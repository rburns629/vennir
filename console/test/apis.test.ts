// SPDX-License-Identifier: MIT
/**
 * API products (decision 20): applied and removed with the catalog's
 * release, each with its ServiceAccount; who sees and may call each; held
 * when its backend's host isn't allowed; paused by its team's maintainers.
 */
import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { and, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyApis } from "../src/catalogSync.js";
import { config } from "../src/config.js";
import { apiState, backendAllowed, backendNamespace, backendPlace } from "../src/core/apis.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, findTeamByName } from "../src/db/queries.js";
import { apiProblems, apiTraffic, apis, gatewayState, teams } from "../src/db/schema.js";
import { ApiSchema } from "../src/gen/vennir/catalog/v1/release_pb.js";
import { buildApp } from "../src/index.js";
import { ensureServiceAccount } from "../src/k8s.js";
import { caller, rpcClient } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
  ensureNamespaceExists: vi.fn(() => Promise.resolve()),
  applySecretStoreObjects: vi.fn(() => Promise.resolve()),
}));
// The catalog repository a release came from, for "Ask for access": faked
// here, since catalog_sync is one row other test files write too.
vi.mock("../src/db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/queries.js")>()),
  catalogRepository: vi.fn(() => Promise.resolve("github.com/acme/vennir-catalog")),
}));

const prefix = `api-${randomUUID().slice(0, 6)}`;
const owner = `${prefix}-pay`;
const consumer = `${prefix}-web`;
const outsider = `${prefix}-out`;

const openapi = {
  openapi: "3.1.0",
  info: { title: "Orders", version: "2.3.0" },
  servers: [{ url: "https://orders.example.run.app" }],
  paths: {
    "/orders": { post: { summary: "Create an order", requestBody: { content: { "application/json": { schema: { type: "object" } } } } } },
    "/orders/{id}": { get: { summary: "One order", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }] } },
  },
};

function api(name: string, fields: Record<string, unknown> = {}) {
  return {
    name,
    team: owner,
    displayName: "Orders API",
    description: "Orders.",
    openapi: JSON.stringify(openapi),
    backendUrl: "https://orders.example.run.app",
    backendAuth: { kind: { case: "googleIdToken" as const, value: { serviceAccount: "gw@p.iam.gserviceaccount.com", audience: "https://orders.example.run.app" } } },
    serviceAccount: `${name}-api`,
    shareWith: [consumer],
    perMinute: { default: 60, [consumer]: 600 },
    timeoutSeconds: 20,
    maxRequestBytes: BigInt(1024),
    path: `teams/${owner}/apis/${name}/api.yaml`,
    ...fields,
  };
}

const problems: string[] = [];

/** Applies a release's APIs, as catalogSync does, for the test's teams only. */
async function apply(apiList: ReturnType<typeof api>[]) {
  await applyApis(
    apiList.map((a) => create(ApiSchema, a)),
    new Set([owner, consumer, outsider]),
    new Set(),
    async (item, work) => {
      try {
        await work();
      } catch (error) {
        problems.push(`${item}: ${String(error)}`);
      }
    },
  );
}

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
const tokens: Record<"maintainer" | "member" | "consumer" | "outsider", string> = { maintainer: "", member: "", consumer: "", outsider: "" };
let serviceAccounts: unknown[][] = [];

beforeAll(async () => {
  app = await buildApp();
  config.gateway.backendHosts = ["*.example.run.app"];
  config.gateway.internetTeams = [owner];
  config.gateway.url = "http://gateway.vennir-system.svc:8080";
  config.gateway.publicUrl = "https://api.example.com";
  await Promise.all([createTeam(owner), createTeam(consumer), createTeam(outsider)]);
  await apply([api("orders", { internet: true }), api("ledger", { hidden: true, shareWith: [], perMinute: {} }), api("legacy", { backendUrl: "https://old.example.com" })]);
  serviceAccounts = [...vi.mocked(ensureServiceAccount).mock.calls];
  const made = { maintainer: await users.makeUser(), member: await users.makeUser(), consumer: await users.makeUser(), outsider: await users.makeUser() };
  const [ownerTeam, consumerTeam, outsiderTeam] = await Promise.all([findTeamByName(owner), findTeamByName(consumer), findTeamByName(outsider)]);
  await addTeamMember(made.maintainer.id, ownerTeam?.id ?? "", "maintainer");
  await addTeamMember(made.member.id, ownerTeam?.id ?? "", "member");
  await addTeamMember(made.consumer.id, consumerTeam?.id ?? "", "member");
  await addTeamMember(made.outsider.id, outsiderTeam?.id ?? "", "member");
  for (const [who, user] of Object.entries(made)) tokens[who as keyof typeof tokens] = await users.signIn(user.email);
});

