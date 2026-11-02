// SPDX-License-Identifier: MIT
/**
 * A product's clouds (core/clouds.ts): one whose clouds leave out this
 * install's is listed and marked, never checked, and refused at submit,
 * before anything reaches kernel-api; with no clouds, or on an install
 * whose cloud isn't known, it's as before. kernel-api and the registry are
 * stubbed; the rest is the real console on the real test database.
 */
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, upsertProduct } from "../src/db/queries.js";
import { products, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { submitExecution, type KernelExecution } from "../src/kernel/client.js";
import { checkDue } from "../src/readiness.js";
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

const prefix = `cld-${randomUUID().slice(0, 6)}`;
const team = `${prefix}-aws`;
const silent = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Parameters<typeof checkDue>[0];

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let token: string;

const register = (product: string, action: string, clouds: string[], cloudsFrom: string) =>
  upsertProduct({ name: `${team}-${product}-${action}`, image: `registry.example/${team}/${product}:1`, action, teamId: teamId, shareWith: ["*"],
    inputSchema: { type: "object" }, check: "ready", clouds, cloudsFrom });
let teamId = "";

type Listed = { products?: { name: string; clouds?: string[]; cloudsFrom?: string; runsHere?: boolean; readiness?: { state: string } }[] };
const listed = async () => ((await call<Listed>(token, "ProductService/ListProducts")).body.products ?? []).filter((p) => p.name.startsWith(team));
const submit = (product: string) =>
  call<{ executionId?: string }>(token, "ExecutionService/SubmitExecution", {
    dag: { name: "clouds", requestId: randomUUID(), tasks: [{ id: "one", image: `registry.example/${team}/${product}:1`, action: "create", team, inputs: {} }] },
  });

beforeAll(async () => {
  app = await buildApp();
  teamId = (await createTeam(team)).id;
  await register("bucket", "create", ["aws"], "team");
  await register("bucket", "ready", ["aws"], "team");
  await register("everywhere", "create", [], "");
  await register("everywhere", "ready", [], "");
  const member = await users.makeUser();
  await addTeamMember(member.id, teamId, "maintainer");
  token = await users.signIn(member.email);
});

beforeEach(() => {
  config.installCloud = "gcp";
  vi.mocked(submitExecution).mockClear();
});

afterAll(async () => {
  config.installCloud = "";
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("a product for other clouds' installs", () => {
  it("is listed, with its clouds and where they're set, as not for this install", async () => {
    const bucket = (await listed()).find((p) => p.name === `${team}-bucket-create`);
    expect(bucket).toMatchObject({ clouds: ["aws"], cloudsFrom: "team" });
    expect(bucket?.runsHere ?? false).toBe(false);
    expect((await listed()).find((p) => p.name === `${team}-everywhere-create`)?.runsHere).toBe(true);
    expect((await call<{ cloud?: string }>("", "AuthService/GetEnvironment")).body.cloud).toBe("gcp");
  });

  it("is never checked here, and shows no readiness", async () => {
    await checkDue(silent);
    const checked = vi.mocked(submitExecution).mock.calls.map((c) => (c[0] as { tasks: { image: string }[] }).tasks[0]?.image ?? "");
    expect(checked.some((image) => image.includes(`${team}/everywhere`))).toBe(true);
    expect(checked.some((image) => image.includes(`${team}/bucket`))).toBe(false);
    expect((await listed()).find((p) => p.name === `${team}-bucket-create`)?.readiness).toBeUndefined();
    const now = await call(token, "ProductService/CheckProduct", { name: `${team}-bucket-create` });
    expect(now.code).toBe("failed_precondition");
  });

  it("is refused at submit, and nothing reaches kernel-api", async () => {
    const refused = await submit("bucket");
    expect(refused.code).toBe("failed_precondition");
    expect(refused.message).toContain(`${team}-bucket-create is for aws installs; this install is on gcp.`);
    expect(refused.failure).toBe("NOT_FOR_THIS_INSTALL");
    expect(vi.mocked(submitExecution)).not.toHaveBeenCalled();
    const ran = await submit("everywhere");
    expect(ran.message ?? "").toBe("");
    expect(ran.body.executionId).toBeTruthy();
  });

  it("runs on an install on its cloud, and on one whose cloud isn't known", async () => {
    config.installCloud = "aws";
    expect((await submit("bucket")).body.executionId).toBeTruthy();
    config.installCloud = "";
    expect((await submit("bucket")).body.executionId).toBeTruthy();
    expect((await listed()).find((p) => p.name === `${team}-bucket-create`)?.runsHere).toBe(true);
  });
});
