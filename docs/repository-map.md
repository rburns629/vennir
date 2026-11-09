# Repository map

Every folder and file in this repository, and what it's for. For how the pieces work together, read [`architecture.md`](architecture.md) and the diagrams in [`architecture/`](architecture/README.md); this page is the index.

The repository holds two independent projects that are deployed together and share no code:

- **`kernel/`** runs DAGs: an API that accepts them, and a scheduler that runs each task as a Kubernetes Job.
- **`console/`** is the authenticated front door: sign-in, teams, secrets, products, and the web UI.

Around them: `helm/` packages both for Kubernetes, with each cluster's settings, and `docs/` explains it all.

```
.
├── kernel/        the execution engine (Go): kernel-api, kernel-scheduler
├── console/       the web console and its API (TypeScript)
├── helm/          Helm charts for both, and each cluster's settings
├── docs/          maintainer documentation and diagrams
├── examples/      demo products (not real catalog products)
├── catalog-template/  what a new catalog repository starts as
├── cli/           vennir, the installer CLI (Go)
├── proto/         the console's API as protobuf (Connect); `make proto` generates its code
├── site/          vennir.io, the public website (static, on Firebase Hosting)
├── .github/       CI and security workflows
├── Makefile       everyday commands: run, deploy, logs
└── _local/        your own scratch space (gitignored)
```

## Top level

