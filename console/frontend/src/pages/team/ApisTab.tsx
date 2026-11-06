// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Mono } from "../../components/Mono";
import { errorMessage, listApis, listAwayApiAccess, type ApiAccessRequest, type ApiGrant, type ApiProduct } from "../../api";
import { when } from "../../time";
import { ApiStatePill } from "../api/ApiStatePill";
import { grantedByText, Principal, rateText, revokeAsk, useAccessAsk } from "../api/access";
import { CardTitle } from "./shared";

const COLUMNS: DataTableColumn<ApiProduct>[] = [
  { key: "name", header: "API", render: (a) => a.displayName },
  { key: "state", header: "State", render: (a) => <ApiStatePill state={a.state} /> },
  { key: "backend", header: "Backend", render: (a) => (a.backendUrl ? <Mono>{a.backendUrl}</Mono> : "—"), hideBelow: "md" },
  { key: "requests", header: "Requests", render: (a) => a.accessRequests, hideBelow: "sm" },
];

const AWAY_DAYS = 30;
const until = (since: string | null) => (since ? when(new Date(new Date(since).getTime() + AWAY_DAYS * 24 * 60 * 60 * 1000).toISOString()) : "");

/**
 * The grants and waiting requests of the team's APIs that left the
 * catalog's release: kept 30 days, back if an API of the same name
 * returns, letting nobody call meanwhile. Its maintainers and admins may
 * revoke them.
 */
function AwayAccess({ teamName, canRevoke }: { teamName: string; canRevoke: boolean }) {
  const [away, setAway] = useState<{ grants: ApiGrant[]; requests: ApiAccessRequest[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    listAwayApiAccess(teamName)
      .then(setAway)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the grants of APIs that left the catalog.")); });
  }, [teamName]);
  useEffect(load, [load]);
  const { ask, dialog } = useAccessAsk(load);

  const grants = away?.grants.filter((g) => !g.revokedAt) ?? [];
  const waiting = away?.requests.filter((r) => r.state === "waiting") ?? [];
  if (error) return <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>;
  if (grants.length === 0 && waiting.length === 0) return null;

  const columns: DataTableColumn<ApiGrant>[] = [
    { key: "api", header: "API", render: (g) => <Mono>{g.name}</Mono> },
    { key: "to", header: "Granted to", render: (g) => <Principal grant={g} /> },
    { key: "rate", header: "Rate", render: (g) => rateText(g.perMinute, Boolean(g.group)), hideBelow: "sm" },
    { key: "by", header: "Granted by", render: grantedByText, hideBelow: "md" },
    { key: "until", header: "Kept until", render: (g) => until(g.awaySince), hideBelow: "sm" },
  ];
  if (canRevoke) {
    columns.push({
      key: "revoke",
      header: "Revoke",
      align: "right",
      render: (g) => (
        <Button size="small" color="error" onClick={() => { ask(revokeAsk(g, "It won’t come back with the API. Whom it names is told.")); }}>
          Revoke…
        </Button>
      ),
    });
  }
  return (
    <Card component="section" aria-labelledby="away" sx={{ mt: 3, p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <CardTitle id="away" title="Away from the catalog’s release">
        These APIs left the catalog’s release. Their grants and requests are kept {AWAY_DAYS} days, letting nobody call, and come back if an API of the
        same name returns within them; after, they’re gone.
      </CardTitle>
      <DataTable columns={columns} rows={grants} getRowKey={(g) => g.id} emptyMessage="No grants kept." />
      {waiting.length > 0 && (
        <Typography variant="body2" color="text.secondary">
          Waiting for its return: {waiting.map((r) => `${r.userEmail} (${r.name})`).join(", ")}.
        </Typography>
      )}
      {dialog}
    </Card>
  );
}

/** A team's API products: its apis/ folder in the catalog, as published; and what's kept of the ones that left. */
export function ApisTab({ teamName, canMaintain }: { teamName: string; canMaintain: boolean }) {
  const navigate = useNavigate();
  const [apis, setApis] = useState<ApiProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listApis()
      .then((all) => {
        if (!cancelled) setApis(all.filter((a) => a.team === teamName));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Failed to load the team's APIs."));
      });
    return () => {
      cancelled = true;
    };
  }, [teamName]);

  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Backends this team runs, published through the gateway: each one an api.yaml and its OpenAPI file in the team&apos;s catalog folder,
        reviewed like any product. Open one for its endpoints, traffic, who may call it, and pausing.
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <DataTable
        columns={COLUMNS}
        rows={apis}
        getRowKey={(a) => a.name}
        onRowClick={(a) => {
          navigate(`/apis/${a.team}/${a.name}`);
        }}
        emptyMessage="No APIs: add teams/<team>/apis/<name>/api.yaml and its OpenAPI file to the catalog."
      />
      <AwayAccess teamName={teamName} canRevoke={canMaintain} />
    </>
  );
}
