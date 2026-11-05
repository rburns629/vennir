// SPDX-License-Identifier: MIT
/**
 * API products (decision 20): a backend a team runs, published through the
 * gateway, which forwards only what its OpenAPI document describes. The
 * catalog's release brings them (catalogSync.ts); the gateway reads them
 * from the database. Here: who sees and may call which, whether each is
 * live, held (its backend's host isn't one the admins allow) or paused, and
 * pausing one for an incident.
 */
import { Code } from "@connectrpc/connect";
import { ApiError } from "../apiError.js";
import { canMaintainTeam } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { catalogRepository, findApi, findUserById, listLiveTeamApis, setApiPaused, type ApiRow } from "../db/queries.js";
import { apiProblems, apiTraffic, gatewayState, teams, type BackendAuth } from "../db/schema.js";
import { apiNamespace, hasApiNamespace } from "../k8s.js";
import { catalogLinks, githubBase } from "./catalogLinks.js";

type Api = ApiRow & { teamName: string };

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a backend URL's host is one the admins allow: exactly, or below a "*." pattern. */
export function backendAllowed(url: string, hosts: string[] = config.gateway.backendHosts): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p;
  });
}

/**
 * The namespace an in-cluster backend host names (<service>.<namespace>.svc,
 * with or without .cluster.local), or null for any other host. The gateway
 * may reach every team's API backends, so an API may only use one in its
 * own team's API backends' namespace (backendPlace): another team's would
 * be served under this API's spec and sharing (the gateway's
 * store.BackendNamespace, kept in step).
 */
export function backendNamespace(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  const match = /^(?:[^.]+\.)+?([^.]+)\.svc(?:\.cluster\.local)?$/.exec(host);
  return match?.[1] ?? null;
}

/**
 * Where an API's backend runs, for the team the API is: "outside" the
 * cluster (any host backendHosts allows), in the team's API backends'
 * namespace ("apis", `<team>-apis`, k8s.ts apiNamespace), in the team's own
 * namespace ("team": accepted for one release, until backends have moved;
 * the gateway logs it), or anywhere else ("other": held). `<team>-apis` is
 * the team's only when no team has that name (`apiNamespaceTaken`: one
 * named before such names were refused). The gateway's store.BackendPlace,
 * kept in step.
 */
export function backendPlace(url: string, team: string, apiNamespaceTaken = false): "outside" | "apis" | "team" | "other" {
  const namespace = backendNamespace(url);
  if (namespace === null) return "outside";
  if (namespace === apiNamespace(team) && !apiNamespaceTaken) return "apis";
  if (namespace === team) return "team";
  return "other";
}

/** Of these teams, the ones whose `<team>-apis` is a team's name (purged ones too: names stay reserved). */
export async function apiNamespacesTaken(teamNames: string[]): Promise<Set<string>> {
  const unique = [...new Set(teamNames)];
  if (unique.length === 0) return new Set();
  const rows = await db.select({ name: teams.name }).from(teams).where(inArray(teams.name, unique.map(apiNamespace)));
  const taken = new Set(rows.map((r) => r.name));
  return new Set(unique.filter((t) => taken.has(apiNamespace(t))));
}

/**
 * These teams' API backends' namespaces, by team: none for a team whose
 * `<team>-apis` is too long for a namespace, or is another team's name (both
 * from before such names were refused), so the console never makes, labels,
 * writes into or deletes another team's namespace as this one's.
 */
export async function ownApiNamespaces(teamNames: string[]): Promise<Map<string, string>> {
  const taken = await apiNamespacesTaken(teamNames);
  return new Map(teamNames.filter((t) => hasApiNamespace(t) && !taken.has(t)).map((t) => [t, apiNamespace(t)]));
}

/** One team's API backends' namespace (ownApiNamespaces), or null. */
export async function ownApiNamespace(team: string): Promise<string | null> {
  return (await ownApiNamespaces([team])).get(team) ?? null;
}

/** Why the gateway can't serve an API, as it recorded it (api_problems). */
export interface Problem {
  problem: string;
  foundAt: Date;
}

/** Live, held, paused, or unavailable (the gateway can't use its spec), and why: in the gateway's order. */
export function apiState(
  api: Pick<Api, "backendUrl" | "pausedMessage" | "teamName">,
  problem: Problem | null = null,
  apiNamespaceTaken = false,
): { state: "live" | "held" | "paused" | "unavailable"; heldReason: string; problem: string; problemFoundAt: Date | null } {
  const none = { heldReason: "", problem: "", problemFoundAt: null };
  if (api.pausedMessage !== null) return { state: "paused", ...none };
  if (!backendAllowed(api.backendUrl)) {
    return {
      state: "held",
      ...none,
      heldReason: `Its backend's host, ${hostOf(api.backendUrl)}, isn't one this install's admins allow (the gateway's backendHosts).`,
    };
  }
  if (backendPlace(api.backendUrl, api.teamName, apiNamespaceTaken) === "other") {
    return {
      state: "held",
      ...none,
      heldReason:
        `Its backend is in namespace ${backendNamespace(api.backendUrl) ?? ""}, not its team's API backends' namespace ` +
        `(${apiNamespace(api.teamName)}): an API may only use a backend of its own team.`,
    };
  }
  if (problem) return { state: "unavailable", ...none, problem: problem.problem, problemFoundAt: problem.foundAt };
  return { state: "live", ...none };
}

