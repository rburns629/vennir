// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { HelpLink } from "../components/HelpLink";
import { Mono } from "../components/Mono";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { errorMessage, listApis, type ApiProduct } from "../api";
import { useAuth } from "../auth/AuthContext";
import { size } from "./api/ApiOverview";
import { MyAccess } from "./api/MyAccess";
import { ApiStatePill } from "./api/ApiStatePill";

type Filter = "all" | "call" | "mine" | "stopped";
const FILTERS: [Filter, string, (a: ApiProduct, mine: boolean) => boolean][] = [
  ["all", "All", () => true],
  ["call", "You may call", (a) => a.mayCall],
  ["mine", "Your teams’", (_a, mine) => mine],
  ["stopped", "Not live", (a) => a.state !== "LIVE"],
];

/** Where the gateway answers, from an API's own address: what's before /<team>/<name>. */
function gatewayBase(address: string, a: ApiProduct): string {
  const suffix = `/${a.team}/${a.name}`;
  return address.endsWith(suffix) ? address.slice(0, -suffix.length) : "";
}

const VIA: Record<string, string> = { user: "by name", group: "through a group" };

/** The You column: whether you may call it, and on what terms. */
function You({ api, mine }: { api: ApiProduct; mine: boolean }) {
  const terms = `${String(api.perMinute)} a minute · ${size(api.maxRequestBytes)} · ${String(api.timeoutSeconds)} s`;
  const [label, note] = mine
    ? ["Your team’s", api.state === "PAUSED" ? "every call gets 503 while paused" : api.state === "UNAVAILABLE" ? "every call gets 503 until its spec is fixed" : terms]
    : api.mayCall
      ? [`May call${api.accessVia && VIA[api.accessVia] ? `, ${VIA[api.accessVia]}` : ""}`, terms]
      : ["Not granted", api.accessRequests === "closed" ? "it takes no requests: ask its team" : "the gateway answers your calls with 403"];
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Typography variant="body2" sx={{ fontWeight: 500, color: api.mayCall || mine ? "text.primary" : "warning.main" }}>
        {label}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {note}
      </Typography>
      {!api.mayCall && !mine && api.accessRequests !== "closed" && (
        <Link component={RouterLink} to={`/apis/${encodeURIComponent(api.team)}/${encodeURIComponent(api.name)}`} variant="body2" sx={{ fontSize: 12.5 }}>
          Request access
        </Link>
      )}
    </Box>
  );
}

function ApiRow({ api, mine }: { api: ApiProduct; mine: boolean }) {
  const note =
    api.state === "HELD" ? api.heldReason : api.state === "UNAVAILABLE" ? api.problem : api.state === "PAUSED" && api.pausedMessage ? `“${api.pausedMessage}”` : "";
  return (
    <TableRow>
      <TableCell sx={{ pl: { sm: 2.75 } }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375, minWidth: { md: 280 } }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 1 }}>
            <Link
              component={RouterLink}
              to={`/apis/${encodeURIComponent(api.team)}/${encodeURIComponent(api.name)}`}
              underline="hover"
              sx={{ fontWeight: 600, fontSize: 14, color: "text.primary" }}
            >
              {api.displayName || api.name}
            </Link>
            <Mono sx={{ fontSize: 12, color: "text.secondary" }}>
              {api.team}/{api.name}
            </Mono>
          </Box>
          {api.description && (
            <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.45 }}>
              {api.description}
            </Typography>
          )}
          {api.deprecated && (
            <Typography variant="caption" sx={{ color: "warning.main" }}>
              Deprecated: {api.deprecated}
            </Typography>
          )}
        </Box>
      </TableCell>
      <TableCell>
        <ApiStatePill state={api.state} />
        {note && (
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            title={note}
            sx={{ mt: 0.5, maxWidth: 180, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}
          >
            {note}
          </Typography>
        )}
      </TableCell>
      <TableCell align="right" sx={{ display: { xs: "none", sm: "table-cell" } }}>
        {api.endpoints.length}
      </TableCell>
      <TableCell sx={{ display: { xs: "none", sm: "table-cell" }, minWidth: 170 }}>
        <You api={api} mine={mine} />
      </TableCell>
      <TableCell sx={{ display: { xs: "none", md: "table-cell" }, pr: 2.75, whiteSpace: "nowrap" }}>
        <Pill tone={api.internet ? "info" : "neutral"}>{api.internet ? "Internet" : "In the cluster"}</Pill>
      </TableCell>
    </TableRow>
  );
}

