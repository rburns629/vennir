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
 *      within the hour).
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
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import { ensureNotBot } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { API_AWAY_DAYS, findApi, findTeamByName, findUserByEmail, findUserById, listBotsForTeam, teamRolesForUser, type ApiRow } from "../db/queries.js";
import { apiAccessRequests, apiGrants, apis, teamMemberships, teams, userGroups, users, type AccessRequestState } from "../db/schema.js";
import { notify } from "../notifier.js";
import { currentSso, GOOGLE_GROUPS_FRESH_SECONDS, groupSources, groupSourceSet, GroupsUnavailable, inGoogleGroup, keepConfirmedGroup, keepGrantedGroup } from "../sso.js";
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
/** The most groups a request may offer. */
export const MAX_OFFERED_GROUPS = 100;

export type Via = "team" | "user" | "group";

/** How a caller may call an API, and at what rate. */
export interface Access {
  via: Via;
  /** team: the team the gateway counts the calls against. */
  callingTeam?: string;
  /** user, group: the grant, and its last call (anyone's in the group, for a group's). */
  grantId?: string;
  lastUsedAt?: Date | null;
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
  if (named && (!who.isBot || ctx.teams.length > 0)) return { via: "user", grantId: named.id, lastUsedAt: named.lastUsedAt, perMinute: grantRate(api, named) };
  if (!who.isBot && who.groupsCurrent) {
    const best = granted
      .filter((g) => g.groupName !== null && ctx.groups.includes(g.groupName))
      // The best rate, then the group's name byte for byte, as the gateway picks.
      .sort((a, b) => grantRate(api, b) - grantRate(api, a) || byteOrder(a.groupName ?? "", b.groupName ?? ""))[0];
    if (best?.groupName) return { via: "group", grantId: best.id, lastUsedAt: best.lastUsedAt, group: best.groupName, perMinute: grantRate(api, best) };
  }
  return null;
}

/**
 * Whether a person who may not call `api` would through a group's grant,
 * but their groups don't count now: the gateway then asks a single sign-on
 * session to sign in again (401) rather than refusing it (its accessFor's
 * staleGroup, the same).
 */
