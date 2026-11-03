// SPDX-License-Identifier: MIT
/** ExecutionService (proto/vertra/console/v1/execution.proto): core/executions.ts over Connect. */
import { Code, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { fromJson, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import { Type } from "@sinclair/typebox";
import {
  cancel,
  ExecutionId,
  executionDetail,
  executionEvents,
  executionLogs,
  listExecutions,
  ListQuery,
  rerun,
  retry,
  submit,
} from "../../core/executions.js";
import { decide, pendingApprovals, previewStep } from "../../core/approvals.js";
import {
  DagSchema,
  ExecutionState,
  TaskState,
  type Dag,
  type ExecutionService,
} from "../../gen/vertra/console/v1/execution_pb.js";
import { KernelApiError } from "../../kernel/client.js";
import { timestamp, unsetIfEmpty } from "../convert.js";
import { callerOf, currentCallerOf, logOf } from "../context.js";
import { rpcError } from "../errors.js";
import { check } from "../validate.js";

/**
 * How often a watch re-reads its execution (each read resolves the
 * caller's credential again, so a sign-out, a password reset or leaving
 * the team ends it); how often it sends the execution unchanged, so a load
 * balancer's idle timeout doesn't cut a quiet stream; and how long one
 * lasts before the client reconnects.
 */
const WATCH_INTERVAL_MS = 2000;
const WATCH_HEARTBEAT_MS = 15_000;
const WATCH_MAX_MS = 10 * 60 * 1000;
const FINISHED = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

const EXECUTION_STATE: Record<string, ExecutionState> = {
  PENDING: ExecutionState.PENDING,
  RUNNING: ExecutionState.RUNNING,
  SUCCEEDED: ExecutionState.SUCCEEDED,
  FAILED: ExecutionState.FAILED,
  CANCELLED: ExecutionState.CANCELLED,
};
const TASK_STATE: Record<string, TaskState> = {
  BLOCKED: TaskState.BLOCKED,
  READY: TaskState.READY,
  CLAIMED: TaskState.CLAIMED,
  RUNNING: TaskState.RUNNING,
  SUCCEEDED: TaskState.SUCCEEDED,
  FAILED: TaskState.FAILED,
  CANCELLED: TaskState.CANCELLED,
  AWAITING_APPROVAL: TaskState.AWAITING_APPROVAL,
};
export const executionState = (state: unknown) =>
  (typeof state === "string" ? EXECUTION_STATE[state] : undefined) ?? ExecutionState.UNSPECIFIED;

/**
 * kernel-api's refusals as Connect errors. A 401 or 403 is about the
 * console's own credentials, not the caller's: unavailable, never
 * unauthenticated (a client would take that for an expired session).
 */
export async function viaKernel<T>(ctx: HandlerContext, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof KernelApiError)) throw error;
    if (error.status === 401 || error.status === 403) {
      logOf(ctx).error(
        { kernelStatus: error.status, kernelBody: error.body },
        "kernel-api refused the console's credentials; check kernelApiToken and api.auth",
      );
      throw rpcError(
        Code.Unavailable,
        "BAD_GATEWAY",
        "The console couldn't authenticate to the execution kernel. An administrator needs to check its configuration.",
      );
    }
    const detail = (error.body as { detail?: unknown } | null)?.detail;
    const message = typeof detail === "string" ? detail : JSON.stringify(detail ?? error.body);
    const code =
      error.status === 404 ? Code.NotFound : error.status === 409 ? Code.FailedPrecondition : Code.InvalidArgument;
    throw rpcError(code, `KERNEL_${String(error.status)}`, message);
  }
}

/** A DAG message as the JSON a REST client submits: only what it set. */
function submission(dag: Dag | undefined): Record<string, unknown> | undefined {
  if (!dag) return undefined;
  return {
    name: dag.name,
    ...(dag.requestId ? { requestId: dag.requestId } : {}),
    tasks: dag.tasks.map((task) => ({
      id: task.id,
      image: task.image,
      action: task.action,
      team: task.team,
      ...(task.serviceAccount === undefined ? {} : { serviceAccount: task.serviceAccount }),
      dependsOn: task.dependsOn,
      secretRefs: task.secretRefs,
      inputs: task.inputs ?? {},
      ...(task.timeoutSeconds === undefined ? {} : { timeoutSeconds: task.timeoutSeconds }),
      ...(task.maxAttempts === undefined ? {} : { maxAttempts: task.maxAttempts }),
      ...(task.resources
        ? {
            resources: Object.fromEntries(
              Object.entries({
                cpu: task.resources.cpu,
                memory: task.resources.memory,
                memoryLimit: task.resources.memoryLimit,
              }).filter(([, v]) => v !== undefined),
            ),
          }
        : {}),
    })),
  };
}

