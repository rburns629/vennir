# Architecture

What Vennir is, how its pieces fit together, how a DAG becomes running
containers, and why it's built the way it is. For running it, see
[operations.md](operations.md); for its security model,
[security-model.md](security-model.md); for every file, the
[repository map](repository-map.md); for the kernel's code, call by call,
[`kernel/ARCHITECTURE.md`](../kernel/ARCHITECTURE.md).

The platform was called Acyclix until 2026-10-20, then Vertra until
2026-11-03; older notes, tags, releases (through 0.10.0, at
`ghcr.io/rburns629/vertra`) and installs may still use those names
(`vennir catalog migrate` converts a catalog).

## What Vennir is

Vennir runs DAGs of containerized steps on Kubernetes. A team submits a
DAG; each step is one action of a **product**, a container image published
from a reviewed **catalog** repository. Vennir runs each step as a
Kubernetes Job in the team's own namespace, passes each step's outputs to
the steps that depend on it, and keeps each team's credentials to that
team's reviewed products.

A step can be anything packaged as a container: a hello-world script, a
database migration, creating cloud infrastructure. Vennir doesn't decide
*which* steps a request needs: whatever submits the DAG does. It runs the
DAG it's given, reliably, and keeps one team's work and secrets away from
every other team's.

## The pieces

![The pieces: a catalog repository's CI pushes product images and a signed catalog release to a registry; each console pulls the release. People and bots sign in to the console, which keeps its own Postgres and hands authorized DAGs to kernel-api, which stores them in the kernel's Postgres. kernel-scheduler claims steps from those rows and creates one Job per step attempt in a team namespace; admission policies check every Job. The gateway, reading the console's Postgres, serves API products from their backends.](architecture/6-the-pieces.svg)

The whole of it as deployed on GKE, with the cloud services around it and
one execution traced through it: [the system diagram](architecture/1-system.svg).
[`architecture/`](architecture/README.md) has the others: every type in the
kernel and module in the console, a run call by call, and the state machines.

- **console** (`console/`, TypeScript, Fastify, React): the only front door.
  People and bots sign in here; it holds teams, memberships, bots and
  automation tokens, registered products and secrets, and an index of which
  team may see which execution. It authorizes every request, then calls
  kernel-api. It also owns team namespaces, writes teams' Secrets (it can't
  read them), pins and scans images, and keeps the kernel's admission
  policies' lists current.
- **kernel** (`kernel/`, Go): one binary and image, processes that
  never call each other and coordinate only through Postgres rows.
  - **kernel-api** validates a DAG and stores it (`KernelService`, over
    Connect). It knows nothing about users or teams and accepts only the
    console (by its ServiceAccount token, checked with a TokenReview).
  - **kernel-scheduler** claims ready steps, starts them as Jobs, watches
    them, records their results, and releases the steps that depended on
    them.
  - **kernel policy** (optional, with a signed catalog: `catalogPolicy`)
    verifies the catalog's release itself and writes what it decides
    (which digests are a product's releases, as which identity; each API's
    token audiences) into admission policies only it may update, beside
    the console's (decision 27).
- **gateway** (`gateway/`, Go; optional, `gateway.enabled` in the console
  chart): serves API products (decision 20), forwarding to each one's
  backend only what its reviewed OpenAPI document describes. Every backend
  must be under a host `gateway.backendHosts` allows, which may be outside
  the cluster; only an in-cluster one is also held to its own team's
  namespace. It signs callers in as the
  console does, reading the
  console's database as a role of its own (docs/security-model.md, "The
  API gateway").
- **Two Postgres databases**, one per project, never shared between them
  (on a small install they can live on one Postgres instance, each with its
  own role).
- **The catalog repository**, separate from this one: where teams contribute
  products by pull request. `catalog-template/` is what a new one starts as.
- **Admission policies** in the kernel chart, which the Kubernetes API
  server applies to every Job, so the rules hold even if the console is
  bypassed: which namespaces steps may run in, which images they may run
  (allowed, pinned, scanned, signed), and which identity and secrets they
  may have.

## From a DAG to running containers

1. **Submit.** A person or bot calls `ExecutionService/SubmitExecution`: a `name`, a
   `requestId` and the `tasks`. Each task names its product's `image` and
   `action`, its `team`, its `inputs`, what it `dependsOn`, and any
   `secretRefs`.
