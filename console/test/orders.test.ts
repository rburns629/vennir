// SPDX-License-Identifier: MIT
/**
 * The order builder (src/core/orders.ts, decision 23): a cart wired by
 * wiring type, a default provider added, a shared type asked once, a choice
 * left to the person, a cycle reported; and PreviewOrder's own checks (its
 * team's members, no ordering bot, only actions shared with the caller) on
 * the real test database.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { planOrder } from "../src/core/orders.js";
import type { TeamProduct } from "../src/core/templates.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, findTeamByName, upsertProduct } from "../src/db/queries.js";
import { products, resources, submittedExecutions, teams, users as usersTable, wiringTypes } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { submitExecution } from "../src/kernel/client.js";
import { caller, rpcClient } from "./rpc.js";
import { lockWiringTypes } from "./wiringTypesLock.js";

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
  return { ...actual, submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })) };
});
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "registry.example/", additional: [], version: "1" })),
}));

/** A product, as planOrder needs it: what it needs and provides, by wiring type ("": none). */
function product(name: string, needs: Record<string, string | [string, "optional"]>, provides: Record<string, string> = {}): TeamProduct {
  const required = Object.entries(needs).filter(([, t]) => typeof t === "string").map(([n]) => n);
  return {
    name: `platform-${name}-create`,
    teamName: "platform",
    action: "create",
    shareWith: ["*"],
    inputSchema: {
      type: "object",
      required,
      properties: Object.fromEntries(
        Object.entries(needs).map(([n, t]) => {
          const wiring = typeof t === "string" ? t : t[0];
          return [n, { type: "string", ...(wiring ? { "x-vennir-needs": wiring } : {}) }];
        }),
      ),
    },
    outputSchema: { type: "object", properties: Object.fromEntries(Object.entries(provides).map(([n, t]) => [n, { type: "string", "x-vennir-provides": t }])) },
  } as unknown as TeamProduct;
}

const project = product("project", { name: "" }, { projectId: "gcp.project" });
const network = product("network", { project: "gcp.project", region: "gcp.region" }, { network: "gcp.network" });
const vm = product("vm", { project: "gcp.project", network: "gcp.network", region: "gcp.region" }, { ip: "ip" });
const types = [
  { name: "gcp.project", shared: false, defaultProvider: "platform/project.create" },
  { name: "gcp.network", shared: false, defaultProvider: null },
  { name: "gcp.region", shared: true, defaultProvider: null },
];
const defaults = new Map([["platform/project.create", project]]);

