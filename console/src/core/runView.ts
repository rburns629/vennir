// SPDX-License-Identifier: MIT
/**
 * How much of a run a caller sees (decided 2026-10-22, narrowed for raw
 * DAGs 2026-11-05). A run's owners see every step: admins, whoever
 * submitted it, and, for a template run, the members of the team it was run
 * for (its onBehalfOf). A raw DAG is run for no one team: its owners are
 * admins and its submitter alone, so being in one of its teams shows that
 * team's steps in full, not the others'. Anyone else may see a run only
 * because their team runs one of its steps: they see the run's own status,
 * their own team's steps in full and, of the rest, only each step's
 * product, state, timing and failure code, never its inputs, outputs,
 * failure messages or logs. A
 * template's consumer still sees what a provider's step returned; a
 * provider never sees the consumer's.
 */
import type { JsonObject } from "@bufbuild/protobuf";
import type { AuthUser } from "../auth/plugin.js";
import { taskTeams } from "./approvals.js";

export interface RunView {
  /** Sees every step. */
  full: boolean;
  /** Sees this step (by its id in the DAG) in full. */
  sees(taskId: string): boolean;
}

export function runView(
  caller: AuthUser | undefined,
  run: { submittedBy: string | null; teams: string[]; template: string | null; onBehalfOf: string | null; payload: unknown },
): RunView {
  const mine = new Set(caller?.teamNames ?? []);
  const owners = runOwnerTeams(run);
  const full =
    caller?.isAdmin === true ||
    (caller !== undefined && run.submittedBy === caller.id) ||
    owners.some((team) => mine.has(team));
  const teamOf = taskTeams(run.payload);
  return { full, sees: (taskId) => full || mine.has(teamOf.get(taskId) ?? "") };
}

/** The teams whose members see every step of a run: a template run's onBehalfOf; a raw DAG's none. */
export function runOwnerTeams(run: { template: string | null; onBehalfOf: string | null }): string[] {
  return run.template !== null && run.onBehalfOf ? [run.onBehalfOf] : [];
}

/** A failure as someone outside the step's team sees it: its code only. */
export function failureCodeOnly(failure: JsonObject | null): JsonObject | null {
  if (failure === null) return null;
  return typeof failure["code"] === "string" ? { code: failure["code"] } : {};
}

/** The DAG as submitted, with the inputs of steps the caller doesn't see removed. */
export function visiblePayload(payload: unknown, view: RunView): unknown {
  if (view.full || typeof payload !== "object" || payload === null || !Array.isArray((payload as { tasks?: unknown }).tasks)) {
    return payload;
  }
  const tasks = (payload as { tasks: unknown[] }).tasks.map((task) => {
    if (typeof task !== "object" || task === null) return task;
    const id = (task as { id?: unknown }).id;
    return typeof id === "string" && view.sees(id) ? task : { ...task, inputs: {} };
  });
  return { ...payload, tasks };
}

/** An event as the caller sees it: a step they don't see keeps its kind, attempt and failure code. */
export function visibleEvent<E extends { payload: JsonObject }>(event: E, view: RunView): E {
  const taskKey = event.payload["taskKey"];
  if (view.full || typeof taskKey !== "string" || view.sees(taskKey)) return event;
  const { attempt, willRetry, error } = event.payload;
  const kept: JsonObject = { taskKey };
  if (attempt !== undefined) kept["attempt"] = attempt;
  if (willRetry !== undefined) kept["willRetry"] = willRetry;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const code = failureCodeOnly(error);
    if (code) kept["error"] = code;
  }
  return { ...event, payload: kept };
}
