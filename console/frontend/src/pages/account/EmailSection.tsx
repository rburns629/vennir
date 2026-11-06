// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Typography from "@mui/material/Typography";
import { errorMessage, getEmailPreferences, setEmailPreferences } from "../../api";

const KINDS = [
  { kind: "run_failed", label: "A run of mine failed" },
  { kind: "run_succeeded", label: "A run of mine finished" },
  { kind: "approval_waiting", label: "A step waits for my team's approval" },
  { kind: "product_not_ready", label: "A product of my team isn't ready" },
  { kind: "catalog_failing", label: "The catalog isn't being pulled (admins)" },
  { kind: "step_refused", label: "The cluster refused a step (mine, or anyone's for admins)" },
  { kind: "platform_alert", label: "A team purged, the image sources changed, a policy not syncing (admins)" },
  { kind: "api_access", label: "Access to an API: asked for, granted, declined or revoked (mine, my bots', or my team's APIs)" },
];

/** Which of your notifications are emailed to you too; hidden when the install sends no email. */
export function EmailSection() {
  const [prefs, setPrefs] = useState<{ available: boolean; kinds: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEmailPreferences()
      .then(setPrefs)
      .catch(() => undefined); // Display only: without it, the card isn't shown.
  }, []);

  if (!prefs?.available) return null;

  function toggle(kind: string, on: boolean): void {
    if (!prefs) return;
    const next = on ? [...prefs.kinds, kind] : prefs.kinds.filter((k) => k !== kind);
    setPrefs({ ...prefs, kinds: next });
    setError(null);
    setEmailPreferences(next).catch((err: unknown) => {
      setError(errorMessage(err, "Couldn't save it."));
    });
  }

  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography variant="h6" component="h2">
        Email
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Everything is in the bell; these come by email too.
      </Typography>
      <Box sx={{ display: "flex", flexDirection: "column" }}>
        {KINDS.map(({ kind, label }) => (
          <FormControlLabel key={kind} control={<Checkbox checked={prefs.kinds.includes(kind)} onChange={(e) => { toggle(kind, e.target.checked); }} />} label={label} />
        ))}
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
    </Card>
  );
}
