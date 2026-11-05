// SPDX-License-Identifier: MIT
/**
 * Syncing a secret writes an ExternalSecret (k8s.ts,
 * upsertExternalSecretGrant): the console replaces only its own, labelled
 * as it labels everything it makes, and never adopts one made elsewhere.
 * The Kubernetes API is faked at the client's methods; the write fence's
 * matching rule is proven on kind (helm/tests/admission-policies.sh).
 */
import * as k8s from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretNotManagedError, upsertExternalSecretGrant } from "../src/k8s.js";

const notFound = () => Object.assign(new Error("not found"), { code: 404 });
const conflict = () => Object.assign(new Error("exists"), { code: 409 });
const grant = (alreadyGranted: boolean) => ({
  namespace: "team-a",
  secretName: "db-key",
  secretStoreName: "vault",
  alreadyGranted,
  keys: [{ secretKey: "password", remoteKey: "db/password" }],
});

let existing: { metadata: k8s.V1ObjectMeta } | undefined;
let secretThere: boolean;

beforeEach(() => {
  vi.spyOn(k8s.KubeConfig.prototype, "loadFromDefault").mockImplementation(function (this: k8s.KubeConfig) {
    this.loadFromClusterAndUser({ name: "fake", server: "https://kubernetes.invalid", skipTLSVerify: false }, { name: "fake" });
  });
  existing = undefined;
  secretThere = false;
  vi.spyOn(k8s.CoreV1Api.prototype, "readNamespace").mockResolvedValue({ metadata: { name: "team-a" } });
  // The dry-run create that tells whether a Secret of that name exists.
  vi.spyOn(k8s.CoreV1Api.prototype, "createNamespacedSecret").mockImplementation(() =>
    secretThere ? Promise.reject(conflict()) : Promise.resolve({}),
  );
  vi.spyOn(k8s.RbacAuthorizationV1Api.prototype, "listNamespacedRoleBinding").mockResolvedValue({ items: [] });
  vi.spyOn(k8s.RbacAuthorizationV1Api.prototype, "deleteNamespacedRole").mockRejectedValue(notFound());
  vi.spyOn(k8s.CustomObjectsApi.prototype, "getNamespacedCustomObject").mockImplementation(() =>
    existing ? Promise.resolve(existing) : Promise.reject(notFound()),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("syncing a secret's ExternalSecret", () => {
  it("creates one, labelled the console's", async () => {
    const created = vi.spyOn(k8s.CustomObjectsApi.prototype, "createNamespacedCustomObject").mockResolvedValue({});
    await upsertExternalSecretGrant(grant(false));
    const body = created.mock.calls[0]?.[0].body as { metadata: k8s.V1ObjectMeta };
    expect(body.metadata.labels).toEqual({ "app.kubernetes.io/managed-by": "vennir-console" });
  });

  it("replaces its own, as it read it", async () => {
    existing = { metadata: { name: "db-key", resourceVersion: "7", labels: { "app.kubernetes.io/managed-by": "vennir-console" } } };
    const replaced = vi.spyOn(k8s.CustomObjectsApi.prototype, "replaceNamespacedCustomObject").mockResolvedValue({});
    await upsertExternalSecretGrant(grant(true));
    const body = replaced.mock.calls[0]?.[0].body as { metadata: k8s.V1ObjectMeta };
    expect(body.metadata.resourceVersion).toBe("7");
  });

  it("registers a Secret its own ExternalSecret syncs", async () => {
    existing = { metadata: { name: "db-key", labels: { "app.kubernetes.io/managed-by": "vennir-console" } } };
    secretThere = true;
    const replaced = vi.spyOn(k8s.CustomObjectsApi.prototype, "replaceNamespacedCustomObject").mockResolvedValue({});
    await upsertExternalSecretGrant(grant(false));
    expect(replaced).toHaveBeenCalledOnce();
  });

  it("refuses one it didn't make, registered or not, and writes nothing", async () => {
    const replaced = vi.spyOn(k8s.CustomObjectsApi.prototype, "replaceNamespacedCustomObject").mockResolvedValue({});
    const created = vi.spyOn(k8s.CustomObjectsApi.prototype, "createNamespacedCustomObject").mockResolvedValue({});
    for (const labels of [undefined, {}, { "app.kubernetes.io/managed-by": "someone-else" }]) {
      existing = { metadata: { name: "db-key", ...(labels ? { labels } : {}) } };
      secretThere = true;
      await expect(upsertExternalSecretGrant(grant(false))).rejects.toThrow(SecretNotManagedError);
      await expect(upsertExternalSecretGrant(grant(true))).rejects.toThrow(/ExternalSecret named "db-key".*wasn't created by the console/);
    }
    expect(replaced).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
  });

  it("refuses a Secret of that name that isn't the team's and nothing of its syncs", async () => {
    secretThere = true;
    const created = vi.spyOn(k8s.CustomObjectsApi.prototype, "createNamespacedCustomObject").mockResolvedValue({});
    await expect(upsertExternalSecretGrant(grant(false))).rejects.toThrow(/A Secret named "db-key"/);
    expect(created).not.toHaveBeenCalled();
  });
});
