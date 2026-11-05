// SPDX-License-Identifier: MIT
/**
 * The audiences a product's steps may get a projected ServiceAccount token
 * for (product.yaml's tokenAudiences), to sign in to another cloud by OIDC
 * federation: AWS's web identity (sts.amazonaws.com), Entra's workload
 * identity (api://AzureADTokenExchange), a GCP workload identity pool. The
 * kernel mounts each at /platform/tokens/<tokenFileName(audience)>, and the
 * cluster's identity policy refuses any its product didn't declare.
 *
 * A token is only as narrow as its audience, so registration refuses the
 * audiences that would make a step's token good inside this cluster: the
 * Kubernetes API server's (read from this console's own API token, which
 * carries exactly those) and kernel-api's (from its token for kernel-api).
 */
import { readFileSync } from "node:fs";
import { config } from "./config.js";

/** As the kernel's domain.MaxTokenAudiences. */
export const MAX_TOKEN_AUDIENCES = 8;

/** Where the kubelet puts this Pod's Kubernetes API token. */
const API_TOKEN_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/token";

/** Kubernetes' usual API audiences, refused even where no token says so. */
const KUBERNETES_AUDIENCES = [
  "https://kubernetes.default.svc",
  "https://kubernetes.default.svc.cluster.local",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
];

/** As the kernel's domain.TokenFileName: characters outside [A-Za-z0-9._-] become "_". */
export function tokenFileName(audience: string): string {
  return audience.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** A JWT's `aud` claim, read (not verified: it's this Pod's own file). No file: none. */
function audiencesIn(file: string): string[] {
  let token: string;
  try {
    token = readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const payload = token.split(".")[1];
  if (!payload) throw new Error(`${file} isn't a JWT`);
  const { aud } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { aud?: unknown };
  return (Array.isArray(aud) ? aud : [aud]).filter((a): a is string => typeof a === "string");
}

/** The audiences no product may ask for in this cluster. */
export function reservedAudiences(): Set<string> {
  return new Set([
    ...KUBERNETES_AUDIENCES,
    ...audiencesIn(API_TOKEN_FILE),
    ...(config.kernelApiTokenFile ? audiencesIn(config.kernelApiTokenFile) : []),
  ]);
}

/**
 * Whether a token for `audience` could be exchanged for a cloud identity:
 * AWS's and Azure's federation audiences, a GKE Workload Identity pool
 * (<project>.svc.id.goog) or its STS audience (identitynamespace:...), a GCP
 * workload identity provider. A product's steps may ask for these (that's
 * what tokenAudiences are for); an API's backend token may not, or its
 * backend could become the API ServiceAccount's cloud identity. As the
 * gateway's credentials.CloudAudience and the catalog tool's, kept in step.
 */
export function cloudFederationAudience(audience: string): boolean {
  const a = audience.toLowerCase();
  return (
    a === "sts.amazonaws.com" ||
    a === "api://azureadtokenexchange" ||
    a.endsWith(".svc.id.goog") ||
    a.startsWith("identitynamespace:") ||
    a.startsWith("//iam.googleapis.com/") ||
    a.startsWith("https://iam.googleapis.com/")
  );
}

/** What's wrong with an API's backend token audience (backend.auth.serviceAccountToken), or "". */
export function apiTokenAudienceProblem(audience: string): string {
  if (reservedAudiences().has(audience)) {
    return `its backend's token audience ${audience} is this cluster's own (the Kubernetes API's or kernel-api's)`;
  }
  if (cloudFederationAudience(audience)) {
    return `its backend's token audience ${audience} is one a cloud federates (AWS, Azure or Google): a backend's token may never carry it`;
  }
  return "";
}

/** What's wrong with a product's audiences, one problem per entry. */
export function tokenAudienceProblems(audiences: string[]): string[] {
  const problems: string[] = [];
  if (audiences.length > MAX_TOKEN_AUDIENCES) problems.push(`at most ${String(MAX_TOKEN_AUDIENCES)} token audiences`);
  const reserved = reservedAudiences();
  const files = new Map<string, string>();
  for (const audience of audiences) {
    if (audience === "" || audience.trim() !== audience || /[\s,]/.test(audience)) {
      problems.push(`token audience ${JSON.stringify(audience)} may not be empty or hold spaces or commas`);
    } else if (reserved.has(audience)) {
      problems.push(`token audience ${JSON.stringify(audience)} is this cluster's own (the Kubernetes API's or kernel-api's): a step may never have one`);
    }
    const file = tokenFileName(audience);
    if (file === "." || file === "..") problems.push(`token audience ${JSON.stringify(audience)} can't be a file name`);
    const other = files.get(file);
    if (other !== undefined) problems.push(`token audiences ${JSON.stringify(other)} and ${JSON.stringify(audience)} share the file ${file}`);
    files.set(file, audience);
  }
  return problems;
}
