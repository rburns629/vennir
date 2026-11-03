// SPDX-License-Identifier: MIT
/**
 * Pull-based catalog registration (src/catalogSync.ts): a release read from
 * the registry is applied as catalog CI's old token would have, an item that
 * fails doesn't stop the rest, a release applied isn't applied again, what a
 * later release drops is unregistered or retired (never purged), a release
 * no trusted signer signed is refused whole, an install following versions
 * applies the newest (or the one it pins), a team the catalog didn't make
 * is left alone until an admin adopts it, and only admins see or start a
 * sync. The registry read and the cluster writes are stubbed; the rest is
 * the real console on the real test database.
 */
import { randomUUID } from "node:crypto";
import { create, toJsonString, type MessageInitShape } from "@bufbuild/protobuf";
import { eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { newestVersion, syncCatalog } from "../src/catalogSync.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { createTeam } from "../src/db/queries.js";
import { auditLog, catalogSync, products, teams, templates, wiringTypes } from "../src/db/schema.js";
import { ReleaseSchema, type Release } from "../src/gen/vertra/catalog/v1/release_pb.js";
import { buildApp } from "../src/index.js";
import { applySecretStoreObjects, createVerifyJob, ExternalSecretsMissingError, readScanJob } from "../src/k8s.js";
import { fetchRelease, listTags } from "../src/registry.js";
import { caller, rpcClient } from "./rpc.js";
import { lockWiringTypes } from "./wiringTypesLock.js";

vi.mock("../src/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/registry.js")>()),
  fetchRelease: vi.fn(),
  listTags: vi.fn(),
}));
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  applySecretStoreObjects: vi.fn(() => Promise.resolve()),
  createVerifyJob: vi.fn(() => Promise.resolve()),
  readScanJob: vi.fn(() => Promise.resolve({ state: "succeeded", output: "" })),
  deleteScanJob: vi.fn(() => Promise.resolve()),
}));

const prefix = `cat-${randomUUID().slice(0, 6)}`;
const teamA = `${prefix}-a`;
const teamB = `${prefix}-b`;
const handMade = `${prefix}-hand`;
const registry = "registry.example/catalog";
const digestOf = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof syncCatalog>[0];

function product(team: string, name: string, action = "run") {
  return {
    name: `${team}-${name}-${action}`,
    image: `${registry}/${team}/${name}@${digestOf(1)}`,
    action,
    team,
    secretRefs: [],
    shareWith: [],
  };
}

function release(fields: MessageInitShape<typeof ReleaseSchema>): Release {
  return create(ReleaseSchema, { commit: "c1", repository: "github.com/my-org/vertra-catalog", ...fields });
}

/** The registry answers with this release, under this digest. */
function publish(r: Release, digest: string) {
  vi.mocked(fetchRelease).mockResolvedValue({ digest, json: toJsonString(ReleaseSchema, r) });
}

const store = { apiVersion: "external-secrets.io/v1", kind: "SecretStore", metadata: { name: "vault" }, spec: {} };

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);

beforeAll(async () => {
  app = await buildApp();
  config.catalog.release = `${registry}/catalog-release:latest`;
  config.catalog.verifierImage = "cosign@sha256:x";
  await createTeam(handMade);
});

beforeEach(() => {
  config.catalog.signature = { publicKeys: [], keylessIssuer: "", keylessSubjectRegExp: "" };
  vi.mocked(applySecretStoreObjects).mockClear();
  vi.mocked(createVerifyJob).mockClear();
});

afterAll(async () => {
  config.catalog.release = "";
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(catalogSync).where(eq(catalogSync.id, 1));
  await users.cleanUp();
  await app.close();
});

const catalogTeams = () => db.select().from(teams).where(like(teams.name, `${prefix}%`));
const catalogProducts = () => db.select().from(products).where(like(products.name, `${prefix}%`));
const status = async () => (await db.select().from(catalogSync).where(eq(catalogSync.id, 1)))[0];

