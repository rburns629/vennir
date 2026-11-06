// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Card from "@mui/material/Card";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import type { ApiEndpoint, ApiProduct, ApiTraffic } from "../../api";
import { Mono } from "../../components/Mono";

export function size(bytes: number): string {
  return bytes >= 1 << 20 ? `${String(bytes / (1 << 20))} MiB` : `${String(Math.round(bytes / 1024))} KiB`;
}

/** A path with its parameters as placeholders, for the sample call. */
function sample(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => `<${name}>`);
}

/**
 * One shell word, single-quoted with any ' in it closed, escaped and
 * reopened: a path comes from the catalog, and people paste the curl
 * command into a terminal, so nothing in it may run.
 */
export function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function Fact({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375, minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ fontSize: 13, overflowWrap: "anywhere" }}>
        {children}
      </Typography>
      {note && (
        <Typography variant="caption" color="text.secondary" component="div" sx={{ overflowWrap: "anywhere" }}>
          {note}
        </Typography>
      )}
    </Box>
  );
}

const METHOD_TONE: Record<string, "success" | "info" | "warning" | "error"> = {
  GET: "success",
  HEAD: "success",
  POST: "info",
  PUT: "warning",
  PATCH: "warning",
  DELETE: "error",
};

/** An HTTP method as a fixed-width tag, colored by what it does (and spelled out, so never by color alone). */
function Method({ method }: { method: string }) {
  const tone = METHOD_TONE[method];
  return (
    <Box
      component="span"
      sx={{
        flex: "0 0 60px",
        textAlign: "center",
        fontFamily: "fontFamilyMono",
        fontSize: 11.5,
        fontWeight: 500,
        py: 0.5,
        borderRadius: 1.5,
        color: tone ? `${tone}.main` : "text.secondary",
        bgcolor: tone ? `${tone}.light` : "action.hover",
      }}
    >
      {method}
    </Box>
  );
}

type EndpointTraffic = ApiTraffic["endpoints"][number];
const num = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());

/** One endpoint's traffic, as the table's columns. */
function TrafficCells({ t }: { t: Pick<EndpointTraffic, "requests" | "invalid" | "backend4xx" | "backend5xx" | "averageMs"> | undefined }) {
  const narrow = { display: { xs: "none", sm: "table-cell" } };
  return (
    <>
      <TableCell align="right">{num(t?.requests)}</TableCell>
      <TableCell align="right" sx={narrow}>
        {num(t?.invalid)}
      </TableCell>
      <TableCell align="right" sx={{ display: { xs: "none", md: "table-cell" } }}>
        {num(t?.backend4xx)}
      </TableCell>
      <TableCell align="right" sx={{ ...narrow, ...(t?.backend5xx ? { color: "error.main", fontWeight: 600 } : {}) }}>
        {num(t?.backend5xx)}
      </TableCell>
      <TableCell align="right" sx={{ display: { xs: "none", md: "table-cell" }, pr: 2.75 }}>
        {t?.averageMs ? `${String(t.averageMs)} ms` : "—"}
      </TableCell>
    </>
  );
}

/**
 * The endpoints its OpenAPI file describes, each with its traffic when the
 * viewer is its own team's (`traffic` given), and how to call the one
 * picked. What anyone who may see an API needs to call it.
 */
