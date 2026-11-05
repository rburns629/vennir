// SPDX-License-Identifier: MIT
/**
 * The cluster's copy of the products' released digests and each team's
 * secrets (productPolicy.ts): what each holds, that every change rewrites
 * them, that an earlier release is listed only while it's in use, the
 * legacy list kept only for an upgrade's overlap, and the size limits.
 * Kubernetes is faked: updateIdentityPolicy runs the build the console
 * hands it on what the fake policy says, and keeps what it would have
 * written.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { createTeam, createUser, recordSecretGrant, setUserAdmin } from "../src/db/queries.js";
import { productReleases, products, submittedExecutions, teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller } from "./rpc.js";
import { ensureServiceAccount, updateIdentityPolicy } from "../src/k8s.js";
import {
  admitReleases,
  MAX_MAP_CHARS,
  policyReleases,
  policyTeamSecrets,
  releaseVariables,
  syncIdentityPolicy,
  UPGRADE_OVERLAP_MS,
  type PolicyProduct,
} from "../src/productPolicy.js";

const DIGITS = "0123456789abcdef".split("");
const empty = (): Record<string, string> => ({
  products: "[]",
  teamSecrets: "{}",
  ...Object.fromEntries(DIGITS.map((d) => [`releases${d}`, "{}"])),
});

/** What the fake cluster's policy says now. */
let policy: Record<string, string> = empty();
let writes = 0;

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  updateIdentityPolicy: vi.fn(async (_name: string, build: (current: Record<string, string>) => Promise<Record<string, string>>) => {
    const wanted = await build({ ...policy });
    if (Object.keys(policy).some((key) => wanted[key] !== undefined && wanted[key] !== policy[key])) writes++;
    policy = { ...policy, ...wanted };
    return true;
  }),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
}));

const prefix = `pol-${randomUUID().slice(0, 6)}`;
const email = `${prefix}@example.com`;
let app: FastifyInstance;
let admin: string;
const originalPolicyName = config.identityPolicyName;

const call = caller(() => app);
const register = (body: object) => call(admin, "ProductService/RegisterProduct", body);
const digest = (c: string) => `sha256:${c.repeat(64)}`;

/** This file's entries in the policy now, each with its digest. */
function ours(): (PolicyProduct & { digest: string })[] {
  const all: (PolicyProduct & { digest: string })[] = [];
  for (const d of DIGITS) {
    const map = JSON.parse(policy[`releases${d}`] ?? "{}") as Record<string, PolicyProduct[]>;
    for (const [key, entries] of Object.entries(map)) {
      expect(key.charAt(7)).toBe(d);
      for (const entry of entries) if (entry.repository.includes(prefix)) all.push({ digest: key, ...entry });
    }
  }
  return all;
}

beforeAll(async () => {
  config.identityPolicyName = "kernel-execution-kernel-identity";
  app = await buildApp();
  await app.ready();
  await createTeam(prefix);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  await setUserAdmin(user.id, true);
  admin = app.jwt.sign({ userId: user.id });
});

afterAll(async () => {
  config.identityPolicyName = originalPolicyName;
  await db.delete(submittedExecutions).where(inArray(submittedExecutions.teams, [[prefix]]));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(inArray(teams.name, [prefix]));
  await db.delete(users).where(inArray(users.email, [email]));
  await app.close();
});

beforeEach(() => {
  writes = 0;
  vi.mocked(updateIdentityPolicy).mockClear();
  vi.mocked(ensureServiceAccount).mockClear();
});

