// SPDX-License-Identifier: MIT
/**
 * Shipping the audit log to write-once storage (config.audit.export): every
 * few minutes one console (an advisory lock) takes the entries after the
 * last one exported, checks their chain (audit.ts) links from the last
 * exported hash, and writes them as one JSON-lines object to a bucket that
 * refuses deletes and overwrites (a GCS retention policy, S3 Object Lock),
 * create-only on its side too. A broken chain (an entry changed, removed or
 * inserted in the database) stops the export where it breaks, loudly: what
 * was shipped stays the record. The bucket and its lock are vertra's
 * (docs/operations.md, "The audit log's copy").
 *
 * The chain shows a change only if it wasn't rewritten after the change:
 * someone who can write the database could change an entry and every hash
 * after it. So the database is also compared with what was shipped
 * (compareWithCopy): each copied entry against its row, field by field
 * (COMPARED), a few objects an hour, round and round.
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, asc, count, eq, gt, gte, lte, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { chainHash } from "./audit.js";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { auditExport, auditLog } from "./db/schema.js";
import { gcpMetadataToken } from "./gcpMetadata.js";

const LOCK = 0x7665727465787074; // "vertexpt"
/** The most entries in one object. */
const BATCH = 5000;

type Row = typeof auditLog.$inferSelect;

/** The first entry whose hash doesn't follow from the one before it, if any. */
export function brokenAt(previousHash: string, rows: Row[]): Row | undefined {
  let previous = previousHash;
  for (const row of rows) {
    if (row.hash === null) {
      // From before the chain: only before its first hashed entry.
      if (previous === "") continue;
      return row;
    }
    const expected = chainHash(previous, {
      at: row.at,
      actorId: row.actorId,
      method: row.method,
      route: row.route,
      target: row.target as Record<string, unknown>,
      status: row.status,
      requestId: row.requestId ?? "",
    });
    if (expected !== row.hash) return row;
    previous = row.hash;
  }
  return undefined;
}

async function put(name: string, body: string): Promise<void> {
  const target = config.audit.export;
  if (target.provider === "gcs") {
    // Create-only: ifGenerationMatch=0 refuses an object that exists.
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(target.bucket)}/o`);
    url.search = new URLSearchParams({ uploadType: "media", name, ifGenerationMatch: "0" }).toString();
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${await gcpMetadataToken()}`, "content-type": "application/x-ndjson" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GCS answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);
    return;
  }
  // Create-only: If-None-Match refuses an object that exists. The bucket's
  // default retention (Object Lock) applies to it.
  await s3Client().send(new PutObjectCommand({ Bucket: target.bucket, Key: name, Body: body, IfNoneMatch: "*", ContentType: "application/x-ndjson" }));
}

function s3Client(): S3Client {
  const target = config.audit.export;
  return new S3Client({
    region: target.region || "us-east-1",
    ...(target.endpoint ? { endpoint: target.endpoint, forcePathStyle: true } : {}),
  });
}

/** A copy's name says which entries it holds: <first>-<last>.jsonl. */
const COPY_NAME = /(\d{12})-(\d{12})\.jsonl$/;

interface Copy {
  name: string;
  first: number;
  last: number;
}

/** Every copy in the bucket, oldest first. */
async function listCopies(): Promise<Copy[]> {
  const target = config.audit.export;
  const names: string[] = [];
  if (target.provider === "gcs") {
    let page = "";
    do {
      const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(target.bucket)}/o`);
      url.search = new URLSearchParams({ prefix: target.prefix, fields: "items(name),nextPageToken", ...(page ? { pageToken: page } : {}) }).toString();
      const response = await fetch(url, { headers: { authorization: `Bearer ${await gcpMetadataToken()}` }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`GCS answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);
      const listed = (await response.json()) as { items?: { name: string }[]; nextPageToken?: string };
      names.push(...(listed.items ?? []).map((item) => item.name));
      page = listed.nextPageToken ?? "";
    } while (page);
  } else {
    let token: string | undefined;
    do {
      const listed = await s3Client().send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: target.prefix, ContinuationToken: token }));
      names.push(...(listed.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : [])));
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }
  return names
    .flatMap((name) => {
      const m = COPY_NAME.exec(name);
      return m ? [{ name, first: Number(m[1]), last: Number(m[2]) }] : [];
    })
    .sort((a, b) => a.first - b.first);
}

