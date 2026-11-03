// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { Mono } from "../../components/Mono";
import { MetricCard } from "../../components/MetricCard";
import { errorMessage, getApiTraffic, type ApiTraffic as Traffic } from "../../api";

const num = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** An API's traffic over the last `hours` (ApiService.GetApiTraffic): its own team's and admins'. Null while loading. */
export function useApiTraffic(team: string, name: string, hours: number, enabled: boolean) {
  const [traffic, setTraffic] = useState<Traffic | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setTraffic(null);
    setError(null);
    getApiTraffic(team, name, hours)
      .then((t) => {
        if (!cancelled) setTraffic(t);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Failed to load its traffic."));
      });
    return () => {
      cancelled = true;
    };
  }, [team, name, hours, enabled]);
  return { traffic, error };
}

/** Last 24 hours or last 7 days. */
export function PeriodToggle({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      aria-label="Period"
      value={hours}
      onChange={(_e, value: number | null) => {
        if (value) onChange(value);
      }}
      sx={{ bgcolor: "background.paper", "& .MuiToggleButton-root": { minHeight: 40, px: 1.75 } }}
    >
      <ToggleButton value={24}>Last 24 hours</ToggleButton>
      <ToggleButton value={168}>Last 7 days</ToggleButton>
    </ToggleButtonGroup>
  );
}

/** What the gateway stopped, by why: what the spec doesn't have, what didn't fit it, and the rest (sign-in, sharing, limits, pauses…). */
function stoppedNote(blocked: number, invalid: number, other: number): string {
  return [
    blocked > 0 && `${blocked.toLocaleString()} not in the spec`,
    invalid > 0 && `${invalid.toLocaleString()} didn’t fit`,
    other > 0 && `${other.toLocaleString()} refused otherwise (sign-in, sharing, limits, pauses)`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Requests, forwarded, stopped and backend errors, each with what's behind it. */
export function TrafficTiles({ traffic }: { traffic: Traffic | null }) {
  const named = traffic?.teams.filter((t) => t.team) ?? [];
  const anonymous = traffic?.teams.find((t) => !t.team)?.requests ?? 0;
  const blocked = traffic?.blocked.reduce((n, b) => n + b.count, 0) ?? 0;
  const invalid = traffic?.endpoints.reduce((n, e) => n + e.invalid, 0) ?? 0;
  const worst = traffic?.endpoints.reduce<Traffic["endpoints"][number] | null>((w, e) => (e.backend5xx > (w?.backend5xx ?? 0) ? e : w), null);
  return (
    <Box component="section" aria-label="Traffic summary" sx={{ display: "grid", gap: 1.75, gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(auto-fit, minmax(200px, 1fr))" } }}>
      <MetricCard
        label="Requests"
        value={num(traffic?.requests)}
        note={traffic && `from ${plural(named.length, "team")}${anonymous ? `, and ${anonymous.toLocaleString()} refused before a team was known` : ""}`}
      />
      <MetricCard
        label="Forwarded to the backend"
        value={num(traffic?.forwarded)}
        note={traffic?.requests ? `${((100 * traffic.forwarded) / traffic.requests).toFixed(1)}% of requests` : undefined}
      />
      <MetricCard
        label="Stopped at the gateway"
        value={num(traffic?.stopped)}
        note={traffic && traffic.stopped > 0 ? stoppedNote(blocked, invalid, traffic.stopped - blocked - invalid) : undefined}
      />
      <MetricCard
        label="Backend errors"
        value={num(traffic?.backendErrors)}
        note={worst ? `${worst.backend5xx.toLocaleString()} answered 5xx on ${worst.endpoint}` : undefined}
      />
    </Box>
  );
}

/** Each calling team's requests, its busiest minute against its limit as a bar. */
export function CallingTeams({ traffic }: { traffic: Traffic | null }) {
  return (
    <Card component="section" aria-label="By calling team" sx={{ px: 2.75, py: 2.5, display: "flex", flexDirection: "column", gap: 1.75 }}>
      <Typography variant="h6" component="h2">
        By calling team
      </Typography>
      {traffic?.teams.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          No callers yet.
        </Typography>
      )}
      {traffic?.teams.map((t) => {
        const pct = t.limitPerMinute ? Math.min(100, Math.round((100 * t.peakPerMinute) / t.limitPerMinute)) : 0;
        const name = t.team || "(no calling team)";
        return (
          <Box key={t.team || "-"} sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
            <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1.5 }}>
              <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 500 }}>
                {name}
              </Typography>
              <Typography variant="body2" sx={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
                {t.requests.toLocaleString()}
              </Typography>
            </Box>
            <Box
              role="meter"
              aria-label={`${name}: busiest minute against its limit`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              sx={{ height: 8, bgcolor: "action.hover", borderRadius: 1, overflow: "hidden" }}
            >
              <Box sx={{ height: "100%", borderRadius: 1, width: `${String(t.limitPerMinute ? Math.max(pct, 1) : 3)}%`, bgcolor: pct >= 90 ? "warning.main" : "primary.main" }} />
            </Box>
            <Typography variant="caption" color="text.secondary">
              {!t.team
                ? `busiest minute ${t.peakPerMinute.toLocaleString()}; refused before a calling team was known (not signed in, not shared, or the API paused, held or closed)`
                : t.limitPerMinute
                  ? `busiest minute ${t.peakPerMinute.toLocaleString()} of ${t.limitPerMinute.toLocaleString()}`
                  : `busiest minute ${t.peakPerMinute.toLocaleString()}`}
            </Typography>
          </Box>
        );
      })}
      <Typography variant="caption" color="text.secondary" sx={{ borderTop: 1, borderColor: "divider", pt: 1.25, lineHeight: 1.45 }}>
        The bar is each team’s busiest minute against its limit; past it, the gateway answers 429.
      </Typography>
    </Card>
  );
}

/** Requests for paths or methods its spec doesn't describe. */
export function BlockedRequests({ traffic }: { traffic: Traffic | null }) {
  return (
    <Card component="section" aria-label="Blocked: not in the spec" sx={{ px: 2.75, py: 2.5, display: "flex", flexDirection: "column", gap: 1.25, borderColor: "warning.light" }}>
      <Typography variant="h6" component="h2">
        Blocked: not in the spec
      </Typography>
      <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.5 }}>
        Paths or methods its OpenAPI file doesn’t describe. They got 404 and never reached the backend; a caller that keeps sending one
        may rely on an endpoint you never published.
      </Typography>
      {traffic?.blocked.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ borderTop: 1, borderColor: "divider", pt: 1 }}>
          Nothing blocked.
        </Typography>
      )}
      {traffic?.blocked.map((b) => (
        <Box key={b.request} sx={{ display: "flex", flexDirection: "column", gap: 0.25, py: 1, borderTop: 1, borderColor: "divider" }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1.25 }}>
            <Mono sx={{ fontSize: 12, overflowWrap: "anywhere" }}>{b.request}</Mono>
            <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
              {b.count.toLocaleString()}
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary">
            {b.teams.join(", ") || "—"}
            {b.last ? ` · last ${new Date(b.last).toLocaleString()}` : ""}
          </Typography>
        </Box>
      ))}
    </Card>
  );
}
