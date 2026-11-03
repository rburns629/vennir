// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createTeam, createUser, recordSubmittedExecution, setTeamRetired, setUserAdmin } from "../src/db/queries.js";
import { submittedExecutions, teams, users } from "../src/db/schema.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { caller } from "./rpc.js";

const prefix = `acct-${randomUUID().slice(0, 6)}`;
let app: FastifyInstance;
let adminId: string;
let memberId: string;
let teamName: string;

async function newUser(isAdmin: boolean): Promise<string> {
  const user = await createUser(`${prefix}-${randomUUID()}@example.com`, await hashPassword("correct-horse-battery"));
  if (isAdmin) await setUserAdmin(user.id, true);
  return user.id;
}

const call = caller(() => app);
const as = <T = Record<string, unknown>>(userId: string, procedure: string, body: object = {}) =>
  call<T>(app.jwt.sign({ userId }), procedure, body);

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  adminId = await newUser(true);
  memberId = await newUser(false);
  teamName = `${prefix}-team`;
  await createTeam(teamName);
});

afterAll(async () => {
  await app.close();
  await db.delete(submittedExecutions).where(eq(submittedExecutions.name, prefix));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(like(users.email, `${prefix}%`));
});

describe("open registration", () => {
  it("is off unless ALLOW_SELF_REGISTRATION is set, and says who to ask", async () => {
    const register = await call(undefined, "AuthService/Register", {
      email: `${prefix}-self@example.com`,
      password: "correct-horse-battery",
    });
    expect(register.code).toBe("permission_denied");
    expect(register.failure).toBe("REGISTRATION_DISABLED");
    expect(register.message).toContain("admin");
    const environment = await call<{ selfRegistration: boolean }>(undefined, "AuthService/GetEnvironment");
    expect(environment.body.selfRegistration).toBe(false);
  });
});

describe("admins create accounts", () => {
  it("creates an account already in its teams, with a one-time password that signs in", async () => {
    const email = `${prefix}-new@example.com`;
    const created = await as<{ temporaryPassword: string }>(adminId, "UserService/CreateUser", { email, teams: [teamName], admin: false });
    expect(created.code).toBe("ok");
    const { temporaryPassword } = created.body;
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(20);

    const login = await call<{ token: string }>(undefined, "AuthService/Login", { email, password: temporaryPassword });
    expect(login.code).toBe("ok");
    const me = await call<{ teamNames: string[] }>(login.body.token, "AuthService/GetMe");
    expect(me.body.teamNames).toEqual([teamName]);
  });

  it("is admin-only", async () => {
    const created = await as(memberId, "UserService/CreateUser", { email: `${prefix}-x@example.com`, teams: [], admin: true });
    expect(created.code).toBe("permission_denied");
    expect(await db.select().from(users).where(eq(users.email, `${prefix}-x@example.com`))).toEqual([]);
  });

  it("checks every team first, so a typo creates nothing", async () => {
    const email = `${prefix}-typo@example.com`;
    const created = await as(adminId, "UserService/CreateUser", { email, teams: [teamName, "no-such-team"], admin: false });
    expect(created.code).toBe("invalid_argument");
    expect(created.message).toContain("no-such-team");
    expect(await db.select().from(users).where(eq(users.email, email))).toEqual([]);
  });

  it("refuses a retired team and an existing email", async () => {
    const retired = `${prefix}-retired`;
    const team = await createTeam(retired);
    await setTeamRetired(team.id, true);
    const intoRetired = await as(adminId, "UserService/CreateUser", { email: `${prefix}-r@example.com`, teams: [retired], admin: false });
    expect(intoRetired.code).toBe("failed_precondition");

    const dup = await as(adminId, "UserService/CreateUser", { email: `${prefix}-new@example.com`, teams: [], admin: false });
    expect(dup.code).toBe("already_exists");
  });

  it("lists accounts with their teams, for admins only", async () => {
    expect((await as(memberId, "UserService/ListUsers")).code).toBe("permission_denied");
    const list = await as<{ users: { email: string; teamNames: string[] }[] }>(adminId, "UserService/ListUsers");
    expect(list.body.users.find((u) => u.email === `${prefix}-new@example.com`)?.teamNames).toEqual([teamName]);
  });
});

