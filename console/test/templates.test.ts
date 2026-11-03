// SPDX-License-Identifier: MIT
/**
 * Templates (src/core/templates.ts): what a consumer may run, the DAG a run
 * builds from products (never from the caller), parameters checked against
 * the template's schema, sharing with specific teams and on whose behalf,
 * a step of an action its team doesn't share, an action run on its own, and
 * a consumer's rights over their own run. kernel-api and the registry are
 * stubbed; the rest is the real console on the real test database.
 */
import { createHmac, randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, recordSecretGrant, upsertProduct, upsertTemplate } from "../src/db/queries.js";
import { botCallbacks, callbackDeliveries, products, submittedExecutions, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { config } from "../src/config.js";
import { deliverCallbacks, runFinishedCallbacks } from "../src/callbacks.js";
import { cancelExecution, getExecution, submitExecution } from "../src/kernel/client.js";
import { caller, problemFields, rpcClient, type RpcError } from "./rpc.js";

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
    cancelExecution: vi.fn((executionId: string) => Promise.resolve({ executionId, state: "CANCELLED" })),
    retryTask: vi.fn((executionId: string) => Promise.resolve({ executionId, state: "RUNNING" })),
  };
});
// The catalog repository a release came from, for "Ask for access": faked
// here, since catalog_sync is one row other test files write too.
vi.mock("../src/db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/queries.js")>()),
  catalogRepository: vi.fn(() => Promise.resolve("github.com/acme/vertra-catalog")),
}));
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "registry.example/", additional: [], version: "1" })),
}));

const prefix = `tpl-${randomUUID().slice(0, 6)}`;
/** The template's team; one that shares an action with it; one that shares nothing; a consumer team. */
const own = `${prefix}-own`;
const db_ = `${prefix}-db`;
const priv = `${prefix}-priv`;
const cons = `${prefix}-cons`;

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let outsiderToken: string;
let otherOutsiderToken: string;
let consumerToken: string;
let ownMemberToken: string;
let dbMemberToken: string;
let privMemberToken: string;

const parameters = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string", maxLength: 10 } },
};

/** The DAG the last call sent kernel-api. */
const forwarded = () => vi.mocked(submitExecution).mock.calls.at(-1)?.[0] as { tasks: Record<string, unknown>[] };

beforeAll(async () => {
  app = await buildApp();
  const [ownTeam, dbTeam, privTeam, consTeam] = [await createTeam(own), await createTeam(db_), await createTeam(priv), await createTeam(cons)];
  await recordSecretGrant({ teamId: ownTeam.id, secretName: "hello-key", keys: ["value"], source: "literal" });
  await upsertProduct({
    name: `${own}-hello-run`,
    image: `registry.example/${own}/hello:1`,
    action: "run",
    teamId: ownTeam.id,
    serviceAccount: "hello",
    secretRefs: ["hello-key"],
    // What the action takes: the template's parameter plus a value it fixes.
    inputSchema: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, fixed: { type: "integer" } } },
    examples: [{ name: "says hello", inputs: { text: "hi" }, outputs: { text: "HELLO" } }],
  });
  await upsertProduct({
    name: `${db_}-store-put`,
    image: `registry.example/${db_}/store:1`,
    action: "put",
    teamId: dbTeam.id,
    serviceAccount: "store",
    shareWith: [own],
  });
  await upsertProduct({
    name: `${priv}-secret-get`,
    image: `registry.example/${priv}/secret:1`,
    action: "get",
    teamId: privTeam.id,
    sourcePath: `teams/${priv}/products/secret/product.yaml`,
  });
  // Only its own team sees this one.
  await upsertProduct({
    name: `${priv}-internal-run`,
    image: `registry.example/${priv}/internal:1`,
    action: "run",
    teamId: privTeam.id,
    hidden: true,
  });
  const hello = { id: "one", action: `${own}/hello.run`, inputs: { text: { $param: "text" }, fixed: 1 } };
  await upsertTemplate({
    teamId: ownTeam.id,
    name: "chain",
    displayName: "Chain",
    description: "Hello, then store it.",
    parameters,
    steps: [hello, { id: "two", action: `${db_}/store.put`, dependsOn: ["one"], inputs: { value: { $fromStep: "one", $output: "text" } } }],
    shareWith: ["*"],
    deprecated: null,
  });
  await upsertTemplate({
    teamId: ownTeam.id,
    name: "for-cons",
    displayName: "For cons",
    description: "",
    parameters,
    steps: [hello],
    shareWith: [cons],
    deprecated: null,
    examples: [{ name: "a greeting", inputs: { text: "hi" }, outputs: {} }],
  });
  await upsertTemplate({ teamId: ownTeam.id, name: "own-only", displayName: "Own only", description: "", parameters, steps: [hello], shareWith: [], deprecated: null, hidden: true });
  await upsertTemplate({
    teamId: ownTeam.id,
    name: "bad-share",
    displayName: "Bad share",
    description: "",
    parameters: { type: "object" },
    steps: [{ id: "x", action: `${priv}/secret.get` }],
    shareWith: ["*"],
    deprecated: null,
  });

  const outsider = await users.makeUser();
  const otherOutsider = await users.makeUser();
  const consumer = await users.makeUser();
  const ownMember = await users.makeUser();
  const dbMember = await users.makeUser();
  const privMember = await users.makeUser();
  await addTeamMember(privMember.id, privTeam.id, "member");
  await addTeamMember(consumer.id, consTeam.id);
  await addTeamMember(ownMember.id, ownTeam.id);
  await addTeamMember(dbMember.id, dbTeam.id);
  [outsiderToken, otherOutsiderToken, consumerToken, ownMemberToken, dbMemberToken, privMemberToken] = await Promise.all(
    [outsider, otherOutsider, consumer, ownMember, dbMember, privMember].map((u) => users.signIn(u.email)),
  );
});

