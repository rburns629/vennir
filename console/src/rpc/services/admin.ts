// SPDX-License-Identifier: MIT
/** AdminService (proto/vennir/console/v1/admin.proto): core/admin.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import type { JsonObject } from "@bufbuild/protobuf";
import type { CatalogStatus } from "../../catalogSync.js";
import { AuditQuery, AuditReadsQuery, adoptCatalogTeam, auditEntries, auditReadEntries, type auditPage, catalogState, install, platformStats, policySync, syncCatalogNow, syncPoliciesNow } from "../../core/admin.js";
import type { AdminService } from "../../gen/vennir/console/v1/admin_pb.js";
import type { SyncOutcome } from "../../policySync.js";
import { timestamp, unsetIfEmpty } from "../convert.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";

function outcomes(byPolicy: Record<string, SyncOutcome | null>) {
  return Object.fromEntries(
    Object.entries(byPolicy)
      .filter((entry): entry is [string, SyncOutcome] => entry[1] !== null)
      .map(([name, outcome]) => [
        name,
        { applies: outcome.applies, ok: outcome.ok, at: timestamp(outcome.at), error: outcome.error },
      ]),
  );
}

function catalog(status: CatalogStatus) {
  return {
    release: status.release,
    newestVersion: status.newestVersion,
    version: status.version ?? "",
    digest: status.digest ?? "",
    commit: status.commit ?? "",
    repository: status.repository ?? "",
    appliedAt: status.appliedAt ? timestamp(status.appliedAt) : undefined,
    problems: status.problems.map((p) => ({ item: p.item, message: p.message, adoptableTeam: p.adoptableTeam ?? "" })),
    checkedAt: status.checkedAt ? timestamp(status.checkedAt) : undefined,
    error: status.error ?? "",
    applied: status.applied ?? undefined,
  };
}

type AuditRow = Awaited<ReturnType<typeof auditPage>>["entries"][number];

/** An audit_log row (with its actor) as an AuditEntry; ObserveService's too. */
export function auditEntryMessage(entry: AuditRow) {
  return {
    id: BigInt(entry.id),
    at: timestamp(entry.at),
    actorId: entry.actorId ?? undefined,
    actorEmail: entry.actorEmail ?? undefined,
    actorIsBot: entry.actorIsBot ?? false,
    method: entry.method,
    route: entry.route,
    target: entry.target as JsonObject,
    status: entry.status,
    requestId: entry.requestId ?? undefined,
  };
}

export function adminService(): ServiceImpl<typeof AdminService> {
  return {
    async getStats(_req, ctx) {
      const stats = await platformStats(callerOf(ctx));
      return {
        teams: BigInt(stats.teams),
        users: BigInt(stats.users),
        products: BigInt(stats.products),
        executions: BigInt(stats.executions),
      };
    },

    async listAuditEntries(req, ctx) {
      const query = check(
        { query: AuditQuery },
        {
          query: {
            before: unsetIfEmpty(Number(req.before)),
            actor: unsetIfEmpty(req.actorId),
            limit: unsetIfEmpty(req.limit),
          },
        },
      ).query;
      const page = await auditEntries(callerOf(ctx), query);
      return {
        entries: page.entries.map(auditEntryMessage),
        nextBefore: BigInt(page.nextBefore ?? 0),
      };
    },

    async listAuditReads(req, ctx) {
      const query = check(
        { query: AuditReadsQuery },
        {
          query: {
            before: unsetIfEmpty(Number(req.before)),
            actor: unsetIfEmpty(req.actorId),
            team: unsetIfEmpty(req.team),
            executionId: unsetIfEmpty(req.executionId),
            limit: unsetIfEmpty(req.limit),
          },
        },
      ).query;
      const page = await auditReadEntries(callerOf(ctx), query);
      return {
        reads: page.reads.map((read) => ({
          id: BigInt(read.id),
          at: timestamp(read.at),
          actorId: read.actorId ?? undefined,
          actorEmail: read.actorEmail ?? undefined,
          actorIsBot: read.actorIsBot ?? false,
          route: read.route,
          executionIds: read.executionIds,
          teams: read.teams,
          target: read.target as JsonObject,
          clientIp: read.clientIp ?? undefined,
          requestId: read.requestId ?? undefined,
        })),
        nextBefore: BigInt(page.nextBefore ?? 0),
      };
    },

    async getPolicySync(_req, ctx) {
      const state = await policySync(callerOf(ctx), logOf(ctx));
      return { outcomes: outcomes(state.outcomes), catalog: state.catalog };
    },

    async syncPolicies(_req, ctx) {
      const state = await syncPoliciesNow(callerOf(ctx), logOf(ctx));
      return { outcomes: outcomes(state.outcomes), catalog: state.catalog };
    },

    async getCatalogStatus(_req, ctx) {
      return { status: catalog(await catalogState(callerOf(ctx))) };
    },

    async syncCatalog(_req, ctx) {
      return { status: catalog(await syncCatalogNow(callerOf(ctx), logOf(ctx))) };
    },

    async adoptCatalogTeam(req, ctx) {
      return { status: catalog(await adoptCatalogTeam(callerOf(ctx), req.name, logOf(ctx))) };
    },

    getInstall(_req, ctx) {
      return install(callerOf(ctx), logOf(ctx));
    },
  };
}
