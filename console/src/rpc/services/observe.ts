// SPDX-License-Identifier: MIT
/** ObserveService (proto/vertra/console/v1/observe.proto): core/observe.ts and core/logs.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Type } from "@sinclair/typebox";
import { listAlerts } from "../../core/alerts.js";
import { searchLogs, SearchLogsQuery, type SearchLogsInput } from "../../core/logs.js";
import { getAuditCopy, getImageSbom, getMetrics, getSecurity, listAudit, ListAuditQuery } from "../../core/observe.js";
import { getUsage } from "../../core/usage.js";
import type { ObserveService } from "../../gen/vertra/console/v1/observe_pb.js";
import { timestamp, unsetIfEmpty } from "../convert.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";
import { auditEntryMessage } from "./admin.js";
import { viaKernel } from "./execution.js";

export function observeService(): ServiceImpl<typeof ObserveService> {
  return {
    async getImageSbom(req, ctx) {
      const { image } = check({ image: Type.String({ minLength: 1, maxLength: 1024 }) }, req);
      return { sbom: await getImageSbom(callerOf(ctx), image) };
    },

    async getSecurity(_req, ctx) {
      const s = await viaKernel(ctx, () => getSecurity(callerOf(ctx)));
      return {
        checks: s.checks,
        refusals: s.refusals.map((r) => ({ ...r, at: timestamp(r.at) })),
        images: s.images.map((i) => ({ ...i, scannedAt: timestamp(i.scannedAt) })),
      };
    },

    async getAuditCopy(_req, ctx) {
      const copy = await getAuditCopy(callerOf(ctx));
      return {
        ...copy,
        copiedThrough: BigInt(copy.copiedThrough),
        copiedAt: timestamp(copy.copiedAt),
        waiting: BigInt(copy.waiting),
        checkedAt: timestamp(copy.checkedAt),
        brokenAt: BigInt(copy.brokenAt),
        comparedThrough: BigInt(copy.comparedThrough),
        comparedAt: timestamp(copy.comparedAt),
        differsAt: BigInt(copy.differsAt),
      };
    },

    async listAlerts(_req, ctx) {
      const found = await listAlerts(callerOf(ctx), logOf(ctx));
      return {
        ...found,
        checkedAt: timestamp(found.checkedAt),
        rules: found.rules.map((r) => ({ ...r, instances: r.instances.map((i) => ({ ...i, activeAt: timestamp(i.activeAt) })) })),
      };
    },

    async getMetrics(_req, ctx) {
      const m = await viaKernel(ctx, () => getMetrics(callerOf(ctx)));
      return { ...m, hours: m.hours.map((h) => ({ ...h, hour: timestamp(h.hour) })) };
    },

    async getUsage(req, ctx) {
      const usage = await getUsage(callerOf(ctx), req.days || 7);
      return {
        ...usage,
        since: timestamp(usage.since),
        products: usage.products.map((p) => ({ ...p, lastUsed: timestamp(p.lastUsed) })),
      };
    },

    async listAudit(req, ctx) {
      const query = check(
        { query: ListAuditQuery },
        {
          query: {
            before: unsetIfEmpty(Number(req.before)),
            team: unsetIfEmpty(req.team),
            mine: req.mine || undefined,
            refusedOnly: req.refusedOnly || undefined,
            limit: unsetIfEmpty(req.limit),
          },
        },
      ).query;
      const page = await listAudit(callerOf(ctx), query);
      return {
        entries: page.entries.map(auditEntryMessage),
        nextBefore: BigInt(page.nextBefore ?? 0),
      };
    },

    async searchLogs(req, ctx) {
      const query = check(
        { query: SearchLogsQuery },
        {
          query: {
            text: unsetIfEmpty(req.text),
            team: unsetIfEmpty(req.team),
            executionId: unsetIfEmpty(req.executionId),
            level: unsetIfEmpty(req.level),
            source: unsetIfEmpty(req.source),
            api: unsetIfEmpty(req.api),
            limit: unsetIfEmpty(req.limit),
          },
        },
      ).query as SearchLogsInput;
      const found = await searchLogs(callerOf(ctx), {
        ...query,
        since: req.since ? timestampDate(req.since) : undefined,
        until: req.until ? timestampDate(req.until) : undefined,
      });
      return { ...found, lines: found.lines.map((l) => ({ ...l, at: timestamp(l.at) })) };
    },
  };
}
