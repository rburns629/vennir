// SPDX-License-Identifier: MIT
/** Thin, explicit query wrappers — no logic beyond the query itself. */
import { and, arrayContains, arrayOverlaps, count, desc, eq, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { imageRepository } from "../imageRef.js";
import { db } from "./client.js";
import {
  imageRepositories,
  teams,
  users,
  teamMemberships,
  apiTokens,
  botIdentities,
  revokedSessions,
  botCallbacks,
  products,
  productReleases,
  submittedExecutions,
  secretGrants,
  wiringTypes,
  templates,
  apis,
  catalogSync,
  schedules,
  type Approval,
  type ErrorHelp,
  type ProductCleanup,
  type ProductExample,
  type ProductResources,
  type TargetRule,
  type TeamRole,
  type TemplateStep,
} from "./schema.js";

export interface User {
  id: string;
  email: string;
  passwordHash: string | null;
  isAdmin: boolean;
  isBot: boolean;
  passwordChangedAt: Date | null;
  // A password someone else set: only changing it is allowed until then.
  mustChangePassword: boolean;
  // Its single sign-on identity, once bound (auth/oidc.ts).
  oidcSubject: string | null;
  // An ordering bot's templates (decision 23); null for anyone else.
  orderTemplates: string[] | null;
}

export async function findUserByEmail(email: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user;
}

export async function findUserById(id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function createUser(email: string, passwordHash: string | null, mustChangePassword = false): Promise<User> {
  const [user] = await db.insert(users).values({ email, passwordHash, mustChangePassword }).returning();
  if (!user) throw new Error("Insert returned no row");
  return user;
}

export async function findUserByOidcSubject(subject: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.oidcSubject, subject)).limit(1);
  return user;
}

/** Binds an account to its single sign-on identity, once: never over another. */
export async function bindOidcSubject(userId: string, subject: string): Promise<boolean> {
  const bound = await db
    .update(users)
    .set({ oidcSubject: subject })
    .where(and(eq(users.id, userId), isNull(users.oidcSubject)))
    .returning({ id: users.id });
  return bound.length === 1;
}

/** An account made at its first single sign-on: no password. */
export async function createSsoUser(email: string, subject: string): Promise<User> {
  const [user] = await db.insert(users).values({ email, oidcSubject: subject }).returning();
  if (!user) throw new Error("Insert returned no row");
  return user;
}

export async function createTeam(name: string): Promise<typeof teams.$inferSelect> {
  const [team] = await db.insert(teams).values({ name }).returning();
  if (!team) throw new Error("Insert returned no row");
  return team;
}

export interface Team {
  id: string;
  name: string;
  createdAt: Date;
  retiredAt: Date | null;
  deletedAt: Date | null;
  /** Where other teams may aim its products (targets.ts). */
  allowedTargets: TargetRule[];
  /** Where people ask when its steps fail (failureHelp.ts). */
  contact: string | null;
  /** team.yaml's owner, from the release: shown, never a grant. */
  owner: string | null;
  /** team.yaml's description, from the release. */
  description: string | null;
  helpChat: string | null;
  helpUrl: string | null;
  /** Its members sign in with single sign-on only (auth/plugin.ts's ssoRequiredBy). */
  requireSso: boolean;
  /** Its own resource limits (teamQuota.ts); null: the install's. */
  quota: { cpu: string; memory: string; pods: string; stepMemory: string } | null;
}

/** A live team: purged (deleted) teams are invisible to every route. A
 * retired team is still returned; callers that write check `retiredAt`. */
export async function findTeamByName(name: string): Promise<Team | undefined> {
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.name, name), isNull(teams.deletedAt)))
    .limit(1);
  return team;
}

/** Including purged teams. Only for "is this name taken" questions: a
 * purged team's name stays reserved (see schema.ts's teams.deletedAt). */
export async function findTeamByNameIncludingDeleted(name: string): Promise<Team | undefined> {
  const [team] = await db.select().from(teams).where(eq(teams.name, name)).limit(1);
  return team;
}

/** Also a purged team: for naming who owns something it left reserved. */
export async function findTeamByIdIncludingDeleted(id: string): Promise<Team | undefined> {
  const [team] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  return team;
}

export async function findTeamById(id: string): Promise<Team | undefined> {
  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, id), isNull(teams.deletedAt)))
    .limit(1);
  return team;
}

/** Admin-only in practice (see core/teams.ts's listTeams) -- a regular
 * member only ever learns team names through their own membership. */
export function listAllTeams(): Promise<Team[]> {
  return db.select().from(teams).where(isNull(teams.deletedAt));
}

/** Retires a team (by: who, in words) or restores it. */
export async function setTeamRetired(teamId: string, retired: boolean, by: string | null = null): Promise<void> {
  await db
    .update(teams)
    .set({ retiredAt: retired ? new Date() : null, retiredBy: retired ? by : null })
    .where(eq(teams.id, teamId));
}

/** Unregisters every product a team owns. Part of retiring it: a retired
 * platform shouldn't be offered for discovery. CI re-registers them on the
 * next push if the team is ever un-retired. */
export async function deleteProductsForTeam(teamId: string): Promise<number> {
  const deleted = await db.delete(products).where(eq(products.teamId, teamId)).returning();
  return deleted.length;
}

/** Purges a retired team in one transaction: memberships, secret grants and
 * products go, bots left belonging to no live team have their tokens
 * revoked, and the row is soft-deleted so its name stays reserved.
 * Execution history (submittedExecutions) is deliberately kept. */
export async function purgeTeam(teamId: string): Promise<{ revokedBotTokens: number }> {
  return db.transaction(async (tx) => {
    const members = await tx
      .delete(teamMemberships)
      .where(eq(teamMemberships.teamId, teamId))
      .returning({ userId: teamMemberships.userId });
    await tx.delete(secretGrants).where(eq(secretGrants.teamId, teamId));
    await tx.delete(products).where(eq(products.teamId, teamId));

    let revokedBotTokens = 0;
    for (const { userId } of members) {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user?.isBot) continue;
      const [stillMember] = await tx
        .select({ teamId: teamMemberships.teamId })
        .from(teamMemberships)
        .where(eq(teamMemberships.userId, userId))
        .limit(1);
      if (stillMember) continue;
      const revoked = await tx
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
        .returning();
      revokedBotTokens += revoked.length;
    }

    await tx.update(teams).set({ deletedAt: new Date() }).where(eq(teams.id, teamId));
    return { revokedBotTokens };
  });
}

