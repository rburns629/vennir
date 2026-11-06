// SPDX-License-Identifier: MIT
/**
 * Teams and their lifecycle: the logic behind TeamService.
 *
 * Creating a team is a platform-level action: only a platform admin, or an
 * automation token holding teams:create (auth/scopes.ts), or the
 * catalog's release (catalogSync.ts). A team is also a Kubernetes namespace tasks are
 * dispatched into, so it isn't something any registered user may mint.
 *
 * The creator is deliberately not made a member. Admins already reach every
 * team, and making catalog CI a member of every team it created was how one
 * leaked CI token came to control every platform, back when CI called the
 * console. A new team starts empty;
 * an admin adds its first members. Growing it stays self-service within the
 * team: a maintainer, or an admin, can add another.
 */
import { Code } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import type { FastifyBaseLogger } from "fastify";
import { currentSso, groupSources, teamIsMapped } from "../sso.js";
import { ApiError, externalSecretsMissing, forbiddenUnlessAdmin } from "../apiError.js";
import { canActForTeam, ensureNotBot, ensureTeamMaintainer, ensureTeamMember } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { hasScope, SCOPES } from "../auth/scopes.js";
import { config, QUANTITY } from "../config.js";
import type { TeamQuota } from "../k8s.js";
import {
  addTeamMember,
  createTeam,
  deleteProductsForTeam,
  findSubmittedExecutions,
  findTeamByName,
  findUserById,
  findTeamByNameIncludingDeleted,
  findUserByEmail,
  listAllTeams,
  listMembersForTeam,
  listSubmittedExecutionsForTeams,
  purgeTeam as purgeTeamRecords,
  removeTeamMember,
  setTeamMemberRole,
  setTeamRequireSso,
  setTeamRetired,
  type TeamMember,
} from "../db/queries.js";
import { secretStoreIdentities, teamMemberships, teams, type TeamRole } from "../db/schema.js";
import { db } from "../db/client.js";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  applySecretStoreObjects,
  ExternalSecretsMissingError,
  deleteTeamNamespace,
  listTaskPods,
  NamespaceNotTeamsError,
  ProtectedNamespaceError,
  apiNamespace,
  hasApiNamespace,
  NAMESPACE_MAX,
  setApiNamespace,
  setTeamNamespace,
  type TeamNamespaceState,
  unfinishedPodsByNamespace,
} from "../k8s.js";
import { getExecutionStates } from "../kernel/client.js";
import { syncGatewayTokenPolicy } from "../gatewayTokenPolicy.js";
import { syncIdentityPolicy } from "../productPolicy.js";
import { copyPullSecret } from "../pullSecret.js";
import { ensureSchedulerLogsBinding } from "../schedulerLogs.js";
import { ensureTeamNetworkPolicy } from "../teamNetwork.js";
import { ensureTeamQuota } from "../teamQuota.js";
import { ensureNotRetired } from "./retired.js";
import { ownApiNamespace, ownApiNamespaces } from "./apis.js";
import { checkSecretStoreObjects, cloudIdentities } from "../secretStores.js";
import { isUniqueViolation } from "./products.js";
import { platformAlert } from "../notifier.js";

/** A team's name is also its namespace's: a DNS label. */
export const TeamName = Type.String({ pattern: "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" });
export const MemberEmail = Type.String({ format: "email" });
export const MemberId = Type.String({ format: "uuid" });
export const SecretStoreDocuments = Type.Array(Type.Unknown(), { minItems: 1, maxItems: 20 });
export const SecretStoreCredential = Type.String({ minLength: 1, maxLength: 16384 });

const nameReserved = (name: string) =>
  new ApiError(409, "NAME_RESERVED", `"${name}" belonged to a team that was purged, and team names are never reused.`);
const noSuchTeam = () => new ApiError(404, "NOT_FOUND", "No such team.");

/**
 * Refuses a new team's name that would be, or couldn't have, an API
 * backends' namespace (k8s.ts apiNamespace): `<name>-apis` is the team's
 * own, so no team may be called that (nor a new one whose `<name>-apis` is
 * an older team's name), and it must fit a namespace's 63 characters. Teams
 * named before stay. The catalog tool refuses the same
 * names (cli/internal/catalogtool, team.schema.json).
 */