/** One group of rows under its own heading row. */
function Group({ title, note, apis, mine }: { title: string; note: string; apis: ApiProduct[]; mine: boolean }) {
  if (apis.length === 0) return null;
  return (
    <TableBody>
      <TableRow>
        <TableCell component="th" scope="rowgroup" colSpan={5} sx={{ pt: 2.25, pb: 1, pl: { sm: 2.75 } }}>
          <Typography component="span" sx={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", color: "text.secondary" }}>
            {title}
          </Typography>
          <Typography component="span" sx={{ fontSize: 12, color: "text.secondary" }}>
            {" "}
            · {note}
          </Typography>
        </TableCell>
      </TableRow>
      {apis.map((a) => (
        <ApiRow key={`${a.team}/${a.name}`} api={a} mine={mine} />
      ))}
    </TableBody>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <Box component="li" sx={{ display: "flex", gap: 1.25 }}>
      <Box
        aria-hidden="true"
        sx={{ flex: "0 0 22px", height: 22, borderRadius: "50%", bgcolor: "info.light", color: "info.main", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        {n}
      </Box>
      <Typography variant="body2" component="span" sx={{ fontSize: 13, lineHeight: 1.5 }}>
        {children}
      </Typography>
    </Box>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375 }}>
      <Typography component="dt" variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
        {label}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, fontSize: 13, lineHeight: 1.5, overflowWrap: "anywhere" }}>
        {children}
      </Typography>
    </Box>
  );
}

/**
 * Every API product the signed-in user may see (ApiService.ListApis):
 * backends teams already run, published through the gateway, which
 * forwards only what each one's OpenAPI document describes. Grouped as
 * your teams' own, the ones you may call, and the ones not granted to you;
 * You may call lists your own access and requests (MyAccess).
 */
