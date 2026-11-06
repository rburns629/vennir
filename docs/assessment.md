# Architecture assessment (2026-10-19)

An assessment of Vennir against what it's meant to become: a Git-governed
marketplace where platform teams publish automation products and anyone in
an organization runs them, reliably and with each team's identities kept to
that team. It compares the kernel with Temporal and Inngest, borrowing their
reliability and usability lessons without their programming models. It
records the agreed direction for the work after the installer CLI.

Everything here was checked against the code on 2026-10-19; file and line
references are to that state. Status words: **built** (implemented and
tested), **partial**, **missing**, **planned** (agreed, not built). What's
still open is in [`TODO.md`](../TODO.md);
the decisions are summarized in [architecture.md](architecture.md#agreed-direction).

## Contents

1. [Summary](#1-summary)
2. [The intended model](#2-the-intended-model)
3. [What exists today](#3-what-exists-today)
4. [Findings](#4-findings)
5. [Compared with Temporal](#5-compared-with-temporal)
6. [Compared with Inngest](#6-compared-with-inngest)
7. [The Git catalog](#7-the-git-catalog)
8. [Team authorization and secrets](#8-team-authorization-and-secrets)
9. [Cloud identity](#9-cloud-identity)
10. [Hosting and target clouds](#10-hosting-and-target-clouds)
11. [Keeping cloud permissions from creeping](#11-keeping-cloud-permissions-from-creeping)
12. [Which targets a consumer may use](#12-which-targets-a-consumer-may-use)
13. [Golden paths and compatibility](#13-golden-paths-and-compatibility)
14. [The console as a marketplace](#14-the-console-as-a-marketplace)
15. [Execution reliability, traced](#15-execution-reliability-traced)
16. [Before production](#16-before-production)
17. [Decisions](#17-decisions)
18. [Roadmap](#18-roadmap)
19. [The smallest architecture that does it](#19-the-smallest-architecture-that-does-it)
20. [What should not change](#20-what-should-not-change)
21. [Answers in brief](#21-answers-in-brief)

## 1. Summary

The execution core is sound and unusually well defended for a 0.x:
Postgres-only coordination with leases and adoption, deterministic Job names
per attempt, three layers of enforcement (console, admission policies, Pod
hardening and NetworkPolicy), pinned and scanned images, and identities that
come from reviewed `product.yaml` files rather than from whoever submits.
GCP and AWS products are proven on real clusters.

What's missing is mostly the marketplace layer: a consumer who isn't a
member of the publishing team, templates they run with inputs only, forms
built from the schemas teams already write, and one catalog shared by
several installs. Two scheduler defects can run a step twice or lose a
finished step's result, and are first to fix.

Highest priorities, in order:

1. Two scheduler defects (R1, R2).
2. Pull-based catalog registration (M1): several installs can share one
   catalog, and catalog CI holds no console credentials.
3. Owner-bound secret references and a consumer role (A1).
4. Default-deny networking between team namespaces (S3).
5. Federated source identities on hosts that aren't the target cloud (I1;
   I2 waits with Azure).

Azure and GitLab are deferred until the platform and its user experience
are done (decided 2026-10-19).

## 2. The intended model

- **Teams own products and their scope.** A platform team (`gcp-platform`,
  `aws-platform`, `azure-platform`, `onprem-platform`) owns its products,
  their code and releases, its secrets, and the cloud permissions those
  secrets point at. A team's scope is its secrets plus what they reach.
- **Identity references live in team secrets.** The GCP team stores
  service account emails (AWS: role ARNs; Azure: managed identity client
  IDs) as secrets and names them in its own steps. The step's code
  impersonates or assumes that identity, which works wherever the identity
  has rights: a project, a folder, the organization.
- **Consumers run what teams publish.** An engineer from any team (say,
  `azure-apps`) runs a published template, supplying only its inputs, to
  deploy into a project they have or are creating. The template's steps
  then feed each other through the DAG. The consumer never chooses
  identities or secrets and never sees their values.
- **The owning team writes the dependency map** (`dependsOn`) in its
  templates; the service may draft one, never decide it.
- **One catalog, many installs.** The same catalog repository may feed
  several Vennir installs (GKE, EKS, AKS, kind). Each install allows the
  registries it pulls from and binds the catalog's identities to its own
  cloud accounts.
- **Products stay plain containers.** Any language, no SDK: inputs in,
  `result.json` out.

## 3. What exists today

| Capability | Status | Where |
| --- | --- | --- |
| DAG validation: cycles, references, credential-shaped inputs | Built | `kernel/internal/domain/dag.go` |
| Claim, lease, adopt; several schedulers | Built | `kernel/internal/scheduler/claiming.go`, `concurrent_test.go` |
| A Job name per attempt; adopting on conflict | Built | `kernel/internal/executor/kubernetes.go` (`JobName`, `createJob`) |
| Retries with backoff, `maxAttempts` (default 1), timeouts | Built | `kernel/internal/scheduler/tick.go` (`handleFailure`, `poll`) |
| Cancel, idempotent | Built | `kernel/internal/api/service.go` (`CancelExecution`) |
| Append-only event history | Built, shown in the console | `execution_events` |
| History per attempt | Partial: stored in `task_attempts`; the API returns only `attemptCount` | `proto/vennir/kernel/v1/kernel.proto` |
| Running-step caps, platform-wide and per team | Built | `kernel/internal/config/config.go` (`MaxRunning`, `MaxRunningPerTeam`) |
| Caps per product, priorities, fairness | Missing | |
| Inputs checked against `inputSchema` | Missing: structure only | `console/src/core/executions.ts`, `console/frontend/src/dagCheck.ts` |
| Outputs checked against `outputSchema` | Missing | |
| Forms from input schemas | Missing: schemas stored, not rendered | `console/src/db/schema.ts:134` |
| Product versions | Partial: a git-SHA tag plus `latest`; `product_releases` lists images | `cli/internal/catalogtool/publish.go` (`versionTag`, `push`) |
| Schema compatibility, deprecation | Missing | |
| A product's ServiceAccount enforced by policy | Built; proven on EKS 2026-10-19 | `helm/charts/execution-kernel/templates/identity-policy.yaml`, `executions.ts:352` |
| Team secrets chosen per step, enforced twice | Built | `executions.ts:522-546`, identity policy |
| Identity references read from a team secret | Built (2026-10-21): the samples read `gcp-target`/`aws-target` when the action lists it | `catalog-template/samples/{gcp,aws}` |
| A consumer role; templates with parameters; exports | Missing: running a team's step requires membership of that team | `executions.ts:494-497` |
| Triggers: console, API with bot tokens | Built | `console/src/core/tokens.ts` |
| Schedules, webhooks | Missing | |
| Re-running a stored DAG | Built | execution page |
| Order builder (cart → DAG) | Exploratory: wiring types stored | `wiringTypes` table |
| Several installs per catalog | Missing: one console URL, one token, one registry per repository | `cli/cmd/vennir/catalog.go:261-263`, the catalog's workflows |
| GCP products | Proven | |
| AWS products | Proven 2026-10-19 (not their SecretStore) | |
| Azure products | Unproven, and blocked: AKS Workload Identity needs a Pod label the kernel can't set | |
| A ServiceAccount token in step Pods | Missing: `automountServiceAccountToken: false`, no projected token. *Since fixed (noted 2026-10-28): step Pods get no Kubernetes token while `scheduler.taskPodHardening` is on, the default; since 2026-11-05 always, the setting removed (`kernel/internal/executor/kubernetes.go`)* | `kubernetes.py:594` |
| Default-deny between team namespaces | Done 2026-10-21: `vennir-default-deny` in every team namespace | [security-model.md](security-model.md#guardrails-the-cluster-enforces) |
| SSO sign-in | Missing (documented) | same |
| GitLab | Planned | `cli/DESIGN.md` |

## 4. Findings

Each finding: category, severity, confidence; then what happens, why it
matters and what to do.

### Scheduler

**R1. A finished step's result can be lost and the step run again.**
Confirmed defect; high; high confidence. *Fixed 2026-10-20: Jobs are
released after the commit; proven on kind.* `get_status()` reads a finished
Job's result and deletes the Job and its ConfigMap while the scheduler's
transaction is still open, keeping the result only in memory for 15 minutes
(`kubernetes.py:305-310`). If the commit fails and that scheduler then
stops, or its lease passes to another, the next owner finds no Job and
fails the attempt as retryable `JOB_NOT_FOUND` (`kubernetes.py:690-711`).
A step that created a database is then marked failed and its outputs lost;
a retry runs it again. **Do:** delete Jobs only after the commit (on a
later pass, for tasks already finished) or leave them to
`ttlSecondsAfterFinished`, already 3600 (`:646`). **Test:** a commit that
fails after finalizing, then a lease takeover, still ends `SUCCEEDED` with
outputs.

**R2. A failed status read fails the attempt but leaves its Job running.**
Confirmed defect; high; high confidence. *Fixed 2026-10-20: a failed read
leaves the task running; a timed-out one is retried only once its Job is
stopped or past its own deadline. Proven on kind with the scheduler's
permission to read Job status removed: the step stayed running with one
attempt, and succeeded once the permission was back.* When `get_status()` raises (an API
timeout, throttling, an API server restart), the step fails as retryable
`EXECUTOR_STATUS_FAILED` (`service.py:465-478`), its handle is cleared, and
its Job is never stopped (`service.py:546-554`). With retries, a second
attempt runs beside the first; without, the step is marked failed while its
Job may still succeed. A timed-out step's cancel is also best-effort
(`service.py:447-448`). **Do:** treat a failed read as unknown (keep the
step running and its lease renewed; fail only after several failures in a
row), and stop an attempt's Job, confirmed, before any retry. **Test:** a
read that fails once leaves one attempt that succeeds; one that keeps
failing cancels before retrying.

**R3. Platform failures are final by default.** Reliability weakness;
medium. `maxAttempts` defaults to 1, so a reclaimed Spot node or a lost Job
fails the step outright. Right for a product that isn't idempotent; wrong
for one that is, and the platform can't tell which. **Do:** let each action
declare its retry policy and whether it's idempotent in `product.yaml`, and
retry platform failures automatically for idempotent ones. **Done
2026-10-21:** `idempotent` and `maxAttempts`, which cap each step's
attempts; an action that isn't idempotent gets one.

**R4. A Job can outlive its cancelled execution.** Reliability weakness;
low. *Fixed 2026-10-20: every five minutes the scheduler releases attempts'
Jobs that no task can use; proven on kind.* A Job created in a pass whose commit failed, for a step then
cancelled, runs until its deadline. **Do:** on cancel, delete by the next
attempt's deterministic name, or sweep `ek-` Jobs whose step has finished.

### Security

**S1. The catalog's console token can be read by pull-request workflows.**
High in organizations with several teams. Where GitHub Environments aren't
available (private repositories on a free plan), the catalog's console
token is a repository secret, readable by a workflow anyone with push
access can change on a branch. With it: register an existing image under
another ServiceAccount, apply a SecretStore, retire teams. Cloud publishing
is safe (its trust is pinned to `main`). **Resolved by M1**: with pull-based
registration, CI holds no console credentials at all (done 2026-10-20).

**S2. The samples use one deployment-wide target identity.** Medium. The
GCP samples impersonate `GCP_TARGET_SERVICE_ACCOUNT` from the kernel's
`TASK_EXTRA_ENVIRONMENT` (`config.py:72-76`), so every step of every team
gets the same one. **Do:** read the target from the team secret the step
names (`/platform/secrets/<name>/value`), as the intended model says, and
drop the deployment-wide setting. **Done 2026-10-21**: the gcp and aws
samples read `/platform/secrets/gcp-target/service-account` and
`/platform/secrets/aws-target/role-arn`, mounted only for actions that list
them in `secretRefs`.

**S3. Steps can reach other teams' Pods.** High for production; documented.
**Do:** a default-deny ingress NetworkPolicy in every team namespace,
created with it. **Done 2026-10-21** (the console's `teamNetwork.ts`,
fenced to that one policy and shape; proven on kind).

**S4. Reads in a multi-team execution.** Medium; documented. Any member of
one team in a shared execution sees every step's outputs and logs. **Do:**
consumers see status, errors and outputs; each step's logs stay with its
owning team.

### Consumers and the catalog

**A1. No consumer role; secret references chosen by whoever submits.**
Requirements mismatch; high. Running a step in a team requires membership
of that team (`executions.ts:494-497`), and a member can attach any of the
team's secrets to any of its products (`executions.ts:522-546`) and
register new ones. The marketplace model (a consumer runs the GCP team's
steps without choosing its identities) can't be expressed. **Do:** a
consumer role that may run published templates with inputs only; secret
references fixed in the owning team's template. **API done 2026-10-21**
(`TemplateService`); the Run page the same day.

**M1. One catalog repository serves one install.** Architectural
limitation; high. The catalog's workflows push to one
`VENNIR_CONSOLE_URL` with one `VENNIR_TOKEN`, and `vennir catalog create`
overwrites both (`catalog.go:261-263`), so a second install pointed at the
same repository silently takes registrations away from the first. **Do:**
pull-based registration: each console reads `main` (a read-only deploy key
or GitHub App), verifies each image's signature against the catalog's
main-only CI identity, and registers products, templates, teams and
SecretStores itself. CI builds, tests, scans, signs and pushes. Adding an
install changes nothing in the repository. **Done 2026-10-20**, with one
change: consoles read a signed release artifact CI pushes beside the
images, not `main` itself, so an install needs registry access only.

**M2. One registry per catalog.** Medium. CI publishes to one registry;
other installs pull from it through their allowed sources. An install on
another cloud needs read access to it (federated, or the `vennir-pull`
copy) and must trust the catalog's signing identity. **Done 2026-10-22**
for an Artifact Registry catalog read from EKS by Workload Identity
Federation (docs/operations.md, "Reading another install's catalog").

**M3. Per install: values and bindings; in the catalog: names.** A design
note, and a strength. Secret values, ServiceAccount bindings and target
lists differ per install; the catalog only names them. So "does this
product work here?" is a question per install, answered by a readiness
check (section 12).

**X1. A consumer can aim an owner's identity at the wrong target.**
Security; high. A project ID typed by a consumer, or passed from step to
step, directs the owning team's identity. If that identity has rights over
a folder or the organization, a consumer can point it at someone else's
project. **Do:** scope owner identities to the folders they serve; give
each team a list of allowed targets per consumer team (section 12); have
later steps act on the project an earlier step outputs, not a typed one.
**Allowed targets done 2026-10-21:** team.yaml's `allowedTargets`, checked
against inputs typed `x-vennir-needs` before another team's run starts;
outputs passed between steps aren't checked. Scoping owner identities stays
each team's own (the gcp sample shows it).

**X2. Any template could include any team's step.** Medium. The team whose
identity does the work should consent. **Do:** each team exports the
actions other teams' templates may include, and to which teams; the console
checks this when it loads a template and again at submit. **Done
2026-10-21:** an action's `shareWith` is that export; checked by catalog CI,
when a release is applied, on each run, and on retrying a consumer's run.

**C1. Schemas declared but not enforced.** Missing capability; medium. The
console stores each action's input and output schemas but checks
submissions for structure only, and nothing checks outputs. A bad input
fails minutes later inside the container; a missing output fails the step
after it. Across teams, one service's outputs are another's inputs.
**Do:** check literal inputs at submit; check resolved inputs before each
step starts (the console attaches the schema to the task, so the kernel
checks a schema it's given and stays product-agnostic, failing with
`INPUT_INVALID`); check outputs against the output schema. **Done 2026-10-21**.

**C2. No versions or compatibility checks.** Missing capability; medium.
Other teams' templates depend on a product's outputs. **Do:** `vennir catalog
check` compares a product's schemas with its last release and fails on a
removed action, a new required input, or a removed or retyped output,
unless the change is marked breaking; add `deprecated: <message>`.
Meaning can't be checked statically: that's what the product's own test
cases are for.

### Cloud identity

**I1. Steps get no ServiceAccount token.** High for multi-cloud. Without
one, a step can't federate through OIDC (AWS web identity from GKE, AKS or
kind; Entra from GKE or EKS; GCP federation from AKS). Native paths still
work because they bring their own (GKE's metadata server, EKS Pod
Identity's webhook). **Do:** a product declares the token audiences it
needs (`tokenAudiences: [sts.amazonaws.com]`); the kernel adds a projected,
short-lived token for those only; the identity policy allows that volume
and nothing more. **Done 2026-10-20**.

**I2. AKS Workload Identity needs a Pod label the kernel can't set.**
Blocker for Azure. **Done 2026-10-21:** `scheduler.taskPodLabels` (the
kernel's `TASK_POD_LABELS`), on step Pods only, never the kernel's own
labels; proven on kind. Proving Azure itself waits with Azure.

**D1. Documentation behind the model.** Low. The samples and
[security-model.md](security-model.md) describe a deployment-wide target
identity and team-member choice of secrets; the intended model has
identity references in team secrets, bound by the owning team.

## 5. Compared with Temporal

| Temporal | Vennir | Verdict |
| --- | --- | --- |
| Durable state, crash recovery | Postgres rows, one transaction per pass, leases adopted | Have it |
| Activity fencing | Row locks, `lease_owner`, a Job name per attempt | Have it, once R1 and R2 are fixed |
| Workflow ID reuse | `requestId` | Have it |
| Retry policy per activity | Global backoff; `maxAttempts` per task; `retryable` from the product | Adopt per action, in `product.yaml` (R3) |
| Start-to-close timeout | `timeoutSeconds` and the Job's deadline | Have it |
| Schedule-to-start timeout | None: a ready step can wait indefinitely behind the caps | Adopt: a maximum queued age |
| Heartbeats | None | Adopt lightly: an optional progress line for people, not for leases |
| Event history | `execution_events`, append-only | Have it; add per-attempt records to the API |
| Deterministic replay, SDKs, signals and queries, dynamic workflows, workers | | Avoid: DAGs are data resolved before they run, and an SDK would end language independence |
| Sagas | | Later, if needed: a product's `delete` action, offered in reverse order after a failure, started by a person |

Running a Job isn't provisioning anything: a step can create a resource and
stop before it reports. No scheduler can make that exactly-once; products
that look before they create can, and every sample does.

## 6. Compared with Inngest

| Inngest | Vennir | Verdict |
| --- | --- | --- |
| Run timeline, step status, logs, retry | Execution page: graph, events, logs, durations, retry, re-run | Have most; add attempts |
| Failure classification | `{code, message, retryable}` everywhere | Have it |
| Concurrency keys | Platform-wide and per-team caps; per product (done 2026-10-21) | Held in the claim by a key from resolved inputs, with an advisory lock per key |
| Priorities, fairness | First in, first out | Later: claim round-robin by team |
| Throttling, debounce | | Later; product caps cover cloud API quotas |
| Durable steps | Each DAG step is a checkpoint; outputs kept when a later step fails | Have it; no SDK checkpoints |
| Cron triggers | | Add: schedules that run a template as a bot |
| Event triggers | Bot tokens and the API | API and CI cover it; webhooks with the outside front door (TODO); no event bus |
| Run one function | A one-task DAG | Add: every action is a one-step template with a form |

## 7. The Git catalog

- **Git stays the source of product definitions.** Review, CODEOWNERS,
  history and CI are the collaboration a marketplace needs. Postgres stays
  the source of truth for runtime state; the console keeps an index.
- **One repository, many installs.** One repository keeps one CODEOWNERS,
  one set of workflows and discovery across teams. Several repositories give
  teams autonomy but need per-repository trust and a mapping from team to
  repository. Stay with one; make each console's trust per (repository,
  team folder) so another repository can be allowed for some teams later.
- **Pull, not push** (M1): consoles read `main` and verify signatures.
- **Templates and exports join products** in each team's folder: `dags/`
  templates with parameters; an `exports` list in `team.yaml`.
- **Ownership:** CODEOWNERS is required per team folder and checked. The
  console's team owner isn't linked to it yet (TODO).
- **Provenance:** pinned digests, scans at registration and daily,
  signatures where configured, enforced by admission. Build provenance
  attestation (SLSA) is optional later: a signature from main-only CI
  already says "built from reviewed `main`". A clean scan or a valid
  signature doesn't prove an image harmless.
- **Team lifecycle:** create, retire (reversible), purge (by hand, namespace
  left for an administrator). Not yet traced: what happens to a running
  execution when its team is retired.
- **GitLab:** planned behind the git-host layer.

## 8. Team authorization and secrets

Built and enforced in two layers: a step mounts only Secrets in its own
team's namespace, only ones registered for that team, only if it's a
registered product of that team running as its declared ServiceAccount,
and only as volumes; steps have no API token; the console can write Secrets
but not read them. Cross-team secret access is impossible by construction.

The model going forward:

- **Maintainers** of a team keep today's rights: register secrets, choose
  them per step, write templates (decided 2026-10-17, unchanged).
- **Consumers** run published templates. The template fixes each step's
  `secretRefs`; the consumer supplies parameters.
- **A product trusted to read a secret can misuse it.** Explicit selection
  doesn't stop an approved product from abusing what it's given. The
  controls are review of its code and `product.yaml`, an immutable digest,
  a main-only build identity, review of templates that bind secrets, and
  narrow cloud grants behind each identity reference (section 11).

## 9. Cloud identity

Two layers:

- **Source:** the product's own Kubernetes ServiceAccount, declared in its
  `product.yaml` and bound per install to a cloud identity: GKE Workload
  Identity, EKS Pod Identity, AKS Workload Identity, or OIDC federation on
  other hosts (I1). It holds only the right to act as specific targets.
- **Target:** the identity a team secret names, chosen by the owning team in
  its templates.

The cloud's grant from source to target is the boundary; knowing an email or
an ARN grants nothing.

- **GCP:** `roles/iam.serviceAccountTokenCreator` granted on each target
  service account, never at project or organization level. Product
  identities never get `iam.serviceAccountKeys.create` or `setIamPolicy`.
- **AWS:** the source role may `sts:AssumeRole` on named target ARNs only;
  each target's trust policy names the source role. Pod Identity trust:
  `pods.eks.amazonaws.com`, conditioned on `aws:SourceAccount` and
  `aws:SourceArn` (proven). No wildcard `sts:AssumeRole`; `iam:PassRole`
  scoped with `iam:PassedToService`; permission boundaries on any role a
  product creates.
- **Azure:** a user-assigned managed identity or app registration with a
  federated identity credential whose issuer is the cluster's and whose
  subject is `system:serviceaccount:<team>:<product-sa>`. RBAC scoped to
  resource groups; no product identity with Owner or User Access
  Administrator. A client ID alone authenticates nothing.

Per-product source identities matter: if a team's products share one
source, every product can act as every target the team stores, and a secret
attached to the wrong step works instead of failing.

## 10. Hosting and target clouds

**P**: proven. **F**: possible today in product code. **K**: needs projected
tokens (I1). **W**: needs Pod labels (I2).

| Host ↓ / target → | GCP | AWS | Azure |
| --- | --- | --- | --- |
| GKE | **P**: Workload Identity | **F**: the GSA's Google ID token from the metadata server, then `AssumeRoleWithWebIdentity` trusting `accounts.google.com`; or **K** with the GKE issuer | **F**: a federated credential with issuer `accounts.google.com`; or **K** |
| EKS | **F**: GCP Workload Identity Federation with an AWS provider, from the Pod Identity role | **P**: Pod Identity | **K**: a federated credential on the EKS issuer |
| AKS | **W+K**: federation with the AKS issuer | **W+K**: an IAM OIDC provider for the AKS issuer | **W**: Workload Identity |
| kind | No public issuer: publish its discovery document and keys, then **K**; or a static credential synced from a vault | the same, or IAM Roles Anywhere | the same |

Every **F** path is the product exchanging tokens with its cloud's own SDK:
no broker in Vennir. Static credentials are a documented fallback for local
use, never the default. Only the **P** cells are proven; treat the rest as
supported once each has been run for real.

## 11. Keeping cloud permissions from creeping

Vennir enforces, or will:

- an image runs only as the ServiceAccount its reviewed `product.yaml`
  declares (built);
- one source identity per product, holding only the right to act as its
  targets;
- no deployment-wide identities (S2);
- consumers can't choose identities or secrets (A1);
- changes to what binds which secret are reviewed Git changes (templates);
- each attempt records who requested it and which principal acted, never
  credentials.

Cloud IAM and the organization keep: what each identity may do, trust
scopes, Token Creator, PassRole and role-assignment rights, SCPs and
organization policies. Vennir doesn't provision IAM.

Drift: each product may ship a `check` action (who am I, may I do X); the
console runs it per install on registration and daily and records which
principal answered. A binding changed outside review shows up there.

Granularity: one identity per product by default; per action only where
one action is destructive (`actions[].serviceAccount`, optional); never per
step or per attempt.

## 12. Which targets a consumer may use

Not live discovery: listing projects, accounts or subscriptions needs broad
rights, differs by cloud, and seeing an account doesn't prove a product can
deploy there. Instead:

- **Allowed targets per team**, in the catalog: which projects, folders,
  accounts or subscriptions each consumer team may aim the team's templates
  at. The form fills its choices from this (`options: targets`).
- **Readiness per install**: each product's `check` action, run by the
  console, shown as "checked on (date) as (principal)", or what's missing.
  It's a provisional check, and says so.

The console answers separately: is it published (catalog), may I use it
(exports, consumer role), where (targets), will it work here (readiness).

## 13. Golden paths and compatibility

- **Contracts:** schemas enforced (C1), wiring checked by output and input
  types. Mostly finishing what exists.
- **Who may call whom:** exports (X2), the first and simplest rule.
- **Architecture:** later. Optional `provides` and `requires` tags in
  `product.yaml` (provider, capability, whether it's a runtime dependency)
  and one rule table in the catalog (approved, conditional, blocked per
  pair), checked at submit. No policy engine until a table isn't enough,
  and no rules until there are real products to write them for.
- `dependsOn` is execution order. A runtime dependency (a service using a
  database in another cloud) can only be declared by products, through
  their output types.

## 14. The console as a marketplace

Definitions are managed in Git, runtime in the console; the console shows
definitions with links to them and never edits them.

| Area | Who | What |
| --- | --- | --- |
| Catalog | Everyone | Templates and products by team: inputs, outputs, owner, release, readiness on this install, runnable examples from the product's test cases; Run opens a form built from the input schema |
| Compose | Everyone | Build a DAG from actions shared with you: each input a value or a type-matched output of an earlier step, `dependsOn` filled in from that wiring, the same checks as a template; save as a draft, or propose it as a template (a pull request to the owning team) |
| Runs | Everyone | List with filters and search (including by something a run created); a timeline per run: steps, attempts and their errors, durations, outputs, who asked and who acted, what it created; logs for the owning team |
| Teams | Everyone | Another team's page: what you may use and its readiness, what isn't shared with you (with "Ask for access"), where you may deploy with them, how to get help, how their products are doing |
| Team (own) | Maintainers | Members and roles, secrets, readiness per product with the fix for anything missing, templates and sharing (from Git) |
| Schedules | Maintainers | A template or composition on a timetable, as the team's bot, with saved inputs and a rule for overlapping runs |
| Submit | Maintainers | Raw DAGs, the advanced path |
| Admin | Admins | The catalog connection, sign-in and roles, limits, allowed registries and image scans, notifications, the audit log |

Forms come from the schemas teams already write (TODO, Console). Every
action is a one-step template, so a team is in the marketplace as soon as it
publishes a product. Eleven screens were mocked up on 2026-10-19: Catalog,
run form, run timeline, Compose, own Team, Admin, Runs, Schedules, another
team's page, preview and approval, and a failed step explained.

### Custom DAGs and discovery

- **Secret bindings belong to the action**, in `product.yaml`
  (`actions[].secretRefs`), so an exported action keeps its owner's
  bindings in any DAG. Templates are compositions a team reviewed and
  published; a consumer's own composition is the same thing, unreviewed.
- **Every action is discoverable; not every action is runnable.** Shared
  with everyone: anyone runs it. Shared with some teams: shown to all, with
  "shared with: …". Not shared: shown, marked "not shared with you", with
  "Ask for access". `visibility: hidden`: its own team only.
- **Pull requests come from the person**, never the console: "Ask for
  access" and "Propose as a template" open GitHub's prefilled page in their
  browser, so the console keeps read-only access to the catalog.
- **Steps use a product's latest release**, protected by the compatibility
  checks (C2); every run records the exact digests it used.

### Management

| Area | Where | Who | Rule |
| --- | --- | --- | --- |
| Run state | Kernel database | — | Never edited by hand: every change is an action that records an event |
| Run actions: cancel, retry a step, re-run | Console | The requester for their own runs; maintainers for their team's steps | Retry says whether it's safe, from the action's idempotency |
| Retries | Policy in `product.yaml`; manual in the console | Owners set the policy | |
| What a run created | A `resources` output convention (type, id, link) | — | Vennir records references; it doesn't track infrastructure state. Cleanup runs products' `delete` actions in reverse |
| Users, teams, roles | Console; teams also in Git | Admins, maintainers | Roles: admin, maintainer, consumer; SSO groups map to them. Everyone signed in is a consumer |
| Step logs | Kernel database | The owning team | Consumers see status, errors and outputs |
| Platform logs, metrics, alerts | stdout, `/metrics` | Operators | |
| Audit | Console database, copied to a write-once store | Admins | Every change, by a person or a bot |
| Limits, retention | Settings | Admins | Caps per platform, team and product; runs kept 90 days |
| Notifications | Console | Requesters, owning teams, admins | On failure, on finish, a product not ready, the catalog not pulled |

### What else shapes the experience

In order of value for the work:

1. **Approvals** (done 2026-10-21). An owner marks an action, or sharing
   with other teams or into a target, as needing approval; the run waits at
   that step until a maintainer approves or declines (audited); unanswered
   requests are withdrawn after 3 days. Needs a waiting state in the kernel.
2. **Failure help from the owner.** Products declare their error codes with
   what they mean and what to do; teams declare where to ask for help. The
   run page shows the owner's explanation, whether retrying is safe, and who
   to ask.
3. **Preview.** An optional `plan` action reports what a step would create,
   change or leave alone; the form offers Preview, and an approver sees it.
4. **One run per target at a time.** A product declares a concurrency key
   from its inputs; the scheduler holds a second step with the same key.
5. **Runnable examples** from each product's test cases.
6. **Copy as API call** on every form and composition.
7. **Ask for access** on anything not shared with you.
8. **Run again with changes**, open a run in Compose, saved inputs,
   environments with promotion, live updates, success rates, changes between
   releases, find what created something, cost hints, a getting-started
   checklist per role.

Preview, failure help, readiness and cleanup are only as good as the
metadata product teams write; the UI says plainly when a product has none.

### Sleep

A sleeping install can't answer, so scale-down is offered for single-person
and development installs, with that warning in `vennir init`. Schedules
wake the platform (a CronJob can); there's no always-on page.

Onboarding stays short per role: an installer runs `vennir` and, for an
existing catalog, connects to it; a platform team adds its folder, its
secrets and its products, guided by readiness; a consumer signs in, picks a
template, fills a form.

## 15. Execution reliability, traced

| Situation | Behavior | |
| --- | --- | --- |
| Submit | One transaction, idempotent by `requestId` | ✔ |
| Claim | `SKIP LOCKED`, a lease, an attempt row | ✔ |
| Job created, commit fails | The step is claimed again with the same attempt number, so the same Job name, and the Job is adopted | ✔ |
| Scheduler stops after creating | The same | ✔ |
| Create times out but succeeded | Retried a bounded number of times, then adopted | ✔ |
| Lease expires while the old scheduler lives | The old one only loads steps it still owns, locked; a new owner never overlaps a pass | ✔ |
| Job gone before its result is recorded | R1 | ✘ |
| Status read fails | R2 | ✘ |
| Timeout | Best-effort cancel, then retry | R2 |
| Cancel | Marked by the API, Jobs stopped on the next pass | R4 edge |
| Clean-up | Retention sweep hourly; Jobs deleted at once (should wait, R1) or after their TTL | ✔ |

## 16. Before production

1. R1 and R2.
2. M1 (and with it S1).
3. A1, with X1's target scoping.
4. S3.
5. I1 and I2, wherever host and target clouds differ.

Then: SSO sign-in; TLS in the charts; the audit log in a write-once store;
alerts; the scheduler proven at scale on a cloud; a lock file for the
kernel; Azure proven; backups proven per cloud; a ResourceQuota per team.

## 17. Decisions

**1. Postgres stays the only coordinator.** Its claim, lease and history
semantics are correct apart from R1 and R2, which a broker wouldn't fix.
Rejected: Temporal, a message broker, Redis.

**2. Kubernetes Jobs stay the unit of execution.** They bring deadlines,
TTLs and admission control. Rejected: a custom resource and operator, which
would move state out of Postgres.

**3. Identity in two layers.** The source is the product's ServiceAccount,
bound per install and holding only the right to act as specific targets; the
target is an identity reference in a team secret, chosen by the owning team
in its templates. The cloud's grant between them is the boundary. Rejected:
a credential broker; one deployment-wide identity.

**4. Consumers run templates.** A consumer runs a team's published template
with inputs only; templates may include other teams' steps where those teams
export them; the owning team writes the dependencies, and the service may
draft them. Maintainers keep choosing secrets per step.

**5. One catalog, many installs, pulled.** Each console reads `main`,
verifies signatures and registers what it finds; CI holds no console
credentials. Rejected for now: several catalog repositories.

**6. Targets are allowed per team; readiness is checked per install.**
Rejected: discovering accounts and projects live.

**7. Golden paths later, as a rule table in Git.** Rejected: a policy
service or language.

**8. Forms from schemas.** The input schemas teams write drive the form,
submit-time and run-time validation and wiring, with a few `x-vennir`
hints; no custom forms per product.

**9. Bindings in `product.yaml`.** Each action names the team secrets it
uses (`actions[].secretRefs`), reviewed with the code that reads them, so
an exported action keeps its owner's bindings in any DAG. Rejected: a
separate team bindings file.

**10. Steps use the latest release.** Compatibility checks block breaking
changes; each run records its digests. Rejected: pinning releases in
templates, which makes owners chase every template with every fix.

**11. Pull requests from the person's own browser.** The console opens
GitHub's prefilled page and keeps read-only access to the catalog.
Rejected: a GitHub App that can write to the catalog.

**12. Signatures required on cloud installs.** A kind install, whose
catalog publishes unsigned, trusts the registry and `main` instead.

**13. Sleep is for development installs**, and schedules wake them.
Rejected: an always-on page.

**14. Contracts may change freely until a first release.** No
compatibility shims while nobody depends on them.

**15. Azure and GitLab wait** until the platform and its experience are
done (decided 2026-10-19).

**16. The console's API on Connect** (decided 2026-10-20). Protos written by
maintainers; clients generated for the frontend and `vennir`; JSON over HTTP for `curl`, and gRPC for callers that want it,
from the same endpoints. Resources and actions alike are RPCs; health,
metrics, static files and outside webhooks stay plain HTTP. Chosen for its
schema and generated clients, not for speed: neither protocol is the
bottleneck. Rejected: tRPC, which only TypeScript callers can use.
Product actions keep JSON Schema as their source; Invoke is one generic
method, and catalog CI later generates a proto per product (stable field
numbers, protovalidate rules, `buf breaking` as the compatibility check).

**17. The kernel in Go** (decided 2026-10-20), for `client-go`'s informers,
goroutines, static binaries and one language with the CLI; not for speed
(steps are bound by container start, the scheduler by database round
trips). R1 and R2 are fixed in Python first. Then the scheduler is replaced
against the same schema, proven by the existing scenarios, then kernel-api
(on Connect), then the migrations tool; the two processes only share rows,
so each is replaced alone. New kernel features are built in Go. (Done the
same day: one binary, `kernel`, with the Python removed.)

**18. The catalog tool in Go** (decided 2026-10-20), first `catalogctl`, a
binary of its own built from the CLI's module and sharing its packages,
downloaded pinned and checked by each catalog's wrapper in place of today's
virtualenv. Ported while the catalog format changes anyway (Phase 1).

**19. One command line** (decided 2026-10-21): the catalog tool is part of
`vennir`, as `vennir catalog ...` (`check`, `publish`, `release`, ...), and
a catalog's wrapper is `./vennir`, downloading the pinned `vennir`. The
repository's setup is `vennir catalog create`. Accepted: a larger download
in catalog CI, and a catalog pinning a whole `vennir` release.

**20. API products, through one gateway** (decided 2026-10-21). Besides
steps, which run as Jobs, a team may publish a backend it already runs as
an API product: `api.yaml` (`kind: Api`: the backend's URL and how to
authenticate to it, `shareWith` (since replaced by each install's access
list: decision 26), limits) and its OpenAPI file, reviewed and
released with the catalog like any product. A gateway, a process of its
own, forwards each request directly to the backend: the same method, path,
query, headers and body, with the caller's credential swapped for the
backend's and the caller named in a signed header; the answer comes back
unchanged. The spec is the allowlist: a request whose method and path
aren't in it is blocked at the gateway (404) and never forwarded, and one
that doesn't match the operation's schemas is refused (400). Backends must
be under hosts the admins allow, so the gateway can't be pointed anywhere,
and their credentials are minted per request where the backend's cloud
allows it (as I1), not stored. Nothing of the team's runs per request.
Rejected: a Job per request (seconds of start-up per call, no streaming);
running the team's own code in the path as a long-lived Deployment (a
second way to run things, with rollouts and scaling; not needed to
publish an existing backend). This replaces the earlier Invoke idea of
calling an action as a run.

**21. What a run created, and deleting it later** (decided 2026-10-23). A
step reports what it made or changed as `resources` in its outputs: each
`{type, id, name?, link?}`. The console copies them, with the step's
resolved inputs and outputs, into its own table when the run finishes, so
a delete never depends on the run still existing: it may come months
later, after run retention has dropped the run. Vennir keeps references,
not infrastructure state. An action that creates things names the action
that removes them, `cleanup` in product.yaml: by default that action is
given `{"resource": {...}}`, the one resource as reported; `cleanup.inputs`
can map more from what was recorded (`$input`, `$output`, `$resource`). Anyone
who may see the team's runs may delete one of its resources at any time:
it runs as an ordinary run of the product's current cleanup action, so
sharing, approvals and the audit log apply, and the resource is marked
deleted when that step succeeds. Cleaning up a whole run deletes its
resources in the reverse of the order they were made. Rejected: the
delete reading the old run's outputs (gone after retention); tracking
resources' live state (each product's own cloud knows that).

**22. Catalog versions, and installs that read another's catalog**
(decided 2026-10-26). One repository is published by one install (its
owner: its registry, its signer); every other install reads it
(`externalCatalog`), and each install chooses what it follows: `latest`,
every release main publishes, or versions. A version is a Git tag
`vX.Y.Z` in the catalog repository: it doesn't rebuild or re-sign
anything, it tags the release main already published and signed for that
commit, `catalog-release:vX.Y.Z`, so an install on a version runs exactly
the digests an install on `latest` ran, verified against the same signer.
Pushing the tag only asks CI on main to do it (the tag's run holds no
credential, since signing and the registry are main-only), and a version
never moves once made. An install follows a pinned version or the newest
one, so promoting test's catalog to prod is cutting a tag. A reading
install trusts the owner's signer (its public key, or its repository's
keyless identity) and enforces it on releases and images as the owner
does, holding no signing rights. `vennir` refuses to make a second
install the owner of a repository that already publishes elsewhere.
Rejected: channel tags such as `:prod` (unfamiliar, and they move);
branches per environment (two histories to merge and sign); signing on a
tag's run (anyone who may push a tag could sign); per-install signers for
one catalog (several roots of trust); approval in each console (no shared
record of what was promoted). An install's cloud is where Vennir runs, not
what its steps may deploy to (federation reaches other clouds), so a second
install is for a real boundary (prod and non-prod, residency, separate
units), not each engineer's cloud.

**23. Orders from outside, and the order builder** (proposed and decided
2026-10-27). An order is a run of a published template, with its
inputs, for one team, asked for by a service outside the cluster (a
storefront, an event bus's consumer, another platform's pipeline). Most
of it is here: the console can be public over HTTPS (`console.public`), a
service signs in keylessly as a bot (its OIDC token, from an issuer the
install allows, mapped to the bot; done for CI on 2026-10-24),
`TemplateService/RunTemplate` runs a template with inputs only and takes
a `request_id`, so a retried order runs once, and a consumer may run
templates and nothing else. What's missing, proposed:

1. *Who an order is for:* always the bot's own team, which owns the run
   (its caps, quota and approvals apply, and its maintainers see and cancel
   it). A bot can't order on behalf of a team it isn't in.
2. *What a bot may order:* a list of templates on the bot (empty: none),
   set by its team's maintainers; RunTemplate refuses any other. Narrower
   than the consumer role, which may run every template shared with the
   team.
3. *Hearing back:* the caller polls `ExecutionService/GetExecution`, or the
   bot names a callback URL (under the install's allowed hosts, as chat
   webhooks are) that the console POSTs the outcome to when the run
   finishes, signed with a secret kept per bot (HMAC), retried as webhooks
   are. An event bus is a product that forwards these, not the platform's.
4. *Limits:* a request rate per bot, and the gateway's style of refusal
   (429) when it's passed.

Rejected: kernel-api in front (it stays private, and has no idea of users);
raw DAGs from outside (they bypass the templates' review and their fixed
secrets); a separate orders service (the console already authenticates,
authorizes, audits and runs templates).

The *order builder* turns a cart of actions into a DAG. Products' inputs and
outputs name wiring types (each team's `teams/<team>/types.yaml`, decision 25); `OrderService/PreviewOrder`
would wire each required input to the one output in the cart that provides
its type, add a type's default provider when nothing in the cart provides
it, ask once for a shared type, and refuse a cycle or an input that two
outputs could fill (the person chooses). It never runs anything: it opens
the DAG in Compose, where a person reviews it and runs it or proposes it as
a template. Open: whether an order from outside should be able to name a
cart rather than a template (proposed: no; carts become templates first,
through review).

Decided on review: the per-bot template list (2), not the consumer role,
limits what a bot may order; callers hear back both ways from the first
version, polling and the per-bot callback (3); and possibly an outcome
webhook a team subscribes to (JSON, for systems rather than chat: the run,
its state, its outputs as its team may see them), beside its chat webhook.

Built 2026-10-27, all of it: ordering bots (`users.order_templates`,
`ensureMayOrder`), the per-bot callback and the team's outcome webhook (both
signed, `console/src/callbacks.ts`), a rate per bot (`core/orderRate.ts`,
429), and the order builder (`core/orders.ts`, Compose's "Build from a
cart"). As proposed, an order from outside names a template, not a cart.

**24. A chat agent, then an MCP server** (proposed 2026-10-27; revised the
same day). A person comes to the console, says what they need ("app
hosting on GCP for shop-api"), and the console's chat agent builds the cart
with them (decision 25): what the offering needs, what the team already
has, what's suggested. The person checks it out. Later, the same tools are
offered over the Model Context Protocol, so an engineer's own agent (Claude
in VS Code, for one) can do the same. Proposed:

1. *In the console, as the person:* a chat panel whose agent runs in the
   console process. Each tool is a plain function over `core/`, run as the
   signed-in person, with the same checks as the API, so the agent sees
   and does only what they may. The tools: describe an offering (what it
   needs, provides and suggests, from the catalog), list what the team
   has deployed and what depends on what, plan a cart (`PreviewOrder`),
   and change the cart. Never place it: the agent fills the cart on the
   page, and the person's own **Place order** is the confirmation. So
   nothing the agent reads (outputs, names and descriptions are written by
   products and people, and may carry instructions) can order or delete
   anything.
2. *The model is the install's setting* (`chat` in the console chart, off
   by default): `provider` (vertex, bedrock, anthropic, openai-compatible),
   `model`, and where it is. On a cloud it signs in keylessly, as the
   console's own workload identity: Vertex AI on GCP, Bedrock on AWS
   (Azure AI Foundry later), so what the chat sends stays in the
   install's cloud. A key, where one is needed, is a Secret named in the
   values, never the values themselves. Two adapters, not one per cloud:
   Anthropic's message format (direct, on Vertex AI and on Bedrock: one
   model family behaving the same on every install) and OpenAI-compatible
   (a local model on a laptop install, LM Studio or Ollama; Gemini).
   Tests use a scripted model, as the scheduler's use a fake executor.
3. *What it sees:* the catalog shared with the person, their teams' runs
   (who, for which team, template and inputs, steps, outputs and failure
   codes) and resources with their links (decision 25). And every doc, so
   it answers questions too (decided on review): the console's guides and
   the platform's own docs (architecture, operations, the security model,
   setup, the clouds, the catalog's guide), shipped in the console's image
   with the version they describe (`console/docs/reference/`, copied by
   `make console-docs`). It searches them by section (keywords, BM25, in the
   console process: `GuideService/SearchGuides`, the Docs page's search
   too) and reads a section whole, and links what it answers from. The
   repository is public, so no doc is a secret; none holds a credential.
   Searching by meaning (embeddings) waits until keywords are measured
   short. Not logs (a
   step's logs can hold anything), nothing admin-only, no secrets, teams,
   members or bots. A conversation is kept for its person only, and
   deleted after 30 days.
4. *Correctness* (decided on review, 2026-10-28): the model words answers;
   it's never the source of a fact.
   - *What's there is asked, never remembered.* What a team has, why a run
     failed, what an offering needs: only from a tool, live, with the
     person's permissions. Anything shown as a thing (a resource, an
     action, a run, the cart) is drawn from the tool's data, not the
     model's text, so a misnamed action shows as the real one or nothing.
   - *Answers from the docs cite, checked.* Only from the sections retrieved
     that turn, each cited; the server keeps a citation only if it names a
     section retrieved, and builds every link itself from the search's
     result, never from the model's text. A factual answer citing nothing
     is marked as not from the docs, and nothing found means "the docs
     don't say", with a link to search.
   - *Docs by kind.* Each says what it is: a guide (using Vennir), how it
     works now, how to run it, or design history (the decisions, with
     proposals and rejected options). History answers "why", never "what
     is", and is searched only for that. The TODO isn't shipped.
   - *Actions checked by the platform.* The agent proposes a cart; the plan
     shown is PreviewOrder's, and PlaceOrder checks it again on the
     person's click.
   - *Measured.* A question set, each with the section that answers it:
     retrieval (the section in the best five) checked in CI; answers, per
     model, run by hand or nightly; scripted tasks checking the tools are
     called in order. Thumbs up or down on each answer, the misses turned
     into cases or doc fixes. A small local model proves the agent's logic,
     not its answers' quality: a production install uses a capable one.
   Built 2026-10-28: the agent (`console/src/chat/`: one model interface
   and the openai-compatible adapter, the tools, the loop with its step
   cap and citation check), `ChatService`, and the Ask panel on every
   page; tested with a scripted model, and seen on kind with a local model
   (Qwen 27B): cited genuinely, with one fact made by joining two sections,
   which only scoring answers catches.
5. *Later, an MCP server* at `/mcp` (Streamable HTTP), the same tools
   for outside agents: a team's bot first (signing in keylessly with its
   cloud identity's ID token at `AuthService/ExchangeToken`), then people
   through MCP's OAuth 2.1 (the console as the authorization server, a
   token for `/mcp` alone). A person chooses on connecting: read only,
   order with confirmation in the console (a link to the cart), or order
   directly (within their rights and their teams' approvals). Deletes
   always wait for confirmation in the console. Each change is audited as
   theirs, through an agent.

Rejected: the provider's hosted agent runtime (Vertex AI Agent Engine,
Bedrock AgentCore) for the console's chat (it would call back in for the
person, needing delegated sign-in first); an adapter per cloud; a
dependency graph the agent infers from descriptions (decision 25); a
separate service for either (decision 23's reasoning).

Open, for review: whether the chat may answer from run logs later;
which issuer an agent on AWS signs in with, for MCP.

**25. The cart: what an offering needs, from the catalog** (proposed
2026-10-27). A person asks for "app hosting" on GCP and nothing else, in the
console or by talking to its agent (decision 24). What app hosting *is* (a
Cloud Run service, or whatever else) is the platform engineers' to say, and
so is what it needs (a project; a database, if wanted). The cart shows
the offering, what it needs added, what it could use that the team already
has, and what's suggested; the person (or the agent, then the person)
checks it out as one run. The agent reads the same answer the cart does. It
never guesses dependencies from descriptions. Proposed:

1. *Declared in the catalog, by the product's own team:* an input that
   `x-vennir-needs` a wiring type depends on something of that type, and
   an output that `x-vennir-provides` one is one (both as today). A
   required input is a dependency; an optional one is a suggestion (app
   hosting's `cloudSqlConnectionName`, typed `gcp.cloud-sql-instance`,
   suggests a database). The wiring types themselves (what each means,
   `shared`, and its `defaultProvider`, what a cart adds when nothing
   fills it) are defined by the team that's the authority on each, in its
   own `teams/<team>/types.yaml`, with its default providers among its own
   actions (decided while building: one catalog-wide file would put every
   team's vocabulary under the catalog's admins, and break whenever the
   teams installed vary). Each type is defined once in the catalog. They
   travel in the catalog release like everything else, and
   `ReplaceWiringTypes` is left for installs without any.
2. *Filled by what's already deployed:* a needed type is filled by a step
   in the cart, by something the team already has, by its default
   provider (added), or by a value typed in. For "already has", each
   resource remembers what its step provided (each typed output, its
   wiring type and value), recorded when its run finishes; those of the
   team's own, and the caller's, are offered first.
3. *Dependencies across runs, recorded:* when a run finishes, each
   resource gets a link to each resource it took an input from, whether
   that came from a step in its own run or from a resource the team already
   had. So "this service runs in that project, made by run X, by Ana" is a
   query, and deleting something others depend on says what depends on
   it. Deleting a project under a live service is refused, and the
   admins are alerted; it goes ahead only once an admin approves it
   (deleting the service first needs no approval).
4. *The cart:* add an action; `OrderService/PreviewOrder` answers the plan:
   - what it needs added (default providers, marked as added);
   - existing resources it could use instead, the choice the person's;
   - suggestions for optional needs (not in the cart until chosen);
   - and the problems it already reports.

   Built for the Catalog (an "Add to cart" beside Run) and for the agent
   alike, as well as Compose.
5. *Checking out:* `OrderService/PlaceOrder` runs a planned cart as one run
   for one team: each step exactly as `RunAction` would run that shared
   action alone (sharing, parameters, targets, its fixed secrets), wired
   by `$fromTask`, with existing resources' values filled in by the
   console (from resources the caller may see). It takes a `requestId`. So
   a member may check out what they could run step by step, without a raw
   DAG. A target-typed input wired from another step (a project id) is
   checked against `allowedTargets` again when that step starts, since its
   value isn't known at submit. Ordering bots still order templates only
   (decision 23).

Rejected: dependencies inferred by the agent from descriptions (not
reviewed, and not the same twice); a separate dependency file per
offering (it would drift from the schemas the steps actually run with);
carts only through Compose and templates (a person could then order
what they need only with a maintainer's help).

Open, for review: whether a cart can be saved and shared before checkout
(proposed: later, as drafts are).

Built so far: the catalog's wiring types (1, 2026-10-27) and what each
resource provides and depends on, with deletes of what others depend on
waiting for an admin (3, 2026-10-28); the preview offering existing
resources and suggestions (4, 2026-10-28); and checkout, PlaceOrder and
the Catalog's cart, with wired targets held to allowedTargets for every
run (5, 2026-10-28).

Decided on review (2026-10-27): members check out carts (5), without a
maintainer; ordering bots still order templates only. Every existing
resource of a needed type that the caller may see is offered, none chosen
by default, except APIs published through the gateway (decision 20):
those are called through the gateway, under its sharing and rates, never
wired into a run as a dependency. Deleting something others depend on (3)
is refused and alerts the admins; it goes ahead only once an admin
approves it, and the approval is audited as theirs.

**26. One gateway, and who may call each API** (proposed 2026-11-05,
revised and approved the same day with the owner; built 2026-11-05: the
access list in `console/src/core/apiAccess.ts` and the gateway's
`accessFor`, its pages from chapter 15 of the mockups canvas). Before it,
every API was a path on the gateway's one host (`/<team>/<api>/`), shared
team by team by its `api.yaml`'s `shareWith`, and a team without access
asked for it by opening an issue: access was a pull request to someone
else's catalog folder, and it was granted to whole teams, not to the
people and services that call. Decided:

1. *The gateway assigns the endpoint, as a path:* each API stays at
   `/<team>/<api>/` on the gateway's one host, as Google's API Gateway
   serves every API under one address. The catalog doesn't choose it: it
   follows from the team and the API's name, and a renamed API is a new
   endpoint. One host means one certificate and one DNS name for the whole
   install, however many teams it has, from wherever the organisation gets
   them (its own CA, the cloud's certificate service, cert-manager).
2. *A pass-through:* the gateway routes each request to the team's
   backend and its answer back, whatever it is (JSON, HTML, nothing),
   swapping only the caller's credential for the backend's and adding
   `Vennir-Caller`. The one origin all APIs share doesn't let one reach
   another through a browser: the gateway takes only a bearer token in
   `Authorization`, which a browser never sends when it opens a link or a
   frame, so no browser can load an API's page there as a signed-in person.
3. *An access list per API, held by the console:* each API has grants,
   each naming either a single sign-on group (everyone in it may call:
   groups as read at sign-in, at most an hour old) or one user, a person
   or a bot (bots aren't in groups, so each service that calls an API is
   named). Each grant has its own rate (by default the API's limit) and
   can be changed or revoked. The API's own team's members and bots may
   always call it; admins may not, unless granted, and a grant to
   themselves is audited like any other. Anyone else is refused (403) at
   the gateway and never reaches the backend; a revoked grant stops calls
   within the gateway's cache time (a minute at most). Grants are per
   install, like a secret store's credential.
4. *Who grants:* only the API's team's maintainers add grants, of groups
   or users. A person asks for access for themselves, with a reason,
   choosing which of their groups (none, or some) to offer for a group
   grant; the API's maintainers see only those, never the rest of their
   groups, and approve it (granting that person, or one of the groups they
   offered, never another) or decline it (decided 2026-11-06). A request
   may be withdrawn while it waits, and asked again at once after a
   decline, shown beside it. Each step is audited and told to the person
   and the API's maintainers. A bot's grant is asked for (and its request
   withdrawn) by its team's maintainers, the bot's owners. The API's
   maintainers change or revoke any grant; an admin may revoke one (an
   incident) but not add or change it; a person may give up their own, and
   a bot's team its bot's. A group's rate is each member's.
5. *What the catalog says:* `api.yaml`'s `access` replaces `shareWith`:

   ```yaml
   access:
     requests: approval   # open (granted at once) | approval | closed
   ```

   Closed refuses new requests; grants already made stay until revoked.
   An API that leaves the catalog's release keeps its grants and requests
   for 30 days (listed as away, revocable by its team's maintainers and
   admins, letting nobody call), gets them back if it returns under the
   same team and name within them, and loses them after (built
   2026-11-05).
   During the release with both, a `shareWith` team's members and bots
   keep calling, marked "from the catalog" (not revocable in the console;
   their named limit kept), and the catalog tool warns that `shareWith` is
   going away, so the API's team grants them properly first.

Rejected: a host per API (`<api>.<team>.<apiDomain>`, proposed first: a
wildcard certificate and DNS record per team, which a large organisation's
certificate authority and rate limits don't scale to, for a browser risk
the bearer-only sign-in doesn't have); team subscriptions (a team is too
coarse: every member and every bot it makes would get in); grants as
catalog pull requests (every grant a change to someone else's folder, and
the same grant on every install); a grant to a whole team as a group
(broader than a bot's own grant, for convenience only).

Open: whether a grant expires (proposed: no, but the API's team sees each
grant's last call, and may revoke unused ones; `TODO.md`, "A grant's last
call"). `shareWith` goes from `api.yaml` in the release after the one with
both (`TODO.md`).

**27. The cluster's policies from the catalog, written by the kernel**
(proposed 2026-11-05; part 1 built 2026-11-06, below). The console keeps the admission policies' literals
current: which digests are a product's releases and as which
ServiceAccount, with which token audiences (the identity policy), each
API's ServiceAccount's audiences, the scan allowlist, the image sources,
and each team's secret names. So whoever controls the console can loosen
them: a compromised console could let an unreviewed image run as a
product's identity. Proposed:

1. *A process of the kernel's, `kernel policy`,* with a ServiceAccount of
   its own, pulls the catalog release the console reads (`catalog.release`)
   and verifies its signature itself, against the signers the kernel chart
   trusts (set at install, never by the console). From it, it writes what
   the catalog decides: each product's released digests with their
   ServiceAccount and token audiences, and each API's ServiceAccount's
   audiences. An earlier release stays allowed while it's in use, as now
   (an unfinished task runs it, read from the kernel's own database, or it
   was in a release in the last hour).
2. *Split policies:* those rules move to policies only it may update (RBAC
   by name; the console's write fence refuses them). The console keeps
   what the console decides, in policies of its own: each team's secret
   names, the image sources, the scan allowlist. Admission policies all
   apply, so a step must pass both: a reviewed release run as its own
   ServiceAccount, and only its team's registered secrets.
3. *Upgrading:* the new policies are seeded from the current ones (the
   chart's `lookup`, as now). The kernel writes them for a release while the
   console still writes the old ones; the next release drops the console's.

What it doesn't change: the console still writes team Secrets (that's how a
secret is registered), sets image sources and accepts scans, and submits
runs. So a compromised console can still put a value in a team's Secret or
run a reviewed product with inputs it chooses; it can't make an image no
release names run as a product, or give an API's ServiceAccount an audience
its `api.yaml` doesn't need. An install without a signed catalog
(`catalog.signature` trusting nobody) keeps the console's writes, and the
Admin page says so.

Rejected: a policy engine (Kyverno, Gatekeeper) beside the admission
policies (a second policy language, and the same question of who writes
its rules); signing each policy edit (the console would hold the key).

*How it's built* (2026-11-06):

- *Verifying:* `kernel policy` (`kernel/internal/policy`) verifies the
  release with cosign's Go library (`github.com/sigstore/cosign/v3`,
  v3.1.3, `pkg/cosign.VerifyImageSignatures`), the code the console's
  cosign Job runs, with the same checks: each trusted public key with no
  transparency log (catalog CI's key signing), then keyless (Fulcio's chain
  from Sigstore's TUF root, the embedded SCT, the Rekor entry the signature
  carries, checked offline, and the issuer and subject). Not sigstore-go:
  it verifies only Sigstore bundles, and catalog CI signs in cosign's older
  format (`--new-bundle-format=false`, a `.sig` tag), which only cosign
  reads. A release older than the one applied is refused, as the console
  refuses one. It needs rekor 1.5.5 or later (and sigstore-go 1.4.0):
  rekor's PGP entry type, which cosign's verifier reaches, used the
  deprecated `golang.org/x/crypto/openpgp` before, with a vulnerability that
  won't be fixed (govulncheck GO-2026-5932), and ProtonMail's maintained
  `go-crypto` since. The binary grows by about 25 MB.
- *What moved:* two policies in the kernel chart that only its
  ServiceAccount may update (RBAC by name; admission policies don't apply
  to admission policy objects, so the write fence can't help): `-catalog-
  identity` (a step runs a released digest as its product's ServiceAccount
  and token audiences, or as `default` with no Secrets and no tokens; and,
  as the console's says too, one container, Secrets only as volumes, never
  ESO's ServiceAccounts) and `-catalog-tokens` (the audiences each API's
  ServiceAccount may be minted, as the release's `api.yaml`s need them,
  with `gateway.gcp.tokenAudience` given to the kernel chart too). The
  kernel computes them as `productPolicy.ts` and `gatewayTokenPolicy.ts`
  do, its earlier releases kept for an hour after a release dropped them,
  or while an execution submitted before then runs one and is still moving
  (bounded per step by `catalogPolicy.inUseMaxSeconds` and in all by
  `inUseLimitSeconds`, so a console asking for retries can't keep one
  forever), and only while a signer that verified that release is still
  trusted (its own tables).
  Both are seeded on upgrade from the console's current ones (lookup), and
  written only once it has applied a verified release, so an install
  doesn't refuse every step while it first reads the catalog.
- *What stayed:* the console's own policies, ANDed with the kernel's: team
  secret names, image sources, the scan allowlist, and its gateway token
  policy, which also narrows an API's audiences to none when an admin's
  backend rules hold it or its team is retired (an admin's decision, not
  the catalog's). Products registered by hand, and platform products, run
  as products only with an unsigned catalog: with a signed one, the
  console refuses to submit a step the kernel's policy doesn't list
  (`IDENTITY_PENDING`, also while the kernel hasn't read a new release
  yet).
- *Upgrading:* this release, both write: the kernel its policies, the
  console its identity policy whole (releases too) and its gateway token
  policy. The next drops the releases from the console's identity policy
  when the kernel writes them, leaving it the secret names. An install
  whose catalog trusts no signer runs no `kernel policy` and keeps the
  console writing them, and the Admin page says which.
- *Which teams:* every team the release names, including one made by hand
  that the console hasn't adopted (decided with the user 2026-11-06):
  adopting is the console's choice about managing a team, not about which
  images run as which ServiceAccount there, which is the signed catalog's.
- *Refusals said:* the newest release refused (unsigned, older than the one
  applied, as when someone who can push tags but not sign points a higher
  version at an older release) holds back every release after it, so it's
  a metric (`kernel_catalog_policy_newest_refused`) and an annotation on
  the identity policy that the Admin page's Policies card shows. The
  cluster's own audiences are checked again at every write, and in the
  policy's CEL, so a changed `api.auth.audience` holds without a release.
- *Reading the registry:* anonymously, with a Docker config Secret by name,
  or as its own ServiceAccount's cloud identity (GKE's metadata server,
  ECR), with the console's mirrors; never as the console. GKE and EKS
  installs keep it off until that identity may read the catalog's registry
  (`TODO.md`).

## 18. Roadmap

None of these needs a new service. All contract changes are additive.

**P0: correctness and isolation**

| Item | Changes a contract | Tests | Size |
| --- | --- | --- | --- |
| R1: delete Jobs only after the commit | No | FakeExecutor and kind | S |
| R2: failed status reads aren't failures; stop a Job before retrying | No | FakeExecutor | S–M |
| M1: pull-based registration (resolves S1) | Catalog CI and console | Console tests; a CI run | M |
| A1: consumer role and templates with fixed secret references | Additive (`dags/` parameters, a membership role) | Console authorization tests | M |
| S3: default-deny ingress per team namespace | No | Policy test on kind | S |
| I1 and I2: projected token audiences; Pod labels | Additive (`product.yaml`, kernel setting) | kind, and one proof per cloud | M |

**P1: foundations**

- Inputs checked at submit and before each step; outputs checked (C1).
- Exports (X2).
- Allowed targets per team; owner identities scoped to folders (X1).
- Retry policy and idempotency per action (R3).
- Compatibility checks and `deprecated` (C2).
- Who asked and who acted, on every attempt; attempts in the API.
- Samples reading identity references from team secrets (S2).
- Registry access across clouds (M2) (done 2026-10-22).

With A1 in P0: secret bindings per action in `product.yaml`, and rules
for what consumers may do to runs (cancel and retry their own).

**P1 additions**

- Roles (admin, maintainer, consumer), then SSO groups mapped to them.
- `visibility` on actions; "not shared with you" with Ask for access.
- Approvals (a waiting state in the kernel) (done 2026-10-21).
- Failure help: error codes in `product.yaml`, help contacts in
  `team.yaml`.
- Concurrency keys per product.

**P2: the marketplace**

- Forms from schemas (TODO, Console).
- Readiness per install.
- Caps per product.
- Schedules.
- Compose, with drafts and Propose as a template.
- The Runs list, run timeline, Teams pages and Admin, as mocked up.
- Preview (`plan` actions).
- The `resources` output convention, what a run created, cleanup.
- Notifications; copy as API call; runnable examples; run again with
  changes.

**P3: later**

- Golden-path rules; runtime-dependency metadata.
- Azure; GitLab; several catalog repositories.
- Environments and promotion (catalog versions: decision 22); saved inputs; live updates; cost hints.
- Discovering targets; build provenance.

## 19. The smallest architecture that does it

The same pieces as today: the console and its database, kernel-api and the
scheduler and their database, the admission policies, one Git catalog, Jobs.
Everything above is columns, tables, `product.yaml` and `team.yaml` fields,
entries in the policies' lists and console pages.

- **Console:** consumer role, templates, exports, targets, readiness,
  schedules, schema forms and checks, pulling the catalog.
- **Kernel:** deleting Jobs after the commit, read errors, projected tokens,
  attempt history, checking resolved inputs against a given schema.
- **Identity policy:** projected token volumes; secret references bound by
  templates.

## 20. What should not change

- Postgres-only coordination; leases with adoption; a Job name per attempt.
- The kernel knowing nothing of users, teams or credentials, and accepting
  only the console.
- The container contract: files in, `result.json` out, the action as its
  argument, no SDK.
- Identity from reviewed `product.yaml`, enforced by the console and the
  cluster.
- Pinned, scanned and signed images; policies with their lists as CEL
  literals.
- Team, namespace and catalog folder as one name; retire and purge, with the
  right to purge withheld.
- A console that can't read Secrets, creates no RBAC and writes only inside
  its fence.
- Git for definitions, Postgres for runtime state.
- At least once, with idempotent products, said plainly.

## 21. Answers in brief

1. **Git as the catalog?** Yes, with consoles pulling reviewed `main`.
2. **Kubernetes Jobs?** Yes.
3. **Postgres for scheduling?** Yes, once R1 and R2 are fixed and it's
   proven at scale.
4. **From Temporal:** retry policy per action, a maximum queued age,
   per-attempt history, optional progress. Not replay or SDKs.
5. **From Inngest:** caps per product, schedules, forms for single actions,
   the run timeline. Fair claiming later.
6. **Team secrets holding identity references?** Sustainable, with owners
   binding them in templates and consumers never choosing.
7. **AWS and Azure equivalents of GCP impersonation:** a role ARN or managed
   identity client ID in a team secret; the product's ServiceAccount as the
   source (Pod Identity, web identity, Workload Identity Federation); the
   target's trust policy or federated credential as the grant.
8. **Permission creep:** one source identity per product with rights only
   to its targets, owner identities scoped to folders, no deployment-wide
   identities, bindings changed in Git, the acting principal recorded,
   readiness checks for drift.
9. **Which accounts are available:** allowed targets per team in the
   catalog, plus readiness per install. No live discovery.
10. **Golden paths:** exports now; a rule table in Git later.
11. **Five changes before production:** R1 and R2, M1, A1, S3, I1 and I2.
12. **Postponed:** golden-path rules, runtime-dependency metadata, several
    catalog repositories, live discovery, priorities, compensation, GitLab,
    anything shaped like an SDK or an event bus.
