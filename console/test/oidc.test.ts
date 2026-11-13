// SPDX-License-Identifier: MIT
/**
 * Single sign-on (auth/oidc.ts) against a stand-in OpenID provider: its
 * own key, discovery document and token endpoint, which checks the PKCE
 * verifier and the client's secret as a real one does. A new person gets an
 * account with no password and no teams; an existing one is bound to their
 * provider identity once; and every check on the ID token refuses. A team
 * that requires single sign-on refuses its members' passwords (not an
 * admin's), and nothing changes for anyone else.
 */
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, count, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { config, sessionTtlSeconds } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createUser, setUserAdmin } from "../src/db/queries.js";
import { auditLog, rateLimitWindows, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { PASSWORD, rpcClient } from "./rpc.js";

const domain = `sso-${randomUUID().slice(0, 6)}.example.com`;
const emailOf = (name: string) => `${name}@${domain}`;
let app: FastifyInstance;
let provider: Server;
let issuer: string;
let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JWK;
/** What the next ID token says, and how it's signed. */
let next: { claims: Record<string, unknown>; key?: CryptoKey };
/** The PKCE challenge the console sent, which the token endpoint checks. */
let challenge = "";
let tokenRequests = 0;
const { rpc } = rpcClient(() => app);

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

  provider = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === "/jwks") return json({ keys: [publicJwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        tokenRequests++;
        const form = new URLSearchParams(body);
        const verifier = form.get("code_verifier") ?? "";
        if (form.get("client_secret") !== "the-secret" || createHash("sha256").update(verifier).digest("base64url") !== challenge) {
          return json({ error: "invalid_grant" }, 400);
        }
        void new SignJWT(next.claims)
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(issuer)
          .setAudience("the-client")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(next.key ?? signingKey)
          .then((idToken) => json({ id_token: idToken, access_token: "unused", token_type: "Bearer" }));
      });
      return;
    }
    res.writeHead(404).end();
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  issuer = `http://127.0.0.1:${String((provider.address() as AddressInfo).port)}`;
  config.oidc = {
    issuer,
    clientId: "the-client",
    clientSecret: "the-secret",
    redirectUrl: "http://localhost/api/auth/oidc/callback",
    allowedDomains: [domain],
    label: "Google",
  };
  app = await buildApp();
  await app.ready();
});

beforeEach(() => {
  tokenRequests = 0;
});

afterAll(async () => {
  config.oidc = null;
  provider.close();
  await db.delete(teams).where(like(teams.name, `${domain.split(".")[0]}-%`));
  await db.delete(users).where(like(users.email, `%@${domain}`));
  await app.close();
});

/** The sign-in page's value for its tab, which comes back with the session. */
const TAB = "0123456789abcdef0123456789abcdef";

/** A whole sign-in as a browser does it; the session, or /login's error code. */
async function signInWith(claims: Record<string, unknown>, options: { key?: CryptoKey; tamper?: "state" | "nonce" | "cookie" } = {}) {
  const start = await app.inject({ method: "GET", url: `/api/auth/oidc/start?tab=${TAB}` });
  expect(start.statusCode).toBe(302);
  const authorize = new URL(start.headers.location as string);
  expect(authorize.origin + authorize.pathname).toBe(`${issuer}/authorize`);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("hd")).toBe(domain);
  challenge = authorize.searchParams.get("code_challenge") ?? "";
  const cookie = String(start.headers["set-cookie"]).split(";")[0] ?? "";
  expect(String(start.headers["set-cookie"])).toMatch(/HttpOnly/);
  const nonce = options.tamper === "nonce" ? "another" : authorize.searchParams.get("nonce");
  next = { claims: { nonce, ...claims }, key: options.key };
  const state = options.tamper === "state" ? "another" : authorize.searchParams.get("state");
  const callback = await app.inject({
    method: "GET",
    url: `/api/auth/oidc/callback?state=${String(state)}&code=c`,
    headers: { cookie: options.tamper === "cookie" ? cookie.replace(/.$/, (last) => (last === "x" ? "y" : "x")) : cookie },
  });
  expect(callback.statusCode).toBe(302);
  const fragment = new URLSearchParams((callback.headers.location as string).split("#")[1]);
  if (fragment.get("token")) expect(fragment.get("tab")).toBe(TAB);
  return { token: fragment.get("token") ?? "", error: fragment.get("error") ?? "" };
}

