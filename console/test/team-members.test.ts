// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createBotUser, createTeam, createUser, setTeamRetired, setUserAdmin } from "../src/db/queries.js";
import { teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, failureCode, type RpcError } from "./rpc.js";

// Listing a team's secrets also lists its ExternalSecrets in the cluster.
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  listExternalSecrets: vi.fn(() => Promise.resolve([])),
}));

const prefix = `mem-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;

async function newUser(options: { admin?: boolean } = {}): Promise<{ id: string; token: string }> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (options.admin) await setUserAdmin(user.id, true);
  return { id: user.id, token: app.jwt.sign({ userId: user.id }) };
}

const call = caller(() => app);
const remove = (token: string, team: string, userId: string) => call(token, "TeamService/RemoveMember", { team, userId });
const listMembers = (token: string, team: string) =>
  call<{ members: { id: string; isBot: boolean; role: string }[] }>(token, "TeamService/ListMembers", { team });

/** A team with two human members. */
async function teamOfTwo() {
  const name = `${prefix}-${randomUUID().slice(0, 6)}`;
  const team = await createTeam(name);
  const first = await newUser();
  const second = await newUser();
  await addTeamMember(first.id, team.id);
  await addTeamMember(second.id, team.id);
  return { name, teamId: team.id, first, second };
}

async function memberIds(name: string): Promise<string[]> {
  return (await listMembers(admin, name)).body.members.map((m) => m.id);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  admin = (await newUser({ admin: true })).token;
});

afterAll(async () => {
  await app.close();
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
});

describe("removing a team member", () => {
  it("is refused to someone outside the team", async () => {
    const t = await teamOfTwo();
    const outsider = await newUser();
    expect((await remove(outsider.token, t.name, t.second.id)).code).toBe("permission_denied");
    expect(await memberIds(t.name)).toContain(t.second.id);
  });

  it("lets a maintainer remove another member, who then loses access", async () => {
    const t = await teamOfTwo();
    expect((await remove(t.first.token, t.name, t.second.id)).code).toBe("ok");
    expect(await memberIds(t.name)).not.toContain(t.second.id);
    expect((await listMembers(t.second.token, t.name)).code).toBe("permission_denied");
  });

  it("never removes the last maintainer, but a bot can always go", async () => {
    const t = await teamOfTwo();
    await remove(t.first.token, t.name, t.second.id);
    const bot = await call(t.first.token, "TokenService/CreateBotToken", {
      team: t.name,
      email: `${t.name}-bot@bot.internal`,
      label: "ci",
    });
    emails.push(`${t.name}-bot@bot.internal`);
    expect(bot.code).toBe("ok");

    const last = await remove(admin, t.name, t.first.id);
    expect(last.code).toBe("failed_precondition");
    expect(last.failure).toBe("LAST_MAINTAINER");

    const botId = (await listMembers(admin, t.name)).body.members.find((m) => m.isBot)?.id;
    expect((await remove(t.first.token, t.name, botId ?? "")).code).toBe("ok");
  });

  it("is refused on a retired team", async () => {
    const t = await teamOfTwo();
    await setTeamRetired(t.teamId, true);
    expect((await remove(admin, t.name, t.second.id)).code).toBe("failed_precondition");
    expect(await memberIds(t.name)).toContain(t.second.id);
  });
});

describe("a bot token's last use", () => {
  it("is empty until the token is used, then recorded", async () => {
    const t = await teamOfTwo();
    const created = await call<{ token: string }>(t.first.token, "TokenService/CreateBotToken", {
      team: t.name,
      email: `${t.name}-ci@bot.internal`,
      label: "ci",
    });
    emails.push(`${t.name}-ci@bot.internal`);
    const botToken = created.body.token;

    const lastUsed = async () =>
      (await call<{ bots: { tokens: { lastUsedAt?: string }[] }[] }>(t.first.token, "TokenService/ListBots", { team: t.name }))
        .body.bots[0]?.tokens[0]?.lastUsedAt;

    expect(await lastUsed()).toBeUndefined();
    expect((await listMembers(botToken, t.name)).code).toBe("ok");
    expect(await lastUsed()).toBeDefined();
  });
});

describe("what a team's outsiders learn", () => {
  it("can't read a team's record, whether or not it exists", async () => {
    const t = await teamOfTwo();
    const outsider = await newUser();
    const existing = await call(outsider.token, "TeamService/GetTeam", { name: t.name });
    const missing = await call(outsider.token, "TeamService/GetTeam", { name: `${prefix}-no-such-team` });
    expect(existing.code).toBe("not_found");
    expect(existing.body).toEqual(missing.body);
    expect((await call(t.first.token, "TeamService/GetTeam", { name: t.name })).code).toBe("ok");
    expect((await call(admin, "TeamService/GetTeam", { name: t.name })).code).toBe("ok");
  });
});

describe("adding a team member", () => {
  it("is refused for a retired team", async () => {
    const t = await teamOfTwo();
    await setTeamRetired(t.teamId, true);
    const newcomer = await newUser();
    const email = emails[emails.length - 1];
    const added = await call(admin, "TeamService/AddMember", { team: t.name, email });
    expect(added.code).toBe("failed_precondition");
    expect(added.failure).toBe("TEAM_RETIRED");
    expect(await memberIds(t.name)).not.toContain(newcomer.id);
  });

  it("is refused for a bot: it belongs to the team that made it", async () => {
    const t = await teamOfTwo();
    const email = `${prefix}-bot-${randomUUID()}@example.com`;
    emails.push(email);
    const { user: bot } = await createBotUser(email);
    const added = await call(t.first.token, "TeamService/AddMember", { team: t.name, email });
    expect(added.code).toBe("already_exists");
    expect(added.failure).toBe("CONFLICT");
    expect(await memberIds(t.name)).not.toContain(bot.id);
  });

  it("says when the account signed itself up and its email was never verified", async () => {
    const t = await teamOfTwo();
    const email = `${prefix}-self-${randomUUID()}@example.com`;
    emails.push(email);
    const was = config.allowSelfRegistration;
    config.allowSelfRegistration = true;
    try {
      expect((await call(undefined, "AuthService/Register", { email, password: "correct-horse-battery" })).code).toBe("ok");
    } finally {
      config.allowSelfRegistration = was;
    }
    const [registered] = await db.select().from(users).where(eq(users.email, email));
    const added = await call(t.first.token, "TeamService/AddMember", { team: t.name, email });
    expect(added.code).toBe("failed_precondition");
    expect(added.failure).toBe("EMAIL_NOT_VERIFIED");
    expect(added.message).toContain("nobody has verified");
    expect(await memberIds(t.name)).not.toContain(registered?.id);
    // Single sign-on verifies it.
    await db.update(users).set({ oidcSubject: `https://idp.test|${randomUUID()}` }).where(eq(users.email, email));
    expect((await call(t.first.token, "TeamService/AddMember", { team: t.name, email })).code).toBe("ok");
    // An admin, who can check it's theirs some other way, may add one anyway.
    const other = `${prefix}-self-${randomUUID()}@example.com`;
    emails.push(other);
    await createUser(other, await hashPassword("correct-horse-battery"), false, true);
    expect((await call(admin, "TeamService/AddMember", { team: t.name, email: other })).code).toBe("ok");
  });

  it("is limited per caller, so emails can't be swept", async () => {
    const t = await teamOfTwo();
    const codes: string[] = [];
    for (let i = 0; i < 31; i++) {
      const added = await call(t.first.token, "TeamService/AddMember", { team: t.name, email: `${prefix}-nobody-${i}@example.com` });
      codes.push(added.code);
    }
    expect(codes.slice(0, 30).every((c) => c === "not_found")).toBe(true);
    expect(codes[30]).toBe("resource_exhausted");
    // Someone else's limit is their own.
    const other = await call(t.second.token, "TeamService/AddMember", { team: t.name, email: `${prefix}-nobody@example.com` });
    expect(other.code).toBe("not_found");
  }, 30_000); // 32 calls in a row: slow on a busy machine
});