2. **Authorize** (the console, `console/src/core/executions.ts`):
   - the caller must belong to every team the DAG names (or be an admin),
     checked against the database on every request;
   - each image is pinned to its digest (`:latest` is fine in a DAG) and
     must have passed its security scan;
   - each task runs as the ServiceAccount its product declares (filled in
     when left out), or as `default` if it isn't a registered product of
     its team, which then can't mount secrets;
   - each `secretRefs` entry must be a secret registered for that team.
3. **Validate and store** (kernel-api): unique task ids, known
   dependencies, no cycles, `$fromTask` references only to upstream tasks,
   no credential-shaped inputs. Every problem comes back at once as a 422.
   One transaction stores the execution, its tasks (`READY` without
   dependencies, `BLOCKED` with, `AWAITING_APPROVAL` instead of `READY`
   for a step the console marked as needing an approval) and its edges. A repeated `requestId`
   returns the existing execution instead of a second one.
4. **Claim** (kernel-scheduler, `kernel/internal/scheduler/`): each pass recovers
   expired leases, claims up to 50 `READY` tasks with
   `FOR UPDATE SKIP LOCKED` and a 60-second lease, and starts their Jobs
   concurrently. Running-step caps (platform-wide and per team) are applied
   here.
5. **Dispatch** (`kernel/internal/executor`): replace each
   `{"$fromTask": …, "$output": …}` input with the upstream task's stored
   output, then create the Job (its name prefixed `ek-`) in the team's
   namespace: the request as a ConfigMap at `/platform/input/request.json`,
   the action as the container's argument, each listed secret mounted
   read-only at `/platform/secrets/<name>/`, a hardened Pod (non-root,
   read-only root filesystem, no Kubernetes token) and a deadline.
6. **Watch and record.** The container writes `/platform/output/result.json`,
   read back through `terminationMessagePath`, so no sidecar is needed. The
   scheduler watches Jobs and Pods, records outputs or a structured error,
   and stores the step's logs (refreshed while it runs, credential shapes
   redacted). A task past its `timeoutSeconds` (default 300) is failed. A
   `retryable` failure is retried up to `maxAttempts` (default 1), after a
   backoff (5 seconds, doubling, at most 5 minutes).
7. **Release.** When a task succeeds, each dependent whose dependencies have
   all succeeded becomes `READY`, and the next pass claims it. When nothing
   more can run, the execution ends `SUCCEEDED`, `FAILED` or `CANCELLED`.
8. **Read.** The console reads the execution, its events and its logs from
   kernel-api after the same team check. The execution page follows it over
   `WatchExecution`, a stream the console feeds by re-reading every 2s
   (re-checking access each time) and sending each change.

### Guarantees and their limits

- **At least once, not exactly once.** A scheduler that dies mid-step loses
  nothing: its leases expire, and the next scheduler adopts its running Jobs
  (a claimed step with no Job goes back to `READY`). A scheduler stopped
  normally releases its leases on the way out. A Job start that fails is
  retried with the same attempt (adopting a Job the failed call may have
  made). So a step can run twice, and **products must be idempotent**: look
  before creating.
- **Steps never cross executions.** Tasks, edges and outputs are keyed by
  UUIDs, an execution's edges are all created in the one transaction that
  stores it, and input resolution only follows a task's own edges. An
  output that isn't there fails the task rather than guessing.
- **A failure doesn't undo success.** Finished steps keep their outputs.
  Once a step fails for good, every step of the execution that hasn't
  started (waiting on a dependency, to be claimed, or for an approval) is
  cancelled, not only the ones that depend on it, and the execution fails;
  steps already running finish (`kernel/internal/scheduler/tick.go`,
  `failExecution`). Retrying a failed step
  (`ExecutionService/RetryTask`) resumes the execution.
  Cancelling is idempotent.

## The product contract

A product is a container image, plus a `product.yaml` in the catalog that
declares its actions, their input and output JSON Schemas, the secrets they
read, and optionally its own ServiceAccount and resources.

- **In:** `/platform/input/request.json` (read-only), with the step's
  resolved `inputs`. The action name is the container's argument.
- **Out:** `/platform/output/result.json`, at most 4 KB:
  `{"status": "succeeded", "outputs": {…}}`, or
  `{"status": "failed", "error": {"code", "message", "retryable"}}`.
