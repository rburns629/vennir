// SPDX-License-Identifier: MIT
/**
 * The client for kernel-api: KernelService (proto/vertra/kernel/v1) over
 * Connect. Every call here is made only after core/executions.ts has
 * checked the caller may touch the execution or team in question:
 * kernel-api has no users or teams and never will (docs/architecture.md),
 * so this console is the only place that authorization can happen.
 *
 * This module is the boundary between the two: it turns the DAG JSON the
 * console authorized into a request, field by field under the names it
 * authorized them by, and kernel-api's answers back into plain JSON for
 * the console's own API. A refusal is a KernelApiError with the HTTP status
 * the kernel's REST API used to answer (404, 409, 422; 401 or 403 for the
 * console's own credentials), for each transport to relay.
 */
import { readFile } from "node:fs/promises";

import { create, type JsonObject } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { config } from "../config.js";
import {
  ExecutionState,
  KernelService,
  ConcurrencyKeySchema,
  ProductCapSchema,
  ResourcesSchema,
  SubmitExecutionRequestSchema,
  TaskSchema,
  TaskState,
  ValidationIssuesSchema,
  type Task,
} from "../gen/vertra/kernel/v1/kernel_pb.js";

export class KernelApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`kernel-api responded ${String(status)}`);
    this.status = status;
    this.body = body;
  }
}

/** The console's projected ServiceAccount token, re-read on every call:
 * the kubelet replaces the file before the token expires. None configured:
 * kernel-api's check is disabled (development only). */
const authenticate: Interceptor = (next) => async (req) => {
  if (config.kernelApiTokenFile) {
    const token = (await readFile(config.kernelApiTokenFile, "utf8")).trim();
    req.header.set("Authorization", `Bearer ${token}`);
  }
  return next(req);
};

let kernel: ReturnType<typeof createClient<typeof KernelService>> | undefined;
let kernelUrl: string | undefined;

function client() {
  // Rebuilt if the URL changes (tests point it at their own server).
  if (!kernel || kernelUrl !== config.kernelApiUrl) {
    kernelUrl = config.kernelApiUrl;
    kernel = createClient(
      KernelService,
      createConnectTransport({ baseUrl: kernelUrl, httpVersion: "1.1", interceptors: [authenticate] }),
    );
  }
  return kernel;
}

const STATUS: Partial<Record<Code, number>> = {
  [Code.NotFound]: 404,
  [Code.FailedPrecondition]: 409,
  [Code.InvalidArgument]: 422,
  [Code.Unauthenticated]: 401,
  [Code.PermissionDenied]: 403,
};

/** kernel-api's refusals as KernelApiError; anything else (it's down, a
 * bug) propagates as it is, to be masked. */
async function call<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const connectError = ConnectError.from(error);
    const status = STATUS[connectError.code];
    if (status === undefined) throw error;
    const issues = connectError.findDetails(ValidationIssuesSchema).flatMap((details) => details.issues);
    const detail =
      issues.length > 0
        ? issues.map((issue) => ({ code: issue.code, message: issue.message, taskId: issue.taskId || null }))
        : connectError.rawMessage;
    throw new KernelApiError(status, { detail });
  }
}

/** What a DAG's JSON may say: anything else is refused, so the JSON can't
 * say one thing to the console's checks (which read these names) and
 * another to the kernel. */
const SUBMISSION_FIELDS = new Set(["name", "requestId", "tasks"]);
const TASK_FIELDS = new Set([
  "id",
  "image",
  "action",
  "team",
  "serviceAccount",
  "dependsOn",
  "secretRefs",
  "tokenAudiences",
  "inputSchema",
  "outputSchema",
  "concurrencyKey",
  "productCap",
  "capacity",
  "approvalRequired",
  "forTeam",
  "inputs",
  "timeoutSeconds",
  "maxAttempts",
  "resources",
]);
const RESOURCE_FIELDS = new Set(["cpu", "memory", "memoryLimit"]);

function refuse(message: string): never {
  throw new KernelApiError(422, { detail: message });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(value: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) refuse(`${where}: unknown field "${key}"`);
  }
}

function text(value: unknown, where: string, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") refuse(`${where} must be a string`);
  return value;
}