describe("applying a release", () => {
  it("makes its teams, registers its products and applies its SecretStores, as the catalog's", async () => {
    publish(
      release({
        teams: [{ name: teamA, secretStoreDocuments: [store] }, { name: teamB, secretStoreDocuments: [] }],
        products: [product(teamA, "site"), product(teamA, "site", "remove"), product(teamB, "db")],
      }),
      digestOf(10),
    );
    expect(await syncCatalog(log)).toBe(true);

    const byName = new Map((await catalogTeams()).map((t) => [t.name, t]));
    expect(byName.get(teamA)?.fromCatalog).toBe(true);
    expect(byName.get(teamB)?.fromCatalog).toBe(true);
    expect(byName.get(handMade)?.fromCatalog).toBe(false);
    const registered = await catalogProducts();
    expect(registered.map((p) => p.name).sort()).toEqual(
      [`${teamA}-site-remove`, `${teamA}-site-run`, `${teamB}-db-run`].sort(),
    );
    expect(registered.every((p) => p.fromCatalog && p.image.endsWith(digestOf(1)))).toBe(true);
    // The stores, never a credential: each install sets its own.
    expect(applySecretStoreObjects).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applySecretStoreObjects).mock.calls[0]?.[0]).toBe(teamA);
    expect(vi.mocked(applySecretStoreObjects).mock.calls[0]?.[2]).toBeUndefined();

    const row = await status();
    expect(row).toMatchObject({ digest: digestOf(10), commit: "c1", problems: [], error: null });
    // What it held: site's two actions are one product.
    expect(row?.applied).toEqual({ teams: 2, products: 2, actions: 3, templates: 0, apis: 0, secretStores: 1 });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.requestId, digestOf(10)));
    expect(entry).toMatchObject({ method: "CATALOG", route: "catalog-sync", status: 200 });
  });

  it("doesn't apply the same release twice", async () => {
    const before = (await status())?.appliedAt;
    expect(await syncCatalog(log)).toBe(true);
    expect(applySecretStoreObjects).not.toHaveBeenCalled();
    const row = await status();
    expect(row?.appliedAt).toEqual(before);
    expect(row?.checkedAt?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
  });

  it("records what failed and applies the rest", async () => {
    publish(
      release({
        commit: "c2",
        teams: [{ name: teamA }, { name: teamB }],
        products: [
          product(teamA, "site"),
          product(teamA, "site", "remove"),
          product(teamB, "db"),
          // A team this release doesn't name (and that doesn't exist).
          product(`${prefix}-ghost`, "x"),
        ],
      }),
      digestOf(11),
    );
    await syncCatalog(log);
    const row = await status();
    expect(row?.commit).toBe("c2");
    expect(row?.problems).toEqual([{ item: `product ${prefix}-ghost-x-run`, message: expect.stringContaining("isn't one of this release's teams") as string }]);
    expect((await catalogProducts()).length).toBe(3);
  });

  it("says ESO isn't installed, and never shows a cluster's error itself", async () => {
    vi.mocked(applySecretStoreObjects)
      .mockRejectedValueOnce(new ExternalSecretsMissingError("external-secrets.io/v1"))
      .mockRejectedValueOnce(new (class ApiException extends Error {})("HTTP-Code: 500 Body: {...} Headers: {audit-id: x}"));
    publish(
      release({
        commit: "c2",
        teams: [{ name: teamA, secretStoreDocuments: [store] }, { name: teamB, secretStoreDocuments: [store] }],
        products: [product(teamA, "site"), product(teamA, "site", "remove"), product(teamB, "db")],
      }),
      digestOf(80),
    );
    await syncCatalog(log);
    const problems = (await status())?.problems as { item: string; message: string }[];
    expect(problems).toHaveLength(2);
    expect(problems[0]?.message).toContain("External Secrets Operator isn't installed");
    expect(problems[0]?.message).toContain("vertra config set -e <env> externalSecrets true");
    expect(problems[1]?.message).toBe("failed unexpectedly: the console's log has why");
  });

  it("unregisters what a later release drops, and retires a team it drops, never one an admin made", async () => {
    const [handTeam] = await db.select().from(teams).where(eq(teams.name, handMade));
    await db.insert(products).values({ name: `${prefix}-hand-made`, image: `${registry}/${handMade}/x@${digestOf(2)}`, action: "run", teamId: handTeam?.id });
    publish(
      release({
        commit: "c3",
        teams: [{ name: teamA }],
        products: [product(teamA, "site")],
      }),
      digestOf(12),
    );
    await syncCatalog(log);

    expect((await catalogProducts()).map((p) => p.name).sort()).toEqual([`${prefix}-hand-made`, `${teamA}-site-run`].sort());
    const byName = new Map((await catalogTeams()).map((t) => [t.name, t]));
    expect(byName.get(teamB)?.retiredAt).not.toBeNull();
    expect(byName.get(teamB)?.retiredBy).toBe("the catalog");
    expect(byName.get(teamB)?.deletedAt).toBeNull(); // retired, never purged
    expect(byName.get(handMade)?.retiredAt).toBeNull();
    expect(byName.get(teamA)?.retiredAt).toBeNull();
  });

  it("brings a retired team back when a release names it again", async () => {
    publish(
      release({
        commit: "c4",
        teams: [{ name: teamA }, { name: teamB }],
        products: [product(teamA, "site"), product(teamB, "db")],
      }),
      digestOf(13),
    );
    await syncCatalog(log);
    const [b] = await db.select().from(teams).where(eq(teams.name, teamB));
    expect(b?.retiredAt).toBeNull();
    expect((await catalogProducts()).some((p) => p.name === `${teamB}-db-run`)).toBe(true);
  });

  it("records a release it can't read, and changes nothing", async () => {
    vi.mocked(fetchRelease).mockRejectedValueOnce(new Error("the registry answered 403"));
    const before = await catalogProducts();
    await syncCatalog(log);
    expect((await status())?.error).toContain("403");
    expect((await status())?.commit).toBe("c4");
    expect((await catalogProducts()).length).toBe(before.length);
  });
});

