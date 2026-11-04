// SPDX-License-Identifier: MIT
/**
 * The console managing team namespaces and SecretStores, so catalog CI needs
 * no cluster credentials: which calls reach Kubernetes, and who may make
 * them. Kubernetes is faked; what k8s.ts then does in the cluster, and what
 * the namespace and purge policies refuse, is proven on kind.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, createUser, setUserAdmin } from "../src/db/queries.js";
import { teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import {
  applySecretStoreObjects,
  deleteTeamNamespace,
  ExternalSecretsMissingError,
  gatewayIngressPolicy,
  NamespaceNotTeamsError,
  ProtectedNamespaceError,
  setTeamNamespace,
  TEAM_GATEWAY_INGRESS,
  writeSchedulerLogsBinding,
  writeTeamNetworkPolicy,
  writeTeamPullSecret,
} from "../src/k8s.js";
import { syncSchedulerLogsBindings } from "../src/schedulerLogs.js";
import { syncPullSecrets } from "../src/pullSecret.js";
import { syncTeamNetworkPolicies } from "../src/teamNetwork.js";
import { checkSecretStoreObjects, cloudIdentities } from "../src/secretStores.js";
import { caller, failureCode, problemMessages, type RpcError } from "./rpc.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  setTeamNamespace: vi.fn(() => Promise.resolve(true)),
  deleteTeamNamespace: vi.fn(() => Promise.resolve()),
  applySecretStoreObjects: vi.fn(() => Promise.resolve()),
  writeTeamPullSecret: vi.fn(() => Promise.resolve(true)),
  writeTeamNetworkPolicy: vi.fn(() => Promise.resolve(true)),
  writeSchedulerLogsBinding: vi.fn(() => Promise.resolve(true)),
  writeTeamQuota: vi.fn(() => Promise.resolve(true)),
}));
// Purging asks kernel-api about unfinished executions; these teams have none.
vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  getExecutionStates: vi.fn(() => Promise.resolve([])),
}));

const prefix = `ns-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;
const original = { ...config.teamNamespaces };

async function newUser(isAdmin = false): Promise<{ id: string; token: string }> {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (isAdmin) await setUserAdmin(user.id, true);
  return { id: user.id, token: app.jwt.sign({ userId: user.id }) };
}

const call = caller(() => app);

async function mint(scopes: string[]): Promise<string> {
  return (await call<{ token: string }>(admin, "TokenService/CreateAutomationToken", { label: prefix, scopes })).body.token;
}

const retire = (team: string) => call(admin, "TeamService/RetireTeam", { name: team });

const name = (suffix: string) => `${prefix}-${suffix}`;

beforeAll(async () => {
  config.teamNamespaces.manage = true;
  config.teamNamespaces.purge = true;
  app = await buildApp();
  await app.ready();
  admin = (await newUser(true)).token;
});

afterAll(async () => {
  Object.assign(config.teamNamespaces, original);
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

beforeEach(() => {
  vi.mocked(setTeamNamespace).mockClear();
  vi.mocked(deleteTeamNamespace).mockClear();
  vi.mocked(applySecretStoreObjects).mockClear();
  vi.mocked(writeTeamPullSecret).mockClear();
  vi.mocked(writeTeamNetworkPolicy).mockClear();
});

describe("creating a team", () => {
  it("creates its namespace, labelled a team's", async () => {
    expect((await call(admin, "TeamService/CreateTeam", { name: name("new") })).code).toBe("ok");
    expect(setTeamNamespace).toHaveBeenCalledWith(name("new"), "true", expect.objectContaining({ createIfMissing: true, label: "vennir/team" }));
  });

  it("refuses a name that can't be a namespace", async () => {
    for (const bad of ["Team_A", "-a", "a".repeat(64), "has space"]) {
      expect((await call(admin, "TeamService/CreateTeam", { name: bad })).code).toBe("invalid_argument");
    }
    expect(setTeamNamespace).not.toHaveBeenCalled();
  });

  it("creates no team when the namespace can't be its", async () => {
    vi.mocked(setTeamNamespace).mockRejectedValueOnce(new ProtectedNamespaceError("protected"));
    expect((await call(admin, "TeamService/CreateTeam", { name: name("prot") })).code).toBe("invalid_argument");
    vi.mocked(setTeamNamespace).mockRejectedValueOnce(new NamespaceNotTeamsError("someone else's"));
    const taken = await call(admin, "TeamService/CreateTeam", { name: name("taken") });
    expect(taken.code).toBe("failed_precondition");
    expect(taken.failure).toBe("NAMESPACE_EXISTS");
    const created = await db.select().from(teams).where(inArray(teams.name, [name("prot"), name("taken")]));
    expect(created).toEqual([]);
  });

  it("leaves namespaces alone when the console doesn't manage them", async () => {
    config.teamNamespaces.manage = false;
    try {
      expect((await call(admin, "TeamService/CreateTeam", { name: name("unmanaged") })).code).toBe("ok");
      expect(setTeamNamespace).not.toHaveBeenCalled();
    } finally {
      config.teamNamespaces.manage = true;
    }
  });
});

describe("EnsureTeam, what catalog CI calls for every team folder", () => {
  it("creates the team the first time, and is a no-op after", async () => {
    const ci = await mint(["teams:create"]);
    const first = await call<{ created: boolean }>(ci, "TeamService/EnsureTeam", { name: name("ensure") });
    expect(first.body.created).toBe(true);
    const again = await call<{ created: boolean }>(ci, "TeamService/EnsureTeam", { name: name("ensure") });
    expect(again.code).toBe("ok");
    expect(again.body.created).toBe(false);
    expect(setTeamNamespace).toHaveBeenCalledTimes(2); // a drifted label is put back every time
  });

  it("un-retires a retired team only with teams:retire too", async () => {
    await createTeam(name("back"));
    await retire(name("back"));
    const createOnly = await call(await mint(["teams:create"]), "TeamService/EnsureTeam", { name: name("back") });
    expect(createOnly.code).toBe("permission_denied");
    const both = await call<{ team: { retiredAt?: string } }>(await mint(["teams:create", "teams:retire"]), "TeamService/EnsureTeam", {
      name: name("back"),
    });
    expect(both.code).toBe("ok");
    expect(both.body.team.retiredAt).toBeUndefined();
  });

  it("refuses a purged team's name, and anyone without teams:create", async () => {
    await createTeam(name("gone"));
    await retire(name("gone"));
    await call(admin, "TeamService/PurgeTeam", { name: name("gone") });
    expect((await call(admin, "TeamService/EnsureTeam", { name: name("gone") })).failure).toBe("NAME_RESERVED");
    expect((await call((await newUser()).token, "TeamService/EnsureTeam", { name: name("anyone") })).code).toBe("permission_denied");
    const registerOnly = await mint(["products:register"]);
    expect((await call(registerOnly, "TeamService/EnsureTeam", { name: name("anyone") })).code).toBe("permission_denied");
  });
});

describe("retiring and purging", () => {
  it("relabels the namespace retired, without creating one", async () => {
    await createTeam(name("ret"));
    expect((await retire(name("ret"))).code).toBe("ok");
    expect(setTeamNamespace).toHaveBeenCalledWith(name("ret"), "retired", expect.objectContaining({ createIfMissing: false }));
    await call(admin, "TeamService/UnretireTeam", { name: name("ret") });
    expect(setTeamNamespace).toHaveBeenLastCalledWith(name("ret"), "true", expect.objectContaining({ createIfMissing: true }));
  });

  it("deletes the namespace when purging, and again when asked again", async () => {
    await createTeam(name("purge"));
    await retire(name("purge"));
    const purged = await call<{ namespaceDeleted: boolean }>(admin, "TeamService/PurgeTeam", { name: name("purge") });
    expect(purged.code).toBe("ok");
    expect(purged.body.namespaceDeleted).toBe(true);
    expect(deleteTeamNamespace).toHaveBeenCalledWith(name("purge"), expect.any(Array));
    // A namespace deletion that failed the first time can simply be retried.
    const again = await call<{ alreadyPurged: boolean }>(admin, "TeamService/PurgeTeam", { name: name("purge") });
    expect(again.code).toBe("ok");
    expect(again.body.alreadyPurged).toBe(true);
    expect(deleteTeamNamespace).toHaveBeenCalledTimes(2);
  });

  it("leaves the namespace when the console isn't allowed to purge", async () => {
    config.teamNamespaces.purge = false;
    try {
      await createTeam(name("keep"));
      await retire(name("keep"));
      const purged = await call<{ namespaceDeleted: boolean }>(admin, "TeamService/PurgeTeam", { name: name("keep") });
      expect(purged.code).toBe("ok");
      expect(purged.body.namespaceDeleted).toBe(false);
      expect(deleteTeamNamespace).not.toHaveBeenCalled();
    } finally {
      config.teamNamespaces.purge = true;
    }
  });
});

describe("applying a team's SecretStore file", () => {
  const store = (team: string, spec: object = { provider: { gcpsm: { projectID: "p", auth: { workloadIdentity: { serviceAccountRef: { name: "eso-gcp" } } } } } }) => ({
    apiVersion: "external-secrets.io/v1",
    kind: "SecretStore",
    metadata: { name: "vault", namespace: team },
    spec,
  });

  it("allows the store and ESO's ServiceAccounts, in the team's namespace", () => {
    const sa = { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "eso-gcp", annotations: { "iam.gke.io/gcp-service-account": "x@p.iam.gserviceaccount.com" } } };
    const checked = checkSecretStoreObjects("team-a", [sa, store("team-a")]);
    expect(checked.problems).toEqual([]);
    expect(checked.objects.map((o) => o.kind)).toEqual(["ServiceAccount", "SecretStore"]);
  });

  it("refuses anything that reaches outside the team", () => {
    const problems = (docs: unknown[]) => checkSecretStoreObjects("team-a", docs).problems.join(" | ");
    expect(problems([store("team-b")])).toContain('namespace must be "team-a"');
    expect(problems([{ ...store("team-a"), kind: "ClusterSecretStore" }])).toContain("only SecretStore");
    expect(problems([store("team-a", { provider: { kubernetes: { remoteNamespace: "x", server: { caProvider: { namespace: "kube-system" } } } } })])).toContain("points into another namespace");
    expect(problems([store("team-a", { provider: { onepassword: { auth: { secretRef: { connectTokenSecretRef: { name: "someone-elses" } } } } } })])).toContain('must name the Secret "eso-auth"');
    expect(problems([store("team-a"), { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "product-sa" } }])).toContain("the only ServiceAccounts allowed");
    expect(problems([{ apiVersion: "v1", kind: "Secret", metadata: { name: "eso-auth" } }])).toContain("only SecretStore");
    expect(problems([{ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "eso-gcp" } }])).toContain("No SecretStore");
  });

  it("applies it with secret-stores:apply or as an admin, and nobody else", async () => {
    const team = name("stores");
    await createTeam(team);
    const member = await newUser();
    const [row] = await db.select().from(teams).where(inArray(teams.name, [team]));
    await addTeamMember(member.id, row?.id ?? "");
    const body = { team, documents: [store(team)], credential: "not-a-real-token" };
    const apply = (token: string) => call(token, "TeamService/ApplySecretStore", body);

    expect((await apply(member.token)).code).toBe("permission_denied");
    expect((await apply(await mint(["teams:create"]))).code).toBe("permission_denied");
    expect(applySecretStoreObjects).not.toHaveBeenCalled();

    expect((await apply(await mint(["secret-stores:apply"]))).code).toBe("ok");
    expect(applySecretStoreObjects).toHaveBeenCalledWith(team, [expect.objectContaining({ kind: "SecretStore" })], "not-a-real-token");
    expect((await apply(admin)).code).toBe("ok");
  });

  it("applies nothing when the file isn't allowed, and says why", async () => {
    const team = name("bad-store");
    await createTeam(team);
    const refused = await call<RpcError>(admin, "TeamService/ApplySecretStore", { team, documents: [store("other")] });
    expect(refused.code).toBe("invalid_argument");
    expect(problemMessages(refused.body)[0]).toContain("namespace must be");
    expect(applySecretStoreObjects).not.toHaveBeenCalled();
  });

  it("says External Secrets Operator isn't installed, as the install's to fix", async () => {
    const team = name("no-eso");
    await createTeam(team);
    vi.mocked(applySecretStoreObjects).mockRejectedValueOnce(new ExternalSecretsMissingError("external-secrets.io/v1"));
    const refused = await call<RpcError>(admin, "TeamService/ApplySecretStore", { team, documents: [store(team)] });
    expect(refused.code).toBe("failed_precondition");
    expect(failureCode(refused.body)).toBe("EXTERNAL_SECRETS_MISSING");
    expect(refused.body.message).toContain("`vennir config set -e <env> externalSecrets true`");
  });
});

describe("a SecretStore's cloud identity", () => {
  const gsa = `eso-${randomUUID().slice(0, 8)}@acme.iam.gserviceaccount.com`;
  const role = `arn:aws:iam::123456789012:role/eso-${randomUUID().slice(0, 8)}`;
  const signingInAs = (team: string, sa: string, spec: unknown = { provider: { gcpsm: { projectID: "p" } } }) => [
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "eso-gcp", annotations: { "iam.gke.io/gcp-service-account": sa } } },
    { apiVersion: "external-secrets.io/v1", kind: "SecretStore", metadata: { name: "vault", namespace: team }, spec },
  ];

  it("is read from its ServiceAccount and the role the store assumes", () => {
    const checked = checkSecretStoreObjects("team-a", signingInAs("team-a", "Eso@P.iam.gserviceaccount.com", { provider: { aws: { role: "arn:aws:iam::1:role/R" } } }));
    expect(cloudIdentities(checked.objects)).toEqual(["aws:arn:aws:iam::1:role/r", "gcp:eso@p.iam.gserviceaccount.com"]);
  });

  it("is one team's alone: another team's store can't sign in as it, until the first lets it go", async () => {
    const [first, second] = [name("id-a"), name("id-b")];
    await createTeam(first);
    await createTeam(second);
    const apply = (team: string, sa: string, spec?: unknown) =>
      call<RpcError>(admin, "TeamService/ApplySecretStore", { team, documents: signingInAs(team, sa, spec) });

    expect((await apply(first, gsa)).code).toBe("ok");
    expect((await apply(first, gsa)).code).toBe("ok"); // its own again
    vi.mocked(applySecretStoreObjects).mockClear();
    const taken = await apply(second, gsa.toUpperCase());
    expect(taken.code).toBe("already_exists");
    expect(taken.failure).toBe("IDENTITY_IN_USE");
    expect(applySecretStoreObjects).not.toHaveBeenCalled();
    // The same through a role the store assumes.
    expect((await apply(first, gsa, { provider: { aws: { role } } })).code).toBe("ok");
    expect((await apply(second, `other-${gsa}`, { provider: { aws: { role } } })).failure).toBe("IDENTITY_IN_USE");

    // The first team's store signs in as another: the old one is free.
    expect((await apply(first, `new-${gsa}`)).code).toBe("ok");
    expect((await apply(second, gsa)).code).toBe("ok");
  });
});

describe("registering a secret", () => {
  it("refuses the name of a SecretStore's own credential, and of the pull Secret", async () => {
    const team = name("reserved");
    await createTeam(team);
    for (const secretName of ["eso-auth", "vennir-pull"]) {
      const put = await call(admin, "SecretService/PutSecret", { team, secretName, data: { token: "x" } });
      expect(put.code).toBe("invalid_argument");
    }
  });
});

describe("the registry pull Secret", () => {
  const PULL = '{"auths":{"ghcr.io":{"auth":"eDp5"}}}';

  beforeAll(() => {
    const file = join(mkdtempSync(join(tmpdir(), "pull-")), "config.json");
    writeFileSync(file, PULL);
    config.teamPullSecretFile = file;
  });

  afterAll(() => {
    config.teamPullSecretFile = "";
  });

  it("is copied into a new team's namespace", async () => {
    expect((await call(admin, "TeamService/CreateTeam", { name: name("pull") })).code).toBe("ok");
    expect(writeTeamPullSecret).toHaveBeenCalledWith(name("pull"), PULL);
  });

  it("isn't copied when a team is retired", async () => {
    await call(admin, "TeamService/CreateTeam", { name: name("pull-retire") });
    vi.mocked(writeTeamPullSecret).mockClear();
    await retire(name("pull-retire"));
    expect(writeTeamPullSecret).not.toHaveBeenCalled();
  });

  it("is copied into every team on a resync, and a failure is reported", async () => {
    await createTeam(name("pull-sync"));
    expect(await syncPullSecrets()).toBe(true);
    expect(writeTeamPullSecret).toHaveBeenCalledWith(name("pull-sync"), PULL);
    vi.mocked(writeTeamPullSecret).mockImplementationOnce(() => Promise.reject(new Error("boom")));
    await expect(syncPullSecrets()).rejects.toThrow("Couldn't copy the pull Secret");
  });

  it("isn't copied when not configured", async () => {
    config.teamPullSecretFile = ""; // the last test: afterAll leaves it so
    expect(await syncPullSecrets()).toBe(false);
    expect(writeTeamPullSecret).not.toHaveBeenCalled();
  });
});

describe("the gateway-ingress network policy", () => {
  it("lets only the gateway's Pods in, only to the Pods a team labels as API backends", () => {
    const policy = gatewayIngressPolicy("team-a", { namespace: "vennir-system", labels: { "app.kubernetes.io/component": "gateway" } });
    expect(policy.metadata?.name).toBe(TEAM_GATEWAY_INGRESS);
    expect(policy.spec).toEqual({
      podSelector: { matchLabels: { "vennir/api-backend": "true" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          _from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "vennir-system" } },
              podSelector: { matchLabels: { "app.kubernetes.io/component": "gateway" } },
            },
          ],
        },
      ],
    });
  });
});

describe("the scheduler's log reading, bound per team namespace", () => {
  const logs = { clusterRole: "kernel-execution-kernel-scheduler-logs", serviceAccount: { namespace: "vennir-system", name: "kernel-execution-kernel" } };
  beforeAll(() => {
    config.teamNamespaces.schedulerLogs = logs;
  });
  afterAll(() => {
    config.teamNamespaces.schedulerLogs = null;
  });

  it("is bound in a new team's namespace, kept while it's retired, and bound again when it's back", async () => {
    vi.mocked(writeSchedulerLogsBinding).mockClear();
    expect((await call(admin, "TeamService/CreateTeam", { name: name("logs") })).code).toBe("ok");
    expect(writeSchedulerLogsBinding).toHaveBeenCalledWith(name("logs"), logs.clusterRole, logs.serviceAccount);
    vi.mocked(writeSchedulerLogsBinding).mockClear();
    await retire(name("logs"));
    expect(writeSchedulerLogsBinding).not.toHaveBeenCalled();
    await call(admin, "TeamService/UnretireTeam", { name: name("logs") });
    expect(writeSchedulerLogsBinding).toHaveBeenCalledWith(name("logs"), logs.clusterRole, logs.serviceAccount);
  });

  it("is bound in every team's namespace on a resync, and not at all when it isn't configured", async () => {
    await createTeam(name("logs-sync"));
    vi.mocked(writeSchedulerLogsBinding).mockClear();
    expect(await syncSchedulerLogsBindings()).toBe(true);
    expect(writeSchedulerLogsBinding).toHaveBeenCalledWith(name("logs-sync"), logs.clusterRole, logs.serviceAccount);
    config.teamNamespaces.schedulerLogs = null;
    vi.mocked(writeSchedulerLogsBinding).mockClear();
    expect(await syncSchedulerLogsBindings()).toBe(false);
    expect(writeSchedulerLogsBinding).not.toHaveBeenCalled();
    config.teamNamespaces.schedulerLogs = logs;
  });
});

describe("the default-deny network policy", () => {
  beforeAll(() => {
    config.teamNamespaces.defaultDenyIngress = true;
  });

  it("is written into a new team's namespace", async () => {
    expect((await call(admin, "TeamService/CreateTeam", { name: name("net") })).code).toBe("ok");
    expect(writeTeamNetworkPolicy).toHaveBeenCalledWith(name("net"), null, false);
  });

  it("isn't written when a team is retired, and is again when it comes back", async () => {
    await call(admin, "TeamService/CreateTeam", { name: name("net-retire") });
    vi.mocked(writeTeamNetworkPolicy).mockClear();
    await retire(name("net-retire"));
    expect(writeTeamNetworkPolicy).not.toHaveBeenCalled();
    await call(admin, "TeamService/UnretireTeam", { name: name("net-retire") });
    expect(writeTeamNetworkPolicy).toHaveBeenCalledWith(name("net-retire"), null, false);
  });

  it("is written into every team on a resync, and a failure is reported", async () => {
    await createTeam(name("net-sync"));
    expect(await syncTeamNetworkPolicies()).toBe(true);
    expect(writeTeamNetworkPolicy).toHaveBeenCalledWith(name("net-sync"), null, false);
    // With the gateway on, its Pods go with it.
    const gateway = { namespace: "vennir-system", labels: { "app.kubernetes.io/component": "gateway" } };
    config.teamNamespaces.gatewayIngress = gateway;
    await syncTeamNetworkPolicies();
    config.teamNamespaces.gatewayIngress = null;
    expect(writeTeamNetworkPolicy).toHaveBeenCalledWith(name("net-sync"), gateway, false);
    // With blockMetadata (EKS), the no-metadata policy goes too.
    config.teamNamespaces.blockMetadata = true;
    await syncTeamNetworkPolicies();
    config.teamNamespaces.blockMetadata = false;
    expect(writeTeamNetworkPolicy).toHaveBeenCalledWith(name("net-sync"), null, true);
    vi.mocked(writeTeamNetworkPolicy).mockImplementationOnce(() => Promise.reject(new Error("boom")));
    await expect(syncTeamNetworkPolicies()).rejects.toThrow("Couldn't write the network policy");
  });

  it("isn't written when turned off, or when the console doesn't manage namespaces", async () => {
    config.teamNamespaces.defaultDenyIngress = false;
    expect(await syncTeamNetworkPolicies()).toBe(false);
    config.teamNamespaces.defaultDenyIngress = true;
    config.teamNamespaces.manage = false;
    expect(await syncTeamNetworkPolicies()).toBe(false);
    config.teamNamespaces.manage = true;
    expect(writeTeamNetworkPolicy).not.toHaveBeenCalled();
  });
});

describe("the no-metadata network policy", () => {
  it("lets every Pod out anywhere but the instance metadata server", async () => {
    const { noMetadataPolicy } = await vi.importActual<typeof import("../src/k8s.js")>("../src/k8s.js");
    const policy = noMetadataPolicy("web");
    expect(policy.metadata?.name).toBe("vennir-no-metadata");
    expect(policy.spec?.podSelector).toEqual({});
    expect(policy.spec?.policyTypes).toEqual(["Egress"]);
    expect(policy.spec?.ingress).toBeUndefined();
    // IPv4 only: an IPv6 block made the AWS VPC CNI enforce none of the
    // namespace's policies on an IPv4 cluster.
    expect(policy.spec?.egress).toEqual([{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.169.254/32"] } }] }]);
  });
});
