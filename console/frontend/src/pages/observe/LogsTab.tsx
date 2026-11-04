// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { LoadFailed, loadFailure } from "../../components/LoadFailed";
import { Mono } from "../../components/Mono";
import { useAuth } from "../../auth/AuthContext";
import { ApiError, errorMessage, listAllTeams, listApis, searchLogs, type LogLineView } from "../../api";
import { LEVEL, LogLines } from "./LogLines";

type Source = "step" | "api" | "platform";

const RANGES: [number, string][] = [
  [1, "Last hour"],
  [6, "Last 6 hours"],
  [24, "Last 24 hours"],
  [168, "Last 7 days"],
  [720, "Last 30 days"],
];

/** Who sees which lines: as the console's log search decides it (console/src/core/logs.ts). */
const WHO: [string, string][] = [
  ["A step’s lines, every level", "The step’s own team, and admins."],
  ["A step’s info lines", "Also the run’s owners: whoever submitted it, and the team it was run for."],
  ["API backends", "Every level, to the backend’s own team only, and admins."],
  ["The platform", "kernel-api, the scheduler, the console and the gateway: admins only."],
];

const field = { "& .MuiInputBase-root": { minHeight: 44 } };

/** What the search covered, in words: "from every step of run 4be9a1c0, last 7 days". */
function described(source: Source, team: string, run: string, hours: number, api = ""): string {
  const range = (RANGES.find(([h]) => h === hours)?.[1] ?? `last ${String(hours)} hours`).toLowerCase();
  const from =
    source === "platform"
      ? "from the platform"
      : source === "api"
        ? api
          ? `from ${team}/${api}’s backend`
          : `from ${team ? `${team}’s` : "every"} API backend${team ? "s" : ""}`
        : run
          ? "from every step of run"
          : `from ${team ? `${team}’s` : "every"} step${team ? "s" : ""}`;
  return `${from}${source === "step" && run ? "" : `, ${range}`}`;
}

