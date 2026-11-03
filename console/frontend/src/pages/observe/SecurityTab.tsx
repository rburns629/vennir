// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DownloadIcon from "@mui/icons-material/FileDownloadOutlined";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Pill, type PillTone } from "../../components/Pill";
import { MetricCard } from "../../components/MetricCard";
import { Mono } from "../../components/Mono";
import { ApiError, errorMessage, getImageSbom, getSecurity, type SecurityView } from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { when } from "../../time";

const STATE: Record<string, { label: string; tone: PillTone }> = {
  enforced: { label: "Enforced", tone: "success" },
  off: { label: "Off here", tone: "warning" },
  not_yet: { label: "Not yet", tone: "neutral" },
};

const SCAN: Record<string, { label: string; tone: PillTone }> = {
  passed: { label: "Passed", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  error: { label: "Couldn't scan", tone: "warning" },
  pending: { label: "Scanning", tone: "neutral" },
  unscanned: { label: "Not scanned", tone: "neutral" },
};

/** Who refused it: the refusals filter's choices, and the tag each refusal carries. */
const SOURCES: [string, string, PillTone][] = [
  ["", "All", "neutral"],
  ["step", "Cluster", "info"],
  ["catalog", "Catalog", "neutral"],
  ["gateway", "Gateway", "success"],
];

const stateOf = (state: string) => STATE[state] ?? { label: "Not yet", tone: "neutral" as const };
const scanOf = (scan: string) => SCAN[scan] ?? { label: "Not scanned", tone: "neutral" as const };
const sourceOf = (source: string): [string, string, PillTone] => SOURCES.find(([id]) => id === source) ?? ["step", "Cluster", "info"];

type Refusal = SecurityView["refusals"][number];
type Image = SecurityView["images"][number];

/** registry/team/product@sha256:abc… → its repository, and the digest's first 12. */
function splitImage(image: string): { repo: string; digest: string } {
  const at = image.indexOf("@sha256:");
  return at < 0 ? { repo: image, digest: "" } : { repo: image.slice(0, at), digest: image.slice(at + 8, at + 20) };
}

const REFUSALS: DataTableColumn<Refusal>[] = [
  {
    key: "when",
    header: "When",
    render: (r) => (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, alignItems: "flex-start", whiteSpace: "nowrap" }}>
        <span>{r.at ? when(r.at) : "—"}</span>
        <Pill tone={sourceOf(r.source)[2]}>{sourceOf(r.source)[1]}</Pill>
      </Box>
    ),
  },
  {
    key: "what",
    header: "What",
    render: (r) => (
      <Box sx={{ fontWeight: 500, minWidth: 160, overflowWrap: "anywhere" }}>
        {r.executionId ? (
          <Link component={RouterLink} to={`/runs/${r.executionId}`}>
            {r.what}
          </Link>
        ) : (
          r.what
        )}
        {r.source === "gateway" && `, ${r.count.toLocaleString()} call${r.count === 1 ? "" : "s"}`}
        {r.detail && (
          <Mono sx={{ display: "block", fontSize: 12, fontWeight: 400, color: "text.secondary", mt: 0.25 }}>{r.detail}</Mono>
        )}
      </Box>
    ),
  },
  {
    key: "why",
    header: "Why",
    render: (r) => (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
        <Mono sx={{ fontSize: 12, fontWeight: 500 }}>{r.code}</Mono>
        <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.45 }}>
          {r.why}
        </Typography>
      </Box>
    ),
    hideBelow: "sm",
  },
];

