// SPDX-License-Identifier: MIT
/**
 * Who may call each API, and who may change that (decision 26,
 * core/apiAccess.ts): its own team; a user a grant names; a person in a
 * group a grant names; for this release a shareWith team ("from the
 * catalog"); nobody else, admins included. Requests (open, approval,
 * closed), deciding them, adding grants, changing their rates and revoking
 * them, each by whom it's for; bots; retired teams; the lists; and every
 * write audited and told.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { and, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyApis } from "../src/catalogSync.js";
import { config } from "../src/config.js";
import { accessFor, pruneAwayAccess, staleGroupFor, type CallerContext } from "../src/core/apiAccess.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, findApi, findTeamByName, findUserByEmail } from "../src/db/queries.js";
import { apiAccessRequests, apiGrants, apis, auditLog, notificationEvents, teams, userGroups, userNotifications, users as users_ } from "../src/db/schema.js";
import { ApiSchema } from "../src/gen/vennir/catalog/v1/release_pb.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
  ensureNamespaceExists: vi.fn(() => Promise.resolve()),
}));
vi.mock("../src/gatewayTokenPolicy.js", () => ({ syncGatewayTokenPolicy: vi.fn(() => Promise.resolve()) }));

const prefix = `acc-${randomUUID().slice(0, 6)}`;
const owner = `${prefix}-pay`;
const consumer = `${prefix}-web`;
const tools = `${prefix}-tools`;
const oldTools = `${prefix}-old`;

const openapi = { openapi: "3.1.0", info: { title: "Orders", version: "1" }, servers: [{ url: "https://orders.example.run.app" }], paths: {} };

function api(name: string, fields: Record<string, unknown> = {}) {
  return {
    name,
    team: owner,
    displayName: name,
    description: "",
    openapi: JSON.stringify(openapi),
    backendUrl: "https://orders.example.run.app",
    serviceAccount: `${name}-api`,
    shareWith: [] as string[],
    perMinute: { default: 60, [consumer]: 600 },
    timeoutSeconds: 20,
    maxRequestBytes: BigInt(1024),
    path: `teams/${owner}/apis/${name}/api.yaml`,
    accessRequests: "approval",
    ...fields,
  };
}
const release = () => [
  api("orders", { shareWith: [consumer] }),
  api("open", { accessRequests: "open" }),
  api("closed", { accessRequests: "closed" }),
  api("secret", { hidden: true, perMinute: {} }),
  // From a vennir before access.requests: approval.
  api("older", { accessRequests: "" }),
  // For what happens while an API is away from the release.
  api("spare"),
  api("spare2"),
];
const problems: string[] = [];
async function apply(list: ReturnType<typeof api>[]) {
  await applyApis(
    list.map((a) => create(ApiSchema, a)),
    new Set([owner, consumer, tools, oldTools]),
    new Set(),
    async (item, work) => {
      try {
        await work();
      } catch (error) {
        problems.push(`${item}: ${String(error)}`);
      }
    },
  );
}

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
type Who = "maintainer" | "member" | "consumer" | "ada" | "bob" | "admin" | "toolsMaintainer" | "toolsMember" | "oldMaintainer";
const tokens = {} as Record<Who | "bot" | "oldBot", string>;
const ids = {} as Record<Who | "bot" | "oldBot", string>;
const emails = {} as Record<Who | "bot" | "oldBot", string>;
const botEmail = `bot-${prefix}@bots.example.com`;
const oldBotEmail = `oldbot-${prefix}@bots.example.com`;

type Grant = { id: string; group?: string; userId?: string; userEmail?: string; bot?: boolean; perMinute?: number; defaultRate?: boolean; grantedBy?: string; accessRequestId?: string; revokedAt?: string };
type Request = { id: string; userEmail?: string; state?: string; reason?: string; decisionReason?: string; grantId?: string; groups?: string[]; requestedBy?: string };
type Listed = { team: string; name: string; mayCall?: boolean; accessVia?: string; perMinute?: number; accessRequests?: string };

const listed = async (who: keyof typeof tokens, name: string) =>
  ((await call<{ apis?: Listed[] }>(tokens[who], "ApiService/ListApis")).body.apis ?? []).find((a) => a.team === owner && a.name === name);
const ask = (who: keyof typeof tokens, name: string, reason = "for the dashboard", bot = "") =>
  call<{ request: Request; grant?: Grant }>(tokens[who], "ApiService/RequestApiAccess", { team: owner, name, reason, botEmail: bot });
const decide = (who: keyof typeof tokens, accessRequestId: string, body: object) =>
  call<{ request: Request; grant?: Grant }>(tokens[who], "ApiService/DecideApiAccessRequest", { accessRequestId, ...body });
const add = (who: keyof typeof tokens, name: string, body: object) => call<{ grant: Grant }>(tokens[who], "ApiService/AddApiGrant", { team: owner, name, ...body });
const revoke = (who: keyof typeof tokens, grantId: string, reason = "") => call(tokens[who], "ApiService/RevokeApiGrant", { grantId, reason });

beforeAll(async () => {
  app = await buildApp();
  config.gateway.backendHosts = ["*.example.run.app"];
  for (const t of [owner, consumer, tools, oldTools]) await createTeam(t);
  await apply(release());
  const team = async (name: string) => (await findTeamByName(name))?.id ?? "";
  for (const who of ["maintainer", "member", "consumer", "ada", "bob", "toolsMaintainer", "toolsMember", "oldMaintainer"] as const) {
    const made = await users.makeUser();
    ids[who] = made.id;
    emails[who] = made.email;
  }
  const admin = await users.makeUser({ admin: true });
  ids.admin = admin.id;
  emails.admin = admin.email;
  await addTeamMember(ids.maintainer, await team(owner), "maintainer");
  await addTeamMember(ids.member, await team(owner), "member");
  await addTeamMember(ids.consumer, await team(consumer), "member");
  await addTeamMember(ids.toolsMaintainer, await team(tools), "maintainer");
  await addTeamMember(ids.toolsMember, await team(tools), "member");
  await addTeamMember(ids.oldMaintainer, await team(oldTools), "maintainer");
  for (const who of Object.keys(ids) as Who[]) tokens[who] = await users.signIn(emails[who]);
  // Bots, made by their teams' maintainers.
  const bot = await call<{ token: string }>(tokens.toolsMaintainer, "TokenService/CreateBotToken", { team: tools, email: botEmail, label: "ci" });
  const oldBot = await call<{ token: string }>(tokens.oldMaintainer, "TokenService/CreateBotToken", { team: oldTools, email: oldBotEmail, label: "ci" });
  expect([bot.code, oldBot.code]).toEqual(["ok", "ok"]);
  tokens.bot = bot.body.token;
  tokens.oldBot = oldBot.body.token;
  users.createdEmails.push(botEmail, oldBotEmail);
  emails.bot = botEmail;
  emails.oldBot = oldBotEmail;
  ids.bot = (await findUserByEmail(botEmail))?.id ?? "";
  ids.oldBot = (await findUserByEmail(oldBotEmail))?.id ?? "";
});

afterAll(async () => {
  config.gateway.backendHosts = [];
  const ours = await db.select({ id: teams.id }).from(teams).where(like(teams.name, `${prefix}%`));
  if (ours.length > 0) await db.delete(teams).where(inArray(teams.id, ours.map((t) => t.id)));
  await users.cleanUp();
  await app.close();
});

describe("from the catalog", () => {
  it("records each API's access.requests, approval when a release doesn't say, and refuses one it can't read", async () => {
    const rows = await db.select({ name: apis.name, accessRequests: apis.accessRequests }).from(apis).innerJoin(teams, eq(teams.id, apis.teamId)).where(eq(teams.name, owner));
    expect(Object.fromEntries(rows.map((r) => [r.name, r.accessRequests]))).toEqual({ orders: "approval", open: "open", closed: "closed", secret: "approval", older: "approval", spare: "approval", spare2: "approval" });
    expect(problems).toEqual([]);
    await apply([...release(), api("odd", { accessRequests: "sometimes" })]);
    expect(problems.some((p) => p.includes("api ") && p.includes("odd") && p.includes("open, approval or closed"))).toBe(true);
    problems.length = 0;
    await apply(release());
    expect((await listed("ada", "open"))?.accessRequests).toBe("open");
  });
});

describe("who may call", () => {
  it("is its own team, and a shareWith team from the catalog; not an outsider, nor an admin", async () => {
    expect(await listed("member", "orders")).toMatchObject({ mayCall: true, accessVia: "API_ACCESS_VIA_TEAM", perMinute: 60 });
    expect(await listed("consumer", "orders")).toMatchObject({ mayCall: true, accessVia: "API_ACCESS_VIA_CATALOG", perMinute: 600 });
    for (const who of ["ada", "admin", "toolsMember", "bot"] as const) {
      const a = await listed(who, "orders");
      expect(a?.mayCall ?? false, who).toBe(false);
      expect(a?.accessVia ?? "API_ACCESS_VIA_UNSPECIFIED", who).toBe("API_ACCESS_VIA_UNSPECIFIED");
    }
  });

  it("follows the gateway's order, as the table both run says (testdata/api-access-cases.json)", () => {
    type Fields = { id?: string; team?: string; shareWith?: string[]; perMinute?: Record<string, number> };
    const table = JSON.parse(readFileSync(new URL("../../testdata/api-access-cases.json", import.meta.url), "utf8")) as {
      gatewayDefaultPerMinute: number;
      api: Required<Fields>;
      cases: {
        name: string;
        api?: Fields;
        caller: { id: string; bot?: boolean; teams?: string[]; groups?: string[]; groupsCurrent?: boolean };
        grants: { id: string; userId?: string; group?: string; perMinute?: number; revoked?: boolean; away?: boolean }[];
        expect: { via: string; team?: string; group?: string; grant?: string; perMinute: number } | null;
        staleGroup?: boolean;
      }[];
    };
    const kept = config.gateway.defaultPerMinute;
    config.gateway.defaultPerMinute = table.gatewayDefaultPerMinute;
    try {
      expect(table.cases.length).toBeGreaterThan(10);
      for (const c of table.cases) {
        const a = { id: table.api.id, teamName: table.api.team, shareWith: c.api?.shareWith ?? table.api.shareWith, perMinute: c.api?.perMinute ?? table.api.perMinute } as unknown as Parameters<typeof accessFor>[1];
        const grants = c.grants.map(
          (g) =>
            ({
              id: g.id,
              apiId: g.away ? null : table.api.id,
              groupName: g.group ?? null,
              userId: g.userId ?? null,
              perMinute: g.perMinute || null,
              revokedAt: g.revoked ? new Date() : null,
            }) as CallerContext["grants"][number],
        );
        const who = { id: c.caller.id, isBot: c.caller.bot ?? false, groupsCurrent: c.caller.groupsCurrent ?? false };
        const ctx = { teams: c.caller.teams ?? [], groups: c.caller.groups ?? [], grants };
        const got = accessFor(who, a, ctx);
        expect(staleGroupFor(who, a, ctx), `${c.name}: staleGroup`).toBe(c.staleGroup ?? false);
        const shown = got ? { via: got.via, team: got.callingTeam ?? "", group: got.group ?? "", grant: got.grantId ?? "", perMinute: got.perMinute } : null;
        const want = c.expect ? { via: c.expect.via, team: c.expect.team ?? "", group: c.expect.group ?? "", grant: c.expect.grant ?? "", perMinute: c.expect.perMinute } : null;
        expect(shown, c.name).toEqual(want);
      }
    } finally {
      config.gateway.defaultPerMinute = kept;
    }
  });
});

describe("asking for access", () => {
  it("waits for approval, once at a time, and can be withdrawn only by whoever asked", async () => {
    const asked = await ask("ada", "orders");
    expect(asked.code).toBe("ok");
    expect(asked.body.request).toMatchObject({ state: "API_ACCESS_REQUEST_STATE_WAITING", userEmail: emails.ada, reason: "for the dashboard" });
    expect(asked.body.grant).toBeUndefined();
    expect((await ask("ada", "orders")).failure).toBe("ALREADY_WAITING");
    expect((await call(tokens.maintainer, "ApiService/WithdrawApiAccessRequest", { accessRequestId: asked.body.request.id })).failure).toBe("FORBIDDEN");
    expect((await call(tokens.ada, "ApiService/WithdrawApiAccessRequest", { accessRequestId: asked.body.request.id })).code).toBe("ok");
    expect((await call(tokens.ada, "ApiService/WithdrawApiAccessRequest", { accessRequestId: asked.body.request.id })).failure).toBe("NOT_WAITING");
    expect((await ask("ada", "orders")).code).toBe("ok");
  });

  it("needs a reason, and is refused when the API takes none, or they may call it already", async () => {
    expect((await ask("bob", "orders", "  ")).failure).toBe("BAD_REQUEST");
    expect((await ask("bob", "closed")).failure).toBe("REQUESTS_CLOSED");
    expect((await ask("member", "orders")).failure).toBe("ALREADY_ALLOWED");
    expect((await ask("consumer", "orders")).failure).toBe("ALREADY_ALLOWED");
    // A hidden API is as one that isn't there.
    expect((await ask("bob", "secret")).code).toBe("not_found");
  });

  it("is granted at once, at the default limit, where requests are open", async () => {
    const asked = await ask("ada", "open");
    expect(asked.body.request.state).toBe("API_ACCESS_REQUEST_STATE_GRANTED");
    expect(asked.body.grant).toMatchObject({ userEmail: emails.ada, perMinute: 60, defaultRate: true, grantedBy: "", accessRequestId: asked.body.request.id });
    expect(await listed("ada", "open")).toMatchObject({ mayCall: true, accessVia: "API_ACCESS_VIA_USER", perMinute: 60 });
    expect((await ask("ada", "open")).failure).toBe("ALREADY_ALLOWED");
  });

  it("for a bot, is a maintainer of its team's to ask, not the bot's nor anyone else's; one of retired teams only, nobody's", async () => {
    expect((await ask("bot", "orders")).failure).toBe("FORBIDDEN");
    expect((await ask("toolsMember", "orders", "ci", botEmail)).failure).toBe("FORBIDDEN");
    expect((await ask("maintainer", "orders", "ci", botEmail)).failure).toBe("FORBIDDEN");
    const asked = await ask("toolsMaintainer", "orders", "the nightly export", botEmail);
    expect(asked.body.request).toMatchObject({ userEmail: botEmail, bot: true, requestedBy: emails.toolsMaintainer, groups: [] });
    await db.update(teams).set({ retiredAt: new Date() }).where(eq(teams.name, oldTools));
    try {
      expect((await ask("oldMaintainer", "orders", "ci", oldBotEmail)).failure).toBe("TEAM_RETIRED");
    } finally {
      await db.update(teams).set({ retiredAt: null }).where(eq(teams.name, oldTools));
    }
  });
});

describe("deciding a request", () => {
  it("is its team's maintainers' only: not a member, an admin, or the requester's", async () => {
    const [waiting] = await db.select().from(apiAccessRequests).where(and(eq(apiAccessRequests.userId, ids.ada), eq(apiAccessRequests.state, "waiting")));
    for (const who of ["member", "admin", "ada", "consumer"] as const) {
      expect((await decide(who, waiting?.id ?? "", { approve: true })).failure, who).toBe("FORBIDDEN");
    }
  });

  it("grants the person by name, at a rate (the default when none), and they may call", async () => {
    const [waiting] = await db.select().from(apiAccessRequests).where(and(eq(apiAccessRequests.userId, ids.ada), eq(apiAccessRequests.state, "waiting")));
    const decided = await decide("maintainer", waiting?.id ?? "", { approve: true, perMinute: 30 });
    expect(decided.code).toBe("ok");
    expect(decided.body.request).toMatchObject({ state: "API_ACCESS_REQUEST_STATE_GRANTED", grantId: decided.body.grant?.id });
    expect(decided.body.grant).toMatchObject({ userEmail: emails.ada, perMinute: 30, grantedBy: emails.maintainer });
    expect(await listed("ada", "orders")).toMatchObject({ mayCall: true, accessVia: "API_ACCESS_VIA_USER", perMinute: 30 });
    expect((await decide("maintainer", waiting?.id ?? "", { approve: false, reason: "no" })).failure).toBe("NOT_WAITING");
  });

  it("declines with a reason, and they may ask again at once", async () => {
    const asked = await ask("bob", "orders", "reports");
    expect((await decide("maintainer", asked.body.request.id, { approve: false })).failure).toBe("BAD_REQUEST");
    const declined = await decide("maintainer", asked.body.request.id, { approve: false, reason: "use the export" });
    expect(declined.body.request).toMatchObject({ state: "API_ACCESS_REQUEST_STATE_DECLINED", decisionReason: "use the export", decidedBy: emails.maintainer });
    const mine = await call<{ requests?: Request[] }>(tokens.bob, "ApiService/ListMyApiAccess");
    expect(mine.body.requests?.find((r) => r.id === asked.body.request.id)?.state).toBe("API_ACCESS_REQUEST_STATE_DECLINED");
    // Every group bob's last sign-in read (the console's own copy), which his
    // request copies as he asks. (Set here, just before: another test file's
    // change of where groups come from empties everyone's.)
    await db
      .update(users_)
      .set({ ssoGroups: [`all@${prefix}.example.com`, `eng@${prefix}.example.com`], ssoGroupsReadAt: new Date() })
      .where(eq(users_.id, ids.bob));
    expect((await ask("bob", "orders", "reports, again")).code).toBe("ok");
  });

  it("grants a person's group instead, only one of theirs as last read; a bot's only by name", async () => {
    const [waiting] = await db.select().from(apiAccessRequests).where(and(eq(apiAccessRequests.userId, ids.bob), eq(apiAccessRequests.state, "waiting")));
    const access = await call<{ requests?: Request[] }>(tokens.maintainer, "ApiService/ListApiAccess", { team: owner, name: "orders" });
    expect(access.body.requests?.find((r) => r.id === waiting?.id)?.groups).toEqual([`all@${prefix}.example.com`, `eng@${prefix}.example.com`]);
    // Only to its maintainers: not to a plain member, nor an admin.
    for (const who of ["member", "admin"] as const) {
      const seen = await call<{ requests?: Request[] }>(tokens[who], "ApiService/ListApiAccess", { team: owner, name: "orders" });
      expect(seen.body.requests?.find((r) => r.id === waiting?.id)?.groups ?? [], who).toEqual([]);
    }
    expect((await decide("maintainer", waiting?.id ?? "", { approve: true, group: "ops@elsewhere.example.com" })).failure).toBe("NOT_THEIR_GROUP");
    // Groups read over a day ago can't be granted from: they sign in again first.
    const dayAgo = new Date(Date.now() - 25 * 3_600_000);
    await db.update(apiAccessRequests).set({ requesterGroupsReadAt: dayAgo }).where(eq(apiAccessRequests.id, waiting?.id ?? ""));
    await db.update(users_).set({ ssoGroupsReadAt: dayAgo }).where(eq(users_.id, ids.bob));
    const stale = await decide("maintainer", waiting?.id ?? "", { approve: true, group: `eng@${prefix}.example.com` });
    expect(stale.failure).toBe("GROUPS_STALE");
    expect(stale.message).toContain("sign in again");
    // They sign in again (their groups read now): the fresher read is the one that counts.
    await db.update(users_).set({ ssoGroupsReadAt: new Date() }).where(eq(users_.id, ids.bob));
    const decided = await decide("maintainer", waiting?.id ?? "", { approve: true, group: `ENG@${prefix}.example.com`, perMinute: 5 });
    expect(decided.body.grant).toMatchObject({ group: `eng@${prefix}.example.com`, perMinute: 5 });
    // Ended, its groups aren't shown any more.
    const after = await call<{ requests?: Request[] }>(tokens.maintainer, "ApiService/ListApiAccess", { team: owner, name: "orders" });
    expect(after.body.requests?.find((r) => r.id === waiting?.id)?.groups ?? []).toEqual([]);
    // With no group source set here (single sign-on off), groups count for
    // nothing (sso.test.ts has them counting, and kept for the gateway).
    expect((await listed("bob", "orders"))?.mayCall ?? false).toBe(false);
    const [botWaiting] = await db.select().from(apiAccessRequests).where(and(eq(apiAccessRequests.state, "waiting"), eq(apiAccessRequests.requestedBy, ids.toolsMaintainer)));
    expect((await decide("maintainer", botWaiting?.id ?? "", { approve: true, group: `eng@${prefix}.example.com` })).failure).toBe("BAD_REQUEST");
    expect((await decide("maintainer", botWaiting?.id ?? "", { approve: true })).body.grant).toMatchObject({ userEmail: botEmail, bot: true });
    expect(await listed("bot", "orders")).toMatchObject({ mayCall: true, accessVia: "API_ACCESS_VIA_USER" });
  });
});

describe("grants", () => {
  it("are added by the API's team's maintainers only: not a member, an admin, or a bot", async () => {
    for (const who of ["member", "admin", "consumer", "bot"] as const) {
      expect((await add(who, "open", { group: "ops@example.com" })).failure, who).toBe("FORBIDDEN");
    }
    expect((await add("maintainer", "open", {})).failure).toBe("BAD_REQUEST");
    expect((await add("maintainer", "open", { group: "x", email: emails.bob })).failure).toBe("BAD_REQUEST");
    expect((await add("maintainer", "open", { email: "nobody@example.com" })).code).toBe("not_found");
    const made = await add("maintainer", "open", { group: " Ops@Example.com ", perMinute: 9 });
    expect(made.body.grant).toMatchObject({ group: "ops@example.com", perMinute: 9, grantedBy: emails.maintainer });
    expect((await add("maintainer", "open", { group: "ops@example.com" })).failure).toBe("ALREADY_GRANTED");
    // Group names as single sign-on group mappings take them: spaces too (Entra's display names).
    expect((await add("maintainer", "open", { group: "  Platform Engineers " })).body.grant).toMatchObject({ group: "platform engineers" });
    expect((await add("maintainer", "open", { group: "   " })).failure).toBe("BAD_REQUEST");
  });

  it("outlive their API leaving the release, and are its again when it's back", async () => {
    const before = (await call<{ grants?: Grant[] }>(tokens.maintainer, "ApiService/ListApiAccess", { team: owner, name: "open" })).body.grants ?? [];
    expect(await listed("ada", "open")).toMatchObject({ mayCall: true });
    await apply(release().filter((a) => a.name !== "open"));
    // Gone from the release: nobody calls it, and its grants are kept, linked to nothing.
    expect(await listed("ada", "open")).toBeUndefined();
    const away = await db.select().from(apiGrants).where(inArray(apiGrants.id, before.map((g) => g.id)));
    expect(away.map((g) => g.apiId)).toEqual(before.map(() => null));
    // Listed meanwhile, marked away, for its team and admins.
    type Away = { grants?: (Grant & { name: string; awaySince?: string })[] };
    const listedAway = await call<Away>(tokens.member, "ApiService/ListAwayApiAccess", { team: owner });
    expect(listedAway.body.grants?.map((g) => g.id).sort()).toEqual(before.map((g) => g.id).sort());
    expect(listedAway.body.grants?.every((g) => g.name === "open" && g.awaySince)).toBe(true);
    expect((await call(tokens.consumer, "ApiService/ListAwayApiAccess", { team: owner })).failure).toBe("FORBIDDEN");
    // Revocable meanwhile: by its maintainers or an admin, nobody else.
    const ops = before.find((g) => g.group === "ops@example.com")?.id ?? "";
    expect((await revoke("member", ops)).failure).toBe("FORBIDDEN");
    expect((await revoke("maintainer", ops, "not needed")).code).toBe("ok");
    await apply(release());
    const after = (await call<{ grants?: Grant[] }>(tokens.maintainer, "ApiService/ListApiAccess", { team: owner, name: "open" })).body.grants ?? [];
    expect(after.map((g) => g.id).sort()).toEqual(before.map((g) => g.id).sort());
    expect(after.find((g) => g.id === ops)?.revokedAt).toBeTruthy();
    expect(await listed("ada", "open")).toMatchObject({ mayCall: true, accessVia: "API_ACCESS_VIA_USER" });
  });

  it("away over 30 days, are gone: not linked again, and pruned; a waiting request declined", async () => {
    // On "older" (approval), which nothing after this needs.
    const asked = await ask("bob", "older", "while away");
    const grant = await add("maintainer", "older", { email: emails.ada });
    await apply(release().filter((a) => a.name !== "older"));
    const longAgo = new Date(Date.now() - 31 * 24 * 3_600_000);
    await db.update(apiGrants).set({ awaySince: longAgo }).where(eq(apiGrants.id, grant.body.grant.id));
    await db.update(apiAccessRequests).set({ awaySince: longAgo }).where(eq(apiAccessRequests.id, asked.body.request.id));
    await apply(release());
    // Back, but too late: neither is its again.
    expect((await call<{ grants?: Grant[] }>(tokens.maintainer, "ApiService/ListApiAccess", { team: owner, name: "older" })).body.grants ?? []).toEqual([]);
    await pruneAwayAccess();
    expect(await db.select().from(apiGrants).where(eq(apiGrants.id, grant.body.grant.id))).toEqual([]);
    const [declined] = await db.select().from(apiAccessRequests).where(eq(apiAccessRequests.id, asked.body.request.id));
    expect(declined).toMatchObject({ state: "declined", decisionReason: expect.stringContaining("over 30 days ago") as unknown });
  });

  it("coming back, give way to a grant made meanwhile: the away one is superseded, not an error", async () => {
    const grant = await add("maintainer", "closed", { email: emails.toolsMember });
    await apply(release().filter((a) => a.name !== "closed"));
    // A grant to the same user on the API as it's published again by some other path.
    const team = (await findTeamByName(owner))?.id ?? "";
    const [row] = await db
      .insert(apis)
      .values({ teamId: team, name: "closed", displayName: "closed", openapi, backendUrl: "https://orders.example.run.app", serviceAccount: "closed-api" })
      .returning();
    await db.insert(apiGrants).values({ apiId: row?.id ?? "", teamId: team, apiName: "closed", userId: ids.toolsMember });
    await apply(release());
    expect(problems).toEqual([]);
    const [superseded] = await db.select().from(apiGrants).where(eq(apiGrants.id, grant.body.grant.id));
    expect(superseded).toMatchObject({ apiId: row?.id, revokeReason: expect.stringContaining("superseded") as unknown });
    expect(superseded?.revokedAt).not.toBeNull();
  });

  it("answer a request of theirs that waits", async () => {
    const asked = await ask("toolsMember", "orders", "reports");
    const made = await add("maintainer", "orders", { email: emails.toolsMember });
    const [answered] = await db.select().from(apiAccessRequests).where(eq(apiAccessRequests.id, asked.body.request.id));
    expect(answered).toMatchObject({ state: "granted", grantId: made.body.grant.id, decidedBy: ids.maintainer });
  });

  it("change rate by the API's maintainers only; 0 is the API's default", async () => {
    const [grant] = await db.select().from(apiGrants).where(and(eq(apiGrants.userId, ids.toolsMember), eq(apiGrants.apiId, (await findApi(owner, "orders"))?.id ?? "")));
    for (const who of ["admin", "toolsMember", "member"] as const) {
      expect((await call(tokens[who], "ApiService/SetApiGrantRate", { grantId: grant?.id, perMinute: 1 })).failure, who).toBe("FORBIDDEN");
    }
    expect((await call<{ grant: Grant }>(tokens.maintainer, "ApiService/SetApiGrantRate", { grantId: grant?.id, perMinute: 7 })).body.grant).toMatchObject({ perMinute: 7, defaultRate: false });
    expect(await listed("toolsMember", "orders")).toMatchObject({ perMinute: 7 });
    expect((await call<{ grant: Grant }>(tokens.maintainer, "ApiService/SetApiGrantRate", { grantId: grant?.id, perMinute: 0 })).body.grant).toMatchObject({ perMinute: 60, defaultRate: true });
    expect((await call(tokens.maintainer, "ApiService/SetApiGrantRate", { grantId: grant?.id, perMinute: 2_000_000 })).code).toBe("invalid_argument");
  });

  it("are revoked by the API's maintainers, an admin, the person, or their bot's team's maintainers; nobody else; and stay, revoked", async () => {
    const orders = (await findApi(owner, "orders"))?.id ?? "";
    const of = async (userId: string) => (await db.select().from(apiGrants).where(and(eq(apiGrants.userId, userId), eq(apiGrants.apiId, orders))))[0]?.id ?? "";
    // Someone else's: refused.
    expect((await revoke("bob", await of(ids.ada))).failure).toBe("FORBIDDEN");
    expect((await revoke("consumer", await of(ids.bot))).failure).toBe("FORBIDDEN");
    expect((await revoke("bot", await of(ids.bot))).failure).toBe("FORBIDDEN");
    // Their own, the person.
    expect((await revoke("ada", await of(ids.ada), "done with it")).code).toBe("ok");
    expect(await listed("ada", "orders")).toMatchObject({ mayCall: false });
    expect((await revoke("ada", await of(ids.ada))).failure).toBe("REVOKED");
    // Their bot's, its team's maintainer.
    expect((await revoke("toolsMaintainer", await of(ids.bot))).code).toBe("ok");
    expect((await listed("bot", "orders"))?.mayCall ?? false).toBe(false);
    // An admin, for an incident; the API's maintainer.
    expect((await revoke("admin", await of(ids.toolsMember), "incident 7")).code).toBe("ok");
    const [group] = await db.select().from(apiGrants).where(and(eq(apiGrants.apiId, orders), eq(apiGrants.groupName, `eng@${prefix}.example.com`)));
    expect((await revoke("maintainer", group?.id ?? "")).code).toBe("ok");
    expect((await listed("bob", "orders"))?.mayCall ?? false).toBe(false);
    // Each stays, revoked, and its API's team and admins see them all.
    const history = await call<{ grants?: Grant[] }>(tokens.admin, "ApiService/ListApiAccess", { team: owner, name: "orders" });
    expect(history.body.grants?.filter((g) => g.revokedAt).length).toBe(4);
    // Once revoked, they may ask again.
    expect((await ask("ada", "orders")).code).toBe("ok");
  });

  it("from a grant, let a hidden API be seen", async () => {
    expect((await call(tokens.bob, "ApiService/GetApi", { team: owner, name: "secret" })).code).toBe("not_found");
    await add("maintainer", "secret", { email: emails.bob });
    expect((await call(tokens.bob, "ApiService/GetApi", { team: owner, name: "secret" })).code).toBe("ok");
    expect(await listed("bob", "secret")).toMatchObject({ mayCall: true, perMinute: config.gateway.defaultPerMinute });
  });
});

describe("while an API is away from the release", () => {
  const withoutSpare = () => release().filter((a) => a.name !== "spare");
  type AwayList = { grants?: Grant[]; requests?: (Request & { awaySince?: string })[] };

  it("its requests are listed without groups, withdrawable by whoever asked, and a bot's listed for its team", async () => {
    await db
      .update(users_)
      .set({ ssoGroups: [`eng@${prefix}.example.com`], ssoGroupsReadAt: new Date() })
      .where(eq(users_.id, ids.bob));
    const bobs = await ask("bob", "spare", "spare work");
    const bots = await ask("toolsMaintainer", "spare", "spare bot", botEmail);
    await apply(withoutSpare());
    const away = await call<AwayList>(tokens.maintainer, "ApiService/ListAwayApiAccess", { team: owner });
    const listedBob = away.body.requests?.find((r) => r.id === bobs.body.request.id);
    expect(listedBob).toMatchObject({ name: "spare", state: "API_ACCESS_REQUEST_STATE_WAITING" });
    expect(listedBob?.awaySince).toBeTruthy();
    expect(listedBob?.groups ?? []).toEqual([]);
    const teamBots = await call<AwayList>(tokens.toolsMember, "ApiService/ListTeamBotApiAccess", { team: tools });
    expect(teamBots.body.requests?.some((r) => r.id === bots.body.request.id && r.name === "spare")).toBe(true);
    expect((await call(tokens.maintainer, "ApiService/WithdrawApiAccessRequest", { accessRequestId: bobs.body.request.id })).failure).toBe("FORBIDDEN");
    expect((await call(tokens.bob, "ApiService/WithdrawApiAccessRequest", { accessRequestId: bobs.body.request.id })).code).toBe("ok");
    const [withdrawn] = await db.select().from(apiAccessRequests).where(eq(apiAccessRequests.id, bobs.body.request.id));
    expect(withdrawn?.state).toBe("withdrawn");
    await apply(release());
  });

  it("a waiting request that would duplicate one made meanwhile is declined as superseded, not an error", async () => {
    const asked = await ask("bob", "spare", "again");
    await apply(withoutSpare());
    const team = (await findTeamByName(owner))?.id ?? "";
    const [row] = await db
      .insert(apis)
      .values({ teamId: team, name: "spare", displayName: "spare", openapi, backendUrl: "https://orders.example.run.app", serviceAccount: "spare-api" })
      .returning();
    await db.insert(apiAccessRequests).values({ apiId: row?.id ?? "", teamId: team, apiName: "spare", userId: ids.bob, reason: "meanwhile" });
    await apply(release());
    expect(problems).toEqual([]);
    const [superseded] = await db.select().from(apiAccessRequests).where(eq(apiAccessRequests.id, asked.body.request.id));
    expect(superseded).toMatchObject({ apiId: row?.id, state: "declined", decisionReason: expect.stringContaining("superseded") as unknown });
  });

  it("its grants are revocable by an admin, not by a retired team's maintainer", async () => {
    const grant = await add("maintainer", "spare", { email: emails.toolsMember });
    await apply(withoutSpare());
    await db.update(teams).set({ retiredAt: new Date() }).where(eq(teams.name, owner));
    try {
      expect((await revoke("maintainer", grant.body.grant.id)).failure).toBe("TEAM_RETIRED");
      expect((await revoke("member", grant.body.grant.id)).failure).toBe("FORBIDDEN");
      expect((await revoke("admin", grant.body.grant.id, "incident")).code).toBe("ok");
    } finally {
      await db.update(teams).set({ retiredAt: null }).where(eq(teams.name, owner));
    }
    await apply(release());
  });

  it("a row linked to no API and not marked away is marked by the next release (a guard)", async () => {
    const team = (await findTeamByName(owner))?.id ?? "";
    const [lost] = await db.insert(apiGrants).values({ teamId: team, apiName: "never", userId: ids.bob }).returning();
    expect(lost?.awaySince).toBeNull();
    await apply(release());
    const [marked] = await db.select().from(apiGrants).where(eq(apiGrants.id, lost?.id ?? ""));
    expect(marked?.awaySince).not.toBeNull();
  });

  it("is pruned 30 days after: only rows away that long, ended requests deleted, and a second run finds nothing", async () => {
    const team = (await findTeamByName(owner))?.id ?? "";
    const old = new Date(Date.now() - 31 * 24 * 3_600_000);
    const recent = new Date(Date.now() - 29 * 24 * 3_600_000);
    const live = await add("maintainer", "spare2", { email: emails.bob });
    const [awayOld] = await db.insert(apiGrants).values({ teamId: team, apiName: "gone", userId: ids.bob, awaySince: old }).returning();
    const [awayRecent] = await db.insert(apiGrants).values({ teamId: team, apiName: "gone", userId: ids.ada, awaySince: recent }).returning();
    const [ended] = await db
      .insert(apiAccessRequests)
      .values({ teamId: team, apiName: "gone", userId: ids.bob, reason: "x", state: "declined", decidedAt: old, awaySince: old })
      .returning();
    const [endedRecently] = await db
      .insert(apiAccessRequests)
      .values({ teamId: team, apiName: "gone", userId: ids.ada, reason: "x", state: "withdrawn", decidedAt: recent, awaySince: old })
      .returning();
    const [waiting] = await db.insert(apiAccessRequests).values({ teamId: team, apiName: "gone", userId: ids.toolsMember, reason: "x", awaySince: old }).returning();
    expect(await pruneAwayAccess()).toBeGreaterThanOrEqual(2);
    const left = async (table: typeof apiGrants | typeof apiAccessRequests, id: string) => (await db.select({ id: table.id }).from(table).where(eq(table.id, id))).length;
    expect(await left(apiGrants, live.body.grant.id)).toBe(1);
    expect(await left(apiGrants, awayOld?.id ?? "")).toBe(0);
    expect(await left(apiGrants, awayRecent?.id ?? "")).toBe(1);
    expect(await left(apiAccessRequests, ended?.id ?? "")).toBe(0);
    expect(await left(apiAccessRequests, endedRecently?.id ?? "")).toBe(1);
    const [declined] = await db.select().from(apiAccessRequests).where(eq(apiAccessRequests.id, waiting?.id ?? ""));
    expect(declined?.state).toBe("declined");
    // Ours are pruned; another run finds nothing more of ours (a declined one stays its 30 days).
    await pruneAwayAccess();
    expect(await left(apiAccessRequests, waiting?.id ?? "")).toBe(1);
    expect(await left(apiGrants, awayRecent?.id ?? "")).toBe(1);
    expect(await left(apiAccessRequests, endedRecently?.id ?? "")).toBe(1);
  });
});

describe("the lists", () => {
  it("of an API's access are its team's and admins'", async () => {
    expect((await call(tokens.member, "ApiService/ListApiAccess", { team: owner, name: "orders" })).code).toBe("ok");
    expect((await call(tokens.admin, "ApiService/ListApiAccess", { team: owner, name: "orders" })).code).toBe("ok");
    for (const who of ["consumer", "ada", "bot"] as const) {
      expect((await call(tokens[who], "ApiService/ListApiAccess", { team: owner, name: "orders" })).failure, who).toBe("FORBIDDEN");
    }
    const access = await call<{ shareWith?: string[]; requests?: Request[] }>(tokens.member, "ApiService/ListApiAccess", { team: owner, name: "orders" });
    expect(access.body.shareWith).toEqual([consumer]);
    expect(access.body.requests?.[0]?.state).toBe("API_ACCESS_REQUEST_STATE_WAITING");
  });

  it("of mine say how I may call each, and my requests that wait or were declined", async () => {
    const mine = await call<{ access?: { team: string; name: string; via: string; callingTeam?: string; perMinute: number }[]; requests?: Request[] }>(
      tokens.consumer,
      "ApiService/ListMyApiAccess",
    );
    expect(mine.body.access?.filter((a) => a.team === owner)).toMatchObject([{ team: owner, name: "orders", via: "API_ACCESS_VIA_CATALOG", callingTeam: consumer, perMinute: 600 }]);
    const ada = await call<{ access?: { name: string; via: string }[]; requests?: Request[] }>(tokens.ada, "ApiService/ListMyApiAccess");
    expect(ada.body.access?.map((a) => `${a.name}:${a.via}`)).toEqual(["open:API_ACCESS_VIA_USER"]);
    expect(ada.body.requests?.map((r) => r.state)).toEqual(["API_ACCESS_REQUEST_STATE_WAITING"]);
  });

  it("of a team's bots' are its members' and admins'", async () => {
    await ask("toolsMaintainer", "orders", "again", botEmail);
    const bots = await call<{ requests?: Request[] }>(tokens.toolsMember, "ApiService/ListTeamBotApiAccess", { team: tools });
    expect([...new Set(bots.body.requests?.map((r) => r.userEmail))]).toEqual([botEmail]);
    expect((await call(tokens.admin, "ApiService/ListTeamBotApiAccess", { team: tools })).code).toBe("ok");
    expect((await call(tokens.ada, "ApiService/ListTeamBotApiAccess", { team: tools })).failure).toBe("FORBIDDEN");
  });
});

describe("retired teams", () => {
  it("can't be granted to or from: the API's team's APIs aren't found; a bot of retired teams can't be granted, and its grant doesn't count", async () => {
    const made = await add("maintainer", "open", { email: oldBotEmail });
    expect(made.code).toBe("ok");
    expect(await listed("oldBot", "open")).toMatchObject({ mayCall: true });
    await db.update(teams).set({ retiredAt: new Date() }).where(eq(teams.name, oldTools));
    try {
      expect((await listed("oldBot", "open"))?.mayCall ?? false).toBe(false);
      expect((await add("maintainer", "orders", { email: oldBotEmail })).failure).toBe("TEAM_RETIRED");
    } finally {
      await db.update(teams).set({ retiredAt: null }).where(eq(teams.name, oldTools));
    }
    await db.update(teams).set({ retiredAt: new Date() }).where(eq(teams.name, owner));
    try {
      expect((await add("maintainer", "orders", { group: "x@example.com" })).code).toBe("not_found");
      expect((await ask("bob", "orders")).code).toBe("not_found");
      const [waiting] = await db.select().from(apiAccessRequests).where(and(eq(apiAccessRequests.userId, ids.ada), eq(apiAccessRequests.state, "waiting")));
      expect((await decide("maintainer", waiting?.id ?? "", { approve: true })).failure).toBe("TEAM_RETIRED");
      expect((await decide("maintainer", waiting?.id ?? "", { approve: false, reason: "no" })).failure).toBe("TEAM_RETIRED");
      // A retired team is read-only to its maintainers; an admin may still revoke (an incident).
      expect((await revoke("maintainer", made.body.grant.id)).failure).toBe("TEAM_RETIRED");
      expect((await revoke("admin", made.body.grant.id)).code).toBe("ok");
    } finally {
      await db.update(teams).set({ retiredAt: null }).where(eq(teams.name, owner));
    }
  });
});

describe("every change", () => {
  it("is audited, with what it was about", async () => {
    const rows = await db
      .select({ route: auditLog.route, target: auditLog.target, status: auditLog.status })
      .from(auditLog)
      .where(and(inArray(auditLog.actorId, [ids.maintainer, ids.ada]), like(auditLog.route, "vennir.console.v1.ApiService/%")));
    const routes = new Set(rows.map((r) => r.route.replace("vennir.console.v1.ApiService/", "")));
    for (const route of ["RequestApiAccess", "WithdrawApiAccessRequest", "DecideApiAccessRequest", "AddApiGrant", "SetApiGrantRate", "RevokeApiGrant"]) {
      expect(routes, route).toContain(route);
    }
    expect(rows.find((r) => r.route.endsWith("/AddApiGrant") && r.status === 200)?.target).toMatchObject({ team: owner, group: " Ops@Example.com ", perMinute: 9 });
    expect(rows.some((r) => r.route.endsWith("/RevokeApiGrant") && (r.target as { reason?: string }).reason === "done with it")).toBe(true);
    // Refusals too, with their status.
    expect(rows.some((r) => r.route.endsWith("/DecideApiAccessRequest") && r.status === 403)).toBe(true);
    expect(rows.some((r) => r.route.endsWith("/WithdrawApiAccessRequest") && r.status === 403)).toBe(true);
  });

  it("is told to whoever it's for and the API's maintainers, never to a bot", async () => {
    const told = async (userId: string) =>
      (
        await db
          .select({ title: notificationEvents.title, link: notificationEvents.link })
          .from(userNotifications)
          .innerJoin(notificationEvents, eq(notificationEvents.id, userNotifications.eventId))
          .where(and(eq(userNotifications.userId, userId), eq(notificationEvents.kind, "api_access")))
      ).map((r) => r.title);
    const maintainer = await told(ids.maintainer);
    expect(maintainer).toContain(`${emails.ada} asks to call ${owner}/orders`);
    expect(maintainer).toContain(`${emails.ada} may call ${owner}/orders`);
    expect(maintainer).toContain(`${emails.bob}'s request to call ${owner}/orders was declined`);
    const ada = await told(ids.ada);
    expect(ada).toContain(`${emails.ada} may call ${owner}/orders`);
    expect(ada).toContain(`${emails.ada} may no longer call ${owner}/orders`);
    expect(await told(ids.bob)).toContain(`${emails.bob}'s request to call ${owner}/orders was declined`);
    // A bot's: its team's maintainers, not the bot.
    expect(await told(ids.toolsMaintainer)).toContain(`${botEmail} may call ${owner}/orders`);
    expect(await told(ids.bot)).toEqual([]);
    // Not the API's members who aren't maintainers.
    expect(await told(ids.member)).toEqual([]);
  });
});