afterAll(async () => {
  Object.assign(config.gateway, { backendHosts: [], internetTeams: [], url: "", publicUrl: "" });
  const ours = await db.select({ id: teams.id }).from(teams).where(like(teams.name, `${prefix}%`));
  if (ours.length > 0) await db.delete(teams).where(inArray(teams.id, ours.map((t) => t.id)));
  await users.cleanUp();
  await app.close();
});

type Listed = { apis?: { team: string; name: string; state: string; mayCall?: boolean; limits?: { team: string; perMinute: number }[]; defaultPerMinute?: number; askForAccessUrl?: string; problem?: string; problemFoundAt?: string; backendUrl?: string; perMinute?: number; publicUrl?: string; endpoints?: { method: string; path: string }[]; heldReason?: string }[] };
const listFor = async (who: keyof typeof tokens) =>
  ((await call<Listed>(tokens[who], "ApiService/ListApis")).body.apis ?? []).filter((a) => a.team === owner);

describe("from the release", () => {
  it("stores each API with its spec, and makes its ServiceAccount", async () => {
    // This file's team's only: other files publish APIs of the same names.
    const ownerId = (await findTeamByName(owner))?.id ?? "";
    const rows = await db.select().from(apis).where(and(eq(apis.teamId, ownerId), inArray(apis.name, ["orders", "ledger", "legacy"])));
    const orders = rows.find((r) => r.name === "orders" && r.backendUrl.includes("orders"));
    expect(orders).toMatchObject({ timeoutSeconds: 20, maxRequestBytes: 1024, internet: true, serviceAccount: "orders-api" });
    expect(orders?.backendAuth).toEqual({ googleIdToken: { serviceAccount: "gw@p.iam.gserviceaccount.com", audience: "https://orders.example.run.app" } });
    expect(serviceAccounts).toContainEqual([owner, "orders-api"]);
    expect(problems).toEqual([]);
  });

  it("removes what a later release drops", async () => {
    await apply([api("orders", { internet: true }), api("ledger", { hidden: true, shareWith: [], perMinute: {} })]);
    expect((await listFor("maintainer")).map((a) => a.name).sort()).toEqual(["ledger", "orders"]);
    await apply([api("orders", { internet: true }), api("ledger", { hidden: true, shareWith: [], perMinute: {} }), api("legacy", { backendUrl: "https://old.example.com" })]);
  });
});

