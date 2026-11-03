// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AdminIcon from "@mui/icons-material/VerifiedUserOutlined";
import CartIcon from "@mui/icons-material/ShoppingCartOutlined";
import ChatIcon from "@mui/icons-material/ChatBubbleOutlineOutlined";
import CheckIcon from "@mui/icons-material/CheckCircleOutlined";
import ComposeIcon from "@mui/icons-material/AccountTreeOutlined";
import ObserveIcon from "@mui/icons-material/InsightsOutlined";
import WarningIcon from "@mui/icons-material/WarningAmberOutlined";
import {
  errorMessage,
  getApiTraffic,
  getCatalogStatus,
  getChatSettings,
  getMetrics,
  getSecurity,
  listApis,
  listDeleteRequests,
  listDrafts,
  listExecutions,
  listNotifications,
  listPendingApprovals,
  listProducts,
  listResources,
  listRunnables,
  listSchedules,
  markNotificationsRead,
  type ApiProduct,
  type ApiTraffic,
  type CatalogStatus,
  type DeleteRequest,
  type ExecutionSummary,
  type MadeResource,
  type MetricsView,
  type Notification,
  type PendingApproval,
  type Product,
  type Runnable,
  type Schedule,
  type SecurityView,
  type StoredDraft,
} from "../api";
import { useAuth } from "../auth/AuthContext";
import { cart, useCart } from "../cart";
import { HelpLink } from "../components/HelpLink";
import { Panel } from "../components/Panel";
import { Pill, type PillTone } from "../components/Pill";
import { ResourceState } from "../components/ResourceTable";
import { StatusBadge } from "../components/StatusBadge";
import { readinessSentence } from "../components/ReadinessNote";
import { useEnvironment } from "../environment";
import { imageName, imageVersion } from "../imageRef";
import { useAsk } from "../layout/ask";
import { runProgress, stepsDone } from "../runningNow";
import { duration, useNow, when } from "../time";
import { runLink } from "./RunFormPage";

const DAYS = 14;
const WEEK_MS = 7 * 86_400_000;
const LIVE = new Set(["RUNNING", "PENDING", "AWAITING_APPROVAL"]);

function greeting(hour: number): string {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** Midnight, local time, `days` ago. */
function dayStart(daysAgo: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

/** What a run was: its template or action, else a DAG. */
function kindOf(run: ExecutionSummary): string {
  return run.template || "DAG";
}

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * One thing Home shows, fetched on its own: undefined while it loads, null
 * when it couldn't be (or isn't for this person). A panel that fails is
 * left out; the rest of Home still shows.
 */
function useLoaded<T>(load: (() => Promise<T>) | null): [T | null | undefined, () => void] {
  const [value, setValue] = useState<T | null | undefined>(load ? undefined : null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!load) return;
    let current = true;
    load()
      .then((v) => { if (current) setValue(v); })
      .catch(() => { if (current) setValue(null); });
    return () => {
      current = false;
    };
    // The loader is fixed for the page; n reloads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  return [value, useCallback(() => { setN((x) => x + 1); }, [])];
}

/** A row in a list that leads somewhere: the whole row is the link. */
function RowLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Box
      component={RouterLink}
      to={to}
      sx={{ display: "flex", gap: 1.5, textDecoration: "none", color: "inherit", borderRadius: "6px", mx: -0.75, px: 0.75, py: 1.25, minHeight: 44, "&:hover": { bgcolor: "background.default" } }}
    >
      {children}
    </Box>
  );
}

/** Rows divided by hairlines. */
function List({ children }: { children: ReactNode }) {
  return <Box sx={{ display: "flex", flexDirection: "column", "& > * + *": { borderTop: 1, borderColor: "tint.rule" } }}>{children}</Box>;
}

const Muted = ({ children }: { children: ReactNode }) => (
  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
    {children}
  </Typography>
);

/** Your runs a day over the last two weeks: a bar a day, today's darker, failures red at its top. */
function RunsByDay({ runs }: { runs: ExecutionSummary[] }) {
  const days = useMemo(() => {
    const counts = Array.from({ length: DAYS }, (_, i) => ({ start: dayStart(DAYS - 1 - i), n: 0, failed: 0 }));
    for (const run of runs) {
      const at = Date.parse(run.createdAt);
      const day = counts.findLast((d) => at >= d.start.getTime());
      if (day) {
        day.n += 1;
        if (run.state === "FAILED") day.failed += 1;
      }
    }
    return counts;
  }, [runs]);
  const most = Math.max(1, ...days.map((d) => d.n));
  const label = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });
  const tip = (d: (typeof days)[number]) => `${label(d.start)}: ${plural(d.n, "run")}${d.failed ? `, ${String(d.failed)} failed` : ""}`;
  return (
    <Box>
      <Box
        role="img"
        aria-label={`Your runs a day for ${String(DAYS)} days. ${days.map(tip).join("; ")}`}
        sx={(t) => ({
          display: "flex",
          alignItems: "flex-end",
          gap: "6px",
          height: 96,
          borderBottom: 1,
          borderColor: "tint.field",
          background: `linear-gradient(${t.palette.tint.rule} 1px, transparent 1px) 0 0 / 100% 48px`,
        })}
      >
        {days.map((d, i) => (
          <Box
            key={d.start.toISOString()}
            title={tip(d)}
            sx={{
              flex: "1 1 0",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              height: `${String(d.n ? Math.max(6, (d.n / most) * 100) : 2)}%`,
              borderRadius: "4px 4px 0 0",
              bgcolor: i === DAYS - 1 ? "primary.main" : d.n ? "sidebar.accent" : "divider",
            }}
          >
            {d.failed > 0 && <Box sx={{ height: `${String((d.failed / d.n) * 100)}%`, bgcolor: "error.main" }} />}
          </Box>
        ))}
      </Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", mt: 0.75 }}>
        <Typography variant="caption" color="text.secondary">
          {days[0] ? label(days[0].start) : ""}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {days[7] ? label(days[7].start) : ""}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Today
        </Typography>
      </Box>
    </Box>
  );
}

