// SPDX-License-Identifier: MIT
/**
 * Keeps the cluster's copy of which audiences each API's ServiceAccount may
 * get a token for current. The gateway mints its backend credentials from
 * an API's own ServiceAccount (gateway/internal/credentials), and the
 * console chart's gateway token policy (templates/gateway.yaml) lets it ask
 * only for what that API's published backend.auth needs, from literals held
 * in the policy itself. This writes them, from the database, whenever the
 * catalog's APIs change, every few minutes (policySync.ts) and at startup,
 * as productPolicy.ts writes the kernel's identity policy:
 *
 * - `apiAudiencesWritten`: "true" once a console has written the maps; the
 *   chart seeds it "false" where it can't keep what's there (an install, the
 *   upgrade from a chart without the maps, a render with no lookup), and
 *   the exact-audience check applies only once it's true.
 * - `apiAudiences0` to `apiAudiencesf`: JSON maps of
 *   "<namespace>/<serviceAccount>" (the API's team, its ServiceAccount) to
 *   the audiences it may have, sharded by the key's length modulo 16 (the
 *   policy's CEL computes the same), since the API server compiles at most
 *   100,000 characters per CEL expression (MAX_MAP_CHARS, MAX_TOTAL_CHARS).
 *
 * An API's audiences are exactly what the gateway asks for:
 * serviceAccountToken, the backend's audience (never one a cloud exchanges
 * for an identity, or the cluster's own: the gateway refuses those itself);
 * awsSigV4, AWS STS's (credentials.AWSAudience); googleIdToken, the
 * gateway's GCP token audience (gateway.gcp.tokenAudience), when this
 * install has one. An API with no backend.auth needs none. An API that's
 * held (its backend's host isn't one the admins allow, or it isn't in its
 * team's API backends' namespace: apis.ts's apiState) or whose team is
 * retired or purged gets none either: the gateway serves it nothing. A
 * paused one keeps its audiences, so resuming it is immediate.
 */
import { config } from "./config.js";
import { apiNamespacesTaken, backendAllowed, backendPlace } from "./core/apis.js";
import { listLiveTeamApis } from "./db/queries.js";
import type { BackendAuth } from "./db/schema.js";
import { updateGatewayTokenPolicy } from "./k8s.js";
import { apiTokenAudienceProblem } from "./tokenAudiences.js";

/** As the gateway's credentials.AWSAudience: what AWS STS's web identity tokens carry. */
export const AWS_STS_AUDIENCE = "sts.amazonaws.com";

/**
 * The most characters one map may hold: the API server compiles at most
 * 100,000 per CEL expression, and this leaves room for the rest. An entry
 * is its key (about 30 to 80 characters) and its audience (a backend's URL,
 * usually under 100), so about 500 APIs a map.
 */
export const MAX_MAP_CHARS = 95_000;
/** The most characters all sixteen may hold, keeping the policy, and Helm's release Secret, well under their limits. */
export const MAX_TOTAL_CHARS = 600_000;

/**
 * Keys in byte order, as Helm's toJson (Go's encoding/json) writes a map, so
 * the chart's upgrade seed re-encodes what this wrote unchanged and the next
 * sync has nothing to rewrite. (Keys and audiences here are ASCII.)
 */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];

/** An API, as this needs it. */
export interface PolicyApi {
  teamName: string;
  serviceAccount: string;
  backendUrl: string;
  backendAuth: BackendAuth | null;
}

/**
 * The audiences the gateway asks for to sign in to this backend, as the
 * gateway's Minter.Authorize does; none where it would refuse to mint.
 */
export function backendAudiences(auth: BackendAuth | null, gcpTokenAudience: string = config.gateway.gcpTokenAudience): string[] {
  if (!auth) return [];
  if ("serviceAccountToken" in auth) {
    const audience = auth.serviceAccountToken.audience;
    if (!audience || apiTokenAudienceProblem(audience) || audience === gcpTokenAudience) return [];
    return [audience];
  }
  if ("awsSigV4" in auth) return [AWS_STS_AUDIENCE];
  if ("googleIdToken" in auth) return gcpTokenAudience ? [gcpTokenAudience] : [];
  return [];
}

