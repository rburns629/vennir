// SPDX-License-Identifier: MIT
/**
 * TeamService through Connect: who may create, see, grow and shrink a team,
 * its lifecycle (retire, purge, a purged name reserved), and a refused
 * SecretStore file's problems as Problem details. The rules are tested in
 * depth in team-*.test.ts, through the same core/teams.ts.
 */
import { randomUUID } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam } from "../src/db/queries.js";
import { teams } from "../src/db/schema.js";
import { countUnfinishedPods } from "../src/k8s.js";
import { ProblemSchema } from "../src/gen/vertra/console/v1/common_pb.js";
import { buildApp } from "../src/index.js";
import { failureCode, rpcClient, type RpcError } from "./rpc.js";

vi.mock("../src/productPolicy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/productPolicy.js")>()),
  syncIdentityPolicy: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  unfinishedPodsByNamespace: vi.fn(() => (running ? Promise.resolve(running) : Promise.reject(new Error("pods is forbidden")))),
}));
vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  getExecutionStates: vi.fn(() => Promise.resolve([])),
}));

let app: FastifyInstance;
// What the cluster has running, by namespace, as the stand-in Pod list says.
let running: Map<string, number> | null = new Map<string, number>();
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);
const prefix = `rpc-team-${randomUUID().slice(0, 6)}`;
let admin: string;
let adminEmail: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  adminEmail = (await makeUser({ admin: true })).email;
  admin = await signIn(adminEmail);
});

afterAll(async () => {
  await app.close();
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await cleanUp();
});

describe("creating teams", () => {
  it("is for admins (or teams:create), and a second create says it already exists", async () => {
    const name = `${prefix}-made`;
    const member = await signIn((await makeUser()).email);
    expect((await rpc("TeamService", "CreateTeam", { name }, { token: member })).statusCode).toBe(403);

    const created = await rpc("TeamService", "CreateTeam", { name }, { token: admin });
    expect(created.json<{ team: { name: string } }>().team.name).toBe(name);

    const again = await rpc("TeamService", "CreateTeam", { name }, { token: admin });
    expect(again.json<RpcError>().code).toBe("already_exists");
  });

  it("ensures a team any number of times, saying when it created one", async () => {
    const name = `${prefix}-ensured`;
    const first = await rpc("TeamService", "EnsureTeam", { name }, { token: admin });
    expect(first.json<{ created: boolean }>().created).toBe(true);
    const second = await rpc("TeamService", "EnsureTeam", { name }, { token: admin });
    expect(second.json<{ created: boolean }>().created).toBe(false);
  });

  it("checks a team's name", async () => {
    const response = await rpc("TeamService", "CreateTeam", { name: "Not A Namespace" }, { token: admin });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
  });
});

describe("a team's members", () => {
  it("say whether the catalog made it", async () => {
    const team = await createTeam(`${prefix}-from-catalog`);
    await db.update(teams).set({ fromCatalog: true }).where(eq(teams.id, team.id));
    const member = await makeUser();
    await addTeamMember(member.id, team.id);
    const got = await rpc("TeamService", "GetTeam", { name: team.name }, { token: await signIn(member.email) });
    expect(got.json<{ team: { fromCatalog?: boolean } }>().team.fromCatalog).toBe(true);
  });

  it("see it and its members; anyone else is told it doesn't exist", async () => {
    const team = await createTeam(`${prefix}-seen`);
    const member = await makeUser();
    await addTeamMember(member.id, team.id);
    const token = await signIn(member.email);

    const got = await rpc("TeamService", "GetTeam", { name: team.name }, { token });
    expect(got.statusCode).toBe(200);
    // Made here, not by the catalog.
    expect(got.json<{ team: { fromCatalog?: boolean } }>().team.fromCatalog).toBe(false);
    const listed = await rpc("TeamService", "ListMembers", { team: team.name }, { token });
    const members = listed.json<{ members: { email: string; hasPassword?: boolean; usesSso?: boolean }[] }>().members;
    expect(members.map((m) => m.email)).toEqual([member.email]);
    // How each signs in: what requiring single sign-on would change for them.
    expect(members[0]).toMatchObject({ hasPassword: true, usesSso: false });

    const outsider = await signIn((await makeUser()).email);
    expect((await rpc("TeamService", "GetTeam", { name: team.name }, { token: outsider })).statusCode).toBe(404);
  });

  it("add people, and never remove the last maintainer", async () => {
    const team = await createTeam(`${prefix}-grow`);
    const member = await makeUser();
    await addTeamMember(member.id, team.id);
    const token = await signIn(member.email);
    const newcomer = await makeUser();

    expect((await rpc("TeamService", "AddMember", { team: team.name, email: newcomer.email }, { token })).statusCode).toBe(200);
    expect((await rpc("TeamService", "RemoveMember", { team: team.name, userId: newcomer.id }, { token })).statusCode).toBe(200);

    const last = await rpc("TeamService", "RemoveMember", { team: team.name, userId: member.id }, { token });
    expect(last.json<RpcError>().code).toBe("failed_precondition");
    expect(failureCode(last.json<RpcError>())).toBe("LAST_MAINTAINER");
  });
});