describe("who sees what", () => {
  it("shows its team everything, the backend included", async () => {
    const listed = await listFor("member");
    expect(listed.map((a) => a.name).sort()).toEqual(["ledger", "legacy", "orders"]);
    const orders = listed.find((a) => a.name === "orders");
    expect(orders).toMatchObject({ mayCall: true, backendUrl: "https://orders.example.run.app", publicUrl: `https://api.example.com/${owner}/orders` });
    expect(orders?.endpoints?.map((e) => `${e.method} ${e.path}`)).toEqual(["POST /orders", "GET /orders/{id}"]);
    // Its own limit, as the gateway counts: the API's default, else the gateway's.
    expect(orders?.perMinute).toBe(60);
    expect(listed.find((a) => a.name === "ledger")?.perMinute).toBe(config.gateway.defaultPerMinute);
  });

  it("lets a team it's shared with call it, at its own limit, without the backend's address", async () => {
    const orders = (await listFor("consumer")).find((a) => a.name === "orders");
    expect(orders).toMatchObject({ mayCall: true, perMinute: 600, backendUrl: "" });
    expect((await listFor("consumer")).some((a) => a.name === "ledger")).toBe(false);
  });

  it("shows others what isn't hidden, but they may not call it", async () => {
    const orders = (await listFor("outsider")).find((a) => a.name === "orders");
    expect(orders?.mayCall ?? false).toBe(false);
    expect(orders?.perMinute ?? 0).toBe(0);
    // Everyone who sees it sees each team's limit, and everyone else's.
    expect(orders).toMatchObject({ limits: [{ team: consumer, perMinute: 600 }], defaultPerMinute: 60 });
    expect((orders as { defaultFromGateway?: boolean } | undefined)?.defaultFromGateway ?? false).toBe(false);
    // An api.yaml with no limits: the gateway's own default, for everyone.
    const ledger = (await listFor("member")).find((a) => a.name === "ledger") as { limits?: unknown[]; defaultPerMinute?: number; defaultFromGateway?: boolean } | undefined;
    expect(ledger?.limits ?? []).toEqual([]);
    expect(ledger).toMatchObject({ defaultPerMinute: config.gateway.defaultPerMinute, defaultFromGateway: true });
    expect((await call(tokens.outsider, "ApiService/GetApi", { team: owner, name: "ledger" })).code).toBe("not_found");
  });

  it("lets only a team call one shared with everyone, as the gateway does: an admin in no team may not", async () => {
    await apply([api("orders", { internet: true }), api("ledger", { hidden: true, shareWith: [], perMinute: {} }), api("legacy", { backendUrl: "https://old.example.com", shareWith: ["*"], perMinute: { default: 60, [outsider]: 5 } })]);
    const adminUser = await users.makeUser({ admin: true });
    try {
      const teamless = ((await call<Listed>(await users.signIn(adminUser.email), "ApiService/ListApis")).body.apis ?? []).find((a) => a.team === owner && a.name === "legacy");
      expect(teamless?.mayCall ?? false).toBe(false);
      expect(teamless?.perMinute ?? 0).toBe(0);
      expect(teamless?.askForAccessUrl ?? "").toBe("");
      // At its own team's limit, as the gateway counts it, even below the default.
      expect((await listFor("outsider")).find((a) => a.name === "legacy")).toMatchObject({ mayCall: true, perMinute: 5 });
    } finally {
      await apply([api("orders", { internet: true }), api("ledger", { hidden: true, shareWith: [], perMinute: {} }), api("legacy", { backendUrl: "https://old.example.com" })]);
    }
  });

  it("offers whoever may not call it an issue asking its team to share it, and nobody else", async () => {
    const ask = new URL((await listFor("outsider")).find((a) => a.name === "orders")?.askForAccessUrl ?? "");
    expect(`${ask.origin}${ask.pathname}`).toBe("https://github.com/acme/vennir-catalog/issues/new");
    expect(ask.searchParams.get("title")).toBe(`Share ${owner}/orders with ${outsider}`);
    expect(ask.searchParams.get("body")).toContain(`[\`teams/${owner}/apis/orders/api.yaml\`]`);
    expect(ask.searchParams.get("body")).toContain(`shareWith: [${outsider}]`);
    expect((await listFor("consumer")).find((a) => a.name === "orders")?.askForAccessUrl ?? "").toBe("");
    expect((await listFor("member")).find((a) => a.name === "orders")?.askForAccessUrl ?? "").toBe("");
  });

  it("says it can't be served, and why, while the gateway has recorded that it can't use its spec", async () => {
    const [orders] = await db.select({ id: apis.id }).from(apis).innerJoin(teams, eq(teams.id, apis.teamId)).where(and(eq(teams.name, owner), eq(apis.name, "orders")));
    const at = new Date("2026-10-30T14:02:00Z");
    await db.insert(apiProblems).values({ apiId: orders?.id ?? "", problem: "its OpenAPI document can't be used: a $ref that isn't there", foundAt: at });
    try {
      expect((await listFor("consumer")).find((a) => a.name === "orders")).toMatchObject({
        state: "API_STATE_UNAVAILABLE",
        problem: "its OpenAPI document can't be used: a $ref that isn't there",
        problemFoundAt: "2026-10-30T14:02:00Z",
      });
      const one = await call<{ api?: { state: string } }>(tokens.consumer, "ApiService/GetApi", { team: owner, name: "orders" });
      expect(one.body.api?.state).toBe("API_STATE_UNAVAILABLE");
    } finally {
      await db.delete(apiProblems).where(eq(apiProblems.apiId, orders?.id ?? ""));
    }
    expect((await listFor("consumer")).find((a) => a.name === "orders")).toMatchObject({ state: "API_STATE_LIVE" });
  });

  it("holds an API whose backend isn't under an allowed host", async () => {
    const legacy = (await listFor("maintainer")).find((a) => a.name === "legacy");
    expect(legacy?.state).toBe("API_STATE_HELD");
    expect(legacy?.heldReason).toContain("old.example.com");
    expect(backendAllowed("https://a.b.example.run.app", ["*.example.run.app"])).toBe(true);
    expect(backendAllowed("https://example.run.app.evil.com", ["*.example.run.app"])).toBe(false);
    expect(backendAllowed("https://xexample.run.app", ["*.example.run.app"])).toBe(false);
  });

  // The hosts a backend may have, for the team payments: the namespace each
  // names, whether it's in the cluster, and so where it runs. The gateway's
  // store_test.go has the same table (backendHostTable), kept in step.
  const backendHosts: [backend: string, domain: string, namespace: string | null, inCluster: boolean, place: string][] = [
    // Services, with and without the cluster's domain.
    ["http://orders.payments-apis.svc.cluster.local:8080", "", "payments-apis", true, "apis"],
    ["http://orders.payments-apis.svc", "", "payments-apis", true, "apis"],
    ["http://ORDERS.Payments-Apis.svc.cluster.local.", "", "payments-apis", true, "apis"],
    ["http://orders.payments.svc.cluster.local", "", "payments", true, "team"],
    ["http://orders.web.svc.cluster.local", "", "web", true, "other"],
    // A headless Service's Pods, and Pods.
    ["http://pod-1.orders.web.svc.cluster.local", "", "web", true, "other"],
    ["http://pod-1.orders.payments-apis.svc", "", "payments-apis", true, "apis"],
    // A Pod's name is its address: cluster DNS answers it whatever
    // namespace it says, so it names none, and is held.
    ["http://10-1-2-3.web.pod.cluster.local", "", null, true, "other"],
    ["http://10-1-2-3.payments-apis.pod", "", null, true, "other"],
    ["http://10-1-2-3.payments-apis.pod.cluster.local", "", null, true, "other"],
    // A cluster with a domain of its own, where cluster.local is still read
    // as the cluster's; on one without, that domain is a name outside.
    ["http://orders.web.svc.corp.internal", "corp.internal", "web", true, "other"],
    ["http://orders.payments-apis.svc.corp.internal", "corp.internal", "payments-apis", true, "apis"],
    ["http://orders.web.svc.cluster.local", "corp.internal", "web", true, "other"],
    ["http://foo.corp.internal", "corp.internal", null, true, "other"],
    ["http://orders.web.svc.corp.internal", "", null, false, "outside"],
    // In the cluster, naming no namespace: held.
    ["http://orders.svc.cluster.local", "", null, true, "other"],
    ["http://cluster.local", "", null, true, "other"],
    ["http://a.b.orders.web.svc.cluster.local", "", null, true, "other"],
    ["http://orders.pod", "", null, true, "other"],
    ["http://10.96.0.10:8080", "", null, true, "other"],
    ["http://[fd00::1]:8080", "", null, true, "other"],
    ["http://[::ffff:10.96.0.10]", "", null, true, "other"],
    ["http://[::ffff:127.0.0.1]", "", null, true, "other"],
    ["http://orders:8080", "", null, true, "other"],
    // The gateway's own Pod, and names outside (looked up as absolute
    // names, so orders.web is never orders.web.svc).
    ["http://127.0.0.1:8080", "", null, false, "outside"],
    ["http://[::1]:8080", "", null, false, "outside"],
    ["http://localhost:8080", "", null, false, "outside"],
    ["http://orders.web", "", null, false, "outside"],
    ["https://api.example.com", "", null, false, "outside"],
    ["https://svc.example.com", "", null, false, "outside"],
  ];

  it("reads a backend host's namespace, and holds one in the cluster that names none", () => {
    for (const [url, domain, namespace, inCluster, place] of backendHosts) {
      expect(backendNamespace(url, domain || "cluster.local"), `${url} ${domain}`).toEqual({ inCluster, namespace });
      expect(backendPlace(url, "payments", false, domain || "cluster.local"), `${url} ${domain}`).toBe(place);
    }
    const before = [...config.gateway.backendHosts];
    config.gateway.backendHosts.splice(0, Infinity, "10.96.0.10", "orders");
    try {
      for (const url of ["http://10.96.0.10:8080", "http://orders:8080"]) {
        const held = apiState({ backendUrl: url, pausedMessage: null, teamName: "payments" });
        expect(held, url).toMatchObject({ state: "held", heldReason: expect.stringContaining("names no namespace") as string });
      }
    } finally {
      config.gateway.backendHosts.splice(0, Infinity, ...before);
    }
  });

  it("holds an API whose in-cluster backend is another team's, whatever backendHosts allows", () => {
    const before = [...config.gateway.backendHosts];
    config.gateway.backendHosts.splice(0, Infinity, "*.svc.cluster.local");
    try {
      const state = (url: string, taken = false) => apiState({ backendUrl: url, pausedMessage: null, teamName: "team-a" }, null, taken);
      // Its API backends' namespace; for one release, its own too.
      expect(state("http://orders.team-a-apis.svc.cluster.local:8080").state).toBe("live");
      expect(state("http://orders.team-a.svc.cluster.local:8080").state).toBe("live");
      const theirs = state("http://orders.team-b.svc.cluster.local:8080");
      expect(theirs).toMatchObject({ state: "held", heldReason: expect.stringContaining("team-b") as string });
      expect(theirs.heldReason).toContain("team-a-apis");
      expect(state("http://orders.team-b-apis.svc.cluster.local:8080").state).toBe("held");
      // A team named team-a-apis (from before such names were refused): its namespace isn't team-a's.
      expect(state("http://orders.team-a-apis.svc.cluster.local:8080", true).state).toBe("held");
    } finally {
      config.gateway.backendHosts.splice(0, Infinity, ...before);
    }
    expect(backendPlace("http://orders.team-a-apis.svc", "team-a")).toBe("apis");
    expect(backendPlace("http://orders.team-a.svc", "team-a")).toBe("team");
    expect(backendPlace("http://orders.team-a-apis-apis.svc", "team-a")).toBe("other");
    expect(backendPlace("https://orders.example.run.app", "team-a")).toBe("outside");
  });

  it("holds an API whose backend is in a namespace named for it that's another team's", async () => {
    const taken = `${owner}-apis`;
    await createTeam(taken);
    const before = [...config.gateway.backendHosts];
    config.gateway.backendHosts.splice(0, Infinity, "*.svc.cluster.local");
    try {
      await apply([api("orders", { internet: true }), api("ledger", { hidden: true, shareWith: [], perMinute: {} }), api("legacy", { backendUrl: `http://legacy.${taken}.svc.cluster.local` })]);
      const got = await call<{ api: { state: string } }>(tokens.member, "ApiService/GetApi", { team: owner, name: "legacy" });
      expect(got.body.api.state).toBe("API_STATE_HELD");
      const listed = await call<Listed>(tokens.member, "ApiService/ListApis", {});
      expect(listed.body.apis?.find((a) => a.name === "legacy")?.state).toBe("API_STATE_HELD");
    } finally {
      config.gateway.backendHosts.splice(0, Infinity, ...before);
      await db.delete(teams).where(eq(teams.name, taken));
      await apply([api("orders", { internet: true }), api("ledger", { hidden: true, shareWith: [], perMinute: {} }), api("legacy", { backendUrl: "https://old.example.com" })]);
    }
  });

  it("gives the spec to whoever may see it", async () => {
    const got = await call<{ openapi: string }>(tokens.consumer, "ApiService/GetApi", { team: owner, name: "orders" });
    expect((JSON.parse(got.body.openapi) as { info: { title: string } }).info.title).toBe("Orders");
  });
});

