// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { errorMessage, listMyApiAccess, listTeamBotApiAccess, type ApiAccessRequest, type ApiProduct, type MyApiAccess } from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Mono } from "../../components/Mono";
import { when } from "../../time";
import { botTeamsOf, giveUpAsk, rateText, RequestAccessDialog, useAccessAsk, withdrawAsk } from "./access";

type Row = { key: string; team: string; name: string; access: MyApiAccess | null; request: ApiAccessRequest | null };

function Two({ first, second }: { first: ReactNode; second?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {first}
      </Typography>
      {second && (
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          {second}
        </Typography>
      )}
    </Box>
  );
}

function how(row: Row): ReactNode {
  const { access: a, request: r, team } = row;
  if (a?.via === "user") return <Two first="By name" second="granted to you" />;
  if (a?.via === "group") return <Two first="Through a group" second={`${a.group}, as of your sign-in; not yours to give up`} />;
  if (a?.via === "team") return <Two first="Your team’s" second={`you’re in ${a.callingTeam}, so always`} />;
  if (a?.via === "catalog") return <Two first="From the catalog" second={`its shareWith names ${a.callingTeam}; going away`} />;
  if (r?.state === "waiting") return <Two first={`Waiting for ${team}`} second={r.createdAt ? `you asked ${when(r.createdAt)}` : undefined} />;
  return <Two first="Declined" second={`by ${r?.decidedBy ?? ""}${r?.decidedAt ? `, ${when(r.decidedAt)}` : ""}: “${r?.decisionReason ?? ""}”`} />;
}

/**
 * The APIs page's You may call (15g): every API you may call and how
 * (by name, through a group, your team's, from the catalog), at your rate,
 * and your requests that wait or were declined; give up a grant by name,
 * withdraw a request, ask again. Beside it, your teams' bots' grants, and
 * how access works.
 */
