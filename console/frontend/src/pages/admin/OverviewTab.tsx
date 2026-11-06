// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import SyncIcon from "@mui/icons-material/Sync";
import LinkIcon from "@mui/icons-material/LinkOutlined";
import { errorMessage, getAuditCopy, getPolicyState, getSecurity, syncPolicyState, type AuditCopy, type CatalogPolicies, type PolicySync } from "../../api";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { when } from "../../time";
import { CatalogCard } from "./CatalogCard";
import { EveryPart, FirstRunChecklist, InstallStats, NeedsYou } from "./InstallCards";
import { AdminCard, Aside, Dot, KeyValues, PILL_TONE, SrOnly, TABLE_SX, TONE_WORD, type Tone } from "./parts";
import { auditState, policiesState, type AdminSummary, useAdminChanged } from "./summary";

/**
 * What each policy the console writes holds, as people say it, and the code
 * a step it stops fails with. The names are policySync.ts's; one this page
 * doesn't know yet shows its name.
 */
const POLICY: Record<string, { label: string; about: ReactNode; code?: string }> = {
  identityPolicy: {
    label: "Products, and the identities and secrets each may use",
    about: "Which ServiceAccount each product runs as, and which of its team's Secrets a step may mount.",
    code: "IDENTITY_NOT_ALLOWED",
  },
  imagePolicy: { label: "Where images may come from", about: <>The sources in <Link component={RouterLink} to="/admin/images">Image sources</Link>.</>, code: "IMAGE_NOT_ALLOWED" },
  scanPolicy: {
    label: "Images that failed their scan",
    about: <>The digests that may not run, from <Link component={RouterLink} to="/admin/scans">Image scans</Link>.</>,
    code: "IMAGE_SCAN_FAILED",
  },
  gatewayTokenPolicy: {
    label: "The gateway's backend credentials",
    about: "The token audiences each API's ServiceAccount may have: only what its published API's backend sign-in needs.",
  },
  pullSecrets: { label: "Registry sign-in for each team", about: "The pull secret each team namespace uses to fetch images from private registries." },
  apiNamespaces: { label: "Each team's API backends' namespace", about: "<team>-apis, where a team runs its API backends, apart from its steps and their Secrets." },
  teamNetworkPolicies: {
    label: "What each team's steps may reach",
    about: "Each team namespace's network policies, and its API backends' namespace's: no other team's Pods, and only the gateway into its API backends.",
  },
  schedulerLogs: { label: "The scheduler's log reading", about: "Lets the kernel's scheduler read its steps' logs in team namespaces, and nothing else." },
  teamQuotas: { label: "What each team may use together", about: "Each team namespace's quota and per-step memory ceiling: its own, or the install's." },
};

/** The admission policies the kernel chart installs, which hold however the console is set. */
const KERNEL_POLICIES: { label: string; about: ReactNode; code?: string }[] = [
  { label: "Where steps may run", about: "Only in namespaces labelled vennir/team=true, never the platform's own.", code: "DISPATCH_REJECTED" },
  { label: "Where images may come from", about: <>The sources in <Link component={RouterLink} to="/admin/images">Image sources</Link>, which the console edits in place.</>, code: "IMAGE_NOT_ALLOWED" },
  { label: "Images are pinned", about: "Every image must name its digest.", code: "IMAGE_NOT_PINNED" },
  { label: "Catalog images are signed", about: <>When the install turns on <Mono>imageSignature</Mono>: checked by Sigstore&apos;s policy-controller.</>, code: "IMAGE_NOT_SIGNED" },
  { label: "Who may delete a team's namespace", about: "Only a retired team's (or its API backends' namespace), and only by the purger the install names." },
];

