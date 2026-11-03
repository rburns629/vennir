// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useRef, useState } from "react";
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Alert, Box, Button, Link, Tab, Tabs, Typography } from "@mui/material";
import {
  errorMessage,
  getTeam,
  getTeamProfile,
  listApis,
  listBots,
  listSchedules,
  listTeamMembers,
  listTeamPods,
  listTeamSecrets,
  purgeTeam,
  retireTeam,
  unretireTeam,
  type Team,
  type TeamProfile,
} from "../api";
import { useAuth } from "../auth/AuthContext";
import { HelpLink } from "../components/HelpLink";
import { Mono } from "../components/Mono";
import { Pill } from "../components/Pill";
import { isRunningPod } from "../components/TeamCard";
import { useEnvironment } from "../environment";
import { AutomationTab } from "./team/AutomationTab";
import { SchedulesTab } from "./team/SchedulesTab";
import { TeamOffers } from "./team/TeamOffers";
import { MembersTab } from "./team/MembersTab";
import { ApisTab } from "./team/ApisTab";
import { RunningTab } from "./team/RunningTab";
import { SecretsTab } from "./team/SecretsTab";
import { SettingsTab } from "./team/SettingsTab";

type TabId = "members" | "offers" | "secrets" | "automation" | "schedules" | "apis" | "running" | "settings";
const TABS: [TabId, string][] = [
  ["members", "Members"],
  ["offers", "What it offers"],
  ["secrets", "Secrets"],
  ["automation", "Automation"],
  ["schedules", "Schedules"],
  ["apis", "APIs"],
  ["running", "Running now"],
  ["settings", "Settings"],
];

/** Each counted tab's count, read alone. */
const COUNTERS: Partial<Record<TabId, (team: string, maintains: boolean) => Promise<number | undefined>>> = {
  members: async (team) => (await listTeamMembers(team)).filter((m) => !m.isBot).length,
  secrets: async (team) => (await listTeamSecrets(team)).length,
  running: async (team) => (await listTeamPods(team)).filter((p) => isRunningPod(p.state)).length,
  // Bots are a maintainer's: anyone else isn't asked.
  automation: async (team, maintains) => (maintains ? (await listBots(team)).length : undefined),
  schedules: async (team) => (await listSchedules(team)).length,
  apis: async (team) => (await listApis()).filter((a) => a.team === team).length,
};

/** The small counts on the tabs: each read once, and a tab's again when
 * it's left (where something may have changed), not every count on every
 * click. Display only: a failed count just isn't shown, and each tab loads
 * (and reports errors for) its own data. */
function useTabCounts(teamName: string, tab: TabId, enabled: boolean, maintains: boolean) {
  const [counts, setCounts] = useState<Partial<Record<TabId, number>>>({});
  // The team counted now: a count that answers after another team is open is dropped.
  const counting = useRef(teamName);
  const read = useCallback(
    (ids: TabId[]) => {
      counting.current = teamName;
      for (const id of ids) {
        COUNTERS[id]?.(teamName, maintains)
          .then((n) => { if (counting.current === teamName) setCounts((c) => ({ ...c, [id]: n })); })
          .catch(() => { if (counting.current === teamName) setCounts((c) => ({ ...c, [id]: undefined })); });
      }
    },
    [teamName, maintains],
  );
  useEffect(() => {
    if (!enabled) return;
    setCounts({});
    read(Object.keys(COUNTERS) as TabId[]);
  }, [read, enabled]);
  const shown = useRef(tab);
  useEffect(() => {
    if (enabled && shown.current !== tab) read([shown.current]);
    shown.current = tab;
  }, [tab, enabled, read]);
  return counts;
}

/** Where to ask the team, from its team.yaml: a chat, a help page, a contact. */
function AskLine({ profile }: { profile: TeamProfile }) {
  const chat = profile.helpChat;
  const url = profile.helpUrl;
  if (!chat && !url && !profile.contact) return null;
  return (
    <>
      {" · ask "}
      {url ? (
        <Link href={url} target="_blank" rel="noopener noreferrer">
          {chat ?? profile.contact ?? "its help page"}
        </Link>
      ) : (
        (chat ?? profile.contact)
      )}
    </>
  );
}