const IMAGES: DataTableColumn<Image>[] = [
  {
    key: "product",
    header: "Product",
    render: (i) => (
      <Box>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {i.product}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {i.team}
        </Typography>
      </Box>
    ),
  },
  {
    key: "image",
    header: "Image",
    render: (i) => {
      const { repo, digest } = splitImage(i.image);
      return (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, overflowWrap: "anywhere" }}>
          <Mono sx={{ fontSize: 12 }}>{repo}</Mono>
          {digest && <Mono sx={{ fontSize: 11.5, color: "text.secondary" }}>@sha256:{digest}</Mono>}
        </Box>
      );
    },
    hideBelow: "md",
  },
  {
    key: "scan",
    header: "Last scan",
    render: (i) => (
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone={i.acceptedReason ? "warning" : scanOf(i.scan).tone}>{i.acceptedReason ? "Accepted" : scanOf(i.scan).label}</Pill>
        {(i.fixable > 0 || i.secrets > 0 || i.acceptedReason) && (
          <Typography variant="caption">
            {[
              i.fixable > 0 ? `${String(i.fixable)} fixable` : "",
              i.secrets > 0 ? `${String(i.secrets)} secrets` : "",
              i.acceptedReason ? `accepted: ${i.acceptedReason}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </Typography>
        )}
      </Stack>
    ),
  },
  { key: "when", header: "Scanned", render: (i) => (i.scannedAt ? when(i.scannedAt) : "—"), hideBelow: "md" },
  { key: "sbom", header: "SBOM", render: (i) => <SbomButton image={i.image} product={i.product} />, hideBelow: "md" },
];

/** Downloads an image's SBOM, as catalog CI attached it; says so when there's none. */
function SbomButton({ image, product }: { image: string; product: string }) {
  const [state, setState] = useState<"idle" | "busy" | "none" | "failed">("idle");
  async function download(): Promise<void> {
    setState("busy");
    try {
      const sbom = await getImageSbom(image);
      const url = URL.createObjectURL(new Blob([sbom], { type: "application/vnd.cyclonedx+json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${product}.cdx.json`;
      link.click();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch (err) {
      setState(err instanceof ApiError && err.code === "NO_SBOM" ? "none" : "failed");
    }
  }
  if (state === "none") return <Typography variant="caption" color="text.secondary">None attached</Typography>;
  return (
    <Button size="small" variant="outlined" startIcon={<DownloadIcon />} disabled={state === "busy"} onClick={() => void download()} sx={{ minHeight: 36 }}>
      {state === "failed" ? "Try again" : "Download"}
    </Button>
  );
}

/** "a · b · c", of the parts that aren't empty. */
const joined = (...parts: string[]) => parts.filter(Boolean).join(" · ");

export function SecurityTab() {
  const { user } = useAuth();
  const [view, setView] = useState<SecurityView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState("");

  useEffect(() => {
    let cancelled = false;
    getSecurity()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Failed to load the security checks."));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const images = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!view) return null;
    return q ? view.images.filter((i) => [i.product, i.team, i.image].some((s) => s.toLowerCase().includes(q))) : view.images;
  }, [view, filter]);

  const refusals = view?.refusals ?? [];
  const shownRefusals = view ? refusals.filter((r) => !source || r.source === source) : null;
  // How many of each code, among those shown, most first. A gateway row is a
  // group of `count` calls; a step's or a release's is one.
  const codes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of shownRefusals ?? []) counts.set(r.code, (counts.get(r.code) ?? 0) + r.count);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [shownRefusals]);

  const enforced = view?.checks.filter((c) => c.state === "enforced") ?? [];
  const notEnforced = view?.checks.filter((c) => c.state !== "enforced") ?? [];
  const failing = view?.images.filter((i) => i.scan === "failed" && !i.acceptedReason) ?? [];
  const accepted = view?.images.filter((i) => i.acceptedReason).length ?? 0;
  const total = (rows: typeof refusals) => rows.reduce((n, r) => n + r.count, 0);
  const bySource = (id: string) => total(refusals.filter((r) => r.source === id));
  const shown = (n: number) => (view ? n.toLocaleString() : "—");

  return (
    <Stack spacing={2.5}>
      {error && <Alert severity="error">{error}</Alert>}
      <Box component="section" aria-label="Summary" sx={{ display: "grid", gap: 1.75, gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", sm: "repeat(auto-fit, minmax(200px, 1fr))" } }}>
        <MetricCard
          label="Checks enforced"
          value={view ? `${String(enforced.length)} of ${String(view.checks.length)}` : "—"}
          note={view && (notEnforced.length ? notEnforced.map((c) => `${c.name}: ${stateOf(c.state).label.toLowerCase()}`).join("; ") : "every one")}
        />
        <MetricCard label="Images allowed" value={shown(view?.images.length ?? 0)} note={view && "each pinned to a digest and scanned"} />
        <MetricCard
          label="Failing scans"
          value={shown(failing.length)}
          note={view && joined(failing.map((i) => `${i.team}’s ${i.product}`).join(", "), accepted ? `${String(accepted)} more accepted by an admin` : "") || undefined}
        />
        <MetricCard
          label="Refused, 7 days"
          value={shown(total(refusals))}
          note={
            view &&
            (joined(
              bySource("step") ? `${String(bySource("step"))} by the cluster` : "",
              bySource("gateway") ? `${String(bySource("gateway"))} by the gateway` : "",
              bySource("catalog") ? `${String(bySource("catalog"))} release${bySource("catalog") === 1 ? "" : "s"}` : "",
            ) ||
              undefined)
          }
        />
      </Box>

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-start" }}>
        <Card component="section" aria-label="What this install enforces" sx={{ flex: "2 1 400px", minWidth: 0, p: 2.75, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography variant="h6" component="h2">
            What this install enforces
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13, mb: 1 }}>
            Each one checked by the cluster itself, not only by the console. What isn&apos;t enforced yet says so.
          </Typography>
          {view?.checks.map((c) => (
            <Box key={c.name} sx={{ display: "flex", gap: 1.5, alignItems: "flex-start", py: 1.25, borderTop: 1, borderColor: "divider" }}>
              <Box sx={{ flex: "0 0 auto" }}>
                <Pill tone={stateOf(c.state).tone}>{stateOf(c.state).label}</Pill>
              </Box>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontSize: 13.5, fontWeight: 500 }}>
                  {c.name}
                </Typography>
                <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.45, overflowWrap: "anywhere" }}>
                  {c.text}
                </Typography>
              </Box>
            </Box>
          ))}
        </Card>

        <Card component="section" aria-label="Refused, last 7 days" sx={{ flex: "3 1 540px", minWidth: 0, overflow: "hidden" }}>
          <Box sx={{ px: 2.75, pt: 2.25, pb: 1.5, display: "flex", flexDirection: "column", gap: 0.75 }}>
            <Typography variant="h6" component="h2">
              Refused, last 7 days
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
              Steps the cluster wouldn&apos;t start, catalog releases the console couldn&apos;t apply, and calls the gateway stopped (your
              teams&apos; APIs, and your teams&apos; calls). A run is linked when you may see it.
            </Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.75, pt: 0.75 }}>
              <Typography variant="caption" color="text.secondary" sx={{ width: 72 }}>
                Refused by
              </Typography>
              <Box role="group" aria-label="Refused by" sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
                {SOURCES.map(([id, label]) => (
                  <Chip
                    key={id || "all"}
                    label={
                      <>
                        {label}{" "}
                        <Box component="span" sx={{ fontWeight: 400, opacity: 0.8 }}>
                          {view ? (id ? bySource(id) : total(refusals)) : ""}
                        </Box>
                      </>
                    }
                    aria-label={label}
                    clickable
                    aria-pressed={source === id}
                    color={source === id ? "primary" : "default"}
                    variant={source === id ? "filled" : "outlined"}
                    onClick={() => {
                      setSource(id);
                    }}
                  />
                ))}
              </Box>
            </Box>
            {codes.length > 0 && (
              <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.75 }}>
                <Typography variant="caption" color="text.secondary" sx={{ width: 72 }}>
                  By code
                </Typography>
                {codes.map(([code, n]) => (
                  <Box
                    key={code}
                    component="span"
                    sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, height: 26, px: 1, borderRadius: 1.5, bgcolor: "background.default", fontFamily: "fontFamilyMono", fontSize: 11.5 }}
                  >
                    {code}
                    <Box component="b" sx={{ fontFamily: "fontFamily", fontWeight: 600 }}>
                      {n}
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
          <Box sx={{ borderTop: 1, borderColor: "divider" }}>
            <DataTable
              columns={REFUSALS}
              rows={shownRefusals}
              getRowKey={(r) => `${r.source}/${r.at ?? ""}/${r.what}/${r.detail}/${r.code}`}
              emptyMessage="Nothing refused this week."
            />
          </Box>
        </Card>
      </Box>

      <Card component="section" aria-label="Every image allowed to run here" sx={{ overflow: "hidden" }}>
        <Box sx={{ px: 2.75, pt: 2.25, pb: 1.5, display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 1.5, alignItems: "flex-end" }}>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, maxWidth: 760 }}>
            <Typography variant="h6" component="h2">
              Every image allowed to run here
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
              Pinned to a digest, scanned before it may run, and rescanned against new advisories while it&apos;s in use. Each one&apos;s SBOM is
              the one catalog CI attached to it.
              {user?.isAdmin && (
                <>
                  {" "}
                  <Link component={RouterLink} to="/admin/scans">
                    Every scan, its findings, and accepting one
                  </Link>
                  .
                </>
              )}
            </Typography>
          </Box>
          <TextField
            size="small"
            type="search"
            placeholder="Filter by product, team or image"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
            sx={{ width: 300, maxWidth: "100%", "& .MuiInputBase-root": { minHeight: 44 } }}
            slotProps={{ htmlInput: { "aria-label": "Filter images" } }}
          />
        </Box>
        <Box sx={{ borderTop: 1, borderColor: "divider" }}>
          <DataTable columns={IMAGES} rows={images} getRowKey={(i) => i.product} emptyMessage="No products registered yet." />
        </Box>
      </Card>
    </Stack>
  );
}
