// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import InventoryIcon from "@mui/icons-material/Inventory2Outlined";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { LoadFailed, loadFailure } from "../components/LoadFailed";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { QuickTile, QuickTiles } from "../components/QuickTile";
import { StatusBadge } from "../components/StatusBadge";
import {
  ApiError,
  listAllTeams,
  listExecutions,
  listPendingApprovals,
  listSchedules,
  type ExecutionSummary,
  type PendingApproval,
  type Schedule,
} from "../api";
import { useAuth } from "../auth/AuthContext";
import { useEnvironment } from "../environment";
import { runningNow } from "../runningNow";
import { statusFill } from "../statusColor";
import { duration, when } from "../time";
import { RunsSchedules } from "./run/RunsSchedules";

const STATUS_OPTIONS = ["RUNNING", "AWAITING_APPROVAL", "PENDING", "FAILED", "SUCCEEDED", "CANCELLED"];
const PAGE_SIZE = 100;
/** The most of a week's runs the tiles count (the server's largest page). */
const WEEK_LIMIT = 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** How long typing pauses before the search goes to the server. */
const SEARCH_DELAY_MS = 300;
/** More steps than this show as one bar, not a segment each. */
const MAX_SEGMENTS = 12;
/** The order a run's steps are drawn in: done first, then what's moving. */
const STEP_ORDER = ["SUCCEEDED", "FAILED", "CANCELLED", "RUNNING", "CLAIMED", "AWAITING_APPROVAL"];

type View = "runs" | "approve" | "schedules";
type Whose = "all" | "mine";
type Kind = "template" | "action" | "order" | "dag" | "cleanup" | "preview";

const KINDS: [Kind, string][] = [
  ["template", "From a template"],
  ["action", "An action alone"],
  ["order", "An order"],
  ["dag", "A DAG"],
  ["cleanup", "A cleanup"],
  ["preview", "A preview"],
];

/** What kind of run it was, from what it ran. */
function kindOf(run: ExecutionSummary): Kind {
  if (run.template === "cleanup" || run.template === "preview" || run.template === "order") return run.template;
  if (!run.template) return "dag";
  return /^[a-z0-9-]+\/[a-z0-9-]+\.[a-z0-9-]+$/.test(run.template) ? "action" : "template";
}

/** What a run was: its template ("app-on-cloud-run · gcp-platform") or a DAG of its teams. */
function what(run: ExecutionSummary): string {
  if (run.template === "cleanup") return `Cleanup · ${run.teams.join(", ")}`;
  if (run.template === "preview") return `Preview · ${run.teams.join(", ")}`;
  if (run.template === "order") return `Order · ${run.teams.join(", ")}`;
  const slash = run.template.indexOf("/");
  if (slash > 0) return `${run.template.slice(slash + 1)} · ${run.template.slice(0, slash)}`;
  return `DAG · ${run.teams.join(", ")}`;
}

function took(run: ExecutionSummary, now: number): string {
  const start = Date.parse(run.createdAt);
  if (run.finishedAt) return duration(Date.parse(run.finishedAt) - start);
  if (run.state === "RUNNING" || run.state === "AWAITING_APPROVAL") return `${duration(now - start)} so far`;
  return "—";
}