const person = (name: string, extra: Record<string, unknown> = {}) => ({
  sub: `sub-${name}`,
  email: emailOf(name),
  email_verified: true,
  hd: domain,
  ...extra,
});

async function me(token: string) {
  const response = await rpc("AuthService", "GetMe", {}, { token });
  return response.json<{ email?: string; teamNames?: string[]; isAdmin?: boolean; hasPassword?: boolean; usesSso?: boolean }>();
}

describe("single sign-on", () => {
  it("makes a new person an account with no password and no teams", async () => {
    const { token, error } = await signInWith(person("new"));
    expect(error).toBe("");
    expect((await me(token)).email).toBe(emailOf("new"));
    const [row] = await db.select().from(users).where(eq(users.email, emailOf("new")));
    expect(row).toMatchObject({ passwordHash: null, isAdmin: false, oidcSubject: `${issuer} sub-new` });
    expect((await me(token)).teamNames ?? []).toEqual([]);
    // And says how it signs in.
    expect(await me(token)).toMatchObject({ hasPassword: false, usesSso: true });
  });

  it("lasts as long as a password's session when no groups are read (the install's jwtTtl)", async () => {
    const lifetime = (token: string) => {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { iat: number; exp: number };
      return claims.exp - claims.iat;
    };
    const { token } = await signInWith(person("lasting"));
    expect(lifetime(token)).toBe(sessionTtlSeconds(config.jwtTtl));
    await createUser(emailOf("lasting-password"), await hashPassword(PASSWORD));
    const login = await rpc("AuthService", "Login", { email: emailOf("lasting-password"), password: PASSWORD }, { ip: "10.7.1.1" });
    expect(lifetime(login.json<{ token: string }>().token)).toBe(sessionTtlSeconds(config.jwtTtl));
  });

  it("binds an existing account to its identity once, and never to another", async () => {
    const existing = await createUser(emailOf("existing"), await hashPassword(PASSWORD));
    await setUserAdmin(existing.id, true);
    const first = await signInWith(person("existing"));
    expect((await me(first.token)).isAdmin).toBe(true);
    // Another provider account given the same email later.
    expect((await signInWith(person("existing", { sub: "someone-else" }))).error).toBe("ACCOUNT_LINKED_ELSEWHERE");
    // The bound one still signs in.
    expect((await signInWith(person("existing"))).error).toBe("");
  });

  it("makes single sign-on the only way into an account it links: its password, and every session from before, stop working", async () => {
    // Someone registered the email first, with a password of their own.
    await createUser(emailOf("squatted"), await hashPassword(PASSWORD));
    const squatter = await rpc("AuthService", "Login", { email: emailOf("squatted"), password: PASSWORD });
    const before = squatter.json<{ token: string }>().token;
    expect((await me(before)).email).toBe(emailOf("squatted"));
    await new Promise((resolve) => setTimeout(resolve, 1100)); // a session's time is to the second

    const linked = await signInWith(person("squatted"));
    expect((await me(linked.token)).email).toBe(emailOf("squatted"));
    expect((await rpc("AuthService", "GetMe", {}, { token: before })).statusCode).toBe(401);
    expect((await rpc("AuthService", "Login", { email: emailOf("squatted"), password: PASSWORD })).statusCode).toBe(401);
    expect(await me(linked.token)).toMatchObject({ hasPassword: false, usesSso: true });
  });

  it("refuses another domain, an unverified email and a bot's", async () => {
    expect((await signInWith(person("outsider", { hd: "elsewhere.example.com", email: "x@elsewhere.example.com" }))).error).toBe("DOMAIN_NOT_ALLOWED");
    expect((await signInWith(person("unverified", { email_verified: false }))).error).toBe("EMAIL_NOT_VERIFIED");
    const bot = await createUser(emailOf("bot"), null);
    await db.update(users).set({ isBot: true }).where(eq(users.id, bot.id));
    expect((await signInWith(person("bot"))).error).toBe("SIGN_IN_FAILED");
    expect(await db.select().from(users).where(inArray(users.email, [emailOf("outsider"), emailOf("unverified")]))).toEqual([]);
  });

  it("refuses a token signed by another key, or for another sign-in", async () => {
    expect((await signInWith(person("forged"), { key: otherKey })).error).toBe("SIGN_IN_FAILED");
    expect((await signInWith(person("replayed"), { tamper: "nonce" })).error).toBe("SIGN_IN_FAILED");
  });

  it("refuses an answer that isn't for the sign-in this browser started, before asking for a token", async () => {
    expect((await signInWith(person("csrf"), { tamper: "state" })).error).toBe("SIGN_IN_EXPIRED");
    expect((await signInWith(person("csrf"), { tamper: "cookie" })).error).toBe("SIGN_IN_EXPIRED");
    expect(tokenRequests).toBe(0);
  });
});

