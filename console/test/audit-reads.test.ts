// SPDX-License-Identifier: MIT
/**
 * Who read what (auditReads.ts, rpc/interceptors.ts's auditReads): each call
 * returning a run's outputs, failure messages or logs, resources' provided
 * values, or a team's secret or store names, records what it returned to
 * whom, by name and never its content, once per DEDUPE_MS; a step whose
 * outputs the caller doesn't see (core/runView.ts) isn't recorded as read;
 * a row that can't be written is logged and the read still answered; the
 * chat agent's reads are the person's; admins alone list them, and that's
 * recorded too. Pruning old rows is in retention.test.ts.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq, inArray, like } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executionRead, forgetRecentReads, READERS, readsWritten, recordReads, writer } from "../src/auditReads.js";
import { callerForUser } from "../src/auth/plugin.js";
import { runTool, type TurnState } from "../src/chat/tools.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, recordSubmittedExecution } from "../src/db/queries.js";
import { auditReads, resources, submittedExecutions, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

const prefix = `ar-${randomUUID().slice(0, 6)}`;
const consumer = `${prefix}-consumer`;
const provider = `${prefix}-provider`;
const run = randomUUID();
const resourceId = randomUUID();
const OUTPUT = `output-${randomUUID()}`;
const MESSAGE = `message-${randomUUID()}`;
const LINE = `line-${randomUUID()}`;
const SECRET_VALUE = `value-${randomUUID()}`;
const PROVIDED = `provided-${randomUUID()}`;

const failure = { code: "PRODUCT_FAILED", message: MESSAGE };

vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  getExecution: vi.fn((executionId: string) =>
    Promise.resolve({
      executionId,
      name: "run",
      state: "FAILED",
      tasks: [
        { taskId: "theirs", state: "SUCCEEDED", attemptCount: 1, outputs: { url: OUTPUT }, failure: null, dependsOn: [], startedAt: null, completedAt: null, attempts: [], approvalRequired: false, approvedBy: "", approvedAt: null, awaitingSince: null, waitingFor: null },
        { taskId: "mine", state: "FAILED", attemptCount: 1, outputs: null, failure, dependsOn: ["theirs"], startedAt: null, completedAt: null, attempts: [{ number: 1, startedAt: null, completedAt: null, failure, requestedBy: "", trigger: "", actedAs: "", image: "" }], approvalRequired: false, approvedBy: "", approvedAt: null, awaitingSince: null, waitingFor: null },
        { taskId: "later", state: "BLOCKED", attemptCount: 0, outputs: null, failure: null, dependsOn: ["mine"], startedAt: null, completedAt: null, attempts: [], approvalRequired: false, approvedBy: "", approvedAt: null, awaitingSince: null, waitingFor: null },
      ],
    }),
  ),
  getExecutionEvents: vi.fn(() =>
    Promise.resolve({
      events: [
        { id: 1, eventType: "TASK_SUCCEEDED", taskId: "t1", payload: { taskKey: "theirs", attempt: 1, outputs: { url: OUTPUT } }, createdAt: null },
        { id: 2, eventType: "TASK_FAILED", taskId: "t2", payload: { taskKey: "mine", attempt: 1, error: failure, willRetry: false }, createdAt: null },
        // The platform's own bookkeeping, not a step's content.
        { id: 3, eventType: "TASK_CLAIMED", taskId: "t3", payload: { taskKey: "later", owner: "scheduler-0", attempt: 1 }, createdAt: null },
      ],
      nextCursor: null,
    }),
  ),
  getExecutionLogs: vi.fn(() =>
    Promise.resolve({
      tasks: [
        { taskId: "theirs", lines: [`{"level":"info","msg":"${LINE}"}`, `${LINE} debug`] },
        { taskId: "mine", lines: [`{"level":"info","msg":"${LINE}"}`] },
      ],
    }),
  ),
}));
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  upsertSecretGrant: vi.fn(() => Promise.resolve()),
  listExternalSecrets: vi.fn(() => Promise.resolve([])),
  listSecretStores: vi.fn(() =>
    Promise.resolve([{ name: "team-vault", provider: "gcpsm", providerLabel: "Google Secret Manager", location: "acme", identity: null, usesStoredCredential: true, ready: true, message: null }]),
  ),
}));
// An order's plan, as it would fill an input with a resource's provided value.
vi.mock("../src/core/orders.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/orders.js")>()),
  previewOrder: vi.fn(() =>
    Promise.resolve({
      steps: [
        { id: "app", product: "x", added: false, inputs: { project: { kind: "resource", resourceId, value: PROVIDED }, size: { kind: "unset" } } },
        { id: "other", product: "y", added: false, inputs: { name: { kind: "unset" } } },
      ],
      problems: [],
      suggestions: [],
    }),
  ),
}));

let app: FastifyInstance;
let loki: Server;
const { makeUser, signIn, cleanUp } = rpcClient(() => app);
const call = caller(() => app);
let admin: { id: string; token: string };
let consumerMember: { id: string; token: string };
let providerMember: { id: string; token: string };

const payload = {
  name: "run",
  tasks: [
    { id: "theirs", team: provider, image: "p", action: "make", inputs: {} },
    { id: "mine", team: consumer, image: "c", action: "use", inputs: {}, dependsOn: ["theirs"] },
    { id: "later", team: consumer, image: "c", action: "use", inputs: {}, dependsOn: ["mine"] },
  ],
};

async function account(isAdmin = false) {
  const user = await makeUser({ admin: isAdmin });
  return { id: user.id, token: await signIn(user.email) };
}

/** The reads `actorId` made through `route`, once written. */
async function readsBy(actorId: string, route: string) {
  await readsWritten();
  return db
    .select()
    .from(auditReads)
    .where(and(eq(auditReads.actorId, actorId), eq(auditReads.route, `vennir.console.v1.${route}`)));
}

