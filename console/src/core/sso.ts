// SPDX-License-Identifier: MIT
/**
 * SsoService: single sign-on as admins set it up (sso.ts uses it). The
 * provider is optional, and set here unless the install set one (then it's
 * read-only here); where groups come from, and which group makes whom a
 * member of which team, are always admins'. Saving a provider reads its
 * discovery document first, so a typo is refused rather than locking the
 * sign-in button onto a provider that doesn't answer. The client secret is
 * write-only: kept sealed, never sent back. Admins only.
 */
import type { FastifyBaseLogger } from "fastify";
import { asc, eq, isNull } from "drizzle-orm";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { findTeamByName } from "../db/queries.js";
import { ssoGroupMappings, ssoSettings, teams, users, type TeamRole } from "../db/schema.js";
import { seal } from "../sealed.js";
import { googleIdentity, markFollowingGroups, refreshSso, SECRET_PURPOSE } from "../sso.js";

const REQUIRES_ADMIN = "Requires admin access.";
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const CLAIM = /^[A-Za-z0-9_:/.-]{0,100}$/;

export interface SsoSettingsView {
  enabled: boolean;
  setByInstall: boolean;
  issuer: string;
  clientId: string;
  clientSecretSet: boolean;
  redirectUrl: string;
  allowedDomains: string[];
  label: string;
  groupsClaim: string;
  googleGroups: boolean;
  updatedBy: string;
  updatedAt: Date | null;
  googleIdentity: string;
}

export interface SsoSettingsInput {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  allowedDomains: string[];
  label: string;
  groupsClaim: string;
  googleGroups: boolean;
}

const bad = (message: string) => new ApiError(400, "BAD_SSO_SETTINGS", message);

export async function getSsoSettings(caller: AuthUser | undefined): Promise<SsoSettingsView> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const [row] = await db
    .select({ settings: ssoSettings, updatedBy: users.email })
    .from(ssoSettings)
    .leftJoin(users, eq(users.id, ssoSettings.updatedBy))
    .where(eq(ssoSettings.id, 1));
  const s = row?.settings;
  const install = config.oidc;
  return {
    enabled: install ? true : (s?.enabled ?? false),
    setByInstall: install !== null,
    issuer: install?.issuer ?? s?.issuer ?? "",
    clientId: install?.clientId ?? s?.clientId ?? "",
    clientSecretSet: install ? true : Boolean(s?.clientSecretEncrypted),
    // A new provider's, from where this console is reached.
    redirectUrl: install?.redirectUrl ?? (s?.redirectUrl || (config.consoleUrl ? `${config.consoleUrl}/api/auth/oidc/callback` : "")),
    allowedDomains: install?.allowedDomains ?? s?.allowedDomains ?? [],
    label: install?.label ?? s?.label ?? "",
    groupsClaim: s?.groupsClaim ?? "",
    googleGroups: s?.googleGroups ?? false,
    updatedBy: row?.updatedBy ?? "",
    updatedAt: s?.updatedAt ?? null,
    googleIdentity: await googleIdentity(),
  };
}

