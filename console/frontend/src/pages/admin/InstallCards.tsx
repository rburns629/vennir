// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import ArrowIcon from "@mui/icons-material/ArrowForward";
import CheckIcon from "@mui/icons-material/Check";
import DoneIcon from "@mui/icons-material/CheckCircle";
import TodoIcon from "@mui/icons-material/RadioButtonUnchecked";
import { listProducts } from "../../api";
import { Pill } from "../../components/Pill";
import { useEnvironment } from "../../environment";
import { when } from "../../time";
import { AdminCard, Dot, PILL_TONE, SrOnly, TONE_WORD, type Tone } from "./parts";
import { auditState, blocksRun, catalogState, failingInUse, unscannedInUse, workingTokens, liveTeams, policiesState, type AdminSummary } from "./summary";

const code = (text: string) => (
  <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: "0.92em" }}>
    {text}
  </Box>
);
const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;
const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`);
const short = (digest: string) => `${digest.slice(0, 15)}…`;

/** One headline figure about the install. */
function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <Card sx={{ p: 2, display: "flex", flexDirection: "column", gap: 0.5, minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography sx={{ fontSize: 22, fontWeight: 600, lineHeight: 1.25, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>{value}</Typography>
      {note && (
        <Typography variant="caption" color="text.secondary">
          {note}
        </Typography>
      )}
    </Card>
  );
}

/** The install in five figures: the console, its teams, people, products and how long runs are kept. */
export function InstallStats({ summary }: { summary: AdminSummary }) {
  const [products, setProducts] = useState<number | null>(null);
  useEffect(() => {
    // Display only: without it, that figure isn't shown.
    listProducts()
      .then((all) => { setProducts(all.length); })
      .catch(() => undefined);
  }, []);
  const { install, teams, people, catalog } = summary;
  const cloud = useEnvironment()?.cloud;
  const live = teams ? liveTeams(teams) : null;
  const notMade = live?.filter((t) => !t.fromCatalog).length ?? 0;
  const admins = people?.filter((p) => p.isAdmin).length ?? 0;
  return (
    <Box component="section" aria-label="This install" sx={{ display: "grid", gap: 1.5, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
      {install && (
        <Stat
          label="Console"
          value={install.version}
          note={
            <>
              {install.environmentLabel}
              {cloud && (
                <Box component="span" title="Products whose catalog files list other clouds are shown here but not run" sx={{ display: "block" }}>
                  Cloud: {cloud} (set by vennir)
                </Box>
              )}
            </>
          }
        />
      )}
      {live && <Stat label="Teams" value={live.length} note={catalog?.release && notMade > 0 ? `${String(notMade)} the catalog didn't make` : undefined} />}
      {people && <Stat label="People" value={people.length} note={plural(admins, "admin")} />}
      {products !== null && <Stat label="Products" value={products} note={catalog?.version ? `from catalog ${catalog.version}` : undefined} />}
      {install && (
        <Stat
          label="Runs kept"
          value={install.runRetentionDays > 0 ? `${String(install.runRetentionDays)} days` : "No time limit"}
          note={install.runRetentionDays > 0 ? "then their records go" : undefined}
        />
      )}
    </Box>
  );
}

interface Need {
  tone: Tone;
  part: string;
  title: string;
  detail?: ReactNode;
  action: string;
  to: string;
}

