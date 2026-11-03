// SPDX-License-Identifier: MIT
/**
 * ExecutionService through Connect: a DAG message submitted the way a JSON
 * body is, who may see, watch, cancel and retry an execution, and
 * kernel-api's refusals as Connect codes. The authorization rules are tested
 * in depth in executions-*.test.ts, through the same
 * core/executions.ts.
 */
import { randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, recordSubmittedExecution } from "../src/db/queries.js";
import { auditLog, teamMemberships, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { cancelExecution, getExecution, KernelApiError, submitExecution } from "../src/kernel/client.js";
import { config } from "../src/config.js";
import { failureCode, rpcClient, type RpcError } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
}));
vi.mock("../src/registry.js", () => ({
  missingImages: vi.fn(() => Promise.resolve([])),
  pinImages: vi.fn((images: string[]) =>
    Promise.resolve({ pinned: new Map(images.map((i) => [i, `${i}@sha256:${"c".repeat(64)}`])), unresolved: [] }),
  ),
}));
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "docker.io/", additional: [], version: "1" })),
  readImagePolicyForDisplay: vi.fn(() =>
    Promise.resolve({ exists: true, source: "docker.io/", additional: [], version: "1" }),
  ),
}));
vi.mock("../src/kernel/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/client.js")>();
  const { randomUUID: uuid } = await import("node:crypto");
  return {
    ...actual,
    submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })),
    cancelExecution: vi.fn((executionId: string) => Promise.resolve({ executionId, state: "CANCELLED" })),
    getExecution: vi.fn((executionId: string) =>
      Promise.resolve({
        executionId,
        name: "watched",
        state: "SUCCEEDED",
        tasks: [
          {
            taskId: "t",
            state: "SUCCEEDED",
            attemptCount: 1,
            outputs: { greeting: "hello" },
            failure: null,
            dependsOn: [],
            startedAt: "2026-10-20T10:00:00Z",
            completedAt: "2026-10-20T10:00:05Z",
            attempts: [
              {
                number: 1,
                startedAt: "2026-10-20T10:00:00Z",
                completedAt: "2026-10-20T10:00:05Z",
                failure: null,
                requestedBy: "",
                trigger: "submitted",
                actedAs: "team/default",
                image: "img@sha256:aa",
              },
            ],
            approvalRequired: false,
            approvedBy: "",
            approvedAt: null,
            awaitingSince: null,
          },
        ],
      }),
    ),
  };
});

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
const prefix = `rpc-exec-${randomUUID().slice(0, 6)}`;
let teamName: string;
let token: string;
let submitterId: string;
let outsider: string;

const dag = (team: string) => ({
  name: "rpc-check",
  requestId: `rpc-check-${randomUUID()}`,
  tasks: [{ id: "t", image: "some-image:latest", action: "create", team, inputs: { greeting: "hello" } }],
});

async function recorded(teamsOf: string[]): Promise<string> {
  const executionId = randomUUID();
  await recordSubmittedExecution({
    executionId,
    teams: teamsOf,
    submittedBy: submitterId,
    name: "x",
    payload: dag(teamsOf[0] ?? ""),
  });
  return executionId;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const team = await createTeam(`${prefix}-a`);
  teamName = team.name;
  const member = await makeUser();
  submitterId = member.id;
  await addTeamMember(member.id, team.id);
  token = await signIn(member.email);
  outsider = await signIn((await makeUser()).email);
});

beforeEach(() => {
  vi.mocked(submitExecution).mockClear();
  vi.mocked(cancelExecution).mockClear();
});

afterAll(async () => {
  await app.close();
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await cleanUp();
});