/** Steps the cluster refused in the last day, from Observe's Security view. */
function RefusedToday() {
  const [refused, setRefused] = useState<{ code: string; team: string }[] | null>(null);
  useEffect(() => {
    // Display only: without it, the card isn't shown.
    getSecurity()
      .then((s) => {
        const since = Date.now() - 24 * 3_600_000;
        setRefused(s.refusals.filter((r) => r.source === "step" && r.at && new Date(r.at).getTime() >= since).map((r) => ({ code: r.code, team: r.team })));
      })
      .catch(() => undefined);
  }, []);
  if (!refused) return null;
  const codes = [...new Set(refused.map((r) => r.code))];
  return (
    <AdminCard title={`Steps the cluster refused: ${String(refused.length)} in the last 24 hours`}>
      <Typography variant="body2" color="text.secondary">
        {refused.length > 0 && <>{codes.length === 1 ? `All ${codes[0] ?? ""}` : codes.join(", ")}. </>}
        Each refusal is listed in Observe, beside what the console and the gateway refused.
      </Typography>
      <Box>
        <Button component={RouterLink} to="/observe?tab=security" variant="outlined" sx={{ minHeight: 44 }}>
          See them in Observe →
        </Button>
      </Box>
    </AdminCard>
  );
}

/** The cluster's admission policies: the ones the console writes, the ones the kernel chart installs, and what they refused. */
export function PoliciesCard() {
  const [policies, setPolicies] = useState<PolicySync[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogPolicies | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPolicyState()
      .then((s) => {
        setPolicies(s.policies);
        setCatalog(s.catalog);
      })
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't read the policies.")); });
  }, []);

  const changed = useAdminChanged();
  async function sync(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const s = await syncPolicyState();
      setPolicies(s.policies);
      setCatalog(s.catalog);
      changed();
    } catch (err) {
      setError(errorMessage(err, "Couldn't write them."));
    } finally {
      setBusy(false);
    }
  }

  const state = policies ? policiesState(policies) : null;
  const applying = (policies ?? []).filter((p) => p.applies);
  const ok = applying.filter((p) => p.ok).length;
  const toneOf = (p: PolicySync): Tone => (!p.applies ? "off" : p.ok ? "ok" : "err");
  return (
    <>
      <AdminCard
        label="Written by the console"
        title={
          <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
            Written by the console
            {state && (
              <Pill tone={PILL_TONE[state.tone]} dot={state.tone === "ok" ? "success.main" : undefined}>
                {state.tone === "ok" ? `In sync: ${String(ok)} of ${String(applying.length)}` : state.text}
              </Pill>
            )}
          </Box>
        }
        status={
          <Button variant="outlined" startIcon={<SyncIcon />} disabled={busy} onClick={() => void sync()} sx={{ minHeight: 44 }}>
            {busy ? "Writing…" : "Write them again"}
          </Button>
        }
      >
        {error && <Alert severity="error">{error}</Alert>}
        {policies && (
          <Box sx={{ overflowX: "auto" }}>
            <Box component="table" sx={TABLE_SX}>
              <thead>
                <tr>
                  <th scope="col">Policy</th>
                  <Box component="th" scope="col" sx={{ display: { xs: "none", sm: "table-cell" } }}>
                    A step it stops fails with
                  </Box>
                  <th scope="col">Last written</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => {
                  const known = POLICY[p.name];
                  return (
                    <tr key={p.name}>
                      <td>
                        <Box sx={{ display: "flex", gap: 1.25, alignItems: "flex-start" }}>
                          <Dot tone={toneOf(p)} sx={{ mt: 0.75 }} />
                          <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              {known?.label ?? p.name}
                              <SrOnly>, {TONE_WORD[toneOf(p)]}</SrOnly>
                            </Typography>
                            {known && (
                              <Typography variant="caption" color="text.secondary">
                                {known.about}
                              </Typography>
                            )}
                            {p.error && (
                              <Typography variant="caption" color="error.main" sx={{ overflowWrap: "anywhere" }}>
                                {p.error}
                              </Typography>
                            )}
                          </Box>
                        </Box>
                      </td>
                      <Box component="td" sx={{ display: { xs: "none", sm: "table-cell" } }}>
                        {known?.code ? <Mono>{known.code}</Mono> : "—"}
                      </Box>
                      <Box component="td" sx={{ whiteSpace: "nowrap", color: "text.secondary" }}>
                        {!p.applies ? "Not used here" : p.ok ? (p.at ? `Written ${when(p.at)}` : "Written") : "Failed"}
                      </Box>
                    </tr>
                  );
                })}
              </tbody>
            </Box>
          </Box>
        )}
        <Typography variant="caption" color="text.secondary">
          A policy that fails to write shows its error here; admins are alerted when one keeps failing. &ldquo;Not used here&rdquo;: this
          install doesn&apos;t have the console keep it. Where images may come from is written when{" "}
          <Link component={RouterLink} to="/admin/images">
            Image sources
          </Link>{" "}
          are saved.
        </Typography>
        {catalog && (
          <Typography variant="caption" color="text.secondary">
            {catalog.writer === "console"
              ? "The catalog isn't signed, so the console alone writes which images run as each product, and each API's token audiences: a console that's taken over could loosen them."
              : catalog.release
                ? `Which images run as each product, and each API's token audiences, the kernel also writes, from the catalog release it verified${catalog.commit ? ` (commit ${catalog.commit.slice(0, 12)})` : ""}: a step must pass both, so the console can't loosen them.`
                : "The kernel will also write which images run as each product, and each API's token audiences, once it has verified a catalog release; until then its copies are what the console last wrote."}
          </Typography>
        )}
      </AdminCard>

      <AdminCard title="Installed with the kernel" status={<Aside>Changed by an upgrade, not here</Aside>}>
        <Typography variant="body2" color="text.secondary">
          Admission policies the kernel chart installs. They hold however the console is set, so a console that&apos;s wrong, or taken over,
          still can&apos;t run a step anywhere else.
        </Typography>
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none" }}>
          {KERNEL_POLICIES.map((k) => (
            <Box component="li" key={k.label} sx={{ display: "flex", justifyContent: "space-between", gap: 2, flexWrap: "wrap", py: 1.5, borderTop: 1, borderColor: "divider" }}>
              <Box sx={{ minWidth: 0, flex: "1 1 280px" }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {k.label}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {k.about}
                </Typography>
              </Box>
              {k.code && <Mono>{k.code}</Mono>}
            </Box>
          ))}
        </Box>
      </AdminCard>

      <RefusedToday />
    </>
  );
}