function texts(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) refuse(`${where} must be a list of strings`);
  return value as string[];
}

function whole(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) refuse(`${where} must be a whole number`);
  return value;
}

function task(value: unknown, index: number): Task {
  const where = `tasks[${String(index)}]`;
  if (!isObject(value)) refuse(`${where} must be an object`);
  only(value, TASK_FIELDS, where);
  const inputs = value.inputs ?? {};
  if (!isObject(inputs)) refuse(`${where}.inputs must be an object`);
  let resources: Task["resources"];
  if (value.resources !== undefined && value.resources !== null) {
    if (!isObject(value.resources)) refuse(`${where}.resources must be an object`);
    only(value.resources, RESOURCE_FIELDS, `${where}.resources`);
    resources = create(ResourcesSchema, {
      cpu: text(value.resources.cpu, `${where}.resources.cpu`),
      memory: text(value.resources.memory, `${where}.resources.memory`),
      memoryLimit: text(value.resources.memoryLimit, `${where}.resources.memoryLimit`),
    });
  }
  return create(TaskSchema, {
    id: text(value.id, `${where}.id`),
    image: text(value.image, `${where}.image`),
    action: text(value.action, `${where}.action`),
    team: text(value.team, `${where}.team`),
    serviceAccount: text(value.serviceAccount, `${where}.serviceAccount`),
    dependsOn: texts(value.dependsOn, `${where}.dependsOn`),
    secretRefs: texts(value.secretRefs, `${where}.secretRefs`),
    tokenAudiences: texts(value.tokenAudiences, `${where}.tokenAudiences`),
    inputSchema: isObject(value.inputSchema) ? (value.inputSchema as JsonObject) : undefined,
    outputSchema: isObject(value.outputSchema) ? (value.outputSchema as JsonObject) : undefined,
    concurrencyKey: isObject(value.concurrencyKey)
      ? create(ConcurrencyKeySchema, {
          scope: text(value.concurrencyKey.scope, `${where}.concurrencyKey.scope`),
          inputs: texts(value.concurrencyKey.inputs, `${where}.concurrencyKey.inputs`),
        })
      : undefined,
    productCap: isObject(value.productCap)
      ? create(ProductCapSchema, {
          scope: text(value.productCap.scope, `${where}.productCap.scope`),
          maxRunning: whole(value.productCap.maxRunning, `${where}.productCap.maxRunning`) ?? 0,
        })
      : undefined,
    capacity: typeof value.capacity === "string" ? value.capacity : "",
    approvalRequired: value.approvalRequired === true,
    forTeam: text(value.forTeam, `${where}.forTeam`),
    inputs: inputs as JsonObject,
    timeoutSeconds: whole(value.timeoutSeconds, `${where}.timeoutSeconds`),
    maxAttempts: whole(value.maxAttempts, `${where}.maxAttempts`),
    resources,
  });
}

/** A DAG's JSON as the request. */
export function submissionRequest(payload: unknown) {
  if (!isObject(payload)) refuse("The submission must be an object.");
  only(payload, SUBMISSION_FIELDS, "submission");
  if (payload.tasks !== undefined && !Array.isArray(payload.tasks)) refuse("tasks must be a list");
  return create(SubmitExecutionRequestSchema, {
    name: text(payload.name, "name"),
    requestId: text(payload.requestId, "requestId"),
    tasks: ((payload.tasks as unknown[] | undefined) ?? []).map(task),
  });
}

const iso = (timestamp: Timestamp | undefined) => (timestamp ? timestampDate(timestamp).toISOString() : null);
const executionState = (state: ExecutionState) => ExecutionState[state];

export interface ExecutionSubmissionResponse {
  executionId: string;
  state: string;
}

export interface SubmittedExecutionResult extends ExecutionSubmissionResponse {
  /** False when the requestId was used before: kernel-api returned that
   * execution instead of starting a new one. */
  created: boolean;
}

/** requestedBy: who asked, as "user:<id>"; the kernel records it on each
 * task's first attempt and hands it back, never resolving it. */
export async function submitExecution(payload: unknown, requestedBy = ""): Promise<SubmittedExecutionResult> {
  const request = submissionRequest(payload);
  request.requestedBy = requestedBy;
  const response = await call(() => client().submitExecution(request));
  return { executionId: response.executionId, state: executionState(response.state), created: response.created };
}