export async function refuseNewTeamName(name: string): Promise<void> {
  if (name.endsWith("-apis")) {
    throw new ApiError(422, "UNPROCESSABLE_ENTITY", `A team's name can't end in -apis: <team>-apis is where a team's API backends run.`);
  }
  if (!hasApiNamespace(name)) {
    throw new ApiError(
      422,
      "UNPROCESSABLE_ENTITY",
      `A team's name can be at most ${String(NAMESPACE_MAX - "-apis".length)} characters, so that ${apiNamespace(name)} fits a namespace's ${String(NAMESPACE_MAX)}.`,
    );
  }
  if (await findTeamByNameIncludingDeleted(apiNamespace(name))) {
    throw new ApiError(409, "NAMESPACE_EXISTS", `${apiNamespace(name)}, where this team's API backends would run, is another team's name.`);
  }
}

/**
 * Sets the team's namespace label, and its API backends' namespace's
 * (k8s.ts setApiNamespace), when the console manages team namespaces
 * (config.teamNamespaces); refuses a namespace that can't be a team's. A
 * new team's API backends' namespace comes first, so a name whose
 * `<name>-apis` can't be its never gets a namespace the kernel dispatches
 * into. An existing team's that can't be its (a namespace of that name was
 * there first) is logged and left, and the policy resync reports it
 * (syncApiNamespaces): the team itself goes on.
 */
async function setTeamNamespaceState(
  name: string,
  state: TeamNamespaceState,
  createIfMissing: boolean,
  log: FastifyBaseLogger,
  isNew = false,
): Promise<void> {
  if (!config.teamNamespaces.manage) return;
  try {
    const options = { ...config.teamNamespaces, createIfMissing };
    let apis = await ownApiNamespace(name);
    if (apis && isNew) await setApiNamespace(name, state, options);
    await setTeamNamespace(name, state, options);
    if (apis && !isNew) {
      try {
        await setApiNamespace(name, state, options);
      } catch (error) {
        if (!(error instanceof NamespaceNotTeamsError || error instanceof ProtectedNamespaceError)) throw error;
        log.warn({ event: "api_namespace_refused", team: name, namespace: apis, reason: error.message }, "the team's API backends' namespace can't be its");
        apis = null;
      }
    }
    if (state === "true") {
      await ensureTeamNetworkPolicy(name, apis);
      await ensureSchedulerLogsBinding(name);
      await ensureTeamQuota(name);
      await copyPullSecret(name);
    }
  } catch (error) {
    if (error instanceof ProtectedNamespaceError) throw new ApiError(422, "UNPROCESSABLE_ENTITY", error.message);
    if (error instanceof NamespaceNotTeamsError) throw new ApiError(409, "NAMESPACE_EXISTS", error.message);
    throw error;
  }
}

/**
 * Gives every team its API backends' namespace (k8s.ts setApiNamespace),
 * labelled as the team is: made for an active team that has none (teams
 * made before there were any), relabelled for a retired one. In every
 * policy resync (policySync.ts), before the network policies are written.
 * Returns whether it applies; throws (after trying every team) if any
 * failed.
 */
export async function syncApiNamespaces(): Promise<boolean> {
  if (!config.teamNamespaces.manage) return false;
  const failed: string[] = [];
  const all = await listAllTeams();
  const own = await ownApiNamespaces(all.map((t) => t.name));
  for (const team of all) {
    if (!own.has(team.name)) continue;
    const active = team.retiredAt === null;
    try {
      await setApiNamespace(team.name, active ? "true" : "retired", { ...config.teamNamespaces, createIfMissing: active });
    } catch {
      failed.push(apiNamespace(team.name));
    }
  }
  if (failed.length > 0) throw new Error(`Couldn't make or label the API backends' namespaces: ${failed.join(", ")}.`);
  return true;
}

const TERMINAL_EXECUTION_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

