// SPDX-License-Identifier: MIT
/**
 * The install's alerts, as a Prometheus has them now (Observe's Metrics):
 * the charts' alerting rules (their groups are vertra-console and
 * vertra-kernel), each inactive, pending or firing, with what it fires
 * for. Read from config.monitoring.prometheusUrl's HTTP API, which any
 * Prometheus serves itself, Alertmanager or not: the bundled one, one the
 * operator runs, or one outside the cluster.
 *
 * Every signed-in person sees them, as they see the Metrics tab; a firing
 * instance labelled with an API the caller can't see (another team's
 * hidden one) is counted, not described.
 */
import { Code } from "@connectrpc/connect";
import { ApiError } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { listLiveTeamApis } from "../db/queries.js";
import { gcpMetadataToken } from "../gcpMetadata.js";
import { listGmpRuleGroups } from "../k8s.js";
import { sees } from "./apis.js";

/** Prometheus's /api/v1/rules, as far as it's read here. */
interface RulesResponse {
  status: string;
  data?: {
    groups?: {
      name: string;
      rules?: {
        type: string;
        name: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
        alerts?: { labels?: Record<string, string>; annotations?: Record<string, string>; state: string; activeAt?: string }[];
      }[];
    }[];
  };
}

export interface AlertInstanceView {
  state: string;
  activeAt: Date | null;
  summary: string;
  description: string;
  labels: Record<string, string>;
}

export interface AlertRuleView {
  name: string;
  severity: string;
  summary: string;
  state: string;
  instances: AlertInstanceView[];
  hidden: number;
}

/** The charts' rule groups. */
const OURS = /^vertra-/;
/** A rule's summary for no one instance: its template expressions left out. */
const general = (text: string) => text.replace(/\{\{[^}]*\}\}/g, "…");
const STATE_ORDER = ["firing", "pending", "inactive"];

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

export interface AlertsView {
  configured: boolean;
  problem: string;
  checkedAt: Date | null;
  rules: AlertRuleView[];
  source: "prometheus" | "google" | "";
  project: string;
  stateUnknown: boolean;
}

/** One of GMP's query API's series. */
interface Series {
  metric: Record<string, string>;
  value: [number, string];
}

/** Labels GKE's managed Prometheus adds to every series: where, not what. */
const GMP_LABELS = ["project_id", "location", "cluster"];

/** Why GMP's query API couldn't be read. */
class GmpUnread extends Error {}

