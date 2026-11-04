// SPDX-License-Identifier: MIT
/**
 * The console's last use, recorded for the kernel's sleeper (activity.ts):
 * signed-in requests count, at most one write a minute; anonymous ones
 * don't. Kubernetes is faked; the real ConfigMap write is proven on kind.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { createUser } from "../src/db/queries.js";
import { users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller } from "./rpc.js";

const call = caller(() => app);
import { recordActivity } from "../src/k8s.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  recordActivity: vi.fn(() => Promise.resolve()),
}));

const email = `activity-${randomUUID().slice(0, 6)}@example.com`;
const original = { activityConfigMap: config.activityConfigMap, platformNamespace: config.platformNamespace };
let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  Object.assign(config, { activityConfigMap: "console-execution-console-activity", platformNamespace: "vennir-system" });
  app = await buildApp();
  await app.ready();
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  token = app.jwt.sign({ userId: user.id });
});

afterAll(async () => {
  Object.assign(config, original);
  await db.delete(users).where(inArray(users.email, [email]));
  await app.close();
});

describe("recording the console's activity", () => {
  it("ignores anonymous requests", async () => {
    await call(undefined, "AuthService/GetMe");
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("records a signed-in request, then at most once a minute", async () => {
    const me = () => call(token, "AuthService/GetMe");
    expect((await me()).code).toBe("ok");
    expect(recordActivity).toHaveBeenCalledOnce();
    expect(recordActivity).toHaveBeenCalledWith("vennir-system", "console-execution-console-activity", expect.any(Date));
    await me();
    expect(recordActivity).toHaveBeenCalledOnce();
  });
});