/** Executions touching this team that haven't finished. Asks kernel-api for
 * live states; if it can't answer, this throws, so a purge fails closed
 * instead of proceeding on a guess. Every one of the team's executions, not
 * a page: a purge must see them all. */
async function unfinishedExecutionIds(teamName: string): Promise<string[]> {
  const ids = (await listSubmittedExecutionsForTeams([teamName])).map((row) => row.executionId);
  const states = await getExecutionStates(ids);
  return states.filter(({ state }) => !TERMINAL_EXECUTION_STATES.has(state)).map(({ executionId }) => executionId);
}

export async function allTeams(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller);
  return listAllTeams();
}

export async function newTeam(caller: AuthUser | undefined, name: string, log: FastifyBaseLogger) {
  if (!caller?.isAdmin && !hasScope(caller, SCOPES.TEAMS_CREATE)) {
    throw new ApiError(403, "FORBIDDEN", "Creating a team requires admin access (or an automation token with teams:create).");
  }
  const existing = await findTeamByNameIncludingDeleted(name);
  // A distinct code, not the plain "already exists" a caller may treat as
  // success: a purged platform's name can't be reused (schema.ts's
  // teams.deletedAt), and that must fail.
  if (existing?.deletedAt) throw nameReserved(name);
  if (existing) throw new ApiError(409, "CONFLICT", "Team already exists.", Code.AlreadyExists);
  await refuseNewTeamName(name);
  // The namespace first: a name that can't be a team's namespace never
  // becomes a team.
  await setTeamNamespaceState(name, "true", true, log, true);
  const team = await createTeam(name);
  log.info({ team: team.name, createdBy: caller?.id }, "team created");
  return team;
}

/**
 * Makes sure a team exists and is active, with its namespace: what a
 * catalog release does for every team folder, any number of times. Creates the team if it's new (teams:create), un-retires it if it
 * was retired (teams:retire too: a team folder restored), and puts its
 * namespace's label back if it drifted. A purged team's name stays refused.
 */
export async function ensureTeam(caller: AuthUser | undefined, name: string, log: FastifyBaseLogger) {
  if (!caller || (!caller.isAdmin && !hasScope(caller, SCOPES.TEAMS_CREATE))) {
    throw new ApiError(403, "FORBIDDEN", "Requires admin access or teams:create.");
  }
  const existing = await findTeamByNameIncludingDeleted(name);
  if (existing?.deletedAt) throw nameReserved(name);
  if (existing?.retiredAt && !caller.isAdmin && !hasScope(caller, SCOPES.TEAMS_RETIRE)) {
    throw new ApiError(403, "FORBIDDEN", `"${name}" is retired; un-retiring it requires teams:retire.`);
  }
  if (!existing) await refuseNewTeamName(name);
  await setTeamNamespaceState(name, "true", true, log, !existing);
  if (!existing) {
    const team = await createTeam(name);
    log.info({ team: name, createdBy: caller.id }, "team created");
    return { ...team, created: true };
  }
  if (existing.retiredAt) {
    await setTeamRetired(existing.id, false);
    log.info({ team: name, by: caller.id }, "team un-retired");
  }
  return { ...existing, retiredAt: null, created: false };
}

/**
 * One team's record, for its members, admins, and an automation token that
 * creates teams. Anyone else gets the same 404 as for a team
 * that doesn't exist, so team names can't be probed. A purged team is
 * still returned (deletedAt set): its name is reserved.
 */
export async function teamRecord(caller: AuthUser | undefined, name: string) {
  const allowed = caller !== undefined && (canActForTeam(caller, name) || hasScope(caller, SCOPES.TEAMS_CREATE));
  const team = allowed ? await findTeamByNameIncludingDeleted(name) : undefined;
  if (!team) throw noSuchTeam();
  return team;
}

async function memberTeam(caller: AuthUser | undefined, name: string) {
  ensureTeamMember(caller, name);
  const team = await findTeamByName(name);
  if (!team) throw noSuchTeam();
  return team;
}

async function maintainedTeam(caller: AuthUser | undefined, name: string) {
  ensureTeamMaintainer(caller, name);
  const team = await findTeamByName(name);
  if (!team) throw noSuchTeam();
  return team;
}

