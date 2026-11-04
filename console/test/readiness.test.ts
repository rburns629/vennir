// SPDX-License-Identifier: MIT
/**
 * Readiness (src/readiness.ts): a product's check is run once when it's
 * due, by the console itself, as the product; its answer is kept and shown
 * with the product and in the catalog; a product found not ready tells its
 * team's maintainers once; Check now is its team's; a new image is checked
 * again. kernel-api and the registry are stubbed; the rest is the real
 * console on the real test database.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, upsertProduct } from "../src/db/queries.js";
import { notificationEvents, productReadiness, products, submittedExecutions, teams, userNotifications } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { submitExecution, type KernelExecution } from "../src/kernel/client.js";
import { checkDue } from "../src/readiness.js";
import { recordFinishedRuns } from "../src/resourceRecorder.js";
import { caller, rpcClient } from "./rpc.js";

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
    Promise.resolve({ pinned: new Map(images.map((i) => [i, i.includes("@") ? i : `${i}@sha256:${"c".repeat(64)}`])), unresolved: [] }),
  ),
}));
vi.mock("../src/kernel/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/client.js")>();
  const { randomUUID: uuid } = await import("node:crypto");
  return {
    ...actual,
    submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })),
    getExecutionStates: vi.fn((ids: string[]) =>
      Promise.resolve(ids.flatMap((id) => (kernelRuns.has(id) ? [{ executionId: id, state: kernelRuns.get(id)?.state ?? "", steps: {}, createdAt: null, updatedAt: null }] : []))),
    ),
    getExecution: vi.fn((id: string) => Promise.resolve(kernelRuns.get(id) ?? { executionId: id, name: "x", state: "RUNNING", tasks: [] })),
  };
});
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "registry.example/", additional: [], version: "1" })),
}));

const prefix = `rdy-${randomUUID().slice(0, 6)}`;
const prov = `${prefix}-prov`;
const silent = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Parameters<typeof checkDue>[0];

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let maintainer: { id: string };
let maintainerToken: string;
let outsiderToken: string;
let provTeamId: string;

const register = (action: string, image = `registry.example/${prov}/svc:1`) =>
  upsertProduct({ name: `${prov}-svc-${action}`, image, action, teamId: provTeamId, shareWith: ["*"], inputSchema: { type: "object" }, check: "ready" });

/** The last check run kernel-api got, finished with this answer. */
async function answered(outputs: Record<string, unknown>): Promise<string> {
  const result = (await vi.mocked(submitExecution).mock.results.at(-1)?.value) as { executionId: string };
  kernelRuns.set(result.executionId, {
    executionId: result.executionId,
    name: "check",
    state: "SUCCEEDED",
    tasks: [{ taskId: "check", state: "SUCCEEDED", attemptCount: 1, outputs, failure: null, dependsOn: [], startedAt: null, completedAt: null, attempts: [], approvalRequired: false, approvedBy: "", approvedAt: null, awaitingSince: null, waitingFor: null }],
  });
  for (let i = 0; i < 50; i++) {
    const [row] = await db.select({ at: submittedExecutions.resourcesRecordedAt }).from(submittedExecutions).where(eq(submittedExecutions.executionId, result.executionId));
    if (row?.at) break;
    await recordFinishedRuns();
  }
  return result.executionId;
}

const readinessRow = async () => (await db.select().from(productReadiness).where(eq(productReadiness.product, `${prov}-svc-ready`)))[0];

beforeAll(async () => {
  app = await buildApp();
  provTeamId = (await createTeam(prov)).id;
  await register("create");
  await register("ready");
  maintainer = await users.makeUser();
  const outsider = await users.makeUser();
  await addTeamMember(maintainer.id, provTeamId, "maintainer");
  [maintainerToken, outsiderToken] = await Promise.all([maintainer, outsider].map((u) => users.signIn((u as { email: string }).email)));
});

beforeEach(() => {
  vi.mocked(submitExecution).mockClear();
});

