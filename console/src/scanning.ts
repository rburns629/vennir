// SPDX-License-Identifier: MIT
/**
 * Scanning every image before it's registered or run, whoever built it.
 * Catalog CI scans what it publishes, but an image registered by hand, or
 * one that turns vulnerable after it shipped, would otherwise run unchecked.
 *
 * One verdict per digest (db/schema.ts's imageScans), from a Trivy client
 * Job (k8s.ts's createScanJob) run against the chart's Trivy server, which
 * holds the vulnerability database. The rule is catalog CI's: a HIGH or
 * CRITICAL vulnerability that has a fix, or a secret baked into the image,
 * fails it; unfixable ones are reported, not blocking. A failed digest
 * blocks new registrations and runs (core/products.ts, routes/
 * executions.ts), never steps already running, until a rescan finds it
 * clean or an admin accepts it with a reason. Images in use are rescanned
 * daily, since new vulnerabilities are published against old images. The
 * kernel chart's scan policy holds the failed digests (syncScanPolicy), so
 * the cluster refuses them however a Job reaches it.
 */
import { and, eq, gt, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { imageScans } from "./db/schema.js";
import { normalizeImage } from "./imageRef.js";
import { createScanJob, deleteScanJob, readScanJob, readScanner, scaleScanner, updateScanPolicy } from "./k8s.js";
import { scansFinished } from "./metrics.js";

export type ScanRow = typeof imageScans.$inferSelect;

export interface Finding {
  kind: "vulnerability" | "secret";
  id: string;
  severity: string;
  package?: string;
  installed?: string;
  fixedIn?: string;
  title?: string;
}

export interface ScanFindings {
  fixable: number;
  unfixable: number;
  secrets: number;
  /** The blocking ones first, at most MAX_FINDINGS. */
  findings: Finding[];
  error?: string;
}

const MAX_FINDINGS = 25;

/**
 * Trivy's `--format template`: one line per HIGH/CRITICAL vulnerability and
 * per secret, then END, so a cut-off output is never read as a clean one.
 * (`.` is the report's Results.)
 */
export const SCAN_TEMPLATE =
  "{{- range . }}{{- range .Vulnerabilities }}" +
  '{{- if or (eq .Severity "CRITICAL") (eq .Severity "HIGH") }}' +
  "V|{{ .Severity }}|{{ .FixedVersion }}|{{ .VulnerabilityID }}|{{ .PkgName }}|{{ .InstalledVersion }}\n" +
  "{{ end }}{{- end }}" +
  "{{- range .Secrets }}S|{{ .Severity }}|{{ .RuleID }}|{{ .Title }}\n{{ end }}" +
  "{{- end }}END\n";

/** The scan's findings, or null when the output isn't a complete scan. */
export function parseScanOutput(output: string): ScanFindings | null {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.at(-1) !== "END") return null;
  const result: ScanFindings = { fixable: 0, unfixable: 0, secrets: 0, findings: [] };
  const blocking: Finding[] = [];
  const reported: Finding[] = [];
  for (const line of lines.slice(0, -1)) {
    const fields = line.split("|");
    if (fields[0] === "V") {
      const [, severity = "", fixedIn = "", id = "", pkg = "", installed = ""] = fields;
      const finding: Finding = { kind: "vulnerability", id, severity, package: pkg, installed, ...(fixedIn ? { fixedIn } : {}) };
      if (fixedIn) {
        result.fixable++;
        blocking.push(finding);
      } else {
        result.unfixable++;
        reported.push(finding);
      }
    } else if (fields[0] === "S") {
      const [, severity = "", id = "", title = ""] = fields;
      result.secrets++;
      blocking.push({ kind: "secret", id, severity, title });
    }
  }
  result.findings = [...blocking, ...reported].slice(0, MAX_FINDINGS);
  return result;
}

export function verdictOf(findings: ScanFindings): "passed" | "failed" {
  return findings.fixable > 0 || findings.secrets > 0 ? "failed" : "passed";
}

