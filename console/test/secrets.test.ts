// SPDX-License-Identifier: MIT
/**
 * Registering and revoking secrets (core/secrets.ts, SecretService): who may, which names,
 * and what reaches the cluster. Kubernetes is faked; what k8s.ts then does
 * to the cluster (labels, pruning old bindings) is proven on kind.
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import {
  addTeamMember,
  createTeam,
  createUser,
  isSecretRegistered,
  recordSecretGrant,
  setTeamRetired,
} from "../src/db/queries.js";
import { teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { SecretNotManagedError, deleteSecretGrant, upsertExternalSecretGrant, upsertSecretGrant } from "../src/k8s.js";
import { syncIdentityPolicy } from "../src/productPolicy.js";
import { caller } from "./rpc.js";

// The cluster's copy of every team's secret names; here, recorded.
vi.mock("../src/productPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/productPolicy.js")>()),
  syncIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  upsertSecretGrant: vi.fn(() => Promise.resolve()),
  upsertExternalSecretGrant: vi.fn(() => Promise.resolve()),
  deleteSecretGrant: vi.fn(() => Promise.resolve()),
}));

const prefix = `sec-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let ours: { id: string; name: string };
let theirs: { id: string; name: string };
let member: string;

const call = caller(() => app);
const put = (body: object) => call(member, "SecretService/PutSecret", body);
const revoke = (team: string, secretName: string, token = member) => call(token, "SecretService/RevokeSecret", { team, secretName });

const literal = (fields: Record<string, unknown> = {}) => ({
  team: ours.name,
  secretName: "db-key",
  data: { value: "x" },
  ...fields,
});

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  ours = await createTeam(`${prefix}-ours`);
  theirs = await createTeam(`${prefix}-theirs`);
  const email = `${prefix}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  await addTeamMember(user.id, ours.id);
  member = app.jwt.sign({ userId: user.id });
});

afterAll(async () => {
  await db.delete(teams).where(inArray(teams.name, [ours.name, theirs.name]));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

beforeEach(() => {
  vi.mocked(upsertSecretGrant).mockClear();
  vi.mocked(deleteSecretGrant).mockClear();
  vi.mocked(syncIdentityPolicy).mockClear();
});

describe("registering", () => {
  it("refuses another team's namespace", async () => {
    expect((await put(literal({ team: theirs.name }))).code).toBe("permission_denied");
    expect(upsertSecretGrant).not.toHaveBeenCalled();
  });

  it.each(["DB_KEY", "db key", "-db", "a".repeat(121)])("refuses a secret named %j", async (secretName) => {
    expect((await put(literal({ secretName }))).code).toBe("invalid_argument");
    expect(upsertSecretGrant).not.toHaveBeenCalled();
  });

  it("registers a secret for the whole team, and tells the cluster", async () => {
    expect((await put(literal({ secretName: "team-key" }))).code).toBe("ok");
    expect(await isSecretRegistered(ours.id, "team-key")).toBe(true);
    expect(syncIdentityPolicy).toHaveBeenCalledOnce();
  });

  it("ignores fields it doesn't know, like the ServiceAccount older clients sent", async () => {
    expect((await put(literal({ secretName: "old-client", serviceAccountName: "db-product" }))).code).toBe("ok");
    expect(await isSecretRegistered(ours.id, "old-client")).toBe(true);
  });

  it("says when the name belongs to a Secret the console didn't create", async () => {
    vi.mocked(upsertSecretGrant).mockRejectedValueOnce(new SecretNotManagedError("taken"));
    expect((await put(literal({ secretName: "store-credentials" }))).code).toBe("failed_precondition");
    expect(await isSecretRegistered(ours.id, "store-credentials")).toBe(false);
  });

  it("leaves no record behind when the cluster write fails", async () => {
    vi.mocked(upsertSecretGrant).mockRejectedValueOnce(new Error("API server unreachable"));
    expect((await put(literal({ secretName: "unwritten" }))).code).toBe("internal");
    expect(await isSecretRegistered(ours.id, "unwritten")).toBe(false);
  });

  it("tells the cluster when the team already has the grant, so its Secret may be replaced", async () => {
    await put(literal({ secretName: "new-key" }));
    expect(vi.mocked(upsertSecretGrant).mock.calls[0]?.[0]).toMatchObject({ alreadyGranted: false });

    await recordSecretGrant({ teamId: ours.id, secretName: "old-key", keys: ["value"], source: "literal" });
    await put(literal({ secretName: "old-key" }));
    expect(vi.mocked(upsertSecretGrant).mock.calls[1]?.[0]).toMatchObject({ alreadyGranted: true });
  });

  it("refuses switching a secret between pasted and synced until it's revoked", async () => {
    await recordSecretGrant({ teamId: ours.id, secretName: "synced-key", keys: ["value"], source: "external" });
    const pasted = await put(literal({ secretName: "synced-key" }));
    expect(pasted.code).toBe("failed_precondition");
    expect(JSON.stringify(pasted.body)).toContain("Revoke it first");
    expect(upsertSecretGrant).not.toHaveBeenCalled();

    await recordSecretGrant({ teamId: ours.id, secretName: "pasted-key", keys: ["value"], source: "literal" });
    vi.mocked(upsertExternalSecretGrant).mockClear();
    const synced = await call(member, "SecretService/SyncSecret", {
      team: ours.name,
      secretName: "pasted-key",
      secretStoreName: "vault",
      keys: [{ secretKey: "value", remoteKey: "db/key" }],
    });
    expect(synced.code).toBe("failed_precondition");
    expect(upsertExternalSecretGrant).not.toHaveBeenCalled();
  });
});

describe("revoking", () => {
  it("removes the grant, from the cluster first", async () => {
    await recordSecretGrant({ teamId: ours.id, secretName: "to-revoke", keys: ["value"], source: "literal" });
    expect((await revoke(ours.name, "to-revoke")).code).toBe("ok");
    expect(deleteSecretGrant).toHaveBeenCalledWith(ours.name, "to-revoke", "literal");
    expect(await isSecretRegistered(ours.id, "to-revoke")).toBe(false);
    expect(syncIdentityPolicy).toHaveBeenCalledOnce();
  });

  it("keeps the grant on record if the cluster couldn't be updated", async () => {
    await recordSecretGrant({ teamId: ours.id, secretName: "sticky", keys: ["value"], source: "literal" });
    vi.mocked(deleteSecretGrant).mockRejectedValueOnce(new Error("API server unreachable"));
    expect((await revoke(ours.name, "sticky")).code).toBe("internal");
    expect(await isSecretRegistered(ours.id, "sticky")).toBe(true);
  });

  it("refuses another team's secret", async () => {
    await recordSecretGrant({ teamId: theirs.id, secretName: "theirs", keys: ["value"], source: "literal" });
    expect((await revoke(theirs.name, "theirs")).code).toBe("permission_denied");
    expect(deleteSecretGrant).not.toHaveBeenCalled();
  });

  it("says when there's no such secret", async () => {
    expect((await revoke(ours.name, "never-registered")).code).toBe("not_found");
  });

  it("leaves a retired team's secrets alone", async () => {
    const retired = await createTeam(`${prefix}-retired`);
    const email = `${prefix}-r@example.com`;
    emails.push(email);
    const user = await createUser(email, await hashPassword("correct-horse-battery"));
    await addTeamMember(user.id, retired.id);
    await recordSecretGrant({ teamId: retired.id, secretName: "kept", keys: ["value"], source: "literal" });
    await setTeamRetired(retired.id, true);
    const revoked = await revoke(retired.name, "kept", app.jwt.sign({ userId: user.id }));
    expect(revoked.failure).toBe("TEAM_RETIRED");
    await db.delete(teams).where(inArray(teams.name, [retired.name]));
  });
});
