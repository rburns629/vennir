# Codebase guide

Vertra runs pre-resolved DAGs of containerized "product" steps as
Kubernetes Jobs, passing each step's outputs to the steps that depend on
them, with each team's credentials kept to its own namespace and its own
reviewed products. A step can be anything packaged as a container, from a
hello-world script to creating cloud infrastructure. Long-form docs
already exist — check them before re-deriving anything:

- `docs/architecture.md`: what Vertra is, the pieces, the request flow,
  the data, and the design decisions. Start here.
- `docs/operations.md`: installing (kind and Helm), upgrading, databases,
  backups, network policies, troubleshooting.
- `docs/security-model.md`: what's enforced and by which layer, secrets and
  vault sync, what isn't enforced yet.
- `docs/assessment.md`: the 2026-10-19 architecture assessment and the
  agreed direction (consumers and templates, identity in two layers, one
  catalog pulled by many installs), with its roadmap in `TODO.md`.
- `docs/repository-map.md`: every folder and file, one line each. Update it
  when adding, moving or removing files.
- `docs/architecture/`: draw.io diagrams (system, UML classes for both
  services, a submit-to-finished sequence, state machines, and the pieces at
  a glance that `architecture.md` shows), all written by `generate.py`.
  Rerun it after changing code, then `make console-docs`; don't hand-edit
  the .drawio.
  The database tables are in `console/docs/06-database-schemas.md`, which
  tests in both projects keep in step with the models.
- `kernel/ARCHITECTURE.md`: the kernel's layer rules and a literal
  call-by-call trace of submit → claim → dispatch → poll → finalize.
- `console/docs/`: the user guides the console serves (getting started,
  secrets, DAGs, the API, the database tables).
- `TODO.md`: the actionable follow-up list (security, access, operations,
  housekeeping). Check it before proposing work; update it when an item is
  done or a new one is found.
- `cli/DESIGN.md`: the design for `vertra`, the installer CLI (Go,
  OpenTofu for the cloud side); read it before working on `cli/`.
- `catalog-template/`: what a new catalog repository starts as. Its docs
  (including `docs/onboarding-with-ai.md`) are for catalog teams, **not**
  instructions for this repo.
- `helm/values/{kind,gke,eks}/*.yaml`: each environment's Helm settings, the whole
  of them (`make kind-deploy` and `make gke-deploy` use `--reset-values`). A
  setting that isn't in these files isn't deployed.

## Layout

Three independent projects share one repo so they can be deployed together.
They share no environment or code. Build and test each one from inside
its own directory.

- **`kernel/`** (Go 1.26+, pgx, client-go, Connect): one binary,
  `kernel`, run as processes that never talk to each other directly and
  coordinate only through Postgres rows (`cmd/kernel`; the subcommand
  picks the process):
  - `kernel api` (kernel-api, `internal/api`): KernelService
    (`proto/vertra/kernel/v1`) over Connect, which accepts, reads,
    cancels and retries executions. It accepts only the console, by its
    ServiceAccount token (`internal/api/auth.go`, TokenReview), and must
    only be reachable in-cluster. It has no users or teams.
  - `kernel scheduler` (kernel-scheduler, `internal/scheduler`): polls
    forever, claims READY tasks with `FOR UPDATE SKIP LOCKED` + leases,
    dispatches via the Kubernetes executor, polls status (informers wake
    it), releases dependents. A failed pass is logged and retried from
    durable state on the next one.
  - `kernel migrate` (`internal/migrate`) owns the schema: `sql/NNNN_*.sql`,
    applied in order by the chart's hook Job; a released file never
    changes. kernel-api and the scheduler wait until the database is at
    the newest. `kernel sleep` (`internal/sleeper`) scales an idle
    platform to zero. With a managed database (Cloud SQL), every process
    signs in with its own Workload Identity token, no password
    (`internal/dbauth`), after `kernel database-setup` (`internal/dbsetup`)
    opened its database to it alone.
  - Layering points one way: `domain → executor → scheduler`, `domain →
    api`, all `→ cmd`; `domain` has no I/O, `scheduler` knows only the
    `Executor` interface, and `api` and `scheduler` never import each
    other.
  - The kernel was Python until 2026-10-20 (decision 17,
    `docs/assessment.md`); `kernel migrate` takes over an install Alembic
    migrated.
