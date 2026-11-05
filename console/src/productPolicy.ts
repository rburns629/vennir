// SPDX-License-Identifier: MIT
/**
 * Keeps the cluster's copy of who may run as what current. The console
 * decides which ServiceAccount and Secrets a task may use (identityRefusal
 * in core/executions.ts); helm/charts/execution-kernel/templates/
 * identity-policy.yaml makes the Kubernetes API server enforce the same rule
 * on every Job the scheduler creates, from literals held in the policy
 * itself. This writes them, from the database, whenever products or secrets
 * change, every few minutes (policySync.ts) and at startup:
 *
 * - `releases0` to `releasesf`: a product's identity is tied to the digests
 *   it was released as (db/schema.ts's productReleases), never to whatever
 *   else its repository holds. Each maps a released digest to the products
 *   it's a release of, matched the way identityRefusal matches a task:
 *   their team (its namespace; "" for a platform product), the release's
 *   image repository (read as imageRepository reads it, which the policy's
 *   CEL does too), the action, the ServiceAccount it runs as ("default"
 *   when it declares none), and the token audiences it declared,
 *   comma-separated (tokenAudiences.ts refuses a comma in one). Sixteen
 *   maps by the digest's first hex digit, as the scan policy holds its
 *   digests, since the API server compiles at most 100,000 characters per
 *   CEL expression (MAX_MAP_CHARS, MAX_RELEASE_CHARS).
 * - `teamSecrets`: each team's registered secret names, comma-separated (CEL
 *   wants every value in a literal map to be one type; Secret names can't
 *   hold commas). A registered product may mount any of its namespace's.
 * - `products`: the list by repository (any digest) that kernel charts
 *   before released digests held, kept by the chart on upgrade so steps
 *   keep running while consoles from before, which still write it, may be
 *   taking submissions during this one's rollout. Kept as it is for this
 *   console's first UPGRADE_OVERLAP_MS, then written empty; never written
 *   with anything in it.
 *
 * Which releases are in it (releaseInUse): each product's current one, and
 * an earlier one while it's in use: a step of an execution not yet seen
 * finished runs it (the kernel starts later steps and attempts by itself),
 * or it was registered or run in the last RELEASE_GRACE_MINUTES. The rest
 * are pruned: a step of one runs as an unregistered image would.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { listTeamSecretNames } from "./db/queries.js";
import { productReleases, products, teams } from "./db/schema.js";
import { imageRepository } from "./imageRef.js";
import { allowedPrefixes, readImagePolicy } from "./imagePolicy.js";
import { updateIdentityPolicy } from "./k8s.js";
import { pinImages } from "./registry.js";
import { ADMIT_GRACE_MINUTES, digestOf, PINNED_DIGEST, runningDigests } from "./scanning.js";

/** What a task that isn't a registered product runs as, with no Secrets. */
export const UNREGISTERED_SERVICE_ACCOUNT = "default";

/** One product a released digest is a release of, as the policy's CEL matches it. */
export interface PolicyProduct {
  team: string;
  repository: string;
  action: string;
  serviceAccount: string;
  audiences: string;
}

/** A product's release, with what the policy needs about its product. */
export interface ReleaseIdentity {
  image: string;
  action: string;
  serviceAccount: string | null;
  tokenAudiences: string[];
  /** The owning team's name (its namespace); null for a platform product. */
  teamName: string | null;
}

/** How long an earlier release keeps its identity after it was last registered or run. */
export const RELEASE_GRACE_MINUTES = ADMIT_GRACE_MINUTES;

/**
 * The most characters one releases map may hold: the API server compiles
 * at most 100,000 per CEL expression, and this leaves room for the rest.
 * An entry is about 230 (its digest, about 75, and one product's fields,
 * about 150 more per action), so about 400 (digest, action) pairs a map.
 */
export const MAX_MAP_CHARS = 95_000;
/**
 * The most characters all sixteen may hold: about 2,600 (digest, action)
 * pairs. The policy object stays well under etcd's 1.5 MiB, and Helm's
 * release Secret, which keeps it (compressed) beside the scan policy's,
 * under its 1 MiB.
 */
export const MAX_RELEASE_CHARS = 600_000;

/** How long after this console starts it keeps a non-empty legacy `products` list (the chart's upgrade seed). */
export const UPGRADE_OVERLAP_MS = 10 * 60_000;
const startedAt = Date.now();

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];

const releaseDigest = sql`substring(${productReleases.image} from ${PINNED_DIGEST})`;

/**
 * Whether a release (joined with its product) gives a step its product's
 * identity: it's pinned, and it's the product's current image, or an
 * earlier one still in use (this file's header). Never NULL.
 */
export const releaseInUse: SQL = sql`(
  ${releaseDigest} IS NOT NULL AND (
    ${productReleases.image} = ${products.image}
    OR ${productReleases.lastUsedAt} > now() - make_interval(mins => ${RELEASE_GRACE_MINUTES})
    OR ${releaseDigest} IN ${runningDigests}
  )
)`;

