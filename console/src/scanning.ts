// SPDX-License-Identifier: MIT
/**
 * Scanning every image before it's registered or run, whoever built it.
 * Catalog CI scans what it publishes, but an image registered by hand, or
 * one that turns vulnerable after it shipped, would otherwise run unchecked.
 *
 * One verdict per digest (db/schema.ts's imageScans), from a Trivy client
 * Job (k8s.ts's createScanJob) run against the chart's Trivy server, which
 * holds the vulnerability database. A multi-platform image is scanned for
 * every platform the cluster runs (config.scanning.platforms), since a step
 * runs whichever its node pulls, and fails if any of them does. The rule is catalog CI's: a HIGH or
 * CRITICAL vulnerability that has a fix, or a secret baked into the image,
 * fails it; unfixable ones are reported, not blocking. A failed digest
 * blocks new registrations and runs (core/products.ts, routes/
 * executions.ts), never steps already running, until a rescan finds it
 * clean or an admin accepts it with a reason. Images in use are rescanned
 * daily, since new vulnerabilities are published against old images. The
 * kernel chart's scan policy admits only the digests that passed (or were
 * accepted) and are still in use (syncScanPolicy, digestInUse), so the
 * cluster refuses anything else however a Job reaches it. A submission
 * writes its digests there before kernel-api has it (scanBlocker).
 */