/** Whether the gateway would hold this API (serve it nothing), as apiState says. */
function held(api: PolicyApi, apiNamespaceTaken: boolean): boolean {
  return !backendAllowed(api.backendUrl) || backendPlace(api.backendUrl, api.teamName, apiNamespaceTaken) === "other";
}

/**
 * Each API ServiceAccount's audiences ("<namespace>/<serviceAccount>"),
 * sorted, each once, of the APIs that aren't held (`taken`: the teams whose
 * `<team>-apis` is another team's name, apiNamespacesTaken). Two APIs on
 * one ServiceAccount share what both need.
 */
export function policyApiAudiences(apis: PolicyApi[], taken: Set<string>, gcpTokenAudience?: string): Map<string, string[]> {
  const byKey = new Map<string, Set<string>>();
  for (const api of apis) {
    if (held(api, taken.has(api.teamName))) continue;
    const audiences = backendAudiences(api.backendAuth, gcpTokenAudience);
    if (audiences.length === 0) continue;
    const key = `${api.teamName}/${api.serviceAccount}`;
    const set = byKey.get(key) ?? new Set<string>();
    for (const audience of audiences) set.add(audience);
    byKey.set(key, set);
  }
  return new Map([...byKey].sort(([a], [b]) => byteOrder(a, b)).map(([key, set]) => [key, [...set].sort()]));
}

/**
 * Which of the sixteen maps a key is in: its length modulo 16, as the
 * policy's CEL reads it (size() counts code points; a namespace's and a
 * ServiceAccount's names are ASCII, so that's .length).
 */
export function shardOf(key: string): string {
  return DIGITS[key.length % 16] ?? "0";
}

/** The maps as the policy's variables; throws when they'd be over what it holds. */
export function audienceVariables(audiences: Map<string, string[]>): Record<string, string> {
  const maps = new Map<string, Record<string, string[]>>(DIGITS.map((digit) => [digit, {}]));
  for (const [key, list] of audiences) {
    const map = maps.get(shardOf(key));
    if (map) map[key] = list;
  }
  const variables: Record<string, string> = {};
  let total = 0;
  for (const digit of DIGITS) {
    const map = maps.get(digit) ?? {};
    const literal = JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => byteOrder(a, b))));
    if (literal.length > MAX_MAP_CHARS) {
      throw new Error(
        `The API ServiceAccounts' audiences in map ${digit} take ${String(literal.length)} characters, more than the gateway token policy holds in one map (${String(MAX_MAP_CHARS)}).`,
      );
    }
    total += literal.length;
    variables[`apiAudiences${digit}`] = literal;
  }
  if (total > MAX_TOTAL_CHARS) {
    throw new Error(`The API ServiceAccounts' audiences take ${String(total)} characters, more than the gateway token policy holds (${String(MAX_TOTAL_CHARS)}).`);
  }
  return variables;
}

/**
 * Everything the policy should say now: the maps, and that they've been
 * written (`apiAudiencesWritten`: until a console first writes them, the
 * policy doesn't hold mints to them, so a console that's slow to roll out
 * after an upgrade, or a render with no lookup, refuses no API's credential).
 */
export async function wantedAudienceVariables(): Promise<Record<string, string>> {
  const apis = await listLiveTeamApis();
  const taken = await apiNamespacesTaken(apis.map((api) => api.teamName));
  return { ...audienceVariables(policyApiAudiences(apis, taken)), apiAudiencesWritten: "true" };
}

/**
 * Writes every published API's ServiceAccount's audiences into the gateway
 * token policy, pruning the rest. Errors propagate, as syncIdentityPolicy's
 * do. Returns false when there's nothing to write to: the gateway is off
 * (no policy configured, as in tests) or its policy isn't installed.
 */
export async function syncGatewayTokenPolicy(): Promise<boolean> {
  if (!config.gateway.tokenPolicyName) return false;
  return updateGatewayTokenPolicy(config.gateway.tokenPolicyName, () => wantedAudienceVariables());
}