/** The stored DAG as a message; unset if it can't be read as one. */
function storedDag(payload: unknown): Dag | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  try {
    return fromJson(DagSchema, JSON.parse(JSON.stringify(payload)) as JsonValue, { ignoreUnknownFields: true });
  } catch {
    return undefined;
  }
}

type Detail = Awaited<ReturnType<typeof executionDetail>>;

const text = (value: unknown) => (typeof value === "string" ? value : "");

function execution(detail: Detail) {
  const failure = (f: JsonObject | null) =>
    f ? { code: text(f["code"]), message: text(f["message"]), retryable: f["retryable"] === true } : undefined;
  return {
    executionId: detail.executionId,
    name: detail.name,
    state: executionState(detail.state),
    tasks: detail.tasks.map((task) => ({
      taskId: task.taskId,
      state: TASK_STATE[task.state] ?? TaskState.UNSPECIFIED,
      attemptCount: task.attemptCount,
      outputs: task.outputs ?? undefined,
      failure: failure(task.failure),
      dependsOn: task.dependsOn,
      startedAt: timestamp(task.startedAt),
      completedAt: timestamp(task.completedAt),
      attempts: task.attempts.map((a) => ({
        number: a.number,
        startedAt: timestamp(a.startedAt),
        completedAt: timestamp(a.completedAt),
        failure: failure(a.failure),
        requestedBy: a.requestedBy,
        trigger: a.trigger,
        actedAs: a.actedAs,
        image: a.image,
      })),
      help: task.help
        ? {
            means: task.help.means,
            whatToDo: task.help.do,
            fromOwner: task.help.fromOwner,
            retry: task.help.retry,
            team: task.help.team,
            contact: task.help.contact,
            chat: task.help.chat,
            url: task.help.url,
          }
        : undefined,
      approval: task.approval
        ? {
            approvedBy: task.approval.approvedBy,
            approvedAt: timestamp(task.approval.approvedAt),
            awaitingSince: timestamp(task.approval.awaitingSince),
            canDecide: task.approval.canDecide,
            canPreview: task.approval.canPreview,
          }
        : undefined,
      waitingFor: task.waitingFor ?? undefined,
      waitingForCap: task.waitingForCap,
    })),
    teams: detail.teams,
    submittedBy: detail.submittedBy ?? "",
    createdAt: timestamp(detail.createdAt),
    dag: storedDag(detail.payload),
    runBlocked: detail.runBlocked
      ? {
          code: detail.runBlocked.error,
          message: detail.runBlocked.message,
          missingImages: detail.runBlocked.missingImages ?? [],
          disallowedImages: detail.runBlocked.disallowedImages ?? [],
          allowedSources: detail.runBlocked.allowedSources ?? [],
        }
      : undefined,
    template: detail.template ?? undefined,
    templateParameters: (detail.templateParameters ?? undefined) as JsonObject | undefined,
    onBehalfOf: detail.onBehalfOf ?? undefined,
    schedule: detail.schedule ?? undefined,
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function executionService(): ServiceImpl<typeof ExecutionService> {
  return {
    async listExecutions(req, ctx) {
      const query = check(
        { query: ListQuery },
        {
          query: Object.fromEntries(
            Object.entries({
              limit: unsetIfEmpty(req.page?.limit ?? 0),
              cursor: unsetIfEmpty(req.page?.cursor ?? ""),
              since: req.since ? new Date(Number(req.since.seconds) * 1000).toISOString() : undefined,
              team: unsetIfEmpty(req.team),
              search: unsetIfEmpty(req.search),
              mine: req.mine || undefined,
            }).filter(([, v]) => v !== undefined),
          ),
        },
      ).query;
      const page = await listExecutions(callerOf(ctx), query, logOf(ctx));
      return {
        executions: page.executions.map((row) => ({
          executionId: row.executionId,
          name: row.name,
          teams: row.teams,
          submittedBy: row.submittedBy ?? undefined,
          createdAt: timestamp(row.createdAt),
          state: executionState(row.state),
          template: row.template ?? "",
          steps: row.steps,
          finishedAt: timestamp(row.finishedAt),
          submittedByEmail: row.submittedByEmail ?? undefined,
          running: row.running,
          schedule: row.scheduleName ?? undefined,
        })),
        nextCursor: page.nextCursor ?? "",
        runRetentionDays: page.runRetentionDays,
      };
    },

    async submitExecution(req, ctx) {
      const result = await viaKernel(ctx, () => submit(callerOf(ctx), submission(req.dag), logOf(ctx)));
      return {
        executionId: result.executionId,
        state: executionState(result.state),
      };
    },

    async getExecution(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      return {
        execution: execution(await viaKernel(ctx, () => executionDetail(callerOf(ctx), executionId, logOf(ctx)))),
      };
    },

    async *watchExecution(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      const until = Date.now() + WATCH_MAX_MS;
      let last = "";
      let sentAt = 0;
      while (!ctx.signal.aborted && Date.now() < until) {
        const caller = await currentCallerOf(ctx);
        const detail = await viaKernel(ctx, () => executionDetail(caller, executionId, logOf(ctx)));
        const seen = JSON.stringify(detail);
        if (seen !== last || Date.now() - sentAt >= WATCH_HEARTBEAT_MS) {
          last = seen;
          sentAt = Date.now();
          yield { execution: execution(detail) };
        }
        if (FINISHED.has(detail.state)) return;
        await wait(WATCH_INTERVAL_MS, ctx.signal);
      }
    },

    async listExecutionEvents(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      const after = unsetIfEmpty(Number(req.after));
      const page = await viaKernel(ctx, () => executionEvents(callerOf(ctx), executionId, after));
      return {
        events: page.events.map((event) => ({
          id: BigInt(event.id),
          eventType: event.eventType,
          taskId: event.taskId ?? undefined,
          payload: event.payload,
          createdAt: timestamp(event.createdAt),
        })),
        nextCursor: BigInt(page.nextCursor ?? 0),
      };
    },

    async getExecutionLogs(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      const logs = await viaKernel(ctx, () => executionLogs(callerOf(ctx), executionId));
      return { tasks: logs.tasks };
    },

    async cancelExecution(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      const result = await viaKernel(ctx, () => cancel(callerOf(ctx), executionId));
      return {
        executionId: result.executionId,
        state: executionState(result.state),
      };
    },

    async retryTask(req, ctx) {
      const { executionId, taskId } = check({ executionId: ExecutionId, taskId: Type.String({ minLength: 1 }) }, req);
      const result = await viaKernel(ctx, () => retry(callerOf(ctx), executionId, taskId, logOf(ctx)));
      return {
        executionId: result.executionId,
        state: executionState(result.state),
      };
    },

    async decideApproval(req, ctx) {
      const { executionId, taskId, approve, reason } = check(
        { executionId: ExecutionId, taskId: Type.String({ minLength: 1 }), approve: Type.Boolean(), reason: Type.String({ maxLength: 500 }) },
        req,
      );
      const result = await viaKernel(ctx, () => decide(callerOf(ctx), executionId, taskId, approve, reason));
      return { executionId: result.executionId, state: executionState(result.state) };
    },

    async previewStep(req, ctx) {
      const { executionId, taskId } = check({ executionId: ExecutionId, taskId: Type.String({ minLength: 1, maxLength: 253 }) }, req);
      return viaKernel(ctx, () => previewStep(callerOf(ctx), executionId, taskId, logOf(ctx)));
    },

    async listPendingApprovals(_req, ctx) {
      const approvals = await viaKernel(ctx, () => pendingApprovals(callerOf(ctx)));
      return {
        approvals: approvals.map((a) => ({
          executionId: a.executionId,
          executionName: a.executionName,
          taskId: a.taskId,
          team: a.team,
          image: a.image,
          action: a.action,
          requestedBy: a.requestedBy,
          awaitingSince: timestamp(a.awaitingSince),
          canDecide: a.canDecide,
        })),
      };
    },

    async rerunExecution(req, ctx) {
      const { executionId } = check({ executionId: ExecutionId }, req);
      const result = await viaKernel(ctx, () => rerun(callerOf(ctx), executionId, logOf(ctx)));
      return {
        executionId: result.executionId,
        state: executionState(result.state),
      };
    },
  };
}