- **`console/`** (execution-console: TypeScript, Fastify 5, Drizzle/pg,
  `@kubernetes/client-node`). It is the authenticated front door to
  kernel-api: teams/users/bots, per-team secret registration, execution
  viewing/submission. All API routes live under `/api` (`src/index.ts`).
  The same process serves the React SPA from `frontend/dist`, giving one
  origin with no CORS.
  - `console/frontend/`: React 19, MUI, Vite, react-router. It has its own
    `package.json`.
  - The API is Connect services defined in `proto/` (`make proto`
    regenerates the console's, frontend's and CLI's code and the API
    reference), served at `/api/vertra.console.v1.<Service>/<Method>` by
    `src/rpc/`. `src/rpc/services/*.ts` only map messages; what a method
    does lives in `src/core/`, which throws `ApiError` (`src/apiError.ts`)
    to refuse. A new method: its rpc in `proto/`, `make proto`, its logic in
    `src/core/`, its mapping in `src/rpc/services/`, and a test.
  - `src/k8s.ts`: every Secret, ServiceAccount and ExternalSecret write.
    These writes are security-sensitive and idempotent (read, then
    create-or-replace; a product's ServiceAccount is create-only). The
    console's only RBAC write is one RoleBinding per team namespace,
    `vertra-scheduler-logs`, letting the kernel's scheduler read its steps'
    logs there (`src/schedulerLogs.ts`; its write fence allows nothing
    else); otherwise it only deletes the per-secret Roles older versions
    made.
- **`gateway/`** (Go 1.26+, pgx, libopenapi-validator): the API gateway
  (decision 20, `docs/assessment.md`), forwarding to each API product's
  backend exactly what its OpenAPI document describes. It reads the
  console's database as a role of its own (`vertra_gateway`, granted by
  `console/src/db/gatewayAccess.ts`: a column it starts to read is granted
  there) (published APIs; who callers are, checked exactly as
  `console/src/auth/plugin.ts` does, and kept in step with it), writing
  only its own traffic counts (`api_traffic`), why an API can't be
  served (`api_problems`) and API tokens' `last_used_at`. It checks sessions with the
  console's public key (`/api/auth/jwks`), never `JWT_SECRET`. The console chart deploys it (`gateway.enabled`); it may mint
  ServiceAccount tokens only for `*-api` ServiceAccounts in team namespaces
  (an admission policy). Its tests read the console's migrated test
  database (`TEST_DATABASE_URL`).
- **`helm/`**: everything Helm. `helm/charts/` holds the two charts,
  `execution-kernel` (api + scheduler + Postgres) and `execution-console`
  (+ its own Postgres), with neutral defaults; `helm/values/{kind,gke,eks}/` holds
  each cluster's settings for them and for the third-party charts (ESO,
  policy-controller; on kind, cert-manager and Traefik for `make kind-tls`). The Helm release names are
  `kernel` and `console`, installed into the platform's own namespace
  `vertra-system`, never a team namespace.
- **Task namespaces are allowlisted by an admission policy**
  (`helm/charts/execution-kernel/templates/dispatch-policy.yaml`). The scheduler
  can only create Jobs in namespaces labelled `vertra/team=true`, and
  never in its own. A rejection surfaces as a non-retryable
  `DISPATCH_REJECTED` task failure. New team namespaces need the label.
- **Task images are allowlisted too** (`helm/charts/execution-kernel/templates/image-policy.yaml`).
  A task may only run an image under an allowed source: the source registry
  set at install (`imagePolicy.sourceRegistry`) plus whatever admins add on
  the Admin page. Both live as CEL literals inside the admission policy
  itself, which the console edits (`console/src/imagePolicy.ts`, same matching
  rules as the CEL). Not a ConfigMap parameter: on Kubernetes 1.36, once a
  policy with a `paramRef` was deleted and recreated, later ConfigMap edits
  stopped taking effect. A refusal is a non-retryable `IMAGE_NOT_ALLOWED`. On kind, task
  images live in the local registry `localhost:5001` (`make kind-registry`),
  not `kind load`.