/**
 * Refused for someone who signs in with single sign-on on a team a group is
 * mapped to: their groups decide it at each sign-in (sso.ts), so a change
 * here wouldn't last. Bots and password accounts are managed here as ever.
 */
async function ensureNotFollowingGroups(team: { id: string; name: string }, person: { email: string; usesSso: boolean }): Promise<void> {
  if (!person.usesSso || !(await groupsDecide(team))) return;
  throw new ApiError(
    409,
    "TEAM_FOLLOWS_SSO_GROUPS",
    `${person.email}'s membership of "${team.name}" follows their single sign-on groups: change their groups, or the team's mappings (Admin, Single sign-on and groups).`,
  );
}

/** Adds someone with an account, as a member unless a maintainer is asked
 * for. A maintainer's job; TeamService limits how often. */
export async function addMember(
  caller: AuthUser | undefined,
  teamName: string,
  email: string,
  role: TeamRole = "member",
): Promise<void> {
  ensureNotBot(caller, "add a team member");
  const team = await maintainedTeam(caller, teamName);
  ensureNotRetired(team);
  const user = await findUserByEmail(email);
  if (!user) throw new ApiError(404, "NOT_FOUND", "No such user.");
  // A bot belongs to the team that made it (tokens.ts teamBot): one added
  // here would act for this team on its own team's tokens.
  if (user.isBot) {
    throw new ApiError(409, "CONFLICT", `${email} is a bot: make this team its own (Bots), rather than adding another team's.`, Code.AlreadyExists);
  }
  ensureVerified(caller, user);
  await ensureNotFollowingGroups(team, { email: user.email, usesSso: user.oidcSubject !== null });
  await addTeamMember(user.id, team.id, role);
}

/**
 * Refuses adding, by its email, an account that signed itself up and that
 * nobody has verified is the address's owner's: self-registration checks
 * nothing, so it may be anyone's. Single sign-on verifies it (binding the
 * account to the provider's, whose email it checked); an admin, who can
 * check it's theirs some other way, may add it anyway.
 */
function ensureVerified(caller: AuthUser | undefined, user: { email: string; selfRegistered: boolean; oidcSubject: string | null }): void {
  if (!user.selfRegistered || user.oidcSubject !== null || caller?.isAdmin) return;
  const how = currentSso()
    ? "Once they sign in with single sign-on it's verified and they can be added; or an admin can add them."
    : "If it's theirs, an admin can add them.";
  throw new ApiError(
    409,
    "EMAIL_NOT_VERIFIED",
    `${user.email}'s account signed itself up, and nobody has verified that address is theirs: anyone can sign up with any email. ${how}`,
    undefined,
    { email: user.email },
  );
}

/** Whether groups decide this team's single sign-on members: groups are read and one is mapped to it. */
async function groupsDecide(team: { id: string }): Promise<boolean> {
  const sources = groupSources();
  return (sources.claim !== "" || sources.google) && (await teamIsMapped(team.id));
}

/** Everyone in the team, with their roles, and whose membership follows
 * their groups (ensureNotFollowingGroups refuses changing it): any member may see them. */
export async function members(caller: AuthUser | undefined, teamName: string) {
  const team = await memberTeam(caller, teamName);
  const [rows, decided] = await Promise.all([listMembersForTeam(team.id), groupsDecide(team)]);
  return rows.map((m) => ({ ...m, followsGroups: decided && m.usesSso && !m.isBot }));
}

/** Refused when it would leave the team with no person who maintains it:
 * nobody but an admin could then manage it. Bots don't count. */
function ensureAMaintainerStays(team: { name: string }, all: TeamMember[], leaving: TeamMember): void {
  if (leaving.isBot || leaving.role !== "maintainer") return;
  const others = all.filter((m) => !m.isBot && m.role === "maintainer" && m.id !== leaving.id);
  if (others.length === 0) {
    throw new ApiError(
      409,
      "LAST_MAINTAINER",
      `${leaving.email} is the only person who maintains "${team.name}". Make someone else a maintainer first.`,
    );
  }
}

