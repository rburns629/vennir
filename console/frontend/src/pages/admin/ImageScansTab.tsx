// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { errorMessage, acceptImageScan, listImageScans, rescanImage, type ImageScan } from "../../api";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Mono } from "../../components/Mono";
import { Pill, type PillTone } from "../../components/Pill";
import { useAdminChanged } from "./summary";
import { AdminCard } from "./parts";

type Shown = "all" | "failed" | "error" | "pending" | "passed" | "accepted";

/** What a scan says now: an accepted failure is its own state. */
const verdictOf = (s: ImageScan): Exclude<Shown, "all"> => (s.status === "failed" && s.acceptedReason ? "accepted" : s.status);

const VERDICT: Record<Exclude<Shown, "all">, { label: string; tone: PillTone }> = {
  failed: { label: "Failed", tone: "error" },
  error: { label: "Couldn't scan", tone: "warning" },
  pending: { label: "Scanning", tone: "neutral" },
  passed: { label: "Passed", tone: "success" },
  accepted: { label: "Accepted", tone: "warning" },
};

const FILTERS: [Shown, string][] = [
  ["all", "All"],
  ["failed", "Failed"],
  ["error", "Couldn't scan"],
  ["pending", "Scanning"],
  ["accepted", "Accepted"],
  ["passed", "Passed"],
];

const when = (at: string | null) => (at ? new Date(at).toLocaleString() : "—");
const short = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 12);
const repositoryOf = (image: string) => image.split("@")[0] ?? image;

const COLUMNS: DataTableColumn<ImageScan>[] = [
  {
    key: "image",
    header: "Image",
    render: (s) => (
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
          {repositoryOf(s.image)}
        </Typography>
        <Mono>{short(s.digest)}</Mono>
      </Box>
    ),
  },
  {
    key: "verdict",
    header: "Verdict",
    render: (s) => (
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone={VERDICT[verdictOf(s)].tone}>{VERDICT[verdictOf(s)].label}</Pill>
        {(s.fixable > 0 || s.secrets > 0) && (
          <Typography variant="caption" color="text.secondary">
            {s.fixable} fixable{s.secrets > 0 ? `, ${String(s.secrets)} secrets` : ""}
          </Typography>
        )}
      </Stack>
    ),
  },
  { key: "scanned", header: "Scanned", render: (s) => when(s.scannedAt), hideBelow: "md" },
  { key: "used", header: "Last used", render: (s) => when(s.lastUsedAt), hideBelow: "md" },
];