export function ApisPage() {
  const { user } = useAuth();
  const [apis, setApis] = useState<ApiProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  // Read again after a change under You may call (a grant given up is a row that moves).
  const [version, setVersion] = useState(0);
  const load = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);
  useEffect(() => {
    let cancelled = false;
    listApis()
      .then((list) => {
        if (!cancelled) {
          setApis(list);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Failed to load APIs."));
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const teams = useMemo(() => user?.teamNames ?? [], [user]);
  const isMine = (a: ApiProduct) => teams.includes(a.team);
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!apis || !q) return apis;
    return apis.filter((a) => [a.team, a.name, a.displayName, a.description].some((s) => s.toLowerCase().includes(q)));
  }, [apis, search]);
  const test = FILTERS.find(([id]) => id === filter)?.[2] ?? (() => true);
  const shown = searched?.filter((a) => test(a, isMine(a))) ?? null;
  const mine = shown?.filter(isMine) ?? [];
  const shared = shown?.filter((a) => !isMine(a) && a.mayCall) ?? [];
  const others = shown?.filter((a) => !isMine(a) && !a.mayCall) ?? [];
  const myTeamsWithApis = [...new Set((apis ?? []).filter(isMine).map((a) => a.team))];

  // The gateway's two addresses, from any API that carries them.
  const inCluster = apis?.map((a) => gatewayBase(a.url, a)).find(Boolean) ?? "";
  const internet = apis?.map((a) => gatewayBase(a.publicUrl, a)).find(Boolean) ?? "";
  const botTeam = user?.maintainerOf[0];

  return (
    <Box>
      <PageHeader
        title="APIs"
        help={{ guide: "11-apis", label: "APIs and the gateway" }}
        subtitle="Backends teams already run, published through this install's gateway. Each one's OpenAPI file is the whole of what reaches it: anything else is blocked at the gateway."
      />
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, alignItems: "center", mb: 2.5 }}>
        <TextField
          size="small"
          type="search"
          placeholder="Search by name, team or what it does"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          sx={{ flex: "0 1 340px", minWidth: 0, width: { xs: "100%", sm: "auto" }, "& .MuiInputBase-root": { minHeight: 44, bgcolor: "background.paper" } }}
          slotProps={{ htmlInput: { "aria-label": "Search APIs" } }}
        />
        <Box role="group" aria-label="Show" sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          {FILTERS.map(([id, label, matches]) => (
            <Chip
              key={id}
              clickable
              aria-pressed={filter === id}
              color={filter === id ? "primary" : "default"}
              variant={filter === id ? "filled" : "outlined"}
              onClick={() => {
                setFilter(id);
              }}
              label={
                <>
                  {label}{" "}
                  <Box component="span" sx={{ fontWeight: 400, opacity: 0.8 }}>
                    {searched ? searched.filter((a) => matches(a, isMine(a))).length : ""}
                  </Box>
                </>
              }
              sx={{ height: 36, fontWeight: filter === id ? 500 : 400 }}
            />
          ))}
        </Box>
      </Box>

      {filter === "call" && <MyAccess apis={apis} search={search} onChanged={load} />}
      {filter !== "call" && (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-start" }}>
          <Card component="section" aria-label="APIs you can see" sx={{ flex: "3 1 680px", minWidth: 0, overflowX: "auto" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ pl: { sm: 2.75 } }}>API</TableCell>
                  <TableCell>State</TableCell>
                  <TableCell align="right" sx={{ display: { xs: "none", sm: "table-cell" } }}>
                    Endpoints
                  </TableCell>
                  <TableCell sx={{ display: { xs: "none", sm: "table-cell" } }}>You</TableCell>
                  <TableCell sx={{ display: { xs: "none", md: "table-cell" }, pr: 2.75 }}>Reachable</TableCell>
                </TableRow>
              </TableHead>
              {shown === null && !error && (
                <TableBody>
                  {[0, 1, 2].map((i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={5}>
                        <Skeleton variant="text" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              )}
              {shown?.length === 0 && (
                <TableBody>
                  <TableRow>
                    <TableCell colSpan={5} sx={{ py: 4, textAlign: "center", color: "text.secondary" }}>
                      {apis?.length
                        ? "No API matches."
                        : "No APIs yet. A team publishes one with an api.yaml and its OpenAPI file in its catalog folder."}
                    </TableCell>
                  </TableRow>
                </TableBody>
              )}
              <Group
                title="Your teams’"
                note={`${myTeamsWithApis.join(", ")}: you see their traffic and backends`}
                apis={mine}
                mine
              />
              <Group title="You may call" note="granted to you, or to a group of yours" apis={shared} mine={false} />
              <Group
                title="Not granted to you"
                note="listed so you know they exist; ask for access from its page"
                apis={others}
                mine={false}
              />
            </Table>
          </Card>

          <Box component="aside" sx={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <Card component="section" aria-label="Calling an API" sx={{ p: 2.75, display: "flex", flexDirection: "column", gap: 1.5 }}>
              <Typography variant="h6" component="h2">
                Calling any of them
              </Typography>
              <Box component="dl" sx={{ m: 0, display: "flex", flexDirection: "column", gap: 1.25 }}>
                {internet && (
                  <Fact label="From the internet">
                    <Mono sx={{ fontSize: 12.5 }}>{internet}/&lt;team&gt;/&lt;api&gt;</Mono>
                  </Fact>
                )}
                {inCluster && (
                  <Fact label="In the cluster">
                    <Mono sx={{ fontSize: 12.5 }}>{inCluster}/&lt;team&gt;/&lt;api&gt;</Mono>
                  </Fact>
                )}
                <Fact label="Signed in as">
                  You, or one of your team’s bots: <Mono sx={{ fontSize: 12 }}>Authorization: Bearer $VENNIR_TOKEN</Mono>. It stops at the
                  gateway; the backend gets who called in <Mono sx={{ fontSize: 12 }}>Vennir-Caller</Mono>.
                </Fact>
                <Fact label="Who may call">
                  Access is per person or per bot, never per team: whoever an API’s team grants, by name or through a single sign-on group, and its own
                  team always. Each grant has its own rate, counted a minute at a time.
                </Fact>
              </Box>
              {botTeam && (
                <Button
                  component={RouterLink}
                  to={`/teams/${encodeURIComponent(botTeam)}?tab=automation`}
                  variant="outlined"
                  size="large"
                  sx={{ alignSelf: "flex-start" }}
                >
                  A bot for {botTeam}
                </Button>
              )}
            </Card>

            <Card component="section" aria-label="Publishing an API" sx={{ p: 2.75, display: "flex", flexDirection: "column", gap: 1.25 }}>
              <Typography variant="h6" component="h2">
                Publishing one of yours
              </Typography>
              <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 1.25 }}>
                <Step n={1}>
                  Add <Mono sx={{ fontSize: 12 }}>api.yaml</Mono> and its OpenAPI file under{" "}
                  <Mono sx={{ fontSize: 12 }}>teams/&lt;team&gt;/apis/</Mono> in your catalog repository.
                </Step>
                <Step n={2}>It’s reviewed like a product, and goes live with the next catalog release.</Step>
                <Step n={3}>Its backend’s host must be one the admins allow; until then it’s Held.</Step>
                <Step n={4}>The gateway must be able to use its OpenAPI document. When it can’t, the API shows Can’t serve, with why, and every call gets 503 until a release fixes the file.</Step>
              </Box>
              <HelpLink guide="11-apis" section="publishing-or-changing-an-api" label="Publishing an API" />
            </Card>
          </Box>
        </Box>
      )}
    </Box>
  );
}