async function readCopy(name: string): Promise<string> {
  const target = config.audit.export;
  if (target.provider === "gcs") {
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(target.bucket)}/o/${encodeURIComponent(name)}?alt=media`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${await gcpMetadataToken()}` }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`GCS answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);
    return response.text();
  }
  const object = await s3Client().send(new GetObjectCommand({ Bucket: target.bucket, Key: name }));
  return (await object.Body?.transformToString()) ?? "";
}

/**
 * What the comparison compares: what chainHash hashes, and the id and hash.
 * Not the whole row, so a column added to audit_log later doesn't make
 * every entry already copied differ.
 */
const COMPARED = ["id", "at", "actorId", "method", "route", "target", "status", "requestId", "hash"] as const;

/** An entry (a row, or a copied line parsed) as the comparison sees it: its COMPARED fields, in order (a Date as JSON writes it). */
export function compared(entry: Record<string, unknown>): string {
  return JSON.stringify(COMPARED.map((field) => entry[field] ?? null));
}

/** How many copies one look compares. */
const COPIES_A_LOOK = 10;

/**
 * One look comparing the database with its copy: the next few copies after
 * the last one compared (from the first again once it reaches the end).
 * Each copied entry must be its row (compared); the first that isn't
 * (changed, or gone from the database) is recorded, loudly, and the look
 * stops there.
 */
export async function compareWithCopy(log: FastifyBaseLogger): Promise<void> {
  if (!config.audit.export.bucket) return;
  const now = new Date();
  const [state] = await db.select().from(auditExport).where(eq(auditExport.id, 1));
  let copies: Copy[];
  try {
    copies = await listCopies();
  } catch (error) {
    await record({ comparedAt: now, compareProblem: `couldn't list the copy: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  let through = state?.comparedThrough ?? 0;
  let next = copies.filter((c) => c.first > through).slice(0, COPIES_A_LOOK);
  if (next.length === 0) {
    // The end of a round: from the first copy again.
    through = 0;
    next = copies.slice(0, COPIES_A_LOOK);
  }
  for (const copy of next) {
    let lines: string[];
    try {
      lines = (await readCopy(copy.name)).split("\n").filter((line) => line !== "");
    } catch (error) {
      await record({ comparedAt: now, compareProblem: `couldn't read ${copy.name}: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(gte(auditLog.id, copy.first), lte(auditLog.id, copy.last)))
      .orderBy(asc(auditLog.id));
    const stored = new Map(rows.map((row) => [row.id, compared(row)]));
    // Retention deletes what's older than auditDays (retention.ts): an
    // entry gone from the database for that is as expected.
    const kept = config.retention.auditDays ? now.getTime() - config.retention.auditDays * 86_400_000 : null;
    for (const line of lines) {
      const copied = JSON.parse(line) as { id: number; at: string };
      const { id, at } = copied;
      const row = stored.get(id);
      if (row === compared(copied)) continue;
      if (row === undefined && kept !== null && new Date(at).getTime() < kept) continue;
      const how = row === undefined ? "is gone from the database" : "differs in the database";
      const problem = `audit entry ${String(id)} ${how} from its write-once copy (${copy.name}): it was changed after it was copied.`;
      log.error({ event: "audit_copy_differs", entryId: id, object: copy.name }, problem);
      await record({ comparedAt: now, differsAt: id, compareProblem: problem });
      return;
    }
    through = copy.last;
  }
  await record({ comparedThrough: through, comparedAt: now, differsAt: null, compareProblem: null });
}

async function record(values: Partial<typeof auditExport.$inferInsert>): Promise<void> {
  await db
    .insert(auditExport)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: auditExport.id, set: values });
}

/** One export; false when another console holds the lock. */
export async function exportAudit(log: FastifyBaseLogger): Promise<boolean> {
  if (!config.audit.export.bucket) return true;
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${LOCK}) AS locked`);
    if (!locked.rows[0]?.locked) return false;
    const now = new Date();
    const [state] = await tx.select().from(auditExport).where(eq(auditExport.id, 1));
    const lastId = state?.lastId ?? 0;
    const rows = await tx.select().from(auditLog).where(gt(auditLog.id, lastId)).orderBy(asc(auditLog.id)).limit(BATCH);
    const [first] = rows;
    const last = rows.at(-1);
    if (!first || !last) {
      await record({ checkedAt: now, error: null, brokenAt: null });
      return true;
    }
    const broken = brokenAt(state?.lastHash ?? "", rows);
    if (broken) {
      const error = `the audit log's chain breaks at entry ${String(broken.id)}: it was changed, or one before it was removed or added, after it was written. Nothing from there on is exported.`;
      log.error({ event: "audit_chain_broken", entryId: broken.id }, error);
      await record({ checkedAt: now, error, brokenAt: broken.id });
      return true;
    }
    const day = last.at.toISOString().slice(0, 10).replaceAll("-", "/");
    const name = `${config.audit.export.prefix}${day}/${String(first.id).padStart(12, "0")}-${String(last.id).padStart(12, "0")}.jsonl`;
    try {
      await put(name, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    } catch (error) {
      log.error({ event: "audit_export_failed", err: error }, "couldn't export the audit log");
      await record({ checkedAt: now, error: `couldn't write to the bucket: ${error instanceof Error ? error.message : String(error)}`, brokenAt: null });
      return true;
    }
    await record({ lastId: last.id, lastHash: last.hash ?? state?.lastHash ?? "", exportedAt: now, checkedAt: now, error: null, brokenAt: null });
    log.info({ event: "audit_exported", object: name, entries: rows.length }, "audit log exported");
    return true;
  });
}

/** The export's state, for Observe: none when it's off. */
export async function auditExportStatus() {
  if (!config.audit.export.bucket) return null;
  const [state] = await db.select().from(auditExport).where(eq(auditExport.id, 1));
  return (
    state ?? {
      lastId: 0,
      lastHash: "",
      exportedAt: null,
      checkedAt: null,
      error: null,
      brokenAt: null,
      comparedThrough: 0,
      comparedAt: null,
      differsAt: null,
      compareProblem: null,
    }
  );
}

/** Where the copy goes, as a URL: gs://bucket/prefix or s3://bucket/prefix. */
export function auditExportDestination(): string {
  const target = config.audit.export;
  return `${target.provider === "gcs" ? "gs" : "s3"}://${target.bucket}/${target.prefix}`;
}

/** Entries written since the last one copied. */
export async function auditEntriesNotCopied(lastId: number): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog).where(gt(auditLog.id, lastId));
  return row?.n ?? 0;
}

export function startAuditExport(log: FastifyBaseLogger): void {
  if (!config.audit.export.bucket) return;
  const run = () => {
    exportAudit(log).catch((error: unknown) => {
      log.error({ event: "audit_export_failed", err: error }, "couldn't export the audit log");
    });
  };
  run();
  setInterval(run, config.audit.export.minutes * 60_000).unref();
  const compare = () => {
    compareWithCopy(log).catch((error: unknown) => {
      log.error({ event: "audit_compare_failed", err: error }, "couldn't compare the audit log with its copy");
    });
  };
  setTimeout(compare, 60_000).unref();
  setInterval(compare, 60 * 60_000).unref();
}
