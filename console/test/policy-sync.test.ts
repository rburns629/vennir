// SPDX-License-Identifier: MIT
/** Rewriting the cluster's policies periodically, and showing admins how it went (policySync.ts). */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { createUser, setUserAdmin } from "../src/db/queries.js";
import { users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller } from "./rpc.js";
import { readPolicyVariables, updateIdentityPolicy } from "../src/k8s.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  updateIdentityPolicy: vi.fn(() => Promise.resolve(true)),
  readPolicyVariables: vi.fn(() => Promise.resolve(null)),
}));

const emails: string[] = [];
let app: FastifyInstance;
let admin: string;
let member: string;
const originalName = config.identityPolicyName;

beforeAll(async () => {
  config.identityPolicyName = "kernel-execution-kernel-identity";
  app = await buildApp();
  await app.ready();
  for (const isAdmin of [true, false]) {
    const email = `sync-${randomUUID().slice(0, 8)}@example.com`;
    emails.push(email);
    const user = await createUser(email, await hashPassword("correct-horse-battery"));
    if (isAdmin) await setUserAdmin(user.id, true);
    if (isAdmin) admin = app.jwt.sign({ userId: user.id });
    else member = app.jwt.sign({ userId: user.id });
  }
});

afterAll(async () => {
  config.identityPolicyName = originalName;
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

type Outcomes = {
  outcomes: Record<string, { ok: boolean; applies: boolean; error?: string }>;
  catalog?: { writer: string; release: string; commit: string };
};
const rpc = caller(() => app);
const read = (token: string) => rpc<Outcomes>(token, "AdminService/GetPolicySync");
const sync = (token: string) => rpc<Outcomes>(token, "AdminService/SyncPolicies");

describe("policy sync", () => {
  it("rewrites the policies on request and says how it went, for admins only", async () => {
    expect((await read(member)).code).toBe("permission_denied");
    const synced = (await sync(admin)).body.outcomes;
    expect(synced["identityPolicy"]).toMatchObject({ ok: true, applies: true });
    expect(synced["scanPolicy"]).toMatchObject({ ok: true, applies: false }); // scanning off here
  });

  it("says who writes the catalog's policies: the kernel, from its release, when its policy is installed", async () => {
    expect((await read(admin)).body.catalog).toMatchObject({ writer: "console" });
    config.catalogIdentityPolicyName = "kernel-execution-kernel-catalog-identity";
    try {
      vi.mocked(readPolicyVariables).mockResolvedValueOnce(null);
      expect((await read(admin)).body.catalog).toMatchObject({ writer: "console" });
      vi.mocked(readPolicyVariables).mockResolvedValueOnce({
        variables: {},
        annotations: { "vennir.dev/catalog-release": "r.example/catalog-release@sha256:abc", "vennir.dev/catalog-commit": "c0ffee" },
      });
      expect((await read(admin)).body.catalog).toEqual({ writer: "kernel", release: "r.example/catalog-release@sha256:abc", commit: "c0ffee" });
      // The console only ever reads it.
      expect(readPolicyVariables).toHaveBeenCalledWith("kernel-execution-kernel-catalog-identity");
    } finally {
      config.catalogIdentityPolicyName = "";
    }
  });

  it("shows a failure instead of hiding it", async () => {
    vi.mocked(updateIdentityPolicy).mockRejectedValueOnce(new Error("conflict, five times"));
    const outcome = (await sync(admin)).body.outcomes;
    expect(outcome["identityPolicy"]).toMatchObject({ ok: false, error: "conflict, five times" });
    expect((await read(admin)).body.outcomes["identityPolicy"]?.ok).toBe(false);
  });
});
