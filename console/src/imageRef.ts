// SPDX-License-Identifier: MIT
/**
 * Reading an image reference the way the kubelet does. Pure, so the
 * database layer (image repository ownership) can use it as well as the
 * image policy. Keep in step with image-policy.yaml's and
 * identity-policy.yaml's CEL.
 */

/** An uppercase letter anywhere but the tag: in a path component, or in the
 * first part (its host and port, or a short name's repository). The same
 * expression as image-policy.yaml's `uppercase`. */
const UPPERCASE_NAME = /^([^/@]*[A-Z][^@]*\/|([^@]*\/)?[^/@:]*[A-Z])/;

/** Whether the image has an uppercase letter in its registry or repository.
 * Such an image is never allowed: a registry host is case-insensitive, so a
 * prefix compared as written wouldn't be the registry's view, and Docker
 * reads an uppercase first part as a host. Repositories are lowercase, so
 * nothing valid is lost (a tag may have uppercase). */
export function hasUppercaseName(image: string): boolean {
  return UPPERCASE_NAME.test(image);
}

/** An image as the kubelet reads it: `node:20` is
 * `docker.io/library/node:20`, `team/app` is `docker.io/team/app`. A first
 * part with a `.` or `:`, `localhost`, or one with an uppercase letter is a
 * registry host, as Docker's reference parser reads it. */
export function normalizeImage(image: string): string {
  const first = image.split("/")[0] ?? "";
  const hasHost =
    image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost" || /[A-Z]/.test(first));
  if (hasHost) return image;
  return image.includes("/") ? `docker.io/${image}` : `docker.io/library/${image}`;
}

/** An image without its tag or digest, normalized: what every release of
 * one product has in common (`…/app:1.2`, `…/app@sha256:…` and a pinned
 * `…/app:1.2@sha256:…` are `…/app`). The digest comes off, then the tag, as
 * the identity policy's CEL does. */
export function imageRepository(image: string): string {
  const normalized = normalizeImage(image);
  const at = normalized.indexOf("@");
  const unpinned = at >= 0 ? normalized.slice(0, at) : normalized;
  const colon = unpinned.lastIndexOf(":");
  return colon > unpinned.lastIndexOf("/") ? unpinned.slice(0, colon) : unpinned;
}
