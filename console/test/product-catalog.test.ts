// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateApiToken, hashApiToken } from "../src/auth/apiToken.js";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createApiToken, createBotUser, createTeam, createUser, setUserAdmin } from "../src/db/queries.js";
import { products, teams, users, wiringTypes } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller } from "./rpc.js";
import { lockWiringTypes } from "./wiringTypesLock.js";

// Registering a team's product creates its ServiceAccount in the team's
// namespace (test/product-policy.test.ts checks that); not here.
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
}));

// What catalog CI registers about a product beyond its image (the
// catalog's tools/product.schema.json), and its wiring vocabulary.

const prefix = `cat-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;
let member: string;
let catalogCi: string;
let unlock: () => Promise<void>;

const call = caller(() => app);
const register = (token: string, body: object) => call(token, "ProductService/RegisterProduct", body);
const replaceTypes = (token: string, types: object) => call(token, "ProductService/ReplaceWiringTypes", { types });
const readTypes = async () =>
  (await call<{ types: { name: string; defaultProvider?: string }[] }>(member, "ProductService/ListWiringTypes")).body.types;

async function newUser(isAdmin: boolean): Promise<string> {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (isAdmin) await setUserAdmin(user.id, true);
  return app.jwt.sign({ userId: user.id });
}

interface Listed {
  name: string;
  shareWith?: string[];
  deprecated?: string;
  inputSchema?: Record<string, unknown>;
  displayName?: string;
  description?: string;
  outputSchema?: Record<string, unknown>;
  serviceAccount?: string;
  secretRefs: string[];
  resources?: Record<string, string>;
}

async function listed(name: string): Promise<Listed | undefined> {
  return (await call<{ products: Listed[] }>(admin, "ProductService/ListProducts")).body.products.find((p) => p.name === name);
}

const INPUT = { type: "object", additionalProperties: false, properties: { instanceName: { type: "string", title: "Instance name" } } };
const OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: { connection: { type: "string", title: "Connection", "x-vennir-provides": "gcp.cloudsql.connection" } },
};

beforeAll(async () => {
  unlock = await lockWiringTypes();
  app = await buildApp();
  await app.ready();
  await createTeam(prefix);
  admin = await newUser(true);
  member = await newUser(false);
  const botEmail = `${prefix}-ci@bots.vennir.local`;
  emails.push(botEmail);
  const { user: bot } = await createBotUser(botEmail);
  const token = generateApiToken();
  await createApiToken(bot.id, "catalog CI", hashApiToken(token), ["products:register"]);
  catalogCi = token;
});

afterAll(async () => {
  await db.delete(wiringTypes);
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(inArray(teams.name, [prefix]));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
  await unlock();
});

describe("registering a product's full description", () => {
  const name = `${prefix}-db-create`;
  const full = {
    name,
    image: `example.com/${prefix}/db:1`,
    action: "create",
    team: prefix,
    inputSchema: INPUT,
    displayName: "Database",
    description: "A database instance.",
    outputSchema: OUTPUT,
    serviceAccount: "db-product",
    secretRefs: ["db-admin-key"],
    resources: { cpu: "250m", memory: "512Mi", memoryLimit: "1Gi" },
  };

  it("stores and lists everything catalog CI sends", async () => {
    expect((await register(catalogCi, full)).code).toBe("ok");
    expect(await listed(name)).toMatchObject({
      inputSchema: INPUT,
      displayName: "Database",
      description: "A database instance.",
      outputSchema: OUTPUT,
      serviceAccount: "db-product",
      secretRefs: ["db-admin-key"],
      resources: { cpu: "250m", memory: "512Mi", memoryLimit: "1Gi" },
    });
  });

  it("refuses a size that isn't a Kubernetes quantity", async () => {
    for (const resources of [{ cpu: "lots" }, { memory: "512 MiB" }, { memoryLimit: "-1" }]) {
      expect((await register(catalogCi, { ...full, resources })).code).toBe("invalid_argument");
    }
  });

  it("drops resource kinds it doesn't know (as protobuf ignores unknown fields)", async () => {
    expect((await register(catalogCi, { ...full, resources: { cpu: "100m", gpu: "1" } })).code).toBe("ok");
    expect((await listed(name))?.resources).toEqual({ cpu: "100m" });
  });

  it("keeps what's stored when a later registration leaves fields out", async () => {
    const registered = await register(catalogCi, { name, image: `example.com/${prefix}/db:2`, action: "create", team: prefix });
    expect(registered.code).toBe("ok");
    expect(await listed(name)).toMatchObject({ inputSchema: INPUT, outputSchema: OUTPUT, serviceAccount: "db-product" });
  });

  it("gives a product registered without them empty values, not an error", async () => {
    const bare = `${prefix}-bare-create`;
    const registered = await register(admin, { name: bare, image: `example.com/${prefix}/bare:1`, action: "create", team: prefix });
    expect(registered.code).toBe("ok");
    const product = await listed(bare);
    expect(product).toMatchObject({ inputSchema: {}, outputSchema: {}, secretRefs: [] });
    expect(product?.displayName).toBeUndefined();
    expect(product?.serviceAccount).toBeUndefined();
  });

  it("replaces secretRefs, shareWith and deprecated on every registration: it's the whole product.yaml", async () => {
    const shared = `${prefix}-shared-create`;
    const base = { name: shared, image: `example.com/${prefix}/shared:1`, action: "create", team: prefix };
    const first = await register(catalogCi, {
      ...base,
      secretRefs: ["db-admin-key"],
      shareWith: ["web", "*"],
      deprecated: "Use db.provision instead.",
    });
    expect(first.code).toBe("ok");
    expect(await listed(shared)).toMatchObject({
      secretRefs: ["db-admin-key"],
      shareWith: ["web", "*"],
      deprecated: "Use db.provision instead.",
    });

    expect((await register(catalogCi, base)).code).toBe("ok");
    expect(await listed(shared)).toMatchObject({ secretRefs: [], shareWith: [], deprecated: "" });
  });

  it("refuses a shareWith entry that isn't a team name or *", async () => {
    expect((await register(catalogCi, { ...full, shareWith: ["Not A Team"] })).code).toBe("invalid_argument");
  });

  it("refuses names Kubernetes wouldn't accept", async () => {
    for (const bad of [{ serviceAccount: "Bad_Name" }, { secretRefs: ["ok", "Not OK"] }]) {
      expect((await register(catalogCi, { ...full, ...bad })).code).toBe("invalid_argument");
    }
  });
});

describe("the wiring types", () => {
  const types = {
    "gcp.project": { jsonType: "string", description: "A project id.", shared: true, defaultProvider: "gcp/project.create" },
    "gcp.region": { jsonType: "string", description: "A region.", shared: true },
  };

  it("can be replaced by catalog CI and read by anyone signed in", async () => {
    expect((await replaceTypes(catalogCi, types)).code).toBe("ok");
    const read = await readTypes();
    expect(read.map((t) => t.name)).toEqual(["gcp.project", "gcp.region"]);
    expect(read[0]?.defaultProvider).toBe("gcp/project.create");
    expect(read[1]?.defaultProvider).toBeUndefined();
  });

  it("is replaced as a whole: a type left out is removed", async () => {
    await replaceTypes(catalogCi, { "gcp.region": types["gcp.region"] });
    expect((await readTypes()).map((t) => t.name)).toEqual(["gcp.region"]);
  });

  it("can't be changed by an ordinary user", async () => {
    expect((await replaceTypes(member, types)).code).toBe("permission_denied");
  });

  it("refuses malformed types, without touching the stored ones", async () => {
    for (const bad of [
      {},
      { Project: types["gcp.project"] },
      { "gcp.project": { ...types["gcp.project"], jsonType: "object" } },
      { "gcp.project": { ...types["gcp.project"], defaultProvider: "not a provider" } },
    ]) {
      expect((await replaceTypes(admin, bad)).code, JSON.stringify(bad)).toBe("invalid_argument");
    }
    expect((await readTypes()).map((t) => t.name)).toEqual(["gcp.region"]);
  });
});
