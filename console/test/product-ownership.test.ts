// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateApiToken, hashApiToken } from "../src/auth/apiToken.js";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import {
  addTeamMember,
  claimRegisteredImageRepositories,
  createApiToken,
  createBotUser,
  createTeam,
  createUser,
  setUserAdmin,
} from "../src/db/queries.js";
import { imageRepositories, products, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller } from "./rpc.js";

// A product is its team's: no other team may take over its name, or
// register its image repository as their own product (and so run that code
// with their own ServiceAccount and Secrets), not even after it's deleted.

const prefix = `own-${randomUUID().slice(0, 6)}`;
const teamA = `${prefix}-a`;
const teamB = `${prefix}-b`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;
let memberA: string;
let catalogCi: string;

const call = caller(() => app);
const register = (token: string, body: Record<string, unknown>) => call(token, "ProductService/RegisterProduct", body);
const releaseRepo = (token: string, repository: string) => call(token, "ProductService/ReleaseImageRepository", { repository });
const repo = (name: string) => `example.com/${prefix}/${name}`;

async function newUser(isAdmin: boolean, team?: string): Promise<string> {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (isAdmin) await setUserAdmin(user.id, true);
  if (team) await addTeamMember(user.id, team);
  return app.jwt.sign({ userId: user.id });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const a = await createTeam(teamA);
  const b = await createTeam(teamB);
  admin = await newUser(true);
  memberA = await newUser(false, a.id);
  const botEmail = `${prefix}-ci@bots.vertra.local`;
  emails.push(botEmail);
  const bot = await createBotUser(botEmail);
  const token = generateApiToken();
  await createApiToken(bot.id, "catalog CI", hashApiToken(token), ["products:register"]);
  catalogCi = token;
});

