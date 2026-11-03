// SPDX-License-Identifier: MIT
/**
 * teams/users/teamMemberships — the portable, cloud-agnostic authorization
 * source of truth, here rather than derived from git/CODEOWNERS so a
 * membership change takes effect on the next request. SSO/SAML, when it's wired up, is purely an authentication
 * layer on top of these same tables (just-in-time provisioning writes
 * into teamMemberships, same as manual registration would) — nothing
 * about this schema changes when that's added.
 *
 * team.name doubles as the Kubernetes namespace name by convention (see
 * console/src/k8s.ts) — deliberately not a separate column, so there's exactly
 * one place "which team owns which namespace" is decided, not two that
 * could drift apart.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  boolean,
  jsonb,
  unique,
  index,
  bigserial,
  bigint,
  integer,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** A task Pod's size, as the kernel's TaskResources takes it. */
export interface ProductResources {
  cpu?: string;
  memory?: string;
  memoryLimit?: string;
}

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Retired: the platform is being wound down (its catalog folder was
  // removed). The team becomes read-only -- no new submissions, secrets,
  // bots, or product registrations -- and its products are unregistered.
  // Reversible: clearing this brings it back.
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  // Who retired it, as it was then: their email, or "the catalog" for a
  // release that dropped it; null while it isn't retired.
  retiredBy: text("retired_by"),
  // Purged: memberships, secret grants and products are gone, and the team
  // is invisible everywhere. The row itself is kept on purpose, so the name
  // stays reserved: execution history is keyed by team *name*, and a new
  // team reusing it would otherwise inherit visibility of the old one's
  // executions. Only set on a team that was retired first.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Made by a catalog release (catalogSync.ts): retired when a release no
  // longer names it. A team an admin made isn't touched by releases, unless
  // one names it, which makes it the catalog's.
  fromCatalog: boolean("from_catalog").notNull().default(false),
  // Its members sign in with single sign-on only (auth/plugin.ts): no
  // password, and no session a password made, while single sign-on is on.
  // Ignored while it's off, so nobody is locked out. Admins are exempt (a
  // way in if the provider fails).
  requireSso: boolean("require_sso").notNull().default(false),
  // What its steps may use together, set by an admin (teamQuota.ts); null:
  // the install's defaults. Kubernetes quantities, "" for no limit.
  quota: jsonb("quota").$type<{ cpu: string; memory: string; pods: string; stepMemory: string }>(),
  // team.yaml's allowedTargets, from the catalog's release: where other
  // teams may aim this team's products (targets.ts). Empty: nowhere.
  allowedTargets: jsonb("allowed_targets").$type<TargetRule[]>().notNull().default([]),
  // team.yaml's contact and help, from the release: where people ask when
  // one of its steps fails (failureHelp.ts). Null: not said.
  contact: text("contact"),
  // team.yaml's owner (a GitHub user or team): shown, never a grant.
  owner: text("owner"),
  // team.yaml's description, from the release. Null: a team made here, or none said.
  description: text("description"),
  helpChat: text("help_chat"),
  helpUrl: text("help_url"),
});

/** One rule of a team's allowedTargets: the teams it covers ("*" for every
 * team), and per kind of target (gcp.project, ...) the values or patterns
 * they may supply. */
export interface TargetRule {
  teams: string[];
  targets: Record<string, string[]>;
  /** The steps it lets through still wait for an approval. */
  approval?: boolean;
}

