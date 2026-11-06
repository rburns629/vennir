// SPDX-License-Identifier: MIT
/**
 * Single sign-on's settings in effect, and its groups.
 *
 * The provider is the install's (config.oidc, from the console chart's sso)
 * when it set one; else the one admins saved (sso_settings, its secret
 * sealed), when it's on. Every console reads the saved one every few
 * seconds, so a change reaches them all without a restart; currentSso() is
 * synchronous for the many places that only ask whether it's on.
 *
 * Groups come from the ID token's groups claim and/or Google Workspace
 * (Cloud Identity's Groups API, as this console's own Google identity,
 * asking about each Google group mapped to a team or granted an API). At
 * each sign-in, every team a group is mapped to follows them for that
 * person: added with the best role their groups give, changed, or removed;
 * and their groups are kept (user_groups) for the gateway's group grants
 * (decision 26).
 * A lookup that fails refuses the sign-in rather than counting as no
 * groups, which would take people out of their teams.
 *
 * Google groups are read again every hour between sign-ins
 * (resyncGoogleGroups). A claim can't be: only a sign-in reads it. So while
 * a claim is a source, a membership a group gave counts only for a single
 * sign-on session signed in within CLAIM_GROUPS_SESSION_SECONDS
 * (auth/plugin.ts, and the gateway the same), and a sign-in that leaves
 * someone such a membership gets a session no longer than that. The same
 * goes for a group's grant to call an API: the gateway counts a person's
 * groups only for such a session, and a sign-in whose groups hold one gets
 * a session no longer than that.
 */
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { writeAuditEntry } from "./audit.js";
import { config, sessionTtlSeconds } from "./config.js";
import { db } from "./db/client.js";
import { apiAccessRequests, apiGrants, apis, ssoGroupMappings, ssoSettings, teamMemberships, teams, userGroups, users, type TeamRole } from "./db/schema.js";
import { gcpMetadataToken } from "./gcpMetadata.js";
import { unseal } from "./sealed.js";

export const SECRET_PURPOSE = "sso client secret";
const REFRESH_MS = 10_000;
const CLOUD_IDENTITY = "https://cloudidentity.googleapis.com/v1/";
const METADATA_EMAIL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";

export interface Sso {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  allowedDomains: string[];
  label: string;
  setByInstall: boolean;
}

export interface GroupSources {
  /** The ID token claim listing a person's groups; "": none. */
  claim: string;
  google: boolean;
}

/**
 * What a person's groups are read under, as sso_settings says it: where
 * groups come from, and the saved provider (on, and which). Changing any of
 * it empties everyone's kept groups (core/sso.ts), and a write of groups
 * read under other settings than the row's now is skipped (storeUserGroups).
 */
export interface GroupSettings {
  claim: string;
  google: boolean;
  enabled: boolean;
  issuer: string;
}

const groupSettingsOf = (row: { groupsClaim: string; googleGroups: boolean; enabled: boolean; issuer: string } | undefined): GroupSettings => ({
  claim: row?.groupsClaim ?? "",
  google: row?.googleGroups ?? false,
  enabled: row?.enabled ?? false,
  issuer: row?.issuer ?? "",
});

const sameGroupSettings = (a: GroupSettings, b: GroupSettings) => a.claim === b.claim && a.google === b.google && a.enabled === b.enabled && a.issuer === b.issuer;

let saved: { provider: Sso | null; groups: GroupSources; settings: GroupSettings } = {
  provider: null,
  groups: { claim: "", google: false },
  settings: groupSettingsOf(undefined),
};

/** The group settings this console read last (refreshSso): what a sign-in or resync now reads groups under. */
export function groupSettingsNow(): GroupSettings {
  return { ...saved.settings };
}

/** The provider people may sign in with now, or null when single sign-on is off. */
export function currentSso(): Sso | null {
  return config.oidc ? { ...config.oidc, setByInstall: true } : saved.provider;
}

export function groupSources(): GroupSources {
  return saved.groups;
}

