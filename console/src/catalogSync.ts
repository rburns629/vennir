// SPDX-License-Identifier: MIT
/**
 * Pull-based catalog registration: this console reads its catalog's release
 * (proto/vertra/catalog/v1/release.proto) from the registry, verifies its
 * signature where the install trusts one, and applies it. Catalog CI only
 * builds, tests, scans, signs and pushes; it holds no console credential,
 * and any number of installs read the same catalog.
 *
 * Applying a release, as the catalog's CI used to through the API, and with
 * exactly its old token's rights (CATALOG):
 *   - each team it names exists and is active, with its namespace; a team
 *     made by an earlier release that this one doesn't name is retired
 *     (reversible). Purging stays an admin's action, never a release's. A
 *     team that exists but no release made (by hand, or before this console
 *     read releases) is left alone, its products and SecretStores too, until
 *     an admin adopts it (adoptTeam): a new catalog folder never takes over
 *     an existing team's namespace and secrets by itself;
 *   - each product action is registered at its pinned image (scanned, owned,
 *     checked as any registration is); one an earlier release registered
 *     that this one doesn't have is unregistered;
 *   - each team's templates are stored as the release has them; one it
 *     no longer has is removed;
 *   - each team's API products are stored with their OpenAPI documents,
 *     each with its ServiceAccount (create-only, as a product's); one it no
 *     longer has is removed;
 *   - the catalog's wiring types (every team's types.yaml) replace the
 *     install's, when it has any;
 *   - each team's SecretStore documents are applied. A store's stored
 *     credential is set per install (TeamService.SetSecretStoreCredential),
 *     never carried by a release.
 * One item that fails is recorded and the rest still apply; the release
 * isn't applied again unless asked (SyncCatalog), and the next one is.
 *
 * Every few minutes (config.catalog.pollSeconds), and on SyncCatalog; one
 * console at a time (an advisory lock), so replicas don't apply it twice.
 */
import { fromJson } from "@bufbuild/protobuf";
import type { JsonValue } from "@bufbuild/protobuf";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "./apiError.js";

import { writeAuditEntry } from "./audit.js";
import { SCOPES } from "./auth/scopes.js";
import type { AuthUser } from "./auth/plugin.js";
import { CLOUDS, config } from "./config.js";
import { deleteProduct, registerProduct } from "./core/products.js";
import { applySecretStore, ensureTeam, retireTeam } from "./core/teams.js";
import { parameterSchemaProblem, templateStepProblems } from "./core/templates.js";
import { db } from "./db/client.js";
import { deleteApisExcept, deleteTemplatesExcept, findTeamByName, replaceWiringTypes, upsertApi, upsertTemplate } from "./db/queries.js";
import type { BackendAuth } from "./db/schema.js";
import { catalogSync, products, teams } from "./db/schema.js";
import { ReleaseSchema, type BackendAuth as ReleaseBackendAuth, type Release } from "./gen/vertra/catalog/v1/release_pb.js";
import { createVerifyJob, deleteScanJob, ensureServiceAccount, readScanJob } from "./k8s.js";
import { catalogSyncs } from "./metrics.js";
import { fetchRelease, listTags } from "./registry.js";
import { reservedAudiences } from "./tokenAudiences.js";

/** The rights a release is applied with: what catalog CI's token held. */
const CATALOG: AuthUser = {
  id: "catalog-sync",
  teamNames: [],
  maintainerOf: [],
  isAdmin: false,
  scopes: [SCOPES.TEAMS_CREATE, SCOPES.TEAMS_RETIRE, SCOPES.PRODUCTS_REGISTER, SCOPES.SECRET_STORES_APPLY],
};

/** Any constant no one else uses: one console applies a release at a time. */
const LOCK_KEY = 4_170_225_610;

export interface CatalogProblem {
  item: string;
  message: string;
  /** A team the catalog didn't make, which an admin may adopt. */
  adoptableTeam?: string;
}