describe("pausing", () => {
  const pause = (who: keyof typeof tokens, message: string) => call(tokens[who], "ApiService/PauseApi", { team: owner, name: "orders", message });

  it("is a maintainer's of its team, with a message for callers", async () => {
    expect((await pause("member", "incident")).code).toBe("permission_denied");
    expect((await pause("consumer", "incident")).code).toBe("permission_denied");
    expect((await pause("maintainer", "  ")).code).toBe("invalid_argument");
    expect((await pause("maintainer", "Incident 42: back by 14:00")).code).toBe("ok");
    const orders = (await listFor("consumer")).find((a) => a.name === "orders") as { state: string; pausedMessage?: string } | undefined;
    expect(orders).toMatchObject({ state: "API_STATE_PAUSED", pausedMessage: "Incident 42: back by 14:00" });
  });

  it("lasts across releases, until it's resumed", async () => {
    await apply([api("orders", { internet: true }), api("ledger", { hidden: true, shareWith: [], perMinute: {} }), api("legacy", { backendUrl: "https://old.example.com" })]);
    expect((await listFor("maintainer")).find((a) => a.name === "orders")?.state).toBe("API_STATE_PAUSED");
    expect((await call(tokens.maintainer, "ApiService/ResumeApi", { team: owner, name: "orders" })).code).toBe("ok");
    expect((await listFor("maintainer")).find((a) => a.name === "orders")?.state).toBe("API_STATE_LIVE");
  });
});

