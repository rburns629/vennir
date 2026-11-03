// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Typography from "@mui/material/Typography";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Mono } from "../../components/Mono";
import { errorMessage, listApis, type ApiProduct } from "../../api";
import { ApiStatePill } from "../api/ApiStatePill";

const COLUMNS: DataTableColumn<ApiProduct>[] = [
  { key: "name", header: "API", render: (a) => a.displayName },
  { key: "state", header: "State", render: (a) => <ApiStatePill state={a.state} /> },
  { key: "backend", header: "Backend", render: (a) => (a.backendUrl ? <Mono>{a.backendUrl}</Mono> : "—"), hideBelow: "md" },
  { key: "shared", header: "Shared with", render: (a) => a.shareWith.join(", ") || "only this team", hideBelow: "sm" },
];

/** A team's API products: its apis/ folder in the catalog, as published. */
export function ApisTab({ teamName }: { teamName: string }) {
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
        reviewed like any product. Open one for its endpoints, traffic and pausing.
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
    </>
  );
}