- **Step identity is enforced in the cluster too**
  (`helm/charts/execution-kernel/templates/identity-policy.yaml`). A step runs
  as `default` with no Secrets unless it's a registered product, which runs
  as the ServiceAccount its `product.yaml` declares (or `default`) and may
  mount any Secret its team registered: the same rule as the console's
  `identityRefusal`. Secrets are per team, chosen per step (`secretRefs`);
  a product.yaml's `actions[].secretRefs` (catalog format v2) are recorded
  as its bindings, not yet enforced (that comes with consumers). The products and
  each team's secret names live as CEL literals in the policy, which the
  console rewrites whenever products or secrets change and at startup
  (`console/src/productPolicy.ts`). A refusal
  is a non-retryable `IDENTITY_NOT_ALLOWED`. Because the console edits this
  policy and the image policy, Helm 4's server-side apply sees it as their
  owner: upgrade the kernel chart with `--force-conflicts` (the Makefile
  does), or it fails with a conflict.
- **Every image is pinned and scanned.** The console pins each task's image
  to its digest at submission (`repo:latest@sha256:…`, `console/src/
  registry.ts`; DAGs may say `:latest`), and scans every digest before it's
  registered or run (`console/src/scanning.ts`: a Trivy client Job against
  the console chart's Trivy server; a fixable HIGH/CRITICAL or a secret
  fails it). The kernel chart's `scan-policy.yaml` refuses unpinned images
  and failed digests (`IMAGE_NOT_PINNED`, `IMAGE_SCAN_FAILED`), from a list
  the console keeps current.
- **Catalog images can be required to be signed** (`imageSignature` in the
  kernel chart, `templates/image-signature.yaml`; on in the GKE values).
  Catalog CI signs them after they pass its security scans, with a generated
  key, a cloud KMS key, or keyless (its own OIDC identity); the chart accepts
  public keys and/or a keyless identity, and Sigstore's policy-controller
  (any cluster; `helm/values/gke/policy-controller.yaml`) refuses unsigned
  ones with `IMAGE_NOT_SIGNED`. The controller refuses any image it can't
  resolve to a digest in every namespace it covers, so it must exclude the
  platform's own namespace, and it isn't installed on kind (it can't reach
  `localhost:5001`).
- **Team lifecycle, namespaces included, is the console's**: creating a
  team creates its namespace (`vertra/team=true`); a team can be
  *retired* (reversible: read-only in the console, namespace relabelled
  `vertra/team=retired`) and then *purged* (soft-deleted so its name stays
  reserved; `TeamService/PurgeTeam`). The namespace stays, labelled
  retired, for a cluster administrator to delete: the console may delete it
  only with `teamNamespaces.purge`, off on purpose so the identity that
  retires a namespace can't also delete it. The console also
  applies a team's reviewed SecretStore file
  (`TeamService/ApplySecretStore`, checked by `console/src/secretStores.ts`). The
  console chart's `namespace-policy.yaml` limits what it may do to
  namespaces; the kernel chart's `purge-policy.yaml` lets a configured
  purger delete only retired ones. Writes call
  `ensureNotRetired` (`console/src/core/retired.ts`). Team lookups skip
  purged teams unless they use `findTeamByNameIncludingDeleted`.
- **The console pulls the catalog** (`console/src/catalogSync.ts`): catalog
  CI publishes images, then `./vertra catalog release` pushes the whole catalog
  as a signed OCI artifact, `<registry>/catalog-release`
  (`proto/vertra/catalog/v1/release.proto`). Each console polls it
  (`catalog.release` in the console chart), verifies it with a cosign Job
  when `catalog.signature` trusts a signer, and applies it with the old
  catalog token's rights: teams ensured, products registered, SecretStores
  applied, what a release drops unregistered or retired, never purged. A
  team the catalog didn't make (`teams.from_catalog`) is left alone until
  an admin adopts it (`AdminService/AdoptCatalogTeam`). So the catalog
  holds no console or cluster credential, and serves any number of
  installs. A store's stored credential is set per install
  (`TeamService/SetSecretStoreCredential`).
  An install can read another's catalog (`externalCatalog` in vertra.yaml);
  a Google Artifact Registry on another cloud it reads by Workload Identity
  Federation, the console handing the kubelet and its Jobs the hour's token
  (`console/src/registryFederation.ts`).
