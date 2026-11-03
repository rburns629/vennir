// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { HelpLink } from "../../components/HelpLink";
import { MetricCard } from "../../components/MetricCard";
import { Mono } from "../../components/Mono";
import { errorMessage, getInstall, getMetrics, type InstallInfo, type MetricsView } from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { AlertsCard } from "./AlertsCard";

type ProductTimes = MetricsView["products"][number];

/** 0.4 s, 12 s, 3 min 5 s, 1 h 2 min. */
function duration(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${String(Math.round(seconds))} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${String(m)} min ${String(Math.round(seconds % 60))} s`;
  return `${String(Math.floor(m / 60))} h ${String(m % 60)} min`;
}

/** Where a duration falls on the step-time scale, 1 s to 10 min, logarithmic: 0 to 100. */
const onScale = (seconds: number) => Math.max(0, Math.min(100, (Math.log10(Math.max(seconds, 1)) / Math.log10(600)) * 100));
const SCALE: [string, number][] = [
  ["1 s", 1],
  ["10 s", 10],
  ["1 min", 60],
  ["10 min", 600],
];

/** A product's step times as a bar from its median to its 95th percentile, the median marked. */
function TimeRange({ p }: { p: ProductTimes }) {
  const from = onScale(p.p50Seconds);
  const to = onScale(p.p95Seconds);
  return (
    <Box
      role="img"
      aria-label={`median ${duration(p.p50Seconds)}, 95th percentile ${duration(p.p95Seconds)}`}
      title={`median ${duration(p.p50Seconds)}, 95th percentile ${duration(p.p95Seconds)}`}
      sx={{ position: "relative", height: 12, minWidth: 160 }}
    >
      {SCALE.map(([label, s]) => (
        <Box key={label} aria-hidden="true" sx={{ position: "absolute", top: 0, bottom: 0, left: `${String(onScale(s))}%`, width: "1px", bgcolor: "divider" }} />
      ))}
      <Box sx={{ position: "absolute", top: 2, height: 8, borderRadius: 1, bgcolor: "primary.light", opacity: 0.45, left: `${String(from)}%`, width: `${String(Math.max(1, to - from))}%` }} />
      <Box sx={{ position: "absolute", top: 0, width: 3, height: 12, borderRadius: 0.5, bgcolor: "text.primary", left: `calc(${String(from)}% - 1px)` }} />
    </Box>
  );
}

const PRODUCTS: DataTableColumn<ProductTimes>[] = [
  {
    key: "product",
    header: "Product",
    render: (p) => (
      <Box>
        <Typography variant="body2">
          <Box component="span" sx={{ fontWeight: 500 }}>
            {p.product}
          </Box>{" "}
          <Mono sx={{ fontSize: 12 }}>{p.action}</Mono>
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {p.team}
        </Typography>
      </Box>
    ),
  },
  { key: "steps", header: "Steps", render: (p) => p.steps.toLocaleString(), align: "right" },
  {
    key: "ok",
    header: "Succeeded",
    render: (p) => {
      if (!p.steps) return "—";
      const pct = Math.round((100 * p.succeeded) / p.steps);
      return (
        <Box component="span" sx={pct < 90 ? { color: "error.main", fontWeight: 600 } : undefined}>
          {pct}%
        </Box>
      );
    },
    align: "right",
  },
  { key: "p50", header: "Median", render: (p) => duration(p.p50Seconds), align: "right", hideBelow: "sm" },
  {
    key: "p95",
    header: "95th percentile",
    render: (p) => (
      <Box component="span" sx={{ fontWeight: 500 }}>
        {duration(p.p95Seconds)}
      </Box>
    ),
    align: "right",
  },
  {
    key: "range",
    header: (
      <Box component="span" sx={{ display: "block", position: "relative", height: "1.4em", minWidth: 160 }}>
        {SCALE.map(([label, s], i) => (
          <Box
            component="span"
            key={label}
            sx={{ position: "absolute", left: `${String(onScale(s))}%`, transform: i === 0 ? "none" : i === SCALE.length - 1 ? "translateX(-100%)" : "translateX(-50%)", whiteSpace: "nowrap" }}
          >
            {label}
          </Box>
        ))}
      </Box>
    ),
    render: (p) => <TimeRange p={p} />,
    hideBelow: "md",
  },
];

/** One series over the last 24 hours, one axis. */
function HourChart({ data, dataKey, label, format, summary }: { data: { label: string }[]; dataKey: string; label: string; format: (n: number) => string; summary: string }) {
  const theme = useTheme();
  return (
    <Box role="img" aria-label={summary} sx={{ height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 0, right: 8 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={theme.palette.divider} />
          <XAxis dataKey="label" fontSize={11} minTickGap={24} stroke={theme.palette.text.secondary} tickLine={false} />
          <YAxis allowDecimals={false} fontSize={11} width={44} tickFormatter={format} stroke={theme.palette.text.secondary} axisLine={false} tickLine={false} />
          <Tooltip formatter={(v) => [format(Number(v)), label]} contentStyle={{ background: theme.palette.background.paper, borderColor: theme.palette.divider }} />
          <Bar dataKey={dataKey} fill={theme.palette.primary.main} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}

function ChartCard({ title, sub, foot, children }: { title: string; sub: string; foot: string; children: ReactNode }) {
  return (
    <Card component="section" aria-label={title} sx={{ px: 2.75, py: 2.5, display: "flex", flexDirection: "column", gap: 1.5, minWidth: 0 }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Typography variant="h6" component="h2">
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
          {sub}
        </Typography>
      </Box>
      {children}
      <Typography variant="caption">{foot}</Typography>
    </Card>
  );
}

/** Which Prometheus an install may use: the console chart's monitoring.provider. */
const PROVIDERS: [string, string, string][] = [
  ["google", "Managed Service for Prometheus", "GKE’s own: reads the charts’ PodMonitoring and Rules; billed per sample."],
  ["operator", "Prometheus Operator", "kube-prometheus-stack, or anything reading its PodMonitors and PrometheusRules."],
  ["bundled", "The console chart’s own", "One Prometheus Pod and a volume, scraping only this namespace; without an Alertmanager, alerts show only on its own page."],
  ["amazon", "Amazon Managed Prometheus", "The bundled one writing to a workspace, its alerts to an SNS topic and an email."],
];
const SERIES = [
  "kernel_tasks",
  "kernel_oldest_ready_task_age_seconds",
  "console_rpc_requests_total",
  "console_catalog_syncs_total",
  "vertra_gateway_requests_total",
  "vertra_gateway_request_duration_seconds",
];

export function MetricsTab() {
  const [view, setView] = useState<MetricsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which Prometheus this install uses, and its Grafana: the install's settings, an admin's to read.
  const isAdmin = useAuth().user?.isAdmin ?? false;
  const [install, setInstall] = useState<InstallInfo | null>(null);
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    getInstall()
      .then((i) => {
        if (!cancelled) setInstall(i);
      })
      .catch(() => {
        /* the section says it's the admins' to say */
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    getMetrics()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Failed to load the metrics."));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hours = useMemo(
    () =>
      (view?.hours ?? []).map((h) => ({
        label: h.hour ? new Date(h.hour).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
        started: h.started,
        wait: h.waitP95Seconds,
      })),
    [view],
  );
  const started = view?.hours.reduce((n, h) => n + h.started, 0);
  const failed = view?.failures.reduce((n, f) => n + f.count, 0);
  const busiest = hours.reduce<(typeof hours)[number] | null>((b, h) => (h.started > (b?.started ?? 0) ? h : b), null);
  const longest = hours.reduce<(typeof hours)[number] | null>((b, h) => (h.wait > (b?.wait ?? 0) ? h : b), null);
  const most = Math.max(1, ...(view?.failures.map((f) => f.count) ?? []));
  const shown = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());

  return (
    <Stack spacing={2.5}>
      {error && <Alert severity="error">{error}</Alert>}
      <Box component="section" aria-label="Summary" sx={{ display: "grid", gap: 1.75, gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(auto-fit, minmax(200px, 1fr))" } }}>
        <MetricCard label="Waiting to start now" value={shown(view?.ready)} note={view && "ready, not yet running"} />
        <MetricCard label="Running now" value={shown(view?.running)} note={view && "steps started, or being started"} />
        <MetricCard
          label="Started, 24 hours"
          value={shown(started)}
          note={busiest ? `busiest hour ${busiest.label}, ${busiest.started.toLocaleString()} started` : undefined}
        />
        <MetricCard label="Failed attempts, 24 hours" value={shown(failed)} note={failed ? "by code below" : undefined} />
      </Box>

      <Box sx={{ display: "grid", gap: 2.5, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" } }}>
        <ChartCard
          title="Steps started, by hour"
          sub={busiest ? `Highest at ${busiest.label}, ${busiest.started.toLocaleString()} steps.` : "None started in the last 24 hours."}
          foot="Every attempt, retries included, over the last 24 hours."
        >
          <HourChart
            data={hours}
            dataKey="started"
            label="Started"
            format={(n) => n.toLocaleString()}
            summary={`Steps started each hour over the last 24 hours${busiest ? `; highest at ${busiest.label}` : ""}`}
          />
        </ChartCard>
        <ChartCard
          title="Wait to start, 95th percentile"
          sub={longest ? `Highest at ${longest.label}, ${duration(longest.wait)}.` : "No waits in the last 24 hours."}
          foot="From a step becoming ready to its Pod starting. A rising wait means the cluster or the scheduler is short of room."
        >
          <HourChart data={hours} dataKey="wait" label="Wait, p95" format={duration} summary="The 95th percentile wait from ready to running, each hour over the last 24 hours" />
        </ChartCard>
      </Box>

      <Box sx={{ display: "grid", gap: 2.5, alignItems: "start", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 3fr) minmax(0, 2fr)" } }}>
        <Card component="section" aria-label="Why steps failed" sx={{ px: 2.75, py: 2.5, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography variant="h6" component="h2">
            Why steps failed, last 24 hours
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13, mb: 1.25 }}>
            Each failed attempt by its code. A product&apos;s own codes are explained in its documentation.
          </Typography>
          {view?.failures.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ borderTop: 1, borderColor: "divider", pt: 1.25 }}>
              No failures.
            </Typography>
          )}
          {view?.failures.map((f) => (
            <Box
              key={f.code}
              sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr) 40px", sm: "minmax(0, 250px) minmax(0, 1fr) 40px" }, columnGap: 1.75, rowGap: 0.75, alignItems: "center", py: 1.125, borderTop: 1, borderColor: "divider" }}
            >
              <Mono sx={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.code || "(none)"}</Mono>
              <Box aria-hidden="true" sx={{ height: 12, display: { xs: "none", sm: "block" } }}>
                <Box sx={{ height: "100%", width: `${String((100 * f.count) / most)}%`, bgcolor: "primary.main", borderRadius: "0 4px 4px 0" }} />
              </Box>
              <Typography variant="body2" sx={{ textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {f.count.toLocaleString()}
              </Typography>
              <Typography variant="body2" sx={{ gridColumn: "1 / -1", fontSize: 12.5, lineHeight: 1.45 }}>
                {f.means || "—"}
                {f.retried && " Some were retried automatically."}
              </Typography>
            </Box>
          ))}
        </Card>
        <AlertsCard />
      </Box>

      <Card component="section" aria-label="Step times by product" sx={{ overflow: "hidden" }}>
        <Box sx={{ px: 2.75, pt: 2.25, pb: 1.5, display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 1.25, alignItems: "flex-end" }}>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
            <Typography variant="h6" component="h2">
              Step times by product, last 7 days
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
              How long each product&apos;s action runs once started, slowest first. The bar runs from the median to the 95th percentile, on a log
              scale.
            </Typography>
          </Box>
          <Box aria-hidden="true" sx={{ display: { xs: "none", md: "flex" }, alignItems: "center", gap: 1.75, fontSize: 12 }}>
            <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.75 }}>
              <Box component="i" sx={{ width: 3, height: 12, bgcolor: "text.primary", borderRadius: 0.5 }} />
              median
            </Box>
            <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.75 }}>
              <Box component="i" sx={{ width: 22, height: 8, bgcolor: "primary.light", opacity: 0.45, borderRadius: 1 }} />
              to the 95th percentile
            </Box>
          </Box>
        </Box>
        <Box sx={{ borderTop: 1, borderColor: "divider" }}>
          <DataTable
            columns={PRODUCTS}
            rows={view ? [...view.products].sort((a, b) => b.p95Seconds - a.p95Seconds) : null}
            getRowKey={(p) => `${p.team}/${p.product}/${p.action}`}
            emptyMessage="No steps this week."
          />
        </Box>
      </Card>

      <Card component="section" aria-label="Prometheus and Grafana" sx={{ p: 2.75, display: "flex", flexDirection: "column", gap: 1.75 }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, maxWidth: 780 }}>
          <Typography variant="h6" component="h2">
            Going deeper: Prometheus and Grafana
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            Every component serves <Mono sx={{ fontSize: 12 }}>/metrics</Mono> (kernel-api, the scheduler, the console, the gateway), open only to
            the Prometheus this install names. The charts load its alerts into that Prometheus, and the console chart ships a Grafana
            dashboard: steps, the console, the gateway.{" "}
            {!install
              ? "Which one this install uses, and where to find it, is your admins' to say."
              : install.monitoringProvider
                ? `This install uses ${install.monitoringProvider}.`
                : "This install has none: only these charts."}
          </Typography>
          {install?.grafanaUrl && (
            <Typography variant="body2" sx={{ fontSize: 13 }}>
              <Link href={install.grafanaUrl} target="_blank" rel="noopener noreferrer">
                Open its Grafana
              </Link>
            </Typography>
          )}
        </Box>
        <Box sx={{ display: "grid", gap: 1.25, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          {PROVIDERS.map(([key, title, text]) => (
            <Box
              key={key}
              aria-current={install?.monitoringProvider === key ? "true" : undefined}
              sx={{ display: "flex", flexDirection: "column", gap: 0.5, p: 1.75, borderRadius: 2, border: 1, borderColor: install?.monitoringProvider === key ? "primary.main" : "divider", bgcolor: "background.default" }}
            >
              <Mono sx={{ fontSize: 12.5, fontWeight: 500 }}>{key}</Mono>
              <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 500 }}>
                {title}
              </Typography>
              <Typography variant="caption" sx={{ lineHeight: 1.45 }}>
                {text}
              </Typography>
            </Box>
          ))}
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.75, fontSize: 12, color: "text.secondary" }}>
          For alerts and dashboards of your own:
          {SERIES.map((s) => (
            <Mono key={s} sx={{ fontSize: 11.5, color: "text.primary", bgcolor: "background.default", borderRadius: 1.5, px: 1, py: 0.375 }}>
              {s}
            </Mono>
          ))}
          <HelpLink guide="reference-operations" section="metrics-and-alerts" label="every metric, in Operations" />
        </Box>
      </Card>
    </Stack>
  );
}