/** Something waiting on you, a card in Needs you. */
interface Need {
  key: string;
  kind: string;
  title: string;
  text: string;
  cta: string;
  to: string;
}

function needsOf(approvals: PendingApproval[], deletes: DeleteRequest[], schedules: Schedule[], maintainerOf: string[]): Need[] {
  const out: Need[] = approvals.map((a) => ({
    key: `a:${a.executionId}/${a.taskId}`,
    kind: `Approval · ${a.team}`,
    title: a.executionName,
    text: `${a.requestedBy || "Someone"} asked to run ${a.taskId}${a.action ? ` (${a.action})` : ""} for ${a.team}${a.awaitingSince ? `, ${when(a.awaitingSince)}` : ""}.`,
    cta: "Review it",
    to: `/runs/${encodeURIComponent(a.executionId)}`,
  }));
  const waiting = deletes.filter((d) => d.decision === null);
  if (waiting.length > 0) {
    const names = waiting.flatMap((d) => d.resources.map((r) => r.name ?? r.externalId));
    out.push({
      key: "deletes",
      kind: "Delete requests · admin",
      title: `${plural(waiting.length, "delete")} ${waiting.length === 1 ? "waits" : "wait"} for an admin`,
      text: `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${String(names.length - 3)} more` : ""}: other resources still use them.`,
      cta: "Decide",
      to: "/runs/made",
    });
  }
  for (const s of schedules.filter((x) => x.enabled && x.lastError && maintainerOf.includes(x.team))) {
    out.push({
      key: `s:${s.id}`,
      kind: `Schedule · ${s.team}`,
      title: `${s.name} didn't start`,
      text: `${s.lastError ?? ""}${s.nextRunAt ? ` Next try ${when(s.nextRunAt)}.` : ""}`,
      cta: "Open the schedule",
      to: `/teams/${encodeURIComponent(s.team)}?tab=schedules`,
    });
  }
  return out;
}

function NeedsYou({ needs }: { needs: Need[] | null }) {
  return (
    <Panel
      tone="warning"
      icon={<WarningIcon sx={{ color: "warning.main" }} />}
      title={
        <>
          Needs you
          {needs && needs.length > 0 && <Pill tone="warning">{needs.length}</Pill>}
        </>
      }
      action={
        <Link component={RouterLink} to="/runs" variant="body2">
          All runs
        </Link>
      }
    >
      {needs === null ? (
        <Skeleton variant="rounded" height={64} />
      ) : needs.length === 0 ? (
        <Typography variant="body2">Nothing waits for you.</Typography>
      ) : (
        <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" } }}>
          {needs.map((n) => (
            <Box
              component="article"
              key={n.key}
              sx={{ bgcolor: "background.paper", border: 1, borderColor: "tint.warningBorder", borderRadius: 2, px: 2, py: 1.75, display: "flex", flexDirection: "column", gap: 0.75, fontSize: 13, lineHeight: 1.45, minWidth: 0 }}
            >
              <Typography sx={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: "uppercase", color: "warning.main" }}>{n.kind}</Typography>
              <Typography sx={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{n.title}</Typography>
              <Typography variant="body2" sx={{ fontSize: 13, overflowWrap: "anywhere" }}>
                {n.text}
              </Typography>
              <Button variant="outlined" size="small" component={RouterLink} to={n.to} sx={{ alignSelf: "flex-start", mt: "auto", minHeight: 36 }}>
                {n.cta}
              </Button>
            </Box>
          ))}
        </Box>
      )}
    </Panel>
  );
}

function RunningNow({ live, now }: { live: ExecutionSummary[] | null; now: number }) {
  return (
    <Panel
      icon={<Box component="span" aria-hidden="true" sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: "primary.main", display: "inline-block" }} />}
      title="Running now, yours and your teams'"
      action={
        <Link component={RouterLink} to="/runs" variant="body2">
          All runs
        </Link>
      }
    >
      {live === null && <Skeleton variant="rounded" height={64} />}
      {live?.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Nothing of yours or your teams' is running. <Link component={RouterLink} to="/catalog">Find something to run</Link>.
        </Typography>
      )}
      {live?.map((r) => {
        const { done, total } = stepsDone(r);
        const waiting = r.state === "AWAITING_APPROVAL";
        return (
          <Box
            key={r.executionId}
            component={RouterLink}
            to={`/runs/${encodeURIComponent(r.executionId)}`}
            sx={{ display: "flex", flexDirection: "column", gap: 1, px: 1.75, py: 1.5, border: 1, borderColor: "tint.rule", borderRadius: 2, textDecoration: "none", color: "inherit", "&:hover": { borderColor: "tint.infoBorder" } }}
          >
            <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 1 }}>
              <Typography sx={{ fontWeight: 500, fontSize: 14, overflowWrap: "anywhere" }}>{r.name}</Typography>
              <Typography variant="caption" color="text.secondary">
                {kindOf(r)} · {r.teams.join(", ")} · {duration(now - Date.parse(r.createdAt))}
              </Typography>
            </Box>
            <Box sx={{ height: 6, borderRadius: 3, bgcolor: "divider", overflow: "hidden" }} aria-hidden="true">
              <Box sx={{ height: "100%", width: `${String(total ? Math.max(6, (done / total) * 100) : 6)}%`, bgcolor: waiting ? "warning.main" : "primary.main", borderRadius: 3 }} />
            </Box>
            <Typography variant="caption">
              {waiting ? "Waiting for an approval" : runProgress(r)}
            </Typography>
          </Box>
        );
      })}
    </Panel>
  );
}

