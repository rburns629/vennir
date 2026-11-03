// SPDX-License-Identifier: MIT
import { Fragment, useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { MetricCard } from "../../components/MetricCard";
import { Mono } from "../../components/Mono";
import { errorMessage, getUsage, listAllTeams, type ProductUsageView, type TeamUsageView, type UsageView } from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { when } from "../../time";
import { countsText, PERIOD, startedBy, usageTeam } from "../../usageText";

type Days = 1 | 7 | 30;
type By = "team" | "product";

/** A count with a bar for its size against the largest, as Metrics draws failures. */
function Sized({ n, most, label }: { n: number; most: number; label: string }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, minWidth: 140 }}>
      <Typography variant="body2" sx={{ width: 48, flex: "0 0 auto", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {n.toLocaleString()}
      </Typography>
      <Box title={label} sx={{ flex: "1 1 auto", height: 10 }}>
        <Box sx={{ height: "100%", width: `${String((100 * n) / Math.max(1, most))}%`, bgcolor: "primary.main", borderRadius: "0 4px 4px 0" }} />
      </Box>
    </Box>
  );
}

function teamColumns(most: number): DataTableColumn<TeamUsageView>[] {
  return [
    {
      key: "team",
      header: "Team",
      render: (t) =>
        t.team ? (
          <Link component={RouterLink} to={`/teams/${encodeURIComponent(t.team)}`} sx={{ fontWeight: 500, whiteSpace: "nowrap" }}>
            {t.team}
          </Link>
        ) : (
          <Typography variant="body2" sx={{ fontStyle: "italic", color: "text.secondary" }}>
            No team
          </Typography>
        ),
    },
    { key: "runs", header: "Runs started", render: (t) => <Sized n={t.runs} most={most} label={`${t.runs.toLocaleString()} runs started for ${usageTeam(t.team)}`} /> },
    { key: "by", header: "Started by", hideBelow: "md", render: (t) => <Box sx={{ whiteSpace: "nowrap" }}>{startedBy(t) || "—"}</Box> },
    { key: "steps", header: "Steps", align: "right", hideBelow: "sm", render: (t) => t.steps.toLocaleString() },
    {
      key: "used",
      header: "Products it used",
      hideBelow: "md",
      render: (t) => (
        <Box sx={{ lineHeight: 1.6 }}>
          {t.used.slice(0, 3).map((u) => (
            <Box component="span" key={u.name} sx={{ display: "inline-block", mr: 1.25, whiteSpace: "nowrap" }}>
              <Mono sx={{ fontSize: 12 }}>{u.name}</Mono>{" "}
              <Box component="span" sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
                ×{u.count.toLocaleString()}
              </Box>
            </Box>
          ))}
          {t.used.length > 3 && (
            <Box component="span" sx={{ color: "text.secondary" }}>
              +{t.used.length - 3} more
            </Box>
          )}
          {t.used.length === 0 && "—"}
        </Box>
      ),
    },
    { key: "ranFor", header: "Its products ran for", hideBelow: "md", render: (t) => <Box sx={{ minWidth: 180 }}>{countsText(t.ranFor, t.team) || "—"}</Box> },
  ];
}

function productColumns(most: number): DataTableColumn<ProductUsageView>[] {
  return [
    {
      key: "product",
      header: "Product",
      render: (p) => (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
          {p.registered ? (
            <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
              {p.product}
            </Typography>
          ) : (
            <Mono sx={{ fontSize: 12, overflowWrap: "anywhere" }}>{p.product}</Mono>
          )}
          <Typography variant="caption" color="text.secondary">
            {p.registered ? `${p.team} · ${p.action}` : `not a registered product · ran in ${p.team}`}
          </Typography>
        </Box>
      ),
    },
    { key: "steps", header: "Steps", render: (p) => <Sized n={p.steps} most={most} label={`${p.steps.toLocaleString()} steps of ${p.product}`} /> },
    { key: "runs", header: "Runs", align: "right", hideBelow: "sm", render: (p) => p.runs.toLocaleString() },
    { key: "usedBy", header: "Used by", hideBelow: "md", render: (p) => countsText(p.usedBy, undefined, 5) },
    { key: "last", header: "Last used", hideBelow: "sm", render: (p) => (p.lastUsed ? when(p.lastUsed) : "—") },
  ];
}

/**
 * Observe's Usage tab: who ran what over the last day, week or month, by
 * team or by product, from the console's own record of runs (so it works
 * without Prometheus). An admin sees every team; anyone else their own.
 */