afterAll(async () => {
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(imageRepositories).where(like(imageRepositories.repository, `example.com/${prefix}/%`));
  await db.delete(teams).where(inArray(teams.name, [teamA, teamB]));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

describe("product names", () => {
  it("another team can't take over a product's name", async () => {
    const name = `${prefix}-deploy`;
    expect((await register(catalogCi, { name, image: `${repo("deploy")}:1`, action: "run", team: teamA })).code).toBe("ok");

    const takeover = await register(catalogCi, { name, image: `${repo("evil")}:1`, action: "run", team: teamB });
    expect(takeover.code).toBe("failed_precondition");
    expect(takeover.message).toContain(`team "${teamA}"`);

    // Not even catalog CI's token, which may register for any team.
    const viaCi = await register(catalogCi, { name, image: `${repo("evil")}:2`, action: "run", team: teamB });
    expect(viaCi.code).toBe("failed_precondition");

    const [stored] = await db.select().from(products).where(like(products.name, name));
    expect(stored?.image).toBe(`${repo("deploy")}:1`);
  });

  it("its own team can still update it", async () => {
    const name = `${prefix}-update`;
    expect((await register(catalogCi, { name, image: `${repo("update")}:1`, action: "run", team: teamA })).code).toBe("ok");
    const updated = await register(catalogCi, { name, image: `${repo("update")}@sha256:${"a".repeat(64)}`, action: "run", team: teamA });
    expect(updated.code).toBe("ok");
  });

  it("a team can't take over a platform product's name, nor the platform a team's", async () => {
    const platformName = `${prefix}-platform`;
    expect((await register(admin, { name: platformName, image: `${repo("platform")}:1`, action: "run" })).code).toBe("ok");
    const byTeam = await register(catalogCi, { name: platformName, image: `${repo("x")}:1`, action: "run", team: teamA });
    expect(byTeam.code).toBe("failed_precondition");
    expect(byTeam.message).toContain("the platform");

    const teamName = `${prefix}-teams`;
    expect((await register(catalogCi, { name: teamName, image: `${repo("teams")}:1`, action: "run", team: teamA })).code).toBe("ok");
    expect((await register(admin, { name: teamName, image: `${repo("y")}:1`, action: "run" })).code).toBe("failed_precondition");
  });
});

describe("image repositories", () => {
  it("only the team that first registered a repository may use it, by any tag or digest", async () => {
    expect((await register(catalogCi, { name: `${prefix}-build`, image: `${repo("build")}:1`, action: "build", team: teamA })).code).toBe("ok");

    for (const image of [`${repo("build")}:1`, `${repo("build")}:2`, `${repo("build")}@sha256:${"b".repeat(64)}`]) {
      const borrowed = await register(catalogCi, { name: `${prefix}-b-build-${randomUUID().slice(0, 4)}`, image, action: "build", team: teamB });
      expect(borrowed.code).toBe("failed_precondition");
      expect(borrowed.message).toContain(`team "${teamA}"`);
    }
    // The owning team may register more products (actions) from it.
    expect((await register(catalogCi, { name: `${prefix}-build-check`, image: `${repo("build")}:1`, action: "check", team: teamA })).code).toBe("ok");
  });

  it("stays reserved after its product is deleted, until an admin releases it", async () => {
    const name = `${prefix}-gone`;
    const image = `${repo("gone")}:1`;
    expect((await register(catalogCi, { name, image, action: "run", team: teamA })).code).toBe("ok");
    expect((await call(catalogCi, "ProductService/DeleteProduct", { name })).code).toBe("ok");

    const afterDelete = await register(catalogCi, { name: `${prefix}-b-gone`, image, action: "run", team: teamB });
    expect(afterDelete.code).toBe("failed_precondition");

    expect((await releaseRepo(memberA, repo("gone"))).code).toBe("permission_denied");
    expect((await releaseRepo(admin, repo("gone"))).code).toBe("ok");
    expect((await releaseRepo(admin, repo("gone"))).code).toBe("not_found");

    expect((await register(catalogCi, { name: `${prefix}-b-gone`, image, action: "run", team: teamB })).code).toBe("ok");
  });

  it("can't be released while a product uses it", async () => {
    expect((await register(catalogCi, { name: `${prefix}-busy`, image: `${repo("busy")}:1`, action: "run", team: teamA })).code).toBe("ok");
    expect((await releaseRepo(admin, repo("busy"))).code).toBe("failed_precondition");
  });

  it("lists owners for admins only", async () => {
    expect((await call(memberA, "ProductService/ListImageRepositories")).code).toBe("permission_denied");
    const listed = await call<{ repositories: { repository: string; teamName?: string; products: number }[] }>(
      admin,
      "ProductService/ListImageRepositories",
    );
    expect(listed.body.repositories.find((r) => r.repository === repo("busy"))).toMatchObject({ teamName: teamA, products: 1 });
  });

  it("is claimed at startup for products registered before repositories had owners", async () => {
    // Two older products, two teams, one repository: the older one's team wins.
    const [a, b] = await db.select().from(teams).where(inArray(teams.name, [teamA, teamB]));
    const ownerA = [a, b].find((t) => t?.name === teamA);
    const ownerB = [a, b].find((t) => t?.name === teamB);
    await db.insert(products).values([
      { name: `${prefix}-old-a`, image: `${repo("old")}:1`, action: "run", teamId: ownerA?.id ?? null, createdAt: new Date(Date.now() - 60_000) },
      { name: `${prefix}-old-b`, image: `${repo("old")}:2`, action: "run", teamId: ownerB?.id ?? null, createdAt: new Date() },
    ]);
    await claimRegisteredImageRepositories();
    await claimRegisteredImageRepositories(); // idempotent
    const [owner] = await db.select().from(imageRepositories).where(like(imageRepositories.repository, repo("old")));
    expect(owner?.teamId).toBe(ownerA?.id);
    // So team B's existing registration can't be refreshed any more.
    expect((await register(catalogCi, { name: `${prefix}-old-b`, image: `${repo("old")}:3`, action: "run", team: teamB })).code).toBe("failed_precondition");
  });
});
