// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { ApiError, getImagePolicy, updateImagePolicy, type ImagePolicy } from "../../api";
import { when } from "../../time";
import { AdminCard, Dot, SrOnly, TONE_WORD, type Tone } from "./parts";
import { failingInUse, type AdminSummary, useAdminChanged } from "./summary";

/** A whole registry host (every project or user on it), not one path in
 * it. Same rule as ../../src/imagePolicy.ts's isBroadSource. */
function isBroadSource(entry: string): boolean {
  return entry.trim().replace(/^https?:\/\//, "").split("/").filter(Boolean).length <= 1;
}

interface Check {
  title: string;
  about: ReactNode;
  /** Its state, when this install says. */
  state?: { tone: Tone; text: string };
  where: ReactNode;
}

/** The checks an image passes when its step starts, numbered, each with its state where the API gives one. */
function ImageChecks({ summary }: { summary: AdminSummary | null }) {
  const allowed = summary?.imagePolicy?.allowed.length;
  const scanning = summary?.install?.scanning;
  // null: the cluster couldn't be read.
  const signing = summary?.install?.imageSignaturesRequired;
  const failing = summary ? failingInUse(summary).length : 0;
  const checks: Check[] = [
    {
      title: "Comes from an allowed source",
      about: <>Its name starts with one of the sources above. Refused as <Mono>IMAGE_NOT_ALLOWED</Mono>.</>,
      state: allowed === undefined ? undefined : allowed > 0 ? { tone: "ok", text: "On" } : { tone: "err", text: "None allowed" },
      where: "Set above",
    },
    {
      title: "Is pinned to a digest",
      about: <>The console pins every image to its digest at submission, so what was scanned is what runs. Refused as <Mono>IMAGE_NOT_PINNED</Mono>.</>,
      state: { tone: "ok", text: "On" },
      where: "Always on",
    },
    {
      title: "Passed its scan",
      about: <>No fixable HIGH or CRITICAL finding and no secret, or an admin accepted it. Refused as <Mono>IMAGE_SCAN_FAILED</Mono>.</>,
      state: scanning === undefined ? undefined : scanning ? { tone: "ok", text: "On" } : { tone: "off", text: "Off" },
      where:
        scanning && failing > 0 ? (
          <Link component={RouterLink} to="/admin/scans">
            {failing} failing now: Image scans →
          </Link>
        ) : (
          <>
            Set by the install: <Mono>scanning.enabled</Mono>
          </>
        ),
    },
    {
      title: "Is signed, and from the source registry",
      about:
        signing === false ? (
          <>
            Off here: any image from an allowed source runs once it passes the checks above. With <Mono>imageSignature</Mono> on, only images
            catalog CI signed in the source registry would. Refused as <Mono>IMAGE_NOT_SIGNED</Mono>.
          </>
        ) : (
          <>
            Signed by the catalog&apos;s CI after its security scans, and in the source registry: an image from another allowed source is refused
            too. Refused as <Mono>IMAGE_NOT_SIGNED</Mono>.
          </>
        ),
      state: signing === true ? { tone: "ok", text: "On" } : signing === false ? { tone: "off", text: "Off" } : undefined,
      where: (
        <>
          Set by the install: <Mono>imageSignature</Mono>
        </>
      ),
    },
  ];
  return (
    <AdminCard title="What an image passes before it runs">
      <Typography variant="body2" color="text.secondary">
        The cluster checks each one when the step starts, however the run was submitted. The console checks the first three at submission
        too, so a refusal comes early, with its reason.
      </Typography>
      <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none" }}>
        {checks.map((c, i) => (
          <Box component="li" key={c.title} sx={{ display: "flex", gap: 2, alignItems: "flex-start", py: 1.75, borderTop: 1, borderColor: "divider" }}>
            <Box
              aria-hidden="true"
              sx={{ flex: "0 0 28px", height: 28, borderRadius: "50%", bgcolor: "info.light", color: "info.main", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              {i + 1}
            </Box>
            <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1.5, flexWrap: "wrap" }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {c.title}
                </Typography>
                {c.state && (
                  <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, fontSize: 13 }}>
                    <Dot tone={c.state.tone} />
                    {c.state.text}
                    <SrOnly>, {TONE_WORD[c.state.tone]}</SrOnly>
                  </Box>
                )}
              </Box>
              <Typography variant="body2" color="text.secondary">
                {c.about}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {c.where}
              </Typography>
            </Box>
          </Box>
        ))}
      </Box>
    </AdminCard>
  );
}

/**
 * The image sources tasks may run from. The cluster enforces this exact
 * list when a task is dispatched (the execution-kernel chart's
 * image-policy.yaml), so a save here takes effect for every team at once.
 * Below them, every check an image passes before it runs.
 */