/** Nothing the caller was given is in the record, only names. */
function expectNoContent(rows: unknown[]) {
  const recorded = JSON.stringify(rows);
  for (const content of [OUTPUT, MESSAGE, LINE, SECRET_VALUE, PROVIDED]) expect(recorded).not.toContain(content);
}

function envelope(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/** A fake logger that keeps what it was given. */
function keptLog() {
  const lines: { level: string; fields: Record<string, unknown> }[] = [];
  const at = (level: string) => (fields: Record<string, unknown>) => void lines.push({ level, fields });
  return { lines, log: { info: at("info"), error: at("error") } as unknown as FastifyBaseLogger };
}

beforeAll(async () => {
  loki = createServer((_req, res) => {
    const ns = `${String(Date.now() - 1000)}000000`;
    const result = [
      { stream: { component: "step", namespace: consumer, level: "debug", execution_id: run, task: "mine", attempt: "1" }, values: [[ns, LINE]] },
      { stream: { component: "step", namespace: consumer, level: "info", execution_id: run, task: "later", attempt: "1" }, values: [[ns, LINE]] },
    ];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "success", data: { resultType: "streams", result } }));
  }).listen(0, "127.0.0.1");
  await once(loki, "listening");
  config.logs.lokiUrl = `http://127.0.0.1:${String((loki.address() as AddressInfo).port)}`;

  app = await buildApp();
  await app.ready();
  admin = await account(true);
  consumerMember = await account();
  providerMember = await account();
  await addTeamMember(consumerMember.id, (await createTeam(consumer)).id);
  await addTeamMember(providerMember.id, (await createTeam(provider)).id);
  // A template run for the consumer: the provider's member sees only "theirs" in full.
  await recordSubmittedExecution({
    executionId: run,
    teams: [provider, consumer],
    submittedBy: consumerMember.id,
    name: "run",
    payload,
    template: "provision",
    templateParameters: {},
    onBehalfOf: consumer,
  });
  await db.insert(resources).values({
    id: resourceId,
    product: `${provider}-p-make`,
    productTeam: provider,
    type: "gcp/project",
    externalId: `${prefix}-project`,
    ownerTeam: consumer,
    executionId: run,
    taskId: "theirs",
    provides: [{ type: `${prefix}/project`, value: PROVIDED, output: "projectId" }],
  });
});

afterAll(async () => {
  config.logs.lokiUrl = "";
  loki.close();
  await readsWritten();
  await db.delete(auditReads).where(inArray(auditReads.actorId, [admin.id, consumerMember.id, providerMember.id]));
  await db.delete(resources).where(eq(resources.id, resourceId));
  await db.delete(submittedExecutions).where(eq(submittedExecutions.executionId, run));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await app.close();
  await cleanUp();
});

