// SPDX-License-Identifier: MIT
/**
 * Approvals: which steps wait for one (product.yaml's approval, a target
 * allowedTargets lets through only with one), and who may decide: a
 * maintainer of the step's team, never whoever submitted the run.
 */
import { config } from "../src/config.js";
import { randomUUID } from "node:crypto";
import { arrayOverlaps, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createApiToken, createTeam, upsertProduct } from "../src/db/queries.js";
import { generateApiToken, hashApiToken } from "../src/auth/apiToken.js";
import { notDeciders } from "../src/core/approvals.js";
import { apiTokens, products, schedules, submittedExecutions, teamMemberships, teams, users as usersTable } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { decideApproval, getExecution, listAwaitingApproval, submitExecution, type KernelExecution } from "../src/kernel/client.js";
import { targetsNeedApproval } from "../src/targets.js";
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
    Promise.resolve({ pinned: new Map(images.map((i) => [i, i.includes("@") ? i : `${i}@sha256:${"c".repeat(64)}`])), unresolved: [] }),
  ),
}));
vi.mock("../src/kernel/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/client.js")>();
  const { randomUUID: uuid } = await import("node:crypto");
  return {
    ...actual,
    submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })),
    getExecution: vi.fn(),
    decideApproval: vi.fn((executionId: string) => Promise.resolve({ executionId, state: "RUNNING" })),
    listAwaitingApproval: vi.fn(() => Promise.resolve([])),
  };
});
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "registry.example/", additional: [], version: "1" })),
}));

const prefix = `apr-${randomUUID().slice(0, 6)}`;
const owner = `${prefix}-owner`;
const apps = `${prefix}-apps`;
/** Waits when another team runs it; always waits; waits only for some targets. */
const deploy = `${owner}-deploy-run`;
const wipe = `${owner}-wipe-run`;
const project = `${owner}-project-create`;

let app: FastifyInstance;
const call = caller(() => app);
const users = rpcClient(() => app);
const tokens: Record<"maintainer" | "maintainer2" | "member" | "apps", string> = { maintainer: "", maintainer2: "", member: "", apps: "" };
const ids: Record<string, string> = {};

const inputSchema = {
  type: "object",
  properties: { projectId: { type: "string", "x-vennir-needs": "gcp.project" } },
};

beforeAll(async () => {
  // A product's identity is its released digests', so its images are
  // pinned (each tag, by the mock above, to one digest).
  config.imagePinning = "required";
  app = await buildApp();
  const [ownerTeam, appsTeam] = [await createTeam(owner), await createTeam(apps)];
  await db
    .update(teams)
    .set({
      allowedTargets: [
        { teams: [apps], targets: { "gcp.project": [`${apps}-*`] } },
        { teams: [apps], targets: { "gcp.project": ["prod-*"] }, approval: true },
      ],
    })
    .where(eq(teams.id, ownerTeam.id));
  for (const [name, action, approval] of [
    [deploy, "run", "otherTeams"],
    [wipe, "run", "always"],
    [project, "create", null],
  ] as const) {
    await upsertProduct({
      name,
      image: `registry.example/${owner}/${name}:1@sha256:${"c".repeat(64)}`,
      action,
      teamId: ownerTeam.id,
      inputSchema,
      shareWith: ["*"],
      approval,
    });
  }
  const made = { maintainer: await users.makeUser(), maintainer2: await users.makeUser(), member: await users.makeUser(), apps: await users.makeUser() };
  await addTeamMember(made.maintainer.id, ownerTeam.id, "maintainer");
  await addTeamMember(made.maintainer2.id, ownerTeam.id, "maintainer");
  await addTeamMember(made.member.id, ownerTeam.id, "member");
  await addTeamMember(made.apps.id, appsTeam.id, "member");
  for (const [who, user] of Object.entries(made)) {
    tokens[who as keyof typeof tokens] = await users.signIn(user.email);
    ids[who] = user.id;
  }
});

