// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import { Mono } from "../../components/Mono";
import { ApiError, errorMessage, searchLogs, type LogLineView } from "../../api";
import { LogLines } from "../observe/LogLines";

const SHOWN = 20;

/**
 * The newest lines from its team's API backends (ObserveService.SearchLogs,
 * source api), for its own team and admins. They're the team's Pods
 * labelled vertra/api-backend, not this API's alone: the logs don't say
 * which API a Pod serves.
 */
export function ApiLogs({ team, api }: { team: string; api: string }) {
  const [lines, setLines] = useState<LogLineView[] | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    searchLogs({ team, source: "api", hours: 24 })
      .then((found) => {
        if (!cancelled) setLines(found.lines.slice(0, SHOWN));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "LOGS_OFF") setOff(true);
        else setError(errorMessage(err, "Failed to load its backend's logs."));
      });
    return () => {
      cancelled = true;
    };
  }, [team]);

  return (
    <Card component="section" id="logs" aria-label="Backend logs" sx={{ overflow: "hidden", scrollMarginTop: 16 }}>
      <Box sx={{ px: 2.75, pt: 2.25, pb: 1.5, display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 1.5 }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, maxWidth: 760 }}>
          <Typography variant="h6" component="h2">
            Its backend’s logs
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            The newest lines, over the last day, from Pods {team} labels <Mono sx={{ fontSize: 12 }}>vertra/api-backend</Mono>, every level,
            seen by {team} and admins only. Credentials are redacted before anything is kept.
          </Typography>
        </Box>
        {!off && (
          <Button component={RouterLink} to={`/observe?tab=logs&from=api&team=${encodeURIComponent(team)}&api=${encodeURIComponent(api)}&hours=24`} variant="outlined" size="large">
            Search them in Observe
          </Button>
        )}
      </Box>
      <Box sx={{ borderTop: 1, borderColor: "divider" }}>
        {off && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2.75, py: 2 }}>
            This install doesn&apos;t keep logs. A backend in the cluster still logs where its Pods run.
          </Typography>
        )}
        {error && (
          <Alert severity="error" sx={{ m: 2 }}>
            {error}
          </Alert>
        )}
        {!off && !error && lines === null && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2.75, py: 2 }}>
            Loading…
          </Typography>
        )}
        {lines?.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2.75, py: 2 }}>
            No lines in the last day. A backend outside the cluster (Cloud Run, Lambda) logs where it runs.
          </Typography>
        )}
        {lines && lines.length > 0 && <LogLines lines={lines} sourceWidth={150} />}
      </Box>
    </Card>
  );
}