describe("submitting", () => {
  it("forwards a member's DAG with its image pinned, as its JSON would be", async () => {
    config.imagePinning = "required";
    let response;
    try {
      response = await rpc("ExecutionService", "SubmitExecution", { dag: dag(teamName) }, { token });
    } finally {
      config.imagePinning = "off";
    }
    expect(response.statusCode).toBe(200);
    expect(response.json<{ state: string }>().state).toBe("EXECUTION_STATE_PENDING");
    const [sent] = vi.mocked(submitExecution).mock.calls[0] ?? [];
    const task = (sent as { tasks: Record<string, unknown>[] }).tasks[0];
    expect(task?.["image"]).toMatch(/^some-image:latest@sha256:/);
    expect(task?.["inputs"]).toEqual({ greeting: "hello" });
    // Unset in the message, so the product's identity fills it, not "".
    expect(task?.["serviceAccount"]).toBe("default");
    // Its audit entry names the run it started, so the run's teams see it.
    const { executionId } = response.json<{ executionId: string }>();
    const audited = await db.select().from(auditLog).where(sql`${auditLog.target}->>'executionId' = ${executionId}`);
    expect(audited.map((e) => e.route)).toEqual(["vertra.console.v1.ExecutionService/SubmitExecution"]);
  });

  it("refuses a team the caller isn't in, before kernel-api hears of it", async () => {
    const response = await rpc("ExecutionService", "SubmitExecution", { dag: dag(`${prefix}-nobody`) }, { token });
    expect(response.json<RpcError>().code).toBe("permission_denied");
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("refuses a missing DAG as an invalid argument", async () => {
    const response = await rpc("ExecutionService", "SubmitExecution", {}, { token });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
  });
});

describe("reading", () => {
  it("shows a member the execution, its tasks and the DAG it ran", async () => {
    const executionId = await recorded([teamName]);
    const response = await rpc("ExecutionService", "GetExecution", { executionId }, { token });
    const { execution } = response.json<{
      execution: { state: string; tasks: { taskId: string; outputs: unknown }[]; dag: { name: string } };
    }>();
    expect(execution.state).toBe("EXECUTION_STATE_SUCCEEDED");
    expect(execution.tasks[0]?.outputs).toEqual({ greeting: "hello" });
    expect(execution.dag.name).toBe("rpc-check");
  });

  it("refuses anyone outside its teams", async () => {
    const executionId = await recorded([teamName]);
    const response = await rpc("ExecutionService", "GetExecution", { executionId }, { token: outsider });
    expect(response.json<RpcError>().code).toBe("permission_denied");
  });

  it("passes kernel-api's 404 on as not_found, and its own credentials as unavailable", async () => {
    const executionId = await recorded([teamName]);
    vi.mocked(getExecution).mockRejectedValueOnce(new KernelApiError(404, { detail: "Execution not found." }));
    const missing = await rpc("ExecutionService", "GetExecution", { executionId }, { token });
    expect(missing.json<RpcError>()).toMatchObject({ code: "not_found", message: "Execution not found." });

    vi.mocked(getExecution).mockRejectedValueOnce(new KernelApiError(401, { detail: "no" }));
    const refused = await rpc("ExecutionService", "GetExecution", { executionId }, { token });
    expect(refused.json<RpcError>().code).toBe("unavailable");
    expect(failureCode(refused.json<RpcError>())).toBe("BAD_GATEWAY");
  });
});

describe("watching", () => {
  it("resends an unchanged execution every 15s, so a quiet stream isn't cut as idle", { timeout: 20_000 }, async () => {
    const executionId = await recorded([teamName]);
    // Each read is 8s later on the clock (only Date is faked: a fake
    // setTimeout would also fast-forward the database pool's timers). Read
    // at 0s, 8s (unchanged, not sent), 16s (unchanged, sent), then finished.
    let reads = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(getExecution).mockImplementation((id: string) => {
      reads += 1;
      if (reads > 1) vi.setSystemTime(Date.now() + 8000);
      return Promise.resolve({ executionId: id, name: "quiet", state: reads > 3 ? "SUCCEEDED" : "RUNNING", tasks: [] });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/vertra.console.v1.ExecutionService/WatchExecution",
        headers: { "content-type": "application/connect+json", authorization: `Bearer ${token}` },
        payload: envelope({ executionId }),
      });
      const states = unenvelope(response.rawPayload)
        .slice(0, -1)
        .map((frame) => (frame as { execution: { state: string } }).execution.state);
      // The first read, the unchanged one at 16s, and the finish.
      expect(states).toEqual(["EXECUTION_STATE_RUNNING", "EXECUTION_STATE_RUNNING", "EXECUTION_STATE_SUCCEEDED"]);
    } finally {
      vi.useRealTimers();
      vi.mocked(getExecution).mockReset();
    }
  });

  it("streams the execution and ends once it has finished", async () => {
    const executionId = await recorded([teamName]);
    const response = await app.inject({
      method: "POST",
      url: "/api/vertra.console.v1.ExecutionService/WatchExecution",
      headers: { "content-type": "application/connect+json", authorization: `Bearer ${token}` },
      payload: envelope({ executionId }),
    });
    const frames = unenvelope(response.rawPayload);
    // One message, then the end-of-stream frame with no error.
    expect(frames).toHaveLength(2);
    expect((frames[0] as { execution: { state: string } }).execution.state).toBe("EXECUTION_STATE_SUCCEEDED");
    expect(frames[1]).toEqual({});
  });

  it("ends once the watcher leaves the run's team, without another read", { timeout: 20_000 }, async () => {
    const team = await createTeam(`${prefix}-leaves`);
    const leaver = await makeUser();
    await addTeamMember(leaver.id, team.id);
    const leaverToken = await signIn(leaver.email);
    const executionId = await recorded([team.name]);
    let reads = 0;
    vi.mocked(getExecution).mockImplementation(async (id: string) => {
      reads += 1;
      // Removed from the team while the stream is open.
      await db.delete(teamMemberships).where(and(eq(teamMemberships.userId, leaver.id), eq(teamMemberships.teamId, team.id)));
      return { executionId: id, name: "watched", state: "RUNNING", tasks: [] };
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/vertra.console.v1.ExecutionService/WatchExecution",
        headers: { "content-type": "application/connect+json", authorization: `Bearer ${leaverToken}` },
        payload: envelope({ executionId }),
      });
      const frames = unenvelope(response.rawPayload);
      expect((frames[0] as { execution: { state: string } }).execution.state).toBe("EXECUTION_STATE_RUNNING");
      expect((frames.at(-1) as { error?: { code: string } }).error?.code).toBe("permission_denied");
      expect(reads).toBe(1);
    } finally {
      vi.mocked(getExecution).mockReset();
    }
  });

  it("refuses an outsider in the end-of-stream frame", async () => {
    const executionId = await recorded([teamName]);
    const response = await app.inject({
      method: "POST",
      url: "/api/vertra.console.v1.ExecutionService/WatchExecution",
      headers: { "content-type": "application/connect+json", authorization: `Bearer ${outsider}` },
      payload: envelope({ executionId }),
    });
    const frames = unenvelope(response.rawPayload);
    expect((frames.at(-1) as { error?: { code: string } }).error?.code).toBe("permission_denied");
  });
});

describe("cancelling", () => {
  it("needs every one of its teams", async () => {
    const other = await createTeam(`${prefix}-b`);
    const shared = await recorded([teamName, other.name]);
    const response = await rpc("ExecutionService", "CancelExecution", { executionId: shared }, { token });
    expect(response.json<RpcError>().code).toBe("permission_denied");
    expect(cancelExecution).not.toHaveBeenCalled();

    const own = await recorded([teamName]);
    const cancelled = await rpc("ExecutionService", "CancelExecution", { executionId: own }, { token });
    expect(cancelled.json<{ state: string }>().state).toBe("EXECUTION_STATE_CANCELLED");
  });
});

/** A Connect streaming request body: one JSON message in its 5-byte envelope. */
function envelope(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function unenvelope(raw: Buffer): unknown[] {
  const frames: unknown[] = [];
  for (let at = 0; at < raw.length;) {
    const length = raw.readUInt32BE(at + 1);
    frames.push(JSON.parse(raw.subarray(at + 5, at + 5 + length).toString()));
    at += 5 + length;
  }
  return frames;
}
