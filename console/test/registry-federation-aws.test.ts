// SPDX-License-Identifier: MIT
/**
 * Reading another install's Amazon ECR with no stored key (M2): the
 * console's projected token exchanged at AWS STS for the owner's role
 * (AssumeRoleWithWebIdentity), whose credentials ask ECR for its registry
 * token (the SDK is faked here, as in registry-ecr.test.ts), cached, used
 * for image checks and handed out as Docker config.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { checkImage } from "../src/registry.js";
import {
  federatedDockerConfig,
  federatedEcrCredential,
  federatedHost,
  federationEnabled,
  resetFederatedToken,
} from "../src/registryFederation.js";

const sends = vi.fn();
const clients: { region: string; credentials: Record<string, unknown> }[] = [];
vi.mock("@aws-sdk/client-ecr", () => ({
  ECRClient: vi.fn(function (this: { send: typeof sends }, options: { region: string; credentials: Record<string, unknown> }) {
    clients.push(options);
    this.send = sends;
  }),
  GetAuthorizationTokenCommand: vi.fn(),
}));

const HOST = "123456789012.dkr.ecr.us-east-2.amazonaws.com";
const ROLE = "arn:aws:iam::123456789012:role/vennir-reader-vennir-gke";
const saved = { ...config.registryFederation };
const savedEcrToken = config.registryEcrToken;
let stsCalls: { url: string; body: URLSearchParams }[];
let registryAuthorizations: (string | null)[];

function sts(status: number, body: string) {
  stsCalls = [];
  registryAuthorizations = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://sts.")) {
        stsCalls.push({ url, body: new URLSearchParams(String(init?.body)) });
        return Promise.resolve(new Response(body, { status }));
      }
      // The registry: ECR's Basic challenge, then the manifest.
      const authorization = new Headers(init?.headers).get("authorization");
      registryAuthorizations.push(authorization);
      if (!authorization) {
        return Promise.resolve(new Response(null, { status: 401, headers: { "www-authenticate": `Basic realm="https://${HOST}/",service="ecr.amazonaws.com"` } }));
      }
      return Promise.resolve(new Response(null, { status: 200, headers: { "docker-content-digest": `sha256:${"c".repeat(64)}` } }));
    }),
  );
}

function credentials(expiresInMs: number): string {
  return `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
    <AccessKeyId>ASIAEXAMPLE</AccessKeyId><SecretAccessKey>secret-key</SecretAccessKey>
    <SessionToken>session-token</SessionToken><Expiration>${new Date(Date.now() + expiresInMs).toISOString()}</Expiration>
  </Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "federation-aws-"));
  writeFileSync(join(dir, "token"), "projected-jwt\n");
  Object.assign(config.registryFederation, { gcpProvider: "", gcpServiceAccount: "", awsRoleArn: ROLE, hosts: [HOST], tokenFile: join(dir, "token") });
  config.registryEcrToken = false;
  clients.length = 0;
  sends.mockReset().mockResolvedValue({
    authorizationData: [{ authorizationToken: Buffer.from("AWS:ecr-password").toString("base64"), expiresAt: new Date(Date.now() + 12 * 3_600_000) }],
  });
  resetFederatedToken();
});

afterEach(() => {
  Object.assign(config.registryFederation, saved);
  config.registryEcrToken = savedEcrToken;
  vi.unstubAllGlobals();
});

describe("registry federation to Amazon ECR", () => {
  it("assumes the owner's role with the projected token, then asks ECR as that role", async () => {
    sts(200, credentials(3_600_000));
    expect(await federatedEcrCredential(HOST)).toEqual({ username: "AWS", password: "ecr-password" });
    expect(stsCalls).toHaveLength(1);
    expect(stsCalls[0]?.url).toBe("https://sts.us-east-2.amazonaws.com/");
    expect(Object.fromEntries(stsCalls[0]?.body ?? [])).toMatchObject({
      Action: "AssumeRoleWithWebIdentity",
      RoleArn: ROLE,
      WebIdentityToken: "projected-jwt",
    });
    expect(clients[0]?.region).toBe("us-east-2");
    expect(clients[0]?.credentials).toMatchObject({ accessKeyId: "ASIAEXAMPLE", secretAccessKey: "secret-key", sessionToken: "session-token" });
  });

  it("keeps the credential until 15 minutes before the role's session ends", async () => {
    sts(200, credentials(3_600_000));
    await federatedEcrCredential(HOST);
    await federatedEcrCredential(HOST);
    expect(stsCalls).toHaveLength(1);
    resetFederatedToken();
    sts(200, credentials(10 * 60_000));
    await federatedEcrCredential(HOST);
    await federatedEcrCredential(HOST);
    expect(stsCalls).toHaveLength(2);
  });

  it("fails loudly, saying what STS said and never the token, rather than asking anonymously", async () => {
    sts(
      403,
      "<ErrorResponse><Error><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error></ErrorResponse>",
    );
    const error = await federatedEcrCredential(HOST).catch((e: unknown) => e as Error);
    expect(error.message).toMatch(/AWS STS answered 403 \(AccessDenied: Not authorized/);
    expect(error.message).not.toContain("projected-jwt");
    expect(sends).not.toHaveBeenCalled();
  });

  it("covers only its host, and hands out ECR's token as Docker config", async () => {
    expect(federationEnabled()).toBe(true);
    expect(federatedHost(HOST)).toBe(true);
    expect(federatedHost("210987654321.dkr.ecr.us-east-2.amazonaws.com")).toBe(false);
    sts(200, credentials(3_600_000));
    const auths = (JSON.parse(await federatedDockerConfig()) as { auths: Record<string, { auth: string }> }).auths;
    expect(Buffer.from(auths[HOST]?.auth ?? "", "base64").toString()).toBe("AWS:ecr-password");
  });

  it("signs the console's image checks in to the owner's registry", async () => {
    sts(200, credentials(3_600_000));
    const image = `${HOST}/vennir-products/platform/p-${randomUUID().slice(0, 8)}:latest`;
    expect(await checkImage(image, [`${HOST}/vennir-products/`])).toBe("available");
    expect(registryAuthorizations).toEqual([null, `Basic ${Buffer.from("AWS:ecr-password").toString("base64")}`]);
  });

  it("is off without a role or a provider", () => {
    config.registryFederation.awsRoleArn = "";
    expect(federationEnabled()).toBe(false);
    expect(federatedHost(HOST)).toBe(false);
  });
});
