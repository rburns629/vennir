// SPDX-License-Identifier: MIT
/**
 * ProductService through Connect: catalog CI's products:register token or
 * an admin registers a team's products (never its maintainers), platform
 * products are admins', a name or repository another team owns is refused, and the
 * wiring types are replaced only by whoever may register products. The
 * rules are tested in depth elsewhere, through the same
 * core/products.ts.
 */
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam } from "../src/db/queries.js";
import { imageRepositories, products, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { failureCode, rpcClient, type RpcError } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
}));
vi.mock("../src/productPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/productPolicy.js")>()),
  syncIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
const prefix = `rpc-prd-${randomUUID().slice(0, 6)}`;
const registry = `registry.example/${prefix}`;
let ours: { id: string; name: string };
let theirs: { id: string; name: string };
let token: string;
let adminToken: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  ours = await createTeam(`${prefix}-ours`);
  theirs = await createTeam(`${prefix}-theirs`);
  const member = await makeUser();
  await addTeamMember(member.id, ours.id);
  token = await signIn(member.email);
  adminToken = await signIn((await makeUser({ admin: true })).email);
});

afterAll(async () => {
  await app.close();
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(imageRepositories).where(like(imageRepositories.repository, `${registry}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await cleanUp();
});

const registration = (overrides: object = {}) => ({
  name: `${prefix}-greet`,
  image: `${registry}/ours/greet:latest`,
  action: "greet",
  team: ours.name,
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
  outputSchema: { type: "object" },
  displayName: "Greet",
  serviceAccount: "greeter",
  secretRefs: ["api-key"],
  resources: { cpu: "250m", memory: "256Mi" },
  ...overrides,
});

describe("ProductService", () => {
  it("refuses a team's maintainer: products come from the catalog, or an admin", async () => {
    const response = await rpc("ProductService", "RegisterProduct", registration(), { token });
    expect(response.statusCode).toBe(403);
    expect(response.json<RpcError>().message).toContain("catalog");
  });

  it("registers a team's product, as an admin, and lists it to its members, schemas and all", async () => {
    const response = await rpc("ProductService", "RegisterProduct", registration(), { token: adminToken });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ product: { teamId: string } }>().product.teamId).toBe(ours.id);

    const listed = await rpc("ProductService", "ListProducts", {}, { token });
    const found = listed
      .json<{ products: { name: string; inputSchema: object; serviceAccount: string; resources: object; teamName: string }[] }>()
      .products.find((p) => p.name === `${prefix}-greet`);
    expect(found).toMatchObject({
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      serviceAccount: "greeter",
      resources: { cpu: "250m", memory: "256Mi" },
      teamName: ours.name,
    });
  });

  it("keeps other teams' products, and platform products, out of a member's reach", async () => {
    const theirsResponse = await rpc(
      "ProductService",
      "RegisterProduct",
      registration({ name: `${prefix}-x`, team: theirs.name, image: `${registry}/theirs/x:1` }),
      { token },
    );
    expect(theirsResponse.statusCode).toBe(403);

    const platform = await rpc(
      "ProductService",
      "RegisterProduct",
      registration({ name: `${prefix}-p`, team: undefined, image: `${registry}/platform/p:1` }),
      { token },
    );
    expect(platform.statusCode).toBe(403);
    expect(platform.json<RpcError>().message).toContain("platform product");
  });

  it("refuses a repository another team owns", async () => {
    const admin = await signIn((await makeUser({ admin: true })).email);
    const response = await rpc(
      "ProductService",
      "RegisterProduct",
      registration({ name: `${prefix}-steal`, team: theirs.name }),
      { token: admin },
    );
    expect(response.json<RpcError>().code).toBe("failed_precondition");
    expect(failureCode(response.json<RpcError>())).toBe("CONFLICT");
  });

  it("refuses a product a ServiceAccount ending in -api: an API's, whose tokens the gateway mints", async () => {
    const response = await rpc("ProductService", "RegisterProduct", registration({ name: `${prefix}-sneaky`, serviceAccount: "orders-api" }), { token: adminToken });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
    expect(response.json<RpcError>().message).toContain("-api");
  });

  it("checks a registration", async () => {
    const response = await rpc(
      "ProductService",
      "RegisterProduct",
      registration({ name: `${prefix}-bad`, serviceAccount: "Not A Name", resources: { cpu: "lots" } }),
      { token },
    );
    expect(response.json<RpcError>().code).toBe("invalid_argument");
  });

  it("deletes a product for an admin, never for a team's maintainer", async () => {
    expect((await rpc("ProductService", "DeleteProduct", { name: `${prefix}-greet` }, { token })).statusCode).toBe(403);
    expect((await rpc("ProductService", "DeleteProduct", { name: `${prefix}-greet` }, { token: adminToken })).statusCode).toBe(200);
  });

  it("lets only admins or products:register replace the wiring types", async () => {
    const response = await rpc(
      "ProductService",
      "ReplaceWiringTypes",
      { types: { "gcp.project": { jsonType: "string", description: "A project id.", shared: true } } },
      { token },
    );
    expect(response.statusCode).toBe(403);
  });
});