beforeEach(() => {
  vi.mocked(submitExecution).mockClear();
  vi.mocked(cancelExecution).mockClear();
  vi.mocked(getExecution).mockClear();
});

afterAll(async () => {
  const ours = await db.select({ id: teams.id }).from(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(submittedExecutions).where(like(submittedExecutions.template, `${prefix}%`));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  if (ours.length > 0) await db.delete(teams).where(inArray(teams.id, ours.map((t) => t.id)));
  await users.cleanUp();
  await app.close();
});

type Runnables = {
  runnables?: {
    kind: string;
    team: string;
    name: string;
    onBehalfOf?: string[];
    onBehalfOfRequired?: boolean;
    shared?: boolean;
    sourceUrl?: string;
    askForAccessUrl?: string;
  }[];
};
const listed = async (token: string) =>
  ((await call<Runnables>(token, "TemplateService/ListTemplates")).body.runnables ?? []).filter((r) => r.team.startsWith(prefix));

describe("what a consumer may run", () => {
  it("offers an action's examples, from its passing tests", async () => {
    const listed = (await call<{ runnables?: { name: string; examples?: unknown[] }[] }>(outsiderToken, "TemplateService/ListTemplates")).body.runnables ?? [];
    const hello = (await call<{ runnables?: { name: string; examples?: unknown[] }[] }>(ownMemberToken, "TemplateService/ListTemplates")).body.runnables?.find((r) => r.name === `${own}-hello-run`);
    expect(hello?.examples).toEqual([{ name: "says hello", inputs: { text: "hi" }, outputs: { text: "HELLO" } }]);
    expect(listed.find((r) => r.name === "chain")?.examples ?? []).toEqual([]);
  });

  it("offers a template's own examples", async () => {
    const all = (await call<{ runnables?: { name: string; examples?: unknown[] }[] }>(ownMemberToken, "TemplateService/ListTemplates")).body.runnables ?? [];
    expect(all.find((r) => r.name === "for-cons")?.examples).toEqual([{ name: "a greeting", inputs: { text: "hi" }, outputs: {} }]);
  });

  it("lists templates shared with everyone, or with one of their teams, and actions shared with them", async () => {
    const outsider = await listed(outsiderToken);
    expect(outsider.filter((r) => r.shared).map((r) => `${r.kind}:${r.name}`).sort()).toEqual(["KIND_TEMPLATE:bad-share", "KIND_TEMPLATE:chain"]);

    const consumer = await listed(consumerToken);
    expect(consumer.find((r) => r.name === "for-cons")).toMatchObject({ onBehalfOf: [cons], onBehalfOfRequired: true });

    // A member of the owning team sees its actions too; the other team's only where shared.
    const member = await listed(ownMemberToken);
    expect(member.filter((r) => r.kind === "KIND_ACTION" && r.shared).map((r) => r.name).sort()).toEqual(
      [`${db_}-store-put`, `${own}-hello-run`].sort(),
    );
  });
});

describe("what isn't shared with someone", () => {
  it("is listed, not runnable, with where it's defined and an issue asking for it", async () => {
    const consumer = await listed(consumerToken);
    const theirs = consumer.find((r) => r.name === `${priv}-secret-get`);
    expect(theirs).toMatchObject({ shared: false, sourceUrl: `https://github.com/acme/vertra-catalog/blob/main/teams/${priv}/products/secret/product.yaml` });
    const ask = new URL(theirs?.askForAccessUrl ?? "");
    expect(`${ask.origin}${ask.pathname}`).toBe("https://github.com/acme/vertra-catalog/issues/new");
    expect(ask.searchParams.get("title")).toBe(`Share ${priv}/secret.get with ${cons}`);
    expect(ask.searchParams.get("body")).toContain(`shareWith: [${cons}]`);
    // Running it is still refused.
    const run = await call(consumerToken, "TemplateService/RunAction", { product: `${priv}-secret-get`, inputs: {} });
    expect(run.code).toBe("not_found");
  });

  it("has no link to ask with when its file or the catalog isn't known, nor when it's shared", async () => {
    const consumer = await listed(consumerToken);
    expect(consumer.find((r) => r.name === `${own}-hello-run`)).toMatchObject({ shared: false, askForAccessUrl: "" });
    expect(consumer.find((r) => r.name === "for-cons")).toMatchObject({ shared: true, askForAccessUrl: "" });
  });

  it("isn't even listed when hidden, except to its own team", async () => {
    const names = (rs: { name: string }[]) => rs.map((r) => r.name);
    expect(names(await listed(consumerToken))).not.toContain(`${priv}-internal-run`);
    expect(names(await listed(consumerToken))).not.toContain("own-only");
    expect(names(await listed(privMemberToken))).toContain(`${priv}-internal-run`);
    expect(names(await listed(ownMemberToken))).toContain("own-only");

    const productNames = async (token: string) =>
      ((await call<{ products?: { name: string }[] }>(token, "ProductService/ListProducts")).body.products ?? []).map((p) => p.name);
    expect(await productNames(consumerToken)).not.toContain(`${priv}-internal-run`);
    expect(await productNames(privMemberToken)).toContain(`${priv}-internal-run`);
  });
});

describe("running a template", () => {
  it("builds the DAG from its products: their images, identities, secrets and namespaces, never the caller's", async () => {
    const run = await call<{ executionId: string }>(outsiderToken, "TemplateService/RunTemplate", {
      team: own,
      name: "chain",
      parameters: { text: "hi" },
    });
    expect(run.code).toBe("ok");
    const [one, two] = forwarded().tasks;
    expect(one).toMatchObject({
      id: "one",
      team: own,
      action: "run",
      serviceAccount: "hello",
      secretRefs: ["hello-key"],
      inputs: { text: "hi", fixed: 1 },
    });
    // The product's image (pinned on the way when pinning is on; off here).
    expect(String(one?.["image"]).startsWith(`registry.example/${own}/hello:1`)).toBe(true);
    expect(two).toMatchObject({ id: "two", team: db_, serviceAccount: "store", dependsOn: ["one"], inputs: { value: { $fromTask: "one", $output: "text" } } });

    const [record] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, run.body.executionId));
    expect(record).toMatchObject({ template: `${own}/chain`, templateParameters: { text: "hi" }, onBehalfOf: null, teams: [own, db_] });
  });

  it("checks the parameters against the template's schema first", async () => {
    const refused = await call(outsiderToken, "TemplateService/RunTemplate", {
      team: own,
      name: "chain",
      parameters: { text: "far too long for it", extra: true },
    });
    expect(refused.code).toBe("invalid_argument");
    expect(refused.failure).toBe("INVALID_PARAMETERS");
    // Each problem on its field, as Problem details (the run form shows them there).
    expect(problemFields(refused.body as RpcError)).toEqual(expect.arrayContaining(["parameters.text", "parameters"]));
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("runs a template shared with specific teams on behalf of one of the caller's", async () => {
    expect((await call(outsiderToken, "TemplateService/RunTemplate", { team: own, name: "for-cons", parameters: { text: "hi" } })).code).toBe(
      "not_found",
    );
    // The consumer's only eligible team, unless they say otherwise.
    const run = await call<{ executionId: string }>(consumerToken, "TemplateService/RunTemplate", {
      team: own,
      name: "for-cons",
      parameters: { text: "hi" },
    });
    expect(run.code).toBe("ok");
    const [record] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, run.body.executionId));
    expect(record?.onBehalfOf).toBe(cons);
    expect(
      (await call(consumerToken, "TemplateService/RunTemplate", { team: own, name: "for-cons", parameters: { text: "hi" }, onBehalfOf: priv })).code,
    ).toBe("permission_denied");
  });

  it("refuses a step of another team's action that team doesn't share with the template's", async () => {
    const refused = await call(outsiderToken, "TemplateService/RunTemplate", { team: own, name: "bad-share", parameters: {} });
    expect(refused.code).toBe("permission_denied");
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("is still refused as a DAG submitted by someone not in its teams", async () => {
    const submitted = await call(outsiderToken, "ExecutionService/SubmitExecution", {
      dag: { name: "copy", tasks: [{ id: "one", image: `registry.example/${own}/hello:1`, action: "run", team: own, inputs: {} }] },
    });
    expect(submitted.code).toBe("permission_denied");
  });
});

describe("running an action on its own", () => {
  it("runs one shared with the caller's team, as a one-step template, and no other", async () => {
    expect((await call(outsiderToken, "TemplateService/RunAction", { product: `${own}-hello-run`, inputs: { text: "hi" } })).code).toBe(
      "not_found",
    );
    const run = await call<{ executionId: string }>(ownMemberToken, "TemplateService/RunAction", {
      product: `${db_}-store-put`,
      inputs: { value: "x" },
    });
    expect(run.code).toBe("ok");
    expect(forwarded().tasks).toEqual([expect.objectContaining({ id: "put", team: db_, serviceAccount: "store", inputs: { value: "x" } })]);
    const [record] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, run.body.executionId));
    expect(record?.template).toBe(`${db_}/store.put`);
  });
});

