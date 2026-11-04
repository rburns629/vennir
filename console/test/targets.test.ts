// SPDX-License-Identifier: MIT
/**
 * Allowed targets (X1): another team may aim a team's products only where
 * that team's allowedTargets let it. Checked before anything runs, from the
 * input's x-vennir-needs type; the owning team's own people aren't limited.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, upsertProduct, upsertTemplate } from "../src/db/queries.js";
import { products, submittedExecutions, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { retryTask, submitExecution } from "../src/kernel/client.js";
import { allowedValues, matchesTarget, narrowWiredTargets, targetProblems } from "../src/targets.js";
import { caller, failureCode, problemFields, rpcClient, type RpcError } from "./rpc.js";

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
    retryTask: vi.fn(() => Promise.resolve({ executionId: "retried", taskId: "run", state: "READY" })),
  };
});
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "registry.example/", additional: [], version: "1" })),
}));

const prefix = `tgt-${randomUUID().slice(0, 6)}`;
/** The team whose product acts on a project; a team it allows some; one it allows none. */
const owner = `${prefix}-owner`;
const allowed = `${prefix}-apps`;
const other = `${prefix}-other`;
const product = `${owner}-project-create`;

let app: FastifyInstance;
let appsToken: string;
let otherToken: string;
let ownerToken: string;
const call = caller(() => app);
const users = rpcClient(() => app);

const inputSchema = {
  type: "object",
  required: ["projectId"],
  properties: { projectId: { type: "string", "x-vennir-needs": "gcp.project" }, label: { type: "string" } },
};

beforeAll(async () => {
  app = await buildApp();
  const [ownerTeam, appsTeam, otherTeam] = [await createTeam(owner), await createTeam(allowed), await createTeam(other)];
  await db
    .update(teams)
    .set({ allowedTargets: [{ teams: [allowed], targets: { "gcp.project": [`${allowed}-*`, "shared-sandbox"] } }] })
    .where(eq(teams.id, ownerTeam.id));
  await upsertProduct({
    name: product,
    image: `registry.example/${owner}/project:1`,
    action: "create",
    teamId: ownerTeam.id,
    inputSchema,
    shareWith: ["*"],
  });
  // Another team's template that passes its own parameter through.
  await upsertTemplate({
    teamId: appsTeam.id,
    name: "new-project",
    displayName: "New project",
    description: "",
    parameters: { type: "object", properties: { project: { type: "string" } } },
    steps: [{ id: "make", action: `${owner}/project.create`, inputs: { projectId: { $param: "project" } } }],
    shareWith: [],
    deprecated: null,
  });
  // A step of any team's that says it provides a project, wired into the
  // owner's: the value isn't known until it runs (a cart can wire it in).
  for (const [team, teamId] of [[allowed, appsTeam.id], [other, otherTeam.id]] as const) {
    await upsertProduct({
      name: `${team}-source-make`,
      image: `registry.example/${team}/source:1`,
      action: "make",
      teamId,
      outputSchema: { type: "object", properties: { projectId: { type: "string", "x-vennir-provides": "gcp.project" } } },
    });
    await upsertTemplate({
      teamId,
      name: "wired-project",
      displayName: "Wired project",
      description: "",
      parameters: { type: "object" },
      steps: [
        { id: "source", action: `${team}/source.make`, inputs: {} },
        { id: "make", action: `${owner}/project.create`, dependsOn: ["source"], inputs: { projectId: { $fromStep: "source", $output: "projectId" } } },
      ],
      shareWith: [],
      deprecated: null,
    });
  }
  const [apps, outsider, ownerMember] = [await users.makeUser(), await users.makeUser(), await users.makeUser()];
  await addTeamMember(apps.id, appsTeam.id, "member");
  await addTeamMember(outsider.id, otherTeam.id, "member");
  await addTeamMember(ownerMember.id, ownerTeam.id, "member");
  [appsToken, otherToken, ownerToken] = await Promise.all([apps, outsider, ownerMember].map((u) => users.signIn(u.email)));
});

