// SPDX-License-Identifier: MIT
/**
 * The scan Job k8s.ts builds and reads back: a container per platform
 * scanned, each one's output read, and the script each runs Trivy with. The Kubernetes API is faked at the
 * client's methods; what a real Job does is proven on kind.
 */
import * as k8s from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScanJob, NO_PLATFORM_MARKER, readScanJob, SCAN_SCRIPT } from "../src/k8s.js";

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
      namespace: "vennir-system",
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
    expect(containers.every((c) => c.command?.join(" ") === `sh -c ${SCAN_SCRIPT} scan`)).toBe(true);
  });

  it("runs Trivy as it would, except that a platform the image hasn't is a clean exit, marked", async () => {
    // A stand-in trivy on PATH: says what it was given, and fails as asked.
    const bin = mkdtempSync(join(tmpdir(), "fake-trivy-"));
    writeFileSync(
      join(bin, "trivy"),
      '#!/bin/sh\nprintf "%s\\n" "$@"\ncase "$FAKE" in\n  absent) echo "remote error: no child with platform linux/arm64 in index x" >&2; exit 1;;\n  down) echo "dial tcp: connection refused" >&2; exit 1;;\nesac\necho END\n',
    );
    chmodSync(join(bin, "trivy"), 0o755);
    const run = (fake: string) => {
      const result = spawnSync("sh", ["-c", SCAN_SCRIPT, "scan", "image", "--platform", "linux/arm64", "a b;$(x)"], {
        env: { PATH: `${bin}:/usr/bin:/bin`, FAKE: fake },
        encoding: "utf8",
      });
      return { code: result.status, out: result.stdout };
    };
    try {
      // Arguments reach Trivy as they are, never as shell.
      expect(run("ok")).toEqual({ code: 0, out: "image\n--platform\nlinux/arm64\na b;$(x)\nEND\n" });
      const absent = run("absent");
      expect(absent.code).toBe(0);
      expect(absent.out.trim().split("\n").at(-1)).toBe(NO_PLATFORM_MARKER);
      const down = run("down");
      expect(down.code).toBe(1);
      expect(down.out).toContain("connection refused");
      expect(down.out).not.toContain(NO_PLATFORM_MARKER);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
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
    expect(await readScanJob("vennir-system", "scan-x", "trivy", true)).toEqual({
      state: "failed",
      output: "END\n",
      outputs: ["END\n", "no child with platform linux/arm64 in index"],
    });
  });
});
