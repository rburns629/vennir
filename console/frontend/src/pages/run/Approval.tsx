// SPDX-License-Identifier: MIT
import { useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { errorMessage, previewStep, type TaskApproval } from "../../api";
import { PreviewResult } from "../../components/PreviewResult";
import { when } from "../../time";

/**
 * A step that needs an approval: who approved it, or that it's waiting,
 * and for a maintainer of its team who didn't start the run, Approve and
 * Decline (with an optional reason, shown with the failure), and, when its
 * product has a plan, a preview of what it would do first.
 */
export function Approval({
  executionId,
  taskId,
  approval,
  awaiting,
  busy,
  onDecide,
}: {
  executionId: string;
  taskId: string;
  approval: TaskApproval;
  awaiting: boolean;
  busy: boolean;
  onDecide: (approve: boolean, reason: string) => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  async function askPreview(): Promise<void> {
    setAsking(true);
    setPreviewError(null);
    try {
      setPreview(await previewStep(executionId, taskId));
    } catch (err) {
      setPreviewError(errorMessage(err, "Couldn't preview it."));
    } finally {
      setAsking(false);
    }
  }

  if (!awaiting) {
    return approval.approvedBy ? (
      <Typography variant="body2" color="text.secondary">
        Approved by {approval.approvedBy}
        {approval.approvedAt && `, ${when(approval.approvedAt)}`}.
      </Typography>
    ) : null;
  }
  return (
    <Alert severity="warning" icon={false}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        <Typography variant="body2" sx={{ color: "text.primary" }}>
          <strong>Waiting for an approval</strong> from a maintainer of its team
          {approval.awaitingSince && `, since ${when(approval.awaitingSince)}`}. Nothing runs until then.
          {!approval.canDecide && " Only its team's maintainers can decide, and never whoever started the run."}
        </Typography>
        {approval.canDecide && declining && (
          <TextField
            size="small"
            label="Why (shown with the step)"
            value={reason}
            onChange={(event) => { setReason(event.target.value); }}
            slotProps={{ htmlInput: { maxLength: 500 } }}
            sx={{ bgcolor: "background.paper" }}
          />
        )}
        {approval.canDecide && (
          <Box sx={{ display: "flex", gap: 1 }}>
            {declining ? (
              <>
                <Button color="error" variant="contained" disabled={busy} onClick={() => { onDecide(false, reason); }}>
                  {busy ? "Declining…" : "Decline"}
                </Button>
                <Button disabled={busy} onClick={() => { setDeclining(false); }}>
                  Back
                </Button>
              </>
            ) : (
              <>
                <Button variant="contained" disabled={busy} onClick={() => { onDecide(true, ""); }}>
                  {busy ? "Approving…" : "Approve"}
                </Button>
                <Button color="error" disabled={busy} onClick={() => { setDeclining(true); }}>
                  Decline…
                </Button>
                {approval.canPreview && (
                  <Button disabled={asking} onClick={() => void askPreview()}>
                    {asking ? "Asking…" : preview ? "Preview again" : "Preview what it would do"}
                  </Button>
                )}
              </>
            )}
          </Box>
        )}
        {previewError && <Alert severity="error">{previewError}</Alert>}
        {preview && (
          <Box sx={{ bgcolor: "background.paper", borderRadius: 1, p: 1.5 }}>
            <PreviewResult key={preview} executionId={preview} />
          </Box>
        )}
      </Box>
    </Alert>
  );
}
