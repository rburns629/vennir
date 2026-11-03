// SPDX-License-Identifier: MIT
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { alpha, useTheme } from "@mui/material/styles";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import { errorMessage, listDeleteRequests, listResources, type DeleteRequest, type MadeResource } from "../api";
import { useAuth } from "../auth/AuthContext";
import { HelpLink } from "../components/HelpLink";
import { QuickTile, QuickTiles } from "../components/QuickTile";
import { ResourceTable, listNames, selectable, useResourceDelete } from "../components/ResourceTable";
import { DeleteRequests } from "./DeleteRequests";

type State = MadeResource["state"];

/** "a", "a and b", "a, b and c". */
const listed = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);

/**
 * What runs made (/runs/made): every resource a run's step reported, for
 * your teams or you, kept after the runs themselves are gone; counted by
 * state, searchable, and deletable where its product says how (decision
 * 21), one at a time or several of one team's at once. Deletes others
 * depended on wait above for an admin (decision 25).
 */
/** The most the server lists at once (console/src/core/resources.ts, LIST_LIMIT). */
const LIST_LIMIT = 200;
/** The most one cleanup run deletes (the same file's DELETE_LIMIT). */
const DELETE_LIMIT = 50;

export function ResourcesPage() {
  const { user } = useAuth();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [stateFilter, setStateFilter] = useState<State | "">("");
  const [madeFor, setMadeFor] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [found, setFound] = useState<MadeResource[] | null>(null);
  const [requests, setRequests] = useState<DeleteRequest[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const search = useDeferredValue(query.trim());

  // Deleted ones only when asked for (Show deleted, or their tile): the
  // server sends the newest LIST_LIMIT, and deleted ones would crowd out
  // what still exists.
  useEffect(() => {
    let current = true;
    listResources({ query: search, includeDeleted })
      .then((rows) => { if (current) { setFound(rows); setError(null); } })
      .catch((err: unknown) => { if (current) setError(errorMessage(err, "Couldn't load what runs made.")); });
    return () => {
      current = false;
    };
  }, [search, includeDeleted]);

  const loadRequests = useCallback(() => {
    listDeleteRequests()
      .then(setRequests)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the deletes waiting for an admin.")); });
  }, []);
  useEffect(loadRequests, [loadRequests]);
  // A delete sent to an admin shows under Waiting for an admin at once.
  const bulk = useResourceDelete(loadRequests);

  const waiting = useMemo(() => new Set((requests ?? []).filter((r) => r.decision === null).flatMap((r) => r.resources.map((res) => res.id))), [requests]);
  const count = (state: State) => found?.filter((r) => r.state === state).length ?? 0;
  const owners = Array.from(new Set((found ?? []).flatMap((r) => (r.ownerTeam ? [r.ownerTeam] : [])))).sort();
  const types = Array.from(new Set((found ?? []).map((r) => r.type))).sort();
  const anyMine = (found ?? []).some((r) => !r.ownerTeam && r.ownerEmail === user?.email);

  const rows = useMemo(() => {
    if (!found) return null;
    return found.filter(
      (r) =>
        (includeDeleted || r.state !== "deleted") &&
        (!stateFilter || r.state === stateFilter) &&
        (!typeFilter || r.type === typeFilter) &&
        (!madeFor || (madeFor === "me" ? !r.ownerTeam && r.ownerEmail === user?.email : r.ownerTeam === madeFor)),
    );
  }, [found, includeDeleted, stateFilter, typeFilter, madeFor, user?.email]);

  // What's picked and still there to delete.
  const picked = (rows ?? []).filter((r) => selected.has(r.id) && selectable(r, waiting));
  const mixed = new Set(picked.map((r) => r.ownerTeam ?? "")).size > 1;
  const tooMany = picked.length > DELETE_LIMIT;

  const tile = (state: State) => ({
    pressed: stateFilter === state,
    onClick: () => {
      const next = stateFilter === state ? "" : state;
      setStateFilter(next);
      if (next === "deleted") setIncludeDeleted(true);
    },
  });
  const madeNote = listed([...owners, ...(anyMine ? ["you"] : [])]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
        <Typography variant="body2" color="text.secondary">
          <Link component={RouterLink} to="/runs">
            Runs
          </Link>{" "}
          / What runs made
        </Typography>
        <Typography variant="h4" component="h1" sx={{ fontSize: { xs: 24, sm: 28 }, mt: 0.75 }}>
          What runs made
        </Typography>
        <Typography sx={{ fontSize: 14, maxWidth: 760, lineHeight: 1.5 }}>
          What your teams&apos; runs, and yours, made or changed, as each product reported it. It&apos;s kept after the runs are gone,
          so it can be deleted at any time: deleting runs the product&apos;s own cleanup. Something other resources still use is
          deleted only once an admin approves it.
        </Typography>
        <Box>
          <HelpLink guide="10-ordering-and-the-cart" section="where-do-i-find-what-a-run-made-and-how-do-i-delete-it" label="Deleting what a run made" />
        </Box>
      </Box>

      <DeleteRequests requests={requests} onDecided={loadRequests} />

      <QuickTiles label="Summary">
        <QuickTile label="Made" value={found ? count("exists") : "…"} note={madeNote ? `for ${madeNote}` : undefined} dot={theme.palette.success.main} {...tile("exists")} />
        <QuickTile label="Deleting" value={found ? count("deleting") : "…"} note="its cleanup run is going" dot={theme.palette.primary.main} {...tile("deleting")} />
        <QuickTile
          label="Delete failed"
          value={found ? count("delete_failed") : "…"}
          note="its cleanup run finished without deleting it"
          dot={theme.palette.error.main}
          {...tile("delete_failed")}
        />
        <QuickTile
          label="Deleted"
          value={!includeDeleted ? "—" : found ? count("deleted") : "…"}
          note={includeDeleted ? "shown with Show deleted" : "press to show them"}
          dot={theme.palette.grey[500]}
          {...tile("deleted")}
        />
      </QuickTiles>

      <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap", alignItems: "center" }}>
        <TextField
          size="small"
          placeholder="Search by name, type or id"
          slotProps={{ htmlInput: { "aria-label": "Search what runs made" } }}
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
          sx={{ flex: "1 1 280px", minWidth: 0, maxWidth: 420, bgcolor: "background.paper" }}
        />
        <FormControl size="small" sx={{ minWidth: 180, bgcolor: "background.paper" }}>
          <InputLabel id="made-for-label">Made for</InputLabel>
          <Select labelId="made-for-label" label="Made for" value={madeFor} onChange={(e) => { setMadeFor(e.target.value); }}>
            <MenuItem value="">Anyone I can see</MenuItem>
            {owners.map((team) => (
              <MenuItem key={team} value={team}>
                {team}
              </MenuItem>
            ))}
            <MenuItem value="me">Just me</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 160, bgcolor: "background.paper" }}>
          <InputLabel id="type-label">Type</InputLabel>
          <Select labelId="type-label" label="Type" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); }}>
            <MenuItem value="">Any type</MenuItem>
            {types.map((type) => (
              <MenuItem key={type} value={type} sx={{ fontFamily: "fontFamilyMono", fontSize: 13 }}>
                {type}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControlLabel
          sx={{ ml: { md: "auto" }, minHeight: 44 }}
          control={
            <Switch
              checked={includeDeleted}
              onChange={(e) => {
                setIncludeDeleted(e.target.checked);
                if (!e.target.checked && stateFilter === "deleted") setStateFilter("");
              }}
            />
          }
          label="Show deleted"
        />
      </Box>
      {error && <Alert severity="error">{error}</Alert>}

      <Card component="section" aria-label="What runs made">
        {picked.length > 0 && (
          <Box
            role="status"
            sx={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "10px 16px",
              px: 2,
              py: 1.5,
              fontSize: 13,
              bgcolor: alpha(theme.palette.primary.main, 0.05),
              borderBottom: 1,
              borderColor: alpha(theme.palette.primary.main, 0.25),
            }}
          >
            <Typography component="span" sx={{ fontSize: 13, fontWeight: 600, color: "primary.dark" }}>
              {picked.length} selected
            </Typography>
            <Typography component="span" sx={{ fontSize: 13, overflowWrap: "anywhere", minWidth: 0 }}>
              {mixed
                ? "These were made for different teams: delete each team's separately."
                : tooMany
                  ? `At most ${String(DELETE_LIMIT)} at once: unselect ${String(picked.length - DELETE_LIMIT)}.`
                  : `${listNames(picked)}: each one's cleanup runs, in one run, newest first.`}
            </Typography>
            <Box sx={{ ml: "auto", display: "flex", gap: 1 }}>
              <Button onClick={() => { setSelected(new Set()); }}>Clear</Button>
              <Button variant="outlined" color="error" startIcon={<DeleteIcon />} disabled={mixed || tooMany} onClick={() => { bulk.ask(picked); }}>
                Delete {picked.length}…
              </Button>
            </Box>
          </Box>
        )}
        {bulk.ui}
        {found && found.length >= LIST_LIMIT && (
          <Typography variant="body2" color="text.secondary" sx={{ px: { xs: 2, sm: 2.75 }, pt: 1.5 }}>
            Showing the newest {LIST_LIMIT}: search or narrow it to find older ones.
          </Typography>
        )}
        <ResourceTable
          resources={rows}
          showRun
          waiting={waiting}
          userEmail={user?.email}
          onAsked={loadRequests}
          selection={{ selected, onChange: setSelected }}
          emptyMessage={
            found && found.length > 0
              ? "Nothing matches these filters."
              : search
                ? "Nothing matches."
                : "Nothing yet: a product lists what a step made as resources in its outputs."
          }
        />
      </Card>
    </Box>
  );
}
