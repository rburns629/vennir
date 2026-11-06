// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { errorMessage, getGateway, listAllApiGrants, listApis, setGatewayClosed, type AllApiGrants, type ApiGrant, type ApiProduct, type GatewayInfo } from "../../api";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { grantedByText, grantName, Principal, rateText, revokeAsk, useAccessAsk } from "../api/access";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Mono";
import { when } from "../../time";
import { useAdminChanged } from "./summary";
import { AdminCard, Aside, KeyValues, TABLE_SX } from "./parts";

/** Why the gateway stopped a request, as people say it, and what it answered (the gateway's own outcomes). */
const OUTCOME: Record<string, { why: string; answered: string }> = {
  blocked: { why: "Not in the API's spec", answered: "404" },
  invalid: { why: "Didn't match the spec, or too large", answered: "400, 413" },
  unauthenticated: { why: "Not signed in, or token unknown", answered: "401" },
  forbidden: { why: "Not on the API's access list", answered: "403" },
  limited: { why: "Over a limit", answered: "429" },
  paused: { why: "API paused by its team", answered: "503" },
  closed: { why: "The gateway was closed", answered: "503" },
  held: { why: "Its backend isn't allowed yet", answered: "503" },
  unavailable: { why: "The API or its caller couldn't be checked", answered: "503" },
  backend_error: { why: "The backend failed or didn't answer", answered: "500, 502, 504" },
};

const count = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

