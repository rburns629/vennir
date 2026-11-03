// SPDX-License-Identifier: MIT
/**
 * A team's bots' keyless identities (auth/keyless.ts): which CI identity
 * signs in as which bot. The team's members see them; its maintainers add
 * and remove them, for the team's own bots only.
 */
import { Code } from "@connectrpc/connect";
import { and, eq, inArray } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import { ensureTeamMaintainer, ensureTeamMember } from "../auth/access.js";
import { identityProblem } from "../auth/keyless.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { findTeamById, findTeamByName } from "../db/queries.js";
import { botIdentities, teamMemberships, users } from "../db/schema.js";
import { ensureNotRetired } from "./retired.js";
import { ensureTeamsBot, teamBot } from "./tokens.js";

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

async function teamNamed(name: string) {
  const team = await findTeamByName(name);
  if (!team) throw new ApiError(404, "NOT_FOUND", `No team "${name}".`);
  return team;
}

/** The team's bots: ids and emails. */
async function teamBots(teamId: string) {
  return db
    .select({ id: users.id, email: users.email })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(and(eq(teamMemberships.teamId, teamId), eq(users.isBot, true)));
}

export async function listBotIdentities(caller: AuthUser | undefined, teamName: string) {
  const who = signedIn(caller);
  ensureTeamMember(who, teamName);
  const team = await teamNamed(teamName);
  const bots = await teamBots(team.id);
  const emails = new Map(bots.map((b) => [b.id, b.email]));
  const rows = bots.length > 0 ? await db.select().from(botIdentities).where(inArray(botIdentities.botId, bots.map((b) => b.id))) : [];
  return {
    identities: rows.map((r) => ({ ...r, botEmail: emails.get(r.botId) ?? "" })),
    issuers: config.keyless.issuers,
    audience: config.keyless.audience,
  };
}

/**
 * Whether another bot already signs in with an identity one token could
 * match as well as these claims (every claim they share has the same
 * value): a sign-in matching two bots is refused (keyless.ts botForToken),
 * so such a one would stop that bot's sign-ins, another team's included.
 */
async function overlapsAnotherBot(issuer: string, claims: Record<string, string>, botId: string | null): Promise<boolean> {
  const others = await db.select({ botId: botIdentities.botId, claims: botIdentities.claims }).from(botIdentities).where(eq(botIdentities.issuer, issuer));
  return others.some(
    (other) => other.botId !== botId && Object.entries(other.claims).every(([name, value]) => !(name in claims) || claims[name] === value),
  );
}

const overlapping = () =>
  new ApiError(409, "IDENTITY_OVERLAPS", "Another bot already signs in with an identity a token matching these claims would match too: name more of what the token is for (its repository, branch or environment).", Code.AlreadyExists);

export async function addBotIdentity(caller: AuthUser | undefined, teamName: string, botId: string, issuer: string, claims: Record<string, string>) {
  const who = signedIn(caller);
  ensureTeamMaintainer(who, teamName);
  const team = await teamNamed(teamName);
  ensureNotRetired(team);
  const bot = (await teamBots(team.id)).find((b) => b.id === botId);
  if (!bot) throw new ApiError(400, "BAD_IDENTITY", `That isn't one of team "${teamName}"'s bots.`);
  await ensureTeamsBot(teamName, bot.email, bot.id);
  const problem = identityProblem(issuer, claims);
  if (problem) throw new ApiError(400, "BAD_IDENTITY", problem);
  if (await overlapsAnotherBot(issuer, claims, botId)) throw overlapping();
  const [row] = await db.insert(botIdentities).values({ botId, issuer, claims, createdBy: who.id }).onConflictDoNothing().returning();
  if (!row) throw new ApiError(409, "ALREADY_EXISTS", "A bot already signs in with exactly these claims.", Code.AlreadyExists);
  return { ...row, botEmail: bot.email };
}

/**
 * A bot that signs in from CI, keyless, with no token: made (or found, as
 * CreateBotToken does) only once its identity passes the same checks
 * addBotIdentity makes, so a refused one leaves no bot behind.
 */
export async function createKeylessBot(
  caller: AuthUser | undefined,
  teamName: string,
  input: { email: string; ordering?: boolean; orderTemplates?: string[]; issuer: string; claims: Record<string, string> },
) {
  const who = signedIn(caller);
  ensureTeamMaintainer(who, teamName);
  const team = await teamNamed(teamName);
  ensureNotRetired(team);
  const problem = identityProblem(input.issuer, input.claims);
  if (problem) throw new ApiError(400, "BAD_IDENTITY", problem);
  const [taken] = await db
    .select({ id: botIdentities.id })
    .from(botIdentities)
    .where(and(eq(botIdentities.issuer, input.issuer), eq(botIdentities.claims, input.claims)));
  if (taken) throw new ApiError(409, "ALREADY_EXISTS", "A bot already signs in with exactly these claims.", Code.AlreadyExists);
  // Before any bot is made: a refused identity leaves none behind.
  if (await overlapsAnotherBot(input.issuer, input.claims, null)) throw overlapping();
  const bot = await teamBot(team, input);
  return { email: bot.email, identity: await addBotIdentity(who, teamName, bot.id, input.issuer, input.claims) };
}

export async function removeBotIdentity(caller: AuthUser | undefined, id: string): Promise<void> {
  const who = signedIn(caller);
  const [row] = await db
    .select({ id: botIdentities.id, teamId: teamMemberships.teamId })
    .from(botIdentities)
    .innerJoin(teamMemberships, eq(teamMemberships.userId, botIdentities.botId))
    .where(eq(botIdentities.id, id));
  const team = row ? await findTeamById(row.teamId) : undefined;
  if (!row || !team) throw new ApiError(404, "NOT_FOUND", "No such identity.");
  ensureTeamMaintainer(who, team.name);
  await db.delete(botIdentities).where(eq(botIdentities.id, id));
}