describe("a signed catalog", () => {
  it("is applied only when a trusted signer signed the release", async () => {
    config.catalog.signature = { publicKeys: ["-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----"], keylessIssuer: "", keylessSubjectRegExp: "" };
    vi.mocked(readScanJob).mockResolvedValueOnce({ state: "failed", output: "no matching signatures" });
    publish(release({ commit: "unsigned", teams: [] }), digestOf(20));
    await syncCatalog(log);
    expect(createVerifyJob).toHaveBeenCalledTimes(1);
    const args = vi.mocked(createVerifyJob).mock.calls[0]?.[0];
    expect(args?.args.at(-1)).toBe(`${registry}/catalog-release@${digestOf(20)}`); // verified by digest
    expect(args?.publicKey).toContain("BEGIN PUBLIC KEY");
    // No pull Secret: the Job signs in to the registry as its cloud identity.
    expect(args?.args[0]).toBe("--k8s-keychain");
    expect((await status())?.error).toContain("no trusted signer");
    expect((await status())?.commit).toBe("c4"); // nothing applied
    expect((await catalogTeams()).find((t) => t.name === teamA)?.retiredAt).toBeNull();

    // With a pull Secret, its Docker config instead (cosign's default keychain).
    config.scanning.pullSecretName = "registry-pull";
    vi.mocked(createVerifyJob).mockClear();
    publish(release({ commit: "signed", teams: [{ name: teamA }] }), digestOf(21));
    try {
      await syncCatalog(log);
    } finally {
      config.scanning.pullSecretName = "";
    }
    expect(vi.mocked(createVerifyJob).mock.calls[0]?.[0].args).not.toContain("--k8s-keychain");
    expect((await status())?.commit).toBe("signed");
  });
});

