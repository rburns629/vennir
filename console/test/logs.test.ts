// SPDX-License-Identifier: MIT
/**
 * Observe's log search (core/logs.ts): the LogQL the console sends Loki
 * carries each caller's visibility. A step's lines, every level, to its own
 * team; its INFO lines to anyone else who may see its run; an API backend's
 * lines to its own team alone; the platform's own to admins. A stand-in Loki records the queries and answers them.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, recordSubmittedExecution } from "../src/db/queries.js";
import { submittedExecutions, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

const prefix = `logs-${randomUUID().slice(0, 6)}`;
const teamA = `${prefix}-a`;
const teamB = `${prefix}-b`;
const sharedRun = randomUUID(); // steps in A and B
const runInA = randomUUID(); // A's alone
// A team named before names ending in -apis were refused: its namespace is
// its own, never team B's API backends' namespace.
const legacyApisTeam = `${teamB}-apis`;
let app: FastifyInstance;
let loki: Server;
const queries: string[] = [];
const { makeUser, signIn, cleanUp } = rpcClient(() => app);
const call = caller(() => app);
let admin: string;
let memberOfA: string;
let memberOfB: string;

type Lines = { lines?: { team: string; executionId: string; level: string; line: string; at: string }[]; truncated?: boolean };

beforeAll(async () => {
  loki = createServer((req, res) => {
    const query = new URL(req.url ?? "", "http://x").searchParams.get("query") ?? "";
    queries.push(query);
    const ns = (offset: number) => `${String(Date.now() - offset)}000000`;
    const result = query.startsWith('{component="api"')
      ? [
          { stream: { component: "api", namespace: `${teamA}-apis`, level: "info", app: "orders" }, values: [[ns(100), "moved backend"]] },
          { stream: { component: "api", namespace: teamA, level: "info", app: "legacy" }, values: [[ns(200), "unmoved backend"]] },
          { stream: { component: "api", namespace: legacyApisTeam, level: "info", app: "own" }, values: [[ns(300), "an -apis team's own"]] },
        ]
      : query.includes('level="info"')
      ? [{ stream: { component: "step", namespace: teamB, level: "info", execution_id: sharedRun, task: "b", attempt: "1" }, values: [[ns(1000), "B's info"]] }]
      : [{ stream: { component: "step", namespace: teamA, level: "debug", execution_id: runInA, task: "a", attempt: "2" }, values: [[ns(500), "A's debug"]] }];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "success", data: { resultType: "streams", result } }));
  }).listen(0, "127.0.0.1");
  await once(loki, "listening");
  config.logs.lokiUrl = `http://127.0.0.1:${String((loki.address() as AddressInfo).port)}`;

  app = await buildApp();
  await app.ready();
  const adminUser = await makeUser({ admin: true });
  const a = await makeUser();
  const b = await makeUser();
  admin = await signIn(adminUser.email);
  memberOfA = await signIn(a.email);
  memberOfB = await signIn(b.email);
  await addTeamMember(a.id, (await createTeam(teamA)).id);
  await addTeamMember(b.id, (await createTeam(teamB)).id);
  await createTeam(legacyApisTeam);
  await recordSubmittedExecution({ executionId: sharedRun, teams: [teamA, teamB], submittedBy: b.id, name: "shared", payload: {} });
  await recordSubmittedExecution({ executionId: runInA, teams: [teamA], submittedBy: a.id, name: "a's", payload: {} });
});

beforeEach(() => {
  queries.length = 0;
});

afterAll(async () => {
  config.logs.lokiUrl = "";
  loki.close();
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.executionId, [sharedRun, runInA]));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await app.close();
  await cleanUp();
});

const search = (token: string, body: object = {}) => call<Lines>(token, "ObserveService/SearchLogs", body);

describe("log search", () => {
  it("gives a member every level of their team's steps, and INFO of runs they may see elsewhere", async () => {
    const found = await search(memberOfA);
    expect(found.code).toBe("ok");
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe(`{component="step", namespace=~"^(${teamA})$"}`);
    expect(queries[1]).toContain(`{component="step", level="info", namespace!~"^(${teamA})$"} | execution_id=~"^(`);
    expect(queries[1]).toContain(sharedRun);
    // Newest first, from both.
    expect(found.body.lines?.map((l) => l.line)).toEqual(["A's debug", "B's info"]);
    expect(found.body.lines?.[0]).toMatchObject({ team: teamA, executionId: runInA, level: "debug" });
  });

  it("never names a run the caller can't see", async () => {
    await search(memberOfB);
    expect(queries.join("\n")).not.toContain(runInA);
    expect(queries[0]).toBe(`{component="step", namespace=~"^(${teamB})$"}`);
  });

  it("refuses a run the caller can't see, and the platform's logs to all but admins", async () => {
    expect((await search(memberOfB, { executionId: runInA })).code).toBe("not_found");
    expect((await search(memberOfA, { source: "platform" })).code).toBe("permission_denied");
    expect(queries).toHaveLength(0);
  });

  it("gives an admin everything, the platform's own logs included", async () => {
    await search(admin, { team: teamB, level: "warn" });
    expect(queries).toEqual([`{component="step", namespace="${teamB}", level="warn"}`]);
    await search(admin, { source: "platform" });
    expect(queries[1]).toBe(`{component="platform"}`);
  });

  it("asks only for INFO elsewhere, so another level searches the caller's own teams alone", async () => {
    await search(memberOfA, { level: "error" });
    expect(queries).toEqual([`{component="step", namespace=~"^(${teamA})$", level="error"}`]);
  });

  it("quotes what was typed, as text to find and not as LogQL", async () => {
    await search(admin, { text: 'x"} |= "a.b' });
    expect(queries[0]).toBe(`{component="step"} |~ "(?i)x\\"\\\\} \\\\|= \\"a\\\\.b"`);
  });

  it("checks names before they reach a query", async () => {
    expect((await search(admin, { team: 'a"}' })).code).toBe("invalid_argument");
    expect((await search(admin, { level: "trace" })).code).toBe("invalid_argument");
    expect((await search(admin, { executionId: "not-a-run" })).code).toBe("invalid_argument");
    expect(queries).toHaveLength(0);
  });

  it("says so when this install keeps no logs", async () => {
    const url = config.logs.lokiUrl;
    config.logs.lokiUrl = "";
    try {
      const off = await search(memberOfA);
      expect(off.code).toBe("failed_precondition");
      expect(off.failure).toBe("LOGS_OFF");
    } finally {
      config.logs.lokiUrl = url;
    }
  });
});

describe("API backends' log search", () => {
  it("gives a member every level of their own team's backends, and nothing of another team's", async () => {
    expect((await search(memberOfA, { source: "api" })).code).toBe("ok");
    expect(queries).toEqual([`{component="api", namespace=~"^(${teamA}|${teamA}-apis)$"}`]);
    queries.length = 0;
    const elsewhere = await search(memberOfA, { source: "api", team: teamB });
    expect(elsewhere.code).toBe("ok");
    expect(elsewhere.body.lines ?? []).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("finds a team's backends in its API backends' namespace and, for now, its own, and names the team", async () => {
    const found = await search(admin, { source: "api" });
    expect(found.body.lines?.map((l) => [l.line, l.team])).toEqual([
      ["moved backend", teamA],
      ["unmoved backend", teamA],
      ["an -apis team's own", legacyApisTeam],
    ]);
  });

  it("gives an admin every team's", async () => {
    await search(admin, { source: "api", team: teamA, level: "error" });
    expect(queries).toEqual([`{component="api", namespace=~"^(${teamA}|${teamA}-apis)$", level="error"}`]);
  });

  it("never takes another team's namespace for a team's API backends' namespace", async () => {
    await search(admin, { source: "api", team: teamB });
    expect(queries).toEqual([`{component="api", namespace=~"^(${teamB})$"}`]);
    queries.length = 0;
    await search(memberOfB, { source: "api" });
    expect(queries).toEqual([`{component="api", namespace=~"^(${teamB})$"}`]);
  });

  it("narrows to one API product's backend, its Pods' vennir/api label", async () => {
    queries.length = 0;
    await search(memberOfA, { source: "api", api: "orders" });
    expect(queries).toEqual([`{component="api", namespace=~"^(${teamA}|${teamA}-apis)$", api="orders"}`]);
    queries.length = 0;
    expect((await search(memberOfA, { source: "api", api: "Not An API" })).code).toBe("invalid_argument");
    expect(queries).toHaveLength(0);
  });

  it("refuses a run: a backend's lines belong to none", async () => {
    expect((await search(memberOfA, { source: "api", executionId: runInA })).code).toBe("invalid_argument");
    expect(queries).toHaveLength(0);
  });
});
