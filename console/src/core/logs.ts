// SPDX-License-Identifier: MIT
/**
 * Observe's log search (ObserveService.SearchLogs) over the chart's Loki
 * (files/alloy.alloy collects it). Loki has no users, so every query the
 * console sends carries the caller's visibility:
 *
 * - a step's lines, every level, to its own team (its namespace);
 * - its INFO lines to the run's other owners (its submitter, the team a
 *   template run was for; core/runView.ts), never to another team's member
 *   (a raw DAG's other teams included);
 * - an API backend's lines (a Pod a team labels vennir/api-backend), every
 *   level, to its own team only: they belong to no run. A team's backends
 *   run in its API backends' namespace, `<team>-apis` (k8s.ts apiNamespace);
 * - the platform's own logs to admins only.
 *
 * Nothing the caller typed reaches a query unchecked: teams and levels are
 * validated names, run ids UUIDs, and the text is quoted and escaped as a
 * regular expression inside a LogQL string.
 */
import { Code } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { and, desc, eq, gte, inArray, isNotNull, or } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import { canActForTeam } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { submittedExecutions, teams } from "../db/schema.js";
import { apiNamespace } from "../k8s.js";
import { runView } from "./runView.js";

const LEVELS = ["debug", "info", "warn", "error"] as const;
const HOUR_MS = 3_600_000;
/** The most runs one search names; enough for anyone's recent runs. */
const MAX_RUNS = 300;