function YourRuns({ runs }: { runs: ExecutionSummary[] | null }) {
  const finished = (runs ?? []).filter((r) => r.state === "SUCCEEDED" || r.state === "FAILED");
  const failed = finished.filter((r) => r.state === "FAILED").length;
  const recent = (runs ?? []).filter((r) => r.state && !LIVE.has(r.state)).slice(0, 4);
  return (
    <Panel
      title="Your runs, last 14 days"
      action={
        runs && (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            {plural(runs.length, "run")}
            {finished.length > 0 && ` · ${String(Math.round(((finished.length - failed) / finished.length) * 100))}% succeeded · ${String(failed)} failed`}
          </Typography>
        )
      }
    >
      {runs === null ? <Skeleton variant="rounded" height={120} /> : <RunsByDay runs={runs} />}
      {recent.length > 0 && (
        <List>
          {recent.map((r) => (
            <RowLink key={r.executionId} to={`/runs/${encodeURIComponent(r.executionId)}`}>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0, flex: "1 1 auto" }}>
                <Typography sx={{ fontWeight: 500, fontSize: 13, color: "primary.main", overflowWrap: "anywhere" }}>{r.name}</Typography>
                <Muted>
                  {kindOf(r)} · {r.teams.join(", ")}
                </Muted>
              </Box>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flex: "0 0 auto" }}>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13, whiteSpace: "nowrap", display: { xs: "none", sm: "block" } }}>
                  {when(r.finishedAt ?? r.createdAt)}
                </Typography>
                {r.state && <StatusBadge status={r.state} />}
              </Box>
            </RowLink>
          ))}
        </List>
      )}
    </Panel>
  );
}

/** What was made for your teams or for you alone (the list has more: a product team's, or every one for an admin). */
function WhatYouMade({ resources, teams, email }: { resources: MadeResource[]; teams: string[]; email: string }) {
  const yours = (r: MadeResource) => (r.ownerTeam ? teams.includes(r.ownerTeam) : r.ownerEmail === email);
  const live = resources.filter((r) => r.state !== "deleted" && yours(r)).sort((a, b) => b.firstReportedAt.localeCompare(a.firstReportedAt));
  if (live.length === 0) return null;
  const names = (refs: { name: string | null; externalId: string }[]) => refs.map((x) => x.name ?? x.externalId).join(", ");
  return (
    <Panel
      title="What your runs made"
      action={
        <Link component={RouterLink} to="/runs/made" variant="body2">
          All {live.length}, and deleting them
        </Link>
      }
    >
      <Muted>As each product reported it, for your teams and for you. Kept after the runs are gone.</Muted>
      <List>
        {live.slice(0, 5).map((r) => (
          <Box key={r.id} sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr) auto", sm: "minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto" }, gap: 1.5, alignItems: "center", py: 1.25, fontSize: 13 }}>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 500, fontSize: 13, overflowWrap: "anywhere" }}>{r.name ?? r.externalId}</Typography>
              <Typography sx={{ fontFamily: "fontFamilyMono", fontSize: 12, color: "text.secondary", overflowWrap: "anywhere" }}>{r.type}</Typography>
              {r.dependsOn.length > 0 && <Muted>Uses {names(r.dependsOn)}</Muted>}
              {r.dependents.length > 0 && <Muted>Used by {names(r.dependents)}</Muted>}
            </Box>
            <Typography variant="body2" sx={{ fontSize: 13, display: { xs: "none", sm: "block" } }}>
              {r.ownerTeam ?? (r.ownerEmail === email ? "you alone" : r.ownerEmail)}
            </Typography>
            <Link component={RouterLink} to="/products" variant="body2" sx={{ fontSize: 13, display: { xs: "none", sm: "block" }, overflowWrap: "anywhere" }}>
              {r.product}
            </Link>
            <Box>
              <ResourceState resource={r} />
            </Box>
          </Box>
        ))}
      </List>
    </Panel>
  );
}

/** The actions shared with your teams that have a check: how many are ready here, and the ones that aren't. */
function YourProducts({ runnables, install }: { runnables: Runnable[]; install: string }) {
  const checked = runnables.filter((r) => r.kind === "action" && r.shared && r.readiness);
  if (checked.length === 0) return null;
  const ready = checked.filter((r) => r.readiness?.state === "ready").length;
  const problems = checked.filter((r) => r.readiness?.state === "not_ready" || r.readiness?.state === "failed");
  return (
    <Panel
      title="Products your teams can use"
      action={
        <Link component={RouterLink} to="/products" variant="body2">
          Every product
        </Link>
      }
    >
      <Typography variant="body2" sx={{ fontSize: 13 }}>
        {ready} of {checked.length} with a check {ready === 1 ? "is" : "are"} ready on {install}.
      </Typography>
      {problems.slice(0, 4).map((r) => {
        const notReady = r.readiness?.state === "not_ready";
        return (
          <Box key={r.name} sx={{ display: "flex", flexDirection: "column", gap: 0.75, px: 1.75, py: 1.5, border: 1, borderColor: notReady ? "tint.errorBorder" : "tint.warningBorder", borderRadius: 2, fontSize: 13 }}>
            <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
              <Typography sx={{ fontWeight: 600, fontSize: 13 }}>
                {r.displayName || r.name} · {r.team}
              </Typography>
              <Pill tone={notReady ? "error" : "warning"}>{notReady ? "Not ready" : "Check failed"}</Pill>
            </Box>
            <Typography variant="body2" sx={{ fontSize: 13, overflowWrap: "anywhere" }}>
              {readinessSentence(r.readiness, install)}
            </Typography>
            {r.readiness?.checkedAt && <Muted>Checked {when(r.readiness.checkedAt)}</Muted>}
          </Box>
        );
      })}
    </Panel>
  );
}

