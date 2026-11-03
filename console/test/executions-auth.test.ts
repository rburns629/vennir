// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inArray, sql } from "drizzle-orm";
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
  upsertProduct,
} from "../src/db/queries.js";
import { submittedExecutions, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { loadExecution } from "../src/auth/access.js";
import { KernelApiError, cancelExecution, retryTask, submitExecution } from "../src/kernel/client.js";
import { ensureServiceAccount } from "../src/k8s.js";
import { missingImages, pinImages } from "../src/registry.js";
import { config } from "../src/config.js";
import { caller, failureDetail, problemFields, type RpcError } from "./rpc.js";

// Creating a product's ServiceAccount in its team's namespace is the one
// cluster write a submission makes; here it's recorded, not made.
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
}));

// The registry is asked about every submission; test/registry.test.ts
// covers how. Here it answers "nothing missing" unless a test says so.
vi.mock("../src/registry.js", () => ({
  missingImages: vi.fn(() => Promise.resolve([])),
  pinImages: vi.fn((images: string[]) =>
    Promise.resolve({ pinned: new Map(images.map((i) => [i, `${i}@sha256:${"c".repeat(64)}`])), unresolved: [] }),
  ),
}));

// Only the call to kernel-api is stubbed: these tests are about the
// console's own authorization decision, made against real Postgres rows,
// before anything is forwarded.
vi.mock("../src/db/queries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/queries.js")>();
  return { ...actual, recordSubmittedExecution: vi.fn(actual.recordSubmittedExecution) };
});
vi.mock("../src/kernel/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/client.js")>();
  const { randomUUID: uuid } = await import("node:crypto");
  return {
    ...actual,
    submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })),
    retryTask: vi.fn((executionId: string) => Promise.resolve({ executionId, state: "RUNNING" })),
    cancelExecution: vi.fn((executionId: string) => Promise.resolve({ executionId, state: "CANCELLED" })),
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

const GRANTEE = "product-a-sa";
let app: FastifyInstance;
let token: string;
let teamName: string;
let teamId: string;
let userId: string;
// A team the test user isn't in.
let otherTeamName: string;
const userEmails: string[] = [];
const recordedExecutionIds: string[] = [];

const call = caller(() => app);
const submitDag = (dag: Record<string, unknown>) =>
  call<{ executionId: string } & RpcError>(token, "ExecutionService/SubmitExecution", { dag });

function submit(task: Record<string, unknown>) {
  return submitDag({
    name: "sa-check",
    requestId: `sa-check-${randomUUID()}`,
    tasks: [{ id: "t", image: "some-image:latest", action: "create", team: teamName, ...task }],
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  teamName = `sa-check-${randomUUID().slice(0, 8)}`;
  const team = await createTeam(teamName);
  teamId = team.id;
  const email = `member-${randomUUID()}@example.com`;
  userEmails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  userId = user.id;
  await addTeamMember(user.id, teamId);
  token = app.jwt.sign({ userId: user.id });

  otherTeamName = `sa-check-other-${randomUUID().slice(0, 8)}`;

  const other = await createTeam(otherTeamName);

  // The team's secrets: any of its products may mount either.
  for (const secretName of ["product-a-secret", "team-other-secret"]) {
    await recordSecretGrant({ teamId, secretName, keys: ["value"], source: "literal" });
  }
  // Another team's, which this team's tasks may never mount.
  await recordSecretGrant({ teamId: other.id, secretName: "other-team-secret", keys: ["value"], source: "literal" });
  // The image these tests submit, registered as the team's product the
  // way catalog CI would: it runs as GRANTEE, reads product-a-secret, and
  // declares one more secret the team never registered. (Deleted with the
  // team.)
  await upsertProduct({
    name: `${teamName}-product-a`,
    image: "some-image:1",
    action: "create",
    teamId,
    serviceAccount: GRANTEE,
    secretRefs: ["product-a-secret", "ungranted-secret"],
    tokenAudiences: ["sts.amazonaws.com"],
    resources: { cpu: "50m", memory: "64Mi" },
  });
  // A product whose action declares its schemas (C1).
  await upsertProduct({
    name: `${teamName}-schema-check`,
    image: "schema-image:1",
    action: "check",
    teamId,
    inputSchema: {
      type: "object",
      required: ["name", "count"],
      properties: { name: { type: "string" }, count: { type: "integer" } },
    },
    outputSchema: { type: "object", required: ["ok"] },
  });
});

beforeEach(() => {
  vi.mocked(ensureServiceAccount).mockClear();
  vi.mocked(submitExecution).mockClear();
  vi.mocked(retryTask).mockClear();
  vi.mocked(cancelExecution).mockClear();
});

afterAll(async () => {
  await app.close();
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.teams, [[teamName]]));
  if (recordedExecutionIds.length > 0) {
    await db.delete(submittedExecutions).where(inArray(submittedExecutions.executionId, recordedExecutionIds));
  }
  await db.delete(teams).where(inArray(teams.name, [teamName, otherTeamName]));
  await db.delete(users).where(inArray(users.email, userEmails));
});

