// SPDX-License-Identifier: MIT
/**
 * The cluster's copy of which audiences each API's ServiceAccount may get a
 * token for (gatewayTokenPolicy.ts): exactly what the gateway asks for per
 * backend.auth, nothing for a held API or a retired team's, the sixteen
 * maps as the policy's CEL shards them, the size limits, that every write
 * says the maps are written, and who rewrites them. Kubernetes is
 * faked: updateGatewayTokenPolicy runs the build the console hands it and
 * keeps what it would have written.
 */
import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { inArray, like } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../src/auth/plugin.js";
import { applyApis } from "../src/catalogSync.js";
import { config } from "../src/config.js";
import { retireTeam, unretireTeam } from "../src/core/teams.js";
import { db } from "../src/db/client.js";
import { createTeam, setTeamRetired, upsertApi } from "../src/db/queries.js";
import { teams, type BackendAuth } from "../src/db/schema.js";
import { ApiSchema } from "../src/gen/vennir/catalog/v1/release_pb.js";
import { updateGatewayTokenPolicy } from "../src/k8s.js";
import {
  audienceVariables,
  AWS_STS_AUDIENCE,
  ENTRA_AUDIENCE,
  backendAudiences,
  MAX_MAP_CHARS,
  policyApiAudiences,
  shardOf,
  syncGatewayTokenPolicy,
  type PolicyApi,
} from "../src/gatewayTokenPolicy.js";

const DIGITS = "0123456789abcdef".split("");
// As the chart seeds it on install: empty, and not yet written.
let policy: Record<string, string> = { apiAudiencesWritten: "false", ...Object.fromEntries(DIGITS.map((d) => [`apiAudiences${d}`, "{}"])) };

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  updateGatewayTokenPolicy: vi.fn(async (_name: string, build: (current: Record<string, string>) => Promise<Record<string, string>>) => {
    policy = { ...policy, ...(await build({ ...policy })) };
    return true;
  }),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
}));

