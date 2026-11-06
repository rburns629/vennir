// SPDX-License-Identifier: MIT
import { useState, type FormEvent } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormLabel from "@mui/material/FormLabel";
import Link from "@mui/material/Link";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { addApiGrant, decideApiAccessRequest, type ApiAccessRequest, type ApiGrant, type ApiProduct } from "../../api";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Mono } from "../../components/Mono";
import { when } from "../../time";
import { accessError, botName, grantedByText, grantName, MAX_REASON, Principal, rateAsk, rateText, revokeAsk, typedRate, useAccessAsk } from "./access";

/** An API's access list and requests (ApiService.ListApiAccess). */
export interface ApiAccessList {
  grants: ApiGrant[];
  requests: ApiAccessRequest[];
}

const DAY = 24 * 60 * 60 * 1000;

function Heading({ title, note }: { title: string; note?: string }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
      <Typography variant="h6" component="h3">
        {title}
      </Typography>
      {note && (
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
          {note}
        </Typography>
      )}
    </Box>
  );
}

/** One waiting request, with how to answer it: whom to grant (them, or a group of theirs), at what rate, or decline. */
function WaitingRequest({ api, request, maintains, onDecline, onDone }: { api: ApiProduct; request: ApiAccessRequest; maintains: boolean; onDecline: () => void; onDone: () => void }) {
  const [to, setTo] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = request.bot ? botName(request.userEmail) : request.userEmail;
  const asked = request.createdAt ? `asked ${when(request.createdAt)}` : "";
  const shownRate = typedRate(rate) || api.defaultPerMinute;

  async function approve(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await decideApiAccessRequest(request.id, { approve: true, group: to, perMinute: typedRate(rate) });
      onDone();
    } catch (err) {
      setError(accessError(err, true));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box component="article" aria-label={`Request for ${who}`} sx={{ p: 2, borderRadius: 2, border: 1, borderColor: "divider", display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
        {request.bot ? `Bot ${who}` : who}
        <Typography component="span" variant="body2" color="text.secondary">
          {" "}
          · {request.bot ? `asked for it by ${request.requestedBy}, a maintainer of its team` : "for themselves"}
          {asked ? ` · ${asked}` : ""}
        </Typography>
      </Typography>
      <Box component="blockquote" sx={{ m: 0, pl: 1.5, borderLeft: 3, borderColor: "divider", fontSize: 13.5, lineHeight: 1.5, overflowWrap: "anywhere" }}>
        {request.reason}
      </Box>
      {maintains && (
        <>
          {request.bot ? (
            <Typography variant="body2">
              Grant it to <Mono>{who}</Mono>, by name · a bot is in no group
            </Typography>
          ) : (
            <FormControl>
              <FormLabel id={`to-${request.id}`} sx={{ fontSize: 13 }}>
                Grant it to
              </FormLabel>
              <RadioGroup aria-labelledby={`to-${request.id}`} value={to} onChange={(e) => { setTo(e.target.value); }}>
                <FormControlLabel value="" control={<Radio size="small" />} label={<Typography variant="body2">{who}, by name · only them</Typography>} />
                {request.groups.map((g) => (
                  <FormControlLabel
                    key={g}
                    value={g}
                    control={<Radio size="small" />}
                    label={
                      <Typography variant="body2">
                        <Mono>{g}</Mono> · a group they’re in, as of {request.groupsReadAt ? `their sign-in ${when(request.groupsReadAt)}` : "their sign-in"}
                      </Typography>
                    }
                  />
                ))}
              </RadioGroup>
            </FormControl>
          )}
          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 1.5 }}>
            <TextField
              size="small"
              type="number"
              label="Its rate, a minute"
              placeholder={String(api.defaultPerMinute)}
              value={rate}
              onChange={(e) => { setRate(e.target.value); }}
              helperText={`Empty: the API’s limit. ${to ? "Each member gets it. " : ""}Change it later without revoking.`}
              slotProps={{ htmlInput: { min: 0 } }}
              sx={{ flex: "0 1 260px" }}
            />
            <Button variant="contained" disabled={busy} onClick={() => void approve()} sx={{ minHeight: 40 }}>
              Approve at {shownRate.toLocaleString()}
            </Button>
            <Button variant="outlined" color="error" disabled={busy} onClick={onDecline} sx={{ minHeight: 40 }}>
              Decline…
            </Button>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
        </>
      )}
    </Box>
  );
}