/**
 * How long after its sign-in a session counts the memberships groups gave,
 * while groups come from an ID token's claim: an hour, so someone the
 * provider takes out of a group is out of its team within the hour (the
 * console signs them out, and their next sign-in reads their groups again).
 * The owner's decision, not a setting: shorter than that signs people in
 * too often; longer is what this closes. The gateway's auth.go keeps the
 * same figure.
 */
export const CLAIM_GROUPS_SESSION_SECONDS = 60 * 60;

/**
 * Whether memberships from groups need a recent sign-in to count: single
 * sign-on is in effect (while it's off, or its secret can't be read, nobody
 * could sign in to have their groups read, and its settings change nothing)
 * and groups come from a claim, which only a sign-in reads. The gateway's
 * auth.go, the same.
 */
export function claimGroupsInUse(): boolean {
  return currentSso() !== null && groupSources().claim !== "";
}

/**
 * How long Google Workspace groups (user_groups.read_at) count for an API's
 * group grant: the hourly resync's hour and half as much again, so a resync
 * that keeps failing fails closed. The gateway's auth.go, the same.
 */
export const GOOGLE_GROUPS_FRESH_SECONDS = 90 * 60;

/**
 * Whether a person's groups (user_groups) count for an API's group grant at
 * all: single sign-on is in effect and a group source is set. Then, with a
 * claim, only for a single sign-on from the last hour (as group-given
 * teams); with Google's alone, only rows read within
 * GOOGLE_GROUPS_FRESH_SECONDS. auth/plugin.ts and apiAccess.ts apply it;
 * the gateway's auth.go, the same.
 */
export function groupSourceSet(): boolean {
  const sources = groupSources();
  return currentSso() !== null && (sources.claim !== "" || sources.google);
}

/**
 * How long a single sign-on session lasts, in seconds: config.jwtTtl, or no
 * more than CLAIM_GROUPS_SESSION_SECONDS when groups come from a claim and
 * the person holds a membership a group gave.
 */
export function ssoSessionSeconds(holdsGroupMembership: boolean): number {
  const ttl = sessionTtlSeconds(config.jwtTtl);
  return claimGroupsInUse() && holdsGroupMembership ? Math.min(ttl, CLAIM_GROUPS_SESSION_SECONDS) : ttl;
}

/** Reads the saved settings again: every few seconds, and after a save. */
export async function refreshSso(log?: FastifyBaseLogger): Promise<void> {
  const [row] = await db.select().from(ssoSettings).where(eq(ssoSettings.id, 1));
  const groups = { claim: row?.groupsClaim ?? "", google: row?.googleGroups ?? false };
  let provider: Sso | null = null;
  if (row?.enabled && row.issuer && row.clientId && row.redirectUrl && row.clientSecretEncrypted) {
    const clientSecret = unseal(row.clientSecretEncrypted, SECRET_PURPOSE);
    if (clientSecret === null) {
      log?.error({ event: "sso_secret_unreadable" }, "the single sign-on client secret can't be read (JWT_SECRET changed?): set it again on the Admin page");
    } else {
      provider = {
        issuer: row.issuer,
        clientId: row.clientId,
        clientSecret,
        redirectUrl: row.redirectUrl,
        allowedDomains: row.allowedDomains,
        label: row.label || "single sign-on",
        setByInstall: false,
      };
    }
  }
  saved = { provider, groups, settings: groupSettingsOf(row) };
}

export function startSsoRefresh(log: FastifyBaseLogger): void {
  const timer = setInterval(() => {
    refreshSso(log).catch((error: unknown) => {
      log.error({ event: "sso_refresh_failed", err: error }, "couldn't read the single sign-on settings");
    });
  }, REFRESH_MS);
  timer.unref();
}

/** Why a person's groups couldn't be read: their sign-in is refused. */
export class GroupsUnavailable extends Error {}

let identity: Promise<string> | undefined;

/** The Google account this console acts as (GKE Workload Identity), or "" off Google Cloud: asked once. */
export function googleIdentity(): Promise<string> {
  // GCE's metadata server answers only plain HTTP, on the node itself (link-local).
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
  identity ??= fetch(METADATA_EMAIL, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2_000) })
    .then(async (response) => (response.ok ? (await response.text()).trim() : ""))
    .catch(() => "");
  return identity;
}