describe("the API", () => {
  it("shows the status and syncs now, for admins only", async () => {
    const admin = await users.makeUser({ admin: true });
    const someone = await users.makeUser();
    const adminToken = await users.signIn(admin.email);
    const someoneToken = await users.signIn(someone.email);
    publish(release({ commit: "via-api", teams: [{ name: teamA }] }), digestOf(30));

    expect((await call(someoneToken, "AdminService/GetCatalogStatus")).code).toBe("permission_denied");
    expect((await call(someoneToken, "AdminService/SyncCatalog")).code).toBe("permission_denied");
    const synced = await call<{ status: { commit: string; release: string } }>(adminToken, "AdminService/SyncCatalog");
    expect(synced.code).toBe("ok");
    expect(synced.body.status).toMatchObject({ commit: "via-api", release: `${registry}/catalog-release:latest` });
    const shown = await call<{ status: { digest: string } }>(adminToken, "AdminService/GetCatalogStatus");
    expect(shown.body.status.digest).toBe(digestOf(30));
  });

  it("names the release's repository in the secret-setup guides, unless the install sets one", async () => {
    const someone = await users.makeUser();
    const token = await users.signIn(someone.email);
    publish(release({ commit: "guides", teams: [{ name: teamA }] }), digestOf(31));
    await syncCatalog(log);
    const facts = await call<{ catalogRepo: string }>(token, "SecretService/GetSecretSources");
    expect(facts.body.catalogRepo).toBe("my-org/vertra-catalog");
    const original = config.secretSources.catalogRepo;
    config.secretSources.catalogRepo = "acme/catalog";
    try {
      expect((await call<{ catalogRepo: string }>(token, "SecretService/GetSecretSources")).body.catalogRepo).toBe("acme/catalog");
    } finally {
      config.secretSources.catalogRepo = original;
    }
  });

  it("lets a team's members set its SecretStores' credential, which is never audited", async () => {
    const member = await users.makeUser();
    const outsider = await users.makeUser();
    const [a] = await db.select().from(teams).where(eq(teams.name, teamA));
    const { addTeamMember } = await import("../src/db/queries.js");
    await addTeamMember(member.id, a!.id);
    const memberToken = await users.signIn(member.email);
    const outsiderToken = await users.signIn(outsider.email);

    const refused = await call(outsiderToken, "TeamService/SetSecretStoreCredential", { team: teamA, credential: "op-token-x" });
    expect(refused.code).toBe("permission_denied");
    vi.mocked(applySecretStoreObjects).mockClear();
    const set = await call(memberToken, "TeamService/SetSecretStoreCredential", { team: teamA, credential: "op-token-secret" });
    expect(set.code).toBe("ok");
    expect(applySecretStoreObjects).toHaveBeenCalledWith(teamA, [], "op-token-secret");
    const entries = await db.select().from(auditLog).where(inArray(auditLog.route, ["vertra.console.v1.TeamService/SetSecretStoreCredential"]));
    expect(JSON.stringify(entries)).not.toContain("op-token-secret");
  });
});

describe("a team the catalog didn't make", () => {
  it("is left alone, its products and stores too, until an admin adopts it", async () => {
    const taken = `${prefix}-taken`;
    await createTeam(taken);
    const admin = await users.makeUser({ admin: true });
    const someone = await users.makeUser();
    const adminToken = await users.signIn(admin.email);
    const someoneToken = await users.signIn(someone.email);
    publish(
      release({
        commit: "takeover",
        teams: [{ name: teamA }, { name: taken, secretStoreDocuments: [store] }],
        products: [product(teamA, "site"), product(taken, "svc")],
      }),
      digestOf(40),
    );
    vi.mocked(applySecretStoreObjects).mockClear();
    expect(await syncCatalog(log)).toBe(true);

    const names = () => catalogProducts().then((ps) => ps.map((p) => p.name));
    expect(await names()).not.toContain(`${taken}-svc-run`);
    expect(applySecretStoreObjects).not.toHaveBeenCalled();
    const [team] = await db.select().from(teams).where(eq(teams.name, taken));
    expect(team?.fromCatalog).toBe(false);
    expect((await status())?.problems).toEqual([expect.objectContaining({ item: `team ${taken}`, adoptableTeam: taken })]);

    expect((await call(someoneToken, "AdminService/AdoptCatalogTeam", { name: taken })).code).toBe("permission_denied");
    expect((await call(adminToken, "AdminService/AdoptCatalogTeam", { name: `${prefix}-nobody` })).code).toBe("not_found");
    const adopted = await call<{ status: { problems?: unknown[] } }>(adminToken, "AdminService/AdoptCatalogTeam", { name: taken });
    expect(adopted.code).toBe("ok");
    expect(adopted.body.status.problems ?? []).toEqual([]);
    expect(await names()).toContain(`${taken}-svc-run`);
    expect(vi.mocked(applySecretStoreObjects).mock.calls.map((c) => c[0])).toEqual([taken]);
  });

  it("isn't given products by a release that doesn't name it", async () => {
    const handMade = `${prefix}-handmade`;
    await createTeam(handMade);
    publish(
      release({ commit: "unnamed", teams: [{ name: teamA }], products: [product(teamA, "site"), product(handMade, "svc")] }),
      digestOf(41),
    );
    expect(await syncCatalog(log)).toBe(true);
    const names = (await catalogProducts()).map((p) => p.name);
    expect(names).toContain(`${teamA}-site-run`);
    expect(names).not.toContain(`${handMade}-svc-run`);
    expect((await status())?.problems).toEqual([expect.objectContaining({ item: `product ${handMade}-svc-run` })]);
  });
});

