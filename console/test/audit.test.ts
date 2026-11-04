// SPDX-License-Identifier: MIT
/** Who changed what (audit.ts, rpc/interceptors.ts): what's recorded, and what never is. */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, createUser, setUserAdmin } from "../src/db/queries.js";
import { auditLog, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  upsertSecretGrant: vi.fn(() => Promise.resolve()),
}));

const prefix = `aud-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: { id: string; token: string };
let member: { id: string; token: string };

async function newUser(isAdmin: boolean) {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (isAdmin) await setUserAdmin(user.id, true);
  return { id: user.id, token: app.jwt.sign({ userId: user.id }) };
}

const call = caller(() => app);
const route = (procedure: string) => `vennir.console.v1.${procedure}`;

/** The entries recorded for `actorId`. */
function entriesBy(actorId: string) {
  return db.select().from(auditLog).where(eq(auditLog.actorId, actorId));
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  admin = await newUser(true);
  member = await newUser(false);
  const team = await createTeam(prefix);
  await addTeamMember(member.id, team.id);
});

afterAll(async () => {
  await db.delete(auditLog).where(inArray(auditLog.actorId, [admin.id, member.id]));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

describe("the audit log", () => {
  it("records a change with who made it and what it named, never the secret's value", async () => {
    const put = await call(member.token, "SecretService/PutSecret", {
      team: prefix,
      secretName: "db-key",
      data: { value: "not-a-real-but-still-secret-value" },
    });
    expect(put.code).toBe("ok");
    const [entry] = (await entriesBy(member.id)).filter((e) => e.route === route("SecretService/PutSecret"));
    expect(entry).toMatchObject({ method: "RPC", status: 200, target: { team: prefix, secretName: "db-key" } });
    expect(JSON.stringify(entry)).not.toContain("not-a-real-but-still-secret-value");
  });

  it("records a refused attempt too", async () => {
    await call(member.token, "TeamService/CreateTeam", { name: `${prefix}-nope` });
    const refused = (await entriesBy(member.id)).find((e) => e.route === route("TeamService/CreateTeam"));
    expect(refused).toMatchObject({ status: 403, target: { name: `${prefix}-nope` } });
  });

  it("doesn't record a call with no one signed in, but does a public method's", async () => {
    const team = `${prefix}-anon`;
    expect((await call(undefined, "SecretService/PutSecret", { team, secretName: "db-key", data: { value: "x" } })).code).toBe("unauthenticated");
    expect((await call("not-a-session", "SecretService/PutSecret", { team, secretName: "db-key", data: { value: "x" } })).code).toBe("unauthenticated");
    const anonymous = await db.select().from(auditLog).where(eq(auditLog.route, route("SecretService/PutSecret")));
    expect(anonymous.filter((e) => (e.target as { team?: string }).team === team)).toEqual([]);
    const email = `${prefix}-nobody@example.com`;
    await call(undefined, "AuthService/Login", { email, password: "wrong-password" });
    const logins = await db.select().from(auditLog).where(eq(auditLog.route, route("AuthService/Login")));
    const ours = logins.filter((e) => (e.target as { email?: string }).email === email);
    expect(ours).toHaveLength(1);
    await db.delete(auditLog).where(inArray(auditLog.id, ours.map((e) => e.id)));
  });

  it("doesn't record reads, but does record a password change, never the password", async () => {
    await call(member.token, "AuthService/GetMe");
    await call(member.token, "AuthService/ChangePassword", {
      currentPassword: "correct-horse-battery",
      newPassword: "another-horse-battery",
    });
    const entries = await entriesBy(member.id);
    const routes = entries.map((e) => e.route);
    expect(routes).not.toContain(route("AuthService/GetMe"));
    expect(routes).toContain(route("AuthService/ChangePassword"));
    expect(JSON.stringify(entries)).not.toContain("horse-battery");
  });

  it("is readable by admins only, newest first", async () => {
    // (A fresh user: the test above changed member's password, ending its sessions.)
    expect((await call((await newUser(false)).token, "AdminService/ListAuditEntries")).code).toBe("permission_denied");
    const page = await call<{ entries: { id: string; route: string; actorEmail: string }[] }>(
      admin.token,
      "AdminService/ListAuditEntries",
      { actorId: member.id },
    );
    expect(page.body.entries.length).toBeGreaterThanOrEqual(2);
    expect(Number(page.body.entries[0]?.id)).toBeGreaterThan(Number(page.body.entries[1]?.id ?? 0));
    expect(page.body.entries[0]?.actorEmail).toContain(prefix);
  });
});