export interface CatalogStatus {
  /** Where the release is read from; empty: no catalog configured. */
  release: string;
  /** Whether it follows the newest version rather than release's tag. */
  newestVersion: boolean;
  digest: string | null;
  /** The version applied (vX.Y.Z), when the release read was one. */
  version: string | null;
  commit: string | null;
  repository: string | null;
  appliedAt: Date | null;
  problems: CatalogProblem[];
  checkedAt: Date | null;
  error: string | null;
  /** What the applied release held; null before one was applied. */
  applied: CatalogCounts | null;
}

export interface CatalogCounts {
  teams: number;
  /** By image: one product, any number of actions. */
  products: number;
  actions: number;
  templates: number;
  apis: number;
  secretStores: number;
}

/** What a release holds, as Admin's catalog section says what it applied. */
export function countsOf(release: Release): CatalogCounts {
  return {
    teams: release.teams.length,
    products: new Set(release.products.map((p) => p.image.split("@")[0])).size,
    actions: release.products.length,
    templates: release.templates.length,
    apis: release.apis.length,
    secretStores: release.teams.reduce((n, t) => n + t.secretStoreDocuments.length, 0),
  };
}

export async function catalogStatus(): Promise<CatalogStatus> {
  const [row] = await db.select().from(catalogSync).where(eq(catalogSync.id, 1));
  return {
    release: config.catalog.release,
    newestVersion: config.catalog.newestVersion,
    digest: row?.digest ?? null,
    version: row?.version ?? null,
    commit: row?.commit ?? null,
    repository: row?.repository ?? null,
    appliedAt: row?.appliedAt ?? null,
    problems: row?.problems ?? [],
    checkedAt: row?.checkedAt ?? null,
    error: row?.error ?? null,
    applied: row?.applied ?? null,
  };
}

async function record(values: Partial<typeof catalogSync.$inferInsert>): Promise<void> {
  await db
    .insert(catalogSync)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: catalogSync.id, set: values });
}

/**
 * Each named team's API products, as the release has them, each with its
 * ServiceAccount; every other API of those teams goes. One that fails to
 * apply keeps what was stored.
 */
