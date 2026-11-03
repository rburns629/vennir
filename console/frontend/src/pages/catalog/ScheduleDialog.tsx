// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import { ApiError, createSchedule, listBots, updateSchedule, type Bot, type Runnable, type Schedule } from "../../api";
import { LoadFailed, loadFailure } from "../../components/LoadFailed";
import { Mono } from "../../components/Mono";
import { runLink } from "../RunFormPage";

/** Common times, and the cron each is. */
export const PRESETS: { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 02:00", cron: "0 2 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Mondays at 09:00", cron: "0 9 * * 1" },
  { label: "The 1st of each month at 06:00", cron: "0 6 1 * *" },
];

/** A cron in words, when it's a preset; else the expression itself. */
export function describeCron(cron: string): string {
  return PRESETS.find((p) => p.cron === cron)?.label ?? cron;
}

/**
 * Scheduling a run: what the form has, on a cron, for one of the teams the
 * person maintains, as one of that team's bots. Opens the team's schedules
 * when it's made.
 */
export function ScheduleDialog({
  open,
  onClose,
  runnable,
  teams,
  parameters,
}: {
  open: boolean;
  onClose: () => void;
  runnable: Runnable;
  /** The teams it may be scheduled for: theirs to maintain, and it may run for. */
  teams: string[];
  /** The form's inputs, checked; null while they aren't. */
  parameters: () => Record<string, unknown> | null;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(runnable.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  const [team, setTeam] = useState(teams[0] ?? "");
  const [cron, setCron] = useState(PRESETS[1]?.cron ?? "0 2 * * *");
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [botsFailed, setBotsFailed] = useState<string | null>(null);
  const [botsTry, setBotsTry] = useState(0);
  const [botId, setBotId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !team) return;
    // A team chosen before the last one's bots answered: theirs are dropped.
    let current = true;
    setBots(null);
    setBotsFailed(null);
    setBotId("");
    listBots(team)
      .then((found) => {
        if (!current) return;
        setBots(found);
        setBotId(found[0]?.id ?? "");
      })
      .catch((err: unknown) => { if (current) setBotsFailed(loadFailure(err)); });
    return () => { current = false; };
  }, [open, team, botsTry]);

  async function save(): Promise<void> {
    const values = parameters();
    if (!values) {
      setError("Fix the form's inputs first: the schedule runs with them.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createSchedule({ team, name, runnable, parameters: values, cron, timeZone, botId });
      navigate(`/teams/${encodeURIComponent(team)}?tab=schedules`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't make the schedule.");
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Schedule {runnable.displayName}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}>
        <Typography variant="body2" color="text.secondary">
          It runs with the inputs in the form, for the team, as one of its bots, which must be allowed to run it each time.
        </Typography>
        <TextField label="Name" value={name} onChange={(e) => { setName(e.target.value); }} size="small" />
        <TextField select label="For team" value={team} onChange={(e) => { setTeam(e.target.value); }} size="small">
          {teams.map((t) => (
            <MenuItem key={t} value={t}>
              {t}
            </MenuItem>
          ))}
        </TextField>
        <WhenFields cron={cron} timeZone={timeZone} onCron={setCron} onTimeZone={setTimeZone} />
        <BotField team={team} bots={bots} failed={botsFailed} onRetry={() => { setBotsTry((n) => n + 1); }} botId={botId} onBot={setBotId} />
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={saving || !botId || !name.trim()} onClick={() => void save()}>
          {saving ? "Saving…" : "Schedule it"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** When it runs: a preset or a cron, in a time zone. */
function WhenFields({ cron, timeZone, onCron, onTimeZone }: { cron: string; timeZone: string; onCron: (cron: string) => void; onTimeZone: (zone: string) => void }) {
  return (
    <>
      <TextField select label="When" value={PRESETS.some((p) => p.cron === cron) ? cron : "custom"} onChange={(e) => { if (e.target.value !== "custom") onCron(e.target.value); }} size="small">
        {PRESETS.map((p) => (
          <MenuItem key={p.cron} value={p.cron}>
            {p.label}
          </MenuItem>
        ))}
        <MenuItem value="custom">Another time (cron)</MenuItem>
      </TextField>
      <TextField
        label="Cron"
        value={cron}
        onChange={(e) => { onCron(e.target.value); }}
        size="small"
        helperText="Minute, hour, day of the month, month, day of the week. At most every five minutes."
        slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: "monospace" } } }}
      />
      <TextField label="Time zone" value={timeZone} onChange={(e) => { onTimeZone(e.target.value); }} size="small" helperText="Such as Europe/Berlin, or UTC." />
    </>
  );
}

/** Which of the team's bots it runs as; a link to add one when it has none, and Try again when they couldn't be loaded. */
function BotField({
  team,
  bots,
  failed,
  onRetry,
  botId,
  onBot,
}: {
  team: string;
  bots: Bot[] | null;
  failed: string | null;
  onRetry: () => void;
  botId: string;
  onBot: (id: string) => void;
}) {
  if (failed) return <LoadFailed what={`${team}'s bots`} reason={failed} onRetry={onRetry} />;
  return bots && bots.length === 0 ? (
    <Alert severity="info">
      {team} has no bot to run it as.{" "}
      <Link component={RouterLink} to={`/teams/${encodeURIComponent(team)}?tab=automation`}>
        Add one on its Automation tab
      </Link>
      .
    </Alert>
  ) : (
    <TextField select label="Runs as" value={bots ? botId : ""} onChange={(e) => { onBot(e.target.value); }} size="small" disabled={!bots}>
      {(bots ?? []).map((b) => (
        <MenuItem key={b.id} value={b.id}>
          {b.email}
        </MenuItem>
      ))}
    </TextField>
  );
}

/** A schedule's runnable, as the run form's address names it. */
export const scheduleRunnable = (s: Schedule) => ({ kind: s.kind, team: s.runnableTeam, name: s.runnableName });

/**
 * Editing a schedule: when, in which time zone, and as which bot. What it
 * runs stays (another schedule runs something else); its inputs change on
 * the run form ("Change inputs…"), checked as a run's are.
 */
export function EditScheduleDialog({ schedule, onClose, onSaved }: { schedule: Schedule; onClose: () => void; onSaved: (saved: Schedule) => void }) {
  const [cron, setCron] = useState(schedule.cron);
  const [timeZone, setTimeZone] = useState(schedule.timeZone);
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [botsFailed, setBotsFailed] = useState<string | null>(null);
  const [botsTry, setBotsTry] = useState(0);
  const [botId, setBotId] = useState(schedule.botId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    setBotsFailed(null);
    listBots(schedule.team)
      .then((found) => { if (current) setBots(found); })
      .catch((err: unknown) => { if (current) setBotsFailed(loadFailure(err)); });
    return () => { current = false; };
  }, [schedule.team, botsTry]);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      onSaved(await updateSchedule(schedule.id, { cron, timeZone, botId }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the schedule.");
      setSaving(false);
    }
  }

  const inputs = Object.entries(schedule.parameters);
  const changed = cron !== schedule.cron || timeZone !== schedule.timeZone || botId !== schedule.botId;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Edit {schedule.name}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}>
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            What it runs
          </Typography>
          <Typography variant="body2">{schedule.kind === "template" ? `${schedule.runnableName} by ${schedule.runnableTeam}` : schedule.runnableName}</Typography>
          <Typography variant="caption" color="text.secondary">
            To run something else, make another schedule.
          </Typography>
        </Box>
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 500, mb: 0.5 }}>
            Inputs
          </Typography>
          <Box sx={{ bgcolor: "background.default", border: 1, borderColor: "divider", borderRadius: 2, px: 1.5, py: 1, maxHeight: 160, overflow: "auto" }}>
            {inputs.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                None
              </Typography>
            ) : (
              inputs.map(([name, value]) => (
                <Mono key={name} sx={{ display: "block", fontSize: 12.5, overflowWrap: "anywhere" }}>
                  {name}: {JSON.stringify(value)}
                </Mono>
              ))
            )}
          </Box>
          <Link
            component={RouterLink}
            to={runLink(scheduleRunnable(schedule))}
            state={{ from: { name: schedule.name, parameters: schedule.parameters, onBehalfOf: schedule.team }, schedule: { id: schedule.id, name: schedule.name, team: schedule.team } }}
            variant="body2"
            sx={{ display: "inline-block", mt: 0.75 }}
          >
            Change inputs…
          </Link>
          <Typography variant="caption" color="text.secondary" component="div">
            Opens the run form with these filled in, checked as a run's are; Save to schedule keeps them.
          </Typography>
        </Box>
        <WhenFields cron={cron} timeZone={timeZone} onCron={setCron} onTimeZone={setTimeZone} />
        <BotField team={schedule.team} bots={bots} failed={botsFailed} onRetry={() => { setBotsTry((n) => n + 1); }} botId={botId} onBot={setBotId} />
        <Typography variant="caption" color="text.secondary">
          A run it already started finishes as it began.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={saving || !changed || !botId} onClick={() => void save()}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