export const SearchLogsQuery = Type.Object({
  text: Type.Optional(Type.String({ maxLength: 200 })),
  team: Type.Optional(Type.String({ pattern: "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" })),
  executionId: Type.Optional(Type.String({ format: "uuid" })),
  level: Type.Optional(Type.Union(LEVELS.map((l) => Type.Literal(l)))),
  source: Type.Optional(Type.Union([Type.Literal("step"), Type.Literal("api"), Type.Literal("platform")])),
  api: Type.Optional(Type.String({ pattern: "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});

export interface SearchLogsInput {
  text?: string | undefined;
  team?: string | undefined;
  executionId?: string | undefined;
  level?: (typeof LEVELS)[number] | undefined;
  source?: "step" | "api" | "platform" | undefined;
  /** With source api: one API product's backend (its Pods' vennir/api label). */
  api?: string | undefined;
  since?: Date | undefined;
  until?: Date | undefined;
  limit?: number | undefined;
}

export interface LogLine {
  at: Date;
  team: string;
  executionId: string;
  task: string;
  attempt: number;
  level: string;
  app: string;
  line: string;
}

/** A LogQL string: JSON's escaping is Go's, which LogQL reads. */
const quoted = (value: string) => JSON.stringify(value);
const regexEscaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `^(a|b)$` over validated names or UUIDs. */
const oneOf = (values: string[]) => quoted(`^(${values.join("|")})$`);

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

/**
 * The runs a caller owns (sees every step of, core/runView.ts) that started
 * since `since`, newest first: submitted, or a template run for one of
 * their teams. A raw DAG of their teams isn't theirs unless they submitted it.
 */
async function ownedRuns(who: AuthUser, since: Date): Promise<string[]> {
  const rows = await db
    .select({ executionId: submittedExecutions.executionId })
    .from(submittedExecutions)
    .where(
      and(
        gte(submittedExecutions.createdAt, new Date(since.getTime() - 24 * HOUR_MS)),
        or(
          eq(submittedExecutions.submittedBy, who.id),
          and(isNotNull(submittedExecutions.template), inArray(submittedExecutions.onBehalfOf, who.teamNames.length > 0 ? who.teamNames : [""])),
        ),
      ),
    )
    .orderBy(desc(submittedExecutions.createdAt))
    .limit(MAX_RUNS);
  return rows.map((r) => r.executionId);
}

/** How much of this run `who` sees: none (not theirs at all), their own steps, or every step. */
async function runAccess(who: AuthUser, executionId: string): Promise<"none" | "own" | "full"> {
  if (who.isAdmin) return "full";
  const [run] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, executionId));
  if (!run || !(run.submittedBy === who.id || run.teams.some((team) => canActForTeam(who, team)))) return "none";
  return runView(who, run).full ? "full" : "own";
}

/** Every team's name, purged ones too (their names stay reserved). */
async function allTeamNames(): Promise<Set<string>> {
  return new Set((await db.select({ name: teams.name }).from(teams)).map((r) => r.name));
}

/**
 * The namespaces these teams' API backends log from: each one's
 * `<team>-apis`, unless that's a team's name (one named before such names
 * were refused): then it's that team's, and this one has none.
 */
function backendNamespaces(own: string[], names: Set<string>): string[] {
  return own.map(apiNamespace).filter((ns) => !names.has(ns));
}

/** The team an API backend's namespace is: itself when a team has its name, else `<team>` of `<team>-apis`. */
export function teamOfBackendNamespace(namespace: string, names: Set<string>): string {
  if (names.has(namespace) || !namespace.endsWith("-apis")) return namespace;
  return namespace.slice(0, -"-apis".length);
}

/** The LogQL queries that together are what `who` may see of this search. */
export async function visibleQueries(who: AuthUser, input: SearchLogsInput, since: Date, names?: Set<string>): Promise<string[]> {
  const filters: string[] = [];
  if (input.executionId) filters.push(`| execution_id=${quoted(input.executionId)}`);
  if (input.text) filters.push(`|~ ${quoted(`(?i)${regexEscaped(input.text)}`)}`);
  const pipeline = filters.length > 0 ? ` ${filters.join(" ")}` : "";
  const level = input.level ? `, level=${quoted(input.level)}` : "";

  if (input.source === "platform") {
    if (!who.isAdmin) throw new ApiError(403, "FORBIDDEN", "The platform's own logs are for admins.", Code.PermissionDenied);
    return [`{component="platform"${level}}${pipeline}`];
  }
  if (input.source === "api") {
    if (input.executionId) {
      throw new ApiError(400, "BAD_REQUEST", "An API backend's lines belong to no run: leave the run out.", Code.InvalidArgument);
    }
    names ??= await allTeamNames();
    const api = input.api ? `, api=${quoted(input.api)}` : "";
    if (who.isAdmin && !input.team) return [`{component="api"${api}${level}}${pipeline}`];
    const namespaces = backendNamespaces(who.isAdmin ? [input.team ?? ""] : who.teamNames.filter((t) => !input.team || t === input.team), names);
    return namespaces.length > 0 ? [`{component="api", namespace=~${oneOf(namespaces)}${api}${level}}${pipeline}`] : [];
  }
  const access = input.executionId ? await runAccess(who, input.executionId) : "full";
  if (access === "none") {
    throw new ApiError(404, "NOT_FOUND", "No such run, or you can't see it.", Code.NotFound);
  }
  const team = input.team ? `, namespace=${quoted(input.team)}` : "";
  if (who.isAdmin) return [`{component="step"${team}${level}}${pipeline}`];

  const queries: string[] = [];
  // Every level of the caller's own teams' steps.
  const own = who.teamNames.filter((t) => !input.team || t === input.team);
  if (own.length > 0) queries.push(`{component="step", namespace=~${oneOf(own)}${level}}${pipeline}`);
  // INFO lines of other teams' steps, in runs the caller owns.
  if ((!input.level || input.level === "info") && access === "full") {
    const runs = input.executionId ? [input.executionId] : await ownedRuns(who, since);
    const elsewhere = who.teamNames.length > 0 ? `, namespace!~${oneOf(who.teamNames)}` : "";
    if (runs.length > 0 && !(input.team && who.teamNames.includes(input.team))) {
      queries.push(`{component="step", level="info"${team}${elsewhere}} | execution_id=~${oneOf(runs)}${pipeline}`);
    }
  }
  return queries;
}

type LokiStreams = { data: { result: { stream: Record<string, string>; values: [string, string][] }[] } };

async function queryLoki(query: string, since: Date, until: Date, limit: number): Promise<LokiStreams> {
  const url = new URL("/loki/api/v1/query_range", config.logs.lokiUrl);
  url.search = new URLSearchParams({
    query,
    start: `${String(since.getTime())}000000`,
    end: `${String(until.getTime())}000000`,
    limit: String(limit),
    direction: "backward",
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new ApiError(503, "LOGS_UNAVAILABLE", "Log search isn't answering right now; try again shortly.", Code.Unavailable);
  }
  if (!response.ok) throw new Error(`Loki answered ${String(response.status)}: ${(await response.text()).slice(0, 500)}`);
  return (await response.json()) as LokiStreams;
}

export async function searchLogs(caller: AuthUser | undefined, input: SearchLogsInput) {
  const who = signedIn(caller);
  if (!config.logs.lokiUrl) {
    throw new ApiError(412, "LOGS_OFF", "This install doesn't keep logs (the console chart's logs.enabled).", Code.FailedPrecondition);
  }
  const now = Date.now();
  const earliest = new Date(now - config.logs.searchDays * 24 * HOUR_MS);
  const until = input.until && input.until.getTime() < now ? input.until : new Date(now);
  let since = input.since ?? new Date(until.getTime() - HOUR_MS);
  if (since < earliest) since = earliest;
  if (since >= until) throw new ApiError(400, "BAD_REQUEST", "since must be before until.", Code.InvalidArgument);
  const limit = input.limit ?? 200;

  const lines: LogLine[] = [];
  let truncated = false;
  const names = input.source === "api" ? await allTeamNames() : new Set<string>();
  for (const query of await visibleQueries(who, input, since, names)) {
    const { data } = await queryLoki(query, since, until, limit);
    let count = 0;
    for (const { stream, values } of data.result) {
      for (const [ns, line] of values) {
        count++;
        lines.push({
          at: new Date(Number(BigInt(ns) / 1_000_000n)),
          team:
            stream["component"] === "platform"
              ? ""
              : stream["component"] === "api"
                ? teamOfBackendNamespace(stream["namespace"] ?? "", names)
                : (stream["namespace"] ?? ""),
          executionId: stream["execution_id"] ?? "",
          task: stream["task"] ?? "",
          attempt: Number(stream["attempt"] ?? 0),
          level: stream["level"] ?? "debug",
          app: stream["app"] ?? "",
          line,
        });
      }
    }
    if (count >= limit) truncated = true;
  }
  lines.sort((a, b) => b.at.getTime() - a.at.getTime());
  if (lines.length > limit) truncated = true;
  return { lines: lines.slice(0, limit), truncated, searchDays: config.logs.searchDays };
}