- **Secrets:** the files under `/platform/secrets/<name>/`, for the secrets
  the step lists. Never in inputs, outputs, logs or the image.
- **Runtime:** non-root, read-only root filesystem with a writable `/tmp`,
  no Kubernetes token, the step's own ServiceAccount (for a cloud identity
  bound to it), at least once.

The catalog's README has the author's side of this: layout, testing, CI and
publishing.

## Data

| Database | Tables | Reference |
| --- | --- | --- |
| Kernel (`execution_kernel`) | `executions`, `execution_tasks` (state, lease, attempt count, inputs as submitted and resolved, the Job's handle), `task_dependencies` (the DAG's edges), `task_attempts`, `task_outputs`, `task_logs`, `execution_events` (append-only, the activity feed) | [`console/docs/06-database-schemas.md`](../console/docs/06-database-schemas.md); `kernel/internal/migrate/sql/` |
| Console (`execution_console`) | users, teams, memberships, API tokens (hashed), registered secrets (names, never values), products and their releases, image repositories, image scans, submitted executions (which teams may see each), the audit log | [`console/docs/06-database-schemas.md`](../console/docs/06-database-schemas.md) |

Tests in both projects keep the schema document in step with the tables.
Each project's migrations (SQL files in `kernel/internal/migrate/sql/`, run
by `kernel migrate`; Drizzle in `console/src/db/migrations/`) start from one
baseline and run as a Helm hook on every install and upgrade, before the
new code starts.

Execution states, task states and the transitions between them are drawn
in `docs/architecture/` (`5-states`), with the rest of the diagrams.

## Observability

- **Logs:** structured JSON on stdout from every process (a `service` field
  tells kernel-api from the scheduler), so any log stack can query them. A
  request ID (`X-Request-ID`, reused or generated) ties a request's lines
  together. `make logs` tails all three on kind.