/** Every release that gives a step its identity now, of a product that can run (a purged team's never does). */
export function listReleaseIdentities(): Promise<ReleaseIdentity[]> {
  return db
    .select({
      image: productReleases.image,
      action: products.action,
      serviceAccount: products.serviceAccount,
      tokenAudiences: products.tokenAudiences,
      teamName: teams.name,
    })
    .from(productReleases)
    .innerJoin(products, eq(products.id, productReleases.productId))
    .leftJoin(teams, eq(teams.id, products.teamId))
    .where(and(or(isNull(products.teamId), isNull(teams.deletedAt)), releaseInUse))
    .orderBy(productReleases.image, products.name);
}

/**
 * The released images (`<repository>@<digest>`, the repository normalized)
 * that give each of these products its identity now (releaseInUse), by
 * product id.
 */
export async function releasedImages(productIds: string[]): Promise<Map<string, Set<string>>> {
  const byProduct = new Map<string, Set<string>>();
  if (productIds.length === 0) return byProduct;
  const rows = await db
    .select({ productId: productReleases.productId, image: productReleases.image })
    .from(productReleases)
    .innerJoin(products, eq(products.id, productReleases.productId))
    .where(and(inArray(productReleases.productId, productIds), releaseInUse));
  for (const row of rows) {
    const key = releasedImageKey(row.image);
    if (!key) continue;
    byProduct.set(row.productId, (byProduct.get(row.productId) ?? new Set()).add(key));
  }
  return byProduct;
}

/** An image's `<repository>@<digest>`, as releasedImages keys them; null when it isn't pinned. */
export function releasedImageKey(image: string): string | null {
  const digest = digestOf(image);
  return digest ? `${imageRepository(image)}@${digest}` : null;
}

/**
 * Marks these releases used now, so each keeps its identity for
 * RELEASE_GRACE_MINUTES more (a submission's execution is recorded, and so
 * in use, only once kernel-api has it).
 */
export async function markReleasesUsed(uses: { productId: string; digest: string }[]): Promise<void> {
  const pairs = [...new Map(uses.map((use) => [`${use.productId} ${use.digest}`, use])).values()];
  if (pairs.length === 0) return;
  await db
    .update(productReleases)
    .set({ lastUsedAt: new Date() })
    .where(or(...pairs.map(({ productId, digest }) => and(eq(productReleases.productId, productId), sql`${releaseDigest} = ${digest}`))));
}

/**
 * Products registered by tag before a product's identity was tied to its
 * digests (an admin's, by hand) are pinned to the digest their tag names
 * now, as a registration by tag is: their image, and a release of it. Run at
 * startup, with image pinning on. One the registry can't resolve keeps its
 * tag, and so no identity, until it's registered again; that's logged, not
 * fatal. Returns how many were pinned.
 */
export async function pinRegisteredTags(log: FastifyBaseLogger): Promise<number> {
  if (config.imagePinning === "off") return 0;
  const tagged = await db
    .select({ id: products.id, name: products.name, image: products.image })
    .from(products)
    .where(sql`substring(${products.image} from ${PINNED_DIGEST}) IS NULL`);
  if (tagged.length === 0) return 0;
  const prefixes = allowedPrefixes(await readImagePolicy());
  let count = 0;
  for (const product of tagged) {
    const resolved = (await pinImages([product.image], prefixes)).pinned.get(product.image);
    if (!resolved || !digestOf(resolved)) {
      log.warn({ event: "product_not_pinned", product: product.name, image: product.image }, "couldn't pin a product registered by tag; it has no identity until it's registered again");
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        await tx.update(products).set({ image: resolved }).where(and(eq(products.id, product.id), eq(products.image, product.image)));
        await tx
          .insert(productReleases)
          .values({ productId: product.id, image: resolved })
          .onConflictDoUpdate({ target: [productReleases.productId, productReleases.image], set: { lastUsedAt: sql`now()` } });
      });
      count++;
    } catch (error) {
      // Another product of the same action at that digest (products are unique by both).
      log.warn({ err: error, event: "product_not_pinned", product: product.name, image: resolved }, "couldn't pin a product registered by tag");
    }
  }
  if (count > 0) log.info({ event: "products_pinned", count }, "pinned products registered by tag");
  return count;
}

