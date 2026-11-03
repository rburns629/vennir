// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { errorMessage, getExecution, type ExecutionDetail, type NotPreviewed } from "../api";
import { Pill, type PillTone } from "./Pill";

const POLL_MS = 2000;
const FINISHED = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

interface Change {
  action: string;
  type: string;
  id: string;
  name?: string;
  detail?: string;
}

const TONE: Record<string, PillTone> = { create: "success", update: "info", delete: "error", none: "neutral" };

/** A plan's outputs, as product.yaml's plan promises them: {summary, changes}; anything else is left out. */
function planOf(outputs: Record<string, unknown> | null): { summary: string; changes: Change[] } {
  const changes = Array.isArray(outputs?.["changes"])
    ? (outputs["changes"] as unknown[]).flatMap((c): Change[] => {
        if (typeof c !== "object" || c === null) return [];
        const r = c as Record<string, unknown>;
        if (typeof r["type"] !== "string" || typeof r["id"] !== "string") return [];
        return [{
          action: typeof r["action"] === "string" ? r["action"] : "none",
          type: r["type"],
          id: r["id"],
          ...(typeof r["name"] === "string" ? { name: r["name"] } : {}),
          ...(typeof r["detail"] === "string" ? { detail: r["detail"] } : {}),
        }];
      })
    : [];
  return { summary: typeof outputs?.["summary"] === "string" ? outputs["summary"] : "", changes };
}

/**
 * What a preview run says each step would do: followed until it finishes,
 * then each step's summary and changes (create, update, delete), or why it
 * couldn't say. `notPreviewed`: the steps it left out, and why.
 */
export function PreviewResult({ executionId, notPreviewed = [] }: { executionId: string; notPreviewed?: NotPreviewed[] }) {
  const [run, setRun] = useState<ExecutionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      getExecution(executionId)
        .then((found) => {
          if (!current) return;
          setRun(found);
          if (!FINISHED.has(found.state)) timer = setTimeout(look, POLL_MS);
        })
        .catch((err: unknown) => { if (current) setError(errorMessage(err, "Couldn't read the preview.")); });
    };
    look();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [executionId]);

  const done = run !== null && FINISHED.has(run.state);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      {error && <Alert severity="error">{error}</Alert>}
      {!done && !error && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <CircularProgress size={18} aria-label="Previewing" />
          <Typography variant="body2" color="text.secondary">
            Asking each step&apos;s product what it would do…
          </Typography>
        </Box>
      )}
      {done &&
        run.tasks.map((task) => {
          const plan = planOf(task.outputs);
          return (
            <Box key={task.taskId} sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
              <Typography variant="subtitle2">{task.taskId}</Typography>
              {task.state !== "SUCCEEDED" ? (
                <Alert severity="warning">
                  It couldn&apos;t say: {task.failure?.message || task.failure?.code || task.state.toLowerCase()}.
                </Alert>
              ) : (
                <>
                  {plan.summary && <Typography variant="body2">{plan.summary}</Typography>}
                  {plan.changes.length === 0 && !plan.summary && (
                    <Typography variant="body2" color="text.secondary">
                      Nothing would change.
                    </Typography>
                  )}
                  {plan.changes.map((c) => (
                    <Box key={`${c.type}/${c.id}`} sx={{ display: "flex", alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
                      <Pill tone={TONE[c.action] ?? "neutral"}>{c.action}</Pill>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {c.name ?? c.id}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "fontFamilyMono" }}>
                        {c.type} · {c.id}
                      </Typography>
                      {c.detail && (
                        <Typography variant="caption" color="text.secondary" sx={{ width: "100%" }}>
                          {c.detail}
                        </Typography>
                      )}
                    </Box>
                  ))}
                </>
              )}
            </Box>
          );
        })}
      {notPreviewed.map((n) => (
        <Typography key={n.step} variant="body2" color="text.secondary">
          <Box component="span" sx={{ fontWeight: 500, color: "text.primary" }}>
            {n.step}
          </Box>
          : not previewed. {n.why}
        </Typography>
      ))}
      <Link component={RouterLink} to={`/runs/${executionId}`} variant="caption">
        The preview run
      </Link>
    </Box>
  );
}
