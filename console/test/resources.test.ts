// SPDX-License-Identifier: MIT
/**
 * What runs made, and deleting it (src/resourceRecorder.ts,
 * src/core/resources.ts): a finished run's reported resources are kept with
 * their step's inputs and outputs, checked as they come from a container;
 * who sees and who deletes them; deleting runs the product's cleanup
 * action, newest first, with its inputs as product.yaml maps them; and a
 * resource is deleted once that step succeeds, or free to delete again.
 * kernel-api and the registry are stubbed; the rest is the real console on
 * the real test database.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupInputs } from "../src/core/resources.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, upsertProduct } from "../src/db/queries.js";
import { notificationEvents, products, resourceDeleteRequests, resources, submittedExecutions, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { getExecution, submitExecution, type KernelExecution } from "../src/kernel/client.js";
import { providedBy, recordFinishedRuns, recordRun, refreshProvides, reportedResources, resolvedInputs } from "../src/resourceRecorder.js";
import { caller, rpcClient } from "./rpc.js";

/** The runs kernel-api knows: what each answers. */
const kernelRuns = new Map<string, KernelExecution>();

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
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
  return {
    ...actual,
    submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })),
    getExecutionStates: vi.fn((ids: string[]) =>
      Promise.resolve(
        ids.flatMap((id) => {
          const run = kernelRuns.get(id);
          return run ? [{ executionId: id, state: run.state, steps: {}, createdAt: null, updatedAt: null }] : [];
        }),
      ),
    ),
    getExecution: vi.fn((id: string) => Promise.resolve(kernelRuns.get(id) ?? { executionId: id, name: "x", state: "RUNNING", tasks: [] })),
  };
});
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "registry.example/", additional: [], version: "1" })),
}));

const prefix = `res-${randomUUID().slice(0, 6)}`;
const prov = `${prefix}-prov`;
const prov2 = `${prefix}-prov2`;
const cons = `${prefix}-cons`;

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let consumerToken: string;
let providerToken: string;
let outsiderToken: string;

const anyObject = { type: "object" };
const PROJECT = `${prefix}.project`;

/** A step's status as kernel-api gives it. */
function step(taskId: string, state: string, outputs: Record<string, unknown> | null = null) {
  return {
    taskId,
    state,
    attemptCount: 1,
    outputs,
    failure: null,
    dependsOn: [],
    startedAt: null,
    completedAt: null,
    attempts: [],
    approvalRequired: false,
    approvedBy: "",
    approvedAt: null,
    awaitingSince: null,
    waitingFor: null,
  };
}

/** The run kernel-api last got. */
const lastSubmitted = () => {
  const result = vi.mocked(submitExecution).mock.results.at(-1)?.value as Promise<{ executionId: string }>;
  const dag = vi.mocked(submitExecution).mock.calls.at(-1)?.[0] as { tasks: Record<string, unknown>[] };
  return { result, dag };
};

/** Records finished runs until this one is. */
async function recorded(executionId: string, pass: { perPass?: number } = {}): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const [row] = await db.select({ at: submittedExecutions.resourcesRecordedAt }).from(submittedExecutions).where(eq(submittedExecutions.executionId, executionId));
    if (row?.at) return;
    await recordFinishedRuns(pass);
  }
  throw new Error(`${executionId} was never recorded`);
}

/** Runs an action for the consumer's team and finishes it with these outputs. */
async function ranAndFinished(product: string, inputs: Record<string, unknown>, outputs: Record<string, unknown>): Promise<string> {
  const run = await call<{ executionId: string }>(consumerToken, "TemplateService/RunAction", { product, inputs, onBehalfOf: cons });
  expect(run.code).toBe("ok");
  const executionId = run.body.executionId;
  const action = product.split("-").at(-1) ?? "";
  kernelRuns.set(executionId, { executionId, name: "x", state: "SUCCEEDED", tasks: [step(action, "SUCCEEDED", outputs)] });
  await recorded(executionId);
  return executionId;
}

