// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink, useParams, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import DownloadIcon from "@mui/icons-material/FileDownloadOutlined";
import { errorMessage, getApi, listApiAccess, listMyApiAccess, pauseApi, resumeApi, type ApiAccessRequest, type ApiProduct, type MyApiAccess } from "../api";
import { useAuth } from "../auth/AuthContext";
import { HelpLink } from "../components/HelpLink";
import { Mono } from "../components/Mono";
import { when } from "../time";
import { Pill } from "../components/Pill";
import { ApiBackend, ApiPause, RequestSteps } from "./api/ApiDefinition";
import { ApiLogs } from "./api/ApiLogs";
import { ApiEndpoints, Fact, sharedWith, size } from "./api/ApiOverview";
import { WhoMayCall, type ApiAccessList } from "./api/WhoMayCall";
import { StandingPill, standingFor, YourAccess } from "./api/YourAccess";
import { ApiStatePill } from "./api/ApiStatePill";
import { BlockedRequests, CallingTeams, PeriodToggle, TrafficTiles, useApiTraffic } from "./api/ApiTraffic";

/** The page's parts, for its own team: what "On this page" links to. Old ?tab= links land on theirs. */
const SECTIONS: [string, string][] = [
  ["endpoints", "Endpoints and traffic"],
  ["access", "Who may call"],
  ["backend", "Backend and pausing"],
  ["logs", "Backend logs"],
];
const OLD_TABS: Record<string, string> = { traffic: "endpoints", definition: "backend", access: "access" };

/**
 * One API product (ApiService.GetApi), on one page. Anyone who may see it
 * gets where to call it, its endpoints and how to call each. Its own team
 * and admins, the only ones the console shows its backend to, also get each
 * endpoint's traffic, who calls it, what the gateway blocked, its backend as
 * the catalog says, pausing it (maintainers), and its backend's logs.
 *
 * Who may call it (decision 26): anyone else sees their own access to it
 * (YourAccess: request, withdraw, give up); its own team and admins see its
 * requests and access list (WhoMayCall).
 */
export function ApiPage() {
  const { team = "", name = "" } = useParams();
  // Another API is another page: nothing of the last one's state, or its late answers, carries over.
  return <ApiView key={`${team}/${name}`} team={team} name={name} />;
}

