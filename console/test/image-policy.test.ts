// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, createUser, setUserAdmin } from "../src/db/queries.js";
import { teams, users } from "../src/db/schema.js";
import {
  allowedPrefixes,
  hasUppercaseName,
  imageRefusal,
  invalidSourceReason,
  isBroadSource,
  isImageAllowed,
  isPlainReference,
  normalizeImage,
  type ImagePolicy,
} from "../src/imagePolicy.js";
import { PLAIN_REFERENCE } from "../src/imageRef.js";
import { buildApp } from "../src/index.js";
import { caller, failureDetail, type RpcError } from "./rpc.js";
import { submitExecution } from "../src/kernel/client.js";
import { ImagePolicyConflictError, writeImagePolicyData } from "../src/k8s.js";

// The cluster's policy is the only thing faked: `stored` plays it.
let stored: { source: string; additional: string[]; version: string } | null;
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  readImagePolicyData: vi.fn(() => Promise.resolve(stored)),
  writeImagePolicyData: vi.fn(),
}));
vi.mock("../src/kernel/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/client.js")>();
  const { randomUUID: uuid } = await import("node:crypto");
  return { ...actual, submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })) };
});

const SOURCE = "us-central1-docker.pkg.dev/proj/catalog-products";

function policy(source: string, additional: string[] = []): ImagePolicy {
  return { exists: true, source, additional, version: "1" };
}

