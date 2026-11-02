// SPDX-License-Identifier: MIT
/**
 * AuthService (proto/vertra/console/v1/auth.proto): signing in, and who
 * you are. The same rules as rpc/services/auth.ts and rpc/services/auth.ts, which it
 * replaces: open registration only when allowed, sign-in limited per
 * client and email and spaced out per account, the same failure (and
 * timing) whether an email has an account or the password is wrong, and a
 * password change that signs out every other session.
 */
import { currentSso } from "../../sso.js";
import { Code, type ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { loginWaitSeconds, recordLoginFailure, recordLoginSuccess } from "../../auth/loginThrottle.js";
import { hashPassword, NewPassword, verifyAgainstNothing, verifyPassword } from "../../auth/password.js";
import { config } from "../../config.js";
import { createUser, findUserByEmail, findUserById, recordSignIn, revokeSession, setUserPassword, teamRolesForUser } from "../../db/queries.js";
import { newSession, ssoRequiredBy } from "../../auth/plugin.js";
import type { AuthService } from "../../gen/vertra/console/v1/auth_pb.js";
import { callerOf, kClientIp, kSignedIn, logOf } from "../context.js";
import { badRequest, forbidden, rpcError, unauthenticated } from "../errors.js";
import { FixedWindowLimit } from "../rateLimit.js";
import { botForToken } from "../../auth/keyless.js";
import { timestamp } from "../convert.js";
import { check } from "../validate.js";

const Email = Type.String({ format: "email" });
const AnyPassword = Type.String({ minLength: 1 });

const MINUTE = 60 * 1000;
// Keyed on client and email together: per client alone would be one
// global limit behind a load balancer that hides clients; per email alone
// would let anyone lock a known account out (rpc/services/auth.ts has the rest).
const loginLimit = new FixedWindowLimit(10, 15 * MINUTE);
const exchangeLimit = new FixedWindowLimit(60, 15 * MINUTE);
/** How long a keyless bot's session lasts: about a CI job. */
const KEYLESS_SESSION_SECONDS = 3600;
const registerLimit = new FixedWindowLimit(20, 60 * MINUTE);
const passwordChangeLimit = new FixedWindowLimit(10, 15 * MINUTE);

export function authService(app: FastifyInstance): ServiceImpl<typeof AuthService> {
  return {
    getEnvironment() {
      return {
        label: config.environmentLabel,
        selfRegistration: config.allowSelfRegistration,
        ssoLabel: currentSso()?.label ?? "",
        cloud: config.installCloud,
      };
    },

    async register(req, ctx) {
      await registerLimit.take(`register:${ctx.values.get(kClientIp)}`, ctx);
      const { email, password } = check({ email: Email, password: NewPassword }, req);
      if (!config.allowSelfRegistration) {
        throw forbidden("Accounts are created by an admin. Ask a Vertra admin for one.", "REGISTRATION_DISABLED");
      }
      if (await findUserByEmail(email)) {
        throw rpcError(Code.AlreadyExists, "CONFLICT", "Email already registered.");
      }
      const user = await createUser(email, await hashPassword(password));
      return { userId: user.id, email: user.email };
    },

    async exchangeToken(req, ctx) {
      const { idToken } = check({ idToken: Type.String({ minLength: 1, maxLength: 8192 }) }, req);
      await exchangeLimit.take(`exchange:${ctx.values.get(kClientIp)}`, ctx);
      const bot = await botForToken(idToken);
      logOf(ctx).info({ event: "keyless_sign_in", userId: bot.botId, issuer: bot.issuer, subject: bot.subject }, "a bot signed in with its CI's identity");
      // Not a password's session: signed in by an identity provider, as single sign-on is.
      ctx.values.set(kSignedIn, bot.botId);
      const token = app.jwt.sign(newSession(bot.botId, true), { expiresIn: KEYLESS_SESSION_SECONDS });
      return { token, email: bot.email, expiresAt: timestamp(new Date(Date.now() + KEYLESS_SESSION_SECONDS * 1000)) };
    },

    async login(req, ctx) {
      const { email, password } = check({ email: Email, password: AnyPassword }, req);
      await loginLimit.take(`login:${ctx.values.get(kClientIp)}:${email.toLowerCase()}`, ctx);
      // Refused before the password is checked, so this says nothing about it.
      const wait = await loginWaitSeconds(email);
      if (wait > 0) {
        ctx.responseHeader.set("Retry-After", String(wait));
        throw rpcError(
          Code.ResourceExhausted,
          "TOO_MANY_ATTEMPTS",
          `Too many failed sign-ins for this account. Try again in ${String(wait)} seconds.`,
          true,
        );
      }
      const user = await findUserByEmail(email);
      // A missing account is still checked against a throwaway hash, so
      // neither the answer nor its timing says which emails exist.
      const valid = user?.passwordHash
        ? await verifyPassword(user.passwordHash, password)
        : await verifyAgainstNothing(password);
      if (!user || !valid) {
        await recordLoginFailure(email);
        logOf(ctx).warn({ event: "sign_in_failed", email, clientIp: ctx.values.get(kClientIp) }, "a sign-in failed");
        throw unauthenticated("Invalid email or password.");
      }
      ctx.values.set(kSignedIn, user.id);
      // A team that requires single sign-on refuses its members' passwords;
      // checked only once the password was right, so the answer says
      // nothing about an account to someone guessing.
      const requiring = ssoRequiredBy(user, await teamRolesForUser(user.id));
      if (requiring.length > 0) {
        throw forbidden(
          `${requiring.join(", ")} sign${requiring.length === 1 ? "s" : ""} in with ${currentSso()?.label ?? "single sign-on"}: use that instead of a password.`,
          "SSO_REQUIRED",
        );
      }
      await recordLoginSuccess(email);
      await recordSignIn(user.id);
      return { token: app.jwt.sign(newSession(user.id)) };
    },

    async getMe(_req, ctx) {
      const caller = callerOf(ctx);
      const user = await findUserById(caller.id);
      // A deleted account outliving its own still-valid token.
      if (!user) throw unauthenticated("Account no longer exists.");
      return {
        userId: user.id,
        email: user.email,
        teamNames: caller.teamNames,
        maintainerOf: caller.maintainerOf,
        isAdmin: user.isAdmin,
        mustChangePassword: caller.mustChangePassword ?? false,
        hasPassword: user.passwordHash !== null,
        usesSso: user.oidcSubject !== null,
      };
    },

    async changePassword(req, ctx) {
      const caller = callerOf(ctx);
      await passwordChangeLimit.take(`password-change:${caller.id}`, ctx);
      const { currentPassword, newPassword } = check(
        { currentPassword: AnyPassword, newPassword: NewPassword },
        req,
      );
      const user = await findUserById(caller.id);
      if (!user) throw unauthenticated();
      // Bots authenticate with API tokens and have no password.
      if (!user.passwordHash) throw badRequest("This account has no password to change.");
      // invalid_argument, not unauthenticated: a client treats that as
      // "your session is gone" and signs the person out.
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        throw badRequest("Current password is incorrect.", "currentPassword");
      }
      if (newPassword === currentPassword) {
        throw badRequest("New password must be different from the current one.", "newPassword");
      }
      await setUserPassword(user.id, await hashPassword(newPassword), false);
      logOf(ctx).info({ userId: user.id }, "password changed");
      return { token: app.jwt.sign(newSession(user.id)) };
    },

    async signOut(_req, ctx) {
      const session = callerOf(ctx).session;
      // An API token, or a session from before sessions had ids: nothing to end here.
      if (session) await revokeSession(session.sid, new Date(session.exp * 1000));
      logOf(ctx).info({ event: "signed_out" }, "signed out");
      return {};
    },
  };
}
