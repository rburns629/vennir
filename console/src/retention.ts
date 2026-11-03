// SPDX-License-Identifier: MIT
/**
 * Deleting what's past its retention, hourly: submitted-execution records
 * (the kernel deletes the executions themselves after the same period),
 * audit entries, and scan verdicts of images nobody has used in a while
 * (scanned again if they're used again), and sign-in's bookkeeping. 0 keeps
 * a kind forever.
 */
import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/client.js";
import {
  apiTraffic,
  auditExport,
  auditLog,
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

export async function deleteExpired(): Promise<{ executions: number; audit: number; scans: number }> {
  const { executionDays, auditDays, scanDays } = config.retention;
  const executions = executionDays
    ? (
        await db
          .delete(submittedExecutions)
          .where(lt(submittedExecutions.createdAt, daysAgo(executionDays)))
          .returning({ id: submittedExecutions.executionId })
      ).length
    : 0;
  // With the log copied to write-once storage, only what's been copied
  // goes: an export that's stuck keeps everything after it.
  const copied = config.audit.export.bucket
    ? ((await db.select({ lastId: auditExport.lastId }).from(auditExport).where(eq(auditExport.id, 1)))[0]?.lastId ?? 0)
    : null;
  const audit = auditDays
    ? (
        await db
          .delete(auditLog)
          .where(copied === null ? lt(auditLog.at, daysAgo(auditDays)) : and(lt(auditLog.at, daysAgo(auditDays)), lte(auditLog.id, copied)))
          .returning({ id: auditLog.id })
      ).length
    : 0;
  const scans = scanDays
    ? (
        await db
          .delete(imageScans)
          .where(
            and(
              lt(imageScans.lastUsedAt, daysAgo(scanDays)),
              isNull(imageScans.jobName),
              ne(imageScans.status, "pending"),
              // Never a blocking verdict: it's what keeps the digest on the
              // cluster's deny list (scanning.ts's syncScanPolicy).
              or(ne(imageScans.status, "failed"), isNotNull(imageScans.acceptedAt)),
            ),
          )
          .returning({ digest: imageScans.digest })
      ).length
    : 0;
  // The gateway's traffic counts: a week. Notifications, order callbacks and the chat's ratings: 90 days.
  await db.delete(apiTraffic).where(lt(apiTraffic.minute, daysAgo(7)));
  await db.delete(notificationEvents).where(lt(notificationEvents.createdAt, daysAgo(90)));
  await db.delete(callbackDeliveries).where(lt(callbackDeliveries.createdAt, daysAgo(90)));
  await db.delete(chatFeedback).where(lt(chatFeedback.createdAt, daysAgo(90)));
  // Sign-in's bookkeeping, once it no longer counts: sessions signed out
  // that have expired anyway, limits' ended windows, and failures over an
  // hour old (auth/loginThrottle.ts).
  await db.delete(revokedSessions).where(lt(revokedSessions.expiresAt, sql`now()`));
  await db.delete(rateLimitWindows).where(lt(rateLimitWindows.resetsAt, sql`now()`));
  await db.delete(signInFailures).where(lt(signInFailures.windowStart, sql`now() - interval '1 hour'`));
  return { executions, audit, scans };
}

export function startRetention(log: FastifyBaseLogger): void {
  const run = () =>
    deleteExpired()
      .then((deleted) => {
        if (deleted.executions + deleted.audit + deleted.scans > 0) {
          log.info({ event: "retention", ...deleted }, "deleted what's past retention");
        }
      })
      .catch((error: unknown) => {
        log.error({ err: error }, "couldn't delete what's past retention");
      });
  void run();
  setInterval(() => void run(), 3_600_000).unref();
}
