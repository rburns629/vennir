// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Mono } from "../../components/Mono";
import { useAuth } from "../../auth/AuthContext";
import { Pill, type PillTone } from "../../components/Pill";
import { when } from "../../time";
import { errorMessage, listAllTeams, listAudit, type AuditEntryView, getAuditCopy, type AuditCopy } from "../../api";

/** "vennir.console.v1.SecretService/PutSecret" → "Put secret", "catalog-sync" → "Catalog sync". */
function actionName(route: string): { action: string; service: string } {
  const [service = "", method] = route.replace(/^vennir\.console\.v1\./, "").split("/");
  const words = (method ?? service).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/-/g, " ").toLowerCase();
  return { action: words.charAt(0).toUpperCase() + words.slice(1), service: method ? service.replace(/Service$/, "") : "" };
}

function outcome(status: number): { label: string; tone: PillTone } {
  if (status === 207) return { label: "Done, with problems", tone: "warning" };
  if (status < 400) return { label: "Done", tone: "success" };
  if (status === 401 || status === 403) return { label: "Refused", tone: "error" };
  if (status < 500) return { label: "Rejected", tone: "warning" };
  return { label: "Failed", tone: "error" };
}

/** An entry number, grouped when it's one ("18,405"). */
const entry = (n: number | string) => (/^\d+$/.test(String(n)) ? Number(n).toLocaleString() : String(n));

/** One of the copy's three figures, with the swatch it has on the bar above. */
function CopyFigure({ swatch, label, value, note }: { swatch: string; label: string; value: string; note: string }) {
  return (
    <Box sx={{ display: "flex", gap: 1.25, alignItems: "flex-start", p: 1.75, border: 1, borderColor: "divider", borderRadius: 2, bgcolor: "background.default" }}>
      <Box aria-hidden="true" sx={{ flex: "0 0 12px", height: 12, mt: 0.375, borderRadius: 0.75, bgcolor: swatch }} />
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12.5 }}>
          {label}
        </Typography>
        <Typography sx={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</Typography>
        <Typography variant="caption">{note}</Typography>
      </Box>
    </Box>
  );
}

/**
 * The log's write-once copy: whether its hash chain held, how far it has
 * been copied, and how far the database has been compared with the copy.
 * Nothing when there's no copy.
 */
