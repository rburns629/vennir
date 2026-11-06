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
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { readPolicyVariables } from "./k8s.js";
import { type ReleaseUse } from "./productPolicy.js";

/** Who writes the catalog's policies, as the Admin page says it. */
export interface CatalogPolicies {
  /**
   * "kernel": kernel policy, from the release it verified; "console": this
   * console (the kernel's policy isn't installed); "unknown": it couldn't
   * be read (logged).
   */
  writer: "kernel" | "console" | "unknown";
  /**
   * With the kernel: the release it last wrote them from
   * (<repository>@<digest>), and its commit; both "" until it has applied
   * one it trusts (the policies stand as the chart seeded them, or list
   * nothing after its signers changed).
   */
  release: string;
  commit: string;
  /** Whether this console's catalog trusts a signer (catalog.signature). */
  catalogSigned: boolean;
  /** Whether the gateway is on, and the kernel writes its API audiences too. */
  gateway: boolean;
  tokens: boolean;
  /**
   * With the kernel: why it refused the newest release the catalog names
   * (it holds back every release after it); "" when it didn't.
   */
  refused: string;
}

/** Annotations kernel policy sets on its policies (kernel/internal/policy). */
const RELEASE_ANNOTATION = "vennir.dev/catalog-release";
const COMMIT_ANNOTATION = "vennir.dev/catalog-commit";
const REFUSED_ANNOTATION = "vennir.dev/catalog-refused";

function catalogSigned(): boolean {
  const { publicKeys, keylessIssuer } = config.catalog.signature;
  return publicKeys.length > 0 || keylessIssuer !== "";
}

/**
 * Who writes them now. A read that fails is "unknown", never guessed: the
 * outcomes beside it are still shown.
 */
export async function catalogPolicies(log: FastifyBaseLogger): Promise<CatalogPolicies> {
  const gateway = config.gateway.tokenPolicyName !== "";
  const base = { catalogSigned: catalogSigned(), gateway, release: "", commit: "", tokens: false, refused: "" };
  try {
    const policy = config.catalogIdentityPolicyName ? await readPolicyVariables(config.catalogIdentityPolicyName) : null;
    if (!policy) return { ...base, writer: "console" };
    const tokens = gateway && config.catalogTokensPolicyName ? (await readPolicyVariables(config.catalogTokensPolicyName)) !== null : false;
    return {
      ...base,
      writer: "kernel",
      release: policy.annotations[RELEASE_ANNOTATION] ?? "",
      commit: policy.annotations[COMMIT_ANNOTATION] ?? "",
      refused: policy.annotations[REFUSED_ANNOTATION] ?? "",
      tokens,
    };
  } catch (error) {
    log.warn({ err: error, event: "catalog_policy_unread" }, "couldn't read the kernel's catalog policies");
    return { ...base, writer: "unknown" };
  }
}

/**
 * How long a read of the kernel's policy answers for (it changes at most
 * once a kernel pass, a minute): submissions don't each read and parse it.
 * A use it doesn't list is read again, fresh, before it's refused.
 */
const CACHE_MS = 5_000;
let cached: { listed: Set<string> | null; at: number } | null = null;

/** A release as the kernel's policy lists it, its token audiences included. */
function kernelKey(digest: string, team: string, repository: string, action: string, serviceAccount: string, audiences: string): string {
  return JSON.stringify([digest, team, repository, action, serviceAccount, audiences]);
}

/** Every (digest, entry) the kernel's releases maps list, audiences included; a literal that can't be read counts as empty. */
function kernelUses(variables: Record<string, string>): Set<string> {
  const listed = new Set<string>();
  for (const digit of "0123456789abcdef") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(variables[`releases${digit}`] ?? "{}");
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    for (const [digest, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries as Record<string, unknown>[]) {
        const s = (k: string) => (typeof e[k] === "string" ? e[k] : "");
        listed.add(kernelKey(digest, s("team"), s("repository"), s("action"), s("serviceAccount"), s("audiences")));
      }
    }
  }
  return listed;
}

/** The kernel's listed uses; null when there's no such policy. */
async function kernelListed(fresh: boolean): Promise<Set<string> | null> {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.listed;
  const policy = await readPolicyVariables(config.catalogIdentityPolicyName);
  cached = { listed: policy ? kernelUses(policy.variables) : null, at: Date.now() };
  return cached.listed;
}

/** A step as the kernel's policy would match it: its release, and the token audiences its product declares. */
export type KernelUse = ReleaseUse & { audiences: string[] };

/**
 * The digests of these uses the kernel's catalog identity policy doesn't
 * list as that product's release in that team, with those audiences
 * (exactly: the kernel lists no platform product, its policy matches a
 * step's own namespace only, and a token for an audience its entry doesn't
 * carry is refused). None when there's no such policy: the console's own
 * holds then. With a signed catalog that's logged, as the Admin page says:
 * the kernel chart's catalogPolicy is off, or the console's
 * catalogPolicy.identityPolicyName doesn't name its policy. Refusing then
 * would refuse every product on a signed install that runs without
 * catalogPolicy (the console writes everything there).
 */
export async function unlistedByKernel(
  uses: KernelUse[],
  log?: FastifyBaseLogger,
  required: (fresh: boolean) => Promise<boolean> = () => Promise.resolve(false),
): Promise<string[]> {
  if (uses.length === 0) return [];
  // The console's own identity policy holds no releases (the kernel chart's
  // catalogPolicy): a missing kernel policy is a misconfiguration, not a
  // reason to let everything through. Its shape is read again, fresh,
  // before that's said: catalogPolicy may have just been turned off.
  const missing = async () => {
    if (!(await required(true))) return [];
    throw new Error(
      "The console's identity policy holds no released digests (the kernel chart's catalogPolicy), but the kernel's catalog " +
        `identity policy (the console chart's catalogPolicy.identityPolicyName, \"${config.catalogIdentityPolicyName}\") isn't there to check them against.`,
    );
  };
  if (!config.catalogIdentityPolicyName) return (await required(false)) ? missing() : [];
  const key = (use: KernelUse) => kernelKey(use.digest, use.team, use.repository, use.action, use.serviceAccount, use.audiences.join(","));
  const unlisted = (listed: Set<string>) => uses.filter((use) => !listed.has(key(use)));
  let listed = await kernelListed(false);
  if (listed && unlisted(listed).length > 0) listed = await kernelListed(true);
  if (!listed && (await required(false))) return missing();
  if (!listed) {
    if (catalogSigned()) {
      log?.warn({ event: "catalog_policy_missing", policy: config.catalogIdentityPolicyName },
        "the catalog is signed, but the kernel's catalog identity policy isn't there: only the console's checks products' identities");
    }
    return [];
  }
  return [...new Set(unlisted(listed).map((use) => use.digest))];
}

/** Forgets the cached read (tests). */
export function forgetKernelPolicy(): void {
  cached = null;
}
