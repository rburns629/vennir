// SPDX-License-Identifier: MIT
/**
 * Observe's alerts (src/core/alerts.ts): read from a Prometheus's own rules
 * API (stubbed here), only the charts' groups, firing first; an instance
 * about another team's hidden API counted, not described, except to an
 * admin; a Prometheus not answering said so; none configured, nothing.
 */
import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyApis } from "../src/catalogSync.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, findTeamByName } from "../src/db/queries.js";
import { teams } from "../src/db/schema.js";
import { ApiSchema } from "../src/gen/vennir/catalog/v1/release_pb.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  ensureServiceAccount: vi.fn(() => Promise.resolve()),
  listGmpRuleGroups: vi.fn(() => (rulesMissing ? Promise.reject(Object.assign(new Error("not found"), { code: 404 })) : Promise.resolve(gmpGroups))),
}));
// No Rules type in the cluster (managed collection off).
let rulesMissing = false;
vi.mock("../src/gcpMetadata.js", () => ({ gcpMetadataToken: vi.fn(() => Promise.resolve("the-consoles-google-token")) }));

// The cluster's Rules objects, as GKE's managed Prometheus evaluates them.
const gmpGroups = [
  { name: "vennir-kernel", rules: [{ alert: "VennirSchedulerDown", labels: { severity: "critical" }, annotations: { summary: "No scheduler has finished a pass in 10 minutes." } }, { record: "x" }] },
  { name: "vennir-console", rules: [{ alert: "VennirGatewayBackendUnreachable", labels: { severity: "critical" }, annotations: { summary: "The gateway can't reach {{ $labels.api }}'s backend." } }] },
  { name: "someone-elses", rules: [{ alert: "DiskFull", annotations: { summary: "A disk is full." } }] },
];
// What GMP's query API answers, by query; and what it was asked.
let gmp: (query: string) => Promise<Response>;
const gmpAsked: { query: string; authorization: string | null }[] = [];
const GMP = "https://monitoring.googleapis.com/v1/projects/acyclix-dev/location/global/prometheus/api/v1/query?query=";

const prefix = `alr-${randomUUID().slice(0, 6)}`;
const owner = `${prefix}-pay`;
const other = `${prefix}-web`;
const PROMETHEUS = `http://prometheus-${prefix}.test:9090`;

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
const tokens = { owner: "", other: "", admin: "" };
let answer: () => Promise<Response>;

const rule = (name: string, state: string, summary: string, alerts: { labels: Record<string, string>; summary: string; state?: string }[] = []) => ({
  type: "alerting",
  name,
  state,
  labels: { severity: "warning" },
  annotations: { summary },
  alerts: alerts.map((a) => ({
    labels: { alertname: name, severity: "warning", ...a.labels },
    annotations: { summary: a.summary, description: "More than 10% of its requests failed." },
    state: a.state ?? "firing",
    activeAt: "2026-10-30T13:58:00Z",
  })),
});

