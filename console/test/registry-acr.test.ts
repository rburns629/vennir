// SPDX-License-Identifier: MIT
/**
 * ACR's registry credential from the console's own Entra identity
 * (config.registryAcrToken): AKS Workload Identity's token file exchanged at
 * Entra for an access token, that exchanged at the registry for a refresh
 * token, which answers its Bearer challenge as `az acr login` does. Entra
 * and ACR are faked here; the real ones are to be proven on AKS. Kept, not
 * fetched per image, and never asked for other registries.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { checkImage } from "../src/registry.js";

const HOST = "vennirproducts.azurecr.io";
const ALLOWED = [`${HOST}/`];
const ACR_USER = "00000000-0000-0000-0000-000000000000";
const TENANT = "11111111-2222-3333-4444-555555555555";
let calls: { url: string; body: URLSearchParams | null; authorization?: string }[];

beforeEach(() => {
  calls = [];
  config.registryAcrToken = true;
  const tokenFile = join(mkdtempSync(join(tmpdir(), "acr-")), "token");
  writeFileSync(tokenFile, "projected-sa-token\n");
  vi.stubEnv("AZURE_CLIENT_ID", "console-client-id");
  vi.stubEnv("AZURE_TENANT_ID", TENANT);
  vi.stubEnv("AZURE_FEDERATED_TOKEN_FILE", tokenFile);
  vi.stubEnv("AZURE_AUTHORITY_HOST", "https://login.microsoftonline.com/");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = (init?.headers as Record<string, string> | undefined)?.["authorization"];
      const body = init?.body instanceof URLSearchParams ? init.body : null;
      calls.push({ url, body, authorization });
      if (url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
        return Promise.resolve(Response.json({ access_token: "entra-token", expires_in: 3600 }));
      }
      if (url === `https://${HOST}/oauth2/exchange`) {
        return Promise.resolve(Response.json({ refresh_token: "acr-refresh-token" }));
      }
      if (url.startsWith(`https://${HOST}/oauth2/token?`)) {
        const ok = authorization === `Basic ${Buffer.from(`${ACR_USER}:acr-refresh-token`).toString("base64")}`;
        return Promise.resolve(ok ? Response.json({ access_token: "acr-access-token" }) : new Response(null, { status: 401 }));
      }
      if (authorization !== "Bearer acr-access-token") {
        return Promise.resolve(
          new Response(null, { status: 401, headers: { "www-authenticate": `Bearer realm="https://${HOST}/oauth2/token",service="${HOST}"` } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 200, headers: { "docker-content-digest": `sha256:${"c".repeat(64)}` } }));
    }),
  );
});

afterEach(() => {
  config.registryAcrToken = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function image(): string {
  return `${HOST}/platform/p-${randomUUID().slice(0, 8)}:latest`;
}

describe("ACR's credential", () => {
  it("comes from the console's Entra identity and answers ACR's Bearer challenge", async () => {
    expect(await checkImage(image(), ALLOWED)).toBe("available");
    const entra = calls.find((c) => c.url.includes("login.microsoftonline.com"));
    expect(Object.fromEntries(entra?.body ?? [])).toEqual({
      client_id: "console-client-id",
      scope: "https://management.azure.com/.default",
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: "projected-sa-token",
    });
    const exchange = calls.find((c) => c.url.endsWith("/oauth2/exchange"));
    expect(Object.fromEntries(exchange?.body ?? [])).toEqual({ grant_type: "access_token", service: HOST, access_token: "entra-token" });
  });

  it("is kept, not fetched per image", async () => {
    await checkImage(image(), ALLOWED);
    await checkImage(image(), ALLOWED);
    expect(calls.filter((c) => c.url.endsWith("/oauth2/exchange")).length).toBeLessThanOrEqual(1);
  });

  it("isn't asked for when the setting is off, or for another registry", async () => {
    config.registryAcrToken = false;
    expect(await checkImage(image(), ALLOWED)).toBe("unverified");
    config.registryAcrToken = true;
    expect(await checkImage("example.com/x/y:1", ["example.com/"])).toBe("unverified");
    expect(calls.some((c) => c.url.includes("login.microsoftonline.com") || c.url.endsWith("/oauth2/exchange"))).toBe(false);
  });
});