export function ImageSourcesCard({ summary = null }: { summary?: AdminSummary | null }) {
  const [policy, setPolicy] = useState<ImagePolicy | null>(null);
  const [source, setSource] = useState("");
  const [additional, setAdditional] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingBroad, setConfirmingBroad] = useState(false);

  function show(loaded: ImagePolicy): void {
    setPolicy(loaded);
    setSource(loaded.source);
    setAdditional(loaded.additional);
  }

  useEffect(() => {
    getImagePolicy()
      .then(show)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load image sources.");
      });
  }, []);

  const entries = additional.map((entry) => entry.trim()).filter((entry) => entry !== "");
  const broad = [source, ...entries].filter((entry) => entry.trim() !== "" && isBroadSource(entry));
  const changed = policy !== null && (source !== policy.source || additional.join("\n") !== policy.additional.join("\n"));

  const summaryChanged = useAdminChanged();
  async function save(): Promise<void> {
    if (!policy) return;
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      show(await updateImagePolicy(source, entries, policy.version));
      summaryChanged();
      setSuccess("Saved. The cluster enforces the new list for every task from now on.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
      setConfirmingBroad(false);
    }
  }

  const notConfigured = policy !== null && policy.exists && policy.allowed.length === 0;

  return (
    <>
      <AdminCard title="Allowed sources" status={policy?.exists && policy.allowed.length > 0 && <Pill tone="success" dot="success.main">In the cluster&apos;s policy</Pill>}>
        <Typography variant="body2" color="text.secondary">
          Each entry is a path prefix: an image runs only if its name starts with one. Base images a Dockerfile builds from (node,
          python…) don&apos;t need listing: they&apos;re part of the published image.
        </Typography>

        {policy && !policy.exists && (
          <Alert severity="error">
            The cluster&apos;s image policy doesn&apos;t exist, so no task can run. Installing or upgrading the execution-kernel release creates it.
          </Alert>
        )}
        {notConfigured && <Alert severity="warning">No image source is configured yet, so no task can run. Set the source registry below.</Alert>}

        <TextField
          label="Source registry"
          size="small"
          placeholder="us-central1-docker.pkg.dev/my-project/catalog-products"
          helperText="Where the catalog's CI publishes product images. Required: with no source, no step can run."
          value={source}
          disabled={!policy?.exists}
          onChange={(event) => { setSource(event.target.value); }}
          slotProps={{ htmlInput: { sx: { fontFamily: "fontFamilyMono" } } }}
        />
        <Typography variant="body2" sx={{ fontWeight: 500, mt: 0.5 }}>
          More allowed sources
        </Typography>
        {summary?.install?.imageSignaturesRequired === true && (
          <Alert severity="info" role="note">
            This install requires signed images, so a step runs only images catalog CI signed in the source registry. Images from the sources
            below pass this check, then are refused at the signature check (<Mono>IMAGE_NOT_SIGNED</Mono>): they don&apos;t run here.
          </Alert>
        )}
        {additional.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            None. Such as docker.io/library for official Docker Hub images.
          </Typography>
        )}
        {additional.map((entry, index) => (
          <Box key={index} sx={{ display: "flex", gap: 1, alignItems: "center" }}>
            <TextField
              size="small"
              fullWidth
              placeholder="docker.io/library"
              sx={entry.trim() && isBroadSource(entry) ? { "& .MuiOutlinedInput-notchedOutline": { borderColor: "warning.main" } } : undefined}
              slotProps={{ htmlInput: { "aria-label": `Allowed source ${String(index + 1)}`, sx: { fontFamily: "fontFamilyMono" } } }}
              value={entry}
              disabled={!policy?.exists}
              onChange={(event) => {
                const value = event.target.value;
                setAdditional((current) => current.map((e, i) => (i === index ? value : e)));
              }}
            />
            <IconButton
              aria-label={`Remove ${entry.trim() || `source ${String(index + 1)}`}`}
              color="error"
              onClick={() => { setAdditional((current) => current.filter((_, i) => i !== index)); }}
              sx={{ border: 1, borderColor: "divider", borderRadius: 2, width: 44, height: 44 }}
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Box>
        ))}
        {broad.length > 0 && (
          <Alert severity="warning">
            {broad.join(", ")} {broad.length === 1 ? "is a whole registry" : "are whole registries"}: any image anyone has published there could
            run. Prefer a specific path. Saving asks you to confirm.
          </Alert>
        )}
        <Box>
          <Button variant="outlined" startIcon={<AddIcon />} disabled={!policy?.exists} onClick={() => { setAdditional((current) => [...current, ""]); }} sx={{ minHeight: 44 }}>
            Add a source
          </Button>
        </Box>
        {error && <Alert severity="error">{error}</Alert>}
        {success && <Alert severity="success">{success}</Alert>}
        <Box sx={{ display: "flex", gap: 1.5, alignItems: "center", flexWrap: "wrap", borderTop: 1, borderColor: "divider", pt: 2 }}>
          <Button
            variant="contained"
            disabled={saving || !policy?.exists || source.trim() === ""}
            onClick={() => {
              if (broad.length > 0) setConfirmingBroad(true);
              else void save();
            }}
            sx={{ minHeight: 44 }}
          >
            {saving ? "Saving…" : "Save image sources"}
          </Button>
          <Button variant="outlined" disabled={!changed || saving} onClick={() => { if (policy) show(policy); }} sx={{ minHeight: 44 }}>
            Discard changes
          </Button>
          <Typography variant="caption" color="text.secondary">
            {policy?.lastSavedBy && policy.lastSavedAt && `Last saved by ${policy.lastSavedBy}, ${when(policy.lastSavedAt)}. `}
            Admins are alerted when these change.
          </Typography>
        </Box>
        <ConfirmDialog
          open={confirmingBroad}
          title="Allow a whole registry?"
          description={`${broad.join(", ")} would let tasks run any image published there by anyone, not just your own. Save anyway?`}
          confirmLabel="Save anyway"
          destructive
          busy={saving}
          onConfirm={() => void save()}
          onCancel={() => { setConfirmingBroad(false); }}
        />
      </AdminCard>
      <ImageChecks summary={summary} />
    </>
  );
}
