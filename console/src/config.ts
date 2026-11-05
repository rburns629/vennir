// SPDX-License-Identifier: MIT
import { isIP } from "node:net";
import { parseIntoClientConfig } from "pg-connection-string";
import { readFileSync } from "node:fs";

/**
 * One validated config object, read once at startup — same principle as
 * the kernel's Settings (kernel/internal/config): fail immediately and legibly on a
 * missing/invalid value, not three calls deep into a request.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** A session lifetime like "8h", "30m", or "1d" -- the subset of fast-jwt's
 * `expiresIn` string format this service actually accepts. Checked here,
 * at startup, rather than left for fast-jwt to reject: a typo would
 * otherwise only surface as a 500 on the first login attempt. */
function parseSessionTtl(value: string): string {
  if (!/^\d+(m|h|d)$/.test(value)) {
    throw new Error(`Invalid JWT_TTL "${value}": expected a number followed by m, h, or d (e.g. "8h").`);
  }
  return value;
}

function parseBoolean(name: string): boolean {
  const value = process.env[name];
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`Invalid ${name} "${value}": expected "true" or "false".`);
}

/** Registry credentials by host, from a Docker config file -- the same
 * `.dockerconfigjson` format as a Kubernetes image pull Secret, so any
 * registry that works as an imagePullSecret works here. Read at startup
 * so a bad mount fails the deploy, not the first image check. */
export type RegistryCredentials = Map<string, { username: string; password: string }>;

/**
 * Where to reach a registry from inside the cluster when that differs from
 * its name in image references: "host=url" pairs, comma-separated. On kind,
 * images are named localhost:5001/..., which the nodes map to the
 * kind-registry container, but which from a Pod is the Pod itself:
 * "localhost:5001=http://kind-registry:5000". Plain http only when listed.
 */
function parseRegistryMirrors(value: string | undefined): Map<string, string> {
  const mirrors = new Map<string, string>();
  for (const pair of (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [host, url] = pair.split("=", 2).map((s) => s.trim());
    if (!host || !url || !/^https?:\/\/[^/]+$/.test(url)) {
      throw new Error(`REGISTRY_MIRRORS entry "${pair}" isn't "host=http(s)://host[:port]".`);
    }
    mirrors.set(host, url);
  }
  return mirrors;
}

/** A comma-separated setting as a list, blanks dropped. */
/** A whole number above zero, or the default when unset; anything else fails startup. */
function positiveInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid ${name} "${value}": expected a whole number above zero.`);
  return n;
}

function atLeastTwo(n: number): number {
  if (n < 2) throw new Error(`Invalid DATABASE_POOL_SIZE "${String(n)}": at least 2 (a background pass holds one for its lock and works on another).`);
  return n;
}

/** A whole number, zero or more, or the default when unset; anything else fails startup. */
function wholeNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${name} "${value}": expected a whole number, zero or more.`);
  return n;
}

/** SCAN_PLATFORMS (os/arch or os/arch/variant, comma-separated), or the console's own; anything else fails startup. */
function scanPlatforms(): string[] {
  const platforms = (process.env["SCAN_PLATFORMS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const platform of platforms) {
    if (!/^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9]+)?$/.test(platform)) {
      throw new Error(`Invalid SCAN_PLATFORMS entry "${platform}": expected os/arch, e.g. linux/arm64.`);
    }
  }
  if (platforms.length > 0) return [...new Set(platforms)];
  return [`linux/${process.arch === "x64" ? "amd64" : process.arch}`];
}

/** Where the audit log is copied: gcs or s3; anything else fails startup (it would copy to the wrong cloud). */
function auditExportProvider(): "gcs" | "s3" {
  const value = process.env["AUDIT_EXPORT_PROVIDER"] || "gcs";
  if (value !== "gcs" && value !== "s3") throw new Error(`Invalid AUDIT_EXPORT_PROVIDER "${value}": gcs or s3.`);
  return value;
}

/** A TCP port (or, where `off` allows it, 0 for none), or the default when unset; anything else fails startup. */
function port(name: string, fallback: number, off = false): number {
  const n = off ? wholeNumber(name, fallback) : positiveInt(name, fallback);
  if (n > 65535) throw new Error(`Invalid ${name} "${String(n)}": expected a port, up to 65535.`);
  return n;
}

/** Vertex's model unless another's named: the one scored (decision 24, 2026-10-28). */
export const VERTEX_MODEL = "google/gemini-3.5-flash";
/** Bedrock's unless another's named: a Claude open to every Bedrock account. */
export const BEDROCK_MODEL = "anthropic.claude-sonnet-5";

/**
 * The chat agent's settings, as given: from the install (the chart's chat
 * values, read at startup) or from an admin (the Admin page's, chat/
 * settings.ts). A number left null takes its default.
 */
export interface ChatInput {
  provider: string;
  model: string;
  endpoint: string;
  apiKey: string;
  vertexProject: string;
  vertexLocation: string;
  bedrockRegion: string;
  effort: string;
  maxSteps: number | null;
  timeoutSeconds: number | null;
  maxTokens: number | null;
  contextTokens: number | null;
}

/** DATABASE_IAM_AUTH: "gcp", "aws" (with DATABASE_IAM_REGION), or "" for the URL's password. */
function databaseIamAuth(): "" | "gcp" | "aws" {
  const value = process.env["DATABASE_IAM_AUTH"] ?? "";
  if (value !== "" && value !== "gcp" && value !== "aws") throw new Error(`Invalid DATABASE_IAM_AUTH "${value}": expected "gcp", "aws", or nothing for a password.`);
  if (value === "aws" && !process.env["DATABASE_IAM_REGION"]) throw new Error("DATABASE_IAM_REGION is needed with DATABASE_IAM_AUTH=aws.");
  if (value !== "") {
    const problem = verifiedTlsProblem(process.env["DATABASE_URL"] ?? "");
    if (problem) throw new Error(`DATABASE_URL: ${problem}`);
  }
  return value;
}