describe("planning an order", () => {
  it("wires each input to the one output of its type, each step after what it takes from", () => {
    const { steps, problems } = planOrder([vm, network, project], types, defaults, []);
    expect(problems).toEqual([]);
    expect(steps.map((s) => s.id)).toEqual(["project", "network", "vm"]);
    expect(steps.find((s) => s.id === "vm")?.inputs).toEqual({
      project: { kind: "step", step: "project", output: "projectId" },
      network: { kind: "step", step: "network", output: "network" },
      // A shared type: one parameter, named for it, for every input of it.
      region: { kind: "parameter", parameter: "gcp.region" },
    });
    expect(steps.find((s) => s.id === "network")?.inputs["region"]).toEqual({ kind: "parameter", parameter: "gcp.region" });
    // An input with no wiring type is the person's to fill.
    expect(steps.find((s) => s.id === "project")?.inputs["name"]).toEqual({ kind: "unset" });
  });

  it("adds a type's default provider when nothing in the cart provides it, once", () => {
    const { steps, problems } = planOrder([vm, network], types, defaults, []);
    expect(problems).toEqual([]);
    expect(steps.map((s) => [s.id, s.added])).toEqual([["project", true], ["network", false], ["vm", false]]);
    // Not available to the caller: said, not added.
    const without = planOrder([network], types, new Map([["platform/project.create", null]]), []);
    expect(without.steps.map((s) => s.id)).toEqual(["network"]);
    expect(without.problems).toMatchObject([{ code: "NO_PROVIDER", step: "network", input: "project" }]);
  });

  it("leaves an input two outputs could fill to the person, until they choose", () => {
    const other = product("other-project", {}, { projectId: "gcp.project" });
    const open = planOrder([project, other, network], types, defaults, []);
    expect(open.steps.find((s) => s.id === "network")?.inputs["project"]).toEqual({ kind: "unset" });
    expect(open.problems).toMatchObject([
      {
        code: "AMBIGUOUS",
        step: "network",
        input: "project",
        options: [
          { fromStep: "project", fromOutput: "projectId" },
          { fromStep: "other-project", fromOutput: "projectId" },
        ],
      },
    ]);
    const chosen = planOrder([project, other, network], types, defaults, [{ step: "network", input: "project", fromStep: "other-project", fromOutput: "projectId" }]);
    expect(chosen.problems).toEqual([]);
    expect(chosen.steps.find((s) => s.id === "network")?.inputs["project"]).toEqual({ kind: "step", step: "other-project", output: "projectId" });
  });

  it("reports steps that feed each other round in a circle", () => {
    const a = product("a", { b: "type.b" }, { a: "type.a" });
    const b = product("b", { a: "type.a" }, { b: "type.b" });
    const { steps, problems } = planOrder([a, b], [], new Map(), []);
    expect(steps.map((s) => s.id)).toEqual(["a", "b"]);
    expect(problems).toMatchObject([{ code: "CYCLE", step: "a, b" }]);
  });

  it("leaves what an action makes to the person: a project.create's project id is never wired", () => {
    const create = product("project-create", { projectId: "gcp.project" }, { projectId: "gcp.project" });
    const { steps, problems } = planOrder([create], types, defaults, []);
    expect(problems).toEqual([]);
    expect(steps.map((s) => s.id)).toEqual(["project-create"]);
    expect(steps[0]?.inputs["projectId"]).toEqual({ kind: "unset" });
  });

  it("offers what's already there before adding a new one, none chosen", () => {
    const existing = [
      { id: "r1", wiringType: "gcp.project", value: "web-prod", label: "web-prod (gcp/project)" },
      { id: "r2", wiringType: "gcp.project", value: "web-dev", label: "web-dev (gcp/project)" },
    ];
    const open = planOrder([network], types, defaults, [], existing);
    expect(open.steps.map((s) => s.id)).toEqual(["network"]);
    expect(open.steps[0]?.inputs["project"]).toEqual({ kind: "unset" });
    expect(open.problems).toMatchObject([
      {
        code: "CHOOSE_EXISTING",
        step: "network",
        input: "project",
        options: [{ resourceId: "r1" }, { resourceId: "r2" }, { addNew: true }],
      },
    ]);

    const used = planOrder([network], types, defaults, [{ step: "network", input: "project", resourceId: "r2" }], existing);
    expect(used.problems).toEqual([]);
    expect(used.steps.map((s) => s.id)).toEqual(["network"]);
    expect(used.steps[0]?.inputs["project"]).toEqual({ kind: "resource", resourceId: "r2", value: "web-dev" });

    const fresh = planOrder([network], types, defaults, [{ step: "network", input: "project", addNew: true }], existing);
    expect(fresh.problems).toEqual([]);
    expect(fresh.steps.map((s) => [s.id, s.added])).toEqual([["project", true], ["network", false]]);
    expect(fresh.steps[1]?.inputs["project"]).toEqual({ kind: "step", step: "project", output: "projectId" });
  });

  it("suggests what could fill an optional input, adding nothing", () => {
    const database = product("database", {}, { connection: "gcp.db" });
    const app = product("app", { project: "gcp.project", db: ["gcp.db", "optional"] });
    const withDb = [...types, { name: "gcp.db", shared: false, defaultProvider: "platform/database.create" }];
    const { steps, problems, suggestions } = planOrder([project, app], withDb, new Map([...defaults, ["platform/database.create", database]]), [], [
      { id: "d1", wiringType: "gcp.db", value: "p:r:main", label: "main (gcp/sql)" },
    ]);
    expect(problems).toEqual([]);
    expect(steps.map((s) => s.id)).toEqual(["project", "app"]);
    expect(steps[1]?.inputs["db"]).toEqual({ kind: "unset" });
    expect(suggestions).toMatchObject([{ step: "app", input: "db", wiringType: "gcp.db", provider: "platform-database-create", existing: [{ resourceId: "d1" }] }]);
  });

  it("gives the same action twice two steps", () => {
    const { steps } = planOrder([project, project], types, defaults, []);
    expect(steps.map((s) => s.id)).toEqual(["project", "project-2"]);
  });
});

