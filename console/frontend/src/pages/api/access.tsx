// SPDX-License-Identifier: MIT
/**
 * The parts of who may call an API (decision 26) the pages share: how a
 * grant or request names whom it's for, its rate in words, the one dialog
 * that asks before a change (revoke, withdraw, change a rate, decline), and
 * the request dialog (for yourself, or for a bot of a team you maintain).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormGroup from "@mui/material/FormGroup";
import FormLabel from "@mui/material/FormLabel";
import MenuItem from "@mui/material/MenuItem";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  ApiError,
  errorMessage,
  listBots,
  requestApiAccess,
  revokeApiGrant,
  setApiGrantRate,
  withdrawApiAccessRequest,
  type ApiAccessRequest,
  type ApiGrant,
  type ApiProduct,
  type Me,
} from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Mono";
import { when } from "../../time";

/** The longest reason the console takes (core/apiAccess.ts's MAX_REASON). */
export const MAX_REASON = 1000;

/** The highest rate a grant may have (core/apiAccess.ts's MAX_GRANT_PER_MINUTE). */
export const MAX_RATE = 1_000_000;

/** A rate as typed: a whole number of requests a minute, 0 (empty) for the API's limit, never above MAX_RATE. */
export const typedRate = (text: string) => Math.min(MAX_RATE, Math.max(0, Math.floor(Number(text) || 0)));

/** A bot's name: its email before the @. */
export const botName = (email: string) => email.split("@")[0] ?? email;

/** Whom a grant names, in a word: its group, its bot's name, or its person's email. */
export const grantName = (grant: Pick<ApiGrant, "group" | "userEmail" | "bot">) => grant.group || (grant.bot ? botName(grant.userEmail) : grant.userEmail);

/** The teams whose bots the caller may ask for: those they maintain that aren't retired, but `except` (an API's own team, whose bots call it already). */
export function botTeamsOf(user: Pick<Me, "maintainerOf" | "retiredTeams"> | null, except?: string): string[] {
  return (user?.maintainerOf ?? []).filter((t) => t !== except && !user?.retiredTeams.includes(t));
}

/** What an access error says; `deciding` (a maintainer approving a request), with what else they may do. */
export function accessError(err: unknown, deciding = false): string {
  const message = errorMessage(err, "That didn't work. Try again.");
  return deciding && err instanceof ApiError && err.code === "GROUPS_STALE" ? `${message} Or grant them by name.` : message;
}

/** The most groups a request may offer (core/apiAccess.ts's MAX_OFFERED_GROUPS). */
export const MAX_OFFERED_GROUPS = 100;

/** Past this many groups to offer, the dialog has a box to find them by. */
const FILTER_GROUPS_FROM = 10;

/** A rate in words: a group's is each member's. */
export function rateText(perMinute: number, group = false): string {
  return `${perMinute.toLocaleString()} a minute${group ? ", each member" : ""}`;
}

/** Whom a grant names: a group, a bot or a person, said first, then who. */
export function Principal({ grant }: { grant: Pick<ApiGrant, "group" | "userEmail" | "bot"> }) {
  const [kind, who] = grant.group ? ["Group", grant.group] : grant.bot ? ["Bot", botName(grant.userEmail)] : ["Person", grant.userEmail];
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        {kind}
      </Typography>
      <Mono sx={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{who}</Mono>
    </Box>
  );
}

/** A grant's last call, as the gateway records it (to within a few minutes). */
export function lastCallText(lastUsedAt: string | null): string {
  return lastUsedAt ? when(lastUsedAt) : "never";
}

/** Who granted it, and when. */
export function grantedByText(grant: Pick<ApiGrant, "grantedBy" | "createdAt">): string {
  const at = grant.createdAt ? when(grant.createdAt) : "";
  return [grant.grantedBy || "granted at once (requests are open)", at].filter(Boolean).join(", ");
}

/** A change to ask about first: its dialog's words, an optional field, and what it does with the field. */
export interface AccessAsk {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  input?: { label: string; required?: boolean; helperText?: string; type?: "text" | "number"; initial?: string; maxLength?: number };
  run: (value: string) => Promise<unknown>;
}

/**
 * The one confirm step for every access change on a page: `ask` opens it,
 * and once it's done `onChanged` reloads what the page shows. A failure
 * stays in the dialog, to try again or cancel.
 */