export interface KernelAttempt {
  number: number;
  startedAt: string | null;
  completedAt: string | null;
  failure: JsonObject | null;
  /** "user:<id>" as the console sent it; "" for an automatic retry. */
  requestedBy: string;
  trigger: string;
  actedAs: string;
  image: string;
}

export interface KernelTaskStatus {
  taskId: string;
  state: string;
  attemptCount: number;
  outputs: JsonObject | null;
  failure: JsonObject | null;
  dependsOn: string[];
  startedAt: string | null;
  completedAt: string | null;
  attempts: KernelAttempt[];
  approvalRequired: boolean;
  /** "user:<id>" as the console sent it, once approved; else "". */
  approvedBy: string;
  approvedAt: string | null;
  /** While AWAITING_APPROVAL: since when. */
  awaitingSince: string | null;
  /** While READY but held by another step with its concurrency key: the key's inputs and values. */
  waitingFor: JsonObject | null;
  /** While READY but held because its product already has its most steps running. */
  waitingForCap: boolean;
}

export interface KernelExecution {
  executionId: string;
  name: string;
  state: string;
  tasks: KernelTaskStatus[];
}

export async function getExecution(executionId: string): Promise<KernelExecution> {
  const { execution } = await call(() => client().getExecution({ executionId }));
  if (!execution) throw new KernelApiError(404, { detail: "Execution not found." });
  return {
    executionId: execution.executionId,
    name: execution.name,
    state: executionState(execution.state),
    tasks: execution.tasks.map((task) => ({
      taskId: task.taskId,
      state: TaskState[task.state],
      attemptCount: task.attemptCount,
      outputs: task.outputs ?? null,
      failure: task.failure ?? null,
      dependsOn: task.dependsOn,
      startedAt: iso(task.startedAt),
      completedAt: iso(task.completedAt),
      attempts: task.attempts.map((a) => ({
        number: a.number,
        startedAt: iso(a.startedAt),
        completedAt: iso(a.completedAt),
        failure: a.failure ?? null,
        requestedBy: a.requestedBy,
        trigger: a.trigger,
        actedAs: a.actedAs,
        image: a.image,
      })),
      approvalRequired: task.approvalRequired,
      approvedBy: task.approvedBy,
      approvedAt: iso(task.approvedAt),
      awaitingSince: iso(task.awaitingSince),
      waitingFor: task.waitingFor ?? null,
      waitingForCap: task.waitingForCap,
    })),
  };
}

export interface ExecutionStateEntry {
  executionId: string;
  state: string;
  /** How many of its steps are in each state (PENDING, RUNNING, SUCCEEDED, ...). */
  steps: Record<string, number>;
  createdAt: string | null;
  /** Its last change: when it finished, once it has. */
  updatedAt: string | null;
  /** The steps claimed or running now, by step id: only when asked for
   * (`running: true`), and never once the execution has finished. */
  running: { taskId: string; action: string; attempt: number; maxAttempts: number }[];
}

/** Per call to kernel-api, which takes at most 1000. */
const STATES_BATCH = 500;

/** Many executions' states for a list view, in batches; nothing to ask
 * for an empty list. `running` also asks which steps run now, which costs
 * kernel-api a query per execution: only for a list that shows it. */
export async function getExecutionStates(executionIds: string[], { running = false } = {}): Promise<ExecutionStateEntry[]> {
  const states: ExecutionStateEntry[] = [];
  for (let i = 0; i < executionIds.length; i += STATES_BATCH) {
    const page = await call(() =>
      client().getExecutionStates({ executionIds: executionIds.slice(i, i + STATES_BATCH), includeRunning: running }),
    );
    states.push(
      ...page.states.map((entry) => ({
        executionId: entry.executionId,
        state: executionState(entry.state),
        steps: { ...entry.steps },
        createdAt: iso(entry.createdAt),
        updatedAt: iso(entry.updatedAt),
        running: entry.running.map((r) => ({ taskId: r.taskId, action: r.action, attempt: r.attempt, maxAttempts: r.maxAttempts })),
      })),
    );
  }
  return states;
}