/** What the gateway recorded it can't serve, of these APIs. */
async function problemsOf(ids: string[]): Promise<Map<string, Problem>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(apiProblems).where(inArray(apiProblems.apiId, ids));
  return new Map(rows.map((r) => [r.apiId, { problem: r.problem, foundAt: r.foundAt }]));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Every operation its spec describes: what the gateway lets through. */
export function endpoints(openapi: unknown): { method: string; path: string; summary: string }[] {
  const paths = isRecord(openapi) && isRecord(openapi["paths"]) ? openapi["paths"] : {};
  const out: { method: string; path: string; summary: string }[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const summary = typeof op["summary"] === "string" ? op["summary"] : "";
      out.push({ method: method.toUpperCase(), path, summary });
    }
  }
  return out;
}

/** The team a call is made as, as the gateway's callingTeam picks it: the API's own, else the first of the caller's it's shared with (by name, byte for byte); none, no call. The gateway also passes over a retired team of the caller's, which this doesn't know of. */
function callingTeam(caller: AuthUser, api: Api): string | undefined {
  if (caller.teamNames.includes(api.teamName)) return api.teamName;
  return caller.teamNames.find((t) => api.shareWith.includes("*") || api.shareWith.includes(t));
}

function mayCall(caller: AuthUser, api: Api): boolean {
  return callingTeam(caller, api) !== undefined;
}

/** Whether the caller may see the API at all: it isn't hidden, or it's their team's (or they're an admin). */
export function sees(caller: AuthUser, api: Pick<Api, "hidden" | "teamName">): boolean {
  return !api.hidden || caller.isAdmin || caller.teamNames.includes(api.teamName);
}

/**
 * The requests a minute the caller may send it, as the gateway counts them
 * (without Vennir-Team): the calling team's own limit, else the API's
 * default, else the gateway's (0 in either means unset there too).
 */
function perMinuteFor(caller: AuthUser, api: Api): number {
  const team = callingTeam(caller, api);
  if (team === undefined) return 0;
  return api.perMinute[team] || api.perMinute["default"] || config.gateway.defaultPerMinute;
}

/** Its limits as the gateway counts them: each team api.yaml names, and everyone else's default. */
function limitsOf(api: Api) {
  const own = api.perMinute["default"] ?? 0;
  return {
    limits: Object.entries(api.perMinute)
      .filter(([team, n]) => team !== "default" && n > 0)
      .map(([team, perMinute]) => ({ team, perMinute }))
      .sort((a, b) => a.team.localeCompare(b.team)),
    defaultPerMinute: own || config.gateway.defaultPerMinute,
    defaultFromGateway: !own,
  };
}

function authKind(auth: BackendAuth | null): string {
  if (!auth) return "";
  if ("serviceAccountToken" in auth) return "service_account_token";
  if ("googleIdToken" in auth) return "google_id_token";
  return "aws_sig_v4";
}

function joinUrl(base: string, api: Api): string {
  return base ? `${base.replace(/\/$/, "")}/${api.teamName}/${api.name}` : "";
}

/** One API as the caller sees it; `base` is the catalog repository's GitHub page, for its links. */
function view(caller: AuthUser, api: Api, base: string | null, problem: Problem | null, apiNamespaceTaken: boolean) {
  const own = caller.isAdmin || caller.teamNames.includes(api.teamName);
  const internet = api.internet && config.gateway.internetTeams.includes(api.teamName);
  const info = isRecord(api.openapi) && isRecord(api.openapi["info"]) ? api.openapi["info"] : {};
  return {
    team: api.teamName,
    name: api.name,
    displayName: api.displayName,
    description: api.description,
    ...apiState(api, problem, apiNamespaceTaken),
    pausedMessage: api.pausedMessage ?? "",
    mayCall: mayCall(caller, api),
    shareWith: api.shareWith,
    hidden: api.hidden,
    deprecated: api.deprecated ?? "",
    internet,
    url: joinUrl(config.gateway.url, api),
    publicUrl: internet ? joinUrl(config.gateway.publicUrl, api) : "",
    endpoints: endpoints(api.openapi),
    perMinute: perMinuteFor(caller, api),
    timeoutSeconds: api.timeoutSeconds,
    maxRequestBytes: api.maxRequestBytes,
    sourcePath: api.sourcePath ?? "",
    ...limitsOf(api),
    // Shared with everyone, asking for it can't help: a caller without a team needs one.
    askForAccessUrl: catalogLinks(base, api.sourcePath ?? null, "the API", `${api.teamName}/${api.name}`, caller, mayCall(caller, api) || api.shareWith.includes("*")).askForAccessUrl ?? "",
    backendUrl: own ? api.backendUrl : "",
    backendAuth: own ? authKind(api.backendAuth) : "",
    specTitle: typeof info["title"] === "string" ? info["title"] : "",
    specVersion: typeof info["version"] === "string" ? info["version"] : "",
  };
}