/**
 * Removes someone: a maintainer's job. A team never loses its last
 * maintainer this way; make another first. Bots can always be removed.
 */
export async function removeMember(
  caller: AuthUser | undefined,
  teamName: string,
  userId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  ensureNotBot(caller, "remove a team member");
  const team = await maintainedTeam(caller, teamName);
  ensureNotRetired(team);
  const all = await listMembersForTeam(team.id);
  const target = all.find((m) => m.id === userId);
  if (!target) throw new ApiError(404, "NOT_FOUND", "Not a member of this team.");
  await ensureNotFollowingGroups(team, target);
  ensureAMaintainerStays(team, all, target);
  await removeTeamMember(target.id, team.id);
  log.info({ team: team.name, removed: target.email, removedBy: caller?.id }, "team member removed");
}

/** Makes someone a maintainer or a member: a maintainer's job, never
 * leaving the team without a maintainer. */
export async function setMemberRole(
  caller: AuthUser | undefined,
  teamName: string,
  userId: string,
  role: TeamRole,
  log: FastifyBaseLogger,
): Promise<void> {
  ensureNotBot(caller, "change a member's role");
  const team = await maintainedTeam(caller, teamName);
  ensureNotRetired(team);
  const all = await listMembersForTeam(team.id);
  const target = all.find((m) => m.id === userId);
  if (!target) throw new ApiError(404, "NOT_FOUND", "Not a member of this team.");
  if (target.role === role) return;
  await ensureNotFollowingGroups(team, target);
  if (role === "member") ensureAMaintainerStays(team, all, target);
  await setTeamMemberRole(target.id, team.id, role);
  log.info({ team: team.name, member: target.email, role, by: caller?.id }, "team member's role changed");
}

/**
 * Whether a team's members must sign in with single sign-on (admins only).
 * Turning it on ends its members' password sessions at their next request
 * (auth/plugin.ts); admins are exempt. Kept while single sign-on is off,
 * but without effect, so nobody is locked out.
 */
export async function setTeamSignIn(caller: AuthUser | undefined, teamName: string, requireSso: boolean, log: FastifyBaseLogger) {
  ensureNotBot(caller, "change how the team signs in");
  forbiddenUnlessAdmin(caller, "Only an admin decides how a team signs in.");
  const team = await findTeamByName(teamName);
  if (!team) throw new ApiError(404, "NOT_FOUND", `No team named "${teamName}".`, Code.NotFound);
  if (team.requireSso === requireSso) return;
  await setTeamRequireSso(team.id, requireSso);
  log.warn({ event: "team_sign_in_changed", team: team.name, requireSso, by: caller?.id }, "team's sign-in changed");
}

/**
 * Sets what a team's steps may use together, or (null) the install's
 * limits again, and writes them into its namespace at once. Admins only.
 */
export async function setTeamQuota(caller: AuthUser | undefined, teamName: string, quota: TeamQuota | null, log: FastifyBaseLogger) {
  forbiddenUnlessAdmin(caller, "Only an admin sets a team's resource limits.");
  const team = await findTeamByName(teamName);
  if (!team) throw new ApiError(404, "NOT_FOUND", `No team named "${teamName}".`, Code.NotFound);
  if (quota) {
    for (const [key, value] of Object.entries(quota) as [string, string][]) {
      if (value && !(key === "pods" ? /^[0-9]+$/ : QUANTITY).test(value)) {
        throw new ApiError(400, "BAD_QUOTA", `${key}: "${value}" isn't a Kubernetes quantity, such as 4, 500m or 16Gi${key === "pods" ? " (a whole number for pods)" : ""}.`);
      }
    }
  }
  await db.update(teams).set({ quota }).where(eq(teams.id, team.id));
  await ensureTeamQuota(team.name);
  log.warn({ event: "team_quota_changed", team: team.name, quota, by: caller?.id }, "team's resource limits changed");
  return { ...team, quota };
}

