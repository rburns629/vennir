// SPDX-License-Identifier: MIT
/**
 * Who may call each API (decision 26), and who may change that: the logic
 * behind ApiService's access methods (rpc/services/api.ts).
 *
 * Who may call (accessFor, the gateway's rule: gateway/internal/gateway's
 * accessFor, kept in step), in this order:
 *
 *   1. a member or bot of the API's own team, at the team's limit;
 *   2. a user a grant names (a person, or a bot of a team that isn't
 *      retired), at the grant's rate;
 *   3. a person (never a bot) in a single sign-on group a grant names, at
 *      the grant's rate (each member's), the best of their groups'; only
 *      while their groups count (plugin.ts's groupsCurrent: while groups
 *      come from an ID token's claim, a single sign-on session signed in
 *      within the hour);
 *   4. for this release, a member or bot of a team its api.yaml's shareWith
 *      names ("from the catalog": not revocable here), at that team's limit.
 *
 * Anyone else may not, admins included (the gateway answers 403
 * NOT_GRANTED). A team's limit is api.yaml's limit for it, else its
 * default, else the gateway's; a grant's rate is its own, else (null) the
 * API's default, else the gateway's: api.yaml's per-team limits are for
 * calling teams only, never for a grant.
 *
 * Who may change it: only the API's team's maintainers add grants, change
 * their rates and decide requests (not an admin, unless they maintain it);
 * a grant is revoked by them, an admin, the person it names, or a
 * maintainer of the bot's team it names. A person asks for themselves; a
 * maintainer of a bot's team asks for the bot. Bots change nothing here.
 * An API of a retired team isn't found (nothing is granted or served for
 * it); a bot all of whose teams are retired can't be granted, and its
 * grants don't count. Every write is audited (rpc/interceptors.ts) and told
 * (notifier.ts, kind api_access) to whoever it's for, whoever asked, and
 * the API's team's maintainers.
 */
import { Code } from "@connectrpc/connect";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import { ensureNotBot } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { findApi, findTeamByName, findUserByEmail, findUserById, listBotsForTeam, teamRolesForUser, type ApiRow } from "../db/queries.js";
import { apiAccessRequests, apiGrants, apis, teamMemberships, teams, userGroups, users, type AccessRequestState } from "../db/schema.js";
import { notify } from "../notifier.js";
import { ensureNotRetired } from "./retired.js";

type Api = ApiRow & { teamName: string };
type Grant = typeof apiGrants.$inferSelect;
type AccessRequest = typeof apiAccessRequests.$inferSelect;

/** The highest rate a grant may have, requests a minute. */
export const MAX_GRANT_PER_MINUTE = 1_000_000;
/** The longest reason a request or a decline may give. */
export const MAX_REASON = 1000;
/** The longest group name a grant may name. */
export const MAX_GROUP = 256;

export type Via = "team" | "user" | "group" | "catalog";

/** How a caller may call an API, and at what rate. */
export interface Access {
  via: Via;
  /** team, catalog: the team the gateway counts the calls against. */
  callingTeam?: string;
  /** user, group: the grant. */
  grantId?: string;
  group?: string;
  perMinute: number;
}

/** What accessFor needs of a caller besides who they are. */
export interface CallerContext {
  /** Their teams that aren't retired, in byte order (as the gateway reads them). */
  teams: string[];
  /** Their single sign-on groups as kept (user_groups); none for a bot. */
  groups: string[];
  /** Active grants that name them or one of their groups. */
  grants: Grant[];
}

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

/** The API's default limit: api.yaml's default, else the gateway's. */
export function defaultRate(api: Pick<Api, "perMinute">): number {
  return api.perMinute["default"] || config.gateway.defaultPerMinute;
}

/** A calling team's limit: api.yaml's for it, else the default. */
export function teamRate(api: Pick<Api, "perMinute">, team: string): number {
  return api.perMinute[team] || defaultRate(api);
}

/** A grant's rate: its own, else the API's default. */
export function grantRate(api: Pick<Api, "perMinute">, grant: Pick<Grant, "perMinute">): number {
  return grant.perMinute ?? defaultRate(api);
}

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * How `who` may call `api`, or null: the gateway's rule, in its order (this
 * file's comment). `ctx` is theirs (callerContext).
 */
