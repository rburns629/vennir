// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { errorMessage, getChatLimits, setChatLimits, type ChatLimits } from "../../api";
import { LoadFailed, loadFailure } from "../../components/LoadFailed";
import { useAdminChanged } from "./summary";
import { AdminCard, Aside } from "./parts";

const DEFAULT_PER_HOUR = 30;
const DEFAULT_PER_DAY = 200;
const MOST = 10_000;

/** A field's number, or null when it isn't a whole one. */
const whole = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : null);
const inRange = (n: number | null): n is number => n !== null && n >= 1 && n <= MOST;

/**
 * How many questions each person may ask the chat agent, an hour and a
 * day: each can take several model calls. The server checks
 * the same rules (BAD_CHAT_LIMITS); they're checked here first to say so
 * on the field.
 */
export function ChatLimitsCard() {
  const changed = useAdminChanged();
  const [saved, setSaved] = useState<ChatLimits | null>(null);
  const [hour, setHour] = useState("");
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [loadTry, setLoadTry] = useState(0);

  function show(l: ChatLimits): void {
    setSaved(l);
    setHour(String(l.perHour));
    setDay(String(l.perDay));
  }

  useEffect(() => {
    let current = true;
    setLoadFailed(null);
    getChatLimits()
      .then((l) => { if (current) show(l); })
      .catch((err: unknown) => { if (current) setLoadFailed(loadFailure(err)); });
    return () => { current = false; };
  }, [loadTry]);

  if (!saved) {
    return (
      <AdminCard title="Questions per person">
        {loadFailed ? (
          <LoadFailed what="the limits" reason={loadFailed} onRetry={() => { setLoadTry((n) => n + 1); }} />
        ) : (
          <Typography color="text.secondary">Loading…</Typography>
        )}
      </AdminCard>
    );
  }

  const perHour = whole(hour);
  const perDay = whole(day);
  const hourProblem = inRange(perHour) ? null : "1 to 10,000";
  const dayProblem = !inRange(perDay) ? "1 to 10,000" : inRange(perHour) && perDay < perHour ? "At least the hour's" : null;

  async function save(h: number, d: number): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      show(await setChatLimits(h, d));
      setNotice(`Saved: ${h.toLocaleString("en-US")} an hour, ${d.toLocaleString("en-US")} a day.`);
      changed();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save them."));
    } finally {
      setBusy(false);
    }
  }

  const setAt = saved.updatedAt ? new Date(saved.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
  return (
    <AdminCard
      title="Questions per person"
      status={saved.updatedBy || setAt ? <Aside>{[saved.updatedBy ? `Set by ${saved.updatedBy}` : "Set", setAt].filter(Boolean).join(" · ")}</Aside> : undefined}
    >
      <Typography variant="body2" color="text.secondary">
        Each question can take several model calls, so each person may ask only so many. One more is refused until their hour or day is
        up. Only questions the agent answers count, and bots can&apos;t ask at all. The same on every console.
      </Typography>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 220px))" } }}>
        <TextField
          size="small"
          label="An hour"
          value={hour}
          onChange={(e) => { setHour(e.target.value); setNotice(null); }}
          error={hourProblem !== null}
          helperText={hourProblem ?? `${String(DEFAULT_PER_HOUR)} by default`}
          slotProps={{ htmlInput: { inputMode: "numeric" } }}
        />
        <TextField
          size="small"
          label="A day"
          value={day}
          onChange={(e) => { setDay(e.target.value); setNotice(null); }}
          error={dayProblem !== null}
          helperText={dayProblem ?? `${String(DEFAULT_PER_DAY)} by default; at least the hour's`}
          slotProps={{ htmlInput: { inputMode: "numeric" } }}
        />
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}
      <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap", alignItems: "center" }}>
        <Button
          variant="contained"
          disabled={busy || hourProblem !== null || dayProblem !== null}
          onClick={() => { if (perHour !== null && perDay !== null) void save(perHour, perDay); }}
          sx={{ minHeight: 44 }}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button variant="outlined" disabled={busy} onClick={() => { void save(DEFAULT_PER_HOUR, DEFAULT_PER_DAY); }} sx={{ minHeight: 44 }}>
          Use the defaults
        </Button>
        <Typography variant="caption" color="text.secondary">
          1 to 10,000 each.
        </Typography>
      </Box>
    </AdminCard>
  );
}
