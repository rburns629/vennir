// SPDX-License-Identifier: MIT
/**
 * Single sign-on as admins set it up (core/sso.ts, sso.ts): only admins
 * see or change it; the client secret is kept sealed and never sent back;
 * an issuer that doesn't answer is refused, and so is changing a provider
 * the install set. Signing in follows the saved settings (and is refused
 * while they're off). Groups, from the ID token's claim or Google
 * Workspace, make a mapped team's membership follow them at each sign-in,
 * leave unmapped teams alone, and, when they can't be read, refuse the
 * sign-in without touching anyone's teams. A mapped team's single sign-on
 * members can't be changed by hand. The settings and each membership
 * change are audited. While groups come from a claim, a session in which a
 * group gave someone a team lasts an hour at most, and such a team counts
 * only for a single sign-on from the last hour. Against a stand-in provider.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config, sessionTtlSeconds } from "../src/config.js";
import { db } from "../src/db/client.js";
import { hashPassword } from "../src/auth/password.js";
import { newSession } from "../src/auth/plugin.js";
import { addTeamMember, createTeam, createUser, purgeTeam, setUserPassword, teamRolesForUser } from "../src/db/queries.js";
import { auditLog, ssoGroupMappings, ssoSettings, teamMemberships, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { CLAIM_GROUPS_SESSION_SECONDS, refreshSso, resyncGoogleGroups } from "../src/sso.js";
import { CLIENT_ID, CLIENT_SECRET, startProvider } from "./oidcProvider.js";
import { caller, PASSWORD, rpcClient } from "./rpc.js";

const prefix = `ssoa-${randomUUID().slice(0, 6)}`;
const domain = `${prefix}.example.com`;
const teamA = `${prefix}-a`;
const teamB = `${prefix}-b`;
// Whether a membership check asks about one of this file's people: a
// resync reads every SSO account in the database, other test files' too,
// which mustn't join these teams.
const ours = (url: string) => decodeURIComponent(url).includes(`@${domain}'`);
const teamC = `${prefix}-c`;
let app: FastifyInstance;
let provider: Awaited<ReturnType<typeof startProvider>>;
const people = rpcClient(() => app);
const call = caller(() => app);
let admin: string;
let member: string;
const ids: Record<string, string> = {};

const person = (name: string, extra: Record<string, unknown> = {}) => ({ sub: `sub-${name}`, email: `${name}@${domain}`, email_verified: true, ...extra });
const settings = (extra: object = {}) => ({
  enabled: true,
  issuer: provider.issuer,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUrl: "http://localhost/api/auth/oidc/callback",
  allowedDomains: [domain],
  label: "Okta",
  groupsClaim: "groups",
  googleGroups: false,
  ...extra,
});
async function teamsOf(email: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ team: teams.name, role: teamMemberships.role })
    .from(teamMemberships)
    .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(and(eq(users.email, email), like(teams.name, `${prefix}%`)));
  return Object.fromEntries(rows.map((r) => [r.team, r.role]));
}

beforeAll(async () => {
  provider = await startProvider();
  config.oidc = null;
  app = await buildApp();
  await app.ready();
  for (const name of [teamA, teamB, teamC]) ids[name] = (await createTeam(name)).id;
  const a = await people.makeUser({ admin: true });
  const m = await people.makeUser();
  await addTeamMember(m.id, ids[teamA] ?? "", "member");
  [admin, member] = await Promise.all([a, m].map((u) => people.signIn(u.email)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.delete(ssoSettings);
  await refreshSso();
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(like(users.email, `%@${domain}`));
  await people.cleanUp();
  provider.close();
  await app.close();
});

describe("the settings", () => {
  it("are admins' only, and keep the client secret sealed and unsent", async () => {
    expect((await call(member, "SsoService/GetSsoSettings")).code).toBe("permission_denied");
    expect((await call(member, "SsoService/SetSsoSettings", settings())).code).toBe("permission_denied");
    const saved = await call<{ settings?: Record<string, unknown> }>(admin, "SsoService/SetSsoSettings", settings());
    expect(saved.code).toBe("ok");
    expect(saved.body.settings).toMatchObject({ enabled: true, clientSecretSet: true, label: "Okta", groupsClaim: "groups" });
    expect(JSON.stringify(saved.body)).not.toContain(CLIENT_SECRET);
    const [row] = await db.select().from(ssoSettings);
    expect(row?.clientSecretEncrypted).toMatch(/^v1\./);
    expect(row?.clientSecretEncrypted).not.toContain(CLIENT_SECRET);
    // Saved again without a secret: the stored one stays.
    expect((await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "", label: "Okta SSO" }))).code).toBe("ok");
    expect((await db.select().from(ssoSettings))[0]?.clientSecretEncrypted).toBe(row?.clientSecretEncrypted);
    // Audited as set: the provider and who may sign in, and whether a secret was given, never the secret.
    const audited = await db
      .select({ target: auditLog.target })
      .from(auditLog)
      .where(and(eq(auditLog.route, "vennir.console.v1.SsoService/SetSsoSettings"), eq(auditLog.status, 200)))
      .orderBy(desc(auditLog.id))
      .limit(2);
    expect(audited.map((a) => a.target)).toMatchObject([
      { issuer: provider.issuer, clientId: CLIENT_ID, allowedDomains: [domain], groupsClaim: "groups", enabled: true, label: "Okta SSO" },
      { issuer: provider.issuer, clientId: CLIENT_ID, enabled: true, secretGiven: true },
    ]);
    expect(audited[0]?.target).not.toHaveProperty("secretGiven");
    expect(JSON.stringify(audited)).not.toContain(CLIENT_SECRET);
  });

  it("refuses an issuer that doesn't answer, and a provider the install set", async () => {
    expect((await call(admin, "SsoService/SetSsoSettings", settings({ issuer: "http://127.0.0.1:9/" }))).failure).toBe("SSO_ISSUER_UNREACHABLE");
    config.oidc = { issuer: provider.issuer, clientId: "x", clientSecret: "y", redirectUrl: "http://localhost/api/auth/oidc/callback", allowedDomains: [domain], label: "Google" };
    try {
      expect((await call(admin, "SsoService/SetSsoSettings", settings())).failure).toBe("SSO_SET_BY_INSTALL");
      // Its groups are admins' still.
      const groupsOnly = await call<{ settings?: Record<string, unknown> }>(admin, "SsoService/SetSsoSettings", {
        enabled: true, issuer: "", clientId: "", clientSecret: "", redirectUrl: "", allowedDomains: [], label: "", groupsClaim: "groups", googleGroups: false,
      });
      expect(groupsOnly.body.settings).toMatchObject({ setByInstall: true, label: "Google", groupsClaim: "groups" });
    } finally {
      config.oidc = null;
    }
  });
});

describe("signing in", () => {
  it("follows the saved settings, and is refused while they're off", async () => {
    await call(admin, "SsoService/SetSsoSettings", settings({ enabled: false }));
    expect((await provider.signIn(app, person("early", { groups: [] }))).error).toBe("SSO_OFF");
    await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "" }));
    const { token, error } = await provider.signIn(app, person("first", { groups: [] }));
    expect([error, token.length > 0]).toEqual(["", true]);
  });

  it("makes a mapped team's membership follow the person's groups, and leaves other teams alone", async () => {
    await call(admin, "SsoService/SetSsoGroupMapping", { group: "G-Dev", team: teamA });
    await call(admin, "SsoService/SetSsoGroupMapping", { group: "g-lead", team: teamA, role: "TEAM_ROLE_MAINTAINER" });
    await call(admin, "SsoService/SetSsoGroupMapping", { group: "g-ops", team: teamB });
    const listed = await call<{ mappings?: unknown[] }>(admin, "SsoService/ListSsoGroupMappings");
    expect(listed.body.mappings?.length).toBeGreaterThanOrEqual(3);

    const dev = await createUser(`dev@${domain}`, null);
    await addTeamMember(dev.id, ids[teamC] ?? "", "member"); // unmapped: by hand, and stays
    expect((await provider.signIn(app, person("dev", { groups: ["g-dev"] }))).error).toBe("");
    expect(await teamsOf(`dev@${domain}`)).toEqual({ [teamA]: "member", [teamC]: "member" });
    await provider.signIn(app, person("dev", { groups: ["g-dev", "G-LEAD", "g-ops"] }));
    expect(await teamsOf(`dev@${domain}`)).toEqual({ [teamA]: "maintainer", [teamB]: "member", [teamC]: "member" });
    // Which groups give each role: only those giving the best one; none for a team added by hand.
    const via = async () =>
      Object.fromEntries(
        (
          await db
            .select({ team: teams.name, viaGroups: teamMemberships.viaGroups })
            .from(teamMemberships)
            .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
            .innerJoin(users, eq(users.id, teamMemberships.userId))
            .where(eq(users.email, `dev@${domain}`))
        ).map((m) => [m.team, m.viaGroups]),
      );
    expect(await via()).toEqual({ [teamA]: ["g-lead"], [teamB]: ["g-ops"], [teamC]: null });
    await provider.signIn(app, person("dev", { groups: ["unmapped"] }));
    expect(await teamsOf(`dev@${domain}`)).toEqual({ [teamC]: "member" });
    // Each change is in the audit log, as single sign-on's, not a request's.
    const audited = await db
      .select({ actorId: auditLog.actorId, method: auditLog.method, target: auditLog.target })
      .from(auditLog)
      .where(and(eq(auditLog.route, "sso-group-sync"), sql`${auditLog.target}->>'userId' = ${dev.id}`))
      .orderBy(asc(auditLog.id));
    expect(audited.every((a) => a.actorId === null && a.method === "SSO")).toBe(true);
    expect(audited.map((a) => a.target)).toEqual([
      { userId: dev.id, team: teamA, change: "joined", role: "member", groups: ["g-dev"] },
      ...[
        { userId: dev.id, team: teamA, change: "role", role: "maintainer", groups: ["g-lead"] },
        { userId: dev.id, team: teamB, change: "joined", role: "member", groups: ["g-ops"] },
      ].sort((a, b) => a.team.localeCompare(b.team)),
      ...[
        { userId: dev.id, team: teamA, change: "left", groups: [] },
        { userId: dev.id, team: teamB, change: "left", groups: [] },
      ],
    ]);
  });

  it("deletes the mappings of a purged team, and passes over a purged team where any are left", async () => {
    const purged = `${prefix}-purged`;
    const purgedId = (await createTeam(purged)).id;
    await call(admin, "SsoService/SetSsoGroupMapping", { group: "g-gone", team: purged });
    await createUser(`purged-member@${domain}`, null);
    await provider.signIn(app, person("purged-member", { groups: ["g-gone"] }));
    expect(await teamsOf(`purged-member@${domain}`)).toEqual({ [purged]: "member" });

    await purgeTeam(purgedId);
    expect(await db.select().from(ssoGroupMappings).where(eq(ssoGroupMappings.teamId, purgedId))).toEqual([]);
    expect(await provider.signIn(app, person("purged-member", { groups: ["g-gone"] }))).toMatchObject({ error: "" });
    expect(await teamsOf(`purged-member@${domain}`)).toEqual({});

    // A mapping a purge left before purges deleted them is passed over too,
    // and not listed; and a membership left in a purged team counts for nothing.
    await db.insert(ssoGroupMappings).values({ groupName: "g-gone", teamId: purgedId, role: "member" });
    await provider.signIn(app, person("purged-member", { groups: ["g-gone"] }));
    expect(await teamsOf(`purged-member@${domain}`)).toEqual({});
    const listed = await call<{ mappings?: { team: string }[] }>(admin, "SsoService/ListSsoGroupMappings");
    expect((listed.body.mappings ?? []).map((m) => m.team)).not.toContain(purged);
    const [member] = await db.select({ id: users.id }).from(users).where(eq(users.email, `purged-member@${domain}`));
    await addTeamMember(member!.id, purgedId, "member");
    expect((await teamRolesForUser(member!.id)).map((r) => r.name)).not.toContain(purged);
  });

  it("refuses a sign-in whose groups can't be read, touching nobody's teams", async () => {
    await provider.signIn(app, person("keeps", { groups: ["g-dev"] }));
    expect((await provider.signIn(app, person("keeps"))).error).toBe("GROUPS_UNAVAILABLE");
    expect((await provider.signIn(app, person("keeps", { _claim_names: { groups: "src1" } }))).error).toBe("GROUPS_UNAVAILABLE");
    expect(await teamsOf(`keeps@${domain}`)).toEqual({ [teamA]: "member" });
  });

  it("reads Google Workspace groups as the console's own identity", async () => {
    await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "", groupsClaim: "", googleGroups: true }));
    await call(admin, "SsoService/SetSsoGroupMapping", { group: `ops@${domain}`, team: teamB });
    const real = globalThis.fetch;
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://metadata.google.internal/")) return Promise.resolve(Response.json({ access_token: "t" }));
      if (url.startsWith("https://cloudidentity.googleapis.com/v1/groups:lookup")) {
        const group = new URL(url).searchParams.get("groupKey.id") ?? "";
        return Promise.resolve(group === `ops@${domain}` ? Response.json({ name: "groups/ops1" }) : new Response("{}", { status: 404 }));
      }
      if (url.startsWith("https://cloudidentity.googleapis.com/v1/groups/ops1/memberships:checkTransitiveMembership")) {
        seen.push(new URL(url).searchParams.get("query") ?? "");
        return Promise.resolve(Response.json({ hasMembership: ours(url) }));
      }
      return real(input, init);
    });
    expect((await provider.signIn(app, person("gws"))).error).toBe("");
    expect(seen[0]).toContain(`member_key_id == 'gws@${domain}'`);
    expect(await teamsOf(`gws@${domain}`)).toEqual({ [teamB]: "member" });

    vi.mocked(globalThis.fetch).mockImplementation((input, init) =>
      String(input).startsWith("http://metadata.google.internal/") ? Promise.resolve(new Response("no", { status: 404 })) : real(input, init),
    );
    expect((await provider.signIn(app, person("gws"))).error).toBe("GROUPS_UNAVAILABLE");
    expect(await teamsOf(`gws@${domain}`)).toEqual({ [teamB]: "member" });
  });
});

describe("a mapped team", () => {
  it("can't have its single sign-on members changed by hand; others as ever", async () => {
    const [dev] = await db.select().from(users).where(eq(users.email, `keeps@${domain}`));
    expect((await call(admin, "TeamService/RemoveMember", { team: teamA, userId: dev?.id })).failure).toBe("TEAM_FOLLOWS_SSO_GROUPS");
    expect((await call(admin, "TeamService/AddMember", { team: teamB, email: `keeps@${domain}` })).failure).toBe("TEAM_FOLLOWS_SSO_GROUPS");
    const password = await createUser(`password@${domain}`, null);
    expect((await call(admin, "TeamService/AddMember", { team: teamA, email: `password@${domain}` })).code).toBe("ok");
    // The members list says whose membership follows groups, by the same rule as the refusal.
    const follows = async () =>
      Object.fromEntries(
        ((await call<{ members: { email: string; followsGroups?: boolean }[] }>(admin, "TeamService/ListMembers", { team: teamA })).body.members ?? []).map((m) => [m.email, m.followsGroups === true]),
      );
    expect(await follows()).toMatchObject({ [`keeps@${domain}`]: true, [`password@${domain}`]: false });
    expect((await call(admin, "TeamService/RemoveMember", { team: teamA, userId: password.id })).code).toBe("ok");
    // Unmapped, the team is managed by hand again.
    for (const m of await db.select().from(ssoGroupMappings).where(eq(ssoGroupMappings.teamId, ids[teamA] ?? ""))) {
      expect((await call(admin, "SsoService/DeleteSsoGroupMapping", { id: m.id })).code).toBe("ok");
    }
    expect((await follows())[`keeps@${domain}`]).toBe(false);
    expect((await call(admin, "TeamService/RemoveMember", { team: teamA, userId: dev?.id })).code).toBe("ok");
  });
});

describe("Google Workspace groups", () => {
  it("are read again between sign-ins: leaving the group leaves the team, and a failure changes nothing", async () => {
    const real = globalThis.fetch;
    let member = true;
    let failing = false;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://metadata.google.internal/")) return Promise.resolve(Response.json({ access_token: "t" }));
      if (url.startsWith("https://cloudidentity.googleapis.com/v1/groups:lookup")) {
        if (failing) return Promise.resolve(new Response("down", { status: 503 }));
        const group = new URL(url).searchParams.get("groupKey.id") ?? "";
        return Promise.resolve(group === `ops@${domain}` ? Response.json({ name: "groups/ops1" }) : new Response("{}", { status: 404 }));
      }
      if (url.startsWith("https://cloudidentity.googleapis.com/v1/groups/ops1/memberships:checkTransitiveMembership")) {
        return Promise.resolve(Response.json({ hasMembership: member && ours(url) }));
      }
      return real(input, init);
    });
    await resyncGoogleGroups(app.log);
    expect(await teamsOf(`gws@${domain}`)).toEqual({ [teamB]: "member" });
    failing = true;
    member = false;
    await resyncGoogleGroups(app.log);
    expect(await teamsOf(`gws@${domain}`)).toEqual({ [teamB]: "member" }); // couldn't tell: kept
    failing = false;
    await resyncGoogleGroups(app.log);
    expect(await teamsOf(`gws@${domain}`)).toEqual({});
    spy.mockRestore();
  });

  it("skip someone deleted while their groups are read, and carry on with everyone else", async () => {
    const gone = await createUser(`gone@${domain}`, null);
    await db.update(users).set({ oidcSubject: `sub-gone-${prefix}` }).where(eq(users.id, gone.id));
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://metadata.google.internal/")) return Response.json({ access_token: "t" });
      if (url.startsWith("https://cloudidentity.googleapis.com/v1/groups:lookup")) {
        const group = new URL(url).searchParams.get("groupKey.id") ?? "";
        return group === `ops@${domain}` ? Response.json({ name: "groups/ops1" }) : new Response("{}", { status: 404 });
      }
      if (url.startsWith("https://cloudidentity.googleapis.com/v1/groups/ops1/memberships:checkTransitiveMembership")) {
        // Their account goes while the pass reads their groups.
        if (decodeURIComponent(url).includes(`gone@${domain}`)) await db.delete(users).where(eq(users.id, gone.id));
        return Response.json({ hasMembership: ours(url) });
      }
      return real(input, init);
    });
    await expect(resyncGoogleGroups(app.log)).resolves.toBeTypeOf("number");
    expect(await teamsOf(`gws@${domain}`)).toEqual({ [teamB]: "member" });
  });
});

describe("a session that groups from a claim gave a team", () => {
  const lifetime = (token: string) => {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { iat: number; exp: number };
    return claims.exp - claims.iat;
  };
  const teamsSeen = async (token: string) => {
    const me = await call<{ teamNames?: string[] }>(token, "AuthService/GetMe");
    return me.code === "ok" ? (me.body.teamNames ?? []).filter((t) => t.startsWith(prefix)).sort() : me.code;
  };
  /** A single sign-on session of this person's, signed in `ago` seconds before `now` (seconds) and not yet expired. */
  const signedInAgo = (userId: string, ago: number, now = Math.floor(Date.now() / 1000)) =>
    app.jwt.sign({ ...newSession(userId, true), iat: now - ago } as ReturnType<typeof newSession>, { expiresIn: 8 * 3600 });
  /** A team mapped from `group`, and a person in it by that group, signed in once. */
  async function groupMember(name: string, group: string) {
    const team = `${prefix}-${name}`;
    ids[team] = (await createTeam(team)).id;
    await call(admin, "SsoService/SetSsoGroupMapping", { group, team });
    const signedIn = await provider.signIn(app, person(name, { groups: [group] }));
    expect(signedIn.error).toBe("");
    const [row] = await db.select().from(users).where(eq(users.email, `${name}@${domain}`));
    return { team, id: row?.id ?? "", token: signedIn.token };
  }

  it("lasts an hour at most; without one, or without a claim, the install's jwtTtl", async () => {
    const ttl = sessionTtlSeconds(config.jwtTtl);
    await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "" }));
    const fresh = await groupMember("fresh", "g-fresh");
    expect(lifetime(fresh.token)).toBe(Math.min(ttl, CLAIM_GROUPS_SESSION_SECONDS));
    expect(CLAIM_GROUPS_SESSION_SECONDS).toBe(3600);
    expect(await teamsSeen(fresh.token)).toEqual([fresh.team]);
    // Groups that give no team: nothing to read again, so the whole session.
    const none = await provider.signIn(app, person("fresh-none", { groups: ["unmapped"] }));
    expect(lifetime(none.token)).toBe(ttl);
    // No groups claim (no group source at all): the whole session too, the team kept.
    await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "", groupsClaim: "" }));
    const unread = await provider.signIn(app, person("fresh"));
    expect(lifetime(unread.token)).toBe(ttl);
    expect(await teamsSeen(unread.token)).toEqual([fresh.team]);
    // A password's session too.
    const password = await people.makeUser();
    expect(lifetime(await people.signIn(password.email))).toBe(ttl);
  });

  it("counts that team only for a single sign-on from the last hour: an older one ends, a password's goes on without it", async () => {
    await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "" }));
    const { team, id } = await groupMember("hourly", "g-hourly");
    await addTeamMember(id, ids[teamC] ?? "", "member"); // unmapped: by hand
    const both = [teamC, team].sort();
    expect(await teamsSeen(signedInAgo(id, CLAIM_GROUPS_SESSION_SECONDS - 60))).toEqual(both);
    // The hour itself still counts; a second more doesn't.
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, "now").mockReturnValue(now * 1000 + 999);
    expect(await teamsSeen(signedInAgo(id, CLAIM_GROUPS_SESSION_SECONDS, now))).toEqual(both);
    expect(await teamsSeen(signedInAgo(id, CLAIM_GROUPS_SESSION_SECONDS + 1, now))).toBe("unauthenticated");
    vi.restoreAllMocks();
    const old = signedInAgo(id, CLAIM_GROUPS_SESSION_SECONDS + 60);
    expect(await teamsSeen(old)).toBe("unauthenticated");
    // Groups not from a claim (Google's are read every hour) or none: as before.
    await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "", groupsClaim: "" }));
    expect(await teamsSeen(old)).toEqual(both);
    // Single sign-on off, a claim still saved: its settings change nothing, as before.
    await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "", enabled: false }));
    expect(await teamsSeen(old)).toEqual(both);
    await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "" }));
    expect(await teamsSeen(old)).toBe("unauthenticated");
    // A team unmapped since is managed by hand: it counts as one.
    const mappings = await db.select().from(ssoGroupMappings).where(eq(ssoGroupMappings.teamId, ids[team] ?? ""));
    await db.delete(ssoGroupMappings).where(eq(ssoGroupMappings.teamId, ids[team] ?? ""));
    expect(await teamsSeen(old)).toEqual(both);
    await db.insert(ssoGroupMappings).values(mappings);
    // A password an admin set: its session never counts the group's team.
    await setUserPassword(id, await hashPassword(PASSWORD), false);
    expect(await teamsSeen(await people.signIn(`hourly@${domain}`))).toEqual([teamC]);
  });

  it("keeps the rule for a retired team: listed while recent, and an older session still ends", async () => {
    await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "" }));
    const { team, id } = await groupMember("retiring", "g-retiring");
    await db.update(teams).set({ retiredAt: new Date() }).where(eq(teams.id, ids[team] ?? ""));
    expect(await teamsSeen(signedInAgo(id, 60))).toEqual([team]);
    expect(await teamsSeen(signedInAgo(id, CLAIM_GROUPS_SESSION_SECONDS + 60))).toBe("unauthenticated");
  });

  it("counts a single sign-on member added by hand before the team was mapped as following groups", async () => {
    await call(admin, "SsoService/SetSsoSettings", settings({ clientSecret: "" }));
    const team = `${prefix}-premapped`;
    ids[team] = (await createTeam(team)).id;
    const early = await createUser(`premapped@${domain}`, null);
    await db.update(users).set({ oidcSubject: `sub-premapped-${prefix}` }).where(eq(users.id, early.id));
    await addTeamMember(early.id, ids[team] ?? "", "member");
    const old = signedInAgo(early.id, CLAIM_GROUPS_SESSION_SECONDS + 60);
    expect(await teamsSeen(old)).toEqual([team]); // not mapped yet: by hand
    await call(admin, "SsoService/SetSsoGroupMapping", { group: "g-premapped", team });
    expect(await teamsSeen(old)).toBe("unauthenticated");
    expect(await teamsSeen(signedInAgo(early.id, 60))).toEqual([team]);
  });
});