/** What needs an admin now, worst first, each from what the API says. */
function needs(s: AdminSummary, ssoLabel: string): Need[] {
  const out: Need[] = [];
  const failed = s.install?.scanning === false ? [] : failingInUse(s);
  if (failed.length === 1 && failed[0]) {
    const f = failed[0];
    out.push({
      tone: "err",
      part: "Image scans",
      title: `${f.image.split("@")[0] ?? f.image} failed its scan`,
      detail: <>{code(short(f.digest))} has {plural(f.fixable, "fixable HIGH or CRITICAL finding")}{f.secrets > 0 ? ` and ${plural(f.secrets, "secret")}` : ""}. It can&apos;t run until it&apos;s rebuilt, or an admin accepts it with a reason.</>,
      action: "Review the scan",
      to: "/admin/scans",
    });
  } else if (failed.length > 1) {
    out.push({ tone: "err", part: "Image scans", title: `${String(failed.length)} images failed their scan`, detail: "They can't run until they're rebuilt, or an admin accepts each with a reason.", action: "Review the scans", to: "/admin/scans" });
  }
  const unscanned = s.install?.scanning === false ? [] : unscannedInUse(s);
  if (unscanned.length > 0) {
    out.push({
      tone: "warn",
      part: "Image scans",
      title: `${plural(unscanned.length, "image")} in use couldn't be scanned`,
      detail: "A step can't start with one until a scan succeeds: the reason is on each, with Rescan.",
      action: "See the scans",
      to: "/admin/scans",
    });
  }
  if (s.imagePolicy && (!s.imagePolicy.exists || s.imagePolicy.allowed.length === 0)) {
    out.push({
      tone: "err",
      part: "Image sources",
      title: s.imagePolicy.exists ? "No image source is allowed" : "The cluster's image policy doesn't exist",
      detail: s.imagePolicy.exists ? "No step can run until one is." : "No step can run. Installing or upgrading the kernel creates it.",
      action: "Open Image sources",
      to: "/admin/images",
    });
  }
  if (s.catalog?.release && s.catalog.error) {
    out.push({ tone: "err", part: "Catalog", title: "The catalog's release wasn't applied", detail: s.catalog.error, action: "See Catalog", to: "/admin/catalog" });
  }
  for (const p of s.catalog?.problems ?? []) {
    if (!p.adoptableTeam) continue;
    out.push({
      tone: "warn",
      part: "Catalog",
      title: `The catalog found a team named ${p.adoptableTeam} that it didn't make`,
      detail: `The last release left ${p.adoptableTeam}, its products and its SecretStores alone. Adopt it if the catalog's folder is meant to be that team; otherwise rename the folder.`,
      action: "Decide in Catalog",
      to: "/admin/catalog",
    });
  }
  const others = (s.catalog?.problems ?? []).filter((p) => !p.adoptableTeam);
  if (others.length > 0) {
    out.push({ tone: "warn", part: "Catalog", title: `The last release was applied except ${plural(others.length, "item")}`, detail: others.map((p) => p.item).join(", "), action: "See Catalog", to: "/admin/catalog" });
  }
  const failing = (s.policies ?? []).filter((p) => p.applies && !p.ok);
  if (failing.length > 0) {
    out.push({ tone: "err", part: "Cluster policies", title: `${plural(failing.length, "cluster policy", "cluster policies")} weren't written`, detail: failing[0]?.error ?? undefined, action: "See Cluster policies", to: "/admin/policies" });
  }
  if (s.audit) {
    const state = auditState(s.audit);
    if (state.tone === "err" || state.tone === "warn") {
      out.push({ tone: state.tone, part: "Audit log copy", title: `The audit log's copy: ${state.text.toLowerCase()}`, detail: s.audit.compareProblem || s.audit.problem || undefined, action: "See Audit log copy", to: "/admin/audit" });
    }
  }
  if (s.chat?.problem) out.push({ tone: "err", part: "Chat agent", title: "The chat agent's settings can't be used, so it's off", detail: s.chat.problem, action: "Open Chat agent", to: "/admin/chat" });
  if (s.gateway?.enabled && s.gateway.closedMessage) {
    out.push({ tone: "warn", part: "API gateway", title: "The gateway is closed", detail: `Every API answers 503 with “${s.gateway.closedMessage}”.`, action: "Open API gateway", to: "/admin/gateway" });
  }
  const unfinished = (s.people ?? []).filter((p) => p.mustChangePassword);
  if (unfinished.length > 0) {
    out.push({
      tone: "warn",
      part: "People",
      title: `${plural(unfinished.length, "person", "people")} ${unfinished.length === 1 ? "hasn't" : "haven't"} chosen a password yet`,
      detail: `${list(unfinished.slice(0, 3).map((p) => p.email))}${unfinished.length > 3 ? " and others" : ""}: their temporary passwords still work; reset one if it went astray.`,
      action: "See them in People",
      to: "/admin/people",
    });
  }
  // Optional: with groups to read, teams nothing maps are still kept by hand.
  if (s.sso?.enabled && (s.sso.groupsClaim || s.sso.googleGroups) && s.mappings && s.teams) {
    const mapped = new Set(s.mappings.map((m) => m.team));
    const unmapped = s.teams.filter((t) => !t.retiredAt && !t.deletedAt && !mapped.has(t.name)).map((t) => t.name);
    if (unmapped.length > 0 && unmapped.length <= 5) {
      out.push({
        tone: "off",
        part: "Optional · Single sign-on and groups",
        title: `No group maps anyone to ${list(unmapped)}`,
        detail: `Their members are added and removed by hand. Map a ${ssoLabel || "directory"} group to each to keep them in step with your directory.`,
        action: "Map groups",
        to: "/admin/sign-in",
      });
    }
  }
  return out;
}