import { and, eq, gt, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { imageScans, products, submittedExecutions } from "./db/schema.js";
import { normalizeImage } from "./imageRef.js";
import { createScanJob, deleteScanJob, NO_PLATFORM_MARKER, readScanJob, readScanner, scaleScanner, updateScanPolicy } from "./k8s.js";
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

/** Whether a scan container found no image for its platform (k8s.ts's SCAN_SCRIPT): no node of that platform can run it either. */
function noSuchPlatform(output: string): boolean {
  return output.trim().split("\n").at(-1)?.trim() === NO_PLATFORM_MARKER;
}

/**
 * One scan's findings from its platforms' outputs (one each): those of
 * every platform the image has, counted once however many have them. An
 * error when one isn't a complete scan, or the image has none of them.
 */
export function combineScanOutputs(outputs: string[]): { findings: ScanFindings } | { error: string } {
  const lines = new Set<string>();
  let scanned = 0;
  for (const output of outputs) {
    if (parseScanOutput(output) === null) {
      if (noSuchPlatform(output)) continue;
      return { error: output.trim().split("\n").slice(-5).join("\n") || "The scan failed." };
    }
    scanned++;
    for (const line of output.split("\n").map((l) => l.trim())) if (line && line !== "END") lines.add(line);
  }
  if (scanned === 0) return { error: `The image has none of the platforms scanned (${config.scanning.platforms.join(", ")}).` };
  // Complete scans' lines, so this is one too.
  return { findings: parseScanOutput([...lines, "END"].join("\n")) as ScanFindings };
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

/** How long a digest stays admitted after it was last used (digestInUse). */
export const ADMIT_GRACE_MINUTES = 60;

/**
 * The most digests the scan policy may hold (scan-policy.yaml's header):
 * about 80 bytes each, so about 400 KB, well under etcd's 1.5 MiB object
 * limit (and Helm's release Secrets, which keep it, hold 1 MiB). It holds
 * them in sixteen maps by their first hex digit, since the API server
 * compiles at most 100,000 characters per CEL expression: at most
 * MAX_PER_MAP in each.
 */
export const MAX_ADMITTED_DIGESTS = 5_000;
export const MAX_PER_MAP = 1_200;
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];

/** A pinned image's digest, for SQL's substring(... from ...). */
export const PINNED_DIGEST = "@(sha256:[a-f0-9]{64})$";

/**
 * The digests the steps of every execution the console hasn't seen finish
 * run (its submitted_executions row not yet recorded): the kernel starts
 * their later steps and further attempts by itself. Never NULL.
 */
export const runningDigests: SQL = sql`(
  SELECT digest FROM (
    SELECT substring(step.task->>'image' from ${PINNED_DIGEST}) AS digest
    FROM ${submittedExecutions},
      jsonb_array_elements(CASE WHEN jsonb_typeof(${submittedExecutions.payload}->'tasks') = 'array'
        THEN ${submittedExecutions.payload}->'tasks' ELSE '[]'::jsonb END) AS step(task)
    WHERE ${submittedExecutions.resourcesRecordedAt} IS NULL
  ) AS running
  WHERE digest IS NOT NULL
)`;

/**
 * Whether a scan's digest is still in use, so the cluster must keep
 * admitting it (scan-policy.yaml's header): a registered product's image
 * (by digest), a step of an execution not yet seen finished (the kernel
 * starts its later steps and attempts by itself), or used in the last
 * ADMIT_GRACE_MINUTES (a submission whose execution isn't recorded yet).
 * Whatever else runs again goes through a submission or retry, which
 * scans it and admits it again first. The subqueries never yield NULL (an
 * image that isn't pinned), so neither does this, and NOT digestInUse
 * (retention.ts) means what it says.
 */
export const digestInUse: SQL = sql`(
  ${imageScans.lastUsedAt} > now() - make_interval(mins => ${ADMIT_GRACE_MINUTES})
  OR ${imageScans.digest} IN (
    SELECT digest FROM (SELECT substring(${products.image} from ${PINNED_DIGEST}) AS digest FROM ${products}) AS registered
    WHERE digest IS NOT NULL
  )
  OR ${imageScans.digest} IN ${runningDigests}
)`;

/** The digests the cluster admits: passed, or failed and accepted, and in use. */
export async function admittedDigests(): Promise<string[]> {
  const rows = await db
    .select({ digest: imageScans.digest })
    .from(imageScans)
    .where(
      and(
        or(eq(imageScans.status, "passed"), and(eq(imageScans.status, "failed"), isNotNull(imageScans.acceptedAt))),
        digestInUse,
      ),
    )
    .orderBy(imageScans.digest);
  return rows.map((row) => row.digest);
}

/**
 * How long after this console starts it keeps the kernel chart's upgrade
 * seed (unlistedAdmitted true, scan-policy.yaml): consoles from before the
 * allow list, which don't write it, may still be taking submissions during
 * this one's rollout. Only kept when it's there; never set.
 */
export const UPGRADE_OVERLAP_MS = 10 * 60_000;
const startedAt = Date.now();

/** What the scan policy says: each listed digest admitted (true) or not, and whether one not listed is. */
interface ScanPolicyState {
  digests: Map<string, boolean>;
  unlistedAdmitted: boolean;
}

/** The state the policy's variables (k8s.ts's updateScanPolicy) hold; a literal that can't be read counts as empty. */
function readState(variables: Record<string, string>): ScanPolicyState {
  const digests = new Map<string, boolean>();
  for (const digit of DIGITS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(variables[`allowedDigests${digit}`] ?? "{}");
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    for (const [digest, admitted] of Object.entries(parsed)) {
      if (typeof admitted === "boolean") digests.set(digest, admitted);
    }
  }
  return { digests, unlistedAdmitted: variables["unlistedAdmitted"] === "true" };
}

/** The policy's variables for a state: each digest in its first hex digit's map. */
function writeState(state: ScanPolicyState): Record<string, string> {
  if (state.digests.size > MAX_ADMITTED_DIGESTS) {
    throw new Error(`${String(state.digests.size)} image digests are in use, more than the scan policy holds (${String(MAX_ADMITTED_DIGESTS)}).`);
  }
  const maps = new Map<string, Record<string, boolean>>(DIGITS.map((digit) => [digit, {}]));
  for (const digest of [...state.digests.keys()].sort()) {
    const map = maps.get(digest.charAt(7));
    if (map) map[digest] = state.digests.get(digest) ?? false;
  }
  const variables: Record<string, string> = { unlistedAdmitted: String(state.unlistedAdmitted) };
  for (const [digit, map] of maps) {
    if (Object.keys(map).length > MAX_PER_MAP) {
      throw new Error(`More than ${String(MAX_PER_MAP)} image digests in use start ${digit}, more than the scan policy holds in one map.`);
    }
    variables[`allowedDigests${digit}`] = JSON.stringify(map);
  }
  return variables;
}

/** Whether the policy admits a digest, as its CEL does. */
function stateAdmits(state: ScanPolicyState, digest: string): boolean {
  const listed = state.digests.get(digest);
  return listed === true || (listed === undefined && state.unlistedAdmitted);
}

/**
 * What the scan policy should say, given what it says now: each admitted
 * digest, true. While the chart's upgrade seed is there and this console
 * started less than UPGRADE_OVERLAP_MS ago, unlistedAdmitted stays true,
 * with each digest that fails (and isn't accepted) listed false, as the
 * deny list before it.
 */
async function wantedState(current: ScanPolicyState): Promise<ScanPolicyState> {
  const wanted: ScanPolicyState = { digests: new Map(), unlistedAdmitted: false };
  if (current.unlistedAdmitted && Date.now() - startedAt < UPGRADE_OVERLAP_MS) {
    wanted.unlistedAdmitted = true;
    const refused = await db
      .select({ digest: imageScans.digest })
      .from(imageScans)
      .where(and(eq(imageScans.status, "failed"), isNull(imageScans.acceptedAt)));
    for (const { digest } of refused) wanted.digests.set(digest, false);
  }
  for (const digest of await admittedDigests()) wanted.digests.set(digest, true);
  return wanted;
}

/**
 * Makes sure the cluster admits these digests, which have just passed (or
 * been accepted), before a step of them is handed to kernel-api: when one
 * isn't admitted yet (or the chart's upgrade seed is there past
 * UPGRADE_OVERLAP_MS), the whole list is rewritten and the write waited
 * for. Returns the digests it still doesn't admit: their verdict changed
 * meanwhile.
 */
async function admit(digests: string[]): Promise<string[]> {
  if (digests.length === 0 || !config.scanning.policyName) return [];
  let state: ScanPolicyState = { digests: new Map(), unlistedAdmitted: false };
  const exists = await updateScanPolicy(
    config.scanning.policyName,
    async (variables) => {
      state = readState(variables);
      const seedExpired = state.unlistedAdmitted && Date.now() - startedAt >= UPGRADE_OVERLAP_MS;
      if (!seedExpired && digests.every((digest) => stateAdmits(state, digest))) return variables;
      state = await wantedState(state);
      return writeState(state);
    },
    { settle: true },
  );
  return exists ? digests.filter((digest) => !stateAdmits(state, digest)) : [];
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
    azureWorkloadIdentity: config.scanning.azureWorkloadIdentity,
    target,
    insecure,
    platforms: config.scanning.platforms,
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
    const outputs = job.state === "missing" ? [] : (job.outputs ?? [job.output]);
    if (job.state === "failed" && outputs.some((output) => IMAGE_GONE.test(output)) && row.status !== "failed") {
      // The registry no longer has it: scanning again can never work. It
      // can't run either; if it's ever pushed again, its next use scans it.
      // A failed verdict is kept (below, as a rescan that couldn't run), so
      // the console keeps refusing it.
      const gone = await db.delete(imageScans).where(thisJob).returning({ digest: imageScans.digest });
      await deleteScanJob(namespace, row.jobName);
      if (gone.length === 0) continue;
      scansFinished.inc({ status: "gone" });
      changed = true;
      continue;
    }
    // A failed Job may still have complete scans in its other containers
    // (one that failed for its own reason is an error all the same).
    const scan: { findings: ScanFindings } | { error: string } =
      job.state === "missing"
        ? { error: "The scan Job disappeared." }
        : job.state === "succeeded" && job.unread
          ? { error: `The scan finished, but its output couldn't be read (${job.unread}).` }
          : combineScanOutputs(outputs);
    const status = "findings" in scan ? verdictOf(scan.findings) : "error";
    const recorded: ScanFindings = "findings" in scan ? scan.findings : { fixable: 0, unfixable: 0, secrets: 0, findings: [], error: scan.error };
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

/**
 * Writes the digests the cluster admits (admittedDigests) into the kernel
 * chart's scan policy, pruning those no longer in use.
 */
export async function syncScanPolicy(): Promise<boolean> {
  if (!config.scanning.enabled || !config.scanning.policyName) return false;
  return updateScanPolicy(config.scanning.policyName, async (variables) => writeState(await wantedState(readState(variables))));
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
 * try again. Null also means the cluster's scan policy admits them now
 * (admit), so call it before handing kernel-api what runs them.
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
    if (waiting.length === 0 && errored.length === 0) {
      const unadmitted = await admit([...new Set(pinned.map((image) => digestOf(image) ?? ""))]);
      if (unadmitted.length === 0) return null;
      const changed = pinned.filter((image) => unadmitted.includes(digestOf(image) ?? ""));
      return {
        error: "IMAGE_SCAN_PENDING",
        message: `The scan verdict of ${changed.join(", ")} changed while it was being submitted; try again.`,
        images: changed.map((image) => ({ image, digest: digestOf(image) ?? "" })),
      };
    }
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