describe("reading a run", () => {
  it("records the steps whose outputs or failures were returned, with the run and their teams, never what they said", async () => {
    expect((await call(consumerMember.token, "ExecutionService/GetExecution", { executionId: run })).code).toBe("ok");
    const rows = await readsBy(consumerMember.id, "ExecutionService/GetExecution");
    expect(rows).toHaveLength(1);
    // "later" has nothing to show yet: not read.
    expect(rows[0]).toMatchObject({ executionIds: [run], teams: [consumer, provider].sort(), target: { tasks: ["mine", "theirs"] }, clientIp: "10.9.0.1" });
    expect(rows[0]?.requestId).toBeTruthy();
    expectNoContent(rows);
  });

  it("records the same read again once its window has passed, not before", async () => {
    expect((await call(consumerMember.token, "ExecutionService/GetExecution", { executionId: run })).code).toBe("ok");
    expect((await call(consumerMember.token, "ExecutionService/GetExecution", { executionId: run })).code).toBe("ok");
    expect(await readsBy(consumerMember.id, "ExecutionService/GetExecution")).toHaveLength(1);
    forgetRecentReads();
    expect((await call(consumerMember.token, "ExecutionService/GetExecution", { executionId: run })).code).toBe("ok");
    expect(await readsBy(consumerMember.id, "ExecutionService/GetExecution")).toHaveLength(2);
  });

  it("doesn't record a step the caller wasn't shown as read", async () => {
    const seen = await call<{ execution: { tasks: { taskId: string; outputs?: unknown }[] } }>(providerMember.token, "ExecutionService/GetExecution", { executionId: run });
    expect(seen.body?.execution.tasks.find((t) => t.taskId === "mine")?.outputs).toBeUndefined();
    const rows = await readsBy(providerMember.id, "ExecutionService/GetExecution");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executionIds: [run], teams: [provider], target: { tasks: ["theirs"] } });
  });

  it("records a watch's steps as it streams them", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/vennir.console.v1.ExecutionService/WatchExecution",
      headers: { "content-type": "application/connect+json", authorization: `Bearer ${providerMember.token}` },
      payload: envelope({ executionId: run }),
      remoteAddress: "10.9.0.1",
    });
    expect(response.statusCode).toBe(200);
    const rows = await readsBy(providerMember.id, "ExecutionService/WatchExecution");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executionIds: [run], teams: [provider], target: { tasks: ["theirs"] } });
    expectNoContent(rows);
  });

  it("records the events whose outputs or failure messages were returned, with the steps' teams", async () => {
    expect((await call(consumerMember.token, "ExecutionService/ListExecutionEvents", { executionId: run })).code).toBe("ok");
    const rows = await readsBy(consumerMember.id, "ExecutionService/ListExecutionEvents");
    expect(rows).toHaveLength(1);
    // "later"'s claim is the scheduler's bookkeeping, not its content.
    expect(rows[0]).toMatchObject({ executionIds: [run], teams: [consumer, provider].sort(), target: { tasks: ["mine", "theirs"] } });
    expectNoContent(rows);

    expect((await call(providerMember.token, "ExecutionService/ListExecutionEvents", { executionId: run })).code).toBe("ok");
    expect((await readsBy(providerMember.id, "ExecutionService/ListExecutionEvents"))[0]).toMatchObject({ teams: [provider], target: { tasks: ["theirs"] } });
  });

  it("records the steps whose logs were returned, counted, not quoted", async () => {
    expect((await call(providerMember.token, "ExecutionService/GetExecutionLogs", { executionId: run })).code).toBe("ok");
    const rows = await readsBy(providerMember.id, "ExecutionService/GetExecutionLogs");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executionIds: [run], teams: [provider], target: { tasks: ["theirs"], lines: 2 } });
    expectNoContent(rows);
  });

  it("records a log search as one row: its runs, each with its steps", async () => {
    expect((await call(consumerMember.token, "ObserveService/SearchLogs", { team: consumer })).code).toBe("ok");
    const rows = await readsBy(consumerMember.id, "ObserveService/SearchLogs");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executionIds: [run], teams: [consumer], target: { runs: { [run]: ["later", "mine"] } } });
    expectNoContent(rows);
  });

  it("records what the chat agent's tools read, as the person it acts for", async () => {
    const who = await callerForUser(providerMember.id);
    const state: TurnState = {
      caller: who!,
      team: null,
      log: app.log,
      sources: [],
      cart: null,
      via: { route: "vennir.console.v1.ChatService/AskStream", clientIp: "10.7.0.1", requestId: "chat-request" },
    };
    const { ok } = await runTool(state, "get_run", JSON.stringify({ executionId: run }));
    expect(ok).toBe(true);
    const rows = await readsBy(providerMember.id, "ChatService/AskStream");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      executionIds: [run],
      teams: [provider],
      target: { tasks: ["theirs"], tool: "get_run" },
      clientIp: "10.7.0.1",
      requestId: "chat-request",
    });
    expectNoContent(rows);
  });
});