describe("traffic", () => {
  it("adds up what the gateway recorded, for the API's own team", async () => {
    const ownerTeam = await findTeamByName(owner);
    const [orders] = await db.select().from(apis).where(and(eq(apis.teamId, ownerTeam?.id ?? ""), eq(apis.name, "orders")));
    const minute = (ago: number) => new Date(Math.floor(Date.now() / 60_000) * 60_000 - ago * 60_000);
    await db.insert(apiTraffic).values([
      { apiId: orders?.id ?? "", minute: minute(5), team: consumer, endpoint: "POST /orders", outcome: "forwarded_2xx", count: 40, durationMs: 4000 },
      { apiId: orders?.id ?? "", minute: minute(4), team: consumer, endpoint: "POST /orders", outcome: "forwarded_2xx", count: 70, durationMs: 7000 },
      { apiId: orders?.id ?? "", minute: minute(4), team: consumer, endpoint: "POST /orders", outcome: "invalid", count: 3, durationMs: 3 },
      { apiId: orders?.id ?? "", minute: minute(3), team: consumer, endpoint: "GET /orders/{id}", outcome: "forwarded_5xx", count: 2, durationMs: 100 },
      { apiId: orders?.id ?? "", minute: minute(2), team: consumer, endpoint: "DELETE /admin/users", outcome: "blocked", count: 5, durationMs: 0 },
      { apiId: orders?.id ?? "", minute: minute(2), team: "", endpoint: "POST /orders", outcome: "unauthenticated", count: 1, durationMs: 0 },
      // Before sign-in, a path not in the spec: counted under no endpoint.
      { apiId: orders?.id ?? "", minute: minute(2), team: "", endpoint: "", outcome: "unauthenticated", count: 6, durationMs: 0 },
      // A hidden API asked for by a caller not of its team: stopped too.
      { apiId: orders?.id ?? "", minute: minute(2), team: "", endpoint: "GET /orders/{id}", outcome: "not_found", count: 4, durationMs: 0 },
      // A team with no limit of its own in api.yaml: held to the API's default.
      { apiId: orders?.id ?? "", minute: minute(2), team: "elsewhere", endpoint: "GET /orders/{id}", outcome: "forwarded_2xx", count: 1, durationMs: 10 },
      { apiId: orders?.id ?? "", minute: minute(60 * 30), team: consumer, endpoint: "POST /orders", outcome: "forwarded_2xx", count: 999, durationMs: 0 },
    ]);
    type Traffic = { requests: string; forwarded: string; stopped: string; backendErrors: string; endpoints: { endpoint: string; requests: string; invalid: string; backend5xx: string; averageMs: string }[]; blocked: { request: string; count: string; teams: string[] }[]; teams: { team: string; peakPerMinute: string; limitPerMinute: number }[] };
    const got = await call<Traffic>(tokens.member, "ApiService/GetApiTraffic", { team: owner, name: "orders", hours: 24 });
    expect(got.code).toBe("ok");
    const t = got.body;
    expect([t.requests, t.forwarded, t.stopped, t.backendErrors]).toEqual(["132", "113", "19", "2"]);
    expect(t.endpoints.map((e) => e.endpoint)).not.toContain("");
    expect(t.endpoints.find((e) => e.endpoint === "POST /orders")).toMatchObject({ requests: "114", invalid: "3", averageMs: "100" });
    expect(t.blocked).toEqual([expect.objectContaining({ request: "DELETE /admin/users", count: "5", teams: [consumer] })]);
    expect(t.teams.find((x) => x.team === consumer)).toMatchObject({ peakPerMinute: "73", limitPerMinute: 600 });
    expect(t.teams.find((x) => x.team === "elsewhere")).toMatchObject({ limitPerMinute: 60 });
    expect((await call(tokens.consumer, "ApiService/GetApiTraffic", { team: owner, name: "orders" })).code).toBe("permission_denied");
  });
});

