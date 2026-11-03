// SPDX-License-Identifier: MIT
/**
 * Schedules (src/core/schedules.ts, src/scheduleRunner.ts): who makes them
 * and what's refused; a due schedule starts once, as its bot, for its team,
 * even with two consoles at once; a refused start is kept and told to the
 * team's maintainers, as is one that can't run again; a time claimed and
 * not started is started by another console; pausing. kernel-api and the registry are stubbed; the
 * rest is the real console on the real test database.
 */
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, upsertProduct } from "../src/db/queries.js";
import { notificationEvents, products, schedules, submittedExecutions, teamMemberships, teams, users as usersTable } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { submitExecution } from "../src/kernel/client.js";
import { config } from "../src/config.js";
import { recordNextSchedule } from "../src/k8s.js";
import { startDueSchedules } from "../src/scheduleRunner.js";
import { caller, rpcClient } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  recordNextSchedule: vi.fn(() => Promise.resolve()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
  updateIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../src/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/registry.js")>()),
  missingImages: vi.fn(() => Promise.resolve([])),
  pinImages: vi.fn((images: string[]) =>
    Promise.resolve({ pinned: new Map(images.map((i) => [i, `${i}@sha256:${"c".repeat(64)}`])), unresolved: [] }),
  ),
}));
vi.mock("../src/kernel/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/client.js")>();
  const { randomUUID: uuid } = await import("node:crypto");
  return { ...actual, submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })) };
});
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "registry.example/", additional: [], version: "1" })),
}));

const prefix = `sch-${randomUUID().slice(0, 6)}`;
const prov = `${prefix}-prov`;
const own = `${prefix}-own`;
const silent = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Parameters<typeof startDueSchedules>[0];

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let maintainer: { id: string; email: string };
let bot: { id: string; email: string };
let maintainerToken: string;
let memberToken: string;
let ownTeamId: string;

const nightly = (extra: object = {}) => ({
  team: own,
  name: "nightly",
  kind: "action",
  runnableTeam: prov,
  runnableName: `${prov}-thing-run`,
  parameters: { text: "hello" },
  cron: "0 2 * * *",
  timeZone: "Europe/Berlin",
  botId: bot.id,
  ...extra,
});

const ours = () => vi.mocked(submitExecution).mock.calls.filter((c) => (c[0] as { tasks: Record<string, unknown>[] }).tasks[0]?.["team"] === prov);

beforeAll(async () => {
  app = await buildApp();
  const provTeam = await createTeam(prov);
  ownTeamId = (await createTeam(own)).id;
  await upsertProduct({
    name: `${prov}-thing-run`,
    image: `registry.example/${prov}/thing:1`,
    action: "run",
    teamId: provTeam.id,
    shareWith: ["*"],
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 10 } } },
  });
  maintainer = await users.makeUser();
  const member = await users.makeUser();
  bot = await users.makeUser();
  await db.update(usersTable).set({ isBot: true }).where(eq(usersTable.id, bot.id));
  await addTeamMember(maintainer.id, ownTeamId, "maintainer");
  await addTeamMember(member.id, ownTeamId, "member");
  await addTeamMember(bot.id, ownTeamId, "maintainer");
  [maintainerToken, memberToken] = await Promise.all([maintainer, member].map((u) => users.signIn(u.email)));
});

beforeEach(() => {
  vi.mocked(submitExecution).mockClear();
});