afterAll(async () => {
  config.imagePinning = "off";
  await db.delete(submittedExecutions).where(arrayOverlaps(submittedExecutions.teams, [owner, apps]));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  const ours = await db.select({ id: teams.id }).from(teams).where(like(teams.name, `${prefix}%`));
  if (ours.length > 0) await db.delete(teams).where(inArray(teams.id, ours.map((t) => t.id)));
  await db.delete(usersTable).where(like(usersTable.email, `${prefix}-ci-%@bots.vennir.local`));
  await users.cleanUp();
  await app.close();
});

beforeEach(() => {
  vi.mocked(submitExecution).mockClear();
  vi.mocked(decideApproval).mockClear();
});

/** Runs an action as `who`; its execution id and whether its step waits for an approval. */
async function run(who: keyof typeof tokens, product: string, projectId = `${apps}-dev`) {
  const result = await call<{ executionId: string }>(tokens[who], "TemplateService/RunAction", { product, inputs: { projectId } });
  expect(result.code).toBe("ok");
  const submitted = vi.mocked(submitExecution).mock.lastCall?.[0] as { tasks: { approvalRequired?: boolean }[] };
  return { executionId: result.body.executionId, waits: submitted.tasks[0]?.approvalRequired === true };
}

function awaiting(executionId: string, state = "AWAITING_APPROVAL"): KernelExecution {
  return {
    executionId,
    name: "x",
    state: "RUNNING",
    tasks: [
      {
        taskId: "run",
        state,
        attemptCount: 0,
        outputs: null,
        failure: null,
        dependsOn: [],
        startedAt: null,
        completedAt: null,
        attempts: [],
        approvalRequired: true,
        approvedBy: "",
        approvedAt: null,
        awaitingSince: new Date().toISOString(),
      },
    ],
  };
}

describe("which steps wait for an approval", () => {
  it("otherTeams: another team's run waits, the owning team's doesn't", async () => {
    expect((await run("apps", deploy)).waits).toBe(true);
    expect((await run("member", deploy)).waits).toBe(false);
  });

  it("a list of teams: their runs wait, another consumer's and the owning team's don't", async () => {
    const [ownerTeam] = await db.select().from(teams).where(eq(teams.name, owner));
    const audit = `${owner}-audit-run`;
    await upsertProduct({
      name: audit,
      image: `registry.example/${owner}/${audit}:1@sha256:${"c".repeat(64)}`,
      action: "run",
      teamId: ownerTeam!.id,
      // No target in it: only the approval decides.
      inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
      shareWith: ["*"],
      approvalTeams: [apps],
    });
    const web = await createTeam(`${prefix}-web`);
    const webUser = await users.makeUser();
    await addTeamMember(webUser.id, web.id, "member");
    const webToken = await users.signIn(webUser.email);
    expect((await run("apps", audit)).waits).toBe(true);
    expect((await run("member", audit)).waits).toBe(false);
    const result = await call<{ executionId: string }>(webToken, "TemplateService/RunAction", { product: audit, inputs: { projectId: `${apps}-dev` } });
    expect(result.code).toBe("ok");
    const submitted = vi.mocked(submitExecution).mock.lastCall?.[0] as { tasks: { approvalRequired?: boolean }[] };
    expect(submitted.tasks[0]?.approvalRequired === true).toBe(false);
  });

  it("always: every run waits, the owning team's too", async () => {
    expect((await run("member", wipe)).waits).toBe(true);
  });

  it("another image of a product's repository, not a release, is still held to its approval", async () => {
    vi.mocked(submitExecution).mockClear();
    const image = `registry.example/${owner}/${wipe}:2@sha256:${"e".repeat(64)}`;
    const result = await call(tokens.maintainer, "ExecutionService/SubmitExecution", {
      dag: { name: "unreleased", tasks: [{ id: "t", image, action: "run", team: owner, inputs: { projectId: `${apps}-dev` } }] },
    });
    expect(result.code).toBe("ok");
    const submitted = vi.mocked(submitExecution).mock.lastCall?.[0] as { tasks: { approvalRequired?: boolean; serviceAccount?: string }[] };
    expect(submitted.tasks[0]?.approvalRequired).toBe(true);
  });

  it("a target a rule lets through only with an approval waits; one another rule allows doesn't", async () => {
    expect((await run("apps", project, `${apps}-dev`)).waits).toBe(false);
    expect((await run("apps", project, "prod-eu")).waits).toBe(true);
    expect((await run("member", project, "prod-eu")).waits).toBe(false);
  });

  it("matches rules as targets.ts does", () => {
    const rules = [
      { teams: ["web"], targets: { "gcp.project": ["web-*"] } },
      { teams: ["*"], targets: { "gcp.project": ["web-prod", "shared-*"] }, approval: true },
    ];
    expect(targetsNeedApproval({ allowedTargets: rules }, inputSchema, { projectId: "web-prod" }, ["web"])).toBe(false);
    expect(targetsNeedApproval({ allowedTargets: rules }, inputSchema, { projectId: "shared-1" }, ["web"])).toBe(true);
    expect(targetsNeedApproval({ allowedTargets: rules }, inputSchema, { projectId: { $fromTask: "a", $output: "b" } }, ["web"])).toBe(false);
  });
});