function requireRetireRight(caller: AuthUser | undefined): void {
  if (!caller?.isAdmin && !hasScope(caller, SCOPES.TEAMS_RETIRE)) {
    throw new ApiError(403, "FORBIDDEN", "Requires admin access or teams:retire.");
  }
}

/**
 * Retire: the reversible first step of removing a platform (an admin,
 * or the catalog release that no longer has the team's folder). The team becomes read-only and its
 * products unregistered; members keep its history. Its namespace is
 * relabelled vennir/team=retired (when the console manages them), which
 * stops the kernel dispatching new steps there; anything running finishes.
 */
export async function retireTeam(caller: AuthUser | undefined, name: string, log: FastifyBaseLogger) {
  requireRetireRight(caller);
  const team = await findTeamByName(name);
  if (!team) throw noSuchTeam();
  // The namespace first: once it's labelled retired, the kernel's dispatch
  // policy starts no new step there.
  await setTeamNamespaceState(team.name, "retired", false, log);
  if (!team.retiredAt) await setTeamRetired(team.id, true, await whoRetires(caller));
  const unregisteredProducts = await deleteProductsForTeam(team.id);
  await syncIdentityPolicy();
  // Its APIs are off the gateway: their ServiceAccounts' audiences go.
  await syncGatewayTokenPolicy();
  log.info({ team: team.name, by: caller?.id, unregisteredProducts }, "team retired");
  return { name: team.name, retired: true, unregisteredProducts };
}

/**
 * teams.retiredBy for a team a catalog release retired (it dropped the
 * team's folder): the next release that names it again brings it back
 * (catalogSync.ts). Any other retiring, an admin's, only an admin undoes.
 */
export const CATALOG_RETIRER = "the catalog";

/** Who's retiring a team, as its page says it: an email, or the catalog's release. */
async function whoRetires(caller: AuthUser | undefined): Promise<string | null> {
  if (caller?.id === "catalog-sync") return CATALOG_RETIRER; // catalogSync.ts's CATALOG
  return caller ? ((await findUserById(caller.id))?.email ?? null) : null;
}

/** Undoes a retire (a team's folder restored); its products return with the catalog's next release. */
export async function unretireTeam(caller: AuthUser | undefined, name: string, log: FastifyBaseLogger) {
  requireRetireRight(caller);
  const team = await findTeamByName(name);
  if (!team) throw noSuchTeam();
  await setTeamNamespaceState(team.name, "true", true, log);
  if (team.retiredAt) await setTeamRetired(team.id, false);
  // Its APIs are back on the gateway: their ServiceAccounts' audiences too.
  await syncGatewayTokenPolicy();
  log.info({ team: team.name, by: caller?.id }, "team un-retired");
  return { name: team.name, retired: false };
}

/**
 * Purge: irreversible. Only a retired team, and only once none of its
 * executions are still running. Removes memberships, secret grants and
 * products, revokes bots left with no team, and soft-deletes the team so its
 * name stays reserved; execution history is kept. Then deletes its
 * namespace when the console manages team namespaces and may purge them
 * (config.teamNamespaces.purge). Again for a purged team, it only retries
 * the namespace's deletion.
 */