/** One scan: everything it found, and what an admin can do about it. */
function ScanDialog({ scan, onClose, onChanged }: { scan: ImageScan; onClose: () => void; onChanged: (s: ImageScan) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const summaryChanged = useAdminChanged();
  async function act(what: () => Promise<ImageScan | null>, done: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const changed = await what();
      if (changed) {
        onChanged(changed);
        summaryChanged();
      }
      setNote(changed ? done : "Scanning is off on this install.");
      setReason("");
    } catch (err) {
      setError(errorMessage(err, "That didn't work."));
    } finally {
      setBusy(false);
    }
  }

  const reasonOk = reason.trim().length >= 10 && reason.length <= 2000;
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ overflowWrap: "anywhere" }}>{repositoryOf(scan.image)}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <Pill tone={VERDICT[verdictOf(scan)].tone}>{VERDICT[verdictOf(scan)].label}</Pill>
          <Mono sx={{ overflowWrap: "anywhere", minWidth: 0 }}>{scan.digest}</Mono>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Asked for {when(scan.requestedAt)} · scanned {when(scan.scannedAt)} · last used {when(scan.lastUsedAt)}.{" "}
          {scan.fixable} fixable HIGH or CRITICAL, {scan.unfixable} without a fix yet, {scan.secrets} secrets.
        </Typography>
        {scan.error && <Alert severity="warning">Couldn&apos;t scan it: {scan.error}</Alert>}
        {scan.acceptedReason && (
          <Alert severity="info">
            Accepted by {scan.acceptedBy ?? "an admin"} ({when(scan.acceptedAt)}): {scan.acceptedReason}
          </Alert>
        )}
        {scan.findings.length > 0 && (
          <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", "& td, & th": { textAlign: "left", py: 0.75, pr: 1.5, borderBottom: 1, borderColor: "divider", verticalAlign: "top", fontSize: 13 } }}>
            <thead>
              <tr>
                <th>Severity</th>
                <th>Finding</th>
                <th>Package</th>
                <th>Fixed in</th>
              </tr>
            </thead>
            <tbody>
              {scan.findings.map((f) => (
                <tr key={`${f.kind}/${f.id}/${f.package}`}>
                  <td>{f.severity}</td>
                  <td>
                    <Mono>{f.id}</Mono>
                    {f.title && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                        {f.title}
                      </Typography>
                    )}
                  </td>
                  <td>{f.kind === "secret" ? "a secret" : `${f.package} ${f.installed}`}</td>
                  <td>{f.fixedIn || "—"}</td>
                </tr>
              ))}
            </tbody>
          </Box>
        )}
        {scan.findings.length < scan.fixable + scan.unfixable + scan.secrets && (
          <Typography variant="caption" color="text.secondary">
            The first {scan.findings.length} shown; scan the image yourself for the rest.
          </Typography>
        )}
        {scan.status === "failed" && !scan.acceptedReason && (
          <TextField
            label="Why it may run anyway"
            multiline
            minRows={2}
            value={reason}
            onChange={(e) => { setReason(e.target.value); }}
            helperText="10 to 2,000 characters, kept in the audit log. It may run until a rescan finds something new."
          />
        )}
        {note && <Alert severity="success">{note}</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button disabled={busy} onClick={() => void act(() => rescanImage(scan.digest), "Scanning it again.")}>
          Rescan now
        </Button>
        {scan.status === "failed" && !scan.acceptedReason && (
          <Button color="warning" disabled={busy || !reasonOk} onClick={() => void act(() => acceptImageScan(scan.digest, reason.trim()), "Accepted.")}>
            Accept
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Every image digest's scan, for admins: what failed and why, what
 * couldn't be scanned, and what was accepted anyway. A scan opens with
 * its findings, to rescan it or accept a failure with a reason.
 */
export function ImageScansTab() {
  const [scans, setScans] = useState<ImageScan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown>("all");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<ImageScan | null>(null);

  useEffect(() => {
    listImageScans()
      .then(setScans)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the scans.")); });
  }, []);

  const counts = useMemo(() => {
    const n: Record<Shown, number> = { all: 0, failed: 0, error: 0, pending: 0, passed: 0, accepted: 0 };
    for (const s of scans ?? []) {
      n.all += 1;
      n[verdictOf(s)] += 1;
    }
    return n;
  }, [scans]);

  const rows = useMemo(() => {
    if (!scans) return null;
    const q = filter.trim().toLowerCase();
    return scans.filter((s) => (shown === "all" || verdictOf(s) === shown) && (!q || s.image.toLowerCase().includes(q) || s.digest.includes(q)));
  }, [scans, shown, filter]);

  const changed = (s: ImageScan) => {
    setScans((all) => (all ?? []).map((x) => (x.digest === s.digest ? s : x)));
    setOpen(s);
  };

  return (
    <AdminCard title="Every image's last scan">
        <Typography variant="body2" color="text.secondary">
          Every image is scanned before it&apos;s registered or run, and again while it&apos;s in use (every 24 hours unless the install sets another interval). A failed one can&apos;t run (the
          cluster refuses it) until it&apos;s fixed or an admin accepts it.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <Box role="group" aria-label="Verdict" sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
          {FILTERS.map(([id, label]) => (
            <Chip
              key={id}
              label={`${label} ${scans ? String(counts[id]) : ""}`}
              clickable
              aria-pressed={shown === id}
              color={shown === id ? "primary" : "default"}
              variant={shown === id ? "filled" : "outlined"}
              onClick={() => { setShown(id); }}
              sx={{ height: 36 }}
            />
          ))}
        </Box>
        <TextField
          size="small"
          placeholder="Filter by image or digest"
          value={filter}
          onChange={(e) => { setFilter(e.target.value); }}
          sx={{ width: { xs: "100%", sm: 320 } }}
          slotProps={{ htmlInput: { "aria-label": "Filter by image or digest" } }}
        />
        <DataTable columns={COLUMNS} rows={rows} getRowKey={(s) => s.digest} onRowClick={setOpen} emptyMessage="No scans like that." />
      {open && <ScanDialog scan={open} onClose={() => { setOpen(null); }} onChanged={changed} />}
    </AdminCard>
  );
}
