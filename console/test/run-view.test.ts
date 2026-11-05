// SPDX-License-Identifier: MIT
/**
 * Who sees what of a run that spans teams (core/runView.ts): its owners
 * (admins, the submitter, the team a template run was for) every step; a
 * provider's member their own steps in full and, of the rest, only state
 * and failure codes. A raw DAG's owners are admins and its submitter alone
 * (2026-11-05): each of its teams' members sees its own steps in full.
 */
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, recordSubmittedExecution } from "../src/db/queries.js";
import { submittedExecutions, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { rpcClient } from "./rpc.js";

const prefix = `rv-${randomUUID().slice(0, 6)}`;
const consumer = `${prefix}-consumer`;
const provider = `${prefix}-provider`;
const templateRun = randomUUID();
const rawRun = randomUUID();

const failure = { code: "PRODUCT_FAILED", message: "the consumer's database password was rejected" };

vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  getExecution: vi.fn((executionId: string) =>
    Promise.resolve({
      executionId,
      name: "run",
      state: "FAILED",
      tasks: [
        { taskId: "theirs", state: "SUCCEEDED", attemptCount: 1, outputs: { url: "https://p.example" }, failure: null, dependsOn: [], startedAt: null, completedAt: null, attempts: [], approvalRequired: false, approvedBy: "", approvedAt: null, awaitingSince: null, waitingFor: null },
        { taskId: "mine", state: "FAILED", attemptCount: 1, outputs: { secretish: "consumer data" }, failure, dependsOn: ["theirs"], startedAt: null, completedAt: null, attempts: [{ number: 1, startedAt: null, completedAt: null, failure, requestedBy: "", trigger: "", actedAs: "", image: "" }], approvalRequired: false, approvedBy: "", approvedAt: null, awaitingSince: null, waitingFor: { projectId: "consumer data" } },
      ],
    }),
  ),
  getExecutionEvents: vi.fn(() =>
    Promise.resolve({
      events: [
        { id: 1, eventType: "TASK_SUCCEEDED", taskId: "t1", payload: { taskKey: "theirs", attempt: 1, outputs: { url: "https://p.example" } }, createdAt: null },
        { id: 2, eventType: "TASK_FAILED", taskId: "t2", payload: { taskKey: "mine", attempt: 1, error: failure, willRetry: false }, createdAt: null },
      ],
      nextCursor: null,
    }),
  ),
  getExecutionLogs: vi.fn(() =>
    Promise.resolve({
      tasks: [
        { taskId: "theirs", lines: ['{"level":"info","msg":"provisioned"}', "provider debug"] },
        { taskId: "mine", lines: ['{"level":"info","msg":"consumer step"}', "consumer debug"] },
      ],
    }),
  ),
}));

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
let consumerMember: string;
let providerMember: string;
let submitter: string;
let admin: string;

const payload = {
  name: "run",
  tasks: [
    { id: "theirs", team: provider, image: "p", action: "make", inputs: { size: "small" } },
    { id: "mine", team: consumer, image: "c", action: "use", inputs: { password: "consumer input" }, dependsOn: ["theirs"] },
  ],
};

type Detail = {
  execution?: {
    tasks: { taskId: string; outputs?: Record<string, unknown>; failure?: Record<string, unknown>; attempts?: { failure?: Record<string, unknown> }[] }[];
    dag?: { tasks: { id: string; inputs?: Record<string, unknown> }[] };
    templateParameters?: Record<string, unknown>;
  };
};
type Events = { events?: { payload?: Record<string, unknown> }[] };
type Logs = { tasks?: { taskId: string; lines?: string[]; hidden?: number }[] };

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const c = await makeUser();
  const p = await makeUser();
  const s = await makeUser();
  consumerMember = await signIn(c.email);
  providerMember = await signIn(p.email);
  submitter = await signIn(s.email);
  admin = await signIn((await makeUser({ admin: true })).email);
  const consumerTeam = await createTeam(consumer);
  const providerTeam = await createTeam(provider);
  await addTeamMember(c.id, consumerTeam.id);
  await addTeamMember(s.id, consumerTeam.id);
  await addTeamMember(p.id, providerTeam.id);
  await recordSubmittedExecution({
    executionId: templateRun,
    teams: [provider, consumer],
    submittedBy: s.id,
    name: "run",
    payload,
    template: "provision",
    templateParameters: { region: "eu" },
    onBehalfOf: consumer,
  });
  await recordSubmittedExecution({ executionId: rawRun, teams: [provider, consumer], submittedBy: s.id, name: "raw", payload });
});

afterAll(async () => {
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.executionId, [templateRun, rawRun]));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await app.close();
  await cleanUp();
});

const detail = async (token: string, executionId: string) =>
  (await rpc("ExecutionService", "GetExecution", { executionId }, { token })).json<Detail>().execution!;
const events = async (token: string, executionId: string) =>
  (await rpc("ExecutionService", "ListExecutionEvents", { executionId }, { token })).json<Events>().events ?? [];
const logs = async (token: string, executionId: string) =>
  (await rpc("ExecutionService", "GetExecutionLogs", { executionId }, { token })).json<Logs>().tasks ?? [];
const task = <T extends { taskId: string }>(list: T[], id: string) => list.find((t) => t.taskId === id)!;