export async function purgeTeam(caller: AuthUser | undefined, name: string, log: FastifyBaseLogger) {
  if (!caller?.isAdmin && !hasScope(caller, SCOPES.TEAMS_DELETE)) {
    throw new ApiError(403, "FORBIDDEN", "Requires admin access or teams:delete.");
  }
  const team = await findTeamByNameIncludingDeleted(name);
  if (!team) throw noSuchTeam();
  // Whether its namespace goes too: otherwise it stays labelled retired,
  // for an operator to delete.
  const namespaceDeleted = config.teamNamespaces.manage && config.teamNamespaces.purge;
  const purgeNamespace = async () => {
    if (!namespaceDeleted) return;
    await deleteTeamNamespace(team.name, config.teamNamespaces.protected);
    const apis = await ownApiNamespace(team.name);
    if (apis) await deleteTeamNamespace(apis, config.teamNamespaces.protected);
  };
  if (team.deletedAt) {
    await purgeNamespace();
    return { name: team.name, purged: true, alreadyPurged: true, revokedBotTokens: 0, namespaceDeleted };
  }
  if (!team.retiredAt) {
    throw new ApiError(409, "NOT_RETIRED", `Team "${team.name}" must be retired before it can be purged.`);
  }
  const unfinished = await unfinishedExecutionIds(team.name);
  if (unfinished.length > 0) {
    throw new ApiError(
      409,
      "EXECUTIONS_RUNNING",
      `Team "${team.name}" still has ${String(unfinished.length)} unfinished execution(s); cancel them or wait before purging.`,
      undefined,
      { executionIds: unfinished },
    );
  }
  const { revokedBotTokens, removedBotIdentities } = await purgeTeamRecords(team.id);
  await syncIdentityPolicy();
  await purgeNamespace();
  log.info({ team: team.name, by: caller?.id, revokedBotTokens, removedBotIdentities }, "team purged");
  await platformAlert(
    `purge:${team.id}`,
    `Team ${team.name} was purged`,
    `Its people, secrets, products and bots' tokens are gone${namespaceDeleted ? ", and its namespace" : "; its namespace stays, labelled retired, for an operator to delete"}.`,
    caller?.id,
  );
  return { name: team.name, purged: true, revokedBotTokens, namespaceDeleted };
}

/**
 * Applies a team's reviewed SecretStore file (the catalog's
 * teams/<team>/secret-stores/*.yaml, as JSON): its SecretStores and the
 * ServiceAccounts ESO signs in as, in the team's namespace, after
 * secretStores.ts's checks. `credential`, for a provider that needs a stored
 * one, goes to the Secret eso-auth. Only the catalog's release
 * (secret-stores:apply) or an admin: a SecretStore decides which vault
 * identity a team can read, so it comes through catalog review.
 */
export async function applySecretStore(
  caller: AuthUser | undefined,
  name: string,
  input: { documents: unknown[]; credential?: string | undefined },
  log: FastifyBaseLogger,
): Promise<void> {
  if (!caller?.isAdmin && !hasScope(caller, SCOPES.SECRET_STORES_APPLY)) {
    throw new ApiError(403, "FORBIDDEN", "Requires admin access or secret-stores:apply.");
  }
  const team = await findTeamByName(name);
  if (!team) throw noSuchTeam();
  ensureNotRetired(team);
  const checked = checkSecretStoreObjects(team.name, input.documents);
  if (checked.problems.length > 0) {
    throw new ApiError(422, "UNPROCESSABLE_ENTITY", "The SecretStore file isn't allowed.", undefined, {
      problems: checked.problems,
    });
  }
  // Its cloud identities become the team's alone, in the same transaction
  // as the cluster write: refused if another team's stores sign in as one.
  const identities = cloudIdentities(checked.objects);
  const inUse = (taken: string[]) =>
    new ApiError(409, "IDENTITY_IN_USE", `Another team's SecretStore already signs in as ${taken.join(", ")}; each team needs its own.`,
      Code.AlreadyExists, { identities: taken });
  try {
    await db.transaction(async (tx) => {
      if (identities.length > 0) {
        const taken = await tx
          .select({ identity: secretStoreIdentities.identity })
          .from(secretStoreIdentities)
          .where(and(inArray(secretStoreIdentities.identity, identities), ne(secretStoreIdentities.teamId, team.id)));
        if (taken.length > 0) throw inUse(taken.map((t) => t.identity));
      }
      await tx.delete(secretStoreIdentities).where(eq(secretStoreIdentities.teamId, team.id));
      if (identities.length > 0) {
        await tx.insert(secretStoreIdentities).values(identities.map((identity) => ({ identity, teamId: team.id })));
      }
      await applySecretStoreObjects(team.name, checked.objects, input.credential);
    });
  } catch (error) {
    // Another team claimed one between the check and the insert.
    if (isUniqueViolation(error)) throw inUse(identities);
    if (error instanceof ExternalSecretsMissingError) throw externalSecretsMissing(error);
    throw error;
  }
  log.info(
    { team: team.name, by: caller?.id, objects: checked.objects.map((o) => `${o.kind}/${o.metadata.name}`), identities },
    "secret store applied",
  );
}

