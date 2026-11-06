// SPDX-License-Identifier: MIT
/**
 * Deleting what's past its retention, hourly: submitted-execution records
 * (the kernel deletes the executions themselves after the same period),
 * audit entries, who read what (audit_reads), and scan verdicts of images nobody has used in a while
 * (scanned again if they're used again), sign-in's bookkeeping, and the access
 * lists of APIs gone from the release for 30 days. 0 keeps
 * a kind forever.
 */
import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNotNull, isNull, lt, lte, ne, not, or, sql } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { digestInUse } from "./scanning.js";
import { pruneAwayAccess } from "./core/apiAccess.js";
import {
  apiTraffic,
  auditExport,
  auditLog,
  auditReads,
  callbackDeliveries,
  chatFeedback,
  imageScans,
  notificationEvents,
  rateLimitWindows,
  revokedSessions,
  signInFailures,
  submittedExecutions,
} from "./db/schema.js";

const daysAgo = (days: number) => sql`now() - make_interval(days => ${days})`;

export async function deleteExpired(log?: FastifyBaseLogger): Promise<{ executions: number; audit: number; reads: number; scans: number }> {
  const { executionDays, auditDays, auditReadsDays, scanDays } = config.retention;
  // Each kind on its own: one that fails is logged (and counts nothing), and the others still go.
  async function step(what: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      const entry = { event: "retention_failed", what, err: error };
      if (log) log.error(entry, "couldn't delete what's past retention");
      else console.error(entry, "couldn't delete what's past retention");
      return 0;
    }
  }
  const done = () => Promise.resolve(0);
  const executions = await step("submitted_executions", async () =>
    executionDays
      ? (
          await db
            .delete(submittedExecutions)
            .where(lt(submittedExecutions.createdAt, daysAgo(executionDays)))
            .returning({ id: submittedExecutions.executionId })
        ).length
      : 0,
  );
  const audit = await step("audit_log", async () => {
    if (!auditDays) return 0;
    // With the log copied to write-once storage, only what's been copied
    // goes: an export that's stuck keeps everything after it.
    const copied = config.audit.export.bucket
      ? ((await db.select({ lastId: auditExport.lastId }).from(auditExport).where(eq(auditExport.id, 1)))[0]?.lastId ?? 0)
      : null;
    return (
      await db
        .delete(auditLog)
        .where(copied === null ? lt(auditLog.at, daysAgo(auditDays)) : and(lt(auditLog.at, daysAgo(auditDays)), lte(auditLog.id, copied)))
        .returning({ id: auditLog.id })
    ).length;
  });
  // Reads aren't chained or copied: what's past its days just goes.
  const reads = await step("audit_reads", async () => (auditReadsDays ? ((await db.delete(auditReads).where(lt(auditReads.at, daysAgo(auditReadsDays)))).rowCount ?? 0) : 0));
  const scans = await step("image_scans", async () =>
    scanDays
      ? (
          await db
            .delete(imageScans)
            .where(
              and(
                lt(imageScans.lastUsedAt, daysAgo(scanDays)),
                isNull(imageScans.jobName),
                ne(imageScans.status, "pending"),
                // Never a blocking verdict, so the console keeps refusing it,
                // nor one still in use, which the cluster admits only while
                // its verdict is here (scanning.ts's digestInUse).
                or(ne(imageScans.status, "failed"), isNotNull(imageScans.acceptedAt)),
                not(digestInUse),
              ),
            )
            .returning({ digest: imageScans.digest })
        ).length
      : 0,
  );
  // The gateway's traffic counts: a week. Notifications, order callbacks and the chat's ratings: 90 days.
  await step("api_traffic", () => db.delete(apiTraffic).where(lt(apiTraffic.minute, daysAgo(7))).then(done));
  // An API's grants and requests, 30 days after it left the catalog's release.
  await step("away_api_access", () => pruneAwayAccess().then(done));
  await step("notification_events", () => db.delete(notificationEvents).where(lt(notificationEvents.createdAt, daysAgo(90))).then(done));
  await step("callback_deliveries", () => db.delete(callbackDeliveries).where(lt(callbackDeliveries.createdAt, daysAgo(90))).then(done));
  await step("chat_feedback", () => db.delete(chatFeedback).where(lt(chatFeedback.createdAt, daysAgo(90))).then(done));
  // Sign-in's bookkeeping, once it no longer counts: sessions signed out
  // that have expired anyway, limits' ended windows, and failures over an
  // hour old (auth/loginThrottle.ts).
  await step("revoked_sessions", () => db.delete(revokedSessions).where(lt(revokedSessions.expiresAt, sql`now()`)).then(done));
  await step("rate_limit_windows", () => db.delete(rateLimitWindows).where(lt(rateLimitWindows.resetsAt, sql`now()`)).then(done));
  await step("sign_in_failures", () => db.delete(signInFailures).where(lt(signInFailures.windowStart, sql`now() - interval '1 hour'`)).then(done));
  return { executions, audit, reads, scans };
}

export function startRetention(log: FastifyBaseLogger): void {
  const run = () =>
    deleteExpired(log)
      .then((deleted) => {
        if (deleted.executions + deleted.audit + deleted.reads + deleted.scans > 0) {
          log.info({ event: "retention", ...deleted }, "deleted what's past retention");
        }
      })
      .catch((error: unknown) => {
        log.error({ err: error }, "couldn't delete what's past retention");
      });
  void run();
  setInterval(() => void run(), 3_600_000).unref();
}
