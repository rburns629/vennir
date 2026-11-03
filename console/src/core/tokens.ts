// SPDX-License-Identifier: MIT
/**
 * Bots and their API tokens: the logic behind TokenService
 * (rpc/services/token.ts).
 *
 * A team's bot (db/schema.ts's users.isBot) is a maintainer of that team
 * (an ordering bot, a member that may run only its templates): only a
 * maintainer of the team (or an admin) can create one, see its tokens, or
 * revoke one. An automation token's bot belongs to no team; its scopes
 * (auth/scopes.ts) are the whole of what it can do, and only admins mint
 * or list them. Every raw token is returned once, here, and never stored
 * or shown again.
 */
import { Code } from "@connectrpc/connect";
import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import { canMaintainTeam, ensureTeamMaintainer } from "../auth/access.js";
import { generateApiToken, hashApiToken } from "../auth/apiToken.js";
import type { AuthUser } from "../auth/plugin.js";
import { ScopeSchema } from "../auth/scopes.js";
import {
  addTeamMember,
  botHasCredentials,
  createApiToken,
  createBotUser,
  findApiTokenById,
  findTeamByName,
  listAutomationTokens,
  listBotsForTeam,
  revokeApiToken,
  setOrderTemplates,
  teamNamesForUser,
  type Db,
} from "../db/queries.js";
import { db } from "../db/client.js";
import { botCallbacks } from "../db/schema.js";
import { newCallback } from "../callbacks.js";
import { ensureNotRetired } from "./retired.js";

export const BotEmail = Type.String({ format: "email" });
export const TokenLabel = Type.String({ minLength: 1 });
export const AutomationLabel = Type.String({ minLength: 1, maxLength: 100 });
export const AutomationScopes = Type.Array(ScopeSchema, { minItems: 1, uniqueItems: true });
export const TokenId = Type.String({ format: "uuid" });
/** How long a new token lasts, in days: 0 until revoked, otherwise up to two years. */
export const ExpiresInDays = Type.Integer({ minimum: 0, maximum: 730 });
/** A new token's lifetime when none is asked for. */
export const DEFAULT_TOKEN_DAYS = 90;