type Listed = { resources?: { id: string; externalId: string; link: string; state: string; canDelete: boolean; ownerTeam: string }[] };
const list = async (token: string, body: object) => (await call<Listed>(token, "ResourceService/ListResources", body)).body.resources ?? [];

beforeAll(async () => {
  app = await buildApp();
  const provTeam = await createTeam(prov);
  await createTeam(cons);
  const register = (name: string, action: string, extra: Partial<Parameters<typeof upsertProduct>[0]> = {}) =>
    upsertProduct({
      name: `${prov}-${name}-${action}`,
      image: `registry.example/${prov}/${name}:1`,
      action,
      teamId: provTeam.id,
      shareWith: ["*"],
      inputSchema: anyObject,
      ...extra,
    });
  await register("thing", "create", { cleanup: { action: "delete", inputs: null } });
  // Another team's, the same.
  const prov2Team = await createTeam(prov2);
  for (const action of ["create", "delete"]) {
    await upsertProduct({
      name: `${prov2}-thing-${action}`,
      image: `registry.example/${prov2}/thing:1`,
      action,
      teamId: prov2Team.id,
      shareWith: ["*"],
      inputSchema: anyObject,
      ...(action === "create" ? { cleanup: { action: "delete", inputs: null } } : {}),
    });
  }
  await register("thing", "delete", { inputSchema: { type: "object", required: ["resource"], properties: { resource: { type: "object" } } } });
  await register("project", "create", { cleanup: { action: "remove", inputs: { project: { $input: "project" }, id: { $resource: "id" }, zone: { $output: "zone" }, force: true } } });
  await register("project", "remove");
  await register("note", "create");
  // A project and a service in it, typed: the service needs what the project provides.
  const removeResource = { inputSchema: { type: "object", required: ["resource"], properties: { resource: { type: "object" } } } };
  await register("proj", "create", {
    outputSchema: { type: "object", properties: { projectId: { type: "string", "x-vennir-provides": PROJECT } } },
    cleanup: { action: "delete", inputs: null },
  });
  await register("proj", "delete", removeResource);
  await register("svc", "create", {
    inputSchema: { type: "object", properties: { project: { type: "string", "x-vennir-needs": PROJECT } } },
    cleanup: { action: "delete", inputs: null },
  });
  await register("svc", "delete", removeResource);

  const consumer = await users.makeUser();
  const provider = await users.makeUser();
  const outsider = await users.makeUser();
  const [consTeam] = await db.select().from(teams).where(eq(teams.name, cons));
  await addTeamMember(consumer.id, consTeam?.id ?? "", "member");
  await addTeamMember(provider.id, provTeam.id, "member");
  [consumerToken, providerToken, outsiderToken] = await Promise.all([consumer, provider, outsider].map((u) => users.signIn(u.email)));
});

beforeEach(() => {
  vi.mocked(submitExecution).mockClear();
});

afterAll(async () => {
  await db.delete(resourceDeleteRequests).where(inArray(resourceDeleteRequests.ownerTeam, [cons, prov]));
  await db.delete(resources).where(like(resources.productTeam, `${prefix}%`));
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.onBehalfOf, [cons]));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("what a step reports", () => {
  it("keeps a type and an id, a name, and only an http(s) link", () => {
    expect(
      reportedResources({
        resources: [
          { type: "demo/thing", id: "t-1", name: "Thing", link: "https://example.com/t-1" },
          { type: "demo/thing" },
          { type: "demo/thing", id: "t-2", link: "javascript:alert(1)" },
          "t-3",
        ],
      }),
    ).toEqual([
      { type: "demo/thing", id: "t-1", name: "Thing", link: "https://example.com/t-1" },
      { type: "demo/thing", id: "t-2", name: null, link: null },
    ]);
    expect(reportedResources({ resources: "t-1" })).toEqual([]);
    expect(reportedResources(null)).toEqual([]);
  });

  it("is kept with its step's inputs as the kernel resolved them", () => {
    expect(resolvedInputs({ project: { $fromTask: "a", $output: "id" }, size: 2 }, new Map([["a", { id: "p-1" }]]))).toEqual({ project: "p-1", size: 2 });
  });

  it("is given to cleanup as the resource, or as product.yaml maps it", () => {
    const recorded = { inputs: { project: "p-1" }, outputs: { zone: "eu" }, type: "gcp/project", externalId: "p-1", name: null, link: "https://x" };
    expect(cleanupInputs(null, recorded)).toEqual({ resource: { type: "gcp/project", id: "p-1", link: "https://x" } });
    expect(cleanupInputs({ project: { $input: "project" }, zone: { $output: "zone" }, id: { $resource: "id" }, gone: { $input: "nope" }, force: true }, recorded)).toEqual({
      project: "p-1",
      zone: "eu",
      id: "p-1",
      force: true,
    });
  });
});

