// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import { errorMessage, listAlerts, type AlertRuleView, type AlertsView } from "../../api";
import { Mono } from "../../components/Mono";
import { Pill, type PillTone } from "../../components/Pill";
import { when } from "../../time";

const STATE: Record<AlertRuleView["state"], { tone: PillTone; label: string }> = {
  firing: { tone: "error", label: "Firing" },
  pending: { tone: "warning", label: "Pending" },
  inactive: { tone: "success", label: "Quiet" },
  unknown: { tone: "neutral", label: "Unknown" },
};

/** The earliest an alert's instances became active: since when it's been firing (or pending). */
function since(rule: AlertRuleView): string | null {
  const times = rule.instances.flatMap((i) => (i.state === rule.state && i.activeAt ? [i.activeAt] : [])).sort();
  return times[0] ?? null;
}

/**
 * The install's alerts as its Prometheus has them now (the console chart's
 * monitoring.prometheusUrl, else the bundled one; or, on GKE's managed
 * Prometheus, the cluster's Rules and which fire from Google): each of the
 * charts' rules, firing ones first with what they fire for. An instance
 * about an API you can't see is only counted.
 */
export function AlertsCard() {
  const [alerts, setAlerts] = useState<AlertsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAlerts()
      .then((found) => {
        if (!cancelled) setAlerts(found);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Couldn't read the alerts."));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const firing = alerts?.rules.filter((r) => r.state === "firing").length ?? 0;
  const google = alerts?.source === "google";
  // The rules came, but not their state: said in its own box, not as a failure.
  const unread = alerts?.stateUnknown ?? false;
  return (
    <Card component="section" aria-labelledby="alerts" sx={{ px: 2.75, py: 2.5, display: "flex", flexDirection: "column", gap: 1.25, minWidth: 0 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1.25, flexWrap: "wrap" }}>
        <Typography id="alerts" variant="h6" component="h2">
          Alerts
        </Typography>
        {alerts?.checkedAt && (!alerts.problem || unread) && (
          <Typography variant="caption" color="text.secondary">
            {unread ? "state unknown" : firing > 0 ? `${String(firing)} firing` : "none firing"}
            {google && !unread ? " · from Google Cloud" : ""} · checked {when(alerts.checkedAt)}
          </Typography>
        )}
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {alerts && !alerts.configured && (
        <Typography variant="body2" color="text.secondary">
          The console reads no Prometheus here, so alerts aren&apos;t shown. Its chart&apos;s <Mono>monitoring.prometheusUrl</Mono> names one, or the bundled
          Prometheus is used when it&apos;s on.
        </Typography>
      )}
      {alerts?.problem && !unread && <Alert severity="warning">Couldn&apos;t read the alerts: {alerts.problem}</Alert>}
      {alerts?.configured && (!alerts.problem || unread) && alerts.rules.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {google ? "The cluster has none of the charts' alerts as Rules." : "Its Prometheus has none of the charts' alerts loaded."}
        </Typography>
      )}
      {alerts?.configured && (!alerts.problem || unread) && alerts.rules.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
          {google ? (
            <>
              The charts&apos; alerts, loaded as Rules into Google Cloud&apos;s managed Prometheus, which evaluates them for project <Mono>{alerts.project}</Mono>.
            </>
          ) : (
            "The charts' alerts, as this install's Prometheus has them now."
          )}
        </Typography>
      )}
      {unread && (
        <Alert severity="warning" role="status">
          <Typography variant="body2" sx={{ fontWeight: 600 }}>Which ones fire can&apos;t be read</Typography>
          {alerts?.problem} The rules below are the cluster&apos;s; their state is unknown.
        </Alert>
      )}
      {alerts?.rules.map((rule) => {
        const from = since(rule);
        const state = STATE[rule.state];
        return (
          <Box key={rule.name} sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 1.5, py: 1, borderTop: 1, borderColor: "divider" }}>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
              <Mono sx={{ fontSize: 12 }}>{rule.name}</Mono>
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12.5, lineHeight: 1.4 }}>
                {rule.summary}
              </Typography>
              {rule.instances.map((i, n) => (
                <Box key={n} sx={{ mt: 0.5, px: 1, py: 0.75, borderRadius: 1.5, bgcolor: i.state === "firing" ? "error.light" : "warning.light", color: i.state === "firing" ? "error.dark" : "warning.dark", fontSize: 12.5, lineHeight: 1.45 }}>
                  {/* Google keeps no instance's own text: its labels say where, under the rule's summary. */}
                  {google ? null : i.summary || rule.summary}
                  {Object.keys(i.labels).length > 0 && (
                    <Mono sx={{ display: "block", fontSize: 11.5, overflowWrap: "anywhere" }}>
                      {Object.entries(i.labels)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(" · ")}
                    </Mono>
                  )}
                  {google && i.activeAt ? `Since ${when(i.activeAt)}` : null}
                </Box>
              ))}
              {rule.hidden > 0 && (
                <Typography variant="caption" color="text.secondary">
                  And {rule.hidden} about an API you can&apos;t see.
                </Typography>
              )}
            </Box>
            <Pill tone={state.tone}>{rule.state !== "inactive" && from ? `${state.label} since ${when(from)}` : state.label}</Pill>
          </Box>
        );
      })}
      {google && alerts.rules.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ borderTop: 1, borderColor: "divider", pt: 1, lineHeight: 1.5 }}>
          Google keeps which alerts fire and their labels, not each one&apos;s own text: a firing alert shows its rule&apos;s summary and the labels that say where.
          Grafana or Cloud Monitoring shows the same from Google.
        </Typography>
      )}
    </Card>
  );
}
