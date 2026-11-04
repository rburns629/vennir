// SPDX-License-Identifier: MIT
/**
 * Reading a registry this install can't read as itself with no stored key
 * (M2): another install's catalog, on another cloud or in another AWS
 * account. The console's own ServiceAccount token, projected for the
 * other side (its audience), is exchanged there for a short-lived
 * credential:
 *   - Google Artifact Registry: at Google's STS for an access token
 *     (Workload Identity Federation), used directly or to impersonate a
 *     service account;
 *   - Amazon ECR: at AWS STS (AssumeRoleWithWebIdentity) for the owner's
 *     role's credentials, which ask ECR for its registry token. The role
 *     trusts this cluster's console alone and reads only the catalog
 *     (`vennir catalog grant`).
 * Nothing is stored that outlives the token.
 *
 * The console federates once, for everything that reads the registry:
 * image checks and releases (registry.ts), and, written as Docker config
 * Secrets every policy sync (pullSecret.ts), the verify and scan Jobs
 * (REGISTRY_TOKEN_SECRET in this namespace) and the kubelet and
 * policy-controller pulling steps' images (vennir-pull in each team
 * namespace). A token is replaced 15 minutes before it expires and the
 * sync runs every few minutes, so those Secrets always hold one that's
 * still good.
 */
import { readFile } from "node:fs/promises";
import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { config } from "./config.js";

const STS_URL = "https://sts.googleapis.com/v1/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const REQUEST_TIMEOUT_MS = 10_000;
const REFRESH_BEFORE_MS = 15 * 60_000;
/** An ECR registry: <account>.dkr.ecr.<region>.amazonaws.com. */
const ECR_HOST = /^\d{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const seconds = (value: unknown): number => (typeof value === "number" ? value : 3600);

export interface RegistryCredential {
  username: string;
  password: string;
}

let cached: { value: string; expiresAt: number } | null = null;
const cachedEcr = new Map<string, RegistryCredential & { expiresAt: number }>();

/** Whether federation is configured, to Google or to AWS. */
export function federationEnabled(): boolean {
  return config.registryFederation.gcpProvider !== "" || config.registryFederation.awsRoleArn !== "";
}

/** Whether federation is configured, and covers `host`. */
export function federatedHost(host: string): boolean {
  return federationEnabled() && config.registryFederation.hosts.includes(host);
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    // Google's error bodies say what's wrong (an audience, a binding) and
    // hold no secret; the request's token is never echoed back.
    throw new Error(`${new URL(url).host} answered ${String(response.status)}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function projectedToken(): Promise<string> {
  return (await readFile(config.registryFederation.tokenFile, "utf8")).trim();
}

/** A Google access token for the federated identity, cached until 15 minutes before it expires. */
export async function federatedGcpToken(): Promise<string> {
  if (cached && cached.expiresAt - REFRESH_BEFORE_MS > Date.now()) return cached.value;
  const { gcpProvider, gcpServiceAccount } = config.registryFederation;
  const exchanged = await postJson(STS_URL, {
    grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: `//iam.googleapis.com/${gcpProvider}`,
    scope: SCOPE,
    requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
    subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    subjectToken: await projectedToken(),
  });
  const federated = text(exchanged["access_token"]);
  if (!federated) throw new Error("Google's STS returned no access token");
  if (!gcpServiceAccount) {
    cached = { value: federated, expiresAt: Date.now() + seconds(exchanged["expires_in"]) * 1000 };
    return federated;
  }
  const impersonated = await postJson(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(gcpServiceAccount)}:generateAccessToken`,
    { scope: [SCOPE], lifetime: "3600s" },
    { authorization: `Bearer ${federated}` },
  );
  const value = text(impersonated["accessToken"]);
  if (!value) throw new Error("IAM Credentials returned no access token");
  const expireTime = Date.parse(text(impersonated["expireTime"]));
  cached = { value, expiresAt: Number.isNaN(expireTime) ? Date.now() + 3_600_000 : expireTime };
  return value;
}

/** One element of STS's XML answer (its credentials are plain text there). */
function xmlElement(xml: string, name: string): string {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "";
}

/**
 * The owner's role's credentials, by web identity: the projected token
 * (audience sts.amazonaws.com) exchanged at the registry's regional STS.
 * An unsigned call: the token is the proof.
 */
async function assumeRole(region: string, partitionSuffix: string) {
  const response = await fetch(`https://sts.${region}.amazonaws.com${partitionSuffix}/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Action: "AssumeRoleWithWebIdentity",
      Version: "2011-06-15",
      RoleArn: config.registryFederation.awsRoleArn,
      RoleSessionName: "vennir-console",
      DurationSeconds: "3600",
      WebIdentityToken: await projectedToken(),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    // STS's error says why (the trust's audience or subject, a missing
    // provider) and never echoes the token.
    const why = `${xmlElement(body, "Code")}: ${xmlElement(body, "Message")}`;
    throw new Error(`AWS STS answered ${String(response.status)} (${why.slice(0, 300)})`);
  }
  const accessKeyId = xmlElement(body, "AccessKeyId");
  const secretAccessKey = xmlElement(body, "SecretAccessKey");
  const sessionToken = xmlElement(body, "SessionToken");
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw new Error("AWS STS returned no credentials");
  const stated = new Date(xmlElement(body, "Expiration"));
  const expiration = Number.isNaN(stated.getTime()) ? new Date(Date.now() + 3_600_000) : stated;
  return { accessKeyId, secretAccessKey, sessionToken, expiration };
}