export type ApiView = ReturnType<typeof view>;

export async function listApis(caller: AuthUser | undefined): Promise<ApiView[]> {
  const who = signedIn(caller);
  const base = githubBase(await catalogRepository());
  const seen = (await listLiveTeamApis()).filter((api) => sees(who, api));
  const problems = await problemsOf(seen.map((api) => api.id));
  const taken = await apiNamespacesTaken(seen.map((api) => api.teamName));
  return seen.map((api) => view(who, api, base, problems.get(api.id) ?? null, taken.has(api.teamName)));
}

async function visibleApi(who: AuthUser, team: string, name: string): Promise<Api> {
  const api = await findApi(team, name);
  if (!api || !sees(who, api)) throw new ApiError(404, "NOT_FOUND", `No API "${team}/${name}".`);
  return api;
}

export async function getApi(caller: AuthUser | undefined, team: string, name: string) {
  const who = signedIn(caller);
  const api = await visibleApi(who, team, name);
  const problem = (await problemsOf([api.id])).get(api.id) ?? null;
  const taken = (await apiNamespacesTaken([api.teamName])).has(api.teamName);
  return { api: view(who, api, githubBase(await catalogRepository()), problem, taken), openapi: JSON.stringify(api.openapi) };
}

/** Pauses (a message) or resumes (null) an API; a maintainer of its team or an admin. */
export async function pauseApi(caller: AuthUser | undefined, team: string, name: string, message: string | null): Promise<void> {
  const who = signedIn(caller);
  const api = await visibleApi(who, team, name);
  if (!canMaintainTeam(who, api.teamName)) {
    throw new ApiError(403, "FORBIDDEN", `Only a maintainer of ${api.teamName} may pause or resume its APIs.`);
  }
  if (message !== null && !message.trim()) {
    throw new ApiError(400, "BAD_REQUEST", "Say why it's paused: every caller is told.", Code.InvalidArgument);
  }
  await setApiPaused(api.id, message === null ? null : message.trim(), who.id);
}

/** Outcomes the gateway answers itself, without forwarding. */
const STOPPED = ["blocked", "invalid", "limited", "unauthenticated", "forbidden", "not_found", "paused", "held", "closed", "unavailable"];