describe("failure help in a release", () => {
  it("stores a product's error help and its team's contact and help", async () => {
    publish(
      release({
        commit: "help",
        teams: [{ name: teamA, contact: "a@acme.com", owner: "@acme/team-a", description: "Runs payments.", helpChat: "#a-help", helpUrl: "https://runbooks.acme.com/a" }],
        products: [{ ...product(teamA, "site"), errors: { QUOTA_EXCEEDED: { means: "No quota left.", do: "Ask for more." } } }],
      }),
      digestOf(60),
    );
    await syncCatalog(log);
    const [team] = await db
      .select({ contact: teams.contact, owner: teams.owner, description: teams.description, helpChat: teams.helpChat, helpUrl: teams.helpUrl })
      .from(teams)
      .where(eq(teams.name, teamA));
    expect(team).toEqual({ contact: "a@acme.com", owner: "@acme/team-a", description: "Runs payments.", helpChat: "#a-help", helpUrl: "https://runbooks.acme.com/a" });
    const [site] = await db.select({ errorHelp: products.errorHelp }).from(products).where(eq(products.name, `${teamA}-site-run`));
    expect(site?.errorHelp).toEqual({ QUOTA_EXCEEDED: { means: "No quota left.", do: "Ask for more." } });
  });
});

describe("a release's templates", () => {
  it("are stored as the release has them, and removed when a release drops them", async () => {
    const stored = () =>
      db
        .select({ name: templates.name, steps: templates.steps, shareWith: templates.shareWith, examples: templates.examples })
        .from(templates)
        .innerJoin(teams, eq(teams.id, templates.teamId))
        .where(eq(teams.name, teamA));
    publish(
      release({
        commit: "templates",
        teams: [{ name: teamA }],
        products: [product(teamA, "site")],
        templates: [
          {
            name: "go",
            team: teamA,
            displayName: "Go",
            parameters: { type: "object" },
            steps: [{ id: "s", action: `${teamA}/site.run`, inputs: { n: 1 } }],
            shareWith: ["*"],
            examples: [{ name: "quick", inputs: { n: 2 } }],
          },
        ],
      }),
      digestOf(50),
    );
    await syncCatalog(log);
    expect((await status())?.problems).toEqual([]);
    expect(await stored()).toEqual([
      { name: "go", steps: [{ id: "s", action: `${teamA}/site.run`, inputs: { n: 1 } }], shareWith: ["*"], examples: [{ name: "quick", inputs: { n: 2 }, outputs: {} }] },
    ]);

    publish(release({ commit: "no-templates", teams: [{ name: teamA }], products: [product(teamA, "site")] }), digestOf(51));
    await syncCatalog(log);
    expect(await stored()).toEqual([]);
  });

  it("aren't stored while a step's action isn't shared with their team (X2)", async () => {
    const withB = (shareWith: string[]) =>
      release({
        commit: `x2-${shareWith.join("-") || "none"}`,
        teams: [{ name: teamA }, { name: teamB }],
        products: [product(teamA, "site"), { ...product(teamB, "db"), shareWith }],
        templates: [
          {
            name: "uses-b",
            team: teamA,
            displayName: "Uses B",
            parameters: { type: "object" },
            steps: [{ id: "s", action: `${teamB}/db.run` }],
          },
        ],
      });
    const stored = async () =>
      (
        await db
          .select({ name: templates.name })
          .from(templates)
          .innerJoin(teams, eq(teams.id, templates.teamId))
          .where(eq(teams.name, teamA))
      ).map((t) => t.name);

    publish(withB([]), digestOf(52));
    await syncCatalog(log);
    expect((await status())?.problems).toEqual([
      expect.objectContaining({ item: `template ${teamA}/uses-b`, message: expect.stringContaining(`doesn't share with team "${teamA}"`) }),
    ]);
    expect(await stored()).not.toContain("uses-b");

    publish(withB([teamA]), digestOf(53));
    await syncCatalog(log);
    expect((await status())?.problems).toEqual([]);
    expect(await stored()).toContain("uses-b");
  });
});