function WriteOnceCopy() {
  const { user } = useAuth();
  const [copy, setCopy] = useState<AuditCopy | null>(null);
  useEffect(() => {
    // Display only: without it, the section just isn't shown.
    getAuditCopy().then(setCopy).catch(() => undefined);
  }, []);
  if (!copy?.enabled) return null;

  const latest = copy.copiedThrough + copy.waiting;
  const pct = (n: number) => (latest ? Math.min(100, (100 * n) / latest) : 0);
  const status =
    copy.differsAt > 0 ? (
      <Pill tone="error">Changed since copied</Pill>
    ) : copy.brokenAt > 0 ? (
      <Pill tone="error">Chain broken</Pill>
    ) : copy.compareProblem ? (
      <Pill tone="warning">Not compared</Pill>
    ) : !copy.checkedAt ? (
      <Pill tone="neutral">Not checked yet</Pill>
    ) : (
      <Pill tone="success" dot="currentColor">
        Chain intact
      </Pill>
    );

  return (
    <Card component="section" aria-label="The write-once copy" sx={{ px: 2.75, py: 2.5, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 1.5 }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, maxWidth: 780 }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.25 }}>
            <Typography variant="h6" component="h2">
              Its write-once copy
            </Typography>
            {status}
            <Typography variant="caption" color="text.secondary">
              {copy.checkedAt ? `checked ${when(copy.checkedAt)}` : "not checked yet"}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            Each entry is hash-chained to the one before. Every few minutes the new ones, their chain checked, are copied to{" "}
            {copy.destination ? <Mono sx={{ fontSize: 12 }}>{copy.destination}</Mono> : "a bucket"}
            {copy.destination ? ", a bucket" : ""} that refuses deletes and overwrites; and the database is compared with the copy, entry by
            entry, round and round, which catches a change whose hashes were all rewritten.
          </Typography>
        </Box>
        {user?.isAdmin && (
          <Button component={RouterLink} to="/admin/audit" variant="outlined" size="large">
            Where it&apos;s set
          </Button>
        )}
      </Box>

      {copy.brokenAt > 0 && (
        <Alert severity="error">
          The log&apos;s chain breaks at entry {entry(copy.brokenAt)}: it was changed, or one before it removed or added, after it was
          written. Its copy stops there.
        </Alert>
      )}
      {copy.differsAt > 0 && (
        <Alert severity="error">{copy.compareProblem || `Entry ${entry(copy.differsAt)} in the database differs from its write-once copy.`}</Alert>
      )}
      {/* The comparison couldn't run: nothing says the database still matches. */}
      {copy.compareProblem && copy.differsAt === 0 && <Alert severity="warning">Not compared with its copy: {copy.compareProblem}</Alert>}
      {/* The chain held, but nothing new is reaching the copy: as Admin's card says it. */}
      {copy.problem && copy.brokenAt === 0 && <Alert severity="warning">Not copying: {copy.problem}</Alert>}

      {latest > 0 && (
        <Box
          role="img"
          aria-label={`Entries 1 to ${entry(latest)}: copied through ${entry(copy.copiedThrough)}; compared with the copy through ${entry(copy.comparedThrough)}; ${copy.differsAt ? `differs at ${entry(copy.differsAt)}` : "no difference found"}`}
          sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}
        >
          <Box sx={{ position: "relative", height: 14, borderRadius: 1.75, bgcolor: "action.hover", overflow: "hidden" }}>
            <Box sx={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${String(pct(copy.copiedThrough))}%`, bgcolor: "info.light", border: 1, borderColor: "primary.main", borderRadius: 1.75, opacity: 0.6 }} />
            <Box sx={{ position: "absolute", top: 3, bottom: 3, left: 0, width: `${String(pct(copy.comparedThrough))}%`, bgcolor: "primary.main", borderRadius: "0 4px 4px 0" }} />
          </Box>
          <Box sx={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "text.secondary" }}>
            <span>entry 1</span>
            <span>{entry(latest)}</span>
          </Box>
        </Box>
      )}

      <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <CopyFigure
          swatch="info.light"
          label="Copied through"
          value={copy.copiedThrough ? `entry ${entry(copy.copiedThrough)}` : "nothing yet"}
          note={[copy.copiedAt ? `at ${when(copy.copiedAt)}` : "", `${copy.waiting.toLocaleString()} waiting for the next copy`].filter(Boolean).join(" · ")}
        />
        <CopyFigure
          swatch="primary.main"
          label="Compared with the copy through"
          value={copy.comparedThrough ? `entry ${entry(copy.comparedThrough)}` : "nothing yet"}
          note={[
            copy.comparedAt ? `at ${when(copy.comparedAt)}` : "",
            copy.copiedThrough ? `this round is ${String(Math.round((100 * copy.comparedThrough) / copy.copiedThrough))}% done` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        <CopyFigure
          swatch={copy.differsAt ? "error.main" : copy.compareProblem || !copy.checkedAt ? "warning.main" : "success.main"}
          label="Differs at"
          value={copy.differsAt ? `entry ${entry(copy.differsAt)}` : copy.compareProblem ? "not compared" : !copy.checkedAt ? "not checked yet" : "nowhere"}
          note={
            copy.differsAt
              ? "the database no longer matches its copy there"
              : copy.compareProblem
                ? "the comparison couldn't run, as said above"
                : !copy.checkedAt
                  ? "its first check runs within minutes"
                  : "the database agrees with its copy so far"
          }
        />
      </Box>
    </Card>
  );
}

function targetText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const AUDIT: DataTableColumn<AuditEntryView>[] = [
  { key: "id", header: "Entry", render: (e) => <Mono sx={{ fontSize: 12, color: "text.secondary" }}>{entry(e.id)}</Mono>, align: "right", hideBelow: "md" },
  { key: "when", header: "When", render: (e) => <Box component="span" sx={{ whiteSpace: "nowrap" }}>{e.at ? when(e.at) : "—"}</Box>, hideBelow: "sm" },
  {
    key: "who",
    header: "Who",
    render: (e) => (
      <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
        <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: { xs: "anywhere", md: "normal" } }}>
          {e.actorEmail ?? "The console"}
        </Typography>
        {e.actorIsBot && <Pill tone="neutral">bot</Pill>}
      </Stack>
    ),
  },
  {
    key: "what",
    header: "What",
    render: (e) => {
      const { action, service } = actionName(e.route);
      return (
        <Box>
          <Typography variant="body2">{action}</Typography>
          {service && (
            <Typography variant="caption" color="text.secondary">
              {service}
            </Typography>
          )}
        </Box>
      );
    },
  },
  {
    key: "target",
    header: "On",
    render: (e) => (
      <Stack spacing={0.25} sx={{ minWidth: 200 }}>
        {Object.entries(e.target).map(([key, value]) => (
          <Typography key={key} variant="caption" sx={{ overflowWrap: "anywhere" }}>
            <Box component="span" sx={{ color: "text.secondary" }}>
              {key}:
            </Box>{" "}
            {key === "executionId" && typeof value === "string" ? (
              <Link component={RouterLink} to={`/runs/${value}`}>
                <Mono>{value.slice(0, 8)}</Mono>
              </Link>
            ) : (
              targetText(value)
            )}
          </Typography>
        ))}
      </Stack>
    ),
    hideBelow: "md",
  },
  {
    key: "outcome",
    header: "Outcome",
    render: (e) => (
      <Pill tone={outcome(e.status).tone} title={`HTTP ${String(e.status)}`}>
        {outcome(e.status).label}
      </Pill>
    ),
  },
];

export function AuditTab() {
  const { user } = useAuth();
  const [teams, setTeams] = useState<string[]>([]);
  const [team, setTeam] = useState("");
  const [mine, setMine] = useState(false);
  const [refusedOnly, setRefusedOnly] = useState(false);
  const [entries, setEntries] = useState<AuditEntryView[] | null>(null);
  const [nextBefore, setNextBefore] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each filter's number: Load older for an earlier one is dropped.
  const listing = useRef(0);

  useEffect(() => {
    if (!user) return;
    if (!user.isAdmin) {
      setTeams(user.teamNames);
      return;
    }
    listAllTeams()
      .then((all) => {
        setTeams(all.map((t) => t.name).sort());
      })
      .catch(() => {
        setTeams([]);
      });
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    listing.current += 1;
    setEntries(null);
    setNextBefore("");
    setLoadingMore(false);
    setError(null);
    listAudit({ team, mine, refusedOnly })
      .then((page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setNextBefore(page.nextBefore);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Failed to load the audit log."));
      });
    return () => {
      cancelled = true;
    };
  }, [team, mine, refusedOnly]);

  async function loadMore(): Promise<void> {
    const mineNow = listing.current;
    setLoadingMore(true);
    try {
      const page = await listAudit({ before: nextBefore, team, mine, refusedOnly });
      if (mineNow !== listing.current) return; // the filters changed meanwhile
      setEntries((shown) => [...(shown ?? []), ...page.entries]);
      setNextBefore(page.nextBefore);
    } catch (err) {
      if (mineNow === listing.current) setError(errorMessage(err, "Failed to load more."));
    } finally {
      if (mineNow === listing.current) setLoadingMore(false);
    }
  }

  return (
    <Stack spacing={2.5}>
      <WriteOnceCopy />
      <Card component="section" aria-label="Who changed what" sx={{ overflow: "hidden" }}>
        <Box sx={{ px: 2.75, pt: 2.25, pb: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography variant="h6" component="h2">
            Who changed what
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            {user?.isAdmin
              ? "Every change anyone asked for, allowed or refused: as an admin, you see all of it. Secrets' values, passwords and tokens are never recorded."
              : "Your own changes, and every change to your teams and their runs, by anyone. Secrets' values, passwords and tokens are never recorded."}
          </Typography>
        </Box>
        {error && (
          <Alert severity="error" sx={{ mx: 2.75, my: 1 }}>
            {error}
          </Alert>
        )}
        <Box sx={{ px: 2.75, pt: 0.5, pb: 1.5, display: "flex", columnGap: 2.75, rowGap: 0.75, flexWrap: "wrap", alignItems: "center" }}>
          <FormControl size="small" sx={{ minWidth: 180, "& .MuiInputBase-root": { minHeight: 44 } }}>
            <InputLabel id="audit-team-label">Team</InputLabel>
            <Select
              labelId="audit-team-label"
              label="Team"
              value={team}
              onChange={(event) => {
                setTeam(event.target.value);
              }}
            >
              <MenuItem value="">{user?.isAdmin ? "Everything" : "All you can see"}</MenuItem>
              {teams.map((name) => (
                <MenuItem key={name} value={name}>
                  {name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControlLabel
            control={
              <Switch
                checked={mine}
                onChange={(event) => {
                  setMine(event.target.checked);
                }}
              />
            }
            label="Only mine"
            sx={{ minHeight: 44 }}
          />
          <FormControlLabel
            control={
              <Switch
                checked={refusedOnly}
                onChange={(event) => {
                  setRefusedOnly(event.target.checked);
                }}
              />
            }
            label="Only refused or failed"
            sx={{ minHeight: 44 }}
          />
        </Box>
        <Box sx={{ borderTop: 1, borderColor: "divider" }}>
          <DataTable columns={AUDIT} rows={entries} getRowKey={(e) => e.id} emptyMessage="Nothing recorded that you can see." />
        </Box>
        {nextBefore && (
          <Box sx={{ display: "flex", justifyContent: "center", px: 2.75, py: 1.75 }}>
            <Button variant="outlined" size="large" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load older entries"}
            </Button>
          </Box>
        )}
      </Card>
    </Stack>
  );
}