afterAll(async () => {
  await db.delete(submittedExecutions).where(like(submittedExecutions.template, `${prefix}%`));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  const ours = await db.select({ id: teams.id }).from(teams).where(like(teams.name, `${prefix}%`));
  if (ours.length > 0) await db.delete(teams).where(inArray(teams.id, ours.map((t) => t.id)));
  await users.cleanUp();
  await app.close();
});

describe("matching", () => {
  it("takes exact values and * for any run of characters, nothing else as special", () => {
    expect(matchesTarget("apps-*", "apps-dev")).toBe(true);
    expect(matchesTarget("apps-*", "payments-apps-dev")).toBe(false);
    expect(matchesTarget("folders/12", "folders/12")).toBe(true);
    expect(matchesTarget("a.b", "aXb")).toBe(false);
    expect(matchesTarget("*", "anything")).toBe(true);
  });

  it("finds a team's values in rules for it or for every team", () => {
    const rules = [
      { teams: ["web"], targets: { "gcp.project": ["web-*"] } },
      { teams: ["*"], targets: { "gcp.project": ["sandbox"], "aws.account": ["1"] } },
    ];
    expect(allowedValues(rules, ["web"], "gcp.project")).toEqual(["web-*", "sandbox"]);
    expect(allowedValues(rules, ["data"], "gcp.project")).toEqual(["sandbox"]);
  });

  it("leaves a value an earlier step produced alone", () => {
    const team = { name: "o", allowedTargets: [] };
    expect(targetProblems(team, inputSchema, { projectId: { $fromTask: "a", $output: "projectId" } }, ["web"])).toEqual([]);
    expect(targetProblems(team, inputSchema, { projectId: "x" }, ["web"])).toHaveLength(1);
  });
});

describe("a target another step will fill", () => {
  const wired = { projectId: { $fromTask: "a", $output: "projectId" } };

  it("is limited, for the kernel, to what the owner lets the team use without an approval", () => {
    const rules = [
      { teams: ["web"], targets: { "gcp.project": ["web-*", "a.b"] } },
      { teams: ["web"], targets: { "gcp.project": ["prod-*"] }, approval: true },
    ];
    const { schema, refused } = narrowWiredTargets({ allowedTargets: rules }, inputSchema, wired, ["web"]);
    expect(refused).toEqual([]);
    expect((schema as { properties: Record<string, unknown> }).properties["projectId"]).toEqual({
      allOf: [inputSchema.properties.projectId, { anyOf: [{ type: "string", pattern: "^web-.*$" }, { type: "string", pattern: "^a\\.b$" }] }],
    });
    // A value given now is left to the submit-time check.
    expect(narrowWiredTargets({ allowedTargets: rules }, inputSchema, { projectId: "web-1" }, ["web"]).schema).toBe(inputSchema);
    // Allowed only with an approval, or not at all: refused.
    expect(narrowWiredTargets({ allowedTargets: rules.slice(1) }, inputSchema, wired, ["web"]).refused).toEqual([{ field: "projectId", kind: "gcp.project" }]);
  });

  it("goes to the kernel limited when another team runs it, and is refused for a team allowed none", async () => {
    vi.mocked(submitExecution).mockClear();
    const ok = await call<RpcError>(appsToken, "TemplateService/RunTemplate", { team: allowed, name: "wired-project", parameters: {} });
    expect(ok.code).toBe("ok");
    const dag = vi.mocked(submitExecution).mock.calls.at(-1)?.[0] as { tasks: { id: string; inputSchema?: { properties: Record<string, { allOf?: unknown[] }> } }[] };
    const make = dag.tasks.find((t) => t.id === "make");
    expect(make?.inputSchema?.properties["projectId"]?.allOf?.[1]).toEqual({
      anyOf: [{ type: "string", pattern: `^${allowed}-.*$` }, { type: "string", pattern: "^shared-sandbox$" }],
    });
    const refused = await call<RpcError>(otherToken, "TemplateService/RunTemplate", { team: other, name: "wired-project", parameters: {} });
    expect(refused.code).toBe("invalid_argument");
    expect(failureCode(refused.body)).toBe("INPUT_INVALID");
  });
});