export async function applyApis(
  released: Release["apis"],
  named: Set<string>,
  foreign: Set<string>,
  attempt: (item: string, work: () => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const keepApis = new Set<string>();
  // Only the named teams' APIs change: a team the release drops is retired,
  // which takes its APIs off the gateway.
  const teamIds: string[] = [];
  for (const name of named) {
    const team = foreign.has(name) ? undefined : await findTeamByName(name);
    if (team) teamIds.push(team.id);
  }
  for (const a of released) {
    if (foreign.has(a.team) || !named.has(a.team)) continue;
    const team = await findTeamByName(a.team);
    if (!team) continue;
    keepApis.add(`${team.id}/${a.name}`);
    await attempt(`api ${a.team}/${a.name}`, async () => {
      let openapi: unknown;
      try {
        openapi = JSON.parse(a.openapi);
      } catch {
        throw new ReleaseProblem("its OpenAPI document isn't JSON");
      }
      if (typeof openapi !== "object" || openapi === null) throw new ReleaseProblem("its OpenAPI document isn't an object");
      // The gateway mints tokens only for an API's own ServiceAccount
      // (*-api, its policy) and never for the cluster's own audiences.
      if (!a.serviceAccount.endsWith("-api")) throw new ReleaseProblem(`its serviceAccount ${a.serviceAccount} must end in -api`);
      if (a.backendAuth?.kind.case === "serviceAccountToken" && reservedAudiences().has(a.backendAuth.kind.value.audience)) {
        throw new ReleaseProblem(`its backend's token audience ${a.backendAuth.kind.value.audience} is this cluster's own (the Kubernetes API's or kernel-api's)`);
      }
      // The identity its backend credentials are minted for (phase 4).
      await ensureServiceAccount(a.team, a.serviceAccount);
      await upsertApi({
        teamId: team.id,
        name: a.name,
        displayName: a.displayName,
        description: a.description,
        openapi,
        backendUrl: a.backendUrl,
        backendAuth: backendAuth(a.backendAuth),
        serviceAccount: a.serviceAccount,
        shareWith: a.shareWith,
        hidden: a.hidden,
        deprecated: a.deprecated || null,
        internet: a.internet,
        perMinute: a.perMinute,
        timeoutSeconds: a.timeoutSeconds || 30,
        maxRequestBytes: Number(a.maxRequestBytes) || 1_048_576,
        sourcePath: a.path || null,
      });
    });
  }
  await attempt("removing APIs", () => deleteApisExcept(teamIds, keepApis));
}

function backendAuth(auth: ReleaseBackendAuth | undefined): BackendAuth | null {
  switch (auth?.kind.case) {
    case "serviceAccountToken":
      return { serviceAccountToken: { audience: auth.kind.value.audience } };
    case "googleIdToken":
      return { googleIdToken: { serviceAccount: auth.kind.value.serviceAccount, audience: auth.kind.value.audience } };
    case "awsSigV4": {
      const { roleArn, region, service } = auth.kind.value;
      return { awsSigV4: { roleArn, region, service } };
    }
    default:
      return null;
  }
}

/** What's wrong with a release's own contents, said as the problem. */
class ReleaseProblem extends Error {}

/** What a sync or an item records as why it failed: a refusal's, a
 * release's problem, or this code's own plain Error, which says what to do.
 * Anything else (the cluster client's, carrying response bodies and
 * headers; the database's) only the log has. */
function message(error: unknown): string {
  if (error instanceof ApiError || error instanceof ReleaseProblem) return error.message;
  if (error instanceof Error && error.constructor === Error) return error.message;
  return "failed unexpectedly: the console's log has why";
}

/** What `cosign verify` needs to check a release against each trusted
 * signer: one try per public key, then keyless. Empty: nothing trusted, so
 * nothing verified (the registry's main-only write access is the trust). */
function verifications(reference: string): { args: string[]; publicKey?: string }[] {
  const { publicKeys, keylessIssuer, keylessSubjectRegExp } = config.catalog.signature;
  // Registry sign-in as the scan Jobs have it: the pull Secret's Docker
  // config when there is one (cosign's default keychain), else the cloud
  // identity of the Job's ServiceAccount (GKE Workload Identity, EKS), which
  // cosign reads only with --k8s-keychain.
  const keychain = config.scanning.pullSecretName ? [] : ["--k8s-keychain"];
  // Catalog CI's key signatures go to no public log (`vertra catalog publish`'s signing).
  const tries: { args: string[]; publicKey?: string }[] = publicKeys.map((publicKey) => ({
    args: [...keychain, "--key", "env://COSIGN_PUBLIC_KEY", "--insecure-ignore-tlog=true", reference],
    publicKey,
  }));
  if (keylessIssuer && keylessSubjectRegExp) {
    tries.push({
      args: [...keychain, "--certificate-oidc-issuer", keylessIssuer, "--certificate-identity-regexp", keylessSubjectRegExp, reference],
    });
  }
  return tries;
}

/** Whether any trusted signer signed `reference` (pinned by digest). */
async function verified(reference: string, log: FastifyBaseLogger): Promise<boolean> {
  const namespace = config.platformNamespace;
  for (const [i, attempt] of verifications(reference).entries()) {
    const name = `catalog-verify-${Date.now().toString(36)}-${String(i)}`;
    await createVerifyJob({
      namespace,
      name,
      image: config.catalog.verifierImage,
      serviceAccount: config.scanning.serviceAccount,
      pullSecretName: config.scanning.pullSecretName,
      ...attempt,
    });
    const deadline = Date.now() + 300_000;
    let state = await readScanJob(namespace, name, "cosign");
    while (state.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      state = await readScanJob(namespace, name, "cosign");
    }
    await deleteScanJob(namespace, name);
    if (state.state === "succeeded") return true;
    log.warn({ event: "catalog_release_unverified", reference, output: "output" in state ? state.output.slice(-500) : state.state },
      "a trusted signer didn't verify the catalog release");
  }
  return false;
}

/** Applies a release; returns what it couldn't do. */
export async function apply(release: Release, log: FastifyBaseLogger): Promise<CatalogProblem[]> {
  const problems: CatalogProblem[] = [];
  const attempt = async (item: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      problems.push({ item, message: message(error) });
      log.warn({ event: "catalog_apply_problem", item, err: error }, `catalog release: ${item} failed`);
    }
  };
  const named = new Set(release.teams.map((t) => t.name));
  // Teams this release may not touch: ones no release made.
  const foreign = new Set<string>();
  for (const team of release.teams) {
    const [existing] = await db
      .select({ fromCatalog: teams.fromCatalog, deletedAt: teams.deletedAt })
      .from(teams)
      .where(eq(teams.name, team.name));
    if (existing && !existing.fromCatalog && !existing.deletedAt) {
      foreign.add(team.name);
      problems.push({
        item: `team ${team.name}`,
        message: `a team named ${team.name} already exists here and the catalog didn't make it; its products and SecretStores weren't applied. Adopt it if the catalog's folder is meant to be that team, or rename the folder.`,
        adoptableTeam: team.name,
      });
      continue;
    }
    await attempt(`team ${team.name}`, async () => {
      await ensureTeam(CATALOG, team.name, log);
      const allowedTargets = team.allowedTargets.map((rule) => ({
        teams: rule.teams,
        targets: Object.fromEntries(rule.targets.map((t) => [t.type, t.values])),
        ...(rule.approval ? { approval: true } : {}),
      }));
      await db
        .update(teams)
        .set({
          fromCatalog: true,
          allowedTargets,
          contact: team.contact || null,
          owner: team.owner || null,
          description: team.description || null,
          helpChat: team.helpChat || null,
          helpUrl: team.helpUrl || null,
        })
        .where(eq(teams.name, team.name));
    });
  }
  const released = new Set<string>();
  for (const p of release.products) {
    released.add(p.name);
    if (foreign.has(p.team)) continue;
    // Only into a team this release names (and so made, or will): never
    // into one it leaves out, which may be a team no release made.
    if (!named.has(p.team)) {
      problems.push({ item: `product ${p.name}`, message: `its team ${p.team} isn't one of this release's teams, so it wasn't registered.` });
      continue;
    }
    await attempt(`product ${p.name}`, async () => {
      // A cloud this console doesn't know would keep it from running anywhere.
      const unknown = p.clouds.filter((c) => !CLOUDS.includes(c));
      if (unknown.length > 0) throw new ReleaseProblem(`its clouds name ${unknown.join(", ")}: not one of ${CLOUDS.join(", ")}`);
      await registerProduct(CATALOG, {
        name: p.name,
        image: p.image,
        action: p.action,
        team: p.team,
        inputSchema: p.inputSchema ?? {},
        outputSchema: p.outputSchema ?? {},
        ...(p.displayName ? { displayName: p.displayName } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.serviceAccount ? { serviceAccount: p.serviceAccount } : {}),
        secretRefs: p.secretRefs,
        tokenAudiences: p.tokenAudiences,
        shareWith: p.shareWith,
        hidden: p.hidden,
        ...(p.path ? { sourcePath: p.path } : {}),
        idempotent: p.idempotent,
        maxAttempts: p.maxAttempts > 0 ? p.maxAttempts : 1,
        concurrencyKey: p.concurrencyKey,
        maxRunning: p.maxRunning,
        clouds: p.clouds,
        cloudsFrom: p.cloudsFrom,
        capacity: p.capacity === "spot" || p.capacity === "onDemand" ? p.capacity : null,
        cleanup: p.cleanup ? { action: p.cleanup.action, inputs: p.cleanup.inputs ?? null } : null,
        plan: p.plan || null,
        check: p.check || null,
        examples: p.examples.map((e) => ({ name: e.name, inputs: e.inputs ?? {}, outputs: e.outputs ?? {} })),
        approval: p.approval === "always" || p.approval === "otherTeams" ? p.approval : "",
        approvalTeams: p.approvalTeams,
        errorHelp: Object.fromEntries(
          Object.entries(p.errors).map(([code, help]) => [code, { means: help.means, ...(help.do ? { do: help.do } : {}) }]),
        ),
        deprecated: p.deprecated,
        ...(p.resources
          ? {
              resources: Object.fromEntries(
                Object.entries({ cpu: p.resources.cpu, memory: p.resources.memory, memoryLimit: p.resources.memoryLimit }).filter(
                  ([, v]) => v,
                ),
              ),
            }
          : {}),
      });
      await db.update(products).set({ fromCatalog: true }).where(eq(products.name, p.name));
    });
  }
  // Each named team's templates, as the release has them. One that fails to
  // apply keeps what was stored; every other template of a team the catalog
  // made goes, as its products do.
  const keepTemplates = new Set<string>();
  for (const t of release.templates) {
    if (foreign.has(t.team) || !named.has(t.team)) continue;
    const team = await findTeamByName(t.team);
    if (!team) continue; // its own problem, above
    keepTemplates.add(`${team.id}/${t.name}`);
    await attempt(`template ${t.team}/${t.name}`, async () => {
      const parameters = t.parameters ?? { type: "object" };
      const problem = parameterSchemaProblem(parameters);
      if (problem) throw new ReleaseProblem(`its parameters aren't a usable JSON Schema: ${problem}`);
      // Every step's action, as applied just above, shared with this team.
      const stepProblems = await templateStepProblems(t.team, t.name, t.steps);
      if (stepProblems.length > 0) throw new ReleaseProblem(stepProblems.join(" "));
      await upsertTemplate({
        teamId: team.id,
        name: t.name,
        displayName: t.displayName,
        description: t.description,
        parameters,
        steps: t.steps.map((step) => ({
          id: step.id,
          action: step.action,
          ...(step.dependsOn.length > 0 ? { dependsOn: step.dependsOn } : {}),
          ...(step.inputs ? { inputs: step.inputs } : {}),
          ...(step.timeoutSeconds !== undefined ? { timeoutSeconds: step.timeoutSeconds } : {}),
          ...(step.maxAttempts !== undefined ? { maxAttempts: step.maxAttempts } : {}),
        })),
        shareWith: t.shareWith,
        hidden: t.hidden,
        sourcePath: t.path || null,
        deprecated: t.deprecated || null,
        examples: t.examples.slice(0, 10).map((e) => ({ name: e.name, inputs: e.inputs ?? {}, outputs: {} })),
      });
    });
  }
  await attempt("removing templates", () => deleteTemplatesExcept(keepTemplates));
  await applyApis(release.apis, named, foreign, attempt);
  // The whole vocabulary, when the catalog defines one; else the install's
  // own (ReplaceWiringTypes) stay.
  const vocabulary = release.wiringTypes;
  if (vocabulary) {
    await attempt("wiring types", () =>
      replaceWiringTypes(
        vocabulary.types.map((t) => ({
          name: t.name,
          team: t.team,
          jsonType: t.jsonType,
          description: t.description,
          shared: t.shared,
          defaultProvider: t.defaultProvider || null,
        })),
      ),
    );
  }
  // What earlier releases made and this one no longer has.
  for (const gone of await db.select({ name: products.name }).from(products).where(eq(products.fromCatalog, true))) {
    if (!released.has(gone.name)) await attempt(`removing product ${gone.name}`, () => deleteProduct(CATALOG, gone.name));
  }
  const catalogTeams = await db
    .select({ name: teams.name, retiredAt: teams.retiredAt, deletedAt: teams.deletedAt })
    .from(teams)
    .where(eq(teams.fromCatalog, true));
  for (const team of catalogTeams) {
    if (!named.has(team.name) && !team.retiredAt && !team.deletedAt) {
      await attempt(`retiring team ${team.name}`, () => retireTeam(CATALOG, team.name, log));
    }
  }
  for (const team of release.teams.filter((t) => t.secretStoreDocuments.length > 0 && !foreign.has(t.name))) {
    await attempt(`secret stores of ${team.name}`, () =>
      applySecretStore(CATALOG, team.name, { documents: team.secretStoreDocuments }, log),
    );
  }
  return problems;
}