/**
 * Which of these Google groups (by email) the person is in, directly or
 * through another group. Asked group by group (checkTransitiveMembership),
 * which a Groups Reader may do; searching all of a person's groups at once
 * (searchTransitiveGroups) needs more than that role (found on GKE,
 * 2026-10-25). A group that doesn't exist has nobody in it.
 */
async function googleGroupsOf(email: string, candidates: string[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  const token = await gcpMetadataToken();
  // Joined as text: as a relative URL, "groups:lookup" would read as a scheme.
  const get = (path: string) => fetch(CLOUD_IDENTITY + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  const query = `member_key_id == '${email.replace(/'/g, "")}'`;
  const found: string[] = [];
  for (const group of candidates) {
    const looked = await get(`groups:lookup?${new URLSearchParams({ "groupKey.id": group }).toString()}`);
    if (looked.status === 404) continue;
    if (!looked.ok) throw new Error(`Cloud Identity answered ${String(looked.status)} looking up ${group}: ${(await looked.text()).slice(0, 300)}`);
    const { name } = (await looked.json()) as { name: string };
    const checked = await get(`${name}/memberships:checkTransitiveMembership?${new URLSearchParams({ query }).toString()}`);
    if (!checked.ok) throw new Error(`Cloud Identity answered ${String(checked.status)} checking ${group}: ${(await checked.text()).slice(0, 300)}`);
    if (((await checked.json()) as { hasMembership?: boolean }).hasMembership === true) found.push(group);
  }
  return found;
}

/**
 * The person's groups, lowercased, or null when no source is set. A source
 * that's set but can't say (a missing claim, Entra ID's overage, Google's
 * API failing) throws GroupsUnavailable.
 */
export async function groupsOf(claims: Record<string, unknown>, email: string): Promise<string[] | null> {
  const sources = groupSources();
  if (!sources.claim && !sources.google) return null;
  const groups: string[] = [];
  if (sources.claim) {
    const value = claims[sources.claim];
    if (!Array.isArray(value)) {
      const overage = typeof claims["_claim_names"] === "object" && claims["_claim_names"] !== null;
      throw new GroupsUnavailable(
        overage
          ? `The provider left out the ${sources.claim} claim: too many groups to list (configure it to send only the groups assigned to Vennir).`
          : `The ID token has no ${sources.claim} claim: configure the provider to send it.`,
      );
    }
    groups.push(...value.filter((g): g is string => typeof g === "string"));
  }
  if (sources.google) {
    // Only the Google groups (by email) mapped to a team or granted an API matter.
    try {
      groups.push(...(await googleGroupsOf(email, await namedGoogleGroups())));
    } catch (error) {
      throw new GroupsUnavailable(`Couldn't read Google Workspace groups: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...new Set(groups.map((g) => g.toLowerCase()))];
}

/**
 * The groups that matter: mapped to a team (sso_group_mappings), or named
 * by an active grant (api_grants; one whose API is out of the release
 * too, so it's there when the API is back). Lowercased.
 */
async function namedGroups(): Promise<string[]> {
  const mapped = await db.selectDistinct({ group: ssoGroupMappings.groupName }).from(ssoGroupMappings);
  const granted = await db
    .selectDistinct({ group: apiGrants.groupName })
    .from(apiGrants)
    .where(and(isNull(apiGrants.revokedAt), isNotNull(apiGrants.groupName)));
  return [...new Set([...mapped.map((m) => m.group), ...granted.map((g) => g.group ?? "")].filter((g) => g !== "").map((g) => g.toLowerCase()))];
}

/** The named groups that are Google groups (by email): the ones Google is asked about. */
async function namedGoogleGroups(): Promise<string[]> {
  return (await namedGroups()).filter((g) => g.includes("@"));
}

/** Whether a person is in one Google group (by email), asked of Google now. */
export async function inGoogleGroup(email: string, group: string): Promise<boolean> {
  try {
    return (await googleGroupsOf(email, [group])).length > 0;
  } catch (error) {
    throw new GroupsUnavailable(`Couldn't read Google Workspace groups: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The most of a person's groups kept for deciding requests (users.sso_groups): a claim may list many. */
const MAX_SNAPSHOT_GROUPS = 1000;

/**
 * Keeps a person's groups as just read: all of them (at most
 * MAX_SNAPSHOT_GROUPS) in users.sso_groups, the console's alone, for a
 * request's maintainers to choose from; and in user_groups, which the
 * gateway reads, only the ones that matter (namedGroups), every one of
 * them, replacing what was there. null (no source set) keeps none.
 */
export async function storeUserGroups(userId: string, groups: string[] | null, readUnder: GroupSettings = groupSettingsNow()): Promise<boolean> {
  const all = [...new Set((groups ?? []).map((g) => g.toLowerCase()))].sort();
  const named = new Set(await namedGroups());
  const kept = all.filter((g) => named.has(g));
  const now = new Date();
  return db.transaction(async (tx) => {
    // The settings row shared-locked, so an admin's change (and the emptying
    // that follows it, clearKeptGroups) waits for this write, or this sees
    // it: groups read under settings that are no longer the row's (another
    // replica changed them since this one read them) aren't written.
    const [row] = await tx.select().from(ssoSettings).where(eq(ssoSettings.id, 1)).for("share");
    if (!sameGroupSettings(groupSettingsOf(row), readUnder)) return false;
    // The person's row locked: keepGrantedGroup waits for this, or this for it.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    await tx
      .update(users)
      .set({ ssoGroups: groups === null ? null : all.slice(0, MAX_SNAPSHOT_GROUPS), ssoGroupsReadAt: groups === null ? null : now })
      .where(eq(users.id, userId));
    await tx.delete(userGroups).where(eq(userGroups.userId, userId));
    if (kept.length > 0) await tx.insert(userGroups).values(kept.map((groupName) => ({ userId, groupName, readAt: now }))).onConflictDoNothing();
    return true;
  });
}

/**
 * A group just granted: everyone whose last-read groups (users.sso_groups)
 * include it has it in user_groups now, as read then (read_at), rather than
 * at their next sign-in.
 */
export async function keepGrantedGroup(group: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Their rows locked (storeUserGroups locks them too), and read again
    // once free: a sign-in that just took the group away wins.
    const people = await tx
      .select({ id: users.id, readAt: users.ssoGroupsReadAt })
      .from(users)
      .where(and(sql`${group} = any(${users.ssoGroups})`, isNotNull(users.ssoGroupsReadAt)))
      .for("update");
    if (people.length === 0) return;
    await tx
      .insert(userGroups)
      .values(people.map((p) => ({ userId: p.id, groupName: group, readAt: p.readAt ?? new Date() })))
      .onConflictDoNothing();
  });
}

/** One person's group, just confirmed (Google, deciding a request): kept, read now. */
export async function keepConfirmedGroup(userId: string, group: string): Promise<void> {
  await db
    .insert(userGroups)
    .values({ userId, groupName: group, readAt: new Date() })
    .onConflictDoUpdate({ target: [userGroups.userId, userGroups.groupName], set: { readAt: new Date() } });
}

/**
 * Where groups come from changed (a claim set, cleared or renamed, Google
 * turned on or off, single sign-on turned off): nobody's groups as read
 * count any more, so none are kept; each person's next sign-in (or the
 * Google resync) reads them again.
 */
export async function clearKeptGroups(tx: Pick<typeof db, "update" | "delete">): Promise<void> {
  // In the order every writer of kept groups locks (storeUserGroups,
  // keepGrantedGroup): sso_settings (the caller's), then users, then
  // user_groups; so none of them deadlocks with another.
  await tx.update(users).set({ ssoGroups: null, ssoGroupsReadAt: null }).where(isNotNull(users.ssoGroups));
  await tx.delete(userGroups);
  // Waiting requests' copies too: a maintainer can't grant a group read under the old settings.
  await tx
    .update(apiAccessRequests)
    .set({ offeredGroups: [], offeredGroupsReadAt: null, requesterGroups: [], requesterGroupsReadAt: null })
    .where(eq(apiAccessRequests.state, "waiting"));
}

/** Whether one of the person's groups (as kept) has an active grant to a live team's API. */
export async function holdsGroupGrant(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: apiGrants.id })
    .from(apiGrants)
    .innerJoin(userGroups, and(eq(userGroups.groupName, apiGrants.groupName), eq(userGroups.userId, userId)))
    .innerJoin(apis, eq(apis.id, apiGrants.apiId))
    .innerJoin(teams, eq(teams.id, apis.teamId))
    .where(and(isNull(apiGrants.revokedAt), isNull(teams.retiredAt), isNull(teams.deletedAt)))
    .limit(1);
  return row !== undefined;
}

const rank = (role: TeamRole) => (role === "maintainer" ? 2 : 1);

/**
 * Makes the person's membership of every mapped team follow their groups:
 * the best role a group of theirs is mapped to, or none. Teams nothing maps
 * to are left alone. Each change is audited (no request makes it: a sign-in
 * or the hourly resync). Returns what changed.
 */
export async function syncMappedTeams(userId: string, groups: string[], log: FastifyBaseLogger): Promise<string[]> {
  const mappings = await db
    .select({ groupName: ssoGroupMappings.groupName, teamId: ssoGroupMappings.teamId, role: ssoGroupMappings.role, teamName: teams.name })
    .from(ssoGroupMappings)
    .innerJoin(teams, eq(teams.id, ssoGroupMappings.teamId))
    // A purged team's are deleted with it; one from before never applies.
    .where(isNull(teams.deletedAt));
  if (mappings.length === 0) return [];
  const mine = new Set(groups);
  // Each mapped team's best role from the person's groups, and which of them give it.
  const wanted = new Map<string, { name: string; role: TeamRole | null; via: string[] }>();
  for (const m of mappings) {
    const current = wanted.get(m.teamId) ?? { name: m.teamName, role: null, via: [] };
    if (mine.has(m.groupName.toLowerCase())) {
      if (current.role === null || rank(m.role) > rank(current.role)) {
        current.role = m.role;
        current.via = [m.groupName];
      } else if (m.role === current.role) current.via.push(m.groupName);
    }
    wanted.set(m.teamId, current);
  }
  const held = new Map(
    (
      await db
        .select({ teamId: teamMemberships.teamId, role: teamMemberships.role })
        .from(teamMemberships)
        .where(and(eq(teamMemberships.userId, userId), inArray(teamMemberships.teamId, [...wanted.keys()])))
    ).map((m) => [m.teamId, m.role]),
  );
  const changes: string[] = [];
  const audit = (change: "joined" | "left" | "role", team: string, role: TeamRole | null, groups: string[]) =>
    writeAuditEntry(log, {
      actorId: null,
      method: "SSO",
      route: "sso-group-sync",
      target: { userId, team, change, ...(role ? { role } : {}), groups },
      status: 200,
      requestId: randomUUID(),
    });
  for (const [teamId, { name, role, via }] of wanted) {
    const now = held.get(teamId);
    const viaGroups = [...new Set(via)].sort();
    if (role === null && now) {
      await db.delete(teamMemberships).where(and(eq(teamMemberships.userId, userId), eq(teamMemberships.teamId, teamId)));
      changes.push(`left ${name}`);
      await audit("left", name, null, viaGroups);
    } else if (role && !now) {
      await db.insert(teamMemberships).values({ userId, teamId, role, viaGroups }).onConflictDoNothing();
      changes.push(`joined ${name} as ${role}`);
      await audit("joined", name, role, viaGroups);
    } else if (role) {
      // The role, and which groups give it, kept current either way.
      await db.update(teamMemberships).set({ role, viaGroups }).where(and(eq(teamMemberships.userId, userId), eq(teamMemberships.teamId, teamId)));
      if (now !== role) {
        changes.push(`${role} of ${name}`);
        await audit("role", name, role, viaGroups);
      }
    }
  }
  if (changes.length > 0) log.warn({ event: "sso_teams_synced", userId, changes }, "team memberships follow single sign-on groups");
  return changes;
}

/** How often mapped Google groups are read again for everyone, between sign-ins. */
const GROUP_RESYNC_MS = 60 * 60_000;

/**
 * Reads every single sign-on user's mapped Google Workspace groups again and
 * makes their mapped teams follow them, so leaving a group takes someone out
 * of its team within the hour, not at their next sign-in. Only when Google's
 * Groups API is the only source: groups from an ID token's claim can't be
 * read without a sign-in (CLAIM_GROUPS_SESSION_SECONDS bounds those). A person whose
 * groups can't be read now keeps their teams (failing never removes
 * anyone); the next pass tries again. Returns how many people changed.
 */
export async function resyncGoogleGroups(log: FastifyBaseLogger): Promise<number> {
  const sources = groupSources();
  // Only while single sign-on is in effect here: with its secret unreadable
  // (currentSso() null), nothing is read, so Google's rows age out past
  // GOOGLE_GROUPS_FRESH_SECONDS at the gateway too, which counts it on.
  if (currentSso() === null || !sources.google || sources.claim) return 0;
  const readUnder = groupSettingsNow();
  // Mapped to a team or granted an API: the groups anything follows.
  const named = await namedGoogleGroups();
  if (named.length === 0) return 0;
  const people = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(isNotNull(users.oidcSubject), eq(users.isBot, false)));
  let changed = 0;
  for (const person of people) {
    let groups: string[];
    try {
      groups = (await googleGroupsOf(person.email, named)).map((g) => g.toLowerCase());
    } catch (error) {
      log.warn({ event: "sso_groups_resync_failed", userId: person.id, err: error }, "couldn't read a person's Google groups; their teams stay as they are");
      continue;
    }
    try {
      // Their groups for the gateway's group grants, then their mapped teams.
      await storeUserGroups(person.id, groups, readUnder);
      if ((await syncMappedTeams(person.id, groups, log)).length > 0) changed++;
    } catch (error) {
      // Deleted while this pass ran: nothing of theirs to follow, and the
      // rest still are. Anything else fails the pass, as it should.
      if (!userIsGone(error)) throw error;
      log.info({ event: "sso_groups_resync_skipped", userId: person.id }, "a person was deleted while their groups were read");
    }
  }
  return changed;
}

/** A foreign_key_violation on a membership's user: the account was deleted (drizzle-orm wraps the pg error as `.cause`). */
function userIsGone(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "23503" &&
    "constraint" in cause &&
    (cause.constraint === "team_memberships_user_id_users_id_fk" || cause.constraint === "user_groups_user_id_users_id_fk")
  );
}

