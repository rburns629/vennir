// SPDX-License-Identifier: MIT
/**
 * Does a task's image still exist, and which exact image (digest) does its
 * tag name right now? Asked of the registry itself, over the
 * OCI distribution API every registry speaks (Artifact Registry, ACR, ECR,
 * GHCR, Docker Hub), so a DAG naming a deleted image (a purged platform's,
 * say) is refused up front instead of failing at dispatch.
 *
 * Three answers, and only "missing" ever blocks anything:
 *   - "available": the registry returned the manifest;
 *   - "missing": the registry answered 404 for it;
 *   - "unverified": anything else -- an image outside the allowed sources,
 *     a timeout, a 401/403. The kernel still refuses a missing image at
 *     dispatch (IMAGE_NOT_FOUND), so an unanswered check costs a slower
 *     error, never a wrong run.
 *
 * Image references come from users, so this only ever contacts registries
 * under an allowed image source (imagePolicy.ts), which admins chose to
 * trust; anything else is "unverified" without a request being made. A
 * credential (config.registryCredentials, or a GKE metadata token for
 * Google's registries, ECR's or ACR's from the console's own identity) is used when there is one, and only ever sent to the
 * registry it belongs to; public sources like docker.io/library/ are asked
 * anonymously.
 */
import { createHash } from "node:crypto";

import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { azureToken } from "./azureToken.js";
import { config } from "./config.js";
import { gcpMetadataToken } from "./gcpMetadata.js";
import { federatedCredential, federatedHost } from "./registryFederation.js";
import { isImageAllowed, normalizeImage } from "./imagePolicy.js";

export type ImageStatus = "available" | "missing" | "unverified";

interface ImageCheck {
  status: ImageStatus;
  /** The manifest's digest ("sha256:…"), when the registry answered. */
  digest?: string;
}

interface ImageRef {
  /** The host the registry API is served from. */
  host: string;
  repository: string;
  /** A tag or a digest. */
  reference: string;
}

interface Credential {
  username: string;
  password: string;
}

const REQUEST_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60_000;
/** A check that gave no digest (a timeout, a 5xx, a 401, a manifest with
 * no digest header) is remembered only this long: long enough that polling
 * doesn't hammer a registry that's down, short enough that one blip doesn't
 * refuse a tag's submissions for a minute (pinning refuses what it can't
 * resolve). */
const UNANSWERED_TTL_MS = 5_000;
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const GOOGLE_REGISTRY = /^([a-z0-9-]+-docker\.pkg\.dev|([a-z]+\.)?gcr\.io)$/;
/** An ECR registry: <account>.dkr.ecr.<region>.amazonaws.com. */
const ECR_REGISTRY = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/;
/** An Azure Container Registry: <name>.azurecr.io (.cn, .us in sovereign clouds). */
const ACR_REGISTRY = /^[a-z0-9]{5,50}\.azurecr\.(io|cn|us)$/;
/** The username ACR takes beside a refresh token. */
const ACR_TOKEN_USER = "00000000-0000-0000-0000-000000000000";
/** ACR's refresh tokens last three hours: one is used for one. */
const ACR_TOKEN_TTL_MS = 3_600_000;
/** Null for a reference without a registry host (e.g. `demo-product:local`,
 * or Docker Hub's `nginx` shorthand): there's nothing to ask. */