export function staleGroupFor(who: Pick<AuthUser, "id" | "isBot" | "groupsCurrent">, api: Api, ctx: CallerContext): boolean {
  if (who.isBot || who.groupsCurrent || accessFor(who, api, ctx) !== null) return false;
  return ctx.grants.some((g) => g.apiId === api.id && g.revokedAt === null && g.groupName !== null && ctx.groups.includes(g.groupName));
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

/**
 * A user's groups as kept (user_groups) that may count: with Google's
 * groups alone (no claim), only those read within
 * GOOGLE_GROUPS_FRESH_SECONDS, so a resync that keeps failing fails closed
 * (the gateway's auth.go, the same). Whether groups count at all is the
 * caller's groupsCurrent.
 */
async function groupsOf(userId: string): Promise<string[]> {
  const fresh = groupSources().claim === "" ? gte(userGroups.readAt, new Date(Date.now() - GOOGLE_GROUPS_FRESH_SECONDS * 1000)) : undefined;
  const rows = await db
    .select({ group: userGroups.groupName })
    .from(userGroups)
    .where(and(eq(userGroups.userId, userId), fresh))
    .orderBy(asc(userGroups.groupName));
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

/** A user as accessFor sees them, by id: their teams as now, their groups counting as for a recent sign-in. */
async function userAsCaller(userId: string): Promise<{ who: Pick<AuthUser, "id" | "isBot" | "teamNames" | "groupsCurrent">; email: string } | null> {
  const user = await findUserById(userId);
  if (!user) return null;
  const roles = await teamRolesForUser(user.id);
  return { who: { id: user.id, isBot: user.isBot, teamNames: roles.map((r) => r.name), groupsCurrent: !user.isBot && groupSourceSet() }, email: user.email };
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

/** The live teams (not retired) a bot is in that the caller maintains: a retired team's maintainers act for none of its bots. */
async function botTeamsMaintainedBy(who: AuthUser, botId: string): Promise<string[]> {
  const roles = await teamRolesForUser(botId);
  return liveTeams(roles.map((r) => r.name).filter((t) => who.maintainerOf.includes(t)));
}

/** Locks an API's row for the rest of a transaction: its grants and requests change one writer at a time. */
async function lockApi(tx: Pick<typeof db, "select">, apiId: string): Promise<void> {
  const [row] = await tx.select({ id: apis.id }).from(apis).where(eq(apis.id, apiId)).for("update");
  // Gone meanwhile (a release dropped it): nothing to grant or ask for.
  if (!row) throw new ApiError(404, "NOT_FOUND", "That API isn't published any more.");
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

/** A group's name as single sign-on group mappings take it (core/sso.ts setSsoGroupMapping): trimmed, lowercased, 1 to 256 characters. */
function groupOf(group: string): string {
  const g = group.trim().toLowerCase();
  if (!g || g.length > MAX_GROUP) {
    throw new ApiError(400, "BAD_REQUEST", "A group is its name or ID as the provider sends it, or a Google group's email.");
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
  // Why the platform revoked it (superseded), when it did.
  revokeReason: string;
  // When its API left the catalog's release; null while it's published.
  awaySince: Date | null;
  // The last request let in through it (the gateway's, to a few minutes).
  lastUsedAt: Date | null;
}

/**
 * Where a row's API is: published (apisById), or away from the release, by
 * its team's name (awayTeams, by team id) and its own api_name.
 */
function placeOf(row: { apiId: string | null; teamId: string; apiName: string }, apisById: Map<string, Api>, awayTeams: Map<string, string>) {
  const api = row.apiId ? apisById.get(row.apiId) : undefined;
  if (api) return { api, team: api.teamName, name: api.name };
  const team = row.apiId === null ? awayTeams.get(row.teamId) : undefined;
  return team === undefined ? null : { api: null, team, name: row.apiName };
}

async function grantViews(rows: Grant[], apisById: Map<string, Api>, awayTeams = new Map<string, string>()): Promise<GrantView[]> {
  const people = await emailsOf(rows.flatMap((g) => [g.userId, g.grantedBy, g.revokedBy]));
  return rows.flatMap((g) => {
    const place = placeOf(g, apisById, awayTeams);
    if (!place) return [];
    const user = g.userId ? people.get(g.userId) : undefined;
    return [
      {
        id: g.id,
        team: place.team,
        name: place.name,
        group: g.groupName ?? "",
        userId: g.userId ?? "",
        userEmail: user?.email ?? "",
        bot: user?.isBot ?? false,
        perMinute: place.api ? grantRate(place.api, g) : (g.perMinute ?? config.gateway.defaultPerMinute),
        defaultRate: g.perMinute === null,
        grantedBy: g.grantedBy ? (people.get(g.grantedBy)?.email ?? "(deleted account)") : "",
        accessRequestId: g.fromRequest ?? "",
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        revokedAt: g.revokedAt,
        revokedBy: g.revokedBy ? (people.get(g.revokedBy)?.email ?? "(deleted account)") : "",
        revokeReason: g.revokeReason ?? "",
        awaySince: g.awaySince,
        lastUsedAt: g.lastUsedAt,
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
  // When those groups were read: a group read over GROUPS_DECIDE_HOURS ago
  // can't be granted from them (decideRequest).
  groupsReadAt: Date | null;
  awaySince: Date | null;
}

/**
 * `withGroups`: show each waiting request's groups (the requester's when
 * they asked), for the API's maintainers to grant one of them; never an
 * ended request's, and never to anyone else.
 */
async function requestViews(
  rows: AccessRequest[],
  apisById: Map<string, Api>,
  withGroups = false,
  awayTeams = new Map<string, string>(),
): Promise<RequestView[]> {
  const people = await emailsOf(rows.flatMap((r) => [r.userId, r.requestedBy, r.decidedBy]));
  const groups = new Map<string, { groups: string[]; readAt: Date | null }>();
  if (withGroups) for (const r of rows) if (r.state === "waiting") groups.set(r.id, await requesterGroupsOf(r));
  return rows.flatMap((r) => {
    const place = placeOf(r, apisById, awayTeams);
    if (!place) return [];
    const user = people.get(r.userId);
    const shown = withGroups && r.state === "waiting" && !user?.isBot ? groups.get(r.id) : undefined;
    return [
      {
        id: r.id,
        team: place.team,
        name: place.name,
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
        groups: shown?.groups ?? [],
        groupsReadAt: shown?.readAt ?? null,
        awaySince: r.awaySince,
      },
    ];
  });
}

/** How long a person's groups, as read, may be granted from (decideRequest): older, they sign in again first. */
export const GROUPS_DECIDE_HOURS = 24;

/**
 * A waiting request's groups to choose from: only the ones the person
 * offered when they asked, never their others. Read when they asked, or
 * (readAt) at a later sign-in whose groups still include every one of them.
 */
async function requesterGroupsOf(r: AccessRequest): Promise<{ groups: string[]; readAt: Date | null }> {
  if (r.offeredGroups.length === 0) return { groups: [], readAt: r.offeredGroupsReadAt };
  const [now] = await db.select({ groups: users.ssoGroups, readAt: users.ssoGroupsReadAt }).from(users).where(eq(users.id, r.userId));
  const still = now?.readAt && now.groups && r.offeredGroups.every((g) => now.groups?.includes(g));
  if (still && now.readAt && (!r.offeredGroupsReadAt || now.readAt > r.offeredGroupsReadAt)) return { groups: r.offeredGroups, readAt: now.readAt };
  return { groups: r.offeredGroups, readAt: r.offeredGroupsReadAt };
}

/**
 * A person's groups as last read (users.sso_groups) while they count now,
 * by the gateway's rule (groupsCurrent; with Google's groups alone, read
 * within GOOGLE_GROUPS_FRESH_SECONDS): the ones they may offer in a
 * request. Null while they don't count (and for a bot).
 */
function offerableGroups(who: Pick<AuthUser, "isBot" | "groupsCurrent">, read: { groups: string[] | null; readAt: Date | null } | undefined): string[] | null {
  if (who.isBot || !who.groupsCurrent || !read?.groups || !read.readAt) return null;
  if (groupSources().claim === "" && Date.now() - read.readAt.getTime() > GOOGLE_GROUPS_FRESH_SECONDS * 1000) return null;
  return read.groups;
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
async function tell(api: Pick<Api, "teamName" | "name">, title: string, body: string, about: (string | null)[]): Promise<void> {
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
 * Asks for access: for the caller, offering `groups` (some of theirs, as
 * last read while they count) for a group grant instead; or (botEmail) for
 * a bot of a team they maintain. An open API's is granted at once, at its
 * default limit.
 */
export async function requestAccess(caller: AuthUser | undefined, team: string, name: string, reason: string, botEmail: string, groups: string[] = []) {
  const who = signedIn(caller);
  ensureNotBot(who, "ask for access to an API");
  const api = await visible(who, team, name);
  const why = reasonOf(reason, "you need it");
  const offered = [...new Set(groups.map(groupOf))].sort();
  if (botEmail && offered.length > 0) throw new ApiError(400, "BAD_REQUEST", "A bot is in no group: it's granted by name.");
  let target: Pick<AuthUser, "id" | "isBot" | "teamNames" | "groupsCurrent">;
  let targetEmail: string;
  if (botEmail) {
    const bot = await findUserByEmail(botEmail);
    const maintained = bot?.isBot ? (await teamRolesForUser(bot.id)).map((r) => r.name).filter((t) => who.maintainerOf.includes(t)) : [];
    if (!bot || maintained.length === 0) {
      throw new ApiError(403, "FORBIDDEN", `${botEmail} isn't a bot of a team you maintain: its team's maintainers ask for it.`);
    }
    // Only for a team of theirs that isn't retired (read-only, as elsewhere).
    if ((await liveTeams(maintained)).length === 0) {
      throw new ApiError(409, "TEAM_RETIRED", `${maintained.join(", ")} is retired, so nothing new can be asked for its bots. An admin can un-retire it.`);
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
      // One writer at a time per API, and checked again inside: a grant made
      // meanwhile (AddApiGrant) means there's nothing to ask for.
      await lockApi(tx, api.id);
      const [granted] = await tx
        .select({ id: apiGrants.id })
        .from(apiGrants)
        .where(and(eq(apiGrants.apiId, api.id), eq(apiGrants.userId, target.id), isNull(apiGrants.revokedAt)));
      if (granted) throw new ApiError(409, "ALREADY_ALLOWED", `${targetEmail} may call ${api.teamName}/${api.name} already.`);
      // The groups they offer, each one of theirs as last read while they
      // count: read here, their row share-locked, so emptying them
      // (clearKeptGroups) waits for this request, and empties its copy too,
      // or this sees them emptied. Only those are kept, for the API's
      // maintainers to grant one of them; never their others.
      const [read] = offered.length === 0 ? [] : await tx.select({ groups: users.ssoGroups, readAt: users.ssoGroupsReadAt }).from(users).where(eq(users.id, who.id)).for("share");
      const counted = offerableGroups(who, read);
      if (offered.length > 0 && counted === null) {
        throw new ApiError(409, "GROUPS_STALE", "Your groups haven't been read lately enough to offer one: sign in again, then ask.");
      }
      const theirs = counted ?? [];
      const notTheirs = offered.filter((g) => !theirs.includes(g));
      if (notTheirs.length > 0) throw new ApiError(400, "NOT_THEIR_GROUP", `You aren't in ${notTheirs.join(", ")}, as your groups were last read: offer only your own.`);
      const offeredGroupsReadAt = offered.length > 0 ? (read?.readAt ?? null) : null;
      const key = { apiId: api.id, teamId: api.teamId, apiName: api.name };
      const [request] = await tx.insert(apiAccessRequests).values({ ...key, userId: target.id, requestedBy: who.id, reason: why, offeredGroups: offered, offeredGroupsReadAt }).returning();
      if (!request) throw new Error("no request was made");
      if (api.accessRequests !== "open") return { request, grant: null };
      // Open: granted at once, by nobody, at the API's default limit; the
      // request it answers marked granted in the same transaction.
      const [grant] = await tx.insert(apiGrants).values({ ...key, userId: target.id, fromRequest: request.id }).returning();
      if (!grant) throw new Error("no grant was made");
      const [answered] = await tx
        .update(apiAccessRequests)
        .set({ state: "granted", grantId: grant.id, decidedAt: new Date() })
        .where(eq(apiAccessRequests.id, request.id))
        .returning();
      return { request: answered ?? request, grant };
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
  const api = request?.apiId ? await apiById(request.apiId) : null;
  if (!request || !api) throw new ApiError(404, "NOT_FOUND", "No such request for access.");
  if (request.state !== "waiting") throw new ApiError(409, "NOT_WAITING", `That request was ${request.state} already.`);
  return { request, api };
}

/**
 * A waiting request, of a published API or of one away from the release
 * (to withdraw: its requester sees it listed meanwhile).
 */
async function waitingOrAwayRequest(id: string): Promise<{ request: AccessRequest; api: Pick<Api, "teamName" | "name"> }> {
  const [away] = await db.select().from(apiAccessRequests).where(and(eq(apiAccessRequests.id, id), isNull(apiAccessRequests.apiId)));
  if (!away) return waitingRequest(id);
  const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, away.teamId));
  if (!team) throw new ApiError(404, "NOT_FOUND", "No such request for access.");
  if (away.state !== "waiting") throw new ApiError(409, "NOT_WAITING", `That request was ${away.state} already.`);
  return { request: away, api: { teamName: team.name, name: away.apiName } };
}

/**
 * Withdraws a waiting request (its API published or away): whoever asked,
 * or, for a bot's, a maintainer of one of the bot's teams that isn't
 * retired (a bot's owners are its team's maintainers).
 */
export async function withdrawRequest(caller: AuthUser | undefined, id: string): Promise<void> {
  const who = signedIn(caller);
  const { request, api } = await waitingOrAwayRequest(id);
  if (request.requestedBy !== who.id && !(await ownsBot(who, request.userId))) {
    throw new ApiError(403, "FORBIDDEN", "Only whoever asked may withdraw a request, or, for a bot's, its team's maintainers.");
  }
  const [done] = await db
    .update(apiAccessRequests)
    .set({ state: "withdrawn", decidedBy: who.id, decidedAt: new Date() })
    .where(and(eq(apiAccessRequests.id, id), eq(apiAccessRequests.state, "waiting")))
    .returning({ id: apiAccessRequests.id });
  if (!done) throw new ApiError(409, "NOT_WAITING", "That request was answered meanwhile.");
  const email = (await findUserById(request.userId))?.email ?? "";
  await tell(api, `The request for ${email} to call ${api.teamName}/${api.name} was withdrawn`, "", [request.userId, request.requestedBy]);
}

/** Whether `userId` is a bot of a team `who` maintains that isn't retired. */
async function ownsBot(who: AuthUser, userId: string): Promise<boolean> {
  const user = await findUserById(userId);
  if (!user?.isBot) return false;
  const maintained = (await teamRolesForUser(user.id)).map((r) => r.name).filter((t) => who.maintainerOf.includes(t));
  return (await liveTeams(maintained)).length > 0;
}

/** Grants or declines a waiting request: a maintainer of the API's team. */
export async function decideRequest(caller: AuthUser | undefined, id: string, approve: boolean, group: string, perMinute: number, reason: string) {
  const who = signedIn(caller);
  const { request, api } = await waitingRequest(id);
  ensureApiMaintainer(who, api, "decide requests to call its APIs");
  ensureNotRetired({ name: api.teamName, retiredAt: api.retiredAt });
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
  const rate = perMinuteOf(perMinute);
  let groupName: string | null = null;
  // Whether Google confirmed it just now (then it's kept for the person, read now).
  let confirmed = false;
  if (group) {
    if (target.who.isBot) throw new ApiError(400, "BAD_REQUEST", "A bot is in no group: grant it by name.");
    groupName = groupOf(group);
    // Only a group they offered when they asked: never another, so a
    // refusal says nothing about groups they didn't offer.
    const read = await requesterGroupsOf(request);
    if (!read.groups.includes(groupName)) {
      throw new ApiError(400, "GROUP_NOT_OFFERED", `${target.email} didn't offer ${groupName} when they asked: grant one they offered, or them by name.`);
    }
    const fresh = read.readAt !== null && Date.now() - read.readAt.getTime() <= GROUPS_DECIDE_HOURS * 3_600_000;
    if (!fresh) {
      // Read too long ago: with Google Workspace groups, Google may say
      // they're in it still.
      const sources = groupSources();
      try {
        confirmed = currentSso() !== null && sources.google && groupName.includes("@") && (await inGoogleGroup(target.email, groupName));
      } catch (error) {
        if (error instanceof GroupsUnavailable) throw new ApiError(503, "GROUPS_UNAVAILABLE", error.message);
        throw error;
      }
      if (!confirmed) {
        throw new ApiError(409, "GROUPS_STALE", `${target.email}'s groups were read over ${String(GROUPS_DECIDE_HOURS)} hours ago: ask them to sign in again, then decide.`);
      }
    }
  } else if (target.who.isBot) {
    await ensureBotTeamLive(target.who.id, target.email);
  }
  let made: { request: AccessRequest; grant: Grant };
  try {
    made = await db.transaction(async (tx) => {
      await lockApi(tx, api.id);
      const [grant] = await tx
        .insert(apiGrants)
        .values({
          apiId: api.id,
          teamId: api.teamId,
          apiName: api.name,
          ...(groupName ? { groupName } : { userId: request.userId }),
          perMinute: rate,
          grantedBy: who.id,
          fromRequest: request.id,
        })
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
  // The granted group is kept for whoever's in it (as last read), and
  // for the requester as Google just said.
  if (groupName) {
    await keepGrantedGroup(groupName);
    if (confirmed) await keepConfirmedGroup(request.userId, groupName);
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
      await lockApi(tx, api.id);
      const [made] = await tx.insert(apiGrants).values({ apiId: api.id, teamId: api.teamId, apiName: api.name, ...target, perMinute: rate, grantedBy: who.id }).returning();
      if (!made) throw new Error("no grant was made");
      // A request of theirs that waits is answered by it, in the same
      // transaction (requestAccess takes the same lock, and checks again).
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
  if ("groupName" in target) await keepGrantedGroup(target.groupName);
  await tell(api, `${named} may call ${api.teamName}/${api.name}`, `Granted by ${(await findUserById(who.id))?.email ?? ""}, at ${rateText(api, rate)}.`, [
    "userId" in target ? target.userId : null,
  ]);
  return one(await grantViews([grant], new Map([[api.id, api]])));
}

async function activeGrant(id: string): Promise<{ grant: Grant; api: Api & { retiredAt: Date | null } }> {
  const [grant] = await db.select().from(apiGrants).where(eq(apiGrants.id, id));
  const api = grant?.apiId ? await apiById(grant.apiId) : null;
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
  const [away] = await db.select().from(apiGrants).where(and(eq(apiGrants.id, id), isNull(apiGrants.apiId)));
  if (away) return revokeAwayGrant(who, away, reason);
  const { grant, api } = await activeGrant(id);
  const subject = grant.userId ? await findUserById(grant.userId) : undefined;
  const asMaintainer = who.maintainerOf.includes(api.teamName) && api.retiredAt === null;
  const allowed =
    asMaintainer ||
    who.isAdmin ||
    grant.userId === who.id ||
    (subject?.isBot === true && (await botTeamsMaintainedBy(who, subject.id)).length > 0);
  if (!allowed) {
    // Its maintainers, while their team is retired: read-only, as elsewhere.
    if (who.maintainerOf.includes(api.teamName)) ensureNotRetired({ name: api.teamName, retiredAt: api.retiredAt });
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

/**
 * Revokes a grant of an API that left the release (kept API_AWAY_DAYS to
 * come back with it): its team's maintainers, while the team is live, or
 * an admin.
 */
async function revokeAwayGrant(who: AuthUser, grant: Grant, reason: string): Promise<void> {
  const [team] = await db.select().from(teams).where(and(eq(teams.id, grant.teamId), isNull(teams.deletedAt)));
  if (!team) throw new ApiError(404, "NOT_FOUND", "No such grant.");
  if (grant.revokedAt) throw new ApiError(409, "REVOKED", "That grant was revoked already.");
  if (!who.isAdmin) {
    if (!who.maintainerOf.includes(team.name)) throw new ApiError(403, "FORBIDDEN", `Only ${team.name}'s maintainers, or an admin, may revoke a grant of its API that left the release.`);
    ensureNotRetired(team);
  }
  const [revoked] = await db
    .update(apiGrants)
    .set({ revokedAt: new Date(), revokedBy: who.id })
    .where(and(eq(apiGrants.id, grant.id), isNull(apiGrants.revokedAt)))
    .returning({ id: apiGrants.id });
  if (!revoked) throw new ApiError(409, "REVOKED", "That grant was revoked meanwhile.");
  const why = reason.trim().slice(0, MAX_REASON);
  const subject = grant.userId ? await findUserById(grant.userId) : undefined;
  await tell(
    { teamName: team.name, name: grant.apiName },
    `${principal(grant, subject?.email ?? "")} won't call ${team.name}/${grant.apiName} if it's back`,
    `Revoked while the API is out of the catalog's release, by ${(await findUserById(who.id))?.email ?? ""}${why ? `: ${why}` : "."}`,
    [grant.userId],
  );
}

/** The teams these rows' APIs are of, by id: for the ones away from the release. */
async function awayTeamsOf(rows: { apiId: string | null; teamId: string }[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.filter((r) => r.apiId === null).map((r) => r.teamId))];
  if (ids.length === 0) return new Map();
  const found = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, ids));
  return new Map(found.map((t) => [t.id, t.name]));
}

/**
 * The grants and requests of a team's APIs that left the release, each
 * with when (away_since): its members, and admins.
 */
export async function listAwayAccess(caller: AuthUser | undefined, team: string) {
  const who = signedIn(caller);
  const row = await findTeamByName(team);
  if (!row) throw new ApiError(404, "NOT_FOUND", `No team "${team}".`);
  if (!who.isAdmin && !who.teamNames.includes(row.name)) throw new ApiError(403, "FORBIDDEN", `Not a member of team "${team}", and not a platform admin.`);
  const away = new Map([[row.id, row.name]]);
  const grants = await db
    .select()
    .from(apiGrants)
    .where(and(eq(apiGrants.teamId, row.id), isNull(apiGrants.apiId)))
    .orderBy(asc(apiGrants.apiName), sql`${apiGrants.revokedAt} IS NOT NULL`, desc(apiGrants.createdAt));
  const requests = await db
    .select()
    .from(apiAccessRequests)
    .where(and(eq(apiAccessRequests.teamId, row.id), isNull(apiAccessRequests.apiId)))
    .orderBy(asc(apiAccessRequests.apiName), desc(apiAccessRequests.createdAt));
  return { grants: await grantViews(grants, new Map(), away), requests: await requestViews(requests, new Map(), false, away) };
}

/** ListAllApiGrants' page when none is asked for, and its largest. */
export const ALL_GRANTS_PAGE = 100;
export const ALL_GRANTS_MAX = 500;

/**
 * Every active grant on the install, newest first, a page at a time (the
 * cursor is how many came before): published APIs' and away ones', of
 * teams that aren't retired. With how many there are of each kind and the
 * requests waiting, for the whole install. Admins: for an incident, they
 * revoke; adding and changing grants are each API's team's.
 */
export async function listAllGrants(caller: AuthUser | undefined, limit: number, cursor: string) {
  const who = signedIn(caller);
  if (!who.isAdmin) throw new ApiError(403, "FORBIDDEN", "Only admins see every API's grants.");
  const size = Math.min(limit > 0 ? limit : ALL_GRANTS_PAGE, ALL_GRANTS_MAX);
  const offset = /^\d{1,9}$/.test(cursor) ? Number(cursor) : 0;
  if (cursor && !/^\d{1,9}$/.test(cursor)) throw new ApiError(400, "BAD_REQUEST", "That cursor isn't one this list gave.");
  const liveTeam = and(isNull(teams.deletedAt), isNull(teams.retiredAt));
  const active = and(isNull(apiGrants.revokedAt), liveTeam);
  const rows = await db
    .select({ grant: apiGrants, teamName: teams.name })
    .from(apiGrants)
    .innerJoin(teams, eq(teams.id, apiGrants.teamId))
    .where(active)
    .orderBy(desc(apiGrants.createdAt), desc(apiGrants.id))
    .limit(size + 1)
    .offset(offset);
  const page = rows.slice(0, size);
  const away = new Map(page.filter((r) => r.grant.apiId === null).map((r) => [r.grant.teamId, r.teamName]));
  const grants = await grantViews(page.map((r) => r.grant), await liveApis(), away);
  // The counts, for the whole install: one small row per grant.
  const kinds = await db
    .select({ group: apiGrants.groupName, bot: users.isBot })
    .from(apiGrants)
    .innerJoin(teams, eq(teams.id, apiGrants.teamId))
    .leftJoin(users, eq(users.id, apiGrants.userId))
    .where(active);
  const waiting = await db
    .select({ teamId: apiAccessRequests.teamId, apiName: apiAccessRequests.apiName })
    .from(apiAccessRequests)
    .innerJoin(teams, eq(teams.id, apiAccessRequests.teamId))
    .where(and(eq(apiAccessRequests.state, "waiting"), liveTeam));
  return {
    grants,
    nextCursor: rows.length > size ? String(offset + size) : "",
    total: kinds.length,
    groups: kinds.filter((k) => k.group !== null).length,
    people: kinds.filter((k) => k.group === null && k.bot !== true).length,
    bots: kinds.filter((k) => k.group === null && k.bot === true).length,
    waitingRequests: waiting.length,
    waitingApis: new Set(waiting.map((w) => `${w.teamId}/${w.apiName}`)).size,
  };
}

/**
 * What API_AWAY_DAYS after its API left the release is past keeping
 * (retention.ts, hourly): its grants deleted; its waiting requests
 * declined, saying why (the person sees it among their requests); and its
 * ended requests deleted once ended that long. Returns how many went.
 */
export async function pruneAwayAccess(): Promise<number> {
  const cutoff = sql`now() - make_interval(days => ${API_AWAY_DAYS})`;
  const grants = await db.delete(apiGrants).where(and(isNull(apiGrants.apiId), lt(apiGrants.awaySince, cutoff))).returning({ id: apiGrants.id });
  await db
    .update(apiAccessRequests)
    .set({ state: "declined", decisionReason: `The API left the catalog's release over ${String(API_AWAY_DAYS)} days ago.`, decidedAt: new Date() })
    .where(and(isNull(apiAccessRequests.apiId), lt(apiAccessRequests.awaySince, cutoff), eq(apiAccessRequests.state, "waiting")));
  const requests = await db
    .delete(apiAccessRequests)
    .where(and(isNull(apiAccessRequests.apiId), lt(apiAccessRequests.awaySince, cutoff), ne(apiAccessRequests.state, "waiting"), lt(apiAccessRequests.decidedAt, cutoff)))
    .returning({ id: apiAccessRequests.id });
  return grants.length + requests.length;
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
  return { grants: await grantViews(grants, byApi), requests: await requestViews(requests, byApi, who.maintainerOf.includes(api.teamName)) };
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

/** The APIs the caller may call, and how; their requests that wait or were declined; and the groups they may offer in one. */
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
  const [read] = who.isBot ? [] : await db.select({ groups: users.ssoGroups, readAt: users.ssoGroupsReadAt }).from(users).where(eq(users.id, who.id));
  return { access, requests: await requestViews(requests, all, false, await awayTeamsOf(requests)), groups: offerableGroups(who, read) ?? [] };
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
  return { grants: await grantViews(grants, all), requests: await requestViews(requests, all, false, await awayTeamsOf(requests)) };
}