/** A catalog version: a Git tag vX.Y.Z, as `vertra catalog promote` makes. */
const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The newest of `tags` that's a version, or null when none is. */
export function newestVersion(tags: string[]): string | null {
  const parts = (tag: string) => tag.slice(1).split(".").map(Number);
  let newest: string | null = null;
  for (const tag of tags.filter((t) => VERSION.test(t))) {
    if (newest === null) {
      newest = tag;
      continue;
    }
    const [a, b] = [parts(tag), parts(newest)];
    const i = a.findIndex((n, k) => n !== b[k]);
    if (i >= 0 && (a[i] ?? 0) > (b[i] ?? 0)) newest = tag;
  }
  return newest;
}

/** The release this console follows now: the one its setting names, or
 * (newestVersion) its repository's newest version. */
async function followed(): Promise<{ reference: string; version: string | null }> {
  const repository = config.catalog.release.replace(/[:@][^/]*$/, "");
  if (config.catalog.newestVersion) {
    const version = newestVersion(await listTags(repository));
    if (!version) throw new Error(`${repository} has no version yet (a vX.Y.Z tag in the catalog repository makes one); nothing was applied`);
    return { reference: `${repository}:${version}`, version };
  }
  const tag = /:([^/@]+)$/.exec(config.catalog.release)?.[1] ?? "";
  return { reference: config.catalog.release, version: VERSION.test(tag) ? tag : null };
}

