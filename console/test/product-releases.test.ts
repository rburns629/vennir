// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { createTeam, createUser, findTeamByName, setUserAdmin, upsertProduct } from "../src/db/queries.js";
import { productReleases, products, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { config } from "../src/config.js";
import { pinRegisteredTags } from "../src/productPolicy.js";
import { caller } from "./rpc.js";

// The registry, for registrations by tag with pinning on: example/app:pinned
// names one digest; nothing else resolves.
const PINNED_DIGEST = `sha256:${"7".repeat(64)}`;
vi.mock("../src/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/registry.js")>()),
  pinImages: vi.fn((images: string[]) =>
    Promise.resolve({
      pinned: new Map(images.filter((i) => i.endsWith(":pinned")).map((i) => [i, `${i}@${PINNED_DIGEST}`])),
      unresolved: images.filter((i) => !i.endsWith(":pinned")),
    }),
  ),
}));

vi.mock("../src/imagePolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/imagePolicy.js")>()),
  readImagePolicy: vi.fn(() => Promise.resolve({ exists: true, source: "docker.io/", additional: [], version: "1" })),
}));

const prefix = `rel-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;

interface Listed {
  name: string;
  teamName?: string;
  image: string;
  releases: { image: string; registeredAt: string }[];
}

const call = caller(() => app);

function register(image: string) {
  return call(admin, "ProductService/RegisterProduct", { name: `${prefix}-product`, image, action: "create", team: prefix });
}

async function listed(): Promise<Listed> {
  const response = await call<{ products: Listed[] }>(admin, "ProductService/ListProducts");
  const product = response.body.products.find((p) => p.name === `${prefix}-product`);
  if (!product) throw new Error("product not listed");
  return product;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const email = `${prefix}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  await setUserAdmin(user.id, true);
  admin = app.jwt.sign({ userId: user.id });
  await createTeam(prefix);
});

afterAll(async () => {
  await app.close();
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
});

describe("product release history", () => {
  it("records each distinct image as a release, newest first", async () => {
    expect((await register("example/app:aaa")).code).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await register("example/app:bbb")).code).toBe("ok");

    const product = await listed();
    expect(product.teamName).toBe(prefix);
    expect(product.image).toBe("example/app:bbb");
    expect(product.releases.map((r) => r.image)).toEqual(["example/app:bbb", "example/app:aaa"]);
  });

  it("doesn't duplicate or re-date a release when the same image is registered again", async () => {
    const before = await listed();
    expect((await register("example/app:bbb")).code).toBe("ok");
    expect((await listed()).releases).toEqual(before.releases);
  });

  it("keeps the history when an older image becomes current again (a rollback)", async () => {
    expect((await register("example/app:aaa")).code).toBe("ok");
    const product = await listed();
    // The current image is what `latest` means, not the newest date.
    expect(product.image).toBe("example/app:aaa");
    expect(product.releases.map((r) => r.image)).toEqual(["example/app:bbb", "example/app:aaa"]);
  });
});

describe("registering by tag", () => {
  it("records the digest the tag names, which a step's identity is tied to", async () => {
    config.imagePinning = "required";
    try {
      expect((await register("example/app:pinned")).code).toBe("ok");
      const product = await listed();
      expect(product.image).toBe(`example/app:pinned@${PINNED_DIGEST}`);
      expect(product.releases[0]?.image).toBe(`example/app:pinned@${PINNED_DIGEST}`);
    } finally {
      config.imagePinning = "off";
    }
  });

  it("refuses a tag the registry can't resolve, and registers nothing", async () => {
    config.imagePinning = "required";
    try {
      const before = await listed();
      const refused = await register("example/app:moving");
      expect(refused.code).toBe("invalid_argument");
      expect(refused.message).toContain("couldn't ask the registry which image example/app:moving is");
      expect((await listed()).releases).toEqual(before.releases);
    } finally {
      config.imagePinning = "off";
    }
  });
});

describe("products registered by tag before identities were tied to digests", () => {
  it("are pinned at startup to the digest their tag names, as a release; one that won't resolve keeps its tag", async () => {
    const team = await findTeamByName(prefix);
    await upsertProduct({ name: `${prefix}-old`, image: "example/old:pinned", action: "run", teamId: team?.id ?? null });
    await upsertProduct({ name: `${prefix}-gone`, image: "example/gone:moving", action: "run", teamId: team?.id ?? null });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof pinRegisteredTags>[0];
    config.imagePinning = "required";
    try {
      expect(await pinRegisteredTags(log)).toBeGreaterThanOrEqual(1);
    } finally {
      config.imagePinning = "off";
    }
    const [old] = await db.select().from(products).where(eq(products.name, `${prefix}-old`));
    expect(old?.image).toBe(`example/old:pinned@${PINNED_DIGEST}`);
    const releases = await db.select().from(productReleases).where(eq(productReleases.productId, old?.id ?? ""));
    expect(releases.map((r) => r.image).sort()).toEqual(["example/old:pinned", `example/old:pinned@${PINNED_DIGEST}`]);
    const [gone] = await db.select().from(products).where(eq(products.name, `${prefix}-gone`));
    expect(gone?.image).toBe("example/gone:moving");
  });
});
