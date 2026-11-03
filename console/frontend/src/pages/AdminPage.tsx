// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { Link as RouterLink, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import ListSubheader from "@mui/material/ListSubheader";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import EditIcon from "@mui/icons-material/EditOutlined";
import TerminalIcon from "@mui/icons-material/TerminalOutlined";
import { useAuth } from "../auth/AuthContext";
import { ErrorPage } from "../components/ErrorPage";
import { HelpLink, helpHref } from "../components/HelpLink";
import { PageHeader } from "../components/PageHeader";
import { Pill, type PillTone } from "../components/Pill";
import type { InstallInfo } from "../api";
import { useEnvironment } from "../environment";
import { AdminChannelCard } from "./admin/AdminChannelCard";
import { AutomationTokensCard } from "./admin/AutomationTokensCard";
import { ChatLimitsCard } from "./admin/ChatLimitsCard";
import { ChatSettingsCard } from "./admin/ChatSettingsCard";
import { ChatTab } from "./admin/ChatTab";
import { GatewayTab } from "./admin/GatewayTab";
import { ImageScansTab } from "./admin/ImageScansTab";
import { ImageSourcesCard } from "./admin/ImageSourcesCard";
import { AuditCopyCard, CatalogSection, OverviewTab, PoliciesCard } from "./admin/OverviewTab";
import { PeopleTab } from "./admin/PeopleTab";
import { SsoCard } from "./admin/SsoCard";
import { AdminCard, Dot, SrOnly, TONE_WORD } from "./admin/parts";
import { AdminChanged, sectionStates, useAdminSummary, type AdminSummary, type State } from "./admin/summary";

/** The guide that explains every section (console/docs/16-admin-settings.md). */
const GUIDE = "16-admin-settings";

/**
 * Where a section's settings are made: in the console (here), by the
 * install (vertra.yaml or the Helm values, then vertra apply), the install
 * turning it on and the console running it (both), or nothing to set.
 */
type Source = "here" | "install" | "both" | "status";
const SOURCE: Record<Source, { label: string; tone: PillTone }> = {
  here: { label: "Set here", tone: "info" },
  install: { label: "Set by the install", tone: "neutral" },
  both: { label: "Install and here", tone: "neutral" },
  status: { label: "Status only", tone: "neutral" },
};

interface Section {
  id: string;
  label: string;
  /** What it does and what it affects, in a sentence or two. */
  about: ReactNode;
  source: Source;
  /** What's changed in this console, and what the install sets (with this install's values, once read): a few points each. */
  here?: ReactNode[];
  install?: ReactNode[] | ((install: InstallInfo | null) => ReactNode[]);
  content: (summary: AdminSummary | null) => ReactNode;
}

const mono = (text: string) => (
  <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: "0.93em" }}>
    {text}
  </Box>
);

/** A setting's value on this install, after its name: " (this install: 8h)". Nothing until it's read. */
function thisInstall(install: InstallInfo | null, value: (i: InstallInfo) => ReactNode) {
  return install ? <> (this install: {value(install)})</> : null;
}

/** A number of seconds as people say it: 90 s, 5 min, 2 h. */
function seconds(n: number): string {
  if (n % 3600 === 0 && n >= 3600) return `${String(n / 3600)} h`;
  if (n % 60 === 0 && n >= 60) return `${String(n / 60)} min`;
  return `${String(n)} s`;
}

/** Who may sign a release, in words. */
function signers(i: InstallInfo): ReactNode {
  if (!i.catalogVersion) return "no catalog";
  const keys = i.catalogSignerKeys > 0 ? `${String(i.catalogSignerKeys)} public ${i.catalogSignerKeys === 1 ? "key" : "keys"}` : "";
  const keyless = i.catalogKeylessIssuer ? (
    <>
      keyless, {mono(i.catalogKeylessIssuer)} for {mono(i.catalogKeylessSubject || "any subject")}
    </>
  ) : null;
  if (!keys && !keyless) return "none, so releases aren't checked";
  return (
    <>
      {keys}
      {keys && keyless && " or "}
      {keyless}
    </>
  );
}

/** Whether anyone may sign up, as this install has it. */
function SelfRegistration() {
  const open = useEnvironment()?.selfRegistration;
  return (
    <>
      Whether anyone may sign up: {mono("allowSelfRegistration")}
      {open === undefined ? "" : open ? " (on)" : " (off)"}.
    </>
  );
}

