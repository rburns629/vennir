// SPDX-License-Identifier: MIT
import { claimGroupsInUse, CLAIM_GROUPS_SESSION_SECONDS, currentSso } from "../sso.js";
import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { randomUUID } from "node:crypto";
import { findApiTokenPrincipal, findUserById, isSessionRevoked, teamRolesForUser, touchApiToken } from "../db/queries.js";
import { API_TOKEN_PREFIX, hashApiToken } from "./apiToken.js";
import { sessionJwks, sessionKeyId, sessionKeys } from "../sessionKeys.js";

/** How stale an API token's "last used" time may get before a request
 * rewrites it: precise enough for "is anything still using this?". */
const TOKEN_USE_RESOLUTION_MS = 5 * 60 * 1000;

declare module "@fastify/jwt" {
  interface FastifyJWT {
    // sso: made by single sign-on (auth/oidc.ts), not a password. sid: the
    // session's own id, which signing out revokes (newSession).
    payload: { userId: string; sso?: boolean; sid: string };
    // iat/exp are added by the signer, not by our own jwtSign call. A
    // session from before sids has none, and can't be signed out early.
    user: { userId: string; sso?: boolean; sid?: string; iat: number; exp: number };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set for a Connect call (rpc/server.ts) — the caller's identity,
     * their *current* team memberships, and their platform-admin status,
     * looked up fresh from the database on every request (never baked
     * into the JWT itself), so a membership or role change takes effect
     * immediately rather than only once a stale token expires. `scopes`
     * is non-empty only for an automation API token (auth/scopes.ts). */
    // teamNames: every team the caller is in; maintainerOf: the ones it
    // maintains (auth/access.ts).
    // mustChangePassword: a password session whose password someone else
    // set; it may only change it (rpc/interceptors.ts).
    authUser?: {
      id: string;
      teamNames: string[];
      maintainerOf: string[];
      isAdmin: boolean;
      // A bot (a token's, a keyless sign-in's, or what the console does as
      // one): never the person approving a step (core/approvals.ts).
      isBot?: boolean;
      scopes: string[];
      mustChangePassword?: boolean;
      // Set for an ordering bot's own request: the only templates it may
      // run (auth/access.ts's ensureMayOrder). Never for what the console
      // does as a bot (a schedule's runs, reviewed by its team).
      orderTemplates?: string[];
      // A session's (not an API token's): its id and when it expires
      // (seconds), for signing it out (AuthService.SignOut).
      session?: { sid: string; exp: number };
    };
  }
}

/** A new session's claims: who, how they signed in, and the session's own id. */
export function newSession(userId: string, sso = false): { userId: string; sso?: boolean; sid: string } {
  return { userId, ...(sso ? { sso: true } : {}), sid: randomUUID() };
}

/**
 * The teams that make this person sign in with single sign-on, while it's
 * on: none for an admin (a way in if the provider fails), or for anyone
 * while it's off (nobody is locked out).
 */
export function ssoRequiredBy(user: { isAdmin: boolean }, roles: { name: string; requireSso: boolean }[]): string[] {
  if (!currentSso() || user.isAdmin) return [];
  return roles.filter((r) => r.requireSso).map((r) => r.name);
}

/** Who's calling, or why nobody is: a session JWT or an API token. */
export type AuthUser = NonNullable<FastifyRequest["authUser"]>;
export type CallerResolution = { authUser: AuthUser; problem?: undefined } | { authUser?: undefined; problem: string };

/**
 * Resolves the request's bearer credential into its caller, looked up fresh
 * from the database, for the Connect services (rpc/server.ts).
 *
 * Two credential shapes: a human's session JWT from signing in, or a bot's
 * long-lived API token (see db/schema.ts's apiTokens and core/tokens.ts),
 * told apart by the token's own prefix so this never has to "try JWT, fall
 * back on failure." Whichever it is, one user id resolves into the same
 * authUser shape, so every downstream check (team membership, isAdmin)
 * works the same either way.
 */