export function LogsTab({
  initialRun,
  initialSource,
  initialTeam,
  initialHours,
  initialApi,
}: {
  initialRun: string;
  initialSource?: string;
  initialTeam?: string;
  initialHours?: number;
  /** With source api: one API product, by name (its team is initialTeam). */
  initialApi?: string;
}) {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [team, setTeam] = useState(initialTeam ?? "");
  const [run, setRun] = useState(initialRun);
  const [api, setApi] = useState(initialApi && initialTeam ? `${initialTeam}/${initialApi}` : "");
  // The API products whose backends the caller may search: their teams' (every one, for an admin).
  const [apis, setApis] = useState<{ team: string; name: string }[] | null>(null);
  const [apisFailed, setApisFailed] = useState<string | null>(null);
  const [apisTry, setApisTry] = useState(0);
  const [level, setLevel] = useState("");
  const [source, setSource] = useState<Source>(initialSource === "api" || initialSource === "platform" ? initialSource : "step");
  // A link's range when it's one offered (an API's 24-hour card), else a run's week or the last hour.
  const [hours, setHours] = useState(RANGES.some(([h]) => h === initialHours) ? (initialHours ?? 1) : initialRun ? 168 : 1);
  const [teams, setTeams] = useState<string[]>([]);
  const [teamsFailed, setTeamsFailed] = useState<string | null>(null);
  const [teamsTry, setTeamsTry] = useState(0);
  const [lines, setLines] = useState<LogLineView[] | null>(null);
  const [searched, setSearched] = useState({ source, team, run: initialRun, hours, api: initialApi ?? "" });
  const [truncated, setTruncated] = useState(false);
  const [searchDays, setSearchDays] = useState(30);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (!user.isAdmin) {
      setTeams(user.teamNames);
      return;
    }
    let current = true;
    setTeamsFailed(null);
    listAllTeams()
      .then((all) => {
        if (current) setTeams(all.map((t) => t.name).sort());
      })
      .catch((err: unknown) => {
        if (current) setTeamsFailed(loadFailure(err));
      });
    return () => { current = false; };
  }, [user, teamsTry]);

  useEffect(() => {
    if (!user || source !== "api") return;
    let current = true;
    setApisFailed(null);
    listApis()
      .then((found) => { if (current) setApis(found.filter((a) => user.isAdmin || user.teamNames.includes(a.team)).map((a) => ({ team: a.team, name: a.name }))); })
      .catch((err: unknown) => { if (current) setApisFailed(loadFailure(err)); });
    return () => { current = false; };
  }, [user, source, apisTry]);

  async function search(): Promise<void> {
    setSearching(true);
    setError(null);
    const runId = source === "step" ? run.trim() : "";
    const apiName = source === "api" && api ? (api.split("/")[1] ?? "") : "";
    try {
      const found = await searchLogs({
        text: text.trim(),
        team: source === "platform" ? "" : team,
        executionId: runId,
        level,
        source,
        api: apiName,
        hours,
      });
      setLines(found.lines);
      setSearched({ source, team: source === "platform" ? "" : team, run: runId, hours, api: apiName });
      setTruncated(found.truncated);
      setSearchDays(found.searchDays);
    } catch (err) {
      if (err instanceof ApiError && err.code === "LOGS_OFF") setOff(true);
      else setError(errorMessage(err, "Failed to search the logs."));
    } finally {
      setSearching(false);
    }
  }

  // The first search, as the page opens (a run's, when it came from one).
  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (off) {
    return (
      <Alert severity="info">
        This install doesn&apos;t keep logs, so there&apos;s nothing to search. Each run&apos;s page still shows its steps&apos; output. An admin can
        turn log search on (the console chart&apos;s <Mono>logs.enabled</Mono>).
      </Alert>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2.5 }}>
      <Card
        component="form"
        role="search"
        aria-label="Search the logs"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
        sx={{ px: 2.75, py: 2.5, display: "flex", flexDirection: "column", gap: 1.75 }}
      >
        <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 1.5 }}>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, maxWidth: 760 }}>
            <Typography variant="h6" component="h2">
              Search the logs
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
              {user?.isAdmin
                ? `Every step's output, every team's API backends', and the platform's own. Credentials are redacted before anything is kept. Searchable for ${String(searchDays)} days, then archived.`
                : `Every line from your teams' steps and API backends, and the INFO lines of other runs you can see. Credentials are redacted before anything is kept. Searchable for ${String(searchDays)} days, then archived.`}
            </Typography>
          </Box>
          <ToggleButtonGroup
            exclusive
            size="small"
            aria-label="From"
            value={source}
            onChange={(_e, value: Source | null) => {
              if (value) setSource(value);
            }}
            sx={{ bgcolor: "background.paper", flexWrap: "wrap", "& .MuiToggleButton-root": { minHeight: 40, px: 1.75, gap: 0.75 } }}
          >
            <ToggleButton value="step">Steps</ToggleButton>
            <ToggleButton value="api">API backends</ToggleButton>
            {user?.isAdmin && (
              <ToggleButton value="platform">
                The platform
                <Box component="span" sx={{ fontSize: 11, color: "text.secondary", fontWeight: 400 }}>
                  admins
                </Box>
              </ToggleButton>
            )}
          </ToggleButtonGroup>
        </Box>
        {teamsFailed && source !== "platform" && <LoadFailed what="the teams to choose from" reason={teamsFailed} onRetry={() => { setTeamsTry((n) => n + 1); }} />}
        {apisFailed && source === "api" && <LoadFailed what="the APIs to choose from" reason={apisFailed} onRetry={() => { setApisTry((n) => n + 1); }} />}
        <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap", alignItems: "center" }}>
          <TextField
            label="Text to find"
            placeholder="Any text"
            type="search"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            sx={{ ...field, flex: "2 1 240px", "& input": { fontFamily: "fontFamilyMono", fontSize: 13 } }}
            slotProps={{ htmlInput: { maxLength: 200 }, inputLabel: { shrink: true } }}
          />
          {source !== "platform" && (
            <FormControl sx={{ ...field, flex: "1 1 150px" }}>
              <InputLabel id="logs-team-label" shrink>
                Team
              </InputLabel>
              <Select
                labelId="logs-team-label"
                label="Team"
                notched
                displayEmpty
                value={team}
                onChange={(event) => {
                  setTeam(event.target.value);
                  if (api && !api.startsWith(`${event.target.value}/`)) setApi("");
                }}
              >
                <MenuItem value="">Any</MenuItem>
                {teams.map((name) => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          {source === "api" && (
            <FormControl sx={{ ...field, flex: "1 1 220px" }}>
              <InputLabel id="logs-api-label" shrink>
                API
              </InputLabel>
              <Select
                labelId="logs-api-label"
                label="API"
                aria-describedby="logs-api-help"
                notched
                displayEmpty
                value={api}
                onChange={(event) => {
                  setApi(event.target.value);
                  if (event.target.value) setTeam(event.target.value.split("/")[0] ?? "");
                }}
              >
                <MenuItem value="">{team ? `Any of ${team}’s APIs` : "Any API"}</MenuItem>
                {(apis ?? [])
                  .filter((a) => !team || a.team === team)
                  .map((a) => (
                    <MenuItem key={`${a.team}/${a.name}`} value={`${a.team}/${a.name}`}>
                      {a.team}/{a.name}
                    </MenuItem>
                  ))}
              </Select>
              <Typography id="logs-api-help" variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                One API: its backend&apos;s Pods labelled <Mono sx={{ fontSize: 11.5 }}>vennir/api: &lt;name&gt;</Mono>.
              </Typography>
            </FormControl>
          )}
          {source === "step" && (
            <TextField
              label="Run id"
              placeholder="Any run"
              value={run}
              onChange={(event) => {
                setRun(event.target.value);
              }}
              sx={{ ...field, flex: "1 1 240px" }}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          )}
          <FormControl sx={{ ...field, flex: "0 1 120px" }}>
            <InputLabel id="logs-level-label" shrink>
              Level
            </InputLabel>
            <Select
              labelId="logs-level-label"
              label="Level"
              notched
              displayEmpty
              value={level}
              onChange={(event) => {
                setLevel(event.target.value);
              }}
            >
              <MenuItem value="">Any</MenuItem>
              {Object.keys(LEVEL).map((name) => (
                <MenuItem key={name} value={name}>
                  {name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl sx={{ ...field, flex: "0 1 150px" }}>
            <InputLabel id="logs-range-label">When</InputLabel>
            <Select
              labelId="logs-range-label"
              label="When"
              value={hours}
              onChange={(event) => {
                setHours(Number(event.target.value));
              }}
            >
              {RANGES.filter(([h]) => h <= searchDays * 24).map(([h, label]) => (
                <MenuItem key={h} value={h}>
                  {label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Button type="submit" variant="contained" size="large" disabled={searching} sx={{ px: 2.75 }}>
            {searching ? "Searching…" : "Search"}
          </Button>
        </Box>
      </Card>

      {error && <Alert severity="error">{error}</Alert>}

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-start" }}>
        <Card component="section" aria-label="Log lines" sx={{ flex: "3 1 640px", minWidth: 0, overflow: "hidden" }}>
          <Box sx={{ px: 2.75, py: 1.75, display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 1, borderBottom: 1, borderColor: "divider" }}>
            <Typography variant="body2" sx={{ fontSize: 13 }}>
              {lines === null ? (
                "Searching…"
              ) : (
                <>
                  <b>
                    {lines.length.toLocaleString()} line{lines.length === 1 ? "" : "s"}
                  </b>{" "}
                  {described(searched.source, searched.team, searched.run, searched.hours, searched.api)}
                  {searched.run && (
                    <>
                      {" "}
                      <Link component={RouterLink} to={`/runs/${searched.run}`} sx={{ fontFamily: "fontFamilyMono", fontSize: 12.5 }}>
                        {searched.run.slice(0, 8)}
                      </Link>
                      , {(RANGES.find(([h]) => h === searched.hours)?.[1] ?? "").toLowerCase()}
                    </>
                  )}
                  {lines.length > 0 && " · newest first"}
                </>
              )}
            </Typography>
            {user?.isAdmin && (
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
                every level: you&apos;re an admin
              </Typography>
            )}
          </Box>
          {truncated && (
            <Alert severity="info" sx={{ m: 2 }}>
              Only the newest {lines?.length ?? 0} lines are shown. Narrow the search to see the rest.
            </Alert>
          )}
          {lines?.length === 0 && (
            <Typography color="text.secondary" sx={{ px: 2.75, py: 3 }}>
              Nothing found.
            </Typography>
          )}
          {lines && lines.length > 0 && <LogLines lines={lines} />}
        </Card>

        <Box component="aside" sx={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <Card component="section" aria-label="Who sees which lines" sx={{ px: 2.75, py: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
            <Typography variant="h6" component="h2">
              Who sees which lines
            </Typography>
            {WHO.map(([what, who]) => (
              <Box key={what} sx={{ display: "flex", flexDirection: "column", gap: 0.375, pt: 1.25, borderTop: 1, borderColor: "divider" }}>
                <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 500 }}>
                  {what}
                </Typography>
                <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.45 }}>
                  {who}
                </Typography>
              </Box>
            ))}
            <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.45 }}>
              Steps log JSON lines with a level; a plain line counts as debug, so nothing reaches other teams by accident. Write info for the
              people running your product.
            </Typography>
          </Card>
          <Card component="section" aria-label="Redacted, then kept" sx={{ px: 2.75, py: 2.5, display: "flex", flexDirection: "column", gap: 1 }}>
            <Typography variant="h6" component="h2">
              Redacted, then kept
            </Typography>
            <Typography variant="body2" sx={{ fontSize: 13, lineHeight: 1.5 }}>
              Credential shapes are replaced with <Mono sx={{ fontSize: 12 }}>••••••••</Mono> before a line is stored. Searchable here for{" "}
              {searchDays} days, then archived.
            </Typography>
            <Typography variant="body2" sx={{ fontSize: 13, lineHeight: 1.5 }}>
              A run&apos;s own page still shows its steps&apos; output, kept with the run.
            </Typography>
          </Card>
        </Box>
      </Box>
    </Box>
  );
}