describe("reading what runs made", () => {
  it("records a resource list as one row: the resources, their runs and teams", async () => {
    expect((await call(consumerMember.token, "ResourceService/ListResources", { team: consumer })).code).toBe("ok");
    const rows = await readsBy(consumerMember.id, "ResourceService/ListResources");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executionIds: [run], teams: [consumer, provider].sort(), target: { resources: [resourceId] } });
    expectNoContent(rows);
  });

  it("records an order's plan that filled an input with a resource's value, looking up its run", async () => {
    expect((await call(consumerMember.token, "OrderService/PreviewOrder", { team: consumer, actions: ["x"] })).code).toBe("ok");
    const rows = await readsBy(consumerMember.id, "OrderService/PreviewOrder");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executionIds: [run], teams: [consumer, provider].sort(), target: { resources: [resourceId] } });
    expectNoContent(rows);
  });

  it("records the chat agent's plan_order the same way", async () => {
    const who = await callerForUser(consumerMember.id);
    const state: TurnState = { caller: who!, team: consumer, log: app.log, sources: [], cart: null, via: { route: "vennir.console.v1.ChatService/Ask", clientIp: "", requestId: "" } };
    expect((await runTool(state, "plan_order", JSON.stringify({ actions: ["x"] }))).ok).toBe(true);
    const rows = await readsBy(consumerMember.id, "ChatService/Ask");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executionIds: [run], target: { resources: [resourceId], tool: "plan_order" } });
  });
});

describe("reading a team's secrets", () => {
  it("records the names listed, never a value; a listing of nothing isn't a read", async () => {
    expect((await call(consumerMember.token, "SecretService/ListSecrets", { team: consumer })).code).toBe("ok");
    expect(await readsBy(consumerMember.id, "SecretService/ListSecrets")).toHaveLength(0);

    const put = await call(consumerMember.token, "SecretService/PutSecret", { team: consumer, secretName: "db-password", data: { value: SECRET_VALUE } });
    expect(put.code).toBe("ok");
    expect((await call(consumerMember.token, "SecretService/ListSecrets", { team: consumer })).code).toBe("ok");
    const rows = await readsBy(consumerMember.id, "SecretService/ListSecrets");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executionIds: [], teams: [consumer], target: { secrets: ["db-password"] } });
    expectNoContent(rows);
  });

  it("records the SecretStores listed", async () => {
    expect((await call(consumerMember.token, "SecretService/ListSecretStores", { team: consumer })).code).toBe("ok");
    const rows = await readsBy(consumerMember.id, "SecretService/ListSecretStores");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ teams: [consumer], target: { stores: ["team-vault"] } });
  });
});

describe("when a read can't be recorded", () => {
  it("still answers the read", async () => {
    const insert = vi.spyOn(writer, "insert").mockRejectedValueOnce(new Error("the database is down"));
    try {
      const answered = await call<{ secrets: unknown[] }>(providerMember.token, "SecretService/ListSecretStores", { team: provider });
      expect(answered.code).toBe("ok");
      await readsWritten();
      expect(insert).toHaveBeenCalledTimes(1);
      expect(await readsBy(providerMember.id, "SecretService/ListSecretStores")).toHaveLength(0);
    } finally {
      insert.mockRestore();
    }
  });

  it("logs it loudly, with what it would have said, and records the next one", async () => {
    const insert = vi.spyOn(writer, "insert").mockRejectedValueOnce(new Error("the database is down"));
    const { lines, log } = keptLog();
    const who = { actorId: providerMember.id, route: `${prefix}/failing`, clientIp: "", requestId: "r1" };
    try {
      recordReads(log, who, [{ teams: [provider], target: { secrets: ["a"] } }]);
      await readsWritten();
      expect(lines.find((l) => l.level === "error")?.fields).toMatchObject({ event: "audit_read_write_failed", reads: [{ route: `${prefix}/failing`, target: { secrets: ["a"] } }] });
    } finally {
      insert.mockRestore();
    }
    // Not remembered as recorded: the same read again is written.
    recordReads(log, who, [{ teams: [provider], target: { secrets: ["a"] } }]);
    await readsWritten();
    expect(await db.select().from(auditReads).where(eq(auditReads.route, `${prefix}/failing`))).toHaveLength(1);
  });

  it("never turns a reader's failure into the caller's error", async () => {
    const original = READERS["vennir.console.v1.SecretService/ListSecretStores"]!;
    READERS["vennir.console.v1.SecretService/ListSecretStores"] = () => () => {
      throw new Error("a reader bug");
    };
    try {
      expect((await call(consumerMember.token, "SecretService/ListSecretStores", { team: consumer })).code).toBe("ok");
    } finally {
      READERS["vennir.console.v1.SecretService/ListSecretStores"] = original;
    }
  });
});

