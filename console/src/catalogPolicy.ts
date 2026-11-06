// SPDX-License-Identifier: MIT
/**
 * The cluster's policies of what the catalog decides, as the kernel writes
 * them (decision 27, docs/assessment.md): with a signed catalog, `kernel
 * policy` verifies the release itself and writes, into policies only it may
 * update, which digests are a product's releases (as which ServiceAccount,
 * with which token audiences) and each API ServiceAccount's audiences. They
 * apply beside this console's own (productPolicy.ts, gatewayTokenPolicy.ts),
 * so a step must pass both. This console only reads them: to say on the
 * Admin page who writes them, and to refuse a submission whose release the
 * kernel's policy doesn't list (the kernel hasn't read a new release yet,
 * or it isn't one the signed catalog names: a product registered by hand),
 * rather than have the cluster refuse its step at dispatch.
 *
 * With an unsigned catalog the kernel chart installs no catalog policy, and
 * this console's policies are all there is.
 */
import { config } from "./config.js";
import { readPolicyVariables } from "./k8s.js";
import { listedUses, useKey, type ReleaseUse } from "./productPolicy.js";

/** Who writes the catalog's policies, as the Admin page says it. */
export interface CatalogPolicies {
  /** "kernel": kernel policy, from the release it verified; "console": this console. */
  writer: "kernel" | "console";
  /**
   * With the kernel: the release it last wrote them from
   * (<repository>@<digest>), and its commit; both "" until it has applied
   * one (the policies stand as the chart seeded them from the console's).
   */
  release: string;
  commit: string;
}

/** Annotations kernel policy sets on its policies (kernel/internal/policy). */
const RELEASE_ANNOTATION = "vennir.dev/catalog-release";
const COMMIT_ANNOTATION = "vennir.dev/catalog-commit";

export async function catalogPolicies(): Promise<CatalogPolicies> {
  const policy = config.catalogIdentityPolicyName ? await readPolicyVariables(config.catalogIdentityPolicyName) : null;
  if (!policy) return { writer: "console", release: "", commit: "" };
  return { writer: "kernel", release: policy.annotations[RELEASE_ANNOTATION] ?? "", commit: policy.annotations[COMMIT_ANNOTATION] ?? "" };
}

/**
 * How long a read of the kernel's policy answers for (it changes at most
 * once a kernel pass, a minute): submissions don't each read and parse it.
 * A use it doesn't list is read again, fresh, before it's refused.
 */
const CACHE_MS = 5_000;
let cached: { listed: Set<string> | null; at: number } | null = null;

/** The (digest, entry) pairs the kernel's policy lists; null when there's no such policy. */
async function kernelListed(fresh: boolean): Promise<Set<string> | null> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.listed;
  const policy = await readPolicyVariables(config.catalogIdentityPolicyName);
  cached = { listed: policy ? listedUses(policy.variables) : null, at: Date.now() };
  return cached.listed;
}

/**
 * The digests of these uses the kernel's catalog identity policy doesn't
 * list as that product's release in that team (exactly: the kernel lists
 * no platform product, and its policy matches a step's own namespace
 * only); none when there's no such policy (the console writes them all).
 */
export async function unlistedByKernel(uses: ReleaseUse[]): Promise<string[]> {
  if (uses.length === 0 || !config.catalogIdentityPolicyName) return [];
  const unlisted = (listed: Set<string>) => uses.filter((use) => !listed.has(useKey(use)));
  let listed = await kernelListed(false);
  if (listed && unlisted(listed).length > 0) listed = await kernelListed(true);
  if (!listed) return [];
  return [...new Set(unlisted(listed).map((use) => use.digest))];
}

/** Forgets the cached read (tests). */
export function forgetKernelPolicy(): void {
  cached = null;
}