/**
 * Why a sign-in token from the cloud mustn't be sent over DATABASE_URL, or
 * "": its TLS must check the server's certificate, so only the server gets
 * it. Read as node-postgres reads it (pg-connection-string, then PGHOST and
 * PGSSLMODE where the URL says nothing), so what's checked is what
 * connects: TLS that rejects an unverified certificate (sslmode=verify-full,
 * or verify-ca with sslrootcert; node-postgres 8 checks the certificate for
 * require and prefer too, unless uselibpqcompat, which this then refuses).
 * A loopback address or a Unix socket (a Cloud SQL Auth Proxy beside the
 * process, which encrypts and checks on its own) needs none. The rule of
 * the kernel's verifiedTLSProblem and the gateway's verifiedTLS; never
 * quotes the URL, which may hold a password.
 */
export function verifiedTlsProblem(databaseUrl: string): string {
  let parsed: ReturnType<typeof parseIntoClientConfig>;
  try {
    parsed = parseIntoClientConfig(databaseUrl);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? ` (${String(error.code)})` : "";
    return `can't be read as a Postgres URL${code}`;
  }
  const host = parsed.host || process.env["PGHOST"] || "localhost";
  const loopback = (isIP(host) === 4 && host.startsWith("127.")) || (isIP(host) === 6 && host === "::1");
  if (host.startsWith("/") || host === "localhost" || loopback) return "";
  const ssl: unknown = parsed.ssl === undefined ? sslFromEnvironment() : parsed.ssl;
  const verified = ssl === true || ssl === "true" || (typeof ssl === "object" && ssl !== null && (ssl as { rejectUnauthorized?: unknown }).rejectUnauthorized !== false);
  if (verified) return "";
  return "with DATABASE_IAM_AUTH, its token is sent only over TLS that checks the server's certificate: sslmode=verify-full, or verify-ca with sslrootcert (the server's own CA), unless it connects to localhost (a Cloud SQL Auth Proxy)";
}

/** node-postgres's TLS where the URL says nothing: PGSSLMODE's (pg's connection-parameters.js). */
function sslFromEnvironment(): unknown {
  switch (process.env["PGSSLMODE"]) {
    case "prefer":
    case "require":
    case "verify-ca":
    case "verify-full":
      return true;
    case "no-verify":
      return { rejectUnauthorized: false };
    default:
      return false;
  }
}