const STATE_MEANS: { tone: Tone; name: string; means: string }[] = [
  { tone: "ok", name: "Intact", means: "The chain held, and the copies compared so far match the database." },
  { tone: "warn", name: "Not copying", means: "The last copy failed: the reason is shown, and entries wait until it works." },
  { tone: "warn", name: "Not compared", means: "The database couldn't be compared with its copy (the reason is shown), so a change there wouldn't be noticed until it can." },
  { tone: "off", name: "Not checked yet", means: "The copy is on, but its first check hasn't run: it does within minutes." },
  { tone: "err", name: "Chain broken", means: "An entry was changed, removed or added after it was written. Nothing from there on is copied." },
  { tone: "err", name: "Changed since copied", means: "An entry in the database differs from its copy in the bucket." },
  { tone: "off", name: "Off", means: "No copy: the log is only in the console's database, and nothing checks its chain." },
];

/** The audit log's write-once copy: how far it has gone, whether its chain held, and what each state means. */
export function AuditCopyCard() {
  const [copy, setCopy] = useState<AuditCopy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAuditCopy()
      .then(setCopy)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't read the audit copy.")); });
  }, []);

  const state = copy ? auditState(copy) : null;
  const total = copy ? copy.copiedThrough + copy.waiting : 0;
  const share = total > 0 && copy ? (copy.copiedThrough / total) * 100 : 0;

  return (
    <>
      <AdminCard title="The audit log's copy" status={state && <Pill tone={PILL_TONE[state.tone]}>{state.text}</Pill>}>
        {error && <Alert severity="error">{error}</Alert>}
        {copy && !copy.enabled && (
          <Typography variant="body2" color="text.secondary">
            The audit log is in the console&apos;s database only. Its entries are hash-chained, but nothing checks the chain until they&apos;re
            copied to a bucket that refuses deletes: <Mono>audit.export</Mono> in vennir.yaml (gcp, aws).
          </Typography>
        )}
        {copy?.enabled && (
          <>
            {state?.tone === "ok" && (
              <Alert severity="success" icon={<LinkIcon fontSize="small" />}>
                The chain held through entry {copy.copiedThrough.toLocaleString()}, and the copies compared so far match the database.
              </Alert>
            )}
            {copy.brokenAt > 0 && (
              <Alert severity="error">
                The chain breaks at entry {copy.brokenAt.toLocaleString()}: it was changed, or one before it was removed or added, after it
                was written. Nothing from there on is copied.
              </Alert>
            )}
            {copy.problem && copy.brokenAt === 0 && <Alert severity="warning">{copy.problem}</Alert>}
            {copy.differsAt > 0 && <Alert severity="error">{copy.compareProblem}</Alert>}
            {copy.compareProblem && copy.differsAt === 0 && <Alert severity="warning">{copy.compareProblem}</Alert>}
            {total > 0 && (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
                <Box sx={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <span>Entries copied</span>
                  <span>
                    {copy.copiedThrough.toLocaleString()} of {total.toLocaleString()}
                  </span>
                </Box>
                <Box
                  role="img"
                  aria-label={`${copy.copiedThrough.toLocaleString()} of ${total.toLocaleString()} entries copied; ${copy.waiting.toLocaleString()} waiting`}
                  sx={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", bgcolor: "divider" }}
                >
                  <Box sx={{ width: `${String(share)}%`, bgcolor: "success.main" }} />
                  <Box sx={{ flex: 1, bgcolor: copy.waiting > 0 ? "warning.main" : "transparent" }} />
                </Box>
                <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", fontSize: 12, color: "text.secondary" }}>
                  <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.75 }}>
                    <Dot tone="ok" />
                    Copied
                  </Box>
                  <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.75 }}>
                    <Dot tone="warn" />
                    Waiting for the next copy: {copy.waiting.toLocaleString()}
                  </Box>
                </Box>
              </Box>
            )}
            <KeyValues
              rows={[
                ["Copied to", <Mono key="d">{copy.destination || "—"}</Mono>],
                ["Last copy", copy.copiedAt ? `${when(copy.copiedAt)}, through entry ${copy.copiedThrough.toLocaleString()}` : "not yet"],
                ["Chain checked", copy.checkedAt ? when(copy.checkedAt) : "not yet"],
                ["Compared with the copy", copy.comparedAt ? `${when(copy.comparedAt)}, through entry ${copy.comparedThrough.toLocaleString()} this round` : "not yet"],
              ]}
            />
          </>
        )}
        <Box>
          <Button component={RouterLink} to="/observe?tab=audit" variant="outlined" sx={{ minHeight: 44 }}>
            Read the audit log in Observe →
          </Button>
        </Box>
      </AdminCard>

      <AdminCard title="What its state means">
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none" }}>
          {STATE_MEANS.map((s) => (
            <Box
              component="li"
              key={s.name}
              sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "200px 1fr" }, gap: { xs: 0.25, sm: 2 }, py: 1.25, borderTop: 1, borderColor: "divider" }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, fontWeight: 500, fontSize: 14 }}>
                <Dot tone={s.tone} />
                {s.name}
              </Box>
              <Typography variant="body2" color="text.secondary">
                {s.means}
              </Typography>
            </Box>
          ))}
        </Box>
      </AdminCard>
    </>
  );
}

/** This install at a glance: its figures, what needs an admin, whether it's ready to run, and every part with where it's set. */
export function OverviewTab({ summary }: { summary: AdminSummary | null }) {
  if (!summary) {
    return (
      <Typography variant="body2" color="text.secondary">
        Reading this install…
      </Typography>
    );
  }
  return (
    <>
      <InstallStats summary={summary} />
      <NeedsYou summary={summary} />
      <FirstRunChecklist summary={summary} />
      <EveryPart summary={summary} />
    </>
  );
}

/** Where teams, products and templates come from; the images they run are in Image sources and Image scans. */
export function CatalogSection() {
  return (
    <>
      <CatalogCard />
      <Typography variant="body2" color="text.secondary">
        Admins are alerted when the catalog can&apos;t be pulled. Where its images may come from is in{" "}
        <Link component={RouterLink} to="/admin/images">
          Image sources
        </Link>
        ; every image allowed to run here, with its last scan, is in{" "}
        <Link component={RouterLink} to="/admin/scans">
          Image scans
        </Link>
        .
      </Typography>
    </>
  );
}