/** Adding a grant directly, without a request: a group, or a person or bot by email. */
function AddGrant({ api, onDone, onCancel }: { api: ApiProduct; onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<"group" | "user">("group");
  const [who, setWho] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addApiGrant(api.team, api.name, kind === "group" ? { group: who.trim() } : { email: who.trim() }, typedRate(rate));
      onDone();
    } catch (err) {
      setError(accessError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box component="form" aria-label="Add a grant" onSubmit={(e) => void submit(e)} sx={{ p: 2, borderRadius: 2, bgcolor: "background.default", display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Heading title="Add a grant" note="Directly, without a request. The one granted is told." />
      <FormControl>
        <FormLabel id="grant-to" sx={{ fontSize: 13 }}>
          To
        </FormLabel>
        <RadioGroup row aria-labelledby="grant-to" value={kind} onChange={(e) => { setKind(e.target.value === "user" ? "user" : "group"); }}>
          <FormControlLabel value="group" control={<Radio size="small" />} label={<Typography variant="body2">A group · everyone in a single sign-on group</Typography>} />
          <FormControlLabel value="user" control={<Radio size="small" />} label={<Typography variant="body2">A person or a bot · one, by email; bots only ever this way</Typography>} />
        </RadioGroup>
      </FormControl>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, alignItems: "flex-start" }}>
        <TextField
          size="small"
          required
          label={kind === "group" ? "Group" : "Email"}
          placeholder={kind === "group" ? "orders-readers@acme.com" : "priya@acme.com"}
          value={who}
          onChange={(e) => { setWho(e.target.value); }}
          helperText={kind === "group" ? "As the provider sends it: its name or ID, or a Google group’s email." : "A person’s email, or a bot’s, with its team."}
          sx={{ flex: "1 1 260px" }}
        />
        <TextField
          size="small"
          type="number"
          label="Its rate, a minute"
          placeholder={String(api.defaultPerMinute)}
          value={rate}
          onChange={(e) => { setRate(e.target.value); }}
          helperText="Empty: the API’s limit."
          slotProps={{ htmlInput: { min: 0 } }}
          sx={{ flex: "0 1 200px" }}
        />
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ display: "flex", gap: 1 }}>
        <Button type="submit" variant="contained" disabled={busy || !who.trim()}>
          Grant {who.trim() || (kind === "group" ? "the group" : "them")}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </Box>
    </Box>
  );
}

/**
 * Who may call an API, for its own team and admins (15f): requests waiting
 * (a maintainer grants the person, or a group of theirs, at a rate; or
 * declines with a reason), the access list (change a rate, revoke), adding
 * a grant, what its api.yaml says, and what ended in the last 30 days. Its
 * maintainers change it; members see it; an admin may only revoke.
 */
