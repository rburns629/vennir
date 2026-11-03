// SPDX-License-Identifier: MIT
/**
 * Single sign-on with an OpenID Connect provider (the one in effect:
 * sso.ts, the install's or admins'): the authorization code flow with PKCE,
 * as two routes under /api/auth/oidc, which read the settings at each
 * request, so turning it on or off needs no restart.
 *
 * - start: makes a state, a nonce and a PKCE verifier, keeps them in a
 *   signed, HttpOnly cookie scoped to these routes for ten minutes, and
 *   sends the browser to the provider.
 * - callback: checks the state against that cookie, exchanges the code (with
 *   the verifier and the client's secret), and checks the ID token: the
 *   provider's signature (its published keys), issuer, audience, expiry,
 *   nonce, a verified email, and an allowed domain (Google's hd claim). Then
 *   the person's account: the one bound to this provider identity; else the
 *   one with this email, bound now (once: never over another identity); else
 *   a new one, with no password and no teams (admins and maintainers add
 *   them, as for anyone). Then, when groups are set up, every team a group
 *   is mapped to follows the person's groups (sso.ts); groups that can't be
 *   read refuse the sign-in. It answers with a redirect to /login carrying
 *   the session in the URL's fragment, which browsers never send to a server.
 *
 * Every failure redirects to /login#error=<CODE> and is logged in full.
 */
import { createHash, randomBytes } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { config } from "../config.js";
import { currentSso, groupsOf, GroupsUnavailable, syncMappedTeams, type Sso } from "../sso.js";
import { bindOidcSubject, createSsoUser, findUserByEmail, findUserByOidcSubject, recordSignIn } from "../db/queries.js";
import { newSession } from "./plugin.js";
import { writeAuditEntry } from "../audit.js";

const COOKIE = "vertra_oidc";
const COOKIE_PATH = "/api/auth/oidc";
const COOKIE_SECONDS = 600;
const GOOGLE = "https://accounts.google.com";