describe("a consumer's run", () => {
  it("is theirs and its steps' teams' to see, and theirs to cancel; nobody else's", async () => {
    const run = await call<{ executionId: string }>(outsiderToken, "TemplateService/RunTemplate", {
      team: own,
      name: "chain",
      parameters: { text: "mine" },
    });
    const executionId = run.body.executionId;
    const get = (token: string) => call<{ execution?: { template?: string } }>(token, "ExecutionService/GetExecution", { executionId });

    const seen = await get(outsiderToken);
    expect(seen.code).toBe("ok");
    expect(seen.body.execution?.template).toBe(`${own}/chain`);
    expect((await get(dbMemberToken)).code).toBe("ok");
    expect((await get(otherOutsiderToken)).code).toBe("permission_denied");

    const listedRuns = await call<{ executions?: { executionId: string }[] }>(outsiderToken, "ExecutionService/ListExecutions", {});
    expect(listedRuns.body.executions?.some((e) => e.executionId === executionId)).toBe(true);

    expect((await call(otherOutsiderToken, "ExecutionService/CancelExecution", { executionId })).code).toBe("permission_denied");
    expect((await call(outsiderToken, "ExecutionService/CancelExecution", { executionId })).code).toBe("ok");
    expect(cancelExecution).toHaveBeenCalledWith(executionId);
  });

  it("is retried only while its steps are still shared with the template's team (X2)", async () => {
    const run = await call<{ executionId: string }>(outsiderToken, "TemplateService/RunTemplate", {
      team: own,
      name: "chain",
      parameters: { text: "retry me" },
    });
    const retry = () => call<RpcError>(outsiderToken, "ExecutionService/RetryTask", { executionId: run.body.executionId, taskId: "two" });
    expect((await retry()).code).toBe("ok");

    const [store] = await db.select().from(products).where(eq(products.name, `${db_}-store-put`));
    const share = (shareWith: string[]) =>
      upsertProduct({ name: store?.name ?? "", image: store?.image ?? "", action: "put", teamId: store?.teamId ?? null, shareWith });
    await share([]);
    try {
      const refused = await retry();
      expect(refused.code).toBe("permission_denied");
      expect(refused.message).toContain(`doesn't share with team "${own}"`);
    } finally {
      await share([own]);
    }
  });

  it("is rerun as the template, with the same parameters", async () => {
    const run = await call<{ executionId: string }>(outsiderToken, "TemplateService/RunTemplate", {
      team: own,
      name: "chain",
      parameters: { text: "again" },
    });
    vi.mocked(submitExecution).mockClear();
    const rerun = await call<{ executionId: string }>(outsiderToken, "ExecutionService/RerunExecution", { executionId: run.body.executionId });
    expect(rerun.code).toBe("ok");
    expect(forwarded().tasks[0]).toMatchObject({ team: own, inputs: { text: "again", fixed: 1 } });
    const [record] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, rerun.body.executionId));
    expect(record?.template).toBe(`${own}/chain`);
  });
});

