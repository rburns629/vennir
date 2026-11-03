// SPDX-License-Identifier: MIT
import { useMemo, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { errorMessage, cancelExecution, decideApproval, rerunExecution, retryTask, type ExecutionDetail, type TaskStatus } from "../api";
import { useAuth } from "../auth/AuthContext";
import { HelpLink } from "../components/HelpLink";
import { StatusBadge } from "../components/StatusBadge";
import { computeStages } from "../dagLayout";
import { duration, useNow, when } from "../time";
import type { RunFrom } from "./RunFormPage";
import { FailureCard } from "./run/FailureCard";
import { RunSteps } from "./run/RunSteps";
import { RunTimeline } from "./run/RunTimeline";
import { OrderCart } from "./run/OrderCart";
import { WhatItMade } from "./run/WhatItMade";
import { StepPanel } from "./run/StepPanel";
import { WhoActed } from "./run/WhoActed";
import { TERMINAL_STATES, useExecutionWatch } from "./useExecutionWatch";

/** The step to show when none is chosen: one that needs attention, else the last to move. */
function defaultStep(tasks: TaskStatus[]): string {
  const pick =
    tasks.find((t) => t.state === "FAILED") ??
    tasks.find((t) => t.state === "AWAITING_APPROVAL") ??
    tasks.find((t) => t.state === "RUNNING" || t.state === "CLAIMED") ??
    tasks.findLast((t) => t.attempts.length > 0) ??
    tasks[0];
  return pick?.taskId ?? "";
}

/** Why retrying this step would be refused (the run's team or one of its images), or null. */
function retryBlockedFor(execution: ExecutionDetail, taskId: string): string | null {
  const blocked = execution.runBlocked;
  if (!blocked) return null;
  const image = execution.payload?.tasks.find((t) => t.id === taskId)?.image;
  if (blocked.error === "IMAGE_NOT_FOUND") {
    return image && blocked.missingImages?.includes(image) ? `Image "${image}" no longer exists in the registry.` : null;
  }
  if (blocked.error === "IMAGE_NOT_ALLOWED") {
    return image && blocked.disallowedImages?.includes(image) ? `Image "${image}" is not from an allowed image source.` : null;
  }
  return blocked.message;
}

/** "app-on-cloud-run by gcp-platform", "a cleanup", or "a DAG". */
function source(execution: ExecutionDetail): string {
  const template = execution.template;
  if (template === "cleanup") return "a cleanup of what runs made";
  if (template === "preview") return "a preview: it changes nothing";
  if (template === "order") return "an order from the cart";
  const slash = template?.indexOf("/") ?? -1;
  if (!template || slash < 0) return "a DAG";
  return `${template.slice(slash + 1)} by ${template.slice(0, slash)}`;
}

/**
 * The run form for what this run ran, when it was a template or an action run
 * alone. It runs the catalog's current version, so an image this run used
 * being gone doesn't stop it.
 */
function formFor(execution: ExecutionDetail): string | null {
  const ref = execution.template;
  if (!ref || ref === "cleanup" || ref === "preview" || ref === "order" || execution.templateParameters === null) return null;
  const kind = /^[a-z0-9-]+\/[a-z0-9-]+\.[a-z0-9-]+$/.test(ref) ? "action" : "template";
  return `/catalog/run?${kind}=${encodeURIComponent(ref)}`;
}

/**
 * One run: what it is and who started it, its steps against time, why it
 * failed if it did, and the selected step in detail. Kept current by
 * WatchExecution (useExecutionWatch) until it finishes.
 */
export function ExecutionDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { execution, events, logs, error, resume } = useExecutionWatch(id);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const live = execution !== null && !TERMINAL_STATES.has(execution.state);
  const now = useNow(live);

  const tasks = useMemo(() => (execution ? computeStages(execution.tasks).flat() : []), [execution]);
  const definitions = useMemo(() => new Map((execution?.payload?.tasks ?? []).map((t) => [t.id, t])), [execution]);

  /** Runs an action on this run, showing its refusal; then watches again (the run may be live again). */
  async function act(key: string, action: () => Promise<unknown>, failed: string): Promise<void> {
    setActionError(null);
    setBusy(key);
    try {
      await action();
      resume();
    } catch (err) {
      setActionError(errorMessage(err, failed));
    } finally {
      setBusy(null);
    }
  }

  // A rerun is a new run: go to it.
  async function rerun(): Promise<void> {
    setActionError(null);
    setBusy("rerun");
    try {
      navigate(`/runs/${(await rerunExecution(id)).executionId}`);
    } catch (err) {
      setActionError(errorMessage(err, "Couldn't run it again."));
      setBusy(null);
    }
  }

  if (!execution) {
    return (
      <Box>
        <Link component={RouterLink} to="/runs" variant="body2">
          Runs
        </Link>
        {error ? (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        ) : (
          <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
            <CircularProgress size={28} aria-label="Loading the run" />
          </Box>
        )}
      </Box>
    );
  }

  const selectedId = chosen ?? defaultStep(tasks);
  const selected = tasks.find((t) => t.taskId === selectedId);
  const failedIndex = execution.state === "FAILED" ? tasks.findIndex((t) => t.state === "FAILED") : -1;
  const failed = tasks[failedIndex];
  const lastChange = Math.max(Date.parse(execution.createdAt), ...tasks.flatMap((t) => t.attempts.map((a) => Date.parse(a.completedAt ?? a.startedAt ?? execution.createdAt))));
  const took = duration((live ? now : lastChange) - Date.parse(execution.createdAt));
  const startedBy = execution.submittedBy && execution.submittedBy === user?.email ? "you" : (execution.submittedBy ?? "someone since removed");
  const rerunBlocked = execution.runBlocked?.message ?? (execution.payload === null ? "This run predates stored submissions, so there's nothing to replay." : null);
  const form = formFor(execution);
  const retry = (taskId: string) => act(taskId, () => retryTask(id, taskId), "Couldn't retry it.");

  const showStep = (taskId: string) => {
    setChosen(taskId);
    document.getElementById("step")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const chip =
    failed && failedIndex >= 0
      ? { label: `Failed at step ${String(failedIndex + 1)} of ${String(tasks.length)}`, detail: took }
      : { label: undefined, detail: live ? `${took} so far` : took };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
        <Link component={RouterLink} to="/runs">
          Runs
        </Link>{" "}
        / {execution.name}
      </Typography>
      <Box component="header" sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 2, mt: -1.5 }}>
        <Box sx={{ minWidth: 0, flex: "1 1 320px", display: "flex", flexDirection: "column", gap: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.5 }}>
            <Typography variant="h4" component="h1" sx={{ fontSize: { xs: 24, sm: 28 }, overflowWrap: "anywhere" }}>
              {execution.name}
            </Typography>
            <StatusBadge status={execution.state} size="medium" label={chip.label} detail={chip.detail} />
          </Box>
          <Typography sx={{ fontSize: 14, color: "text.primary", opacity: 0.85 }}>
            Started by {startedBy}
            {execution.onBehalfOf && ` for ${execution.onBehalfOf}`}
            {execution.schedule && (
              <>
                {" on the schedule "}
                {execution.onBehalfOf ? (
                  <Link component={RouterLink} to={`/teams/${encodeURIComponent(execution.onBehalfOf)}?tab=schedules`}>
                    {execution.schedule}
                  </Link>
                ) : (
                  execution.schedule
                )}
              </>
            )}
            , {when(execution.createdAt)} · {source(execution)}
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
            {execution.state === "FAILED" && (
              <HelpLink guide="15-troubleshooting" section="where-do-i-start-when-a-run-fails" label="What to do when a run fails" />
            )}
            <HelpLink guide="09-runs-explained" section="what-do-a-runs-states-and-a-steps-states-mean" label="What a run's states mean" />
          </Box>
        </Box>
        <Box sx={{ display: "flex", gap: 1.25, flexWrap: "wrap" }}>
          {form && (
            <Button
              variant="outlined"
              size="large"
              onClick={() => {
                const from: RunFrom = { name: execution.name, parameters: execution.templateParameters ?? {}, onBehalfOf: execution.onBehalfOf };
                navigate(form, { state: { from } });
              }}
            >
              Run with changes
            </Button>
          )}
          <Tooltip title={rerunBlocked ?? ""}>
            <span>
              <Button
                variant={execution.state === "SUCCEEDED" ? "contained" : "outlined"}
                size="large"
                disabled={busy === "rerun" || rerunBlocked !== null}
                onClick={() => void rerun()}
              >
                {busy === "rerun" ? "Starting…" : "Run again"}
              </Button>
            </span>
          </Tooltip>
          {live && (
            <Button variant="outlined" size="large" color="error" disabled={busy === "cancel"} onClick={() => void act("cancel", () => cancelExecution(id), "Couldn't cancel it.")}>
              {busy === "cancel" ? "Cancelling…" : "Cancel run"}
            </Button>
          )}
        </Box>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}
      {actionError && <Alert severity="error">{actionError}</Alert>}
      {execution.runBlocked && (
        <Alert severity="warning" sx={{ overflowWrap: "anywhere" }}>
          {execution.runBlocked.message} It can&apos;t be run again or retried; its history is kept.
        </Alert>
      )}

      {failed && (
        <FailureCard
          runId={execution.executionId}
          task={failed}
          position={`Step ${String(failedIndex + 1)}`}
          busy={busy === failed.taskId}
          retryBlocked={retryBlockedFor(execution, failed.taskId)}
          onRetry={() => void retry(failed.taskId)}
          onShow={() => { showStep(failed.taskId); }}
        />
      )}

      <OrderCart execution={execution} />

      <Card component="section" aria-label="Timeline" sx={{ px: { xs: 2, sm: 3 }, py: { xs: 2, sm: 2.75 } }}>
        <RunTimeline tasks={tasks} definitions={definitions} startedAt={execution.createdAt} now={now} finished={!live} selected={selectedId} onSelect={setChosen} />
      </Card>

      {/* The step beside what the run made and who acted in it; one column below 1000px. */}
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 3fr) minmax(0, 2fr)" }, gap: 3, alignItems: "start" }}>
        {selected ? (
          <StepPanel
            executionId={execution.executionId}
            task={selected}
            definition={definitions.get(selected.taskId)}
            payload={execution.payload}
            logs={logs.find((l) => l.taskId === selected.taskId)}
            events={events.filter((e) => e.taskId === selected.taskId)}
            now={now}
            busy={busy === selected.taskId}
            retryBlocked={retryBlockedFor(execution, selected.taskId)}
            onRetry={() => void retry(selected.taskId)}
            onDecide={(approve, reason) =>
              void act(selected.taskId, () => decideApproval(id, selected.taskId, approve, reason), approve ? "Couldn't approve it." : "Couldn't decline it.")
            }
          />
        ) : (
          <Box />
        )}
        <Box component="aside" sx={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          {execution.state === "FAILED" && tasks.length > 1 && <RunSteps tasks={tasks} selected={selectedId} onSelect={showStep} />}
          <WhatItMade executionId={execution.executionId} watching={live || now - lastChange < 120_000} failed={execution.state === "FAILED"} />
          {selected && <WhoActed task={selected} definition={definitions.get(selected.taskId)} userEmail={user?.email} onBehalfOf={execution.onBehalfOf} />}
        </Box>
      </Box>
    </Box>
  );
}
