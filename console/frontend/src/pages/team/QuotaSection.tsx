// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { errorMessage, setTeamQuota, type Team, type TeamQuota } from "../../api";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { SettingsCard } from "./shared";

const FIELDS: { key: keyof TeamQuota; label: string; help: string }[] = [
  { key: "cpu", label: "CPU, all steps together", help: "Such as 8 or 500m" },
  { key: "memory", label: "Memory, all steps together", help: "Such as 32Gi" },
  { key: "pods", label: "Steps running at once", help: "A whole number" },
  { key: "stepMemory", label: "Memory, one step at most", help: "Such as 8Gi" },
];

/** A limit as the page shows it. */
function limit(value: string) {
  return value ? <Mono>{value}</Mono> : "no limit";
}

/**
 * What a team's steps may use together, as its namespace's quota holds it:
 * its own, or the install's. Admins change it; everyone sees it.
 */
export function QuotaSection({ team, isAdmin, onChanged }: { team: Team; isAdmin: boolean; onChanged: () => void }) {
  const [form, setForm] = useState<TeamQuota>(team.quota);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setForm(team.quota); }, [team.quota]);

  async function save(quota: TeamQuota | null): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await setTeamQuota(team.name, quota);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Couldn't change the limits."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard title="Resource limits">
      <Typography variant="body2" color="text.secondary">
        What {team.name}&apos;s steps may use together; the cluster enforces it. A step that can never fit fails with{" "}
        <Mono>RESOURCES_NOT_ALLOWED</Mono>; one waiting for the team&apos;s other steps waits.
        {!isAdmin && " Only admins change them."}
      </Typography>
      <Box>
        {team.quotaIsDefault ? <Pill tone="neutral">The install&apos;s</Pill> : <Pill tone="info">{team.name}&apos;s own, not the install&apos;s</Pill>}
      </Box>
      {isAdmin ? (
        <>
          <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
            {FIELDS.map((f) => (
              <TextField
                key={f.key}
                size="small"
                label={f.label}
                value={form[f.key]}
                placeholder="no limit"
                onChange={(e) => { setForm({ ...form, [f.key]: e.target.value.trim() }); }}
                helperText={`${f.help}. The install's: ${team.installQuota[f.key] || "no limit"}`}
                slotProps={{ inputLabel: { shrink: true } }}
                sx={{ "& input": { fontFamily: "fontFamilyMono" } }}
              />
            ))}
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button variant="contained" disabled={saving} onClick={() => void save(form)}>
              Save the team&apos;s own
            </Button>
            {!team.quotaIsDefault && (
              <Button variant="outlined" color="inherit" disabled={saving} onClick={() => void save(null)}>
                Use the install&apos;s again
              </Button>
            )}
          </Box>
        </>
      ) : (
        <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 2, rowGap: 0.5 }}>
          {FIELDS.map((f) => (
            <Box key={f.key} sx={{ display: "contents" }}>
              <Typography component="dt" variant="body2" color="text.secondary">
                {f.label}
              </Typography>
              <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                {limit(team.quota[f.key])}
                {/* Its own: the install's beside it, to compare. */}
                {!team.quotaIsDefault && (
                  <Typography component="span" variant="body2" color="text.secondary">
                    {" "}
                    (the install&apos;s: {limit(team.installQuota[f.key])})
                  </Typography>
                )}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </SettingsCard>
  );
}