/**
 * Sets the stored credential the team's SecretStores may use: the Secret
 * eso-auth, which no step can mount. Each install's own (a release carries
 * the stores, never a credential): a maintainer of the team, or an admin.
 */
export async function setSecretStoreCredential(
  caller: AuthUser | undefined,
  name: string,
  credential: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const team = await maintainedTeam(caller, name);
  ensureNotRetired(team);
  await applySecretStoreObjects(team.name, [], credential);
  log.info({ team: team.name, by: caller?.id }, "secret store credential set");
}

/** A Pod's DAG payload, as far as a label needs: its task ids in order. */
function taskIds(payload: unknown): string[] {
  const tasks = (payload as { tasks?: { id?: unknown }[] } | null)?.tasks;
  return Array.isArray(tasks) ? tasks.map((t) => (typeof t.id === "string" ? t.id : "")) : [];
}

/**
 * What's running in a team's namespace, as tasks: each Pod the kernel
 * dispatched carries its execution id and task key, so the Team page can
 * say "task 2 of 3 of ..." instead of a pod name. Only this team's
 * namespace, and an execution is named only if this team is part of it.
 */
export async function teamPods(caller: AuthUser | undefined, teamName: string) {
  ensureTeamMember(caller, teamName);
  const pods = await listTaskPods(teamName);
  const ids = [...new Set(pods.map((p) => p.executionId).filter((id): id is string => id !== null))];
  const executions = new Map(
    (await findSubmittedExecutions(ids)).filter((e) => e.teams.includes(teamName)).map((e) => [e.executionId, e]),
  );
  return pods.map((pod) => {
    const execution = pod.executionId ? executions.get(pod.executionId) : undefined;
    const tasks = execution ? taskIds(execution.payload) : [];
    const position = pod.taskKey ? tasks.indexOf(pod.taskKey) : -1;
    return {
      ...pod,
      execution: execution
        ? { name: execution.name, taskNumber: position >= 0 ? position + 1 : null, taskCount: tasks.length || null }
        : null,
    };
  });
}

/** Every team's owner, description, people and Pods running now, for an
 * admin's Teams page: one query and one Pod list, not two requests a team. */
export async function teamSummaries(caller: AuthUser | undefined, log: FastifyBaseLogger) {
  forbiddenUnlessAdmin(caller);
  const [rows, running] = await Promise.all([
    db
      .select({ name: teams.name, owner: teams.owner, description: teams.description, people: sql<number>`count(${teamMemberships.userId})::int` })
      .from(teams)
      .leftJoin(teamMemberships, eq(teamMemberships.teamId, teams.id))
      .where(isNull(teams.deletedAt))
      .groupBy(teams.id),
    // Only the running figure needs the cluster: without it, the rest still shows.
    unfinishedPodsByNamespace().catch((error: unknown) => {
      log.error({ err: error }, "couldn't list the cluster's Pods for the teams' running figures");
      return null;
    }),
  ]);
  return rows.map((row) => ({
    name: row.name,
    owner: row.owner ?? "",
    description: row.description ?? "",
    people: row.people,
    // teams.name is its namespace's name.
    running: running ? (running.get(row.name) ?? 0) : undefined,
  }));
}

/** What anyone signed in may know of a team: where to ask it, whether it's retired, its size. */
export async function teamProfile(caller: AuthUser | undefined, name: string) {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  const [team] = await db.select().from(teams).where(and(eq(teams.name, name), isNull(teams.deletedAt)));
  if (!team) throw noSuchTeam();
  const [counted] = await db.select({ n: sql<number>`count(*)::int` }).from(teamMemberships).where(eq(teamMemberships.teamId, team.id));
  return {
    name: team.name,
    fromCatalog: team.fromCatalog,
    retired: team.retiredAt !== null,
    contact: team.contact ?? "",
    owner: team.owner ?? "",
    description: team.description ?? "",
    helpChat: team.helpChat ?? "",
    helpUrl: team.helpUrl ?? "",
    people: counted?.n ?? 0,
  };
}