/** An API's traffic over the last `hours`: its own team, and admins. */
export async function getApiTraffic(caller: AuthUser | undefined, team: string, name: string, hours: number) {
  const who = signedIn(caller);
  const api = await visibleApi(who, team, name);
  if (!who.isAdmin && !who.teamNames.includes(api.teamName)) {
    throw new ApiError(403, "FORBIDDEN", `Only ${api.teamName} sees its API's traffic.`);
  }
  const since = new Date(Date.now() - Math.min(Math.max(hours || 24, 1), 168) * 3_600_000);
  const rows = await db
    .select()
    .from(apiTraffic)
    .where(and(eq(apiTraffic.apiId, api.id), gte(apiTraffic.minute, since)));
  let requests = 0;
  let forwarded = 0;
  let stopped = 0;
  let backendErrors = 0;
  const endpoints = new Map<string, { requests: number; invalid: number; backend4xx: number; backend5xx: number; ms: number; answered: number }>();
  const blocked = new Map<string, { count: number; teams: Set<string>; last: Date }>();
  const teams = new Map<string, { requests: number; minutes: Map<number, number> }>();
  for (const r of rows) {
    requests += r.count;
    const isForwarded = r.outcome.startsWith("forwarded_");
    if (isForwarded) forwarded += r.count;
    if (STOPPED.includes(r.outcome)) stopped += r.count;
    if (r.outcome === "forwarded_5xx" || r.outcome === "backend_error") backendErrors += r.count;
    const t = teams.get(r.team) ?? { requests: 0, minutes: new Map<number, number>() };
    t.requests += r.count;
    t.minutes.set(r.minute.getTime(), (t.minutes.get(r.minute.getTime()) ?? 0) + r.count);
    teams.set(r.team, t);
    if (r.outcome === "blocked") {
      const b = blocked.get(r.endpoint) ?? { count: 0, teams: new Set<string>(), last: r.minute };
      b.count += r.count;
      if (r.team) b.teams.add(r.team);
      if (r.minute > b.last) b.last = r.minute;
      blocked.set(r.endpoint, b);
      continue;
    }
    // Before sign-in, a path that isn't the spec's is counted under no
    // endpoint (the gateway keeps no made-up path): in the totals only.
    if (r.endpoint === "") continue;
    const e = endpoints.get(r.endpoint) ?? { requests: 0, invalid: 0, backend4xx: 0, backend5xx: 0, ms: 0, answered: 0 };
    e.requests += r.count;
    if (r.outcome === "invalid") e.invalid += r.count;
    if (r.outcome === "forwarded_4xx") e.backend4xx += r.count;
    if (r.outcome === "forwarded_5xx") e.backend5xx += r.count;
    if (isForwarded) {
      e.ms += r.durationMs;
      e.answered += r.count;
    }
    endpoints.set(r.endpoint, e);
  }
  // What the gateway holds a team to without a limit of its own: the API's
  // default, else the gateway's (as perMinuteFor says it to callers).
  const fallback = api.perMinute["default"] || config.gateway.defaultPerMinute;
  return {
    requests,
    forwarded,
    stopped,
    backendErrors,
    endpoints: [...endpoints]
      .map(([endpoint, e]) => ({
        endpoint,
        requests: e.requests,
        invalid: e.invalid,
        backend4xx: e.backend4xx,
        backend5xx: e.backend5xx,
        averageMs: e.answered ? Math.round(e.ms / e.answered) : 0,
      }))
      .sort((a, b) => b.requests - a.requests),
    blocked: [...blocked]
      .map(([request, b]) => ({ request, count: b.count, teams: [...b.teams].sort(), last: b.last }))
      .sort((a, b) => b.count - a.count),
    teams: [...teams]
      .map(([name, t]) => ({
        team: name,
        requests: t.requests,
        peakPerMinute: Math.max(0, ...t.minutes.values()),
        limitPerMinute: name ? api.perMinute[name] || fallback : 0,
      }))
      .sort((a, b) => b.requests - a.requests),
  };
}

function admin(caller: AuthUser | undefined): AuthUser {
  const who = signedIn(caller);
  if (!who.isAdmin) throw new ApiError(403, "FORBIDDEN", "The gateway's settings are an admin's.");
  return who;
}

/** The gateway's settings, whether it's closed, and what it refused over the last day. */
export async function getGateway(caller: AuthUser | undefined) {
  admin(caller);
  const [state] = await db.select().from(gatewayState).where(eq(gatewayState.id, 1));
  const closedBy = state?.closedBy ? ((await findUserById(state.closedBy))?.email ?? "(deleted account)") : "";
  const since = new Date(Date.now() - 24 * 3_600_000);
  const byOutcome = await db
    .select({ outcome: apiTraffic.outcome, team: apiTraffic.team, count: sql<number>`sum(${apiTraffic.count})::int` })
    .from(apiTraffic)
    .where(gte(apiTraffic.minute, since))
    .groupBy(apiTraffic.outcome, apiTraffic.team);
  const refused = new Map<string, { count: number; mostly: string; most: number }>();
  let requests = 0;
  for (const r of byOutcome) {
    requests += r.count;
    if (!STOPPED.includes(r.outcome) && r.outcome !== "backend_error") continue;
    const entry = refused.get(r.outcome) ?? { count: 0, mostly: "", most: 0 };
    entry.count += r.count;
    if (r.count > entry.most) Object.assign(entry, { mostly: r.team, most: r.count });
    refused.set(r.outcome, entry);
  }
  return {
    enabled: config.gateway.url !== "",
    backendHosts: config.gateway.backendHosts,
    internetTeams: config.gateway.internetTeams,
    url: config.gateway.url,
    publicUrl: config.gateway.publicUrl,
    closedMessage: state?.closedMessage ?? "",
    closedBy,
    closedAt: state?.closedAt ?? null,
    apis: (await listLiveTeamApis()).length,
    requests24h: requests,
    refused: [...refused].map(([outcome, r]) => ({ outcome, count: r.count, mostly: r.mostly })).sort((a, b) => b.count - a.count),
  };
}

/** Closes the gateway with a message, or reopens it (""). */
export async function setGatewayClosed(caller: AuthUser | undefined, message: string): Promise<void> {
  const who = admin(caller);
  const closed = message.trim();
  await db
    .insert(gatewayState)
    .values({ id: 1, closedMessage: closed || null, closedBy: closed ? who.id : null, closedAt: closed ? new Date() : null })
    .onConflictDoUpdate({
      target: gatewayState.id,
      set: { closedMessage: closed || null, closedBy: closed ? who.id : null, closedAt: closed ? new Date() : null },
    });
}
