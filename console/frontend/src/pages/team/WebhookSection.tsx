// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { errorMessage, deleteTeamWebhook, getTeamWebhook, setTeamWebhook, testTeamWebhook, type TeamWebhook } from "../../api";
import { when } from "../../time";
import { Mono } from "../../components/Mono";
import { SettingsCard } from "./shared";

const KINDS = [
  { kind: "run_failed", label: "A run for the team failed" },
  { kind: "approval_waiting", label: "A step waits for the team's approval" },
  { kind: "product_not_ready", label: "A product of the team isn't ready on this install" },
  { kind: "step_refused", label: "The cluster refused a step of the team (an unsigned or unallowed image, say)" },
] as const;

/** What the admins' channel may get besides (an admin chooses the team, on the Admin page). */
const ADMIN_KINDS = [
  { kind: "platform_alert", label: "Admins' alerts: a team purged, the image sources changed, a policy not syncing" },
  { kind: "catalog_failing", label: "The catalog isn't being pulled" },
] as const;

/**
 * The team's chat webhook (Slack, Google Chat, Teams): where its
 * notifications are posted. Its maintainers set, test and remove it; the URL
 * is never shown again once saved, only its host. Members see whether it's
 * set and working. On the admins' channel it may get admins' alerts too.
 */
export function WebhookSection({ team, canManage, retired }: { team: string; canManage: boolean; retired: boolean }) {
  const [webhook, setWebhook] = useState<TeamWebhook | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [kinds, setKinds] = useState<string[]>(KINDS.map((k) => k.kind));
  const [adminChannel, setAdminChannel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    getTeamWebhook(team)
      .then(({ webhook: found, allowedHosts, adminChannel: forAdmins }) => {
        setWebhook(found);
        setAllowed(allowedHosts);
        setAdminChannel(forAdmins);
        if (found.configured) setKinds(found.kinds);
        else if (forAdmins) setKinds([...KINDS, ...ADMIN_KINDS].map((k) => k.kind));
      })
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the webhook.")); });
  }, [team]);

  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err, "Something went wrong. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    act(async () => {
      setWebhook(await setTeamWebhook(team, url.trim(), kinds));
      setUrl("");
      setNotice("Saved.");
    });
  const test = () =>
    act(async () => {
      const result = await testTeamWebhook(team);
      if (result.sent) setNotice("Sent a test message.");
      else setError(`It didn't go: ${result.error}`);
      setWebhook((await getTeamWebhook(team)).webhook);
    });
  const remove = () =>
    act(async () => {
      await deleteTeamWebhook(team);
      setWebhook({ configured: false, host: "", kinds: [], lastSentAt: null, lastError: null });
    });

  const editable = canManage && !retired;
  const toggle = (kind: string, on: boolean) => { setKinds((current) => (on ? [...current, kind] : current.filter((k) => k !== kind))); };

  return (
    <SettingsCard title="Chat notifications">
      <Typography variant="body2" color="text.secondary">
        Posts {team}&apos;s notifications to a Slack, Google Chat or Teams channel through its incoming webhook. Everyone also
        gets their own in the console&apos;s bell.
      </Typography>
      {webhook?.configured ? (
        <Box role="status" sx={{ p: 1.5, borderRadius: 2, bgcolor: webhook.lastError ? "warning.light" : "background.default" }}>
          <Typography variant="body2" sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
            <Box
              component="span"
              aria-hidden="true"
              sx={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, alignSelf: "center", bgcolor: webhook.lastError ? "warning.main" : "success.main" }}
            />
            <span>
              Posting to <Mono>{webhook.host}</Mono>
              {webhook.lastSentAt ? `, last ${when(webhook.lastSentAt)}` : ", nothing sent yet"}.
            </span>
          </Typography>
          {webhook.lastError && (
            <Typography variant="body2" sx={{ color: "warning.main", mt: 0.5 }}>
              The last post didn&apos;t go: {webhook.lastError}
            </Typography>
          )}
        </Box>
      ) : (
        webhook && <Typography variant="body2">No webhook: nothing is posted.</Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}
      {editable && webhook && (
        <>
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            {[...KINDS, ...(adminChannel ? ADMIN_KINDS : [])].map(({ kind, label }) => (
              <FormControlLabel
                key={kind}
                control={<Checkbox checked={kinds.includes(kind)} onChange={(e) => { toggle(kind, e.target.checked); }} />}
                label={label}
                sx={{ "& .MuiFormControlLabel-label": { fontSize: 14 } }}
              />
            ))}
          </Box>
          <TextField
            label={webhook.configured ? "A new webhook URL (optional)" : "Webhook URL"}
            type="password"
            autoComplete="off"
            value={url}
            onChange={(e) => { setUrl(e.target.value); }}
            placeholder="https://hooks.slack.com/services/…"
            helperText={`Kept encrypted and never shown again. Allowed hosts: ${allowed.join(", ")}.`}
            size="small"
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button variant="contained" disabled={busy || (!webhook.configured && !url.trim())} onClick={() => void save()}>
              Save
            </Button>
            {webhook.configured && (
              <>
                <Button variant="outlined" color="inherit" disabled={busy} onClick={() => void test()}>
                  Send a test message
                </Button>
                <Button color="error" disabled={busy} onClick={() => void remove()}>
                  Remove
                </Button>
              </>
            )}
          </Box>
        </>
      )}
    </SettingsCard>
  );
}