export function WhoMayCall({ api, list, error, maintains, isAdmin, onChanged }: { api: ApiProduct; list: ApiAccessList | null; error: string | null; maintains: boolean; isAdmin: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const { ask, dialog } = useAccessAsk(onChanged);
  const t = api.team;
  const active = list?.grants.filter((g) => !g.revokedAt) ?? null;
  const waiting = list?.requests.filter((r) => r.state === "waiting") ?? [];
  const since = Date.now() - 30 * DAY;
  const ended = [
    ...(list?.grants ?? []).filter((g) => g.revokedAt && new Date(g.revokedAt).getTime() >= since).map((g) => ({ key: g.id, at: g.revokedAt ?? "", who: g.group || g.userEmail, what: "Revoked", note: `by ${g.revokedBy || "the platform"}${g.revokeReason ? `: “${g.revokeReason}”` : ""}` })),
    ...(list?.requests ?? [])
      .filter((r) => (r.state === "declined" || r.state === "withdrawn") && r.decidedAt && new Date(r.decidedAt).getTime() >= since)
      .map((r) => ({
        key: r.id,
        at: r.decidedAt ?? "",
        who: r.userEmail,
        what: r.state === "declined" ? "Declined" : "Withdrawn",
        note: r.state === "declined" ? `by ${r.decidedBy}${r.decisionReason ? `: “${r.decisionReason}”` : ""}` : "before anyone answered",
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const columns: DataTableColumn<ApiGrant>[] = [
    { key: "to", header: "Granted to", render: (g) => <Principal grant={g} /> },
    {
      key: "rate",
      header: "Rate",
      render: (g) => (
        <>
          {rateText(g.perMinute)}
          {(g.group || g.defaultRate) && (
            <Typography variant="caption" color="text.secondary" component="div">
              {[g.group ? "each member, counted per person" : "", g.defaultRate ? "the API’s limit" : ""].filter(Boolean).join(" · ")}
            </Typography>
          )}
        </>
      ),
    },
    { key: "by", header: "Granted by", render: (g) => grantedByText(g), hideBelow: "sm" },
  ];
  if (maintains || isAdmin) {
    columns.push({
      key: "actions",
      header: "Actions",
      align: "right",
      render: (g) => (
        <Box sx={{ display: "flex", gap: 0.5, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {maintains && (
            <Button size="small" aria-label={`Change rate of ${grantName(g)}’s grant…`} onClick={() => { ask(rateAsk(g, api.defaultPerMinute)); }}>
              Change rate…
            </Button>
          )}
          <Button
            size="small"
            color="error"
            aria-label={`Revoke ${grantName(g)}’s access…`}
            onClick={() => {
              ask(revokeAsk(g, maintains ? "Whom it names is told." : `For an incident: ${t}’s maintainers and whom it names are told.`));
            }}
          >
            Revoke…
          </Button>
        </Box>
      ),
    });
  }

  return (
    <Box id="access" sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-start", scrollMarginTop: 16 }}>
      <Card component="section" aria-label="Who may call" sx={{ flex: "3 1 620px", minWidth: 0, p: 2.75, display: "flex", flexDirection: "column", gap: 2.5 }}>
        <Heading
          title="Who may call your API"
          note={`${t}’s maintainers change it; members see it.${isAdmin && !maintains ? " As an admin you may revoke a grant (an incident), not add or change one." : ""}`}
        />
        {error && <Alert severity="error">{error}</Alert>}
        {waiting.length > 0 && (
          <Box component="section" aria-label="Asking for access" sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            <Heading title={`Asking for access · ${String(waiting.length)}`} note={`Any ${t} maintainer can answer. Whoever asked is told, and it’s in the audit log.`} />
            {waiting.map((r) => (
              <WaitingRequest
                key={r.id}
                api={api}
                request={r}
                maintains={maintains}
                onDone={onChanged}
                onDecline={() => {
                  ask({
                    title: `Decline the request for ${r.bot ? botName(r.userEmail) : r.userEmail}?`,
                    description: `${r.bot ? `${r.requestedBy}, who asked,` : "They"} see your reason, and may ask again.`,
                    confirmLabel: "Decline",
                    destructive: true,
                    input: { label: "Why you’re declining", required: true, maxLength: MAX_REASON },
                    run: (reason) => decideApiAccessRequest(r.id, { approve: false, reason: reason.trim() }),
                  });
                }}
              />
            ))}
          </Box>
        )}
        <Box component="section" aria-label="Access list" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 1.5 }}>
            <Heading
              title={`Access list${active ? ` · ${String(active.length)} ${active.length === 1 ? "grant" : "grants"}` : ""}`}
              note="Anyone not on it gets 403 from the gateway. A changed rate or a revoked grant takes effect within a minute."
            />
            {maintains && !adding && (
              <Button variant="outlined" onClick={() => { setAdding(true); }}>
                Add a grant
              </Button>
            )}
          </Box>
          {adding && (
            <AddGrant
              api={api}
              onCancel={() => { setAdding(false); }}
              onDone={() => {
                setAdding(false);
                onChanged();
              }}
            />
          )}
          <DataTable columns={columns} rows={active} getRowKey={(g) => g.id} skeletonRowCount={2} emptyMessage={`No grants: only ${t}’s own members and bots may call it.`} />
          <Typography variant="caption" color="text.secondary">
            {maintains ? "You change or revoke any grant. " : ""}Others may end one too: a person may give up their own, a bot’s team may revoke its bot’s, and an admin may revoke any in an incident (not add or change one). Always,
            without a grant: {t}’s own members and bots. Admins call it only if granted, like anyone else.
          </Typography>
        </Box>
      </Card>

      <Box component="aside" sx={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <Card component="section" aria-label="As its api.yaml says" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
          <Typography variant="h6" component="h3">
            As its api.yaml says
          </Typography>
          <Typography variant="body2">
            Requests:{" "}
            <strong>{api.accessRequests === "open" ? "granted at once" : api.accessRequests === "closed" ? "closed" : `need approval by ${t}`}</strong> ·{" "}
            <Mono sx={{ fontSize: 12 }}>access: {`{ requests: ${api.accessRequests} }`}</Mono>
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            open would grant each at once; closed shows no Request button, and grants already made stay.
          </Typography>
          <Typography variant="body2">
            Limit: <strong>{rateText(api.defaultPerMinute)}</strong> a grant, unless it sets its own; for a group, each member
            {api.defaultFromGateway ? " (the gateway’s default: its api.yaml sets none)" : ""}.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            These change in the catalog, reviewed like any product{api.sourcePath ? <>: <Mono sx={{ fontSize: 12 }}>{api.sourcePath}</Mono></> : ""}. The grants are this install’s, held here.
          </Typography>
        </Card>
        <Card component="section" aria-label="Ended, last 30 days" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
            <Typography variant="h6" component="h3">
              Ended, last 30 days
            </Typography>
            <Link component={RouterLink} to="/observe?tab=audit" variant="body2">
              In the audit log →
            </Link>
          </Box>
          {ended.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Nothing revoked, declined or withdrawn.
            </Typography>
          ) : (
            ended.map((e) => (
              <Box key={e.key} sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
                <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                  <Mono sx={{ fontSize: 12.5 }}>{e.who}</Mono> · <strong>{e.what}</strong>
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                  {e.note}, {when(e.at)}
                </Typography>
              </Box>
            ))
          )}
        </Card>
        <Card component="section" aria-label="Grants don't expire" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 0.75 }}>
          <Typography variant="h6" component="h3">
            Grants don’t expire
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Each lasts until it’s revoked.
          </Typography>
        </Card>
      </Box>
      {dialog}
    </Box>
  );
}