/** The parts Needs you reads, by name: one that couldn't be read is said. */
const UNREAD_PARTS: [keyof AdminSummary, string][] = [
  ["people", "People"],
  ["catalog", "the catalog"],
  ["imagePolicy", "image sources"],
  ["scans", "image scans"],
  ["policies", "cluster policies"],
  ["audit", "the audit log's copy"],
  ["chat", "the chat agent"],
  ["gateway", "the gateway"],
];

/** What needs an admin: each with what it means and the section that settles it. */
export function NeedsYou({ summary }: { summary: AdminSummary }) {
  const ssoLabel = summary.sso?.label ?? "";
  const items = needs(summary, ssoLabel);
  const urgent = items.filter((i) => i.tone !== "off").length;
  const worst: Tone = items.some((i) => i.tone === "err") ? "err" : urgent > 0 ? "warn" : "ok";
  // Parts it couldn't read: it can't say they're fine.
  const unread = UNREAD_PARTS.filter(([key]) => summary[key] === null).map(([, name]) => name);
  return (
    <AdminCard
      title="Needs you"
      accent={urgent > 0 ? "warning" : undefined}
      status={
        urgent > 0 ? (
          <Pill tone={PILL_TONE[worst]}>{plural(urgent, "thing")}</Pill>
        ) : unread.length > 0 ? (
          <Pill tone="warning">Couldn&apos;t read {unread.length}</Pill>
        ) : (
          <Pill tone="success">Nothing now</Pill>
        )
      }
    >
      {unread.length > 0 && (
        <Typography variant="body2" color="text.secondary">
          Couldn&apos;t read {unread.join(", ")}, so this can&apos;t say {unread.length === 1 ? "it's" : "they're"} fine. Reload to try again.
        </Typography>
      )}
      {items.length === 0 && unread.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Nothing needs you: every part reads as it should.
        </Typography>
      )}
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none" }}>
        {items.map((n, i) => (
          <Box
            component="li"
            key={`${n.part}-${n.title}`}
            sx={{ display: "flex", gap: 1.5, alignItems: "flex-start", flexWrap: { xs: "wrap", sm: "nowrap" }, py: 1.75, borderTop: i === 0 ? 0 : 1, borderColor: "divider" }}
          >
            <Dot tone={n.tone} sx={{ mt: 0.75 }} />
            <Box sx={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
              <Typography variant="caption" color="text.secondary">
                {n.part}
                <SrOnly>, {TONE_WORD[n.tone]}</SrOnly>
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                {n.title}
              </Typography>
              {n.detail && (
                <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                  {n.detail}
                </Typography>
              )}
            </Box>
            <Button component={RouterLink} to={n.to} variant="outlined" endIcon={<ArrowIcon />} sx={{ flexShrink: 0, minHeight: 44, ml: { xs: 2.5, sm: 0 } }}>
              {n.action}
            </Button>
          </Box>
        ))}
      </Box>
    </AdminCard>
  );
}