const POOL = "acme.svc.id.goog";
const sat = (audience: string): BackendAuth => ({ serviceAccountToken: { audience } });
const aws: BackendAuth = { awsSigV4: { roleArn: "arn:aws:iam::1:role/r", region: "us-east-1", service: "lambda" } };
const google: BackendAuth = { googleIdToken: { serviceAccount: "gw@p.iam.gserviceaccount.com", audience: "https://orders.a.run.app" } };
const entra: BackendAuth = {
  entraToken: { tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222", scope: "api://orders/.default" },
};

describe("an API's audiences", () => {
  it("are what the gateway asks for, per backend.auth", () => {
    expect(backendAudiences(sat("https://orders.example"), POOL)).toEqual(["https://orders.example"]);
    expect(backendAudiences(aws, POOL)).toEqual([AWS_STS_AUDIENCE]);
    expect(backendAudiences(google, POOL)).toEqual([POOL]);
    expect(backendAudiences(entra, POOL)).toEqual([ENTRA_AUDIENCE]);
    expect(backendAudiences(null, POOL)).toEqual([]);
  });

  it("are none where the gateway would refuse to mint", () => {
    // Google's, with no pool set up for the gateway.
    expect(backendAudiences(google, "")).toEqual([]);
    // A backend's token for an audience a cloud exchanges, or the
    // gateway's own for one, or the cluster's.
    for (const audience of ["sts.amazonaws.com", "api://AzureADTokenExchange", POOL, "identitynamespace:acme.svc.id.goog:x", "//iam.googleapis.com/projects/1/x", "https://kubernetes.default.svc", ""]) {
      expect(backendAudiences(sat(audience), POOL), audience).toEqual([]);
    }
    expect(backendAudiences(sat("https://pool.example/provider"), "https://pool.example/provider")).toEqual([]);
  });
});

describe("the policy's maps", () => {
  const allowed = ["*.example", "*.a.run.app", "*.svc.cluster.local"];
  let hosts: string[];
  beforeAll(() => {
    hosts = config.gateway.backendHosts;
    config.gateway.backendHosts = allowed;
  });
  afterAll(() => {
    config.gateway.backendHosts = hosts;
  });
  const api = (fields: Partial<PolicyApi>): PolicyApi => ({
    teamName: "pay",
    serviceAccount: "orders-api",
    backendUrl: "https://orders.example",
    backendAuth: sat("https://orders.example"),
    ...fields,
  });

  it("key each API's ServiceAccount by its namespace, and leave held APIs out", () => {
    const got = policyApiAudiences(
      [
        api({}),
        api({ serviceAccount: "ledger-api", backendAuth: aws }),
        api({ teamName: "web", serviceAccount: "site-api", backendUrl: "https://site.a.run.app", backendAuth: google }),
        // In its team's API backends' namespace: served.
        api({ serviceAccount: "inside-api", backendUrl: "http://inside.pay-apis.svc.cluster.local", backendAuth: sat("inside") }),
        // Held: a host the admins don't allow, another team's namespace.
        api({ serviceAccount: "held-api", backendUrl: "https://elsewhere.org", backendAuth: aws }),
        api({ serviceAccount: "other-api", backendUrl: "http://x.web-apis.svc.cluster.local", backendAuth: sat("x") }),
        // No credential: nothing to mint.
        api({ serviceAccount: "open-api", backendAuth: null }),
      ],
      new Set(),
      POOL,
    );
    expect(Object.fromEntries(got)).toEqual({
      "pay/inside-api": ["inside"],
      "pay/ledger-api": [AWS_STS_AUDIENCE],
      "pay/orders-api": ["https://orders.example"],
      "web/site-api": [POOL],
    });
  });

  it("give two APIs on one ServiceAccount what both need", () => {
    const got = policyApiAudiences([api({ backendAuth: aws }), api({})], new Set(), POOL);
    expect(got.get("pay/orders-api")).toEqual(["https://orders.example", AWS_STS_AUDIENCE].sort());
  });

  it("hold a team's API backends' namespace that's another team's name", () => {
    const inside = api({ backendUrl: "http://inside.pay-apis.svc.cluster.local", backendAuth: sat("inside") });
    expect(policyApiAudiences([inside], new Set(["pay"]), POOL).size).toBe(0);
  });

  it("shard by the key's length modulo 16, as the policy's CEL does", () => {
    expect(shardOf("a/b")).toBe("3");
    expect(shardOf("abcdefgh/ij-api")).toBe("f");
    expect(shardOf("abcdefgh/ijk-api")).toBe("0");
    const variables = audienceVariables(new Map([["a/b", ["x"]], ["abcdefgh/ijk-api", ["y", "z"]]]));
    expect(Object.keys(variables).sort()).toEqual(DIGITS.map((d) => `apiAudiences${d}`).sort());
    expect(JSON.parse(variables["apiAudiences3"] ?? "")).toEqual({ "a/b": ["x"] });
    expect(JSON.parse(variables["apiAudiences0"] ?? "")).toEqual({ "abcdefgh/ijk-api": ["y", "z"] });
    expect(variables["apiAudiences1"]).toBe("{}");
  });

  it("refuse more than one map holds", () => {
    const big = new Map<string, string[]>();
    // Every key of one length, so one map.
    for (let i = 0; big.size * 60 < MAX_MAP_CHARS + 1000; i++) big.set(`team-${String(i).padStart(6, "0")}/a-api`, [`https://${"a".repeat(30)}.example`]);
    expect(() => audienceVariables(big)).toThrow(/more than the gateway token policy holds in one map/);
  });
});

describe("syncing", () => {
  const prefix = `gtp-${randomUUID().slice(0, 6)}`;
  const live = `${prefix}-live`;
  const retired = `${prefix}-gone`;
  let saved: { hosts: string[]; name: string; gcp: string };

  beforeAll(async () => {
    saved = { hosts: config.gateway.backendHosts, name: config.gateway.tokenPolicyName, gcp: config.gateway.gcpTokenAudience };
    Object.assign(config.gateway, { backendHosts: ["*.example"], tokenPolicyName: "gateway-tokens", gcpTokenAudience: POOL });
    const [liveTeam, retiredTeam] = await Promise.all([createTeam(live), createTeam(retired)]);
    const base = { displayName: "A", openapi: { openapi: "3.1.0", info: { title: "A", version: "1" }, paths: {} }, backendUrl: "https://a.example" };
    await upsertApi({ ...base, teamId: liveTeam.id, name: "orders", serviceAccount: "orders-api", backendAuth: sat("https://a.example") });
    await upsertApi({ ...base, teamId: liveTeam.id, name: "ledger", serviceAccount: "ledger-api", backendAuth: aws });
    await upsertApi({ ...base, teamId: liveTeam.id, name: "held", serviceAccount: "held-api", backendUrl: "https://a.elsewhere.org", backendAuth: aws });
    await upsertApi({ ...base, teamId: retiredTeam.id, name: "orders", serviceAccount: "orders-api", backendAuth: google });
    await setTeamRetired(retiredTeam.id, true, null);
  });

  afterAll(async () => {
    Object.assign(config.gateway, { backendHosts: saved.hosts, tokenPolicyName: saved.name, gcpTokenAudience: saved.gcp });
    const ours = await db.select({ id: teams.id }).from(teams).where(like(teams.name, `${prefix}%`));
    if (ours.length > 0) await db.delete(teams).where(inArray(teams.id, ours.map((t) => t.id)));
  });

  /** Every key the fake policy lists of this test's teams, with its audiences. */
  const ours = () => {
    const listed: Record<string, string[]> = {};
    for (const d of DIGITS) {
      for (const [key, audiences] of Object.entries(JSON.parse(policy[`apiAudiences${d}`] ?? "{}") as Record<string, string[]>)) {
        if (key.startsWith(prefix)) {
          expect(shardOf(key)).toBe(d);
          listed[key] = audiences;
        }
      }
    }
    return listed;
  };

  it("writes each published API's ServiceAccount's audiences, and none for a held one or a retired team's", async () => {
    expect(await syncGatewayTokenPolicy()).toBe(true);
    // From then on the policy holds mints to the maps.
    expect(policy["apiAudiencesWritten"]).toBe("true");
    expect(ours()).toEqual({ [`${live}/ledger-api`]: [AWS_STS_AUDIENCE], [`${live}/orders-api`]: ["https://a.example"] });
  });

  it("prunes what's no longer published", async () => {
    const [team] = await db.select({ id: teams.id }).from(teams).where(like(teams.name, live));
    await setTeamRetired(team?.id ?? "", true, null);
    await syncGatewayTokenPolicy();
    expect(ours()).toEqual({});
  });

  it("is rewritten when a team retires or comes back, and when the catalog's APIs are applied", async () => {
    const admin = { id: randomUUID(), teamNames: [], maintainerOf: [], isAdmin: true, scopes: [] } as unknown as AuthUser;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
    const writes = () => vi.mocked(updateGatewayTokenPolicy).mock.calls.length;
    let before = writes();
    await unretireTeam(admin, live, log);
    expect(writes()).toBe(before + 1);
    expect(ours()[`${live}/orders-api`]).toEqual(["https://a.example"]);
    before = writes();
    await retireTeam(admin, live, log);
    expect(writes()).toBe(before + 1);
    expect(ours()).toEqual({});
    await unretireTeam(admin, live, log);
    // A release changing an API's credential: written at once.
    before = writes();
    const problems: string[] = [];
    await applyApis(
      [
        create(ApiSchema, {
          name: "orders",
          team: live,
          displayName: "A",
          openapi: JSON.stringify({ openapi: "3.1.0", info: { title: "A", version: "1" }, paths: {} }),
          backendUrl: "https://a.example",
          backendAuth: { kind: { case: "awsSigV4", value: { roleArn: "arn:aws:iam::1:role/r", region: "us-east-1", service: "lambda" } } },
          serviceAccount: "orders-api",
        }),
      ],
      new Set([live]),
      new Set(),
      async (item, work) => {
        try {
          await work();
        } catch (error) {
          problems.push(`${item}: ${String(error)}`);
        }
      },
    );
    expect(problems).toEqual([]);
    expect(writes()).toBe(before + 1);
    // The release had only orders: ledger went, and orders signs in to AWS now.
    expect(ours()).toEqual({ [`${live}/orders-api`]: [AWS_STS_AUDIENCE] });
  });

  it("writes nothing with the gateway off", async () => {
    config.gateway.tokenPolicyName = "";
    expect(await syncGatewayTokenPolicy()).toBe(false);
    config.gateway.tokenPolicyName = "gateway-tokens";
  });
});