/** "a", "a and b", "a, b and c". */
function listed(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** A run's steps as one segment each, colored by state, and "2 of 4" done. */
function Steps({ steps }: { steps: Record<string, number> }) {
  const theme = useTheme();
  const total = Object.values(steps).reduce((a, b) => a + b, 0);
  if (total === 0) return <Typography sx={{ fontSize: 13, color: "text.secondary" }}>—</Typography>;
  const done = steps["SUCCEEDED"] ?? 0;
  const ordered = [...STEP_ORDER, ...Object.keys(steps).filter((s) => !STEP_ORDER.includes(s))];
  const segments = ordered.flatMap((state) => Array.from({ length: steps[state] ?? 0 }, () => state));
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      <Box aria-hidden="true" sx={{ display: "flex", gap: "3px", width: total > MAX_SEGMENTS ? 80 : undefined }}>
        {total > MAX_SEGMENTS
          ? ordered
              .filter((state) => steps[state])
              .map((state) => (
                <Box key={state} sx={{ height: 8, borderRadius: "2px", flex: steps[state], bgcolor: statusFill(theme, state) }} />
              ))
          : segments.map((state, i) => (
              <Box key={i} sx={{ width: 14, height: 8, borderRadius: "2px", bgcolor: statusFill(theme, state), opacity: state === "PENDING" || state === "READY" || state === "BLOCKED" ? 0.45 : 1 }} />
            ))}
      </Box>
      <Typography component="span" sx={{ fontSize: 13, color: "text.primary", whiteSpace: "nowrap" }}>
        {done} of {total}
      </Typography>
    </Box>
  );
}

/** A tab's label with its count beside it, when there's one. */
function Counted({ label, count, tone }: { label: string; count: number | null; tone: "warning" | "neutral" }) {
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
      {label}
      {count !== null && count > 0 && <Pill tone={tone}>{count}</Pill>}
    </Box>
  );
}

/**
 * Runs you can see, newest first: from the console's record of who started
 * what (already scoped to the viewer), each with its state and steps from
 * kernel-api in bulk; the week's at a glance. To approve lists the steps
 * waiting for your team; Schedules, your teams' timetables.
 */
