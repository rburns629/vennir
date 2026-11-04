// SPDX-License-Identifier: MIT
/**
 * The client for kernel-api (src/kernel/client.ts), against a KernelService
 * of the test's own over real HTTP. The console proves who it is with its
 * projected ServiceAccount token (kernel-api checks it with a TokenReview);
 * the kubelet rotates the file, so it's read on every call. And it turns
 * DAG JSON into a request strictly, under the names the console checked.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import {
  ExecutionState,
  KernelService,
  TaskState,
  ValidationIssuesSchema,
  type SubmitExecutionRequest,
} from "../src/gen/vennir/kernel/v1/kernel_pb.js";
import { getExecution, KernelApiError, submissionRequest, submitExecution } from "../src/kernel/client.js";

const seen: { authorization: string | null; submitted?: SubmitExecutionRequest }[] = [];
let refuseWith: ConnectError | undefined;

function routes(router: ConnectRouter) {
  router.service(KernelService, {
    getExecution(req, ctx) {
      seen.push({ authorization: ctx.requestHeader.get("Authorization") });
      if (refuseWith) throw refuseWith;
      return {
        execution: {
          executionId: req.executionId,
          name: "demo",
          state: ExecutionState.RUNNING,
          tasks: [{ taskId: "a", state: TaskState.SUCCEEDED, attemptCount: 1, outputs: { x: 1 }, dependsOn: [] }],
        },
      };
    },
    submitExecution(req, ctx) {
      seen.push({ authorization: ctx.requestHeader.get("Authorization"), submitted: req });
      if (refuseWith) throw refuseWith;
      return { executionId: "e-1", state: ExecutionState.PENDING, created: true };
    },
  });
}

let server: Server;
const originalUrl = config.kernelApiUrl;
const originalTokenFile = config.kernelApiTokenFile;

beforeAll(async () => {
  server = createServer(connectNodeAdapter({ routes }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.kernelApiUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  config.kernelApiUrl = originalUrl;
  await new Promise((resolve) => server.close(resolve));
});

describe("kernel-api client", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kernel-token-"));
    seen.length = 0;
    refuseWith = undefined;
  });

  afterEach(async () => {
    config.kernelApiTokenFile = originalTokenFile;
    await rm(dir, { recursive: true, force: true });
  });

  it("sends the projected token, re-read on every call", async () => {
    const tokenFile = join(dir, "token");
    config.kernelApiTokenFile = tokenFile;

    await writeFile(tokenFile, "first-token\n");
    await getExecution("e1");
    await writeFile(tokenFile, "rotated-token\n");
    await getExecution("e2");

    expect(seen.map((s) => s.authorization)).toEqual(["Bearer first-token", "Bearer rotated-token"]);
  });

  it("sends no token when none is configured (kernel-api's check disabled)", async () => {
    config.kernelApiTokenFile = undefined;
    await getExecution("e1");
    expect(seen[0]?.authorization).toBeNull();
  });

  it("fails rather than calling without a token when the file is missing", async () => {
    config.kernelApiTokenFile = join(dir, "missing");
    await expect(getExecution("e1")).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("answers in the JSON the console's API maps from", async () => {
    config.kernelApiTokenFile = undefined;
    expect(await getExecution("e1")).toEqual({
      executionId: "e1",
      name: "demo",
      state: "RUNNING",
      tasks: [
        {
          taskId: "a",
          state: "SUCCEEDED",
          attemptCount: 1,
          outputs: { x: 1 },
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
          waitingForCap: false,
        },
      ],
    });
  });

  it("turns kernel-api's refusals into the statuses the console relays", async () => {
    config.kernelApiTokenFile = undefined;
    refuseWith = new ConnectError("Execution not found.", Code.NotFound);
    await expect(getExecution("e1")).rejects.toMatchObject({ status: 404, body: { detail: "Execution not found." } });

    refuseWith = new ConnectError("This caller may not use kernel-api.", Code.PermissionDenied);
    await expect(getExecution("e1")).rejects.toMatchObject({ status: 403 });

    refuseWith = new ConnectError("invalid DAG", Code.InvalidArgument, undefined, [
      {
        desc: ValidationIssuesSchema,
        value: create(ValidationIssuesSchema, {
          issues: [{ code: "CYCLE_DETECTED", message: "Cycle detected involving task(s): a, b.", taskId: "a" }],
        }),
      },
    ]);
    await expect(submitExecution({ name: "x", tasks: [] })).rejects.toMatchObject({
      status: 422,
      body: { detail: [{ code: "CYCLE_DETECTED", message: "Cycle detected involving task(s): a, b.", taskId: "a" }] },
    });

    // Anything else (kernel-api down, a bug) isn't a refusal: it's masked.
    refuseWith = new ConnectError("boom", Code.Internal);
    const error: unknown = await getExecution("e1").catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(KernelApiError);
  });

  it("submits every field under the names the console checked", async () => {
    config.kernelApiTokenFile = undefined;
    const result = await submitExecution({
      name: "demo",
      requestId: "r-1",
      tasks: [
        {
          id: "a",
          image: "r/app@sha256:abc",
          action: "run",
          team: "team-a",
          serviceAccount: "app-sa",
          dependsOn: [],
          secretRefs: ["key"],
          inputs: { n: 1, nested: { $fromTask: "x", $output: "y" } },
          timeoutSeconds: 60,
          maxAttempts: 2,
          resources: { cpu: "250m", memoryLimit: "1Gi" },
        },
      ],
    });
    expect(result).toEqual({ executionId: "e-1", state: "PENDING", created: true });
    const task = seen[0]?.submitted?.tasks[0];
    expect(task).toMatchObject({
      id: "a",
      serviceAccount: "app-sa",
      secretRefs: ["key"],
      inputs: { n: 1, nested: { $fromTask: "x", $output: "y" } },
      timeoutSeconds: 60,
      maxAttempts: 2,
      resources: { cpu: "250m", memory: "", memoryLimit: "1Gi" },
    });
  });
});

describe("a DAG's JSON as a request", () => {
  const task = { id: "a", image: "i", action: "run", team: "t", serviceAccount: "default" };

  it("refuses names the console didn't check, so the two can't disagree", () => {
    for (const extra of [{ service_account: "admin" }, { secret_refs: ["k"] }, { depends_on: [] }, { timeout_seconds: 1 }]) {
      expect(() => submissionRequest({ name: "x", tasks: [{ ...task, ...extra }] })).toThrow(KernelApiError);
    }
    expect(() => submissionRequest({ external_reference: "x", tasks: [task] })).toThrow(KernelApiError);
    expect(() => submissionRequest({ name: "x", tasks: [{ ...task, resources: { memory_limit: "1Gi" } }] })).toThrow(
      KernelApiError,
    );
  });

  it("refuses the names from before the rename (stored DAGs were migrated)", () => {
    expect(() => submissionRequest({ externalReference: "old", tasks: [task] })).toThrow(KernelApiError);
    expect(() => submissionRequest({ name: "x", idempotencyKey: "k", tasks: [task] })).toThrow(KernelApiError);
  });

  it("refuses the wrong types instead of guessing", () => {
    for (const bad of [{ timeoutSeconds: "60" }, { timeoutSeconds: 1.5 }, { dependsOn: "a" }, { inputs: [] }, { id: 3 }]) {
      expect(() => submissionRequest({ name: "x", tasks: [{ ...task, ...bad }] })).toThrow(KernelApiError);
    }
  });
});