afterAll(async () => {
  await db.delete(notificationEvents).where(like(notificationEvents.key, "schedule:%"));
  await db.delete(submittedExecutions).where(eq(submittedExecutions.onBehalfOf, own));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("making a schedule", () => {
  it("is a maintainer's, as one of the team's bots, and refuses what couldn't run", async () => {
    expect((await call(memberToken, "ScheduleService/CreateSchedule", nightly())).code).toBe("permission_denied");
    for (const [bad, failure] of [
      [{ cron: "0 2 * *" }, "BAD_SCHEDULE"],
      [{ cron: "* * * * *" }, "BAD_SCHEDULE"],
      [{ timeZone: "Mars/Olympus" }, "BAD_SCHEDULE"],
      [{ botId: maintainer.id }, "BAD_SCHEDULE"],
      [{ parameters: { text: "far too long a text" } }, "INVALID_PARAMETERS"],
    ] as const) {
      expect((await call(maintainerToken, "ScheduleService/CreateSchedule", nightly(bad))).failure).toBe(failure);
    }
    const made = await call<{ schedule?: { nextRunAt?: string; botEmail?: string } }>(maintainerToken, "ScheduleService/CreateSchedule", nightly());
    expect(made.code).toBe("ok");
    expect(made.body.schedule?.botEmail).toBe(bot.email);
    // 02:00 in Berlin.
    expect(new Date(made.body.schedule?.nextRunAt ?? "").getUTCHours()).toBeOneOf([0, 1]);
    expect((await call<{ schedules?: unknown[] }>(memberToken, "ScheduleService/ListSchedules", { team: own })).body.schedules).toHaveLength(1);
  });
});

describe("a due schedule", () => {
  it("starts once, as its bot, for its team, even with two consoles at once", async () => {
    await db.update(schedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schedules.teamId, ownTeamId));
    await Promise.all([startDueSchedules(silent), startDueSchedules(silent)]);
    expect(ours()).toHaveLength(1);
    const [row] = await db.select().from(schedules).where(eq(schedules.teamId, ownTeamId));
    expect(row?.lastError).toBeNull();
    expect(row?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    const [run] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, row?.lastExecutionId ?? ""));
    expect(run).toMatchObject({ submittedBy: bot.id, onBehalfOf: own, scheduleId: row?.id, templateParameters: { text: "hello" } });
    // Listed with the schedule that started it (the run is its step's team's).
    const admin = await users.signIn((await users.makeUser({ admin: true })).email);
    const listed = await call<{ executions?: { executionId: string; schedule?: string }[] }>(admin, "ExecutionService/ListExecutions", { team: prov });
    expect(listed.body.executions?.find((e) => e.executionId === run?.executionId)?.schedule).toBe("nightly");
    await startDueSchedules(silent);
    expect(ours()).toHaveLength(1);
  });

  it("refused, is kept on the schedule and told to the team's maintainers", async () => {
    await db.delete(teamMemberships).where(eq(teamMemberships.userId, bot.id));
    const [row] = await db.update(schedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schedules.teamId, ownTeamId)).returning();
    await startDueSchedules(silent);
    expect(ours()).toEqual([]);
    const [after] = await db.select().from(schedules).where(eq(schedules.id, row?.id ?? ""));
    expect(after?.lastError).toMatch(/aren't a member of team/);
    const [event] = await db.select().from(notificationEvents).where(like(notificationEvents.key, `schedule:${row?.id ?? ""}%`));
    expect(event?.title).toBe("Schedule nightly couldn't start");
  });

  it("tells the sleeper when the next one runs, once each time it changes", async () => {
    Object.assign(config, { activityConfigMap: "console-activity", platformNamespace: "vertra-system" });
    try {
      const [row] = await db.select().from(schedules).where(eq(schedules.teamId, ownTeamId));
      const soon = new Date(Date.now() + 3_600_000);
      await db.update(schedules).set({ nextRunAt: soon }).where(eq(schedules.id, row?.id ?? ""));
      vi.mocked(recordNextSchedule).mockClear();
      await startDueSchedules(silent);
      await startDueSchedules(silent);
      const calls = vi.mocked(recordNextSchedule).mock.calls;
      expect(calls).toHaveLength(1);
      // The earliest of every enabled schedule here: ours, unless another test's comes first.
      expect(calls[0]?.slice(0, 2)).toEqual(["vertra-system", "console-activity"]);
      expect((calls[0]?.[2] as Date).getTime()).toBeLessThanOrEqual(soon.getTime());
    } finally {
      Object.assign(config, { activityConfigMap: "", platformNamespace: "" });
    }
  });

  it("that can't run again (its time zone no longer reads) runs this once, and says why", async () => {
    await addTeamMember(bot.id, ownTeamId, "maintainer");
    const [row] = await db
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() - 60_000), timeZone: "Mars/Olympus" })
      .where(eq(schedules.teamId, ownTeamId))
      .returning();
    try {
      await startDueSchedules(silent);
      expect(ours()).toHaveLength(1);
      const [after] = await db.select().from(schedules).where(eq(schedules.id, row?.id ?? ""));
      expect(after?.nextRunAt).toBeNull();
      expect(after?.lastError).toMatch(/^It won't run again: "Mars\/Olympus" isn't a time zone/);
      const events = await db.select().from(notificationEvents).where(like(notificationEvents.key, `schedule:${row?.id ?? ""}%:stopped`));
      expect(events.map((e) => e.title)).toEqual(["Schedule nightly won't run again"]);
    } finally {
      await db.update(schedules).set({ timeZone: "Europe/Berlin", lastError: null }).where(eq(schedules.id, row?.id ?? ""));
    }
  });

  it("claimed by a console that stopped before starting it, is started by another", async () => {
    const due = new Date(Date.now() - 10 * 60_000);
    const [row] = await db
      .update(schedules)
      .set({ nextRunAt: new Date(Date.now() + 3_600_000), claimedRunAt: due, claimedAt: new Date() })
      .where(eq(schedules.teamId, ownTeamId))
      .returning();
    await startDueSchedules(silent);
    expect(ours()).toEqual([]); // still the claiming console's to start
    await db.update(schedules).set({ claimedAt: new Date(Date.now() - 6 * 60_000) }).where(eq(schedules.id, row?.id ?? ""));
    await Promise.all([startDueSchedules(silent), startDueSchedules(silent)]);
    expect(ours()).toHaveLength(1);
    expect((ours()[0]?.[0] as { requestId?: string }).requestId).toMatch(new RegExp(`schedule:${row?.id ?? ""}:${due.toISOString()}$`));
    const [after] = await db.select().from(schedules).where(eq(schedules.id, row?.id ?? ""));
    expect(after).toMatchObject({ claimedRunAt: null, claimedAt: null, lastRunAt: due });
  });

  it("paused, doesn't run", async () => {
    await addTeamMember(bot.id, ownTeamId, "maintainer");
    const [row] = await db.select().from(schedules).where(eq(schedules.teamId, ownTeamId));
    const paused = await call<{ schedule?: { enabled?: boolean; nextRunAt?: string } }>(maintainerToken, "ScheduleService/UpdateSchedule", { id: row?.id, enabled: false });
    expect(paused.body.schedule?.enabled ?? false).toBe(false);
    expect(paused.body.schedule?.nextRunAt).toBeUndefined();
    await startDueSchedules(silent);
    expect(ours()).toEqual([]);
    expect((await call(maintainerToken, "ScheduleService/DeleteSchedule", { id: row?.id })).code).toBe("ok");
  });
});