/**
 * ECR's registry credential for `host`, as the owner's role: kept until 15
 * minutes before it (or the role's session) expires.
 */
export async function federatedEcrCredential(host: string): Promise<RegistryCredential> {
  const match = ECR_HOST.exec(host);
  if (!match) throw new Error(`${host} isn't an Amazon ECR registry`);
  const region = match[1] ?? "";
  const hit = cachedEcr.get(region);
  if (hit && hit.expiresAt - REFRESH_BEFORE_MS > Date.now()) return hit;
  const credentials = await assumeRole(region, match[2] ?? "");
  const client = new ECRClient({ region, credentials });
  const result = await client.send(new GetAuthorizationTokenCommand({}), { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const data = result.authorizationData?.[0];
  if (!data?.authorizationToken) throw new Error("ECR returned no authorization token");
  const [username = "", password = ""] = Buffer.from(data.authorizationToken, "base64").toString().split(":");
  const expiresAt = Math.min(data.expiresAt?.getTime() ?? Date.now() + 3_600_000, credentials.expiration.getTime());
  const credential = { username, password, expiresAt };
  cachedEcr.set(region, credential);
  return { username, password };
}

/** The registry credential for a federated host. */
export async function federatedCredential(host: string): Promise<RegistryCredential> {
  if (config.registryFederation.awsRoleArn) return federatedEcrCredential(host);
  return { username: "oauth2accesstoken", password: await federatedGcpToken() };
}

/**
 * The Docker config every reader of the registries gets: the federated
 * hosts with a fresh token, and any static credentials from the pull
 * Secret (registryCheck.pullSecretName) beside them.
 */
export async function federatedDockerConfig(): Promise<string> {
  const auths: Record<string, { auth: string }> = {};
  for (const [host, credential] of config.registryCredentials) {
    auths[host] = { auth: Buffer.from(`${credential.username}:${credential.password}`).toString("base64") };
  }
  for (const host of config.registryFederation.hosts) {
    const { username, password } = await federatedCredential(host);
    auths[host] = { auth: Buffer.from(`${username}:${password}`).toString("base64") };
  }
  return JSON.stringify({ auths });
}

/** For tests: forget the cached tokens. */
export function resetFederatedToken(): void {
  cached = null;
  cachedEcr.clear();
}