export function accessFor(who: Pick<AuthUser, "id" | "isBot" | "groupsCurrent">, api: Api, ctx: CallerContext): Access | null {
  if (ctx.teams.includes(api.teamName)) return { via: "team", callingTeam: api.teamName, perMinute: teamRate(api, api.teamName) };
  const granted = ctx.grants.filter((g) => g.apiId === api.id && g.revokedAt === null);
  const named = granted.find((g) => g.userId === who.id);
  // A bot's grant counts while one of its teams is live: none from a retired team.
  if (named && (!who.isBot || ctx.teams.length > 0)) return { via: "user", grantId: named.id, perMinute: grantRate(api, named) };
  if (!who.isBot && who.groupsCurrent) {
    const best = granted
      .filter((g) => g.groupName !== null && ctx.groups.includes(g.groupName))
      // The best rate, then the group's name byte for byte, as the gateway picks.
      .sort((a, b) => grantRate(api, b) - grantRate(api, a) || byteOrder(a.groupName ?? "", b.groupName ?? ""))[0];
    if (best?.groupName) return { via: "group", grantId: best.id, group: best.groupName, perMinute: grantRate(api, best) };
  }
  const shared = ctx.teams.find((t) => api.shareWith.includes("*") || api.shareWith.includes(t));
  if (shared !== undefined) return { via: "catalog", callingTeam: shared, perMinute: teamRate(api, shared) };
  return null;
}

/** Of these team names, the live ones (not retired or purged), in the order given. */
async function liveTeams(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await db
    .select({ name: teams.name })
    .from(teams)
    .where(and(inArray(teams.name, names), isNull(teams.retiredAt), isNull(teams.deletedAt)));
  const live = new Set(rows.map((r) => r.name));
  return names.filter((n) => live.has(n));
}

/** A user's groups as kept (user_groups). */
async function groupsOf(userId: string): Promise<string[]> {
  const rows = await db.select({ group: userGroups.groupName }).from(userGroups).where(eq(userGroups.userId, userId)).orderBy(asc(userGroups.groupName));
  return rows.map((r) => r.group);
}

/** Everything accessFor needs of a caller. */
export async function callerContext(who: Pick<AuthUser, "id" | "isBot" | "teamNames">): Promise<CallerContext> {
  const teamNames = await liveTeams(who.teamNames);
  const groups = who.isBot ? [] : await groupsOf(who.id);
  const grants = await db
    .select()
    .from(apiGrants)
    .where(and(isNull(apiGrants.revokedAt), groups.length > 0 ? or(eq(apiGrants.userId, who.id), inArray(apiGrants.groupName, groups)) : eq(apiGrants.userId, who.id)));
  return { teams: teamNames, groups, grants };
}

/** A user as accessFor sees them, by id: their teams as now, their groups counting (as for a recent sign-in). */
async function userAsCaller(userId: string): Promise<{ who: Pick<AuthUser, "id" | "isBot" | "teamNames" | "groupsCurrent">; email: string } | null> {
  const user = await findUserById(userId);
  if (!user) return null;
  const roles = await teamRolesForUser(user.id);
  return { who: { id: user.id, isBot: user.isBot, teamNames: roles.map((r) => r.name), groupsCurrent: !user.isBot }, email: user.email };
}

// --- reading ---

/** One API by id with its team, retired or not; null once gone or purged. */
async function apiById(id: string): Promise<(Api & { retiredAt: Date | null }) | null> {
  const [row] = await db
    .select({ api: apis, teamName: teams.name, retiredAt: teams.retiredAt })
    .from(apis)
    .innerJoin(teams, eq(teams.id, apis.teamId))
    .where(and(eq(apis.id, id), isNull(teams.deletedAt)));
  return row ? { ...row.api, teamName: row.teamName, retiredAt: row.retiredAt } : null;
}

/** An API by team and name, as the caller may see it; 404 otherwise (a hidden one they may not call looks absent). */
async function visible(who: AuthUser, team: string, name: string): Promise<Api> {
  const api = await findApi(team, name);
  if (!api) throw new ApiError(404, "NOT_FOUND", `No API "${team}/${name}".`);
  // As apis.ts's sees(): a hidden one is its team's, admins', and those a grant lets in.
  if (!api.hidden || who.isAdmin || who.teamNames.includes(api.teamName)) return api;
  const via = accessFor(who, api, await callerContext(who))?.via;
  if (via === "user" || via === "group") return api;
  throw new ApiError(404, "NOT_FOUND", `No API "${team}/${name}".`);
}