export function useAccessAsk(onChanged: () => void): { ask: (a: AccessAsk) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<AccessAsk | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = useCallback((a: AccessAsk) => {
    setError(null);
    setPending(a);
  }, []);
  async function confirm(value: string): Promise<void> {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await pending.run(value);
      setPending(null);
      onChanged();
    } catch (err) {
      setError(accessError(err));
    } finally {
      setBusy(false);
    }
  }
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.title ?? ""}
      description={pending?.description ?? ""}
      confirmLabel={pending?.confirmLabel}
      destructive={pending?.destructive}
      input={pending?.input}
      busy={busy}
      error={error}
      onConfirm={(value) => void confirm(value)}
      onCancel={() => {
        setPending(null);
      }}
    />
  );
  return { ask, dialog };
}

/** Asking before revoking a grant; `who` says whose it is, for the title. */
export function revokeAsk(grant: ApiGrant, note: string): AccessAsk {
  const named = grantName(grant);
  return {
    title: `Revoke ${named}'s access to ${grant.team}/${grant.name}?`,
    description: `${note} The gateway stops its calls within a minute.`,
    confirmLabel: "Revoke",
    destructive: true,
    input: { label: "Why (optional)", helperText: "Kept in the audit log, and told to whom it names.", maxLength: MAX_REASON },
    run: (reason) => revokeApiGrant(grant.id, reason),
  };
}

/** Asking before giving up your own grant. */
export function giveUpAsk(grantId: string, api: string): AccessAsk {
  return {
    title: `Give up your access to ${api}?`,
    description: "The gateway refuses your calls within a minute. You can ask again later.",
    confirmLabel: "Give up my access",
    destructive: true,
    run: () => revokeApiGrant(grantId),
  };
}

/** Asking before withdrawing a waiting request. */
export function withdrawAsk(request: ApiAccessRequest): AccessAsk {
  return {
    title: `Withdraw the request for ${request.bot ? botName(request.userEmail) : "you"}?`,
    description: `${request.team} is told, and nothing is granted. You may ask again at once.`,
    confirmLabel: "Withdraw",
    run: () => withdrawApiAccessRequest(request.id),
  };
}

/** Asking for a grant's new rate. */
export function rateAsk(grant: ApiGrant, defaultPerMinute: number): AccessAsk {
  return {
    title: "Change its rate",
    description: `Requests a minute${grant.group ? ", for each person in the group" : ""}. Empty: the API's limit, ${defaultPerMinute.toLocaleString()}. It takes effect within a minute, without revoking.`,
    confirmLabel: "Change rate",
    input: { label: "Its rate, a minute", type: "number", initial: grant.defaultRate ? "" : String(grant.perMinute) },
    run: (value) => setApiGrantRate(grant.id, typedRate(value)),
  };
}

type ApiChoice = Pick<ApiProduct, "team" | "name" | "displayName" | "url" | "publicUrl" | "defaultPerMinute" | "accessRequests">;

/**
 * Asking for access to an API (15b): for yourself, offering none or some of
 * your `groups` for a group grant (none ticked at first), or for a bot of a
 * team you maintain (granted by name only), with a reason. On an API's
 * page, `api` is that one; on a team's Automation tab, `bot` is fixed and
 * the API is picked from `apis`.
 */