/** Adds someone, as a maintainer unless said otherwise; someone already in
 * the team keeps the role they have. */
export async function addTeamMember(userId: string, teamId: string, role: TeamRole = "maintainer"): Promise<void> {
  await db.insert(teamMemberships).values({ userId, teamId, role }).onConflictDoNothing();
}

/** False when the user isn't a member. */
export async function setTeamMemberRole(userId: string, teamId: string, role: TeamRole): Promise<boolean> {
  const updated = await db
    .update(teamMemberships)
    .set({ role })
    .where(and(eq(teamMemberships.userId, userId), eq(teamMemberships.teamId, teamId)))
    .returning({ userId: teamMemberships.userId });
  return updated.length > 0;
}

/** False when the user wasn't a member. */
export async function removeTeamMember(userId: string, teamId: string): Promise<boolean> {
  const removed = await db
    .delete(teamMemberships)
    .where(and(eq(teamMemberships.userId, userId), eq(teamMemberships.teamId, teamId)))
    .returning({ userId: teamMemberships.userId });
  return removed.length > 0;
}

/** Also stamps passwordChangedAt, which is what revokes every session
 * issued before this call (see auth/plugin.ts). mustChange: set by someone
 * other than its owner, who must change it before doing anything else. */
export async function setUserPassword(userId: string, passwordHash: string, mustChange = false): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash, passwordChangedAt: new Date(), mustChangePassword: mustChange })
    .where(eq(users.id, userId));
}

/** A successful sign-in, with a password or single sign-on. */
export async function recordSignIn(userId: string): Promise<void> {
  await db.update(users).set({ lastSignedInAt: new Date() }).where(eq(users.id, userId));
}

export async function setUserAdmin(userId: string, isAdmin: boolean): Promise<void> {
  await db.update(users).set({ isAdmin }).where(eq(users.id, userId));
}

/** How an account signs in: a password of its own, single sign-on, or both. */
export interface SignInMethods {
  hasPassword: boolean;
  /** Bound to an identity provider's account at its first single sign-on. */
  usesSso: boolean;
}

export interface UserSummary extends SignInMethods {
  email: string;
  isAdmin: boolean;
  createdAt: Date;
  teamNames: string[];
  /** Its password was set by an admin and not changed since. */
  mustChangePassword: boolean;
  lastSignedInAt: Date | null;
}

const signInMethods = {
  hasPassword: sql<boolean>`${users.passwordHash} is not null`,
  usesSso: sql<boolean>`${users.oidcSubject} is not null`,
};

/** Every human account (bots are listed per team, see core/tokens.ts) with
 * the active teams it belongs to, for the Admin page. */
export async function listHumanUsersWithTeams(): Promise<UserSummary[]> {
  const rows = await db
    .select({
      email: users.email,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
      mustChangePassword: users.mustChangePassword,
      lastSignedInAt: users.lastSignedInAt,
      ...signInMethods,
      teamName: teams.name,
    })
    .from(users)
    .leftJoin(teamMemberships, eq(teamMemberships.userId, users.id))
    .leftJoin(teams, and(eq(teams.id, teamMemberships.teamId), isNull(teams.deletedAt)))
    .where(eq(users.isBot, false))
    .orderBy(users.email);
  const byEmail = new Map<string, UserSummary>();
  for (const row of rows) {
    const { teamName, ...account } = row;
    const summary = byEmail.get(row.email) ?? { ...account, teamNames: [] };
    if (teamName) summary.teamNames.push(teamName);
    byEmail.set(row.email, summary);
  }
  return [...byEmail.values()];
}

/** Removes the account, its memberships and its tokens (cascades). The
 * executions it submitted stay, with no submitter (see schema.ts). */
export async function deleteUser(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

/** Used to refuse revoking the last admin (core/users.ts) -- an empty
 * platform-admin set would mean nobody could ever grant it back. */
export async function countAdmins(): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(users)
    .where(eq(users.isAdmin, true));
  return row?.count ?? 0;
}

/** The names of every team a user belongs to — this, not anything baked
 * into a JWT, is the live authorization source checked on every request,
 * so a membership change takes effect immediately, not at next login. */
export async function teamNamesForUser(userId: string): Promise<string[]> {
  return (await teamRolesForUser(userId)).map((row) => row.name);
}

/** Every team a user belongs to, and as what: the same live source. */
export async function setTeamRequireSso(teamId: string, requireSso: boolean): Promise<void> {
  await db.update(teams).set({ requireSso }).where(eq(teams.id, teamId));
}

export async function teamRolesForUser(userId: string): Promise<{ name: string; role: TeamRole; requireSso: boolean }[]> {
  return db
    .select({ name: teams.name, role: teamMemberships.role, requireSso: teams.requireSso })
    .from(teamMemberships)
    .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
    .where(eq(teamMemberships.userId, userId));
}

/** Idempotent: reuses the bot user if one with this email already exists
 * (core/tokens.ts still checks it's actually a bot, not a human who
 * happens to share the email, before treating it as one). */
export async function createBotUser(email: string): Promise<User> {
  const [inserted] = await db
    .insert(users)
    .values({ email, isBot: true })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (inserted) return inserted;
  const existing = await findUserByEmail(email);
  if (!existing) throw new Error("Insert conflicted but no existing row was found");
  return existing;
}