/** Only a maintainer of the API's own team: an admin isn't one by being an admin. */
function ensureApiMaintainer(who: AuthUser, api: Api, what: string): void {
  ensureNotBot(who, what);
  if (!who.maintainerOf.includes(api.teamName)) {
    throw new ApiError(403, "FORBIDDEN", `Only a maintainer of ${api.teamName} may ${what}.`);
  }
}

/** The teams a bot is in that the caller maintains. */
async function botTeamsMaintainedBy(who: AuthUser, botId: string): Promise<string[]> {
  const roles = await teamRolesForUser(botId);
  return roles.map((r) => r.name).filter((t) => who.maintainerOf.includes(t));
}

/** A bot may be granted while one of its teams is live. */
async function ensureBotTeamLive(botId: string, email: string): Promise<void> {
  const live = await liveTeams((await teamRolesForUser(botId)).map((r) => r.name));
  if (live.length === 0) {
    throw new ApiError(409, "TEAM_RETIRED", `${email} is a bot of retired teams only, so nothing new can be granted to it.`);
  }
}

function perMinuteOf(perMinute: number): number | null {
  if (!Number.isInteger(perMinute) || perMinute < 0 || perMinute > MAX_GRANT_PER_MINUTE) {
    throw new ApiError(400, "BAD_REQUEST", `A rate is 1 to ${String(MAX_GRANT_PER_MINUTE)} requests a minute, or 0 for the API's default.`);
  }
  return perMinute === 0 ? null : perMinute;
}

function groupOf(group: string): string {
  const g = group.trim().toLowerCase();
  if (!g || g.length > MAX_GROUP || /[\s\p{Cc}]/u.test(g)) {
    throw new ApiError(400, "BAD_REQUEST", `A group is its name as single sign-on gives it (a groups claim value, or a Google group's email): 1 to ${String(MAX_GROUP)} characters, no spaces.`);
  }
  return g;
}

function reasonOf(reason: string, what: string): string {
  const r = reason.trim();
  if (!r) throw new ApiError(400, "BAD_REQUEST", `Say why ${what}: the API's team reads it.`);
  if (r.length > MAX_REASON) throw new ApiError(400, "BAD_REQUEST", `A reason is at most ${String(MAX_REASON)} characters.`);
  return r;
}

/** A unique index broken by a concurrent write (drizzle wraps pg's error as `.cause`). */
function isUniqueViolation(error: unknown, index: string): boolean {
  const cause: unknown = error instanceof Error ? (error.cause ?? error) : undefined;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505" && "constraint" in cause && cause.constraint === index;
}

// --- views ---

async function emailsOf(ids: (string | null)[]): Promise<Map<string, { email: string; isBot: boolean }>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select({ id: users.id, email: users.email, isBot: users.isBot }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, { email: r.email, isBot: r.isBot }]));
}

export interface GrantView {
  id: string;
  team: string;
  name: string;
  group: string;
  userId: string;
  userEmail: string;
  bot: boolean;
  perMinute: number;
  defaultRate: boolean;
  grantedBy: string;
  accessRequestId: string;
  createdAt: Date;
  updatedAt: Date;
  revokedAt: Date | null;
  revokedBy: string;
}

async function grantViews(rows: Grant[], apisById: Map<string, Api>): Promise<GrantView[]> {
  const people = await emailsOf(rows.flatMap((g) => [g.userId, g.grantedBy, g.revokedBy]));
  return rows.flatMap((g) => {
    const api = apisById.get(g.apiId);
    if (!api) return [];
    const user = g.userId ? people.get(g.userId) : undefined;
    return [
      {
        id: g.id,
        team: api.teamName,
        name: api.name,
        group: g.groupName ?? "",
        userId: g.userId ?? "",
        userEmail: user?.email ?? "",
        bot: user?.isBot ?? false,
        perMinute: grantRate(api, g),
        defaultRate: g.perMinute === null,
        grantedBy: g.grantedBy ? (people.get(g.grantedBy)?.email ?? "(deleted account)") : "",
        accessRequestId: g.fromRequest ?? "",
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        revokedAt: g.revokedAt,
        revokedBy: g.revokedBy ? (people.get(g.revokedBy)?.email ?? "(deleted account)") : "",
      },
    ];
  });
}

