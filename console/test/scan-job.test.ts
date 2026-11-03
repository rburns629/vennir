// SPDX-License-Identifier: MIT
/**
 * The scan Job k8s.ts builds and reads back: a container per platform
 * scanned, each one's output read. The Kubernetes API is faked at the
 * client's methods; what a real Job does is proven on kind.
 */
import * as k8s from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScanJob, readScanJob } from "../src/k8s.js";

beforeEach(() => {
  // No cluster: the client's methods are faked below.
  vi.spyOn(k8s.KubeConfig.prototype, "loadFromDefault").mockImplementation(function (this: k8s.KubeConfig) {
    this.loadFromClusterAndUser({ name: "fake", server: "https://kubernetes.invalid", skipTLSVerify: false }, { name: "fake" });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a scan Job", () => {
  it("has a container per platform, each with its own cache, the first named trivy", async () => {
    const created = vi.spyOn(k8s.BatchV1Api.prototype, "createNamespacedJob").mockResolvedValue({});
    await createScanJob({
      namespace: "vertra-system",
      name: "scan-x",
      scannerImage: "trivy@sha256:abc",
      serverUrl: "http://trivy:4954",
      serviceAccount: "scanner",
      pullSecretName: "",
      target: `registry.example/app@sha256:${"a".repeat(64)}`,
      insecure: false,
      platforms: ["linux/amd64", "linux/arm64"],
      template: "END\n",
    });
    const containers = created.mock.calls[0]?.[0].body.spec?.template.spec?.containers ?? [];
    expect(containers.map((c) => c.name)).toEqual(["trivy", "trivy-1"]);
    const flag = (args: string[] | undefined, name: string) => args?.[args.indexOf(name) + 1];
    expect(containers.map((c) => flag(c.args, "--platform"))).toEqual(["linux/amd64", "linux/arm64"]);
    expect(new Set(containers.map((c) => flag(c.args, "--cache-dir"))).size).toBe(2);
  });

  it("is read back with every platform's output, in order", async () => {
    vi.spyOn(k8s.BatchV1Api.prototype, "readNamespacedJob").mockResolvedValue({
      status: { conditions: [{ type: "Failed", status: "True" }] },
    } as k8s.V1Job);
    vi.spyOn(k8s.CoreV1Api.prototype, "listNamespacedPod").mockResolvedValue({
      items: [
        {
          metadata: { name: "scan-x-abcde", creationTimestamp: new Date() },
          spec: { containers: [{ name: "trivy" }, { name: "trivy-1" }] },
          status: { phase: "Failed" },
        },
      ],
    } as k8s.V1PodList);
    vi.spyOn(k8s.CoreV1Api.prototype, "readNamespacedPodLog").mockImplementation(({ container }) =>
      Promise.resolve(container === "trivy" ? "END\n" : "no child with platform linux/arm64 in index"),
    );
    expect(await readScanJob("vertra-system", "scan-x", "trivy", true)).toEqual({
      state: "failed",
      output: "END\n",
      outputs: ["END\n", "no child with platform linux/arm64 in index"],
    });
  });
});
