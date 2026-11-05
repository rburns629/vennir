// SPDX-License-Identifier: MIT
/**
 * The product registry, what a DAG step can reference (db/schema.ts), and
 * the catalog's wiring types: the logic behind ProductService.
 *
 * Registration is the catalog release's doing (catalogSync.ts, with the
 * rights of products:register, auth/scopes.ts), not a person clicking a
 * button: the real approval happened when the pull request merged, through
 * CODEOWNERS. Reading isn't scoped like writing:
 * discovering what exists is a different concern from vouching for it.
 */
import { Type } from "@sinclair/typebox";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import type { FastifyBaseLogger } from "fastify";
import { ensureTeamMember } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { hasScope, SCOPES } from "../auth/scopes.js";
import { CLOUDS, config } from "../config.js";
import type { Approval, ProductCleanup, ProductExample } from "../db/schema.js";
import { tokenAudienceProblems } from "../tokenAudiences.js";
import {
  deleteProductByName,
  findProductByName,
  findRunnableProduct,
  findTeamByIdIncludingDeleted,
  findTeamByName,
  listImageRepositories,
  listProducts,
  listWiringTypes,
  ProductOwnershipError,
  releaseImageRepository,
  replaceWiringTypes,
  upsertProduct,
} from "../db/queries.js";
import { allowedPrefixes, readImagePolicy } from "../imagePolicy.js";
import { ensureServiceAccount, NamespaceNotFoundError } from "../k8s.js";
import { syncIdentityPolicy } from "../productPolicy.js";
import { ESO_SERVICE_ACCOUNTS } from "../secretStores.js";
import { checkNow } from "../readiness.js";
import { refreshProvides } from "../resourceRecorder.js";
import { pinImages } from "../registry.js";
import { ensureNotRetired } from "./retired.js";
import { digestOf, requestScan } from "../scanning.js";
import { ensureRunsHere } from "./clouds.js";

const REQUIRES_ADMIN = "Requires admin access.";

/** A ServiceAccount or Secret name: a Kubernetes DNS-1123 subdomain. */
export const KubernetesName = Type.String({ pattern: "^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$", maxLength: 253 });

/** A Kubernetes quantity, the same rule as the kernel's TaskResources ("250m", "512Mi"). */
const Quantity = Type.String({ pattern: "^[0-9]+(\\.[0-9]+)?(m|k|Ki|M|Mi|G|Gi|T|Ti)?$", maxLength: 32 });

/** The Pod size the product's tasks get unless a task sets its own. */
export const Resources = Type.Object(
  {
    cpu: Type.Optional(Quantity),
    memory: Type.Optional(Quantity),
    memoryLimit: Type.Optional(Quantity),
  },
  { additionalProperties: false },
);