describe("deleting an account", () => {
  it("removes the account but keeps the executions it submitted", async () => {
    const email = `${prefix}-leaver@example.com`;
    const leaver = await createUser(email, await hashPassword("correct-horse-battery"));
    const executionId = randomUUID();
    await recordSubmittedExecution({ executionId, teams: [teamName], submittedBy: leaver.id, name: prefix, payload: {} });

    expect((await as(adminId, "UserService/DeleteUser", { email })).code).toBe("ok");
    expect(await db.select().from(users).where(eq(users.email, email))).toEqual([]);
    const [kept] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, executionId));
    expect(kept?.submittedBy).toBeNull();
  });

  it("won't delete your own account, and is admin-only", async () => {
    const [self] = await db.select().from(users).where(eq(users.id, adminId));
    expect((await as(adminId, "UserService/DeleteUser", { email: self?.email ?? "" })).code).toBe("failed_precondition");

    const [member] = await db.select().from(users).where(eq(users.id, memberId));
    expect((await as(memberId, "UserService/DeleteUser", { email: member?.email ?? "" })).code).toBe("permission_denied");
    // (The last-admin rule can't be reached here: the shared test database
    // always holds other tests' admins. It's the same countAdmins() check
    // that SetAdmin already relies on.)
  });
});

describe("an email", () => {
  it("is one account however it's typed: registering, signing in, an admin's lookups", async () => {
    const was = config.allowSelfRegistration;
    config.allowSelfRegistration = true;
    try {
      const registered = await call<{ email: string }>(undefined, "AuthService/Register", {
        email: `${prefix}-Mixed@Example.com`,
        password: "correct-horse-battery",
      });
      expect(registered.body.email).toBe(`${prefix}-mixed@example.com`);
      const again = await call(undefined, "AuthService/Register", { email: `${prefix}-mixed@example.com`, password: "correct-horse-battery" });
      expect(again.code).toBe("already_exists");
    } finally {
      config.allowSelfRegistration = was;
    }
    const login = await call(undefined, "AuthService/Login", { email: `${prefix}-MIXED@example.COM`, password: "correct-horse-battery" });
    expect(login.code).toBe("ok");
    expect((await as(adminId, "UserService/DeleteUser", { email: `${prefix}-mixed@EXAMPLE.com` })).code).toBe("ok");
    expect(await db.select().from(users).where(like(users.email, `${prefix}-mixed%`))).toEqual([]);
  });

  it("is lowercased by 0063 for accounts from before, one per address", async () => {
    // As Register used to store them (raw inserts: the code lowercases now).
    const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
    const rows = [
      { email: `${prefix}-Erin@Old.com`, createdAt: at(0) }, // alone: lowercased
      { email: `${prefix}-DAVE@x.com`, createdAt: at(1) }, // the oldest of its address: lowercased
      { email: `${prefix}-Dave@X.com`, createdAt: at(2) }, // left as typed
      { email: `${prefix}-fay@x.com`, createdAt: at(4) }, // already lowercase: keeps it
      { email: `${prefix}-Fay@x.com`, createdAt: at(3) }, // left as typed, though older
    ];
    const made = await db.insert(users).values(rows).returning({ id: users.id, email: users.email });
    const file = readFileSync(new URL("../src/db/migrations/0063_lowercase_emails.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(file));
    const after = new Map(
      (await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, made.map((m) => m.id)))).map((u) => [u.id, u.email]),
    );
    expect(made.map((m) => after.get(m.id))).toEqual([
      `${prefix}-erin@old.com`,
      `${prefix}-dave@x.com`,
      `${prefix}-Dave@X.com`,
      `${prefix}-fay@x.com`,
      `${prefix}-Fay@x.com`,
    ]);
  });
});