- **`catalog-template/`**: what a new catalog repository starts as
  (the `./vertra` wrapper, its workflows, the starter `templates/`, an empty `teams/`
  for the adopter's first team, and `samples/`: `local`, one no-cloud
  product in five languages that new teams copy starters from (and
  `ticket`, a sample of resources and cleanup), and `gcp`,
  `aws`, `azure`, billed cloud examples; azure unproven). It's
  versioned with the platform because its release format and schemas must
  match the console's; `.github/scripts/catalog-template.sh` runs `vertra catalog`
  in it with samples installed as teams (CI checks it that way, and
  `make catalog-publish` publishes it that way). A team's real products live in its own catalog
  repository, created from this, **not here**; adding a product needs no
  change to this repo. Its files are catalog format v2 (`apiVersion:
  vertra.dev/v2` and a `kind`: Team, Product, Template, Dag); the schemas
  are in `tools/` and embedded in vertra (`cli/internal/catalogtool/
  schemas/`, kept equal by a test): change both together.
- **`perf/`**: performance benchmarks on a kind cluster of their own,
  `vertra-perf` (`perf/README.md`: the runbook, and what's been found).
  Never run them on `vertra-local` or a shared cluster; every Makefile kind
  target takes `KIND_CLUSTER=vertra-perf`.
- **`_local/`** (gitignored): personal scratch space, such as a clone of
  your own catalog repository.
- `examples/`: fake demo products (`project-product`,
  `application-product`, `hello-world-app`) that deliberately share no code.

## Core contracts worth knowing before touching code

- **Product container contract**: the kernel mounts a ConfigMap with
  `request.json` at `/platform/input` (read-only). The action is passed as
  the container's `args`. The container writes `result.json` to
  `/platform/output`, which is read back via `terminationMessagePath`, so
  no sidecar is needed. Job names are prefixed `ek-`. A product that
  declares `tokenAudiences` also gets a short-lived ServiceAccount token
  per audience at `/platform/tokens/<audience>`, for OIDC federation to
  another cloud; never the Kubernetes API's. The action's `input` and
  `output` schemas are enforced: literal inputs at submit (the console),
  resolved inputs before it starts and outputs when it finishes (the
  kernel, from schemas the console attaches: `INPUT_INVALID`,
  `OUTPUT_INVALID`).
- **Input references**: a task input of exactly
  `{"$fromTask": "<id>", "$output": "<name>"}` is replaced with the
  upstream task's output at dispatch time
  (`kernel/internal/domain/task.go:ResolveInputs`; kernel-api refuses a
  reference to anything but a direct dependency, `domain/dag.go`).
- **Team = namespace**: a task's `team` is its dispatch namespace, and its
  `serviceAccount` is the Pod's identity. `secretRefs` name the Secrets to
  mount. On the UI side, `teams.name` doubles as the namespace name by
  convention (`console/src/db/schema.ts`). There is deliberately no separate
  column for it.
- **UI authorization**: a team-scoped method requires the caller to be a
  member of that team or an admin: `auth/access.ts` (`ensureTeamMember`,
  `canActForTeam`, and `loadExecution` for an execution, "any" of its
  teams to see it, "every" to cancel it). Use those, in `core/`; never call
  kernel-api from a new method without that check.
- **UI error handling**: the `maskErrors` interceptor
  (`src/rpc/interceptors.ts`) answers anything that isn't an `ApiError`
  with a generic `internal` error and logs it in full, because
  `@kubernetes/client-node` errors carry cluster response bodies and
  headers (a Fastify error handler does the same outside the API). An
  `ApiError`'s `extra` fields go in its `Failure` detail. Don't add
  per-method try/catch fallbacks.
- **Config**: the kernel's lives in `kernel/internal/config` (one
  `Settings` for every process, read from the chart's ConfigMap and
  checked at startup). UI config lives in `src/config.ts` (`requireEnv`
  for `DATABASE_URL`, `JWT_SECRET`, `KERNEL_API_URL`). Add new options
  there, not via scattered env reads.

## Commands

Local cluster (repo root; `docs/operations.md` has the rest):

