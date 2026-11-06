// SPDX-License-Identifier: MIT
/**
 * Running the platform, for admins: platform-wide counts, who changed what
 * (audit.ts), whether the cluster's copies of the console's lists are
 * current (policySync.ts), and the catalog release applied
 * (catalogSync.ts). The logic behind AdminService.
 */
import { currentSso } from "../sso.js";
import { and, arrayContains, desc, eq, lt, type SQL } from "drizzle-orm";
import { Type } from "@sinclair/typebox";
import type { FastifyBaseLogger } from "fastify";
import { Code } from "@connectrpc/connect";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import { config } from "../config.js";
import type { AuthUser } from "../auth/plugin.js";
import { db } from "../db/client.js";
import { countProducts, countSubmittedExecutions, countTeams, countUsers } from "../db/queries.js";
import { auditLog, auditReads, users } from "../db/schema.js";
import { adoptTeam, catalogStatus, syncCatalog } from "../catalogSync.js";
import { policySyncOutcomes, syncPolicies } from "../policySync.js";
import { catalogPolicies } from "../catalogPolicy.js";
import { clusterImagePolicyExists } from "../k8s.js";

const REQUIRES_ADMIN = "Requires admin access.";

/**
 * Platform-wide counts for the admin home page. Admins only: a non-admin's
 * home page derives its own numbers from what it already fetches.
 */
export async function platformStats(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller);
  const [teams, accounts, products, executions] = await Promise.all([
    countTeams(),
    countUsers(),
    countProducts(),
    countSubmittedExecutions(),
  ]);
  return { teams, users: accounts, products, executions };
}

/** This install: the console's version and which optional parts are on. Admins only. */
export async function install(caller: AuthUser | undefined, log: FastifyBaseLogger) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const signature = config.catalog.signature;
  return {
    version: config.version,
    environmentLabel: config.environmentLabel,
    ssoProvider: currentSso()?.label ?? "",
    logs: config.logs.lokiUrl !== "",
    logSearchDays: config.logs.searchDays,
    auditCopy: config.audit.export.bucket !== "",
    gateway: config.gateway.url !== "",
    catalog: config.catalog.release !== "",
    catalogSigned: signature.publicKeys.length > 0 || signature.keylessIssuer !== "",
    scanning: config.scanning.enabled,
    runRetentionDays: config.retention.executionDays,
    ...catalogSettings(),
    // Email: whether, where through and from whom; never its sign-in.
    email: config.notifications.email.host !== "",
    emailHost: config.notifications.email.host,
    emailFrom: config.notifications.email.from,
    monitoringProvider: config.monitoring.provider,
    grafanaUrl: config.monitoring.grafanaUrl,
    sessionLength: config.jwtTtl,
    auditKeepDays: config.audit.export.bucket ? config.audit.export.keepDays : 0,
    auditLock: config.audit.export.bucket !== "" && config.audit.export.lock,
    policySyncSeconds: config.policySyncIntervalSeconds,
    imageSignaturesRequired: await imageSignaturesRequired(log),
    rescanHours: config.scanning.enabled ? config.scanning.rescanHours : 0,
  };
}

/**
 * Whether catalog images must be signed, from the cluster: the kernel
 * chart's signature policy exists. Undefined when the console can't tell
 * (no policy name configured, or the cluster didn't answer): a page says
 * so rather than guess either way.
 */
async function imageSignaturesRequired(log: FastifyBaseLogger): Promise<boolean | undefined> {
  const name = config.imageSignaturePolicyName;
  if (!name) return undefined;
  try {
    return await clusterImagePolicyExists(name);
  } catch (error) {
    log.warn({ err: error, policy: name }, "couldn't read the image signature policy");
    return undefined;
  }
}

/** The catalog release's settings, as the install named them; all empty with no catalog. */
function catalogSettings() {
  const { release, newestVersion, pollSeconds, external, signature } = config.catalog;
  if (!release) {
    return { catalogVersion: "", catalogPollSeconds: 0, catalogSignerKeys: 0, catalogKeylessIssuer: "", catalogKeylessSubject: "", externalCatalog: "" };
  }
  // <registry>/catalog-release:<tag>: the tag is latest or a version (vennir's releaseTag).
  const at = release.lastIndexOf(":");
  const slash = release.lastIndexOf("/");
  const tag = at > slash ? release.slice(at + 1) : "latest";
  return {
    catalogVersion: newestVersion ? "newest" : tag,
    catalogPollSeconds: pollSeconds,
    catalogSignerKeys: signature.publicKeys.length,
    catalogKeylessIssuer: signature.keylessIssuer,
    catalogKeylessSubject: signature.keylessSubjectRegExp,
    externalCatalog: external && slash > 0 ? release.slice(0, slash) : "",
  };
}