describe("starting single sign-on", () => {
  it("audits a refusal of a sign-in it started, and only logs an answer to one it didn't", async () => {
    const callbacks = () =>
      db.select({ n: count() }).from(auditLog).where(and(eq(auditLog.route, "/api/auth/oidc/callback"), eq(auditLog.status, 401))).then((rows) => rows[0]?.n ?? 0);
    const before = await callbacks();
    // No cookie, or one this console didn't sign: anyone can send these.
    const unsolicited = await app.inject({ method: "GET", url: "/api/auth/oidc/callback?state=x&code=y" });
    expect(unsolicited.headers.location).toBe("/login#error=SIGN_IN_EXPIRED");
    expect((await signInWith(person("forged-cookie"), { tamper: "cookie" })).error).toBe("SIGN_IN_EXPIRED");
    expect(await callbacks()).toBe(before);
    // One it started, refused: audited.
    expect((await signInWith(person("other-state"), { tamper: "state" })).error).toBe("SIGN_IN_EXPIRED");
    expect(await callbacks()).toBe(before + 1);
  });

  it("limits how often one address comes back from the provider", async () => {
    const from = "10.44.0.9";
    const answer = () => app.inject({ method: "GET", url: "/api/auth/oidc/callback?state=x&code=y", remoteAddress: from });
    await db.insert(rateLimitWindows).values({ key: `sso-callback:${from}`, count: 300, resetsAt: new Date(Date.now() + 60_000) });
    try {
      expect((await answer()).headers.location).toBe("/login#error=RATE_LIMITED");
    } finally {
      await db.delete(rateLimitWindows).where(eq(rateLimitWindows.key, `sso-callback:${from}`));
    }
    expect((await answer()).headers.location).toBe("/login#error=SIGN_IN_EXPIRED");
    await db.delete(rateLimitWindows).where(eq(rateLimitWindows.key, `sso-callback:${from}`));
  });

  it("needs the sign-in page's value for its tab, which comes back only with that sign-in's session", async () => {
    for (const url of ["/api/auth/oidc/start", "/api/auth/oidc/start?tab=x", `/api/auth/oidc/start?tab=${TAB}&tab=${TAB}`]) {
      const refused = await app.inject({ method: "GET", url });
      expect(refused.statusCode).toBe(302);
      expect(refused.headers.location).toBe("/login#error=SIGN_IN_EXPIRED");
    }
    // A whole sign-in echoes it (signInWith checks).
    expect((await signInWith(person("tabbed"))).token).not.toBe("");
  });
});

