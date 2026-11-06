// SPDX-License-Identifier: MIT
/**
 * Who changed what: every call that can change something (a Connect method
 * not marked NO_SIDE_EFFECTS), allowed or refused, is recorded once it's
 * answered, in the audit_log table and as a structured log line
 * (`event: "audit"`, for shipping to a SIEM), by rpc/interceptors.ts's
 * audit interceptor. One interceptor, so a new method is covered without
 * remembering to.
 *
 * Recorded: the caller (its user id; bots are users), the method, the
 * identifying fields of the request (TARGET_FIELDS: names, teams, images,
 * emails, scopes, reasons), and the status. Never the rest of a request: a
 * secret's value, a password, a token or a credential is never read here.
 * Sign-ins, registering and password changes are recorded too, allowed or
 * refused (the email tried, never the password); a sign-in's actor is who
 * it signed in. Every entry carries the client's address (clientIp).
 */
import { createHash } from "node:crypto";
import { desc, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyBaseLogger } from "fastify";
import { db } from "./db/client.js";
import { auditLog } from "./db/schema.js";

/** Body fields that only ever identify what was acted on. */
const TARGET_FIELDS = [
  "name",
  "team",
  "namespace",
  "secretName",
  "secretStoreName",
  "serviceAccount",
  "image",
  "action",
  "email",
  "label",
  "scopes",
  "reason",
  "source",
  "additional",
  "executionId",
  "taskId",
  "approve",
  "tokenId",
  "userId",
  "digest",
  "repository",
  "secretStore",
  "product",
  "onBehalfOf",
  "issuer",
  // API access (core/apiAccess.ts): the grant or request, the group, the rate, the bot.
  "grantId",
  "accessRequestId",
  "group",
  "perMinute",
  "botEmail",
] as const;

/** The single sign-on settings' (SetSsoSettings): the provider, who may sign in, where groups come from. */
const SSO_FIELDS = ["clientId", "redirectUrl", "allowedDomains", "groupsClaim", "googleGroups"] as const;

export function targetFields(body: unknown): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const field of TARGET_FIELDS) {
      const value = (body as Record<string, unknown>)[field];
      if (value !== undefined && (typeof value !== "string" || value.length <= 500)) target[field] = value;
    }
    const tasks = (body as Record<string, unknown>)["tasks"];
    if (Array.isArray(tasks)) target["tasks"] = tasks.length;
    // A submission's DAG: its name and how many tasks.
    const dag = (body as Record<string, unknown>)["dag"];
    if (dag) Object.assign(target, targetFields(dag));
    // The chat agent's settings (Set/TestChatConfig): where they'd send its
    // questions, and with what; never the key.
    const chat = (body as Record<string, unknown>)["config"];
    if (chat && typeof chat === "object" && !Array.isArray(chat)) {
      for (const field of ["enabled", "provider", "model", "endpoint", "vertexProject", "vertexLocation", "bedrockRegion"] as const) {
        let value = (chat as Record<string, unknown>)[field];
        // An address as far as its path: a query string or a user isn't kept.
        if (field === "endpoint" && typeof value === "string") value = value.replace(/[?#].*$/, "").replace(/^(https?:\/\/)[^/@]*@/, "$1");
        if (value !== undefined && value !== "" && (typeof value !== "string" || value.length <= 500)) target[field] = value;
      }
      if ((chat as Record<string, unknown>)["apiKey"]) target["keyGiven"] = true;
    }
    // The single sign-on settings: what they are now; never the client
    // secret, only that one was given.
    const fields = body as Record<string, unknown>;
    if (SSO_FIELDS.some((field) => field in fields) || "clientSecret" in fields) {
      for (const field of SSO_FIELDS) {
        const value = fields[field];
        if (value !== undefined && (typeof value !== "string" || value.length <= 500)) target[field] = value;
      }
      target["enabled"] = fields["enabled"] === true;
      if (fields["clientSecret"]) target["secretGiven"] = true;
    }
  }
  return target;
}

/** Every console's audit writes take this lock, so the chain stays one line. */
const CHAIN_LOCK = 0x76657274617564; // "vertaud"

export interface AuditEntryInput {
  actorId: string | null;
  method: string;
  route: string;
  target: Record<string, unknown>;
  status: number;
  requestId: string;
}

/** JSON with every object's keys sorted: the same entry always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** An entry's hash: of the previous entry's hash and the entry itself. */
export function chainHash(previous: string, entry: AuditEntryInput & { at: Date }): string {
  const fields = {
    at: entry.at.toISOString(),
    actorId: entry.actorId,
    method: entry.method,
    route: entry.route,
    target: entry.target,
    status: entry.status,
    requestId: entry.requestId,
  };
  return createHash("sha256").update(previous).update("\n").update(canonical(fields)).digest("hex");
}

/** Appends an entry to the chain (auditExport.ts checks it before shipping it). */
export async function appendAuditEntry<S extends Record<string, unknown>>(database: NodePgDatabase<S>, entry: AuditEntryInput): Promise<void> {
  // Microseconds are kept by Postgres, milliseconds by Date: hash what's stored.
  const at = new Date();
  await database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`);
    const [last] = await tx
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .where(isNotNull(auditLog.hash))
      .orderBy(desc(auditLog.id))
      .limit(1);
    await tx.insert(auditLog).values({ ...entry, at, hash: chainHash(last?.hash ?? "", { ...entry, at }) });
  });
}

/** Writes one audit entry, as a log line and a row; a failed write is logged. */
export async function writeAuditEntry(
  log: FastifyBaseLogger,
  entry: {
    actorId: string | null;
    method: string;
    route: string;
    target: Record<string, unknown>;
    status: number;
    requestId: string;
  },
): Promise<void> {
  log.info({ event: "audit", ...entry }, `${entry.method} ${entry.route} ${String(entry.status)}`);
  try {
    await appendAuditEntry(db, entry);
  } catch (error) {
    // The request has been answered; losing its record is logged loudly,
    // and the log line above still has it.
    log.error({ err: error, event: "audit_write_failed" }, "couldn't record an audit entry");
  }
}