export const CHAT_PROVIDERS = ["vertex", "bedrock", "anthropic", "openai-compatible"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

/** The chat agent's settings checked, or null when it's off (no model). Throws, naming the setting, when one's wrong. */
export function chatFrom(input: ChatInput) {
  const endpoint = input.endpoint.trim().replace(/\/+$/, "");
  const provider = input.provider || "openai-compatible";
  // On a cloud's own, choosing it is choosing chat: its model unless another's named.
  const model = input.model.trim() || (provider === "vertex" ? VERTEX_MODEL : provider === "bedrock" ? BEDROCK_MODEL : "");
  if (!model) return null;
  if (!(CHAT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`chat.provider "${provider}": ${CHAT_PROVIDERS.join(", ")}`);
  }
  // Vertex: Gemini through Vertex AI's OpenAI-compatible endpoint, in the
  // install's own project, as the console's Workload Identity (no key).
  const vertexProject = input.vertexProject.trim();
  const vertexLocation = input.vertexLocation.trim() || "global";
  if (provider === "vertex" && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(vertexProject)) {
    throw new Error(`chat.vertex.project "${vertexProject}": the Google Cloud project whose Vertex AI answers`);
  }
  if (!/^[a-z0-9-]+$/.test(vertexLocation)) throw new Error(`chat.vertex.location "${vertexLocation}": global, or a region`);
  // Bedrock: Claude through Amazon Bedrock's Messages API in this region,
  // signed as the console's own AWS identity (EKS Pod Identity; no key).
  const bedrockRegion = input.bedrockRegion.trim();
  if (provider === "bedrock" && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(bedrockRegion)) {
    throw new Error(`chat.bedrock.region "${bedrockRegion}": the AWS region whose Bedrock answers, such as us-east-2`);
  }
  if (provider === "bedrock" && !/^anthropic\.claude-[a-z0-9.-]+$/.test(model)) {
    throw new Error(`chat.model "${model}": Bedrock's name for a Claude model, such as ${BEDROCK_MODEL}`);
  }
  // Anthropic's API is the SDK's own address unless given, Vertex's built
  // from its project and location; any other needs one.
  if (endpoint ? !/^https?:\/\/[^\s]+$/.test(endpoint) : provider === "openai-compatible") {
    throw new Error(`chat.endpoint "${endpoint}": the model's base URL, http(s)://.../v1`);
  }
  // A credential belongs in chat.apiKey, never in the address (which is logged).
  if (endpoint && /^https?:\/\/[^/?#]*@/.test(endpoint)) throw new Error("chat.endpoint: no user or password in the address; a key goes in chat.apiKey");
  if (provider === "anthropic" && !input.apiKey) throw new Error("chat.apiKey: Anthropic's API needs a key");
  if (input.effort && !["low", "medium", "high"].includes(input.effort)) throw new Error(`chat.effort "${input.effort}": low, medium or high`);
  for (const [name, n] of Object.entries({ maxSteps: input.maxSteps, timeoutSeconds: input.timeoutSeconds, maxTokens: input.maxTokens, contextTokens: input.contextTokens })) {
    if (n !== null && (!Number.isInteger(n) || n < 1)) throw new Error(`chat.${name} ${String(n)}: a whole number above zero`);
  }
  // A cloud's model thinks, and its thinking counts toward its reply: more room there.
  const cloud = provider !== "openai-compatible";
  const maxTokens = input.maxTokens ?? (cloud ? 8000 : 1500);
  const contextTokens = input.contextTokens ?? (cloud ? 64000 : 16000);
  // The prompt, the tools' descriptions and a question need about 6000, and two replies their room.
  if (contextTokens < 2 * maxTokens + 8000) {
    throw new Error(`chat.contextTokens ${String(contextTokens)}: at least twice chat.maxTokens (${String(maxTokens)}) and 8000 more`);
  }
  const vertexHost = vertexLocation === "global" ? "aiplatform.googleapis.com" : `${vertexLocation}-aiplatform.googleapis.com`;
  return {
    provider: provider as ChatProvider,
    endpoint:
      endpoint ||
      (provider === "vertex"
        ? `https://${vertexHost}/v1/projects/${vertexProject}/locations/${vertexLocation}/endpoints/openapi`
        : provider === "bedrock"
          ? `https://bedrock-mantle.${bedrockRegion}.api.aws/anthropic`
          : ""),
    model,
    apiKey: input.apiKey,
    vertexProject,
    vertexLocation,
    bedrockRegion,
    // Model calls and tool calls in one answer, at most.
    maxSteps: input.maxSteps ?? 8,
    // How long one model call may take: a local model is slow.
    timeoutSeconds: input.timeoutSeconds ?? 180,
    maxTokens,
    // The most one model call is sent, in tokens (estimated): the
    // conversation, what the tools return and room for the replies. A
    // conversation that can't fit is refused; a tool result that won't fit
    // is held back. Claude takes far more; this bounds the cost.
    contextTokens,
    // How hard the model thinks, where it takes one (Anthropic, Bedrock, Vertex); unset, its own default.
    effort: (input.effort || null) as "low" | "medium" | "high" | null,
  };
}

export type ChatConfig = NonNullable<ReturnType<typeof chatFrom>>;

/** A whole-number setting from the environment, or null for its default. */
function optionalInt(name: string): number | null {
  const value = process.env[name];
  return value === undefined || value === "" ? null : positiveInt(name, 0);
}

/** The install's chat settings: the chart's, from the environment. */
function loadChat(): ChatConfig | null {
  return chatFrom({
    provider: process.env["CHAT_PROVIDER"] ?? "",
    model: process.env["CHAT_MODEL"] ?? "",
    endpoint: process.env["CHAT_ENDPOINT"] ?? "",
    apiKey: process.env["CHAT_API_KEY"] ?? "",
    vertexProject: process.env["CHAT_VERTEX_PROJECT"] ?? "",
    vertexLocation: process.env["CHAT_VERTEX_LOCATION"] ?? "",
    bedrockRegion: process.env["CHAT_BEDROCK_REGION"] ?? "",
    effort: process.env["CHAT_EFFORT"] ?? "",
    maxSteps: optionalInt("CHAT_MAX_STEPS"),
    timeoutSeconds: optionalInt("CHAT_TIMEOUT_SECONDS"),
    maxTokens: optionalInt("CHAT_MAX_TOKENS"),
    contextTokens: optionalInt("CHAT_CONTEXT_TOKENS"),
  });
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Single sign-on (auth/oidc.ts): an OpenID Connect provider, Google's for
 * now. Off unless OIDC_ISSUER is set; then every other setting is needed,
 * and at least one allowed domain: a provider anyone can sign up to
 * (Google is one) must never let just anyone in.
 */
/** A Kubernetes quantity (2, 500m, 8Gi), or a whole number for pods. */
export const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/;

/** Each team's default ceiling (TEAM_QUOTA_*), checked at startup. */
function loadQuota() {
  const quota = {
    cpu: process.env["TEAM_QUOTA_CPU"] ?? "",
    memory: process.env["TEAM_QUOTA_MEMORY"] ?? "",
    pods: process.env["TEAM_QUOTA_PODS"] ?? "",
    stepMemory: process.env["TEAM_QUOTA_STEP_MEMORY"] ?? "",
  };
  for (const [key, value] of Object.entries(quota)) {
    if (value && !(key === "pods" ? /^[0-9]+$/ : QUANTITY).test(value)) {
      throw new Error(`teamNamespaces.quota.${key}: "${value}" isn't a Kubernetes quantity (2, 500m, 8Gi)`);
    }
  }
  return quota;
}

function schedulerLogs(): { clusterRole: string; serviceAccount: { namespace: string; name: string } } | null {
  const clusterRole = process.env["TEAM_SCHEDULER_LOGS_ROLE"] ?? "";
  const serviceAccount = process.env["TEAM_SCHEDULER_SERVICE_ACCOUNT"] ?? "";
  if (!clusterRole && !serviceAccount) return null;
  const [namespace, name, extra] = serviceAccount.split("/");
  if (!clusterRole || !namespace || !name || extra !== undefined) {
    throw new Error("TEAM_SCHEDULER_LOGS_ROLE and TEAM_SCHEDULER_SERVICE_ACCOUNT (namespace/name) go together");
  }
  return { clusterRole, serviceAccount: { namespace, name } };
}

function gatewayPods(): { namespace: string; labels: Record<string, string> } | null {
  const namespace = process.env["TEAM_GATEWAY_NAMESPACE"] ?? "";
  if (!namespace) return null;
  const labels = Object.fromEntries(
    list(process.env["TEAM_GATEWAY_POD_LABELS"]).map((pair) => {
      const [key, value] = pair.split("=", 2);
      if (!key || value === undefined) throw new Error(`TEAM_GATEWAY_POD_LABELS: "${pair}" isn't key=value`);
      return [key, value];
    }),
  );
  if (Object.keys(labels).length === 0) throw new Error("TEAM_GATEWAY_POD_LABELS: the gateway's Pod labels are needed with TEAM_GATEWAY_NAMESPACE");
  return { namespace, labels };
}

function loadOidc() {
  const issuer = process.env["OIDC_ISSUER"] ?? "";
  if (!issuer) return null;
  const oidc = {
    issuer,
    clientId: process.env["OIDC_CLIENT_ID"] ?? "",
    clientSecret: process.env["OIDC_CLIENT_SECRET"] ?? "",
    // Where the provider sends people back: <console URL>/api/auth/oidc/callback.
    redirectUrl: process.env["OIDC_REDIRECT_URL"] ?? "",
    // Workspace domains whose people may sign in (Google's hd claim).
    allowedDomains: list(process.env["OIDC_ALLOWED_DOMAINS"]).map((d) => d.toLowerCase()),
    // On the sign-in button: "Sign in with <label>".
    label: process.env["OIDC_LABEL"] || "Google",
  };
  const missing = Object.entries({
    OIDC_CLIENT_ID: oidc.clientId,
    OIDC_CLIENT_SECRET: oidc.clientSecret,
    OIDC_REDIRECT_URL: oidc.redirectUrl,
    OIDC_ALLOWED_DOMAINS: oidc.allowedDomains.join(","),
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) throw new Error(`OIDC_ISSUER is set, so these are needed too: ${missing.join(", ")}`);
  if (!/^https?:\/\/[^/]+\/api\/auth\/oidc\/callback$/.test(oidc.redirectUrl)) {
    throw new Error("OIDC_REDIRECT_URL must be the console's own <scheme>://<host>/api/auth/oidc/callback.");
  }
  return oidc;
}

function loadRegistryCredentials(path: string | undefined): RegistryCredentials {
  const credentials: RegistryCredentials = new Map();
  if (!path) return credentials;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`REGISTRY_AUTH_FILE "${path}" isn't a readable JSON file: ${String(error)}`);
  }
  const auths = (parsed as { auths?: Record<string, { auth?: string; username?: string; password?: string }> }).auths;
  if (typeof auths !== "object") {
    throw new Error(`REGISTRY_AUTH_FILE "${path}" has no "auths" object.`);
  }
  for (const [key, entry] of Object.entries(auths)) {
    // Keys are hosts, or URLs like "https://index.docker.io/v1/".
    const host = key.includes("://") ? new URL(key).host : key.replace(/\/.*$/, "");
    const decoded = entry.auth ? Buffer.from(entry.auth, "base64").toString("utf8") : null;
    const separator = decoded?.indexOf(":") ?? -1;
    const username = decoded && separator > 0 ? decoded.slice(0, separator) : entry.username;
    const password = decoded && separator > 0 ? decoded.slice(separator + 1) : entry.password;
    if (!username || !password) {
      throw new Error(`REGISTRY_AUTH_FILE entry "${key}" has no usable credentials.`);
    }
    credentials.set(host === "index.docker.io" ? "registry-1.docker.io" : host, { username, password });
  }
  return credentials;
}

/** Email for notifications (notifier.ts); host empty: none. Checked here so a half-set one fails at startup. */
function loadEmail() {
  const email = {
    host: process.env["SMTP_HOST"] ?? "",
    port: port("SMTP_PORT", 587),
    // "tls" (implicit, port 465), "starttls" (upgraded, 587, required), or
    // "none" (a local test server only).
    tls: (process.env["SMTP_TLS"] ?? "starttls") as "tls" | "starttls" | "none",
    from: process.env["SMTP_FROM"] ?? "",
    username: process.env["SMTP_USERNAME"] ?? "",
    // The password is read from a file (the chart mounts its Secret), never
    // an environment variable.
    passwordFile: process.env["SMTP_PASSWORD_FILE"] ?? "",
  };
  if (!email.host) return email;
  if (!["tls", "starttls", "none"].includes(email.tls)) throw new Error(`SMTP_TLS is tls, starttls or none, not "${email.tls}".`);
  if (!/^[^@\s]+@[^@\s]+$/.test(email.from.replace(/^.*<(.+)>$/, "$1"))) throw new Error("SMTP_HOST is set, so SMTP_FROM needs an email address.");
  if (!Number.isInteger(email.port) || email.port < 1 || email.port > 65535) throw new Error("SMTP_PORT isn't a port.");
  if (email.username && !email.passwordFile) throw new Error("SMTP_USERNAME is set, so SMTP_PASSWORD_FILE is needed too.");
  return email;
}

/** JWT_SECRET: at least 32 bytes. Every session's key, every sealing key and the SSO cookie's HMAC come from it. */
function jwtSecret(): string {
  const value = requireEnv("JWT_SECRET");
  if (Buffer.byteLength(value) < 32) throw new Error("JWT_SECRET is shorter than 32 bytes: use a long random value (the chart generates one when jwtSecret is empty).");
  return value;
}

/**
 * Keyless bots: the issuers allowed, and the audience their tokens must
 * name (KEYLESS_AUDIENCE, else the console's URL). With neither set, no
 * issuer is allowed: a constant audience would accept tokens minted for
 * any other service that uses it. (A console with no address CI can reach
 * has no use for keyless bots anyway.) noAudience says that's why it's off.
 */
function keyless(): { issuers: string[]; audience: string; noAudience: boolean } {
  const audience = process.env["KEYLESS_AUDIENCE"] || (process.env["CONSOLE_URL"] ?? "").replace(/\/+$/, "");
  const issuers = audience ? list(process.env["KEYLESS_ISSUERS"] ?? "https://token.actions.githubusercontent.com,https://gitlab.com") : [];
  return { issuers, audience, noAudience: !audience };
}

/** INSTALL_CLOUD: one of the catalog's clouds, or "" when not known. */
function installCloud(): string {
  const value = process.env["INSTALL_CLOUD"] ?? "";
  if (value !== "" && !CLOUDS.includes(value)) throw new Error(`INSTALL_CLOUD "${value}": one of ${CLOUDS.join(", ")}, or empty`);
  return value;
}

/** The clouds a catalog's team.yaml or product.yaml may name (its schemas' enum). */
export const CLOUDS = ["gcp", "aws", "azure", "kind", "existing"];

/** MONITORING_PROVIDER: operator, google, bundled, or "" when monitoring is off. */
function monitoringProvider(): "" | "operator" | "google" | "bundled" {
  const value = process.env["MONITORING_PROVIDER"] ?? "";
  if (value !== "" && value !== "operator" && value !== "google" && value !== "bundled") {
    throw new Error(`Invalid MONITORING_PROVIDER "${value}": expected operator, google, bundled, or nothing for off.`);
  }
  return value;
}

/** GKE's managed Prometheus: a project id (or "" for none) and its cluster. */
function googleMonitoring(): { project: string; cluster: string } {
  const project = (process.env["MONITORING_GOOGLE_PROJECT"] ?? "").trim();
  const cluster = (process.env["MONITORING_GOOGLE_CLUSTER"] ?? "").trim();
  if (project !== "" && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    throw new Error(`Invalid MONITORING_GOOGLE_PROJECT "${project}": a Google Cloud project id.`);
  }
  if (cluster !== "" && !/^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$/.test(cluster)) {
    throw new Error(`Invalid MONITORING_GOOGLE_CLUSTER "${cluster}": a GKE cluster's name.`);
  }
  return { project, cluster };
}

/** CLUSTER_DOMAIN: the cluster's DNS domain, cluster.local unless it was set up with another. */
function clusterDomain(): string {
  const value = (process.env["CLUSTER_DOMAIN"] || "cluster.local").replace(/\.$/, "");
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(value)) {
    throw new Error(`Invalid CLUSTER_DOMAIN "${value}": a DNS name such as cluster.local`);
  }
  return value;
}

/** An http(s) address from the environment, or "" for none. */
function httpUrl(name: string): string {
  const value = (process.env[name] ?? "").trim().replace(/\/+$/, "");
  if (value && !/^https?:\/\/[^\s]+$/.test(value)) throw new Error(`Invalid ${name} "${value}": expected http(s)://...`);
  return value;
}

export const config = {
  port: port("PORT", 8080),
  // The guides and the platform's docs, copied into the image (guides.ts).
  docsDir: process.env["DOCS_DIR"] || "/app/docs",
  // /metrics for Prometheus, on a port of its own so the console's Ingress
  // never serves it (metrics.ts). 0 turns it off.
  metricsPort: port("METRICS_PORT", 9090, true),
  databaseUrl: requireEnv("DATABASE_URL"),
  // Most connections this process holds (each request it serves may take
  // one); the size keeps every process's sum under Postgres's limit.
  // At least two: a background pass (catalog sync, the audit copy, each
  // delivery pass) holds one connection for its lock while it works on
  // another (db/client.ts whileHolding); with one, it would wait forever.
  databasePoolSize: atLeastTwo(positiveInt("DATABASE_POOL_SIZE", 10)),
  // Longest opening a database connection may take (db/connection.ts).
  databaseConnectTimeoutSeconds: positiveInt("DATABASE_CONNECT_TIMEOUT_SECONDS", 10),
  // Sign in with its own cloud identity instead of a password: "gcp"
  // (Cloud SQL's IAM database authentication, its Workload Identity's
  // token), or "" (the URL's password).
  databaseIamAuth: databaseIamAuth(),
  databaseIamRegion: process.env["DATABASE_IAM_REGION"] ?? "",
  // With the gateway on: its own database role (db/gatewayAccess.ts), which
  // the migration Job grants what the gateway reads, and creates with this
  // password when the console runs as its Postgres's superuser. Empty: no
  // gateway.
  gatewayDatabase: {
    role: process.env["GATEWAY_DB_ROLE"] ?? "",
    password: process.env["GATEWAY_DB_PASSWORD"] || undefined,
  },
  // Signs and verifies session JWTs. Must be long and random in any real
  // deployment — this is not a value with a safe default. Shorter than 32
  // bytes fails startup.
  jwtSecret: jwtSecret(),
  // How long a login session stays valid before the user has to sign in
  // again. Bounded on purpose: with no expiry, a leaked token was usable
  // forever, and rotating JWT_SECRET (logging *everyone* out) was the only
  // way to revoke one. A password change/reset additionally revokes a
  // user's earlier sessions immediately (see auth/plugin.ts).
  jwtTtl: parseSessionTtl(process.env["JWT_TTL"] ?? "8h"),
  // Only read by db/migrate.ts's one-time bootstrap seed, never by the
  // running server. Deliberately no hardcoded default password: if
  // BOOTSTRAP_ADMIN_PASSWORD isn't set, the account gets a random one, never
  // printed, instead of anything guessable — see db/bootstrapAdmin.ts.
  bootstrapAdminEmail: process.env["BOOTSTRAP_ADMIN_EMAIL"] ?? "admin@example.com",
  bootstrapAdminPassword: process.env["BOOTSTRAP_ADMIN_PASSWORD"],
  bootstrapAdminMustChangePassword: parseBoolean("BOOTSTRAP_ADMIN_MUST_CHANGE_PASSWORD"),
  // kernel-api knows nothing of users or teams: this service is its only
  // accepted caller (kernelApiTokenFile below) and authorizes every request
  // first (core/executions.ts). Reachable only from inside the cluster.
  kernelApiUrl: requireEnv("KERNEL_API_URL"),
  // This Pod's ServiceAccount token, projected for kernel-api's audience
  // (the chart mounts it), sent on every kernel-api call: kernel-api checks
  // it with a TokenReview and accepts only this console
  // (kernel/internal/api/auth.go). Read on each call, since the kubelet rotates it. Unset only
  // when kernel-api runs with its check disabled, in local development.
  kernelApiTokenFile: process.env["KERNEL_API_TOKEN_FILE"],
  // Purely cosmetic -- rendered as a badge in the UI so it's visually
  // obvious which deployment a browser tab is actually talking to (a
  // local `kind` cluster vs a real GKE deployment, both of which run the
  // identical chart). Never used for any behavioral decision, so an
  // unset/wrong value is never a correctness bug, just a confusing badge
  // -- a sensible default is fine here, unlike the values above.
  environmentLabel: process.env["ENVIRONMENT_LABEL"] ?? "unlabeled environment",
  // The cloud this install is on (INSTALL_CLOUD, which vennir sets): a
  // product whose clouds leave it out is listed but never checked or run
  // here (core/clouds.ts). Empty: not known, so every product runs.
  installCloud: installCloud(),
  // Its image's tag (the chart's), shown on the Admin page.
  version: process.env["CONSOLE_VERSION"] || "development",
  // Where people reach the console (https://<host>), for links in what's
  // posted to chat webhooks; empty: posted without one.
  consoleUrl: (process.env["CONSOLE_URL"] ?? "").replace(/\/+$/, ""),
  // Keyless bots (auth/keyless.ts): the OIDC issuers whose ID tokens a
  // bot may sign in with instead of a stored token (a CI's own identity,
  // such as GitHub Actions'), and the audience those tokens must be for.
  keyless: keyless(),
  // Notifications (notifier.ts): the hosts a team's chat webhook may be
  // under ("hooks.slack.com", or "*.webhook.office.com" for any name below
  // it), so a webhook can't point the console at anything else.
  notifications: {
    // Email (notifier.ts): an SMTP server to send through. Empty host: no
    // email. tls: "tls" (implicit, port 465), "starttls" (upgraded, 587,
    // required), or "none" (local test servers only). The password is read
    // from a file (the chart mounts its Secret), never an environment
    // variable.
    email: loadEmail(),
    webhookHosts: list(process.env["NOTIFY_WEBHOOK_HOSTS"] ?? "hooks.slack.com,chat.googleapis.com,*.webhook.office.com,*.logic.azure.com"),
  },
  // Callbacks for systems (decision 23, callbacks.ts): the hosts an
  // ordering bot's callback or a team's outcome webhook may be under, as
  // webhookHosts. Empty: none.
  // The chat agent (decision 24, src/chat/), as the install sets it: off
  // unless a model is set or the provider is vertex. A key, when one's
  // needed, comes from a Secret (CHAT_API_KEY), never the settings. Admins
  // may set their own on the Admin page (chat/settings.ts chatSettings(),
  // which everything reads; this is its default).
  chat: loadChat(),
  orders: {
    callbackHosts: list(process.env["ORDER_CALLBACK_HOSTS"]),
    // How many orders each ordering bot may place a minute (core/orderRate.ts).
    ratePerMinute: positiveInt("ORDER_RATE_PER_MINUTE", 60),
  },
  // Off unless set: accounts are created by an admin (Admin page ->
  // Accounts, POST /api/users), with their teams attached. Open
  // registration has no email verification, so anyone who can reach the
  // console could make an account; turn it on only behind a trusted
  // network boundary.
  allowSelfRegistration: parseBoolean("ALLOW_SELF_REGISTRATION"),
  // The console chart's write fence (write-fence-policy.yaml): the console
  // won't start unless it's in force. Empty: off (the chart's writeFence).
  writeFencePolicy: process.env["WRITE_FENCE_POLICY"] ?? "",
  // Single sign-on; null when off. Turning it on changes nothing else:
  // passwords still work, except for the members of a team that requires
  // single sign-on (teams.requireSso; admins are exempt).
  oidc: loadOidc(),
  // The proxies in front of the console, as addresses and CIDR ranges
  // (comma-separated), so request.ip (the sign-in throttle, rate limits,
  // logs) is the real client: behind Google's external Application Load
  // Balancer, its front ends (35.191.0.0/16, 130.211.0.0/22) and its own
  // address, which it appends after the client's. Empty (the default):
  // X-Forwarded-For is ignored, since anything could have written it.
  trustProxy: (process.env["TRUST_PROXY"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // Checking that a DAG's images still exist before running it (see
  // registry.ts). Only registries named here are ever contacted: those in
  // REGISTRY_AUTH_FILE, plus Artifact Registry/GCR when
  // REGISTRY_GCP_METADATA_TOKEN is on (short-lived tokens from the GKE
  // metadata server via Workload Identity, so GKE needs no stored key).
  // With neither set, nothing is checked and the kernel's own dispatch
  // (IMAGE_NOT_FOUND) is the only guard.
  registryCredentials: loadRegistryCredentials(process.env["REGISTRY_AUTH_FILE"]),
  registryGcpMetadataToken: parseBoolean("REGISTRY_GCP_METADATA_TOKEN"),
  // EKS: short-lived ECR credentials from the console's own AWS identity
  // (EKS Pod Identity), for ECR registries, instead of a stored key.
  registryEcrToken: parseBoolean("REGISTRY_ECR_TOKEN"),
  registryMirrors: parseRegistryMirrors(process.env["REGISTRY_MIRRORS"]),
  // The API gateway (decision 20; the chart's gateway values): the hosts an
  // API's backend may be under ("orders.example.com", or "*.a.run.app" for
  // any name below it), an API under none being held, not published; the
  // teams whose APIs may be reachable from the internet; and where callers
  // reach the gateway, inside the cluster and from outside.
  gateway: {
    backendHosts: list(process.env["GATEWAY_BACKEND_HOSTS"]),
    internetTeams: list(process.env["GATEWAY_INTERNET_TEAMS"]),
    url: process.env["GATEWAY_URL"] ?? "",
    publicUrl: process.env["GATEWAY_PUBLIC_URL"] ?? "",
    // The gateway's limit for a team an API's limits don't name and no
    // default covers (its DEFAULT_PER_MINUTE), shown on an API's page.
    defaultPerMinute: positiveInt("GATEWAY_DEFAULT_PER_MINUTE", 600),
  },
  // A registry on another cloud (or another AWS account), read with no
  // stored key (registryFederation.ts), exchanging the console's projected
  // token (tokenFile, with the other side as its audience): Google Artifact
  // Registry hosts through Workload Identity Federation for an access token,
  // used directly or to impersonate gcpServiceAccount (gcpProvider:
  // projects/<number>/locations/global/workloadIdentityPools/<pool>/
  // providers/<provider>); or Amazon ECR hosts by assuming awsRoleArn by web
  // identity, for ECR's registry token. One or the other; both empty: off.
  // tokenSecret is the Docker config Secret written in this namespace for
  // the verify and scan Jobs.
  registryFederation: {
    gcpProvider: process.env["REGISTRY_GCP_WIF_PROVIDER"] ?? "",
    gcpServiceAccount: process.env["REGISTRY_GCP_SERVICE_ACCOUNT"] ?? "",
    awsRoleArn: process.env["REGISTRY_AWS_ROLE_ARN"] ?? "",
    hosts: (process.env["REGISTRY_FEDERATED_HOSTS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    tokenFile: process.env["REGISTRY_FEDERATION_TOKEN_FILE"] ?? "/var/run/secrets/vennir/registry/token",
    tokenSecret: process.env["REGISTRY_TOKEN_SECRET"] ?? "",
  },
  // Every task's image is pinned to its digest at submission (routes/
  // executions.ts): "required" refuses a submission whose image the registry
  // can't resolve; "off" sends tags as they are (tests, a registry the
  // console can't reach).
  imagePinning: (process.env["IMAGE_PINNING"] ?? "required") === "off" ? ("off" as const) : ("required" as const),
  // Where the allowed image sources live: inside the execution-kernel
  // chart's image admission policy itself (helm/charts/execution-kernel/
  // templates/image-policy.yaml), which the Admin page edits; see
  // imagePolicy.ts. Named after that release: "<release>-execution-kernel-image".
  imagePolicyName: process.env["IMAGE_POLICY_NAME"] ?? "kernel-execution-kernel-image",
  // The kernel chart's identity admission policy (identity-policy.yaml),
  // whose list of registered products this console keeps in step with its
  // own (productPolicy.ts), so the cluster enforces each product's
  // ServiceAccount and Secrets too. The chart always sets it; unset (as in
  // tests) means the console never writes to the cluster.
  identityPolicyName: process.env["IDENTITY_POLICY_NAME"] ?? "",
  // How often the identity and scan policies are rewritten from the
  // database whatever changed (policySync.ts), so drift doesn't last.
  policySyncIntervalSeconds: positiveInt("POLICY_SYNC_INTERVAL_SECONDS", 300),
  // How long things are kept, in days (retention.ts); 0 keeps them forever.
  retention: {
    // Submitted-execution records; set it as the kernel's
    // execution_retention_days, which deletes the executions themselves.
    executionDays: wholeNumber("EXECUTION_RETENTION_DAYS", 90),
    auditDays: wholeNumber("AUDIT_RETENTION_DAYS", 365),
    // Scan verdicts of images not used for this long; never a blocking one.
    scanDays: wholeNumber("SCAN_RETENTION_DAYS", 90),
  },
  // The platform's registry pull Secret (a .dockerconfigjson file, mounted
  // from the chart's registryCheck.pullSecretName), which the console copies
  // into every team namespace as k8s.ts's TEAM_PULL_SECRET (pullSecret.ts),
  // so steps can run images from private registries. Unset: not copied.
  teamPullSecretFile: process.env["TEAM_PULL_SECRET_FILE"] ?? "",
  // This release's own namespace (where scan Jobs run).
  platformNamespace: process.env["PLATFORM_NAMESPACE"] ?? "",
  // The cluster's DNS domain: which API backend hosts are in the cluster,
  // and in which namespace (core/apis.ts backendNamespace).
  clusterDomain: clusterDomain(),
  // The ConfigMap the console records its last use in (activity.ts), for
  // the kernel's sleeper. Empty (as in tests): not recorded.
  activityConfigMap: process.env["ACTIVITY_CONFIGMAP"] ?? "",
  // Scanning every image before it's registered or run (scanning.ts): a
  // Trivy client Job per digest, in the platform's namespace, against the
  // chart's Trivy server. Off (as in tests) means no scans and no checks.
  scanning: {
    enabled: process.env["SCANNING_ENABLED"] === "true",
    serverUrl: process.env["SCANNER_SERVER_URL"] ?? "",
    image: process.env["SCANNER_IMAGE"] ?? "",
    serviceAccount: process.env["SCANNER_SERVICE_ACCOUNT"] ?? "",
    // The registryCheck pull Secret, for private registries.
    pullSecretName: process.env["SCANNER_PULL_SECRET"] ?? "",
    // How long a submission waits for an image's first scan before asking
    // the caller to try again.
    waitSeconds: wholeNumber("SCAN_WAIT_SECONDS", 60),
    // Images in use are scanned again once their verdict is this old.
    rescanHours: positiveInt("SCAN_RESCAN_HOURS", 24),
    // The kernel chart's scan admission policy, which holds the admitted digests.
    policyName: process.env["SCAN_POLICY_NAME"] ?? "",
    // The Trivy server's Deployment, which the console scales to zero after
    // idleMinutes with no scans and back up when one is wanted. Empty: it's
    // left running.
    scannerDeployment: process.env["SCANNER_DEPLOYMENT"] ?? "",
    idleMinutes: wholeNumber("SCANNER_IDLE_MINUTES", 15),
    // Which images of a multi-platform index to scan: every platform the
    // cluster's nodes run, since a step runs whichever its node pulls.
    // Defaults to the console's own (its nodes'), as Trivy would otherwise
    // pick linux/amd64 whatever the cluster is.
    platforms: scanPlatforms(),
  },
  // The audit log's write-once copy (auditExport.ts): a bucket that refuses
  // deletes and overwrites, written every `minutes`. Empty bucket: off.
  audit: {
    export: {
      bucket: process.env["AUDIT_EXPORT_BUCKET"] ?? "",
      // gcs (the console's Workload Identity) or s3 (its AWS identity, or
      // AWS_* credentials and an endpoint for an S3-compatible store).
      provider: auditExportProvider(),
      region: process.env["AUDIT_EXPORT_REGION"] ?? "",
      endpoint: process.env["AUDIT_EXPORT_ENDPOINT"] ?? "",
      prefix: process.env["AUDIT_EXPORT_PREFIX"] ?? "vennir-audit/",
      minutes: positiveInt("AUDIT_EXPORT_MINUTES", 5),
      // What the bucket keeps, as the install says it made it (vennir.yaml's
      // audit.keepDays and audit.lock), for the Admin page only, which
      // labels them "as configured": the bucket enforces them, and the
      // console's identity may write and read its objects but not read the
      // bucket's retention or lock. 0: not known here.
      keepDays: wholeNumber("AUDIT_EXPORT_KEEP_DAYS", 0),
      lock: parseBoolean("AUDIT_EXPORT_LOCK"),
    },
  },
  // Prometheus, as the charts' monitoring values set it (operator, google or
  // bundled; empty: off), and where the install's Grafana is: shown on the
  // Admin page and Observe. prometheusUrl is the Prometheus whose alerts
  // Observe shows (core/alerts.ts): the bundled one, or any other, in the
  // cluster or not; empty, none are shown.
  monitoring: {
    provider: monitoringProvider(),
    grafanaUrl: httpUrl("GRAFANA_URL"),
    prometheusUrl: httpUrl("PROMETHEUS_URL"),
    // With provider google and no prometheusUrl: the project and cluster
    // whose managed Prometheus says which alerts fire.
    google: googleMonitoring(),
  },
  // The kernel chart's signature policy (image-signature.yaml, a
  // policy-controller ClusterImagePolicy): catalog images must be signed
  // exactly when it exists, which the Admin page reads from the cluster.
  // Named after that release: "<release>-execution-kernel-signed-images".
  // Empty: not read, so the Admin page doesn't say.
  imageSignaturePolicyName: process.env["IMAGE_SIGNATURE_POLICY_NAME"] ?? "",
  // Log search (core/logs.ts): the chart's Loki, which the console queries
  // with each caller's visibility added. Empty: this install keeps no logs.
  // Older than searchDays, logs are archived and not searched.
  logs: {
    lokiUrl: process.env["LOKI_URL"] ?? "",
    searchDays: positiveInt("LOG_SEARCH_DAYS", 30),
  },
  // The catalog this console registers from (catalogSync.ts): its release,
  // <registry>/catalog-release:latest, read through the same registry
  // sign-in as image checks (registryCredentials, the GKE metadata token,
  // ECR) and mirrors. Empty (as in tests): no catalog; products, teams and
  // SecretStores are only what admins make by hand.
  catalog: {
    release: process.env["CATALOG_RELEASE"] ?? "",
    // Follow the newest version (a vX.Y.Z tag of release's repository,
    // `vennir catalog promote`) instead of release's own tag.
    newestVersion: process.env["CATALOG_NEWEST_VERSION"] === "true",
    pollSeconds: positiveInt("CATALOG_POLL_SECONDS", 300),
    // release is another install's catalog (vennir.yaml's externalCatalog),
    // not this install's own, as the install says. Display only, labelled
    // "as configured": nothing the console reads tells the two apart (the
    // kernel's source registry is the other install's then too).
    external: parseBoolean("CATALOG_EXTERNAL"),
    // Who may sign a release: the same as the kernel chart's imageSignature
    // (PEM public keys, a JSON list; and/or a keyless identity). None: the
    // release isn't verified, its trust being the registry's main-only
    // write access.
    signature: {
      publicKeys: JSON.parse(process.env["CATALOG_SIGNATURE_PUBLIC_KEYS"] || "[]") as string[],
      keylessIssuer: process.env["CATALOG_SIGNATURE_KEYLESS_ISSUER"] ?? "",
      keylessSubjectRegExp: process.env["CATALOG_SIGNATURE_KEYLESS_SUBJECT_REGEXP"] ?? "",
    },
    // cosign, pinned, which a verification Job runs.
    verifierImage: process.env["CATALOG_VERIFIER_IMAGE"] ?? "",
  },
  // Team namespaces (k8s.ts's team namespace functions, core/teams.ts):
  // the console creates a team's namespace with the team label, relabels it
  // when the team is retired or un-retired, and (with purge) deletes it when
  // the team is purged, so the catalog needs no cluster credentials. The
  // chart turns it on; unset (as in tests) the console leaves namespaces
  // to someone else.
  teamNamespaces: {
    manage: process.env["TEAM_NAMESPACES_MANAGE"] === "true",
    purge: process.env["TEAM_NAMESPACES_PURGE"] === "true",
    // The kernel's dispatch policy runs steps only in namespaces with this
    // label set to "true"; "retired" stops it.
    label: process.env["TEAM_NAMESPACE_LABEL"] ?? "vennir/team",
    // Pod Security level enforced in the namespaces it creates (the kernel's
    // step Pods meet `restricted`); empty for none.
    podSecurity: process.env["TEAM_NAMESPACE_POD_SECURITY"] ?? "",
    // A NetworkPolicy in each one refusing connections from outside it
    // (teamNetwork.ts).
    defaultDenyIngress: process.env["TEAM_NAMESPACE_DEFAULT_DENY_INGRESS"] === "true",
    // With it, a NetworkPolicy refusing the instance metadata server
    // (k8s.ts's TEAM_NO_METADATA): on EKS, where a step could otherwise
    // take its node's credentials. Never on GKE, whose Workload Identity
    // is served there.
    blockMetadata: process.env["TEAM_NAMESPACE_BLOCK_METADATA"] === "true",
    // The kernel scheduler's log reading, bound in each team namespace only
    // (schedulerLogs.ts): its logs-only ClusterRole, and its ServiceAccount
    // as namespace/name. Unset, nothing is bound.
    schedulerLogs: schedulerLogs(),
    // With the gateway on: its Pods (their namespace and labels), which a
    // second NetworkPolicy lets reach the Pods a team labels as API
    // backends (k8s.ts's TEAM_GATEWAY_INGRESS). Null: the gateway is off.
    gatewayIngress: gatewayPods(),
    // What each team's steps may use together, unless an admin set the
    // team's own (teamQuota.ts): Kubernetes quantities, "" for no limit.
    quota: loadQuota(),
    // Never a team's, whatever a team is called: the platform's own, and
    // any the operator lists. (kube-* always.)
    protected: [
      ...(process.env["PLATFORM_NAMESPACE"] ? [process.env["PLATFORM_NAMESPACE"]] : []),
      ...(process.env["PROTECTED_NAMESPACES"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      "kube-system",
      "kube-public",
      "kube-node-lease",
    ],
  },
  // What the Team page's "Connect a source" wizard needs to tell a platform
  // owner: which repo the connection's PR goes to, and the facts a cloud
  // provider must trust for this cluster's identities. Display only: a
  // wrong value produces a wrong instruction, never a wrong permission
  // (the SecretStore still goes through review). Empty means "not available
  // on this cluster", and the wizard says so instead of guessing.
  secretSources: {
    // owner/repo of the catalog, where teams/<team>/secret-stores/ lives.
    catalogRepo: process.env["SECRET_SOURCES_CATALOG_REPO"] ?? "",
    // This cluster's service-account token issuer, for Azure and AWS to
    // federate with (on GKE: https://container.googleapis.com/v1/projects/
    // <project>/locations/<location>/clusters/<cluster>).
    clusterIssuer: process.env["SECRET_SOURCES_CLUSTER_ISSUER"] ?? "",
    // GKE Workload Identity: the pool (<project>.svc.id.goog) and the
    // cluster's name and location, which a gcpsm SecretStore names.
    gcpWorkloadIdentityPool: process.env["SECRET_SOURCES_GCP_WORKLOAD_IDENTITY_POOL"] ?? "",
    gkeClusterName: process.env["SECRET_SOURCES_GKE_CLUSTER_NAME"] ?? "",
    gkeClusterLocation: process.env["SECRET_SOURCES_GKE_CLUSTER_LOCATION"] ?? "",
  },
};
