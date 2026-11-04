// SPDX-License-Identifier: MIT
/**
 * SecretService through Connect: a team's members alone touch its secrets,
 * reserved names are refused, a value is written to the cluster but never
 * audited or returned, and an unset optional field reaches the cluster as
 * absent. The rules are tested in depth
 * (secrets.test.ts), through the same core/secrets.ts.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam } from "../src/db/queries.js";
import { auditLog, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { upsertExternalSecretGrant, upsertSecretGrant } from "../src/k8s.js";
import { failureCode, rpcClient, type RpcError } from "./rpc.js";

vi.mock("../src/productPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/productPolicy.js")>()),
  syncIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  upsertSecretGrant: vi.fn(() => Promise.resolve()),
  upsertExternalSecretGrant: vi.fn(() => Promise.resolve()),
  deleteSecretGrant: vi.fn(() => Promise.resolve()),
  listExternalSecrets: vi.fn(() => Promise.resolve([])),
}));

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
const prefix = `rpc-sec-${randomUUID().slice(0, 6)}`;
let team: { id: string; name: string };
let member: { id: string; email: string };
let token: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  team = await createTeam(`${prefix}-a`);
  member = await makeUser();
  await addTeamMember(member.id, team.id);
  token = await signIn(member.email);
});

afterAll(async () => {
  await app.close();
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await cleanUp();
});

describe("SecretService", () => {
  it("writes a member's pasted secret, lists it by name only, and audits no value", async () => {
    const value = `value-${randomUUID()}`;
    const put = await rpc("SecretService", "PutSecret", { team: team.name, secretName: "api-key", data: { value } }, { token });
    expect(put.statusCode).toBe(200);
    expect(vi.mocked(upsertSecretGrant)).toHaveBeenLastCalledWith(
      expect.objectContaining({ namespace: team.name, secretName: "api-key", data: { value } }),
    );

    const listed = await rpc("SecretService", "ListSecrets", { team: team.name }, { token });
    const secrets = listed.json<{ secrets: { secretName: string; keys: string[]; source: string }[] }>().secrets;
    expect(secrets).toContainEqual(expect.objectContaining({ secretName: "api-key", keys: ["value"], source: "SECRET_SOURCE_LITERAL" }));
    expect(listed.body).not.toContain(value);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, member.id), eq(auditLog.route, "vennir.console.v1.SecretService/PutSecret")))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(entry?.target).toMatchObject({ team: team.name, secretName: "api-key" });
    expect(JSON.stringify(entry)).not.toContain(value);
  });

  it("keeps everyone else out", async () => {
    const outsider = await signIn((await makeUser()).email);
    for (const [method, body] of [
      ["ListSecrets", { team: team.name }],
      ["PutSecret", { team: team.name, secretName: "x", data: { value: "x" } }],
      ["RevokeSecret", { team: team.name, secretName: "api-key" }],
    ] as const) {
      const response = await rpc("SecretService", method, body, { token: outsider });
      expect(response.statusCode).toBe(403);
    }
  });

  it("refuses the reserved names", async () => {
    for (const secretName of ["eso-auth", "vennir-pull"]) {
      const response = await rpc("SecretService", "PutSecret", { team: team.name, secretName, data: { value: "x" } }, { token });
      expect(response.json<RpcError>().code).toBe("invalid_argument");
      expect(failureCode(response.json<RpcError>())).toBe("UNPROCESSABLE_ENTITY");
    }
  });

  it("checks names and values, every problem at once", async () => {
    const response = await rpc("SecretService", "PutSecret", { team: team.name, secretName: "Not_Valid", data: {} }, { token });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
  });

  it("syncs from a store, an unset property absent rather than empty", async () => {
    const response = await rpc(
      "SecretService",
      "SyncSecret",
      { team: team.name, secretName: "db", secretStoreName: "vault", keys: [{ secretKey: "password", remoteKey: "db/password" }] },
      { token },
    );
    expect(response.statusCode).toBe(200);
    const call = vi.mocked(upsertExternalSecretGrant).mock.lastCall?.[0];
    expect(call?.keys).toEqual([{ secretKey: "password", remoteKey: "db/password" }]);
  });

  it("revokes", async () => {
    const response = await rpc("SecretService", "RevokeSecret", { team: team.name, secretName: "api-key" }, { token });
    expect(response.statusCode).toBe(200);
    const again = await rpc("SecretService", "RevokeSecret", { team: team.name, secretName: "api-key" }, { token });
    expect(again.statusCode).toBe(404);
  });
});
