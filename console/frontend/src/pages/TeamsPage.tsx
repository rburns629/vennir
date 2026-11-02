// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { Mono } from "../components/Mono";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { TeamCard } from "../components/TeamCard";
import {
  ApiError,
  createTeam,
  getCatalogStatus,
  getUsage,
  listAllTeams,
  listApis,
  listPendingApprovals,
  listRunnables,
  listSsoGroupMappings,
  listTeamSummaries,
  type ApiProduct,
  type PendingApproval,
  type Runnable,
  type SsoGroupMapping,
  type Team,
  type TeamSummary,
  type UsageView,
} from "../api";
import { useAuth } from "../auth/AuthContext";
import { useEnvironment } from "../environment";
import { CardTitle, SectionLabel, visuallyHidden } from "./team/shared";

const teamHref = (name: string, tab?: string) => `/teams/${encodeURIComponent(name)}${tab ? `?tab=${tab}` : ""}`;

/** What the three roles may do: the same words as the guide. */
const ROLES: [string, "neutral" | "info" | "warning", string][] = [
  ["Member", "neutral", "Sees the team's runs, logs and secrets' names, and runs its actions."],
  ["Maintainer", "info", "Also manages its people and roles, secrets, bots, schedules and raw DAGs, and approves its steps."],
  ["Vertra admin", "warning", "Reaches every team; only admins create, retire and purge teams and set their limits."],
];

/** Every team's owner, description, people and what's running, in one
 * call, again when the teams change. Display only: if it fails, each shows a dash. */
