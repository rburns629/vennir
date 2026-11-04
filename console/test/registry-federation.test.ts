// SPDX-License-Identifier: MIT
/**
 * Reading a registry on another cloud with no stored key (M2): the
 * console's projected token exchanged at Google's STS, used directly or to
 * impersonate a service account, cached, and handed out as Docker config.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { federatedDockerConfig, federatedGcpToken, federatedHost, resetFederatedToken } from "../src/registryFederation.js";

const PROVIDER = "projects/123/locations/global/workloadIdentityPools/vennir/providers/eks";
const saved = { ...config.registryFederation };
const savedCredentials = new Map(config.registryCredentials);
let calls: { url: string; body: Record<string, unknown>; authorization: string | null }[];

function answer(responses: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        authorization: new Headers(init.headers).get("authorization"),
      });
      const host = new URL(url).host;
      return Promise.resolve(new Response(JSON.stringify(responses[host]), { status: responses[host] ? 200 : 403 }));
    }),
  );
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "federation-"));
  writeFileSync(join(dir, "token"), "projected-jwt\n");
  Object.assign(config.registryFederation, {
    gcpProvider: PROVIDER,
    gcpServiceAccount: "",
    hosts: ["us-central1-docker.pkg.dev"],
    tokenFile: join(dir, "token"),
  });
  resetFederatedToken();
});

afterEach(() => {
  Object.assign(config.registryFederation, saved);
  config.registryCredentials.clear();
  for (const [host, credential] of savedCredentials) config.registryCredentials.set(host, credential);
  vi.unstubAllGlobals();
});

describe("registry federation", () => {
  it("exchanges the projected token at Google's STS for the provider", async () => {
    answer({ "sts.googleapis.com": { access_token: "federated", expires_in: 3600 } });
    expect(await federatedGcpToken()).toBe("federated");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      audience: `//iam.googleapis.com/${PROVIDER}`,
      subjectToken: "projected-jwt",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
    });
  });

  it("impersonates the service account when one is set, with the federated token", async () => {
    config.registryFederation.gcpServiceAccount = "reader@catalog.iam.gserviceaccount.com";
    answer({
      "sts.googleapis.com": { access_token: "federated", expires_in: 3600 },
      "iamcredentials.googleapis.com": { accessToken: "impersonated", expireTime: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(await federatedGcpToken()).toBe("impersonated");
    expect(calls[1]?.url).toContain("reader%40catalog.iam.gserviceaccount.com:generateAccessToken");
    expect(calls[1]?.authorization).toBe("Bearer federated");
  });

  it("keeps a token until 15 minutes before it expires", async () => {
    answer({ "sts.googleapis.com": { access_token: "first", expires_in: 3600 } });
    await federatedGcpToken();
    await federatedGcpToken();
    expect(calls).toHaveLength(1);
    resetFederatedToken();
    answer({ "sts.googleapis.com": { access_token: "short", expires_in: 600 } });
    await federatedGcpToken();
    await federatedGcpToken();
    expect(calls).toHaveLength(2);
  });

  it("fails loudly, saying what Google said, rather than signing in anonymously", async () => {
    answer({});
    await expect(federatedGcpToken()).rejects.toThrow(/sts.googleapis.com answered 403/);
  });

  it("covers only its hosts, and hands out a Docker config with static credentials beside them", async () => {
    expect(federatedHost("us-central1-docker.pkg.dev")).toBe(true);
    expect(federatedHost("europe-docker.pkg.dev")).toBe(false);
    config.registryCredentials.set("ghcr.io", { username: "u", password: "p" });
    answer({ "sts.googleapis.com": { access_token: "federated", expires_in: 3600 } });
    const auths = (JSON.parse(await federatedDockerConfig()) as { auths: Record<string, { auth: string }> }).auths;
    expect(Buffer.from(auths["us-central1-docker.pkg.dev"]?.auth ?? "", "base64").toString()).toBe("oauth2accesstoken:federated");
    expect(Buffer.from(auths["ghcr.io"]?.auth ?? "", "base64").toString()).toBe("u:p");
  });

  it("is off without a provider", () => {
    config.registryFederation.gcpProvider = "";
    expect(federatedHost("us-central1-docker.pkg.dev")).toBe(false);
  });
});