describe("deciding", () => {
  const decide = (who: keyof typeof tokens, executionId: string, approve = true) =>
    call(tokens[who], "ExecutionService/DecideApproval", { executionId, taskId: "run", approve, reason: "not now" });

  it("is a maintainer of the step's team's, who didn't submit the run", async () => {
    const { executionId } = await run("apps", deploy);
    vi.mocked(getExecution).mockResolvedValue(awaiting(executionId));
    expect((await decide("apps", executionId)).code).toBe("permission_denied");
    expect((await decide("member", executionId)).code).toBe("permission_denied");
    expect((await decide("maintainer", executionId)).code).toBe("ok");
    expect(decideApproval).toHaveBeenCalledWith(executionId, "run", true, `user:${ids["maintainer"] ?? ""}`, "");
  });

  it("never the maintainer who submitted it", async () => {
    const { executionId } = await run("maintainer", wipe);
    vi.mocked(getExecution).mockResolvedValue(awaiting(executionId));
    const refused = await decide("maintainer", executionId);
    expect(refused.code).toBe("permission_denied");
    expect(refused.message).toContain("another maintainer");
    expect((await decide("maintainer2", executionId, false)).code).toBe("ok");
    expect(decideApproval).toHaveBeenCalledWith(executionId, "run", false, `user:${ids["maintainer2"] ?? ""}`, "not now");
  });

  it("never the maintainer who made the bot that submitted it", async () => {
    const email = `${prefix}-ci-${randomUUID().slice(0, 6)}@bots.vennir.local`;
    const minted = await call<{ token: string }>(tokens["maintainer"], "TokenService/CreateBotToken", { team: owner, email, label: "ci" });
    expect(minted.code).toBe("ok");
    const asBot = await call<{ executionId: string }>(minted.body.token, "TemplateService/RunAction", { product: wipe, inputs: { projectId: `${apps}-dev` } });
    expect(asBot.code).toBe("ok");
    const executionId = asBot.body.executionId;
    vi.mocked(getExecution).mockResolvedValue(awaiting(executionId));

    const refused = await decide("maintainer", executionId);
    expect(refused.code).toBe("permission_denied");
    expect(refused.message).toContain("another maintainer");
    type Detail = { execution: { tasks: { approval?: { canDecide?: boolean } }[] } };
    const canDecide = async (who: keyof typeof tokens) =>
      (await call<Detail>(tokens[who], "ExecutionService/GetExecution", { executionId })).body.execution.tasks[0]?.approval?.canDecide ?? false;
    expect(await canDecide("maintainer")).toBe(false);
    expect(await canDecide("maintainer2")).toBe(true);

    // Kept with the run: the token gone afterwards changes nothing.
    await db.delete(apiTokens).where(eq(apiTokens.createdBy, ids["maintainer"] ?? ""));
    expect((await decide("maintainer", executionId)).code).toBe("permission_denied");
    expect((await decide("maintainer2", executionId)).code).toBe("ok");
  });

  it("never a bot, even a maintainer's", async () => {
    const { executionId } = await run("maintainer", wipe);
    vi.mocked(getExecution).mockResolvedValue(awaiting(executionId));
    const email = `${prefix}-ci-${randomUUID().slice(0, 6)}@bots.vennir.local`;
    const minted = await call<{ token: string }>(tokens["maintainer2"], "TokenService/CreateBotToken", { team: owner, email, label: "approver" });
    const refused = await call(minted.body.token, "ExecutionService/DecideApproval", { executionId, taskId: "run", approve: true, reason: "" });
    expect(refused.code).toBe("permission_denied");
    expect(refused.message).toContain("not a bot");
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("never whoever made or changed a schedule its bot runs, nor a bot's maker's bot's maker", async () => {
    const [ownerTeam] = await db.select({ id: teams.id }).from(teams).where(eq(teams.name, owner));
    const bot = async () => {
      const email = `${prefix}-ci-${randomUUID().slice(0, 6)}@bots.vennir.local`;
      const [user] = await db.insert(usersTable).values({ email, isBot: true }).returning();
      await db.insert(teamMemberships).values({ userId: user!.id, teamId: ownerTeam!.id, role: "maintainer" });
      return user!.id;
    };
    const scheduled = await bot();
    await db.insert(schedules).values({
      teamId: ownerTeam!.id, name: `${prefix}-nightly`, kind: "action", runnableTeam: owner, runnableName: wipe, cron: "0 3 * * *",
      botId: scheduled, enabled: false, createdBy: ids["maintainer"] ?? null, updatedBy: ids["maintainer2"] ?? null,
    });
    expect((await notDeciders(scheduled)).sort()).toEqual([scheduled, ids["maintainer"], ids["maintainer2"]].sort());

    // Bot X, made by the maintainer, made bot Y a token: Y's runs aren't the maintainer's to approve either.
    const x = await bot();
    const y = await bot();
    await createApiToken(x, "x", hashApiToken(generateApiToken()), [], null, ids["maintainer"] ?? null);
    await createApiToken(y, "y", hashApiToken(generateApiToken()), [], null, x);
    expect((await notDeciders(y)).sort()).toEqual([y, x, ids["maintainer"]].sort());
  });

  it("only a step awaiting approval", async () => {
    const { executionId } = await run("apps", deploy);
    vi.mocked(getExecution).mockResolvedValue(awaiting(executionId, "READY"));
    expect((await decide("maintainer", executionId)).code).toBe("failed_precondition");
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("is offered on the run's page to whoever may decide", async () => {
    const { executionId } = await run("apps", deploy);
    vi.mocked(getExecution).mockResolvedValue(awaiting(executionId));
    type Detail = { execution: { tasks: { approval?: { canDecide?: boolean } }[] } };
    const canDecide = async (who: keyof typeof tokens) =>
      (await call<Detail>(tokens[who], "ExecutionService/GetExecution", { executionId })).body.execution.tasks[0]?.approval?.canDecide ?? false;
    expect(await canDecide("maintainer")).toBe(true);
    expect(await canDecide("member")).toBe(false);
    expect(await canDecide("apps")).toBe(false);
  });
});

describe("pending approvals", () => {
  it("lists the teams the caller maintains, and says which they may decide", async () => {
    vi.mocked(listAwaitingApproval).mockResolvedValue([
      { executionId: randomUUID(), executionName: "a", taskId: "run", team: owner, image: "i", action: "run", requestedBy: `user:${ids["apps"] ?? ""}`, awaitingSince: null },
      { executionId: randomUUID(), executionName: "b", taskId: "run", team: owner, image: "i", action: "run", requestedBy: `user:${ids["maintainer"] ?? ""}`, awaitingSince: null },
    ]);
    type Listed = { approvals?: { executionName: string; canDecide?: boolean; requestedBy: string }[] };
    const listed = await call<Listed>(tokens["maintainer"], "ExecutionService/ListPendingApprovals");
    expect(listed.code).toBe("ok");
    expect(vi.mocked(listAwaitingApproval).mock.lastCall?.[0]).toEqual([owner]);
    expect((listed.body.approvals ?? []).map((a) => [a.executionName, a.canDecide ?? false])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(listed.body.approvals?.[0]?.requestedBy).toContain("@example.com");
    await call(tokens["member"], "ExecutionService/ListPendingApprovals");
    expect(vi.mocked(listAwaitingApproval).mock.lastCall?.[0]).toEqual([]);
  });
});
