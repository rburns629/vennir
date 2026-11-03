// SPDX-License-Identifier: MIT
/**
 * TokenService: the rules for bots and automation tokens
 * (shared through core/tokens.ts), through Connect: team membership gates a
 * team's bots, admins alone handle automation tokens, a retired team gets
 * no new token, and a raw token is shown once and never audited.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createApiToken, createBotUser, createTeam, setTeamRetired } from "../src/db/queries.js";
import { generateApiToken, hashApiToken } from "../src/auth/apiToken.js";
import { apiTokens, auditLog, botCallbacks, botIdentities, teamMemberships, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { failureCode, rpcClient, type RpcError } from "./rpc.js";

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
const prefix = `rpc-tok-${randomUUID().slice(0, 8)}`;
const botEmails: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (botEmails.length > 0) await db.delete(users).where(inArray(users.email, botEmails));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await cleanUp();
});

async function memberOfNewTeam() {
  const team = await createTeam(`${prefix}-${randomUUID().slice(0, 6)}`);
  const member = await makeUser();
  await addTeamMember(member.id, team.id);
  return { team, member, token: await signIn(member.email) };
}

describe("a team's bots", () => {
  it("are made and listed by its members, the token shown once and never audited", async () => {
    const { team, member, token } = await memberOfNewTeam();
    const email = `bot-${randomUUID()}@example.com`;
    botEmails.push(email);

    const created = await rpc("TokenService", "CreateBotToken", { team: team.name, email, label: "ci" }, { token });
    expect(created.statusCode).toBe(200);
    const { token: raw, tokenId } = created.json<{ token: string; tokenId: string }>();
    expect(raw.length).toBeGreaterThan(20);

    const listed = await rpc("TokenService", "ListBots", { team: team.name }, { token });
    const bots = listed.json<{ bots: { email: string; tokens: { id: string }[] }[] }>().bots;
    expect(bots.find((bot) => bot.email === email)?.tokens.map((t) => t.id)).toEqual([tokenId]);
    expect(listed.body).not.toContain(raw);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, member.id), eq(auditLog.route, "vertra.console.v1.TokenService/CreateBotToken")))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(entry?.target).toMatchObject({ team: team.name, email, label: "ci" });
    expect(JSON.stringify(entry)).not.toContain(raw);

    // The bot's token works, as a member of the team.
    const asBot = await rpc("TokenService", "ListBots", { team: team.name }, { token: raw });
    expect(asBot.statusCode).toBe(200);
  });

  it("are out of reach of anyone else", async () => {
    const { team } = await memberOfNewTeam();
    const outsider = await makeUser();
    const token = await signIn(outsider.email);
    for (const [method, body] of [
      ["ListBots", { team: team.name }],
      ["CreateBotToken", { team: team.name, email: `x-${randomUUID()}@example.com`, label: "x" }],
    ] as const) {
      const response = await rpc("TokenService", method, body, { token });
      expect(response.statusCode).toBe(403);
      expect(failureCode(response.json<RpcError>())).toBe("FORBIDDEN");
    }
  });

  it("can't get a new token in a retired team", async () => {
    const { team, token } = await memberOfNewTeam();
    await setTeamRetired(team.id, true);
    const response = await rpc(
      "TokenService",
      "CreateBotToken",
      { team: team.name, email: `late-${randomUUID()}@example.com`, label: "x" },
      { token },
    );
    expect(response.json<RpcError>().code).toBe("failed_precondition");
    expect(failureCode(response.json<RpcError>())).toBe("TEAM_RETIRED");
  });

  it("belong to the team that made them: another team can't take one, or an automation bot", async () => {
    const owner = await memberOfNewTeam();
    const taker = await memberOfNewTeam();
    const email = `bot-${randomUUID()}@example.com`;
    botEmails.push(email);
    expect((await rpc("TokenService", "CreateBotToken", { team: owner.team.name, email, label: "ci" }, { token: owner.token })).statusCode).toBe(200);

    const taken = await rpc("TokenService", "CreateBotToken", { team: taker.team.name, email, label: "x" }, { token: taker.token });
    expect(taken.json<RpcError>().code).toBe("already_exists");
    expect(failureCode(taken.json<RpcError>())).toBe("CONFLICT");
    const theirs = await rpc("TokenService", "ListBots", { team: taker.team.name }, { token: taker.token });
    expect(theirs.json<{ bots?: { email: string }[] }>().bots ?? []).not.toContainEqual(expect.objectContaining({ email }));

    // A bot in no team that has a token, as an admin's automation bot has, isn't anyone's to take.
    const automation = `automation-${randomUUID().slice(0, 8)}@bot.internal`;
    botEmails.push(automation);
    const { user: automationBot } = await createBotUser(automation);
    await createApiToken(automationBot.id, "catalog CI", hashApiToken(generateApiToken()), ["products:register"], null);
    const orphan = await rpc("TokenService", "CreateBotToken", { team: taker.team.name, email: automation, label: "x" }, { token: taker.token });
    expect(failureCode(orphan.json<RpcError>())).toBe("CONFLICT");

    // Its own team still gets new tokens for it.
    expect((await rpc("TokenService", "CreateBotToken", { team: owner.team.name, email, label: "again" }, { token: owner.token })).statusCode).toBe(200);
  });

  it("asked for at one new address by two teams at once, go to one of them", async () => {
    const first = await memberOfNewTeam();
    const second = await memberOfNewTeam();
    const email = `bot-${randomUUID()}@example.com`;
    botEmails.push(email);
    const answers = await Promise.all(
      [first, second].map((t) => rpc("TokenService", "CreateBotToken", { team: t.team.name, email, label: "ci" }, { token: t.token })),
    );
    expect(answers.map((a) => a.statusCode).sort()).toEqual([200, 409]);
    const [bot] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(await db.select().from(teamMemberships).where(eq(teamMemberships.userId, bot!.id))).toHaveLength(1);
  });

  it("can be finished by the team that started one, when making it stopped before its team", async () => {
    const { team, token } = await memberOfNewTeam();
    const email = `bot-${randomUUID()}@example.com`;
    botEmails.push(email);
    await createBotUser(email); // made, with no team, token or identity yet
    expect((await rpc("TokenService", "CreateBotToken", { team: team.name, email, label: "ci" }, { token })).statusCode).toBe(200);
  });

  it("in two teams from before bots had one are left with their maker's team (migration 0058)", async () => {
    const owner = await memberOfNewTeam();
    const taker = await memberOfNewTeam();
    const email = `bot-${randomUUID()}@example.com`;
    botEmails.push(email);
    const { user: bot } = await createBotUser(email);
    const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
    await db.insert(teamMemberships).values({ userId: bot.id, teamId: owner.team.id, role: "maintainer", createdAt: at(0) });
    const before = await createApiToken(bot.id, "owner's", hashApiToken(generateApiToken()), [], null);
    await db.update(apiTokens).set({ createdAt: at(1) }).where(eq(apiTokens.id, before.id));
    await db.insert(teamMemberships).values({ userId: bot.id, teamId: taker.team.id, role: "maintainer", createdAt: at(10) });
    const after = await createApiToken(bot.id, "taker's", hashApiToken(generateApiToken()), [], null);
    await db.update(apiTokens).set({ createdAt: at(20) }).where(eq(apiTokens.id, after.id));
    await db.insert(botIdentities).values({ botId: bot.id, issuer: "https://ci.example", claims: { sub: `repo:x/${randomUUID()}` }, createdAt: at(20) });

    await db.insert(botCallbacks).values({ botId: bot.id, urlEncrypted: "x", host: "taker.example", secretEncrypted: "x", updatedAt: at(20) });
    await db.update(users).set({ orderTemplates: ["deploy"] }).where(eq(users.id, bot.id));

    // In a transaction that's rolled back, so other test files never see it.
    const migration = readFileSync(new URL("../src/db/migrations/0058_bots_belong_to_one_team.sql", import.meta.url), "utf8");
    const checked = Symbol("checked");
    await expect(
      db.transaction(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement));
        const memberships = await tx.select({ teamId: teamMemberships.teamId }).from(teamMemberships).where(eq(teamMemberships.userId, bot.id));
        expect(memberships).toEqual([{ teamId: owner.team.id }]);
        const tokens = await tx.select({ id: apiTokens.id, revokedAt: apiTokens.revokedAt }).from(apiTokens).where(eq(apiTokens.userId, bot.id));
        expect(tokens.find((t) => t.id === before.id)?.revokedAt).toBeNull();
        expect(tokens.find((t) => t.id === after.id)?.revokedAt).not.toBeNull();
        expect(await tx.select().from(botIdentities).where(eq(botIdentities.botId, bot.id))).toEqual([]);
        expect(await tx.select().from(botCallbacks).where(eq(botCallbacks.botId, bot.id))).toEqual([]);
        const [after_] = await tx.select({ orderTemplates: users.orderTemplates }).from(users).where(eq(users.id, bot.id));
        expect(after_?.orderTemplates).toEqual([]);
        throw checked;
      }),
    ).rejects.toBe(checked);
  });

  it("can only be revoked by a member of one of the bot's teams, or an admin", async () => {
    const { team, token } = await memberOfNewTeam();
    const email = `bot-${randomUUID()}@example.com`;
    botEmails.push(email);
    const created = await rpc("TokenService", "CreateBotToken", { team: team.name, email, label: "ci" }, { token });
    const { tokenId, token: raw } = created.json<{ tokenId: string; token: string }>();

    const outsider = await signIn((await makeUser()).email);
    expect((await rpc("TokenService", "RevokeToken", { tokenId }, { token: outsider })).statusCode).toBe(403);

    expect((await rpc("TokenService", "RevokeToken", { tokenId }, { token })).statusCode).toBe(200);
    expect((await rpc("TokenService", "ListBots", { team: team.name }, { token: raw })).statusCode).toBe(401);
  });
});

describe("automation tokens", () => {
  it("are for admins only", async () => {
    const { token } = await memberOfNewTeam();
    const response = await rpc("TokenService", "CreateAutomationToken", { label: "ci", scopes: ["teams:create"] }, { token });
    expect(response.statusCode).toBe(403);
  });

  it("refuse unknown scopes, every problem at once", async () => {
    const admin = await makeUser({ admin: true });
    const token = await signIn(admin.email);
    const response = await rpc("TokenService", "CreateAutomationToken", { label: "", scopes: ["root"] }, { token });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
  });
});

describe("input formats", () => {
  it("knows every format the schemas declare", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const { FORMATS } = await import("../src/rpc/validate.js");
    const files = ["core", "auth", "rpc/services"].map((dir) => `src/${dir}`);
    const used = new Set<string>();
    for (const dir of files) {
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".ts")) continue;
        for (const match of (await readFile(`${dir}/${name}`, "utf-8")).matchAll(/format: "([a-z-]+)"/g)) {
          if (match[1]) used.add(match[1]);
        }
      }
    }
    expect([...used].filter((format) => !(format in FORMATS))).toEqual([]);
  });
});