const prefix = `ord-${randomUUID().slice(0, 6)}`;
const team = `${prefix}-shop`;
const other = `${prefix}-other`;
let app: FastifyInstance;
let unlock: () => Promise<void>;
const users = rpcClient(() => app);
const call = caller(() => app);

beforeAll(async () => {
  unlock = await lockWiringTypes();
  app = await buildApp();
  const shop = await createTeam(team);
  const otherTeam = await createTeam(other);
  // Wiring types of this test's own, beside whatever the catalog has.
  await db.insert(wiringTypes).values([
    { name: `${prefix}.project`, jsonType: "string", description: "", shared: false, defaultProvider: `${team}/project.create` },
  ]);
  await upsertProduct({
    name: `${team}-project-create`,
    image: `registry.example/${team}/project:1`,
    action: "create",
    teamId: shop.id,
    outputSchema: { type: "object", properties: { projectId: { type: "string", "x-vennir-provides": `${prefix}.project` } } },
  });
  await upsertProduct({
    name: `${team}-bucket-create`,
    image: `registry.example/${team}/bucket:1`,
    action: "create",
    teamId: shop.id,
    inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string", "x-vennir-needs": `${prefix}.project` } } },
  });
  await upsertProduct({ name: `${other}-secret-get`, image: `registry.example/${other}/secret:1`, action: "get", teamId: otherTeam.id });
});

afterAll(async () => {
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.onBehalfOf, [team]));
  await db.delete(wiringTypes).where(inArray(wiringTypes.name, [`${prefix}.project`]));
  await db.delete(resources).where(like(resources.productTeam, `${prefix}%`));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  // The ordering bot made through the API, and the people.
  await db.delete(usersTable).where(like(usersTable.email, `${prefix}-%`));
  await users.cleanUp();
  await app.close();
  await unlock();
});

describe("PreviewOrder", () => {
  it("wires a cart for a member of its team, adding the default provider", async () => {
    const member = await users.makeUser();
    await join(member.id, team);
    const token = await users.signIn(member.email);
    const preview = await call<{ steps: { id: string; product: string; added?: boolean; inputs: Record<string, unknown> }[]; problems?: unknown[] }>(
      token,
      "OrderService/PreviewOrder",
      { team, actions: [`${team}-bucket-create`] },
    );
    expect(preview.code).toBe("ok");
    expect(preview.body.steps.map((s) => [s.id, s.added ?? false])).toEqual([["project", true], ["bucket", false]]);
    expect(preview.body.steps[1]?.inputs["project"]).toMatchObject({ kind: "step", step: "project", output: "projectId" });
    expect(preview.body.problems ?? []).toEqual([]);

    // Not for a team they aren't in; not an action that isn't shared with them.
    expect((await call(token, "OrderService/PreviewOrder", { team: other, actions: [`${team}-bucket-create`] })).code).toBe("permission_denied");
    expect((await call(token, "OrderService/PreviewOrder", { team, actions: [`${other}-secret-get`] })).code).toBe("not_found");
  });

  it("offers the team's own resources of a needed type, not other teams'", async () => {
    const member = await users.makeUser();
    await join(member.id, team);
    const token = await users.signIn(member.email);
    const made = (owner: string, id: string) => ({
      product: `${team}-project-create`,
      productTeam: team,
      type: "demo/project",
      externalId: `${prefix}-${id}`,
      ownerTeam: owner,
      executionId: randomUUID(),
      taskId: "project",
      provides: [{ type: `${prefix}.project`, value: `${prefix}-${id}`, output: "projectId" }],
    });
    await db.insert(resources).values([made(team, "ours"), made(other, "theirs")]);
    const preview = await call<{ problems?: { code: string; options: { resourceId?: string; addNew?: boolean; label?: string }[] }[] }>(
      token,
      "OrderService/PreviewOrder",
      { team, actions: [`${team}-bucket-create`] },
    );
    expect(preview.code).toBe("ok");
    expect(preview.body.problems).toMatchObject([{ code: "CHOOSE_EXISTING" }]);
    const options = preview.body.problems?.[0]?.options ?? [];
    expect(options.map((o) => o.label ?? "")).toEqual([`${prefix}-ours (demo/project)`, expect.stringContaining("A new one")]);
    await db.delete(resources).where(like(resources.externalId, `${prefix}-%`));
  });

  it("isn't for an ordering bot: carts become templates first", async () => {
    const maintainer = await users.makeUser();
    await join(maintainer.id, team, "maintainer");
    const made = await call<{ token: string }>(await users.signIn(maintainer.email), "TokenService/CreateBotToken", {
      team, email: `${prefix}-orders@bot.example.com`, label: "storefront", ordering: true, orderTemplates: [],
    });
    expect((await call(made.body.token, "OrderService/PreviewOrder", { team, actions: [`${team}-bucket-create`] })).failure).toBe("ORDERS_ONLY");
  });
});