describe("the gateway's settings", () => {
  it("are an admin's, who may close it with a message and reopen it", async () => {
    expect((await call(tokens.maintainer, "ApiService/GetGateway")).code).toBe("permission_denied");
    expect((await call(tokens.maintainer, "ApiService/SetGatewayClosed", { message: "no" })).code).toBe("permission_denied");
    const adminUser = await users.makeUser({ admin: true });
    const adminToken = await users.signIn(adminUser.email);
    try {
      expect((await call(adminToken, "ApiService/SetGatewayClosed", { message: "Rotating the signing key" })).code).toBe("ok");
      type Gateway = { closedMessage: string; closedBy: string; backendHosts: string[]; refused: { outcome: string; count: string }[] };
      const g = (await call<Gateway>(adminToken, "ApiService/GetGateway")).body;
      expect(g).toMatchObject({ closedMessage: "Rotating the signing key", closedBy: adminUser.email, backendHosts: ["*.example.run.app"] });
      expect(g.refused.map((r) => r.outcome)).toEqual(expect.arrayContaining(["blocked", "invalid"]));
    } finally {
      expect((await call(adminToken, "ApiService/SetGatewayClosed", { message: "" })).code).toBe("ok");
    }
    const [state] = await db.select().from(gatewayState);
    expect(state?.closedMessage ?? null).toBeNull();
  });
});

describe("an API's identity, which the gateway mints tokens for", () => {
  it("must end in -api, and its token audience may not be the cluster's own", async () => {
    problems.length = 0;
    await apply([
      api("wrong-account", { serviceAccount: "deployer" }),
      api("cluster-audience", { backendAuth: { kind: { case: "serviceAccountToken" as const, value: { audience: "https://kubernetes.default.svc" } } } }),
    ]);
    expect(problems).toEqual([
      expect.stringContaining("must end in -api"),
      expect.stringContaining("is this cluster's own"),
    ]);
  });

  it("may not be for an audience a cloud federates", async () => {
    const audiences = [
      "sts.amazonaws.com",
      "api://AzureADTokenExchange",
      "acme.svc.id.goog",
      "identitynamespace:acme.svc.id.goog:https://container.googleapis.com/v1/projects/acme/locations/l/clusters/c",
      "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/k",
    ];
    problems.length = 0;
    await apply(audiences.map((audience, i) => api(`cloud-audience-${String(i)}`, { backendAuth: { kind: { case: "serviceAccountToken" as const, value: { audience } } } })));
    expect(problems).toEqual(audiences.map(() => expect.stringContaining("one a cloud federates")));
  });
});