export const RegisterProductBody = Type.Object({
  name: Type.String({ minLength: 1 }),
  image: Type.String({ minLength: 1 }),
  action: Type.String({ minLength: 1 }),
  // Absent or null: a platform product, admin-only to register, since no
  // team is vouching for it. Present: that team's product, which requires
  // membership in that team (or admin), as everything team-scoped does.
  team: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  inputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  // The rest of the action's product.yaml (see db/schema.ts). Each one left
  // out keeps what's already stored.
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  serviceAccount: Type.Optional(KubernetesName),
  secretRefs: Type.Optional(Type.Array(KubernetesName, { uniqueItems: true, maxItems: 50 })),
  // Checked further by tokenAudienceProblems (tokenAudiences.ts).
  tokenAudiences: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { uniqueItems: true })),
  resources: Type.Optional(Resources),
  // A team name, or "*" for every team.
  shareWith: Type.Optional(
    Type.Array(Type.Union([Type.Literal("*"), Type.String({ pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$" })]), {
      uniqueItems: true,
      maxItems: 200,
    }),
  ),
  // Only its own team sees it; it can't then be shared.
  hidden: Type.Optional(Type.Boolean()),
  sourcePath: Type.Optional(Type.String({ maxLength: 1024 })),
  // How many times a step of it may run; more than 1 only when idempotent.
  idempotent: Type.Optional(Type.Boolean()),
  maxAttempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  // The inputs naming what a step changes: one step per set of values at a time.
  concurrencyKey: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 8, uniqueItems: true })),
  // At most this many of the product's steps at once (0: no cap of its own).
  maxRunning: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  // The clouds of the installs it's for, and which file said so.
  clouds: Type.Optional(Type.Array(Type.Union(CLOUDS.map((c) => Type.Literal(c))), { maxItems: 5, uniqueItems: true })),
  cloudsFrom: Type.Optional(Type.Union([Type.Literal("product"), Type.Literal("team"), Type.Literal("")])),
  // The capacity its steps run on; null, the install's own.
  capacity: Type.Optional(Type.Union([Type.Literal("spot"), Type.Literal("onDemand"), Type.Null()])),
  // What removes the resources its steps report: another action of it, and its inputs.
  cleanup: Type.Optional(
    Type.Union([
      Type.Object({
        action: Type.String({ pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$" }),
        inputs: Type.Union([Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown(), { maxProperties: 32 }), Type.Null()]),
      }),
      Type.Null(),
    ]),
  ),
  // The action of the same product that previews this one; null: none.
  plan: Type.Optional(Type.Union([Type.String({ pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$" }), Type.Null()])),
  // The action of the same product that says whether it's ready here; null: none.
  check: Type.Optional(Type.Union([Type.String({ pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$" }), Type.Null()])),
  // Examples of running it: its passing contract tests.
  examples: Type.Optional(
    Type.Array(
      Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), inputs: Type.Record(Type.String(), Type.Unknown()), outputs: Type.Record(Type.String(), Type.Unknown()) }),
      { maxItems: 10 },
    ),
  ),
  // When a step waits for a maintainer of its team to approve it; "": never.
  approval: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("otherTeams"), Type.Literal("")])),
  // What its error codes mean, and what to do about each.
  errorHelp: Type.Optional(
    Type.Record(
      Type.String({ pattern: "^[A-Z][A-Z0-9_]{1,63}$" }),
      Type.Object({ means: Type.String({ minLength: 1, maxLength: 500 }), do: Type.Optional(Type.String({ maxLength: 500 })) }),
    ),
  ),
  deprecated: Type.Optional(Type.String({ maxLength: 1000 })),
});

export type RegisterProductInput = {
  name: string;
  image: string;
  action: string;
  team?: string | null;
  inputSchema?: Record<string, unknown>;
  displayName?: string;
  description?: string;
  outputSchema?: Record<string, unknown>;
  serviceAccount?: string;
  secretRefs?: string[];
  tokenAudiences?: string[];
  resources?: { cpu?: string; memory?: string; memoryLimit?: string };
  shareWith?: string[];
  /** Only its own team sees it (it then has no shareWith). */
  hidden?: boolean;
  /** Its product.yaml in the catalog repository. */
  sourcePath?: string;
  /** Running it again does no harm; needed for maxAttempts above 1. */
  idempotent?: boolean;
  /** How many times a step of it may run in all (1: no retries). */
  maxAttempts?: number;
  /** The inputs naming what a step changes; one step per set of values at a time. */
  concurrencyKey?: string[];
  /** At most this many of the product's steps at once; 0, no cap of its own. */
  maxRunning?: number;
  /** The clouds of the installs it's for (empty: every install), and which file said so. */
  clouds?: string[];
  cloudsFrom?: string;
  /** The capacity its steps run on (spot, onDemand); null, the install's own. */
  capacity?: "spot" | "onDemand" | null;
  /** What removes the resources its steps report; null: nothing does. */
  cleanup?: ProductCleanup | null;
  /** The action of the same product that previews this one; null: none. */
  plan?: string | null;
  /** The action of the same product that says whether it's ready here; null: none. */
  check?: string | null;
  /** Examples of running it, from its passing contract tests. */
  examples?: ProductExample[];
  /** When a step waits for a maintainer of its team to approve it; "": never. */
  approval?: Approval | "";
  /** Teams whose runs wait for an approval (product.yaml's approval as a list). */
  approvalTeams?: string[];
  /** What its error codes mean, and what to do about each. */
  errorHelp?: Record<string, { means: string; do?: string }>;
  /** Empty: not deprecated. */
  deprecated?: string;
};

/**
 * The wiring vocabulary (db/schema.ts's wiringTypes), for an install whose
 * catalog defines none (ReplaceWiringTypes): one entry per type name.
 */
export const WiringTypesBody = Type.Record(
  // A type's name: lower-case words joined by dots (gcp.project). Any
  // other key is refused, rather than vanishing (an all-misnamed body would
  // otherwise wipe the set).
  Type.String({ pattern: "^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$" }),
  Type.Object({
    jsonType: Type.Union([Type.Literal("string"), Type.Literal("integer"), Type.Literal("number"), Type.Literal("boolean")]),
    description: Type.String({ minLength: 1, maxLength: 2000 }),
    shared: Type.Boolean(),
    // <team>/<product>.<action>
    defaultProvider: Type.Optional(Type.String({ pattern: "^[a-z0-9-]+/[a-z0-9-]+\\.[a-z0-9-]+$" })),
  }),
  {
    additionalProperties: false,
    // At least one type: the catalog always has some.
    minProperties: 1,
    maxProperties: 500,
  },
);

/** A Postgres unique_violation: registering the same (image, action) pair
 * under a second name hits the other unique constraint, which isn't the
 * "already registered, update it" case onConflictDoUpdate handles (keyed on
 * name). drizzle-orm wraps the pg error, the one with the SQLSTATE as its
 * `.cause` (undocumented; seen in the installed version). */
export function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}

/** Who owns what a registration collided with, in words. */
async function ownershipMessage(error: ProductOwnershipError, name: string): Promise<string> {
  let owner = "the platform (no team)";
  if (error.ownerTeamId !== null) {
    const team = await findTeamByIdIncludingDeleted(error.ownerTeamId);
    owner = team ? `team "${team.name}"${team.deletedAt ? " (purged)" : ""}` : "another team";
  }
  if (error.conflict === "name") return `The product name "${name}" belongs to ${owner}.`;
  if (error.conflict === "serviceAccount") {
    return `${name}: its serviceAccount is another product's, of ${owner}: a product runs as its own; choose another.`;
  }
  return `This image's repository belongs to ${owner}: only its products may use it. An admin can release a repository no product uses.`;
}

/** Every product anyone signed in may see: all but hidden ones, which only
 * their own team (and admins) see. */
export async function products(caller: AuthUser | undefined) {
  const all = await listProducts();
  if (caller?.isAdmin) return all;
  return all.filter((p) => !p.hidden || (p.teamName !== null && (caller?.teamNames ?? []).includes(p.teamName)));
}

export async function registerProduct(caller: AuthUser | undefined, input: RegisterProductInput) {
  const teamName = input.team ?? null;
  const audienceProblems = tokenAudienceProblems(input.tokenAudiences ?? []);
  if (audienceProblems.length > 0) {
    throw new ApiError(422, "UNPROCESSABLE_ENTITY", `${input.name}: ${audienceProblems.join("; ")}.`);
  }
  // -api is an API product's ServiceAccount: the gateway may mint tokens
  // for those (its admission policy), so no product may run as one.
  if (input.serviceAccount?.endsWith("-api")) {
    throw new ApiError(422, "UNPROCESSABLE_ENTITY", `${input.name}: a serviceAccount ending in -api is an API's (the gateway mints its tokens); choose another.`);
  }
  // ESO signs in to the team's vault as these, with the identity the
  // catalog's admins approved in its SecretStore files.
  if (input.serviceAccount && ESO_SERVICE_ACCOUNTS.includes(input.serviceAccount)) {
    throw new ApiError(422, "UNPROCESSABLE_ENTITY", `${input.name}: ${input.serviceAccount} is the ServiceAccount ESO reads the team's vault as; choose another.`);
  }
  if (input.hidden && (input.shareWith ?? []).length > 0) {
    throw new ApiError(422, "UNPROCESSABLE_ENTITY", `${input.name}: a hidden action can't be shared (shareWith).`);
  }
  if ((input.maxAttempts ?? 1) > 1 && !input.idempotent) {
    throw new ApiError(422, "UNPROCESSABLE_ENTITY", `${input.name}: only an idempotent action may have more than one attempt.`);
  }

  let teamId: string | null = null;
  if (teamName === null) {
    forbiddenUnlessAdmin(caller, "Registering a platform product (no team) requires admin access.");
  } else {
    // Products come from the catalog (its review decides what code runs, as
    // what), or from an admin: a team's maintainers don't register them.
    if (!caller?.isAdmin && !hasScope(caller, SCOPES.PRODUCTS_REGISTER)) {
      throw new ApiError(403, "FORBIDDEN", "Products are registered by the catalog's release, or by a platform admin.");
    }
    const team = await findTeamByName(teamName);
    if (!team) throw new ApiError(404, "NOT_FOUND", `No such team: "${teamName}".`);
    ensureNotRetired(team);
    teamId = team.id;
    // Its ServiceAccount exists from registration on, so the platform team
    // can bind a cloud identity to it before its first run. Created if
    // missing, never modified (k8s.ts). A platform product's is created in
    // each team namespace it first runs in.
    const serviceAccount = input.serviceAccount;
    if (serviceAccount && serviceAccount !== "default") {
      try {
        await ensureServiceAccount(teamName, serviceAccount);
      } catch (error) {
        if (!(error instanceof NamespaceNotFoundError)) throw error;
        throw new ApiError(422, "UNPROCESSABLE_ENTITY", error.message);
      }
    }
  }

  // Its image is scanned from registration on (scanning.ts): pinned already
  // (a catalog release registers by digest), or resolved here. A digest whose scan
  // failed isn't registered; one still being scanned is, and submissions
  // wait for its verdict.
  if (config.scanning.enabled) {
    let pinned: string | undefined = digestOf(input.image) ? input.image : undefined;
    if (!pinned) {
      const policy = await readImagePolicy();
      pinned = (await pinImages([input.image], allowedPrefixes(policy))).pinned.get(input.image);
    }
    const scan = pinned ? await requestScan(pinned) : null;
    if (scan?.status === "failed" && scan.acceptedAt === null) {
      throw new ApiError(
        422,
        "IMAGE_SCAN_FAILED",
        `${pinned ?? input.image} fails the security scan; it isn't registered. Rebuild it, or an admin can accept it with a reason.`,
        undefined,
        { findings: scan.findings },
      );
    }
  }

  try {
    const product = await upsertProduct({
      name: input.name,
      image: input.image,
      action: input.action,
      teamId,
      inputSchema: input.inputSchema,
      displayName: input.displayName,
      description: input.description,
      outputSchema: input.outputSchema,
      serviceAccount: input.serviceAccount,
      secretRefs: input.secretRefs,
      tokenAudiences: input.tokenAudiences,
      shareWith: input.shareWith,
      hidden: input.hidden,
      sourcePath: input.sourcePath,
      idempotent: input.idempotent,
      maxAttempts: input.maxAttempts,
      concurrencyKey: input.concurrencyKey,
      maxRunning: input.maxRunning,
      clouds: input.clouds,
      cloudsFrom: input.cloudsFrom,
      capacity: input.capacity,
      cleanup: input.cleanup,
      plan: input.plan,
      check: input.check,
      examples: input.examples,
      approval: input.approval === undefined ? undefined : input.approval || null,
      approvalTeams: input.approvalTeams,
      errorHelp: input.errorHelp,
      deprecated: input.deprecated === undefined ? undefined : input.deprecated || null,
      resources: input.resources,
    });
    await syncIdentityPolicy();
    // What it made before typed its outputs this way is offered by type too.
    await refreshProvides(product.name, product.outputSchema);
    return product;
  } catch (error) {
    if (error instanceof ProductOwnershipError) {
      throw new ApiError(409, "CONFLICT", await ownershipMessage(error, input.name));
    }
    if (isUniqueViolation(error)) {
      throw new ApiError(
        409,
        "CONFLICT",
        `"${input.image}" + "${input.action}" is already registered under a different name.`,
      );
    }
    throw error;
  }
}

export async function deleteProduct(caller: AuthUser | undefined, name: string): Promise<void> {
  const product = await findProductByName(name);
  if (!product) throw new ApiError(404, "NOT_FOUND", "No such product.");
  if (product.teamId === null) {
    forbiddenUnlessAdmin(caller, "Deleting a platform product (no team) requires admin access.");
  } else {
    if (!caller?.isAdmin && !hasScope(caller, SCOPES.PRODUCTS_REGISTER)) {
      throw new ApiError(403, "FORBIDDEN", "Products are unregistered by the catalog's release, or by a platform admin.");
    }
  }
  await deleteProductByName(name);
  await syncIdentityPolicy();
}

/** Which team owns each image repository (db/schema.ts's imageRepositories). Admins only. */
export async function imageRepositories(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  return listImageRepositories();
}

/** Lets any team claim a repository no product uses. Admins only. */
export async function releaseRepository(caller: AuthUser | undefined, repository: string): Promise<void> {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const outcome = await releaseImageRepository(repository);
  if (outcome === "not-found") throw new ApiError(404, "NOT_FOUND", "No team owns that repository.");
  if (outcome === "in-use") {
    throw new ApiError(409, "CONFLICT", "Registered products still use that repository: delete them first.");
  }
}

export function wiringTypes() {
  return listWiringTypes();
}

/** Replaces every wiring type: an admin, or whoever may register products. */
export async function setWiringTypes(
  caller: AuthUser | undefined,
  body: Record<string, { jsonType: "string" | "integer" | "number" | "boolean"; description: string; shared: boolean; defaultProvider?: string }>,
) {
  if (!caller?.isAdmin && !hasScope(caller, SCOPES.PRODUCTS_REGISTER)) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Replacing the wiring types requires admin access or the products:register scope.",
    );
  }
  const types = Object.entries(body).map(([name, type]) => ({
    name,
    jsonType: type.jsonType,
    description: type.description,
    shared: type.shared,
    defaultProvider: type.defaultProvider ?? null,
    team: null,
  }));
  return replaceWiringTypes(types);
}

/** Runs a product's readiness check now (Check now): its team's members, and admins. */
export async function checkProductNow(caller: AuthUser | undefined, name: string, log: FastifyBaseLogger): Promise<{ started: boolean }> {
  const product = await findRunnableProduct(name);
  if (!product) throw new ApiError(404, "NOT_FOUND", `No product "${name}".`);
  ensureTeamMember(caller, product.teamName);
  if (!product.check) throw new ApiError(409, "NO_CHECK", `${name} has no check: its product.yaml names none.`);
  ensureRunsHere(product);
  return { started: await checkNow(product, log) };
}