interface Step {
  /** null: its part couldn't be read, so it isn't said either way. */
  done: boolean | null;
  title: string;
  /** Said once it's done, in the strip that replaces the checklist. */
  doneText: string;
  to: string;
  how: ReactNode;
}

function stepsOf(s: AdminSummary): Step[] {
  const teams = s.teams ? liveTeams(s.teams).length : 0;
  const people = s.people?.length ?? 0;
  return [
    {
      done: s.catalog === null ? null : Boolean(s.catalog.release && s.catalog.appliedAt),
      title: "Connect the catalog",
      doneText: "Catalog connected",
      to: "/admin/catalog",
      how: <>Make the repository your teams publish from: {code("vennir catalog create")}. Its first release is pulled within minutes.</>,
    },
    {
      done: s.imagePolicy === null ? null : s.imagePolicy.allowed.length > 0,
      title: "Allow an image source",
      doneText: "An image source allowed",
      to: "/admin/images",
      how: <>The registry your catalog&apos;s CI pushes to: set at install, or in Image sources.</>,
    },
    {
      done: s.teams === null ? null : teams > 0,
      title: "Have a team",
      doneText: plural(teams, "team"),
      to: "/teams",
      how: <>A team folder in the catalog makes one; or create one on the <Link component={RouterLink} to="/teams">Teams</Link> page.</>,
    },
    {
      done: s.people === null ? null : people > 1,
      title: "Add people",
      doneText: plural(people, "person", "people"),
      to: "/admin/people",
      how: <>On the <Link component={RouterLink} to="/admin/people">People</Link> section, in the teams they work on.</>,
    },
    {
      done: s.install === null ? null : Boolean(s.install.ssoProvider),
      title: "Optional: single sign-on",
      doneText: "Single sign-on",
      to: "/admin/sign-in",
      how: <>In <Link component={RouterLink} to="/admin/sign-in">Single sign-on and groups</Link> (Google, Entra ID, Okta…), or {code("vennir sso google")}. Passwords keep working.</>,
    },
  ];
}

/**
 * Getting a new install ready: what it needs before teams can run anything
 * (a catalog, an image source, teams, people), and single sign-on if
 * wanted. Once the needed steps are done, a strip that says so.
 */
export function FirstRunChecklist({ summary }: { summary: AdminSummary }) {
  const steps = stepsOf(summary);
  const needed = steps.filter((s) => !s.title.startsWith("Optional"));
  // A step whose part couldn't be read isn't called undone: no checklist then (Needs you says what wasn't read).
  if (needed.some((s) => s.done === null)) return null;
  const done = needed.filter((s) => s.done).length;

  if (done === needed.length) {
    return (
      <Card component="section" aria-label="Ready to run" sx={{ px: 2.5, py: 1.75, display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: 2.5, rowGap: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Ready to run
        </Typography>
        {steps
          .filter((s) => s.done)
          .map((s) => (
            <Link key={s.title} component={RouterLink} to={s.to} variant="body2" underline="hover" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, color: "text.primary" }}>
              <CheckIcon sx={{ fontSize: 16, color: "success.main" }} aria-hidden="true" />
              {s.doneText}
            </Link>
          ))}
        <Typography variant="caption" color="text.secondary" sx={{ ml: { md: "auto" } }}>
          Everything the first-run checklist asks for is done.
        </Typography>
      </Card>
    );
  }
  return (
    <AdminCard title="Getting this install ready" status={<Typography variant="body2" color="text.secondary">{done} of {needed.length} done</Typography>} sx={{ borderColor: "info.light" }}>
      <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 1.25 }}>
        {steps.map((step) => (
          <Box component="li" key={step.title} sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
            {step.done ? <DoneIcon color="success" fontSize="small" sx={{ mt: 0.25 }} aria-label="Done" /> : <TodoIcon color="disabled" fontSize="small" sx={{ mt: 0.25 }} aria-label="Not yet" />}
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 500, color: step.done ? "text.secondary" : "text.primary" }}>
                {step.title}
              </Typography>
              {!step.done && (
                <Typography variant="body2" color="text.secondary">
                  {step.how}
                </Typography>
              )}
            </Box>
          </Box>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary">
        The whole of it is in the guide{" "}
        <Link component={RouterLink} to="/docs/reference-setup">
          Set up Vennir
        </Link>
        .
      </Typography>
    </AdminCard>
  );
}

