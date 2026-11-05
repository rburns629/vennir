// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import {
  addTeamMember,
  createTeam,
  createUser,
  recordSecretGrant,
  recordSubmittedExecution,
  setUserAdmin,
} from "../src/db/queries.js";
import { botIdentities, secretGrants, submittedExecutions, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { getExecutionStates, retryTask, submitExecution } from "../src/kernel/client.js";
import { caller } from "./rpc.js";

// Only kernel-api is stubbed. `kernelStates` is what it reports for each
// execution id; submitExecution and retryTask just accept.
const kernelStates = new Map<string, string>();
vi.mock("../src/kernel/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/client.js")>();
  const { randomUUID: uuid } = await import("node:crypto");
  return {
    ...actual,
    submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })),
    retryTask: vi.fn((executionId: string) => Promise.resolve({ executionId, state: "RUNNING" })),
    getExecution: vi.fn((executionId: string) =>
      Promise.resolve({ executionId, name: "history", state: "FAILED", tasks: [] }),
    ),
    getExecutionStates: vi.fn((ids: string[]) =>
      Promise.resolve(
        ids.filter((id) => kernelStates.has(id)).map((id) => ({ executionId: id, state: kernelStates.get(id) })),
      ),
    ),
  };
});

// The image policy lives in a ConfigMap on a real cluster; here it allows
// everything these tests submit (their images are Docker Hub shorthands).
vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() =>
    Promise.resolve({ exists: true, source: "docker.io/", additional: [], version: "1" }),
  ),
  readImagePolicyForDisplay: vi.fn(() =>
    Promise.resolve({ exists: true, source: "docker.io/", additional: [], version: "1" }),
  ),
}));