describe("policy entries", () => {
  it("list each released digest's products in its first hex digit's map, matched the way the console does", () => {
    const maps = policyReleases([
      {
        image: `registry.example/platform/db:1@${digest("a")}`,
        action: "create",
        serviceAccount: "db-product",
        tokenAudiences: ["sts.amazonaws.com", "api://AzureADTokenExchange"],
        teamName: "team-a",
      },
      { image: `node@${digest("0")}`, action: "run", serviceAccount: null, tokenAudiences: [], teamName: null },
      // Not pinned: never a release that gives an identity.
      { image: "node:20", action: "run", serviceAccount: null, tokenAudiences: [], teamName: null },
    ]);
    expect([...(maps.get("a") ?? [])]).toEqual([
      [
        digest("a"),
        [
          {
            team: "team-a",
            repository: "registry.example/platform/db",
            action: "create",
            serviceAccount: "db-product",
            audiences: "sts.amazonaws.com,api://AzureADTokenExchange",
          },
        ],
      ],
    ]);
    expect([...(maps.get("0") ?? [])]).toEqual([
      [digest("0"), [{ team: "", repository: "docker.io/library/node", action: "run", serviceAccount: "default", audiences: "" }]],
    ]);
    expect(DIGITS.filter((d) => (maps.get(d)?.size ?? 0) > 0)).toEqual(["0", "a"]);
  });

  it("refuse to write a map the API server couldn't compile", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({
      image: `registry.example/team/p${String(i)}@sha256:a${i.toString(16).padStart(63, "0")}`,
      action: "run",
      serviceAccount: null,
      tokenAudiences: [],
      teamName: "team",
    }));
    expect(() => releaseVariables(policyReleases(many))).toThrow(/more than the identity policy holds in one map/);
    const fits = releaseVariables(policyReleases(many.slice(0, 300)));
    expect(fits["releasesa"]?.length).toBeLessThan(MAX_MAP_CHARS);
  });

  it("list each team's secrets, comma-separated", () => {
    expect(
      policyTeamSecrets([
        { teamName: "team-b", secretName: "z" },
        { teamName: "team-a", secretName: "db-key" },
        { teamName: "team-a", secretName: "api-token" },
      ]),
    ).toEqual({ "team-a": "api-token,db-key", "team-b": "z" });
  });
});