/** Where a part is set, in a word: this console, the install, the install turning it on and the console running it, or nowhere (status). */
type Where = "here" | "install" | "both" | "status";
const WHERE: Record<Where, { label: string; tone: "info" | "neutral" }> = {
  here: { label: "Here", tone: "info" },
  install: { label: "Install", tone: "neutral" },
  both: { label: "Both", tone: "neutral" },
  status: { label: "Status", tone: "neutral" },
};

interface Part {
  name: string;
  to?: string;
  tone: Tone;
  detail: ReactNode;
  where: Where;
}

function PartRow({ part, first }: { part: Part; first: boolean }) {
  const where = WHERE[part.where];
  return (
    <Box component="li" sx={{ display: "flex", gap: 1.25, alignItems: "flex-start", py: 1.25, borderTop: first ? 0 : 1, borderColor: "divider" }}>
      <Dot tone={part.tone} sx={{ mt: 0.75 }} />
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.25 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {part.to ? (
            <Link component={RouterLink} to={part.to} sx={{ color: "text.primary" }}>
              {part.name}
            </Link>
          ) : (
            part.name
          )}
          <SrOnly>, {TONE_WORD[part.tone]}</SrOnly>
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          {part.detail}
        </Typography>
      </Box>
      <Pill tone={where.tone}>{where.label}</Pill>
    </Box>
  );
}

function PartGroup({ name, parts }: { name: string; parts: Part[] }) {
  if (parts.length === 0) return null;
  return (
    <Card component="section" aria-label={name} sx={{ p: { xs: 2, sm: 2.25 }, minWidth: 0 }}>
      <Typography variant="subtitle2" component="h3" sx={{ fontWeight: 600, mb: 0.5 }}>
        {name}
      </Typography>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none" }}>
        {parts.map((p, i) => (
          <PartRow key={p.name} part={p} first={i === 0} />
        ))}
      </Box>
    </Card>
  );
}

const daysUntil = (at: string) => Math.ceil((new Date(at).getTime() - Date.now()) / 86_400_000);