```
make quickstart  # from nothing (or any state) to a running local install; rerunnable
make up          # resume the kind node, clear Unknown pods, port-forward console → http://localhost:18080
make down        # docker stop the node (keeps all data; never `kind delete cluster`)
make logs        # stern tail of kernel-api/scheduler/console on kind
make build-products   # build the demo product images
make catalog-publish CATALOG=<dir>   # local mode: publish a catalog folder's products to kind
make kind-deploy # helm upgrade both releases on kind (runs migrations)
make proto       # lint proto/ (the console's API) and regenerate its committed code
```

The kind values set a fixed admin password for local use only; never
reuse it anywhere else.

CI (`.github/workflows/ci.yml`, `security.yml`) runs every check below on
each PR, plus `helm lint`/render of `helm/values/*`, actionlint, a Trivy/OSV scan
of both platform images, Semgrep and gitleaks.

Kernel (`cd kernel`, Go 1.26+; CI uses the same pinned
`golang:1.27-alpine` image as the CLI, and `make test` runs it there):

```
go run ./cmd/kernel migrate              # the test database (DATABASE_URL), before the tests
go test ./...                            # all tests (TEST_DATABASE_URL)
go test ./internal/api -run TestName     # single test
go vet ./... && gofmt -l .
go build -o /tmp/kernel ./cmd/kernel     # then e.g. /tmp/kernel api
```

A schema change is a new `internal/migrate/sql/NNNN_name.sql`; the
console's database guide (`console/docs/06-database-schemas.md`) documents
it, and a test checks it does. kernel-api's API is
`proto/vertra/kernel/v1/kernel.proto`: `make proto` after changing it.