export function parseImageRef(image: string): ImageRef | null {
  const slash = image.indexOf("/");
  if (slash < 0) return null;
  const first = image.slice(0, slash);
  if (!first.includes(".") && !first.includes(":") && first !== "localhost") return null;

  // A digest wins over a tag; both come off the repository
  // (`repo:latest@sha256:…` is how submissions are pinned).
  let rest = image.slice(slash + 1);
  let reference = "latest";
  const at = rest.indexOf("@");
  if (at >= 0) {
    reference = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    if (at < 0) reference = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (!rest || !reference) return null;
  const host = first === "docker.io" ? "registry-1.docker.io" : first;
  const repository = host === "registry-1.docker.io" && !rest.includes("/") ? `library/${rest}` : rest;
  return { host, repository, reference };
}

const ecrTokens = new Map<string, Credential & { expiresAt: number }>();

/**
 * ECR's short-lived registry credential (12 hours), from the console's own
 * AWS identity: the SDK finds EKS Pod Identity's credentials by itself.
 * Kept until 10 minutes before it expires.
 */
async function ecrCredential(account: string, region: string): Promise<Credential> {
  const key = `${account}/${region}`;
  const cached = ecrTokens.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const client = new ECRClient({ region });
  const result = await client.send(new GetAuthorizationTokenCommand({}), {
    abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = result.authorizationData?.[0];
  if (!data?.authorizationToken) throw new Error("ECR returned no authorization token");
  const [username = "", password = ""] = Buffer.from(data.authorizationToken, "base64").toString().split(":");
  const expiresAt = (data.expiresAt?.getTime() ?? Date.now() + 3_600_000) - 600_000;
  const credential = { username, password, expiresAt };
  ecrTokens.set(key, credential);
  return credential;
}

const acrTokens = new Map<string, Credential & { expiresAt: number }>();

/**
 * ACR's refresh token for the console's own Entra identity (AKS Workload
 * Identity, azureToken.ts), which the registry's token endpoint takes as a
 * password: what `az acr login` does, with no stored key. The identity needs
 * AcrPull on the registry.
 */
async function acrCredential(host: string): Promise<Credential> {
  const cached = acrTokens.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const response = await fetch(`https://${host}/oauth2/exchange`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "access_token",
      service: host,
      access_token: await azureToken("https://management.azure.com/.default"),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ACR's token exchange returned ${String(response.status)}`);
  const body = (await response.json()) as { refresh_token?: string };
  if (!body.refresh_token) throw new Error("ACR returned no refresh token");
  const credential = { username: ACR_TOKEN_USER, password: body.refresh_token, expiresAt: Date.now() + ACR_TOKEN_TTL_MS };
  acrTokens.set(host, credential);
  return credential;
}

/** Null means ask anonymously. */
async function credentialFor(host: string): Promise<Credential | null> {
  if (federatedHost(host)) return federatedCredential(host);
  const configured = config.registryCredentials.get(host);
  if (configured) return configured;
  if (config.registryGcpMetadataToken && GOOGLE_REGISTRY.test(host)) {
    return { username: "oauth2accesstoken", password: await gcpMetadataToken() };
  }
  const ecr = ECR_REGISTRY.exec(host);
  if (config.registryEcrToken && ecr) {
    const { username, password } = await ecrCredential(ecr[1] ?? "", ecr[2] ?? "");
    return { username, password };
  }
  if (config.registryAcrToken && ACR_REGISTRY.test(host)) {
    const { username, password } = await acrCredential(host);
    return { username, password };
  }
  return null;
}

function basic(credential: Credential): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
}

/** The parameters of a `WWW-Authenticate: Bearer realm="…",service="…"` challenge. */
function parseBearerChallenge(header: string | null): Record<string, string> | null {
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const params: Record<string, string> = {};
  for (const match of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) {
    const [, key, value] = match;
    if (key && value !== undefined) params[key] = value;
  }
  return params;
}

/** A registry token for one repository, per the Docker token-auth flow. */
async function bearerToken(
  ref: ImageRef,
  challenge: Record<string, string>,
  credential: Credential | null,
): Promise<string | null> {
  const realm = challenge["realm"];
  if (!realm) return null;
  const realmUrl = new URL(realm);
  // Only the registry's own token service: its own host, or Docker Hub's
  // known one. Never a host a registry response merely points at.
  const trusted =
    realmUrl.protocol === "https:" &&
    (realmUrl.host === ref.host || (ref.host === "registry-1.docker.io" && realmUrl.host === "auth.docker.io"));
  if (!trusted) return null;
  if (challenge["service"]) realmUrl.searchParams.set("service", challenge["service"]);
  realmUrl.searchParams.set("scope", `repository:${ref.repository}:pull`);
  const response = await fetch(realmUrl, {
    headers: credential ? { authorization: basic(credential) } : {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { token?: string; access_token?: string };
  return body.token ?? body.access_token ?? null;
}

function checkFrom(response: Response): ImageCheck {
  if (response.status === 404) return { status: "missing" };
  if (response.status !== 200) return { status: "unverified" };
  const digest = response.headers.get("docker-content-digest") ?? undefined;
  return digest && /^sha256:[a-f0-9]{64}$/.test(digest) ? { status: "available", digest } : { status: "available" };
}

async function checkUncached(image: string): Promise<ImageCheck> {
  const ref = parseImageRef(normalizeImage(image));
  if (!ref) return { status: "unverified" };
  const credential = await credentialFor(ref.host);

  // A mirror (config.registryMirrors) is only a different address for the
  // same registry: credentials are still the image host's.
  const base = config.registryMirrors.get(ref.host) ?? `https://${ref.host}`;
  const url = `${base}/v2/${ref.repository}/manifests/${encodeURIComponent(ref.reference)}`;
  const head = (authorization?: string) =>
    fetch(url, {
      method: "HEAD",
      headers: { accept: MANIFEST_TYPES, ...(authorization ? { authorization } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  const first = await head();
  if (first.status !== 401) return checkFrom(first);
  const challenge = parseBearerChallenge(first.headers.get("www-authenticate"));
  if (challenge) {
    const token = await bearerToken(ref, challenge, credential);
    return token ? checkFrom(await head(`Bearer ${token}`)) : { status: "unverified" };
  }
  return credential ? checkFrom(await head(basic(credential))) : { status: "unverified" };
}

const cache = new Map<string, ImageCheck & { expiresAt: number }>();
/** At most this many images remembered: expired ones go first, then the oldest. */
const CACHE_MAX_ENTRIES = 1000;

function remember(image: string, check: ImageCheck): void {
  const now = Date.now();
  // "available" with no digest can't be pinned either: as short as unanswered.
  const ttl = check.status === "missing" || check.digest ? CACHE_TTL_MS : UNANSWERED_TTL_MS;
  if (cache.size >= CACHE_MAX_ENTRIES) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    for (const key of cache.keys()) {
      if (cache.size < CACHE_MAX_ENTRIES) break;
      cache.delete(key);
    }
  }
  cache.delete(image); // re-inserted last: the newest
  cache.set(image, { ...check, expiresAt: now + ttl });
}

/** For tests. */
export function cachedImageCount(): number {
  return cache.size;
}

/** Never throws: a check that can't complete is "unverified", and so is
 * an image outside `allowedPrefixes` (nothing is requested for it).
 * Answers are cached for a minute, since the execution detail page polls;
 * an unanswered check, for a few seconds. */
export async function checkImage(image: string, allowedPrefixes: string[]): Promise<ImageStatus> {
  return (await inspectImage(image, allowedPrefixes)).status;
}

/** Checks under way: callers asking about the same image at once (a burst
 * of submissions) share one request to the registry. */
const inFlight = new Map<string, Promise<ImageCheck>>();

async function inspectImage(image: string, allowedPrefixes: string[]): Promise<ImageCheck> {
  if (!isImageAllowed(image, allowedPrefixes)) return { status: "unverified" };
  const cached = cache.get(image);
  if (cached && cached.expiresAt > Date.now()) return cached;
  let pending = inFlight.get(image);
  if (!pending) {
    pending = checkUncached(image)
      .catch((): ImageCheck => ({ status: "unverified" }))
      .then((check) => {
        remember(image, check);
        return check;
      })
      .finally(() => inFlight.delete(image));
    inFlight.set(image, pending);
  }
  return pending;
}

/** Whether an image reference already names its digest. */
export function isPinned(image: string): boolean {
  return /@sha256:[a-f0-9]{64}$/.test(image);
}

/**
 * Each tagged image pinned to the digest its tag names right now:
 * `repo:latest` becomes `repo:latest@sha256:…` (Kubernetes pulls by the
 * digest; the tag stays for people reading it). So a DAG can keep naming
 * `:latest`, while the run, any retry, and the image scanned are exactly the
 * bytes resolved here. Already-pinned images are kept as they are; the ones
 * the registry couldn't resolve are listed in `unresolved`.
 */
export async function pinImages(
  images: string[],
  allowedPrefixes: string[],
): Promise<{ pinned: Map<string, string>; unresolved: string[] }> {
  const pinned = new Map<string, string>();
  const unresolved: string[] = [];
  for (const image of new Set(images)) {
    if (isPinned(image)) {
      pinned.set(image, image);
      continue;
    }
    const { digest } = await inspectImage(image, allowedPrefixes);
    if (digest) pinned.set(image, `${image}@${digest}`);
    else unresolved.push(image);
  }
  return { pinned, unresolved };
}

/** The images among `images` the registry says don't exist. */
export async function missingImages(images: string[], allowedPrefixes: string[]): Promise<string[]> {
  const unique = [...new Set(images)];
  const statuses = await Promise.all(unique.map((image) => checkImage(image, allowedPrefixes)));
  return unique.filter((_, i) => statuses[i] === "missing");
}

/** The most a catalog release's JSON may be: far more than any catalog. */
const MAX_RELEASE_BYTES = 10 * 1024 * 1024;
const RELEASE_TIMEOUT_MS = 30_000;
export const RELEASE_MEDIA_TYPE = "application/vnd.vennir.catalog.release.v1+json";
const RELEASE_CONFIG_MEDIA_TYPE = "application/vnd.vennir.catalog.release.config.v1+json";

/** A GET of `path` under the reference's repository, signing in as the
 * manifest checks do (the registry's own token service only). */
async function registryGet(ref: ImageRef, path: string, accept: string): Promise<Response> {
  const credential = await credentialFor(ref.host);
  const base = config.registryMirrors.get(ref.host) ?? `https://${ref.host}`;
  const url = `${base}/v2/${ref.repository}/${path}`;
  const get = (authorization?: string) =>
    fetch(url, {
      headers: { accept, ...(authorization ? { authorization } : {}) },
      signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
    });
  const first = await get();
  if (first.status !== 401) return first;
  const challenge = parseBearerChallenge(first.headers.get("www-authenticate"));
  if (challenge) {
    const token = await bearerToken(ref, challenge, credential);
    if (token) return get(`Bearer ${token}`);
    return first;
  }
  return credential ? get(basic(credential)) : first;
}

function sha256(data: Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

async function body(response: Response, what: string): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`${what}: the registry answered ${String(response.status)}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_RELEASE_BYTES) throw new Error(`${what}: larger than ${String(MAX_RELEASE_BYTES)} bytes`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > MAX_RELEASE_BYTES) throw new Error(`${what}: larger than ${String(MAX_RELEASE_BYTES)} bytes`);
  return data;
}

/**
 * A catalog release (catalog CI's `vennir catalog release`): its manifest's
 * digest, and its one layer, the release as JSON. `reference` is the
 * console's own setting (config.catalog.release), never a caller's. Every
 * byte read is checked against the digest that names it, so the JSON is
 * exactly what the manifest, and its signature, cover.
 */
export async function fetchRelease(reference: string): Promise<{ digest: string; json: string }> {
  const ref = parseImageRef(reference);
  if (!ref) throw new Error(`catalog release ${reference}: not a registry reference`);
  const manifestBytes = await body(
    await registryGet(ref, `manifests/${encodeURIComponent(ref.reference)}`, "application/vnd.oci.image.manifest.v1+json"),
    "the release's manifest",
  );
  const digest = sha256(manifestBytes);
  if (ref.reference.startsWith("sha256:") && ref.reference !== digest) {
    throw new Error(`the release's manifest isn't ${ref.reference}`);
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    config?: { mediaType?: string };
    layers?: { mediaType?: string; digest?: string }[];
  };
  if (manifest.config?.mediaType !== RELEASE_CONFIG_MEDIA_TYPE) {
    throw new Error(`${reference} isn't a catalog release (its config is ${manifest.config?.mediaType ?? "missing"})`);
  }
  const layer = manifest.layers?.find((l) => l.mediaType === RELEASE_MEDIA_TYPE);
  if (!layer?.digest || !/^sha256:[a-f0-9]{64}$/.test(layer.digest)) throw new Error(`${reference} has no release layer`);
  const blob = await body(await registryGet(ref, `blobs/${layer.digest}`, RELEASE_MEDIA_TYPE), "the release");
  if (sha256(blob) !== layer.digest) throw new Error("the release's content doesn't match its digest");
  return { digest, json: new TextDecoder().decode(blob) };
}

/** The most pages of tags read: far more than any catalog's releases. */
const MAX_TAG_PAGES = 50;

/**
 * Every tag of the repository `reference` names (its tag or digest is
 * ignored), following the registry's pages. The catalog's release
 * repository, to find its newest version (catalogSync.ts).
 */
export async function listTags(reference: string): Promise<string[]> {
  const ref = parseImageRef(reference);
  if (!ref) throw new Error(`${reference}: not a registry reference`);
  const tags: string[] = [];
  let last = "";
  for (let page = 0; page < MAX_TAG_PAGES; page++) {
    const path = `tags/list?n=1000${last ? `&last=${encodeURIComponent(last)}` : ""}`;
    const response = await registryGet(ref, path, "application/json");
    const listed = JSON.parse(new TextDecoder().decode(await body(response, "the release's tags"))) as { tags?: string[] | null };
    const batch = listed.tags ?? [];
    tags.push(...batch);
    // A registry with more to give says so in a Link header.
    if (!response.headers.get("link") || batch.length === 0) return tags;
    last = batch[batch.length - 1] ?? "";
  }
  throw new Error(`the release's tags: more than ${String(MAX_TAG_PAGES)} pages`);
}

/** CycloneDX's in-toto predicate type, as `cosign attest --type cyclonedx` writes it. */
export const CYCLONEDX_PREDICATE = "https://cyclonedx.org/bom";

/**
 * The CycloneDX SBOM catalog CI attached to an image (`cosign attest`, in
 * the legacy layout policy-controller reads: the `sha256-<hex>.att` tag, one
 * DSSE envelope per layer), as JSON; null when there's none. `image` must be
 * pinned by digest, and is one the caller may see (core/observe.ts). Shown
 * as catalog CI attached it: its signature is the image's signer's, which
 * the cluster checks on every run.
 */
export async function fetchSbom(image: string): Promise<string | null> {
  const digest = /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1];
  const ref = parseImageRef(image);
  if (!digest || !ref) return null;
  const tag = { ...ref, reference: digest.replace(":", "-") + ".att" };
  const response = await registryGet(tag, `manifests/${encodeURIComponent(tag.reference)}`, "application/vnd.oci.image.manifest.v1+json");
  if (response.status === 404) return null;
  const manifest = JSON.parse(new TextDecoder().decode(await body(response, "the image's attestations"))) as {
    layers?: { mediaType?: string; digest?: string; annotations?: Record<string, string> }[];
  };
  for (const layer of manifest.layers ?? []) {
    if (layer.annotations?.["predicateType"] !== CYCLONEDX_PREDICATE || !layer.digest || !/^sha256:[a-f0-9]{64}$/.test(layer.digest)) continue;
    const blob = await body(await registryGet(tag, `blobs/${layer.digest}`, layer.mediaType ?? "application/json"), "the image's SBOM");
    if (sha256(blob) !== layer.digest) throw new Error("the image's SBOM doesn't match its digest");
    const envelope = JSON.parse(new TextDecoder().decode(blob)) as { payload?: string };
    const statement = JSON.parse(Buffer.from(envelope.payload ?? "", "base64").toString("utf8")) as { predicateType?: string; predicate?: unknown };
    if (statement.predicateType === CYCLONEDX_PREDICATE && statement.predicate) return JSON.stringify(statement.predicate);
  }
  return null;
}
