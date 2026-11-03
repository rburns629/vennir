// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import { ApiError, errorMessage, deleteRunResources, listResources, type MadeResource } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ResourceLinks, ResourceState, resourceName, useResourceDelete } from "../../components/ResourceTable";

const REFRESH_MS = 15_000;

/**
 * What a run made, once it's recorded (within a minute of the run
 * finishing): each resource, one Delete each, and Delete all, newest first.
 * Hidden while there's nothing. Looked at again every few seconds while
 * `watching` (the run is live or just finished) or something is being deleted.
 */
export function WhatItMade({ executionId, watching, failed }: { executionId: string; watching: boolean; failed: boolean }) {
  const navigate = useNavigate();
  const [made, setMade] = useState<MadeResource[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const remove = useResourceDelete();
  const deleting = made.some((r) => r.state === "deleting");

  useEffect(() => {
    let current = true;
    const load = () => {
      listResources({ executionId, includeDeleted: true })
        .then((rows) => { if (current) setMade(rows); })
        .catch(() => undefined); // Display only: the run page works without it.
    };
    load();
    const timer = watching || deleting ? setInterval(load, REFRESH_MS) : undefined;
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [executionId, watching, deleting]);

  async function deleteAll(): Promise<void> {
    setBusy(true);
    setError(null);
    setAsked(null);
    try {
      navigate(`/runs/${await deleteRunResources(executionId)}`);
    } catch (err) {
      // Something else still uses one: an admin has been asked (decision 25).
      if (err instanceof ApiError && err.code === "HAS_DEPENDENTS") setAsked(err.message);
      else setError(errorMessage(err, "Couldn't delete them."));
      setBusy(false);
      setConfirming(false);
    }
  }

  if (made.length === 0) return null;
  const left = made.filter((r) => r.canDelete && r.state !== "deleted");
  // Used by something this run didn't make: deleted only if an admin approves.
  const ids = new Set(left.map((r) => r.id));
  const inUse = left.some((r) => r.hiddenDependents > 0 || r.dependents.some((d) => !ids.has(d.id)));
  return (
    <Card component="section" aria-labelledby="made-heading" sx={{ p: { xs: 2, sm: 2.75 }, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
        <Typography id="made-heading" variant="h6" component="h2">
          {failed ? "What it made before failing" : "What this run made"}
        </Typography>
        <Link component={RouterLink} to="/runs/made" variant="body2">
          All that runs made
        </Link>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {asked && <Alert severity="info">{asked}</Alert>}
      {remove.ui}
      {made.map((r) => (
        <Box
          key={r.id}
          sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1.25, px: 1.5, py: 1.25, border: 1, borderColor: "divider", borderRadius: 2, fontSize: 13 }}
        >
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
            <Typography component="span" sx={{ fontSize: 13, fontWeight: 500, overflowWrap: "anywhere" }}>
              {r.link ? (
                <Link href={r.link} target="_blank" rel="noopener noreferrer">
                  {resourceName(r)} ↗
                </Link>
              ) : (
                resourceName(r)
              )}
            </Typography>
            <Typography component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12, color: "text.secondary", overflowWrap: "anywhere" }}>
              {r.type} · {r.externalId}
            </Typography>
            <Typography component="span" variant="caption" color="text.secondary">
              From step {r.taskId}
            </Typography>
            {r.state !== "deleted" && <ResourceLinks resource={r} />}
          </Box>
          <Box sx={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0.5, flexShrink: 0 }}>
            <ResourceState resource={r} />
            {r.canDelete && r.state !== "deleting" && r.state !== "deleted" && (
              <Button size="small" color="error" onClick={() => { remove.ask([r]); }} aria-label={`Delete ${resourceName(r)}`}>
                {r.state === "delete_failed" ? "Try again" : "Delete"}
              </Button>
            )}
          </Box>
        </Box>
      ))}
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.5 }}>
        {failed
          ? "As each product reported it. Keep them to retry: the steps that made them won't run again. Or delete them: each one's cleanup runs, newest first."
          : "As each product reported it. Delete all runs each one's cleanup, newest first; something another resource still uses waits for an admin."}
      </Typography>
      {left.length > 1 && (
        <Button variant="outlined" color="error" startIcon={<DeleteIcon />} sx={{ alignSelf: "flex-start" }} onClick={() => { setConfirming(true); }}>
          Delete all {left.length}…
        </Button>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Delete all ${String(left.length)}?`}
        description={
          inUse
            ? "Other resources still use some of these, so they're deleted only if an admin approves it. Ask them now? (To skip that, delete what uses them first.)"
            : "This runs each one's cleanup, newest first, one after another, which deletes them where they live. You'll see the run."
        }
        confirmLabel={inUse ? "Ask an admin" : "Delete all"}
        destructive
        busy={busy}
        onConfirm={() => void deleteAll()}
        onCancel={() => { setConfirming(false); }}
      />
    </Card>
  );
}