describe("the rules (the same ones image-policy.yaml's CEL applies)", () => {
  const prefixes = allowedPrefixes(policy(SOURCE, ["docker.io/library"]));

  it.each([
    [`${SOURCE}/app:1`, true],
    [`${SOURCE}-evil/app:1`, false],
    ["us-central1-docker.pkg.dev/other/catalog-products/app:1", false],
    ["node:20", true],
    ["docker.io/library/python:3.12", true],
    ["team/app:1", false],
    ["docker.io/evil/app", false],
    ["localhost:5001/app:1", false],
    // Uppercase anywhere but the tag: a host matched as written isn't the
    // registry's view of it, and an uppercase first part is a host to Docker.
    [`${SOURCE.toUpperCase()}/app:1`, false],
    [`${SOURCE}/App:1`, false],
    [`${SOURCE}/app:Latest`, true],
    [`${SOURCE}/app:Latest@sha256:${"a".repeat(64)}`, true],
    ["Node:20", false],
    ["Library/node:20", false],
    ["docker.io/Library/node:20", false],
    // Only a reference written the registries' way: a prefix of anything
    // else doesn't say where the image is.
    [`${SOURCE}/../../other/private/app:1`, false],
    [`${SOURCE}/./app:1`, false],
    [`${SOURCE}//app:1`, false],
    [`${SOURCE}/app?x=1`, false],
    [`${SOURCE}/app#x`, false],
    [`${SOURCE}/app%2f..%2fother:1`, false],
    [`${SOURCE}/app\\other:1`, false],
    [`${SOURCE}/app :1`, false],
    [`${SOURCE}/app:`, false],
    [`${SOURCE}/app@sha256:abc`, false],
    [`${SOURCE}/team_a/my-app.v2__x:1.2-rc_1`, true],
    [`${SOURCE}/app:latest@sha256:${"a".repeat(64)}`, true],
    [`${SOURCE}/app@sha256:${"a".repeat(64)}`, true],
  ])("%s allowed: %s", (image, allowed) => {
    expect(isImageAllowed(image, prefixes)).toBe(allowed);
  });

  it("finds uppercase in a registry or repository, never in a tag", () => {
    for (const image of ["Registry.Example/app", "registry.example:5000/a/B/c:1", "Team/app", "app:1/X", "App", "App:1", "App@sha256:x", "localhost:5001/A"]) {
      expect(hasUppercaseName(image), image).toBe(true);
    }
    for (const image of ["registry.example/app:LATEST", "localhost:5001/app:V1@sha256:abc", "node:Twenty", "a/b/c"]) {
      expect(hasUppercaseName(image), image).toBe(false);
    }
  });

  it("explains an uppercase refusal", () => {
    expect(imageRefusal([`${SOURCE}/App:1`], policy(SOURCE))?.message).toMatch(/uppercase letter in the registry or repository/);
  });

  it("explains a refusal of something that isn't a reference", () => {
    const refusal = imageRefusal([`${SOURCE}/../../other/app:1`], policy(SOURCE));
    expect(refusal?.error).toBe("IMAGE_NOT_ALLOWED");
    expect(refusal?.message).toMatch(/isn't written as an image reference/);
  });

  it("is the expression the cluster's policy applies", () => {
    const chart = readFileSync(new URL("../../helm/charts/execution-kernel/templates/image-policy.yaml", import.meta.url), "utf8");
    // A RegExp's source writes "/" as "\\/".
    expect(chart).toContain(`"${PLAIN_REFERENCE.source.replaceAll("\\/", "/")}"`);
  });

  it("takes every way of writing a registry host", () => {
    for (const image of ["localhost:5001/local/app:1", "registry.example:5000/a/b/c", "node", "node:20", "team/app", "123456789012.dkr.ecr.us-east-1.amazonaws.com/a/b:1", "my-registry.azurecr.io/app:1"]) {
      expect(isPlainReference(image), image).toBe(true);
    }
  });

  it("reads short names the way the kubelet does", () => {
    expect(normalizeImage("node:20")).toBe("docker.io/library/node:20");
    expect(normalizeImage("team/app")).toBe("docker.io/team/app");
    expect(normalizeImage("localhost:5001/app")).toBe("localhost:5001/app");
    // Docker reads an uppercase first part as a registry host.
    expect(normalizeImage("Team/app")).toBe("Team/app");
  });

  it("only accepts registry paths as sources, and flags whole-registry ones", () => {
    expect(invalidSourceReason(SOURCE)).toBeNull();
    expect(invalidSourceReason("https://localhost:5001")).toBeNull();
    expect(invalidSourceReason("catalog-products")).toMatch(/registry host/);
    expect(invalidSourceReason(`${SOURCE}/app:1`)).toMatch(/tag/);
    expect(invalidSourceReason(`${SOURCE}/app@sha256:abc`)).toMatch(/digest/);
    expect(invalidSourceReason("   ")).toMatch(/empty/);
    // Written into the policy as a CEL string literal: nothing that could close it.
    expect(invalidSourceReason('localhost:5001/x"+"y')).toMatch(/letters, digits/);
    expect(invalidSourceReason("localhost:5001/x\\")).toMatch(/letters, digits/);
    expect(isBroadSource("docker.io")).toBe(true);
    expect(isBroadSource("docker.io/library")).toBe(false);
  });

  it("explains a refusal, naming what is allowed", () => {
    const refusal = imageRefusal(["docker.io/evil/app", `${SOURCE}/ok:1`], policy(SOURCE));
    expect(refusal?.error).toBe("IMAGE_NOT_ALLOWED");
    expect(refusal?.disallowedImages).toEqual(["docker.io/evil/app"]);
    expect(refusal?.message).toContain(`Allowed: ${SOURCE}/`);
  });

  it("refuses everything until a source is configured", () => {
    expect(imageRefusal([`${SOURCE}/ok:1`], policy(""))?.error).toBe("IMAGE_POLICY_NOT_CONFIGURED");
    const missing = imageRefusal(["x"], { exists: false, source: "", additional: [], version: "" });
    expect(missing?.message).toContain("image policy doesn't exist");
  });
});

describe("the routes", () => {
  const prefix = `imgpol-${randomUUID().slice(0, 6)}`;
  const emails: string[] = [];
  let app: FastifyInstance;
  let admin: string;
  let member: string;
  let teamName: string;

  async function newUser(isAdmin: boolean): Promise<string> {
    const email = `${prefix}-${randomUUID()}@example.com`;
    emails.push(email);
    const user = await createUser(email, await hashPassword("correct-horse-battery"));
    if (isAdmin) await setUserAdmin(user.id, true);
    return user.id;
  }

  const call = caller(() => app);
  const as = <T = Record<string, unknown>>(userId: string, procedure: string, body: object = {}) =>
    call<T>(app.jwt.sign({ userId }), procedure, body);

  function submit(image: string) {
    return as<RpcError>(member, "ExecutionService/SubmitExecution", {
      dag: { name: "img", requestId: randomUUID(), tasks: [{ id: "t", image, action: "create", team: teamName }] },
    });
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    admin = await newUser(true);
    member = await newUser(false);
    teamName = `${prefix}-team`;
    const team = await createTeam(teamName);
    await addTeamMember(member, team.id);
  });

  beforeEach(() => {
    stored = { source: `${SOURCE}/`, additional: [], version: "7" };
    vi.mocked(submitExecution).mockClear();
    vi.mocked(writeImagePolicyData).mockReset().mockResolvedValue("8");
  });

  afterAll(async () => {
    await app.close();
    await db.delete(teams).where(inArray(teams.name, [teamName]));
    await db.delete(users).where(inArray(users.email, emails));
  });

  it("refuses a submission from outside the allowed sources and says what's allowed", async () => {
    const refused = await submit("docker.io/evil/app:1");
    expect(refused.code).toBe("invalid_argument");
    expect(refused.failure).toBe("IMAGE_NOT_ALLOWED");
    expect(failureDetail(refused.body)?.["allowedSources"]).toEqual([`${SOURCE}/`]);
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("refuses everything while no source is configured", async () => {
    stored = { source: "", additional: [], version: "7" };
    const refused = await submit(`${SOURCE}/app:1`);
    expect(refused.code).toBe("invalid_argument");
    expect(refused.failure).toBe("IMAGE_POLICY_NOT_CONFIGURED");
  });

  it("lets anyone signed in read the sources, but only admins change them", async () => {
    const read = await as<{ policy: { allowed: string[] } }>(member, "ImageService/GetImagePolicy");
    expect(read.code).toBe("ok");
    expect(read.body.policy.allowed).toEqual([`${SOURCE}/`]);

    const change = { source: SOURCE, additional: ["docker.io/library"], version: "7" };
    expect((await as(member, "ImageService/SetImagePolicy", change)).code).toBe("permission_denied");
    expect(writeImagePolicyData).not.toHaveBeenCalled();

    const saved = await as<{ policy: { allowed: string[] } }>(admin, "ImageService/SetImagePolicy", change);
    expect(saved.code).toBe("ok");
    expect(saved.body.policy.allowed).toEqual([`${SOURCE}/`, "docker.io/library/"]);
    expect(writeImagePolicyData).toHaveBeenCalledWith(
      "kernel-execution-kernel-image",
      { source: `${SOURCE}/`, additional: ["docker.io/library/"] },
      "7",
    );
    // Who saved it last, from the audit log: for admins only.
    const after = await as<{ policy: { lastSavedBy?: string; lastSavedAt?: string } }>(admin, "ImageService/GetImagePolicy");
    expect(after.body.policy.lastSavedBy).toBe(emails[0]);
    expect(after.body.policy.lastSavedAt).toBeTruthy();
    expect((await as<{ policy: { lastSavedBy?: string } }>(member, "ImageService/GetImagePolicy")).body.policy.lastSavedBy ?? "").toBe("");
  });

  it("rejects an invalid source, and a save based on a stale version", async () => {
    const bad = await as(admin, "ImageService/SetImagePolicy", { source: "catalog-products", additional: [], version: "7" });
    expect(bad.code).toBe("invalid_argument");
    expect(bad.message).toContain("registry host");

    vi.mocked(writeImagePolicyData).mockRejectedValueOnce(new ImagePolicyConflictError("stale"));
    const stale = await as(admin, "ImageService/SetImagePolicy", { source: SOURCE, additional: [], version: "6" });
    expect(stale.code).toBe("failed_precondition");
    expect(stale.message).toContain("Reload");
  });

  it("says so when the cluster's policy itself is missing", async () => {
    stored = null;
    const saved = await as(admin, "ImageService/SetImagePolicy", { source: SOURCE, additional: [], version: "7" });
    expect(saved.code).toBe("failed_precondition");
    expect(saved.failure).toBe("IMAGE_POLICY_MISSING");
  });
});