/** Refuses an issuer whose discovery document can't be read, or names another issuer. */
async function checkIssuer(issuer: string): Promise<void> {
  let found: string | undefined;
  try {
    const response = await fetch(new URL(".well-known/openid-configuration", issuer.replace(/\/?$/, "/")), { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`it answered ${String(response.status)}`);
    found = ((await response.json()) as { issuer?: string }).issuer;
  } catch (error) {
    throw new ApiError(400, "SSO_ISSUER_UNREACHABLE", `Couldn't read ${issuer}'s discovery document: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (found !== issuer) throw new ApiError(400, "SSO_ISSUER_UNREACHABLE", `${issuer}'s discovery document names another issuer (${String(found)}).`);
}

export async function setSsoSettings(caller: AuthUser | undefined, input: SsoSettingsInput, log: FastifyBaseLogger): Promise<SsoSettingsView> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  if (!CLAIM.test(input.groupsClaim)) throw bad("A groups claim is a claim's name, such as groups.");
  const groups = { groupsClaim: input.groupsClaim, googleGroups: input.googleGroups };
  const [stored] = await db.select().from(ssoSettings).where(eq(ssoSettings.id, 1));

  let provider: Partial<typeof ssoSettings.$inferInsert> = {};
  if (config.oidc) {
    if (input.issuer || input.clientId || input.clientSecret || input.redirectUrl || input.allowedDomains.length > 0 || input.label) {
      throw new ApiError(409, "SSO_SET_BY_INSTALL", "This install sets its single sign-on provider (the console chart's sso): change it there.", undefined);
    }
  } else {
    const domains = [...new Set(input.allowedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
    if (input.enabled) {
      if (!/^https:\/\/[^/]+(\/.*)?$/.test(input.issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(input.issuer)) {
        throw bad("The issuer is the provider's https:// URL, such as https://accounts.google.com.");
      }
      if (!input.clientId) throw bad("The client ID is needed.");
      if (!input.clientSecret && !stored?.clientSecretEncrypted) throw bad("The client secret is needed.");
      if (!/^https?:\/\/[^/]+\/api\/auth\/oidc\/callback$/.test(input.redirectUrl)) {
        throw bad("The redirect URL is the console's own <scheme>://<host>/api/auth/oidc/callback.");
      }
      if (domains.length === 0 || !domains.every((d) => DOMAIN.test(d))) {
        throw bad("At least one email domain, such as example.com, whose accounts may sign in.");
      }
      if (input.label.length > 40) throw bad("The button's name is at most 40 characters.");
      await checkIssuer(input.issuer);
    }
    provider = {
      enabled: input.enabled,
      issuer: input.issuer,
      clientId: input.clientId,
      redirectUrl: input.redirectUrl,
      allowedDomains: domains,
      label: input.label,
      ...(input.clientSecret ? { clientSecretEncrypted: seal(input.clientSecret, SECRET_PURPOSE) } : {}),
    };
  }
  const values = { ...provider, ...groups, updatedBy: caller?.id ?? null, updatedAt: new Date() };
  await db.insert(ssoSettings).values({ id: 1, ...values }).onConflictDoUpdate({ target: ssoSettings.id, set: values });
  log.warn(
    { event: "sso_settings_changed", by: caller?.id, enabled: input.enabled, issuer: input.issuer, groupsClaim: input.groupsClaim, googleGroups: input.googleGroups, secretChanged: Boolean(input.clientSecret) },
    "single sign-on settings changed",
  );
  await refreshSso(log);
  return getSsoSettings(caller);
}

export interface SsoGroupMappingView {
  id: string;
  group: string;
  team: string;
  role: TeamRole;
}

export async function listSsoGroupMappings(caller: AuthUser | undefined): Promise<SsoGroupMappingView[]> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  return db
    .select({ id: ssoGroupMappings.id, group: ssoGroupMappings.groupName, team: teams.name, role: ssoGroupMappings.role })
    .from(ssoGroupMappings)
    .innerJoin(teams, eq(teams.id, ssoGroupMappings.teamId))
    // A purged team's are deleted with it; one left from before isn't shown.
    .where(isNull(teams.deletedAt))
    .orderBy(asc(ssoGroupMappings.groupName), asc(teams.name));
}

export async function setSsoGroupMapping(
  caller: AuthUser | undefined,
  input: { group: string; team: string; role: TeamRole },
  log: FastifyBaseLogger,
): Promise<SsoGroupMappingView> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  // Compared without case at sign-in (sso.ts), so kept that way.
  const group = input.group.trim().toLowerCase();
  if (!group || group.length > 256) throw bad("A group is its name or ID as the provider sends it, or a Google group's email.");
  const team = await findTeamByName(input.team);
  if (!team) throw new ApiError(404, "NOT_FOUND", `No team "${input.team}".`);
  if (team.retiredAt) throw new ApiError(409, "TEAM_RETIRED", `Team "${team.name}" is retired.`);
  const [row] = await db
    .insert(ssoGroupMappings)
    .values({ groupName: group, teamId: team.id, role: input.role, createdBy: caller?.id ?? null })
    .onConflictDoUpdate({ target: [ssoGroupMappings.groupName, ssoGroupMappings.teamId], set: { role: input.role } })
    .returning();
  await markFollowingGroups(team.id);
  log.warn({ event: "sso_group_mapped", by: caller?.id, group, team: team.name, role: input.role }, "single sign-on group mapped to a team");
  return { id: row?.id ?? "", group, team: team.name, role: input.role };
}

export async function deleteSsoGroupMapping(caller: AuthUser | undefined, id: string, log: FastifyBaseLogger): Promise<void> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const [gone] = await db.delete(ssoGroupMappings).where(eq(ssoGroupMappings.id, id)).returning();
  if (!gone) throw new ApiError(404, "NOT_FOUND", "No such mapping.");
  log.warn({ event: "sso_group_unmapped", by: caller?.id, group: gone.groupName, teamId: gone.teamId }, "single sign-on group unmapped");
}