export interface KernelEvent {
  id: number;
  eventType: string;
  taskId: string | null;
  payload: JsonObject;
  createdAt: string | null;
}

/** A page of an execution's events; nextCursor (an event id, for after)
 * when there may be more. */
export async function getExecutionEvents(
  executionId: string,
  after?: number,
): Promise<{ events: KernelEvent[]; nextCursor: number | null }> {
  const page = await call(() =>
    client().listExecutionEvents({ executionId, after: after === undefined ? undefined : BigInt(after) }),
  );
  return {
    events: page.events.map((event) => ({
      id: Number(event.id),
      eventType: event.eventType,
      taskId: event.taskId || null,
      payload: event.payload ?? {},
      createdAt: iso(event.createdAt),
    })),
    nextCursor: page.nextCursor === undefined ? null : Number(page.nextCursor),
  };
}

/** Every task's captured container output for this execution, in one call. */
export async function getExecutionLogs(executionId: string): Promise<{ tasks: { taskId: string; lines: string[] }[] }> {
  const logs = await call(() => client().getExecutionLogs({ executionId }));
  return { tasks: logs.tasks.map((task) => ({ taskId: task.taskId, lines: task.lines })) };
}

export async function cancelExecution(executionId: string): Promise<ExecutionSubmissionResponse> {
  const response = await call(() => client().cancelExecution({ executionId }));
  return { executionId: response.executionId, state: executionState(response.state) };
}

export async function retryTask(executionId: string, taskId: string, requestedBy = ""): Promise<ExecutionSubmissionResponse> {
  const response = await call(() => client().retryTask({ executionId, taskId, requestedBy }));
  return { executionId: response.executionId, state: executionState(response.state) };
}

/** Approves (approve) or declines a task awaiting approval; decidedBy is "user:<id>". */
export async function decideApproval(
  executionId: string,
  taskId: string,
  approve: boolean,
  decidedBy: string,
  reason = "",
): Promise<ExecutionSubmissionResponse> {
  const response = await call(() => client().decideApproval({ executionId, taskId, approve, decidedBy, reason }));
  return { executionId: response.executionId, state: executionState(response.state) };
}

export interface KernelAwaitingApproval {
  executionId: string;
  executionName: string;
  taskId: string;
  team: string;
  image: string;
  action: string;
  /** The execution's requestedBy: "user:<id>". */
  requestedBy: string;
  awaitingSince: string | null;
}

/** Every task awaiting approval in these teams, the longest waiting first. */
export async function listAwaitingApproval(teams: string[]): Promise<KernelAwaitingApproval[]> {
  if (teams.length === 0) return [];
  const response = await call(() => client().listAwaitingApproval({ teams }));
  return response.tasks.map((t) => ({
    executionId: t.executionId,
    executionName: t.executionName,
    taskId: t.taskId,
    team: t.team,
    image: t.image,
    action: t.action,
    requestedBy: t.requestedBy,
    awaitingSince: iso(t.awaitingSince),
  }));
}

export interface KernelRefusal {
  executionId: string;
  taskId: string;
  team: string;
  image: string;
  code: string;
  message: string;
  at: string | null;
}

/** Attempts the cluster refused to start since `since`, newest first. */
export async function listRefusals(since: Date): Promise<KernelRefusal[]> {
  const response = await call(() => client().listRefusals({ since: timestampFromDate(since) }));
  return response.refusals.map((r) => ({
    executionId: r.executionId,
    taskId: r.taskId,
    team: r.team,
    image: r.image,
    code: r.code,
    message: r.message,
    at: iso(r.at),
  }));
}

/** What the steps did (kernel-api's GetStats). */
export async function getStats() {
  const s = await call(() => client().getStats({}));
  return {
    hours: s.hours.map((h) => ({ hour: iso(h.hour), started: h.started, waitP95Seconds: h.waitP95Seconds })),
    failures: s.failures.map((f) => ({ code: f.code, count: f.count, retried: f.retried })),
    steps: s.steps.map((x) => ({
      repository: x.repository,
      action: x.action,
      team: x.team,
      attempts: x.attempts,
      succeeded: x.succeeded,
      p50Seconds: x.p50Seconds,
      p95Seconds: x.p95Seconds,
    })),
    ready: s.ready,
    running: s.running,
  };
}
