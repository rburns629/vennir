// SPDX-License-Identifier: MIT
/**
 * Keyless bots (src/auth/keyless.ts, src/core/botIdentities.ts): who sets a
 * bot's identities and what's refused (an issuer the install doesn't
 * allow, nothing identifying, a pattern, another team's bot); a CI's ID
 * token for this install signs in as exactly one bot, and the session it
 * gets works; a wrong audience, an expired or forged token, other claims,
 * or an issuer not allowed (whose keys are never fetched) are refused. A
 * test issuer's discovery document and keys are served by a stubbed fetch.
 */
import { randomUUID } from "node:crypto";
import { and, eq, like, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam } from "../src/db/queries.js";
import { botIdentities, teamMemberships, teams, users as usersTable } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

const prefix = `kls-${randomUUID().slice(0, 6)}`;
const team = `${prefix}-team`;
const other = `${prefix}-other`;
const ISSUER = `https://ci-${prefix}.example.test`;
const AUDIENCE = `vennir-${prefix}`;
const SUBJECT = "repo:acme/app:ref:refs/heads/main";

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let maintainerToken: string;
let memberToken: string;
let bot: { id: string; email: string };
let otherBot: { id: string; email: string };
let sign: (claims: Record<string, unknown>, options?: { issuer?: string; audience?: string; expires?: string; forged?: boolean }) => Promise<string>;
const fetched: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  config.keyless.issuers = [...config.keyless.issuers, ISSUER];
  config.keyless.audience = AUDIENCE;
  const keys = await generateKeyPair("RS256");
  const forger = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Promise.resolve(Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` }));
    if (url === `${ISSUER}/keys`) return Promise.resolve(Response.json({ keys: [jwk] }));
    return realFetch(input, init);
  });
  sign = async (claims, options = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(options.expires ?? "5m")
      .sign(options.forged ? forger.privateKey : keys.privateKey);

  const teamId = (await createTeam(team)).id;
  const otherId = (await createTeam(other)).id;
  const maintainer = await users.makeUser();
  const member = await users.makeUser();
  bot = await users.makeUser();
  otherBot = await users.makeUser();
  await db.update(usersTable).set({ isBot: true }).where(eq(usersTable.id, bot.id));
  await db.update(usersTable).set({ isBot: true }).where(eq(usersTable.id, otherBot.id));
  await addTeamMember(maintainer.id, teamId, "maintainer");
  await addTeamMember(member.id, teamId, "member");
  await addTeamMember(bot.id, teamId, "maintainer");
  await addTeamMember(otherBot.id, otherId, "maintainer");
  [maintainerToken, memberToken] = await Promise.all([maintainer, member].map((u) => users.signIn(u.email)));
});

beforeEach(() => {
  fetched.length = 0;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(usersTable).where(like(usersTable.email, `${prefix}-%@bots.vennir.local`));
  await users.cleanUp();
  await app.close();
});

const add = (token: string, body: object) => call<{ identity?: { id: string } }>(token, "TokenService/AddBotIdentity", { team, botId: bot.id, issuer: ISSUER, ...body });
const exchange = (idToken: string) => call<{ token?: string; email?: string }>(undefined, "AuthService/ExchangeToken", { idToken });

describe("a bot's identities", () => {
  it("are its team's maintainers' to set, exact, identifying, and from an allowed issuer", async () => {
    expect((await add(memberToken, { claims: { sub: SUBJECT } })).code).toBe("permission_denied");
    for (const [body, why] of [
      [{ issuer: "https://elsewhere.example", claims: { sub: SUBJECT } }, /only sign in through/],
      [{ claims: { ref: "refs/heads/main" } }, /Name one of sub/],
      [{ claims: { sub: "repo:acme/*" } }, /no patterns/],
      [{ claims: { sub: SUBJECT, aud: "x" } }, /aud is checked already/],
      [{ botId: otherBot.id, claims: { sub: SUBJECT } }, /isn't one of team/],
    ] as const) {
      const refused = await add(maintainerToken, body);
      expect(refused.failure).toBe("BAD_IDENTITY");
      expect(refused.message).toMatch(why);
    }
    expect((await add(maintainerToken, { claims: { sub: SUBJECT } })).code).toBe("ok");
    expect((await add(maintainerToken, { claims: { sub: SUBJECT } })).code).toBe("already_exists");
    const listed = await call<{ identities?: unknown[]; audience?: string }>(memberToken, "TokenService/ListBotIdentities", { team });
    expect(listed.body).toMatchObject({ audience: AUDIENCE, identities: [{ issuer: ISSUER, claims: { sub: SUBJECT }, botEmail: bot.email }] });
  });

  it("aren't added to a bot that's in another team too, as one could be from before bots had one team", async () => {
    const [otherTeam] = await db.select({ id: teams.id }).from(teams).where(eq(teams.name, other));
    await addTeamMember(otherBot.id, (await db.select({ id: teams.id }).from(teams).where(eq(teams.name, team)))[0]!.id, "maintainer");
    try {
      const refused = await add(maintainerToken, { botId: otherBot.id, claims: { sub: "repo:acme/shared:ref:refs/heads/main" } });
      expect(refused.code).toBe("already_exists");
      expect(refused.failure).toBe("CONFLICT");
    } finally {
      await db.delete(teamMemberships).where(and(eq(teamMemberships.userId, otherBot.id), ne(teamMemberships.teamId, otherTeam!.id)));
    }
  });
});

describe("a bot's identity overlapping another bot's", () => {
  it("is refused, so one team can't stop another team's bot signing in", async () => {
    const victim = { sub: `repo:acme/${prefix}-victim:ref:refs/heads/main`, ref: "refs/heads/main" };
    await db.insert(botIdentities).values({ botId: otherBot.id, issuer: ISSUER, claims: victim });
    let own = "";
    try {
      // Broader (a subset of its claims): every token for the other bot would match it too.
      const broader = await add(maintainerToken, { claims: { sub: victim.sub } });
      expect(broader.code).toBe("already_exists");
      expect(broader.failure).toBe("IDENTITY_OVERLAPS");
      expect((await call(maintainerToken, "TokenService/CreateKeylessBot", { team, email: `${prefix}-broad@bots.vennir.local`, issuer: ISSUER, claims: { sub: victim.sub } })).failure).toBe("IDENTITY_OVERLAPS");
      // Narrower, with a claim of its own the other doesn't name: one token could carry both.
      expect((await add(maintainerToken, { claims: { sub: victim.sub, environment: "prod" } })).failure).toBe("IDENTITY_OVERLAPS");
      // The other bot still signs in.
      expect((await exchange(await sign(victim))).body.email).toBe(otherBot.email);
      // Another subject is no overlap; and a bot's own identities never count against it.
      const mine = await add(maintainerToken, { claims: { sub: `repo:acme/${prefix}-own:ref:refs/heads/main` } });
      expect(mine.code).toBe("ok");
      own = mine.body.identity?.id ?? "";
      const again = await call<{ identity?: { id: string } }>(maintainerToken, "TokenService/CreateKeylessBot", {
        team, email: bot.email, issuer: ISSUER, claims: { sub: `repo:acme/${prefix}-own:ref:refs/heads/main`, environment: "prod" },
      });
      expect(again.code).toBe("ok");
      if (again.body.identity?.id) await db.delete(botIdentities).where(eq(botIdentities.id, again.body.identity.id));
    } finally {
      // Left as the later cases expect.
      await db.delete(botIdentities).where(eq(botIdentities.botId, otherBot.id));
      if (own) await db.delete(botIdentities).where(eq(botIdentities.id, own));
    }
  });
});

describe("a keyless bot", () => {
  const made = (token: string, body: object) =>
    call<{ email?: string; identity?: { botEmail: string; claims: Record<string, string> } }>(token, "TokenService/CreateKeylessBot", {
      team,
      email: `${prefix}-deploy@bots.vennir.local`,
      issuer: ISSUER,
      ...body,
    });
  const tokensOf = async (email: string) =>
    (await call<{ bots?: { email: string; tokens?: unknown[] }[] }>(maintainerToken, "TokenService/ListBots", { team })).body.bots?.find((b) => b.email === email);

  it("is made with its identity and no token, by a maintainer, and only when the identity passes", async () => {
    const email = `${prefix}-deploy@bots.vennir.local`;
    expect((await made(memberToken, { claims: { sub: "repo:acme/deploy:ref:refs/heads/main" } })).code).toBe("permission_denied");
    const refused = await made(maintainerToken, { claims: { sub: "repo:acme/*" } });
    expect(refused.failure).toBe("BAD_IDENTITY");
    // A refused identity makes no bot.
    expect(await tokensOf(email)).toBeUndefined();

    const ok = await made(maintainerToken, { claims: { sub: "repo:acme/deploy:ref:refs/heads/main" } });
    expect(ok.body).toMatchObject({ email, identity: { botEmail: email, claims: { sub: "repo:acme/deploy:ref:refs/heads/main" } } });
    expect((await tokensOf(email))?.tokens ?? []).toEqual([]);
    // The same identity again, for any bot: refused, as AddBotIdentity refuses it.
    expect((await made(maintainerToken, { email: `${prefix}-again@bots.vennir.local`, claims: { sub: "repo:acme/deploy:ref:refs/heads/main" } })).code).toBe("already_exists");
    expect(await tokensOf(`${prefix}-again@bots.vennir.local`)).toBeUndefined();

    // And it signs in.
    const session = await exchange(await sign({ sub: "repo:acme/deploy:ref:refs/heads/main" }));
    expect(session.body.email).toBe(email);
  });

  it("can't be another team's bot, given an identity this team chose", async () => {
    const claims = { sub: "repo:acme/takeover:ref:refs/heads/main" };
    const taken = await made(maintainerToken, { email: otherBot.email, claims });
    expect(taken.code).toBe("already_exists");
    expect(taken.failure).toBe("CONFLICT");
    expect(await tokensOf(otherBot.email)).toBeUndefined();
    expect(await db.select().from(botIdentities).where(eq(botIdentities.botId, otherBot.id))).toEqual([]);
    expect((await exchange(await sign(claims))).body.email).toBeUndefined();
  });
});

describe("signing in with a CI's token", () => {
  it("gives an hour's session as the one bot it names, which works", async () => {
    const signedIn = await exchange(await sign({ sub: SUBJECT, repository: "acme/app" }));
    expect(signedIn.code).toBe("ok");
    expect(signedIn.body.email).toBe(bot.email);
    const me = await call<{ email?: string }>(signedIn.body.token, "AuthService/GetMe");
    expect(me.body.email).toBe(bot.email);
    const [row] = await db.select().from(botIdentities).where(eq(botIdentities.botId, bot.id));
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("gives a bot's rights, which make no tokens, identities or members: nothing outlasts its hour", async () => {
    const signedIn = await exchange(await sign({ sub: SUBJECT, repository: "acme/app" }));
    const session = signedIn.body.token ?? "";
    for (const [method, body] of [
      ["TokenService/CreateBotToken", { team, email: bot.email, label: "forever", expiresInDays: 0 }],
      ["TokenService/CreateBotToken", { team, email: `${prefix}-new@bots.vennir.local`, label: "another" }],
      ["TokenService/AddBotIdentity", { team, botId: bot.id, issuer: ISSUER, claims: { sub: "repo:acme/app:ref:refs/heads/feature" } }],
      ["TeamService/AddMember", { team, email: bot.email, role: "TEAM_ROLE_MAINTAINER" }],
      ["TeamService/SetTeamSignIn", { team, requireSso: false }],
    ] as const) {
      const refused = await call(session, method, body);
      expect(refused.code, method).toBe("permission_denied");
      expect(refused.message, method).toContain("A bot can't");
    }
  });

  it("is refused for another audience, an expired or forged token, or other claims", async () => {
    for (const token of [
      await sign({ sub: SUBJECT }, { audience: "someone-else" }),
      await sign({ sub: SUBJECT, iat: Math.floor(Date.now() / 1000) - 7200 }, { expires: "1h ago" }),
      await sign({ sub: SUBJECT }, { forged: true }),
      await sign({ sub: "repo:acme/app:ref:refs/heads/feature" }),
      "not a token",
    ]) {
      const refused = await exchange(token);
      expect(refused.code).toBe("unauthenticated");
      expect(refused.failure).toBe("KEYLESS_REFUSED");
    }
  });

  it("never fetches the keys of an issuer the install doesn't allow", async () => {
    const refused = await exchange(await sign({ sub: SUBJECT }, { issuer: "https://evil.example" }));
    expect(refused.failure).toBe("KEYLESS_REFUSED");
    expect(fetched.filter((url) => url.startsWith("https://evil.example"))).toEqual([]);
  });

  it("stops once the identity is removed", async () => {
    const [row] = await db.select().from(botIdentities).where(eq(botIdentities.botId, bot.id));
    expect((await call(memberToken, "TokenService/RemoveBotIdentity", { id: row?.id })).code).toBe("permission_denied");
    expect((await call(maintainerToken, "TokenService/RemoveBotIdentity", { id: row?.id })).code).toBe("ok");
    expect((await exchange(await sign({ sub: SUBJECT }))).failure).toBe("KEYLESS_REFUSED");
  });
});
