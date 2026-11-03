// SPDX-License-Identifier: MIT
/**
 * A team's secrets: the logic behind
 * and SecretService.
 *
 * Registering (or rotating) a secret lets any of the team's registered
 * products mount it, when a task lists it in secretRefs; nothing else may
 * (core and the cluster's identity policy). Only a member of the team (or
 * a platform admin) may, and team name and namespace are the same value by
 * convention (db/schema.ts), so that's a direct membership check. A secret
 * is pasted (a Secret written straight into the namespace) or synced (an
 * ExternalSecret against one of the team's reviewed SecretStores). The
 * console never reads a value back.
 */
import { Type } from "@sinclair/typebox";
import type { FastifyBaseLogger } from "fastify";
import { ApiError, externalSecretsMissing } from "../apiError.js";
import { ensureTeamMaintainer, ensureTeamMember } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import {
  catalogRepository,
  deleteSecretGrantRecord,
  findTeamByName,
  listSecretGrantsForTeam,
  recordSecretGrant,
} from "../db/queries.js";
import {
  ExternalSecretsMissingError,
  NamespaceNotFoundError,
  SECRET_STORE_CREDENTIAL,
  SecretNotManagedError,
  TEAM_PULL_SECRET,
  deleteSecretGrant,
  listAllSecretStores,
  listExternalSecrets,
  listSecretStores,
  upsertExternalSecretGrant,
  upsertSecretGrant,
} from "../k8s.js";
import { syncIdentityPolicy } from "../productPolicy.js";
import { ensureNotRetired } from "./retired.js";

// A Kubernetes Secret name (a DNS-1123 subdomain), no longer than a Secret
// volume name may be.
const DNS_SUBDOMAIN = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$";
export const SecretName = Type.String({ minLength: 1, maxLength: 120, pattern: DNS_SUBDOMAIN });
export const SecretTeam = Type.String({ minLength: 1 });
export const SecretData = Type.Record(Type.String(), Type.String(), { minProperties: 1 });
export const SecretStoreName = Type.String({ minLength: 1 });
export const SyncedKeys = Type.Array(
  Type.Object({
    secretKey: Type.String({ minLength: 1 }),
    remoteKey: Type.String({ minLength: 1 }),
    property: Type.Optional(Type.String({ minLength: 1 })),
  }),
  { minItems: 1 },
);

/** A SecretStore's own credential, or the platform's pull Secret, is never a
 * team secret: a step could then read what the store signs in with, or the
 * registry credential. */
function refuseReservedName(secretName: string): void {
  const reserved: Record<string, string> = {
    [SECRET_STORE_CREDENTIAL]: "a SecretStore's own credential",
    [TEAM_PULL_SECRET]: "the platform's registry pull Secret",
  };
  const purpose = reserved[secretName];
  if (purpose !== undefined) {
    throw new ApiError(422, "UNPROCESSABLE_ENTITY", `"${secretName}" is reserved for ${purpose}; choose another name.`);
  }
}

/** The member's team, not retired: a retired team gets nothing new. */
async function writableTeam(caller: AuthUser | undefined, teamName: string, secretName: string) {
  ensureTeamMaintainer(caller, teamName);
  refuseReservedName(secretName);
  const team = await findTeamByName(teamName);
  if (!team) throw new ApiError(404, "NOT_FOUND", `No team named "${teamName}".`);
  ensureNotRetired(team);
  return team;
}

/**
 * Whether the team already has this secret, from the same source. One from
 * the other source is refused: switching would leave the other kind's
 * object behind (an ExternalSecret that overwrites a pasted value and,
 * once revoked, makes the Secret again), so it's revoked first.
 */
async function alreadyRegisteredAs(teamId: string, secretName: string, source: "literal" | "external"): Promise<boolean> {
  const grant = (await listSecretGrantsForTeam(teamId)).find((g) => g.secretName === secretName);
  if (grant && grant.source !== source) {
    const was = grant.source === "external" ? "synced from a SecretStore" : "pasted";
    throw new ApiError(409, "CONFLICT", `"${secretName}" is ${was}. Revoke it first to ${source === "external" ? "sync it" : "paste a value"} instead.`);
  }
  return grant !== undefined;
}

/**
 * Writes a secret to the cluster and records it, in the order that never
 * strands one: a secret new to the team is recorded first (the console's
 * records are what make an existing Secret its own to replace, since it
 * never reads Secrets), and the record is removed again if the cluster
 * refuses or fails; a registered one is rewritten, then its record updated.
 */
async function writeAndRecord(
  teamId: string,
  secretName: string,
  alreadyGranted: boolean,
  write: () => Promise<void>,
  record: () => Promise<unknown>,
): Promise<void> {
  if (!alreadyGranted) await record();
  try {
    await write();
  } catch (error) {
    if (!alreadyGranted) await deleteSecretGrantRecord(teamId, secretName);
    // A caller mistake from k8s.ts, as a refusal; anything else stays a failure.
    if (error instanceof NamespaceNotFoundError) throw new ApiError(422, "UNPROCESSABLE_ENTITY", error.message);
    if (error instanceof SecretNotManagedError) throw new ApiError(409, "CONFLICT", error.message);
    if (error instanceof ExternalSecretsMissingError) throw externalSecretsMissing(error);
    throw error;
  }
  if (alreadyGranted) await record();
}