export async function resolveCaller(request: FastifyRequest): Promise<CallerResolution> {
  const header = request.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  let user;
  let scopes: string[] = [];
  // A session a password made (not single sign-on, not an API token).
  let passwordSession = false;
  // A single sign-on session, and one signed in within CLAIM_GROUPS_SESSION_SECONDS.
  let sessionSso = false;
  let recentSso = false;
  let session: { sid: string; exp: number } | undefined;
  if (bearer?.startsWith(API_TOKEN_PREFIX)) {
    const principal = await findApiTokenPrincipal(hashApiToken(bearer));
    user = principal?.user;
    scopes = principal?.scopes ?? [];
    if (
      principal &&
      (!principal.lastUsedAt || Date.now() - principal.lastUsedAt.getTime() > TOKEN_USE_RESOLUTION_MS)
    ) {
      await touchApiToken(principal.tokenId);
    }
  } else {
    try {
      await request.jwtVerify();
    } catch {
      return { problem: "Missing or invalid token." };
    }
    user = await findUserById(request.user.userId);
    passwordSession = request.user.sso !== true;
    sessionSso = !passwordSession;
    recentSso = sessionSso && Math.floor(Date.now() / 1000) - request.user.iat <= CLAIM_GROUPS_SESSION_SECONDS;
    // A session issued before the user's last password change/reset is
    // revoked. `iat` only has one-second resolution, so compare in
    // whole seconds: the replacement token a password change issues in
    // the same second must still be accepted.
    if (user?.passwordChangedAt && request.user.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      user = undefined;
    }
    // Signed out (AuthService.SignOut) before it expired.
    const sid = request.user.sid;
    if (sid) {
      if (await isSessionRevoked(sid)) user = undefined;
      session = { sid, exp: request.user.exp };
    }
  }

  if (!user) {
    // Either credential shape can point at nothing real: a JWT whose
    // account was since deleted, or an API token that's invalid,
    // unrecognized, or revoked.
    return { problem: "Invalid, expired, or revoked credential." };
  }
  const roles = await teamRolesForUser(user.id);
  // A password's session ends once one of the person's teams requires
  // single sign-on.
  if (passwordSession && ssoRequiredBy(user, roles).length > 0) {
    return { problem: "Your team signs in with single sign-on now: sign in again." };
  }
  // While groups come from an ID token's claim, which only a sign-in reads,
  // a membership a group gave counts only for a recent single sign-on
  // (sso.ts). An older single sign-on session ends, so its person signs in
  // again and their groups are read; a password's session or an API token
  // goes on without those teams. The gateway's auth.go, the same.
  const stale = claimGroupsInUse() && !recentSso;
  if (stale && sessionSso && roles.some((row) => row.fromGroups)) {
    return { problem: "Your teams follow your single sign-on groups: sign in again." };
  }
  const usable = stale ? roles.filter((row) => !row.fromGroups) : roles;
  const teamNames = usable.map((row) => row.name);
  const maintainerOf = usable.filter((row) => row.role === "maintainer").map((row) => row.name);
  const mustChangePassword = passwordSession && user.mustChangePassword;
  return {
    authUser: {
      id: user.id,
      teamNames,
      maintainerOf,
      // Never a bot, whatever its row says (core/users.ts refuses making
      // one an admin); the gateway resolves it the same way.
      isAdmin: user.isAdmin && !user.isBot,
      ...(user.isBot ? { isBot: true } : {}),
      scopes,
      mustChangePassword,
      ...(user.orderTemplates ? { orderTemplates: user.orderTemplates } : {}),
      ...(session ? { session } : {}),
    },
  };
}

/**
 * A user as a caller, for what the console does as them (a schedule's bot):
 * their teams and roles as they are now, and no token scopes. Undefined
 * once the account is gone.
 */
export async function callerForUser(userId: string): Promise<AuthUser | undefined> {
  const user = await findUserById(userId);
  if (!user) return undefined;
  const roles = await teamRolesForUser(user.id);
  return {
    id: user.id,
    teamNames: roles.map((row) => row.name),
    maintainerOf: roles.filter((row) => row.role === "maintainer").map((row) => row.name),
    isAdmin: user.isAdmin && !user.isBot,
    ...(user.isBot ? { isBot: true } : {}),
    scopes: [],
    mustChangePassword: false,
  };
}

const authPlugin: FastifyPluginAsync = async (app) => {
  // Ed25519 (sessionKeys.ts), so the gateway, holding the public key only,
  // can check a session but never make one. jwtVerify() rejects an expired
  // token on its own once `exp` is set, and any other algorithm.
  await app.register(fastifyJwt, {
    secret: sessionKeys,
    sign: { algorithm: "EdDSA", expiresIn: config.jwtTtl, kid: sessionKeyId },
    verify: { algorithms: ["EdDSA"] },
  });
  // The public key, for the gateway; anyone may read it.
  app.get("/api/auth/jwks", () => sessionJwks());
};

export default fp(authPlugin);
