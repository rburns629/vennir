// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import SyncIcon from "@mui/icons-material/Sync";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { errorMessage, adoptCatalogTeam, getCatalogStatus, getInstall, syncCatalog, type CatalogCounts, type CatalogStatus } from "../../api";
import { when } from "../../time";
import { AdminCard, Dot, KeyValues, PILL_TONE, SrOnly, TONE_WORD, type Tone } from "./parts";
import { catalogState, useAdminChanged } from "./summary";

/** One of the release's three facts: published, its signature, applied. */
function Tile({ tone, label, value, children }: { tone: Tone; label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <Box sx={{ bgcolor: "background.default", borderRadius: 2, p: 2, display: "flex", flexDirection: "column", gap: 0.5, minWidth: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: 13, color: "text.secondary" }}>
        <Dot tone={tone} />
        {label}
        <SrOnly>, {TONE_WORD[tone]}</SrOnly>
      </Box>
      <Typography variant="body1" sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
        {value}
      </Typography>
      {children && (
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          {children}
        </Typography>
      )}
    </Box>
  );
}

/**
 * The catalog this console registers from: its release in the registry,
 * which catalog CI pushes from main and this console reads every few
 * minutes, verifies and applies (teams, products, SecretStores). Sync now
 * reads and applies it at once; a team the catalog found but didn't make
 * waits for an admin to adopt it.
 */