describe("an ordering bot (decision 23)", () => {
  it("orders only its listed templates, for its own team, and nothing else", async () => {
    const shop = `${prefix}-shop`;
    const shopTeam = await createTeam(shop);
    const maintainer = await users.makeUser();
    const member = await users.makeUser();
    await addTeamMember(maintainer.id, shopTeam.id, "maintainer");
    await addTeamMember(member.id, shopTeam.id, "member");
    const [maintainerToken, memberToken] = await Promise.all([maintainer, member].map((u) => users.signIn(u.email)));
    const ownTeam = (await db.select().from(teams).where(eq(teams.name, own)))[0];
    await upsertTemplate({ teamId: ownTeam!.id, name: "second", displayName: "Second", description: "", parameters, steps: [{ id: "one", action: `${own}/hello.run`, inputs: { text: { $param: "text" } } }], shareWith: ["*"], deprecated: null });

    const botEmail = `${prefix}-orders@bot.example.com`;
    const made = await call<{ token: string }>(maintainerToken, "TokenService/CreateBotToken", {
      team: shop, email: botEmail, label: "storefront", ordering: true, orderTemplates: [`${own}/chain`],
    });
    expect(made.code).toBe("ok");
    const bot = made.body.token;

    const order = (name: string) => call(bot, "TemplateService/RunTemplate", { team: own, name, parameters: { text: "hi" }, onBehalfOf: shop });
    expect((await order("chain")).code).toBe("ok");
    expect((await order("second")).failure).toBe("TEMPLATE_NOT_ORDERABLE");
    expect((await call(bot, "TemplateService/RunAction", { product: `${own}-hello-run`, inputs: { text: "hi" } })).failure).toBe("ORDERS_ONLY");
    expect((await call(bot, "ExecutionService/SubmitExecution", { dag: { name: "raw", tasks: [{ id: "a", image: "registry.example/x:1", action: "run", team: shop }] } })).failure).toBe("ORDERS_ONLY");

    // Its team's maintainers list what it may order; a member may not.
    expect((await call(memberToken, "TokenService/SetBotOrders", { team: shop, email: botEmail, templates: [`${own}/second`] })).code).toBe("permission_denied");
    expect((await call(maintainerToken, "TokenService/SetBotOrders", { team: shop, email: botEmail, templates: [`${own}/chain`, `${own}/second`] })).code).toBe("ok");
    expect((await order("second")).code).toBe("ok");
    const listed = await call<{ bots: { email: string; ordering: boolean; orderTemplates: string[] }[] }>(maintainerToken, "TokenService/ListBots", { team: shop });
    expect(listed.body.bots.find((b) => b.email === botEmail)).toMatchObject({ ordering: true, orderTemplates: [`${own}/chain`, `${own}/second`] });

    // A pipeline's bot stays one: no ordering bot from it.
    const pipeline = `${prefix}-ci@bot.example.com`;
    expect((await call(maintainerToken, "TokenService/CreateBotToken", { team: shop, email: pipeline, label: "ci" })).code).toBe("ok");
    expect((await call(maintainerToken, "TokenService/CreateBotToken", { team: shop, email: pipeline, label: "x", ordering: true })).code).toBe("already_exists");
    expect((await call(maintainerToken, "TokenService/SetBotOrders", { team: shop, email: pipeline, templates: [] })).failure).toBe("NOT_ORDERING");
  });

  it("is held to its rate: past it, 429 with Retry-After", async () => {
    const shop = `${prefix}-rated`;
    const shopTeam = await createTeam(shop);
    const maintainer = await users.makeUser();
    await addTeamMember(maintainer.id, shopTeam.id, "maintainer");
    const made = await call<{ token: string }>(await users.signIn(maintainer.email), "TokenService/CreateBotToken", {
      team: shop, email: `${prefix}-rated@bot.example.com`, label: "storefront", ordering: true, orderTemplates: [`${own}/chain`],
    });
    const bot = made.body.token;
    const order = (requestId: string) =>
      app.inject({
        method: "POST",
        url: "/api/vertra.console.v1.TemplateService/RunTemplate",
        headers: { "content-type": "application/json", authorization: `Bearer ${bot}` },
        payload: JSON.stringify({ team: own, name: "chain", parameters: { text: "hi" }, onBehalfOf: shop, requestId }),
      });
    const rate = config.orders.ratePerMinute;
    config.orders.ratePerMinute = 2;
    try {
      expect((await order("one")).statusCode).toBe(200);
      expect((await order("two")).statusCode).toBe(200);
      const refused = await order("three");
      expect(refused.statusCode).toBe(429);
      expect(refused.json<RpcError>().code).toBe("resource_exhausted");
      expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60);
      // A person isn't held to it.
      expect((await call(ownMemberToken, "TemplateService/RunTemplate", { team: own, name: "chain", parameters: { text: "hi" } })).code).toBe("ok");
    } finally {
      config.orders.ratePerMinute = rate;
    }
  });

  it("hears back: its order's outcome is posted to its callback, signed", async () => {
    const shop = `${prefix}-store`;
    const shopTeam = await createTeam(shop);
    const maintainer = await users.makeUser();
    await addTeamMember(maintainer.id, shopTeam.id, "maintainer");
    const maintainerToken = await users.signIn(maintainer.email);
    const botEmail = `${prefix}-store@bot.example.com`;
    const made = await call<{ token: string }>(maintainerToken, "TokenService/CreateBotToken", {
      team: shop, email: botEmail, label: "storefront", ordering: true, orderTemplates: [`${own}/chain`],
    });
    const setCallback = (body: Record<string, unknown>) =>
      call<{ host: string; signingSecret?: string }>(maintainerToken, "TokenService/SetBotCallback", { team: shop, email: botEmail, ...body });

    // Only under the install's allowed hosts: none, by default.
    const hosts = config.orders.callbackHosts;
    expect((await setCallback({ url: "https://orders.example.com/vertra" })).failure).toBe("BAD_CALLBACK");
    config.orders.callbackHosts = ["orders.example.com"];
    try {
      expect((await setCallback({ url: "https://elsewhere.example.com/vertra" })).failure).toBe("BAD_CALLBACK");
      const set = await setCallback({ url: "https://orders.example.com/vertra" });
      expect(set.body.host).toBe("orders.example.com");
      const secret = set.body.signingSecret ?? "";
      expect(secret).toMatch(/^vcs_/);
      // Changing the URL keeps the secret, and doesn't show it again.
      expect((await setCallback({ url: "https://orders.example.com/v2" })).body.signingSecret ?? "").toBe("");
      const listed = await call<{ bots: { email: string; callbackHost: string }[] }>(maintainerToken, "TokenService/ListBots", { team: shop });
      expect(listed.body.bots.find((b) => b.email === botEmail)?.callbackHost).toBe("orders.example.com");

      const ordered = await call<{ executionId: string }>(made.body.token, "TemplateService/RunTemplate", {
        team: own, name: "chain", parameters: { text: "hi" }, onBehalfOf: shop, requestId: "order-1042",
      });
      expect(ordered.code).toBe("ok");
      const [run] = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, ordered.body.executionId));
      const posted: { url: string; body: string; signature: string }[] = [];
      vi.stubGlobal("fetch", vi.fn((url: string, init: { body: string; headers: Record<string, string> }) => {
        posted.push({ url, body: init.body, signature: init.headers["vertra-signature"] ?? "" });
        return Promise.resolve(new Response("ok"));
      }));
      const finished = { ...run!, state: "SUCCEEDED", finishedAt: new Date().toISOString(), tasks: [] };
      await runFinishedCallbacks(finished);
      await runFinishedCallbacks(finished);
      expect(await db.select().from(callbackDeliveries).where(like(callbackDeliveries.key, `${ordered.body.executionId}:%`))).toHaveLength(1);
      await deliverCallbacks({ warn: vi.fn() } as never);
      const post = posted.find((p) => p.body.includes(ordered.body.executionId));
      expect(post?.url).toBe("https://orders.example.com/v2");
      expect(JSON.parse(post!.body)).toMatchObject({ type: "order.finished", requestId: "order-1042", template: `${own}/chain`, onBehalfOf: shop, state: "SUCCEEDED" });
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(post!.signature) ?? [];
      expect(v1).toBe(createHmac("sha256", secret).update(`${t ?? ""}.${post!.body}`).digest("hex"));

      // Rotated: a new secret; removed: no callback.
      const rotated = await setCallback({ url: "https://orders.example.com/v2", rotateSecret: true });
      expect(rotated.body.signingSecret).toMatch(/^vcs_/);
      expect(rotated.body.signingSecret).not.toBe(secret);
      expect((await setCallback({ url: "" })).code).toBe("ok");
      const [bot] = await db.select({ id: submittedExecutions.submittedBy }).from(submittedExecutions).where(eq(submittedExecutions.executionId, ordered.body.executionId));
      expect(await db.select().from(botCallbacks).where(eq(botCallbacks.botId, bot!.id!))).toEqual([]);
    } finally {
      config.orders.callbackHosts = hosts;
      vi.unstubAllGlobals();
    }
  });
});