describe("PlaceOrder", () => {
  type Dag = { tasks: { id: string; team: string; dependsOn?: string[]; inputs: Record<string, unknown> }[] };
  const lastDag = () => vi.mocked(submitExecution).mock.calls.at(-1)?.[0] as Dag;
  let token: string;
  beforeAll(async () => {
    const member = await users.makeUser();
    await join(member.id, team);
    token = await users.signIn(member.email);
  });

  it("runs a cart as one run, the default provider added and wired in, as the team's order", async () => {
    vi.mocked(submitExecution).mockClear();
    const placed = await call<{ executionId: string }>(token, "OrderService/PlaceOrder", { team, actions: [`${team}-bucket-create`], requestId: `${prefix}-1` });
    expect(placed.code).toBe("ok");
    expect(lastDag().tasks.map((t) => [t.id, t.dependsOn ?? [], t.inputs])).toEqual([
      ["project", [], {}],
      ["bucket", ["project"], { project: { $fromTask: "project", $output: "projectId" } }],
    ]);
    const [run] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, placed.body.executionId));
    expect(run).toMatchObject({ template: "order", onBehalfOf: team, templateParameters: { actions: [`${team}-bucket-create`] } });
    // Each planned step's product, the one the plan added marked: for the run's page.
    expect((run?.templateParameters as { steps?: unknown } | null)?.steps).toEqual([
      { id: "project", product: `${team}-project-create`, added: true },
      { id: "bucket", product: `${team}-bucket-create`, added: false },
    ]);
  });

  it("is refused while a choice is unmade, and uses what's already there once chosen", async () => {
    const [made] = await db
      .insert(resources)
      .values({
        product: `${team}-project-create`,
        productTeam: team,
        type: "demo/project",
        externalId: `${prefix}-existing`,
        ownerTeam: team,
        executionId: randomUUID(),
        taskId: "project",
        provides: [{ type: `${prefix}.project`, value: `${prefix}-existing`, output: "projectId" }],
      })
      .returning();
    try {
      const refused = await call(token, "OrderService/PlaceOrder", { team, actions: [`${team}-bucket-create`] });
      expect(refused.failure).toBe("ORDER_INCOMPLETE");
      vi.mocked(submitExecution).mockClear();
      const placed = await call(token, "OrderService/PlaceOrder", {
        team,
        actions: [`${team}-bucket-create`],
        choices: [{ step: "bucket", input: "project", resourceId: made?.id }],
      });
      expect(placed.code).toBe("ok");
      expect(lastDag().tasks).toMatchObject([{ id: "bucket", inputs: { project: `${prefix}-existing` } }]);
      // The run's page reads the chosen resource by its id.
      const chosen = await call<{ resources?: { id: string; externalId: string }[] }>(token, "ResourceService/ListResources", { ids: [made?.id] });
      expect(chosen.body.resources?.map((r) => r.externalId)).toEqual([`${prefix}-existing`]);
    } finally {
      await db.delete(resources).where(like(resources.externalId, `${prefix}-%`));
    }
  });

  it("isn't for someone outside the team, or an ordering bot", async () => {
    const outsider = await users.signIn((await users.makeUser()).email);
    expect((await call(outsider, "OrderService/PlaceOrder", { team, actions: [`${team}-bucket-create`] })).code).toBe("permission_denied");
    const maintainer = await users.makeUser();
    await join(maintainer.id, team, "maintainer");
    const bot = await call<{ token: string }>(await users.signIn(maintainer.email), "TokenService/CreateBotToken", {
      team, email: `${prefix}-cart@bot.example.com`, label: "storefront", ordering: true, orderTemplates: [],
    });
    expect((await call(bot.body.token, "OrderService/PlaceOrder", { team, actions: [`${team}-bucket-create`] })).failure).toBe("ORDERS_ONLY");
  });
});

async function join(userId: string, name: string, role: "member" | "maintainer" = "member") {
  const found = await findTeamByName(name);
  await addTeamMember(userId, found?.id ?? "", role);
}