export interface ApiTokenMeta {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

export async function createApiToken(
  userId: string,
  label: string,
  tokenHash: string,
  scopes: string[] = [],
  expiresAt: Date | null = null,
  createdBy: string | null = null,
): Promise<ApiTokenMeta> {
  const [token] = await db
    .insert(apiTokens)
    .values({ userId, label, tokenHash, scopes, expiresAt, createdBy })
    .returning();
  if (!token) throw new Error("Insert returned no row");
  return token;
}

/** Everyone who made a bot something to act with: a token, a keyless
 * identity, or a schedule that runs as it (made or last changed it). */
export async function botMakers(botId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT created_by AS id FROM ${apiTokens} WHERE user_id = ${botId} AND created_by IS NOT NULL
    UNION SELECT created_by FROM ${botIdentities} WHERE bot_id = ${botId} AND created_by IS NOT NULL
    UNION SELECT created_by FROM ${schedules} WHERE bot_id = ${botId} AND created_by IS NOT NULL
    UNION SELECT updated_by FROM ${schedules} WHERE bot_id = ${botId} AND updated_by IS NOT NULL`);
  return rows.rows.map((r) => r.id);
}

export interface AutomationToken extends ApiTokenMeta {
  botEmail: string;
  scopes: string[];
}

/** Every live automation token: a token with platform-wide scopes. Team
 * bots' tokens (no scopes) are listed per team by listBotsForTeam. */
export function listAutomationTokens(): Promise<AutomationToken[]> {
  return db
    .select({
      id: apiTokens.id,
      label: apiTokens.label,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
      scopes: apiTokens.scopes,
      botEmail: users.email,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(isNull(apiTokens.revokedAt), sql`cardinality(${apiTokens.scopes}) > 0`))
    .orderBy(desc(apiTokens.createdAt));
}

/** The only place a raw bearer token is ever turned back into an identity
 * -- see auth/plugin.ts. Revoked tokens never resolve to anything. */
/** The bot behind a live (unrevoked) API token, plus that token's own
 * scopes -- scopes belong to the token, not the bot, so revoking one
 * token never widens or narrows another. */
export async function findApiTokenPrincipal(
  tokenHash: string,
): Promise<{ user: User; scopes: string[]; tokenId: string; lastUsedAt: Date | null } | undefined> {
  const [row] = await db
    .select({
      user: users,
      scopes: apiTokens.scopes,
      tokenId: apiTokens.id,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, tokenHash),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), sql`${apiTokens.expiresAt} > now()`),
      ),
    )
    .limit(1);
  return row;
}

/** Whether a session was signed out before it expired. */
export async function isSessionRevoked(sid: string): Promise<boolean> {
  const [row] = await db.select({ sid: revokedSessions.sid }).from(revokedSessions).where(eq(revokedSessions.sid, sid)).limit(1);
  return row !== undefined;
}

/** Signs a session out, until it would have expired anyway. */
export async function revokeSession(sid: string, expiresAt: Date): Promise<void> {
  await db.insert(revokedSessions).values({ sid, expiresAt }).onConflictDoNothing();
}

/** Records that a token was just used. Coarse on purpose: the caller skips
 * this while the stored time is recent, so a busy pipeline isn't a write
 * per request. */
export async function touchApiToken(tokenId: string): Promise<void> {
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, tokenId));
}

export async function revokeApiToken(tokenId: string): Promise<void> {
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
}

export async function findApiTokenById(
  tokenId: string,
): Promise<{ id: string; userId: string; revokedAt: Date | null } | undefined> {
  const [token] = await db
    .select({ id: apiTokens.id, userId: apiTokens.userId, revokedAt: apiTokens.revokedAt })
    .from(apiTokens)
    .where(eq(apiTokens.id, tokenId))
    .limit(1);
  return token;
}

export interface BotWithTokens {
  id: string;
  email: string;
  tokens: ApiTokenMeta[];
  /** An ordering bot's templates; null for a pipeline's bot. */
  orderTemplates: string[] | null;
  /** Its order callback (callbacks.ts), if it has one. */
  callback: { host: string; lastSentAt: Date | null; lastError: string | null } | null;
}

/** N+1 on purpose -- a team realistically has a handful of bots, and this
 * reads far more plainly than a single aggregated join would. */
export async function listBotsForTeam(teamId: string): Promise<BotWithTokens[]> {
  const bots = await db
    .select({
      id: users.id,
      email: users.email,
      orderTemplates: users.orderTemplates,
      callbackHost: botCallbacks.host,
      callbackLastSentAt: botCallbacks.lastSentAt,
      callbackLastError: botCallbacks.lastError,
    })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .leftJoin(botCallbacks, eq(botCallbacks.botId, users.id))
    .where(and(eq(teamMemberships.teamId, teamId), eq(users.isBot, true)));

  const withTokens: BotWithTokens[] = [];
  for (const { callbackHost, callbackLastSentAt, callbackLastError, ...bot } of bots) {
    const callback = callbackHost === null ? null : { host: callbackHost, lastSentAt: callbackLastSentAt, lastError: callbackLastError };
    const tokens = await db
      .select({
        id: apiTokens.id,
        label: apiTokens.label,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
        expiresAt: apiTokens.expiresAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, bot.id), isNull(apiTokens.revokedAt)));
    withTokens.push({ ...bot, callback, tokens });
  }
  return withTokens;
}

export interface TeamMember extends SignInMethods {
  id: string;
  email: string;
  isBot: boolean;
  isAdmin: boolean;
  role: TeamRole;
  addedAt: Date;
  /** The single sign-on groups giving the role; null when added by hand. */
  viaGroups: string[] | null;
}

/** Human *and* bot accounts -- the Members tab shows both today (there's
 * no separate "CI/Bots" filter on this specific list; BotManagementSection
 * has its own dedicated bot view already). Ordered oldest-first so "who
 * was here from the start" reads naturally. */
export async function listMembersForTeam(teamId: string): Promise<TeamMember[]> {
  return db
    .select({
      id: users.id,
      email: users.email,
      isBot: users.isBot,
      isAdmin: users.isAdmin,
      role: teamMemberships.role,
      addedAt: teamMemberships.createdAt,
      viaGroups: teamMemberships.viaGroups,
      ...signInMethods,
    })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(eq(teamMemberships.teamId, teamId))
    .orderBy(teamMemberships.createdAt);
}

export interface Product {
  id: string;
  name: string;
  image: string;
  action: string;
  teamId: string | null;
  inputSchema: unknown;
  displayName: string | null;
  description: string | null;
  outputSchema: unknown;
  serviceAccount: string | null;
  secretRefs: string[];
  tokenAudiences: string[];
  shareWith: string[];
  hidden: boolean;
  sourcePath: string | null;
  idempotent: boolean;
  maxAttempts: number;
  concurrencyKey: string[];
  maxRunning: number;
  clouds: string[];
  cloudsFrom: string;
  capacity: string | null;
  cleanup: ProductCleanup | null;
  plan: string | null;
  check: string | null;
  examples: ProductExample[];
  approval: Approval | null;
  approvalTeams: string[];
  errorHelp: Record<string, ErrorHelp>;
  deprecated: string | null;
  resources: ProductResources | null;
  createdAt: Date;
}

export interface ProductRelease {
  image: string;
  registeredAt: Date;
}

/** A product plus its owning team's name (its platform; null for a
 * platform-provided product with no team) and its release history, newest
 * first. */
export interface ProductWithReleases extends Product {
  teamName: string | null;
  releases: ProductRelease[];
}

export interface ProductInput {
  name: string;
  image: string;
  action: string;
  teamId: string | null;
  // Each optional: left out, a new product gets the column's default and
  // an existing one keeps what it has, so a caller that doesn't send a
  // field (an older catalog CI) never wipes it.
  inputSchema?: unknown;
  displayName?: string | undefined;
  description?: string | undefined;
  outputSchema?: unknown;
  serviceAccount?: string | undefined;
  secretRefs?: string[] | undefined;
  tokenAudiences?: string[] | undefined;
  shareWith?: string[] | undefined;
  hidden?: boolean | undefined;
  sourcePath?: string | undefined;
  idempotent?: boolean | undefined;
  maxAttempts?: number | undefined;
  concurrencyKey?: string[] | undefined;
  maxRunning?: number | undefined;
  clouds?: string[] | undefined;
  cloudsFrom?: string | undefined;
  capacity?: string | null | undefined;
  cleanup?: ProductCleanup | null | undefined;
  plan?: string | null | undefined;
  check?: string | null | undefined;
  examples?: ProductExample[] | undefined;
  approval?: Approval | null | undefined;
  approvalTeams?: string[] | undefined;
  errorHelp?: Record<string, ErrorHelp> | undefined;
  deprecated?: string | null | undefined;
  resources?: ProductResources | undefined;
}

/** Registration and re-registration are the same call (see core/products.ts
 * -- CI runs this on every merge, not just the product's first ever build),
 * keyed on name. */
/**
 * A registration refused because another team (or the platform, a null
 * owner) already owns the product name or the image repository. A product
 * is its team's: no other team may take over its name, or register its
 * image repository as theirs and run that code with their own identity.
 */
export class ProductOwnershipError extends Error {
  constructor(
    readonly conflict: "name" | "repository",
    readonly ownerTeamId: string | null,
  ) {
    super(`${conflict} is owned by ${ownerTeamId ?? "the platform"}`);
    this.name = "ProductOwnershipError";
  }
}

/**
 * Registers a product, or updates one its team already registered under
 * this name. Throws ProductOwnershipError when the name or the image's
 * repository belongs to someone else. The image repository is claimed for
 * the product's team by the first registration that uses it, and stays
 * claimed after the product is deleted (see schema.ts's imageRepositories).
 */
export async function upsertProduct(input: ProductInput): Promise<Product> {
  const described = Object.fromEntries(
    Object.entries({
      inputSchema: input.inputSchema,
      displayName: input.displayName,
      description: input.description,
      outputSchema: input.outputSchema,
      serviceAccount: input.serviceAccount,
      secretRefs: input.secretRefs,
      tokenAudiences: input.tokenAudiences,
      shareWith: input.shareWith,
      hidden: input.hidden,
      sourcePath: input.sourcePath,
      idempotent: input.idempotent,
      maxAttempts: input.maxAttempts,
      concurrencyKey: input.concurrencyKey,
      maxRunning: input.maxRunning,
      clouds: input.clouds,
      cloudsFrom: input.cloudsFrom,
      capacity: input.capacity,
      cleanup: input.cleanup,
      plan: input.plan,
      check: input.check,
      examples: input.examples,
      approval: input.approval,
      approvalTeams: input.approvalTeams,
      errorHelp: input.errorHelp,
      deprecated: input.deprecated,
      resources: input.resources,
    }).filter(([, value]) => value !== undefined),
  );
  const repository = imageRepository(input.image);
  return db.transaction(async (tx) => {
    // Claims it if nobody has; then whoever has, which a concurrent first
    // registration by another team can't change underneath this one.
    await tx.insert(imageRepositories).values({ repository, teamId: input.teamId }).onConflictDoNothing();
    const [owner] = await tx
      .select({ teamId: imageRepositories.teamId })
      .from(imageRepositories)
      .where(eq(imageRepositories.repository, repository));
    if (!owner || owner.teamId !== input.teamId) {
      throw new ProductOwnershipError("repository", owner?.teamId ?? null);
    }
    // An existing name is only updated when it's this team's product, in
    // the same statement, so two teams racing for one new name can't both
    // end up thinking it's theirs.
    const [product] = await tx
      .insert(products)
      .values({ name: input.name, image: input.image, action: input.action, teamId: input.teamId, ...described })
      .onConflictDoUpdate({
        target: products.name,
        set: { image: input.image, action: input.action, ...described },
        setWhere: sql`${products.teamId} is not distinct from ${input.teamId}`,
      })
      .returning();
    if (!product) {
      const [existing] = await tx
        .select({ teamId: products.teamId })
        .from(products)
        .where(eq(products.name, input.name));
      throw new ProductOwnershipError("name", existing?.teamId ?? null);
    }
    // Record this image as a release. Re-registering an image already
    // recorded is a no-op, so a CI re-run doesn't duplicate or re-date it.
    await tx
      .insert(productReleases)
      .values({ productId: product.id, image: product.image })
      .onConflictDoNothing({ target: [productReleases.productId, productReleases.image] });
    return product;
  });
}

/**
 * Claims, for its product's team, every image repository a registered
 * product uses and nobody owns yet: products registered before
 * repositories had owners. The oldest product of a repository decides.
 * Idempotent; run at startup.
 */
export async function claimRegisteredImageRepositories(): Promise<void> {
  const registered = await db
    .select({ image: products.image, teamId: products.teamId })
    .from(products)
    .orderBy(products.createdAt);
  for (const { image, teamId } of registered) {
    if (teamId === null) {
      await db.insert(imageRepositories).values({ repository: imageRepository(image), teamId }).onConflictDoNothing();
      continue;
    }
    // The team read and locked in the same statement: one deleted since the
    // products were read (or while this runs) claims nothing.
    await db.execute(sql`
      INSERT INTO ${imageRepositories} (repository, team_id)
      SELECT ${imageRepository(image)}, ${teams.id} FROM ${teams} WHERE ${teams.id} = ${teamId} FOR KEY SHARE
      ON CONFLICT DO NOTHING`);
  }
}

export interface ImageRepositoryOwner {
  repository: string;
  teamName: string | null;
  createdAt: Date;
  /** How many registered products use it. */
  products: number;
}

export async function listImageRepositories(): Promise<ImageRepositoryOwner[]> {
  const [owners, registered] = await Promise.all([
    db
      .select({
        repository: imageRepositories.repository,
        teamName: teams.name,
        createdAt: imageRepositories.createdAt,
      })
      .from(imageRepositories)
      .leftJoin(teams, eq(teams.id, imageRepositories.teamId))
      .orderBy(imageRepositories.repository),
    db.select({ image: products.image }).from(products),
  ]);
  const uses = new Map<string, number>();
  for (const { image } of registered) {
    const repository = imageRepository(image);
    uses.set(repository, (uses.get(repository) ?? 0) + 1);
  }
  return owners.map((owner) => ({ ...owner, products: uses.get(owner.repository) ?? 0 }));
}

/**
 * Releases a repository's owner, so any team may register it next. Refused
 * ("in-use") while a registered product still uses it: delete those first.
 */
export async function releaseImageRepository(
  repository: string,
): Promise<"released" | "in-use" | "not-found"> {
  const registered = await db.select({ image: products.image }).from(products);
  if (registered.some(({ image }) => imageRepository(image) === repository)) return "in-use";
  const deleted = await db
    .delete(imageRepositories)
    .where(eq(imageRepositories.repository, repository))
    .returning({ repository: imageRepositories.repository });
  return deleted.length > 0 ? "released" : "not-found";
}

/** The products a task dispatched into this team's namespace may be: the
 * team's own and the platform's (no team). Null for a namespace with no
 * console team: only the platform's. */
export function listProductsUsableBy(teamId: string | null): Promise<Product[]> {
  const platform = isNull(products.teamId);
  return db
    .select()
    .from(products)
    .where(teamId === null ? platform : or(eq(products.teamId, teamId), platform));
}

export interface ProductIdentity {
  image: string;
  action: string;
  serviceAccount: string | null;
  tokenAudiences: string[];
  /** The owning team's name (its namespace); null for a platform product. */
  teamName: string | null;
}

/** What the cluster's identity policy needs about every product that can
 * run (productPolicy.ts): a purged team's products never match a task. */
export function listProductIdentities(): Promise<ProductIdentity[]> {
  return db
    .select({
      image: products.image,
      action: products.action,
      serviceAccount: products.serviceAccount,
      tokenAudiences: products.tokenAudiences,
      teamName: teams.name,
    })
    .from(products)
    .leftJoin(teams, eq(teams.id, products.teamId))
    .where(or(isNull(products.teamId), isNull(teams.deletedAt)))
    .orderBy(products.name);
}

export async function findProductByName(name: string): Promise<Product | undefined> {
  const [product] = await db.select().from(products).where(eq(products.name, name)).limit(1);
  return product;
}

/** Two queries, not a join: every product with its releases (newest
 * first), without repeating each product's columns once per release. */
export async function listProducts(): Promise<ProductWithReleases[]> {
  const [allProducts, allReleases] = await Promise.all([
    // The team's name comes along so the Products page can group by
    // platform for every viewer: GET /teams (the only other source of
    // names) is admin-only.
    db
      .select({ product: products, teamName: teams.name })
      .from(products)
      .leftJoin(teams, eq(teams.id, products.teamId))
      .orderBy(products.name),
    db
      .select({
        productId: productReleases.productId,
        image: productReleases.image,
        registeredAt: productReleases.registeredAt,
      })
      .from(productReleases)
      .orderBy(desc(productReleases.registeredAt)),
  ]);
  const releasesByProduct = new Map<string, ProductRelease[]>();
  for (const { productId, image, registeredAt } of allReleases) {
    const list = releasesByProduct.get(productId) ?? [];
    list.push({ image, registeredAt });
    releasesByProduct.set(productId, list);
  }
  return allProducts.map(({ product, teamName }) => ({
    ...product,
    teamName,
    releases: releasesByProduct.get(product.id) ?? [],
  }));
}

export interface WiringType {
  name: string;
  jsonType: string;
  description: string;
  shared: boolean;
  defaultProvider: string | null;
  /** The team whose types.yaml defines it; null: set by ReplaceWiringTypes. */
  team: string | null;
  updatedAt: Date;
}

export function listWiringTypes(): Promise<WiringType[]> {
  return db.select().from(wiringTypes).orderBy(wiringTypes.name);
}

/** Replaces the whole vocabulary in one transaction: what's given is all of
 * it (a catalog release's, or ReplaceWiringTypes'), so a type removed there
 * goes here too. */
export async function replaceWiringTypes(
  types: Omit<WiringType, "updatedAt">[],
): Promise<WiringType[]> {
  return db.transaction(async (tx) => {
    await tx.delete(wiringTypes);
    if (types.length === 0) return [];
    return tx.insert(wiringTypes).values(types).returning();
  });
}

export async function deleteProductByName(name: string): Promise<void> {
  await db.delete(products).where(eq(products.name, name));
}

export interface SubmittedExecution {
  executionId: string;
  teams: string[];
  /** Null once the submitter's account was deleted (history outlives it). */
  submittedBy: string | null;
  /** Who may not approve its steps, as worked out at submission (core/approvals.ts). */
  notDeciders: string[];
  name: string;
  // The exact body originally forwarded to kernel-api -- `null` only for
  // rows recorded before this column existed (see schema.ts). This is
  // what a rerun resubmits, unmodified apart from a fresh requestId.
  payload: unknown;
  /** Set for a run of a template (schema.ts): which, with what, for which team. */
  template: string | null;
  templateParameters: unknown;
  onBehalfOf: string | null;
  createdAt: Date;
}

/** Called right after kernel-api confirms the execution exists (see
 * core/executions.ts) -- this is the only record of which teams are
 * allowed to see it, since kernel-api itself has no concept of teams.
 * `onConflictDoNothing` on purpose, not a plain insert -- kernel-api's own
 * requestId handling means this can run more than once for the same
 * executionId (a resubmission with a previously-used key returns kernel's
 * original 200, same executionId, not a new one). A plain insert crashed
 * with a real, unhandled unique-constraint violation on the second call --
 * caught live, not anticipated. The row from the first, real submission is
 * already correct; a repeat call has nothing new to record. */
export async function recordSubmittedExecution(input: {
  executionId: string;
  teams: string[];
  /** Null: the console itself (readiness checks). */
  submittedBy: string | null;
  notDeciders?: string[];
  scheduleId?: string | undefined;
  name: string;
  payload: unknown;
  template?: string | undefined;
  templateParameters?: unknown;
  onBehalfOf?: string | undefined;
}): Promise<void> {
  await db.insert(submittedExecutions).values(input).onConflictDoNothing();
}

export async function findSubmittedExecution(
  executionId: string,
): Promise<SubmittedExecution | undefined> {
  const [row] = await db
    .select()
    .from(submittedExecutions)
    .where(eq(submittedExecutions.executionId, executionId))
    .limit(1);
  return row;
}

/** The executions behind a set of task pods, for labelling them on the
 * Team page: name, and each task's position in its DAG. */
export async function findSubmittedExecutions(executionIds: string[]): Promise<SubmittedExecution[]> {
  if (executionIds.length === 0) return [];
  return db
    .select()
    .from(submittedExecutions)
    .where(inArray(submittedExecutions.executionId, executionIds));
}

export type SubmittedExecutionSummary = Omit<SubmittedExecution, "payload" | "templateParameters" | "onBehalfOf" | "notDeciders">;

// Every list caller (core/executions.ts's list) only ever
// renders summary fields -- `payload` is a full stored task graph, fetched
// only where it's actually needed (findSubmittedExecution, for the detail
// page and for /rerun), so a list of many executions doesn't ship every
// one's entire DAG definition over the wire just to render a table row.
const summaryColumns = {
  executionId: submittedExecutions.executionId,
  teams: submittedExecutions.teams,
  submittedBy: submittedExecutions.submittedBy,
  name: submittedExecutions.name,
  createdAt: submittedExecutions.createdAt,
  template: submittedExecutions.template,
};

export interface ExecutionPageQuery {
  /** Only executions sharing one of these teams, or submitted by visibleToUser; null for every execution (an admin). */
  visibleTo: string[] | null;
  /** Whose own runs are visible too, whatever their teams. */
  visibleToUser?: string | undefined;
  limit: number;
  /** A previous page's `nextCursor`. */
  cursor?: string | undefined;
  since?: Date | undefined;
  /** Only executions this team is part of. */
  team?: string | undefined;
  /** Part of the name, any case. */
  search?: string | undefined;
  /** Only this account's own runs. */
  submittedBy?: string | undefined;
}

export interface ExecutionPage {
  /** With the submitter's email (null once that account is deleted) and the schedule that started it (null when none did, or it's deleted). */
  rows: (SubmittedExecutionSummary & { submittedByEmail: string | null; scheduleName: string | null })[];
  /** Where the next page starts; null on the last page. */
  nextCursor: string | null;
}

/** Thrown for a cursor this function didn't produce. */
export class InvalidCursorError extends Error {}

const CURSOR_SEPARATOR = "|";

/**
 * Executions newest first, one page at a time. The cursor is the last row's
 * (created_at, execution_id), with the time as Postgres's own text: a JS Date
 * would round its microseconds and skip or repeat rows at a page boundary.
 */
export async function listSubmittedExecutionsPage(query: ExecutionPageQuery): Promise<ExecutionPage> {
  const conditions = [];
  if (query.visibleTo !== null) {
    const ownRuns = query.visibleToUser ? eq(submittedExecutions.submittedBy, query.visibleToUser) : undefined;
    if (query.visibleTo.length === 0 && !ownRuns) return { rows: [], nextCursor: null };
    const teamRuns = query.visibleTo.length > 0 ? arrayOverlaps(submittedExecutions.teams, query.visibleTo) : undefined;
    conditions.push(or(teamRuns, ownRuns));
  }
  if (query.team) conditions.push(arrayContains(submittedExecutions.teams, [query.team]));
  if (query.submittedBy) conditions.push(eq(submittedExecutions.submittedBy, query.submittedBy));
  if (query.since) conditions.push(gte(submittedExecutions.createdAt, query.since));
  if (query.search) {
    const escaped = query.search.replace(/[\\%_]/g, (c) => `\\${c}`);
    conditions.push(ilike(submittedExecutions.name, `%${escaped}%`));
  }
  if (query.cursor) {
    const [time, id] = query.cursor.split(CURSOR_SEPARATOR);
    if (!time || !id || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(Date.parse(time))) {
      throw new InvalidCursorError("Not a cursor from this list.");
    }
    conditions.push(
      sql`(${submittedExecutions.createdAt}, ${submittedExecutions.executionId}) < (${time}::timestamptz, ${id}::uuid)`,
    );
  }
  const rows = await db
    .select({ ...summaryColumns, submittedByEmail: users.email, scheduleName: schedules.name, cursorTime: sql<string>`${submittedExecutions.createdAt}::text` })
    .from(submittedExecutions)
    .leftJoin(users, eq(users.id, submittedExecutions.submittedBy))
    .leftJoin(schedules, eq(schedules.id, submittedExecutions.scheduleId))
    .where(and(...conditions))
    .orderBy(desc(submittedExecutions.createdAt), desc(submittedExecutions.executionId))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    rows: page.map((row) => ({
      executionId: row.executionId,
      teams: row.teams,
      submittedBy: row.submittedBy,
      submittedByEmail: row.submittedByEmail,
      scheduleName: row.scheduleName,
      name: row.name,
      createdAt: row.createdAt,
      template: row.template,
    })),
    nextCursor: rows.length > query.limit && last ? `${last.cursorTime}${CURSOR_SEPARATOR}${last.executionId}` : null,
  };
}

/** The name of the schedule that started a run; null when none did, or it's deleted. */
export async function scheduleThatStarted(executionId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: schedules.name })
    .from(submittedExecutions)
    .innerJoin(schedules, eq(schedules.id, submittedExecutions.scheduleId))
    .where(eq(submittedExecutions.executionId, executionId));
  return row?.name ?? null;
}

/** Executions visible to a non-admin: any execution with at least one
 * task belonging to a team they're a member of (the `&&` array-overlap
 * operator, not equality -- a caller only needs to share one team with a
 * multi-team DAG, not own all of it). */
export function listSubmittedExecutionsForTeams(
  teamNames: string[],
): Promise<SubmittedExecutionSummary[]> {
  if (teamNames.length === 0) return Promise.resolve([]);
  return db
    .select(summaryColumns)
    .from(submittedExecutions)
    .where(arrayOverlaps(submittedExecutions.teams, teamNames))
    .orderBy(desc(submittedExecutions.createdAt));
}

/** Platform-wide counts for the admin home view (core/admin.ts) --
 * server-side aggregates, not "fetch the full list and take .length,"
 * since a non-admin never has a reason to pull every row in these tables
 * just to render a number. */
export async function countTeams(): Promise<number> {
  const [row] = await db.select({ count: count() }).from(teams).where(isNull(teams.deletedAt));
  return row?.count ?? 0;
}

export async function countUsers(): Promise<number> {
  const [row] = await db.select({ count: count() }).from(users);
  return row?.count ?? 0;
}

export async function countProducts(): Promise<number> {
  const [row] = await db.select({ count: count() }).from(products);
  return row?.count ?? 0;
}

export async function countSubmittedExecutions(): Promise<number> {
  const [row] = await db.select({ count: count() }).from(submittedExecutions);
  return row?.count ?? 0;
}

export type SecretGrantSource = "literal" | "external";

export interface SecretGrantRecord {
  id: string;
  teamId: string;
  secretName: string;
  keys: string[];
  source: SecretGrantSource;
  createdAt: Date;
  updatedAt: Date;
}

/** Called right after k8s.ts's upsertSecretGrant/upsertExternalSecretGrant
 * actually provisions the Secret or ExternalSecret (see
 * core/secrets.ts) -- records what was granted, never the values.
 * Upsert on (teamId, secretName): re-registering the same secret
 * (rotation, or switching source) updates this row instead of creating a
 * second one, matching upsertSecretGrant's own create-or-replace
 * semantics. */
export async function recordSecretGrant(input: {
  teamId: string;
  secretName: string;
  keys: string[];
  source: SecretGrantSource;
}): Promise<SecretGrantRecord> {
  const now = new Date();
  const [row] = await db
    .insert(secretGrants)
    .values({ ...input, updatedAt: now })
    .onConflictDoUpdate({
      target: [secretGrants.teamId, secretGrants.secretName],
      set: {
        keys: input.keys,
        source: input.source,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("Insert returned no row");
  return row as SecretGrantRecord;
}

export async function deleteSecretGrantRecord(teamId: string, secretName: string): Promise<void> {
  await db.delete(secretGrants).where(and(eq(secretGrants.teamId, teamId), eq(secretGrants.secretName, secretName)));
}

export async function listSecretGrantsForTeam(teamId: string): Promise<SecretGrantRecord[]> {
  const rows = await db
    .select()
    .from(secretGrants)
    .where(eq(secretGrants.teamId, teamId))
    .orderBy(desc(secretGrants.updatedAt));
  return rows as SecretGrantRecord[];
}

/** Whether a team registered this secret: what a task's secretRefs may
 * name (core/executions.ts). The kernel mounts whatever Secret name it's
 * given, with no notion of teams, so this is where that's decided. */
export async function isSecretRegistered(teamId: string, secretName: string): Promise<boolean> {
  const [row] = await db
    .select({ id: secretGrants.id })
    .from(secretGrants)
    .where(and(eq(secretGrants.teamId, teamId), eq(secretGrants.secretName, secretName)))
    .limit(1);
  return row !== undefined;
}

/** Every team's registered secret names, for the identity policy
 * (productPolicy.ts); a purged team's never match a task. */
export function listTeamSecretNames(): Promise<{ teamName: string; secretName: string }[]> {
  return db
    .select({ teamName: teams.name, secretName: secretGrants.secretName })
    .from(secretGrants)
    .innerJoin(teams, eq(teams.id, secretGrants.teamId))
    .where(isNull(teams.deletedAt))
    .orderBy(teams.name, secretGrants.secretName);
}

/** Every registered secret, for removing the per-secret Roles the console
 * used to create (k8s.ts's removeLegacySecretRoles). */
export function listAllSecretGrants(): Promise<{ teamName: string; secretName: string }[]> {
  return db
    .select({ teamName: teams.name, secretName: secretGrants.secretName })
    .from(secretGrants)
    .innerJoin(teams, eq(teams.id, secretGrants.teamId));
}

/** A template with its team's name (schema.ts's templates). */
export interface TemplateRow {
  id: string;
  teamId: string;
  teamName: string;
  name: string;
  displayName: string;
  description: string;
  parameters: unknown;
  steps: TemplateStep[];
  shareWith: string[];
  hidden: boolean;
  sourcePath: string | null;
  deprecated: string | null;
  /** Ways to run it, from its file: a name and its parameters (as inputs). */
  examples: ProductExample[];
}

const templateColumns = {
  id: templates.id,
  teamId: templates.teamId,
  teamName: teams.name,
  name: templates.name,
  displayName: templates.displayName,
  description: templates.description,
  parameters: templates.parameters,
  steps: templates.steps,
  shareWith: templates.shareWith,
  hidden: templates.hidden,
  sourcePath: templates.sourcePath,
  deprecated: templates.deprecated,
  examples: templates.examples,
};

/** Every template of a team that's neither retired nor purged: what can run. */
export function listRunnableTemplates(): Promise<TemplateRow[]> {
  return db
    .select(templateColumns)
    .from(templates)
    .innerJoin(teams, eq(teams.id, templates.teamId))
    .where(and(isNull(teams.retiredAt), isNull(teams.deletedAt)))
    .orderBy(teams.name, templates.name);
}

export async function findRunnableTemplate(teamName: string, name: string): Promise<TemplateRow | undefined> {
  const [row] = await db
    .select(templateColumns)
    .from(templates)
    .innerJoin(teams, eq(teams.id, templates.teamId))
    .where(and(eq(teams.name, teamName), eq(templates.name, name), isNull(teams.retiredAt), isNull(teams.deletedAt)));
  return row;
}

/** Stores a template as a catalog release has it, keyed on its team and name.
 * Left out, it's listed and its file isn't known. */
export async function upsertTemplate(
  input: Omit<TemplateRow, "id" | "teamName" | "hidden" | "sourcePath" | "examples"> & Partial<Pick<TemplateRow, "hidden" | "sourcePath" | "examples">>,
): Promise<void> {
  const { teamId, name, ...rest } = input;
  await db
    .insert(templates)
    .values({ teamId, name, ...rest })
    .onConflictDoUpdate({ target: [templates.teamId, templates.name], set: { ...rest, updatedAt: new Date() } });
}

/** Removes every template of a team the catalog made but these ("<team id>/<name>"); returns how many went. */
export async function deleteTemplatesExcept(keep: Set<string>): Promise<number> {
  const all = await db
    .select({ id: templates.id, teamId: templates.teamId, name: templates.name })
    .from(templates)
    .innerJoin(teams, eq(teams.id, templates.teamId))
    .where(eq(teams.fromCatalog, true));
  const gone = all.filter((t) => !keep.has(`${t.teamId}/${t.name}`)).map((t) => t.id);
  if (gone.length > 0) await db.delete(templates).where(inArray(templates.id, gone));
  return gone.length;
}

/** A product and its team's name, by its registered name, if its team can run it. */
export async function findRunnableProduct(name: string): Promise<(Product & { teamName: string }) | undefined> {
  const [row] = await db
    .select({ product: products, teamName: teams.name })
    .from(products)
    .innerJoin(teams, eq(teams.id, products.teamId))
    .where(and(eq(products.name, name), isNull(teams.retiredAt), isNull(teams.deletedAt)));
  return row ? { ...row.product, teamName: row.teamName } : undefined;
}

/** Every team's product whose team can run it (platform products have no namespace of their own). */
export async function listRunnableProducts(): Promise<(Product & { teamName: string })[]> {
  const rows = await db
    .select({ product: products, teamName: teams.name })
    .from(products)
    .innerJoin(teams, eq(teams.id, products.teamId))
    .where(and(isNull(teams.retiredAt), isNull(teams.deletedAt)))
    .orderBy(products.name);
  return rows.map((row) => ({ ...row.product, teamName: row.teamName }));
}

/** The catalog repository the last applied release came from
 * ("github.com/<owner>/<repo>"), or null before any release. */
export async function catalogRepository(): Promise<string | null> {
  const [row] = await db.select({ repository: catalogSync.repository }).from(catalogSync).limit(1);
  return row?.repository ?? null;
}

export type ApiRow = typeof apis.$inferSelect;

/** Stores an API as the catalog's release has it, keeping whether it's paused. */
export async function upsertApi(
  input: Omit<typeof apis.$inferInsert, "id" | "pausedMessage" | "pausedBy" | "updatedAt">,
): Promise<void> {
  const { teamId, name, ...rest } = input;
  await db
    .insert(apis)
    .values({ teamId, name, ...rest })
    .onConflictDoUpdate({ target: [apis.teamId, apis.name], set: { ...rest, updatedAt: new Date() } });
}

/** Removes every API of these teams but those kept ("<team id>/<name>"); returns how many went. */
export async function deleteApisExcept(teamIds: string[], keep: Set<string>): Promise<number> {
  if (teamIds.length === 0) return 0;
  const all = await db
    .select({ id: apis.id, teamId: apis.teamId, name: apis.name })
    .from(apis)
    .where(inArray(apis.teamId, teamIds));
  const gone = all.filter((a) => !keep.has(`${a.teamId}/${a.name}`)).map((a) => a.id);
  if (gone.length > 0) await db.delete(apis).where(inArray(apis.id, gone));
  return gone.length;
}

/** Every API whose team isn't retired or purged, with its team's name. */
export async function listLiveTeamApis(): Promise<(ApiRow & { teamName: string })[]> {
  const rows = await db
    .select({ api: apis, teamName: teams.name })
    .from(apis)
    .innerJoin(teams, eq(teams.id, apis.teamId))
    .where(and(isNull(teams.retiredAt), isNull(teams.deletedAt)))
    .orderBy(teams.name, apis.name);
  return rows.map((r) => ({ ...r.api, teamName: r.teamName }));
}

/** One API by team and name. */
export async function findApi(team: string, name: string): Promise<(ApiRow & { teamName: string }) | undefined> {
  const [row] = await db
    .select({ api: apis, teamName: teams.name })
    .from(apis)
    .innerJoin(teams, eq(teams.id, apis.teamId))
    .where(and(eq(teams.name, team), eq(apis.name, name), isNull(teams.retiredAt), isNull(teams.deletedAt)));
  return row ? { ...row.api, teamName: row.teamName } : undefined;
}

/** Pauses an API (a message) or resumes it (null). */
export async function setApiPaused(id: string, message: string | null, by: string | null): Promise<void> {
  await db.update(apis).set({ pausedMessage: message, pausedBy: message === null ? null : by, updatedAt: new Date() }).where(eq(apis.id, id));
}

/** A run to look at again for what it made or deleted (resourceRecorder.ts), once it finishes. */
export async function markResourcesUnrecorded(executionId: string): Promise<void> {
  await db.update(submittedExecutions).set({ resourcesRecordedAt: null }).where(eq(submittedExecutions.executionId, executionId));
}

/** An ordering bot's templates (decision 23): the only ones it may run. */
export async function setOrderTemplates(userId: string, templates: string[]): Promise<void> {
  await db.update(users).set({ orderTemplates: templates }).where(and(eq(users.id, userId), eq(users.isBot, true)));
}