export function TeamPage() {
  const { teamName = "" } = useParams();
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const sso = useEnvironment()?.ssoLabel ?? "";
  const isMember = user?.teamNames.includes(teamName) ?? false;
  const isAdmin = user?.isAdmin ?? false;
  // Platform admins can see and manage any team, not just ones they belong
  // to -- see ../../src/auth/access.ts's matching backend checks. Any
  // member sees the tabs; only a maintainer gets their forms. The API
  // refuses either way; this only decides what to show, so nobody sees a
  // 403 they can't act on.
  const canSee = isMember || isAdmin;
  const canMaintain = (user?.maintainerOf.includes(teamName) ?? false) || isAdmin;
  // The tab is in the address (?tab=settings), so it can be linked to.
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as TabId | null;
  const tabs = TABS.filter(([id]) => id !== "automation" || canMaintain); // bots are a maintainer's
  const tab: TabId = tabs.some(([id]) => id === requested) ? (requested as TabId) : "members";
  const setTab = (next: TabId) => { setParams(next === "members" ? {} : { tab: next }, { replace: true }); };
  const [team, setTeam] = useState<Team | null>(null);
  const [profile, setProfile] = useState<TeamProfile | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const retired = Boolean(team?.retiredAt);
  const counts = useTabCounts(teamName, tab, canSee, canMaintain);

  const reload = useCallback(() => {
    // Display only: if this fails, the page still works without the
    // retired marker, and the forms below surface their own errors.
    getTeam(teamName).then(setTeam).catch(() => undefined);
  }, [teamName]);

  useEffect(() => {
    setTeam(null);
    setProfile(null);
    reload();
    // Display only: where to ask the team, in the header and its settings.
    if (canSee) getTeamProfile(teamName).then(setProfile).catch(() => undefined);
  }, [reload, teamName, canSee]);

  /** Retire, restore or purge: the refusal shown up top, the team reloaded after. */
  async function lifecycle(action: () => Promise<void>): Promise<void> {
    setLifecycleError(null);
    setLifecycleBusy(true);
    try {
      await action();
    } catch (err) {
      // A purge is refused (409) while runs are unfinished; its message says so.
      setLifecycleError(errorMessage(err, "Something went wrong. Try again."));
    } finally {
      setLifecycleBusy(false);
    }
  }
  const restore = () => lifecycle(async () => { await unretireTeam(teamName); reload(); });

  const role = isMember ? (canMaintain ? "You maintain it" : "You're a member") : isAdmin ? "Viewing as admin" : null;

  return (
    <Box>
      <Typography component="nav" aria-label="Breadcrumb" variant="body2" color="text.secondary">
        <Link component={RouterLink} to="/teams">
          Teams
        </Link>{" "}
        / {teamName}
      </Typography>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 2, flexWrap: "wrap", mt: 1, mb: 2.5 }}>
        <Box sx={{ minWidth: 0, flex: "1 1 420px" }}>
          <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.25, mb: 0.75 }}>
            <Typography variant="h4" component="h1" sx={{ overflowWrap: "anywhere", fontSize: { xs: 24, sm: 28 } }}>
              {teamName}
            </Typography>
            {retired && <Pill tone="neutral">Retired</Pill>}
            {role && <Pill tone="info">{role}</Pill>}
            {sso && team?.requireSso && (
              <Pill tone="neutral" title={`Members sign in with ${sso}; their passwords don't work (admins' do).`}>
                {sso} sign-in only
              </Pill>
            )}
          </Box>
          {profile?.description && (
            <Typography variant="body1" sx={{ maxWidth: 860, mb: 0.5, overflowWrap: "anywhere" }}>
              {profile.description}
            </Typography>
          )}
          {canSee && (
            <Typography variant="body1" color="text.secondary">
              Namespace <Mono>{teamName}</Mono>
              {team &&
                (team.fromCatalog ? (
                  <>
                    {" · from the catalog, "}
                    <Mono>teams/{teamName}/</Mono>
                  </>
                ) : (
                  " · made here"
                ))}
              {profile && <AskLine profile={profile} />}
            </Typography>
          )}
        </Box>
        <HelpLink guide="13-teams-and-roles" section="what-may-a-member-a-maintainer-and-an-admin-do" label="Who can do what" />
      </Box>

      {lifecycleError && (
        <Alert severity="error" sx={{ mb: 3 }}>
          {lifecycleError}
        </Alert>
      )}

      {!canSee ? (
        <TeamOffers teamName={teamName} showProfile />
      ) : (
        <>
          <Tabs
            value={tab}
            onChange={(_event, value: TabId) => { setTab(value); }}
            variant="scrollable"
            allowScrollButtonsMobile
            aria-label="Team views"
            sx={{ mb: 3 }}
          >
            {tabs.map(([id, label]) => (
              <Tab
                key={id}
                value={id}
                label={
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    {label}
                    {counts[id] !== undefined && counts[id] > 0 && (
                      <Box
                        component="span"
                        sx={{ minWidth: 20, px: 0.75, borderRadius: 999, bgcolor: "background.default", border: 1, borderColor: "divider", fontSize: 12, lineHeight: "18px", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}
                      >
                        {counts[id]}
                      </Box>
                    )}
                  </Box>
                }
              />
            ))}
          </Tabs>
          {retired && team?.retiredAt && (
            <Alert
              severity="info"
              icon={false}
              sx={{ mb: 3, bgcolor: "action.hover", borderColor: "divider", color: "text.primary", alignItems: "center" }}
              action={
                isAdmin ? (
                  <Button variant="outlined" color="inherit" size="small" disabled={lifecycleBusy} onClick={() => void restore()} sx={{ bgcolor: "background.paper" }}>
                    Restore it
                  </Button>
                ) : undefined
              }
            >
              <strong>
                Retired {new Date(team.retiredAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                {team.retiredBy && ` by ${team.retiredBy}`}.
              </strong>{" "}
              This
              team is retired: it&apos;s read-only. Nothing new can be registered, granted or run for it, and its products are no
              longer listed. Its history stays visible.
              {!isAdmin && " An admin can restore it."}
            </Alert>
          )}
          {tab === "members" && (
            <MembersTab
              teamName={teamName}
              readOnly={retired || !canMaintain}
              currentUserId={user?.id}
              requireSso={Boolean(sso && team?.requireSso)}
              onShowAutomation={canMaintain ? () => { setTab("automation"); } : undefined}
              onShowSettings={() => { setTab("settings"); }}
            />
          )}
          {tab === "offers" && <TeamOffers teamName={teamName} showProfile={false} />}
          {tab === "secrets" && <SecretsTab teamName={teamName} readOnly={retired || !canMaintain} />}
          {tab === "automation" && canMaintain && (
            <AutomationTab
              teamName={teamName}
              readOnly={retired}
              schedules={counts.schedules}
              onShowSchedules={() => { setTab("schedules"); }}
              onShowSettings={() => { setTab("settings"); }}
            />
          )}
          {tab === "schedules" && <SchedulesTab teamName={teamName} readOnly={retired || !canMaintain} />}
          {tab === "apis" && <ApisTab teamName={teamName} />}
          {tab === "running" && <RunningTab teamName={teamName} />}
          {tab === "settings" && team && (
            <SettingsTab
              team={team}
              profile={profile}
              isAdmin={isAdmin}
              busy={lifecycleBusy}
              onChanged={reload}
              onShowMembers={() => { setTab("members"); }}
              onRetire={() => lifecycle(async () => { await retireTeam(teamName); reload(); })}
              onRestore={restore}
              onPurge={() =>
                lifecycle(async () => {
                  await purgeTeam(teamName);
                  // The teams list (and every team picker) reads user.teamNames from
                  // `me`, loaded before the purge. Display only: if the reload fails,
                  // the purge still happened and a page refresh shows it.
                  await refresh().catch(() => undefined);
                  void navigate("/teams");
                })
              }
            />
          )}
        </>
      )}
    </Box>
  );
}