export interface RequestView {
  id: string;
  team: string;
  name: string;
  userId: string;
  userEmail: string;
  bot: boolean;
  requestedBy: string;
  reason: string;
  state: AccessRequestState;
  decidedBy: string;
  decisionReason: string;
  grantId: string;
  createdAt: Date;
  decidedAt: Date | null;
  groups: string[];
}

/** `withGroups`: show each person's groups (to the API's team, deciding). */
async function requestViews(rows: AccessRequest[], apisById: Map<string, Api>, withGroups = false): Promise<RequestView[]> {
  const people = await emailsOf(rows.flatMap((r) => [r.userId, r.requestedBy, r.decidedBy]));
  const groups = new Map<string, string[]>();
  if (withGroups) {
    const ids = [...new Set(rows.map((r) => r.userId))];
    if (ids.length > 0) {
      for (const g of await db.select().from(userGroups).where(inArray(userGroups.userId, ids)).orderBy(asc(userGroups.groupName))) {
        groups.set(g.userId, [...(groups.get(g.userId) ?? []), g.groupName]);
      }
    }
  }
  return rows.flatMap((r) => {
    const api = apisById.get(r.apiId);
    if (!api) return [];
    const user = people.get(r.userId);
    return [
      {
        id: r.id,
        team: api.teamName,
        name: api.name,
        userId: r.userId,
        userEmail: user?.email ?? "",
        bot: user?.isBot ?? false,
        requestedBy: r.requestedBy ? (people.get(r.requestedBy)?.email ?? "(deleted account)") : "",
        reason: r.reason,
        state: r.state,
        decidedBy: r.decidedBy ? (people.get(r.decidedBy)?.email ?? "(deleted account)") : "",
        decisionReason: r.decisionReason ?? "",
        grantId: r.grantId ?? "",
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        groups: user?.isBot ? [] : (groups.get(r.userId) ?? []),
      },
    ];
  });
}

const one = <T>(views: T[]): T => {
  const [view] = views;
  if (view === undefined) throw new Error("a row that was just written wasn't found");
  return view;
};

// --- telling ---