describe("a team's outcome webhook (decision 23)", () => {
  it("posts each of its runs' outcomes, with its steps' outputs, signed; set by its maintainers", async () => {
    const team = `${prefix}-systems`;
    const made = await createTeam(team);
    const maintainer = await users.makeUser();
    const member = await users.makeUser();
    await addTeamMember(maintainer.id, made.id, "maintainer");
    await addTeamMember(member.id, made.id, "member");
    const [maintainerToken, memberToken] = await Promise.all([maintainer, member].map((u) => users.signIn(u.email)));
    const set = (token: string, body: Record<string, unknown>) =>
      call<{ callback: { host: string; configured: boolean }; signingSecret?: string }>(token, "NotificationService/SetTeamCallback", { team, ...body });

    const hosts = config.orders.callbackHosts;
    config.orders.callbackHosts = ["*.example.com"];
    try {
      expect((await set(memberToken, { url: "https://hooks.example.com/runs" })).code).toBe("permission_denied");
      expect((await set(maintainerToken, { url: "http://hooks.example.com/runs" })).failure).toBe("BAD_CALLBACK");
      const saved = await set(maintainerToken, { url: "https://hooks.example.com/runs" });
      expect(saved.body.callback).toMatchObject({ configured: true, host: "hooks.example.com" });
      const secret = saved.body.signingSecret ?? "";
      expect(secret).toMatch(/^vcs_/);
      // Its members see it, never its URL.
      const seen = await call<{ callback: Record<string, unknown> }>(memberToken, "NotificationService/GetTeamCallback", { team });
      expect(seen.body.callback).toMatchObject({ configured: true, host: "hooks.example.com" });
      expect(JSON.stringify(seen.body)).not.toContain("/runs");

      const posted: { url: string; body: string; signature: string }[] = [];
      vi.stubGlobal("fetch", vi.fn((url: string, init: { body: string; headers: Record<string, string> }) => {
        posted.push({ url, body: init.body, signature: init.headers["vertra-signature"] ?? "" });
        return Promise.resolve(new Response("ok"));
      }));
      const executionId = randomUUID();
      const tasks = [
        { taskId: "make", state: "SUCCEEDED", outputs: { url: "https://app.example.com" }, failure: null },
        { taskId: "check", state: "FAILED", outputs: null, failure: { code: "CHECK_FAILED", message: "not ready" } },
      ] as never[];
      const run = { executionId, name: "deploy", submittedBy: maintainer.id, teams: [team], template: null, onBehalfOf: null, payload: { requestId: "r-1" }, state: "FAILED", finishedAt: new Date().toISOString(), tasks };
      await runFinishedCallbacks(run);
      // Another team's run isn't posted to it.
      await runFinishedCallbacks({ ...run, executionId: randomUUID(), teams: [`${prefix}-elsewhere`] });
      await deliverCallbacks({ warn: vi.fn() } as never);
      const mine = posted.filter((p) => p.url === "https://hooks.example.com/runs");
      expect(mine).toHaveLength(1);
      expect(JSON.parse(mine[0]!.body)).toEqual({
        type: "run.finished", executionId, requestId: "r-1", template: null, name: "deploy", team, state: "FAILED", finishedAt: run.finishedAt,
        steps: [
          { taskId: "make", state: "SUCCEEDED", outputs: { url: "https://app.example.com" }, failureCode: null },
          { taskId: "check", state: "FAILED", outputs: null, failureCode: "CHECK_FAILED" },
        ],
      });
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(mine[0]!.signature) ?? [];
      expect(v1).toBe(createHmac("sha256", secret).update(`${t ?? ""}.${mine[0]!.body}`).digest("hex"));

      // Two consoles' passes at once: posted once, by one of them.
      const overlap = randomUUID();
      await runFinishedCallbacks({ ...run, executionId: overlap });
      vi.stubGlobal("fetch", vi.fn((url: string, init: { body: string; headers: Record<string, string> }) => new Promise<Response>((resolve) => {
        // Slow enough that the second pass starts while the first is posting.
        setTimeout(() => {
          posted.push({ url, body: init.body, signature: init.headers["vertra-signature"] ?? "" });
          resolve(new Response("ok"));
        }, 200);
      })));
      const counts = await Promise.all([deliverCallbacks({ warn: vi.fn() } as never), deliverCallbacks({ warn: vi.fn() } as never)]);
      expect(counts.filter((n) => n === 0)).toHaveLength(1);
      await deliverCallbacks({ warn: vi.fn() } as never);
      expect(posted.filter((p) => p.body.includes(overlap))).toHaveLength(1);

      // Too big with its outputs: posted without them, and says so.
      const big = randomUUID();
      await runFinishedCallbacks({ ...run, executionId: big, tasks: [{ taskId: "make", state: "SUCCEEDED", outputs: { blob: "x".repeat(300_000) }, failure: null }] as never[] });
      const [row] = await db.select().from(callbackDeliveries).where(like(callbackDeliveries.key, `${big}:%`));
      expect(JSON.parse(row!.body)).toMatchObject({ outputsOmitted: true, steps: [{ taskId: "make", outputs: null }] });

      // Removed: what's still waiting isn't posted.
      expect((await set(maintainerToken, { url: "" })).body.callback.configured).toBe(false);
      posted.length = 0;
      await deliverCallbacks({ warn: vi.fn() } as never);
      expect(posted.filter((p) => p.body.includes(big))).toEqual([]);
    } finally {
      config.orders.callbackHosts = hosts;
      vi.unstubAllGlobals();
    }
  });
});
