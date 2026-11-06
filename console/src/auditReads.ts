// SPDX-License-Identifier: MIT
/**
 * Who read what (decided 2026-11-05): every call that returned a run's
 * outputs or failure messages, step logs, what resources provided (step
 * outputs too), or a team's secret or SecretStore names, to the caller who
 * got them, in audit_reads. Reads of sensitive content, not page views;
 * apart from audit_log (audit.ts) so the write chain doesn't grow with
 * every read, and kept for retention.auditReadsDays.
 *
 * Recorded by rpc/interceptors.ts's auditReads interceptor from what each
 * method in READERS answered, so only what was returned is named: a step
 * whose outputs the caller doesn't see (core/runView.ts) comes back without
 * them and isn't recorded, and a call that returned nothing sensitive
 * leaves no row. One interceptor reading the answers, as audit.ts's reads
 * the requests, rather than a call in each core function: the route, the
 * request id and the client's address are the interceptor's to know, and
 * the answer is exactly what the caller got. The chat agent's tools, which
 * call core directly inside ChatService, record their reads themselves
 * (chat/tools.ts), as the person the agent acts for.
 *
 * Named, never repeated: step keys, secret and store names, resource ids,
 * counts. Never an output, a log line, a failure message or a value. One
 * row per call: a list's runs are in execution_ids, its teams in teams.
 *
 * A page that polls reads the same thing again and again: the same reader,
 * from the same address, shown the same content (route, runs, teams,
 * target, and a hash of what was returned: outputs, failure messages, log
 * lines, provided values) is given one row per DEDUPE_MS, by each console
 * process (an in-memory cache of the key's sha256, so a restart or another
 * replica records it again). Content that changed, or a new address, is a
 * new row. Every read is still logged; reading who read is never deduped.
 *
 * Written after the answer, without holding it up (recordReads doesn't
 * wait): a read is logged first (`event: "audit_read"`, for a SIEM, as
 * audit.ts logs writes), and a row that can't be written is logged at
 * error with what it would have said. The read isn't refused when its row
 * can't be written: the log line has it, and refusing reads whenever the
 * database hiccups would make runs unreadable for an outage of the record.
 */