describe("roles: maintainers and members", () => {
  /** A team with a maintainer and a member, as the API adds them. */
  async function teamWithAMember() {
    const name = `${prefix}-${randomUUID().slice(0, 6)}`;
    const team = await createTeam(name);
    const maintainer = await newUser();
    await addTeamMember(maintainer.id, team.id, "maintainer");
    const memberEmail = `${prefix}-${randomUUID()}@example.com`;
    emails.push(memberEmail);
    const user = await createUser(memberEmail, await hashPassword("correct-horse-battery"));
    expect((await call(maintainer.token, "TeamService/AddMember", { team: name, email: memberEmail })).code).toBe("ok");
    const member = { id: user.id, token: app.jwt.sign({ userId: user.id }) };
    return { name, maintainer, member };
  }
  const roleOf = async (team: string, id: string) =>
    (await listMembers(admin, team)).body.members.find((m) => m.id === id)?.role;

  it("adds someone as a member unless a maintainer is asked for", async () => {
    const t = await teamWithAMember();
    expect(await roleOf(t.name, t.member.id)).toBe("TEAM_ROLE_MEMBER");
    expect(await roleOf(t.name, t.maintainer.id)).toBe("TEAM_ROLE_MAINTAINER");
  });

  it("lets a member see the team's people and secrets, and manage none of it", async () => {
    const t = await teamWithAMember();
    const newcomer = await newUser();
    const newcomerEmail = emails[emails.length - 1];
    expect((await listMembers(t.member.token, t.name)).code).toBe("ok");
    expect((await call(t.member.token, "SecretService/ListSecrets", { team: t.name })).code).toBe("ok");
    for (const [method, body] of [
      ["TeamService/AddMember", { team: t.name, email: newcomerEmail }],
      ["TeamService/RemoveMember", { team: t.name, userId: t.maintainer.id }],
      ["TeamService/SetMemberRole", { team: t.name, userId: t.member.id, role: "TEAM_ROLE_MAINTAINER" }],
      ["SecretService/PutSecret", { team: t.name, secretName: "db", data: { password: "x" } }],
      ["TokenService/CreateBotToken", { team: t.name, email: `${t.name}-bot@bot.internal`, label: "ci" }],
      ["TokenService/ListBots", { team: t.name }],
    ] as const) {
      const response = await call(t.member.token, method, body);
      expect(response.code, method).toBe("permission_denied");
    }
    expect(await memberIds(t.name)).not.toContain(newcomer.id);
  });

  it("lets a maintainer make a member a maintainer, who can then manage the team", async () => {
    const t = await teamWithAMember();
    const set = await call(t.maintainer.token, "TeamService/SetMemberRole", {
      team: t.name,
      userId: t.member.id,
      role: "TEAM_ROLE_MAINTAINER",
    });
    expect(set.code).toBe("ok");
    expect(await roleOf(t.name, t.member.id)).toBe("TEAM_ROLE_MAINTAINER");
    expect((await remove(t.member.token, t.name, t.maintainer.id)).code).toBe("ok");
  });

  it("never leaves a team without a maintainer, and needs a role", async () => {
    const t = await teamWithAMember();
    const demote = await call<RpcError>(t.maintainer.token, "TeamService/SetMemberRole", {
      team: t.name,
      userId: t.maintainer.id,
      role: "TEAM_ROLE_MEMBER",
    });
    expect(demote.code).toBe("failed_precondition");
    expect(failureCode(demote.body)).toBe("LAST_MAINTAINER");
    const unspecified = await call(t.maintainer.token, "TeamService/SetMemberRole", { team: t.name, userId: t.member.id });
    expect(unspecified.code).toBe("invalid_argument");
  });

  it("tells someone which of their teams they maintain", async () => {
    const t = await teamWithAMember();
    const me = (token: string) => call<{ teamNames: string[]; maintainerOf?: string[] }>(token, "AuthService/GetMe", {});
    expect((await me(t.maintainer.token)).body.maintainerOf).toContain(t.name);
    const member = (await me(t.member.token)).body;
    expect(member.teamNames).toContain(t.name);
    expect(member.maintainerOf ?? []).not.toContain(t.name);
  });
});