export function ApiEndpoints({ api, traffic }: { api: ApiProduct; traffic?: ApiTraffic | null }) {
  const [selected, setSelected] = useState<ApiEndpoint | null>(api.endpoints[0] ?? null);
  const base = api.publicUrl || api.url || `<the gateway>/${api.team}/${api.name}`;
  const curl =
    selected &&
    [
      `curl -X ${selected.method} ${shellWord(base + sample(selected.path))} \\`,
      `  -H "Authorization: Bearer $VENNIR_TOKEN"`,
      ...(["POST", "PUT", "PATCH"].includes(selected.method) ? [`  -H 'Content-Type: application/json' -d '{...}'`] : []),
    ].join("\n");
  const showTraffic = traffic !== undefined;
  const byEndpoint = new Map<string, EndpointTraffic>((traffic?.endpoints ?? []).map((e) => [e.endpoint, e]));
  const inSpec = new Set(api.endpoints.map((e) => `${e.method} ${e.path}`));
  const offSpec = (traffic?.endpoints ?? []).filter((e) => !inSpec.has(e.endpoint) && e.requests > 0);
  const trafficCell = { display: { xs: "none", sm: "table-cell" } };

  return (
    <Card component="section" aria-label="Endpoints" sx={{ flex: "3 1 620px", minWidth: 0, overflow: "hidden" }}>
      <Box sx={{ px: 2.75, pt: 2.25, pb: 1.25, display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Typography variant="h6" component="h2">
          Endpoints, from its OpenAPI file
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
          The whole of what reaches the backend; anything else gets 404 from the gateway. Pick one to see how to call it.
        </Typography>
      </Box>
      <Box sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ "& th": { whiteSpace: "nowrap" } }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ pl: 2.75 }}>Endpoint</TableCell>
              {showTraffic && (
                <>
                  <TableCell align="right">Requests</TableCell>
                  <TableCell align="right" sx={trafficCell}>
                    Didn’t fit
                  </TableCell>
                  <TableCell align="right" sx={{ display: { xs: "none", md: "table-cell" } }}>
                    Backend 4xx
                  </TableCell>
                  <TableCell align="right" sx={trafficCell}>
                    Backend 5xx
                  </TableCell>
                  <TableCell align="right" sx={{ display: { xs: "none", md: "table-cell" }, pr: 2.75 }}>
                    Backend, avg
                  </TableCell>
                </>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {api.endpoints.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} sx={{ py: 4, textAlign: "center", color: "text.secondary" }}>
                  Its OpenAPI file describes no endpoints.
                </TableCell>
              </TableRow>
            )}
            {api.endpoints.map((e) => {
              const key = `${e.method} ${e.path}`;
              const t = traffic ? (byEndpoint.get(key) ?? { requests: 0, invalid: 0, backend4xx: 0, backend5xx: 0, averageMs: 0 }) : undefined;
              const on = selected?.method === e.method && selected.path === e.path;
              return (
                <TableRow key={key} selected={on} sx={on ? { boxShadow: (theme) => `inset 3px 0 0 ${theme.palette.primary.main}` } : undefined}>
                  <TableCell sx={{ pl: 2.75 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minWidth: { sm: 240 } }}>
                      <Method method={e.method} />
                      <ButtonBase
                        onClick={() => {
                          setSelected(e);
                        }}
                        aria-pressed={on}
                        aria-label={`${e.method} ${e.path}${e.summary ? `: ${e.summary}` : ""}`}
                        sx={{ display: "flex", flexDirection: "column", alignItems: "flex-start", textAlign: "left", gap: 0.25, minWidth: 0, minHeight: 36, borderRadius: 1 }}
                      >
                        <Mono sx={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{e.path}</Mono>
                        {e.summary && (
                          <Typography variant="caption" color="text.secondary">
                            {e.summary}
                          </Typography>
                        )}
                      </ButtonBase>
                    </Box>
                  </TableCell>
                  {showTraffic && <TrafficCells t={t} />}
                </TableRow>
              );
            })}
            {/* What callers sent that isn't in the spec now (paths it never had, refused at the
                door; operations since removed): counted in the totals, so listed too. */}
            {showTraffic &&
              offSpec.map((e) => (
                <TableRow key={`other ${e.endpoint}`}>
                  <TableCell sx={{ pl: 2.75 }}>
                    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: { sm: 240 } }}>
                      <Mono sx={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{e.endpoint}</Mono>
                      <Typography variant="caption" color="text.secondary">
                        not in its current spec
                      </Typography>
                    </Box>
                  </TableCell>
                  <TrafficCells t={e} />
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </Box>
      {curl && (
        <Box id="calling" sx={{ px: 2.75, pt: 2.25, pb: 2.75, borderTop: 1, borderColor: "divider", bgcolor: "background.default", display: "flex", flexDirection: "column", gap: 1.25 }}>
          <Typography variant="subtitle2" component="h3">
            Calling{" "}
            <Mono sx={{ fontWeight: 500 }}>
              {selected.method} {selected.path}
            </Mono>
          </Typography>
          <Box
            component="pre"
            tabIndex={0}
            sx={{ m: 0, p: 1.75, bgcolor: "code.background", color: "code.text", borderRadius: 2, overflowX: "auto", fontSize: 12, lineHeight: 1.6, fontFamily: "fontFamilyMono" }}
          >
            {curl}
          </Box>
          <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.5 }}>
            Your <Mono>Authorization</Mono> header signs you in to the gateway and stops there. The backend gets your other headers, and
            who you are in <Mono>Vennir-Caller</Mono>, signed by the gateway. Every answer says which answered:{" "}
            <Mono>Vennir-Answered-By: gateway</Mono> or <Mono>backend</Mono>.
          </Typography>
        </Box>
      )}
    </Card>
  );
}