/** The digest an image is pinned to, or null for a tag. */
export function digestOf(image: string): string | null {
  return /@(sha256:[a-f0-9]{64})$/.exec(image)?.[1] ?? null;
}

/** What the scan Job pulls: through the registry's mirror when there is one. */
export function scanTarget(image: string): { target: string; insecure: boolean } {
  const normalized = normalizeImage(image);
  const host = normalized.split("/")[0] ?? "";
  const mirror = config.registryMirrors.get(host);
  if (!mirror) return { target: normalized, insecure: false };
  const url = new URL(mirror);
  return { target: url.host + normalized.slice(host.length), insecure: url.protocol === "http:" };
}

function blocks(row: ScanRow): boolean {
  return row.status === "failed" && row.acceptedAt === null;
}

/**
 * Whether the Trivy server can take a scan now. An idled one (scaled to zero)
 * is scaled up and isn't ready yet: the scan stays pending, and
 * reconcileScans starts it once the server is up.
 */
async function scannerReady(): Promise<boolean> {
  const name = config.scanning.scannerDeployment;
  if (!name) return true;
  const scanner = await readScanner(config.platformNamespace, name);
  if (scanner.replicas === 0) await scaleScanner(config.platformNamespace, name, 1);
  return scanner.replicas > 0 && scanner.ready > 0;
}

/**
 * Scales the Trivy server to zero once no scan is running or due (the
 * caller checks that) and none has been asked for or finished in
 * idleMinutes. requestScan and the rescans bring it
 * back.
 */
async function idleScanner(): Promise<void> {
  const name = config.scanning.scannerDeployment;
  if (!name || config.scanning.idleMinutes <= 0) return;
  const idle = sql`now() - make_interval(secs => ${config.scanning.idleMinutes * 60})`;
  const [busy] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(imageScans)
    .where(
      or(
        isNotNull(imageScans.jobName),
        gt(imageScans.requestedAt, idle),
        gt(imageScans.scannedAt, idle),
      ),
    );
  if ((busy?.n ?? 0) > 0) return;
  const scanner = await readScanner(config.platformNamespace, name);
  if (scanner.replicas === 0) return;
  await scaleScanner(config.platformNamespace, name, 0);
}

async function startScan(row: { digest: string; image: string }): Promise<void> {
  const name = `scan-${row.digest.slice(7, 27)}-${Date.now().toString(36)}`;
  const { target, insecure } = scanTarget(row.image);
  // The job name is taken first, so two consoles don't both start one.
  const claimed = await db
    .update(imageScans)
    .set({ jobName: name, requestedAt: new Date() })
    .where(and(eq(imageScans.digest, row.digest), isNull(imageScans.jobName)))
    .returning({ digest: imageScans.digest });
  if (claimed.length === 0) return;
  await createScanJob({
    namespace: config.platformNamespace,
    name,
    scannerImage: config.scanning.image,
    serverUrl: config.scanning.serverUrl,
    serviceAccount: config.scanning.serviceAccount,
    pullSecretName: config.scanning.pullSecretName,
    target,
    insecure,
    platform: config.scanning.platform,
    template: SCAN_TEMPLATE,
  });
}

/** The registry's answer for a digest it doesn't have (Trivy passes it on). */
const IMAGE_GONE = /MANIFEST_UNKNOWN|manifest unknown/i;

/** How long an attempt that couldn't scan (its image gone from the registry, say) waits before the next. */
export const RETRY_ERRORED_MINUTES = 15;

/**
 * Whether a scan is due: never scanned, or its last attempt errored and
 * has waited RETRY_ERRORED_MINUTES, or its verdict is older than the
 * rescan interval and no rescan has failed in the last RETRY_ERRORED_MINUTES
 * (a rescan that errors keeps the old verdict, so without that it'd be
 * started again on every pass). The same rule as reconcileScans' query.
 */
function isDue(row: ScanRow, now: Date): boolean {
  const waited = now.getTime() - row.requestedAt.getTime() > RETRY_ERRORED_MINUTES * 60_000;
  if (row.status === "pending") return true;
  if (row.status === "error") return waited;
  const stale = row.scannedAt !== null && now.getTime() - row.scannedAt.getTime() > config.scanning.rescanHours * 3_600_000;
  return stale && (row.scannedAt === null || row.requestedAt <= row.scannedAt || waited);
}

