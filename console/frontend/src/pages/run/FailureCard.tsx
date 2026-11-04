// SPDX-License-Identifier: MIT
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { TaskStatus } from "../../api";
import { useAsk } from "../../layout/ask";
import { FailureHelp, explainedBy } from "./FailureHelp";

/** "not retried automatically", or how many attempts it had. */
function retriedNote(task: TaskStatus): string {
  if (!task.failure?.retryable) return "not retried automatically";
  return task.attempts.length > 1 ? `after ${String(task.attempts.length)} attempts` : "";
}

/**
 * Why a failed run stopped, at the top of its page: the step, its error
 * code and message, and what that means and what to do about it, and
 * Ask Vennir about it when there's a model (the question in its box, to send).
 * The question names the run and the step's position only: the step's id and
 * its error code come from a DAG's author and a product, so they stay out of
 * what the person sends as their own words (the agent reads them with get_run).
 */
export function FailureCard({
  runId,
  task,
  position,
  busy,
  retryBlocked,
  onRetry,
  onShow,
}: {
  runId: string;
  task: TaskStatus;
  /** "Step 3". */
  position: string;
  busy: boolean;
  retryBlocked: string | null;
  onRetry: () => void;
  onShow: () => void;
}) {
  const ask = useAsk();
  if (!task.failure) return null;
  const note = retriedNote(task);
  return (
    <Card component="section" aria-labelledby="why-heading" sx={{ p: 3, borderColor: "error.light", display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 1.25 }}>
        <Typography id="why-heading" variant="h6" component="h2" sx={{ fontSize: 18, overflowWrap: "anywhere", minWidth: 0 }}>
          {position}, {task.taskId}: {task.failure.message}
        </Typography>
        <Box
          component="span"
          sx={{ fontFamily: "fontFamilyMono", fontSize: 12, color: "error.dark", bgcolor: "error.light", px: 1, py: 0.5, borderRadius: 1.5, overflowWrap: "anywhere" }}
        >
          {task.failure.code}
          {note && ` · ${note}`}
        </Box>
      </Box>
      {task.help && <FailureHelp help={task.help} />}
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px", pt: 1.75, borderTop: 1, borderColor: "divider" }}>
        <Tooltip title={retryBlocked ?? (task.failure.retryable ? "" : "This failure is marked not retryable.")}>
          <span>
            <Button variant="contained" disabled={busy || retryBlocked !== null} onClick={onRetry}>
              {busy ? "Retrying…" : `Retry ${task.taskId}`}
            </Button>
          </span>
        </Tooltip>
        <Button variant="outlined" onClick={onShow}>
          Show its attempts and logs
        </Button>
        {typeof ask.model === "string" && (
          <Button
            variant="text"
            onClick={() => { ask.open(`Why did run ${runId} fail at ${position.toLowerCase()}, and what should I do?`); }}
          >
            Ask Vennir about it
          </Button>
        )}
        {task.help && (
          <Typography variant="body2" color="text.secondary" sx={{ ml: { sm: "auto" } }}>
            {explainedBy(task.help)}
          </Typography>
        )}
      </Box>
    </Card>
  );
}