/** A product image's release in the last week, or a deprecation of something shared with you. */
interface News {
  key: string;
  tag: "Release" | "New" | "Deprecated";
  name: string;
  text: string;
  /** Actions shared with you from it, to run or add to the cart. */
  runnable: Runnable | null;
}

function newsOf(products: Product[], runnables: Runnable[]): News[] {
  const shared = new Map(runnables.filter((r) => r.kind === "action" && r.shared).map((r) => [r.name, r]));
  const since = Date.now() - WEEK_MS;
  // One entry per image: its actions are released together.
  const byImage = new Map<string, Product[]>();
  for (const p of products) {
    const key = `${p.teamName ?? ""}/${imageName(p.image)}`;
    byImage.set(key, [...(byImage.get(key) ?? []), p]);
  }
  const out: (News & { at: number })[] = [];
  for (const [key, group] of byImage) {
    const first = group[0];
    if (!first) continue;
    const team = first.teamName ?? "the platform";
    const actions = group.map((p) => p.action).join(", ");
    const runnable = group.map((p) => shared.get(p.name)).find((r) => r !== undefined) ?? null;
    const latest = first.releases[0];
    const at = latest ? Date.parse(latest.registeredAt) : NaN;
    if (latest && at >= since) {
      const isNew = first.releases.length === 1;
      out.push({
        key,
        at,
        tag: isNew ? "New" : "Release",
        // Its tag when it has one: a bare digest says nothing to a reader.
        name: `${first.displayName ?? imageName(first.image)}${imageVersion(first.image).startsWith("sha256:") ? "" : ` ${imageVersion(first.image)}`} · ${team}`,
        text: `${isNew ? "A new product" : "A new image"}${runnable ? " shared with you" : ""}: ${actions}. Registered ${when(latest.registeredAt)}.`,
        runnable: first.deprecated ? null : runnable,
      });
    } else if (first.deprecated && runnable) {
      out.push({ key, at: 0, tag: "Deprecated", name: `${first.displayName ?? imageName(first.image)} · ${team}`, text: first.deprecated, runnable: null });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 5);
}

const NEWS_TONE: Record<News["tag"], PillTone> = { Release: "info", New: "info", Deprecated: "warning" };

function CatalogNews({ news }: { news: News[] }) {
  if (news.length === 0) return null;
  return (
    <Panel title="New and changed in the catalog" action={<Muted>The last 7 days</Muted>}>
      <List>
        {news.map((c) => (
          <Box key={c.key} sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "10px 16px", py: 1.5 }}>
            <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start", minWidth: 0, flex: "1 1 280px" }}>
              <Box sx={{ flex: "0 0 auto", minWidth: 84, display: "flex", justifyContent: "center" }}>
                <Pill tone={NEWS_TONE[c.tag]}>{c.tag}</Pill>
              </Box>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 500, overflowWrap: "anywhere" }}>{c.name}</Typography>
                <Typography variant="body2" sx={{ fontSize: 13, overflowWrap: "anywhere" }}>
                  {c.text}
                </Typography>
              </Box>
            </Box>
            <Box sx={{ display: "flex", gap: 1 }}>
              {c.runnable ? (
                <>
                  <AddToCart name={c.runnable.name} />
                  <Button variant="outlined" size="small" component={RouterLink} to={runLink(c.runnable)} sx={{ minHeight: 36 }}>
                    Run
                  </Button>
                </>
              ) : (
                <Button variant="outlined" size="small" component={RouterLink} to="/products" sx={{ minHeight: 36 }}>
                  See product
                </Button>
              )}
            </Box>
          </Box>
        ))}
      </List>
    </Panel>
  );
}

function AddToCart({ name }: { name: string }) {
  const inCart = useCart().actions.includes(name);
  return inCart ? (
    <Button variant="outlined" size="small" color="success" component={RouterLink} to="/catalog/cart" sx={{ minHeight: 36 }}>
      In your cart
    </Button>
  ) : (
    <Button variant="outlined" size="small" onClick={() => { cart.add(name); }} sx={{ minHeight: 36 }}>
      Add to cart
    </Button>
  );
}

/** One line of the install at a glance: settled (a check) or to look at (a warning), what, and where to look. */
interface Health {
  ok: boolean;
  severe?: boolean;
  title: string;
  text: string;
  cta: string;
  to: string;
}