export const AuditQuery = Type.Object({
  // The id of the last entry already seen: older ones come next.
  before: Type.Optional(Type.Integer({ minimum: 1 })),
  actor: Type.Optional(Type.String({ format: "uuid" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

/** The audit log, newest first, a page at a time. */
export async function auditEntries(
  caller: AuthUser | undefined,
  query: { before?: number | undefined; actor?: string | undefined; limit?: number | undefined },
) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const { before, actor, limit = 100 } = query;
  return auditPage(actor !== undefined ? [eq(auditLog.actorId, actor)] : [], before, limit);
}

/** One page of the entries matching every condition, newest first, with their actors. */
export async function auditPage(conditions: (SQL | undefined)[], before: number | undefined, limit: number) {
  const where = [...conditions, before !== undefined ? lt(auditLog.id, before) : undefined].filter((c) => c !== undefined);
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      actorId: auditLog.actorId,
      actorEmail: users.email,
      actorIsBot: users.isBot,
      method: auditLog.method,
      route: auditLog.route,
      target: auditLog.target,
      status: auditLog.status,
      requestId: auditLog.requestId,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(limit);
  return { entries: rows, nextBefore: rows.length === limit ? (rows.at(-1)?.id ?? null) : null };
}

export const AuditReadsQuery = Type.Object({
  // The id of the last read already seen: older ones come next.
  before: Type.Optional(Type.Integer({ minimum: 1 })),
  actor: Type.Optional(Type.String({ format: "uuid" })),
  team: Type.Optional(Type.String({ pattern: "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" })),
  executionId: Type.Optional(Type.String({ format: "uuid" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

/**
 * Who read what (auditReads.ts), newest first, a page at a time: by
 * reader, by the team whose data it was, by run. Admins only; reading it
 * is recorded too (READERS).
 */
export async function auditReadEntries(
  caller: AuthUser | undefined,
  query: { before?: number | undefined; actor?: string | undefined; team?: string | undefined; executionId?: string | undefined; limit?: number | undefined },
) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const { before, actor, team, executionId, limit = 100 } = query;
  const where = [
    actor !== undefined ? eq(auditReads.actorId, actor) : undefined,
    team !== undefined ? arrayContains(auditReads.teams, [team]) : undefined,
    executionId !== undefined ? arrayContains(auditReads.executionIds, [executionId]) : undefined,
    before !== undefined ? lt(auditReads.id, before) : undefined,
  ].filter((c) => c !== undefined);
  const rows = await db
    .select({
      id: auditReads.id,
      at: auditReads.at,
      actorId: auditReads.actorId,
      actorEmail: users.email,
      actorIsBot: users.isBot,
      route: auditReads.route,
      executionIds: auditReads.executionIds,
      teams: auditReads.teams,
      target: auditReads.target,
      clientIp: auditReads.clientIp,
      requestId: auditReads.requestId,
    })
    .from(auditReads)
    .leftJoin(users, eq(users.id, auditReads.actorId))
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(auditReads.id))
    .limit(limit);
  return { reads: rows, nextBefore: rows.length === limit ? (rows.at(-1)?.id ?? null) : null };
}

/**
 * Who writes the catalog's policies (catalogPolicy.ts), for display beside
 * the outcomes: when it can't be read, it's left out (and logged), never
 * guessed, and the outcomes are still shown.
 */
async function catalogWriter(log: FastifyBaseLogger) {
  try {
    return await catalogPolicies();
  } catch (error) {
    log.warn({ err: error, event: "catalog_policy_unread" }, "couldn't read the kernel's catalog identity policy");
    return undefined;
  }
}

/** The last outcome of each policy sync, and who writes the catalog's. */
export async function policySync(caller: AuthUser | undefined, log: FastifyBaseLogger) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  return { outcomes: policySyncOutcomes(), catalog: await catalogWriter(log) };
}

/** Runs every policy sync now, then returns their outcomes. */
export async function syncPoliciesNow(caller: AuthUser | undefined, log: FastifyBaseLogger) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  await syncPolicies(log);
  return { outcomes: policySyncOutcomes(), catalog: await catalogWriter(log) };
}

/** The catalog release last applied, and how the last look went. */
export async function catalogState(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  return catalogStatus();
}

/** Reads and applies the catalog's release now, even the one applied already. */
export async function syncCatalogNow(caller: AuthUser | undefined, log: FastifyBaseLogger) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  if (!(await syncCatalog(log, true))) {
    throw new ApiError(409, "BUSY", "Another console is applying the catalog right now; try again shortly.", Code.Aborted);
  }
  return catalogStatus();
}

/** Lets the catalog's release manage an existing team, then syncs. */
export async function adoptCatalogTeam(caller: AuthUser | undefined, name: string, log: FastifyBaseLogger) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  if (!(await adoptTeam(name))) throw new ApiError(404, "NOT_FOUND", "No such team.", Code.NotFound);
  log.info({ event: "catalog_team_adopted", team: name, by: caller?.id }, "team adopted by the catalog");
  return syncCatalogNow(caller, log);
}