/** The sections, grouped: each its own page, /admin/<id>. */
const GROUPS: { name: string; sections: Section[] }[] = [
  {
    name: "Install",
    sections: [
      {
        id: "overview",
        label: "Overview",
        about: "This install at a glance: what still needs you, and the state of every part, each leading to the section that sets it. Nothing is changed on this page.",
        source: "status",
        install: [
          <>Optional parts are turned on in {mono("vertra.yaml")}: {mono("vertra config set -e <env> <key> <value>")}, then {mono("vertra apply <env>")}.</>,
          "Without vertra, the same keys are in the console and kernel charts' Helm values.",
        ],
        content: (summary) => <OverviewTab summary={summary} />,
      },
    ],
  },
  {
    name: "People and access",
    sections: [
      {
        id: "people",
        label: "People",
        about: "Everyone who can sign in to this install: add a person to the teams they work on, make or remove an admin, reset a password, or delete an account. What each person may do comes from their teams; bots are on each team's Automation tab.",
        source: "here",
        here: ["Accounts, admins and password resets.", "A new person joins each team chosen as a maintainer; the team's maintainers change roles on its Members tab."],
        install: (i) => [
          <>The first admin: {mono("admin.email")} in vertra.yaml.</>,
          <>How long a session lasts: {mono("jwtTtl")}{thisInstall(i, (x) => mono(x.sessionLength)) ?? " (8 hours unless the install changes it)"}.</>,
          <SelfRegistration key="self-registration" />,
        ],
        content: () => <PeopleTab />,
      },
      {
        id: "sign-in",
        label: "Single sign-on and groups",
        about: "Lets people sign in with your OpenID Connect provider (Google, Entra ID, Okta, Keycloak…), and keeps team membership and roles in step with its groups. Passwords keep working, except in teams that require single sign-on.",
        source: "both",
        here: [
          "The provider, unless the install sets it.",
          "Where groups come from, and which groups map to which teams: always here.",
          <>Whether a team requires single sign-on: on <Link component={RouterLink} to="/teams">that team&apos;s Settings tab</Link>.</>,
        ],
        install: [
          <>Optionally the provider: {mono("sso")} in vertra.yaml ({mono("vertra sso google <env>")}). It then shows here read-only.</>,
          <>Google Workspace groups&apos; access: {mono("vertra sso google-groups <env>")}.</>,
        ],
        content: () => <SsoCard />,
      },
      {
        id: "tokens",
        label: "Automation tokens",
        about: "Tokens for the platform's own automation, each with only the permissions ticked. They belong to no team: a team's bots are on that team's Automation tab.",
        source: "here",
        here: ["Issuing a token, its permissions and how long it lasts.", "Revoking one: it stops working at once."],
        content: () => <AutomationTokensCard />,
      },
    ],
  },
  {
    name: "Catalog and images",
    sections: [
      {
        id: "catalog",
        label: "Catalog",
        about: "Where teams, products, templates and SecretStores come from. Catalog CI publishes a release from the catalog repository's main; this console reads it every few minutes, checks its signature and applies it. What a release no longer has is unregistered or retired here, never purged.",
        source: "both",
        here: ["Sync now: read and apply the release at once.", "Adopt a team the catalog found here but didn't make."],
        install: (i) => [
          <>
            The release, and which versions to apply: {mono("catalog")}, {mono("catalogVersion")} ({mono("vertra catalog create")}, {mono("vertra catalog promote")})
            {thisInstall(i, (x) => (x.catalogVersion ? mono(x.catalogVersion) : "no catalog"))}.
          </>,
          <>How often it looks for a new release: the console chart&apos;s {mono("catalog.pollSeconds")}{thisInstall(i, (x) => (x.catalogVersion ? `every ${seconds(x.catalogPollSeconds)}` : "no catalog"))}.</>,
          <>Who may sign a release: {mono("signing")}{thisInstall(i, signers)}.</>,
          <>Reading another install&apos;s catalog instead: {mono("externalCatalog")}{thisInstall(i, (x) => (x.externalCatalog ? <>{mono(x.externalCatalog)}, as configured</> : x.catalogVersion ? "its own, as configured" : "no catalog"))}.</>,
        ],
        content: () => <CatalogSection />,
      },
      {
        id: "images",
        label: "Image sources",
        about: "The registry paths a step's image may come from. The cluster refuses any other image when a step starts, however it was submitted (IMAGE_NOT_ALLOWED). A save takes effect for every team at once.",
        source: "both",
        here: ["The allowed sources: the source registry and any more.", "Upgrades keep what's saved here."],
        install: (i) => [
          <>Their first value, when the kernel is installed: {mono("taskImages.registry")} in vertra.yaml.</>,
          <>
            Whether images must be signed: the kernel chart&apos;s {mono("imageSignature")}
            {thisInstall(i, (x) =>
              x.imageSignaturesRequired === null
                ? "couldn't be read from the cluster"
                : x.imageSignaturesRequired
                  ? "required, its signature policy is in the cluster"
                  : "not required, no signature policy in the cluster",
            )}
            .
          </>,
        ],
        content: (summary) => <ImageSourcesCard summary={summary} />,
      },
      {
        id: "scans",
        label: "Image scans",
        about: "Every image's last scan. A failed image can't be registered or run until it's rebuilt, or an admin accepts it here.",
        source: "both",
        here: ["Rescan an image now.", "Accept a failed one, with a reason kept in the audit log."],
        install: (i) => [
          <>Whether images are scanned: the console chart&apos;s {mono("scanning.enabled")} (on by default){thisInstall(i, (x) => (x.scanning ? "on" : "off"))}.</>,
          <>How often images in use are scanned again: {mono("scanning.rescanHours")}{thisInstall(i, (x) => (x.rescanHours ? `every ${String(x.rescanHours)} h` : "never, scanning is off"))}.</>,
        ],
        content: () => <ImageScansTab />,
      },
    ],
  },
  {
    name: "Integrations",
    sections: [
      {
        id: "gateway",
        label: "API gateway",
        about: "One front door for every team's API products: it signs callers in, lets through only what each API's reviewed OpenAPI file describes, and forwards it to that API's backend, minting the backend's credential per request rather than storing it.",
        source: "both",
        here: ["Closing the gateway, and reopening it.", "A team's maintainers pause one of their own APIs from its page."],
        install: [
          <>Whether it runs: {mono("gateway.enabled")}.</>,
          <>Where backends may be: {mono("gateway.backendHosts")}.</>,
          <>Which teams may publish to the internet: {mono("gateway.internetTeams")}.</>,
          <>Its addresses: {mono("gateway.url")}, {mono("gateway.publicUrl")}.</>,
        ],
        content: () => <GatewayTab />,
      },
      {
        id: "chat",
        label: "Chat agent",
        about: (
          <>
            The model behind Ask Vertra, which answers from the guides and proposes carts from the catalog, and what people asked it and how
            they rated the answers. What it&apos;s sent reaches the model&apos;s provider: on a cloud, choose the install&apos;s own.
          </>
        ),
        source: "both",
        here: ["A model of your own, its provider and limits: it replaces the install's until you choose Use the install's.", "Turning it off for everyone."],
        install: [<>A default model: {mono("chat")} in vertra.yaml ({mono("chat.model")}, {mono("chat.off")}) on gcp and aws; elsewhere the console chart&apos;s {mono("chat")} values.</>],
        content: () => (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <ChatSettingsCard />
            <ChatLimitsCard />
            <ChatTab />
          </Box>
        ),
      },
      {
        id: "alerts",
        label: "Admins' alerts",
        about: "Admins get alerts (a team purged, the image sources changed, a policy not written, a step the cluster refused) in the console and by email. A team's chat webhook can get them too.",
        source: "both",
        here: ["Which team's chat webhook also gets them."],
        install: (i) => [
          <>
            Email: the console chart&apos;s {mono("notifications.email")} names the SMTP server
            {thisInstall(i, (x) => (x.email ? <>{mono(x.emailHost)}, from {mono(x.emailFrom)}</> : "none, so no email is sent"))}.
          </>,
          <>The hosts a webhook may post to: {mono("notifications.webhookHosts")}.</>,
        ],
        content: () => <AdminChannelCard />,
      },
    ],
  },
  {
    name: "Security and audit",
    sections: [
      {
        id: "policies",
        label: "Cluster policies",
        about: "The rules the cluster enforces whatever the console says: which products, identities, secrets and images a step may use, and what each team's steps may reach and take. The console writes them from its database when products, secrets or image sources change, at startup, and every few minutes, which also undoes any edit made by hand.",
        source: "status",
        here: ["Write them again: rewrite them all now."],
        install: (i) => [
          <>How often they&apos;re rewritten: the console chart&apos;s {mono("policySyncIntervalSeconds")}{thisInstall(i, (x) => `every ${seconds(x.policySyncSeconds)}`) ?? " (300)"}.</>,
          "The policies the kernel chart installs and the console doesn't write (below).",
        ],
        content: () => <PoliciesCard />,
      },
      {
        id: "audit",
        label: "Audit log copy",
        about: "Every request that tried to change something is in the audit log, each entry hash-chained to the one before, so changing, removing or slipping in an entry breaks every later hash. This is its write-once copy in a bucket that refuses deletes and overwrites, and whether the chain still holds.",
        source: "install",
        install: (i) => [
          <>Whether there&apos;s a copy, and where: {mono("audit.export")} in vertra.yaml (gcp, aws), or the console chart&apos;s {mono("audit.export.bucket")}.</>,
          <>How long the bucket keeps each entry: {mono("audit.keepDays")}{thisInstall(i, (x) => (!x.auditCopy ? "no copy" : x.auditKeepDays ? `${String(x.auditKeepDays)} days, as configured` : "not known here"))}.</>,
          <>
            {mono("audit.lock")} makes that retention permanent: nobody can shorten it or delete the bucket until it lapses. Decide before you set it
            {thisInstall(i, (x) => (!x.auditCopy ? "no copy" : x.auditLock ? "locked, as configured" : "not locked, as configured"))}.
          </>,
        ],
        content: () => <AuditCopyCard />,
      },
    ],
  },
];
const SECTIONS = GROUPS.flatMap((g) => g.sections);