export function startGroupResync(log: FastifyBaseLogger): void {
  const timer = setInterval(() => {
    resyncGoogleGroups(log).catch((error: unknown) => {
      log.error({ event: "sso_groups_resync_failed", err: error }, "couldn't read single sign-on groups again");
    });
  }, GROUP_RESYNC_MS);
  timer.unref();
}

/**
 * A team just mapped (or, with no team, every mapped team, once a group
 * source is set): its single sign-on members' memberships follow their
 * groups from now on (their next sign-in keeps or removes them), so they
 * count as group-given (via_groups '{}', as migration 0067 marked them).
 * One added by hand while no source was set is marked here too.
 */
export async function markFollowingGroups(teamId?: string): Promise<void> {
  const ssoPeople = db.select({ id: users.id }).from(users).where(and(isNotNull(users.oidcSubject), eq(users.isBot, false)));
  const mappedTeams = db.selectDistinct({ id: ssoGroupMappings.teamId }).from(ssoGroupMappings);
  await db
    .update(teamMemberships)
    .set({ viaGroups: [] })
    .where(
      and(
        teamId ? eq(teamMemberships.teamId, teamId) : inArray(teamMemberships.teamId, mappedTeams),
        isNull(teamMemberships.viaGroups),
        inArray(teamMemberships.userId, ssoPeople),
      ),
    );
}

/** Whether a team's memberships of single sign-on users follow groups (it has a mapping). */
export async function teamIsMapped(teamId: string): Promise<boolean> {
  const [row] = await db.select({ id: ssoGroupMappings.id }).from(ssoGroupMappings).where(eq(ssoGroupMappings.teamId, teamId)).limit(1);
  return row !== undefined;
}