function ApiView({ team, name }: { team: string; name: string }) {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [api, setApi] = useState<ApiProduct | null>(null);
  const [openapi, setOpenapi] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState(24);
  const [mine, setMine] = useState<{ access: MyApiAccess[]; requests: ApiAccessRequest[] } | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const [accessList, setAccessList] = useState<ApiAccessList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // Bumped to read again: the API after a change, its access after an access change.
  const [apiVersion, setApiVersion] = useState(0);
  const [accessVersion, setAccessVersion] = useState(0);
  const load = () => {
    setApiVersion((v) => v + 1);
  };

  useEffect(() => {
    let cancelled = false;
    getApi(team, name)
      .then((result) => {
        if (cancelled) return;
        setApi(result.api);
        setOpenapi(result.openapi);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, "Couldn't load the API."));
      });
    return () => {
      cancelled = true;
    };
  }, [team, name, apiVersion]);

  const ownTeam = Boolean(api?.backendUrl);
  const maintains = !!user && (user.isAdmin || user.maintainerOf.includes(team));
  const inTeam = user?.teamNames.includes(team) ?? false;
  const grants = !!user && user.maintainerOf.includes(team);

  // Your own access, when it isn't your team's; its access list, for its team and admins: each its own error.
  const loaded = api !== null;
  useEffect(() => {
    if (!loaded || inTeam) return;
    let cancelled = false;
    listMyApiAccess()
      .then((m) => {
        if (cancelled) return;
        setMine(m);
        setMineError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setMineError(errorMessage(err, "Couldn't load your access."));
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, inTeam, accessVersion]);
  useEffect(() => {
    if (!loaded || !ownTeam) return;
    let cancelled = false;
    listApiAccess(team, name)
      .then((list) => {
        if (cancelled) return;
        setAccessList(list);
        setListError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setListError(errorMessage(err, "Couldn't load who may call it."));
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, ownTeam, team, name, accessVersion]);
  const accessChanged = () => {
    load();
    setAccessVersion((v) => v + 1);
  };
  const standing = standingFor(team, name, mine);
  const waiting = accessList?.requests.filter((r) => r.state === "waiting").length ?? 0;
  const { traffic, error: trafficError } = useApiTraffic(team, name, hours, ownTeam);

  // A link to an old tab scrolls to its part, once the page is there.
  const jump = OLD_TABS[params.get("tab") ?? ""];
  useEffect(() => {
    if (ownTeam && jump) document.getElementById(jump)?.scrollIntoView?.();
  }, [ownTeam, jump]);

  /** Whether it worked (its error is shown when it didn't). */
  async function change(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
      return true;
    } catch (err) {
      setError(errorMessage(err, "That didn't work."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function download(): void {
    if (!api) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(JSON.parse(openapi), null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${api.team}-${api.name}-openapi.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const owner = !inTeam ? "Viewing as admin" : user?.maintainerOf.includes(team) ? "You maintain it" : "Your team's";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
      <Typography variant="body2" color="text.secondary">
        <Link component={RouterLink} to="/apis">
          APIs
        </Link>{" "}
        / {team} / {api?.displayName ?? name}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {!api && !error && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress size={28} aria-label="Loading the API" />
        </Box>
      )}
      {api && (
        <>
          <Box component="header" sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 2 }}>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1, maxWidth: 820, minWidth: 0 }}>
              <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.25 }}>
                <Typography variant="h4" component="h1" sx={{ fontSize: { xs: 24, sm: 28 }, overflowWrap: "anywhere" }}>
                  {api.displayName}
                </Typography>
                <ApiStatePill state={api.state} />
                <Pill tone={api.internet ? "info" : "neutral"}>{api.internet ? "Internet" : "In the cluster"}</Pill>
                {ownTeam && <Pill tone="neutral">{owner}</Pill>}
                {!inTeam && mine && <StandingPill standing={standing} />}
              </Box>
              {api.description && (
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 14, lineHeight: 1.5 }}>
                  {api.description}
                </Typography>
              )}
              <Box>
                <HelpLink guide="11-apis" section="how-do-i-call-an-api-through-the-gateway" label="Calling an API through the gateway" />
              </Box>
            </Box>
            <Button variant="outlined" size="large" startIcon={<DownloadIcon />} onClick={download} disabled={!openapi}>
              Download its OpenAPI file
            </Button>
          </Box>

          {(api.state !== "LIVE" || api.deprecated) && (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
              {api.state === "PAUSED" && (
                <Alert severity="warning">Paused by its team: every signed-in caller gets 503 with “{api.pausedMessage}” (anyone else, 404), and nothing reaches the backend.</Alert>
              )}
              {api.state === "HELD" && <Alert severity="warning">Held: {api.heldReason}</Alert>}
              {api.state === "UNAVAILABLE" && (
                <Alert severity="error">
                  <strong>The gateway can’t use its OpenAPI document, so every call gets 503 and nothing reaches the backend.</strong>
                  <Box sx={{ mt: 0.5 }}>
                    Why, as the gateway found it{api.problemFoundAt ? ` ${when(api.problemFoundAt)}` : ""}:{" "}
                    <Mono sx={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{api.problem}</Mono>
                  </Box>
                  <Box sx={{ mt: 0.5 }}>
                    {api.sourcePath ? (
                      <>
                        Fix the OpenAPI file beside <Mono sx={{ fontSize: 12.5 }}>{api.sourcePath}</Mono> in the catalog
                      </>
                    ) : (
                      "Fix its OpenAPI file in the catalog"
                    )}
                    ; it serves again with the next release. Run <Mono sx={{ fontSize: 12.5 }}>vennir catalog validate</Mono> on the fix first.
                  </Box>
                </Alert>
              )}
              {api.deprecated && <Alert severity="info">Deprecated: {api.deprecated}</Alert>}
            </Box>
          )}

          <Card
            component="section"
            aria-label="Where and how much"
            sx={{ px: 2.75, py: 2, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", columnGap: 3.5, rowGap: 1.75 }}
          >
            <Fact
              label="Call it at"
              note={api.publicUrl && api.url ? <Mono sx={{ fontSize: 12 }}>in the cluster: {api.url}</Mono> : undefined}
            >
              <Mono sx={{ fontSize: 12.5 }}>{api.publicUrl || api.url || `<the gateway>/${api.team}/${api.name}`}</Mono>
            </Fact>
            <Fact label="Spec">{`${api.specTitle} ${api.specVersion} · ${String(api.endpoints.length)} endpoint${api.endpoints.length === 1 ? "" : "s"}`}</Fact>
            <Fact label="Who may call" note={<>Requests: <Mono sx={{ fontSize: 12 }}>access: {`{ requests: ${api.accessRequests} }`}</Mono></>}>
              Whoever {api.team} grants a group, or a person or bot by name; {api.team}’s own members and bots always.
            </Fact>
            <Fact label="A grant’s rate" note={`${api.team} may set each grant’s own`}>
              {api.defaultPerMinute.toLocaleString()} a minute by default
            </Fact>
            {api.mayCall && (
              <Fact label={inTeam ? "Your team’s limit" : "Your rate"}>
                {`${String(api.perMinute)} a minute · ${size(api.maxRequestBytes)} a request · ${String(api.timeoutSeconds)} s`}
              </Fact>
            )}
            {api.shareWith.length > 0 && (
              <Box sx={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 0.75, borderTop: 1, borderColor: "divider", pt: 1.5 }}>
                <Typography variant="body2" color="text.secondary">
                  From the catalog: its api.yaml’s shareWith names {sharedWith(api)}, whose members and bots may call it at these limits. Going away: {api.team} grants
                  them instead.
                </Typography>
                <Box component="ul" sx={{ display: "flex", flexWrap: "wrap", gap: 1, m: 0, p: 0, listStyle: "none" }}>
                  {api.limits.map((l) => (
                    <Box component="li" key={l.team} sx={{ px: 1.25, py: 0.5, borderRadius: 999, bgcolor: "background.default", fontSize: 12.5 }}>
                      {l.team} · {l.perMinute.toLocaleString()} a minute
                    </Box>
                  ))}
                  <Box component="li" sx={{ px: 1.25, py: 0.5, borderRadius: 999, bgcolor: "background.default", fontSize: 12.5 }}>
                    {api.limits.length > 0 ? "Every other team" : "Every team"} · {api.defaultPerMinute.toLocaleString()} a minute
                  </Box>
                </Box>
              </Box>
            )}
          </Card>

          {!inTeam && mine && <YourAccess api={api} standing={standing} onChanged={accessChanged} />}
          {!inTeam && mineError && <Alert severity="error">{mineError}</Alert>}

          {ownTeam && (
            <Box component="nav" aria-label="On this page" sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.5, borderBottom: 1, borderColor: "divider" }}>
              {SECTIONS.map(([id, label]) => (
                <Link
                  key={id}
                  href={`#${id}`}
                  underline="none"
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth" });
                  }}
                  sx={{ display: "inline-flex", alignItems: "center", minHeight: 44, px: 1.75, fontSize: 14, color: "text.secondary", borderBottom: 2, borderColor: "transparent", "&:hover": { color: "text.primary", borderColor: "divider" } }}
                >
                  {label}
                  {id === "access" && waiting > 0 ? ` · ${String(waiting)} waiting` : ""}
                </Link>
              ))}
              <Typography variant="caption" color="text.secondary" sx={{ ml: { sm: "auto" }, py: 1 }}>
                Traffic, who may call, backend and logs: {api.team}’s members and admins only. Callers see the endpoints.
              </Typography>
            </Box>
          )}

          {ownTeam && (
            <>
              <Box id="endpoints" sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 1.5, scrollMarginTop: 16 }}>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13, maxWidth: 720 }}>
                  What callers sent, what the gateway stopped, and what the backend answered. Bodies are never recorded; callers only by team.
                </Typography>
                <PeriodToggle hours={hours} onChange={setHours} />
              </Box>
              {trafficError && <Alert severity="error">{trafficError}</Alert>}
              <TrafficTiles traffic={traffic} />
            </>
          )}

          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-start" }}>
            <ApiEndpoints key={`${team}/${name}`} api={api} traffic={ownTeam ? traffic : undefined} />
            {ownTeam && (
              <Box component="aside" sx={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <CallingTeams traffic={traffic} />
                <BlockedRequests traffic={traffic} />
              </Box>
            )}
          </Box>

          {ownTeam && (
            <WhoMayCall api={api} list={accessList} error={listError} maintains={grants} isAdmin={user?.isAdmin ?? false} onChanged={accessChanged} />
          )}

          {ownTeam && (
            <Box id="backend" sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "stretch", scrollMarginTop: 16 }}>
              <ApiBackend api={api} />
              {maintains && (
                <ApiPause
                  api={api}
                  busy={busy}
                  onPause={(message) => change(() => pauseApi(team, name, message))}
                  onResume={() => change(() => resumeApi(team, name))}
                />
              )}
            </Box>
          )}

          <RequestSteps />

          {ownTeam && <ApiLogs team={team} api={name} />}
        </>
      )}
    </Box>
  );
}