/** One side of "where it's set": a heading with its icon, then its points. */
function Where({ icon, title, points }: { icon: ReactNode; title: string; points: ReactNode[] }) {
  return (
    <Box sx={{ bgcolor: "background.default", borderRadius: 2, px: 1.75, py: 1.5, display: "flex", flexDirection: "column", gap: 0.75, fontSize: 13, lineHeight: 1.5 }}>
      <Typography component="h3" sx={{ m: 0, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, color: "text.secondary", display: "flex", alignItems: "center", gap: 1 }}>
        {icon}
        {title}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.25, display: "flex", flexDirection: "column", gap: 0.5 }}>
        {points.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </Box>
    </Box>
  );
}

/**
 * What a section is for, where its settings are made, and its part of the
 * guide: above its cards.
 */
function SectionIntro({ section, install }: { section: Section; install: InstallInfo | null }) {
  const source = SOURCE[section.source];
  const installPoints = typeof section.install === "function" ? section.install(install) : section.install;
  return (
    <AdminCard title={section.label} status={<Pill tone={source.tone}>{source.label}</Pill>} label={`About ${section.label}`}>
      <Typography variant="body2" sx={{ maxWidth: 860, lineHeight: 1.6 }}>
        {section.about}
      </Typography>
      {(section.here || section.install) && (
        <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {section.here && <Where icon={<EditIcon sx={{ fontSize: 15 }} aria-hidden="true" />} title="Set here" points={section.here} />}
          {installPoints && <Where icon={<TerminalIcon sx={{ fontSize: 15 }} aria-hidden="true" />} title="Set by the install" points={installPoints} />}
        </Box>
      )}
      <Box>
        <HelpLink guide={GUIDE} section={section.label.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")} label={`About ${section.label}`} />
      </Box>
    </AdminCard>
  );
}

/** A section's short state beside its name: a dot, a few words, and what the dot means for a screen reader. */
function NavState({ state }: { state: State }) {
  return (
    <Box component="span" sx={{ fontSize: 12, color: "text.secondary", display: "inline-flex", alignItems: "center", gap: 0.75, whiteSpace: "nowrap", flexShrink: 0 }}>
      <Dot tone={state.tone} />
      {state.text}
      <SrOnly>, {TONE_WORD[state.tone]}</SrOnly>
    </Box>
  );
}

const GROUP_HEADING = { m: 0, mb: 0.5, px: 1.5, fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, color: "text.secondary" } as const;

/** The sections down the side, in their groups, each with its state. */
function SectionNav({ current, states }: { current: string; states: Partial<Record<string, State>> }) {
  return (
    <Box component="nav" aria-label="Admin sections" sx={{ display: { xs: "none", md: "flex" }, flexDirection: "column", gap: 1.75, position: "sticky", top: 16, fontSize: 14 }}>
      {GROUPS.map((g) => (
        <Box key={g.name} role="group" aria-label={g.name}>
          <Typography component="h2" sx={GROUP_HEADING}>
            {g.name}
          </Typography>
          {g.sections.map((s) => {
            const on = s.id === current;
            const state = states[s.id];
            return (
              <Link
                key={s.id}
                component={RouterLink}
                to={`/admin/${s.id}`}
                underline="none"
                aria-current={on ? "page" : undefined}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1.25,
                  minHeight: 44,
                  px: 1.5,
                  borderRadius: 2,
                  color: on ? "text.primary" : "text.secondary",
                  fontWeight: on ? 500 : 400,
                  bgcolor: on ? "info.light" : "transparent",
                  "&:hover": { bgcolor: on ? "info.light" : "action.hover", color: "text.primary" },
                }}
              >
                <Box component="span" sx={{ flex: "1 1 auto", minWidth: 0 }}>
                  {s.label}
                </Box>
                {state && <NavState state={state} />}
              </Link>
            );
          })}
        </Box>
      ))}
      <Box sx={{ borderTop: 1, borderColor: "divider", pt: 1.5, px: 1.5 }}>
        <Link component={RouterLink} to={helpHref({ guide: GUIDE })} variant="body2">
          The Admin guide, setting by setting →
        </Link>
      </Box>
    </Box>
  );
}

