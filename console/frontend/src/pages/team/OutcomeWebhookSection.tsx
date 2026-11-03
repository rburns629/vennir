// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Typography from "@mui/material/Typography";
import { errorMessage, getTeamCallback, setTeamCallback, type TeamCallback } from "../../api";
import { Mono } from "../../components/Mono";
import { SignedCallback } from "../../components/SignedCallback";
import { SettingsCard } from "./shared";

/**
 * The team's outcome webhook: each of its runs' outcomes (its steps'
 * states and outputs) posted as signed JSON, for its own systems rather than
 * chat. Its maintainers set it; members see where it posts and how it went.
 */
export function OutcomeWebhookSection({ team, canManage, retired }: { team: string; canManage: boolean; retired: boolean }) {
  const [callback, setCallback] = useState<TeamCallback | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getTeamCallback(team)
      .then((found) => {
        setCallback(found.callback);
        setAllowed(found.allowedHosts);
      })
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the outcome webhook.")); });
  }, [team]);
  useEffect(load, [load]);

  // An install that allows no hosts can't have one: say nothing unless one is set.
  if (callback && !callback.configured && allowed.length === 0) return null;
  return (
    <SettingsCard title="Outcome webhook">
      <Typography variant="body2" color="text.secondary">
        For {team}&apos;s own systems: when one of its runs finishes, its outcome (each step&apos;s state and outputs) is posted
        as signed JSON.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {callback && (
        <SignedCallback
          current={callback.configured ? callback : null}
          editable={canManage && !retired}
          none="None: nothing is posted."
          save={(url, rotate) => setTeamCallback(team, url, rotate)}
          onSaved={load}
        />
      )}
      <Typography variant="caption" color="text.secondary">
        Each post carries <Mono>Vertra-Signature: t=…,v1=…</Mono>: HMAC-SHA256 of <Mono>{"<t>.<body>"}</Mono> with its secret.
        Allowed hosts: {allowed.join(", ") || "none"}.
      </Typography>
    </SettingsCard>
  );
}