beforeAll(async () => {
  app = await buildApp();
  await Promise.all([createTeam(owner), createTeam(other)]);
  const spec = JSON.stringify({ openapi: "3.1.0", info: { title: "x", version: "1" }, paths: {} });
  await applyApis(
    ["orders", "ledger"].map((name) =>
      create(ApiSchema, { name, team: owner, displayName: name, openapi: spec, backendUrl: "https://x.example.run.app", serviceAccount: `${name}-api`, hidden: name === "ledger" }),
    ),
    new Set([owner, other]),
    new Set(),
    async (_item, work) => { await work(); },
  );
  const [made, them] = [await users.makeUser(), await users.makeUser()];
  await addTeamMember(made.id, (await findTeamByName(owner))?.id ?? "", "member");
  await addTeamMember(them.id, (await findTeamByName(other))?.id ?? "", "member");
  tokens.owner = await users.signIn(made.email);
  tokens.other = await users.signIn(them.email);
  tokens.admin = await users.signIn((await users.makeUser({ admin: true })).email);

  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(GMP)) {
      const query = decodeURIComponent(url.slice(GMP.length));
      gmpAsked.push({ query, authorization: new Headers(init?.headers).get("authorization") });
      return gmp(query);
    }
    return url === `${PROMETHEUS}/api/v1/rules?type=alert` ? answer() : realFetch(input, init);
  });
  answer = () =>
    Promise.resolve(
      Response.json({
        status: "success",
        data: {
          groups: [
            { name: "vennir-kernel", rules: [rule("VennirSchedulerDown", "inactive", "No scheduler has finished a pass in 10 minutes.")] },
            {
              name: "vennir-console",
              rules: [
                rule("VennirGatewayBackendUnreachable", "firing", "The gateway can't reach {{ $labels.api }}'s backend.", [
                  { labels: { api: `${owner}/orders` }, summary: `The gateway can't reach ${owner}/orders's backend.` },
                  { labels: { api: `${owner}/ledger` }, summary: `The gateway can't reach ${owner}/ledger's backend.` },
                ]),
                { type: "recording", name: "vennir:requests:rate5m" },
              ],
            },
            { name: "someone-elses", rules: [rule("DiskFull", "firing", "A disk is full.", [{ labels: {}, summary: "A disk is full." }])] },
          ],
        },
      }),
    );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  config.monitoring.prometheusUrl = "";
  config.monitoring.provider = "";
  config.monitoring.google = { project: "", cluster: "" };
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

type Listed = {
  configured?: boolean;
  problem?: string;
  source?: string;
  project?: string;
  stateUnknown?: boolean;
  rules?: { name: string; state: string; summary: string; hidden?: number; instances?: { summary: string; labels: Record<string, string>; activeAt?: string }[] }[];
};
const list = async (token: string) => (await call<Listed>(token, "ObserveService/ListAlerts", {})).body;

describe("alerts", () => {
  it("are none when the console reads no Prometheus", async () => {
    config.monitoring.prometheusUrl = "";
    expect(await list(tokens.owner)).toMatchObject({ configured: false, rules: [] });
  });

  it("are the charts' rules, firing first, with what each fires for", async () => {
    config.monitoring.prometheusUrl = PROMETHEUS;
    const found = await list(tokens.owner);
    expect(found.configured).toBe(true);
    expect(found.rules?.map((r) => [r.name, r.state])).toEqual([
      ["VennirGatewayBackendUnreachable", "firing"],
      ["VennirSchedulerDown", "inactive"],
    ]);
    expect(found.rules?.[0]).toMatchObject({
      summary: "The gateway can't reach …'s backend.",
      instances: [
        { summary: `The gateway can't reach ${owner}/orders's backend.`, labels: { api: `${owner}/orders` }, activeAt: "2026-10-30T13:58:00Z" },
        { summary: `The gateway can't reach ${owner}/ledger's backend.` },
      ],
    });
  });

  it("count, not describe, what fires for an API the caller can't see; an admin sees it all", async () => {
    config.monitoring.prometheusUrl = PROMETHEUS;
    const theirs = (await list(tokens.other)).rules?.[0];
    expect(theirs?.instances?.map((i) => i.labels["api"])).toEqual([`${owner}/orders`]);
    expect(theirs?.hidden).toBe(1);
    expect((await list(tokens.admin)).rules?.[0]?.instances).toHaveLength(2);
  });

  it("say when Prometheus isn't answering", async () => {
    config.monitoring.prometheusUrl = PROMETHEUS;
    const was = answer;
    answer = () => Promise.reject(new Error("connect ECONNREFUSED"));
    try {
      expect(await list(tokens.owner)).toMatchObject({ configured: true, problem: "Prometheus isn't answering." });
    } finally {
      answer = was;
    }
  });
});