/** "5 teams, 14 products, 6 templates, 4 SecretStores": what the release held, leaving out what it had none of. */
function heldText(c: CatalogCounts): string {
  const n = (count: number, one: string, many: string) => (count > 0 ? `${String(count)} ${count === 1 ? one : many}` : "");
  const parts = [
    n(c.teams, "team", "teams"),
    c.products > 0 ? `${n(c.products, "product", "products")}${c.actions > c.products ? ` (${String(c.actions)} actions)` : ""}` : "",
    n(c.templates, "template", "templates"),
    n(c.apis, "API", "APIs"),
    n(c.secretStores, "SecretStore", "SecretStores"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "An empty release.";
}

export function CatalogCard() {
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [signed, setSigned] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [adopting, setAdopting] = useState<string | null>(null);

  useEffect(() => {
    getCatalogStatus()
      .then(setStatus)
      .catch((err: unknown) => {
        setError(errorMessage(err, "Failed to load the catalog's status."));
      });
    // Display only: without it, the signature isn't described.
    getInstall()
      .then((i) => { setSigned(i.catalogSigned); })
      .catch(() => undefined);
  }, []);

  const changed = useAdminChanged();
  async function sync(): Promise<void> {
    setError(null);
    setSyncing(true);
    try {
      setStatus(await syncCatalog());
      changed();
    } catch (err) {
      setError(errorMessage(err, "Something went wrong. Try again."));
    } finally {
      setSyncing(false);
    }
  }

  async function adopt(name: string): Promise<void> {
    setError(null);
    setSyncing(true);
    try {
      setStatus(await adoptCatalogTeam(name));
      setAdopting(null);
      changed();
    } catch (err) {
      setError(errorMessage(err, "Something went wrong. Try again."));
    } finally {
      setSyncing(false);
    }
  }

  const state = status ? catalogState(status) : null;
  const commit = status?.commit && /^[0-9a-f]{40}$/.test(status.commit) ? status.commit.slice(0, 12) : status?.commit;

  return (
    <>
      <AdminCard
        title="The release"
        status={
          state &&
          status?.release && (
            <Pill tone={PILL_TONE[state.tone]}>
              {state.tone === "ok" ? "Applied" : status.problems.length > 0 && !status.error ? `Applied, except ${String(status.problems.length)} ${status.problems.length === 1 ? "item" : "items"}` : state.text}
            </Pill>
          )
        }
      >
        {status && !status.release && (
          <Alert severity="info">
            No catalog is configured (the console chart&apos;s <Mono>catalog.release</Mono>; <Mono>vennir catalog create</Mono> makes one).
            Teams and products are only what admins make here.
          </Alert>
        )}
        {status?.release && (
          <>
            <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
              <Tile tone={status.commit ? "ok" : "off"} label="Applied release" value={status.version || (commit ? <Mono>{commit}</Mono> : "Nothing yet")}>
                {status.commit && (
                  <>
                    {status.repository ? <>by {status.repository}, </> : null}commit <Mono>{commit}</Mono>
                  </>
                )}
              </Tile>
              {signed !== null && (
                <Tile tone={signed ? "ok" : "warn"} label="Signature" value={signed ? "Checked" : "Not checked"}>
                  {signed ? "Each release's signature is checked before it's applied, against the signers the install trusts." : "Any release in the registry is applied: the install trusts no signer."}
                </Tile>
              )}
              <Tile tone={status.error ? "err" : status.problems.length > 0 ? "warn" : status.appliedAt ? "ok" : "off"} label="Applied" value={status.appliedAt ? when(status.appliedAt) : "Nothing yet"}>
                {status.error ? "The last attempt failed (below)." : status.applied ? heldText(status.applied) : null}
              </Tile>
            </Box>
            <KeyValues
              rows={[
                [
                  "Release",
                  status.newestVersion ? (
                    <>
                      the newest version of <Mono>{status.release.replace(/[:@][^/]*$/, "")}</Mono>
                    </>
                  ) : (
                    <Mono>{status.release}</Mono>
                  ),
                ],
                ["Last looked", status.checkedAt ? when(status.checkedAt) : "never"],
              ]}
            />
            {status.error && <Alert severity="error">{status.error}</Alert>}
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
              <Button variant="contained" startIcon={<SyncIcon />} disabled={syncing} onClick={() => void sync()} sx={{ minHeight: 44 }}>
                {syncing ? "Syncing…" : "Sync now"}
              </Button>
              <Typography variant="caption" color="text.secondary">
                Reads the release and applies it, even if it&apos;s the one already applied.
              </Typography>
            </Box>
          </>
        )}
        {error && <Alert severity="error">{error}</Alert>}
      </AdminCard>

      {status?.release && status.problems.length > 0 && (
        <AdminCard title="The last release was applied except" accent="warning">
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none" }}>
            {status.problems.map((p) => (
              <Box component="li" key={p.item} sx={{ display: "flex", gap: 2, alignItems: "flex-start", flexWrap: "wrap", py: 1.5, borderTop: 1, borderColor: "divider" }}>
                <Pill tone="warning">{p.item}</Pill>
                <Typography variant="body2" color="text.secondary" sx={{ flex: "1 1 280px", minWidth: 0, overflowWrap: "anywhere" }}>
                  {p.message}
                </Typography>
                {p.adoptableTeam && (
                  <Button variant="outlined" disabled={syncing} onClick={() => { setAdopting(p.adoptableTeam); }} sx={{ minHeight: 44 }}>
                    Adopt {p.adoptableTeam}…
                  </Button>
                )}
              </Box>
            ))}
          </Box>
          {status.problems.some((p) => p.adoptableTeam) && (
            <Alert severity="info">
              Adopting lets the catalog manage that team: releases register its products, apply its SecretStores, and retire it if its folder
              goes. Its members, secrets and history stay.
            </Alert>
          )}
        </AdminCard>
      )}

      <ConfirmDialog
        open={adopting !== null}
        title={`Let the catalog manage ${adopting ?? ""}?`}
        description="The catalog's folder of that name becomes this team: its releases will register products into it, apply its SecretStores, and retire it if the folder goes. Its members, secrets and history stay. Do this only if the folder is meant to be this team."
        confirmLabel="Adopt"
        busy={syncing}
        onConfirm={() => { if (adopting) void adopt(adopting); }}
        onCancel={() => { setAdopting(null); }}
      />
    </>
  );
}