| Path | What it's for |
| --- | --- |
| `README.md` | What Vennir is, a first example DAG, trying it locally on kind, and how the parts fit together. |
| `LICENSE` | The MIT license. |
| `SECURITY.md` | How to report a vulnerability privately, response times, supported versions, scope. |
| `CONTRIBUTING.md` | Setting up, testing, what a pull request needs, the CLA. |
| `CLA.md` | The Individual Contributor License Agreement contributors accept once, by a comment on their first pull request (`workflows/cla.yml`). |
| `CODE_OF_CONDUCT.md` | Adopts the Contributor Covenant 2.1, and where to report problems. |
| `AGENTS.md` | Guide for AI coding assistants (and a quick orientation for people): layout, core contracts, commands, things that bite, engineering principles. |
| `CLAUDE.md` | One line that imports `AGENTS.md`, so Claude Code reads the same guide. |
| `TODO.md` | The actionable follow-up list: security, access, operations, housekeeping. Check it before starting work. |
| `Makefile` | Everyday commands: `make quickstart` (a local install from nothing), `make up`/`down`/`logs` for the kind cluster, `make kind-deploy*` and `make gke-deploy*`, building the demo products, and `make test`/`test-db`/`test-db-down` (a throwaway test Postgres, separate from any install), and `make proto` (lint the API's protos and generate their code). |
| `.gitignore` | Keeps `_local/`, build output and dependencies out of git. |
| `buf.yaml` | buf's module (`proto/`) and lint rules for the APIs. |
| `buf.gen.es.yaml`, `buf.gen.frontend.yaml`, `buf.gen.go.yaml`, `buf.gen.kernel.yaml` | What `make proto` generates: TypeScript for the console (`console/src/gen/`: its API and kernel-api's, which it calls) and for the frontend (`console/frontend/src/gen/`, the console's API only, JavaScript with type declarations), Go for the CLI (`cli/internal/gen/`, the console's API and the catalog release) and for the kernel (`kernel/internal/gen/`, its own and the catalog release, which `kernel policy` reads), each from plugins pinned in that project. |
| `proto/vennir/console/v1/` | The console's API as Connect services: one file per service (`execution.proto`'s `ExecutionService` streams `WatchExecution`), and `common.proto` (failures, problems, paging). The API reference page is built from these. |
| `proto/vennir/catalog/v1/release.proto` | A catalog release: every team (with its SecretStore files) and product action of a catalog's `main`, which `vennir catalog release` pushes as an OCI artifact and each console pulls. |
| `proto/vennir/kernel/v1/kernel.proto` | kernel-api's `KernelService`, internal: only the console calls it. |
| `gateway/` | The API gateway (its own section, below). |
| `perf/` | Performance benchmarks on a kind cluster of their own (`vennir-perf`): `README.md` (the runbook and the findings), the driver (a Go module, no dependencies: `main.go` runs a scenario through the console's API, `workload.go` the shapes and hard caps, `console.go` the calls, `analyze.go` the timings, correctness checks and report, `readers.go` people reading while it runs (`-readers`), `compare.go` two runs side by side (`go run . compare`)), `pgbench/run.sh` (Postgres alone, in the cluster, as it's sized), `slowcreate/` (an admission webhook holding Job creates, to see a create that timed out but happened: `main.go`, `webhook.yaml`, `run.sh` up or down, `kernel.yaml` the short timeout), and the perf cluster's settings (`kind-kernel.yaml`, `kind-console.yaml`). Results go to `perf/results/`, not in git. |
| `site/` | vennir.io, the public website: static pages, no build step (`README.md` says how to change and deploy it). `public/` holds the pages (`index.html` home, `product`, `use-cases`, `security`, `get-started`, `faq`, `docs`, `changelog`, `community`, `404`), `robots.txt`, `sitemap.xml`, `llms.txt` and `og.png` for search engines and AI assistants, `site.js` (the home page's animated run, the copy button and the Docs page's search) `favicon.svg`, and `diagrams/` (copies of `docs/architecture/`'s SVGs the pages show); `firebase.json` the hosting settings (clean URLs, security headers), `.firebaserc` its Google Cloud project. |
| `testdata/` | Test cases more than one project reads: `api-access-cases.json`, who may call an API, run by both the console's and the gateway's `accessFor` tests so they can't drift. |
| `.semgrep/malicious.yml` | Semgrep rules for code that has no business in a product (running remote code, hidden payloads, reverse shells, mining). Run by `ci.yml`'s code job. |

## `.github/`: CI

| Path | What it's for |
| --- | --- |
| `workflows/ci.yml` | Every PR: the kernel's `gofmt`, `go vet`, migrations and tests (`-race`), with its kind tests in the kubernetes job; console tests, lint and build; the API's protos linted and their committed generated code checked against `make proto`; govulncheck over the CLI, the kernel and the gateway; Helm lint and render of `helm/values/*`; `actionlint` (this repo's workflows and the catalog template's); the catalog template's checks; building both platform images and scanning them (Trivy, OSV-Scanner); secret scanning (gitleaks) and code scanning (Semgrep, including `.semgrep/`). One workflow, so each event is one run. |
| `workflows/perf.yml` | The performance benchmarks, by hand or weekly, never on a PR: `vennir-perf` on the runner, baseline and burst, the results kept as an artifact and compared with the last successful run's (`perf`'s `compare`). |
| `dependabot.yml` | Monthly update pull requests, one per ecosystem (a week's cooldown): the platform's and the samples' Go, npm, every Dockerfile, the workflows, and the catalog template's Rust and Python starters. |
| `workflows/cla.yml` | On a pull request: asks each author who hasn't accepted the CLA to, and passes once all have (CLA Assistant Lite; signatures on the `cla-signatures` branch). |
| `workflows/release.yml` | On a version tag: first checks `vennir` with govulncheck; then builds both platform images for amd64 and arm64, scans them, pushes them to GHCR, signs them keyless; packages, pushes and signs both charts; creates the GitHub release; builds `vennir` for linux and macOS (amd64, arm64), pushes each binary to GHCR as a blob a catalog's `./vennir` downloads by SHA-256, signs them, and attaches them with their checksums (each `vennir` carrying its release's charts' SHA-256s); then, for a release that isn't a pre-release, opens the pull request pinning `catalog-template/vennir` to it (`pin-vennir.sh`) and adding its charts' SHA-256s to `cli/internal/install/release-charts.sha256`. |
| `scripts/install-scanners.sh` | Installs pinned, checksum-verified tool binaries (Trivy, OSV-Scanner, gitleaks, actionlint, cosign, oras) for the workflows. |
| `scripts/pin-vennir.sh` | Pins a released `vennir` in a catalog's `./vennir` (default `catalog-template/vennir`): its version and each platform's SHA-256 from the release, after checking each downloads anonymously and matches. |
| `scripts/catalog-template.sh` | Runs `vennir catalog` (vennir built from this checkout) in `catalog-template/` with its samples (all, or `SAMPLES=`) installed as teams: CI's `validate` and `check`, and `make catalog-publish`'s `publish -- release` (commands separated by `--` run in the same assembled catalog). |
| `scripts/build-vennir.sh` | Builds `vennir` for this machine in the pinned Go image (no Go needed) into `cli/bin/`, and prints its path, for `VENNIR_BIN`. |
| `scripts/scan-image.sh` | Scans one built platform image and fails if it must not ship (fixable high or critical vulnerabilities, and more). |
| `scripts/published.sh` | Whether a tag is in the registry (its digest), for the release workflow, which writes each version's tags once. |
| `ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml` | Issue forms for bugs and feature requests. |
| `ISSUE_TEMPLATE/config.yml` | Turns off blank issues and points security reports to private reporting. |
| `pull_request_template.md` | What every pull request describes, and its checklist. |

## `kernel/`: the execution engine

Go (pgx, client-go, Connect). One binary, `kernel`, run as processes that never call each other and meet only in Postgres: **kernel-api** (`kernel api`), **kernel-scheduler** (`kernel scheduler`), **kernel policy** (`kernel policy`, with a signed catalog), the migration hook (`kernel migrate`) and the sleeper (`kernel sleep`). Python until 2026-10-20 (decision 17 in `docs/assessment.md`). The package rules and a call-by-call trace are in [`ARCHITECTURE.md`](../kernel/ARCHITECTURE.md).

| Path | What it's for |
| --- | --- |
| `README.md` | What the kernel is and how to run and test it. |
| `ARCHITECTURE.md` | The package rules, and a call-by-call trace of submit → claim → dispatch → poll → finish. |
| `go.mod`, `go.sum` | The kernel's Go module (`github.com/roburns/vennir/kernel`). |
| `Dockerfile` | The image: a Go stage builds the binary; it runs on distroless (no shell) as a non-root user. |
| `.dockerignore`, `.gcloudignore` | Keep test binaries and local files out of the image and the Cloud Build upload. |
| `cmd/kernel/main.go` | The binary: `api`, `scheduler`, `policy`, `migrate`, `database-setup`, `sleep [--now]`, `wake`; for the chart `wait-for-postgres` (init containers) and `check-heartbeat` (the scheduler's liveness probe); and `database-token FILE` (a managed database's sign-in for pg_restore, when vennir moves an install's data in). |
| `internal/config/config.go` | Every setting, for every process, read from the environment (the chart's ConfigMap) and checked at startup. |
| `internal/dbauth/` | Signing in to a managed database with the workload's own identity: on GKE, its Workload Identity token from the metadata server (Cloud SQL's IAM database authentication); on EKS, an RDS token its Pod Identity role signs (`rds.go`), and the RDS administrator's password from Secrets Manager, for database-setup. |
| `internal/dbsetup/` | `kernel database-setup`: as a managed server's administrator, makes what the cloud didn't (on RDS, the databases and the services' `rds_iam` users), then opens each database to its own service alone (the console may pass on its CONNECT and schema USAGE, for the gateway). |
| **`internal/domain/`** | **The rules, with no I/O.** |
| `internal/domain/states.go` | Task and execution states, the retry rule and its backoff. |
| `internal/domain/dag.go` | Checks a DAG before it's stored: duplicate ids, unknown or repeated dependencies, cycles, `$fromTask` references, credentials in inputs; topological order. |
| `internal/domain/schema.go` | A product's input or output schema, as the console attaches it to a task: compiled (nothing outside it fetched) and checked against values. |
| `internal/domain/result.go` | `result.json`, what a product writes, parsed strictly; the structured error. |
| `internal/domain/task.go` | Step sizes; `{"$fromTask", "$output"}` references and resolving them; the `request.json` a product reads. |
| `internal/domain/credentials.go` | Recognizes credential shapes: redacts them from logs and error messages, fails outputs that hold one, refuses inputs that do. |
| `internal/domain/events.go` | The event types recorded for an execution. |
| **`internal/api/`** | **kernel-api.** |
| `internal/api/service.go` | `KernelService`: submit (idempotent by `requestId`), read an execution, its states, events and logs, cancel, retry a task. |
| `internal/api/stats.go` | What the steps did, from the kernel's tables, for Observe's Metrics tab: started and p95 wait by hour, failures by code, step times by image and action, ready and running now. |
| `internal/api/refusals.go` | The attempts the cluster refused to start (admission policies' codes) since a time, for Observe. |
| `internal/api/approvals.go` | Approving or declining a task awaiting approval, and listing a team's awaiting tasks. |
| `internal/api/auth.go` | Accepts only the console: checks its ServiceAccount token with a TokenReview. |
| `internal/api/server.go` | The HTTP server: the service, health, metrics, and every request logged and measured. |
| **`internal/executor/`** | **Running a task.** |
| `internal/executor/executor.go` | The `Executor` interface and the types passed through it. |
| `internal/executor/kubernetes.go` | The one executor: creates the Job and its `request.json` ConfigMap (adopting an attempt's Job, reporting a policy's refusal), reads status and the termination message, catches image-pull failures, removes a finished Job once released. |
| `internal/executor/stepjob_test.go` | Keeps `helm/tests/step-job.json` equal to the Job the executor makes, for the admission tests to dry-run. |
| `internal/executor/watch.go` | Informers on the kernel's Jobs and Pods: wake the loop on a change, and skip re-reading a step that hasn't changed. |
| `internal/executor/executortest/` | `Fake`: an in-memory executor, to test the scheduler without a cluster. |
| **`internal/scheduler/`** | **The scheduling pass and the loop.** |
| `internal/scheduler/tick.go` | One pass, in two parts: `RecordPass` (expire undecided approvals, poll running tasks, save results, retry or fail, release dependents, finish executions, renew the rest's leases) and `DispatchPass` (claim, start each task, retry or fail one that couldn't start); `RunTick` runs both in one transaction, for tests. |
| `internal/scheduler/claiming.go` | Takes READY tasks with `FOR UPDATE SKIP LOCKED` and a lease, within the running caps (the platform's, each team's, each product's) and concurrency keys; recovers tasks whose lease expired; releases a stopping scheduler's leases. |
| `internal/scheduler/rows.go` | The task and attempt rows, events, and compare-and-set execution transitions. |
| `internal/scheduler/run.go` | The loop: each pass records what finished and commits it, then dispatches in a transaction of its own, finished Jobs released after the commit (held `ReleaseAfter` first, for the log collector), housekeeping, the queue gauges (`kernel_tasks`, the oldest ready task's age), the heartbeat, leases released on stop. |
| `internal/scheduler/retention.go` | Deletes finished executions past their retention (with everything of theirs). |
| `internal/scheduler/orphans.go` | Every few minutes, removes attempts' Jobs no task can use any more (a pass that rolled back, a release that failed, a deleted execution). |
| `internal/scheduler/stranded.go` | Every few minutes too, cancels tasks left waiting in a cancelled execution (by a writer that raced the cancel), which nothing would claim. |
| **`internal/migrate/`** | **The schema.** |
| `internal/migrate/sql/` | One SQL file per change, applied in order, each once: `0001_initial_schema.sql` (every table at the first public release), then one file per later change. A released file never changes. |
| `internal/migrate/grants.go` | What `kernel policy`'s own database role holds (`GrantPolicy`, after the migrations): it reads `schema_migrations`, `executions` and `execution_tasks`, and changes only `catalog_policy_*`; tested in `grants_test.go`. |
| `internal/migrate/migrate.go` | Applies them under an advisory lock, recorded in `schema_migrations`; takes over an install Alembic migrated; what kernel-api and the scheduler wait for. |
| `internal/sleeper/sleeper.go` | The sleeper: one look, and if the platform is idle, the counts to wake to recorded and every Deployment scaled to zero (the databases last), the wake CronJob armed for the console's next schedule; and `Wake` (`kernel wake`), which brings it back. |
| **`internal/policy/`** | **`kernel policy`: what a signed catalog decides, written into the cluster by the kernel (decision 27).** |
| `internal/policy/policy.go` | The pass: look at the catalog's release, verify and apply a new one (never an older one), then write the catalog identity and token policies from what's applied, pruning earlier releases no longer in use. |
| `internal/policy/compute.go` | Pure: what the console would register from a release (product releases, APIs' sign-ins), which releases are in use, the audiences each API ServiceAccount needs, and the sixteen maps' literals with their size limits. |
| `internal/policy/verify.go` | Verifying a release's signature with cosign's Go library: each trusted public key (no transparency log), then a keyless identity against Sigstore's trusted root, its Rekor entry checked offline. |
| `internal/policy/registry.go` | Reading the release from the registry as this Pod's own identity (by federation, a Docker config, GKE's metadata token, ECR's), through mirrors; following the newest version. |
| `internal/policy/federation.go` | Another cloud's catalog (or another AWS account's ECR) by a federation of its own: its projected ServiceAccount token exchanged at Google's STS (then impersonating), or by `AssumeRoleWithWebIdentity` for ECR's token. |
| `internal/policy/store.go` | The release applied and the product releases it named, in the kernel's database; which releases unfinished tasks run. |
| `internal/policy/writer.go` | Rewriting an admission policy's literals through the API server, conditionally on the version read. |
| `internal/policy/cel_test.go` | The policies' literals compiled by cel-go as the API server compiles them, whatever strings a catalog release carries. |
| `internal/policy/testdata/keyless/` | A real keyless cosign signature (of cosign's own release image) and Sigstore's trusted root, for the verification tests. |
| `internal/logging/`, `internal/metrics/` | JSON logs; the Prometheus metrics. |
| `internal/gen/` | `KernelService`'s generated Go, and the catalog release's (`make proto`). |
| `internal/scheduler/perf_test.go` | The scheduler and Postgres alone, with the fake executor and 1, 2 and 4 schedulers: steps a second, and that no step starts twice. Only with `VENNIR_PERF=1` (`perf/README.md`). |
| `internal/dbtest/`, `internal/kindtest/` | For tests: the test database and throwaway ones; the current kind cluster and test images (`kindtest/fixture/`: a test-only product that crashes, sleeps or fails on demand). |
| `*_test.go` | Beside each package: against the real, migrated test database (`TEST_DATABASE_URL`), client-go's fake clientset, or (`TestKind*`) a real kind cluster, skipping without one or failing when `KERNEL_TESTS_REQUIRE_KUBERNETES=1` (CI). |

## `console/`: the console and its API

TypeScript, Fastify 5, Drizzle (Postgres), `@kubernetes/client-node`. One process serves the API under `/api` and the React app, from one origin.

### Project files

| Path | What it's for |
| --- | --- |
| `package.json`, `package-lock.json` | Backend dependencies and scripts (`dev`, `build`, `typecheck`, `lint`, `test`, `db:*`). |
| `tsconfig.json`, `eslint.config.js` | TypeScript and lint settings. |
| `drizzle.config.ts` | Where the schema and migrations are, for `npm run db:generate`. |
| `vitest.config.ts` | Test settings, including the test database. |
| `Dockerfile` | Builds the backend and frontend into one image, with `docs/` copied in. Runs as a non-root user. |
| `.gcloudignore` | Keeps local files out of the Cloud Build upload. |

### `console/scripts/`

| Path | What it's for |
| --- | --- |
| `chat-eval.ts` | Scores the chat agent's answers on the question set against a console's model (`npm run chat-eval`): cites an answering section, flagged uncited, `mustSay`/`mustNotSay`, seconds; results in `chat-eval-results/`, not in git. |
| `api-reference.ts` | Turns the protos (a `buf build` image, comments included) into the API reference's data, `frontend/src/gen/api-reference.json`; run by `make proto`. |

### `console/src/`: the backend

| Path | What it's for |
| --- | --- |
| `gen/` | Generated from `proto/` by `make proto`; never edited (and not linted). |
| `index.ts` | Builds the app: the global error handler (hides server errors' details), auth, rate limits, every route under `/api`, the static frontend. |
| `config.ts` | Every setting, read and checked once at startup. |
| `k8s.ts` | **Every write to Kubernetes:** product ServiceAccounts (create-only), Secrets, ExternalSecrets, removing the per-secret Roles older versions made, the image policy; also reads namespaces, SecretStores and task Pods. Security-sensitive. |
| `kernel/client.ts` | Calls kernel-api's `KernelService` over Connect (with the console's projected ServiceAccount token): submit, read, states, events, logs, cancel, retry. Turns a DAG's JSON into the request strictly, under the names the console checked, and kernel-api's refusals into the statuses the console relays. |
| `imagePolicy.ts` | The allowed image sources: the same matching rules as the cluster's image policy, and reading and saving it. |
| `imageRef.ts` | Reading an image reference the way the kubelet does (`normalizeImage`, `imageRepository`); pure, used by the image policy and repository ownership. |
| `secretStores.ts` | What a team's SecretStore file may hold, checked before the console applies it (`PUT /teams/:team/secret-store`): the same rules as the catalog's own check. |
| `scanning.ts` | Scanning every image before it's registered or run: a Trivy client Job per digest, verdicts in `image_scans`, daily rescans, the digests that passed and are in use written into the kernel's scan policy; idling the Trivy server when no scan is wanted. |
| `activity.ts` | Records when the console was last used (any signed-in request, once a minute at most) for the kernel's sleeper. |
| `audit.ts` | Who changed what: every changing `/api` request, allowed or refused, recorded in `audit_log`, hash-chained, and logged (never a secret value, password or token). |
| `auditReads.ts` | Who read what: the methods whose answers carry runs' outputs, failure messages, logs, resources' provided values or secret names, and recording what each returned to whom in `audit_reads` (by name, never the content; the same read once every 10 minutes), without holding up the read; the chat agent's tools record theirs. |
| `metrics.ts` | The console's Prometheus metrics (Connect calls by procedure and code, catalog syncs, image scans, the process), on a port of their own. |
| `auditExport.ts` | The audit log's write-once copy: every few minutes, new entries, their hash chain checked, to a GCS or S3 bucket that refuses deletes and overwrites; and every hour a few copies compared with the database, entry by entry. |
| `catalogSync.ts` | Pulls the catalog's release (its tag, or the newest version) every few minutes (and on Sync now), verifies its signature with a cosign Job, and applies it: teams, products, SecretStores; unregisters and retires what it drops; leaves teams it didn't make alone until an admin adopts them. |
| `jsonSchema.ts` | Checking values against the JSON Schemas teams write (ajv, draft 2020-12, nothing fetched): template parameters and products' inputs. |
| `catalogPolicy.ts` | Reads the kernel's catalog identity policy (never writes it): who writes the catalog's policies, for the Admin page, and which of a submission's releases it doesn't list yet, which the console refuses to submit. |
| `tokenAudiences.ts` | Which audiences a product's steps may get a projected token for: refuses the Kubernetes API's (from the console's own token) and kernel-api's, and names each token's file. |
| `policySync.ts` | Rewrites the identity, scan and gateway token policies and the teams' pull Secrets every few minutes, so drift doesn't last; keeps each sync's outcome for admins. |
| `logLevels.ts` | Who sees which of a step's log lines: INFO to everyone who can see the run, the rest to the step's team. |
| `registryFederation.ts` | Reading another install's registry with no stored key: the console's projected token exchanged at Google's STS (Workload Identity Federation, an Artifact Registry) or AWS STS (the owner's role by web identity, then ECR's token), and the Docker config it hands out. |
| `pullSecret.ts` | Copies the platform's registry pull Secret into every team namespace (`vennir-pull`), for steps' images in private registries. |
| `failureHelp.ts` | What a failed step's error means, what to do, whether a retry is safe and whom to ask: the owner's words, else the platform's. |
| `targets.ts` | Allowed targets (X1): which projects, folders, accounts or subscriptions another team may aim a team's products at, from its `allowedTargets`. |
| `schedulerLogs.ts` | Binds the kernel scheduler's log reading in each team namespace (one RoleBinding to its logs-only ClusterRole, the console's only RBAC write), with the namespace and on every policy resync. |
| `teamNetwork.ts` | Keeps the default-deny NetworkPolicy (`vennir-default-deny`) in every team namespace, so teams' steps can't reach each other. |
| `retention.ts` | Deletes, hourly, submitted-execution records, audit entries, unused scan verdicts and chat ratings (90 days) past their retention. |
| `notifier.ts` | Notifications: making each event once (a run that failed or finished, a step waiting for an approval, the catalog not pulled, a product not ready, a step the cluster refused, a platform alert), fanning it out to inboxes, email (SMTP, the kinds each person chooses) and teams' chat webhooks, and sending those, one console at a time (webhook URLs encrypted, allowed hosts only). |
| `readiness.ts` | Whether each product is ready on this install: runs its check action (as the console, as the product) when it's new or changed, daily or on Check now, and records the answer. |
| `scheduleRunner.ts`, `cron.ts` | Starting teams' schedules when they're due, each as its bot (claimed by moving its next run on, so one console starts it), and the cron expressions they use (five fields, IANA time zones). |
| `callbacks.ts` | Callbacks for systems (decision 23): a finished run queued for its ordering bot's callback (`order.finished`) and its owning teams' outcome webhooks (`run.finished`, with steps' outputs), posted signed (`Vennir-Signature`), allowed hosts only, five tries, one console at a time. |
| `resourceRecorder.ts` | Every 30 seconds, copies what finished runs' steps reported as `resources` (with each step's inputs and outputs) into the `resources` table, and marks what cleanup runs deleted. |
| `productPolicy.ts` | Which product releases (digests) give a step its product's identity, and writes them, with each team's secrets, into the cluster's identity policy: after every product or secret change, every few minutes (pruning releases no longer in use), at startup, and before a submission runs one it doesn't list yet; with the kernel chart's `catalogPolicy`, only the secret names (the kernel writes the digests). |
| `gatewayTokenPolicy.ts` | Which audiences each published API's ServiceAccount may get a token for (what the gateway asks for per backend.auth; none for a held API or a retired team's), written into the console chart's gateway token policy: after every catalog sync and team retirement, every few minutes and at startup. |
| `azureToken.ts` | The console's own Microsoft Entra access token (AKS Workload Identity): its token file exchanged at Entra, per scope; the registry's for ACR. |
| `gcpMetadata.ts` | The console's own Google access token, from the node's metadata server (Workload Identity): the registry's, the audit export's, single sign-on's, Vertex's and the database's. |
| `registry.ts` | Asks a container registry whether an image still exists, before a run, pins tags to digests, and fetches the catalog's release (digest-checked) and lists its tags, for its newest version. |
| `apiError.ts` | `ApiError`: a refusal (HTTP status, stable code, message, Connect code, extra fields) thrown by `core/` and turned into a Connect error (its code, a `Failure` detail with any extra fields) by Connect's interceptor. |
| `guides.ts` | The guides in `console/docs/` and the reference: listing them with their sections, reading them, and the figures they draw (`GuideService`). |
| **`core/`** | **What the API does**, one file per area, called by the Connect services: each function takes the caller, checks access, does the work, and throws `ApiError` to refuse. |
| `core/executions.ts` | Submitting (team, identity, secret, image and scan checks, pinning, ServiceAccounts), listing, reading, events, logs, cancel, retry, rerun. |
| `core/teams.ts` | Teams and members, their namespaces, retiring, restoring and purging, SecretStore files, running task Pods. |
| `core/secrets.ts`, `core/products.ts`, `core/images.ts` | Team secrets and their sources; the product registry, repository ownership and wiring types; the image policy and scan verdicts. |
| `core/clouds.ts` | Which installs a product is for: its clouds against this install's (`INSTALL_CLOUD`, which vennir sets), and the `NOT_FOR_THIS_INSTALL` refusal at submit. |
| `core/users.ts`, `core/tokens.ts`, `core/admin.ts` | Accounts; bot and automation tokens; platform counts, the audit log, policy sync. |
| `core/orderRate.ts` | An ordering bot's rate (decision 23): its orders in the last minute, counted from its runs; past `orders.ratePerMinute`, 429 with Retry-After. |
| `core/templates.ts` | Templates: what a person may run (templates and shared actions), running one with parameters only, each step built from its product; reruns of a template's run; previews (runs of plan actions) and cleanup runs. |
| `core/catalogLinks.ts` | Links into the catalog repository for a template, action or API: its file, and the pre-filled issue Ask for access opens. |
| `auth/keyless.ts`, `core/botIdentities.ts` | Keyless bots: a CI's ID token exchanged for a bot's hour-long session (AuthService/ExchangeToken), and which CI identities sign in as which bot (TokenService). |
| `core/schedules.ts` | `ScheduleService`: a team's schedules (members see, maintainers make, pause and delete), checked as their bot. |
| `core/sso.ts` | `SsoService`: single sign-on as admins set it (the provider unless the install set it, its discovery checked, its secret write-only), where groups come from, and groups mapped to teams. |
| `core/drafts.ts` | `DraftService`: Compose's drafts, kept for their team (its members and admins), bounded, each save conditional on the version it changed. |
| `chat/agent.ts`, `chat/tools.ts`, `chat/model.ts` | The chat agent (decision 24, `ChatService`): the loop (the model calling tools, as the person, up to `chat.maxSteps`, its answer's citations checked); its guardrails (a scope check before it, an answer from neither the docs nor the tools not shown, a context window of `chat.contextTokens`); its steps streamed as it takes them (`AskStream`), the answer only at the end, checked; the tools, each the console's own code as the person (search and read the docs, find and describe offerings, what a team has, a run, plan an order, propose a cart); one model interface and its adapters: openai-compatible (LM Studio, Ollama, Gemini on Vertex) and Anthropic's Messages API (Claude, through Anthropic or Amazon Bedrock). |
| `chat/bedrock.ts` | Claude in Amazon Bedrock: each request the Anthropic client makes, signed (SigV4, `bedrock-mantle`) as the console's own AWS identity. |
| `core/chatLimits.ts` | How many questions each person may ask the chat agent (`ChatService`'s Get and SetChatLimits; 30 an hour and 200 a day by default), counted per person in `rate_limit_windows` once the agent will answer them. |
| `core/chatSettings.ts` | The chat agent's model as admins set it (`ChatService`'s Get, Set, Reset and TestChatConfig): checked as the install's are (`config.ts` `chatFrom`), the key sealed and write-only, back to the install's on reset, and unsaved settings tried with one question through the agent. |
| `chat/settings.ts` | The chat agent's settings in effect (`currentChat()`): an admin's (`chat_settings`) or the install's, read every 10 s and after a change; an admin's that can't be used turns chat off and says why. |
| `core/chatFeedback.ts` | Rating the chat agent's answers (`ChatService/RateAnswer`: up or down, with the question, the answer, its sources and a comment; your own team's) and listing them for admins (`ListChatFeedback`). |
| `chat/citations.ts` | The chat agent's citations: retrieved sections numbered as sources, an answer's citations kept only when they name one retrieved that turn, links built by the console, an answer citing nothing it found flagged. |
| `guideSearch.ts` | Searching the guides and reference docs: each cut into sections at its headings, ranked by BM25 (a heading's words three times; two words also tried as one), built once from the image's docs (`GuideService/SearchGuides`, the Docs page's search, the chat agent). |
| `core/orders.ts` | `OrderService` (decisions 23 and 25): the order builder (`planOrder`, no I/O): a cart of actions wired by wiring type; for a needed type, what the team already has offered, else its default provider added, or a shared type asked once; optional inputs suggested; ambiguities and cycles reported. `PreviewOrder` runs nothing; `PlaceOrder` runs a planned cart as one run for the team, each step as its action alone (`templates.ts`'s `runOrderSteps`). |
| `core/notifications.ts` | `NotificationService`: your inbox, and your teams' chat webhooks (members see, maintainers set, test and remove). |
| `core/resources.ts` | What runs made (`ResourceService`): who sees and deletes each resource, and deleting them by running their products' cleanup actions, newest first. |
| `core/runView.ts` | How much of a run a caller sees: its owners (admins, its submitter, a template run's team) every step; any other team's member only its own steps in full (the rest: state and failure codes). |
| `core/alerts.ts` | Observe's alerts: the charts' alerting rules as a Prometheus has them now (its `/api/v1/rules`, from `monitoring.prometheusUrl`; or, on GKE's managed Prometheus, the cluster's `Rules` and which fire from Google's query API), firing first; an instance about an API the caller can't see only counted. |
| `core/logs.ts` | Observe's log search over Loki, each query carrying the caller's visibility: a step's lines to its team, its INFO to anyone who may see its run, the platform's to admins. |
| `core/usage.ts` | Who ran what (`GetUsage`), from `submitted_executions`: runs counted for the teams they were run for (as `runView.ts` decides), by people, bots or schedules, readiness checks left out; the products their steps used; read at most once a minute per period, each caller shown their part. |
| `core/observe.ts` | Observe for everyone: the security checks (what this install enforces and doesn't yet, what the cluster refused this week, a run linked only for those who may see it, every image allowed to run and its scan), the metrics (from kernel-api's `GetStats`, each image named by its product, a hidden one only for its team), and the audit log as each caller may see it (`listAudit`). |
| `core/apis.ts` | API products: who sees each, whether it's live, held (its backend's host isn't allowed) or paused, and pausing one. |
| `core/apiAccess.ts` | Who may call each API (decision 26, the gateway's rule): its team, or a grant to a user or a group; requests for access, deciding them, grants and their rates, revoking, and the lists. |
| `core/approvals.ts` | Approvals: a maintainer of a step's team, never whoever ran it, approves or declines it; the steps awaiting one. |
| `core/retired.ts` | The shared "this team is retired, it's read-only" refusal. |
| **`rpc/`** | **The API**: Connect services from `proto/`, at `/api/vennir.console.v1.<Service>/<Method>`. |
| `rpc/server.ts` | Mounts every service on Fastify with `@connectrpc/connect-fastify`, resolving each call's caller from its bearer token. |
| `rpc/interceptors.ts` | Masking unexpected errors as `internal`, auditing every changing call (with the run it started), requiring a caller outside the public methods. |
| `rpc/errors.ts`, `rpc/context.ts`, `rpc/validate.ts`, `rpc/rateLimit.ts`, `rpc/convert.ts` | Connect errors with `Failure`/`Problem` details; the caller, log and request in the handler context; checking requests against REST's TypeBox schemas; fixed-window rate limits; timestamps. |
| `rpc/services/*.ts` | One file per service in `proto/vennir/console/v1/`, each mapping messages to and from `core/`. `execution.ts` also streams `WatchExecution` (re-reading and re-authorizing every 2 seconds). |
| **`auth/`** | **Who's calling.** |
| `auth/plugin.ts` | Checks every request's session or bot token and loads the caller's teams and admin flag. |
| `auth/oidc.ts` | Single sign-on (any OpenID Connect provider): the authorization code flow with PKCE, the ID token's checks, each account bound to its provider identity once, then its groups and mapped teams (`sso.ts`). |
| `sso.ts` | Single sign-on's settings in effect (the install's, else admins', read every few seconds); a person's groups (the ID token's claim, Google Workspace's Groups API); mapped teams following them at each sign-in. |
| `teamQuota.ts` | Each team namespace's ResourceQuota and LimitRange: its own limits (an admin's) or the install's, written with the namespace and on every policy resync. |
| `sealed.ts` | Values the console keeps and uses itself (webhook URLs, the SSO client secret), sealed with AES-256-GCM under a key derived from `JWT_SECRET` per purpose. |
| `sessionKeys.ts` | The Ed25519 key sessions are signed with, derived from `JWT_SECRET`, and its public half as a JWKS (`/api/auth/jwks`) for the gateway. |
| `auth/access.ts` | The authorization rules: who may act for a team, and see (any of its teams) or cancel (every team) an execution. |
| `auth/password.ts` | Password hashing (argon2), and the dummy check that makes failed logins take the same time. |
| `auth/apiToken.ts` | Bot and automation tokens (`mp_…`): generating and hashing them. |
| `auth/scopes.ts` | Platform-wide permissions for automation tokens (`teams:create`, `products:register`, …). |
| `auth/loginThrottle.ts` | Slows down repeated failed logins. |
| **`db/`** | **The console's Postgres.** |
| `db/schema.ts` | The tables: teams, users, memberships, tokens, products and releases, secret grants, submitted executions, wiring types. |
| `db/queries.ts` | Every database query the routes use. |
| `db/client.ts` | The database connection, and `whileHolding`: work one console at a time does under an advisory lock (the notifier's and callbacks' delivery passes). |
| `db/migrate.ts` | Applies migrations, creates the first admin and grants the gateway's role; run by the migration Job on deploy. |
| `db/connection.ts` | How every pool connects: `DATABASE_URL`, and with `DATABASE_IAM_AUTH` a short-lived token as each connection's password (gcp: its Workload Identity's; aws: `db/rds.ts`, an RDS token its role signs). |
| `awsSha256.ts` | SHA-256 for AWS's SigV4 signer: the Bedrock chat's requests and RDS tokens. |
| `db/gatewayAccess.ts` | The gateway's own database role: the columns it reads and its traffic counts, nothing else; created here on the console's own Postgres. |
| `db/bootstrapAdmin.ts` | Creates the first admin once: with the operator's password (vennir's, from a Secret, changed at the first sign-in), or a random one that is never printed (given one by `resetAdmin.ts`). |
| `db/resetAdmin.ts` | Gives an admin a new random password from inside the console's Pod (`vennir admin reset-password`): printed once, every session revoked, audited. |
| `db/migrations/` | The schema: `0000_initial_schema.sql` (every table at the first public release), then one SQL file per later change, generated by `npm run db:generate` (`0002_catalog_sync.sql`: the catalog release applied, and which teams and products it made; `0003_token_audiences.sql`; `0004_templates.sql`: templates, and which template a run came from; `0005_team_roles.sql`: maintainer or member; `0006_visibility.sql`; `0007_allowed_targets.sql`; `0008_retries.sql`; `0009_concurrency_keys.sql`; `0010_failure_help.sql`; `0011_approvals.sql`; `0012_apis.sql`; `0013_gateway_traffic.sql`; `0014_oidc_subject.sql`: each account's single sign-on identity; `0015_team_require_sso.sql`: a team requiring it; `0016_must_change_password.sql`; `0017_audit_chain.sql`: the audit log's hashes and its copy's progress; `0018_last_signed_in.sql`: each account's last sign-in; `0019_audit_broken_at.sql`: where the audit chain broke; `0020_resources.sql`: what runs made, and products' cleanup; `0021_notifications.sql`: notifications and teams' chat webhooks; `0022_plans.sql`: products' plan actions, for Preview; `0023_readiness.sql`: products' checks and their answers; `0024_schedules.sql`: teams' schedules; `0025_bot_identities.sql`: bots' keyless identities; `0026_examples.sql`: actions' examples, from their tests; `0027_email.sql`: notifications by email; `0028_drafts_and_template_examples.sql`: Compose's drafts, and templates' examples; `0029_sso_settings.sql`: single sign-on as admins set it, and groups mapped to teams; `0030_team_quota.sql`: a team's own resource limits; `0031_catalog_version.sql`: the catalog version applied; `0032_secret_store_identities.sql`: the cloud identity each team's SecretStores sign in as; `0033_alerts.sql`: refusals and platform alerts emailed by default; `0034_admin_channel.sql`: the team whose webhook gets admins' alerts; `0035_product_caps.sql`: products' maxRunning; `0036_product_capacity.sql`: products' capacity; `0037_team_owner.sql`: team.yaml's owner; `0038_ordering_bots.sql`: the templates each ordering bot may order; `0039_order_callbacks.sql`: ordering bots' callbacks, and what's waiting to be posted; `0040_order_rate_index.sql`: each submitter's runs by time, for an ordering bot's rate; `0041_team_callbacks.sql`: teams' outcome webhooks, a delivery to a bot or a team; `0042_wiring_type_teams.sql`: the team that defines each wiring type; `0043_resource_links.sql`: what each resource depends on, across runs, and deletes waiting for an admin; `0044_chat_feedback.sql`: how people rated the chat agent's answers; `0045_chat_settings.sql`: the chat agent's model as admins set it; `0049_stored_dag_field_names.sql`: stored submissions' old field names renamed; `0050_audit_copy_compare.sql`: the database compared with the audit copy; `0051_approval_teams.sql`: products' approval for some teams' runs; `0052_team_description.sql`: team.yaml's description; `0057_product_clouds.sql`: the clouds of the installs each product is for; `0060_unrecorded_runs_index.sql`: the runs the resource recorder has still to record, by time; `0061_chat_limits.sql`: the chat agent's questions per person, as admins set them; `0062_schedule_claims.sql`: a schedule's claimed time until it starts; `0063_lowercase_emails.sql`: accounts' emails lowercased; `0065_release_last_used.sql`: when each product release was last registered or run, for which keep their identity; `0066_user_self_registered.sql`: accounts that signed themselves up, their email unverified; `0067_membership_from_groups.sql`: memberships from before group tracking marked group-given; `0068_audit_reads.sql`: who read runs' outputs, logs and secret names; `0069_api_grants.sql`: each API's grants and requests for access, `access.requests`, and each person's single sign-on groups; `0070_api_grants_kept.sql`: grants and requests kept by their API's team and name while it's out of the release, and each person's full groups for the console alone; `0071_api_grants_away.sql`: when each grant's and request's API left the release, and why the platform revoked one; `0072_api_access_offered_groups.sql`: access changes emailed by default, and requests keeping only the groups their person offers; `0073_api_share_with_emptied.sql`: APIs' `share_with` emptied, grants alone letting others call); `meta/` is drizzle's bookkeeping. |

### `console/frontend/`: the web app

React 19, MUI, Vite, react-router. Its own `package.json`.

| Path | What it's for |
| --- | --- |
| `src/gen/` | Generated from `proto/` by `make proto` (JavaScript with type declarations); never edited. |
| `index.html`, `src/main.tsx` | The page and the app's entry point. |
| `src/App.tsx` | The routes; each page loads only when first opened. |
| `src/app.test.tsx` | The whole app over a fake console API: every page renders, Admin only for admins, the sign-in rules (signed out, single sign-on offered, a password to change first, an expired session), a retired team read-only. |
| `src/api.ts` | Every call to the backend, with its types: plain objects over the generated Connect clients (`src/gen/`), so pages never see the messages; and `errorMessage`, what a page says about a failure. |
| `src/catalogFile.ts` | GitHub's pages to create or edit a file in the catalog repository (proposing a template, a team's SecretStore). |
| `src/theme.ts`, `src/index.css` | MUI theme and base styles. `theme.ts` holds every color and the mono font as named tokens (`sidebar.*`, `code.*`, `fontFamilyMono`), plus the focus ring and reduced-motion rules. |
| `src/dagCheck.ts` | Checks a pasted DAG live on the Submit page (JSON or YAML) and explains what's wrong. Tested in `dagCheck.test.ts`. |
| `vitest.config.ts`, `src/**/*.test.ts` | The frontend's tests (`npm test`); a test that renders opts into jsdom. |
| `src/dagLayout.ts` | Arranges a DAG's tasks into columns for the execution graph. |
| `src/usageText.ts` | How usage reads, the same on Observe's Usage tab and the Teams page's cards ("No team", "itself", who started runs). |
| `src/time.ts` | Durations and times as people say them ("8m 05s", "today 14:02"), a schedule's next run in its own time zone ("02:00 New York time") and the viewer's, and a clock that ticks while something runs. Tested in `time.test.ts`. |
| `src/statusColor.ts` | Each state's color and label, shared by the status chips and the home charts. |
| `src/runningNow.ts` | What a run is doing now ("app-hosting.create, attempt 2 of 3"), for Home's Running now and the Runs list. Tested in `runningNow.test.ts`. |
| `src/auth/` | The signed-in user (`AuthContext`), the guard that sends signed-out visitors to the login page, and where signing in goes back to (`returnTo`). |
| `src/layout/` | The sidebar (the install, the places, your account and its settings menu; a top bar opens it on a phone), and `SignInLayout`, the screens before it (signing in, registering, choosing your own password). Old addresses (`/executions`, `/run`) redirect in `App.tsx`. |
| `src/environment.tsx` | The install's public settings (its label, open registration, single sign-on), fetched once for the whole app. |
| `src/components/` | Shared pieces (`Pill`, the tinted label every state and status uses; `ErrorPage`: not found, admins only, and the error boundary around each page; `CodeBlock`: commands and snippets with a copy button): tables, page headers, status badges, metric cards, team cards, empty states, a load that failed (`LoadFailed`: what couldn't be loaded and why, with Try again, never shown as an empty list), confirm dialogs, inline monospace (`Mono`), `HelpLink` (a link into a guide's section, which page headers and empty states take). |
| `src/pages/HomePage.tsx` | Home: what needs you (approvals, an admin's waiting deletes, schedules that didn't start), what's running for you and your teams, how your last two weeks went, what your runs made, products not ready, what's new in the catalog, your cart and latest draft, schedules coming up, your teams' APIs, notifications, Ask, and for an admin the install at a glance. |
| `src/components/Panel.tsx`, `src/components/CheckStrip.tsx`, `src/components/ReadinessNote.tsx` | A page section as a card with its heading and link; a plan's checks in a line (the cart, Compose, the Catalog's cart); a card's note when a product isn't ready here, its check failed, or it's deprecated. |
| `src/components/QuickTile.tsx` | A count that's also a filter (pressed while it filters): the Runs list's week and What runs made's states. |
| `src/layout/NotificationBell.tsx` | The bell (the sidebar, or the top bar on a phone): how many notifications are unread, the newest, opening one goes to what it's about. |
| `src/pages/team/WebhookSection.tsx` | A team's chat notifications on its Settings tab: its webhook's host and state; maintainers set, test and remove it. |
| `src/pages/team/OutcomeWebhookSection.tsx`, `src/components/SignedCallback.tsx` | A team's outcome webhook on its Settings tab, and the signed callback editor it shares with an ordering bot's card (Automation): where it posts, its last post, a new URL or secret, the secret shown once. |
| `src/components/ReadinessPill.tsx` | Whether a product is ready on this install (its check): Ready, Not ready, Check failed, Checking or Not checked yet, with what's missing on hover. |
| `src/pages/catalog/ScheduleDialog.tsx`, `src/pages/team/SchedulesTab.tsx` | Scheduling a run from its form (when, time zone, the team's bot), and a team's schedules on its Schedules tab (pause, delete, last start). |
| `src/pages/ComposePage.tsx`, `src/compose.ts` | Compose (`/catalog/compose`): a template built from shared actions, inputs wired by type (`x-vennir-needs`, `x-vennir-provides`), proposed to the catalog as a file (GitHub's new-file page) or run now when it's all the person's team's. |
| `src/pages/useComposeDrafts.ts` | Compose's drafts, kept by the console for their team: saved a second after a change, each save naming the version before it; a rename moves the draft; a conflict waits for the person; drafts a browser kept move over. Tested alongside. |
| `src/pages/team/KeylessSection.tsx` | A bot signing in from CI with no token, on its Automation card: its identities, adding one (GitHub Actions, GitLab), the job's snippet. |
| `src/pages/team/TeamOffers.tsx` | A team as anyone signed in sees it (its page, for those not in it; its members' What it offers tab): where to ask it, and its templates, actions and APIs, with sharing and readiness. |
| `src/pages/account/EmailSection.tsx` | Preferences' Email card: which notifications come by email too (when the install sends email). |
| `src/components/PreviewResult.tsx` | What a preview run says each step would do (its plan action's summary and changes), followed until it finishes; on the run form and an approval. |
| `src/layout/sidebarTip.ts` | The collapsed sidebar's names on hover, light on the dark column. |
| `src/layout/ChatLauncher.tsx`, `src/layout/ask.ts`, `src/components/ChatPanel.tsx`, `src/components/ProposedCartLines.tsx` | Ask, for every page to open (`useAsk`: the help's buttons too), in the sidebar (the top bar on a phone), off and saying who turns it on when there's no model: the chat panel, its answers' sources linked, design history labelled, what it's doing shown as it goes, a cart it proposes (`ProposedCartLines`: each step's team, product, verb and wiring, as planned) opened in the Cart, a new conversation when one fills the model's window, each answer rated up or down (a wrong one with what was wrong) for the admins. |
| `src/pages/CartPage.tsx`, `src/cart.ts` | The cart (`/catalog/cart`, decision 25): actions added from the Catalog (kept in this browser), planned together for one of your teams by `PreviewOrder` (what's added, what you already have to choose from, what's suggested, what you fill in), and placed as one run (`PlaceOrder`). |
| `src/pages/DeleteRequests.tsx` | What runs made's "Waiting for an admin": deletes refused because other resources used them, approved or denied by an admin. |
| `src/pages/ResourcesPage.tsx`, `src/components/ResourceTable.tsx` | What runs made (`/runs/made`): every resource your teams' runs (and yours) reported, searchable, kept after the runs are gone, with Delete where its product says how. |
| `src/pages/ExecutionsListPage.tsx`, `src/pages/run/RunsSchedules.tsx` | Runs (`/runs`): every run you can see, a page at a time (yours, or by team and name, filtered on the server), each with what it ran, its steps' progress and how long it took; the week's tiles; the steps waiting for your team to approve; and every one of your teams' schedules (`RunsSchedules`). |
| `src/pages/useExecutionWatch.ts` | Follows one execution over `WatchExecution` until it finishes, with its events and logs; reopens a stream that ends or drops, backs off when it can't connect; `resume()` after a retry or cancel. Tested alongside. |
| `src/pages/SubmitExecutionPage.tsx` | Paste or write a DAG, with live checking. |
| `src/pages/ExecutionDetailPage.tsx`, `src/pages/run/` | One run: who started it and from what, what an order's cart held and chose (`OrderCart`), its steps against time (`RunTimeline`), why it failed (`FailureCard`, `FailureHelp`), its steps in order (`RunSteps`), what it made (`WhatItMade`, with Delete all), who asked for it and ran it (`WhoActed`), and the chosen step (`StepPanel`: its approval, attempts, outputs, inputs, logs (`StepLogs`), definition); retry, approve, cancel, run again. |
| `src/pages/ProductsPage.tsx` | The product registry, by platform, with releases. |
| `src/pages/ObservePage.tsx`, `src/pages/observe/` | Observe, a tab per file (`?tab=`): the security checks (what's enforced, what was refused this week by the cluster, the catalog or the gateway, every image that may run and its scan), the metrics (with `AlertsCard.tsx`, the install's alerts), usage by team or by product (`UsageTab.tsx`), log search (`LogLines.tsx` draws the lines, for an API's page too), and the audit log (with its write-once copy's progress). |
| `src/pages/ApisPage.tsx`, `src/pages/ApiPage.tsx`, `src/pages/api/`, `src/pages/team/ApisTab.tsx` | API products: every one you may see (your teams', ones you may call, not granted to you; You may call: your own access and requests, `MyAccess`), and one API's page: its endpoints and how to call them for anyone who may see it; for its own team, each endpoint's traffic, its callers and what was blocked, what its api.yaml says, pausing it, its backend's logs (`ApiLogs`), and who may call it (`WhoMayCall`: requests, the access list). Anyone else sees their own access to it (`YourAccess`: request, withdraw, give up); `access.tsx` holds what these share (the request dialog, the confirm step for revoke, withdraw and rates). The team's APIs tab lists grants kept for an API away from the release. Its curl example quotes the URL as one shell word (`shellWord`, tested against a real `sh`). |
| `src/pages/team/BotApiAccess.tsx` | A team's Automation tab: each bot's grants to other teams' APIs and its requests; asking for a bot, withdrawing, revoking. |
| `src/pages/TeamsPage.tsx`, `TeamPage.tsx` | Your teams (an admin, every team), and one team's page: its tabs, the chosen one in the address (`?tab=`). |
| `src/pages/team/` | The Team page's tabs: members, secrets (adding one, connecting a cloud source, a SecretStore's stored credential in `StoredCredential.tsx`), automation (bots), running tasks. `providers.ts` describes each secret provider for the "Connect a source" wizard. |
| `src/pages/team/SettingsTab.tsx`, `QuotaSection.tsx` | A team's Settings: requiring single sign-on (and who it would lock out), its resource limits (admins set them), where the team comes from, and for an admin retiring, restoring and purging it. |
| `src/pages/CatalogPage.tsx` | The Catalog (`/catalog`): every template and action, as cards: what each asks for, Run, or, when it isn't shared with you, Ask for access; by team, and only what you can run. |
| `src/pages/RunFormPage.tsx`, `src/pages/catalog/FieldInput.tsx`, `src/schemaForm.ts` | Running one (`/catalog/run?template=` or `?action=`): a form from its schema (text, numbers, yes/no, choices, lists, name/value pairs, JSON; checked on each field before sending; ordered and grouped by its form hints), which of your teams it's for, and what will run. |
| `src/pages/AdminPage.tsx`, `src/pages/admin/` | Admin (admins only), in sections down the side (`/admin/<section>`; the old `?tab=` addresses lead to theirs), each opening with what it does, what's set here and what the install sets, and its part of `16-admin-settings.md`; each with its state beside its name, read once for the page by `summary.ts` (the cards' shared pieces are in `parts.tsx`). Install: Overview (the install's figures, what needs an admin, getting a new install ready, every part with its state and where it's set, `InstallCards.tsx`). People and access: People (how people sign in, adding them, everyone with how they sign in and when they last did, admin rights, password resets, deletes), Single sign-on and groups (the provider and groups mapped to teams, `SsoCard.tsx`), Automation tokens. Catalog and images: Catalog (the release, its signature, adopting a team), Image sources (`/admin/images`), Image scans (every digest's verdict and findings, rescanning one, accepting a failure with a reason). Integrations: API gateway (its traffic, its settings, closing it, what it refused at the door), Chat agent (its model, provider, key and limits in place of the install's, tried before saved, `ChatSettingsCard.tsx`; how many questions each person may ask, `ChatLimitsCard.tsx`; and how people rated its answers, `ChatTab.tsx`), Admins' alerts (the team whose chat webhook gets them). Security and audit: Cluster policies (the ones the console writes, the kernel chart's, what the cluster refused today), Audit log copy (`/admin/audit`). |
| `src/pages/AccountPage.tsx`, `ChoosePasswordPage.tsx`, `src/components/PasswordChangeForm.tsx` | Preferences (`/account`): who you are, how you sign in (a password to change, or single sign-on), your teams; and the screen a password someone else set holds you on until you choose your own. |
| `src/pages/DocsPage.tsx`, `ApiReference.tsx`, `src/pages/docs/` | The docs: the guides from `console/docs/`, the platform's own docs copied into `console/docs/reference/`, and the API reference (from `src/gen/api-reference.json`, which `make proto` writes from the protos), as one set. A home with where to start; the contents down the side nested three deep, in categories, docs and groups that open and close; a long doc a section to a page (`/docs/<doc>/<section>`, its headings a level up), and a link to any heading in it opening the page it's on; each page with its trail, its sections beside it and the next one to read at its foot. `docs/contents.ts` places each doc and each section of a long one, in reading order (its test fails while one the console serves isn't placed), and turns the repository's links between docs into links here; `docs/Figure.tsx` shows the figures the docs draw, and opens them at full size.
| `src/pages/LoginPage.tsx`, `RegisterPage.tsx` | Sign-in and registration. |
| `public/favicon.svg` | The browser tab icon. |
| `vite.config.ts`, `tsconfig*.json` | Build settings. |

### `console/docs/`: the in-console guides

Shown on the console's Docs page, in file order. They ship inside the console image.

| File | Guide |
| --- | --- |
| `01-getting-started.md` | Try Vennir end to end: a platform, a product, a DAG. |
| `02-sync-secrets-gcp.md` | Syncing secrets from GCP Secret Manager. |
| `03-what-is-a-dag.md` | DAGs, `dependsOn` and `$fromTask`. |
| `04-secrets-explained.md` | How secrets stay locked to one product. |
| `05-calling-the-api.md` | Calling the API from a pipeline with a bot token. |
| `06-database-schemas.md` | Every table in both databases. Tests in both projects keep it in step with the code. |
| `07-how-data-moves.md` | One real value followed from one task to the next. |
| `08-under-the-hood.md` | Every unusual use of Kubernetes, Helm and Postgres, and why. |
| `09-runs-explained.md` | A run's states, retries, cancelling, approvals, every failure code, limits, retention and logs. |
| `10-ordering-and-the-cart.md` | The Catalog: readiness, running a template, previews, approvals, the cart, composing, schedules, what a run made. |
| `11-apis.md` | API products: finding one, access, calling it through the gateway, its errors, traffic, pausing, backends' logs. |
| `12-observe.md` | Observe: security checks, scans and SBOMs, metrics, logs and who sees them, the audit log and its copy. |
| `13-teams-and-roles.md` | Teams, members, maintainers and admins, single sign-on groups, team settings, retiring and purging. |
| `14-bots-and-automation.md` | Bots and their tokens, keyless CI sign-in, ordering bots, signed callbacks, outcome webhooks, notifications, schedules. |
| `15-troubleshooting.md` | By symptom: a failed run, a refused submission or image, a waiting step, a missing secret, sign-in, the catalog. |
| `16-admin-settings.md` | Every Admin section: what it does, what it affects, and whether it's set here or by the install. |
| `17-onboarding.md` | Onboarding, start to finish: install, the catalog, a team, a first product, then a cloud ready for products and a first real resource. |
| `18-where-to-host.md` | Where to host Vennir: kind, GKE, EKS or an existing cluster, compared, and what changes for teams by host. |
| `19-deploy-to-gcp.md` | Deploy to Google Cloud: each product's principal, the APIs, its roles (and the organization's side: a folder and billing for the projects it creates), the runtime account and team secrets, readiness, running and cleaning up; from outside GKE. |
| `20-deploy-to-aws.md` | Deploy to AWS: a role per product through EKS Pod Identity, other accounts, readiness, running and cleaning up; from outside EKS. |
| `21-api-gateway.md` | The API gateway, start to finish: turning it on, publishing each kind of backend, calling it, putting it on the internet, running it. |
| `22-addresses-and-firewalls.md` | Addresses and firewall rules: which address each part uses, finding them, identity instead of allowlists, and a fixed outbound address. |
| `23-deploy-to-azure.md` | Deploy to Azure: a managed identity per product, trusting the cluster's tokens (AKS's webhook, or the team secret elsewhere), its roles, private registries, running, Key Vault, APIs. |
| `24-every-cloud-from-any-install.md` | Creating resources in every cloud: the identity model, who sets up what, which way in by host and target, each cloud's permission structure (GCP folders for projects), the setup from GKE. |
| `lab-1-laptop.md` … `lab-7-apis-across-clouds.md` | The hands-on labs, each with its goal, time, cost, checks and clean up: Vennir on kind and a first product (free), then on GKE with a catalog, Google Cloud projects under a folder, AWS and Azure from a GKE install, and APIs on every cloud through the gateway (billed). |
| `reference/` | The platform's own docs, copied from the repository (`SOURCES` lists them; `make console-docs`, `.github/scripts/console-docs.sh`): the Docs page's reference, and what the chat agent answers from; `reference/architecture/` holds the figures they draw (`docs/architecture/*.svg`). `test/docs.test.ts` fails while a copy differs. |

### `console/test/`

Run against a real, migrated Postgres (`execution_console_test`).

| File | What it covers |
| --- | --- |
| `auth.test.ts`, `accounts.test.ts` | Sign-in, sessions, password changes and resets, login throttling. |
| `executions-auth.test.ts` | Who may submit what: teams, identities, team secrets, images, `requestId`. |
| `kernel-client.test.ts` | The kernel-api client against a KernelService of its own: the projected token, re-read on every call; the answers and refusals it maps; refusing field names the console didn't check. |
| `product-policy.test.ts` | The identity policy's products and team secrets: their entries, and that every change rewrites them; with the kernel writing the releases (`catalogPolicy`), the secret names alone. |
| `identity-policy-shape.test.ts` | The identity policy's two shapes as the console reads them: matching releases, or (with `catalogPolicy`) none, its maps inert. |
| `product-ownership.test.ts` | One team per product name and image repository, kept after deletion until an admin releases it. |
| `templates.test.ts` | Templates: what a consumer may run, the DAG built from products, parameters against the schema, sharing and on whose behalf, unshared steps, actions alone, a consumer's rights over their run, reruns. |
| `orders.test.ts` | The order builder: a cart wired by type, a default provider added, a shared type asked once, a choice left to the person, a cycle; and `PreviewOrder`'s checks (its team's members, no ordering bot, only shared actions). |
| `token-audiences.test.ts` | A product's token audiences: the cluster's own refused at registration, file names, what's stored. |
| `catalog-sync.test.ts` | Applying a catalog release: what it makes, what it drops, a failed item, a bad signature, teams it didn't make, the API; the stored credential. |
| `team-members.test.ts`, `team-lifecycle.test.ts` | Membership, retiring and purging teams. |
| `team-namespaces.test.ts` | The console creating, relabelling and deleting team namespaces, and applying SecretStore files: what reaches Kubernetes, and who may. |
| `image-scans.test.ts`, `scan-job.test.ts` | Reading Trivy's output, verdicts per digest (every platform scanned), what a failed scan blocks, an admin accepting one, idling the scanner and waking it for a scan; the scan Job's container per platform. |
| `registry-ecr.test.ts` | ECR's credential from the console's own AWS identity: fetched, sent as ECR's Basic challenge asks, kept for its lifetime. |
| `registry-acr.test.ts` | ACR's credential from the console's own Entra identity: Workload Identity's token exchanged at Entra, then at the registry for a refresh token, kept. |
| `client-ip.test.ts` | Who the client is behind a load balancer: only trusted proxies' X-Forwarded-For counts. |
| `activity.test.ts` | Recording the console's last use: signed-in requests only, once a minute at most. |
| `audit.test.ts` | What the audit log records (a change, a refusal) and never records (secret values; reads; sign-in and passwords). |
| `audit-reads.test.ts` | Who read what, through the API: each recorded read's target and never its content (a run, a watch, events, logs, a log search, resources, an order's plan, secrets and stores), a hidden step not recorded as read, the same read recorded once a window, a failed write logged with the read still answered, the chat agent's reads as the person's, admins alone listing them (and that recorded); pruning them is in `retention.test.ts`. |
| `audit-visibility.test.ts` | Who sees which audit entries in Observe: admins all; anyone else their own, and those about their teams and runs; filters within that. |
| `policy-sync.test.ts`, `retention.test.ts` | The policy resync and its reported outcome; what retention deletes and keeps. |
| `automation-tokens.test.ts` | Automation tokens and their scopes. |
| `image-policy.test.ts`, `registry.test.ts` | Allowed image sources; the registry check. |
| `product-releases.test.ts`, `product-catalog.test.ts` | Product registration, releases, full descriptions, wiring types. |
| `docs.test.ts`, `schemaDoc.test.ts` | The guides load and link correctly; the database guide matches the schema. |
| `jsonSchema.test.ts` | What a schema refuses, in its own words (a pattern's `x-vennir-pattern-message`) or ajv's. |
| `secrets.test.ts` | Registering and revoking secrets: other teams refused, names Kubernetes would refuse, a Secret the console didn't create. |
| `external-secrets.test.ts` | A synced secret's ExternalSecret: created labelled, only the console's own replaced, one made elsewhere never replaced or adopted. |
| `gateway-token-policy.test.ts` | The gateway token policy's audiences: what each backend.auth needs, held APIs and retired teams left out, the sixteen maps and their size limit. |
| `apis.test.ts` | API products from releases (with their ServiceAccounts), who sees and may call them, held backends, pausing. |
| `api-access.test.ts` | Who may call an API (team, user and group grants), requests (open, approval, closed), deciding, granting, rates and revoking, by whom; bots, retired teams, the lists, audit and notifications. |
| `approvals.test.ts` | Which steps wait for an approval (`always`, `otherTeams`, a list of teams, a target rule), and who may decide. |
| `registry-federation.test.ts` | The STS exchange, impersonation, caching and the Docker config handed out. |
| `registry-federation-aws.test.ts` | The same for Amazon ECR: assuming the owner's role by web identity, ECR's token as that role, caching to the session, STS's refusal, image checks and the Docker config. |
| `usage.test.ts` | Usage: runs counted for the team they were run for, by people, bots or schedules, readiness checks left out; what each caller sees (their teams, their products' users, a hidden product named only for its team). |
| `observe.test.ts` | The security checks: what's enforced, refusals linked only for those who may see the run, images (a hidden product's for its team); the metrics, named by product, a hidden one's only for its team. |
| `logs.test.ts` | The LogQL the log search sends (a stand-in Loki records it): each caller's visibility, names checked, typed text quoted; LOGS_OFF. |
| `metrics.test.ts` | The console's Prometheus metrics: calls counted by procedure and code, served on their own port and not on the console's. |
| `log-levels.test.ts` | A step's log lines by level: INFO for everyone who can see the run, the rest for its team. |
| `audit-chain.test.ts` | The audit log's hash chain: each entry follows the one before; a changed, removed, inserted or unhashed entry breaks it. |
| `audit-copy.test.ts` | The audit log's copy as Observe shows it: off, how far it has gone and what's waiting, the bucket for admins only, and the entry where a forged one broke the chain. |
| `bootstrap-admin.test.ts` | The first admin: a generated password is never printed and must be changed, an operator's isn't unless asked, an existing account is left alone. |
| `write-fence.test.ts` | The write fence's check: in force only failing closed, checking something, and bound to deny. |
| `run-view.test.ts` | Who sees what of a run across teams: the consumer and submitter everything, a provider's member their own steps in full and only codes of the rest (details, events, logs); a raw DAG likewise for each of its teams, in full for its submitter and admins. |
| `password-change.test.ts` | A password someone else set: nothing but changing it until then (an admin's own reset and single sign-on aren't held back). |
| `team-quota.test.ts` | Teams' resource limits: the install's for a new team, an admin's own written at once and undone, refused to others and for what isn't a quantity, every team's on resync. |
| `sso.test.ts`, `oidcProvider.ts` | Single sign-on as admins set it: admins only, the secret sealed and unsent, issuers checked, an install's provider read-only, signing in following the saved settings, mapped teams following the claim's and Google Workspace's groups (and untouched when they can't be read), manual edits refused; the stand-in provider it signs in against. |
| `oidc.test.ts` | Signing in with single sign-on against a stand-in provider: new accounts, binding an existing one once, every refusal (domain, unverified email, signature, nonce, state); a team requiring it refusing its members' passwords and password sessions, admins exempt, nothing while it's off. |
| `reset-admin.test.ts` | Resetting a lost admin password: printed once, sessions revoked, audited, admins only. |
| `config.test.ts` | Startup settings: a short `JWT_SECRET` refused, keyless bots off with no audience to check. |
| `execution-list.test.ts` | The execution list, a page at a time: every row once, only the caller's, server-side filters. |
| `access.test.ts` | The authorization rules in `auth/access.ts`. |
| `security-headers.test.ts` | The browser security headers (CSP and others) on pages and errors. |
| `chatTasks.ts` | Ordering tasks for the chat agent, judged by what it did: the tools it used, in order; the cart it proposed, or that it proposed none; what it must say. And `OFF_TOPIC`, questions it must refuse. Scored with the question set by `scripts/chat-eval.ts`. |
| `docQuestions.ts` | The question set: questions as people ask them, each with the sections that answer it. `docs.test.ts` holds the search's retrieval at 90% or more of them; the chat agent's answers are scored against them. |
| `rpc.ts` | Calling the Connect services as JSON through `app.inject`, and reading their error details. |
| `groupSettingsLock.ts` | A Postgres advisory lock the files that change single sign-on's settings or rely on kept groups (`sso.test.ts`, `api-access.test.ts`) hold for their whole run, so they never run at once on the shared test database. |
| `wiringTypesLock.ts` | A Postgres advisory lock the tests that read or replace the install-wide wiring types hold, since test files run in parallel. |
| `rpc-*.test.ts` | Each Connect service (auth, users, tokens, admin, secrets, products, teams, executions): who may call it, its refusals as Connect codes and details, and requests checked against their schemas. |
| `api-reference.test.ts` | The generated API reference marks exactly the public methods, and documents every service and method. |

## `gateway/`: the API gateway

| Path | What it's for |
| --- | --- |
| `cmd/gateway/main.go` | Reads its settings, the published APIs (every few seconds) and serves: inside the cluster, optionally a public listener, and metrics. |
| `internal/gateway/` | The request path: the API, paused or held, who's calling, whether they may call it (`accessFor`: their team, or a grant to them or a group of theirs; `grants_test.go`), size, the spec (404 when not in it, 400 when unfit, `problems.go` saying each field and the rule it broke, never the value), their team's or grant's rate, then forwarded with the backend's credential and a signed `Vennir-Caller`, the answer streamed back. |
| `internal/auth/` | Signing callers in as the console does: session JWTs (checked with the console's public key, fetched from its JWKS: `keys.go`) and bot tokens, against its database; a person's single sign-on groups, and whether they count now. |
| `internal/store/` | The published APIs from the console's `apis` table, and their active grants (`api_grants`), each with its OpenAPI validator and endpoints, and why one can't be served (written to the console's `api_problems`); whether an admin closed the gateway; the backend host rule. |
| `internal/credentials/` | Signing a forwarded request in to its backend, from the API's own ServiceAccount: its token (TokenRequest), a Google ID token (federated at Google's STS, then generateIdToken), or AWS SigV4 (AssumeRoleWithWebIdentity); each kept for most of its life. |
| `internal/traffic/` | Counting each API's requests a minute at a time (team, endpoint, outcome) and adding them to the console's `api_traffic`. |
| `internal/caller/` | The `Vennir-Caller` header (an EdDSA JWT) and its public key at `/.vennir/jwks.json`. |
| `internal/limits/` | A token bucket per API and calling team. |
| `internal/config/` | Its settings, checked at startup. |
| `internal/dbauth/` | Signing in to a managed database as itself (the kernel's, copied: the projects share no code): an RDS token, or on GKE a Google token federated from its own ServiceAccount token, since its NetworkPolicy keeps it from the metadata server. |
| `Dockerfile` | One static binary on distroless, cross-compiled on the builder's platform. |

## `helm/`: Kubernetes packaging

`helm/charts/` holds the two charts; each chart's `values.yaml` has neutral defaults. `helm/values/` holds each cluster's own settings.

### `helm/charts/execution-kernel/`

| Path | What it's for |
| --- | --- |
| `Chart.yaml`, `values.yaml`, `.helmignore` | The chart, its defaults (with resource requests), and what to leave out. |
| `sizes/{minimal,resilient,scaled,auto}.yaml` | The size presets: copies, step caps and default step size, retention, the database volume. |
| `templates/autoscaling.yaml` | kernel-api's HorizontalPodAutoscaler (`auto`), and PodDisruptionBudgets for whatever runs two or more copies. |
| `templates/sleeper.yaml` | Sleeping when idle: the sleeper's CronJobs, its narrow identity (replica counts of named Deployments only, and an admission policy that lets it only suspend, resume and reschedule its CronJobs), and the ConfigMap of counts to wake to. |
| `templates/step-headroom.yaml` | Warm headroom: low-priority placeholder Pods the size of a default step, and their PriorityClass. |
| `templates/kernel-api-deployment.yaml`, `kernel-api-service.yaml` | kernel-api, reachable only inside the cluster. |
| `templates/monitoring.yaml` | Monitoring (`monitoring.provider`): a PodMonitor (operator) or PodMonitoring (google) for kernel-api and the scheduler, and alerts (scheduler down or failing, steps waiting) as a PrometheusRule, Rules, or a rule file for the console chart's bundled Prometheus. |
| `templates/kernel-scheduler-deployment.yaml` | kernel-scheduler. |
| `templates/postgres-*.yaml` | The kernel's Postgres: Deployment, storage, Service, and (with `tls`) its `pg_hba` accepting only TLS from the network. |
| `templates/tls.yaml` | TLS inside the cluster (`tls`): a CA of the release's own, made once and kept, and the certificates it signs for Postgres and kernel-api; the CA alone in `-tls-ca` for clients, the console's included. |
| `templates/migration-job.yaml` | Runs database migrations before an upgrade (a Helm hook); with the bundled Postgres, first makes the kernel's own login role (`postgres.auth.kernelUsername`) and hands it the kernel's database, as the superuser. |
| `templates/backup-cronjob.yaml` | Scheduled database backup (both databases when they share the instance) to GCS, S3, Azure Blob or a volume. |
| `templates/configmap.yaml`, `secret.yaml`, `serviceaccount.yaml` | Settings, the database password, the kernel's identity. |
| `templates/rbac.yaml` | What the scheduler may do: create and delete Jobs and ConfigMaps, read Pods; and its logs-only ClusterRole, bound per team namespace by the console (or cluster-wide, `rbac.schedulerLogs: cluster`). |
| `templates/dispatch-policy.yaml` | Admission policy: the scheduler may only create Jobs (hardened) in namespaces labelled `vennir/team=true`, and delete only its own Jobs and ConfigMaps there. |
| `templates/step-jobs-policy.yaml` | Admission policy: in a team namespace, only the scheduler (and Kubernetes' own controllers) may create or change a Job or ConfigMap named `ek-`. |
| `templates/step-pods-policy.yaml` | Admission policy: in a team namespace, only Kubernetes' own controllers may make or change a Pod with a task Job's labels or owner. |
| `templates/image-policy.yaml` | Admission policy: task images only from allowed sources (the console edits the list). |
| `templates/image-signature.yaml` | With Sigstore's policy-controller: only signed images from the source registry run in team namespaces, checked on Pods; a second policy passes the workloads that make them. |
| `templates/purge-policy.yaml` | Admission policy: only the purge identity may delete a team's namespace, or its API backends' namespace, and only a retired one. |
| `templates/networkpolicy.yaml` | Only the release's Pods (and the console) may reach Postgres; only the console may reach kernel-api; `kernel policy`'s metrics port only from `metricsFrom`. |
| `templates/identity-policy.yaml` | Admission policy: a step runs as `default` with no Secrets, or, running one of its registered product's released digests, as the product's ServiceAccount with only its team's Secrets. The console keeps its released digests current; with `catalogPolicy` it holds each team's secret names alone, the kernel's `catalog-policy.yaml` holding the digests. |
| `templates/catalog-policy.yaml` | With `catalogPolicy` (a signed catalog): `kernel policy`'s Deployment, ServiceAccount and RBAC (update on its two policies, by name, only), and those policies: a step runs a digest the catalog's verified release names as its product's ServiceAccount and token audiences, or as `default` with no Secrets and no tokens; the gateway mints an API's ServiceAccount only the audiences its `api.yaml` needs. Seeded on upgrade from the console's. |
| `templates/scan-policy.yaml` | Admission policy: a step's image must be pinned by digest, and a digest that passed its security scan (the console keeps that list, pruned to the digests in use). |
| `templates/console-database.yaml` | With `postgres.consoleDatabase` on: the console's database and login role on the kernel's Postgres, the gateway's own role, their connection Secrets, and the Job that creates them, so one instance serves both. |
| `templates/_helpers.tpl`, `NOTES.txt` | Shared template snippets; the message shown after install. |

### `helm/charts/execution-console/`

| Path | What it's for |
| --- | --- |
| `Chart.yaml`, `values.yaml`, `.helmignore` | The chart and its defaults. |
| `sizes/{minimal,resilient,scaled,auto}.yaml` | The size presets: copies and retention. |
| `templates/autoscaling.yaml` | The console's HorizontalPodAutoscaler (`auto`) and its PodDisruptionBudget from two copies. |
| `templates/logs.yaml`, `files/alloy.alloy` | Log search (`logs`): one Loki (a volume or a bucket) and Grafana Alloy collecting steps' and the platform's Pods with credentials redacted; only Alloy and the console reach Loki. |
| `templates/monitoring.yaml`, `files/grafana-dashboard.json` | Monitoring (`monitoring.provider`): a PodMonitor or PodMonitoring for the console and gateway, alerts (calls failing, sign-in bursts, the catalog not applying, backends unreachable) as a PrometheusRule, Rules or a rule file, and Vennir's Grafana dashboard as a ConfigMap. |
| `templates/prometheus.yaml` | The bundled Prometheus (`monitoring.provider: bundled`): one StatefulSet with a volume, finding this namespace's Vennir Pods through a Role, both charts' alerts, reachable by nothing (port-forward). |
| `templates/ingress.yaml` | Reaching the console from outside the cluster (HTTPS only), for the catalog's CI: the certificate from the cloud, a Secret, or cert-manager (an issuer of yours, or Let's Encrypt through the chart's own Issuer); plain HTTP refused for known controllers. With `trustProxy`, the console believes the load balancer's X-Forwarded-For. |
| `templates/httproute.yaml` | The same through a Gateway (`gatewayApi`): an HTTPRoute on its HTTPS listener, and a redirect from its HTTP one. |
| `templates/activity.yaml` | The ConfigMap the console records its last use in (for the kernel's sleeper), and the Role that lets it update that one. |
| `templates/deployment.yaml`, `service.yaml` | The console, and how it's reached (LoadBalancer on GKE, port-forward on kind). |
| `templates/postgres-*.yaml`, `migration-job.yaml`, `backup-cronjob.yaml` | Its own Postgres, migrations and backups. |
| `templates/tls.yaml` | With its own Postgres and `tls`: that Postgres's CA and certificate, made once and kept. |
| `templates/networkpolicy.yaml` | The console's metrics port only from `metricsFrom`; when it runs its own Postgres, only this release's Pods may reach it. |
| `templates/write-fence-policy.yaml` | Admission policy: the console may write Secrets, ServiceAccounts, Roles, RoleBindings and ExternalSecrets only in team namespaces. |
| `templates/gateway.yaml` | The API gateway (`gateway.enabled`): its Deployment and Service, its signing key (generated once, kept), its one RBAC verb (ServiceAccount tokens), the admission policy limiting that to `*-api` ServiceAccounts in team namespaces, each for only the audiences its published API needs (literals the console keeps, `gatewayTokenPolicy.ts`), its egress (anywhere but the cloud metadata server, by default) and ingress (its metrics port only from `metricsFrom`), and an Ingress for its public listener. |
| `templates/console-jobs-policy.yaml` | Admission policy: the only Jobs the console may run are its image scans and catalog verifications, as `k8s.ts` builds them (the scanning identity with no token, this release's Trivy or cosign image, only the pull Secret, non-root, nothing from the node), in its own namespace. |
| `templates/namespace-policy.yaml` | Admission policy: the console may only create namespaces labelled a team's, or a team's API backends' (`<team>-apis`, `vennir/api-backends`), never both, and change that one label on one, never on kube-* or protected ones. |
| `templates/scanner.yaml` | The Trivy server image scans run against, the scan Jobs' ServiceAccount (no token) and the Role that lets the console run them in its own namespace and idle the server (its replica count only). |
| `templates/configmap.yaml`, `secret.yaml`, `serviceaccount.yaml` | Settings, generated secrets (kept across upgrades), the console's identity. |
| `templates/rbac.yaml` | What the console may do in Kubernetes: create ServiceAccounts, write Secrets and ExternalSecrets, write one RoleBinding per team namespace (the scheduler's logs; the write fence allows no other) and delete older consoles' Roles and RoleBindings, edit the image and identity policies; read namespaces, SecretStores and Pods. |
| `templates/_helpers.tpl`, `NOTES.txt` | Shared snippets; post-install message. |

### `helm/tests/`

| Path | What it's for |
| --- | --- |
| `secrets-e2e.sh` | A team's secret end to end on a kind install (`make kind-e2e-secrets`): a SecretStore (ESO's fake provider) syncs it, a registered product's step reads it (its SHA-256, never the value), and a step that isn't one, or another team's, is refused; with the kernel writing the catalog's policies, that product (registered by hand) is refused and a product of the verified release runs. |
| `prometheus-rules.sh`, `prometheus/alerts.test.yaml` | Both charts' alerts rendered and evaluated by promtool (the bundled Prometheus's image) against made-up series: what fires and what doesn't. Run by CI's helm job. |
| `step-job.json` | A step's Job exactly as the kernel's executor makes it (a kernel test keeps it equal), which `admission-policies.sh` dry-runs as the scheduler and as anyone else. |
| `admission-policies.sh` | Proves the charts' admission policies on a real cluster (dispatch and a step's Job shape, step Jobs, image sources, step identity, scans, purging, the console's write fence, namespaces and Jobs, the gateway's tokens), case by case with server-side dry runs; and the kernel's catalog policies beside the console's (both apply), and who may update which. Run by CI's kubernetes job. |
| `catalog-policy-render.sh` | The kernel chart's catalog policies rendered with no cluster (no lookup): their maps empty, `apiAudiencesWritten` false, and the settings the chart refuses. Run by CI's helm job. |
| `console-render.sh` | The console chart's refusals, rendered with no cluster: the gateway on the console's own host, where an API's page could read the console's session. CI's helm job runs it. |

### `helm/values/`: each cluster's settings

The complete settings for each cluster: `make kind-deploy*` and `make gke-deploy*` install the charts with these files and `--reset-values`, so a setting not in these files isn't deployed.

| Path | What it's for |
| --- | --- |
| `kind/kernel.yaml`, `kind/console.yaml` | The local kind cluster: local images, the demo admin, the local registry. |
| `kind/external-secrets.yaml` | External Secrets Operator on kind. |
| `kind/audit-store.yaml` | `make kind-audit-store`: SeaweedFS (S3 with Object Lock) and a bucket locked for a day, for the console's audit copy on kind. |
| `kind/cert-manager.yaml`, `kind/traefik.yaml`, `kind/tls-test.yaml` | `make kind-tls`: cert-manager, Traefik (Ingress and Gateway API), and a private test CA with a Gateway, for the console over HTTPS on kind. |
| `gke/kernel.yaml`, `gke/console.yaml` | The real GKE cluster: Artifact Registry images, Workload Identity, the LoadBalancer, image signatures. |
| `gke/external-secrets.yaml` | External Secrets Operator on GKE, with Workload Identity. |
| `gke/policy-controller.yaml` | Sigstore's policy-controller, which checks image signatures on GKE. |
| `eks/kernel.yaml`, `eks/console.yaml`, `eks/policy-controller.yaml`, `eks/external-secrets.yaml` | An example for EKS (Auto Mode), as `vennir apply` writes it: ECR, Pod Identity (no annotations), the steps NodePool and its Spot or on-demand placements, a KMS signer, IRSA for teams' stores. Not a live cluster's; placeholders in angle brackets. |

## `docs/`: maintainer documentation

| Path | What it's for |
| --- | --- |
| `architecture.md` | **Start here.** What Vennir is, the pieces, how a DAG becomes running containers, the product contract, the data, observability, the design decisions, a glossary. |
| `operations.md` | Installing (kind, and any cluster with Helm), cloud identities, upgrading, databases (passwords, access, retention), backups and restores, network policies, troubleshooting. |
| `security-model.md` | For security reviewers: where secrets live, vault sync, who can read a secret, what the cluster enforces, what isn't enforced yet, and what's out of scope. |
| `assessment.md` | The architecture assessment of 2026-10-19: what exists, findings, comparisons with Temporal and Inngest, identity across clouds, the agreed direction and its roadmap. |
| `repository-map.md` | This page. |
| `architecture/` | draw.io diagrams (system, UML classes for both projects, a submit-to-finished sequence, state machines, and the pieces at a glance that `architecture.md` shows), their SVG exports, and `generate.py`, which writes them from the code. Rerun it after changing code, then `make console-docs`. |

### `docs/setup.md`

Setting up Vennir with `vennir`, start to finish: the questions `init` asks and what each decides, what `apply` asks of you (DNS), the first sign-in and Google sign-in, the catalog, day-to-day commands, and what `destroy` keeps.

### `docs/clouds/`: before `vennir init`

| Path | What it's for |
| --- | --- |
| `aws.md`, `azure.md`, `gcp.md`, `github.md` | What only each website can do before an install (an account, subscription or project, the root user's MFA, a budget, an IAM user or roles, signing in, organization policies), linked from `vennir` when it finds one of them missing. |
| `computer.md` | The machine `vennir` runs from, on macOS, Linux and Windows (WSL 2): Docker, `vennir` itself, the tools it downloads and the CLIs it doesn't. |

## `examples/`: demo products

Fake products used by the demos and the kernel's integration tests. They deliberately share no code, as real products wouldn't, and aren't held to the production bar. Real products live in each team's own catalog repository, started from `catalog-template/`.

| Path | What it's for |
| --- | --- |
| `project-product/` | Pretends to create a project and outputs its id. |
| `application-product/` | Pretends to deploy an application into a project, taking the project id from the step before. |
| `hello-world-app/` | A tiny web app: the image the Cloud Run demo deploys (and `samples/gcp/apis/hello-world` publishes through the gateway). |
| `greetings-api/` | The backend of `samples/local/apis/greetings`, `samples/aws/apis/greetings` (on ECS Express Mode) and `samples/azure/apis/greetings` (on Container Apps), the cloud ones taking their audience from `Host` with `AUDIENCE_FROM_HOST`: a Go service (standard library only) that checks the gateway's signed `Vennir-Caller` against its JWKS before answering; `deploy.yaml` runs it in the local team's API backends' namespace, `local-apis`, labelled `vennir/api-backend` (`make kind-sample-api`). |
| `order-receiver/` | A reference receiver for order callbacks: a Go service (standard library only) that checks each post's `Vennir-Signature` (HMAC-SHA256, at most five minutes old) before accepting it; `deploy.yaml` runs it in a namespace of its own, with the bot's secret and a certificate the console trusts. |

## `cli/`: the installer

| Path | What it's for |
| --- | --- |
| `DESIGN.md` | The design for `vennir`: targets, cluster modes, sizes, scale-down, requirements, the OpenTofu modules, the approval screen and cost estimate, the catalog step, the build order. |
| `go.mod`, `go.sum` | The Go module (`github.com/roburns/vennir/cli`): cobra and yaml.v3, protobuf and Connect for the console's API, and `make proto`'s two plugins as `tool` dependencies. |
| `internal/gen/` | Generated from `proto/` by `make proto` (messages and Connect clients); never edited. |
| `cmd/vennir/catalog_commands.go` | A catalog's own commands, `vennir catalog validate`, `check`, `publish`, `release`, `changed`, `secret-stores check`, `bases`, `migrate`: what every catalog's `./vennir` runs. `vennir catalog create` (making the repository) is `catalog.go`. |
| `cmd/vennir/catalog_grant.go` | `vennir catalog grant`: the catalog owner's install lets another read its catalog, as exactly that reader's identity (its screen, confirmation, `--revoke`). |
| `internal/grant/` | What `vennir catalog grant` finds and changes, through gcloud or the AWS CLI as you: a Workload Identity provider and the repository's reader binding, or a reader's service accounts (gcp); an IAM OIDC provider and a role reading only the catalog's ECR prefix (aws). |
| `internal/catalogtool/` | What `vennir catalog` does in a catalog: validating teams, CODEOWNERS, products, `dags/` templates and DAGs, `apis/` API products and their OpenAPI files (`apis.go`), and teams' wiring types and the types products name (`types.go`) in catalog format v2 (against the schemas it embeds, `schemas/`, kept equal to the template's `tools/` by a test), and `migrate` from before v2; the compatibility check against the base (`compat.go`: breaking changes need a raised `version`, removals a deprecation first); pinning base images; building, contract-testing, scanning (Trivy, OSV-Scanner), pushing and signing products; building a team's products in its own GitHub Environment, and planning and checking those Environments (`buildenv.go`); building, pushing and signing the catalog's release (`release.go`), and tagging a commit's release as a version (`promote.go`). It never calls a console. |
| `cmd/vennir/main.go` | The root command, its shared flags (`--config`, `-v`, `--non-interactive`) and loading an environment. |
| `cmd/vennir/help.go` | Every command's help and examples, the `settings` and `sizes` help topics, and `vennir man`; a test checks every command has its help. |
| `cmd/vennir/init.go` | `init <env>`: the questions (or flags), then `deploy/<env>/vennir.yaml`. |
| `cmd/vennir/apply.go` | `apply`: the approval screen (what changed since `applied.yaml`, the add-ons only when missing or older), then registry, cluster (on aws, the catalog repository's OIDC subject naming its branch first, `ensureCatalogSubject`), namespace, images and both releases. |
| `cmd/vennir/operate.go` | `check`, `status`, `sleep`, `wake`, `console` and `destroy`. |
| `cmd/vennir/backup.go` | `backup`, `backups` and `restore`. |
| `cmd/vennir/logs.go` | `logs`: the platform's components' logs, or one execution's steps' from their team namespaces. |
| `cmd/vennir/admin.go` | `admin reset-password`: a lost admin password, reset inside the cluster; where a generated password is saved (`admin-password`, 0600, never printed). |
| `cmd/vennir/catalog.go` | `catalog create`: creates the catalog repository on GitHub with its first team and starters, sets its registry variables (no console credential; old ones removed and revoked), pushes it (or, taking one over from another registry, runs its CI by hand to republish), waits for its CI, has the console apply the release, and runs a starter; the first admin's generated password changed first. |
| `cmd/vennir/apply_aws.go` | The aws target's part of `apply` and `destroy`: the sign-in and region checks, the module's plan, prices, outputs, Auto Mode's StorageClass and steps' node pool, and what a destroy keeps. |
| `cmd/vennir/apply_azure.go` | The azure target's part of `apply` and `destroy`: the sign-in check, the module's plan and outputs, the cluster's credentials, and what a destroy keeps (the backups' storage account and the registry, in their resource group). |
| `cmd/vennir/apply_gcp.go` | The gcp target's part of `apply` and `destroy`: the project's checks, the module's plan, prices, outputs, and what a destroy keeps. |
| `cmd/vennir/tools.go` | `tools`, `config get/set`, and the tools check `init` and `apply` share. |
| `internal/config/` | The config file: defaults, validation, load and save, dotted-key get and set (any setting, lists included); `settings.go` describes every setting, kept complete by a test. |
| `internal/prompt/` | The questions on a terminal; defaults when non-interactive. |
| `internal/tools/` | Required tools per target, version checks, and pinned, checksum-verified downloads into `~/.vennir/bin`; the third-party Helm charts, each pulled and checked against its SHA-256 before it's installed (`pins.go`: both pin lists, and how to update them). |
| `internal/run/` | Runs the external commands (kubectl, helm, docker, kind), printing them with `-v`; `Together` runs independent lookups side by side. |
| `internal/cluster/` | The kind cluster and its local registry: inspect, create, delete; namespaces. |
| `internal/install/` | The platform images (built from source or released), the generated Helm values, and `helm upgrade`; the first admin's password, given in a Secret (`firstadmin_test.go`); `database.go`, a managed database's values, Secrets and `kernel database-setup` Job; `addons.go`, the add-ons an apply installed (recorded for `destroy`) and the team namespaces the console made; `release-charts.sha256`, every released chart's SHA-256, which a pulled release chart is checked against (the release workflow adds each release's). |
| `internal/platform/` | The installed platform: deployments, sleep, wake, running steps, console access. |
| `internal/plan/` | The approval screen and the sizes' platform floors (`FloorOf`: with the optional parts turned on). |
| `internal/gcp/` | What a gcp install needs from gcloud, as you: the project's checks, the cluster's credentials, a short-lived Docker sign-in, the module's inputs and the registry paths. |
| `internal/access/` | Guided access: who you're signed in as (AWS, Google, Azure, GitHub), where an install would go, and what that allows (regions an organization's policy permits, budgets, OpenTofu's sign-in, a project's existing resources), as the approval screen's Access block and problems with fixes and guides; AWS's errors classified whole. |
| `cmd/vennir/init_access.go` | The guided access steps in `init`: choosing a sign-in and running it, choosing a project or a region from those that answer, offering a budget, recording who set the environment up. |
| `internal/awscloud/` | What an aws install needs from the AWS CLI, as you: the sign-in and region checks, the cluster's credentials, a short-lived ECR sign-in, the module's inputs, the account's GitHub OIDC provider, Auto Mode's in-cluster setup, and the ECR repositories a destroy removes. |
| `internal/azurecloud/` | What an azure install needs from the az CLI, as you: the sign-in and cluster checks, and the cluster's credentials for kubectl (Microsoft Entra, through kubelogin). |
| `internal/modules/aws/` | The aws OpenTofu module (embedded): a VPC in two zones (public subnets, no NAT gateway), an EKS Auto Mode cluster, ECR (a template that creates products' repositories on push, and the platform's), Pod Identity roles for the console and the backups, the backup bucket, and the catalog CI's GitHub OIDC role. |
| `internal/modules/azure/` | The azure OpenTofu module (embedded): a resource group, an AKS cluster (Entra sign-in only, Azure RBAC, Workload Identity, Cilium network policy) with a system pool and a steps pool from zero, ACR, managed identities for the console, the scans, kernel policy and the backups (each federated to its ServiceAccount), and the backups' storage account, which takes no keys. |
| `internal/modules/gcp/` | The gcp OpenTofu module (embedded in the binary): network, a GKE Autopilot or Standard cluster, Artifact Registry repositories, the nodes', console's and backups' identities, the backup bucket; `.terraform.lock.hcl` pins the provider's checksums. |
| `internal/modules/modules.go` | Embeds the modules and writes one into an environment's `tofu/`. |
| `internal/catalog/` | Assembles a new catalog's first commit from `catalog-template/`: the first team, the starters for its languages, the owners, where it publishes; and pins its `./vennir` to a release. |
| `internal/catalogtemplate/` | `catalog-template/` inside a released vennir: `template.tgz`, empty in git, written by the release workflow (`git archive`) before it builds. |
| `internal/githost/` | The catalog's git host, as you through `gh`: repositories, pushes (gh signs git in for that command only), variables, secrets from stdin, Environments, workflow runs; GitHub's single sign-on refusals. |
| `internal/consoleapi/` | The console's API as vennir uses it, over the generated Connect clients: signing in as the admin, revoking the tokens catalogs once held, syncing the catalog, running a DAG and watching it finish. Tested against fake Connect handlers. |
| `internal/tofu/` | Runs OpenTofu in an environment's `tofu/`: init, plan (summarised for the approval screen, each resource type named in words: a test checks every module's), apply the approved plan, outputs, destroy. |
| `internal/backup/` | The databases' backups: the backup Job run now, dumps to and from this machine, the bucket's pairs, the restore (writers stopped, both databases replaced, started again), a managed database's on-demand backups, and moving an install's data into a managed database (`move.go`). |
| `internal/releases/` | Vennir's releases (GitHub's list, cached a day): the newest, what an upgrade passes over, whether a version change can be applied, and a release's binaries' checksums. |
| `internal/pricing/` | Live prices for the approval screen: Google's price catalog (read with your gcloud sign-in; `gcp_account.go`: your billing account's prices, when you may read them) AWS's Price List and Spot price history (with your AWS sign-in), and Azure's Retail Prices API (public), fetched a few calls at a time and each cached a day, and their cost models; `testdata/` holds real price entries. |

## `catalog-template/`: what a new catalog starts as

Copied whole into a new catalog repository (`README.md` there explains it to its users). Its own `.github/` is for that repository, not this one.

| Path | What it's for |
| --- | --- |
| `README.md` | The catalog's guide: layout, onboarding a team, `product.yaml`, testing, CI, publishing, SecretStores, retiring. |
| `vennir.yaml` | Where products publish (registry, signing), local defaults overridden by CI variables; and `buildEnvironments`, the teams whose products build on main in a GitHub Environment of their own. |
| `bases.yaml` | The base images the catalog approves, empty to start: CI copies each into the registry weekly (`vennir catalog bases mirror`), and `--use-mirror` points Dockerfiles at the copies. |
| `vennir`, `tools/` | The wrapper that runs `vennir` (`cli/cmd/vennir`) at a pinned, checksum-verified release, or `VENNIR_BIN`: the one tool behind every workflow and local publishing; and the schemas of every catalog file in format v2 (`team`, `product`, `template`, `dag`, `api`, `bases`, `types`), for editors (vennir catalog embeds its own). |
| `.github/` | The catalog's workflows (check; on main, plan, build in teams' own Environments, then publish and release; a `vX.Y.Z` tag asking main to make that version, `version.yml`; SecretStore and CODEOWNERS checks; deleting a removed team's images), the registry sign-in plan and publish share (`actions/registry-sign-in`), its scanner installer, and a placeholder `CODEOWNERS`. |
| `.semgrep/malicious.yml` | Code rules for products: download-and-execute, reverse shells, mining, reading the Pod's token. |
| `templates/` | Starters to copy: a team, three products, and DAGs that use them. Checked by CI, never published. |
| `teams/` | Empty but for its README: a new catalog's teams go here. |
| `samples/local/` | A sample team with no cloud or secrets: one product in Python, TypeScript, Go, PowerShell and Rust, shared with every team, and a template chaining two of them (`dags/shout-backwards.yaml`); and `ticket`, which reports what it opens as `resources` and names `close` as its `cleanup`, and whose `watch` needs a ticket (`types.yaml`'s `local.ticket`), so an order wires it and the watch depends on its ticket. New teams copy starters from it by language; published whole, it proves an install end to end. `apis/greetings` is an API product with no cloud: a backend in the team's API backends' namespace (`local-apis`), published through the gateway. |
| `docs/onboarding-with-ai.md` | For catalog teams using an AI assistant to add a team or product. |
| `samples/gcp/` | A sample team whose products call real, billed Google Cloud APIs, copied into a team once a cloud identity is set up; `project`, `app-hosting` and `cloud-sql` label what they make and delete it as their `cleanup` (`actions/delete.py`), and each says whether it's ready on an install (`actions/check.py`: `testIamPermissions` as its own identity); `apis/hello-world` publishes the Cloud Run service app-hosting deploys (the gateway signs in with a Google ID token); `types.yaml` defines the wiring types they need and provide (`gcp.project`, `gcp.region`, `gcp.cloud-sql-instance`, `gcp.container-image`) and their default providers. Every cloud sample's products install exactly their `requirements.txt`, each package pinned by version and hash (made from `requirements.in` by pip-compile, as its header says). |
| `samples/aws/` | The same for AWS: an S3 bucket, an ECS Express Mode service (AWS's counterpart to Cloud Run: the team's image, registry and roles), RDS for PostgreSQL (its password kept by Secrets Manager), keyless through EKS Pod Identity or IRSA, each with a `check` (`actions/check.py`: who it signs in as, and read-only calls its role must allow). Proven on EKS (its SecretStore not yet). `caller-identity` signs in to AWS from a cluster that isn't EKS with its projected ServiceAccount token (`tokenAudiences`, `AssumeRoleWithWebIdentity`). `apis/orders` is an API product in front of a Lambda function URL that requires IAM (the gateway signs with SigV4); `apis/greetings` one whose backend runs on ECS Express Mode, which `dags/greetings-backend.yaml` hosts with `ecs-express`. |
| `samples/perf/` | The performance-testing team: `noop`, which sleeps, succeeds or fails as asked and says when its container ran, for `perf/` in the platform's repository. No network, no credentials; published only to the perf cluster. |
| `samples/azure/` | The same for Azure: a resource group, a Container App (optionally behind its built-in Entra authentication, `entraAuth`), a PostgreSQL flexible server with Entra sign-in only, keyless through AKS Workload Identity (the step Pod label it needs is the kernel chart's `scheduler.taskPodLabels`), or off AKS by federation with the step's own token (the team secret `<ServiceAccount>-identity`). The first two proven on AKS. `apis/greetings` is an API product whose backend runs as a Container App behind the gateway's Entra token (`entraToken`), which `dags/greetings-backend.yaml` hosts with `resource-group` and `container-app`. |

## Not in git

| Path | What it's for |
| --- | --- |
| `_local/` | Your own scratch space: a clone of your own catalog repository, notes. Never committed. |
| `node_modules/`, `dist/`, `.venv/`, caches | Installed dependencies and build output. |