/** The policy's releases maps' contents: each digest's products, sorted, each listed once. */
export function policyReleases(identities: ReleaseIdentity[]): Map<string, Map<string, PolicyProduct[]>> {
  const maps = new Map<string, Map<string, PolicyProduct[]>>(DIGITS.map((digit) => [digit, new Map()]));
  const seen = new Set<string>();
  for (const identity of identities) {
    const digest = digestOf(identity.image);
    if (!digest) continue;
    const entry: PolicyProduct = {
      team: identity.teamName ?? "",
      repository: imageRepository(identity.image),
      action: identity.action,
      serviceAccount: identity.serviceAccount ?? UNREGISTERED_SERVICE_ACCOUNT,
      audiences: identity.tokenAudiences.join(","),
    };
    const key = JSON.stringify([digest, entry]);
    if (seen.has(key)) continue;
    seen.add(key);
    const map = maps.get(digest.charAt(7));
    if (map) map.set(digest, [...(map.get(digest) ?? []), entry]);
  }
  for (const map of maps.values()) {
    for (const entries of map.values()) entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return maps;
}

/** The releases maps as the policy's variables; throws when they'd be over what it holds. */
export function releaseVariables(maps: Map<string, Map<string, PolicyProduct[]>>): Record<string, string> {
  const variables: Record<string, string> = {};
  let total = 0;
  for (const digit of DIGITS) {
    const map = maps.get(digit) ?? new Map<string, PolicyProduct[]>();
    const literal = JSON.stringify(Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b))));
    if (literal.length > MAX_MAP_CHARS) {
      throw new Error(
        `The product releases in use whose digests start ${digit} take ${String(literal.length)} characters, more than the identity policy holds in one map (${String(MAX_MAP_CHARS)}).`,
      );
    }
    total += literal.length;
    variables[`releases${digit}`] = literal;
  }
  if (total > MAX_RELEASE_CHARS) {
    throw new Error(`The product releases in use take ${String(total)} characters, more than the identity policy holds (${String(MAX_RELEASE_CHARS)}).`);
  }
  return variables;
}

/** The digests the policy's releases maps list now; a literal that can't be read counts as empty. */
/** A listed release, as admitReleases asks for one: its digest, and the product entry it runs as. */
export interface ReleaseUse {
  digest: string;
  repository: string;
  action: string;
  serviceAccount: string;
}

function useKey(use: ReleaseUse): string {
  return JSON.stringify([use.digest, use.repository, use.action, use.serviceAccount]);
}

/** Every (digest, entry) the policy's releases maps list. */
function listedUses(variables: Record<string, string>): Set<string> {
  const listed = new Set<string>();
  for (const digit of DIGITS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(variables[`releases${digit}`] ?? "{}");
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    for (const [digest, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries as Partial<PolicyProduct>[]) {
        listed.add(useKey({ digest, repository: e.repository ?? "", action: e.action ?? "", serviceAccount: e.serviceAccount ?? "" }));
      }
    }
  }
  return listed;
}

export function policyTeamSecrets(secrets: { teamName: string; secretName: string }[]): Record<string, string> {
  const byTeam = new Map<string, string[]>();
  for (const { teamName, secretName } of secrets) byTeam.set(teamName, [...(byTeam.get(teamName) ?? []), secretName]);
  return Object.fromEntries([...byTeam].sort().map(([team, names]) => [team, names.sort().join(",")]));
}

/** The legacy list (this file's header): kept as it is for UPGRADE_OVERLAP_MS, then empty. */
function legacyProducts(current: string | undefined): string {
  if (current !== undefined && current !== "[]" && Date.now() - startedAt < UPGRADE_OVERLAP_MS) return current;
  return "[]";
}

/** Everything the policy should say, given what it says now. */
async function wantedVariables(current: Record<string, string>): Promise<Record<string, string>> {
  return {
    products: legacyProducts(current["products"]),
    teamSecrets: JSON.stringify(policyTeamSecrets(await listTeamSecretNames())),
    ...releaseVariables(policyReleases(await listReleaseIdentities())),
  };
}

/**
 * Writes the releases in use and every team's secret names into the
 * identity policy, pruning the releases no longer in use. Errors propagate:
 * a caller that just changed a product or a secret fails (and can retry the
 * idempotent change), rather than leave the cluster enforcing an older list
 * unnoticed. Returns false when there's nothing to write to: no policy
 * configured (tests, local development) or installed.
 */
export async function syncIdentityPolicy(): Promise<boolean> {
  if (!config.identityPolicyName) return false;
  return updateIdentityPolicy(config.identityPolicyName, wantedVariables);
}

/**
 * Makes sure the cluster lists these releases, each under the product entry
 * a submission has just been allowed to run it as (and marked used), before
 * kernel-api has it: when one isn't listed yet (its digest may be, as
 * another product's), the whole policy is rewritten and the write waited
 * for. Returns the digests it still doesn't list so: their product changed
 * meanwhile.
 */
export async function admitReleases(uses: ReleaseUse[]): Promise<string[]> {
  const wanted = [...new Map(uses.map((use) => [useKey(use), use])).values()];
  if (wanted.length === 0 || !config.identityPolicyName) return [];
  let listed = new Set<string>();
  const exists = await updateIdentityPolicy(
    config.identityPolicyName,
    async (current) => {
      listed = listedUses(current);
      if (wanted.every((use) => listed.has(useKey(use)))) return current;
      const variables = await wantedVariables(current);
      listed = listedUses(variables);
      return variables;
    },
    { settle: true },
  );
  return exists ? [...new Set(wanted.filter((use) => !listed.has(useKey(use))).map((use) => use.digest))] : [];
}