/** The people who maintain these teams. */
async function maintainersOf(teamNames: string[]): Promise<string[]> {
  if (teamNames.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(teamMemberships)
    .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(and(inArray(teams.name, teamNames), eq(teamMemberships.role, "maintainer"), eq(users.isBot, false), isNull(teams.deletedAt)));
  return rows.map((r) => r.id);
}

/**
 * Tells the API's maintainers, and these users (people only; for a bot,
 * its teams' maintainers), what happened. The change is made and audited
 * already: a notification that can't be made is logged, never a failure.
 */
async function tell(api: Api, title: string, body: string, about: (string | null)[]): Promise<void> {
  try {
    const people = await emailsOf(about);
    const bots = [...people].filter(([, u]) => u.isBot).map(([id]) => id);
    const botTeams = (await Promise.all(bots.map((id) => teamRolesForUser(id)))).flat().map((r) => r.name);
    const userIds = [...(await maintainersOf([api.teamName, ...botTeams])), ...[...people].filter(([, u]) => !u.isBot).map(([id]) => id)];
    await notify({
      key: `api-access:${randomUUID()}`,
      kind: "api_access",
      title,
      body,
      link: `/apis/${api.teamName}/${api.name}`,
      userIds,
      teams: [],
    });
  } catch (error) {
    console.error({ event: "api_access_notify_failed", api: `${api.teamName}/${api.name}`, err: error }, "couldn't tell people of an API access change");
  }
}

const rateText = (api: Api, perMinute: number | null) => `${String(perMinute ?? defaultRate(api))} requests a minute${perMinute === null ? " (the API's default)" : ""}`;
const principal = (g: Pick<Grant, "groupName">, email: string) => (g.groupName ? `group ${g.groupName}` : email);

// --- writes ---

/**
 * Asks for access: for the caller, or (botEmail) for a bot of a team they
 * maintain. An open API's is granted at once, at its default limit.
 */
export async function requestAccess(caller: AuthUser | undefined, team: string, name: string, reason: string, botEmail: string) {
  const who = signedIn(caller);
  ensureNotBot(who, "ask for access to an API");
  const api = await visible(who, team, name);
  const why = reasonOf(reason, "you need it");
  let target: Pick<AuthUser, "id" | "isBot" | "teamNames" | "groupsCurrent">;
  let targetEmail: string;
  if (botEmail) {
    const bot = await findUserByEmail(botEmail);
    if (!bot?.isBot || (await botTeamsMaintainedBy(who, bot.id)).length === 0) {
      throw new ApiError(403, "FORBIDDEN", `${botEmail} isn't a bot of a team you maintain: its team's maintainers ask for it.`);
    }
    await ensureBotTeamLive(bot.id, bot.email);
    target = { id: bot.id, isBot: true, teamNames: (await teamRolesForUser(bot.id)).map((r) => r.name), groupsCurrent: false };
    targetEmail = bot.email;
  } else {
    target = who;
    targetEmail = (await findUserById(who.id))?.email ?? "";
  }
  if (api.accessRequests === "closed") {
    throw new ApiError(409, "REQUESTS_CLOSED", `${api.teamName}/${api.name} takes no requests for access: ask its team directly.`);
  }
  const access = accessFor(target, api, await callerContext(target));
  if (access) {
    throw new ApiError(409, "ALREADY_ALLOWED", `${botEmail ? botEmail : "You"} may call ${api.teamName}/${api.name} already (${access.via}).`);
  }
  let made: { request: AccessRequest; grant: Grant | null };
  try {
    made = await db.transaction(async (tx) => {
      const [request] = await tx.insert(apiAccessRequests).values({ apiId: api.id, userId: target.id, requestedBy: who.id, reason: why }).returning();
      if (!request) throw new Error("no request was made");
      if (api.accessRequests !== "open") return { request, grant: null };
      // Open: granted at once, by nobody, at the API's default limit.
      const [grant] = await tx.insert(apiGrants).values({ apiId: api.id, userId: target.id, fromRequest: request.id }).returning();
      if (!grant) throw new Error("no grant was made");
      const [granted] = await tx
        .update(apiAccessRequests)
        .set({ state: "granted", grantId: grant.id, decidedAt: new Date() })
        .where(eq(apiAccessRequests.id, request.id))
        .returning();
      return { request: granted ?? request, grant };
    });
  } catch (error) {
    if (isUniqueViolation(error, "api_access_requests_one_waiting")) {
      throw new ApiError(409, "ALREADY_WAITING", `A request for ${targetEmail} waits already: withdraw it, or wait for ${api.teamName}'s answer.`);
    }
    if (isUniqueViolation(error, "api_grants_active_user")) throw new ApiError(409, "ALREADY_ALLOWED", `${targetEmail} may call it already.`);
    throw error;
  }
  const byApi = new Map([[api.id, api]]);
  if (made.grant) {
    await tell(api, `${targetEmail} may call ${api.teamName}/${api.name}`, `Its requests are open: granted at once, at ${rateText(api, null)}. Reason: ${why}`, [target.id, who.id]);
  } else {
    await tell(api, `${targetEmail} asks to call ${api.teamName}/${api.name}`, `Asked by ${(await findUserById(who.id))?.email ?? ""}: ${why}`, [target.id, who.id]);
  }
  return { request: one(await requestViews([made.request], byApi)), grant: made.grant ? one(await grantViews([made.grant], byApi)) : null };
}

async function waitingRequest(id: string): Promise<{ request: AccessRequest; api: Api & { retiredAt: Date | null } }> {
  const [request] = await db.select().from(apiAccessRequests).where(eq(apiAccessRequests.id, id));
  const api = request ? await apiById(request.apiId) : null;
  if (!request || !api) throw new ApiError(404, "NOT_FOUND", "No such request for access.");
  if (request.state !== "waiting") throw new ApiError(409, "NOT_WAITING", `That request was ${request.state} already.`);
  return { request, api };
}

/** Withdraws a waiting request: whoever asked. */
export async function withdrawRequest(caller: AuthUser | undefined, id: string): Promise<void> {
  const who = signedIn(caller);
  const { request, api } = await waitingRequest(id);
  if (request.requestedBy !== who.id) throw new ApiError(403, "FORBIDDEN", "Only whoever asked may withdraw a request.");
  const [done] = await db
    .update(apiAccessRequests)
    .set({ state: "withdrawn", decidedBy: who.id, decidedAt: new Date() })
    .where(and(eq(apiAccessRequests.id, id), eq(apiAccessRequests.state, "waiting")))
    .returning({ id: apiAccessRequests.id });
  if (!done) throw new ApiError(409, "NOT_WAITING", "That request was answered meanwhile.");
  const email = (await findUserById(request.userId))?.email ?? "";
  await tell(api, `The request for ${email} to call ${api.teamName}/${api.name} was withdrawn`, "", [request.userId, request.requestedBy]);
}

/** Grants or declines a waiting request: a maintainer of the API's team. */
export async function decideRequest(caller: AuthUser | undefined, id: string, approve: boolean, group: string, perMinute: number, reason: string) {
  const who = signedIn(caller);
  const { request, api } = await waitingRequest(id);
  ensureApiMaintainer(who, api, "decide requests to call its APIs");
  const target = await userAsCaller(request.userId);
  if (!target) throw new ApiError(404, "NOT_FOUND", "Whom that request was for is gone.");
  const byApi = new Map<string, Api>([[api.id, api]]);
  if (!approve) {
    const why = reasonOf(reason, "it's declined");
    const [declined] = await db
      .update(apiAccessRequests)
      .set({ state: "declined", decidedBy: who.id, decisionReason: why, decidedAt: new Date() })
      .where(and(eq(apiAccessRequests.id, id), eq(apiAccessRequests.state, "waiting")))
      .returning();
    if (!declined) throw new ApiError(409, "NOT_WAITING", "That request was answered meanwhile.");
    await tell(api, `${target.email}'s request to call ${api.teamName}/${api.name} was declined`, why, [request.userId, request.requestedBy]);
    return { request: one(await requestViews([declined], byApi)), grant: null };
  }
  // Nothing new for a retired team's API.
  ensureNotRetired({ name: api.teamName, retiredAt: api.retiredAt });
  const rate = perMinuteOf(perMinute);
  let groupName: string | null = null;
  if (group) {
    if (target.who.isBot) throw new ApiError(400, "BAD_REQUEST", "A bot is in no group: grant it by name.");
    groupName = groupOf(group);
    if (!(await groupsOf(request.userId)).includes(groupName)) {
      throw new ApiError(400, "NOT_THEIR_GROUP", `${target.email} isn't in ${groupName}, as the console last read their groups.`);
    }
  } else if (target.who.isBot) {
    await ensureBotTeamLive(target.who.id, target.email);
  }
  let made: { request: AccessRequest; grant: Grant };
  try {
    made = await db.transaction(async (tx) => {
      const [grant] = await tx
        .insert(apiGrants)
        .values({ apiId: api.id, ...(groupName ? { groupName } : { userId: request.userId }), perMinute: rate, grantedBy: who.id, fromRequest: request.id })
        .returning();
      if (!grant) throw new Error("no grant was made");
      const [granted] = await tx
        .update(apiAccessRequests)
        .set({ state: "granted", decidedBy: who.id, grantId: grant.id, decidedAt: new Date() })
        .where(and(eq(apiAccessRequests.id, id), eq(apiAccessRequests.state, "waiting")))
        .returning();
      if (!granted) throw new ApiError(409, "NOT_WAITING", "That request was answered meanwhile.");
      return { request: granted, grant };
    });
  } catch (error) {
    if (isUniqueViolation(error, "api_grants_active_user") || isUniqueViolation(error, "api_grants_active_group")) {
      throw new ApiError(409, "ALREADY_GRANTED", `${groupName ? `Group ${groupName}` : target.email} has a grant to ${api.teamName}/${api.name} already.`);
    }
    throw error;
  }
  await tell(
    api,
    `${target.email} may call ${api.teamName}/${api.name}`,
    `Granted ${groupName ? `through group ${groupName}` : "by name"} by ${(await findUserById(who.id))?.email ?? ""}, at ${rateText(api, rate)}.`,
    [request.userId, request.requestedBy],
  );
  return { request: one(await requestViews([made.request], byApi)), grant: one(await grantViews([made.grant], byApi)) };
}

/** Grants a group or a user (by email): a maintainer of the API's team. */
export async function addGrant(caller: AuthUser | undefined, team: string, name: string, group: string, email: string, perMinute: number) {
  const who = signedIn(caller);
  const api = await findApi(team, name);
  if (!api) throw new ApiError(404, "NOT_FOUND", `No API "${team}/${name}".`);
  ensureApiMaintainer(who, api, "grant access to its APIs");
  if (Boolean(group) === Boolean(email)) throw new ApiError(400, "BAD_REQUEST", "Grant a group or a user (by email): one of them.");
  const rate = perMinuteOf(perMinute);
  let target: { groupName: string } | { userId: string };
  let named: string;
  if (group) {
    target = { groupName: groupOf(group) };
    named = `group ${target.groupName}`;
  } else {
    const user = await findUserByEmail(email);
    if (!user) throw new ApiError(404, "NOT_FOUND", `No user ${email}.`);
    if (user.isBot) await ensureBotTeamLive(user.id, user.email);
    target = { userId: user.id };
    named = user.email;
  }
  let grant: Grant;
  try {
    grant = await db.transaction(async (tx) => {
      const [made] = await tx.insert(apiGrants).values({ apiId: api.id, ...target, perMinute: rate, grantedBy: who.id }).returning();
      if (!made) throw new Error("no grant was made");
      // A request of theirs that waits is answered by it.
      if ("userId" in target) {
        await tx
          .update(apiAccessRequests)
          .set({ state: "granted", decidedBy: who.id, grantId: made.id, decidedAt: new Date() })
          .where(and(eq(apiAccessRequests.apiId, api.id), eq(apiAccessRequests.userId, target.userId), eq(apiAccessRequests.state, "waiting")));
      }
      return made;
    });
  } catch (error) {
    if (isUniqueViolation(error, "api_grants_active_user") || isUniqueViolation(error, "api_grants_active_group")) {
      throw new ApiError(409, "ALREADY_GRANTED", `${named} has a grant to ${api.teamName}/${api.name} already: change its rate instead.`);
    }
    throw error;
  }
  await tell(api, `${named} may call ${api.teamName}/${api.name}`, `Granted by ${(await findUserById(who.id))?.email ?? ""}, at ${rateText(api, rate)}.`, [
    "userId" in target ? target.userId : null,
  ]);
  return one(await grantViews([grant], new Map([[api.id, api]])));
}

async function activeGrant(id: string): Promise<{ grant: Grant; api: Api & { retiredAt: Date | null } }> {
  const [grant] = await db.select().from(apiGrants).where(eq(apiGrants.id, id));
  const api = grant ? await apiById(grant.apiId) : null;
  if (!grant || !api) throw new ApiError(404, "NOT_FOUND", "No such grant.");
  if (grant.revokedAt) throw new ApiError(409, "REVOKED", "That grant was revoked already.");
  return { grant, api };
}

/** Changes a grant's rate: a maintainer of the API's team. */
export async function setGrantRate(caller: AuthUser | undefined, id: string, perMinute: number) {
  const who = signedIn(caller);
  const { grant, api } = await activeGrant(id);
  ensureApiMaintainer(who, api, "change the rates of its APIs' grants");
  ensureNotRetired({ name: api.teamName, retiredAt: api.retiredAt });
  const rate = perMinuteOf(perMinute);
  const [changed] = await db
    .update(apiGrants)
    .set({ perMinute: rate, updatedAt: new Date() })
    .where(and(eq(apiGrants.id, id), isNull(apiGrants.revokedAt)))
    .returning();
  if (!changed) throw new ApiError(409, "REVOKED", "That grant was revoked meanwhile.");
  const email = grant.userId ? ((await findUserById(grant.userId))?.email ?? "") : "";
  await tell(api, `${principal(grant, email)}'s rate for ${api.teamName}/${api.name} changed`, `Now ${rateText(api, rate)}.`, [grant.userId]);
  return one(await grantViews([changed], new Map([[api.id, api as Api]])));
}

/**
 * Revokes a grant: a maintainer of the API's team, an admin (an incident),
 * the person it names, or a maintainer of the bot's team it names.
 */
export async function revokeGrant(caller: AuthUser | undefined, id: string, reason: string): Promise<void> {
  const who = signedIn(caller);
  ensureNotBot(who, "revoke an API's grant");
  const { grant, api } = await activeGrant(id);
  const subject = grant.userId ? await findUserById(grant.userId) : undefined;
  const allowed =
    who.maintainerOf.includes(api.teamName) ||
    who.isAdmin ||
    grant.userId === who.id ||
    (subject?.isBot === true && (await botTeamsMaintainedBy(who, subject.id)).length > 0);
  if (!allowed) {
    throw new ApiError(403, "FORBIDDEN", `Only ${api.teamName}'s maintainers, an admin, or whom it names (a bot's team's maintainers) may revoke a grant.`);
  }
  const why = reason.trim().slice(0, MAX_REASON);
  const [revoked] = await db
    .update(apiGrants)
    .set({ revokedAt: new Date(), revokedBy: who.id })
    .where(and(eq(apiGrants.id, id), isNull(apiGrants.revokedAt)))
    .returning({ id: apiGrants.id });
  if (!revoked) throw new ApiError(409, "REVOKED", "That grant was revoked meanwhile.");
  await tell(
    api,
    `${principal(grant, subject?.email ?? "")} may no longer call ${api.teamName}/${api.name}`,
    `Revoked by ${(await findUserById(who.id))?.email ?? ""}${why ? `: ${why}` : "."}`,
    [grant.userId],
  );
}

// --- lists ---

/** An API's grants and requests: its own team, and admins. */
export async function listApiAccess(caller: AuthUser | undefined, team: string, name: string) {
  const who = signedIn(caller);
  const api = await visible(who, team, name);
  if (!who.isAdmin && !who.teamNames.includes(api.teamName)) {
    throw new ApiError(403, "FORBIDDEN", `Only ${api.teamName} and admins see who may call its APIs.`);
  }
  const byApi = new Map([[api.id, api]]);
  const grants = await db
    .select()
    .from(apiGrants)
    .where(eq(apiGrants.apiId, api.id))
    .orderBy(sql`${apiGrants.revokedAt} IS NOT NULL`, desc(apiGrants.createdAt));
  const requests = await db
    .select()
    .from(apiAccessRequests)
    .where(eq(apiAccessRequests.apiId, api.id))
    .orderBy(sql`${apiAccessRequests.state} <> 'waiting'`, desc(apiAccessRequests.createdAt));
  return { grants: await grantViews(grants, byApi), requests: await requestViews(requests, byApi, true), shareWith: api.shareWith };
}

/** Every live API, by id. */
async function liveApis(): Promise<Map<string, Api>> {
  const rows = await db
    .select({ api: apis, teamName: teams.name })
    .from(apis)
    .innerJoin(teams, eq(teams.id, apis.teamId))
    .where(and(isNull(teams.retiredAt), isNull(teams.deletedAt)))
    .orderBy(teams.name, apis.name);
  return new Map(rows.map((r) => [r.api.id, { ...r.api, teamName: r.teamName }]));
}

/** The APIs the caller may call, and how; and their requests that wait or were declined. */
export async function listMyAccess(caller: AuthUser | undefined) {
  const who = signedIn(caller);
  const all = await liveApis();
  const ctx = await callerContext(who);
  const access = [...all.values()].flatMap((api) => {
    const a = accessFor(who, api, ctx);
    return a ? [{ team: api.teamName, name: api.name, ...a }] : [];
  });
  const requests = await db
    .select()
    .from(apiAccessRequests)
    .where(and(eq(apiAccessRequests.userId, who.id), inArray(apiAccessRequests.state, ["waiting", "declined"])))
    .orderBy(desc(apiAccessRequests.createdAt));
  return { access, requests: await requestViews(requests, all) };
}

/** A team's bots' active grants, and their requests that wait or were declined: its members, and admins. */
export async function listTeamBotAccess(caller: AuthUser | undefined, team: string) {
  const who = signedIn(caller);
  const row = await findTeamByName(team);
  if (!row) throw new ApiError(404, "NOT_FOUND", `No team "${team}".`);
  if (!who.isAdmin && !who.teamNames.includes(row.name)) throw new ApiError(403, "FORBIDDEN", `Not a member of team "${team}", and not a platform admin.`);
  const bots = (await listBotsForTeam(row.id)).map((b) => b.id);
  if (bots.length === 0) return { grants: [], requests: [] };
  const all = await liveApis();
  const grants = await db
    .select()
    .from(apiGrants)
    .where(and(inArray(apiGrants.userId, bots), isNull(apiGrants.revokedAt), isNotNull(apiGrants.userId)))
    .orderBy(desc(apiGrants.createdAt));
  const requests = await db
    .select()
    .from(apiAccessRequests)
    .where(and(inArray(apiAccessRequests.userId, bots), inArray(apiAccessRequests.state, ["waiting", "declined"])))
    .orderBy(desc(apiAccessRequests.createdAt));
  return { grants: await grantViews(grants, all), requests: await requestViews(requests, all) };
}