type Oidc = Sso;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** Why a sign-in was refused: the code /login shows a message for. */
export class SignInRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let discovered: { issuer: string; discovery: Discovery; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

/** The provider's endpoints and keys, read once from its discovery document. */
async function provider(oidc: Oidc) {
  if (discovered?.issuer === oidc.issuer) return discovered;
  const response = await fetch(new URL(".well-known/openid-configuration", oidc.issuer.replace(/\/?$/, "/")), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${oidc.issuer}'s discovery document: ${String(response.status)}`);
  const discovery = (await response.json()) as Discovery;
  if (discovery.issuer !== oidc.issuer) throw new Error(`${oidc.issuer}'s discovery document names ${discovery.issuer}`);
  discovered = { issuer: oidc.issuer, discovery, keys: createRemoteJWKSet(new URL(discovery.jwks_uri)) };
  return discovered;
}

const random = () => randomBytes(32).toString("base64url");
const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** The domain a person's sign-in counts as: Google's hd (a Workspace account's), else their email's. */
function domainOf(oidc: Oidc, claims: JWTPayload): string {
  if (typeof claims["hd"] === "string") return claims["hd"].toLowerCase();
  // A personal Google account has no hd: it belongs to no domain.
  if (oidc.issuer === GOOGLE) return "";
  const email = typeof claims["email"] === "string" ? claims["email"] : "";
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/** The ID token's claims, once every check has passed. */
async function verifiedClaims(oidc: Oidc, idToken: string, nonce: string) {
  const { discovery, keys } = await provider(oidc);
  const { payload } = await jwtVerify(idToken, keys, { issuer: discovery.issuer, audience: oidc.clientId });
  if (payload["nonce"] !== nonce) throw new SignInRefused("SIGN_IN_FAILED", "The ID token's nonce isn't this sign-in's.");
  const email = typeof payload["email"] === "string" ? payload["email"].toLowerCase() : "";
  if (!email || payload["email_verified"] !== true) {
    throw new SignInRefused("EMAIL_NOT_VERIFIED", "The provider hasn't verified this account's email.");
  }
  const domain = domainOf(oidc, payload);
  if (!oidc.allowedDomains.includes(domain)) {
    throw new SignInRefused("DOMAIN_NOT_ALLOWED", `Accounts from ${domain || "outside a Workspace domain"} can't sign in here.`);
  }
  if (!payload.sub) throw new SignInRefused("SIGN_IN_FAILED", "The ID token names nobody.");
  return { email, subject: `${discovery.issuer} ${payload.sub}`, claims: payload as Record<string, unknown> };
}

/** The account this identity signs in as: bound, matched by email and bound, or new. */
export async function accountFor(email: string, subject: string, log: FastifyBaseLogger) {
  const bound = await findUserByOidcSubject(subject);
  if (bound) return bound;
  const existing = await findUserByEmail(email);
  if (existing) {
    if (existing.isBot) throw new SignInRefused("SIGN_IN_FAILED", "That email belongs to a bot.");
    if (existing.oidcSubject || !(await bindOidcSubject(existing.id, subject))) {
      throw new SignInRefused("ACCOUNT_LINKED_ELSEWHERE", `${email}'s account signs in with another identity.`);
    }
    log.warn(
      { event: "sso_account_linked", userId: existing.id, email, hadPassword: existing.passwordHash !== null },
      "account linked to its single sign-on identity: its password and earlier sessions no longer work",
    );
    return { ...existing, oidcSubject: subject, passwordHash: null };
  }
  const user = await createSsoUser(email, subject);
  log.warn({ event: "sso_account_created", userId: user.id, email }, "account created at its first single sign-on");
  return user;
}

function refuse(reply: FastifyReply, log: FastifyBaseLogger, error: unknown) {
  const code = error instanceof SignInRefused ? error.code : "SIGN_IN_FAILED";
  log.warn({ event: "sso_sign_in_refused", code, err: error }, "single sign-on refused");
  return reply.redirect(`/login#error=${code}`);
}

/** The provider in effect, or the refusal while single sign-on is off. */
function inEffect(): Oidc {
  const oidc = currentSso();
  if (!oidc) throw new SignInRefused("SSO_OFF", "Single sign-on isn't on here.");
  return oidc;
}

/** The two routes, under /api. */
export async function registerOidc(api: FastifyInstance): Promise<void> {
  await api.register(fastifyCookie, { secret: config.jwtSecret });

  api.get("/auth/oidc/start", async (request, reply) => {
    try {
      const oidc = inEffect();
      const { discovery } = await provider(oidc);
      const flow = { state: random(), nonce: random(), verifier: random() };
      reply.setCookie(COOKIE, JSON.stringify(flow), {
        signed: true,
        httpOnly: true,
        secure: oidc.redirectUrl.startsWith("https://"),
        sameSite: "lax",
        path: COOKIE_PATH,
        maxAge: COOKIE_SECONDS,
      });
      const url = new URL(discovery.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: oidc.clientId,
        redirect_uri: oidc.redirectUrl,
        scope: "openid email profile",
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: challengeOf(flow.verifier),
        code_challenge_method: "S256",
        prompt: "select_account",
        // Google: offer this domain's accounts first.
        ...(oidc.allowedDomains.length === 1 ? { hd: oidc.allowedDomains[0] } : {}),
      }).toString();
      return await reply.redirect(url.toString());
    } catch (error) {
      return refuse(reply, request.log, error);
    }
  });

  api.get<{ Querystring: { state?: string; code?: string; error?: string } }>("/auth/oidc/callback", async (request, reply) => {
    const raw = request.cookies[COOKIE];
    reply.clearCookie(COOKIE, { path: COOKIE_PATH });
    try {
      const unsigned = raw ? request.unsignCookie(raw) : undefined;
      if (!unsigned?.valid || !unsigned.value) throw new SignInRefused("SIGN_IN_EXPIRED", "This sign-in wasn't started here, or took too long.");
      const flow = JSON.parse(unsigned.value) as { state: string; nonce: string; verifier: string };
      const { state, code, error } = request.query;
      if (error) throw new SignInRefused("SIGN_IN_CANCELLED", `The provider answered ${error}.`);
      if (!state || state !== flow.state || !code) throw new SignInRefused("SIGN_IN_EXPIRED", "The provider's answer isn't for this sign-in.");

      const oidc = inEffect();
      const { discovery } = await provider(oidc);
      const response = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: oidc.redirectUrl,
          client_id: oidc.clientId,
          client_secret: oidc.clientSecret,
          code_verifier: flow.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`the provider's token endpoint answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);
      const { id_token: idToken } = (await response.json()) as { id_token?: string };
      if (!idToken) throw new Error("the provider sent no ID token");

      const { email, subject, claims } = await verifiedClaims(oidc, idToken, flow.nonce);
      let groups: string[] | null;
      try {
        groups = await groupsOf(claims, email);
      } catch (error) {
        if (error instanceof GroupsUnavailable) throw new SignInRefused("GROUPS_UNAVAILABLE", error.message);
        throw error;
      }
      const user = await accountFor(email, subject, request.log);
      if (groups !== null) await syncMappedTeams(user.id, groups, request.log);
      await recordSignIn(user.id);
      request.log.info({ event: "sso_sign_in", userId: user.id }, "signed in with single sign-on");
      await writeAuditEntry(request.log, {
        actorId: user.id,
        method: "GET",
        route: "/api/auth/oidc/callback",
        target: { email, clientIp: request.ip },
        status: 200,
        requestId: request.id,
      });
      return await reply.redirect(`/login#token=${encodeURIComponent(api.jwt.sign(newSession(user.id, true)))}`);
    } catch (error) {
      await writeAuditEntry(request.log, {
        actorId: null,
        method: "GET",
        route: "/api/auth/oidc/callback",
        target: { clientIp: request.ip },
        status: 401,
        requestId: request.id,
      });
      return refuse(reply, request.log, error);
    }
  });
}
