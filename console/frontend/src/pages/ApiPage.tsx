// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useParams, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import DownloadIcon from "@mui/icons-material/FileDownloadOutlined";
import { ApiError, getApi, pauseApi, resumeApi, type ApiProduct } from "../api";
import { useAuth } from "../auth/AuthContext";
import { HelpLink } from "../components/HelpLink";
import { Mono } from "../components/Mono";
import { when } from "../time";
import { Pill } from "../components/Pill";
import { ApiBackend, ApiPause, RequestSteps } from "./api/ApiDefinition";
import { ApiLogs } from "./api/ApiLogs";
import { ApiEndpoints, Fact, sharedWith, size } from "./api/ApiOverview";
import { ApiStatePill } from "./api/ApiStatePill";
import { BlockedRequests, CallingTeams, PeriodToggle, TrafficTiles, useApiTraffic } from "./api/ApiTraffic";

/** The page's parts, for its own team: what "On this page" links to. Old ?tab= links land on theirs. */
const SECTIONS: [string, string][] = [
  ["endpoints", "Endpoints and traffic"],
  ["backend", "Backend and pausing"],
  ["logs", "Backend logs"],
];
const OLD_TABS: Record<string, string> = { traffic: "endpoints", definition: "backend" };

/**
 * One API product (ApiService.GetApi), on one page. Anyone who may see it
 * gets where to call it, its endpoints and how to call each. Its own team
 * and admins, the only ones the console shows its backend to, also get each
 * endpoint's traffic, who calls it, what the gateway blocked, its backend as
 * the catalog says, pausing it (maintainers), and its backend's logs.
 */
export function ApiPage() {
  const { team = "", name = "" } = useParams();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [api, setApi] = useState<ApiProduct | null>(null);
  const [openapi, setOpenapi] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState(24);

  const load = useCallback(() => {
    getApi(team, name)
      .then((result) => {
        setApi(result.api);
        setOpenapi(result.openapi);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Couldn't load the API.");
      });
  }, [team, name]);

  useEffect(load, [load]);

  const ownTeam = Boolean(api?.backendUrl);
  const maintains = !!user && (user.isAdmin || user.maintainerOf.includes(team));
  const inTeam = user?.teamNames.includes(team) ?? false;
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
      setError(err instanceof ApiError ? err.message : "That didn't work.");
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
  const sharedNote = api && !api.shareWith.includes("*") && api.shareWith.length > 0 ? `and ${api.team}, its own team` : undefined;

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

          {(api.state !== "LIVE" || api.deprecated || !api.mayCall) && (
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
                    ; it serves again with the next release. Run <Mono sx={{ fontSize: 12.5 }}>vertra catalog validate</Mono> on the fix first.
                  </Box>
                </Alert>
              )}
              {api.deprecated && <Alert severity="info">Deprecated: {api.deprecated}</Alert>}
              {!api.mayCall && (
                <Alert
                  severity="info"
                  action={
                    api.askForAccessUrl && (
                      <Button color="inherit" size="small" href={api.askForAccessUrl} target="_blank" rel="noopener noreferrer">
                        Ask for access ↗
                      </Button>
                    )
                  }
                >
                  {(user?.teamNames.length ?? 0) === 0
                    ? "You're in no team, and calls are made as one of your teams: the gateway refuses yours (403). An admin can add you to one."
                    : "It isn't shared with your teams: the gateway refuses your calls (403). Its team decides who may call it, in its api.yaml."}
                </Alert>
              )}
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
            <Fact label="Your team's limit">
              {api.mayCall
                ? `${String(api.perMinute)} a minute · ${size(api.maxRequestBytes)} a request · ${String(api.timeoutSeconds)} s`
                : "None: it isn't shared with your teams"}
            </Fact>
            <Fact label="Shared with" note={sharedNote}>
              {sharedWith(api)}
            </Fact>
            <Box sx={{ gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 0.75, borderTop: 1, borderColor: "divider", pt: 1.5 }}>
              <Typography variant="body2" color="text.secondary">
                Each calling team&apos;s limit, as the gateway counts it
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
              <Typography variant="caption" color="text.secondary">
                {api.limits.length > 0 ? "Named in its api.yaml; the rest get " : "Its api.yaml names no team, so each gets "}
                {api.defaultFromGateway ? "the gateway's own default on this install." : "its api.yaml's default."} Only teams it&apos;s shared with may call it at all.
              </Typography>
            </Box>
          </Card>

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
                </Link>
              ))}
              <Typography variant="caption" color="text.secondary" sx={{ ml: { sm: "auto" }, py: 1 }}>
                Traffic, backend and logs: {api.team}’s members and admins only. Callers see the endpoints.
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