describe("what runs made", () => {
  it("is recorded once its run finishes, for its team, its product's team and whoever ran it", async () => {
    const executionId = await ranAndFinished(`${prov}-thing-create`, {}, {
      resources: [
        { type: "demo/thing", id: `${prefix}-t1`, link: "https://example.com/t1" },
        { type: "demo/thing", id: `${prefix}-t2` },
      ],
    });
    const mine = await list(consumerToken, { executionId });
    expect(mine.map((r) => r.externalId).sort()).toEqual([`${prefix}-t1`, `${prefix}-t2`]);
    expect(mine.every((r) => r.state === "exists" && r.canDelete && r.ownerTeam === cons)).toBe(true);
    // The product's team sees what its product made; it isn't theirs to delete.
    expect((await list(providerToken, { executionId })).map((r) => r.canDelete)).toEqual([false, false]);
    expect(await list(outsiderToken, { executionId })).toEqual([]);
    // Found by a search, too.
    expect((await list(consumerToken, { query: `${prefix}-t1` })).map((r) => r.externalId)).toEqual([`${prefix}-t1`]);
  });

  it("is deleted by its product's cleanup, newest first, and marked once each step succeeds", async () => {
    const executionId = await ranAndFinished(`${prov}-thing-create`, {}, {
      resources: [{ type: "demo/thing", id: `${prefix}-a` }, { type: "demo/thing", id: `${prefix}-b` }],
    });
    expect((await call(outsiderToken, "ResourceService/DeleteRunResources", { executionId })).code).toBe("not_found");
    const asked = await call<{ executionId: string }>(consumerToken, "ResourceService/DeleteRunResources", { executionId });
    expect(asked.code).toBe("ok");
    const { dag } = lastSubmitted();
    expect(dag.tasks.map((t) => [t["id"], t["action"], t["dependsOn"]])).toEqual([
      ["delete-1", "delete", undefined],
      ["delete-2", "delete", ["delete-1"]],
    ]);
    const deleted = dag.tasks.map((t) => (t["inputs"] as { resource: { id: string } }).resource.id).sort();
    expect(deleted).toEqual([`${prefix}-a`, `${prefix}-b`]);
    // Each step deletes for the team it was made for, in its product's team.
    expect(dag.tasks.map((t) => [t["team"], t["forTeam"]])).toEqual([
      [prov, cons],
      [prov, cons],
    ]);
    // The consumer's own cleanup run, for their team.
    const [cleanup] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, asked.body.executionId));
    expect(cleanup).toMatchObject({ template: "cleanup", onBehalfOf: cons });

    expect((await list(consumerToken, { executionId })).map((r) => r.state)).toEqual(["deleting", "deleting"]);
    expect((await call(consumerToken, "ResourceService/DeleteRunResources", { executionId })).code).toBe("not_found");

    // The first delete worked, the second didn't.
    kernelRuns.set(asked.body.executionId, { executionId: asked.body.executionId, name: "x", state: "FAILED", tasks: [step("delete-1", "SUCCEEDED"), step("delete-2", "FAILED")] });
    await recorded(asked.body.executionId);
    const after = await list(consumerToken, { executionId, includeDeleted: true });
    expect(after.map((r) => r.state).sort()).toEqual(["delete_failed", "deleted"]);
    expect(after.find((r) => r.state === "delete_failed")?.canDelete).toBe(true);
    expect(await list(consumerToken, { executionId })).toHaveLength(1);
  });

  it("can be deleted again as soon as a failed delete's run has finished, not before", async () => {
    const executionId = await ranAndFinished(`${prov}-project-create`, { project: "acme-retry" }, { zone: "eu-west", resources: [{ type: "demo/project", id: `${prefix}-retry` }] });
    const [made] = await list(consumerToken, { executionId });
    const first = await call<{ executionId: string }>(consumerToken, "ResourceService/DeleteResources", { resourceIds: [made?.id] });
    expect(first.code).toBe("ok");
    kernelRuns.set(first.body.executionId, { executionId: first.body.executionId, name: "x", state: "RUNNING", tasks: [step("delete-1", "RUNNING")] });
    expect((await call(consumerToken, "ResourceService/DeleteResources", { resourceIds: [made?.id] })).failure).toBe("DELETE_IN_PROGRESS");
    // Failed, but not yet recorded (the recorder looks every 30 seconds).
    kernelRuns.set(first.body.executionId, { executionId: first.body.executionId, name: "x", state: "FAILED", tasks: [step("delete-1", "FAILED")] });
    expect((await call(consumerToken, "ResourceService/DeleteResources", { resourceIds: [made?.id] })).code).toBe("ok");
  });

  it("gives a cleanup the inputs its product.yaml maps, from what the step was given and gave", async () => {
    const executionId = await ranAndFinished(`${prov}-project-create`, { project: "acme-web" }, { zone: "eu-west", resources: [{ type: "demo/project", id: `${prefix}-p` }] });
    const [made] = await list(consumerToken, { executionId });
    expect((await call(consumerToken, "ResourceService/DeleteResources", { resourceIds: [made?.id] })).code).toBe("ok");
    expect(lastSubmitted().dag.tasks[0]).toMatchObject({ action: "remove", inputs: { project: "acme-web", id: `${prefix}-p`, zone: "eu-west", force: true } });
  });

  it("is made for the team a direct run of its shared cleanup is for, whoever's product it is", async () => {
    // Another team's consumer runs the provider's shared delete itself: for
    // its own team, so the product deletes only that team's.
    const run = await call(consumerToken, "TemplateService/RunAction", {
      product: `${prov}-thing-delete`,
      inputs: { resource: { type: "demo/thing", id: `${prefix}-theirs` } },
      onBehalfOf: cons,
    });
    expect(run.code).toBe("ok");
    expect(lastSubmitted().dag.tasks[0]).toMatchObject({ team: prov, forTeam: cons });
    // Never a team the caller isn't in.
    expect(
      (await call(consumerToken, "TemplateService/RunAction", { product: `${prov}-thing-delete`, inputs: { resource: { type: "demo/thing", id: "x" } }, onBehalfOf: prov }))
        .code,
    ).toBe("permission_denied");
  });

  it("is deleted for the team it was made for, even by an admin outside it", async () => {
    const executionId = await ranAndFinished(`${prov}-thing-create`, {}, { resources: [{ type: "demo/thing", id: `${prefix}-by-admin` }] });
    const [made] = await list(consumerToken, { executionId });
    const admin = await users.signIn((await users.makeUser({ admin: true })).email);
    expect((await call(admin, "ResourceService/DeleteResources", { resourceIds: [made?.id] })).code).toBe("ok");
    expect(lastSubmitted().dag.tasks[0]).toMatchObject({ team: prov, forTeam: cons });
  });

  it("deletes each of a person's resources for its own product's team", async () => {
    // Made for the consumer alone (no team), by two teams' products: each
    // cleanup step for its own product's team, as its run's step was.
    const made: string[] = [];
    for (const [product, id] of [[`${prov}-thing-create`, `${prefix}-solo-a`], [`${prov2}-thing-create`, `${prefix}-solo-b`]] as const) {
      const run = await call<{ executionId: string }>(consumerToken, "TemplateService/RunAction", { product, inputs: {} });
      const executionId = run.body.executionId;
      kernelRuns.set(executionId, { executionId, name: "x", state: "SUCCEEDED", tasks: [step("create", "SUCCEEDED", { resources: [{ type: "demo/thing", id }] })] });
      await recorded(executionId);
      made.push(...(await list(consumerToken, { executionId })).map((r) => r.id));
    }
    expect((await call(consumerToken, "ResourceService/DeleteResources", { resourceIds: made })).code).toBe("ok");
    const steps = lastSubmitted().dag.tasks.map((t) => [t["team"], t["forTeam"]]);
    expect(steps.sort()).toEqual([
      [prov, prov],
      [prov2, prov2],
    ]);
  });

  it("is only its person's when the run was for no team", async () => {
    const run = await call<{ executionId: string }>(consumerToken, "TemplateService/RunAction", { product: `${prov}-thing-create`, inputs: {} });
    // Run for no team: its step is told none.
    expect(lastSubmitted().dag.tasks[0]?.["forTeam"]).toBeUndefined();
    const executionId = run.body.executionId;
    kernelRuns.set(executionId, { executionId, name: "x", state: "SUCCEEDED", tasks: [step("create", "SUCCEEDED", { resources: [{ type: "demo/thing", id: `${prefix}-solo` }] })] });
    await recorded(executionId);
    const [mine] = await list(consumerToken, { executionId });
    expect(mine).toMatchObject({ ownerTeam: "", canDelete: true });
    // Not the product's team's to delete, though they see it.
    expect((await list(providerToken, { executionId })).map((r) => r.canDelete)).toEqual([false]);
  });

  it("stays its first owner's when someone else's run reports it too", async () => {
    const id = `${prefix}-shared`;
    const first = await ranAndFinished(`${prov}-thing-create`, {}, { resources: [{ type: "demo/thing", id }] });
    // The product's own team runs it for itself: the same thing, found existing.
    const run = await call<{ executionId: string }>(providerToken, "TemplateService/RunAction", { product: `${prov}-thing-create`, inputs: {} });
    kernelRuns.set(run.body.executionId, { executionId: run.body.executionId, name: "x", state: "SUCCEEDED", tasks: [step("create", "SUCCEEDED", { resources: [{ type: "demo/thing", id }] })] });
    await recorded(run.body.executionId);
    const [kept] = await db.select().from(resources).where(eq(resources.externalId, id));
    expect(kept).toMatchObject({ ownerTeam: cons, executionId: first });
    expect((await list(providerToken, { query: id })).map((r) => r.canDelete)).toEqual([false]);
  });

  it("can't be deleted when its product says nothing about how", async () => {
    const executionId = await ranAndFinished(`${prov}-note-create`, {}, { resources: [{ type: "demo/note", id: `${prefix}-n` }] });
    const [note] = await list(consumerToken, { executionId });
    expect(note?.canDelete).toBe(false);
    const refused = await call(consumerToken, "ResourceService/DeleteResources", { resourceIds: [note?.id] });
    expect(refused.failure).toBe("NO_CLEANUP");
    expect(vi.mocked(submitExecution)).toHaveBeenCalledTimes(1); // only the run that made it
  });

  it("is recorded behind more unfinished runs, older than it, than a pass looks at", async () => {
    // Three passes' worth of runs from long ago that haven't finished: once
    // they filled every pass, and nothing newer was ever looked at.
    const perPass = 5;
    const waiting = Array.from({ length: perPass * 3 }, (_, i) => ({
      executionId: randomUUID(),
      teams: [cons],
      name: "waiting",
      onBehalfOf: cons,
      template: `${cons}/waiting`,
      createdAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)),
    }));
    for (const run of waiting) kernelRuns.set(run.executionId, { executionId: run.executionId, name: "waiting", state: "RUNNING", tasks: [] });
    await db.insert(submittedExecutions).values(waiting);
    try {
      const run = await call<{ executionId: string }>(consumerToken, "TemplateService/RunAction", { product: `${prov}-thing-create`, inputs: {}, onBehalfOf: cons });
      const executionId = run.body.executionId;
      kernelRuns.set(executionId, { executionId, name: "x", state: "SUCCEEDED", tasks: [step("create", "SUCCEEDED", { resources: [{ type: "demo/thing", id: `${prefix}-behind` }] })] });
      await recorded(executionId, { perPass });
      expect((await list(consumerToken, { executionId })).map((r) => r.externalId)).toEqual([`${prefix}-behind`]);
    } finally {
      await db.delete(submittedExecutions).where(inArray(submittedExecutions.executionId, waiting.map((r) => r.executionId)));
      for (const run of waiting) kernelRuns.delete(run.executionId);
    }
  });

  it("passes over a run whose recording fails every time, after a few tries", async () => {
    // Long ago and finished, but kernel-api won't give it: every pass threw on
    // it, and nothing after it was ever recorded.
    // A pass to the end first: the cursor (kept between passes, and so
    // between tests) then starts from the oldest, the stuck run.
    await recordFinishedRuns();
    const stuck = randomUUID();
    kernelRuns.set(stuck, { executionId: stuck, name: "stuck", state: "SUCCEEDED", tasks: [] });
    await db.insert(submittedExecutions).values({ executionId: stuck, teams: [cons], name: "stuck", onBehalfOf: cons, template: `${cons}/stuck`, createdAt: new Date(Date.UTC(2000, 0, 2)) });
    const getting = vi.mocked(getExecution).getMockImplementation();
    vi.mocked(getExecution).mockImplementation((id: string) => (id === stuck ? Promise.reject(new Error("unavailable")) : getting!(id)));
    try {
      const run = await call<{ executionId: string }>(consumerToken, "TemplateService/RunAction", { product: `${prov}-thing-create`, inputs: {}, onBehalfOf: cons });
      const executionId = run.body.executionId;
      kernelRuns.set(executionId, { executionId, name: "x", state: "SUCCEEDED", tasks: [step("create", "SUCCEEDED", { resources: [{ type: "demo/thing", id: `${prefix}-after-stuck` }] })] });
      let failed = 0;
      for (let i = 0; i < 20; i++) {
        const [row] = await db.select({ at: submittedExecutions.resourcesRecordedAt }).from(submittedExecutions).where(eq(submittedExecutions.executionId, executionId));
        if (row?.at) break;
        await recordFinishedRuns().catch(() => (failed += 1));
      }
      expect(failed).toBeGreaterThanOrEqual(3);
      expect((await list(consumerToken, { executionId })).map((r) => r.externalId)).toEqual([`${prefix}-after-stuck`]);
    } finally {
      vi.mocked(getExecution).mockImplementation(getting!);
      await db.delete(submittedExecutions).where(eq(submittedExecutions.executionId, stuck));
      kernelRuns.delete(stuck);
    }
  });
});

