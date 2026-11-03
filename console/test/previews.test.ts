// SPDX-License-Identifier: MIT
/**
 * Preview (src/core/templates.ts, src/core/approvals.ts): what's
 * previewable, a preview being a run of the plan action (product.yaml's
 * plan) with the same inputs, a template's steps left out when they have no
 * plan or depend on an earlier step, and an approver previewing a waiting
 * step, which whoever ran it can't. kernel-api and the registry are
 * stubbed; the rest is the real console on the real test database.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, upsertProduct, upsertTemplate } from "../src/db/queries.js";
import { products, submittedExecutions, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { getExecution, submitExecution } from "../src/kernel/client.js";
import { caller, rpcClient } from "./rpc.js";

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
    getExecution: vi.fn((executionId: string) => Promise.resolve({ executionId, name: "x", state: "RUNNING", tasks: [] })),
  };
});
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "registry.example/", additional: [], version: "1" })),
}));

const prefix = `pvw-${randomUUID().slice(0, 6)}`;
const prov = `${prefix}-prov`;
const cons = `${prefix}-cons`;

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let consumerToken: string;
let maintainerToken: string;

const lastDag = () => vi.mocked(submitExecution).mock.calls.at(-1)?.[0] as { tasks: Record<string, unknown>[] };

beforeAll(async () => {
  app = await buildApp();
  const provTeam = await createTeam(prov);
  const consTeam = await createTeam(cons);
  const register = (name: string, action: string, extra: Partial<Parameters<typeof upsertProduct>[0]> = {}) =>
    upsertProduct({
      name: `${prov}-${name}-${action}`,
      image: `registry.example/${prov}/${name}:1`,
      action,
      teamId: provTeam.id,
      shareWith: ["*"],
      inputSchema: { type: "object" },
      ...extra,
    });
  await register("thing", "create", { plan: "plan" });
  await register("thing", "plan");
  await register("bare", "create");
  await register("gated", "create", { plan: "plan", approval: "always" });
  await register("gated", "plan");
  await upsertTemplate({
    teamId: provTeam.id,
    name: "chain",
    displayName: "Chain",
    description: "",
    parameters: { type: "object", properties: { name: { type: "string" } } },
    steps: [
      { id: "first", action: `${prov}/thing.create`, inputs: { name: { $param: "name" } } },
      { id: "second", action: `${prov}/thing.create`, dependsOn: ["first"], inputs: { name: { $fromStep: "first", $output: "name" } } },
      { id: "third", action: `${prov}/bare.create` },
    ],
    shareWith: ["*"],
    deprecated: null,
  });
  const consumer = await users.makeUser();
  const maintainer = await users.makeUser();
  await addTeamMember(consumer.id, consTeam.id, "member");
  await addTeamMember(maintainer.id, provTeam.id, "maintainer");
  [consumerToken, maintainerToken] = await Promise.all([consumer, maintainer].map((u) => users.signIn(u.email)));
});

beforeEach(() => {
  vi.mocked(submitExecution).mockClear();
});

afterAll(async () => {
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.onBehalfOf, [cons]));
  await db.delete(submittedExecutions).where(like(submittedExecutions.name, `Preview:%`));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("what can be previewed", () => {
  it("is an action with a plan, or a template with a step that has one", async () => {
    const listed = (await call<{ runnables?: { name: string; previewable?: boolean }[] }>(consumerToken, "TemplateService/ListTemplates")).body.runnables ?? [];
    const of = (name: string) => listed.find((r) => r.name === name)?.previewable ?? false;
    expect([of(`${prov}-thing-create`), of(`${prov}-bare-create`), of("chain")]).toEqual([true, false, true]);
  });
});

describe("previewing", () => {
  it("an action runs its plan with the same inputs, as a preview", async () => {
    const asked = await call<{ executionId: string }>(consumerToken, "TemplateService/PreviewAction", { product: `${prov}-thing-create`, inputs: { name: "web" }, onBehalfOf: cons });
    expect(asked.code).toBe("ok");
    expect(lastDag().tasks).toEqual([expect.objectContaining({ id: "create", action: "plan", team: prov, inputs: { name: "web" } })]);
    const [row] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, asked.body.executionId));
    expect(row).toMatchObject({ template: "preview", templateParameters: { of: `${prov}/thing.create`, parameters: { name: "web" } }, onBehalfOf: cons });
    // A preview isn't run again.
    expect((await call(consumerToken, "ExecutionService/RerunExecution", { executionId: asked.body.executionId })).failure).toBe("PREVIEW_RUN");
  });

  it("an action without a plan is refused", async () => {
    expect((await call(consumerToken, "TemplateService/PreviewAction", { product: `${prov}-bare-create`, inputs: {} })).failure).toBe("NO_PREVIEW");
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("a template previews the steps it can, and says why not the rest", async () => {
    const asked = await call<{ notPreviewed?: { step: string; why: string }[] }>(consumerToken, "TemplateService/PreviewTemplate", { team: prov, name: "chain", parameters: { name: "web" } });
    expect(asked.code).toBe("ok");
    expect(lastDag().tasks.map((t) => [t["id"], t["action"], t["inputs"]])).toEqual([["first", "plan", { name: "web" }]]);
    expect(asked.body.notPreviewed?.map((n) => n.step)).toEqual(["second", "third"]);
    expect(asked.body.notPreviewed?.[0]?.why).toMatch(/first's output/);
  });
});

describe("an approver's preview", () => {
  it("runs the waiting step's plan with its inputs, for its team's maintainers only", async () => {
    const run = await call<{ executionId: string }>(consumerToken, "TemplateService/RunAction", { product: `${prov}-gated-create`, inputs: { name: "prod" }, onBehalfOf: cons });
    expect(run.code).toBe("ok");
    const executionId = run.body.executionId;
    vi.mocked(getExecution).mockImplementation((id: string) =>
      Promise.resolve({
        executionId: id,
        name: "gated",
        state: "RUNNING",
        tasks: [
          { taskId: "create", state: "AWAITING_APPROVAL", attemptCount: 0, outputs: null, failure: null, dependsOn: [], startedAt: null, completedAt: null, attempts: [], approvalRequired: true, approvedBy: "", approvedAt: null, awaitingSince: null, waitingFor: null },
        ],
      }),
    );
    const seen = await call<{ execution?: { tasks?: { approval?: { canPreview?: boolean } }[] } }>(maintainerToken, "ExecutionService/GetExecution", { executionId });
    expect(seen.body.execution?.tasks?.[0]?.approval?.canPreview).toBe(true);
    expect((await call(consumerToken, "ExecutionService/PreviewStep", { executionId, taskId: "create" })).code).toBe("permission_denied");
    const asked = await call(maintainerToken, "ExecutionService/PreviewStep", { executionId, taskId: "create" });
    expect(asked.code).toBe("ok");
    expect(lastDag().tasks).toEqual([expect.objectContaining({ id: "create", action: "plan", inputs: { name: "prod" } })]);
    // For the team the step it previews runs for, not the approver's.
    expect(lastDag().tasks[0]?.["forTeam"]).toBe(cons);
  });
});