/** Adds or replaces a pasted secret. */
export async function putSecret(
  caller: AuthUser | undefined,
  input: { team: string; secretName: string; data: Record<string, string> },
): Promise<void> {
  const team = await writableTeam(caller, input.team, input.secretName);
  const alreadyGranted = await alreadyRegisteredAs(team.id, input.secretName, "literal");
  await writeAndRecord(
    team.id,
    input.secretName,
    alreadyGranted,
    () => upsertSecretGrant({ namespace: input.team, secretName: input.secretName, data: input.data, alreadyGranted }),
    () => recordSecretGrant({ teamId: team.id, secretName: input.secretName, keys: Object.keys(input.data), source: "literal" }),
  );
  await syncIdentityPolicy();
}

/**
 * Syncs a secret from one of the team's SecretStores (which the console
 * never creates here): an ExternalSecret reference instead of a value.
 * Otherwise the same as putSecret, with the same result for tasks.
 */
export async function syncSecret(
  caller: AuthUser | undefined,
  input: {
    team: string;
    secretName: string;
    secretStoreName: string;
    keys: { secretKey: string; remoteKey: string; property?: string }[];
  },
): Promise<void> {
  const team = await writableTeam(caller, input.team, input.secretName);
  const alreadyGranted = await alreadyRegisteredAs(team.id, input.secretName, "external");
  await writeAndRecord(
    team.id,
    input.secretName,
    alreadyGranted,
    () =>
      upsertExternalSecretGrant({
        namespace: input.team,
        secretName: input.secretName,
        secretStoreName: input.secretStoreName,
        keys: input.keys,
        alreadyGranted,
      }),
    () =>
      recordSecretGrant({
        teamId: team.id,
        secretName: input.secretName,
        keys: input.keys.map((k) => k.secretKey),
        source: "external",
      }),
  );
  await syncIdentityPolicy();
}

/**
 * Revokes a secret: its registration, and the Secret (or ExternalSecret) the
 * console created. Tasks already running keep what they mounted; new ones
 * can't name it.
 */
export async function revokeSecret(
  caller: AuthUser | undefined,
  teamName: string,
  secretName: string,
  log: FastifyBaseLogger,
): Promise<void> {
  ensureTeamMaintainer(caller, teamName);
  const team = await findTeamByName(teamName);
  if (!team) throw new ApiError(404, "NOT_FOUND", "No such team.");
  ensureNotRetired(team);
  const grant = (await listSecretGrantsForTeam(team.id)).find((g) => g.secretName === secretName);
  if (!grant) throw new ApiError(404, "NOT_FOUND", `No secret "${secretName}" is registered for this team.`);
  // The cluster first: if that fails, the grant stays on record and the
  // revoke can simply be tried again.
  await deleteSecretGrant(teamName, secretName, grant.source);
  await deleteSecretGrantRecord(team.id, secretName);
  await syncIdentityPolicy();
  log.info({ team: teamName, secret: secretName, by: caller?.id }, "secret revoked");
}

/**
 * A team's secrets: registered ones, and any ExternalSecret in its
 * namespace made outside the console (kubectl, a GitOps tool), so the list
 * is the whole truth about what its tasks could be given. Those aren't
 * registered, so no task can mount them until someone registers them.
 * Live per call: whether a sync works right now is the point.
 */
export async function teamSecrets(caller: AuthUser | undefined, teamName: string) {
  ensureTeamMember(caller, teamName);
  const team = await findTeamByName(teamName);
  if (!team) throw new ApiError(404, "NOT_FOUND", "No such team.");
  const grants = await listSecretGrantsForTeam(team.id);
  const externals = await listExternalSecrets(teamName);
  const byName = new Map(externals.map((e) => [e.name, e]));
  const granted = new Set(grants.map((g) => g.secretName));
  return [
    ...grants.map((grant) => ({
      id: grant.id,
      secretName: grant.secretName,
      keys: grant.keys,
      source: grant.source,
      managed: true,
      updatedAt: grant.updatedAt,
      external: grant.source === "external" ? (byName.get(grant.secretName) ?? null) : null,
    })),
    ...externals
      .filter((e) => !granted.has(e.name))
      .map((e) => ({
        id: `external:${e.name}`,
        secretName: e.name,
        keys: e.entries.map((entry) => entry.secretKey),
        source: "external" as const,
        managed: false,
        updatedAt: e.lastSyncedAt,
        external: e,
      })),
  ];
}

/**
 * The team's secret sources: each SecretStore in its namespace, where it
 * connects, who it signs in as, and whether that works right now. A store
 * whose identity another team's store also uses is flagged, since either
 * team could then sync whatever the other can; only an admin is told which
 * teams.
 */
export async function teamSecretStores(caller: AuthUser | undefined, teamName: string) {
  ensureTeamMember(caller, teamName);
  const stores = await listSecretStores(teamName);
  const everywhere = stores.some((s) => s.identity) ? await listAllSecretStores() : [];
  const isAdmin = caller?.isAdmin ?? false;
  return stores.map((store) => {
    const sharedWith = store.identity
      ? [
          ...new Set(
            everywhere
              .filter((o) => o.namespace !== teamName && o.store.identity === store.identity)
              .map((o) => o.namespace),
          ),
        ]
      : [];
    return { ...store, sharedWithCount: sharedWith.length, sharedWith: isAdmin ? sharedWith : null };
  });
}

/**
 * What the "connect a source" guide needs to know about this install. The
 * catalog repository is the install's setting, else the one its applied
 * release came from (owner/name, without github.com/).
 */
export async function secretSources() {
  const fromRelease = (await catalogRepository())?.replace(/^github\.com\//, "") ?? "";
  return { ...config.secretSources, catalogRepo: config.secretSources.catalogRepo || fromRelease };
}