/**
 * One look: fetch the release, and if it's new (or `force`), verify and
 * apply it. Never throws: the outcome is recorded (catalogStatus) and
 * logged. Returns false when another console holds the lock.
 */
export async function syncCatalog(log: FastifyBaseLogger, force = false): Promise<boolean> {
  if (!config.catalog.release) return true;
  return db.transaction(async (tx) => {
    // Released when this transaction ends.
    const locked = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`);
    if (!locked.rows[0]?.locked) return false;
    const now = new Date();
    try {
      const { reference, version } = await followed();
      const { digest, json } = await fetchRelease(reference);
      const [current] = await db.select().from(catalogSync).where(eq(catalogSync.id, 1));
      if (!force && current?.digest === digest) {
        // The same release may be a new version of it.
        await record({ version, checkedAt: now, error: null });
        catalogSyncs.inc({ outcome: "unchanged" });
        return true;
      }
      const repository = config.catalog.release.replace(/[:@][^/]*$/, "");
      if (verifications(`${repository}@${digest}`).length > 0 && !(await verified(`${repository}@${digest}`, log))) {
        throw new Error(`no trusted signer signed the catalog release ${repository}@${digest}; nothing was applied`);
      }
      const release = fromJson(ReleaseSchema, JSON.parse(json) as JsonValue, { ignoreUnknownFields: true });
      const problems = await apply(release, log);
      await record({ digest, version, commit: release.commit, repository: release.repository, appliedAt: now, problems, checkedAt: now, error: null, applied: countsOf(release) });
      await writeAuditEntry(log, {
        actorId: null,
        method: "CATALOG",
        route: "catalog-sync",
        target: { commit: release.commit, version, teams: release.teams.length, products: release.products.length, problems: problems.length },
        status: problems.length === 0 ? 200 : 207,
        requestId: digest,
      });
      catalogSyncs.inc({ outcome: problems.length === 0 ? "applied" : "applied_with_problems" });
      log.info(
        { event: "catalog_release_applied", commit: release.commit, version, digest, teams: release.teams.length, products: release.products.length, problems: problems.length },
        "catalog release applied",
      );
    } catch (error) {
      await record({ checkedAt: now, error: message(error) });
      catalogSyncs.inc({ outcome: "failed" });
      log.error({ event: "catalog_sync_failed", err: error }, "couldn't sync the catalog");
    }
    return true;
  });
}

/**
 * Lets releases manage a team they didn't make; the next sync then applies
 * its products and SecretStores. Admins only (core/admin.ts).
 */
export async function adoptTeam(name: string): Promise<boolean> {
  const adopted = await db
    .update(teams)
    .set({ fromCatalog: true })
    .where(and(eq(teams.name, name), isNull(teams.deletedAt)))
    .returning({ id: teams.id });
  return adopted.length > 0;
}

/** Syncs every pollSeconds from now on, and once right away. */
export function startCatalogSync(log: FastifyBaseLogger): void {
  if (!config.catalog.release) return;
  void syncCatalog(log);
  setInterval(() => void syncCatalog(log), config.catalog.pollSeconds * 1000).unref();
}