- **Metrics:** Prometheus `/metrics` on kernel-api's port, and on a port
  of its own (9090) for the scheduler, the console and the gateway, which
  their public listeners never serve: request counts and latencies by
  route template or method, scheduler pass durations and errors, task
  events, catalog syncs and image scans. Only `networkPolicy.metricsFrom`
  (and, on kernel-api's port, the console) may reach them, and no metric is labelled with a user, a team or a token.
- **Health:** `/health/live` (the process is up; never touches the
  database) and `/health/ready` (the database answers; for kernel-api, at
  this code's schema) on kernel-api and the console; `/.vennir/health` on
  the gateway; the scheduler's liveness is its heartbeat
  (`kernel check-heartbeat`).
- **Audit:** every console call that changes something, with who, what,
  the target and the outcome (`audit_log`, `AdminService/ListAuditEntries`).
- **State:** the databases themselves; see
  [operations.md](operations.md#databases).

## Design decisions

- **The kernel stays blind to teams, users and credentials.** It runs any
  pre-resolved DAG on any conformant cluster, and has nothing sensitive to
  leak. The cost: authorization lives entirely in the console, so kernel-api
  accepts only the console's identity, and the cluster's admission policies
  re-check what matters.
- **Postgres is the only coordination between processes.** No message
  broker: state, queue and leases are rows, claimed with
  `FOR UPDATE SKIP LOCKED`, changed with compare-and-set. Simple to run,
  and a crash loses nothing that was committed.
- **Leases with adoption, at-least-once.** A scheduler can disappear at any
  moment and its steps carry on; the price is that products must be
  idempotent.
- **The Job first, its ConfigMap owned by it.** A step's ConfigMap is
  created after its Job and owned by it, so cleaning up the Job cleans up
  both, and a failed start can be adopted instead of duplicated.
- **The `Executor` protocol** has one production implementation; it exists
  so the scheduler's logic is tested against an in-memory fake.
- **Admission policies as CEL literals.** The image, identity and scan
  policies carry their lists inside the policy, which the console rewrites
  (and resyncs every few minutes), rather than a ConfigMap parameter, which
  stopped taking effect after a policy was recreated on Kubernetes 1.36.
- **Layered enforcement.** The console checks a request; the cluster checks
  the Job; Pod Security and NetworkPolicies limit the running step. Each
  holds when the layer before it is bypassed.
- **Secrets per team, identities per product.** A team chooses which of its
  secrets each step gets; only its reviewed products may get any; a cloud
  identity is bound to one product's ServiceAccount.
- **Two objects for vault sync.** A team's SecretStore (which vault, as
  which identity) is a reviewed catalog change; an ExternalSecret (sync
  this key) is self-service. A team can sync as many secrets as it likes
  without ever widening what its store can reach.
- **Migrations on every deploy**, as a Helm hook that runs before the new
  code: a no-op when nothing's pending, and new code never starts against
  an old schema.
- **Every API route under `/api`.** The console serves its API and the web
  app from one origin; a prefix keeps a page reload from ever hitting an
  API route.
- **Kubernetes only.** There's no Docker-only mode: the isolation Vennir
  promises is Kubernetes', and `kind` makes it local.

## Agreed direction

Decided on 2026-10-19, and built since (each item says when); the
reasoning, findings and roadmap are in [assessment.md](assessment.md), and
what's still open is in [`TODO.md`](../TODO.md).

- **Consumers run templates** (built 2026-10-21: the Run page).
  Anyone may run a team's published template, supplying only its inputs;
  the template fixes each step's secrets and identity, and its steps feed
  each other (`console/src/core/templates.ts`). Templates may include other
  teams' steps only where those teams export them. The owning team writes
  the dependencies; the service may draft them. Maintainers keep choosing
  secrets per step.
- **Identity in two layers.** The source is the product's ServiceAccount,
  bound per install, natively or by OIDC federation, holding only the right
  to act as specific targets. The target is an identity reference (a service
  account email, role ARN or managed identity) in a team secret, chosen by
  the owning team. The cloud's grant between them is the boundary.
- **One catalog, many installs** (built 2026-10-20). Each console pulls
  the catalog's release (`<registry>/catalog-release`, an OCI artifact CI
  pushes from `main` and signs like its images), verifies it, and applies
  it (`console/src/catalogSync.ts`); catalog CI builds, tests, scans, signs
  and pushes, and holds no console credentials. A release never purges, and
  never takes over a team the catalog didn't make unless an admin adopts it. Secret
  values, identity bindings and targets are per install; the catalog only
  names them.
- **Targets allowed per team, readiness per install.** Each team lists
  which projects, folders or accounts each consumer team may aim its
  templates at; each product may ship a `check` action the console runs per
  install. No live account discovery.
- **Forms from schemas.** The input schemas teams write drive the run form
  and are checked at submit and again, resolved, before each step starts.
- **Bindings per action, latest releases.** Each action names the team
  secrets it uses in `product.yaml`, so it keeps them in any DAG a consumer
  composes; steps use a product's latest release, guarded by compatibility
  checks.
- **Pull requests come from people.** Asking for access or proposing a
  template opens GitHub in the person's browser; the console only reads the
  catalog.
- **Still Postgres and Jobs.** No new services: the additions are tables,
  fields and console pages. Azure and GitLab wait until this is done.
- **Languages and APIs** (decided 2026-10-20). The console stays
  TypeScript, its API moves to Connect (protos, generated clients, gRPC
  available). The kernel is Go, against the same schema (2026-10-20),
  and the catalog tool is part of `vennir` (`vennir catalog ...`, decided 2026-10-21). Products keep any
  language and JSON Schema.

## Glossary

- **DAG**: a set of tasks and the dependencies between them.
- **Execution**: one submitted DAG, from `PENDING` to `SUCCEEDED`, `FAILED`
  or `CANCELLED`.
- **Task, step**: one node of a DAG: one action of one product, run as a
  Kubernetes Job (one per attempt).
- **Product**: a reviewed container image with actions, from the catalog.
- **Team**: the unit of tenancy: a console team, a Kubernetes namespace and a
  catalog folder, all one name.
- **Registered secret** (`secret_grants`): the console's record of a team's
  secret: its name and key names, never its value.
- **SecretStore / ExternalSecret**: External Secrets Operator's objects:
  which vault a namespace may read, and which key to sync into which Secret.
- **Admission policy**: a Kubernetes ValidatingAdmissionPolicy, a rule the
  API server applies to every request.
- **Workload identity**: a cloud's way to let a Kubernetes ServiceAccount
  act as a cloud identity without a stored key (GKE Workload Identity, EKS
  Pod Identity or IRSA, AKS Workload Identity).
- **`requestId`**: a caller's idempotency key: submitting it again returns
  the same execution.