describe("syncing", () => {
  it("writes nothing when no policy is configured", async () => {
    config.identityPolicyName = "";
    try {
      expect(await syncIdentityPolicy()).toBe(false);
      expect(updateIdentityPolicy).not.toHaveBeenCalled();
    } finally {
      config.identityPolicyName = "kernel-execution-kernel-identity";
    }
  });

  const product = {
    name: `${prefix}-db-create`,
    image: `example.com/${prefix}/db@${digest("1")}`,
    action: "create",
    team: prefix,
    serviceAccount: "db-product",
    secretRefs: ["db-admin-key"],
  };

  it("adds a product's release when it's registered, and creates its ServiceAccount", async () => {
    expect((await register(product)).code).toBe("ok");
    expect(ours()).toEqual([
      { digest: digest("1"), team: prefix, repository: `example.com/${prefix}/db`, action: "create", serviceAccount: "db-product", audiences: "" },
    ]);
    expect(ensureServiceAccount).toHaveBeenCalledWith(prefix, "db-product");
  });

  it("keeps an earlier release listed while it's in use, and prunes it after", async () => {
    const registered = await register({ ...product, image: `example.com/${prefix}/db@${digest("2")}`, serviceAccount: "db-v2" });
    expect(registered.code).toBe("ok");
    // Registered (used) in the last hour: both, as the product is now.
    expect(ours().map((e) => [e.digest, e.serviceAccount])).toEqual([
      [digest("1"), "db-v2"],
      [digest("2"), "db-v2"],
    ]);
    const [row] = await db.select().from(products).where(eq(products.name, product.name));
    const earlier = await db.select().from(productReleases).where(eq(productReleases.productId, row?.id ?? ""));
    const old = earlier.find((r) => r.image.endsWith(digest("1")));
    await db
      .update(productReleases)
      .set({ lastUsedAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(productReleases.id, old?.id ?? ""));

    // Still run by an execution not yet seen finished: kept.
    const executionId = randomUUID();
    await db.insert(submittedExecutions).values({
      executionId,
      teams: [prefix],
      name: "earlier",
      // As the console submits it: the product's ServiceAccount filled in.
      payload: { tasks: [{ id: "t", team: prefix, image: `example.com/${prefix}/db:1@${digest("1")}`, action: "create", serviceAccount: "db-v2" }] },
    });
    await syncIdentityPolicy();
    expect(ours().map((e) => e.digest)).toEqual([digest("1"), digest("2")]);

    // Finished: pruned; the current one stays.
    await db.update(submittedExecutions).set({ resourcesRecordedAt: new Date() }).where(eq(submittedExecutions.executionId, executionId));
    await syncIdentityPolicy();
    expect(ours().map((e) => e.digest)).toEqual([digest("2")]);
  });

  it("keeps an earlier release in use only for the product a running step runs as", async () => {
    // Two products released at one digest (one image, two actions), and a
    // platform product; each since released again, its earlier release
    // last used two hours ago.
    const shared = `example.com/${prefix}/shared`;
    const platform = `example.com/${prefix}/platform`;
    const a = { name: `${prefix}-a`, action: "run", team: prefix, serviceAccount: "a-sa" };
    const b = { name: `${prefix}-b`, action: "check", team: prefix, serviceAccount: "b-sa" };
    const p = { name: `${prefix}-p`, action: "run" };
    for (const [product, image] of [[a, shared], [b, shared], [p, platform]] as const) {
      expect((await register({ ...product, image: `${image}@${digest("3")}` })).code).toBe("ok");
      expect((await register({ ...product, image: `${image}@${digest("4")}` })).code).toBe("ok");
    }
    const ids = (await db.select().from(products).where(inArray(products.name, [a.name, b.name, p.name]))).map((r) => r.id);
    await db
      .update(productReleases)
      .set({ lastUsedAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(and(inArray(productReleases.productId, ids), like(productReleases.image, `%${digest("3")}`)));
    const earlier = () =>
      ours()
        .filter((e) => e.digest === digest("3"))
        .map((e) => `${e.repository.split("/").at(-1) ?? ""} ${e.action} ${e.serviceAccount}`)
        .sort();

    const executionId = randomUUID();
    const running = async (...tasks: Record<string, unknown>[]) => {
      await db.delete(submittedExecutions).where(eq(submittedExecutions.executionId, executionId));
      await db.insert(submittedExecutions).values({ executionId, teams: [prefix], name: "earlier", payload: { tasks } });
      await syncIdentityPolicy();
      return earlier();
    };
    const step = (task: Record<string, unknown>) => ({ id: "t", team: prefix, image: `${shared}:1@${digest("3")}`, action: "run", serviceAccount: "a-sa", ...task });
    try {
      // A's step keeps A's release, not B's of the same digest.
      expect(await running(step({}))).toEqual(["shared run a-sa"]);
      // The same digest as neither: another action, ServiceAccount, team or repository.
      expect(await running(step({ action: "other" }))).toEqual([]);
      expect(await running(step({ serviceAccount: "b-sa" }))).toEqual([]);
      expect(await running(step({ serviceAccount: undefined }))).toEqual([]);
      expect(await running(step({ team: `${prefix}-other` }))).toEqual([]);
      expect(await running(step({ image: `example.com/${prefix}/elsewhere@${digest("3")}` }))).toEqual([]);
      // Both products' steps: both.
      expect(await running(step({}), step({ id: "u", action: "check", serviceAccount: "b-sa" }))).toEqual(["shared check b-sa", "shared run a-sa"]);
      // A platform product's, in any team's namespace, as "default".
      expect(await running(step({ image: `${platform}@${digest("3")}`, team: `${prefix}-other`, serviceAccount: undefined }))).toEqual(["platform run default"]);
      // Not a step at all: nothing, and no error.
      expect(await running("not a step" as unknown as Record<string, unknown>, {})).toEqual([]);
    } finally {
      await db.delete(submittedExecutions).where(eq(submittedExecutions.executionId, executionId));
      await db.delete(products).where(inArray(products.id, ids));
    }
  });

  it("lists a release a submission is about to run, waiting for the cluster, and writes nothing when it's there", async () => {
    // Pruned above; a submission marks it used first (core/executions.ts).
    const [row] = await db.select().from(products).where(eq(products.name, product.name));
    await db.update(productReleases).set({ lastUsedAt: new Date() }).where(eq(productReleases.productId, row?.id ?? ""));
    const use = (d: string, action = "create") => ({ digest: digest(d), team: prefix, repository: `example.com/${prefix}/db`, action, serviceAccount: "db-v2" });
    expect(await admitReleases([use("1")])).toEqual([]);
    expect(writes).toBe(1);
    expect(vi.mocked(updateIdentityPolicy).mock.lastCall?.[2]).toEqual({ settle: true });
    expect(ours().map((e) => e.digest)).toEqual([digest("1"), digest("2")]);
    writes = 0;
    expect(await admitReleases([use("1"), use("2")])).toEqual([]);
    expect(writes).toBe(0);
    // One nothing released: still not listed.
    expect(await admitReleases([use("9")])).toEqual([digest("9")]);
    // A listed digest, but not as this product's entry (another action of
    // the same image): not admitted, though the digest is listed.
    expect(await admitReleases([use("1", "delete")])).toEqual([digest("1")]);
    // Nor for a step in another team's namespace: the entry is this team's.
    expect(await admitReleases([{ ...use("1"), team: `${prefix}-other` }])).toEqual([digest("1")]);
  });

  it("writes each team's registered secrets with the releases", async () => {
    const [team] = await db.select().from(teams).where(inArray(teams.name, [prefix]));
    await recordSecretGrant({ teamId: team?.id ?? "", secretName: "db-admin-key", keys: ["value"], source: "literal" });
    await syncIdentityPolicy();
    expect(JSON.parse(policy["teamSecrets"] ?? "{}")).toMatchObject({ [prefix]: "db-admin-key" });
  });

  it("drops its releases when it's deleted", async () => {
    expect((await call(admin, "ProductService/DeleteProduct", { name: product.name })).code).toBe("ok");
    expect(updateIdentityPolicy).toHaveBeenCalledOnce();
    expect(ours()).toEqual([]);
  });

  it("drops a team's releases when the team is retired", async () => {
    expect((await register(product)).code).toBe("ok");
    expect(ours()).toHaveLength(1);
    expect((await call(admin, "TeamService/RetireTeam", { name: prefix })).code).toBe("ok");
    expect(ours()).toEqual([]);
  });

  it("fails the change if the cluster can't be updated", async () => {
    vi.mocked(updateIdentityPolicy).mockRejectedValueOnce(new Error("API server unreachable"));
    const registered = await register({ ...product, team: null, name: `${prefix}-platform`, image: `example.com/${prefix}/platform@${digest("3")}` });
    expect(registered.code).toBe("internal");
  });
});

describe("an upgraded install's legacy list (by repository)", () => {
  const legacy = JSON.stringify([{ team: "t", repository: "example.com/t/x", action: "run", serviceAccount: "x", audiences: "" }]);

  it("is kept while consoles from before may still be writing it, then emptied", async () => {
    policy = { ...policy, products: legacy };
    await syncIdentityPolicy();
    expect(policy["products"]).toBe(legacy);
    const now = Date.now();
    const later = vi.spyOn(Date, "now").mockReturnValue(now + UPGRADE_OVERLAP_MS + 1000);
    try {
      await syncIdentityPolicy();
    } finally {
      later.mockRestore();
    }
    expect(policy["products"]).toBe("[]");
    // And never filled again.
    await syncIdentityPolicy();
    expect(policy["products"]).toBe("[]");
  });
});
