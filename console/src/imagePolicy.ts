// SPDX-License-Identifier: MIT
/**
 * Which images a task may run: only those under an allowed source. The
 * cluster is the authority -- helm/charts/execution-kernel/templates/
 * image-policy.yaml refuses any other image when the kernel creates the
 * Job, however the submission arrived. This file applies the *same* rules
 * in the console first, so a user gets a clear refusal at submit time
 * instead of a task failing at dispatch, and so the Admin page can edit the
 * list the cluster enforces.
 *
 * Keep normalizeImage and the prefix rules in step with image-policy.yaml's
 * CEL: if they disagree, the console lets something through that the
 * cluster then refuses (a worse error, but still refused).
 */
import { config } from "./config.js";
import { readImagePolicyData, writeImagePolicyData } from "./k8s.js";
import { hasUppercaseName, normalizeImage } from "./imageRef.js";

export { hasUppercaseName, imageRepository, normalizeImage } from "./imageRef.js";

export interface ImagePolicy {
  /** False when the policy doesn't exist (the kernel chart isn't installed). */
  exists: boolean;
  /** The registry path images are published to (catalog CI's target). */
  source: string;
  additional: string[];
  /** resourceVersion, sent back on save so concurrent edits can't clobber. */
  version: string;
}

/** A source as stored and matched: trimmed, no scheme, ending in "/". */
export function normalizeSource(entry: string): string {
  const trimmed = entry.trim().replace(/^https?:\/\//, "");
  return trimmed === "" || trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/** Why `entry` can't be a source, or null when it can. */
export function invalidSourceReason(entry: string): string | null {
  const source = normalizeSource(entry);
  if (source === "") return "is empty";
  if (/\s/.test(source)) return "contains whitespace";
  if (source.includes("@")) return "names a digest; a source is a registry path, not an image";
  // Written into the cluster's policy as a CEL string literal, so nothing
  // that could close the string. Registry paths never need more than this.
  if (!/^[A-Za-z0-9._:/-]+$/.test(source)) return "may only contain letters, digits and . _ : / -";
  const host = source.split("/")[0] ?? "";
  if (!host.includes(".") && !host.includes(":") && host !== "localhost") {
    return `must start with a registry host (e.g. "us-central1-docker.pkg.dev/…", "docker.io/library/", "localhost:5001/")`;
  }
  if (/:[^/]*\/$/.test(source.slice(host.length))) {
    return "has a tag; a source is a registry path, not an image";
  }
  return null;
}

/** A source that allows a whole registry host (every project, user or
 * organization on it) rather than one path in it. Allowed, but the Admin
 * page warns before saving one. */
export function isBroadSource(entry: string): boolean {
  return normalizeSource(entry).split("/").filter(Boolean).length <= 1;
}

export function allowedPrefixes(policy: ImagePolicy): string[] {
  return [policy.source, ...policy.additional].map(normalizeSource).filter((p) => p !== "");
}

export function isImageAllowed(image: string, prefixes: string[]): boolean {
  if (hasUppercaseName(image)) return false;
  const normalized = normalizeImage(image);
  return prefixes.some((prefix) => normalized.startsWith(prefix));
}

export async function readImagePolicy(): Promise<ImagePolicy> {
  const stored = await readImagePolicyData(config.imagePolicyName);
  if (!stored) return { exists: false, source: "", additional: [], version: "" };
  return {
    exists: true,
    source: normalizeSource(stored.source),
    additional: stored.additional.map(normalizeSource).filter((p) => p !== ""),
    version: stored.version,
  };
}

/** A few seconds' worth: the execution page asks on every 2s poll. */
const DISPLAY_CACHE_MS = 5000;
let displayCache: { policy: ImagePolicy; at: number } | undefined;

/** The policy for showing a notice, read at most every few seconds. Anything
 * that decides whether something runs reads it fresh (readImagePolicy). */
export async function readImagePolicyForDisplay(): Promise<ImagePolicy> {
  if (displayCache && Date.now() - displayCache.at < DISPLAY_CACHE_MS) return displayCache.policy;
  const policy = await readImagePolicy();
  displayCache = { policy, at: Date.now() };
  return policy;
}

/** Saves already-validated sources. Returns the new version. */
export async function writeImagePolicy(source: string, additional: string[], version: string): Promise<string> {
  displayCache = undefined;
  return writeImagePolicyData(
    config.imagePolicyName,
    { source: normalizeSource(source), additional: additional.map(normalizeSource) },
    version,
  );
}

export interface ImageRefusal {
  error: "IMAGE_NOT_ALLOWED" | "IMAGE_POLICY_NOT_CONFIGURED";
  message: string;
  disallowedImages: string[];
  allowedSources: string[];
}

/** Null when every image is allowed; otherwise the refusal, worded for
 * the person who submitted it. */
export function imageRefusal(images: string[], policy: ImagePolicy): ImageRefusal | null {
  const prefixes = allowedPrefixes(policy);
  const unique = [...new Set(images)];
  if (prefixes.length === 0) {
    return {
      error: "IMAGE_POLICY_NOT_CONFIGURED",
      message: policy.exists
        ? "No image source is configured yet, so nothing can run. An admin sets it on the Admin page."
        : "The cluster's image policy doesn't exist, so nothing can run. Installing or upgrading the execution-kernel release creates it.",
      disallowedImages: unique,
      allowedSources: [],
    };
  }
  const disallowed = unique.filter((image) => !isImageAllowed(image, prefixes));
  if (disallowed.length === 0) return null;
  const uppercase = disallowed.filter(hasUppercaseName);
  return {
    error: "IMAGE_NOT_ALLOWED",
    message:
      `${disallowed.join(", ")} ${disallowed.length === 1 ? "is" : "are"} not from an allowed image source. ` +
      `Allowed: ${prefixes.join(", ")}. An admin can allow more on the Admin page.` +
      (uppercase.length > 0
        ? ` ${uppercase.join(", ")} ${uppercase.length === 1 ? "has" : "have"} an uppercase letter in the registry or repository; ` +
          "image names are lowercase (only a tag may have uppercase letters)."
        : ""),
    disallowedImages: disallowed,
    allowedSources: prefixes,
  };
}