/**
 * This install's settings, for admins, in sections down the side: the
 * install, who has access and how they sign in, where the catalog and its
 * images come from, what it's connected to (the gateway, the chat agent's
 * model, alerts) and what keeps it honest. Each section is in the address
 * (/admin/chat), says where its settings are made, and shows its state in
 * the navigation; the old tabs' addresses (?tab=people) still lead to theirs.
 */
export function AdminPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { section: id } = useParams();
  const [params] = useSearchParams();
  const current = id ?? "overview";

  if (!user?.isAdmin) {
    return <ErrorPage title="Admins only" message="This page holds the install's settings, for its admins. Ask one if you need something changed." />;
  }
  const tab = params.get("tab");
  if (!id && tab && SECTIONS.some((s) => s.id === tab)) return <Navigate to={`/admin/${tab}`} replace />;
  const section = SECTIONS.find((s) => s.id === current);
  if (!section) return <Navigate to="/admin" replace />;
  return <AdminSections section={section} onSection={(next) => { navigate(`/admin/${next}`); }} />;
}

/** The sections, for an admin: the summary is read once here (not for anyone
 * else), and again when a section says it changed something. */
function AdminSections({ section, onSection }: { section: Section; onSection: (id: string) => void }) {
  const { summary, reload } = useAdminSummary();
  const states = summary ? sectionStates(summary) : {};
  return (
    <AdminChanged.Provider value={reload}>
    <Box>
      <PageHeader
        title="Admin"
        subtitle={<>This install&apos;s settings, grouped by what they&apos;re for. Teams, products and templates come from the catalog. Each section says what&apos;s set here and what the install sets (vertra.yaml, then {mono("vertra apply")}).</>}
        help={{ guide: GUIDE, label: "The Admin page, setting by setting" }}
      />
      <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "236px minmax(0, 1fr)" }, alignItems: "start" }}>
        <SectionNav current={section.id} states={states} />
        <TextField
          select
          size="small"
          label="Section"
          value={section.id}
          onChange={(e) => { onSection(e.target.value); }}
          sx={{ display: { xs: "flex", md: "none" } }}
        >
          {GROUPS.flatMap((g) => [
            <ListSubheader key={g.name} sx={{ lineHeight: "36px", fontWeight: 600, color: "text.primary" }}>
              {g.name}
            </ListSubheader>,
            ...g.sections.map((s) => (
              <MenuItem key={s.id} value={s.id} sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
                {s.label}
                {states[s.id] && <NavState state={states[s.id] as State} />}
              </MenuItem>
            )),
          ])}
        </TextField>
        <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <SectionIntro section={section} install={summary?.install ?? null} />
          {section.content(summary)}
        </Box>
      </Box>
    </Box>
    </AdminChanged.Provider>
  );
}