describe("a template run, seen by", () => {
  it("the team it was run for: every step", async () => {
    const seen = await detail(consumerMember, templateRun);
    expect(task(seen.tasks, "theirs").outputs).toEqual({ url: "https://p.example" });
    expect(task(seen.tasks, "mine").outputs).toEqual({ secretish: "consumer data" });
    expect(task(seen.tasks, "mine").waitingFor).toEqual({ projectId: "consumer data" });
    expect(seen.dag?.tasks.find((t) => t.id === "mine")?.inputs).toEqual({ password: "consumer input" });
    expect(seen.templateParameters).toEqual({ region: "eu" });
  });

  it("the provider's member: their own step in full, of the consumer's only its state and failure code", async () => {
    const seen = await detail(providerMember, templateRun);
    expect(task(seen.tasks, "theirs").outputs).toEqual({ url: "https://p.example" });
    const mine = task(seen.tasks, "mine");
    expect(mine.outputs ?? null).toBeNull();
    // The code, and an empty message.
    expect(mine.failure?.["code"]).toBe("PRODUCT_FAILED");
    expect(mine.failure?.["message"] ?? "").toBe("");
    expect(mine.attempts?.[0]?.failure?.["code"]).toBe("PRODUCT_FAILED");
    expect(seen.dag?.tasks.find((t) => t.id === "mine")?.inputs ?? {}).toEqual({});
    expect(seen.dag?.tasks.find((t) => t.id === "theirs")?.inputs).toEqual({ size: "small" });
    expect(seen.templateParameters ?? null).toBeNull();
    expect(JSON.stringify(seen)).not.toContain("consumer data");
    expect(JSON.stringify(seen)).not.toContain("password was rejected");
  });

  it("the provider's member: events and logs likewise", async () => {
    const seen = await events(providerMember, templateRun);
    expect(seen[0]?.payload?.["outputs"]).toEqual({ url: "https://p.example" });
    expect(seen[1]?.payload).toEqual({ taskKey: "mine", attempt: 1, willRetry: false, error: { code: "PRODUCT_FAILED" } });

    const lines = await logs(providerMember, templateRun);
    expect(task(lines, "theirs").lines).toHaveLength(2);
    expect(task(lines, "mine").lines ?? []).toEqual([]);
    expect(task(lines, "mine").hidden).toBe(2);
    // The consumer's member still gets the provider's INFO line only.
    expect(task(await logs(consumerMember, templateRun), "theirs").lines).toEqual(['{"level":"info","msg":"provisioned"}']);
  });

  it("whoever ran it: every step", async () => {
    expect(task((await detail(submitter, templateRun)).tasks, "mine").outputs).toEqual({ secretish: "consumer data" });
  });
});

// Submitted by a member of the consumer team; consumerMember is in it too,
// but didn't submit it.
describe("a raw DAG, seen by", () => {
  it("a member of one of its teams who didn't submit it: their team's steps in full, of the other's only state and failure code", async () => {
    const seen = await detail(consumerMember, rawRun);
    expect(task(seen.tasks, "mine").outputs).toEqual({ secretish: "consumer data" });
    expect(task(seen.tasks, "mine").failure?.["message"]).toBe(failure.message);
    expect(seen.dag?.tasks.find((t) => t.id === "mine")?.inputs).toEqual({ password: "consumer input" });
    const theirs = task(seen.tasks, "theirs");
    expect(theirs.outputs ?? null).toBeNull();
    expect(seen.dag?.tasks.find((t) => t.id === "theirs")?.inputs ?? {}).toEqual({});
    expect(JSON.stringify(seen)).not.toContain("p.example");

    const theirsFromProvider = await detail(providerMember, rawRun);
    expect(task(theirsFromProvider.tasks, "theirs").outputs).toEqual({ url: "https://p.example" });
    const mine = task(theirsFromProvider.tasks, "mine");
    expect(mine.outputs ?? null).toBeNull();
    expect(mine.failure?.["code"]).toBe("PRODUCT_FAILED");
    expect(mine.failure?.["message"] ?? "").toBe("");
    expect(theirsFromProvider.dag?.tasks.find((t) => t.id === "mine")?.inputs ?? {}).toEqual({});
    expect(JSON.stringify(theirsFromProvider)).not.toContain("consumer data");
    expect(JSON.stringify(theirsFromProvider)).not.toContain("password was rejected");
  });

  it("a member of one of its teams: events and logs likewise", async () => {
    const seen = await events(consumerMember, rawRun);
    expect(seen[0]?.payload).toEqual({ taskKey: "theirs", attempt: 1 });
    expect(seen[1]?.payload?.["error"]).toEqual(failure);

    const lines = await logs(consumerMember, rawRun);
    expect(task(lines, "mine").lines).toHaveLength(2);
    expect(task(lines, "theirs").lines ?? []).toEqual([]);
    expect(task(lines, "theirs").hidden).toBe(2);
    expect(task(await logs(providerMember, rawRun), "mine").lines ?? []).toEqual([]);
  });

  it("whoever submitted it, and an admin: every step", async () => {
    for (const token of [submitter, admin]) {
      const seen = await detail(token, rawRun);
      expect(task(seen.tasks, "mine").outputs).toEqual({ secretish: "consumer data" });
      expect(task(seen.tasks, "theirs").outputs).toEqual({ url: "https://p.example" });
      expect(seen.dag?.tasks.find((t) => t.id === "theirs")?.inputs).toEqual({ size: "small" });
      expect((await events(token, rawRun))[0]?.payload?.["outputs"]).toEqual({ url: "https://p.example" });
      expect(task(await logs(token, rawRun), "theirs").lines?.length).toBeGreaterThan(0);
    }
  });
});
