// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createBotUser, createUser, setUserAdmin } from "../src/db/queries.js";
import { auditLog, signInFailures, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { failureCode, type RpcError } from "./rpc.js";

const PASSWORD = "correct-horse-battery";
const createdEmails: string[] = [];
let app: FastifyInstance;

async function makeUser(options: { admin?: boolean } = {}): Promise<{ id: string; email: string }> {
  const email = `test-${randomUUID()}@example.com`;
  createdEmails.push(email);
  const user = await createUser(email, await hashPassword(PASSWORD));
  if (options.admin) await setUserAdmin(user.id, true);
  return { id: user.id, email };
}

/** A Connect call, as JSON; Connect answers with the HTTP status REST did
 * for these (401, 429, 400, 403), so the tests read the same. */
function rpc(procedure: string, body: object, token?: string, ip = "10.0.0.1") {
  return app.inject({
    method: "POST",
    url: `/api/vennir.console.v1.${procedure}`,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: JSON.stringify(body),
    remoteAddress: ip,
  });
}

function login(email: string, password: string, ip = "10.0.0.1") {
  return rpc("AuthService/Login", { email, password }, undefined, ip);
}

async function tokenFor(email: string): Promise<string> {
  const response = await login(email, PASSWORD, `10.1.${String(Math.floor(Math.random() * 250))}.1`);
  expect(response.statusCode).toBe(200);
  return (response.json<{ token: string }>()).token;
}

function me(token: string) {
  return rpc("AuthService/GetMe", {}, token);
}

function changePassword(token: string, currentPassword: string, newPassword: string) {
  return rpc("AuthService/ChangePassword", { currentPassword, newPassword }, token);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (createdEmails.length > 0) await db.delete(users).where(inArray(users.email, createdEmails));
});

describe("session expiry", () => {
  it("issues tokens that carry an 8h expiry", async () => {
    const { email } = await makeUser();
    const decoded = app.jwt.decode<{ iat: number; exp: number }>(await tokenFor(email));
    expect(decoded?.exp).toBeDefined();
    expect((decoded?.exp ?? 0) - (decoded?.iat ?? 0)).toBe(8 * 60 * 60);
  });

  it("rejects an expired token", async () => {
    const { id } = await makeUser();
    const token = app.jwt.sign({ userId: id }, { expiresIn: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await me(token)).statusCode).toBe(401);
  });
});

describe("changing your password", () => {
  it("changes the password, revokes older sessions, and keeps the caller signed in", async () => {
    const { email } = await makeUser();
    const oldToken = await tokenFor(email);
    // A session from before the change, issued at least a second earlier
    // (iat has one-second resolution).
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const otherToken = await tokenFor(email);

    const response = await changePassword(otherToken, PASSWORD, "a-brand-new-password");
    expect(response.statusCode).toBe(200);
    const { token: newToken } = response.json<{ token: string }>();

    expect((await me(oldToken)).statusCode).toBe(401);
    expect((await me(newToken)).statusCode).toBe(200);
    expect((await login(email, PASSWORD, "10.2.0.1")).statusCode).toBe(401);
    expect((await login(email, "a-brand-new-password", "10.2.0.2")).statusCode).toBe(200);
  });

  it("rejects a wrong current password with 400, not 401", async () => {
    const { email } = await makeUser();
    const response = await changePassword(await tokenFor(email), "not-my-password", "a-brand-new-password");
    expect(response.statusCode).toBe(400);
  });

  it("rejects a new password shorter than 12 characters", async () => {
    const { email } = await makeUser();
    const response = await changePassword(await tokenFor(email), PASSWORD, "short");
    expect(response.statusCode).toBe(400);
  });
});