describe("the lifecycle", () => {
  it("retires a team (read-only), purges it, and keeps its name reserved", async () => {
    const team = await createTeam(`${prefix}-gone`);
    const member = await makeUser();
    await addTeamMember(member.id, team.id);
    const token = await signIn(member.email);

    const early = await rpc("TeamService", "PurgeTeam", { name: team.name }, { token: admin });
    expect(failureCode(early.json<RpcError>())).toBe("NOT_RETIRED");

    expect((await rpc("TeamService", "RetireTeam", { name: team.name }, { token: admin })).statusCode).toBe(200);
    // Who retired it, for its page.
    const retired = await rpc("TeamService", "GetTeam", { name: team.name }, { token: admin });
    expect(retired.json<{ team?: { retiredBy?: string } }>().team?.retiredBy).toBe(adminEmail);
    const readOnly = await rpc("TeamService", "AddMember", { team: team.name, email: member.email }, { token });
    expect(failureCode(readOnly.json<RpcError>())).toBe("TEAM_RETIRED");

    const purged = await rpc("TeamService", "PurgeTeam", { name: team.name }, { token: admin });
    expect(purged.json<{ alreadyPurged: boolean }>().alreadyPurged).toBe(false);
    const again = await rpc("TeamService", "PurgeTeam", { name: team.name }, { token: admin });
    expect(again.json<{ alreadyPurged: boolean }>().alreadyPurged).toBe(true);

    const reused = await rpc("TeamService", "EnsureTeam", { name: team.name }, { token: admin });
    expect(failureCode(reused.json<RpcError>())).toBe("NAME_RESERVED");
  });
});

describe("SecretStore files", () => {
  it("are refused with every problem listed", async () => {
    const team = await createTeam(`${prefix}-stores`);
    const response = await rpc(
      "TeamService",
      "ApplySecretStore",
      { team: team.name, documents: [{ kind: "Secret", metadata: { name: "x", namespace: "kube-system" } }] },
      { token: admin },
    );
    const error = response.json<RpcError>();
    expect(error.code).toBe("invalid_argument");
    const problems = (error.details ?? [])
      .filter((d) => d.type === "vertra.console.v1.Problem")
      .map((d) => fromBinary(ProblemSchema, Buffer.from(d.value, "base64")).message);
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("another team's page", () => {
  it("says where to ask it and how big it is, to anyone signed in, and nothing more", async () => {
    const name = `${prefix}-public`;
    const team = await createTeam(name);
    await db.update(teams).set({ contact: "#payments-help", owner: "@acme/payments", description: "Takes payments.", helpUrl: "https://wiki.example/payments" }).where(eq(teams.id, team.id));
    const member = await makeUser();
    await addTeamMember(member.id, team.id, "member");
    const outsider = await signIn((await makeUser()).email);

    const profile = await rpc("TeamService", "GetTeamProfile", { name }, { token: outsider });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toEqual({ name, fromCatalog: false, retired: false, contact: "#payments-help", owner: "@acme/payments", description: "Takes payments.", helpChat: "", helpUrl: "https://wiki.example/payments", people: 1 });
    // Its people and its team record stay its own.
    expect((await rpc("TeamService", "ListMembers", { team: name }, { token: outsider })).statusCode).toBe(403);
    expect((await rpc("TeamService", "GetTeamProfile", { name: `${prefix}-nobody` }, { token: outsider })).json<RpcError>().code).toBe("not_found");
    expect((await rpc("TeamService", "GetTeamProfile", { name }, {})).statusCode).toBe(401);
  });
});

describe("an admin's list of every team", () => {
  it("gives each team's owner, description, people and Pods running in one call, to admins only", async () => {
    const name = `${prefix}-summarized`;
    const team = await createTeam(name);
    await db.update(teams).set({ owner: "@acme/billing", description: "Sends invoices." }).where(eq(teams.id, team.id));
    await addTeamMember((await makeUser()).id, team.id, "member");
    await addTeamMember((await makeUser()).id, team.id, "maintainer");
    const empty = `${prefix}-summarized-empty`;
    await createTeam(empty);
    running = new Map([[name, 3]]);

    const response = await rpc("TeamService", "ListTeamSummaries", {}, { token: admin });
    expect(response.statusCode).toBe(200);
    const summaries = response.json<{ teams: { name: string }[] }>().teams;
    expect(summaries.find((t) => t.name === name)).toEqual({ name, owner: "@acme/billing", description: "Sends invoices.", people: 2, running: 3 });
    expect(summaries.find((t) => t.name === empty)).toEqual({ name: empty, owner: "", description: "", people: 0, running: 0 });

    const member = await signIn((await makeUser()).email);
    expect((await rpc("TeamService", "ListTeamSummaries", {}, { token: member })).statusCode).toBe(403);
  });

  it("still gives the rest when the cluster can't be asked, without a running figure", async () => {
    const name = `${prefix}-summarized-unasked`;
    const team = await createTeam(name);
    await addTeamMember((await makeUser()).id, team.id, "member");
    running = null;
    const response = await rpc("TeamService", "ListTeamSummaries", {}, { token: admin });
    running = new Map();
    expect(response.statusCode).toBe(200);
    expect(response.json<{ teams: { name: string }[] }>().teams.find((t) => t.name === name)).toEqual({ name, owner: "", description: "", people: 1 });
  });

  it("counts a namespace's Pods not finished: starting, running, or unable to start", () => {
    const pod = (namespace: string, phase: string, waiting?: string) => ({
      metadata: { namespace },
      status: { phase, ...(waiting ? { containerStatuses: [{ name: "product", image: "i", imageID: "", ready: false, restartCount: 0, state: { waiting: { reason: waiting } } }] } : {}) },
    });
    const counts = countUnfinishedPods([
      pod("a", "Pending"),
      pod("a", "Running"),
      pod("a", "Pending", "ImagePullBackOff"),
      pod("a", "Succeeded"),
      pod("b", "Failed"),
    ]);
    expect(Object.fromEntries(counts)).toEqual({ a: 3 });
  });
});
