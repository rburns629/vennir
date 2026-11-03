// SPDX-License-Identifier: MIT
import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import { errorMessage, decideDeleteRequest, type DeleteRequest, type ResourceRef } from "../api";
import { useAuth } from "../auth/AuthContext";
import { when } from "../time";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { Pill } from "../components/Pill";

const names = (refs: ResourceRef[]) => refs.map((r) => r.name ?? r.externalId).join(", ") || "—";

/**
 * Deletes waiting for an admin because other resources used what they'd
 * delete (decision 25): an admin approves (the cleanup runs, as theirs) or
 * denies each; anyone else sees their own. Shown only when there are any.
 * `onDecided` loads them again.
 */
export function DeleteRequests({ requests, onDecided }: { requests: DeleteRequest[] | null; onDecided: () => void }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(request: DeleteRequest, approve: boolean): Promise<void> {
    setBusy(request.id);
    setError(null);
    try {
      const run = await decideDeleteRequest(request.id, approve);
      if (run) navigate(`/runs/${run}`);
      else onDecided();
    } catch (err) {
      setError(errorMessage(err, "Couldn't decide it."));
      onDecided();
    } finally {
      setBusy(null);
    }
  }

  if (!requests || requests.length === 0) return error ? <Alert severity="error">{error}</Alert> : null;
  const waiting = requests.filter((r) => r.decision === null).length;

  const columns: DataTableColumn<DeleteRequest>[] = [
    {
      key: "what",
      header: "Delete",
      render: (r) => (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
            {names(r.resources)}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "fontFamilyMono", overflowWrap: "anywhere" }}>
            {r.resources.map((res) => `${res.type} · ${res.externalId}`).join(", ")}
          </Typography>
        </Box>
      ),
    },
    { key: "used", header: "Still used by", hideBelow: "sm", render: (r) => <Box sx={{ overflowWrap: "anywhere" }}>{names(r.dependents)}</Box> },
    { key: "who", header: "Asked by", hideBelow: "md", render: (r) => `${r.requestedBy ?? "—"}, ${when(r.createdAt)}` },
    {
      key: "state",
      header: (
        <Box component="span" sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Decide
        </Box>
      ),
      align: "right",
      render: (r) => {
        if (r.decision === "approved") {
          return r.executionId ? (
            <Link component={RouterLink} to={`/runs/${r.executionId}`} underline="none">
              <Pill tone="info">Approved by {r.decidedBy ?? "an admin"}</Pill>
            </Link>
          ) : (
            <Pill tone="info">Approved</Pill>
          );
        }
        if (r.decision === "denied") return <Pill tone="neutral">Denied by {r.decidedBy ?? "an admin"}</Pill>;
        if (r.decision === "deleted") return <Pill tone="neutral">Deleted with what used it</Pill>;
        if (!user?.isAdmin) return <Pill tone="warning">Waiting for an admin</Pill>;
        return (
          <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button disabled={busy !== null} onClick={() => { void decide(r, false); }}>
              Deny
            </Button>
            <Button color="error" variant="contained" disabled={busy !== null} onClick={() => { void decide(r, true); }}>
              Approve and delete
            </Button>
          </Box>
        );
      },
    },
  ];

  return (
    <Box component="section" aria-labelledby="waiting-heading" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 1.25 }}>
        <Typography id="waiting-heading" variant="h6" component="h2" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          Waiting for an admin
          {waiting > 0 && <Pill tone="warning">{waiting}</Pill>}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 640 }}>
          Deletes refused because other resources still use what they&apos;d delete. Approving runs the delete anyway; what used it
          may stop working.
        </Typography>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      <Card sx={{ borderColor: (theme) => alpha(theme.palette.warning.main, 0.3) }}>
        <DataTable columns={columns} rows={requests} getRowKey={(r) => r.id} />
      </Card>
    </Box>
  );
}