/** When a token made now for `days` expires: null for 0, until revoked. */
export function expiryAfter(days: number): Date | null {
  return days === 0 ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
/** A template an ordering bot may order: <team>/<name>. */
export const OrderTemplates = Type.Array(Type.String({ pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$" }), {
  maxItems: 100,
  uniqueItems: true,
});

async function teamForMaintainer(caller: AuthUser | undefined, teamName: string) {
  ensureTeamMaintainer(caller, teamName);
  const team = await findTeamByName(teamName);
  if (!team) throw new ApiError(404, "NOT_FOUND", "No such team.");
  return team;
}

/**
 * Creates a team's bot, or a new token for an existing one. A pipeline's
 * bot is a maintainer (it submits raw DAGs and retries them); an ordering
 * bot (decision 23) a member that may run only its listed templates.
 */
export async function createBotToken(
  caller: AuthUser | undefined,
  teamName: string,
  input: { email: string; label: string; ordering?: boolean; orderTemplates?: string[]; expiresInDays?: number },
) {
  const team = await teamForMaintainer(caller, teamName);
  ensureNotRetired(team);
  const bot = await teamBot(team, input);
  const rawToken = generateApiToken();
  const tokenMeta = await createApiToken(bot.id, input.label, hashApiToken(rawToken), [], expiryAfter(input.expiresInDays ?? DEFAULT_TOKEN_DAYS), caller?.id ?? null);
  return { email: bot.email, token: rawToken, tokenId: tokenMeta.id };
}

/**
 * The team's bot with this address: made if it doesn't exist, and in the
 * team, as a pipeline's bot (a maintainer) or an ordering bot (a member).
 * A bot belongs to the one team that made it: an existing one is this
 * team's only if it's in this team and no other, so no team can take
 * another's bot (or an admin's automation bot) and act as it.
 * The caller has checked the team's maintainer and that it isn't retired.
 */
export async function teamBot(team: { id: string; name: string }, input: { email: string; ordering?: boolean; orderTemplates?: string[] }) {
  // Made (or found) and put in the team in one transaction, holding the
  // account: another request for the address waits, then sees whose it is.
  return db.transaction(async (tx) => {
    const { user: bot, created } = await createBotUser(input.email, tx);
    if (!bot.isBot) {
      throw new ApiError(409, "CONFLICT", `"${input.email}" already belongs to a non-bot account.`, Code.AlreadyExists);
    }
    const teams = created ? [] : await teamNamesForUser(bot.id, tx);
    if (!created) await ensureTeamsBot(team.name, input.email, bot.id, teams, tx);
    const ordering = bot.orderTemplates !== null;
    if (input.ordering && !ordering && teams.length > 0) {
      throw new ApiError(409, "CONFLICT", `"${input.email}" is a pipeline's bot already; make an ordering bot with its own address.`, Code.AlreadyExists);
    }
    if (input.ordering || ordering) {
      if (!ordering) await setOrderTemplates(bot.id, input.orderTemplates ?? [], tx);
      await addTeamMember(bot.id, team.id, "member", tx);
    } else {
      await addTeamMember(bot.id, team.id, "maintainer", tx);
    }
    return bot;
  });
}

/**
 * Refuses a bot that isn't the team's alone. One in no team is the team's
 * only while nothing was ever made for it (a creation that stopped before
 * its membership): one with a token or identity is another's, such as an
 * admin's automation bot or a purged team's.
 */
export async function ensureTeamsBot(teamName: string, email: string, botId: string, teams?: string[], exec: Db = db): Promise<void> {
  const of = teams ?? (await teamNamesForUser(botId, exec));
  if (of.length === 1 && of[0] === teamName) return;
  if (of.length === 0 && !(await botHasCredentials(botId, exec))) return;
  throw new ApiError(409, "CONFLICT", `"${email}" is another team's bot, or was one: choose another address.`, Code.AlreadyExists);
}

/** Sets what an ordering bot of the team may order (its maintainers). */
export async function setBotOrders(caller: AuthUser | undefined, teamName: string, email: string, templates: string[]) {
  const team = await teamForMaintainer(caller, teamName);
  ensureNotRetired(team);
  const bot = (await listBotsForTeam(team.id)).find((b) => b.email === email);
  if (!bot) throw new ApiError(404, "NOT_FOUND", `No bot "${email}" in team "${teamName}".`);
  if (bot.orderTemplates === null) {
    throw new ApiError(409, "NOT_ORDERING", `"${email}" is a pipeline's bot, not an ordering bot.`, Code.FailedPrecondition);
  }
  await setOrderTemplates(bot.id, templates);
  return { templates };
}

/**
 * Sets, changes or removes (empty url) an ordering bot's callback (its
 * team's maintainers). Its signing secret is made when it's first set, or
 * rotated on request, and returned only then; changing the URL keeps it.
 */
export async function setBotCallback(
  caller: AuthUser | undefined,
  teamName: string,
  email: string,
  input: { url: string; rotateSecret: boolean },
): Promise<{ host: string; signingSecret: string }> {
  const team = await teamForMaintainer(caller, teamName);
  ensureNotRetired(team);
  const bot = (await listBotsForTeam(team.id)).find((b) => b.email === email);
  if (!bot) throw new ApiError(404, "NOT_FOUND", `No bot "${email}" in team "${teamName}".`);
  if (bot.orderTemplates === null) {
    throw new ApiError(409, "NOT_ORDERING", `"${email}" is a pipeline's bot, not an ordering bot.`, Code.FailedPrecondition);
  }
  if (input.url === "") {
    await db.delete(botCallbacks).where(eq(botCallbacks.botId, bot.id));
    return { host: "", signingSecret: "" };
  }
  const [existing] = await db.select({ secretEncrypted: botCallbacks.secretEncrypted }).from(botCallbacks).where(eq(botCallbacks.botId, bot.id));
  const { signingSecret, ...stored } = newCallback(input.url, input.rotateSecret, existing?.secretEncrypted);
  const row = { ...stored, updatedBy: caller?.id ?? null, updatedAt: new Date(), lastError: null };
  await db
    .insert(botCallbacks)
    .values({ botId: bot.id, ...row })
    .onConflictDoUpdate({ target: botCallbacks.botId, set: row });
  return { host: stored.host, signingSecret };
}

export async function listBots(caller: AuthUser | undefined, teamName: string) {
  const team = await teamForMaintainer(caller, teamName);
  return listBotsForTeam(team.id);
}

/** A maintainer of a team the token's bot belongs to may revoke it; an admin, any. */
export async function revokeToken(caller: AuthUser | undefined, tokenId: string): Promise<void> {
  const token = await findApiTokenById(tokenId);
  if (!token) throw new ApiError(404, "NOT_FOUND", "No such token.");
  const ownerTeams = await teamNamesForUser(token.userId);
  // An admin may revoke any token, a bot in no team included.
  if (!caller?.isAdmin && !ownerTeams.some((name) => canMaintainTeam(caller, name))) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Not a maintainer of any team this token's bot belongs to, and not a platform admin.",
    );
  }
  await revokeApiToken(token.id);
}

/** For platform automation such as the catalog's CI. Admins only. */
export async function createAutomationToken(
  caller: AuthUser | undefined,
  input: { label: string; scopes: string[]; expiresInDays?: number },
  log: FastifyBaseLogger | undefined,
) {
  forbiddenUnlessAdmin(caller);
  const { user: bot } = await createBotUser(`automation-${randomUUID().slice(0, 8)}@bot.internal`);
  const rawToken = generateApiToken();
  const tokenMeta = await createApiToken(
    bot.id,
    input.label,
    hashApiToken(rawToken),
    input.scopes,
    expiryAfter(input.expiresInDays ?? DEFAULT_TOKEN_DAYS),
    caller?.id ?? null,
  );
  log?.info({ tokenId: tokenMeta.id, scopes: input.scopes, createdBy: caller?.id }, "automation token created");
  return { tokenId: tokenMeta.id, label: tokenMeta.label, scopes: input.scopes, token: rawToken };
}

export async function listAutomationTokensFor(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller);
  return listAutomationTokens();
}