/** When a product's steps wait for an approval (product.yaml's approval). */
export type Approval = "always" | "otherTeams";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  // Nullable on purpose: a user provisioned entirely via SSO in the
  // future may never have a local password at all.
  passwordHash: text("password_hash"),
  // A platform-wide role, separate from team membership: team membership
  // governs one team's own Secrets/RBAC (see docs/multi-tenant-secrets-
  // design.md); isAdmin governs cross-team and platform-level actions --
  // adding a member to a team you're not in, registering a secret for a
  // team you're not in, and (once built) configuring SSO/SAML/OIDC, which
  // has no single owning team to scope it to. Deliberately a boolean, not
  // a roles table: the actual distinction needed today is exactly two-
  // valued (platform admin or not) -- a richer permissions model is real
  // future work if a real second distinction ever shows up, not something
  // to build ahead of that need.
  isAdmin: boolean("is_admin").notNull().default(false),
  // A machine identity (catalog CI, e.g.) rather than a human -- never
  // logs in via /auth/login (hence passwordHash staying null for these),
  // authenticates only via apiTokens below. Kept as an explicit flag
  // rather than inferred from "has no password" so listing "this team's
  // bots" is a direct query, not a guess.
  isBot: boolean("is_bot").notNull().default(false),
  // An ordering bot's templates (decision 23): the only ones it may run
  // (<team>/<name>), and it may run nothing else (no raw DAG, no single
  // action). Null: not an ordering bot.
  orderTemplates: text("order_templates").array(),
  // Set on every password change or admin reset. Any session JWT issued
  // before this instant is rejected (auth/plugin.ts), so changing a
  // password actually kicks out whoever else might be holding an old
  // session, instead of only affecting future logins. Null means never
  // changed since the account was created.
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  // Its password was set by someone else (an admin's new account or reset,
  // `vertra admin reset-password`): until its owner changes it, a session
  // it signs in may only change it (rpc/interceptors.ts).
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  // The identity provider's id for this person (OIDC's iss and sub), bound
  // at their first single sign-on (auth/oidc.ts). From then on only that
  // provider account signs in as them: a new account given the same email
  // can't take this one over.
  oidcSubject: text("oidc_subject").unique(),
  // Its last sign-in, with a password or single sign-on, for the admins'
  // list of people. Null means never.
  lastSignedInAt: timestamp("last_signed_in_at", { withTimezone: true }),
  // Which notifications reach them by email too, when the install sends
  // email (notifier.ts): failures, approvals and readiness by default, not
  // every finished run.
  emailKinds: text("email_kinds").array().$type<NotificationKind[]>().notNull().default(sql`'{run_failed,approval_waiting,product_not_ready,catalog_failing,step_refused,platform_alert}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Long-lived, revocable credentials for bot users (see users.isBot) --
 * catalog CI's way of authenticating to register/deregister products
 * without a human doing an interactive login. Authorization once
 * authenticated is identical to a human's: the token resolves to a user
 * id, and every existing check (team membership, isAdmin) runs the same
 * as it would for a JWT-authenticated request (see auth/plugin.ts).
 */
export const apiTokens = pgTable("api_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Only the hash is stored -- the raw token is shown exactly once, at
  // creation, and never persisted or logged again (same principle as
  // users.passwordHash). A fast hash (SHA-256, see auth/apiToken.ts) is
  // correct here, unlike argon2 for passwords: the cost argon2 adds
  // exists to slow down guessing a low-entropy human password, and a
  // 256-bit random token has no such guessing surface for that cost to
  // defend against.
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label").notNull(),
  // Platform-wide permissions for an *automation* token (auth/scopes.ts),
  // e.g. the catalog CI's one token: "teams:create", "products:register".
  // Empty for an ordinary team bot, whose access comes from team
  // membership like any human's. An automation token's bot belongs to no
  // team, so these scopes are the only things it can do.
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  // Who made it: a bot's run then isn't approved by whoever holds its
  // tokens (core/approvals.ts). Null for one whose maker isn't known.
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // When the token last authenticated a request, at most a few minutes
  // stale (auth/plugin.ts only writes it when it has moved on), so the Team
  // page can show which tokens are still in use before someone revokes one.
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  // After this it authenticates nothing. Null: until revoked (tokens made
  // before expiry existed, and those made to last).
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

/**
 * Sessions signed out before they expired (auth/plugin.ts refuses them, as
 * the gateway does): a session's id (its JWT's `sid`) until it would have
 * expired anyway, when retention.ts deletes it.
 */
export const revokedSessions = pgTable("revoked_sessions", {
  sid: text("sid").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * The fixed windows of rpc/rateLimit.ts, here so every copy of the console
 * counts the same attempts: a key (the limit's name and who) and its count
 * until the window resets.
 */
export const rateLimitWindows = pgTable("rate_limit_windows", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
});

/** An account's failed sign-ins (auth/loginThrottle.ts), shared by every copy. */
export const signInFailures = pgTable("sign_in_failures", {
  email: text("email").primaryKey(),
  failures: integer("failures").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  nextAt: timestamp("next_at", { withTimezone: true }),
});

/**
 * The product registry: what a DAG step can actually reference. One row
 * per (image, action) pair, matching what TaskDefinition itself needs --
 * a step always resolves to exactly one of these, not "a product"
 * abstractly. teamId null means a platform-provided product that no
 * single team vouches for; non-null means
 * a real team's product, and only a member of that team (or an admin) may
 * register, update, or delete it -- the same membership check /secrets
 * already applies to writing a secret, applied one layer earlier: which
 * image a team is willing to have run as their ServiceAccount, not just
 * who can read their secret once it's running.
 */
/** An example of running an action, from one of its passing contract tests. */
export interface ProductExample {
  name: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

/** An action's cleanup: which action of its product removes a resource it reported, with what inputs. */
export interface ProductCleanup {
  action: string;
  /** Null: {"resource": <the resource>}. Else exactly these, with {$input}, {$output} and {$resource} filled in. */
  inputs: Record<string, unknown> | null;
}

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    image: text("image").notNull(),
    action: text("action").notNull(),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    inputSchema: jsonb("input_schema").notNull().default({}),
    // The rest of the action's description from its product.yaml, as
    // catalog CI registers it: enough to list it, build its order form,
    // and wire it into a generated DAG (see the catalog's
    // docs/product-schema.md). Empty until CI registers the product with
    // them; nothing that runs a task reads them.
    displayName: text("display_name"),
    description: text("description"),
    outputSchema: jsonb("output_schema").notNull().default({}),
    // The ServiceAccount its tasks run as, in the owning team's namespace.
    serviceAccount: text("service_account"),
    // The team secrets it uses (product.yaml's actions[].secretRefs): its
    // bindings. (The column keeps its v1 name.)
    secretRefs: text("required_secrets").array().notNull().default(sql`'{}'::text[]`),
    // Audiences its tasks get a projected ServiceAccount token for, to sign
    // in to another cloud (product.yaml's tokenAudiences; tokenAudiences.ts).
    tokenAudiences: text("token_audiences").array().notNull().default(sql`'{}'::text[]`),
    // The other teams that may run it or include it in their templates, or
    // "*" for every team; empty, only its own team (product.yaml's
    // actions[].shareWith). Recorded; enforced once consumers run templates.
    shareWith: text("share_with").array().notNull().default(sql`'{}'::text[]`),
    // product.yaml's visibility: hidden: only its own team sees it (it then
    // has no shareWith). Otherwise every team sees it, and those it isn't
    // shared with can ask for access.
    hidden: boolean("hidden").notNull().default(false),
    // Its product.yaml in the catalog repository, for "Ask for access"
    // (teams/<team>/products/<product>/product.yaml); null when registered
    // otherwise.
    sourcePath: text("source_path"),
    // Running it again with the same inputs does no harm (product.yaml's
    // idempotent); only then may a step of it get more than one attempt.
    idempotent: boolean("idempotent").notNull().default(false),
    // How many times a step of it may run in all (product.yaml's
    // maxAttempts): the attempts its steps get, never more (R3).
    maxAttempts: integer("max_attempts").notNull().default(1),
    // The inputs naming what a step of it changes (product.yaml's
    // concurrencyKey): the kernel runs one step per set of values at a time.
    concurrencyKey: text("concurrency_key").array().notNull().default(sql`'{}'::text[]`),
    // product.yaml's maxRunning: at most this many of the product's steps
    // (all its actions) claimed or running at once; 0, no cap of its own.
    maxRunning: integer("max_running").notNull().default(0),
    // The clouds of the installs it's for (product.yaml's clouds, else its
    // team.yaml's), and which said so ("product", "team", or ""); empty,
    // every install (core/clouds.ts).
    clouds: text("clouds").array().notNull().default(sql`'{}'::text[]`),
    cloudsFrom: text("clouds_from").notNull().default(""),
    // product.yaml's capacity: spot or onDemand; null, the install's own.
    capacity: text("capacity"),
    // What removes the resources its steps report (product.yaml's cleanup):
    // another action of the product, and its inputs (null: {"resource":
    // ...}). Null: nothing does (core/resources.ts).
    cleanup: jsonb("cleanup").$type<ProductCleanup>(),
    // The action of the same product that says what a step of this one
    // would do (product.yaml's plan): Preview runs it. Null: none.
    plan: text("plan"),
    // The action of the same product that says whether it's ready on this
    // install (product.yaml's check, the product's): readiness.ts runs it.
    // Null: none.
    check: text("check"),
    // Examples of running it, from its passing contract tests: a name, the
    // inputs, and what it gave. Offered on its run form.
    examples: jsonb("examples").$type<ProductExample[]>().notNull().default([]),
    // When a step of it waits for a maintainer of its team to approve it
    // (product.yaml's approval): always, or only when another team runs it.
    // Null: never, unless an allowedTargets rule asks (core/approvals.ts).
    approval: text("approval").$type<Approval>(),
    // product.yaml's approval as a list of teams: a step waits for one when
    // its run is for one of them (not its own team's). Empty: by approval.
    approvalTeams: text("approval_teams").array().notNull().default([]),
    // product.yaml's errors: what each error code its actions report means
    // and what to do, shown when a step fails with one (failureHelp.ts).
    errorHelp: jsonb("error_help").$type<Record<string, ErrorHelp>>().notNull().default({}),
    // Why it's deprecated and what to use instead; null when it isn't.
    deprecated: text("deprecated"),
    // The Pod size its tasks get unless a task sets its own: { cpu, memory,
    // memoryLimit } as Kubernetes quantities (the kernel's TaskResources).
    // Null: the deployment's default.
    resources: jsonb("resources").$type<ProductResources>(),
    // Registered from a catalog release (catalogSync.ts): unregistered when
    // a release no longer has it. One an admin registered by hand isn't.
    fromCatalog: boolean("from_catalog").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.image, table.action)],
);

/**
 * Which team owns each image repository (an image without its tag or
 * digest, normalized: imageRef.ts's imageRepository): the first team to
 * register a product from it. Only that team's products may use it, so no
 * team can register another's code as its own product and run it with its
 * own identity. Kept when the product is deleted, so the repository can't
 * be taken over afterwards either; an admin releases it
 * (DELETE /image-repositories). A null team: the platform's (products with
 * no team).
 */
export const imageRepositories = pgTable("image_repositories", {
  repository: text("repository").primaryKey(),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One image's scan, by digest (scanning.ts): the platform scans every image
 * before it's registered or run, whoever built it, and again daily while
 * it's in use. A failed one blocks new registrations and runs (never steps
 * already running) until it's rescanned clean or an admin accepts it, with
 * a reason. The kernel chart's scan policy holds the failed digests, so the
 * cluster refuses them too.
 */
export const imageScans = pgTable("image_scans", {
  digest: text("digest").primaryKey(),
  // The reference it was scanned as (the first seen with this digest).
  image: text("image").notNull(),
  // pending | passed | failed | error
  status: text("status").notNull(),
  // { fixable, unfixable, secrets, findings: [...] } from the last scan.
  findings: jsonb("findings"),
  // The scan Job running now, if any.
  jobName: text("job_name"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  // When it was last asked for (registered or run): rescans stop for an
  // image nobody uses any more.
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  // An admin accepted a failed verdict: who, why, when. Cleared by a rescan
  // that finds something new.
  acceptedBy: uuid("accepted_by"),
  acceptedReason: text("accepted_reason"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
});

/**
 * Who changed what (audit.ts): one row per request that tried to change
 * something through /api, allowed or refused, with the caller, the route,
 * what it named (route parameters and identifying body fields, never a
 * secret value, password or token) and the answer's status. Admins read it
 * (GET /audit); it's also logged, for shipping to a SIEM.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id"),
    method: text("method").notNull(),
    route: text("route").notNull(),
    target: jsonb("target").notNull().default({}),
    status: integer("status").notNull(),
    requestId: text("request_id"),
    // sha256 of the previous entry's hash and this entry (audit.ts), so
    // changing or removing one breaks every later hash. Null on entries
    // from before the chain.
    hash: text("hash"),
  },
  (table) => [index("audit_log_at_idx").on(table.at), index("audit_log_actor_idx").on(table.actorId)],
);

/**
 * Shipping the audit log to write-once storage (auditExport.ts): one row,
 * the last entry exported and its hash, from which the next export's chain
 * is checked.
 */
export const auditExport = pgTable("audit_export", {
  id: integer("id").primaryKey().default(1),
  lastId: bigint("last_id", { mode: "number" }).notNull().default(0),
  lastHash: text("last_hash").notNull().default(""),
  exportedAt: timestamp("exported_at", { withTimezone: true }),
  // The last look, and why it didn't export (a broken chain, the bucket).
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  error: text("error"),
  // The entry where the chain broke at the last look; null while it holds.
  brokenAt: bigint("broken_at", { mode: "number" }),
  // The database compared with its copy (auditExport.ts, compareWithCopy),
  // a few objects a look, round and round: the last entry compared this
  // round, when, the first entry found different (null while they agree),
  // and why the last look didn't finish, if it didn't.
  comparedThrough: bigint("compared_through", { mode: "number" }).notNull().default(0),
  comparedAt: timestamp("compared_at", { withTimezone: true }),
  differsAt: bigint("differs_at", { mode: "number" }),
  compareProblem: text("compare_problem"),
});

/**
 * The catalog's wiring vocabulary (each team's teams/<team>/types.yaml,
 * decision 25): the names a product's input uses to say what it needs
 * (x-vertra-needs) and an output what it provides (x-vertra-provides). The
 * order builder (core/orders.ts) wires carts by them. A catalog release
 * that has any replaces the whole set (catalogSync.ts); an install whose
 * catalog has none sets them with ProductService.ReplaceWiringTypes.
 */
export const wiringTypes = pgTable("wiring_types", {
  name: text("name").primaryKey(),
  // The value's JSON type: string, integer, number or boolean.
  jsonType: text("json_type").notNull(),
  description: text("description").notNull(),
  // Asked once per order when no task in it provides the type.
  shared: boolean("shared").notNull().default(false),
  // <team>/<product>.<action> added to an order automatically when a
  // required input needs the type and nothing in the order provides it.
  defaultProvider: text("default_provider"),
  // The team whose types.yaml defines it, which says what it means; null
  // for one set by ReplaceWiringTypes.
  team: text("team"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every image a product has been registered with, one row per distinct
 * image reference. `products.image` stays the single current one (what CI
 * most recently registered); this is the history behind it, so the
 * Products page can list a product's releases rather than only its newest.
 *
 * Unique on (productId, image): CI re-registering the same image (a
 * re-run of the same commit) is not a new release, and keeps its original
 * registeredAt. Rows go with their product (unregistering or retiring a
 * team's products removes the history too).
 */
export const productReleases = pgTable(
  "product_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    image: text("image").notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.productId, table.image)],
);

/**
 * A team's registered secrets: what POST /secrets has provisioned into
 * Kubernetes (see core/secrets.ts and k8s.ts) -- never the secret
 * *values* themselves, only which team, which Secret name, and which keys
 * it holds. Any of the team's registered products may mount any of them,
 * when a task lists it in secretRefs; nothing else may mount them, and no
 * Secret that isn't registered here may be mounted at all (the identity
 * policy, from productPolicy.ts). Kubernetes
 * stays the actual source of truth for the Secret's contents; this exists
 * because there was otherwise no way to answer "what's already registered
 * for my team" without either a live cluster query on every page load or
 * (before this table existed) not being able to answer it at all. Same
 * "index what kernel/k8s won't tell a human directly" role
 * submittedExecutions plays for kernel-api.
 *
 * Unique on (teamId, secretName): a namespace+name pair is a Kubernetes
 * Secret's own real identity, so re-registering (rotating) the same
 * secret is an update to this row, not a second one -- matching
 * upsertSecretGrant's own idempotent create-or-replace semantics.
 *
 * `source` is display metadata only, not an authorization input: who may
 * mount a secret only ever depends on its name, never how its contents got
 * populated (docs/security-model.md).
 * "external" means an ExternalSecret object was created (k8s.ts's
 * upsertExternalSecretGrant) referencing a SecretStore that must already
 * exist in this namespace; "literal" means a value was pasted directly
 * (upsertSecretGrant).
 */
export const secretGrants = pgTable(
  "secret_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    secretName: text("secret_name").notNull(),
    keys: text("keys").array().notNull(),
    source: text("source").notNull().default("literal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.teamId, table.secretName)],
);

/**
 * kernel-api has no concept of users or teams at all (see docs/multi-
 * tenant-secrets-design.md -- it stays deliberately blind to both), so it
 * can't answer "who's allowed to see this execution." This is that answer,
 * recorded here at submission time (see core/executions.ts): every team
 * named by any task in the submission, so a later read/cancel/retry can
 * check the caller shares at least one of them (or is admin) before this
 * service forwards the request on to kernel-api at all.
 */
export const submittedExecutions = pgTable("submitted_executions", {
  // kernel-api's own execution id -- not generated here, just recorded
  // after kernel-api's response confirms it exists.
  executionId: uuid("execution_id").primaryKey(),
  teams: text("teams").array().notNull(),
  // Null once the submitter's account is deleted: the execution's record
  // (and so its history in the console) outlives the account.
  submittedBy: uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
  // Who may not approve its steps, worked out when it was submitted
  // (core/approvals.ts notDeciders): its submitter and, for a bot, whoever
  // made it something to act with. Null for a run from before, whose are
  // worked out when asked.
  notDeciders: uuid("not_deciders").array(),
  name: text("external_reference").notNull(),
  // The exact body forwarded to kernel-api's `POST /v1/executions` (see
  // core/executions.ts) -- kept so a later rerun can resubmit the same
  // task graph under a fresh requestId without the caller having to
  // hold onto or re-supply it themselves. Nullable because rows recorded
  // before this column existed have nothing to backfill it with; a rerun
  // of one of those is refused rather than guessed at.
  payload: jsonb("payload"),
  // Run from a template (core/templates.ts), not submitted as a DAG: which
  // one ("<team>/<template>", or "<team>/<product>.<action>" for an action
  // run as a one-step template), with what parameters, and on behalf of
  // which of the submitter's teams (null: the person alone). A rerun runs
  // the template again with these; the submitter may see, cancel and retry
  // it without being in the teams its steps ran in.
  template: text("template"),
  templateParameters: jsonb("template_parameters"),
  onBehalfOf: text("on_behalf_of"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // The schedule that started it, if one did (scheduler.ts).
  scheduleId: uuid("schedule_id"),
  // When the resources its steps reported were copied into resources
  // (resourceRecorder.ts), once it finished; null until then.
  resourcesRecordedAt: timestamp("resources_recorded_at", { withTimezone: true }),
}, (table) => [
  // The execution list's order and cursor (listSubmittedExecutionsPage).
  // Ascending, scanned backwards: the same order as ORDER BY ... DESC.
  index("submitted_executions_created_at_idx").on(table.createdAt, table.executionId),
  // Which executions a team is part of (teams && ..., teams @> ...).
  index("submitted_executions_teams_idx").using("gin", table.teams),
  // An ordering bot's runs in the last minute (core/orderRate.ts).
  index("submitted_executions_submitted_by_idx").on(table.submittedBy, table.createdAt),
  // The runs not yet recorded, in the resource recorder's order and cursor
  // (resourceRecorder.ts): only those, however many are recorded.
  index("submitted_executions_unrecorded_idx")
    .on(table.createdAt, table.executionId)
    .where(sql`${table.resourcesRecordedAt} IS NULL`),
]);

/**
 * What runs made or changed: each resource a step reported in its outputs
 * (`resources: [{type, id, name, link}]`), copied when its run finished
 * with that step's resolved inputs and outputs, so it can be deleted long
 * after the run is gone (decision 21, docs/assessment.md). References only:
 * whether it still exists is its product's cloud's to know. A later step
 * reporting the same one (its product's team, type and id) updates it.
 */
export const resources = pgTable(
  "resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The registered product (<team>-<product>-<action>) whose step reported
    // it, and that product's team: its cleanup is that product's current one.
    product: text("product").notNull(),
    productTeam: text("product_team").notNull(),
    type: text("type").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name"),
    link: text("link"),
    // Whose it is: the team the run was for (a template's or action's run:
    // its onBehalfOf, null for its person alone; a DAG: the step's team),
    // and who ran it. Either may see and delete it.
    ownerTeam: text("owner_team"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    // The step that last reported it, and what that step was given and gave.
    executionId: uuid("execution_id").notNull(),
    taskId: text("task_id").notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull().default({}),
    outputs: jsonb("outputs").$type<Record<string, unknown>>().notNull().default({}),
    // Its step's place in its run, for deleting a run's in reverse.
    position: integer("position").notNull().default(0),
    firstReportedAt: timestamp("first_reported_at", { withTimezone: true }).notNull().defaultNow(),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    // A delete in progress: the run of its cleanup action, and who asked.
    deletingExecutionId: uuid("deleting_execution_id"),
    deletingTaskId: text("deleting_task_id"),
    deleteRequestedBy: uuid("delete_requested_by").references(() => users.id, { onDelete: "set null" }),
    // Once its cleanup step succeeded.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // What its step provided, by wiring type (decision 25): each output its
    // product types with x-vertra-provides, and its value. How a later run
    // that's given the value is linked to it (resourceLinks), and how a
    // cart offers it.
    provides: jsonb("provides").$type<Provided[]>().notNull().default([]),
  },
  (table) => [
    unique("resources_product_team_type_external_id").on(table.productTeam, table.type, table.externalId),
    index("resources_execution_id_idx").on(table.executionId),
    index("resources_deleting_execution_id_idx").on(table.deletingExecutionId),
    index("resources_owner_team_idx").on(table.ownerTeam),
    index("resources_provides_idx").using("gin", table.provides),
  ],
);

/** One output a resource's step provided: its wiring type, value and name. */
export interface Provided {
  type: string;
  value: string;
  output: string;
}

/**
 * What each resource depends on (decision 25), recorded when its run
 * finishes (resourceRecorder.ts): a resource its step took an input from,
 * in the same run (the input wired from that step) or an earlier one (the
 * input's value is what a resource there provides, of the input's wiring
 * type). Replaced each time the resource is reported again. Deleting
 * something others depend on waits for an admin (resourceDeleteRequests).
 */
export const resourceLinks = pgTable(
  "resource_links",
  {
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    dependsOnId: uuid("depends_on_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    // The input of the resource's step it came in through, and that input's
    // wiring type (null: an untyped input wired from a step).
    input: text("input").notNull(),
    wiringType: text("wiring_type"),
  },
  (table) => [
    primaryKey({ columns: [table.resourceId, table.dependsOnId, table.input] }),
    index("resource_links_depends_on_id_idx").on(table.dependsOnId),
    check("resource_links_not_itself", sql`${table.resourceId} <> ${table.dependsOnId}`),
  ],
);

/**
 * A delete refused because other resources depend on what it would delete
 * (decision 25): the admins are alerted, and it runs only once one approves
 * it (core/resources.ts). Who asked, what for, and what depended on it
 * then; kept with its decision.
 */
export const resourceDeleteRequests = pgTable(
  "resource_delete_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceIds: uuid("resource_ids").array().notNull(),
    ownerTeam: text("owner_team"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    // The live resources depending on them when it was asked: their ids.
    dependentIds: uuid("dependent_ids").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // approved or denied; deleted when all it would delete was deleted
    // another way first (with what depended on it); null while it waits.
    decision: text("decision").$type<"approved" | "denied" | "deleted">(),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // The cleanup run an approval started.
    executionId: uuid("execution_id"),
  },
  (table) => [
    index("resource_delete_requests_waiting_idx").on(table.createdAt).where(sql`${table.decision} IS NULL`),
    check("resource_delete_requests_decision", sql`${table.decision} IS NULL OR ${table.decision} IN ('approved', 'denied', 'deleted')`),
  ],
);

/**
 * Something worth telling people (notifier.ts): a run that failed or
 * finished, a step waiting for an approval, the catalog not being pulled.
 * Made once (its key), then shown to each of its people (user_notifications)
 * and posted to the chat webhooks of its teams (webhook_deliveries).
 */
export const notificationEvents = pgTable(
  "notification_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // What makes it the same event: "run:<id>:<finished at>", say.
    key: text("key").notNull().unique(),
    kind: text("kind").$type<NotificationKind>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    // The console page it's about: "/runs/<id>".
    link: text("link"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("notification_events_created_at_idx").on(table.createdAt)],
);

export type NotificationKind =
  | "run_failed"
  | "run_succeeded"
  | "approval_waiting"
  | "catalog_failing"
  | "product_not_ready"
  | "step_refused"
  | "platform_alert";

/** A person's copy of an event, until they've read it. */
export const userNotifications = pgTable(
  "user_notifications",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => notificationEvents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.userId] }), index("user_notifications_user_id_idx").on(table.userId)],
);

/**
 * A team's chat webhook (Slack, Google Chat, Teams): where its events are
 * posted, and which. The URL is a credential, so it's kept encrypted
 * (notifier.ts) and never sent back; only its host is shown.
 */
export const teamWebhooks = pgTable("team_webhooks", {
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => teams.id, { onDelete: "cascade" }),
  urlEncrypted: text("url_encrypted").notNull(),
  host: text("host").notNull(),
  kinds: text("kinds").array().$type<NotificationKind[]>().notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // The last post: when it worked, and why the last one didn't.
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  lastError: text("last_error"),
});

/** An event to email to a person, until it's sent or given up on. */
export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => notificationEvents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.userId] })],
);

/** An event to post to a team's webhook, until it's posted or given up on. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => notificationEvents.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.teamId] })],
);

/**
 * An ordering bot's callback (decision 23, callbacks.ts): where its
 * orders' outcomes are posted, signed with its secret, set by its team's
 * maintainers. Only to the hosts the install allows (orders.callbackHosts).
 */
export const botCallbacks = pgTable("bot_callbacks", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // Sealed as team_webhooks' URL is; the secret signs each post (HMAC-SHA256).
  urlEncrypted: text("url_encrypted").notNull(),
  host: text("host").notNull(),
  secretEncrypted: text("secret_encrypted").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  lastError: text("last_error"),
});

/**
 * A team's outcome webhook (decision 23, callbacks.ts): where each of its
 * runs' outcomes is posted, as JSON for systems (beside its chat webhook),
 * signed with its secret, set by its maintainers, under the same hosts.
 */
export const teamCallbacks = pgTable("team_callbacks", {
  teamId: uuid("team_id")
    .primaryKey()
    .references(() => teams.id, { onDelete: "cascade" }),
  urlEncrypted: text("url_encrypted").notNull(),
  host: text("host").notNull(),
  secretEncrypted: text("secret_encrypted").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  lastError: text("last_error"),
});

/** An outcome to post to an ordering bot's callback or a team's, until it's sent or given up on. */
export const callbackDeliveries = pgTable("callback_deliveries", {
  // <execution id>:<state>:<finished at> for a bot's, with :team:<id> for a
  // team's: a run retried and finished again is posted again.
  key: text("key").primaryKey(),
  // Whose callback: one of these.
  botId: uuid("bot_id").references(() => users.id, { onDelete: "cascade" }),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
  // The JSON posted, made once so every attempt posts (and signs) the same.
  body: text("body").notNull(),
  attempts: integer("attempts").notNull().default(0),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [check("callback_deliveries_one_destination", sql`(${table.botId} is null) <> (${table.teamId} is null)`)]);

/**
 * Whether a product is ready on this install (readiness.ts): its check
 * action's last answer, run as the product with its secrets. One row per
 * check action (<team>-<product>-<check>), for its whole product.
 */
export const productReadiness = pgTable("product_readiness", {
  // The check action's registered name.
  product: text("product").primaryKey(),
  productTeam: text("product_team").notNull(),
  // The image checked, so a new one is checked again.
  image: text("image").notNull(),
  // checking (a run is under way), ready, not_ready, or failed (the check
  // couldn't say: its run failed).
  state: text("state").$type<ReadinessState>().notNull(),
  executionId: uuid("execution_id"),
  // What it acts as there (an identity, an account), and what it lacks.
  principal: text("principal"),
  missing: text("missing").array().notNull().default(sql`'{}'::text[]`),
  detail: text("detail"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
});

export type ReadinessState = "checking" | "ready" | "not_ready" | "failed";

/**
 * A team's schedule: a template or action run on a cron, with set
 * parameters, for the team, as one of its bots (scheduler.ts). The bot's
 * rights are checked on every run, as they'd be if it ran it itself.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // What it runs: a template (<team>/<name>) or an action (its registered
    // product name), with these parameters.
    kind: text("kind").$type<"template" | "action">().notNull(),
    runnableTeam: text("runnable_team").notNull(),
    runnableName: text("runnable_name").notNull(),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull().default({}),
    // Five-field cron, read in an IANA time zone (cron.ts).
    cron: text("cron").notNull(),
    timeZone: text("time_zone").notNull().default("UTC"),
    // The team's bot it runs as; deleting the bot deletes the schedule.
    botId: uuid("bot_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    // When it runs next; null while paused or never again.
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastExecutionId: uuid("last_execution_id"),
    // Why its last start was refused, if it was.
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    // Who last changed it: it runs as its bot, so they too don't approve its runs.
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("schedules_team_id_name").on(table.teamId, table.name), index("schedules_next_run_at_idx").on(table.nextRunAt)],
);

/**
 * Who a bot is when it signs in without a stored token (auth/keyless.ts):
 * an OIDC issuer (a CI's, such as GitHub Actions') and the exact claims its
 * ID token must carry (repository, and perhaps ref or environment). A token
 * from that issuer with those claims signs in as the bot.
 */
export const botIdentities = pgTable(
  "bot_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    // Each claim the token must carry, with exactly this value.
    claims: jsonb("claims").$type<Record<string, string>>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  // The same issuer and claims can't name two bots: a token would be ambiguous.
  (table) => [unique("bot_identities_issuer_claims").on(table.issuer, table.claims)],
);

export const teamMemberships = pgTable(
  "team_memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // A maintainer manages the team (members, secrets, bots, raw DAGs); a
    // member sees all of its work and runs its actions (auth/access.ts).
    // Memberships from before roles were maintainers, and stay so.
    role: text("role").$type<TeamRole>().notNull().default("maintainer"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // The single sign-on groups that give this membership its role (sso.ts,
    // at each sign-in or group resync); null when it was added by hand.
    viaGroups: text("via_groups").array(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.teamId] }),
    check("team_memberships_role", sql`${table.role} in ('maintainer', 'member')`),
  ],
);

export type TeamRole = "maintainer" | "member";

/** What an error code means, and what to do about it (product.yaml's errors). */
export interface ErrorHelp {
  means: string;
  do?: string;
}

/**
 * Templates (catalog format v2's dags/*.yaml of kind Template): what a
 * consumer runs, filling in only the parameters, from a catalog release
 * (catalogSync.ts), which also removes them. Each step names an action as
 * "<team>/<product>.<action>"; running one (core/templates.ts) runs each
 * step's product as its ServiceAccount, with its action's own secrets, in
 * its team's namespace. A template is its team's: retired or purged with
 * it.
 */
export const templates = pgTable(
  "templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    // A JSON Schema for an object: the parameters, and the run form.
    parameters: jsonb("parameters").notNull().default({}),
    // [{ id, action, dependsOn?, inputs?, timeoutSeconds?, maxAttempts? }]
    steps: jsonb("steps").$type<TemplateStep[]>().notNull(),
    // The other teams that may run it, or "*" for every team; empty, only
    // its own.
    shareWith: text("share_with").array().notNull().default(sql`'{}'::text[]`),
    // As for products: only its own team sees a hidden one.
    hidden: boolean("hidden").notNull().default(false),
    // Its file in the catalog repository (teams/<team>/dags/<name>.yaml).
    sourcePath: text("source_path"),
    deprecated: text("deprecated"),
    // Ways to run it, from its file: a name and its parameters (as inputs).
    examples: jsonb("examples").$type<ProductExample[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.teamId, table.name)],
);

/**
 * Compose's drafts (core/drafts.ts): a template being built, for a team,
 * which its members and admins see and change from any device. The body is
 * the page's own state, kept as it is; version counts its saves, so an edit
 * made on an older one is refused rather than overwriting.
 */
export const composeDrafts = pgTable(
  "compose_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("compose_drafts_team_id_name").on(table.teamId, table.name)],
);

/**
 * API products (decision 20): a backend a team runs, published through the
 * gateway, which forwards only what `openapi` describes. From the catalog's
 * release (teams/<team>/apis/<name>/api.yaml); the gateway reads this table.
 */
export const apis = pgTable(
  "apis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // Its folder's name: callers reach it at /<team>/<name>/ on the gateway.
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    // The OpenAPI document (3.0 or 3.1), references inside it only: the
    // allowlist the gateway enforces.
    openapi: jsonb("openapi").notNull(),
    backendUrl: text("backend_url").notNull(),
    // How the gateway signs in to the backend, minted per request from the
    // API's ServiceAccount; null: it doesn't. {serviceAccountToken:
    // {audience}} | {googleIdToken: {serviceAccount, audience}} |
    // {awsSigV4: {roleArn, region, service}}
    backendAuth: jsonb("backend_auth").$type<BackendAuth>(),
    // The Kubernetes ServiceAccount, in the team's namespace, its backend
    // credentials are minted for (the console creates it).
    serviceAccount: text("service_account").notNull(),
    shareWith: text("share_with").array().notNull().default(sql`'{}'::text[]`),
    hidden: boolean("hidden").notNull().default(false),
    deprecated: text("deprecated"),
    // reachable: internet, where the gateway's settings allow its team.
    internet: boolean("internet").notNull().default(false),
    // Requests a minute per calling team: "default" and teams by name.
    perMinute: jsonb("per_minute").$type<Record<string, number>>().notNull().default({}),
    timeoutSeconds: integer("timeout_seconds").notNull().default(30),
    maxRequestBytes: integer("max_request_bytes").notNull().default(1_048_576),
    // Its api.yaml in the catalog repository.
    sourcePath: text("source_path"),
    // Set by a maintainer of its team to stop it for an incident: every
    // request gets 503 with this message, and nothing is forwarded.
    pausedMessage: text("paused_message"),
    pausedBy: uuid("paused_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.teamId, table.name)],
);

/**
 * What the gateway did with each API's requests, a minute at a time: by
 * calling team, endpoint (its spec's path for a request that matched one;
 * "METHOD /path" as sent, without its query, for one that matched none)
 * and outcome. The gateway adds to it every 30 seconds; nothing else
 * writes it. No caller's identity, body or header is kept. Kept a week.
 */
export const apiTraffic = pgTable(
  "api_traffic",
  {
    apiId: uuid("api_id")
      .notNull()
      .references(() => apis.id, { onDelete: "cascade" }),
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    // The team that called ("" before one was known: not signed in).
    team: text("team").notNull(),
    endpoint: text("endpoint").notNull(),
    // forwarded_2xx..5xx, blocked, invalid, limited, unauthenticated,
    // forbidden, paused, held, unavailable, backend_error.
    outcome: text("outcome").notNull(),
    count: integer("count").notNull(),
    // Their total time, for averages.
    durationMs: bigint("duration_ms", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.apiId, table.minute, table.team, table.endpoint, table.outcome] }), index("api_traffic_minute_idx").on(table.minute)],
);

/**
 * Why the gateway can't serve an API (its OpenAPI document can't be read
 * or used, or its backend URL can't be parsed), written by the gateway when
 * it builds the API and removed once it builds; no row, it serves. Every
 * call to it meanwhile gets 503.
 */
export const apiProblems = pgTable("api_problems", {
  apiId: uuid("api_id")
    .primaryKey()
    .references(() => apis.id, { onDelete: "cascade" }),
  problem: text("problem").notNull(),
  foundAt: timestamp("found_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The gateway as a whole: one row. Closed, every API answers 503. */
export const gatewayState = pgTable("gateway_state", {
  id: integer("id").primaryKey().default(1),
  closedMessage: text("closed_message"),
  closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export type BackendAuth =
  | { serviceAccountToken: { audience: string } }
  | { googleIdToken: { serviceAccount: string; audience: string } }
  | { awsSigV4: { roleArn: string; region: string; service: string } };

/** One step of a template, as the catalog release carries it. */
export interface TemplateStep {
  id: string;
  /** <team>/<product>.<action> */
  action: string;
  dependsOn?: string[];
  inputs?: Record<string, unknown>;
  timeoutSeconds?: number;
  maxAttempts?: number;
}

/**
 * The catalog release this console last applied, and how its last look went
 * (catalogSync.ts): one row, id 1. The release is read from the registry
 * (config.catalog.release), verified, and applied; the same digest isn't
 * applied twice.
 */
// The cloud identities each team's SecretStores sign in as (secretStores.ts
// cloudIdentities): each is one team's alone, so another team's store can't
// sign in as it and read that team's secrets. A team keeps its own while
// retired or purged (its namespace, and the cloud's binding, may remain).
export const secretStoreIdentities = pgTable("secret_store_identities", {
  identity: text("identity").primaryKey(),
  teamId: uuid("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Install-wide notification settings, one row: the team whose chat webhook
// also gets admins' alerts (platform_alert, catalog_failing, and every
// team's step_refused), when its webhook asks for those kinds.
export const notificationSettings = pgTable("notification_settings", {
  id: integer("id").primaryKey().default(1),
  adminTeamId: uuid("admin_team_id").references(() => teams.id, { onDelete: "set null" }),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const catalogSync = pgTable("catalog_sync", {
  id: integer("id").primaryKey().default(1),
  // The release artifact's manifest digest, its commit and repository.
  digest: text("digest"),
  // The version it is (vX.Y.Z), when the release read was one.
  version: text("version"),
  commit: text("commit"),
  repository: text("repository"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  // What applying it couldn't do, item by item: [{ item, message }].
  problems: jsonb("problems").$type<{ item: string; message: string; adoptableTeam?: string }[]>().notNull().default([]),
  // What it held (catalogSync.ts's counts); null before one was applied.
  applied: jsonb("applied").$type<{ teams: number; products: number; actions: number; templates: number; apis: number; secretStores: number }>(),
  // The last look: when, and why it failed, if it did (fetching or
  // verifying; nothing was applied then).
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  error: text("error"),
});

/**
 * Single sign-on as admins set it up (sso.ts, core/sso.ts): one row. The
 * provider here is used only when the install set none (OIDC_ISSUER); the
 * groups settings always. The client secret is kept encrypted (sealed.ts),
 * so a copy of the database alone doesn't give it away.
 */
export const ssoSettings = pgTable(
  "sso_settings",
  {
    id: integer("id").primaryKey().default(1),
    enabled: boolean("enabled").notNull().default(false),
    issuer: text("issuer").notNull().default(""),
    clientId: text("client_id").notNull().default(""),
    clientSecretEncrypted: text("client_secret_encrypted"),
    redirectUrl: text("redirect_url").notNull().default(""),
    allowedDomains: text("allowed_domains").array().notNull().default(sql`'{}'::text[]`),
    label: text("label").notNull().default(""),
    // The ID token claim listing a person's groups; "": none.
    groupsClaim: text("groups_claim").notNull().default(""),
    // Groups from Google Workspace too (Cloud Identity's Groups API).
    googleGroups: boolean("google_groups").notNull().default(false),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("sso_settings_one_row", sql`${table.id} = 1`)],
);

/**
 * The chat agent's model as an admin set it on the Admin page (chat/
 * settings.ts), in place of the install's (the chart's chat values). No row:
 * the install's. One row at most. The key is sealed, never sent back.
 */
export const chatSettings = pgTable(
  "chat_settings",
  {
    id: integer("id").primaryKey().default(1),
    // Off: no chat agent, whatever the install says.
    enabled: boolean("enabled").notNull().default(true),
    provider: text("provider").notNull(),
    model: text("model").notNull().default(""),
    endpoint: text("endpoint").notNull().default(""),
    vertexProject: text("vertex_project").notNull().default(""),
    vertexLocation: text("vertex_location").notNull().default(""),
    bedrockRegion: text("bedrock_region").notNull().default(""),
    apiKeyEncrypted: text("api_key_encrypted"),
    effort: text("effort").notNull().default(""),
    // Null: the default.
    maxSteps: integer("max_steps"),
    contextTokens: integer("context_tokens"),
    maxTokens: integer("max_tokens"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("chat_settings_one_row", sql`${table.id} = 1`)],
);

/** A provider group that makes its members a team's, at each single sign-on (sso.ts). */
export const ssoGroupMappings = pgTable(
  "sso_group_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // As the provider names it: a groups claim value, or a Google group's email.
    groupName: text("group_name").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: text("role").$type<TeamRole>().notNull().default("member"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("sso_group_mappings_group_team").on(table.groupName, table.teamId)],
);

/**
 * Ratings of the chat agent's answers (decision 24, Correctness): thumbs up
 * or down, each with what was asked and answered, its sources, its steps
 * and its model, sent by the person who rated it (the panel says so).
 * Admins read them (Admin, Chat); a bad one becomes a question-set case or
 * a doc fix. Kept 90 days (retention.ts).
 */
export const chatFeedback = pgTable(
  "chat_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    team: text("team"),
    rating: text("rating").$type<"up" | "down">().notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    // [{id, title, heading, kind, link}] as the answer cited them.
    citations: jsonb("citations").$type<{ id: string; title: string; heading: string; kind: string; link: string }[]>().notNull().default([]),
    // The tools it used, in order.
    steps: jsonb("steps").$type<string[]>().notNull().default([]),
    model: text("model").notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("chat_feedback_created_at_idx").on(table.createdAt),
    check("chat_feedback_rating", sql`${table.rating} IN ('up', 'down')`),
  ],
);