function healthOf(catalog: CatalogStatus | null | undefined, security: SecurityView | null | undefined, metrics: MetricsView | null | undefined, alerts: Notification[]): Health[] {
  const out: Health[] = [];
  if (catalog && catalog.release) {
    out.push(
      catalog.error
        ? { ok: false, severe: true, title: "The catalog couldn't be applied", text: catalog.error, cta: "Catalog", to: "/admin/catalog" }
        : {
            ok: catalog.problems.length === 0,
            title: `Catalog release ${catalog.version || catalog.digest.slice(0, 19)} applied`,
            text: `${catalog.appliedAt ? when(catalog.appliedAt) : "Not yet"}${catalog.commit ? `, commit ${catalog.commit.slice(0, 7)}` : ""}. ${
              catalog.problems.length ? `${plural(catalog.problems.length, "thing")} it couldn't apply.` : "Nothing it couldn't apply."
            }`,
            cta: "Catalog",
            to: "/admin/catalog",
          },
    );
  }
  if (security) {
    const failing = security.images.filter((i) => i.scan === "failed" && !i.acceptedReason);
    out.push(
      failing.length > 0
        ? {
            ok: false,
            severe: true,
            title: `${plural(failing.length, "image")} ${failing.length === 1 ? "fails its" : "fail their"} scan`,
            text: `${failing
              .slice(0, 2)
              .map((i) => `${imageName(i.image)}:${imageVersion(i.image)}`)
              .join(", ")}${failing.length > 2 ? ` and ${String(failing.length - 2)} more` : ""}. Runs of them are refused.`,
            cta: "Images",
            to: "/observe?tab=security",
          }
        : { ok: true, title: "Every image passes its scan", text: `${plural(security.images.length, "image")} allowed to run.`, cta: "Images", to: "/observe?tab=security" },
    );
    const steps = security.refusals.filter((r) => r.source === "step");
    const total = steps.reduce((n, r) => n + r.count, 0);
    const codes = new Map<string, number>();
    for (const r of steps) codes.set(r.code, (codes.get(r.code) ?? 0) + r.count);
    const teams = [...new Set(steps.map((r) => r.team).filter(Boolean))];
    out.push(
      total > 0
        ? {
            ok: false,
            title: `${plural(total, "step")} refused this week`,
            text: `${[...codes].map(([code, n]) => `${String(n)} ${code}`).join(", ")}${teams.length ? `, from ${teams.join(" and ")}` : ""}.`,
            cta: "Security",
            to: "/observe?tab=security",
          }
        : { ok: true, title: "No step refused this week", text: "Every step the cluster was asked to run passed its checks.", cta: "Security", to: "/observe?tab=security" },
    );
  }
  for (const a of alerts.slice(0, 2)) {
    out.push({ ok: false, title: `An alert: ${a.title}`, text: `${a.body ? `${a.body} ` : ""}${when(a.createdAt)}.`, cta: "Open", to: a.link ?? "/admin" });
  }
  if (metrics) {
    const lastHour = metrics.hours.at(-1);
    out.push({
      ok: true,
      title: `${plural(metrics.running, "step")} running, ${String(metrics.ready)} waiting to start`,
      text: lastHour && lastHour.started > 0 ? `Starts waited ${String(Math.round(lastHour.waitP95Seconds))} s at the 95th percentile in the last hour.` : "None started in the last hour.",
      cta: "Metrics",
      to: "/observe?tab=metrics",
    });
  }
  return out;
}

function AtAGlance({ install, health }: { install: string; health: Health[] | null }) {
  return (
    <Panel tone="info" icon={<AdminIcon sx={{ color: "primary.main" }} />} title={`${install} at a glance`} action={<Pill tone="neutral">Admins</Pill>}>
      {health === null ? (
        <Skeleton variant="rounded" height={160} />
      ) : (
        <List>
          {health.map((h) => (
            <RowLink key={h.title} to={h.to}>
              <Box sx={{ pt: "1px", color: h.ok ? "success.main" : h.severe ? "error.main" : "warning.main", "& svg": { fontSize: 18 } }}>{h.ok ? <CheckIcon /> : <WarningIcon />}</Box>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0, flex: "1 1 auto" }}>
                <Typography sx={{ fontWeight: 500, fontSize: 13 }}>{h.title}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13, lineHeight: 1.4, overflowWrap: "anywhere" }}>
                  {h.text}
                </Typography>
              </Box>
              <Typography sx={{ fontSize: 12, color: "primary.main", whiteSpace: "nowrap", pt: "2px" }}>{h.cta}</Typography>
            </RowLink>
          ))}
        </List>
      )}
      <Box sx={{ display: "flex", gap: 1.25, flexWrap: "wrap", borderTop: 1, borderColor: "tint.rule", pt: 1.75 }}>
        <Button variant="outlined" size="small" startIcon={<ObserveIcon />} component={RouterLink} to="/observe" sx={{ minHeight: 36 }}>
          Observe
        </Button>
        <Button variant="outlined" size="small" startIcon={<AdminIcon />} component={RouterLink} to="/admin" sx={{ minHeight: 36 }}>
          Admin
        </Button>
      </Box>
    </Panel>
  );
}

function AskBox({ suggestions }: { suggestions: string[] }) {
  const ask = useAsk();
  const [question, setQuestion] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Cleared only once it's asked: with no model to ask, it stays in the box.
    if (question.trim() && ask.open(question.trim(), { send: true })) setQuestion("");
  };
  return (
    <Panel tone="info" icon={<ChatIcon sx={{ color: "primary.main" }} />} title="Ask Vertra">
      <Box component="form" onSubmit={submit} sx={{ display: "flex", gap: 1 }}>
        <TextField
          size="small"
          placeholder="Ask about a run, a product or an error"
          value={question}
          onChange={(e) => { setQuestion(e.target.value); }}
          slotProps={{ htmlInput: { "aria-label": "Ask Vertra" } }}
          sx={{ flex: "1 1 auto", minWidth: 0, bgcolor: "background.paper", "& .MuiInputBase-root": { minHeight: 44 } }}
        />
        <Button type="submit" variant="contained" disabled={!question.trim()} sx={{ minHeight: 44 }}>
          Ask
        </Button>
      </Box>
      {suggestions.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, alignItems: "flex-start" }}>
          {suggestions.map((s) => (
            <Link key={s} component="button" type="button" variant="body2" onClick={() => { ask.open(s, { send: true }); }} sx={{ textAlign: "left", fontSize: 13 }}>
              {s}
            </Link>
          ))}
        </Box>
      )}
    </Panel>
  );
}

function PickUp({ actions, team, runnables, draft }: { actions: string[]; team: string | null; runnables: Runnable[]; draft: StoredDraft | null }) {
  if (actions.length === 0 && !draft) return null;
  const names = actions.map((a) => runnables.find((r) => r.kind === "action" && r.name === a)?.displayName || a);
  const steps = draft && Array.isArray(draft.body["steps"]) ? draft.body["steps"].length : 0;
  const tile = (icon: ReactNode, tone: "info" | "neutral") => (
    <Box
      aria-hidden="true"
      sx={{ flex: "0 0 36px", height: 36, borderRadius: 2, bgcolor: tone === "info" ? "info.light" : "tint.neutral", color: tone === "info" ? "info.main" : "text.primary", display: "flex", alignItems: "center", justifyContent: "center", "& svg": { fontSize: 18 } }}
    >
      {icon}
    </Box>
  );
  const card = { alignItems: "flex-start", border: 1, borderColor: "tint.rule", mx: 0, px: 1.5, py: 1.5, borderRadius: 2 };
  return (
    <Panel title="Pick up where you left off">
      {actions.length > 0 && (
        <Box component={RouterLink} to="/catalog/cart" sx={{ display: "flex", gap: 1.5, textDecoration: "none", color: "inherit", ...card, "&:hover": { bgcolor: "background.default" } }}>
          {tile(<CartIcon />, "info")}
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375, minWidth: 0 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 500 }}>Your cart, not ordered yet</Typography>
            <Typography variant="body2" sx={{ fontSize: 13, overflowWrap: "anywhere" }}>
              {plural(actions.length, "action")}
              {team ? ` for ${team}` : ""}: {names.join(", ")}
            </Typography>
            <Muted>Kept in this browser</Muted>
          </Box>
        </Box>
      )}
      {draft && (
        <Box
          component={RouterLink}
          to={`/catalog/compose?draft=${encodeURIComponent(`${draft.team}/${draft.name}`)}`}
          sx={{ display: "flex", gap: 1.5, textDecoration: "none", color: "inherit", ...card, "&:hover": { bgcolor: "background.default" } }}
        >
          {tile(<ComposeIcon />, "neutral")}
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375, minWidth: 0 }}>
            <Typography sx={{ fontSize: 14, fontWeight: 500, overflowWrap: "anywhere" }}>{draft.name}</Typography>
            <Typography variant="body2" sx={{ fontSize: 13 }}>
              A draft in Compose, {plural(steps, "step")}, for {draft.team}
            </Typography>
            {draft.updatedAt && (
              <Muted>
                Edited {when(draft.updatedAt)}
                {draft.updatedBy ? ` by ${draft.updatedBy}` : ""}
              </Muted>
            )}
          </Box>
        </Box>
      )}
    </Panel>
  );
}

function ComingUp({ schedules }: { schedules: Schedule[] }) {
  const next = schedules
    .filter((s) => s.enabled && s.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""))
    .slice(0, 3);
  if (next.length === 0) return null;
  return (
    <Panel title="Coming up">
      <List>
        {next.map((s) => {
          const at = new Date(s.nextRunAt ?? "");
          return (
            <RowLink key={s.id} to={`/teams/${encodeURIComponent(s.team)}?tab=schedules`}>
              <Box sx={{ flex: "0 0 40px", display: "flex", flexDirection: "column", alignItems: "center", border: 1, borderColor: "divider", borderRadius: 2, py: "3px", lineHeight: 1.2, alignSelf: "center" }}>
                <Typography sx={{ fontSize: 10, color: "text.secondary", textTransform: "uppercase" }}>{at.toLocaleDateString([], { weekday: "short" })}</Typography>
                <Typography sx={{ fontWeight: 600, fontSize: 13 }}>{at.getDate()}</Typography>
              </Box>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0, flex: "1 1 auto" }}>
                <Typography sx={{ fontWeight: 500, fontSize: 13, overflowWrap: "anywhere" }}>{s.name}</Typography>
                <Muted>
                  {s.team} · {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ({s.timeZone})
                </Muted>
              </Box>
              <Box sx={{ alignSelf: "center" }}>
                {s.lastError ? <Pill tone="error">Last didn't start</Pill> : s.lastRunAt ? <Pill tone="success">Last started</Pill> : <Pill tone="neutral">Not run yet</Pill>}
              </Box>
            </RowLink>
          );
        })}
      </List>
    </Panel>
  );
}

const API_STATE: Record<ApiProduct["state"], { tone: PillTone; label: string }> = {
  LIVE: { tone: "success", label: "Live" },
  PAUSED: { tone: "warning", label: "Paused" },
  HELD: { tone: "error", label: "Held" },
  UNAVAILABLE: { tone: "error", label: "Can’t serve" },
  UNSPECIFIED: { tone: "neutral", label: "Unknown" },
};

function TeamApis({ apis }: { apis: { api: ApiProduct; traffic: ApiTraffic | null }[] }) {
  if (apis.length === 0) return null;
  const figure = (value: string, label: string, error = false) => (
    <Box sx={{ display: "flex", flexDirection: "column" }}>
      <Typography sx={{ fontSize: 16, fontWeight: 600, color: error ? "error.main" : "text.primary", fontVariantNumeric: "tabular-nums" }}>{value}</Typography>
      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{label}</Typography>
    </Box>
  );
  return (
    <Panel
      title="Your teams' APIs, last 7 days"
      action={
        <Link component={RouterLink} to="/apis" variant="body2">
          APIs
        </Link>
      }
    >
      {apis.map(({ api, traffic }) => (
        <Box
          key={`${api.team}/${api.name}`}
          component={RouterLink}
          to={`/apis/${encodeURIComponent(api.team)}/${encodeURIComponent(api.name)}`}
          sx={{ display: "flex", flexDirection: "column", gap: 1.25, px: 1.75, py: 1.5, border: 1, borderColor: "tint.rule", borderRadius: 2, textDecoration: "none", color: "inherit", fontSize: 13, "&:hover": { borderColor: "tint.infoBorder" } }}
        >
          <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, alignItems: "center" }}>
            <Typography sx={{ fontWeight: 600, fontSize: 13, color: "primary.main" }}>
              {api.displayName || api.name} · {api.team}
            </Typography>
            <Pill tone={API_STATE[api.state].tone}>{API_STATE[api.state].label}</Pill>
          </Box>
          {traffic && (
            <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 1 }}>
              {figure(traffic.requests.toLocaleString(), "requests")}
              {figure(traffic.stopped.toLocaleString(), "stopped at the gateway")}
              {figure(traffic.backendErrors.toLocaleString(), "backend errors", traffic.backendErrors > 0)}
            </Box>
          )}
          {api.state === "PAUSED" && api.pausedMessage && <Typography variant="body2" sx={{ fontSize: 13 }}>Paused: “{api.pausedMessage}”</Typography>}
          {api.state === "HELD" && api.heldReason && <Typography variant="body2" sx={{ fontSize: 13 }}>Held: {api.heldReason}</Typography>}
          {api.state === "UNAVAILABLE" && <Typography variant="body2" sx={{ fontSize: 13 }}>Can’t serve: {api.problem}</Typography>}
        </Box>
      ))}
    </Panel>
  );
}

function Notifications({ notes, onRead }: { notes: { notifications: Notification[]; unreadCount: number } | null | undefined; onRead: () => void }) {
  const navigate = useNavigate();
  if (!notes || notes.notifications.length === 0) return null;
  const open = (n: Notification) => {
    if (!n.read) markNotificationsRead([n.id]).then(onRead).catch(() => undefined);
    if (n.link) navigate(n.link);
  };
  return (
    <Panel
      id="notifications"
      title="Notifications"
      action={
        notes.unreadCount > 0 && (
          <Button size="small" onClick={() => { markNotificationsRead("all").then(onRead).catch(() => undefined); }} sx={{ minHeight: 36 }}>
            Mark all read
          </Button>
        )
      }
    >
      <List>
        {notes.notifications.slice(0, 5).map((n) => (
          <Box
            key={n.id}
            component="button"
            type="button"
            onClick={() => { open(n); }}
            sx={{ all: "unset", boxSizing: "border-box", display: "flex", gap: 1.25, alignItems: "flex-start", py: 1.25, px: 0.75, mx: -0.75, borderRadius: "6px", cursor: "pointer", fontSize: 13, minHeight: 44, "&:hover": { bgcolor: "background.default" }, "&:focus-visible": { outline: (t) => `2px solid ${t.palette.primary.main}`, outlineOffset: 2 } }}
          >
            <Box aria-hidden="true" sx={{ flex: "0 0 8px", height: 8, mt: "6px", borderRadius: "50%", bgcolor: n.read ? "tint.field" : n.kind === "run_failed" ? "error.main" : "primary.main" }} />
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
              <Typography sx={{ fontSize: 13, fontWeight: n.read ? 400 : 600, overflowWrap: "anywhere" }}>
                {n.title}
                {!n.read && <Box component="span" sx={{ position: "absolute", left: -9999 }}> (unread)</Box>}
              </Typography>
              <Muted>{when(n.createdAt)}</Muted>
            </Box>
          </Box>
        ))}
      </List>
    </Panel>
  );
}

/**
 * Home: what waits for you to decide, what's running for you and your
 * teams, how your runs went, what they made, what's new in the catalog,
 * and, for an admin, the install at a glance. Each panel loads on its own
 * and is left out when it has nothing to say (or couldn't be loaded), so
 * a new install's Home is short and a busy one's is full.
 */
export function HomePage() {
  const { user } = useAuth();
  const install = useEnvironment()?.label || "this install";
  const { actions: inCart, team: cartTeam } = useCart();
  const isAdmin = user?.isAdmin ?? false;
  const teams = useMemo(() => user?.teamNames ?? [], [user]);
  const [error, setError] = useState<string | null>(null);

  const since = dayStart(DAYS - 1).toISOString();
  const [mine] = useLoaded(() =>
    listExecutions({ mine: true, since, limit: 1000 })
      .then((p) => p.executions)
      .catch((err: unknown) => {
        setError(errorMessage(err, "Couldn't load your runs."));
        throw err;
      }),
  );
  // What could be running for you: your newest runs and each of your teams' (not the install's newest,
  // which on a busy one can leave out a long-running run of yours; nor a cutoff, which leaves out an old approval).
  const [visible] = useLoaded(() =>
    Promise.all([listExecutions({ mine: true, limit: 100 }), ...teams.slice(0, 10).map((team) => listExecutions({ team, limit: 100 }))]).then((pages) => [
      ...new Map(pages.flatMap((p) => p.executions).map((r) => [r.executionId, r])).values(),
    ]),
  );
  const [approvals] = useLoaded(() => listPendingApprovals().then((list) => list.filter((a) => a.canDecide)));
  const [deletes] = useLoaded(isAdmin ? listDeleteRequests : null);
  const [schedules] = useLoaded(() => Promise.all(teams.slice(0, 10).map((t) => listSchedules(t).catch(() => []))).then((all) => all.flat()));
  const [resources] = useLoaded(() => listResources({}));
  const [runnables] = useLoaded(listRunnables);
  const [products] = useLoaded(listProducts);
  const [drafts] = useLoaded(listDrafts);
  const [notes, reloadNotes] = useLoaded(listNotifications);
  const [chat] = useLoaded(getChatSettings);
  const [apis] = useLoaded(() =>
    listApis().then((all) =>
      Promise.all(
        all
          .filter((a) => teams.includes(a.team))
          .slice(0, 3)
          .map(async (api) => ({ api, traffic: await getApiTraffic(api.team, api.name, 168).catch(() => null) })),
      ),
    ),
  );
  const [catalog] = useLoaded(isAdmin ? getCatalogStatus : null);
  const [security] = useLoaded(isAdmin ? getSecurity : null);
  const [metrics] = useLoaded(isAdmin ? getMetrics : null);

  // Running now: yours, and your teams' (an admin sees every run, so it's narrowed to theirs too).
  const live = useMemo(
    () => (visible === undefined ? null : (visible ?? []).filter((r) => r.state && LIVE.has(r.state) && (r.submittedBy === user?.id || r.teams.some((t) => teams.includes(t))))),
    [visible, user?.id, teams],
  );
  const now = useNow((live?.length ?? 0) > 0);
  const needs = approvals === undefined || deletes === undefined || schedules === undefined ? null : needsOf(approvals ?? [], deletes ?? [], schedules ?? [], user?.maintainerOf ?? []);
  const news = useMemo(() => (products && runnables ? newsOf(products, runnables) : []), [products, runnables]);
  const alerts = (notes?.notifications ?? []).filter((n) => n.kind === "platform_alert" && !n.read);
  const health = catalog === undefined || security === undefined || metrics === undefined ? null : healthOf(catalog, security, metrics, alerts);
  // Yours: the newest draft you saved last (a teammate's would be theirs to pick up).
  const latestDraft = drafts?.find((d) => d.updatedBy === user?.email) ?? null;
  const lastFailed = mine?.find((r) => r.state === "FAILED");
  const suggestions = [lastFailed && `Why did ${lastFailed.name} fail?`, teams[0] && `What can I order for ${teams[0]}?`].filter((s): s is string => Boolean(s));

  if (!user) return null;
  const name = user.email.split("@")[0];
  const newest = news.find((n) => n.tag !== "Deprecated");
  const summary =
    live === null || needs === null
      ? " "
      : [
          live.length > 0 ? `${plural(live.length, "run")} for you and your teams ${live.length === 1 ? "is" : "are"} going` : "Nothing of yours or your teams' is running",
          needs.length > 0 ? `, and ${plural(needs.length, "thing")} ${needs.length === 1 ? "waits" : "wait"} for you to decide.` : ", and nothing waits for you.",
          newest ? ` New in the catalog: ${newest.name}.` : "",
        ].join("");

  return (
    <Box sx={{ maxWidth: 1280, mx: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
      <Box component="header" sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 2 }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0 }}>
          <Typography variant="h4" component="h1" sx={{ fontSize: { xs: 24, sm: 28 }, overflowWrap: "anywhere" }}>
            {greeting(new Date().getHours())}, {name}
          </Typography>
          <Typography sx={{ fontSize: 14, maxWidth: 760, lineHeight: 1.5 }}>{summary}</Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", alignItems: "center", fontSize: 13, color: "text.secondary" }}>
            {teams.length === 0 ? (
              <span>You&apos;re not in a team yet: a team&apos;s maintainers or an admin can add you.</span>
            ) : (
              <span>
                Your teams:{" "}
                {teams.map((t, i) => (
                  <span key={t}>
                    {i > 0 && ", "}
                    <Link component={RouterLink} to={`/teams/${encodeURIComponent(t)}`}>
                      {t}
                    </Link>
                    {user.maintainerOf.includes(t) && " (maintainer)"}
                  </span>
                ))}
              </span>
            )}
            <HelpLink guide="01-getting-started" label="Getting started" />
          </Box>
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.25 }}>
          <Button variant="outlined" size="large" startIcon={<CartIcon />} component={RouterLink} to="/catalog/cart">
            Cart
            {inCart.length > 0 && (
              <Box component="span" sx={{ ml: 1 }}>
                <Pill tone="info">{inCart.length}</Pill>
              </Box>
            )}
          </Button>
          <Button variant="contained" size="large" component={RouterLink} to="/catalog">
            Run something
          </Button>
        </Box>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      <NeedsYou needs={needs} />

      <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 3fr) minmax(0, 2fr)" }, alignItems: "start" }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5, minWidth: 0 }}>
          <RunningNow live={live} now={now} />
          <YourRuns runs={mine === undefined ? null : (mine ?? [])} />
          {resources && <WhatYouMade resources={resources} teams={teams} email={user.email} />}
          {runnables && <YourProducts runnables={runnables} install={install} />}
          <CatalogNews news={news} />
        </Box>
        <Box component="aside" aria-label="At a glance" sx={{ display: "flex", flexDirection: "column", gap: 2.5, minWidth: 0 }}>
          {isAdmin && <AtAGlance install={install} health={health} />}
          {chat?.enabled && <AskBox suggestions={suggestions} />}
          <PickUp actions={inCart} team={cartTeam} runnables={runnables ?? []} draft={latestDraft} />
          {schedules && <ComingUp schedules={schedules} />}
          {apis && <TeamApis apis={apis} />}
          <Notifications notes={notes} onRead={reloadNotes} />
        </Box>
      </Box>
    </Box>
  );
}
