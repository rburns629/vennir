// SPDX-License-Identifier: MIT
/**
 * ECR's registry credential from the console's own AWS identity
 * (config.registryEcrToken): fetched from ECR (the SDK is faked here; the
 * real one is proven on EKS), sent as ECR's Basic challenge asks, kept until
 * shortly before it expires, and never asked for other registries.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { checkImage } from "../src/registry.js";

const sends = vi.fn();
vi.mock("@aws-sdk/client-ecr", () => ({
  ECRClient: vi.fn(function (this: { region: string; send: typeof sends }, options: { region: string }) {
    this.region = options.region;
    this.send = sends;
  }),
  GetAuthorizationTokenCommand: vi.fn(),
}));

const HOST = "123456789012.dkr.ecr.us-east-1.amazonaws.com";
const ALLOWED = [`${HOST}/vennir-products/`];
const BASIC = `Basic ${Buffer.from("AWS:ecr-password").toString("base64")}`;
let authorizations: (string | undefined)[];

beforeEach(() => {
  authorizations = [];
  config.registryEcrToken = true;
  sends.mockReset().mockResolvedValue({
    authorizationData: [
      { authorizationToken: Buffer.from("AWS:ecr-password").toString("base64"), expiresAt: new Date(Date.now() + 12 * 3_600_000) },
    ],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.["authorization"];
      authorizations.push(authorization);
      if (authorization !== BASIC) {
        return Promise.resolve(new Response(null, { status: 401, headers: { "www-authenticate": `Basic realm="https://${HOST}/",service="ecr.amazonaws.com"` } }));
      }
      return Promise.resolve(new Response(null, { status: 200, headers: { "docker-content-digest": `sha256:${"b".repeat(64)}` } }));
    }),
  );
});

afterEach(() => {
  config.registryEcrToken = false;
  vi.unstubAllGlobals();
});

function image(): string {
  return `${HOST}/vennir-products/platform/p-${randomUUID().slice(0, 8)}:latest`;
}

describe("ECR's credential", () => {
  it("comes from the console's AWS identity and answers ECR's Basic challenge", async () => {
    expect(await checkImage(image(), ALLOWED)).toBe("available");
    expect(authorizations).toEqual([undefined, BASIC]);
  });

  it("is kept for its lifetime, not fetched per image", async () => {
    await checkImage(image(), ALLOWED);
    await checkImage(image(), ALLOWED);
    expect(sends.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("isn't asked for when the setting is off", async () => {
    config.registryEcrToken = false;
    expect(await checkImage(image(), ALLOWED)).toBe("unverified");
    expect(sends).not.toHaveBeenCalled();
  });
});