- Integration and end-to-end tests use **real Postgres**: `make test` (repo
  root) starts a throwaway container on `127.0.0.1:55432`, migrates both test
  databases and runs the kernel's, the gateway's (against the console's
  database), the console's and the frontend's tests; `make test-db` does
  just the databases. The suites read `TEST_DATABASE_URL`, defaulting to
  `localhost/execution_{kernel,console}_test` (what CI uses). A missing
  database fails rather than skips. Never point the tests at an install's
  databases. Each kernel test runs in a rolled-back transaction, or (for
  kernel-api's, which commit) in a database of its own.
- The kernel's Kubernetes tests (`TestKind*`, `internal/kindtest`)
  **skip** (they don't fail) when the current kubectl context isn't a kind
  cluster or it has no `execution-kernel` namespace
  (`kubectl create namespace execution-kernel`), unless
  `KERNEL_TESTS_REQUIRE_KUBERNETES=1` (CI). They build fixture images with
  Docker and push them to the local registry when `kind-registry` is
  running (Docker Desktop's kind nodes ignore `kind load`ed images), else
  `kind load` them. Run them from your machine, not the Go container,
  which has no cluster: build the test binary there (`go test -c`) and
  run it from its package directory.
- `internal/executor/executortest.Fake` is the in-memory executor for
  scheduler logic tests.

UI (`cd console`, and separately `cd console/frontend`):

```
npm run dev | build | typecheck | lint     # backend (tsx / tsc / eslint)
npm run db:generate                        # drizzle-kit, after editing src/db/schema.ts
npm run db:migrate
cd frontend && npm run dev | build | lint  # vite / tsc -b + vite build / oxlint
```

`npm test` (vitest) runs `console/test/*.test.ts` against a real, migrated
Postgres database called `execution_console_test`. The setup commands are
in `console/vitest.config.ts`. They cover auth (sessions, password
change and reset, login rate limiting), execution access (team
membership, team secrets, product-bound ServiceAccounts, retry and
cancel), the image policy, products and team lifecycle. A new
authorization rule gets a test there.

CLI (`cd cli`, Go 1.26+; CI uses the `golang:1.27-alpine` image by digest):

```
go test ./...                              # unit tests: config, prompts, values, the approval screen
go vet ./... && gofmt -l .
go build -o vertra ./cmd/vertra    # then e.g. ./vertra init dev; ./vertra apply dev
```

`vertra` keeps each environment in `./deploy/<env>/` (gitignored here),
or wherever `--config`/`VERTRA_CONFIG` points. It only runs kubectl,
helm, docker and kind (each pinned and checksum-verified when it downloads
them). To try it end to end without touching your own install, give it a
kind cluster of its own (`--cluster-name`); it shares the `kind-registry`.

## Things that bite

- NetworkPolicies (`templates/networkpolicy.yaml`) let only the kernel
  release's own Pods (and the console's) reach Postgres, and only the
  console reach kernel-api. A new component, or a debugging Pod, can't
  connect until it carries those labels. Checking a database password from
  inside the Postgres Pod proves nothing: local connections are trusted.
- The platform's docs are copied into the console's image
  (`console/docs/reference/`, listed in its `SOURCES`) for the Docs page and
  the chat agent. After changing any of them (`docs/*.md`, `docs/clouds/`,
  `catalog-template/README.md`), run `make console-docs`, or the console's
  tests fail.
- After rebuilding a platform image for kind, you must `kind load
  docker-image <img> --name <cluster>` again. Otherwise the cluster keeps
  running the stale image, or fails with `ImagePullBackOff`.
- Ask before deploying to any shared or billed cluster (`helm upgrade`,
  `kubectl apply`, image rollouts), especially while a design discussion
  is still open. Prove changes on kind first.

# Engineering principles for this project

These are descriptive of how this codebase has actually been built, not
aspirational. Where a rule below conflicts with what's already shipped,
the shipped code is right and the rule is wrong — flag it rather than
silently diverging either way.

**Scope:** applies to `kernel/` and `console/` — anything that ships. Code
under `examples/` is illustrative/reference material for demos and is
exempt from the production bar below (it still shouldn't do anything
actively dangerous — no real credentials, no unsafe subprocess/shell use
— but it doesn't need the same hardening, test depth, or observability as
real kernel/UI code).

## 1. Simplicity over ceremony

- The test for an abstraction is whether it corresponds to real
  complexity, not how many times something has been typed out. `Executor`
  is an interface with exactly one production implementer (the
  Kubernetes one, since the Docker executor was removed when the
  platform went Kubernetes-only). It still earns its keep because it
  makes the code testable: `scheduler.RunTick` holds all the claiming,
  retry and DAG-progression logic, and it's tested against
  `executortest.Fake` without needing a real cluster. That's a concrete,
  present need. What's *not* earned is abstraction built for a need
  that's speculative or merely imagined — a plugin system for a second
  implementation that isn't planned, a second production backend "just
  in case." `cmd/kernel` constructs `executor.Kubernetes`
  directly, with no factory and no selection logic, because there's
  nothing to select between.
- Duplication across genuinely independent artifacts is often correct,
  not a smell. Every `gcp/*` product's `entrypoint.sh` is copied verbatim
  on purpose — a platform team can change one product's language without
  touching another's file, at the cost of a few duplicated lines. Don't
  extract a shared library across things that are independently owned,
  independently deployed, or meant to be swappable/replaceable
  (`examples/project-product` and `examples/application-product`
  deliberately share nothing, since real vendors' containers wouldn't).
  Duplication *within* one owner's own code, doing the same thing for no
  reason, is still worth removing.
- Structural interfaces (Go's interfaces; the console's TypeScript types)
  are the idiomatic mechanism here, not class hierarchies built for polymorphism
  nobody needs yet (`executor.Kubernetes` and `executortest.Fake` share
  nothing but the `Executor` interface they each satisfy).
- `map[string]any` (a JSON object) is sometimes the *correct* type, not a lapse — task
  `inputs` are structurally opaque to the kernel by design (it must not
  need to understand any given product's semantics). Don't force a
  narrower type onto data that's supposed to stay opaque at that layer.

## 2. Security — concrete, not aspirational

**Secrets never touch the places that persist or distribute things.**
- Never in git, in any form, at any stage — not a raw value, not a
  "just for now" placeholder, not a `.env.example` with a real value
  filled in. Never in an image layer (image layers are permanent and
  distributed via registry pulls — a secret in a layer is recoverable
  even if a later layer deletes the file).
- Never in a URL, including a git remote — `https://<token>@github.com/...`
  puts a live credential in plaintext in `.git/config` and in every tool
  or log that ever echoes the remote. Use SSH keys or a credential
  helper instead.
- Never in `outputs` that flow back through an API response or get
  persisted — a product container's `result.json` must never echo back
  the credential material it used, since `outputs` is exactly what an
  ordinary caller of `ExecutionService/GetExecution` can read.

**Prefer no standing credential over a well-guarded one, and a narrow one
over a broad one.**
- Where the target platform supports it, use impersonation/federation
  (short-lived tokens, minted on demand) over a static key
  (the gcp samples' `gcp-target` team secret + `impersonated_credentials`,
  not a downloaded service-account key file).
- When a static credential is genuinely unavoidable, scope it to exactly
  what the one thing it's used for needs (`roles/browser` for a
  read-only check, not `roles/editor` "to be safe") — grant on the
  narrowest resource that makes sense (a specific secret via RBAC
  `resourceNames`, a specific service account, a specific Artifact
  Registry repository), not the broadest one that happens to work.
- One identity per real distinction that matters, not one shared
  identity for convenience. The boundaries that matter here: a team's
  secrets reach only that team's reviewed products (never another team,
  never an unreviewed image), and each step gets only the secrets it lists.
  Within a team, secrets are deliberately shared: the team chooses which
  step gets which (decided 2026-10-17). A cloud identity is the narrower
  thing — bind it to a product's own ServiceAccount, not one every product
  of the team runs as, so one product's cloud permissions don't become all
  of them.

**Build-time and run-time stay strictly separated.**
- An image is a generic, secret-free artifact — the same bytes run for
  every team, every execution, forever, until the code changes. Whatever
  a task needs to authenticate with gets attached at dispatch time (a
  mounted Secret, an env var), never baked into the thing `docker build`
  produces.

**Trust boundaries get validated; internal calls don't.**
- Validate at the edges — API request bodies, product container
  `result.json`, anything crossing from outside the process. Don't
  re-validate what an internal function's own type signature and the
  caller's contract already guarantee.
- Never build a shell command, SQL query, or file path by concatenating
  untrusted input. The Kubernetes executor builds Jobs only through the
  Kubernetes client's structured objects: the image name, the action
  passed as list-form `args`, and task inputs delivered as a
  `request.json` ConfigMap rather than being interpolated into a
  command. That way consumer-controlled task input can never become a
  shell injection vector. The same applies to `console/src/k8s.ts`. That's
  the model, not string formatting plus escaping.

**Fail loudly, not into a fallback that might be a security hole.**
- A blanket "wrap it in try/catch with a fallback" is itself a risk when
  the thing being swallowed is an auth or permission check — a fallback
  that silently allows something on error is a vulnerability wearing a
  resilience pattern's clothes. Errors that indicate a real, unexpected
  failure should propagate and be handled once, deliberately, at the
  layer that knows what durable, safe recovery actually looks like (the
  scheduler's outer loop catching and logging, then retrying from
  durably-persisted state on the next poll — not each internal call
  guessing at its own fallback).

## 3. Production-readiness, beyond security specifically

- **Prove it against the real thing before calling it done.** Mocked
  unit tests prove logic branches; they don't prove a real credential
  authenticates, a real RBAC binding actually restricts access, or a
  real container mount works the way the code assumes. Where a claim is
  "this secret is isolated" or "this now authenticates," it needs a
  real Kubernetes cluster or real cloud call behind it at least once,
  not just a passing mock.
- **Typed, validated configuration**, not ad hoc environment reads
  scattered through the code — one settings object (`internal/config.
  Settings`, the console's `src/config.ts`), validated at startup, so a misconfiguration fails immediately and
  legibly instead of surfacing as a confusing runtime error three calls
  later.
- **Structured logs and metrics on real code paths**, not print
  statements — every request, every credential-adjacent action, in a
  form that's queryable later, not just readable in the moment.
- **Idempotency for anything that mutates external state**, since
  execution here is at-least-once by design — a retried task must not
  double-create a resource or double-charge an external system. This is
  a requirement on product code specifically, not something the kernel
  can enforce for you.
- **Typed, explicit domain errors** (`domain.StructuredError`,
  `executor.DispatchRejected`, `domain.MissingOutputError`,
  `domain.DAGValidationError`; the console's `ApiError`) over bare strings or generic exceptions — an error
  should carry enough structure for a caller to make a real decision
  (retryable or not, what actually failed), not just a message to log.