describe("running another team's action", () => {
  const run = (token: string, projectId: string) =>
    call<{ executionId: string } & RpcError>(token, "TemplateService/RunAction", { product, inputs: { projectId } });

  it("goes where the owning team allows the running team", async () => {
    expect((await run(appsToken, `${allowed}-dev`)).code).toBe("ok");
    expect((await run(appsToken, "shared-sandbox")).code).toBe("ok");
  });

  it("is refused anywhere else, before anything runs, on the field that named it", async () => {
    vi.mocked(submitExecution).mockClear();
    const refused = await run(appsToken, "payments-prod");
    expect(refused.code).toBe("permission_denied");
    expect(failureCode(refused.body)).toBe("TARGET_NOT_ALLOWED");
    expect(problemFields(refused.body)).toEqual(["parameters.projectId"]);
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("is refused everywhere to a team the owner allows nothing, and says to ask", async () => {
    const refused = await run(otherToken, "anything");
    expect(refused.code).toBe("permission_denied");
    expect(refused.message).toContain("allowedTargets");
  });

  it("isn't limited for the owning team's own people", async () => {
    expect((await run(ownerToken, "payments-prod")).code).toBe("ok");
  });

  it("offers each team what it may use", async () => {
    type Listed = { runnables?: { name: string; targets?: { parameter: string; type: string; allowed?: string[] }[] }[] };
    const targetsFor = async (token: string) =>
      (((await call<Listed>(token, "TemplateService/ListTemplates")).body.runnables ?? []).find((r) => r.name === product)?.targets ?? []).map(
        (t) => ({ ...t, allowed: t.allowed ?? [] }),
      );
    expect(await targetsFor(appsToken)).toEqual([{ parameter: "projectId", type: "gcp.project", allowed: [`${allowed}-*`, "shared-sandbox"] }]);
    expect(await targetsFor(otherToken)).toEqual([{ parameter: "projectId", type: "gcp.project", allowed: [] }]);
    expect(await targetsFor(ownerToken)).toEqual([]);
  });
});

describe("retrying another team's action", () => {
  it("is refused once the owning team no longer allows its target, and not where it still does", async () => {
    const run = (projectId: string) =>
      call<{ executionId: string } & RpcError>(appsToken, "TemplateService/RunAction", { product, inputs: { projectId } });
    const sandbox = (await run("shared-sandbox")).body.executionId;
    const own = (await run(`${allowed}-dev`)).body.executionId;
    const taskOf = async (id: string) => {
      const [row] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, id));
      const tasks = (row?.payload as { tasks: { id: string }[] }).tasks;
      return tasks[0]!.id;
    };
    const [ownerTeam] = await db.select().from(teams).where(eq(teams.name, owner));
    const rules = ownerTeam!.allowedTargets;
    // The owner narrows its rules: no more shared sandbox for anyone.
    await db.update(teams).set({ allowedTargets: [{ teams: [allowed], targets: { "gcp.project": [`${allowed}-*`] } }] }).where(eq(teams.id, ownerTeam!.id));
    try {
      vi.mocked(retryTask).mockClear();
      const refused = await call<RpcError>(appsToken, "ExecutionService/RetryTask", { executionId: sandbox, taskId: await taskOf(sandbox) });
      expect(refused.code).toBe("permission_denied");
      expect(failureCode(refused.body)).toBe("TARGET_NOT_ALLOWED");
      expect(problemFields(refused.body)).toEqual(["inputs.projectId"]);
      expect(retryTask).not.toHaveBeenCalled();
      expect((await call(appsToken, "ExecutionService/RetryTask", { executionId: own, taskId: await taskOf(own) })).code).toBe("ok");
    } finally {
      await db.update(teams).set({ allowedTargets: rules }).where(eq(teams.id, ownerTeam!.id));
    }
  });
});

describe("running a template whose step is another team's", () => {
  it("checks the parameter its step takes the target from", async () => {
    const run = (project: string) =>
      call<RpcError>(appsToken, "TemplateService/RunTemplate", { team: allowed, name: "new-project", parameters: { project } });
    expect((await run(`${allowed}-web`)).code).toBe("ok");
    const refused = await run("payments-prod");
    expect(refused.code).toBe("permission_denied");
    expect(problemFields(refused.body)).toEqual(["parameters.project"]);
  });
});