describe("an admin resetting a password", () => {
  function reset(token: string, email: string, newPassword = "reset-by-an-admin") {
    return rpc("UserService/ResetPassword", { email, newPassword }, token);
  }

  it("is admin-only", async () => {
    const caller = await makeUser();
    const target = await makeUser();
    expect((await reset(await tokenFor(caller.email), target.email)).statusCode).toBe(403);
  });

  it("sets the new password and revokes the target's existing sessions", async () => {
    const admin = await makeUser({ admin: true });
    const target = await makeUser();
    const targetToken = await tokenFor(target.email);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect((await reset(await tokenFor(admin.email), target.email)).statusCode).toBe(200);
    expect((await me(targetToken)).statusCode).toBe(401);
    expect((await login(target.email, "reset-by-an-admin", "10.3.0.1")).statusCode).toBe(200);
  });

  it("refuses to reset a bot account", async () => {
    const admin = await makeUser({ admin: true });
    const botEmail = `bot-${randomUUID()}@example.com`;
    createdEmails.push(botEmail);
    await createBotUser(botEmail);
    expect((await reset(await tokenFor(admin.email), botEmail)).statusCode).toBe(400);
  });
});

describe("login rate limiting", () => {
  it("blocks an 11th attempt within the window for the same IP and email", async () => {
    const { email } = await makeUser();
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await login(email, "wrong-password", "10.9.9.9")).statusCode).toBe(401);
    }
    const blocked = await login(email, PASSWORD, "10.9.9.9");
    expect(blocked.statusCode).toBe(429);
    expect(failureCode(blocked.json<RpcError>())).toBe("RATE_LIMITED");
  });

  it("doesn't lock out the same account from a different IP", async () => {
    const { email } = await makeUser();
    for (let attempt = 0; attempt < 10; attempt++) {
      await login(email, "wrong-password", "10.9.9.10");
    }
    expect((await login(email, PASSWORD, "10.9.9.11")).statusCode).toBe(200);
  });

  it("doesn't lock out other accounts behind the same IP", async () => {
    const target = await makeUser();
    const bystander = await makeUser();
    for (let attempt = 0; attempt < 10; attempt++) {
      await login(target.email, "wrong-password", "10.9.9.12");
    }
    expect((await login(bystander.email, PASSWORD, "10.9.9.12")).statusCode).toBe(200);
  });
});