/**
 * Makes sure `image` (pinned) has a scan: starts one if it's due (isDue),
 * or now with `force` (an admin's rescan); marks it used either way.
 * Returns its row.
 */
export async function requestScan(image: string, { force = false } = {}): Promise<ScanRow | null> {
  const digest = digestOf(image);
  if (!digest || !config.scanning.enabled) return null;
  const now = new Date();
  await db
    .insert(imageScans)
    .values({ digest, image, status: "pending" })
    .onConflictDoUpdate({ target: imageScans.digest, set: { lastUsedAt: now } });
  const [row] = await db.select().from(imageScans).where(eq(imageScans.digest, digest));
  if (!row) return null;
  if (row.jobName === null && (force || isDue(row, now)) && (await scannerReady())) {
    await startScan(row);
  }
  return row;
}

/** Reads every running scan Job, records the finished ones' verdicts, and
 * starts the rescans that are due. Returns whether any verdict changed. */
export async function reconcileScans(): Promise<boolean> {
  if (!config.scanning.enabled) return false;
  const namespace = config.platformNamespace;
  let changed = false;
  const running = await db.select().from(imageScans).where(isNotNull(imageScans.jobName));
  for (const row of running) {
    if (!row.jobName) continue;
    const job = await readScanJob(namespace, row.jobName, "trivy", true);
    if (job.state === "running") continue;
    // Every write below is conditioned on this Job still being the row's:
    // another reconcile (another replica's, or a submission waiting in
    // scanBlocker) may have recorded it already and started the next scan.
    const thisJob = and(eq(imageScans.digest, row.digest), eq(imageScans.jobName, row.jobName));
    if (job.state === "failed" && IMAGE_GONE.test(job.output) && row.status !== "failed") {
      // The registry no longer has it: scanning again can never work. It
      // can't run either; if it's ever pushed again, its next use scans it.
      // A failed verdict is kept (below, as a rescan that couldn't run), so
      // the digest stays on the cluster's deny list.
      const gone = await db.delete(imageScans).where(thisJob).returning({ digest: imageScans.digest });
      await deleteScanJob(namespace, row.jobName);
      if (gone.length === 0) continue;
      scansFinished.inc({ status: "gone" });
      changed = true;
      continue;
    }
    const findings = job.state === "succeeded" ? parseScanOutput(job.output) : null;
    const status = findings ? verdictOf(findings) : "error";
    const recorded: ScanFindings = findings ?? {
      fixable: 0,
      unfixable: 0,
      secrets: 0,
      findings: [],
      error:
        job.state === "missing"
          ? "The scan Job disappeared."
          : job.state === "succeeded" && job.unread
            ? `The scan finished, but its output couldn't be read (${job.unread}).`
            : job.output.trim().split("\n").slice(-5).join("\n") || "The scan failed.",
    };
    // An accepted verdict stays accepted only while it finds nothing the
    // admin didn't see.
    const previous = new Set(((row.findings as ScanFindings | null)?.findings ?? []).map((f) => f.id));
    const somethingNew = recorded.findings.some((f) => !previous.has(f.id));
    const recordedRows = await db
      .update(imageScans)
      .set({
        // A rescan that couldn't run keeps the last real verdict.
        status: status === "error" && row.status !== "pending" ? row.status : status,
        findings: status === "error" && row.status !== "pending" ? row.findings : recorded,
        scannedAt: status === "error" && row.status !== "pending" ? row.scannedAt : new Date(),
        jobName: null,
        ...(status === "failed" && somethingNew ? { acceptedAt: null, acceptedBy: null, acceptedReason: null } : {}),
      })
      .where(thisJob)
      .returning({ digest: imageScans.digest });
    await deleteScanJob(namespace, row.jobName);
    if (recordedRows.length === 0) continue;
    scansFinished.inc({ status });
    changed ||= status !== row.status;
  }
  const due = await db
    .select()
    .from(imageScans)
    .where(
      and(
        isNull(imageScans.jobName),
        gt(imageScans.lastUsedAt, sql`now() - interval '30 days'`),
        or(
          eq(imageScans.status, "pending"),
          and(eq(imageScans.status, "error"), lt(imageScans.requestedAt, sql`now() - make_interval(mins => ${RETRY_ERRORED_MINUTES})`)),
          and(
            lt(imageScans.scannedAt, sql`now() - make_interval(hours => ${config.scanning.rescanHours})`),
            or(
              lte(imageScans.requestedAt, imageScans.scannedAt),
              lt(imageScans.requestedAt, sql`now() - make_interval(mins => ${RETRY_ERRORED_MINUTES})`),
            ),
          ),
        ),
      ),
    )
    .limit(20);
  if (due.length > 0 && (await scannerReady())) {
    for (const row of due) await startScan(row);
  }
  if (changed) await syncScanPolicy();
  if (due.length === 0) await idleScanner();
  return changed;
}