export function UsageTab() {
  const { user } = useAuth();
  const isAdmin = user?.isAdmin ?? false;
  const [days, setDays] = useState<Days>(7);
  const [by, setBy] = useState<By>("team");
  const [view, setView] = useState<UsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTeams, setActiveTeams] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    getUsage(days)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Failed to load the usage."));
      });
    return () => {
      cancelled = true;
    };
  }, [days]);
  useEffect(() => {
    if (!isAdmin) return;
    // Display only: without it the tile leaves out "of N".
    listAllTeams()
      .then((all) => { setActiveTeams(all.filter((t) => !t.retiredAt).map((t) => t.name)); })
      .catch(() => undefined);
  }, [isAdmin]);

  const period = PERIOD[days];
  const runs = view?.runs;
  const previous = view?.previousRuns;
  const steps = view?.steps;
  // Of the teams there are now: an admin's every active team, anyone else's own.
  const active = isAdmin ? activeTeams : (user?.teamNames ?? null);
  const ran = view?.teams.filter((t) => t.team && t.runs > 0 && (!active || active.includes(t.team))).length;
  const of = active?.length ?? null;
  const registered = view?.products.filter((p) => p.registered).length;
  const images = view ? view.products.length - (registered ?? 0) : 0;
  const shown = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());
  // A team that started nothing this period still shows when its products ran.
  const teamRows = view ? view.teams.filter((t) => t.runs > 0 || t.ranFor.length > 0) : null;
  const productRows = view?.products ?? null;

  return (
    <Stack spacing={2.5}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 1.5 }}>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13, maxWidth: 760 }}>
          Who ran what, from the console&apos;s own record of every run, so it needs no Prometheus. A run counts for the team it was started for.{" "}
          {isAdmin ? "As an admin you see every team." : "You see the teams you're in, who used their products, and their use of others'."}
        </Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5 }}>
          <ToggleButtonGroup
            exclusive
            size="small"
            aria-label="Show"
            value={by}
            onChange={(_e, value: By | null) => {
              if (value) setBy(value);
            }}
            sx={{ bgcolor: "background.paper", "& .MuiToggleButton-root": { minHeight: 40, px: 1.75 } }}
          >
            <ToggleButton value="team">By team</ToggleButton>
            <ToggleButton value="product">By product</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            exclusive
            size="small"
            aria-label="Period"
            value={days}
            onChange={(_e, value: Days | null) => {
              if (value) setDays(value);
            }}
            sx={{ bgcolor: "background.paper", "& .MuiToggleButton-root": { minHeight: 40, px: 1.75 } }}
          >
            {([1, 7, 30] as const).map((d) => (
              <ToggleButton key={d} value={d}>
                {PERIOD[d].label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      <Box component="section" aria-label={`The last ${period.label}`} sx={{ display: "grid", gap: 1.75, gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(auto-fit, minmax(200px, 1fr))" } }}>
        <MetricCard
          label="Runs started"
          value={shown(runs)}
          note={view && (runs === previous ? `the same as ${period.before}` : `${(runs ?? 0) > (previous ?? 0) ? "up" : "down"} from ${(previous ?? 0).toLocaleString()} ${period.before}`)}
        />
        <MetricCard label="Steps" value={shown(steps)} note={view && "in those runs, retries not counted"} />
        <MetricCard label="Teams that ran something" value={ran === undefined ? "—" : of ? `${String(ran)} of ${String(of)}` : String(ran)} />
        <MetricCard
          label="Products used"
          value={shown(registered)}
          note={images > 0 ? `and ${String(images)} ${images === 1 ? "image that isn't a product" : "images that aren't products"}` : undefined}
        />
      </Box>

      <Card component="section" aria-labelledby="usage-table" sx={{ overflow: "hidden" }}>
        <Box sx={{ px: 2.75, pt: 2.25, pb: 1.5, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography id="usage-table" variant="h6" component="h2">
            {by === "team" ? "By team" : "By product"}, last {period.label}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            {by === "team"
              ? "Runs each team started, who started them, the products its runs used, and the teams its own products ran for. Busiest first."
              : "Each product's steps and the teams whose runs used it, most used first. An image that isn't a registered product shows by its repository."}
          </Typography>
        </Box>
        <Box sx={{ borderTop: 1, borderColor: "divider" }}>
          {by === "team" ? (
            <DataTable
              columns={teamColumns(Math.max(0, ...(teamRows ?? []).map((t) => t.runs)))}
              rows={teamRows}
              getRowKey={(t) => t.team || "(none)"}
              emptyMessage={`No runs in the last ${period.label}.`}
            />
          ) : (
            <DataTable
              columns={productColumns(Math.max(0, ...(productRows ?? []).map((p) => p.steps)))}
              rows={productRows}
              getRowKey={(p) => `${p.team}/${p.product}/${p.action}`}
              emptyMessage={`No steps in the last ${period.label}.`}
            />
          )}
        </Box>
        {by === "team" && (
          <Typography variant="caption" component="p" color="text.secondary" sx={{ px: 2.75, py: 1.5, m: 0 }}>
            Steps count every step of those runs, wherever it ran. A raw DAG across several teams counts for each, and once in the totals above. A step is a product&apos;s only when it ran in its team&apos;s namespace.{" "}
            {isAdmin && (
              <Fragment>
                A run someone started for no team shows under No team.{" "}
              </Fragment>
            )}
            How runs ended is on{" "}
            <Link component={RouterLink} to="/observe?tab=metrics">
              Metrics
            </Link>
            .
          </Typography>
        )}
      </Card>
    </Stack>
  );
}