/** A PromQL query against the project's managed Prometheus, as the console's Google identity. */
async function gmpQuery(project: string, query: string): Promise<Series[]> {
  let token: string;
  try {
    token = await gcpMetadataToken();
  } catch {
    throw new GmpUnread("The console has no Google token here (it signs in to Google with GKE's Workload Identity).");
  }
  let response: Response;
  try {
    response = await fetch(
      `https://monitoring.googleapis.com/v1/projects/${project}/location/global/prometheus/api/v1/query?query=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) },
    );
  } catch {
    throw new GmpUnread("Google's managed Prometheus isn't answering.");
  }
  if (response.status === 403) {
    throw new GmpUnread(`Google's managed Prometheus refused the console (403): its Google identity needs roles/monitoring.viewer on ${project}, which vertra apply grants.`);
  }
  if (!response.ok) throw new GmpUnread(`Google's managed Prometheus answered ${String(response.status)}.`);
  const body = (await response.json()) as { status: string; data?: { result?: Series[] } };
  if (body.status !== "success") throw new GmpUnread("Google's managed Prometheus couldn't run the query.");
  return body.data?.result ?? [];
}

/** An alert instance's identity: its labels but the series' name and state. */
const instanceKey = (metric: Record<string, string>) =>
  JSON.stringify(Object.entries(metric).filter(([k]) => k !== "__name__" && k !== "alertstate").sort(([a], [b]) => a.localeCompare(b)));

/**
 * The charts' rules from the cluster's Rules objects, and which fire from
 * the project's managed Prometheus (ALERTS, and ALERTS_FOR_STATE for
 * since when), in the shape Prometheus's rules API has. GMP keeps no
 * instance's own annotations, so each shows its rule's summary.
 */
async function googleRules(project: string, cluster: string): Promise<{ body: RulesResponse; unread: string }> {
  const groups = (await listGmpRuleGroups()).filter((g) => OURS.test(g.name));
  const names = [...new Set(groups.flatMap((g) => (g.rules ?? []).flatMap((r) => (r.alert ? [r.alert] : []))))];
  const firing = new Map<string, { labels: Record<string, string>; state: string; activeAt?: string }[]>();
  let unread = "";
  if (names.length > 0) {
    const selector = `{alertname=~"${names.join("|")}"${cluster ? `,cluster="${cluster}"` : ""}}`;
    try {
      const [alerts, since] = await Promise.all([gmpQuery(project, `ALERTS${selector}`), gmpQuery(project, `ALERTS_FOR_STATE${selector}`)]);
      const activeAt = new Map(since.map((s) => [instanceKey(s.metric), new Date(Number(s.value[1]) * 1000).toISOString()]));
      for (const a of alerts) {
        const name = a.metric["alertname"] ?? "";
        const labels = Object.fromEntries(Object.entries(a.metric).filter(([k]) => k !== "__name__" && k !== "alertstate" && !GMP_LABELS.includes(k)));
        const at = activeAt.get(instanceKey(a.metric));
        firing.set(name, [...(firing.get(name) ?? []), { labels, state: a.metric["alertstate"] ?? "firing", ...(at ? { activeAt: at } : {}) }]);
      }
    } catch (error) {
      if (!(error instanceof GmpUnread)) throw error;
      unread = error.message;
    }
  }
  return {
    unread,
    body: {
      status: "success",
      data: {
        groups: groups.map((g) => ({
          name: g.name,
          rules: (g.rules ?? []).flatMap((r) =>
            r.alert
              ? [{
                  type: "alerting",
                  name: r.alert,
                  ...(r.labels ? { labels: r.labels } : {}),
                  ...(r.annotations ? { annotations: r.annotations } : {}),
                  alerts: firing.get(r.alert) ?? [],
                }]
              : [],
          ),
        })),
      },
    },
  };
}

export async function listAlerts(caller: AuthUser | undefined): Promise<AlertsView> {
  const who = signedIn(caller);
  const base = config.monitoring.prometheusUrl;
  const google = !base && config.monitoring.provider === "google" ? config.monitoring.google : null;
  if (!base && !google?.project) return { configured: false, problem: "", checkedAt: null, rules: [], source: "", project: "", stateUnknown: false };
  const checkedAt = new Date();
  const answer = (problem: string): AlertsView => ({
    configured: true, problem, checkedAt, rules: [], source: google ? "google" : "prometheus", project: google?.project ?? "", stateUnknown: false,
  });
  let body: RulesResponse;
  let unread = "";
  if (google) {
    try {
      ({ body, unread } = await googleRules(google.project, google.cluster));
    } catch {
      return answer("The cluster's Rules couldn't be read.");
    }
  } else {
    try {
      // Under the URL's own path, for a Prometheus served below one (https://host/prometheus).
      const response = await fetch(`${base}/api/v1/rules?type=alert`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return answer(`Prometheus answered ${String(response.status)}.`);
      body = (await response.json()) as RulesResponse;
    } catch {
      return answer("Prometheus isn't answering.");
    }
    if (body.status !== "success") return answer("Prometheus couldn't list its rules.");
  }

  // The APIs the caller may see, for instances labelled with one.
  const visible = who.isAdmin ? null : new Set((await listLiveTeamApis()).filter((a) => sees(who, a)).map((a) => `${a.teamName}/${a.name}`));
  const rules: AlertRuleView[] = [];
  for (const group of body.data?.groups ?? []) {
    if (!OURS.test(group.name)) continue;
    for (const rule of group.rules ?? []) {
      if (rule.type !== "alerting") continue;
      const active = (rule.alerts ?? []).filter((a) => a.state === "firing" || a.state === "pending");
      const shown = active.filter((a) => !visible || !a.labels?.["api"] || visible.has(a.labels["api"]));
      rules.push({
        name: rule.name,
        severity: rule.labels?.["severity"] ?? "",
        summary: general(rule.annotations?.["summary"] ?? ""),
        state: unread ? "unknown" : active.some((a) => a.state === "firing") ? "firing" : active.length > 0 ? "pending" : "inactive",
        instances: shown.map((a) => {
          const labels = Object.fromEntries(Object.entries(a.labels ?? {}).filter(([k]) => k !== "alertname" && k !== "severity"));
          return {
            state: a.state,
            activeAt: a.activeAt ? new Date(a.activeAt) : null,
            summary: a.annotations?.["summary"] ?? "",
            description: a.annotations?.["description"] ?? "",
            labels,
          };
        }),
        hidden: active.length - shown.length,
      });
    }
  }
  // Firing first, then pending; the rest as Prometheus lists them.
  rules.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  return { ...answer(unread), rules, stateUnknown: unread !== "" };
}