/** Every part of the install, grouped as the sections are: its state, and where it's set. */
export function EveryPart({ summary: s }: { summary: AdminSummary }) {
  const selfRegistration = useEnvironment()?.selfRegistration;
  const people: Part[] = [];
  const catalog: Part[] = [];
  const integrations: Part[] = [];
  const security: Part[] = [];

  if (s.sso) {
    const requiring = (s.teams ?? []).filter((t) => t.requireSso && !t.retiredAt && !t.deletedAt).map((t) => t.name);
    people.push({
      name: "Single sign-on",
      to: "/admin/sign-in",
      tone: s.sso.enabled ? "ok" : "off",
      detail: s.sso.enabled
        ? `On · ${s.sso.label || "single sign-on"}${s.sso.allowedDomains.length > 0 ? `, for ${s.sso.allowedDomains.join(", ")}` : ""}.${requiring.length > 0 ? ` Required by ${list(requiring)}.` : ""}`
        : <>Off: passwords only. Set up in Single sign-on and groups, or {code("vennir sso google")}.</>,
      where: "both",
    });
  }
  if (s.sso && s.mappings) {
    const sources = [s.sso.groupsClaim ? `the ${s.sso.groupsClaim} claim` : "", s.sso.googleGroups ? "Google Workspace groups" : ""].filter(Boolean);
    const teams = new Set(s.mappings.map((m) => m.team)).size;
    people.push({
      name: "Groups from the directory",
      to: "/admin/sign-in",
      tone: sources.length > 0 && s.mappings.length > 0 ? "ok" : "off",
      detail:
        sources.length === 0
          ? "Off: team memberships are kept by hand."
          : `${list(sources).replace(/^./, (c) => c.toUpperCase())}; ${s.mappings.length === 0 ? "no group mapped to a team yet" : `${plural(s.mappings.length, "group")} map people to ${plural(teams, "team")}`}.`,
      where: "here",
    });
  }
  if (s.tokens) {
    const working = workingTokens(s.tokens);
    const soon = working.filter((t) => t.expiresAt && daysUntil(t.expiresAt) <= 14).sort((a, b) => (a.expiresAt ?? "").localeCompare(b.expiresAt ?? ""))[0];
    people.push({
      name: "Automation tokens",
      to: "/admin/tokens",
      tone: working.length > 0 ? "ok" : "off",
      detail: working.length === 0 ? (s.tokens.length === 0 ? "None issued." : "None working: every one has expired.") : `${String(working.length)} active${soon?.expiresAt ? `; ${soon.label} expires in ${plural(daysUntil(soon.expiresAt), "day")}` : ""}.`,
      where: "here",
    });
  }
  if (selfRegistration !== undefined) {
    people.push({
      name: "Self-registration",
      tone: selfRegistration ? "warn" : "ok",
      detail: <>{selfRegistration ? "On: anyone who can reach the console may sign up." : "Off: an admin adds each person."} {code("allowSelfRegistration")}</>,
      where: "install",
    });
  }

  if (s.catalog) {
    const state = catalogState(s.catalog);
    const applied = s.catalog.appliedAt ? `${s.catalog.version || "A release"} applied ${when(s.catalog.appliedAt)}` : "Nothing applied yet";
    catalog.push({
      name: "Catalog release",
      to: "/admin/catalog",
      tone: state.tone,
      detail: !s.catalog.release
        ? <>Off: teams and products are only what admins make here. {code("vennir catalog create")}</>
        : `${applied}${s.catalog.newestVersion ? ", following the newest version" : ""}.${state.tone === "ok" ? "" : ` ${state.text}.`}`,
      where: "both",
    });
  }
  if (s.install?.catalog) {
    catalog.push({
      name: "Release signature",
      to: "/admin/catalog",
      tone: s.install.catalogSigned ? "ok" : "warn",
      detail: s.install.catalogSigned ? "Checked before a release is applied." : <>Not checked: any release in the registry is applied. {code("signing")}</>,
      where: "install",
    });
  }
  if (s.imagePolicy) {
    catalog.push({
      name: "Image sources",
      to: "/admin/images",
      tone: s.imagePolicy.exists && s.imagePolicy.allowed.length > 0 ? "ok" : "err",
      detail: !s.imagePolicy.exists ? "The cluster's image policy doesn't exist: no step can run." : s.imagePolicy.allowed.length === 0 ? "None allowed: no step can run." : `${String(s.imagePolicy.allowed.length)} allowed; the cluster refuses any other image.`,
      where: "both",
    });
  }
  if (s.install) {
    const scans = s.scans ?? [];
    const failed = scans.filter(blocksRun).length;
    const inUse = failingInUse(s).length;
    const unscanned = unscannedInUse(s).length;
    const passed = scans.filter((x) => x.status === "passed").length;
    const accepted = scans.filter((x) => x.status === "failed" && x.acceptedReason).length;
    catalog.push({
      name: "Image scans",
      to: "/admin/scans",
      tone: !s.install.scanning ? "off" : inUse > 0 ? "err" : unscanned > 0 ? "warn" : "ok",
      detail: !s.install.scanning
        ? <>Off: images run unscanned. {code("scanning.enabled")}</>
        : `On. ${String(passed)} passed, ${String(failed)} failed${failed > inUse ? ` (${inUse === 0 ? "none" : String(inUse)} in use)` : ""}, ${String(accepted)} accepted${unscanned > 0 ? `; ${String(unscanned)} in use couldn't be scanned` : ""}.`,
      where: "both",
    });
  }

  if (s.gateway) {
    integrations.push({
      name: "API gateway",
      to: "/admin/gateway",
      tone: !s.gateway.enabled ? "off" : s.gateway.closedMessage ? "warn" : "ok",
      detail: !s.gateway.enabled
        ? <>Off. {code("gateway.enabled")}</>
        : `${s.gateway.closedMessage ? "Closed" : "Open"} · ${plural(s.gateway.apis, "API")}; ${s.gateway.requests24h.toLocaleString()} requests in the last 24 hours.`,
      where: "both",
    });
  }
  if (s.chat) {
    integrations.push({
      name: "Chat agent",
      to: "/admin/chat",
      tone: s.chat.problem ? "err" : s.chat.enabled ? "ok" : "off",
      detail: s.chat.problem ? "Its settings can't be used, so it's off." : s.chat.enabled ? `On · ${s.chat.model || s.chat.provider}, ${s.chat.source === "admins" ? "set here" : "the install's"}.` : "Off.",
      where: "both",
    });
  }
  if (s.channel !== null) {
    integrations.push({
      name: "Admins' alerts",
      to: "/admin/alerts",
      tone: "ok",
      detail: s.channel ? `In the console, by email, and in ${s.channel}'s chat.` : "In the console, and by email.",
      where: "both",
    });
  }
  if (s.install) {
    integrations.push({
      name: "Log search",
      to: s.install.logs ? "/observe?tab=logs" : undefined,
      tone: s.install.logs ? "ok" : "off",
      detail: s.install.logs ? `On · the last ${String(s.install.logSearchDays)} days, in Observe.` : <>Off. {code("logs.enabled")}</>,
      where: "install",
    });
    const grafana = s.install.grafanaUrl;
    integrations.push({
      name: "Metrics",
      to: "/observe?tab=metrics",
      tone: s.install.monitoringProvider ? "ok" : "off",
      detail: s.install.monitoringProvider ? (
        <>
          On · {code(s.install.monitoringProvider)}
          {grafana ? (
            <>
              , its dashboard in{" "}
              <Link href={grafana} target="_blank" rel="noopener noreferrer">
                Grafana
              </Link>
            </>
          ) : null}
          .
        </>
      ) : (
        <>Off: only Observe&apos;s own charts. {code("monitoring")}</>
      ),
      where: "install",
    });
  }

  if (s.policies) {
    const state = policiesState(s.policies);
    const written = s.policies.filter((p) => p.applies).length;
    security.push({
      name: "Cluster policies",
      to: "/admin/policies",
      tone: state.tone,
      detail: state.tone === "ok" ? `In sync: ${String(written)} written, rewritten every few minutes.` : `${state.text}.`,
      where: "status",
    });
  }
  if (s.audit) {
    const state = auditState(s.audit);
    security.push({
      name: "Audit log copy",
      to: "/admin/audit",
      tone: state.tone,
      detail: !s.audit.enabled ? <>Off: the log is only in the console&apos;s database. {code("audit.export")}</> : <>{state.text} · {code(s.audit.destination)}{s.audit.copiedAt ? `, last copied ${when(s.audit.copiedAt)}` : ""}.</>,
      where: "install",
    });
  }
  if (s.install) {
    security.push({
      name: "Run records",
      tone: "ok",
      detail: <>{s.install.runRetentionDays > 0 ? `Kept ${String(s.install.runRetentionDays)} days.` : "Kept with no time limit."} {code("retention.executionDays")}</>,
      where: "install",
    });
  }

  return (
    <Box component="section" aria-label="Every part, and where it's set" sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 2, rowGap: 1 }}>
        <Typography variant="h6" component="h2">
          Every part, and where it&apos;s set
        </Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, fontSize: 12, color: "text.secondary" }}>
          <span><Pill tone="info">Here</Pill> in this console</span>
          <span><Pill tone="neutral">Install</Pill> vennir.yaml, then vennir apply</span>
          <span><Pill tone="neutral">Both</Pill> the install turns it on; it&apos;s run here</span>
        </Box>
      </Box>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "repeat(2, minmax(0, 1fr))" }, alignItems: "start" }}>
        <PartGroup name="People and access" parts={people} />
        <PartGroup name="Catalog and images" parts={catalog} />
        <PartGroup name="Integrations" parts={integrations} />
        <PartGroup name="Security and audit" parts={security} />
      </Box>
    </Box>
  );
}