describe("a release's wiring types", () => {
  it("replace the install's when the catalog defines any, and leave them alone when it doesn't", async () => {
    const unlock = await lockWiringTypes();
    const ours = (await db.select().from(wiringTypes)).filter((t) => t.name.startsWith(prefix));
    try {
      await db.insert(wiringTypes).values({ name: `${prefix}.own`, jsonType: "string", description: "Set by hand.", shared: false });
      publish(release({ commit: "no-types", teams: [{ name: teamA }] }), digestOf(60));
      await syncCatalog(log);
      expect((await db.select().from(wiringTypes)).map((t) => t.name)).toContain(`${prefix}.own`);

      publish(
        release({
          commit: "types",
          teams: [{ name: teamA }],
          wiringTypes: {
            types: [
              { name: `${prefix}.project`, team: teamA, jsonType: "string", description: "A project.", defaultProvider: `${teamA}/project.create` },
              { name: `${prefix}.region`, team: teamA, jsonType: "string", description: "A region.", shared: true },
            ],
          },
        }),
        digestOf(61),
      );
      await syncCatalog(log);
      expect((await status())?.problems).toEqual([]);
      const all = await db.select().from(wiringTypes).orderBy(wiringTypes.name);
      expect(all.map((t) => [t.name, t.team, t.shared, t.defaultProvider])).toEqual([
        [`${prefix}.project`, teamA, false, `${teamA}/project.create`],
        [`${prefix}.region`, teamA, true, null],
      ]);
    } finally {
      await db.delete(wiringTypes).where(like(wiringTypes.name, `${prefix}.%`));
      expect(ours).toEqual([]);
      await unlock();
    }
  });
});

describe("catalog versions", () => {
  it("are vX.Y.Z tags, the newest by number", () => {
    expect(newestVersion(["latest", "c1", "v1.2.0", "v1.10.0", "v1.9.9", "v2.0.0-rc.1", "v01.0.0", "v0.9.0"])).toBe("v1.10.0");
    expect(newestVersion(["v2.0.0", "v10.0.0", "v9.99.99"])).toBe("v10.0.0");
    expect(newestVersion(["latest", "c1"])).toBeNull();
  });

  it("are followed: the newest one applied, and its version recorded", async () => {
    config.catalog.newestVersion = true;
    try {
      vi.mocked(listTags).mockResolvedValueOnce(["latest", "c7", "v1.0.0", "v1.1.0"]);
      publish(release({ commit: "c7", teams: [{ name: teamA }] }), digestOf(70));
      await syncCatalog(log);
      expect(listTags).toHaveBeenLastCalledWith(`${registry}/catalog-release`);
      expect(fetchRelease).toHaveBeenLastCalledWith(`${registry}/catalog-release:v1.1.0`);
      expect(await status()).toMatchObject({ digest: digestOf(70), version: "v1.1.0", commit: "c7", error: null });

      // The same release as a new version: nothing to apply, the version noted.
      vi.mocked(listTags).mockResolvedValueOnce(["v1.1.0", "v1.1.1"]);
      const applied = (await status())?.appliedAt;
      await syncCatalog(log);
      expect(await status()).toMatchObject({ version: "v1.1.1", appliedAt: applied });

      // No version yet: nothing read, nothing applied.
      vi.mocked(listTags).mockResolvedValueOnce(["latest", "c8"]);
      vi.mocked(fetchRelease).mockClear();
      await syncCatalog(log);
      expect(fetchRelease).not.toHaveBeenCalled();
      expect(await status()).toMatchObject({ commit: "c7", error: expect.stringContaining("has no version yet") as unknown });
    } finally {
      config.catalog.newestVersion = false;
    }
  });

  it("can be pinned, and latest is no version", async () => {
    config.catalog.release = `${registry}/catalog-release:v1.0.0`;
    try {
      publish(release({ commit: "c6", teams: [{ name: teamA }] }), digestOf(60));
      await syncCatalog(log);
      expect(fetchRelease).toHaveBeenLastCalledWith(`${registry}/catalog-release:v1.0.0`);
      expect(await status()).toMatchObject({ digest: digestOf(60), version: "v1.0.0" });
    } finally {
      config.catalog.release = `${registry}/catalog-release:latest`;
    }
    publish(release({ commit: "c9", teams: [{ name: teamA }] }), digestOf(90));
    await syncCatalog(log);
    expect(await status()).toMatchObject({ digest: digestOf(90), version: null });
  });
});