export function MyAccess({ apis, search, onChanged }: { apis: ApiProduct[] | null; search: string; /** After a change: the APIs list reloads too. */ onChanged: () => void }) {
  const { user } = useAuth();
  const [mine, setMine] = useState<{ access: MyApiAccess[]; requests: ApiAccessRequest[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState<ApiProduct | null>(null);

  const load = useCallback(() => {
    listMyApiAccess()
      .then((m) => {
        setMine(m);
        setError(null);
      })
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load what you may call.")); });
  }, []);
  useEffect(load, [load]);
  const changed = () => {
    load();
    onChanged();
  };
  const { ask, dialog } = useAccessAsk(changed);
  const botTeams = botTeamsOf(user);

  const byKey = new Map((apis ?? []).map((a) => [`${a.team}/${a.name}`, a]));
  const rows: Row[] | null = mine && [
    ...mine.access.map((a) => ({ key: `a ${a.team}/${a.name}`, team: a.team, name: a.name, access: a, request: null })),
    // A request for an API you may call by now is history; else its newest.
    ...mine.requests
      .filter((r) => !r.bot && !mine.access.some((a) => a.team === r.team && a.name === r.name))
      .filter((r, i, all) => all.findIndex((o) => o.team === r.team && o.name === r.name) === i)
      .map((r) => ({ key: `r ${r.id}`, team: r.team, name: r.name, access: null, request: r })),
  ];
  const q = search.trim().toLowerCase();
  const shown = rows?.filter((r) => !q || [r.team, r.name, byKey.get(`${r.team}/${r.name}`)?.displayName ?? ""].some((s) => s.toLowerCase().includes(q))) ?? null;

  const columns: DataTableColumn<Row>[] = [
    {
      key: "api",
      header: "API",
      render: (r) => {
        const api = byKey.get(`${r.team}/${r.name}`);
        return (
          <Two
            first={
              <Link component={RouterLink} to={`/apis/${encodeURIComponent(r.team)}/${encodeURIComponent(r.name)}`} underline="hover" sx={{ color: "text.primary", fontWeight: 600 }}>
                {api?.displayName || r.name}{" "}
                <Typography component="span" variant="body2" color="text.secondary">
                  {r.team}’s
                </Typography>
              </Link>
            }
            second={<Mono sx={{ fontSize: 12 }}>{(api?.publicUrl || api?.url || `${r.team}/${r.name}`).replace(/^https?:\/\//, "")}</Mono>}
          />
        );
      },
    },
    { key: "how", header: "How", render: how },
    {
      key: "rate",
      header: "Your rate",
      render: (r) => (r.access ? <Two first={rateText(r.access.perMinute)} second={r.access.via === "group" ? "each member gets it" : undefined} /> : "—"),
      hideBelow: "sm",
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      render: (r) => {
        const label = byKey.get(`${r.team}/${r.name}`)?.displayName || `${r.team}/${r.name}`;
        if (r.access?.via === "user") {
          const grant = r.access.grantId;
          return (
            <Button size="small" color="error" onClick={() => { ask(giveUpAsk(grant, label)); }}>
              Give up…
            </Button>
          );
        }
        const request = r.request;
        if (request?.state === "waiting") {
          return (
            <Button size="small" onClick={() => { ask(withdrawAsk(request)); }}>
              Withdraw
            </Button>
          );
        }
        const api = byKey.get(`${r.team}/${r.name}`);
        if (request?.state === "declined" && api && api.accessRequests !== "closed") {
          return (
            <Button size="small" onClick={() => { setAgain(api); }}>
              Ask again…
            </Button>
          );
        }
        return null;
      },
    },
  ];

  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-start" }}>
      <Card component="section" aria-label="What you may call" sx={{ flex: "3 1 680px", minWidth: 0, overflowX: "auto" }}>
        <Box sx={{ px: 2.75, pt: 2.25, pb: 1.25 }}>
          <Typography variant="h6" component="h2">
            What you may call, and what you’ve asked for
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            {user?.email}. Your bots’ grants are on their teams’ Automation pages.
          </Typography>
        </Box>
        {error && (
          <Alert severity="error" sx={{ mx: 2.75, mb: 1.5 }}>
            {error}
          </Alert>
        )}
        <DataTable columns={columns} rows={error ? [] : shown} getRowKey={(r) => r.key} skeletonRowCount={3} emptyMessage={q ? "No API matches." : "Nothing yet: ask for access from an API’s page."} />
      </Card>
      <Box component="aside" sx={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        {botTeams.length > 0 && <YourTeamsBots teams={botTeams} />}
        <HowAccessWorks />
      </Box>
      <RequestAccessDialog
        open={again !== null}
        api={again}
        onClose={() => { setAgain(null); }}
        onDone={() => {
          setAgain(null);
          changed();
        }}
      />
      {dialog}
    </Box>
  );
}

/** Each team you maintain, with its bots' grants and waiting requests, linking to its Automation tab. */
function YourTeamsBots({ teams }: { teams: string[] }) {
  const [counts, setCounts] = useState<Record<string, { grants: number; waiting: number }>>({});
  const key = teams.join(",");
  useEffect(() => {
    let cancelled = false;
    for (const team of key.split(",")) {
      // Display only: a count that can't be read just isn't shown.
      listTeamBotApiAccess(team)
        .then((r) => {
          if (!cancelled) setCounts((c) => ({ ...c, [team]: { grants: r.grants.length, waiting: r.requests.filter((q) => q.state === "waiting").length } }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [key]);
  return (
    <Card component="section" aria-label="Your teams' bots" sx={{ p: 2.75, display: "flex", flexDirection: "column", gap: 1.25 }}>
      <Typography variant="h6" component="h2">
        Your teams’ bots
      </Typography>
      {teams.map((t) => (
        <Box key={t} sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
          <Link component={RouterLink} to={`/teams/${encodeURIComponent(t)}?tab=automation`} variant="body2" sx={{ fontWeight: 500 }}>
            {t}’s Automation
          </Link>
          {counts[t] && (
            <Typography variant="caption" color="text.secondary">
              {counts[t].grants} {counts[t].grants === 1 ? "grant" : "grants"} · {counts[t].waiting} waiting
            </Typography>
          )}
        </Box>
      ))}
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
        As a maintainer of a bot’s team, you ask for it there, with a reason, and may revoke its grants.
      </Typography>
    </Card>
  );
}

const STEPS: ReactNode[] = [
  "You ask, for yourself, from the API’s page, with a reason.",
  <>
    Its api.yaml’s <Mono sx={{ fontSize: 12 }}>access.requests</Mono> decides what happens: open is granted at once, approval waits for its team, closed has no
    button.
  </>,
  "Its team grants you by name, or a group you’re in, at a rate; or declines with a reason.",
  "The gateway checks every call: you, by name or by a group as of your sign-in. Anyone else gets 403.",
];

function HowAccessWorks() {
  return (
    <Card component="section" aria-label="How access works" sx={{ p: 2.75, display: "flex", flexDirection: "column", gap: 1.25 }}>
      <Typography variant="h6" component="h2">
        How access works
      </Typography>
      <Box component="ol" sx={{ m: 0, pl: 2.5, display: "flex", flexDirection: "column", gap: 1 }}>
        {STEPS.map((s, i) => (
          <Typography key={i} component="li" variant="body2" sx={{ fontSize: 13, lineHeight: 1.5 }}>
            {s}
          </Typography>
        ))}
      </Box>
    </Card>
  );
}