function useTeamSummaries(teams: Team[]) {
  const [summaries, setSummaries] = useState<Record<string, TeamSummary>>({});
  const names = teams.map((t) => t.name).join(",");
  useEffect(() => {
    if (!names) return;
    let cancelled = false;
    listTeamSummaries().then(
      (list) => {
        if (!cancelled) setSummaries(Object.fromEntries(list.map((t) => [t.name, t])));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [names]);
  return summaries;
}

export function TeamsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const sso = useEnvironment()?.ssoLabel ?? "";
  const install = useEnvironment()?.label ?? "";
  const isAdmin = user?.isAdmin ?? false;
  const [newTeamName, setNewTeamName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const createInput = useRef<HTMLInputElement>(null);
  const [offers, setOffers] = useState<Runnable[]>([]);
  const [apis, setApis] = useState<ApiProduct[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  // An admin also sees every other team, which the catalog may adopt, and the groups that put people in teams.
  const [allTeams, setAllTeams] = useState<Team[] | null>(null);
  const [adoptable, setAdoptable] = useState<string[]>([]);
  const [mappings, setMappings] = useState<SsoGroupMapping[]>([]);
  const [find, setFind] = useState("");
  const [usage, setUsage] = useState<UsageView | null>(null);

  useEffect(() => {
    // Display only: each just leaves its part of the cards out when it fails.
    listRunnables().then(setOffers).catch(() => undefined);
    listApis().then(setApis).catch(() => undefined);
    listPendingApprovals().then(setApprovals).catch(() => undefined);
    getUsage(7).then(setUsage).catch(() => undefined);
  }, []);
  // A team that started nothing this week is null; undefined while it loads (or if it couldn't).
  const usageOf = (team: string) => (usage ? (usage.teams.find((t) => t.team === team) ?? null) : undefined);
  useEffect(() => {
    if (!isAdmin) return;
    listAllTeams().then(setAllTeams).catch(() => undefined);
    getCatalogStatus()
      .then((status) => { setAdoptable(status.problems.map((p) => p.adoptableTeam).filter(Boolean)); })
      .catch(() => undefined);
    listSsoGroupMappings().then(setMappings).catch(() => undefined);
  }, [isAdmin]);

  const others = (allTeams ?? []).filter((team) => !user?.teamNames.includes(team.name));
  const facts = useTeamSummaries(allTeams ?? []);

  async function handleCreateTeam(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const team = await createTeam(newTeamName.trim());
      // Creating a team doesn't make you a member of it (admins reach every
      // team anyway), so go straight to it to add its first members.
      void navigate(teamHref(team.name));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!user) return null;

  const columns: DataTableColumn<Team>[] = [
    {
      key: "team",
      header: "Team",
      render: (t) => {
        const description = facts[t.name]?.description;
        return (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
            <Link component={RouterLink} to={teamHref(t.name)} sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
              {t.name}
            </Link>
            {description && (
              <Typography
                component="span"
                title={description}
                sx={{ fontSize: 13, color: "text.secondary", overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
              >
                {description}
              </Typography>
            )}
          </Box>
        );
      },
    },
    {
      key: "state",
      header: "State",
      render: (t) =>
        t.retiredAt ? (
          <Pill tone="neutral">
            Retired {new Date(t.retiredAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </Pill>
        ) : t.fromCatalog ? (
          <Pill tone="success" dot="currentColor">
            Active
          </Pill>
        ) : (
          <Pill tone="warning">Not in the catalog</Pill>
        ),
    },
    { key: "made", header: "Made by", hideBelow: "md", render: (t) => (t.fromCatalog ? "the catalog" : "made here") },
    { key: "owner", header: "Owner in the catalog", hideBelow: "md", render: (t) => <Mono>{facts[t.name]?.owner ?? "—"}</Mono> },
    { key: "people", header: "People", hideBelow: "sm", render: (t) => facts[t.name]?.people ?? "–" },
    { key: "running", header: "Running now", hideBelow: "sm", render: (t) => facts[t.name]?.running ?? "–" },
    {
      key: "runs",
      header: "Runs, 7 days",
      hideBelow: "sm",
      render: (t) => {
        const u = usageOf(t.name);
        return u === undefined ? "–" : (u?.runs ?? 0).toLocaleString();
      },
    },
    {
      key: "uses",
      header: "Uses most",
      hideBelow: "md",
      render: (t) => {
        const top = usageOf(t.name)?.used[0];
        const text = top && `${top.name} ×${top.count.toLocaleString()}`;
        return text ? (
          <Box title={text} sx={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <Mono>{text}</Mono>
          </Box>
        ) : (
          "—"
        );
      },
    },
    {
      key: "actions",
      header: <Box component="span" sx={visuallyHidden}>Actions</Box>,
      align: "right",
      render: (t) =>
        t.retiredAt ? (
          <Link component={RouterLink} to={teamHref(t.name, "settings")}>
            Restore or purge
          </Link>
        ) : adoptable.includes(t.name) ? (
          <Link component={RouterLink} to="/admin/catalog">
            Adopt…
          </Link>
        ) : null,
    },
  ];
  const shown = others.filter((t) => t.name.includes(find.trim().toLowerCase()));

  return (
    <Box>
      <PageHeader
        title="Teams"
        help={{ guide: "13-teams-and-roles", label: "Teams and roles" }}
        subtitle={`The teams you're in: their people, secrets, bots, APIs and what's running.${isAdmin ? " As an admin you also see every other team." : ""}`}
        action={
          isAdmin && (
            <Button
              variant="contained"
              size="large"
              startIcon={<AddIcon />}
              onClick={() => {
                document.getElementById("create")?.scrollIntoView({ block: "center" });
                createInput.current?.focus();
              }}
            >
              Create team
            </Button>
          )
        }
      />

      <Box component="section" aria-labelledby="mine" sx={{ mb: 3 }}>
        <SectionLabel id="mine">Your teams · {user.teamNames.length}</SectionLabel>
        {user.teamNames.length === 0 ? (
          <Card>
            <EmptyState
              title="No team yet"
              help={{ guide: "13-teams-and-roles", section: "how-do-i-join-a-team", label: "How to join a team" }}
              message={
                isAdmin
                  ? "You're not a member of any team. As an admin, you can open any of them below."
                  : "You're not a member of any team yet. Ask a maintainer of the team you work on, or an admin, to add you."
              }
            />
          </Card>
        ) : (
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }, gap: 2 }}>
            {user.teamNames.map((teamName) => (
              <TeamCard
                key={teamName}
                name={teamName}
                // As the team's own page says it: an admin manages every team they're in.
                maintains={isAdmin || user.maintainerOf.includes(teamName)}
                offers={offers.filter((r) => r.team === teamName)}
                apis={apis.filter((a) => a.team === teamName)}
                approvals={approvals.filter((a) => a.team === teamName)}
                usage={usageOf(teamName)}
              />
            ))}
          </Box>
        )}
      </Box>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: `repeat(${isAdmin ? 3 : 2}, minmax(0, 1fr))` }, gap: 2, mb: 3, alignItems: "stretch" }}>
        <Card component="section" aria-labelledby="roles" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
          <CardTitle id="roles" title="Who can do what" />
          {ROLES.map(([role, tone, what]) => (
            <Box key={role}>
              <Pill tone={tone}>{role}</Pill>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                {what}
              </Typography>
            </Box>
          ))}
        </Card>

        <Card component="section" aria-labelledby="join" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
          <CardTitle id="join" title="Joining a team">
            Ask one of its maintainers to add you.
            {sso && ` On ${install || "this install"}, your ${sso} groups can also put you in teams each time you sign in${isAdmin ? ":" : "."}`}
          </CardTitle>
          {isAdmin && mappings.length > 0 && (
            <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", columnGap: 2, rowGap: 0.75, fontSize: 13 }}>
              {mappings.map((m) => (
                <Box key={m.id} sx={{ display: "contents" }}>
                  <Mono sx={{ overflowWrap: "anywhere" }}>{m.group}</Mono>
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
                    {m.team} · {m.role}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
          {isAdmin && sso && (
            <Link component={RouterLink} to="/admin/sign-in" variant="body2">
              {mappings.length > 0 ? "Edit group mappings in Admin" : "Map groups to teams in Admin"}
            </Link>
          )}
        </Card>

        {isAdmin && (
          <Card component="section" id="create" aria-labelledby="newteam" sx={{ p: 2.5 }}>
            <Box component="form" onSubmit={(event: FormEvent) => void handleCreateTeam(event)} sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
              <CardTitle id="newteam" title="Create a team">
                Catalog teams arrive with each release. Make one here only for a team outside the catalog; its namespace is
                created with it, labelled <Mono>vertra/team=true</Mono>.
              </CardTitle>
              <TextField
                inputRef={createInput}
                size="small"
                label="Team name"
                placeholder="e.g. checkout"
                required
                value={newTeamName}
                onChange={(event) => {
                  setNewTeamName(event.target.value);
                }}
                helperText="Also its namespace: lowercase letters, digits and dashes."
              />
              <Button type="submit" variant="contained" disabled={submitting} sx={{ alignSelf: "flex-start" }}>
                {submitting ? "Creating…" : "Create team"}
              </Button>
              {error && <Alert severity="error">{error}</Alert>}
            </Box>
          </Card>
        )}
      </Box>

      {allTeams && (
        <Card component="section" aria-labelledby="others">
          <Box sx={{ p: 2.5, pb: 2, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 2, flexWrap: "wrap" }}>
            <CardTitle id="others" title={`Every other team · ${String(others.length)}`}>
              You see these as an admin; their members see only their own. Anyone else sees what a team shares with them.
            </CardTitle>
            <TextField
              type="search"
              size="small"
              placeholder="Team name"
              value={find}
              onChange={(e) => { setFind(e.target.value); }}
              slotProps={{ htmlInput: { "aria-label": "Find a team" } }}
              sx={{ width: { xs: "100%", sm: 240 } }}
            />
          </Box>
          <DataTable
            columns={columns}
            rows={shown}
            getRowKey={(t) => t.id}
            emptyMessage={find ? "No team by that name." : "No other team."}
          />
        </Card>
      )}
    </Box>
  );
}
