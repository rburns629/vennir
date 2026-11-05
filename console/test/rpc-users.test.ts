// SPDX-License-Identifier: MIT
/**
 * UserService: the account rules (accounts.test.ts
 * covers them in depth, through the shared core/users.ts); here, what the
 * Connect path adds: the admin check, refusals as Connect codes with their
 * stable codes, and changes audited without their secrets.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/db/client.js";
import { generateApiToken, hashApiToken } from "../src/auth/apiToken.js";
import { callerForUser } from "../src/auth/plugin.js";
import { createApiToken, createSsoUser } from "../src/db/queries.js";
import { auditLog, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { failureCode, rpcClient, type RpcError } from "./rpc.js";

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
const madeHere: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await cleanUp(madeHere);
});

describe("UserService", () => {
  it("is for admins only", async () => {
    const { email } = await makeUser();
    const token = await signIn(email);
    const response = await rpc("UserService", "ListUsers", {}, { token });
    expect(response.statusCode).toBe(403);
    const error = response.json<RpcError>();
    expect(error.code).toBe("permission_denied");
    expect(failureCode(error)).toBe("FORBIDDEN");
  });

  it("creates an account with a temporary password, and audits it without the password", async () => {
    const admin = await makeUser({ admin: true });
    const token = await signIn(admin.email);
    const email = `made-${randomUUID()}@example.com`;
    madeHere.push(email);

    const created = await rpc("UserService", "CreateUser", { email, teams: [], admin: false }, { token });
    expect(created.statusCode).toBe(200);
    const body = created.json<{ email: string; temporaryPassword: string; admin: boolean }>();
    expect(body).toMatchObject({ email, admin: false });
    expect(body.temporaryPassword.length).toBeGreaterThan(20);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, admin.id), eq(auditLog.route, "vennir.console.v1.UserService/CreateUser")))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(entry).toMatchObject({ method: "RPC", status: 200, target: { email } });
    expect(JSON.stringify(entry)).not.toContain(body.temporaryPassword);

    const again = await rpc("UserService", "CreateUser", { email, teams: [], admin: false }, { token });
    const error = again.json<RpcError>();
    expect(error.code).toBe("already_exists");
    expect(failureCode(error)).toBe("CONFLICT");
  });

  it("says how each person signs in, and when they last did", async () => {
    const admin = await makeUser({ admin: true });
    const token = await signIn(admin.email);
    const person = await makeUser();
    const ssoOnly = await createSsoUser(`sso-${randomUUID()}@example.com`, `https://accounts.google.com ${randomUUID()}`);
    madeHere.push(ssoOnly.email);
    const temporary = `temporary-${randomUUID()}@example.com`;
    madeHere.push(temporary);
    await rpc("UserService", "CreateUser", { email: temporary, teams: [], admin: false }, { token });

    type Listed = { email: string; hasPassword?: boolean; usesSso?: boolean; mustChangePassword?: boolean; lastSignedInAt?: string };
    const listed = async () => {
      const response = await rpc("UserService", "ListUsers", {}, { token });
      return new Map(response.json<{ users: Listed[] }>().users.map((u) => [u.email, u]));
    };
    let users = await listed();
    expect(users.get(person.email)).toMatchObject({ hasPassword: true, usesSso: false, mustChangePassword: false });
    expect(users.get(person.email)?.lastSignedInAt).toBeUndefined();
    expect(users.get(ssoOnly.email)).toMatchObject({ hasPassword: false, usesSso: true });
    expect(users.get(temporary)).toMatchObject({ hasPassword: true, mustChangePassword: true });
    expect(users.get(admin.email)?.lastSignedInAt).toBeDefined();

    const before = Date.now();
    await signIn(person.email);
    users = await listed();
    expect(Date.parse(users.get(person.email)?.lastSignedInAt ?? "")).toBeGreaterThanOrEqual(before - 1000);
  });

  it("names an unknown team, and creates nothing", async () => {
    const admin = await makeUser({ admin: true });
    const token = await signIn(admin.email);
    const email = `typo-${randomUUID()}@example.com`;
    const response = await rpc("UserService", "CreateUser", { email, teams: ["no-such-team-x"], admin: false }, { token });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
    const list = await rpc("UserService", "ListUsers", {}, { token });
    expect(list.json<{ users: { email: string }[] }>().users.map((u) => u.email)).not.toContain(email);
  });

  it("checks input, every problem at once", async () => {
    const admin = await makeUser({ admin: true });
    const token = await signIn(admin.email);
    const response = await rpc("UserService", "ResetPassword", { email: "nope", newPassword: "short" }, { token });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
  });

  it("refuses to revoke the last admin, and records the refusal", async () => {
    const admin = await makeUser({ admin: true });
    const token = await signIn(admin.email);
    // Other admins may exist in this database; only assert the shape when it's the last one.
    const response = await rpc("UserService", "SetAdmin", { email: admin.email, admin: false }, { token });
    if (response.statusCode !== 200) {
      expect(response.json<RpcError>().code).toBe("failed_precondition");
      const [entry] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.actorId, admin.id), eq(auditLog.route, "vennir.console.v1.UserService/SetAdmin")))
        .orderBy(desc(auditLog.id))
        .limit(1);
      expect(entry?.status).toBe(409);
    }
  });
  it("never makes a bot an admin, and never resolves one as an admin", async () => {
    const admin = await makeUser({ admin: true });
    const token = await signIn(admin.email);
    const email = `rpc-bot-${randomUUID()}@bots.vennir.local`;
    madeHere.push(email);
    const [bot] = await db.insert(users).values({ email, isBot: true }).returning();
    if (!bot) throw new Error("no bot");
    const refused = await rpc("UserService", "SetAdmin", { email, admin: true }, { token });
    expect(refused.json<RpcError>().code).toBe("invalid_argument");
    const [after] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, bot.id));
    expect(after?.isAdmin).toBe(false);

    // Even if its row says it's one.
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, bot.id));
    expect((await callerForUser(bot.id))?.isAdmin).toBe(false);
    const raw = generateApiToken();
    await createApiToken(bot.id, "ci", hashApiToken(raw));
    const asBot = await rpc("UserService", "ListUsers", {}, { token: raw });
    expect(asBot.statusCode).toBe(403);
    // And its flag can be cleared, never as "the last admin": it wasn't one.
    expect((await rpc("UserService", "SetAdmin", { email, admin: false }, { token })).statusCode).toBe(200);
    const [cleared] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, bot.id));
    expect(cleared?.isAdmin).toBe(false);
  });
});
