// SPDX-License-Identifier: MIT
/**
 * The identity policy's two shapes, as k8s.ts's updateIdentityPolicy tells
 * its build: the full policy, which matches releases (it has `candidates`),
 * and, with the kernel chart's catalogPolicy (decision 27), one that
 * matches none, the kernel writing them into a policy of its own; its
 * release maps are inert then, kept for a console from before during the
 * upgrade. The Kubernetes API is faked at the client's methods; kind proves
 * the real thing.
 */
import * as k8s from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateIdentityPolicy } from "../src/k8s.js";

const DIGITS = "0123456789abcdef".split("");
const variable = (name: string, expression = "{}") => ({ name, expression });
const literals = () => [variable("teamSecrets"), variable("products", "[]"), ...DIGITS.map((d) => variable(`releases${d}`))];

function policy(variables: { name: string; expression: string }[]): k8s.V1ValidatingAdmissionPolicy {
  return { metadata: { name: "kernel-execution-kernel-identity", resourceVersion: "1" }, spec: { variables } };
}

beforeEach(() => {
  vi.spyOn(k8s.KubeConfig.prototype, "loadFromDefault").mockImplementation(function (this: k8s.KubeConfig) {
    this.loadFromClusterAndUser({ name: "fake", server: "https://kubernetes.invalid", skipTLSVerify: false }, { name: "fake" });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the identity policy's shape", () => {
  it("full: it holds releases, and only changed literals are written", async () => {
    const read = policy([...literals(), variable("releases", "{...}"), variable("candidates", "[]"), variable("matched", "[]")]);
    vi.spyOn(k8s.AdmissionregistrationV1Api.prototype, "readValidatingAdmissionPolicy").mockResolvedValue(read);
    const replaced = vi.spyOn(k8s.AdmissionregistrationV1Api.prototype, "replaceValidatingAdmissionPolicy").mockResolvedValue(read);
    let holds: boolean | undefined;
    await updateIdentityPolicy("kernel-execution-kernel-identity", async (current, shape) => {
      holds = shape.holdsReleases;
      return { ...current, teamSecrets: '{"a":"k"}' };
    });
    expect(holds).toBe(true);
    const written = replaced.mock.calls[0]?.[0].body.spec?.variables ?? [];
    expect(written.find((v) => v.name === "teamSecrets")?.expression).toBe('{"a":"k"}');
    expect(written.map((v) => v.name)).toContain("candidates");
  });

  it("with catalogPolicy: it holds none (no candidates), its literals all still there", async () => {
    const read = policy([...literals(), variable("pod", "object.spec.template.spec"), variable("secrets", "[]")]);
    vi.spyOn(k8s.AdmissionregistrationV1Api.prototype, "readValidatingAdmissionPolicy").mockResolvedValue(read);
    const replaced = vi.spyOn(k8s.AdmissionregistrationV1Api.prototype, "replaceValidatingAdmissionPolicy").mockResolvedValue(read);
    let holds: boolean | undefined;
    await updateIdentityPolicy("kernel-execution-kernel-identity", async (current, shape) => {
      holds = shape.holdsReleases;
      return current;
    });
    expect(holds).toBe(false);
    expect(replaced).not.toHaveBeenCalled();
  });

  it("a policy without its literals is an older chart's", async () => {
    vi.spyOn(k8s.AdmissionregistrationV1Api.prototype, "readValidatingAdmissionPolicy").mockResolvedValue(
      policy([variable("teamSecrets"), variable("pod", "object.spec.template.spec")]),
    );
    await expect(updateIdentityPolicy("kernel-execution-kernel-identity", async (current) => current)).rejects.toThrow(/upgrade the kernel chart/);
  });
});