import { createHash } from "node:crypto";
import type { JsonObject } from "@bufbuild/protobuf";
import { inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { taskTeams } from "./core/approvals.js";
import { db } from "./db/client.js";
import { auditReads, resources, submittedExecutions } from "./db/schema.js";
import type { GetExecutionLogsResponse, GetExecutionResponse, ListExecutionEventsRequest, ListExecutionEventsResponse } from "./gen/vennir/console/v1/execution_pb.js";
import type { SearchLogsResponse } from "./gen/vennir/console/v1/observe_pb.js";
import type { PreviewOrderRequest, PreviewOrderResponse } from "./gen/vennir/console/v1/order_pb.js";
import type { ListResourcesResponse } from "./gen/vennir/console/v1/resource_pb.js";
import type { ListSecretStoresRequest, ListSecretStoresResponse, ListSecretsRequest, ListSecretsResponse } from "./gen/vennir/console/v1/secret_pb.js";

/** The most names one row lists; the rest are counted. */
const MAX_NAMES = 200;
/** How long the same reader's same read is recorded once. */
export const DEDUPE_MS = 10 * 60 * 1000;
/** Reads remembered for that, at most, per process. */
const MAX_REMEMBERED = 20_000;

/**
 * What one call read. `teams` unset: the steps' teams, looked up from the
 * run (events name steps only). `executionIds` unset with `resources` in
 * the target: the resources' runs and teams, looked up (an order's plan
 * names the resources only).
 */
export interface Read {
  executionIds?: string[] | undefined;
  teams?: string[] | undefined;
  target: Record<string, unknown>;
  /** A hash of what was returned, for telling a repeat from new content; never stored or logged. */
  content?: string | undefined;
}

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Who read, and through which call. */
export interface ReadRequest {
  actorId: string;
  route: string;
  clientIp: string;
  requestId: string;
}

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const distinct = (values: Iterable<string>) => [...new Set([...values].filter(Boolean))].sort();

/** Names, at most MAX_NAMES of them, with how many more there were. */
function named(field: string, names: Iterable<string>): Record<string, unknown> {
  const all = distinct(names);
  return all.length > MAX_NAMES ? { [field]: all.slice(0, MAX_NAMES), [`${field}More`]: all.length - MAX_NAMES } : { [field]: all };
}

/** Each run's steps, at most MAX_NAMES runs: a log search's. */
function byRun(pairs: { executionId: string; task: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { executionId, task } of pairs) {
    if (!executionId || !task) continue;
    if (!(executionId in out) && Object.keys(out).length >= MAX_NAMES) continue;
    out[executionId] = distinct([...(out[executionId] ?? []), task]);
  }
  return out;
}

const hasText = (value: unknown) => typeof value === "string" && value !== "";
const messageOf = (failure: unknown) => (typeof failure === "object" && failure !== null ? (failure as { message?: unknown }).message : undefined);
const nonEmpty = (value: unknown) => typeof value === "object" && value !== null && Object.keys(value).length > 0;

/** A step as either core/executions.ts's executionDetail or GetExecution returns it. */
export interface ReturnedTask {
  taskId: string;
  outputs?: unknown;
  failure?: unknown;
  attempts?: { failure?: unknown }[];
}

/** What of a step's own content was returned: its outputs and failure messages; null when none was. */
function returnedContent(task: ReturnedTask): string | null {
  const outputs = nonEmpty(task.outputs) ? task.outputs : null;
  const messages = [messageOf(task.failure), ...(task.attempts ?? []).map((a) => messageOf(a.failure))].filter(hasText);
  if (outputs === null && messages.length === 0) return null;
  return sha256([outputs, messages]);
}

/**
 * A run read: the steps whose outputs or failure messages came back. With
 * `seen` (a watch's), only steps whose content is new since its last
 * message, so a stream records what it showed once, not every two seconds.
 */
export function executionRead(
  executionId: string,
  tasks: ReturnedTask[],
  payload: unknown,
  seen?: Map<string, string>,
): Read[] {
  const keys: string[] = [];
  const contents: [string, string][] = [];
  for (const task of tasks) {
    const content = returnedContent(task);
    if (content === null || seen?.get(task.taskId) === content) continue;
    seen?.set(task.taskId, content);
    keys.push(task.taskId);
    contents.push([task.taskId, content]);
  }
  if (keys.length === 0) return [];
  const teamOf = taskTeams(payload);
  return [
    {
      executionIds: [executionId],
      teams: distinct(keys.map((k) => teamOf.get(k) ?? "")),
      target: named("tasks", keys),
      content: sha256(contents.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    },
  ];
}

/** Resources listed: what their steps reported and provided are those steps' outputs. One row for the list. */
export function resourcesRead(listed: { id: string; executionId: string; productTeam: string; ownerTeam: string; provides?: unknown }[]): Read[] {
  if (listed.length === 0) return [];
  return [
    {
      executionIds: distinct(listed.map((r) => r.executionId).filter(isUuid)),
      teams: distinct(listed.flatMap((r) => [r.productTeam, r.ownerTeam])),
      target: named("resources", listed.map((r) => r.id)),
      content: sha256(listed.map((r) => [r.id, r.provides ?? null])),
    },
  ];
}

/** An order's plan: the resources whose provided values it filled inputs with (their runs and teams looked up). */
export function orderPlanRead(team: string, steps: { inputs: Record<string, { kind: string; resourceId?: string; value?: unknown }> }[]): Read[] {
  const ids = steps.flatMap((s) => Object.values(s.inputs)).filter((i) => i.kind === "resource" && i.resourceId && hasText(i.value)).map((i) => i.resourceId as string);
  const values = steps.flatMap((s) => Object.values(s.inputs)).filter((i) => i.kind === "resource").map((i) => [i.resourceId, i.value]);
  return ids.length > 0 ? [{ teams: [team], target: named("resources", ids), content: sha256(values) }] : [];
}

/** Whether an event carries a step's own content: its outputs or a failure's message. */
function eventShowsContent(payload: JsonObject | undefined): boolean {
  if (!payload) return false;
  const error = payload["error"];
  return nonEmpty(payload["outputs"]) || hasText(error) || hasText(messageOf(error));
}

type Reader = (request: unknown, response: unknown) => Read[];

/**
 * The methods whose answers carry what's recorded, each with what of its
 * answer to name; a new method returning such content goes here. A
 * factory per call, so a stream keeps what it has recorded.
 */
export const READERS: Record<string, () => Reader> = {
  "vennir.console.v1.ExecutionService/GetExecution": () => (_req, res) => {
    const execution = (res as GetExecutionResponse).execution;
    return execution ? executionRead(execution.executionId, execution.tasks, execution.dag) : [];
  },
  "vennir.console.v1.ExecutionService/WatchExecution": () => {
    const seen = new Map<string, string>();
    return (_req, res) => {
      const execution = (res as GetExecutionResponse).execution;
      return execution ? executionRead(execution.executionId, execution.tasks, execution.dag, seen) : [];
    };
  },
  "vennir.console.v1.ExecutionService/ListExecutionEvents": () => (req, res) => {
    const shown = (res as ListExecutionEventsResponse).events.filter((e) => eventShowsContent(e.payload));
    const keys = shown.map((e) => (typeof e.payload?.["taskKey"] === "string" ? e.payload["taskKey"] : "")).filter(Boolean);
    const { executionId } = req as ListExecutionEventsRequest;
    return keys.length > 0 ? [{ executionIds: [executionId], target: named("tasks", keys), content: sha256(shown.map((e) => [String(e.id), e.payload])) }] : [];
  },
  "vennir.console.v1.ExecutionService/GetExecutionLogs": () => (req, res) => {
    const shown = (res as GetExecutionLogsResponse).tasks.filter((t) => t.lines.length > 0);
    if (shown.length === 0) return [];
    return [
      {
        executionIds: [(req as { executionId: string }).executionId],
        teams: distinct(shown.map((t) => t.visibleTo)),
        target: { ...named("tasks", shown.map((t) => t.taskId)), lines: shown.reduce((n, t) => n + t.lines.length, 0) },
        content: sha256(shown.map((t) => [t.taskId, t.lines])),
      },
    ];
  },
  // One row: the runs the lines came from, each with its steps; an API backend's or the platform's lines counted with the rest.
  "vennir.console.v1.ObserveService/SearchLogs": () => (_req, res) => {
    const lines = (res as SearchLogsResponse).lines;
    if (lines.length === 0) return [];
    const runs = byRun(lines.filter((l) => isUuid(l.executionId)));
    return [
      {
        executionIds: Object.keys(runs),
        teams: distinct(lines.map((l) => l.team)),
        target: { runs, lines: lines.length },
        content: sha256(lines.map((l) => [l.executionId, l.task, l.line])),
      },
    ];
  },
  "vennir.console.v1.ResourceService/ListResources": () => (_req, res) => resourcesRead((res as ListResourcesResponse).resources),
  "vennir.console.v1.OrderService/PreviewOrder": () => (req, res) => orderPlanRead((req as PreviewOrderRequest).team, (res as PreviewOrderResponse).steps),
  "vennir.console.v1.SecretService/ListSecrets": () => (req, res) => {
    const names = (res as ListSecretsResponse).secrets.map((s) => s.secretName);
    return names.length > 0 ? [{ teams: [(req as ListSecretsRequest).team], target: named("secrets", names) }] : [];
  },
  "vennir.console.v1.SecretService/ListSecretStores": () => (req, res) => {
    const names = (res as ListSecretStoresResponse).stores.map((s) => s.name);
    return names.length > 0 ? [{ teams: [(req as ListSecretStoresRequest).team], target: named("stores", names) }] : [];
  },
  // Reading who read: every time (never deduped), with what was asked for.
  "vennir.console.v1.AdminService/ListAuditReads": () => (req, res) => {
    const { before, actorId, team, executionId, limit } = req as { before: bigint; actorId: string; team: string; executionId: string; limit: number };
    const filter = Object.fromEntries(
      Object.entries({ before: before ? Number(before) : undefined, actorId, team, executionId, limit: limit || undefined }).filter(([, v]) => v),
    );
    return [{ teams: team ? [team] : [], target: { ...filter, rows: (res as { reads: unknown[] }).reads.length } }];
  },
};

/** When each recent read was last recorded, by what it read (DEDUPE_MS). */
const recent = new Map<string, number>();

/** Reads every one of which gets a row: reading who read. */
const NEVER_DEDUPED = new Set(["vennir.console.v1.AdminService/ListAuditReads"]);

/** The same read again: who, from where, how, what, and the content shown; hashed, so the cache holds no names. */
function readKey(request: ReadRequest, read: Read): string {
  return sha256([request.actorId, request.clientIp, request.route, read.executionIds ?? null, read.teams ?? null, read.target, read.content ?? null]);
}

/** Whether this read was recorded within DEDUPE_MS; remembers it if not. */
function recordedLately(key: string, now: number): boolean {
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_MS) return true;
  if (recent.size >= MAX_REMEMBERED) {
    for (const [k, at] of recent) if (now - at >= DEDUPE_MS) recent.delete(k);
    // Still full of current reads: start again, recording some twice rather than none.
    if (recent.size >= MAX_REMEMBERED) recent.clear();
  }
  recent.set(key, now);
  return false;
}

/** Forgets what was recorded lately: for tests. */
export function forgetRecentReads(): void {
  recent.clear();
}

/** Rows being written, so tests can wait for them. */
const pending = new Set<Promise<void>>();

/** Waits for every read recorded so far to be written (or to have failed). */
export async function readsWritten(): Promise<void> {
  await Promise.all([...pending]);
}

type Entry = Read & ReadRequest;

/** What a read didn't say itself: the steps' teams of one run, or the runs and teams of resources. */
async function filledIn(entries: Entry[]): Promise<void> {
  const runs = distinct(entries.filter((e) => e.teams === undefined).flatMap((e) => e.executionIds ?? []));
  const payloads = new Map<string, unknown>();
  if (runs.length > 0) {
    const rows = await db
      .select({ executionId: submittedExecutions.executionId, payload: submittedExecutions.payload })
      .from(submittedExecutions)
      .where(inArray(submittedExecutions.executionId, runs));
    for (const row of rows) payloads.set(row.executionId, row.payload);
  }
  const resourceIds = distinct(
    entries.filter((e) => e.executionIds === undefined && Array.isArray(e.target["resources"])).flatMap((e) => (e.target["resources"] as string[]).filter(isUuid)),
  );
  const made = new Map<string, { executionId: string; teams: string[] }>();
  if (resourceIds.length > 0) {
    const rows = await db
      .select({ id: resources.id, executionId: resources.executionId, productTeam: resources.productTeam, ownerTeam: resources.ownerTeam })
      .from(resources)
      .where(inArray(resources.id, resourceIds));
    for (const r of rows) made.set(r.id, { executionId: r.executionId, teams: [r.productTeam, r.ownerTeam ?? ""] });
  }
  for (const entry of entries) {
    if (entry.executionIds === undefined) {
      const found = (Array.isArray(entry.target["resources"]) ? (entry.target["resources"] as string[]) : []).flatMap((id) => made.get(id) ?? []);
      entry.executionIds = distinct(found.map((f) => f.executionId).filter(isUuid));
      entry.teams = distinct([...(entry.teams ?? []), ...found.flatMap((f) => f.teams)]);
    }
    if (entry.teams === undefined) {
      const tasks = Array.isArray(entry.target["tasks"]) ? (entry.target["tasks"] as string[]) : [];
      const teams = (entry.executionIds ?? []).flatMap((run) => {
        const teamOf = taskTeams(payloads.get(run));
        return tasks.map((t) => teamOf.get(t) ?? "");
      });
      entry.teams = distinct(teams);
    }
  }
}

/** The insert, apart so a test can make it fail. */
export const writer = {
  async insert(entries: Entry[]): Promise<void> {
    await db.insert(auditReads).values(
      entries.map((e) => ({
        actorId: e.actorId,
        route: e.route,
        executionIds: (e.executionIds ?? []).filter(isUuid),
        teams: e.teams ?? [],
        target: e.target,
        clientIp: e.clientIp || null,
        requestId: e.requestId || null,
      })),
    );
  },
};

/**
 * Records what one call returned, without waiting for it to be written:
 * logged now, a row soon after (unless the same reader was shown the same
 * thing within DEDUPE_MS); a row that can't be written is logged at error, with what it
 * would have said.
 */
export function recordReads(log: FastifyBaseLogger, request: ReadRequest, reads: Read[]): void {
  const now = Date.now();
  const given = reads.map(({ content, ...read }) => ({ entry: { ...request, ...read }, key: readKey(request, { ...read, content }) }));
  // Every read is logged; only its row waits out a repeat.
  for (const { entry } of given) log.info({ event: "audit_read", ...entry }, `read ${entry.route}`);
  const fresh = NEVER_DEDUPED.has(request.route) ? given : given.filter(({ key }) => !recordedLately(key, now));
  if (fresh.length === 0) return;
  const entries: Entry[] = fresh.map(({ entry }) => entry);
  const write = (async () => {
    await filledIn(entries);
    await writer.insert(entries);
  })()
    .catch((error: unknown) => {
      // Not written: the next such read is recorded, not skipped as a repeat.
      for (const { key } of fresh) recent.delete(key);
      log.error({ err: error, event: "audit_read_write_failed", reads: entries }, "couldn't record who read what");
    })
    .finally(() => pending.delete(write));
  pending.add(write);
}