type Ref = { id: string; externalId: string; input: string };
type Linked = { id: string; externalId: string; state: string; provides?: { type: string; value: string; output: string }[]; dependsOn?: Ref[]; dependents?: Ref[] };
const linked = async (token: string, query: string) =>
  ((await call<{ resources?: Linked[] }>(token, "ResourceService/ListResources", { team: cons, query })).body.resources ?? []).filter((r) => r.state !== "deleted");

describe("what depends on what (decision 25)", () => {
  it("keeps what a step provided, by wiring type", () => {
    const schema = { properties: { projectId: { "x-vennir-provides": "gcp.project" }, size: {}, nested: { "x-vennir-provides": "x.y" } } };
    expect(providedBy(schema, { projectId: "p-1", size: 3, nested: { a: 1 } })).toEqual([{ type: "gcp.project", value: "p-1", output: "projectId" }]);
  });

  it("is offered by type once its product types the output, though made before", async () => {
    // The note product types nothing: what it made provides nothing.
    await ranAndFinished(`${prov}-note-create`, {}, { noteId: `${prefix}-n1`, resources: [{ type: "demo/note", id: `${prefix}-n1` }] });
    // A service given its id meanwhile: nothing provided it, so no link.
    await ranAndFinished(`${prov}-svc-create`, { project: `${prefix}-n1` }, { resources: [{ type: "demo/service", id: `${prefix}-s4` }] });
    const [before] = await linked(consumerToken, `${prefix}-n1`);
    expect(before?.provides).toEqual([]);
    expect(before?.dependents).toEqual([]);
    // Typed later (a new catalog release): what it made is brought up to it,
    // and what took its value as that type now depends on it.
    const typed = { type: "object", properties: { noteId: { type: "string", "x-vennir-provides": PROJECT } } };
    expect(await refreshProvides(`${prov}-note-create`, typed)).toBe(1);
    expect(await refreshProvides(`${prov}-note-create`, typed)).toBe(0);
    const [after] = await linked(consumerToken, `${prefix}-n1`);
    expect(after?.provides).toEqual([{ type: PROJECT, value: `${prefix}-n1`, output: "noteId" }]);
    expect(after?.dependents).toMatchObject([{ externalId: `${prefix}-s4`, input: "project" }]);
    // And untyped again, it provides nothing.
    expect(await refreshProvides(`${prov}-note-create`, {})).toBe(1);
  });

  it("links a resource to one an earlier run made, by the value its input needs", async () => {
    await ranAndFinished(`${prov}-proj-create`, {}, { projectId: `${prefix}-p1`, resources: [{ type: "demo/project", id: `${prefix}-p1` }] });
    await ranAndFinished(`${prov}-svc-create`, { project: `${prefix}-p1` }, { resources: [{ type: "demo/service", id: `${prefix}-s1` }] });
    const [project] = await linked(consumerToken, `${prefix}-p1`);
    const [service] = await linked(consumerToken, `${prefix}-s1`);
    expect(project?.provides).toEqual([{ type: PROJECT, value: `${prefix}-p1`, output: "projectId" }]);
    expect(project?.dependents).toMatchObject([{ externalId: `${prefix}-s1`, input: "project" }]);
    expect(service?.dependsOn).toMatchObject([{ externalId: `${prefix}-p1`, input: "project" }]);
    // The outsider sees neither, nor the link.
    expect(await linked(outsiderToken, `${prefix}-p1`)).toEqual([]);
  });

  it("links a step to the one its input was wired from in the same run", async () => {
    const executionId = randomUUID();
    const task = (id: string, name: string, inputs: Record<string, unknown> = {}) => ({ id, team: prov, image: `registry.example/${prov}/${name}:1`, action: "create", inputs });
    await recordRun(
      {
        executionId,
        submittedBy: null,
        template: null,
        onBehalfOf: null,
        payload: { tasks: [task("p", "proj"), { ...task("s", "svc", { project: { $fromTask: "p", $output: "projectId" } }), dependsOn: ["p"] }] },
      },
      {
        executionId,
        name: "x",
        state: "SUCCEEDED",
        tasks: [
          step("p", "SUCCEEDED", { projectId: `${prefix}-p2`, resources: [{ type: "demo/project", id: `${prefix}-p2` }] }),
          step("s", "SUCCEEDED", { resources: [{ type: "demo/service", id: `${prefix}-s2` }] }),
        ],
      },
    );
    const [service] = (await call<{ resources?: Linked[] }>(providerToken, "ResourceService/ListResources", { query: `${prefix}-s2` })).body.resources ?? [];
    expect(service?.dependsOn).toMatchObject([{ externalId: `${prefix}-p2`, input: "project" }]);
  });

  it("refuses deleting what others depend on, asks the admins once, and deletes it when one approves", async () => {
    const [project] = await linked(consumerToken, `${prefix}-p1`);
    const refused = await call<unknown>(consumerToken, "ResourceService/DeleteResources", { resourceIds: [project?.id] });
    expect(refused.code).toBe("failed_precondition");
    expect(refused.failure).toBe("HAS_DEPENDENTS");
    expect(vi.mocked(submitExecution)).not.toHaveBeenCalled();
    // Asking again is the same request.
    await call(consumerToken, "ResourceService/DeleteResources", { resourceIds: [project?.id] });
    type Requests = { requests?: { id: string; decision: string; resources: Ref[]; dependents: Ref[]; requestedBy: string }[] };
    const mine = (await call<Requests>(consumerToken, "ResourceService/ListDeleteRequests", {})).body.requests ?? [];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ decision: "", resources: [{ externalId: `${prefix}-p1` }], dependents: [{ externalId: `${prefix}-s1` }] });
    const id = mine[0]?.id ?? "";
    expect(await db.select().from(notificationEvents).where(eq(notificationEvents.key, `platform:resource-delete:${id}`))).toHaveLength(1);

    // Not the asker's to approve; an admin's.
    expect((await call(consumerToken, "ResourceService/DecideDeleteRequest", { id, approve: true })).failure).toBe("FORBIDDEN");
    const admin = await users.signIn((await users.makeUser({ admin: true })).email);
    const approved = await call<{ executionId: string }>(admin, "ResourceService/DecideDeleteRequest", { id, approve: true });
    expect(approved.code).toBe("ok");
    expect(approved.body.executionId).not.toBe("");
    expect((await call(admin, "ResourceService/DecideDeleteRequest", { id, approve: true })).failure).toBe("ALREADY_DECIDED");
    const [deleting] = await linked(consumerToken, `${prefix}-p1`);
    expect(deleting?.state).toBe("deleting");
  });

  it("deletes the dependents with it, first, without asking", async () => {
    await ranAndFinished(`${prov}-proj-create`, {}, { projectId: `${prefix}-p3`, resources: [{ type: "demo/project", id: `${prefix}-p3` }] });
    await ranAndFinished(`${prov}-svc-create`, { project: `${prefix}-p3` }, { resources: [{ type: "demo/service", id: `${prefix}-s3` }] });
    const [project] = await linked(consumerToken, `${prefix}-p3`);
    const [service] = await linked(consumerToken, `${prefix}-s3`);
    // Asked alone first: waiting for an admin.
    expect((await call(consumerToken, "ResourceService/DeleteResources", { resourceIds: [project?.id] })).failure).toBe("HAS_DEPENDENTS");
    vi.mocked(submitExecution).mockClear();
    // Asked project first: the service still goes first.
    const deleted = await call<{ executionId: string }>(consumerToken, "ResourceService/DeleteResources", { resourceIds: [project?.id, service?.id] });
    expect(deleted.code).toBe("ok");
    const { dag } = lastSubmitted();
    expect(dag.tasks.map((t) => t["image"])).toEqual([
      expect.stringContaining(`${prov}/svc`),
      expect.stringContaining(`${prov}/proj`),
    ]);

    // Once both are gone, the waiting request has nothing left to approve.
    const cleanup = deleted.body.executionId;
    kernelRuns.set(cleanup, { executionId: cleanup, name: "x", state: "SUCCEEDED", tasks: dag.tasks.map((t) => step(String(t["id"]), "SUCCEEDED")) });
    await recorded(cleanup);
    type Requests = { requests?: { id: string; decision: string; resources: Ref[] }[] };
    const requests = (await call<Requests>(consumerToken, "ResourceService/ListDeleteRequests", {})).body.requests ?? [];
    const request = requests.find((r) => r.resources.some((x) => x.externalId === `${prefix}-p3`));
    expect(request?.decision).toBe("deleted");
    const admin = await users.signIn((await users.makeUser({ admin: true })).email);
    expect((await call(admin, "ResourceService/DecideDeleteRequest", { id: request?.id, approve: true })).failure).toBe("ALREADY_DECIDED");
  });
});
