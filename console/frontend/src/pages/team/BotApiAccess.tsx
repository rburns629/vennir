// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, Card, Link, Stack, Typography } from "@mui/material";
import { errorMessage, listApis, listTeamBotApiAccess, type ApiAccessRequest, type ApiGrant, type ApiProduct, type Bot } from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { when } from "../../time";
import { botName, botTeamsOf, grantedByText, grantName, lastCallText, rateText, RequestAccessDialog, revokeAsk, useAccessAsk, withdrawAsk } from "../api/access";
import { CardTitle, SectionLabel } from "./shared";

type Row = { key: string; team: string; name: string; grant: ApiGrant | null; request: ApiAccessRequest | null };

/**
 * A team's Automation: each bot's grants to other teams' APIs and its
 * requests (15i). Its maintainers ask for a bot's access, with a reason,
 * withdraw a bot's request, and revoke a bot's grant; an admin may
 * revoke one too. Members of the API's own team never need a grant.
 */
export function BotApiAccess({ teamName, bots, readOnly }: { teamName: string; bots: Bot[]; readOnly: boolean }) {
  const { user } = useAuth();
  const [access, setAccess] = useState<{ grants: ApiGrant[]; requests: ApiAccessRequest[] } | null>(null);
  const [apis, setApis] = useState<ApiProduct[] | null>(null);
  const [apisError, setApisError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);

  // Only the latest load's answer is shown: one superseded by a later load,
  // or of a team switched away from, is ignored. (Its parent keys it by
  // team too, so nothing of another team's is shown meanwhile.)
  const latest = useRef(0);
  const load = useCallback(() => {
    const mine = ++latest.current;
    listTeamBotApiAccess(teamName)
      .then((got) => {
        if (mine !== latest.current) return;
        setAccess(got);
        setError(null);
      })
      .catch((err: unknown) => {
        if (mine === latest.current) setError(errorMessage(err, "Couldn't load the bots' grants."));
      });
  }, [teamName]);
  useEffect(() => {
    load();
    return () => {
      latest.current++;
    };
  }, [load]);
  useEffect(() => {
    let cancelled = false;
    listApis()
      .then((list) => {
        if (!cancelled) setApis(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setApisError(errorMessage(err, "Couldn't load the APIs to ask for."));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const { ask, dialog } = useAccessAsk(load);

  const maintains = user?.maintainerOf.includes(teamName) ?? false;
  const isAdmin = user?.isAdmin ?? false;
  // A retired team's bots get nothing new; an admin may still revoke (an incident).
  const canAsk = maintains && !readOnly && botTeamsOf(user).includes(teamName);
  const own = apis?.filter((a) => a.team === teamName) ?? [];
  const others = apis?.filter((a) => a.team !== teamName && a.accessRequests !== "closed") ?? null;
  const display = (team: string, name: string) => apis?.find((a) => a.team === team && a.name === name)?.displayName || `${team}/${name}`;

  const columns: DataTableColumn<Row>[] = [
    {
      key: "api",
      header: "API",
      render: (r) => (
        <Link component={RouterLink} to={`/apis/${encodeURIComponent(r.team)}/${encodeURIComponent(r.name)}`} variant="body2" sx={{ fontWeight: 500 }}>
          {display(r.team, r.name)}{" "}
          <Typography component="span" variant="caption" color="text.secondary">
            {r.team}’s
          </Typography>
        </Link>
      ),
    },
    {
      key: "state",
      header: "State",
      render: (r) =>
        r.grant ? (
          <Pill tone="success">Granted</Pill>
        ) : r.request?.state === "waiting" ? (
          <Pill tone="warning">Waiting for {r.team}</Pill>
        ) : (
          <Box>
            <Pill tone="error">Declined</Pill>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5, overflowWrap: "anywhere" }}>
              {r.request?.decisionReason ? `“${r.request.decisionReason}”` : ""}
            </Typography>
          </Box>
        ),
    },
    { key: "rate", header: "Rate", render: (r) => (r.grant ? rateText(r.grant.perMinute) : "—"), hideBelow: "sm" },
    {
      key: "when",
      header: "Granted or asked",
      hideBelow: "md",
      render: (r) =>
        r.grant
          ? grantedByText(r.grant)
          : r.request?.state === "waiting"
            ? `asked by ${r.request.requestedBy === user?.email ? "you" : r.request.requestedBy}${r.request.createdAt ? `, ${when(r.request.createdAt)}` : ""}`
            : `${r.request?.decidedBy ?? ""}${r.request?.decidedAt ? `, ${when(r.request.decidedAt)}` : ""}`,
    },
    { key: "last", header: "Last call", render: (r) => (r.grant ? lastCallText(r.grant.lastUsedAt) : "—"), hideBelow: "sm" },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      render: (r) => {
        const { grant, request } = r;
        if (grant && (isAdmin || (maintains && !readOnly))) {
          return (
            <Button size="small" color="error" aria-label={`Revoke ${grantName(grant)}’s access to ${display(r.team, r.name)}…`} onClick={() => { ask(revokeAsk(grant, `${r.team}’s maintainers are told.`)); }}>
              Revoke…
            </Button>
          );
        }
        // Whoever asked, or any maintainer of its team while the team isn't retired.
        if (request?.state === "waiting" && (request.requestedBy === user?.email || canAsk)) {
          return (
            <Button size="small" onClick={() => { ask(withdrawAsk(request)); }}>
              Withdraw
            </Button>
          );
        }
        return null;
      },
    },
  ];

  return (
    <Box component="section" aria-labelledby="bot-apis" sx={{ mt: 3 }}>
      <SectionLabel id="bot-apis">Bots calling other teams’ APIs</SectionLabel>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1.65fr) minmax(0, 1fr)" }, gap: 2, alignItems: "start" }}>
        <Stack spacing={2}>
          {bots.length === 0 && (
            <Card sx={{ p: 2.5 }}>
              <Typography color="text.secondary">No bots yet: add one above, then ask for its access here.</Typography>
            </Card>
          )}
          {bots.map((bot) => {
            const rows: Row[] | null = access && [
              ...access.grants.filter((g) => g.userId === bot.id).map((g) => ({ key: g.id, team: g.team, name: g.name, grant: g, request: null })),
              ...access.requests
                .filter((q) => q.userId === bot.id)
                .filter((q, i, all) => all.findIndex((o) => o.team === q.team && o.name === q.name) === i)
                .filter((q) => !access.grants.some((g) => g.userId === bot.id && g.team === q.team && g.name === q.name))
                .map((q) => ({ key: q.id, team: q.team, name: q.name, grant: null, request: q })),
            ];
            return (
              <Card key={bot.id} component="article" aria-label={`${botName(bot.email)}'s API access`} sx={{ p: { xs: 2, sm: 2.5 }, display: "flex", flexDirection: "column", gap: 1.5 }}>
                <CardTitle
                  title={<Mono sx={{ fontSize: 15 }}>{botName(bot.email)}</Mono>}
                  aside={
                    canAsk ? (
                      <Button variant="outlined" size="small" onClick={() => { setAsking(bot.email); }}>
                        Request access for a bot…
                      </Button>
                    ) : undefined
                  }
                >
                  {bot.ordering ? "Ordering" : "Pipeline"} · never in a group
                </CardTitle>
                <DataTable columns={columns} rows={rows} getRowKey={(r) => r.key} skeletonRowCount={1} emptyMessage="No grants or requests: it calls only its own team’s APIs." />
                <Typography variant="caption" color="text.secondary">
                  Always, without a grant: {teamName}’s own APIs{own.length > 0 ? ` (${own.map((a) => a.displayName || a.name).join(", ")})` : ""}.
                </Typography>
              </Card>
            );
          })}
        </Stack>
        <Card component="section" aria-labelledby="bot-grants" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
          <CardTitle id="bot-grants" title="A bot’s grants" />
          <Typography variant="body2">
            {teamName}’s maintainers ask for a bot’s access, on its behalf and with a reason; the API’s team approves or declines it, as it does a person’s.
          </Typography>
          <Typography variant="body2">
            {teamName}’s maintainers may revoke a bot’s grant. The API’s team sets and changes its rate, and may revoke it too.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            A person’s grants don’t pass to the bots they run, and <Mono>Vennir-Team</Mono> doesn’t decide access.
          </Typography>
        </Card>
      </Box>
      <RequestAccessDialog
        open={asking !== null}
        bot={asking ?? undefined}
        apis={others}
        apisError={apisError}
        onClose={() => { setAsking(null); }}
        onDone={() => {
          setAsking(null);
          load();
        }}
      />
      {dialog}
    </Box>
  );
}