describe("alerts on Google Cloud's managed Prometheus", () => {
  const where = { project_id: "acyclix-dev", location: "us-central1", cluster: "vennir-dev", namespace: "vennir-system" };
  const series = (name: string, metric: Record<string, string>, value: string) => ({ metric: { __name__: name, ...metric }, value: [1793600000, value] });
  const success = (result: unknown[]) => Promise.resolve(Response.json({ status: "success", data: { resultType: "vector", result } }));
  const onGoogle = () => {
    config.monitoring.prometheusUrl = "";
    config.monitoring.provider = "google";
    config.monitoring.google = { project: "acyclix-dev", cluster: "vennir-dev" };
  };

  it("are the cluster's Rules, and which fire from Google, for this cluster", async () => {
    onGoogle();
    gmpAsked.length = 0;
    const firing = { alertname: "VennirGatewayBackendUnreachable", severity: "critical", api: `${owner}/orders`, ...where };
    const hidden = { ...firing, api: `${owner}/ledger` };
    gmp = (query) =>
      query.startsWith("ALERTS_FOR_STATE")
        ? success([series("ALERTS_FOR_STATE", firing, "1793598000")])
        : // Pending a minute ago, firing now: both still within the freshness window.
          success([series("ALERTS", { ...firing, alertstate: "pending" }, "1"), series("ALERTS", { ...firing, alertstate: "firing" }, "1"), series("ALERTS", { ...hidden, alertstate: "firing" }, "1")]);
    const found = await list(tokens.owner);
    expect(found).toMatchObject({ configured: true, source: "google", project: "acyclix-dev", problem: "" });
    expect(found.stateUnknown ?? false).toBe(false);
    expect(found.rules?.map((r) => [r.name, r.state])).toEqual([
      ["VennirGatewayBackendUnreachable", "firing"],
      ["VennirSchedulerDown", "inactive"],
    ]);
    // Where it fires, not where Google keeps it; since when, from ALERTS_FOR_STATE; no text of its own.
    expect(found.rules?.[0]?.instances).toEqual([
      { state: "firing", activeAt: expect.any(String), summary: "", description: "", labels: { api: `${owner}/orders`, namespace: "vennir-system" } },
      { state: "firing", summary: "", description: "", labels: { api: `${owner}/ledger`, namespace: "vennir-system" } },
    ]);
    expect(Date.parse(found.rules?.[0]?.instances?.[0]?.activeAt ?? "")).toBe(1793598000 * 1000);
    // This project's and cluster's, and only what its rule evaluator still writes.
    const selector = '{alertname=~"VennirSchedulerDown|VennirGatewayBackendUnreachable",project_id="acyclix-dev",cluster="vennir-dev"}';
    expect(gmpAsked.map((a) => a.query).sort()).toEqual([
      `ALERTS_FOR_STATE${selector} and (time() - timestamp(ALERTS_FOR_STATE${selector})) < 150`,
      `ALERTS${selector} and (time() - timestamp(ALERTS${selector})) < 150`,
    ]);
    expect(gmpAsked.every((a) => a.authorization === "Bearer the-consoles-google-token")).toBe(true);
    // Another team's hidden API: counted, not described.
    const theirs = (await list(tokens.other)).rules?.[0];
    expect(theirs?.instances?.map((i) => i.labels["api"])).toEqual([`${owner}/orders`]);
    expect(theirs?.hidden).toBe(1);
  });

  it("say what's missing when Google refuses the console, the rules' state unknown", async () => {
    onGoogle();
    gmp = () => Promise.resolve(new Response("denied", { status: 403 }));
    const found = await list(tokens.owner);
    expect(found).toMatchObject({ configured: true, source: "google", stateUnknown: true });
    expect(found.problem).toContain("roles/monitoring.viewer on acyclix-dev");
    expect(found.rules?.map((r) => r.state)).toEqual(["unknown", "unknown"]);
  });

  it("say when the cluster has no Rules to read", async () => {
    onGoogle();
    rulesMissing = true;
    try {
      expect(await list(tokens.owner)).toMatchObject({ configured: true, source: "google", problem: expect.stringContaining("managed collection") as unknown as string, rules: [] });
    } finally {
      rulesMissing = false;
    }
  });

  it("are none without a project to read", async () => {
    onGoogle();
    config.monitoring.google = { project: "", cluster: "" };
    expect(await list(tokens.owner)).toMatchObject({ configured: false, rules: [] });
  });
});