export function ExecutionsListPage() {
  const { user } = useAuth();
  const theme = useTheme();
  const environment = useEnvironment();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get("view");
  const view: View = requested === "approve" || requested === "schedules" ? requested : "runs";
  const setView = (next: View) => { setParams(next === "runs" ? {} : { view: next }, { replace: true }); };

  const [executions, setExecutions] = useState<ExecutionSummary[] | null>(null);
  const [week, setWeek] = useState<ExecutionSummary[] | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[] | null>(null);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whose, setWhose] = useState<Whose>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  // A week tile was pressed: the table shows that state over the week's runs
  // (those the tiles count), not over the pages loaded.
  const [fromTile, setFromTile] = useState(false);
  const [weekFailed, setWeekFailed] = useState<string | null>(null);
  const [approvalsFailed, setApprovalsFailed] = useState<string | null>(null);
  const [schedulesFailed, setSchedulesFailed] = useState<string | null>(null);
  // Each load's Try again: a new number loads it again.
  const [weekTry, setWeekTry] = useState(0);
  const [approvalsTry, setApprovalsTry] = useState(0);
  const [schedulesTry, setSchedulesTry] = useState(0);
  // Each new filter's number: a Load more for an older one is dropped.
  const listing = useRef(0);
  const [kindFilter, setKindFilter] = useState<Kind | "">("");
  const [allTeams, setAllTeams] = useState<string[]>([]);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); }, SEARCH_DELAY_MS);
    return () => { clearTimeout(timer); };
  }, [search]);

  // Whose, name and team are filtered on the server; a new filter starts over.
  useEffect(() => {
    let cancelled = false;
    listing.current += 1;
    setExecutions(null);
    setNextCursor(null);
    setLoadingMore(false);
    listExecutions({ limit: PAGE_SIZE, search: query, team: teamFilter, mine: whose === "mine" })
      .then((page) => {
        if (cancelled) return;
        setError(null);
        setExecutions(page.executions);
        setNextCursor(page.nextCursor);
        setRetentionDays(page.runRetentionDays);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Couldn't load the runs.");
      });
    return () => { cancelled = true; };
  }, [query, teamFilter, whose]);

  // The tiles: the week's runs, for whose and which team.
  useEffect(() => {
    let cancelled = false;
    setWeek(null);
    setWeekFailed(null);
    listExecutions({ limit: WEEK_LIMIT, since: new Date(now - WEEK_MS).toISOString(), team: teamFilter, mine: whose === "mine" })
      .then((page) => { if (!cancelled) setWeek(page.executions); })
      .catch((err: unknown) => { if (!cancelled) setWeekFailed(loadFailure(err)); }); // The tiles say —, and why above them.
    return () => { cancelled = true; };
  }, [now, teamFilter, whose, weekTry]);

  useEffect(() => {
    let cancelled = false;
    setApprovals(null);
    setApprovalsFailed(null);
    listPendingApprovals()
      .then((list) => { if (!cancelled) setApprovals(list.filter((a) => a.canDecide)); })
      .catch((err: unknown) => { if (!cancelled) setApprovalsFailed(loadFailure(err)); });
    return () => { cancelled = true; };
  }, [approvalsTry]);

  const teamNames = user?.teamNames;
  useEffect(() => {
    if (!teamNames) return;
    let cancelled = false;
    setSchedules(null);
    setSchedulesFailed(null);
    // Every team's or none: one team's left out would read as it having none.
    Promise.all(teamNames.map((team) => listSchedules(team)))
      .then((lists) => { if (!cancelled) setSchedules(lists.flat()); })
      .catch((err: unknown) => { if (!cancelled) setSchedulesFailed(loadFailure(err)); });
    return () => { cancelled = true; };
  }, [teamNames, schedulesTry]);

  useEffect(() => {
    if (!user?.isAdmin) return;
    listAllTeams()
      .then((teams) => { setAllTeams(teams.map((team) => team.name)); })
      .catch(() => { /* the filter offers the teams on the loaded runs */ });
  }, [user?.isAdmin]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    const mine = listing.current;
    setLoadingMore(true);
    try {
      const page = await listExecutions({ limit: PAGE_SIZE, cursor: nextCursor, search: query, team: teamFilter, mine: whose === "mine" });
      if (mine !== listing.current) return; // the filters changed meanwhile
      setExecutions((loaded) => [...(loaded ?? []), ...page.executions]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (mine === listing.current) setError(err instanceof ApiError ? err.message : "Couldn't load more runs.");
    } finally {
      if (mine === listing.current) setLoadingMore(false);
    }
  }

  // State comes from kernel-api per page, so it's filtered here, over what's loaded; kind too.
  const filtered = useMemo(() => {
    // A tile's state, over the week the tiles count (its search applied here: the week's list isn't searched).
    const source = fromTile && week ? week.filter((e) => !query || e.name.toLowerCase().includes(query.toLowerCase())) : executions;
    if (!source) return null;
    return source.filter((e) => (!statusFilter || e.state === statusFilter) && (!kindFilter || kindOf(e) === kindFilter));
  }, [executions, week, fromTile, query, statusFilter, kindFilter]);

  const tiles = useMemo(() => {
    // No week, or no run's state known (kernel-api didn't answer): no numbers, rather than zeros.
    if (!week || (week.length > 0 && week.every((e) => !e.state))) return null;
    const count = (state: string) => week.filter((e) => e.state === state).length;
    const running = week.filter((e) => e.state === "RUNNING");
    const longest = running.at(-1); // Newest first: the last started longest ago.
    const failed = count("FAILED");
    const succeeded = count("SUCCEEDED");
    const finished = week.filter((e) => e.finishedAt).length;
    return {
      running: running.length,
      runningNote: longest ? `longest: ${longest.name}, ${duration(now - Date.parse(longest.createdAt))}` : "none now",
      waiting: count("AWAITING_APPROVAL"),
      failed,
      succeeded,
      finished,
      more: week.length >= WEEK_LIMIT,
    };
  }, [week, now]);

  const teamOptions = user?.isAdmin
    ? Array.from(new Set([...allTeams, ...(executions?.flatMap((e) => e.teams) ?? [])])).sort()
    : (user?.teamNames ?? []);
  const open = (id: string) => { navigate(`/runs/${encodeURIComponent(id)}`); };
  const toApprove = approvals?.length ?? 0;
  // Yours is "you"; anyone else's by their email.
  // A readiness check (template "check") is the console's own run: no account's.
  const byWhom = (e: ExecutionSummary) =>
    e.template === "check" && !e.submittedBy ? "the readiness check" : !e.submittedBy ? "a deleted account" : e.submittedBy === user?.id ? "you" : e.submittedByEmail || "someone else";
  const toggleState = (state: string) => {
    const off = statusFilter === state && fromTile;
    setStatusFilter(off ? "" : state);
    setFromTile(!off);
  };
  const unknown = tiles === null && (weekFailed !== null || week !== null) ? "—" : "…";

  const columns: DataTableColumn<ExecutionSummary>[] = [
    {
      key: "run",
      header: "Run",
      render: (e) => (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
          <Link component={RouterLink} to={`/runs/${encodeURIComponent(e.executionId)}`} underline="hover" sx={{ fontWeight: 500 }} onClick={(event) => { event.stopPropagation(); }}>
            {e.name}
          </Link>
          <Typography component="span" sx={{ fontSize: 13, color: "text.secondary", overflowWrap: "anywhere" }}>
            {what(e)}
          </Typography>
        </Box>
      ),
    },
    { key: "state", header: "State", render: (e) => (e.state ? <StatusBadge status={e.state} /> : "—") },
    {
      key: "steps",
      header: "Steps",
      hideBelow: "sm",
      render: (e) => {
        const now = runningNow(e);
        return (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
            <Steps steps={e.steps} />
            {now && (
              <Typography component="span" sx={{ fontSize: 12, color: "text.secondary", overflowWrap: "anywhere" }}>
                Now: {now}
              </Typography>
            )}
          </Box>
        );
      },
    },
    { key: "started", header: "Started", hideBelow: "md", render: (e) => <Box sx={{ whiteSpace: "nowrap" }}>{when(e.createdAt)}</Box> },
    {
      key: "by",
      header: "By",
      hideBelow: "md",
      render: (e) => (
        <Box sx={{ overflowWrap: "anywhere" }}>
          {byWhom(e)}
          {e.schedule && (
            <Typography component="span" sx={{ display: "block", fontSize: 13, color: "text.secondary" }}>
              on the schedule {e.schedule}
            </Typography>
          )}
        </Box>
      ),
    },
    { key: "took", header: "Took", hideBelow: "md", render: (e) => <Box sx={{ whiteSpace: "nowrap" }}>{took(e, now)}</Box> },
  ];

  const approvalColumns: DataTableColumn<PendingApproval>[] = [
    {
      key: "run",
      header: "Run",
      render: (a) => (
        <Link component={RouterLink} to={`/runs/${encodeURIComponent(a.executionId)}`} underline="hover" sx={{ fontWeight: 500 }} onClick={(event) => { event.stopPropagation(); }}>
          {a.executionName}
        </Link>
      ),
    },
    { key: "step", header: "Step", render: (a) => `${a.taskId} · ${a.team}` },
    { key: "by", header: "Asked by", hideBelow: "sm", render: (a) => a.requestedBy },
    { key: "since", header: "Waiting since", hideBelow: "md", render: (a) => (a.awaitingSince ? when(a.awaitingSince) : "—") },
  ];

  const fieldSx = { bgcolor: "background.paper", "& .MuiInputBase-root": { minHeight: 40 } };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <PageHeader
        title="Runs"
        help={{ guide: "09-runs-explained", label: "Runs, explained" }}
        subtitle="Runs you started, your teams', and any that ran your teams' steps: their state, their steps, and what waits for your team to approve."
        action={
          <Box sx={{ display: "flex", gap: 1.25, flexWrap: "wrap" }}>
            <Button variant="outlined" size="large" startIcon={<InventoryIcon />} component={RouterLink} to="/runs/made">
              What runs made
            </Button>
            <Button variant="outlined" size="large" component={RouterLink} to="/runs/submit">
              Submit a DAG
            </Button>
            <Button variant="contained" size="large" component={RouterLink} to="/catalog">
              Run something
            </Button>
          </Box>
        }
      />

      <Tabs
        value={view}
        onChange={(_event, value: View) => { setView(value); }}
        aria-label="Runs views"
        variant="scrollable"
        allowScrollButtonsMobile
        sx={{ mt: -3 }}
      >
        <Tab value="runs" label="Runs" />
        <Tab value="approve" label={<Counted label="To approve" count={approvals === null ? null : toApprove} tone="warning" />} />
        <Tab value="schedules" label={<Counted label="Schedules" count={schedules === null ? null : schedules.length} tone="neutral" />} />
      </Tabs>

      {error && <Alert severity="error">{error}</Alert>}
      {approvalsFailed && view !== "schedules" && (
        <LoadFailed what="the steps waiting for your approval" reason={approvalsFailed} onRetry={() => { setApprovalsTry((n) => n + 1); }} />
      )}

      {view === "runs" && (
        <>
          {approvals && toApprove > 0 && (
            <Alert
              severity="warning"
              role="status"
              action={
                <Button color="inherit" variant="outlined" onClick={() => { setView("approve"); }}>
                  Review {toApprove === 1 ? "it" : "them"}
                </Button>
              }
            >
              {toApprove === 1 ? "A step waits" : `${String(toApprove)} steps wait`} for an approval you can give:{" "}
              {listed(approvals.slice(0, 3).map((a) => `${a.executionName} (${a.team})`))}
              {toApprove > 3 ? ` and ${String(toApprove - 3)} more` : ""}.
            </Alert>
          )}

          {weekFailed && !error && <LoadFailed what="this week's runs" reason={weekFailed} onRetry={() => { setWeekTry((n) => n + 1); }} />}
          <QuickTiles label="This week at a glance">
            <QuickTile
              label="Running"
              value={tiles?.running ?? unknown}
              note={tiles?.runningNote}
              dot={theme.palette.primary.main}
              pressed={statusFilter === "RUNNING"}
              onClick={() => { toggleState("RUNNING"); }}
            />
            <QuickTile
              label="Waiting for approval"
              value={tiles?.waiting ?? unknown}
              note={approvals ? (toApprove > 0 ? `${String(toApprove)} ${toApprove === 1 ? "step" : "steps"} you can decide` : "no step you can decide") : undefined}
              dot={statusFill(theme, "AWAITING_APPROVAL")}
              pressed={statusFilter === "AWAITING_APPROVAL"}
              onClick={() => { toggleState("AWAITING_APPROVAL"); }}
            />
            <QuickTile
              label="Failed this week"
              value={tiles?.failed ?? unknown}
              note={tiles && `of ${String(tiles.finished)} finished${tiles.more ? ", in the latest 1000" : ""}`}
              dot={theme.palette.error.main}
              pressed={statusFilter === "FAILED"}
              onClick={() => { toggleState("FAILED"); }}
            />
            <QuickTile
              label="Succeeded this week"
              value={tiles?.succeeded ?? unknown}
              note={tiles && (tiles.finished > 0 ? `${String(Math.round((tiles.succeeded / tiles.finished) * 100))}% of those finished` : "none finished yet")}
              dot={theme.palette.success.main}
              pressed={statusFilter === "SUCCEEDED"}
              onClick={() => { toggleState("SUCCEEDED"); }}
            />
          </QuickTiles>

          <Box sx={{ display: "flex", gap: 1.25, flexWrap: "wrap", alignItems: "center" }}>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={whose}
              onChange={(_, value: Whose | null) => { if (value) setWhose(value); }}
              aria-label="Whose runs"
              sx={{ bgcolor: "background.paper", "& .MuiToggleButton-root": { px: 1.75, minHeight: 40 } }}
            >
              <ToggleButton value="mine">Mine</ToggleButton>
              <ToggleButton value="all">All I can see</ToggleButton>
            </ToggleButtonGroup>
            <FormControl size="small" sx={{ minWidth: 150, ...fieldSx }}>
              <InputLabel id="team-filter-label">Team</InputLabel>
              <Select labelId="team-filter-label" label="Team" value={teamFilter} onChange={(event) => { setTeamFilter(event.target.value); }}>
                <MenuItem value="">Any team</MenuItem>
                {teamOptions.filter(Boolean).map((team) => (
                  <MenuItem key={team} value={team}>
                    {team}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 150, ...fieldSx }}>
              <InputLabel id="status-filter-label">State</InputLabel>
              <Select labelId="status-filter-label" label="State" value={statusFilter} onChange={(event) => { setFromTile(false); setStatusFilter(event.target.value); }}>
                <MenuItem value="">Any state</MenuItem>
                {STATUS_OPTIONS.map((status) => (
                  <MenuItem key={status} value={status}>
                    <StatusBadge status={status} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 150, ...fieldSx }}>
              <InputLabel id="kind-filter-label">Kind</InputLabel>
              <Select labelId="kind-filter-label" label="Kind" value={kindFilter} onChange={(event) => { setKindFilter(event.target.value as Kind | ""); }}>
                <MenuItem value="">Any kind</MenuItem>
                {KINDS.map(([kind, label]) => (
                  <MenuItem key={kind} value={kind}>
                    {label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              size="small"
              placeholder="Find a run by name"
              slotProps={{ htmlInput: { "aria-label": "Find a run" } }}
              value={search}
              onChange={(event) => { setSearch(event.target.value); }}
              sx={{ flex: "1 1 240px", minWidth: 0, ...fieldSx }}
            />
          </Box>

          <Card component="section" aria-labelledby="runs-heading">
            <Box sx={{ px: 2.5, pt: 2, pb: 0.75, display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
              <Typography id="runs-heading" variant="h6" component="h2">
                {whose === "mine" ? "Your runs" : "All you can see"}
              </Typography>
              {executions && (
                <Typography variant="body2" color="text.secondary">
                  Newest first · {filtered && filtered.length !== executions.length ? `${String(filtered.length)} shown of ` : ""}
                  {executions.length} loaded{nextCursor ? ", more to load" : ""}
                </Typography>
              )}
            </Box>
            <DataTable
              columns={columns}
              rows={filtered}
              getRowKey={(e) => e.executionId}
              onRowClick={(e) => { open(e.executionId); }}
              emptyMessage={
                executions && executions.length > 0
                  ? "No runs match these filters."
                  : whose === "mine"
                    ? "You haven't started a run yet. Find something to run in the Catalog."
                    : "No runs you can see yet: they're your own, your teams', and any that used your teams' steps."
              }
            />
          </Card>
          {(retentionDays !== null || nextCursor) && (
            <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 1.25, mt: -1.5 }}>
              <Typography variant="caption" color="text.secondary">
                {retentionDays !== null &&
                  `Runs are kept ${retentionDays > 0 ? `${String(retentionDays)} days` : "with no time limit"}${environment?.label ? ` on ${environment.label}` : ""}. What they made is kept until it's deleted.`}
              </Typography>
              {nextCursor && !fromTile && (
                <Button variant="outlined" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              )}
            </Box>
          )}
        </>
      )}

      {view === "approve" && !approvalsFailed && (
        <Card>
          <DataTable
            columns={approvalColumns}
            rows={approvals}
            getRowKey={(a) => `${a.executionId}/${a.taskId}`}
            onRowClick={(a) => { open(a.executionId); }}
            emptyMessage="Nothing waits for your teams to approve."
          />
        </Card>
      )}

      {view === "schedules" && schedulesFailed && (
        <LoadFailed what="your teams' schedules" reason={schedulesFailed} onRetry={() => { setSchedulesTry((n) => n + 1); }} />
      )}
      {view === "schedules" && !schedulesFailed && (
        <RunsSchedules
          schedules={schedules}
          onSaved={(saved) => { setSchedules((current) => current?.map((s) => (s.id === saved.id ? saved : s)) ?? null); }}
        />
      )}
    </Box>
  );
}
