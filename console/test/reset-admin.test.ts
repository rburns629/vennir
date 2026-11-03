// SPDX-License-Identifier: MIT
/**
 * Resetting a lost admin password from inside the cluster
 * (src/db/resetAdmin.ts): a new random one, printed once, every session
 * revoked, audited; an admin's only.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { auditLog, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { rpcClient } from "./rpc.js";

const run = promisify(execFile);
let app: FastifyInstance;
const accounts = rpcClient(() => app);

function reset(email: string) {
  return run("npx", ["tsx", "src/db/resetAdmin.ts", email], {
    env: { ...process.env, DATABASE_URL: process.env["TEST_DATABASE_URL"] ?? "postgresql://postgres@localhost/execution_console_test", JWT_SECRET: "x", KERNEL_API_URL: "http://unused.invalid" },
  });
}

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await accounts.cleanUp();
  await app.close();
});

describe("resetting an admin's password", () => {
  it("prints a new one once, revokes every session, and audits it", async () => {
    const admin = await accounts.makeUser({ admin: true });
    const before = await accounts.signIn(admin.email);
    // Sessions are compared in whole seconds, and one from the reset's own
    // second is kept: reset in a later one.
    await new Promise((r) => setTimeout(r, 1100));
    const { stdout } = await reset(admin.email);
    const password = /New password for .+: (\S+)/.exec(stdout)?.[1] ?? "";
    expect(password.length).toBeGreaterThanOrEqual(20);
    const [row] = await db.select().from(users).where(eq(users.email, admin.email));
    expect(await verifyPassword(row?.passwordHash ?? "", password)).toBe(true);
    // The session from before is revoked.
    const me = await accounts.rpc("AuthService", "GetMe", {}, { token: before });
    expect(me.statusCode).toBe(401);
    const audited = await db.select().from(auditLog).where(eq(auditLog.route, "reset-admin-password"));
    expect(audited.some((a) => (a.target as { email?: string }).email === admin.email)).toBe(true);
  }, 30_000);

  it("finds the admin however their email is typed", async () => {
    const admin = await accounts.makeUser({ admin: true });
    const { stdout } = await reset(admin.email.toUpperCase());
    expect(stdout).toMatch(/New password for .+: \S+/);
  }, 30_000);

  it("is an admin's only", async () => {
    const person = await accounts.makeUser();
    await expect(reset(person.email)).rejects.toMatchObject({ code: 2 });
  }, 30_000);
});