describe("a team that requires single sign-on", () => {
  const login = (email: string, password: string) => rpc("AuthService", "Login", { email, password });

  async function teamOf(name: string, requireSso: boolean, ...members: string[]) {
    const [team] = await db.insert(teams).values({ name: `${domain.split(".")[0]}-${name}`, requireSso }).returning();
    for (const userId of members) await addTeamMember(userId, team!.id);
    return team!;
  }

  it("leaves everyone else's password working: turning single sign-on on changes nothing else", async () => {
    const person = await createUser(emailOf("pw-free"), await hashPassword(PASSWORD));
    await teamOf("free", false, person.id);
    expect((await login(person.email, PASSWORD)).statusCode).toBe(200);
    const environment = (await rpc("AuthService", "GetEnvironment", {})).json<{ ssoLabel?: string }>();
    expect(environment.ssoLabel).toBe("Google");
  });

  it("refuses its members' passwords, once the password is right; never an admin's", async () => {
    const member = await createUser(emailOf("pw-member"), await hashPassword(PASSWORD));
    const admin = await createUser(emailOf("pw-admin"), await hashPassword(PASSWORD));
    await setUserAdmin(admin.id, true);
    // In a free team and a strict one: the strict one wins.
    await teamOf("strict", true, member.id, admin.id);
    await teamOf("loose", false, member.id);

    const refused = await login(member.email, PASSWORD);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("SSO_REQUIRED");
    expect((await login(member.email, "wrong-password-here")).statusCode).toBe(401);
    expect((await login(admin.email, PASSWORD)).statusCode).toBe(200);
  });

  it("ends its members' password sessions when it starts requiring it, not their single sign-on", async () => {
    const member = await createUser(emailOf("sessions"), await hashPassword(PASSWORD));
    const team = await teamOf("sessions", false, member.id);
    const password = app.jwt.sign({ userId: member.id });
    const sso = app.jwt.sign({ userId: member.id, sso: true });
    expect((await rpc("AuthService", "GetMe", {}, { token: password })).statusCode).toBe(200);

    const adminUser = await createUser(emailOf("switcher"), await hashPassword(PASSWORD));
    await setUserAdmin(adminUser.id, true);
    const admin = app.jwt.sign({ userId: adminUser.id });
    expect((await rpc("TeamService", "SetTeamSignIn", { team: team.name, requireSso: true }, { token: admin })).statusCode).toBe(200);

    expect((await rpc("AuthService", "GetMe", {}, { token: password })).statusCode).toBe(401);
    expect((await rpc("AuthService", "GetMe", {}, { token: sso })).statusCode).toBe(200);
    const listed = (await rpc("TeamService", "GetTeam", { name: team.name }, { token: admin })).json<{ team?: { requireSso?: boolean } }>();
    expect(listed.team?.requireSso).toBe(true);
  });

  it("is an admin's to set", async () => {
    const member = await createUser(emailOf("not-admin"), await hashPassword(PASSWORD));
    const team = await teamOf("guarded", false, member.id);
    const token = app.jwt.sign({ userId: member.id });
    expect((await rpc("TeamService", "SetTeamSignIn", { team: team.name, requireSso: true }, { token })).statusCode).toBe(403);
  });

  it("gives its new people no password; others still get one", async () => {
    const adminUser = await createUser(emailOf("creator"), await hashPassword(PASSWORD));
    await setUserAdmin(adminUser.id, true);
    const token = app.jwt.sign({ userId: adminUser.id });
    const strict = await teamOf("new-strict", true);
    const loose = await teamOf("new-loose", false);
    const create = async (name: string, team: string) =>
      (await rpc("UserService", "CreateUser", { email: emailOf(name), teams: [team], admin: false }, { token })).json<{ temporaryPassword?: string }>();
    expect((await create("made-strict", strict.name)).temporaryPassword ?? "").toBe("");
    expect((await create("made-loose", loose.name)).temporaryPassword).toMatch(/.{20,}/);
  });

  it("has no effect while single sign-on is off, so nobody is locked out", async () => {
    const member = await createUser(emailOf("off"), await hashPassword(PASSWORD));
    await teamOf("off", true, member.id);
    const oidc = config.oidc;
    config.oidc = null;
    try {
      expect((await login(member.email, PASSWORD)).statusCode).toBe(200);
      expect((await rpc("AuthService", "GetMe", {}, { token: app.jwt.sign({ userId: member.id }) })).statusCode).toBe(200);
    } finally {
      config.oidc = oidc;
    }
  });
});