const prefix = `life-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;

async function newUser(options: { admin?: boolean } = {}): Promise<{ id: string; token: string }> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (options.admin) await setUserAdmin(user.id, true);
  return { id: user.id, token: app.jwt.sign({ userId: user.id }) };
}

const call = caller(() => app);

async function mint(scopes: string[]): Promise<string> {
  return (await call<{ token: string }>(admin, "TokenService/CreateAutomationToken", { label: prefix, scopes })).body.token;
}

function product(team: string, suffix: string, image: string) {
  return { name: `${team}-${suffix}`, image, action: "create", team };
}

/** A team with one human member, one team bot, a registered product, a
 * secret grant and one finished execution in its history. */
async function populatedTeam() {
  const name = `${prefix}-${randomUUID().slice(0, 6)}`;
  const team = await createTeam(name);
  const member = await newUser();
  await addTeamMember(member.id, team.id);
  const bot = await call<{ token: string }>(member.token, "TokenService/CreateBotToken", {
    team: name,
    email: `${name}-bot@bot.internal`,
    label: "team ci",
  });
  emails.push(`${name}-bot@bot.internal`);
  await call(admin, "ProductService/RegisterProduct", product(name, "p", `example/${name}:1`));
  await recordSecretGrant({ teamId: team.id, secretName: "s", keys: ["value"], source: "literal" });
  const executionId = randomUUID();
  await recordSubmittedExecution({
    executionId,
    teams: [name],
    submittedBy: member.id,
    name: "history",
    payload: {},
  });
  kernelStates.set(executionId, "SUCCEEDED");
  return { name, teamId: team.id, member, botToken: bot.body.token, executionId };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  admin = (await newUser({ admin: true })).token;
});

beforeEach(() => {
  vi.mocked(getExecutionStates).mockClear();
  vi.mocked(submitExecution).mockClear();
  vi.mocked(retryTask).mockClear();
});

afterAll(async () => {
  await app.close();
  await db.delete(submittedExecutions).where(eq(submittedExecutions.name, "history"));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
});

describe("retire", () => {
  it("needs admin or teams:retire, and unregisters the team's products", async () => {
    const t = await populatedTeam();
    expect((await call(t.member.token, "TeamService/RetireTeam", { name: t.name })).code).toBe("permission_denied");

    const retired = await call<{ unregisteredProducts: number }>(await mint(["teams:retire"]), "TeamService/RetireTeam", {
      name: t.name,
    });
    expect(retired.code).toBe("ok");
    expect(retired.body.unregisteredProducts).toBe(1);
    // Idempotent.
    expect((await call(admin, "TeamService/RetireTeam", { name: t.name })).code).toBe("ok");
  });

  it("makes the team read-only until it's un-retired", async () => {
    const t = await populatedTeam();
    await call(admin, "TeamService/RetireTeam", { name: t.name });

    const writes = [
      call(admin, "ProductService/RegisterProduct", product(t.name, "p2", "example/x:2")),
      call(t.member.token, "TokenService/CreateBotToken", { team: t.name, email: `${t.name}-b2@bot.internal`, label: "x" }),
      call(t.member.token, "SecretService/PutSecret", { team: t.name, secretName: "s2", data: { value: "v" } }),
      call(t.member.token, "ExecutionService/SubmitExecution", {
        dag: {
          name: "x",
          requestId: `x-${randomUUID()}`,
          tasks: [{ id: "t", image: "i", action: "a", team: t.name, serviceAccount: "default" }],
        },
      }),
    ];
    for (const outcome of await Promise.all(writes)) {
      expect(outcome.code).toBe("failed_precondition");
      expect(outcome.failure).toBe("TEAM_RETIRED");
    }
    // History stays readable for members.
    expect((await call(t.member.token, "TeamService/ListMembers", { team: t.name })).code).toBe("ok");

    expect((await call(admin, "TeamService/UnretireTeam", { name: t.name })).code).toBe("ok");
    expect((await call(admin, "ProductService/RegisterProduct", product(t.name, "p3", "example/x:3"))).code).toBe("ok");
  });
});

describe("purge", () => {
  it("refuses a team that isn't retired", async () => {
    const t = await populatedTeam();
    const purge = await call(admin, "TeamService/PurgeTeam", { name: t.name });
    expect(purge.code).toBe("failed_precondition");
    expect(purge.failure).toBe("NOT_RETIRED");
  });

  it("refuses while an execution is unfinished, and fails closed if kernel-api can't say", async () => {
    const t = await populatedTeam();
    await call(admin, "TeamService/RetireTeam", { name: t.name });

    kernelStates.set(t.executionId, "RUNNING");
    const running = await call(admin, "TeamService/PurgeTeam", { name: t.name });
    expect(running.code).toBe("failed_precondition");
    expect(running.failure).toBe("EXECUTIONS_RUNNING");
    // Only their states: which steps run is the lists' business, not a purge's.
    expect(vi.mocked(getExecutionStates)).toHaveBeenLastCalledWith([t.executionId]);

    vi.mocked(getExecutionStates).mockRejectedValueOnce(new Error("kernel-api unreachable"));
    expect((await call(admin, "TeamService/PurgeTeam", { name: t.name })).code).toBe("internal");
    const team = await call<{ team: { deletedAt?: string } }>(admin, "TeamService/GetTeam", { name: t.name });
    expect(team.body.team.deletedAt).toBeUndefined();
  });

  it("needs teams:delete: the everyday catalog token can't purge", async () => {
    const t = await populatedTeam();
    await call(admin, "TeamService/RetireTeam", { name: t.name });
    const catalogToken = await mint(["teams:create", "products:register", "teams:retire"]);
    expect((await call(catalogToken, "TeamService/PurgeTeam", { name: t.name })).code).toBe("permission_denied");
    expect((await call(await mint(["teams:delete"]), "TeamService/PurgeTeam", { name: t.name })).code).toBe("ok");
  });

  it("removes access, grants and bots, keeps history, and reserves the name forever", async () => {
    const t = await populatedTeam();
    // Its bot signs in keyless too, by an identity: that goes with it.
    const [bot] = await db.select({ id: users.id }).from(users).where(eq(users.email, `${t.name}-bot@bot.internal`));
    await db.insert(botIdentities).values({ botId: bot?.id ?? "", issuer: "https://issuer.example", claims: { sub: `${t.name}-ci` } });
    await call(admin, "TeamService/RetireTeam", { name: t.name });
    const purged = await call<{ revokedBotTokens: number }>(admin, "TeamService/PurgeTeam", { name: t.name });
    expect(purged.code).toBe("ok");
    expect(purged.body.revokedBotTokens).toBe(2);
    expect(await db.select().from(botIdentities).where(eq(botIdentities.botId, bot?.id ?? ""))).toEqual([]);

    // Gone from membership, admin listing, and the team's own calls.
    expect((await call<{ teamNames: string[] }>(t.member.token, "AuthService/GetMe")).body.teamNames).toEqual([]);
    const listing = await call<{ teams: { name: string }[] }>(admin, "TeamService/ListTeams");
    expect(listing.body.teams.some((team) => team.name === t.name)).toBe(false);
    expect((await call(admin, "TeamService/ListMembers", { team: t.name })).code).toBe("not_found");

    // Secret grants deleted; the team's bot can no longer authenticate.
    expect(await db.select().from(secretGrants).where(eq(secretGrants.teamId, t.teamId))).toEqual([]);
    expect((await call(t.botToken, "AuthService/GetMe")).code).toBe("unauthenticated");

    // Execution history kept.
    const history = await db.select().from(submittedExecutions).where(eq(submittedExecutions.executionId, t.executionId));
    expect(history).toHaveLength(1);

    // The name stays taken: visible to the existence check, and not reusable.
    const existence = await call<{ team: { deletedAt?: string } }>(admin, "TeamService/GetTeam", { name: t.name });
    expect(existence.code).toBe("ok");
    expect(existence.body.team.deletedAt).toBeDefined();
    const reuse = await call(admin, "TeamService/CreateTeam", { name: t.name });
    expect(reuse.code).toBe("failed_precondition");
    expect(reuse.failure).toBe("NAME_RESERVED");
  });
});

describe("running an execution again after its team is retired or purged", () => {
  /** A replayable execution for `team` (populatedTeam's own has no tasks). */
  async function replayableExecution(team: string, submittedBy: string): Promise<string> {
    const executionId = randomUUID();
    await recordSubmittedExecution({
      executionId,
      teams: [team],
      submittedBy,
      name: "history",
      payload: {
        name: "history",
        requestId: randomUUID(),
        tasks: [{ id: "t", image: `example/${team}:1`, action: "create", team }],
      },
    });
    return executionId;
  }

  async function runBlocked(executionId: string) {
    const read = await call<{ execution: { runBlocked?: { code: string } } }>(admin, "ExecutionService/GetExecution", {
      executionId,
    });
    return read.body.execution.runBlocked;
  }

  it("refuses a purged team's rerun, retry and new work, even for an admin, and says why up front", async () => {
    const t = await populatedTeam();
    const executionId = await replayableExecution(t.name, t.member.id);
    await call(admin, "TeamService/RetireTeam", { name: t.name });
    expect((await call(admin, "TeamService/PurgeTeam", { name: t.name })).code).toBe("ok");

    expect((await runBlocked(executionId))?.code).toBe("TEAM_PURGED");
    const refused = [
      await call(admin, "ExecutionService/RerunExecution", { executionId }),
      await call(admin, "ExecutionService/RetryTask", { executionId, taskId: "t" }),
      await call(admin, "ExecutionService/SubmitExecution", {
        dag: { name: "x", requestId: `x-${randomUUID()}`, tasks: [{ id: "t", image: "i", action: "a", team: t.name }] },
      }),
    ];
    for (const outcome of refused) {
      expect(outcome.code).toBe("failed_precondition");
      expect(outcome.failure).toBe("TEAM_PURGED");
    }
    expect(submitExecution).not.toHaveBeenCalled();
    expect(retryTask).not.toHaveBeenCalled();
  });

  it("refuses a retired team's until it's un-retired", async () => {
    const t = await populatedTeam();
    const executionId = await replayableExecution(t.name, t.member.id);
    await call(admin, "TeamService/RetireTeam", { name: t.name });

    expect((await runBlocked(executionId))?.code).toBe("TEAM_RETIRED");
    expect((await call(admin, "ExecutionService/RerunExecution", { executionId })).code).toBe("failed_precondition");
    expect((await call(t.member.token, "ExecutionService/RetryTask", { executionId, taskId: "t" })).code).toBe(
      "failed_precondition",
    );
    expect(submitExecution).not.toHaveBeenCalled();
    expect(retryTask).not.toHaveBeenCalled();

    await call(admin, "TeamService/UnretireTeam", { name: t.name });
    expect(await runBlocked(executionId)).toBeUndefined();
    expect((await call(admin, "ExecutionService/RerunExecution", { executionId })).code).toBe("ok");
    expect((await call(t.member.token, "ExecutionService/RetryTask", { executionId, taskId: "t" })).code).toBe("ok");
  });
});