describe("SubmitExecution: a product runs as its ServiceAccount, with its team's secrets", () => {
  const message = (response: { json: <T>() => T }) => response.message;

  it("forwards a product's task that runs as its ServiceAccount with its team's secret", async () => {
    const response = await submit({ serviceAccount: GRANTEE, secretRefs: ["product-a-secret"] });
    expect(response.code).toBe("ok");
    expect(submitExecution).toHaveBeenCalledOnce();
    // Who asked, for the kernel to record on each task's first attempt.
    expect(vi.mocked(submitExecution).mock.calls[0]?.[1]).toBe(`user:${userId}`);
    // Its ServiceAccount is made sure of, in its team's namespace.
    expect(ensureServiceAccount).toHaveBeenCalledWith(teamName, GRANTEE);
  });

  it("lets a product mount any secret its team registered, not only those it lists", async () => {
    const response = await submit({ serviceAccount: GRANTEE, secretRefs: ["team-other-secret"] });
    expect(response.code).toBe("ok");
  });

  it("gives a task that names no ServiceAccount its product's", async () => {
    const response = await submit({ secretRefs: ["product-a-secret"] });
    expect(response.code).toBe("ok");
    const forwarded = vi.mocked(submitExecution).mock.calls[0]?.[0] as { tasks: Record<string, unknown>[] };
    expect(forwarded.tasks[0]?.["serviceAccount"]).toBe(GRANTEE);
  });

  it("gives an unregistered image that names none \"default\", and makes nothing for it", async () => {
    const response = await submit({ image: "unregistered-image:1" });
    expect(response.code).toBe("ok");
    const forwarded = vi.mocked(submitExecution).mock.calls[0]?.[0] as { tasks: Record<string, unknown>[] };
    expect(forwarded.tasks[0]?.["serviceAccount"]).toBe("default");
    expect(ensureServiceAccount).not.toHaveBeenCalled();
  });

  it("matches any release of the product's image", async () => {
    const response = await submit({ image: "docker.io/library/some-image@sha256:abc", serviceAccount: GRANTEE });
    expect(response.code).toBe("ok");
  });

  it("rejects a product's task that runs as another ServiceAccount", async () => {
    const response = await submit({ serviceAccount: "product-b-sa", secretRefs: ["product-a-secret"] });
    expect(response.code).toBe("permission_denied");
    expect(message(response)).toContain(`runs as ServiceAccount "${GRANTEE}"`);
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("rejects another ServiceAccount even when the task mounts no secrets", async () => {
    // A ServiceAccount can carry a cloud identity (a SecretStore's, another
    // product's), whatever is mounted.
    const response = await submit({ serviceAccount: "secret-store-sa" });
    expect(response.code).toBe("permission_denied");
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("rejects a secret its team never registered, even one the product lists", async () => {
    for (const secret of ["someone-elses-secret", "ungranted-secret"]) {
      const response = await submit({ serviceAccount: GRANTEE, secretRefs: [secret] });
      expect(response.code).toBe("permission_denied");
      expect(message(response)).toContain("is not registered for team");
    }
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("rejects another team's secret", async () => {
    const response = await submit({ serviceAccount: GRANTEE, secretRefs: ["other-team-secret"] });
    expect(response.code).toBe("permission_denied");
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("rejects an action the product doesn't register, as an unregistered image", async () => {
    const response = await submit({ action: "delete", serviceAccount: GRANTEE });
    expect(response.code).toBe("permission_denied");
    expect(message(response)).toContain("isn't a registered product");
  });

  it("runs a product as \"default\" with no secrets, before its own ServiceAccount exists", async () => {
    const response = await submit({ serviceAccount: "default" });
    expect(response.code).toBe("ok");
  });

  it("runs an unregistered image as \"default\" with no secrets", async () => {
    const response = await submit({ image: "unregistered-image:1", serviceAccount: "default" });
    expect(response.code).toBe("ok");
  });

  it("refuses an unregistered image any other ServiceAccount, or a secret", async () => {
    const asGrantee = await submit({ image: "unregistered-image:1", serviceAccount: GRANTEE });
    expect(asGrantee.code).toBe("permission_denied");
    expect(message(asGrantee)).toContain("isn't a registered product");
    const withSecret = await submit({
      image: "unregistered-image:1",
      serviceAccount: "default",
      secretRefs: ["product-a-secret"],
    });
    expect(withSecret.code).toBe("permission_denied");
    expect(submitExecution).not.toHaveBeenCalled();
  });
});

describe("SubmitExecution: token audiences are the product's, never the submitter's", () => {
  const forwarded = () =>
    (vi.mocked(submitExecution).mock.calls[0]?.[0] as { tasks: Record<string, unknown>[] }).tasks[0];

  it("gives a product's task the audiences its product declared", async () => {
    expect((await submit({ image: "some-image:1" })).code).toBe("ok");
    expect(forwarded()?.["tokenAudiences"]).toEqual(["sts.amazonaws.com"]);
  });

  it("gives an unregistered image none", async () => {
    expect((await submit({ image: "unregistered-image:1" })).code).toBe("ok");
    expect(forwarded()).not.toHaveProperty("tokenAudiences");
  });

  it("gives the product's image run as \"default\" none: that isn't the product", async () => {
    expect((await submit({ image: "some-image:1", serviceAccount: "default" })).code).toBe("ok");
    expect(forwarded()).not.toHaveProperty("tokenAudiences");
  });

  it("has no field a submitter could set them with: one sent anyway never reaches kernel-api", async () => {
    expect((await submit({ image: "unregistered-image:1", tokenAudiences: ["sts.amazonaws.com"] })).code).toBe("ok");
    expect(forwarded()).not.toHaveProperty("tokenAudiences");
  });
});

describe("SubmitExecution: inputs are checked against the product's schema", () => {
  const sent = () => (vi.mocked(submitExecution).mock.calls[0]?.[0] as { tasks: Record<string, unknown>[] }).tasks;
  const check = (id: string, inputs: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id,
    image: "schema-image:1",
    action: "check",
    team: teamName,
    inputs,
    ...extra,
  });

  it("refuses literal inputs that don't fit, each problem on its field, and sends nothing", async () => {
    const refused = await submitDag({ name: "schemas", tasks: [check("t", { name: 3, count: "many" })] });
    expect(refused.code).toBe("invalid_argument");
    expect(refused.failure).toBe("INPUT_INVALID");
    expect(problemFields(refused.body)).toEqual(expect.arrayContaining(["tasks.t.inputs.name", "tasks.t.inputs.count"]));
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("leaves an upstream output to the kernel, and sends it both schemas to check", async () => {
    const response = await submitDag({
      name: "schemas",
      tasks: [
        check("first", { name: "a", count: 1 }),
        check("second", { name: "b", count: { $fromTask: "first", $output: "count" } }, { dependsOn: ["first"] }),
      ],
    });
    expect(response.code).toBe("ok");
    const [, second] = sent();
    expect(second).toMatchObject({ inputSchema: { required: ["name", "count"] }, outputSchema: { required: ["ok"] } });
    // Recorded without them: a rerun gets the product's current ones.
    const recorded = vi.mocked(recordSubmittedExecution).mock.calls.at(-1)?.[0];
    expect(JSON.stringify(recorded?.payload)).not.toContain("inputSchema");
  });

  it("sends no schemas for an image that isn't a registered product", async () => {
    expect((await submit({ image: "unregistered-image:1" })).code).toBe("ok");
    expect(sent()[0]).not.toHaveProperty("inputSchema");
  });
});

describe("SubmitExecution: every image is pinned to its digest", () => {
  const forwarded = () => vi.mocked(submitExecution).mock.calls[0]?.[0] as { tasks: { image: string }[] };

  it("sends kernel-api the digest a tag names now, keeping the tag", async () => {
    config.imagePinning = "required";
    try {
      const response = await submit({ image: "some-image:latest", serviceAccount: GRANTEE });
      expect(response.code).toBe("ok");
      expect(forwarded().tasks[0]?.image).toBe(`some-image:latest@sha256:${"c".repeat(64)}`);
    } finally {
      config.imagePinning = "off";
    }
  });

  it("refuses a submission whose image the registry can't resolve", async () => {
    config.imagePinning = "required";
    vi.mocked(pinImages).mockResolvedValueOnce({ pinned: new Map(), unresolved: ["some-image:latest"] });
    try {
      const response = await submit({ image: "some-image:latest", serviceAccount: GRANTEE });
      expect(response.code).toBe("invalid_argument");
      expect(response.failure).toBe("IMAGE_NOT_RESOLVED");
      expect(submitExecution).not.toHaveBeenCalled();
    } finally {
      config.imagePinning = "off";
    }
  });
});

describe("SubmitExecution: images the registry says are gone", () => {
  it("refuses the submission up front and forwards nothing", async () => {
    vi.mocked(missingImages).mockResolvedValueOnce(["some-image:latest"]);
    const response = await submit({ serviceAccount: GRANTEE });
    expect(response.code).toBe("invalid_argument");
    expect(response.failure).toBe("IMAGE_NOT_FOUND");
    expect(failureDetail(response.body)?.["missingImages"]).toEqual(["some-image:latest"]);
    expect(submitExecution).not.toHaveBeenCalled();
  });
});

describe("SubmitExecution: name and requestId", () => {
  const task = () => ({ id: "t", image: "some-image:latest", action: "create", team: teamName, serviceAccount: GRANTEE });
  const forwarded = () => vi.mocked(submitExecution).mock.calls[0]?.[0] as Record<string, unknown>;
  const post = submitDag;

  it("scopes requestId to the submitting team before kernel-api sees it", async () => {
    const response = await post({ name: "scoped", requestId: "hello-1", tasks: [task()] });
    expect(response.code).toBe("ok");
    expect(forwarded()["requestId"]).toBe(`${teamName}/hello-1`);
  });

  it("leaves requestId out when the caller does, so every submission is a new run", async () => {
    await post({ name: "no-key", tasks: [task()] });
    expect(forwarded()).not.toHaveProperty("requestId");
  });

  it("lists a submission under its name", async () => {
    const response = await post({ name: "named", requestId: "named-1", tasks: [task()] });
    const list = await call<{ executions: { executionId: string; name: string }[] }>(token, "ExecutionService/ListExecutions");
    expect(list.body.executions.find((e) => e.executionId === response.body.executionId)?.name).toBe("named");
  });

  it("reruns a DAG stored under the old names, once migration 0049 renamed them", async () => {
    const first = await post({ name: "stored-legacy", requestId: "old-2", tasks: [task()] });
    const id = first.body.executionId;
    // A row stored before the rename: payload with the old names.
    await db
      .update(submittedExecutions)
      .set({ payload: { externalReference: "stored-legacy", idempotencyKey: "old-2", tasks: [task()] } })
      .where(inArray(submittedExecutions.executionId, [id]));
    // What the migration does to it (it changes only rows with the old names).
    await db.execute(sql.raw(readFileSync(new URL("../src/db/migrations/0049_stored_dag_field_names.sql", import.meta.url), "utf8")));
    const [migrated] = await db.select().from(submittedExecutions).where(inArray(submittedExecutions.executionId, [id]));
    expect(migrated?.payload).toMatchObject({ name: "stored-legacy", requestId: "old-2" });
    expect(migrated?.payload).not.toHaveProperty("externalReference");
    vi.mocked(submitExecution).mockClear();

    const rerun = await call(token, "ExecutionService/RerunExecution", { executionId: id });
    expect(rerun.code).toBe("ok");
    expect(forwarded()["name"]).toBe("stored-legacy");
    expect(forwarded()).not.toHaveProperty("externalReference");
    expect(forwarded()).not.toHaveProperty("idempotencyKey");
    expect(forwarded()["requestId"]).not.toBe(`${teamName}/old-2`);
  });

  it("reruns a team's DAG for its team, whatever the stored one says", async () => {
    const first = await post({ name: "stored-for-team", tasks: [task()] });
    const id = first.body.executionId;
    await db
      .update(submittedExecutions)
      .set({ payload: { name: "stored-for-team", tasks: [{ ...task(), forTeam: "someone-else" }] } })
      .where(inArray(submittedExecutions.executionId, [id]));
    vi.mocked(submitExecution).mockClear();
    expect((await call(token, "ExecutionService/RerunExecution", { executionId: id })).code).toBe("ok");
    expect((forwarded()["tasks"] as Record<string, unknown>[])[0]?.["forTeam"]).toBe(teamName);
  });
});

describe("retry and cancel check access again, over every team", () => {
  const task =(id: string, team: string, extra: Record<string, unknown> = {}) => ({
    id,
    image: "some-image:latest",
    action: "create",
    team,
    serviceAccount: GRANTEE,
    ...extra,
  });

  /** An execution as POST /executions would have recorded it. */
  async function recorded(teamsOf: string[], payload: unknown): Promise<string> {
    const executionId = randomUUID();
    recordedExecutionIds.push(executionId);
    await recordSubmittedExecution({ executionId, teams: teamsOf, submittedBy: userId, name: "recheck", payload });
    return executionId;
  }

  const retry = (executionId: string, taskId: string) => call(token, "ExecutionService/RetryTask", { executionId, taskId });
  const cancel = (executionId: string) => call(token, "ExecutionService/CancelExecution", { executionId });

  it("retries a task whose team and secrets still allow it", async () => {
    const id = await recorded([teamName], { tasks: [task("t", teamName, { secretRefs: ["product-a-secret"] })] });
    const response = await retry(id, "t");
    expect(response.code).toBe("ok");
    expect(retryTask).toHaveBeenCalledOnce();
    // Who retried it, for the kernel to record on the next attempt.
    expect(retryTask).toHaveBeenCalledWith(id, "t", `user:${userId}`);
  });

  it("refuses a retry that would mount a secret no longer registered", async () => {
    const id = await recorded([teamName], { tasks: [task("t", teamName, { secretRefs: ["ungranted-secret"] })] });
    const response = await retry(id, "t");
    expect(response.code).toBe("permission_denied");
    expect(response.message).toContain("is not registered for team");
    expect(retryTask).not.toHaveBeenCalled();
  });

  it("refuses a retry by a member of only one of the execution's teams", async () => {
    // Retrying resumes the execution, which revives the other team's tasks too.
    const id = await recorded([teamName, otherTeamName], {
      tasks: [task("mine", teamName), task("theirs", otherTeamName, { dependsOn: ["mine"] })],
    });
    const response = await retry(id, "mine");
    expect(response.code).toBe("permission_denied");
    expect(retryTask).not.toHaveBeenCalled();
  });

  it("refuses a retry it has no stored submission to check against", async () => {
    const id = await recorded([teamName], null);
    const response = await retry(id, "t");
    expect(response.code).toBe("invalid_argument");
    expect(retryTask).not.toHaveBeenCalled();
  });

  it("cancels an execution of the caller's own team", async () => {
    const id = await recorded([teamName], { tasks: [task("t", teamName)] });
    const response = await cancel(id);
    expect(response.code).toBe("ok");
    expect(cancelExecution).toHaveBeenCalledOnce();
  });

  it("refuses a cancel by a member of only one of the execution's teams", async () => {
    const id = await recorded([teamName, otherTeamName], {
      tasks: [task("mine", teamName), task("theirs", otherTeamName)],
    });
    const response = await cancel(id);
    expect(response.code).toBe("permission_denied");
    expect(cancelExecution).not.toHaveBeenCalled();
  });
});

describe("SubmitExecution: a task's size comes from its product unless it sets its own", () => {
  const forwardedTask = () =>
    (vi.mocked(submitExecution).mock.calls[0]?.[0] as { tasks: Record<string, unknown>[] }).tasks[0];

  it("gives a task its product's resources", async () => {
    const response = await submit({ serviceAccount: GRANTEE });
    expect(response.code).toBe("ok");
    expect(forwardedTask()?.["resources"]).toEqual({ cpu: "50m", memory: "64Mi" });
  });

  it("keeps a task's own resources", async () => {
    const response = await submit({ serviceAccount: GRANTEE, resources: { cpu: "2", memory: "4Gi" } });
    expect(response.code).toBe("ok");
    expect(forwardedTask()?.["resources"]).toEqual({ cpu: "2", memory: "4Gi" });
  });

  it("leaves an unregistered image's task unsized, for kernel-api's default", async () => {
    const response = await submit({ image: "unregistered-image:1", serviceAccount: "default" });
    expect(response.code).toBe("ok");
    expect(forwardedTask()).not.toHaveProperty("resources");
  });
});

describe("kernel-api's refusals", () => {
  it("passes on a refusal about the request", async () => {
    vi.mocked(submitExecution).mockRejectedValueOnce(new KernelApiError(422, { detail: [{ msg: "bad" }] }));
    const response = await submit({ image: "unregistered-image:1", serviceAccount: "default" });
    expect(response.code).toBe("invalid_argument");
    expect(response.message).toContain("bad");
  });

  it("turns a refusal of the console's own credentials into unavailable, not unauthenticated (which signs the user out)", async () => {
    for (const status of [401, 403]) {
      vi.mocked(submitExecution).mockRejectedValueOnce(new KernelApiError(status, { detail: "nope" }));
      const response = await submit({ image: "unregistered-image:1", serviceAccount: "default" });
      expect(response.code).toBe("unavailable");
      expect(response.message).toContain("couldn't authenticate to the execution kernel");
    }
  });
});

describe("recording a submission", () => {
  it("answers with the existing execution when the requestId returned one", async () => {
    const existing = randomUUID();
    vi.mocked(submitExecution).mockResolvedValueOnce({ executionId: existing, state: "RUNNING", created: false });
    const response = await submit({ image: "unregistered-image:1", serviceAccount: "default" });
    expect(response.code).toBe("ok");
    expect(response.body.executionId).toBe(existing);
  });

  it("cancels a new execution it couldn't record, so it can't run unseen", async () => {
    const executionId = randomUUID();
    vi.mocked(submitExecution).mockResolvedValueOnce({ executionId, state: "PENDING", created: true });
    vi.mocked(cancelExecution).mockClear();
    vi.mocked(recordSubmittedExecution).mockRejectedValueOnce(new Error("database unavailable"));
    const response = await submit({ image: "unregistered-image:1", serviceAccount: "default" });
    expect(response.code).toBe("internal");
    expect(cancelExecution).toHaveBeenCalledWith(executionId);
  });

  it("leaves a replayed execution alone if recording fails", async () => {
    vi.mocked(submitExecution).mockResolvedValueOnce({ executionId: randomUUID(), state: "RUNNING", created: false });
    vi.mocked(cancelExecution).mockClear();
    vi.mocked(recordSubmittedExecution).mockRejectedValueOnce(new Error("database unavailable"));
    expect((await submit({ image: "unregistered-image:1", serviceAccount: "default" })).code).toBe("internal");
    expect(cancelExecution).not.toHaveBeenCalled();
  });
});

describe("SubmitExecution: a product's own retry policy (R3)", () => {
  const sent = () => (vi.mocked(submitExecution).mock.calls.at(-1)?.[0] as { tasks: Record<string, unknown>[] }).tasks[0];

  beforeAll(async () => {
    await upsertProduct({
      name: `${teamName}-retrying`,
      image: "retry-image:1",
      action: "ensure",
      teamId,
      idempotent: true,
      maxAttempts: 3,
      concurrencyKey: ["projectId"],
      maxRunning: 2,
      capacity: "onDemand",
      sourcePath: "teams/web/products/retrying/product.yaml",
    });
  });

  it("sends its product's cap, shared by the product's actions, and drops one a submitter wrote themselves", async () => {
    const run = (image: string, extra: Record<string, unknown> = {}) =>
      submit({ image, action: "ensure", serviceAccount: "default", inputs: { projectId: "web-1" }, ...extra });
    expect((await run("retry-image:latest")).code).toBe("ok");
    expect(sent()).toMatchObject({ productCap: { scope: "teams/web/products/retrying", maxRunning: 2 }, capacity: "onDemand" });
    expect((await run("unregistered-image:1", { productCap: { scope: "mine", maxRunning: 100 }, capacity: "onDemand" })).code).toBe("ok");
    expect(sent()).not.toHaveProperty("productCap");
    expect(sent()).not.toHaveProperty("capacity");
  });

  it("sends its product's concurrency key, and drops one a submitter wrote themselves", async () => {
    const run = (image: string, extra: Record<string, unknown> = {}) =>
      submit({ image, action: "ensure", serviceAccount: "default", inputs: { projectId: "web-1" }, ...extra });
    expect((await run("retry-image:latest")).code).toBe("ok");
    expect(sent()).toMatchObject({ concurrencyKey: { scope: `${teamName}-retrying`, inputs: ["projectId"] } });
    expect((await run("unregistered-image:1", { concurrencyKey: { scope: "mine", inputs: ["projectId"] } })).code).toBe("ok");
    expect(sent()).not.toHaveProperty("concurrencyKey");
  });

  it("gives an idempotent product's step its attempts, fewer when asked, never more", async () => {
    const run = (maxAttempts?: number) =>
      submit({ image: "retry-image:latest", action: "ensure", serviceAccount: "default", ...(maxAttempts ? { maxAttempts } : {}) });
    expect((await run()).code).toBe("ok");
    expect(sent()).toMatchObject({ maxAttempts: 3 });
    expect((await run(2)).code).toBe("ok");
    expect(sent()).toMatchObject({ maxAttempts: 2 });
    expect((await run(9)).code).toBe("ok");
    expect(sent()).toMatchObject({ maxAttempts: 3 });
  });

  it("gives a product that isn't idempotent one attempt, whatever is asked", async () => {
    expect((await submit({ serviceAccount: GRANTEE, maxAttempts: 4 })).code).toBe("ok");
    expect(sent()).toMatchObject({ maxAttempts: 1 });
  });

  it("leaves an unregistered image's attempts as asked", async () => {
    expect((await submit({ image: "unregistered-image:1", serviceAccount: "default", maxAttempts: 2 })).code).toBe("ok");
    expect(sent()).toMatchObject({ maxAttempts: 2 });
  });
});

describe("a member who isn't a maintainer", () => {
  let memberToken: string;
  let memberId: string;

  beforeAll(async () => {
    const email = `plain-member-${randomUUID()}@example.com`;
    userEmails.push(email);
    const user = await createUser(email, await hashPassword("correct-horse-battery"));
    memberId = user.id;
    await addTeamMember(user.id, teamId, "member");
    memberToken = app.jwt.sign({ userId: user.id });
  });

  async function recordedFor(teamsOf: string[]): Promise<string> {
    const executionId = randomUUID();
    recordedExecutionIds.push(executionId);
    const payload = { tasks: [{ id: "t", image: "some-image:latest", action: "create", team: teamName, serviceAccount: GRANTEE }] };
    await recordSubmittedExecution({ executionId, teams: teamsOf, submittedBy: userId, name: "roles", payload });
    return executionId;
  }

  it("can't submit a raw DAG for the team", async () => {
    const response = await call<RpcError>(memberToken, "ExecutionService/SubmitExecution", {
      dag: { name: "roles", tasks: [{ id: "t", image: "unregistered-image:1", action: "create", team: teamName }] },
    });
    expect(response.code).toBe("permission_denied");
    expect(response.message).toContain("a member, not a maintainer");
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("can't cancel or retry the team's runs", async () => {
    const id = await recordedFor([teamName]);
    expect((await call(memberToken, "ExecutionService/CancelExecution", { executionId: id })).code).toBe("permission_denied");
    expect((await call(memberToken, "ExecutionService/RetryTask", { executionId: id, taskId: "t" })).code).toBe(
      "permission_denied",
    );
    expect(cancelExecution).not.toHaveBeenCalled();
    expect(retryTask).not.toHaveBeenCalled();
  });

  it("still sees the team's runs", async () => {
    const id = await recordedFor([teamName]);
    const asMember = { id: memberId, teamNames: [teamName], maintainerOf: [], isAdmin: false };
    await expect(loadExecution(id, asMember, "any")).resolves.toMatchObject({ executionId: id });
    await expect(loadExecution(id, asMember, "every")).rejects.toThrow("Not a maintainer");
  });
});