afterAll(async () => {
  await db.delete(productReadiness).where(like(productReadiness.product, `${prefix}%`));
  await db.delete(notificationEvents).where(like(notificationEvents.key, `ready:${prefix}%`));
  await db.delete(submittedExecutions).where(like(submittedExecutions.name, "Check:%"));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("a product's check", () => {
  it("runs once when due, as the console, as the product, with no inputs", async () => {
    await checkDue(silent);
    const ours = vi.mocked(submitExecution).mock.calls.map((c) => c[0] as { tasks: Record<string, unknown>[] }).filter((d) => d.tasks[0]?.["team"] === prov);
    expect(ours.map((d) => d.tasks)).toEqual([[expect.objectContaining({ id: "check", action: "ready", inputs: {} })]]);
    const [run] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.name, `Check: ${prov}-svc-ready`));
    expect(run).toMatchObject({ template: "check", submittedBy: null });
    // Its page says the check started it, not a deleted account.
    const shown = await call<{ execution?: { submittedBy?: string } }>(maintainerToken, "ExecutionService/GetExecution", { executionId: run?.executionId });
    expect(shown.body.execution?.submittedBy).toBe("the readiness check");
    expect((await readinessRow())?.state).toBe("checking");
    vi.mocked(submitExecution).mockClear();
    await checkDue(silent);
    expect(vi.mocked(submitExecution).mock.calls.filter((c) => (c[0] as { tasks: Record<string, unknown>[] }).tasks[0]?.["team"] === prov)).toEqual([]);
  });

  it("is kept, shown with the product and in the catalog, and a product not ready tells its maintainers once", async () => {
    vi.mocked(submitExecution).mockClear();
    // Asked for again (as Check now would), so this test's run is the last.
    expect((await call<{ started?: boolean }>(maintainerToken, "ProductService/CheckProduct", { name: `${prov}-svc-create` })).body.started).toBe(false);
    await db.update(productReadiness).set({ state: "failed" }).where(eq(productReadiness.product, `${prov}-svc-ready`));
    expect((await call(outsiderToken, "ProductService/CheckProduct", { name: `${prov}-svc-create` })).code).toBe("permission_denied");
    expect((await call<{ started?: boolean }>(maintainerToken, "ProductService/CheckProduct", { name: `${prov}-svc-create` })).body.started).toBe(true);
    await answered({ ready: false, principal: "svc@acme.iam", missing: ["roles/browser on folder 12"], detail: "Can't list projects." });
    expect(await readinessRow()).toMatchObject({ state: "not_ready", principal: "svc@acme.iam", missing: ["roles/browser on folder 12"] });

    const listed = (await call<{ products?: { name: string; readiness?: { state: string; missing?: string[] } }[] }>(maintainerToken, "ProductService/ListProducts")).body.products ?? [];
    expect(listed.find((p) => p.name === `${prov}-svc-create`)?.readiness).toMatchObject({ state: "not_ready", missing: ["roles/browser on folder 12"] });
    const runnables = (await call<{ runnables?: { name: string; readiness?: { state: string } }[] }>(maintainerToken, "TemplateService/ListTemplates")).body.runnables ?? [];
    expect(runnables.find((r) => r.name === `${prov}-svc-create`)?.readiness?.state).toBe("not_ready");

    const told = await db
      .select({ userId: userNotifications.userId })
      .from(userNotifications)
      .innerJoin(notificationEvents, eq(notificationEvents.id, userNotifications.eventId))
      .where(like(notificationEvents.key, `ready:${prov}%`));
    expect(told.map((t) => t.userId)).toContain(maintainer.id);
    // The same answer again isn't news.
    await db.update(productReadiness).set({ state: "failed" }).where(eq(productReadiness.product, `${prov}-svc-ready`));
    await call(maintainerToken, "ProductService/CheckProduct", { name: `${prov}-svc-create` });
    await answered({ ready: false, principal: "svc@acme.iam", missing: ["roles/browser on folder 12"] });
    expect(await db.select().from(notificationEvents).where(like(notificationEvents.key, `ready:${prov}%`))).toHaveLength(1);
  });

  it("is run again for a new image", async () => {
    await db.update(productReadiness).set({ state: "failed" }).where(eq(productReadiness.product, `${prov}-svc-ready`));
    await call(maintainerToken, "ProductService/CheckProduct", { name: `${prov}-svc-create` });
    await answered({ ready: true, principal: "svc@acme.iam" });
    expect((await readinessRow())?.state).toBe("ready");
    vi.mocked(submitExecution).mockClear();
    await checkDue(silent);
    expect(vi.mocked(submitExecution).mock.calls.filter((c) => (c[0] as { tasks: Record<string, unknown>[] }).tasks[0]?.["team"] === prov)).toEqual([]);
    await register("ready", `registry.example/${prov}/svc:2`);
    await checkDue(silent);
    expect(vi.mocked(submitExecution).mock.calls.filter((c) => (c[0] as { tasks: Record<string, unknown>[] }).tasks[0]?.["team"] === prov)).toHaveLength(1);
    expect(await db.select().from(productReadiness).where(inArray(productReadiness.product, [`${prov}-svc-ready`]))).toHaveLength(1);
  });

  it("that couldn't start shows a plain sentence, never the platform's error", async () => {
    await db.update(productReadiness).set({ state: "failed" }).where(eq(productReadiness.product, `${prov}-svc-ready`));
    // What a client-node error's message looks like: the API server's body and headers.
    vi.mocked(submitExecution).mockRejectedValueOnce(new Error('HTTP-Code: 500 Message: Body: {"secret":"cluster-detail"} Headers: {"audit-id":"x"}'));
    expect((await call<{ started?: boolean }>(maintainerToken, "ProductService/CheckProduct", { name: `${prov}-svc-create` })).body.started).toBe(true);
    const row = await readinessRow();
    expect(row?.state).toBe("failed");
    expect(row?.detail).toBe("Vennir couldn't start its check: the platform didn't answer.");
  });
});