function Figure({ label, value, note }: { label: string; value: ReactNode; note: ReactNode }) {
  return (
    <Card sx={{ p: 2, display: "flex", flexDirection: "column", gap: 0.5, minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography sx={{ fontSize: 24, fontWeight: 600, lineHeight: 1.25, fontVariantNumeric: "tabular-nums" }}>{value}</Typography>
      <Typography variant="caption" color="text.secondary">
        {note}
      </Typography>
    </Card>
  );
}

/**
 * The API gateway: how busy it is, this install's settings (its Helm
 * values, changed by an upgrade, not here), closing it (every API answers
 * 503 with the message, and nothing is forwarded, until it's reopened), and
 * what it refused at the door over the last day; its held APIs, and every
 * grant on every API (decision 26), which an admin may revoke in an
 * incident but not add or change.
 */
export function GatewayTab() {
  const [gateway, setGateway] = useState<GatewayInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(() => {
    getGateway()
      .then(setGateway)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the gateway.")); });
  }, []);
  useEffect(load, [load]);

  // Every API (what's held), and every grant a page at a time with the install's counts.
  const [apis, setApis] = useState<ApiProduct[] | null>(null);
  const [apisError, setApisError] = useState<string | null>(null);
  useEffect(() => {
    listApis()
      .then(setApis)
      .catch((err: unknown) => { setApisError(errorMessage(err, "Couldn't load the APIs.")); });
  }, []);
  const [access, setAccess] = useState<AllApiGrants | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const loadAccess = useCallback((cursor = "") => {
    setMore(cursor !== "");
    listAllApiGrants(cursor)
      .then((page) => {
        setAccess((had) => (cursor && had ? { ...page, grants: [...had.grants, ...page.grants] } : page));
        setAccessError(null);
      })
      .catch((err: unknown) => { setAccessError(errorMessage(err, "Couldn't load the grants.")); })
      .finally(() => { setMore(false); });
  }, []);
  useEffect(() => { loadAccess(); }, [loadAccess]);

  const changed = useAdminChanged();
  async function toggle(): Promise<void> {
    if (!gateway) return;
    setBusy(true);
    setError(null);
    try {
      await setGatewayClosed(gateway.closedMessage ? "" : message);
      setMessage("");
      setConfirming(false);
      load();
      changed();
    } catch (err) {
      setError(errorMessage(err, "That didn't work."));
      // The dialog closes, so the error shows on the page, not behind it.
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const held = apis?.filter((a) => a.state === "HELD") ?? [];
  const waitingApis = access?.waitingApis ?? 0;
  const refused = gateway?.refused.reduce((n, r) => n + r.count, 0) ?? 0;
  const share = gateway && gateway.requests24h > 0 ? `${((refused / gateway.requests24h) * 100).toFixed(1)}% of requests` : "of no requests";
  return (
    <>
      {error && <Alert severity="error">{error}</Alert>}
      {gateway && !gateway.enabled && (
        <Alert severity="info">
          The gateway isn&apos;t running on this install: <Mono>gateway.enabled</Mono> in vennir.yaml.
        </Alert>
      )}
      {gateway?.enabled && (
        <>
          {gateway.closedMessage && (
            <Alert severity="warning">
              Closed by {gateway.closedBy || "an admin"}
              {gateway.closedAt ? ` ${when(gateway.closedAt)}` : ""}: every API answers 503 with “{gateway.closedMessage}”.
            </Alert>
          )}
          <Box component="section" aria-label="The gateway now" sx={{ display: "grid", gap: 1.5, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            <Figure label="State" value={gateway.closedMessage ? "Closed" : "Open"} note={gateway.closedMessage ? "every API answers 503" : "forwarding what each spec allows"} />
            <Figure label="APIs published" value={gateway.apis} note={gateway.backendHosts.length === 0 ? "held until a backend host is allowed" : "on this install"} />
            <Figure label="Requests, 24 hours" value={gateway.requests24h.toLocaleString()} note={`to ${String(gateway.apis)} ${gateway.apis === 1 ? "API" : "APIs"}`} />
            <Figure label="Refused at the door" value={refused.toLocaleString()} note={share} />
            <Figure label="APIs held" value={apis ? `${String(held.length)} of ${String(apis.length)}` : "…"} note="its backend’s host isn’t allowed" />
            <Figure
              label="Grants"
              value={access ? access.total : "…"}
              note={access ? [count(access.groups, "group", "groups"), count(access.people, "person", "people"), count(access.bots, "bot", "bots")].join(", ") : ""}
            />
            <Figure label="Requests waiting" value={access ? access.waitingRequests : "…"} note={`on ${String(waitingApis)} ${waitingApis === 1 ? "API" : "APIs"}, for their teams`} />
          </Box>

          {held.length > 0 && (
            <AdminCard title={`Held APIs · ${String(held.length)}`} accent="warning">
              <Typography variant="body2" color="text.secondary">
                Not served, with the reason, on their pages too. Each serves by itself once its reason clears.
              </Typography>
              {held.map((a) => (
                <Box key={`${a.team}/${a.name}`} sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
                  <Link component={RouterLink} to={`/apis/${encodeURIComponent(a.team)}/${encodeURIComponent(a.name)}`} variant="body2" sx={{ fontWeight: 600 }}>
                    {a.displayName || a.name} <Mono sx={{ fontSize: 12, color: "text.secondary" }}>{a.team}/{a.name}</Mono>
                  </Link>
                  <Typography variant="body2" color="text.secondary">
                    {a.heldReason}
                  </Typography>
                </Box>
              ))}
            </AdminCard>
          )}

          {apisError && <Alert severity="error">{apisError}</Alert>}
          <EveryGrant
            apis={apis ?? []}
            access={access}
            error={accessError}
            loadingMore={more}
            onMore={() => { if (access?.nextCursor) loadAccess(access.nextCursor); }}
            onChanged={() => { loadAccess(); }}
          />

          <AdminCard title="This install's settings" status={<Aside>Read-only: an upgrade changes them</Aside>}>
            <KeyValues
              rows={[
                [
                  "Backends may be under",
                  <>
                    <Mono>{gateway.backendHosts.join(", ") || "nothing yet: every API is held"}</Mono>
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                      An API whose backend isn&apos;t under one is held, not published.
                    </Typography>
                  </>,
                ],
                [
                  "May publish to the internet",
                  <>
                    {gateway.internetTeams.join(", ") || "no team"}
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                      Other teams&apos; APIs answer inside the cluster only.
                    </Typography>
                  </>,
                ],
                ["Inside the cluster", <Mono key="url">{gateway.url}</Mono>],
                ["From the internet", gateway.publicUrl ? <Mono>{gateway.publicUrl}</Mono> : "not published"],
              ]}
            />
            <Typography variant="caption" color="text.secondary">
              These are the console chart&apos;s gateway values: an upgrade (<Mono>vennir apply</Mono>) changes them, not this page.
            </Typography>
          </AdminCard>

          <AdminCard title={gateway.closedMessage ? "Reopen the gateway" : "Close the gateway"} label={gateway.closedMessage ? "Reopen the gateway" : "Close the gateway"} danger={!gateway.closedMessage}>
            <Typography variant="body2" color="text.secondary">
              Every API answers 503 with your message until it&apos;s reopened, and nothing is forwarded. The console, runs and schedules carry
              on. Recorded in the audit log.
            </Typography>
            {!gateway.closedMessage && (
              <TextField
                size="small"
                fullWidth
                label="Message to every caller"
                placeholder="Maintenance until 15:00 UTC"
                helperText="Up to 500 characters"
                value={message}
                onChange={(e) => { setMessage(e.target.value); }}
                slotProps={{ htmlInput: { maxLength: 500 } }}
              />
            )}
            <Box>
              <Button
                variant="contained"
                color={gateway.closedMessage ? "primary" : "error"}
                disabled={busy || (!gateway.closedMessage && !message.trim())}
                onClick={() => {
                  if (gateway.closedMessage) void toggle();
                  else setConfirming(true);
                }}
                sx={{ minHeight: 44 }}
              >
                {gateway.closedMessage ? "Reopen" : "Close the gateway…"}
              </Button>
            </Box>
          </AdminCard>

          <AdminCard
            title="Refused at the door, last 24 hours"
            status={
              <Link component={RouterLink} to="/observe?tab=security" variant="body2">
                Each one, with its caller, in Observe →
              </Link>
            }
          >
            {gateway.refused.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nothing refused.
              </Typography>
            ) : (
              <Box sx={{ overflowX: "auto" }}>
                <Box component="table" sx={TABLE_SX}>
                  <thead>
                    <tr>
                      <th scope="col">Why</th>
                      <th scope="col">Answered</th>
                      <Box component="th" scope="col" sx={{ textAlign: "right !important" }}>
                        Requests
                      </Box>
                      <th scope="col">Mostly from</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gateway.refused.map((r) => (
                      <tr key={r.outcome}>
                        <td>{OUTCOME[r.outcome]?.why ?? r.outcome}</td>
                        <td>
                          <Mono>{OUTCOME[r.outcome]?.answered ?? "—"}</Mono>
                        </td>
                        <Box component="td" sx={{ textAlign: "right" }}>
                          {r.count.toLocaleString()}
                        </Box>
                        <td>{r.mostly || "a caller with no team"}</td>
                      </tr>
                    ))}
                  </tbody>
                </Box>
              </Box>
            )}
          </AdminCard>
          <Typography variant="body2" color="text.secondary">
            Each API&apos;s own limits, access list and traffic are on its page in{" "}
            <Link component={RouterLink} to="/apis">
              APIs
            </Link>
            .
          </Typography>
          <ConfirmDialog
            open={confirming}
            title="Close the gateway?"
            description={`Every API answers 503 with “${message.trim()}” until an admin reopens it, and nothing is forwarded.`}
            confirmLabel="Close the gateway"
            destructive
            busy={busy}
            onConfirm={() => void toggle()}
            onCancel={() => { setConfirming(false); }}
          />
        </>
      )}
    </>
  );
}

/** Every active grant on every API, for an incident: an admin revokes one; adding and changing them, and answering requests, are each API team's. */
function EveryGrant({
  apis,
  access,
  error,
  loadingMore,
  onMore,
  onChanged,
}: {
  apis: ApiProduct[];
  access: AllApiGrants | null;
  error: string | null;
  loadingMore: boolean;
  onMore: () => void;
  onChanged: () => void;
}) {
  const grants = access?.grants ?? (error ? [] : null);
  const waiting = access?.waitingRequests ?? 0;
  const [search, setSearch] = useState("");
  const { ask, dialog } = useAccessAsk(onChanged);
  const names = new Map(apis.map((a) => [`${a.team}/${a.name}`, a.displayName || a.name]));
  const q = search.trim().toLowerCase();
  const shown = grants?.filter((g) => !q || [g.team, g.name, g.group, g.userEmail, names.get(`${g.team}/${g.name}`) ?? ""].some((s) => s.toLowerCase().includes(q))) ?? null;
  const columns: DataTableColumn<ApiGrant>[] = [
    {
      key: "api",
      header: "API",
      render: (g) => (
        <Link component={RouterLink} to={`/apis/${encodeURIComponent(g.team)}/${encodeURIComponent(g.name)}`} variant="body2">
          {names.get(`${g.team}/${g.name}`) ?? g.name}{" "}
          <Typography component="span" variant="caption" color="text.secondary">
            {g.team}’s{g.awaySince ? " · left the catalog’s release" : ""}
          </Typography>
        </Link>
      ),
    },
    { key: "to", header: "Granted to", render: (g) => <Principal grant={g} /> },
    { key: "rate", header: "Rate", render: (g) => rateText(g.perMinute, Boolean(g.group)), hideBelow: "sm" },
    { key: "by", header: "Granted by", render: grantedByText, hideBelow: "md" },
    {
      key: "revoke",
      header: "Revoke",
      align: "right",
      render: (g) => (
        <Button size="small" color="error" aria-label={`Revoke ${grantName(g)}’s access to ${names.get(`${g.team}/${g.name}`) ?? g.name}…`} onClick={() => { ask(revokeAsk(g, `For an incident: ${g.team}’s maintainers and whom it names are told.`)); }}>
          Revoke…
        </Button>
      ),
    },
  ];
  return (
    <AdminCard title={`Every grant${access ? ` · ${String(access.total)}` : ""}`} label="Every grant">
      <Typography variant="body2" color="text.secondary">
        For an incident, an admin may revoke any grant; calls stop within a minute, and the API’s team and the one granted are told. Adding and changing
        grants{waiting > 0 ? `, and answering the ${String(waiting)} waiting ${waiting === 1 ? "request" : "requests"},` : ""} are each API team’s.
      </Typography>
      <TextField
        size="small"
        type="search"
        placeholder="Find a grant"
        value={search}
        onChange={(e) => { setSearch(e.target.value); }}
        sx={{ maxWidth: 340 }}
        slotProps={{ htmlInput: { "aria-label": "Find a grant" } }}
      />
      {error && <Alert severity="error">{error}</Alert>}
      <DataTable columns={columns} rows={shown} getRowKey={(g) => g.id} skeletonRowCount={2} emptyMessage={q ? "No grant matches." : "No grants yet: each API's team grants who may call it."} />
      <Typography variant="caption" color="text.secondary">
        {access && access.nextCursor ? `Showing ${String(access.grants.length)} of ${String(access.total)}, newest first${q ? " (finding among those shown)" : ""}. ` : ""}A group’s rate is each member’s.
      </Typography>
      {access?.nextCursor && (
        <Box>
          <Button variant="outlined" disabled={loadingMore} onClick={onMore}>
            {loadingMore ? "Loading…" : "Show more"}
          </Button>
        </Box>
      )}
      {dialog}
    </AdminCard>
  );
}