/** Writes every blocking digest into the kernel chart's scan policy. */
export async function syncScanPolicy(): Promise<boolean> {
  if (!config.scanning.enabled || !config.scanning.policyName) return false;
  return updateScanPolicy(config.scanning.policyName, async () => {
    const rows = await db.select().from(imageScans).where(eq(imageScans.status, "failed"));
    return JSON.stringify(rows.filter(blocks).map((row) => row.digest).sort());
  });
}

export interface ScanBlocker {
  error: "IMAGE_SCAN_FAILED" | "IMAGE_SCAN_PENDING" | "IMAGE_SCAN_ERROR";
  message: string;
  images: { image: string; digest: string; findings?: ScanFindings | null }[];
}

/**
 * Why these (pinned) images may not run, or null when they may: each must
 * have passed its scan, or been accepted. A first scan is waited for, up to
 * config.scanning.waitSeconds; one still running then asks the caller to
 * try again.
 */
export async function scanBlocker(images: string[]): Promise<ScanBlocker | null> {
  if (!config.scanning.enabled) return null;
  const pinned = [...new Set(images)].filter((image) => digestOf(image) !== null);
  const deadline = Date.now() + config.scanning.waitSeconds * 1000;
  for (;;) {
    const rows = new Map<string, ScanRow>();
    for (const image of pinned) {
      const row = await requestScan(image);
      if (row) rows.set(image, row);
    }
    const failed = pinned.filter((image) => {
      const row = rows.get(image);
      return row !== undefined && blocks(row);
    });
    if (failed.length > 0) {
      return {
        error: "IMAGE_SCAN_FAILED",
        message:
          `${failed.length === 1 ? "This image fails" : "These images fail"} the security scan (a HIGH or CRITICAL ` +
          `vulnerability with a fix, or a secret in the image): ${failed.join(", ")}. Rebuild it, or an admin can ` +
          "accept it with a reason.",
        images: failed.map((image) => ({ image, digest: digestOf(image) ?? "", findings: rows.get(image)?.findings as ScanFindings | null })),
      };
    }
    const waiting = pinned.filter((image) => rows.get(image)?.status === "pending");
    const errored = pinned.filter((image) => rows.get(image)?.status === "error");
    if (waiting.length === 0 && errored.length === 0) return null;
    if (Date.now() >= deadline) {
      return waiting.length > 0
        ? {
            error: "IMAGE_SCAN_PENDING",
            message: `Still scanning ${waiting.join(", ")} for the first time; try again in a minute.`,
            images: waiting.map((image) => ({ image, digest: digestOf(image) ?? "" })),
          }
        : {
            error: "IMAGE_SCAN_ERROR",
            message: `Couldn't scan ${errored.join(", ")}; it's being tried again. Try again in a minute.`,
            images: errored.map((image) => ({ image, digest: digestOf(image) ?? "", findings: rows.get(image)?.findings as ScanFindings | null })),
          };
    }
    await reconcileScans();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
