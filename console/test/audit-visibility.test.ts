// SPDX-License-Identifier: MIT
/**
 * Observe's audit tab (ObserveService.ListAudit): an admin sees every
 * entry; anyone else their own, and what was done to their teams or to
 * runs in them, by anyone. Entries about no team stay with admins.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { appendAuditEntry } from "../src/audit.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, createUser, recordSubmittedExecution, setUserAdmin } from "../src/db/queries.js";
import { auditLog, submittedExecutions, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller } from "./rpc.js";

const prefix = `audv-${randomUUID().slice(0, 6)}`;
const mine = `${prefix}-mine`;
const theirs = `${prefix}-theirs`;
const runInMine = randomUUID();
const runInTheirs = randomUUID();
const emails: string[] = [];
let app: FastifyInstance;
let admin: { id: string; token: string };
let member: { id: string; token: string };
let other: { id: string; token: string };
const ids: Record<string, number> = {};

async function newUser(isAdmin: boolean) {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (isAdmin) await setUserAdmin(user.id, true);
  return { id: user.id, token: app.jwt.sign({ userId: user.id }) };
}

const call = caller(() => app);
const route = (procedure: string) => `vennir.console.v1.${procedure}`;

type Page = { entries?: { id: string }[]; nextBefore?: string };

/** Which of this test's entries `token` sees with these filters. */
async function seen(token: string, filters: object = {}): Promise<string[]> {
  const out = await call<Page>(token, "ObserveService/ListAudit", { limit: 500, ...filters });
  expect(out.code).toBe("ok");
  const visible = new Set((out.body.entries ?? []).map((e) => Number(e.id)));
  return Object.entries(ids)
    .filter(([, id]) => visible.has(id))
    .map(([name]) => name)
    .sort();
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  admin = await newUser(true);
  member = await newUser(false);
  other = await newUser(false);
  await addTeamMember(member.id, (await createTeam(mine)).id);
  await addTeamMember(other.id, (await createTeam(theirs)).id);
  for (const [executionId, team] of [
    [runInMine, mine],
    [runInTheirs, theirs],
  ] as const) {
    await recordSubmittedExecution({ executionId, teams: [team], submittedBy: other.id, name: "x", payload: {} });
  }
  const entries: Record<string, { actorId: string; route: string; target: object; status?: number }> = {
    teamMine: { actorId: other.id, route: route("SecretService/PutSecret"), target: { team: mine, secretName: "s" } },
    teamTheirs: { actorId: other.id, route: route("SecretService/PutSecret"), target: { team: theirs, secretName: "s" } },
    createdMine: { actorId: admin.id, route: route("TeamService/CreateTeam"), target: { name: mine } },
    createdTheirs: { actorId: admin.id, route: route("TeamService/CreateTeam"), target: { name: theirs } },
    namedNotTeam: { actorId: other.id, route: route("ProductService/RegisterProduct"), target: { name: mine, team: theirs } },
    runMine: { actorId: other.id, route: route("ExecutionService/RetryTask"), target: { executionId: runInMine, taskId: "t" } },
    runTheirs: { actorId: other.id, route: route("ExecutionService/RetryTask"), target: { executionId: runInTheirs, taskId: "t" } },
    own: { actorId: member.id, route: route("ExecutionService/SubmitExecution"), target: { name: "dag", tasks: 1 } },
    adminOnly: { actorId: admin.id, route: route("UserService/CreateUser"), target: { email: "someone@example.com" } },
    refusedMine: { actorId: other.id, route: route("SecretService/RevokeSecret"), target: { team: mine }, status: 403 },
  };
  // Through the chain, as the console writes them (audit.ts).
  for (const [name, entry] of Object.entries(entries)) {
    const requestId = `${prefix}-${name}`;
    await appendAuditEntry(db, { ...entry, target: entry.target as Record<string, unknown>, method: "POST", status: entry.status ?? 200, requestId });
    const [row] = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.requestId, requestId));
    ids[name] = row!.id;
  }
});

afterAll(async () => {
  await db.delete(auditLog).where(inArray(auditLog.id, Object.values(ids)));
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.executionId, [runInMine, runInTheirs]));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

describe("who sees the audit log in Observe", () => {
  it("shows a member their own entries and what was done to their teams and runs, by anyone", async () => {
    expect(await seen(member.token)).toEqual(["createdMine", "own", "refusedMine", "runMine", "teamMine"]);
  });

  it("shows an admin every entry", async () => {
    expect(await seen(admin.token)).toEqual(Object.keys(ids).sort());
  });

  it("filters within what the caller may see: a team, their own, the refused", async () => {
    expect(await seen(member.token, { team: theirs })).toEqual([]);
    expect(await seen(admin.token, { team: theirs })).toEqual(["createdTheirs", "namedNotTeam", "runTheirs", "teamTheirs"]);
    expect(await seen(member.token, { mine: true })).toEqual(["own"]);
    expect(await seen(member.token, { refusedOnly: true })).toEqual(["refusedMine"]);
  });

  it("pages newest first", async () => {
    const first = await call<Page>(admin.token, "ObserveService/ListAudit", { limit: 2 });
    expect(first.body.entries).toHaveLength(2);
    const next = await call<Page>(admin.token, "ObserveService/ListAudit", { limit: 2, before: first.body.nextBefore });
    expect(Number(next.body.entries?.[0]?.id)).toBeLessThan(Number(first.body.entries?.[1]?.id));
  });

  it("needs a signed-in caller", async () => {
    expect((await call(undefined, "ObserveService/ListAudit", {})).code).toBe("unauthenticated");
  });
});
