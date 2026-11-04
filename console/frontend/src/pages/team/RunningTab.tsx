// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, ButtonBase, Card, CardContent, Chip, Link, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { errorMessage, listTeamPods, type TaskPod } from "../../api";
import { Facts, TabIntro, relativeTime } from "./shared";
import { Mono } from "../../components/Mono";

const POLL_MS = 5000;

const STATE_CHIP: Record<TaskPod["state"], { label: string; color: "success" | "warning" | "error" | "default" | "info" }> = {
  running: { label: "Running", color: "success" },
  starting: { label: "Starting", color: "info" },
  "cant-start": { label: "Can't start", color: "error" },
  finished: { label: "Finished", color: "default" },
  failed: { label: "Failed", color: "error" },
};

// Problems first, then running, then the rest; newest first within each.
const ORDER: TaskPod["state"][] = ["cant-start", "failed", "running", "starting", "finished"];

function taskTitle(pod: TaskPod): string {
  return pod.taskKey ?? pod.podName;
}

function executionLine(pod: TaskPod): string {
  if (!pod.execution) return pod.executionId ? "an execution" : "not a Vennir task";
  const { name, taskNumber, taskCount } = pod.execution;
  return taskNumber && taskCount ? `${name} · task ${String(taskNumber)} of ${String(taskCount)}` : name;
}

/** The product name from an image reference: the repository's last path
 * segment, without the tag and catalog CI's "-product" suffix. */
function productName(image: string | null): string {
  if (!image) return "—";
  const repo = image.split("@")[0]?.split("/").pop() ?? image;
  return (repo.split(":")[0] ?? repo).replace(/-product$/, "");
}

export function RunningTab({ teamName }: { teamName: string }) {
  const [pods, setPods] = useState<TaskPod[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [, setTick] = useState(0);

  const load = useCallback(() => {
    listTeamPods(teamName)
      .then((next) => {
        setPods(next);
        setLoadError(null);
        setUpdatedAt(Date.now());
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err, "Couldn't load what's running."));
      });
  }, [teamName]);

  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    // Re-render the "updated n s ago" label between polls.
    const clock = setInterval(() => {
      setTick((n) => n + 1);
    }, 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  const sorted = [...(pods ?? [])].sort((a, b) => {
    const byState = ORDER.indexOf(a.state) - ORDER.indexOf(b.state);
    if (byState !== 0) return byState;
    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });
  const current = sorted.find((p) => p.podName === selected) ?? sorted[0] ?? null;
  const count = (state: TaskPod["state"]) => (pods ?? []).filter((p) => p.state === state).length;
  const secondsAgo = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000)) : null;

  return (
    <Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 2, flexWrap: "wrap" }}>
        <TabIntro>
          Tasks running in {teamName} right now. Updates on its own. Finished work, with its outputs and logs, is on the{" "}
          <Link component={RouterLink} to="/runs">
            Runs
          </Link>{" "}
          page.
        </TabIntro>
        <Chip
          size="small"
          variant="outlined"
          color={loadError ? "error" : "default"}
          label={loadError ? "Not updating" : secondsAgo === null ? "Loading…" : `Live · updated ${String(secondsAgo)} s ago`}
        />
      </Box>
      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" }, gap: 2, mb: 3, maxWidth: 640 }}>
        {[
          ["Running", count("running") + count("starting")],
          ["Can't start", count("cant-start") + count("failed")],
        ].map(([label, value]) => (
          <Card key={label} variant="outlined">
            <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Typography variant="body2" color="text.secondary">
                {label}
              </Typography>
              <Typography sx={{ fontSize: 26, fontWeight: 700 }}>{pods ? value : "–"}</Typography>
            </CardContent>
          </Card>
        ))}
      </Box>

      {pods && pods.length === 0 ? (
        <Card variant="outlined">
          <CardContent>
            <Typography color="text.secondary">Nothing is running right now.</Typography>
          </CardContent>
        </Card>
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1.5fr) minmax(0, 1fr)" },
            gap: 2,
            alignItems: "start",
          }}
        >
          <Card variant="outlined" sx={{ overflow: "hidden" }}>
            <Box
              sx={{
                display: { xs: "none", sm: "grid" },
                gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 0.8fr)",
                gap: 2,
                px: 2,
                py: 1.25,
                bgcolor: "action.hover",
                fontSize: 12,
                fontWeight: 600,
                color: "text.secondary",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}
            >
              <span>Task</span>
              <span>Product</span>
              <span>Started</span>
              <span>Status</span>
            </Box>
            {sorted.map((pod) => {
              const chip = STATE_CHIP[pod.state];
              const isSelected = current?.podName === pod.podName;
              return (
                <ButtonBase
                  key={pod.podName}
                  onClick={() => {
                    setSelected(pod.podName);
                  }}
                  aria-pressed={isSelected}
                  sx={{
                    width: "100%",
                    display: "grid",
                    gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 0.8fr)" },
                    gap: 2,
                    alignItems: "center",
                    px: 2,
                    py: 1.5,
                    textAlign: "left",
                    borderTop: 1,
                    borderColor: "divider",
                    bgcolor: isSelected ? (theme) => alpha(theme.palette.primary.main, 0.06) : "transparent",
                    boxShadow: isSelected ? (theme) => `inset 0 0 0 2px ${theme.palette.primary.main}` : "none",
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
                      <Mono>{taskTitle(pod)}</Mono>
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {executionLine(pod)}
                    </Typography>
                  </Box>
                  <Typography variant="body2">
                    <Mono>{productName(pod.image)}</Mono>
                  </Typography>
                  <Typography variant="body2">{relativeTime(pod.startedAt)}</Typography>
                  <Box>
                    <Chip label={chip.label} size="small" color={chip.color} />
                  </Box>
                </ButtonBase>
              );
            })}
          </Card>

          {current && (
            <Card variant="outlined">
              <CardContent>
                <Stack spacing={2}>
                  <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    <Typography sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                      <Mono>{taskTitle(current)}</Mono>
                    </Typography>
                    <Chip label={STATE_CHIP[current.state].label} size="small" color={STATE_CHIP[current.state].color} />
                  </Box>
                  <Facts
                    rows={[
                      ["Execution", executionLine(current)],
                      ["Image", <Mono key="i">{current.image ?? "—"}</Mono>],
                      ["Runs as", <Mono key="s">{current.serviceAccount ?? "—"}</Mono>],
                      ["Attempt", current.attempt ? String(current.attempt) : "—"],
                      ["Started", relativeTime(current.startedAt)],
                      ...(current.finishedAt ? ([["Finished", relativeTime(current.finishedAt)]] as [string, string][]) : []),
                      ["Pod", <Mono key="p">{current.podName}</Mono>],
                    ]}
                  />
                  {current.problem && (
                    <Alert severity="error">
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {current.problem.title}
                      </Typography>
                      <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                        {current.problem.detail}
                      </Typography>
                    </Alert>
                  )}
                  {current.executionId && current.execution && (
                    <Button
                      component={RouterLink}
                      to={`/runs/${current.executionId}`}
                      variant="contained"
                      sx={{ alignSelf: "flex-start" }}
                    >
                      Open execution and logs
                    </Button>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )}
        </Box>
      )}
    </Box>
  );
}
