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
import { errorMessage, getGateway, setGatewayClosed, type GatewayInfo } from "../../api";
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
  forbidden: { why: "Not shared with the caller's team", answered: "403" },
  limited: { why: "Over a limit", answered: "429" },
  paused: { why: "API paused by its team", answered: "503" },
  closed: { why: "The gateway was closed", answered: "503" },
  held: { why: "Its backend isn't allowed yet", answered: "503" },
  unavailable: { why: "The API or its caller couldn't be checked", answered: "503" },
  backend_error: { why: "The backend failed or didn't answer", answered: "500, 502, 504" },
};

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
 * what it refused at the door over the last day.
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

  const refused = gateway?.refused.reduce((n, r) => n + r.count, 0) ?? 0;
  const share = gateway && gateway.requests24h > 0 ? `${((refused / gateway.requests24h) * 100).toFixed(1)}% of requests` : "of no requests";
  return (
    <>
      {error && <Alert severity="error">{error}</Alert>}
      {gateway && !gateway.enabled && (
        <Alert severity="info">
          The gateway isn&apos;t running on this install: <Mono>gateway.enabled</Mono> in vertra.yaml.
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
          </Box>

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
              These are the console chart&apos;s gateway values: an upgrade (<Mono>vertra apply</Mono>) changes them, not this page.
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
            Each API&apos;s own limits, sharing and traffic are on its page in{" "}
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
