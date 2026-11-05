// SPDX-License-Identifier: MIT
/**
 * People's accounts, for admins: the logic behind UserService
 * (rpc/services/user.ts). Admin-only both
 * ways, deliberately with no self-service path (unlike team membership),
 * since admin is a platform-wide capability, not something scoped to what
 * the granter already owns.
 */
import { currentSso } from "../sso.js";
import { Code } from "@connectrpc/connect";
import { randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyBaseLogger } from "fastify";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { hashPassword } from "../auth/password.js";
import {
  addTeamMember,
  countAdmins,
  createUser,
  deleteUser,
  findTeamByName,
  findUserByEmail,
  listHumanUsersWithTeams,
  setUserAdmin,
  setUserPassword,
} from "../db/queries.js";

export const Email = Type.String({ format: "email" });
export const AccountTeams = Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 });

/** Every human account and its teams, for the Admin page. */
export async function listAccounts(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller);
  return listHumanUsersWithTeams();
}

/**
 * How accounts are made while open registration is off (see config.ts): an
 * admin creates one, already in its teams, and gets back a temporary
 * password, shown exactly once (never stored or logged in the clear, same
 * as an API token). The admin hands it over out of band and the person
 * changes it after signing in.
 */
export async function createAccount(
  caller: AuthUser | undefined,
  input: { email: string; teams: string[]; admin: boolean },
  log: FastifyBaseLogger | undefined,
) {
  forbiddenUnlessAdmin(caller);
  const email = input.email.toLowerCase();
  if (await findUserByEmail(email)) {
    throw new ApiError(409, "CONFLICT", `An account for ${email} already exists.`, Code.AlreadyExists);
  }
  // Every team checked before anything is created, so a typo can't leave a
  // half-made account behind.
  const teamIds: string[] = [];
  let teamsRequireSso = false;
  for (const name of [...new Set(input.teams)]) {
    const team = await findTeamByName(name);
    if (!team) throw new ApiError(400, "BAD_REQUEST", `No team named "${name}".`);
    if (team.retiredAt) {
      throw new ApiError(409, "TEAM_RETIRED", `Team "${name}" is retired, so nobody new can join it.`);
    }
    teamIds.push(team.id);
    teamsRequireSso ||= team.requireSso;
  }

  // No password for someone whose team requires single sign-on: they sign in
  // with the provider as this email, which binds the account to them then.
  const ssoOnly = currentSso() && !input.admin && teamsRequireSso;
  const temporaryPassword = ssoOnly ? "" : randomBytes(18).toString("base64url");
  // Whoever receives a temporary password must change it first.
  const user = await createUser(email, temporaryPassword ? await hashPassword(temporaryPassword) : null, temporaryPassword !== "");
  // A maintainer: often a new team's first person, who must be able to
  // manage it. Its maintainers can make them a member afterwards.
  for (const teamId of teamIds) await addTeamMember(user.id, teamId, "maintainer");
  if (input.admin) await setUserAdmin(user.id, true);
  log?.warn(
    { event: "account_created", userId: user.id, by: caller?.id, teams: input.teams, admin: input.admin },
    "account created by admin",
  );
  return { email, temporaryPassword, teams: input.teams, admin: input.admin };
}

/**
 * Deletes an account: its memberships and tokens go with it, but the
 * executions it submitted stay (their submitter shows as a deleted
 * account). Not for bots (revoke their tokens on the team page), not your
 * own account, and never the last admin.
 */
export async function deleteAccount(
  caller: AuthUser | undefined,
  email: string,
  log: FastifyBaseLogger | undefined,
): Promise<void> {
  forbiddenUnlessAdmin(caller);
  const user = await findUserByEmail(email.toLowerCase());
  if (!user) throw new ApiError(404, "NOT_FOUND", "No such user.");
  if (user.id === caller?.id) throw new ApiError(409, "CONFLICT", "You can't delete your own account.");
  if (user.isBot) throw new ApiError(400, "BAD_REQUEST", "Bot accounts are managed on their team's page.");
  if (user.isAdmin && (await countAdmins()) <= 1) {
    throw new ApiError(409, "CONFLICT", "Cannot delete the last remaining admin.");
  }
  await deleteUser(user.id);
  log?.warn({ event: "account_deleted", userId: user.id, email: user.email, by: caller?.id }, "account deleted by admin");
}

/** Grants or revokes admin. Never to a bot, and never revokes the last admin: nobody could grant it back. */
export async function setAdmin(caller: AuthUser | undefined, email: string, admin: boolean): Promise<void> {
  forbiddenUnlessAdmin(caller);
  const user = await findUserByEmail(email);
  if (!user) throw new ApiError(404, "NOT_FOUND", "No such user.");
  // A bot acts unattended on a credential anyone holding it can use: it's
  // never an admin (auth/plugin.ts resolves one as no admin either).
  if (admin && user.isBot) throw new ApiError(400, "BAD_REQUEST", "A bot can't be an admin.");
  // A bot's flag never made it an admin, so clearing one never leaves none.
  if (!admin && user.isAdmin && !user.isBot && (await countAdmins()) <= 1) {
    throw new ApiError(409, "CONFLICT", "Cannot revoke the last remaining admin.");
  }
  await setUserAdmin(user.id, admin);
}

/**
 * An admin's reset of someone's password, for a forgotten one (there's no
 * email-based reset). The admin passes it on out of band, and the person
 * should change it themselves. Every existing session of theirs is revoked
 * (auth/plugin.ts). Bots have no password: they use revocable API tokens.
 */
export async function resetPassword(
  caller: AuthUser | undefined,
  email: string,
  newPassword: string,
  log: FastifyBaseLogger | undefined,
): Promise<void> {
  forbiddenUnlessAdmin(caller);
  const user = await findUserByEmail(email);
  if (!user) throw new ApiError(404, "NOT_FOUND", "No such user.");
  if (user.isBot) {
    throw new ApiError(
      400,
      "BAD_REQUEST",
      "Bot accounts have no password -- revoke and reissue their API token instead.",
    );
  }
  // Someone else's: its owner must change it first. An admin's own: theirs.
  await setUserPassword(user.id, await hashPassword(newPassword), user.id !== caller?.id);
  log?.info({ targetUserId: user.id, resetBy: caller?.id }, "password reset by admin");
}
