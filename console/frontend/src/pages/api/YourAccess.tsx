// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import type { ApiAccessRequest, ApiProduct, MyApiAccess } from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { Pill } from "../../components/Pill";
import { when } from "../../time";
import { botTeamsOf, giveUpAsk, rateText, RequestAccessDialog, useAccessAsk, withdrawAsk } from "./access";

/** Where the caller stands with one API: how they may call it, else their newest request for it (a waiting one first). */
export interface Standing {
  access: MyApiAccess | null;
  request: ApiAccessRequest | null;
}

export function standingFor(team: string, name: string, mine: { access: MyApiAccess[]; requests: ApiAccessRequest[] } | null): Standing {
  const access = mine?.access.find((a) => a.team === team && a.name === name) ?? null;
  const requests = (mine?.requests ?? []).filter((r) => r.team === team && r.name === name && !r.bot);
  return { access, request: requests.find((r) => r.state === "waiting") ?? requests[0] ?? null };
}

/** The header's pill: whether you may call it, or your request waits. */
export function StandingPill({ standing }: { standing: Standing }) {
  if (standing.access) return <Pill tone="success">You may call it</Pill>;
  if (standing.request?.state === "waiting") return <Pill tone="warning">Your request is waiting</Pill>;
  return <Pill tone="neutral">You may not call it</Pill>;
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ overflowWrap: "anywhere" }}>
        {children}
      </Typography>
    </Box>
  );
}

function Quote({ children }: { children: ReactNode }) {
  return (
    <Box component="blockquote" sx={{ m: 0, pl: 1.5, borderLeft: 3, borderColor: "divider", fontSize: 13.5, lineHeight: 1.5, overflowWrap: "anywhere" }}>
      {children}
    </Box>
  );
}

function Act({ button, note }: { button: ReactNode; note: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
      {button}
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13, flex: "1 1 220px" }}>
        {note}
      </Typography>
    </Box>
  );
}

/**
 * Your access to someone else's API (15a, 15c, 15d, 15e): not granted, with
 * Request access; your request waiting, with Withdraw; granted, by name
 * (Give up my access) or through a group; or declined, with its reason and
 * Ask again. From the catalog only (shareWith, going away), the same, with
 * a note of it. A maintainer of other teams may also ask for one of their
 * bots. `groups`: yours, to offer in a request.
 */
export function YourAccess({ api, standing, groups, onChanged }: { api: ApiProduct; standing: Standing; groups: string[]; onChanged: () => void }) {
  const { user } = useAuth();
  const [asking, setAsking] = useState<"you" | "bot" | null>(null);
  const { ask, dialog } = useAccessAsk(onChanged);
  const { access, request } = standing;
  const t = api.team;
  const closed = api.accessRequests === "closed";
  const botTeams = botTeamsOf(user, t);
  // From the catalog only: they may call it, and may ask for a grant of their own.
  const catalog = access?.via === "catalog" ? access : null;
  const title =
    access && !catalog ? "Granted" : request?.state === "waiting" ? `Waiting for ${t}` : request?.state === "declined" ? "Declined" : catalog ? "From the catalog" : "Not granted";

  let body: ReactNode;
  if (access?.via === "user" || access?.via === "group") {
    const group = access.via === "group";
    body = (
      <>
        <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <Line label="Granted to">{group ? `A group you’re in: ${access.group}, as of your sign-in` : "You, by name · not through a group"}</Line>
          <Line label="Rate">
            {rateText(access.perMinute, group)} · {t} may change it without revoking
          </Line>
        </Box>
        {group ? (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            Through a group, so not yours to give up: you’d lose it if you left the group, or {t} revoked the group’s grant.
          </Typography>
        ) : (
          <Act
            button={
              <Button variant="outlined" color="error" onClick={() => { ask(giveUpAsk(access.grantId, api.displayName || api.name)); }}>
                Give up my access…
              </Button>
            }
            note={`${t}’s maintainers may also change its rate or revoke it, and an admin may revoke it in an incident. You’re told either way.`}
          />
        )}
      </>
    );
  } else if (request?.state === "waiting") {
    body = (
      <>
        <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <Line label="Asked by">you{request.createdAt ? `, ${when(request.createdAt)}` : ""}</Line>
          <Line label="Who answers">any {t} maintainer</Line>
        </Box>
        <Quote>{request.reason}</Quote>
        <Act
          button={
            <Button variant="outlined" onClick={() => { ask(withdrawAsk(request)); }}>
              Withdraw the request
            </Button>
          }
          note={`You can, while it waits. ${t} is told.`}
        />
      </>
    );
  } else if (request?.state === "declined") {
    body = (
      <>
        <Line label={[request.decidedBy, request.decidedAt ? when(request.decidedAt) : ""].filter(Boolean).join(" · ") || "Declined"}>
          <Quote>{request.decisionReason}</Quote>
        </Line>
        <Line label={`What you asked${request.createdAt ? `, ${when(request.createdAt)}` : ""}`}>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13.5 }}>
            {request.reason}
          </Typography>
        </Line>
        {!closed && (
          <Act
            button={
              <Button variant="contained" onClick={() => { setAsking("you"); }}>
                Ask again…
              </Button>
            }
            note="At once, with a new reason; this answer stays beside it."
          />
        )}
      </>
    );
  } else {
    body = (
      <>
        <Typography variant="body2">
          {catalog ? "" : "You aren’t on its access list: not by name, and not through a group. "}
          {closed
            ? `${t} takes no requests for it (access.requests: closed): ask its team directly.`
            : api.accessRequests === "open"
              ? `${t} grants every request at once, at its limit.`
              : `Requests need approval by ${t}: a ${t} maintainer grants you, or a group you’re in, or declines with a reason. You’re told either way.`}
        </Typography>
        {!closed && (
          <Act
            button={
              <Button variant="contained" onClick={() => { setAsking("you"); }}>
                Request access…
              </Button>
            }
            note={`For you, ${user?.email ?? ""}`}
          />
        )}
      </>
    );
  }

  return (
    <Card component="section" aria-label="Your access" sx={{ p: 2.75, display: "flex", flexDirection: "column", gap: 1.75 }}>
      <Box>
        <Typography variant="body2" color="text.secondary">
          Your access
        </Typography>
        <Typography variant="h6" component="h2">
          {title}
        </Typography>
      </Box>
      {catalog && (
        <Typography variant="body2">
          From the catalog: its api.yaml’s shareWith names {catalog.callingTeam}, so its members and bots may call it, at {rateText(catalog.perMinute)}. shareWith is going
          away, so you’ll need a grant of your own.
        </Typography>
      )}
      {body}
      {!closed && botTeams.length > 0 && (
        <Act
          button={
            <Button variant="outlined" onClick={() => { setAsking("bot"); }}>
              Request access for a bot…
            </Button>
          }
          note={`You maintain ${botTeams.join(" and ")}, so you may ask for their bots, with a reason. ${t} answers it like a person’s.`}
        />
      )}
      <Typography variant="caption" color="text.secondary" sx={{ borderTop: 1, borderColor: "divider", pt: 1.25 }}>
        Access is per person or per bot, never per team: your grant is yours alone, and a bot’s grants are on its team’s Automation page.
      </Typography>
      <RequestAccessDialog
        open={asking !== null}
        api={api}
        forBot={asking === "bot"}
        groups={groups}
        onClose={() => { setAsking(null); }}
        onDone={() => {
          setAsking(null);
          onChanged();
        }}
      />
      {dialog}
    </Card>
  );
}