export function RequestAccessDialog({
  open,
  api,
  apis = [],
  apisError = null,
  bot,
  forBot = false,
  groups = [],
  onClose,
  onDone,
}: {
  open: boolean;
  api?: ApiChoice | null;
  /** The APIs to pick from (no `api`); null while they load. */
  apis?: ApiChoice[] | null;
  /** Why `apis` couldn't be loaded. */
  apisError?: string | null;
  /** A bot's email: asking for it. */
  bot?: string;
  /** Open on "a bot of a team you maintain". */
  forBot?: boolean;
  /** Your groups as last read while they count (ListMyApiAccess), to offer some of. */
  groups?: string[];
  onClose: () => void;
  /** It's asked, or (requests open) granted. */
  onDone: (granted: boolean) => void;
}) {
  const { user } = useAuth();
  const [picked, setPicked] = useState("");
  const [forWhom, setForWhom] = useState<"you" | "bot">("you");
  const [botEmail, setBotEmail] = useState("");
  // Each bot once, with every team of the caller's it's in.
  const [bots, setBots] = useState<{ email: string; teams: string[] }[] | null>(null);
  const [botsError, setBotsError] = useState<string | null>(null);
  const [offered, setOffered] = useState<string[]>([]);
  const [groupFilter, setGroupFilter] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = api ?? apis?.find((a) => `${a.team}/${a.name}` === picked) ?? null;
  // A bot of the API's own team may call it already; a retired team's can't be asked for.
  const maintained = botTeamsOf(user, target?.team);

  useEffect(() => {
    if (!open) return;
    setForWhom(bot || forBot ? "bot" : "you");
    setBotEmail(bot ?? "");
    setReason("");
    setError(null);
    setPicked("");
    setOffered([]);
    setGroupFilter("");
  }, [open, bot, forBot]);

  // The bots that may be asked for: those of the live teams the caller maintains.
  const teams = botTeamsOf(user).join(",");
  useEffect(() => {
    if (!open || bot || !teams) return;
    let cancelled = false;
    setBotsError(null);
    Promise.all(teams.split(",").map((t) => listBots(t).then((list) => list.map((b) => ({ email: b.email, team: t })))))
      .then((lists) => {
        const byEmail = new Map<string, string[]>();
        for (const b of lists.flat()) byEmail.set(b.email, [...(byEmail.get(b.email) ?? []), b.team]);
        if (!cancelled) setBots([...byEmail].map(([email, of]) => ({ email, teams: of })));
      })
      .catch((err: unknown) => {
        if (!cancelled) setBotsError(errorMessage(err, "Couldn't load your teams' bots."));
      });
    return () => {
      cancelled = true;
    };
  }, [open, bot, teams]);

  const choosable = (bots ?? []).filter((b) => !b.teams.includes(target?.team ?? ""));
  const asBot = forWhom === "bot";
  // The bot asked for: the fixed one, or the one picked while it's still choosable (another API may be its own team's).
  const chosenBot = bot ?? (choosable.some((b) => b.email === botEmail) ? botEmail : "");
  // Your groups to offer: not for a bot, nor where requests are granted at once (by name).
  const offerable = !asBot && target?.accessRequests !== "open" ? groups : [];
  const shownGroups = groupFilter.trim() ? offerable.filter((g) => g.includes(groupFilter.trim().toLowerCase())) : offerable;
  const atMost = offered.filter((g) => offerable.includes(g)).length >= MAX_OFFERED_GROUPS;
  const ready = target !== null && reason.trim() !== "" && (!asBot || chosenBot !== "");

  async function submit(): Promise<void> {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const { grant } = await requestApiAccess(target.team, target.name, reason.trim(), asBot ? chosenBot : "", offered.filter((g) => offerable.includes(g)));
      onDone(grant !== null);
    } catch (err) {
      setError(accessError(err));
    } finally {
      setBusy(false);
    }
  }

  const address = target ? (target.publicUrl || target.url).replace(/^https?:\/\//, "") : "";
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="request-access-title">
      <DialogTitle id="request-access-title" sx={{ fontWeight: 600 }}>
        Request access{target ? ` to ${target.displayName || target.name}` : ""}
        {target && (
          <Typography variant="body2" color="text.secondary" component="div">
            {target.team}’s API{address ? ` · ${address}` : ""}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2.25 }}>
        {!api && (
          <TextField
            select
            size="small"
            label="Which API"
            value={picked}
            onChange={(e) => {
              setPicked(e.target.value);
            }}
            helperText={
              apisError ? "The APIs couldn’t be loaded." : apis === null ? "Loading the APIs…" : apis.length === 0 ? "No other team’s API takes requests." : "Another team’s API that takes requests."
            }
            error={Boolean(apisError)}
            sx={{ mt: 1 }}
          >
            {apis === null && !apisError && <MenuItem disabled>Loading…</MenuItem>}
            {(apis ?? []).map((a) => (
              <MenuItem key={`${a.team}/${a.name}`} value={`${a.team}/${a.name}`}>
                {a.displayName || a.name} · {a.team}
              </MenuItem>
            ))}
          </TextField>
        )}
        {!bot && maintained.length > 0 && (
          <FormControl>
            <FormLabel id="request-for">For</FormLabel>
            <RadioGroup
              aria-labelledby="request-for"
              value={forWhom}
              onChange={(e) => {
                setForWhom(e.target.value === "bot" ? "bot" : "you");
              }}
            >
              <FormControlLabel
                value="you"
                control={<Radio />}
                label={
                  <Box sx={{ py: 0.75 }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      You
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {user?.email}. {target?.team ?? "Its team"} may grant you by name, or a group you’re in.
                    </Typography>
                  </Box>
                }
              />
              <FormControlLabel
                value="bot"
                control={<Radio />}
                label={
                  <Box sx={{ py: 0.75 }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      A bot of a team you maintain
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Granted by name only; you ask on its behalf.
                    </Typography>
                  </Box>
                }
              />
            </RadioGroup>
          </FormControl>
        )}
        {bot ? (
          <Typography variant="body2">
            For <Mono>{botName(bot)}</Mono>, a bot of a team you maintain: granted by name only, as a bot is in no group.
          </Typography>
        ) : (
          asBot && (
            <TextField
              select
              size="small"
              label="Which bot"
              value={chosenBot}
              onChange={(e) => {
                setBotEmail(e.target.value);
              }}
              helperText={botsError ?? `Only bots of ${maintained.join(" and ")}, the teams you maintain.`}
              error={Boolean(botsError)}
            >
              {botsError && <MenuItem disabled>Your teams’ bots couldn’t be loaded</MenuItem>}
              {bots === null && !botsError && <MenuItem disabled>Loading…</MenuItem>}
              {bots !== null && choosable.length === 0 && <MenuItem disabled>Your teams have no bots yet</MenuItem>}
              {choosable.map((b) => (
                <MenuItem key={b.email} value={b.email}>
                  {botName(b.email)} · {b.teams.join(", ")}
                </MenuItem>
              ))}
            </TextField>
          )
        )}
        {offerable.length > 0 && (
          <FormControl component="fieldset">
            <FormLabel component="legend" sx={{ fontSize: 13 }}>
              Offer a group of yours (optional)
            </FormLabel>
            <Typography variant="caption" color="text.secondary">
              {target?.team ?? "Its team"}’s maintainers see only the groups you tick, never your others, and may grant one of them instead of you. None ticked: you, by name.
              {offerable.length > MAX_OFFERED_GROUPS ? ` At most ${String(MAX_OFFERED_GROUPS)}.` : ""}
            </Typography>
            {offerable.length > FILTER_GROUPS_FROM && (
              <TextField
                size="small"
                label="Find a group"
                value={groupFilter}
                onChange={(e) => {
                  setGroupFilter(e.target.value);
                }}
                sx={{ mt: 1 }}
              />
            )}
            {atMost && (
              <Typography variant="caption" color="warning.main">
                That’s {MAX_OFFERED_GROUPS}, the most a request may offer.
              </Typography>
            )}
            <FormGroup sx={{ maxHeight: 280, overflowY: "auto", flexWrap: "nowrap" }}>
              {shownGroups.map((g) => (
                <FormControlLabel
                  key={g}
                  control={
                    <Checkbox
                      size="small"
                      checked={offered.includes(g)}
                      disabled={atMost && !offered.includes(g)}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setOffered((was) => (on ? [...was, g] : was.filter((o) => o !== g)));
                      }}
                    />
                  }
                  label={<Mono sx={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{g}</Mono>}
                />
              ))}
            </FormGroup>
          </FormControl>
        )}
        <TextField
          label="Why you need it"
          required
          multiline
          minRows={3}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
          helperText={`${target?.team ?? "Its team"}’s maintainers see this with the request, and it’s kept in the audit log.`}
          slotProps={{ htmlInput: { maxLength: MAX_REASON } }}
        />
        {target && (
          <Typography variant="body2" color="text.secondary">
            {target.accessRequests === "open"
              ? `${target.team} grants every request at once, at its limit of ${target.defaultPerMinute.toLocaleString()} a minute.`
              : `A ${target.team} maintainer approves it, at a rate (by default ${target.defaultPerMinute.toLocaleString()} a minute), or declines it with a reason. You’re told either way, and may withdraw it while it waits.`}
          </Typography>
        )}
        {apisError && <Alert severity="error">{apisError}</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" disabled={busy || !ready} onClick={() => void submit()}>
          {busy ? "Asking…" : target ? `Ask ${target.team}` : "Ask"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
