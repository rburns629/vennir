// SPDX-License-Identifier: MIT
/**
 * Approvals: a step whose product.yaml says `approval` (always, or for other
 * teams' runs), or that aims at a target its team's allowedTargets let
 * through only with one, waits in AWAITING_APPROVAL (core/executions.ts sets
 * approvalRequired; the kernel holds it). A maintainer of the step's team
 * approves or declines it, never whoever submitted the run: two people, so
 * one can't both ask and agree. Each decision is audited (audit.ts records
 * the method, the execution, the task and `approve`), and the kernel records
 * who decided in the step's events. Nobody deciding within the scheduler's
 * approval timeout fails it with APPROVAL_EXPIRED.
 */
import { Code } from "@connectrpc/connect";
import { ApiError } from "../apiError.js";
import { canMaintainTeam, loadExecution } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import type { FastifyBaseLogger } from "fastify";
import { botMakers, findRunnableProduct, findTeamByName, findUserById, listAllTeams } from "../db/queries.js";
import { decideApproval, getExecution, listAwaitingApproval } from "../kernel/client.js";
import { resolvedInputs } from "../resourceRecorder.js";
import { productLookup, productOfTask } from "./executions.js";
import { ensureNotRetired } from "./retired.js";
import { PREVIEW_RUN, runProductSteps, siblingAction } from "./templates.js";

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

/** Each task's team, from the DAG as submitted. */
export function taskTeams(payload: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const tasks = typeof payload === "object" && payload !== null && Array.isArray((payload as { tasks?: unknown }).tasks)
    ? (payload as { tasks: unknown[] }).tasks
    : [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) continue;
    const { id, team } = task as { id?: unknown; team?: unknown };
    if (typeof id === "string" && typeof team === "string") out.set(id, team);
  }
  return out;
}

/**
 * Who mayn't decide on a run `submittedBy` submitted, so that two people
 * agree before it runs: its submitter, and for a bot's run whoever made the
 * bot something to act with (a token, a keyless identity, a schedule), who
 * could have submitted through it.
 */
export async function notDeciders(submittedBy: string | null): Promise<string[]> {
  if (!submittedBy) return [];
  const submitter = await findUserById(submittedBy);
  return submitter?.isBot ? [submittedBy, ...(await botMakers(submittedBy))] : [submittedBy];
}

/** Whether the caller may decide on a step of `team` in a run whose `notDeciders` are these. */
export function mayDecide(caller: AuthUser, team: string, excluded: string[]): boolean {
  return canMaintainTeam(caller, team) && !excluded.includes(caller.id);
}

export async function decide(
  caller: AuthUser | undefined,
  executionId: string,
  taskId: string,
  approve: boolean,
  reason: string,
) {
  const who = signedIn(caller);
  const submitted = await loadExecution(executionId, who, "any");
  const team = taskTeams(submitted.payload).get(taskId);
  if (team === undefined) throw new ApiError(404, "NOT_FOUND", `No step "${taskId}" in this execution.`);
  if (!canMaintainTeam(who, team)) {
    throw new ApiError(403, "FORBIDDEN", `Only a maintainer of ${team} may approve or decline its steps.`);
  }
  if (submitted.submittedBy === who.id) {
    throw new ApiError(403, "FORBIDDEN", `You submitted this run, so another maintainer of ${team} decides.`);
  }
  if ((await notDeciders(submitted.submittedBy)).includes(who.id)) {
    throw new ApiError(403, "FORBIDDEN", `This run was submitted by a bot you gave a token, identity or schedule, so another maintainer of ${team} decides.`);
  }
  const owner = await findTeamByName(team);
  if (owner) ensureNotRetired(owner);
  const task = (await getExecution(executionId)).tasks.find((t) => t.taskId === taskId);
  if (task?.state !== "AWAITING_APPROVAL") {
    throw new ApiError(409, "NOT_AWAITING_APPROVAL", `Step "${taskId}" isn't awaiting approval.`, Code.FailedPrecondition);
  }
  return decideApproval(executionId, taskId, approve, `user:${who.id}`, approve ? "" : reason);
}

/** The steps awaiting approval in the teams the caller maintains (every team, for an admin). */
export async function pendingApprovals(caller: AuthUser | undefined) {
  const who = signedIn(caller);
  const teams = who.isAdmin ? (await listAllTeams()).map((t) => t.name) : who.maintainerOf;
  const awaiting = await listAwaitingApproval(teams);
  const emails = new Map<string, string>();
  for (const id of new Set(awaiting.map((a) => a.requestedBy).filter((r) => r.startsWith("user:")))) {
    emails.set(id, (await findUserById(id.slice("user:".length)))?.email ?? "(deleted account)");
  }
  const excluded = new Map<string, string[]>();
  for (const id of new Set(awaiting.map((a) => a.requestedBy))) {
    excluded.set(id, id.startsWith("user:") ? await notDeciders(id.slice("user:".length)) : []);
  }
  return awaiting.map((a) => ({
    ...a,
    requestedBy: emails.get(a.requestedBy) ?? "",
    canDecide: !(excluded.get(a.requestedBy) ?? []).includes(who.id),
  }));
}

/**
 * Previews a step waiting for an approval, for whoever may decide on it: a
 * run of its product's plan action (product.yaml's plan) with the inputs
 * the step will get, its upstream steps having finished.
 */
export async function previewStep(caller: AuthUser | undefined, executionId: string, taskId: string, log: FastifyBaseLogger) {
  const who = signedIn(caller);
  const submitted = await loadExecution(executionId, who, "any");
  const team = taskTeams(submitted.payload).get(taskId);
  if (!team) throw new ApiError(404, "NOT_FOUND", `No step "${taskId}" in this run.`);
  if (!mayDecide(who, team, await notDeciders(submitted.submittedBy))) {
    throw new ApiError(403, "FORBIDDEN", `Only who may approve step "${taskId}" (a maintainer of team "${team}", not whoever ran it) previews it.`);
  }
  const detail = await getExecution(executionId);
  if (detail.tasks.find((t) => t.taskId === taskId)?.state !== "AWAITING_APPROVAL") {
    throw new ApiError(409, "NOT_WAITING", `Step "${taskId}" isn't waiting for an approval.`);
  }
  const tasks = typeof submitted.payload === "object" && submitted.payload !== null && Array.isArray((submitted.payload as { tasks?: unknown }).tasks)
    ? ((submitted.payload as { tasks: unknown[] }).tasks as Record<string, unknown>[])
    : [];
  const task = tasks.find((t) => t["id"] === taskId);
  const registered = await productOfTask(productLookup(), task);
  const product = registered ? await findRunnableProduct(registered.name) : undefined;
  const plan = product?.plan ? await siblingAction(product, product.plan) : undefined;
  if (!plan) throw new ApiError(409, "NO_PREVIEW", `Step "${taskId}" has no preview: its product.yaml names no plan for it.`);
  const outputs = new Map(detail.tasks.flatMap((t) => (t.outputs ? [[t.taskId, t.outputs as Record<string, unknown>] as const] : [])));
  const inputs = resolvedInputs(task?.["inputs"], outputs);
  return runProductSteps(
    who,
    `Preview: ${detail.name} · ${taskId}`,
    [{ id: taskId, product: plan, inputs, label: `Step "${taskId}"` }],
    who.teamNames.includes(team) ? team : undefined,
    { template: PREVIEW_RUN, parameters: { of: `${executionId}/${taskId}`, parameters: inputs } },
    { chained: false, eachShared: true },
    log,
  );
}