describe("telling a repeat from a new read", () => {
  const route = `${prefix}/repeats`;
  const rowsOf = async () => {
    await readsWritten();
    return db.select().from(auditReads).where(eq(auditReads.route, route));
  };
  const who = (clientIp: string) => ({ actorId: consumerMember.id, route, clientIp, requestId: "" });
  const step = (url: string) => executionRead(run, [{ taskId: "theirs", outputs: { url } }], payload);

  it("logs every read, gives a repeat no row, and gives the same step's changed outputs one", async () => {
    const { lines, log } = keptLog();
    recordReads(log, who("10.1.0.1"), step(OUTPUT));
    recordReads(log, who("10.1.0.1"), step(OUTPUT));
    expect(await rowsOf()).toHaveLength(1);
    expect(lines.filter((l) => l.fields["event"] === "audit_read")).toHaveLength(2);
    // What the hash of the content is for: never stored or logged.
    expect(JSON.stringify(lines)).not.toContain("content");

    recordReads(log, who("10.1.0.1"), step(`${OUTPUT}-changed`));
    const rows = await rowsOf();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => JSON.stringify(r.target) === JSON.stringify({ tasks: ["theirs"] }))).toBe(true);
  });

  it("gives the same read from a new address a row", async () => {
    const { log } = keptLog();
    const before = (await rowsOf()).length;
    recordReads(log, who("10.1.0.1"), step(OUTPUT));
    expect(await rowsOf()).toHaveLength(before);
    recordReads(log, who("192.0.2.7"), step(OUTPUT));
    const rows = await rowsOf();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)?.clientIp).toBe("192.0.2.7");
  });

  it("never dedupes reading who read", async () => {
    await call(admin.token, "AdminService/ListAuditReads", { team: provider });
    await call(admin.token, "AdminService/ListAuditReads", { team: provider });
    const recorded = await readsBy(admin.id, "AdminService/ListAuditReads");
    expect(recorded.filter((r) => (r.target as { team?: string }).team === provider)).toHaveLength(2);
  });
});

describe("a watch (WatchExecution)", () => {
  it("records each step's content once, again only when it changes", () => {
    const seen = new Map<string, string>();
    const first = [{ taskId: "theirs", outputs: { url: OUTPUT } }, { taskId: "mine", outputs: {} }];
    expect(executionRead(run, first, payload, seen)).toMatchObject([{ executionIds: [run], teams: [provider], target: { tasks: ["theirs"] } }]);
    expect(executionRead(run, first, payload, seen)).toEqual([]);
    const failed = [...first, { taskId: "mine", failure }];
    expect(executionRead(run, failed, payload, seen)).toMatchObject([{ executionIds: [run], teams: [consumer], target: { tasks: ["mine"] } }]);
  });
});

describe("listing who read what", () => {
  it("is for admins alone", async () => {
    const refused = await call(consumerMember.token, "AdminService/ListAuditReads", {});
    expect(refused.code).toBe("permission_denied");
    expect(await readsBy(consumerMember.id, "AdminService/ListAuditReads")).toHaveLength(0);
  });

  it("filters by run, team and reader, pages, and is itself recorded", async () => {
    type Page = { reads: { actorId?: string; route: string; executionIds: string[]; teams: string[]; target: Record<string, unknown> }[]; nextBefore: string };
    const byRun = await call<Page>(admin.token, "AdminService/ListAuditReads", { executionId: run, actorId: providerMember.id });
    expect(byRun.code).toBe("ok");
    const routes = byRun.body!.reads.map((r) => r.route);
    expect(routes).toEqual(
      expect.arrayContaining(["vennir.console.v1.ExecutionService/GetExecution", "vennir.console.v1.ExecutionService/WatchExecution", "vennir.console.v1.ChatService/AskStream"]),
    );
    expect(byRun.body!.reads.every((r) => r.executionIds.includes(run) && r.actorId === providerMember.id)).toBe(true);

    const byTeam = await call<Page>(admin.token, "AdminService/ListAuditReads", { team: consumer, limit: 1 });
    expect(byTeam.body!.reads).toHaveLength(1);
    expect(byTeam.body!.reads[0]?.teams).toContain(consumer);
    expect(Number(byTeam.body!.nextBefore)).toBeGreaterThan(0);

    const recorded = await readsBy(admin.id, "AdminService/ListAuditReads");
    expect(recorded.map((r) => r.target)).toEqual(
      expect.arrayContaining([
        { executionId: run, actorId: providerMember.id, rows: byRun.body!.reads.length },
        { team: consumer, limit: 1, rows: 1 },
      ]),
    );
  });
});