describe("guessing one account from many IPs", () => {
  // The clock stands still, so a one-second wait can't run out while a
  // loaded machine is still hashing the next attempt.
  let t0 = 0;
  beforeEach(() => {
    t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** One failed attempt from each of `count` different IPs. */
  async function failFromManyIps(email: string, count: number, prefix: string) {
    for (let n = 0; n < count; n++) {
      expect((await login(email, "wrong-password", `${prefix}.${String(n)}`)).statusCode).toBe(401);
    }
  }

  it("spaces attempts out after 10 failures, before checking the password", async () => {
    const { email } = await makeUser();
    await failFromManyIps(email, 11, "10.20.0");
    // Even the right password, from a fresh IP, waits its turn: a refusal
    // must not depend on the password, or it would confirm a guess.
    const refused = await login(email, PASSWORD, "10.20.1.1");
    expect(refused.statusCode).toBe(429);
    expect(failureCode(refused.json<RpcError>())).toBe("TOO_MANY_ATTEMPTS");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("lets the owner in once the gap has passed, which clears the count", async () => {
    const { email } = await makeUser();
    await failFromManyIps(email, 11, "10.21.0");
    vi.spyOn(Date, "now").mockReturnValue(t0 + 2_000);
    expect((await login(email, PASSWORD, "10.21.1.1")).statusCode).toBe(200);
    // Cleared: the next wrong guess is an ordinary 401, not a wait.
    expect((await login(email, "wrong-password", "10.21.1.2")).statusCode).toBe(401);
    expect((await login(email, PASSWORD, "10.21.1.3")).statusCode).toBe(200);
  });

  it("throttles an email with no account the same way", async () => {
    const email = `${randomUUID()}@nobody.example.com`;
    await failFromManyIps(email, 11, "10.22.0");
    expect((await login(email, "anything", "10.22.1.1")).statusCode).toBe(429);
  });
});

describe("login timing", () => {
  /** The quickest of a few attempts: other work on the machine only ever adds time. */
  async function fastestMs(email: string, ipPrefix: string): Promise<number> {
    let fastest = Infinity;
    for (let n = 0; n < 5; n++) {
      const started = performance.now();
      await login(email, "wrong-password", `${ipPrefix}.${String(n)}`);
      fastest = Math.min(fastest, performance.now() - started);
    }
    return fastest;
  }

  it("takes as long for an email with no account as for a wrong password", async () => {
    const { email } = await makeUser();
    const missing = `${randomUUID()}@nobody.example.com`;
    await fastestMs(missing, "10.23.9"); // warm the throwaway hash
    const real = await fastestMs(email, "10.23.0");
    const none = await fastestMs(missing, "10.23.1");
    // Both pay for one argon2 check; without it a missing account answered
    // about seven times faster.
    expect(none).toBeGreaterThan(real * 0.5);
  });
});

describe("signing out", () => {
  it("ends the session at once, and only that one", async () => {
    const { email } = await makeUser();
    const first = await tokenFor(email);
    const second = await tokenFor(email);
    expect((await rpc("AuthService/SignOut", {}, first)).statusCode).toBe(200);
    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(200);
    // Again: already gone, still fine to ask.
    expect((await rpc("AuthService/SignOut", {}, first)).statusCode).toBe(401);
  });

  it("gives every session its own id", async () => {
    const { email } = await makeUser();
    const a = app.jwt.decode<{ sid?: string }>(await tokenFor(email));
    const b = app.jwt.decode<{ sid?: string }>(await tokenFor(email));
    expect(a?.sid).toBeTruthy();
    expect(a?.sid).not.toBe(b?.sid);
  });
});

describe("sign-ins in the audit log", () => {
  it("records a sign-in, allowed or refused, with the email and address, never the password", async () => {
    const { id, email } = await makeUser();
    expect((await login(email, "wrong-password", "10.40.0.1")).statusCode).toBe(401);
    expect((await login(email, PASSWORD, "10.40.0.2")).statusCode).toBe(200);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.route, "vennir.console.v1.AuthService/Login"), sql`${auditLog.target}->>'email' = ${email}`))
      .orderBy(auditLog.id);
    expect(rows.map((r) => [r.status, r.actorId, (r.target as { clientIp?: string }).clientIp])).toEqual([
      [401, null, "10.40.0.1"],
      [200, id, "10.40.0.2"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("wrong-password");
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });
});

describe("limits shared by every copy of the console", () => {
  it("counts an account's failures in the database, not in one process", async () => {
    const { email } = await makeUser();
    for (let n = 0; n < 3; n++) await login(email, "wrong-password", `10.41.0.${String(n)}`);
    const [row] = await db.select().from(signInFailures).where(eq(signInFailures.email, email.toLowerCase()));
    expect(row?.failures).toBe(3);
  });
});

describe("session signing", () => {
  it("signs with Ed25519 and publishes only the public key", async () => {
    const { email } = await makeUser();
    const token = await tokenFor(email);
    const header = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString()) as { alg: string; kid: string };
    expect(header.alg).toBe("EdDSA");
    const jwks = (await app.inject({ method: "GET", url: "/api/auth/jwks" })).json<{ keys: Record<string, string>[] }>();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", kid: header.kid });
    expect(jwks.keys[0]?.["d"]).toBeUndefined();
  });

  it("refuses a session signed any other way, such as HS256 with the old secret", async () => {
    const { id } = await makeUser();
    const { createHmac } = await import("node:crypto");
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ userId: id, iat: now, exp: now + 60 })}`;
    const forged = `${unsigned}.${createHmac("sha256", "test-only-jwt-secret").update(unsigned).digest("base64url")}`;
    expect((await me(forged)).statusCode).toBe(401);
  });
});
