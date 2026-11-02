# TODO

Open work, roughly by area. Before starting something here, check the code:
an item may be partly done. When you finish one, remove it; when you find a
new one, add it. Larger items are worth an issue first, to agree on the
design.

## Next, in order (agreed 2026-10-29 and 2026-10-30)

Solid before features: housekeeping and tests first, then features with
steps left, then one billed proof run per cloud, and the MCP server and
Azure last.

1. ~~Managed Prometheus on AWS~~ (done 2026-10-30, `--monitoring amazon`:
   the bundled Prometheus writing to an AMP workspace, its alerts through
   the workspace's Alertmanager to SNS and an email; proven on kind against
   stand-ins, a real alert delivered; the signing and SNS in the billed
   run).
2. ~~The bundled Prometheus's firing alerts on the Observe page~~ (done
   2026-10-30, #45: Observe's Metrics shows the charts' alerts from any
   Prometheus, `monitoring.prometheusUrl`, the bundled one by default;
   proven against a real Prometheus; on kind with the bundled one, left).
3. ~~The run page saying whether a manual retry is safe (the action's
   `idempotent`)~~ (built with the owner's failure help, before the
   redesign: a failed step's **Safe to retry?**).
4. ~~Readiness checks (`check`) for the gcp and aws samples' products~~
   (built 2026-10-30, unit and contract tests; proven in the billed run).
5. What can be built before the billed run: ~~the reverse cross-cloud
   catalog read (ECR from GKE), an aws reader of another account's ECR,
   `vertra`'s command for the catalog owner's grant~~ (built 2026-10-30,
   below), ~~policy-controller on EKS~~ (proven 2026-10-27), ~~a sample
   federating with its product token~~ (2026-10-31: the aws sample's
   `caller-identity`, seen on kind; proven in the billed run, below).
6. The rest of the performance work (below): ~~sustained and higher
   scenarios, Postgres and the API server going away, API load through the
   console, where per-team usage comes from~~ (2026-10-31, phase 3,
   `perf/README.md`: Postgres's restart crashed the console and stalled
   everything two minutes, fixed in #50; one console serves about 115
   reads a second; per-team usage from the console's runs, about 50 ms);
   then cancelling as steps finish (clean), runs compared (`perf`'s
   `compare`) and the `perf` workflow (by hand or weekly, compared with its
   last run); ~~a create that timed out but happened, seen for real~~
   (2026-10-31, `perf/slowcreate/`: adopted by the retry; most the API
   server drops with the kernel); ~~building the per-team usage~~
   (2026-10-31, #52: Observe's Usage tab and the Teams page's cards, `console/src/core/usage.ts`);
   ~~the `perf` workflow's first run~~ (2026-10-31, after #55's Linux
   fixes: 12 minutes, both scenarios correct).
7. ~~The billed proof run, one session per cloud, destroyed after~~
   (done 2026-10-31 on GKE and 2026-11-01 on EKS, released 0.6.0, both
   destroyed with nothing left but the write-once audit buckets; what it
   found is under "Found in the billed run", below; perf's figures in
   `perf/README.md`). All of the plan was proven but `make gke-deploy
   VERSION=` (the run installed the release with `vertra apply` instead).
   The plan, GKE: released images (`make gke-deploy VERSION=`), Managed
   Service for Prometheus, the bundled Prometheus on a cloud volume, the
   audit copy compared on GCS, the gcp sample's API product and per-product
   grants, catalog CI's SBOM attestation, the scheduler at scale (relists,
   rate limits at 50/100, Spot retries), the client limits, why a minimal
   Autopilot install had three nodes, an existing Postgres volume moved to
   non-root (`postgres.nonRoot: true`), the aws sample's `caller-identity`
   signing in to AWS from the GKE cluster (an IAM OIDC provider for its
   issuer; free, STS only), size figures. EKS: SecretStores set up
   by `vertra`, the S3 audit bucket and its comparison, Amazon Managed
   Prometheus, the aws sample's API product, products choosing Spot,
   non-root Postgres on EBS, `vertra destroy` with an unanswering cluster,
   the scheduler at scale, size figures.
8. What the billed run found (below; the password `apply` printed was
   fixed in #61).
9. Last: the MCP server, then Azure (its target, its managed Prometheus,
   the Azure sample signing in).

Blocked: the chat agent on Bedrock (the account's model access) and
Sigstore's newer signature format (policy-controller). Needs a decision:
masking Secret values in logs (suggested: leave it, documented).

## Found in the billed run (2026-10-31 and 2026-11-01)

Released 0.6.0 on GKE Autopilot and EKS standard. Each item names where
it was seen.

`vertra`:
- [ ] **`catalog-template/vertra` in git pins the previous release** until
  `pin-vertra.sh` is run after a release (0.6.0's pinned 0.5.2). `vertra
  catalog create` now pins the release it is; a catalog made from the
  template by hand needs `pin-vertra.sh`. Worth a release step that opens
  the pin's pull request.
- [ ] `apply`'s cost leaves out the optional parts' volumes (log search's
  10 GiB, the bundled Prometheus's 2 GiB); their CPU and memory are counted.

Console and gateway:
- [ ] **Observe's alerts with Google's managed Prometheus** say "not
  configured": the console reads `/api/v1/rules`, which GMP doesn't serve.
  It could list the charts' `Rules` from the cluster (a read on
  `rules.monitoring.googleapis.com`) and which fire from GMP's query API
  (`ALERTS`, at `monitoring.googleapis.com/v1/projects/<p>/location/global/prometheus`),
  which needs the console's Google identity granted `roles/monitoring.viewer`
  (the gcp module) and a GKE run to prove. Card's text on the canvas first.

Kernel and alerts:
- [ ] Completion lag rose from 3 s to 12 s p50 on GKE with steps waiting
  for nodes (`perf/README.md`, "On GKE and EKS"): worth a look.

Samples and catalog CI:
- [ ] **A product can't say which installs it's for**: one catalog serves
  installs on several clouds, so an aws product on a GKE install shows
  "not ready" (its check can't sign in by EKS Pod Identity) when it was
  never meant to run there. A product (or team) could declare its targets
  (`targets: [aws]`, catalog format, both schemas: `tools/` and
  `cli/internal/catalogtool/schemas/`); the console would list it as "not
  for this install" on the catalog, Every product and the run form, skip
  its readiness checks, and refuse to run it there, instead of "not
  ready". Readiness proves only the identity path on this install; whether
  a product works stays the platform team's tests and catalog CI's.
- [ ] **gcp `app-hosting`**: Cloud Run's create needs the deployer to read
  the image's repository (`roles/artifactregistry.reader`), missing from
  its README; its PERMISSION_DENIED was retried three times as
  `GCP_API_ERROR` (should not be retryable); `hello-world`'s api.yaml gives
  the Workload Identity principal in other clusters' form only (GKE's own
  pool is `subject/ns/<ns>/sa/<sa>`).
- [ ] The SBOM attestation's subject name is the scan's temporary tar path,
  not the image.

## Installing and operating

- [x] **A burst that starts a counter can't fire its alert** (found proving
  #45 on kind; fixed 2026-10-30, #46): a series born holding a burst has no
  lower sample, so `increase()` missed the 70 failed sign-ins that made
  `VertraSignInBurst`'s. The console now starts the series its alerts
  measure at zero (sign-in's, by every code; each catalog check outcome);
  proven on kind, firing on the first burst. The other alerts were checked:
  the kernel's tick errors are an unlabelled counter, exported at 0; the
  gateway's per-API counter and the console's internal errors back alerts
  that wait 10 minutes, so later increments count.

- [x] **An upgrade of a minimal standard-mode EKS install can stall**
  (found 2026-10-29): rolling kernel-api and the scheduler runs old and new
  copies at once, the one platform node in Postgres's zone runs out of
  memory, and the autoscaler's extra node may come up in the other zone,
  where Postgres's EBS volume can't follow. Helm times out; scaling
  kernel-api and the scheduler to 0 until Postgres is up recovers it. Fixed
  2026-10-29: standard mode's platform group is in one zone (the first), so
  every node it adds is where the platform's volumes are; steps keep both.
  An install made before keeps its two-zone group (`ignore_changes`: new
  subnets would replace the group, and its volumes may be in the zone
  dropped). Seen on standard-mode EKS (2026-10-29): minimal to resilient,
  Postgres restarting with more memory and two copies of the rest, two
  nodes added, both in Postgres's zone, done in 3m10s unattended. Found
  doing it: a cloud install's database volume never grew with its size
  (kept at its current size, as kind's must be); it grows now (10 to 50
  GiB, online), and the size table (approval screen, cost) has Postgres's
  new requests.

- [x] **A managed database: Cloud SQL on gcp, RDS on aws (2026-10-29)**:
  `database.type: managed` (`vertra init --database managed`, asked on gcp),
  `database.highAvailability`. Cloud SQL for PostgreSQL 16 at a private IP,
  SSL only, tier and connections by size, Google's backups with
  point-in-time recovery; no passwords: the kernel, console and gateway
  each sign in as their own Google identity (IAM database authentication),
  the gateway by federating its own ServiceAccount token (its NetworkPolicy
  keeps it from the metadata server), after `kernel database-setup`, as an
  administrator identity, opened each database to its own service alone.
  Proven on GKE Autopilot in acyclix-dev (us-east1): installed, a team and
  a step run, the console refused the kernel's database; then destroyed.
  Found doing it: node-postgres let its parsed URL's empty password replace
  the token; destroy couldn't delete a protected instance, nor drop a user
  that owns tables (the instance's protection lifted and its databases and
  users abandoned to go with it, applied first, as the buckets' are); the
  gateway can't reach the metadata server.
  On aws (2026-10-29): Amazon RDS for PostgreSQL 16 in the install's VPC,
  no public access, TLS checked in full against Amazon's RDS certificates;
  each service's role signs a 15-minute token (EKS Pod Identity); RDS keeps
  its administrator's password in Secrets Manager, read only by
  database-setup's role, which makes the databases and the rds_iam users.
  Proven on standard-mode EKS in us-east-2 the same way (a team, a step, the
  console refused the kernel's database), then destroyed. Found doing it:
  the gateway's ECR repository was never made (no install had run it on
  aws). Still to do: moving an existing install's data from the in-cluster
  Postgres (apply refuses the switch).

- [x] **Postgres sized to the install (2026-10-29)**: each size sets its
  memory, settings to match and every process's connection pool (all under
  `max_connections`), with no CPU limit and a /dev/shm of its own; measured
  with `perf/pgbench/run.sh` (`perf/README.md`): writes at 64 clients 2.5
  times the old, latency 43 → 17 ms. Still one instance in one zone: past
  `scaled`, or for failover, a managed database (below).

- [x] **Observe: security checks, logs and metrics for everyone**
  (done 2026-10-22, added to through 2026-10-30; mocked up 2026-10-21,
  boards 17–19). One console section with tabs:
  - Security checks (done 2026-10-22: `ObserveService.GetSecurity`, the
    Observe page's first tab): what the cluster enforces (and what it
    doesn't yet), every allowed image with its scan, and every refusal
    (admission codes via kernel-api's `ListRefusals`, and a catalog release
    that couldn't be applied). Each image's SBOM (done 2026-10-27): catalog
    CI attaches it, from its scan, as a CycloneDX attestation signed as the
    image is, and Observe offers it for download (an image the caller may
    see); the release check names the signer. Not yet seen end to end:
    attesting needs cosign, so the next cloud catalog run proves it.
  - Logs (done 2026-10-22, proven on kind: `ObserveService.SearchLogs`,
    the Observe page's Logs tab, the console chart's `logs`): Grafana Alloy
    reads steps' and the platform's Pods through the Kubernetes API,
    redacts credentials with the kernel's patterns (a kernel test keeps
    them equal) and sends them to one Loki, labelled with team, level and
    source, and the run, task, attempt and image as structured metadata.
    The console adds the caller's visibility to every query. Searchable
    `searchDays` (30); on gcp and aws, `vertra` makes the bucket, whose
    lifecycle moves chunks to Archive / Glacier Instant Retrieval then, and
    deletes them after `keepDays` (365). The scheduler keeps a finished
    step's Job 30 s (`scheduler.releaseFinishedAfterSeconds`) so even a
    short step's output is collected. Proven on GKE (2026-10-22): the
    bucket and its rules, Loki writing through Workload Identity, and
    reading back chunks moved to Archive after a restart wiped its local
    copy (which also showed a restart lost the not-yet-uploaded logs: Loki
    now always has a volume). And on EKS: the bucket and its rules, Loki
    writing through Pod Identity, reading back chunks moved to Glacier
    Instant Retrieval with its volume deleted, and a restart keeping its
    volume losing nothing. API backends' logs (done 2026-10-29): Pods a
    team labels `vertra/api-backend` are collected as `component="api"`,
    every level to their own team only (Logs tab, From: API backends);
    proven on kind with the greetings backend. Left, needing a decision
    (2026-10-29): Secret values (not just credential shapes) masked:
    masking a value needs its value, so something would have to read
    every team's Secrets (the collector, or the scheduler), which the
    platform deliberately lets nothing do; credential shapes are redacted,
    products must never print a secret, and a step's non-INFO lines reach
    only its own team. Suggested: leave it, documented.
  - Metrics (done 2026-10-22): the Observe page's Metrics tab for
    everyone, from kernel-api's own tables (`GetStats`: steps started and
    their p95 wait by hour, failures by code, each product's step times),
    so it needs no metrics system. For admins: the console's `console_*`
    metrics on a port of its own, the scheduler's queue gauges
    (`kernel_tasks`, `kernel_oldest_ready_task_age_seconds`), PodMonitors,
    PrometheusRules and a Grafana dashboard in the charts (`monitoring`, off
    by default), with every metrics port open only to
    `networkPolicy.metricsFrom`. Proven on kind with kube-prometheus-stack
    92.1.0 (2026-10-22): all four components scraped through the
    PodMonitors, all seven alerts loaded, the dashboard in Grafana with its
    queries answering; `vertra init` finds the operator and its selector
    labels (`--monitoring`). Two more providers (done 2026-10-30,
    `monitoring.provider`): GKE's Managed Service for Prometheus (its
    `PodMonitoring` and `Rules`, the kernel's TLS CA readable by its
    collector; checked against GMP v0.17.0's CRDs by a server dry run on
    kind) and a bundled Prometheus in the console chart (proven on kind:
    all four components scraped, kernel-api over TLS, both charts' seven
    alerts loaded, a kernel-only upgrade's rule change picked up in 70 s
    without a restart). And Amazon Managed Service for Prometheus (vertra's
    `amazon`, aws): the bundled one writing to the module's workspace as
    `vertra-prometheus` (Pod Identity, only RemoteWrite and
    CreateAlertManagerAlerts on it), its alerts through the workspace's
    Alertmanager to an SNS topic and an email. Proven on kind against
    stand-ins (a receiving Prometheus and an Alertmanager): every
    component's samples arrived labelled with the cluster, and a
    crash-looping scheduler's VertraSchedulerDown fired after its 10
    minutes and reached the Alertmanager. `vertra init`
    offers each (google on gcp, amazon on aws). The alerts' behaviour is
    tested by promtool in CI (`helm/tests/prometheus-rules.sh`). Proven in
    the billed run: google on GKE (every component scraped), bundled on a
    GKE persistent disk, amazon on EKS (SigV4 through Pod Identity, a sign-in
    burst's alert through AMP's Alertmanager to SNS). Left: Observe's alerts
    with google (below).
  - The audit log (done 2026-10-22: `ObserveService.ListAudit`, the
    Observe page's Audit log tab): an admin sees every entry; anyone else
    their own, and what was done to their teams or to runs in them, by
    anyone. An entry records the run a call started, so a submission
    reaches every team in it. Filters: a team, only mine, only refused.
  Who sees a step's logs, by level (decided 2026-10-21; done 2026-10-22 for
  the step output the kernel captures: `console/src/logLevels.ts`, every
  sample logging JSON INFO lines): INFO lines to
  everyone who can see the run, with Secrets masked; DEBUG, WARN and ERROR
  to the product's team (and admins). Steps log JSON lines with a `level`
  (plain lines count as DEBUG, so nothing is shown to consumers by
  accident); the level becomes a Loki label, and the console filters on it
  by the caller's role. The product docs say: write INFO for consumers.

- [ ] **An installer CLI, `vertra`**, in Go (one static binary per OS,
  released signed with the platform). Step 1 of `cli/DESIGN.md`'s build
  order is in `cli/`: kind (local) and existing clusters, `init`, `check`,
  `apply`, `status`, `sleep`, `wake`, `destroy`, `config`, `tools`. Step 2,
  the chart features, is in the charts: size presets (`sizes/`), the
  sleeper, the idle scanner, headroom, PodDisruptionBudgets and the `auto`
  autoscalers. Step 3, gcp, is in: the OpenTofu module (Autopilot and
  Standard), live list prices, apply and destroy; signing (2026-10-26) and
  catalog federation are in, and Cloud SQL and account prices (2026-10-29). Step 4, the catalog on GitHub, is proven (repository,
  federation, CI publishing, a starter run on Spot). Step 5, aws, is proven
  on EKS Auto Mode in us-east-2 (2026-10-18): install, ECR pinning and scans
  through Pod Identity, S3 backups, sleep (nodes gone in about a minute) and
  wake, destroy. Standard mode is proven too (node groups, the EBS and Pod
  Identity add-ons, the Cluster Autoscaler: a step scaled the Spot steps
  group 0 → 1 and back). Since proven (2026-10-19): standard mode's
  platform group settles at one node once the scanner idles; the public
  console on Auto Mode (Route 53 zone, ACM certificate, Auto Mode's load
  balancer, the alias record); the catalog on AWS (a private test
  repository publishing to ECR through GitHub's OIDC role, keyed to
  GitHub's immutable subject, and a starter run); the AWS sample (each
  product as its own ServiceAccount and IAM role by Pod Identity: the
  bucket → App Runner DAG and an RDS instance, then deleted). That run found
  two bugs in images pinned as `repo:tag@sha256:…`, now fixed: the identity
  policy kept the tag on the repository (so a registered product with its
  own ServiceAccount was refused), and the console's registry check asked
  for a repository named with its tag (so retries said the image was gone).
  Just Ship It was left empty afterwards (2026-10-19). The test catalog
  repositories (rburns629/vertra-catalog-test, -aws-test) are kept for
  now. The AWS sample's SecretStore is proven (2026-10-27). A managed database
  (Cloud SQL, RDS) is proven (2026-10-29). Help (2026-10-29): every command
  has its own, with examples; `vertra help settings` and `vertra help
  sizes`; `vertra man` writes man pages, and each release attaches them. `vertra
  logs`; upgrade advice (newer releases, releases passed over, no
  downgrades); `vertra backup`, `backups` and `restore`; moving an
  install's data into a managed database at apply (2026-10-29: proven on
  kind, and on GKE Autopilot with Cloud SQL and EKS standard with RDS: a
  bucket backup, its restore, the move with a run seeded before it found
  after and a new step run, and an on-demand managed backup). Monitoring
  (2026-10-30): `init` offers the cluster's Prometheus Operator, GKE's
  managed Prometheus or a bundled one. The sizes' figures, measured in the
  billed run: `minimal` requests 600m and 1856Mi on GKE (650m with EKS's
  Prometheus), idle use a tenth of that. Left: GitLab as a second git host
  (decided below, not started); the azure target (last).
  Decided 2026-10-18:
  - **Targets:** `kind (local)`, `gcp`, `aws`, `azure`, `existing`. Cluster
    mode when the CLI creates one: `auto` (GKE Autopilot, EKS Auto Mode, AKS
    Automatic), `standard` (a platform node pool, and a steps pool that
    scales from 0), or `existing`.
  - **Cloud side in OpenTofu** (open source; Terraform-compatible): one
    module per cloud for the cluster, network, registry, identities, signing
    key and backup bucket. `tofu plan` feeds the approval screen; changes and
    `destroy` come with it. Runs locally under the user's own cloud login;
    state in `deploy/<env>/` (optional remote backend). kind and existing
    don't use it. Vertra itself is installed with the Helm charts.
  - **Config:** `./deploy/<env>/vertra.yaml` (gitignored in this repo; safe
    to commit elsewhere: names only, secrets generated in the cluster), plus
    a Helm values passthrough for anything the CLI doesn't ask about.
  - **Size:** `minimal` (the absolute minimum), `resilient` (two copies,
    survives upgrades), `scaled` (three or more), `auto` (one to three on
    load): values files shipped with the charts (replicas, step caps,
    default step size, Spot), so Helm users get them too.
  - **Database**, for any size: in-cluster Postgres with daily backups to a
    bucket, or managed (Cloud SQL, RDS, Azure Flexible Server, high
    availability optional).
  - **macOS and Linux only.** `destroy` asks about each kind of data unless
    `--all`.
  - **Scale down:** a yes/no prompt, changeable later. Yes: the platform
    sleeps after an idle period and wakes with `vertra wake`. No: asks
    the always-on copies of the console and API (default from the size) and
    the warm headroom for steps. `sleep` and `wake` always work. The image
    scanner idles to zero regardless.
  - **Requirements first:** per target (kubectl, helm, tofu, docker and kind;
    gcloud, aws and eksctl, az and kubelogin; git and gh for `catalog`).
    Single binaries are downloaded on consent, checksum-verified, into
    `~/.vertra/bin`; installers (docker, gcloud, aws, az) get the exact
    install command instead.
  - **Approval screen** before anything changes: the whole configuration,
    what will be created and installed, and an estimated monthly cost from
    each cloud's live pricing API (always, awake, asleep, per step-hour, a
    likely total), with its limits stated. `--yes`, `--plan-only`; the
    approved plan is kept in `deploy/<env>/`.
  - **Then** `catalog` creates the catalog repository from
    `catalog-template/` with `gh` and the first team with starters for the
    languages picked, and runs one as a smoke test. `make quickstart`
    becomes a wrapper over it.
  - **Repository visibility:** public, private, or internal (offered only
    for an organization under GitHub Enterprise). `check` reads the
    owner's plan and policies (repository creation, allowed actions, OIDC)
    and the approval screen says which settings will be skipped (branch
    rules, secret scanning and Environment branch limits need a paid plan
    on a private repository).
  - **SSO and scopes:** a 403 from an organization's SAML enforcement is
    detected from GitHub's `X-GitHub-SSO` header; the CLI shows (and opens)
    the authorization URL, waits, and retries. Missing token scopes (`repo`,
    `workflow`) go through `gh auth refresh -s`.
  - **Git hosts behind one layer** (create a repository, variables and
    secrets, environments, protected branches, code owners, OIDC, SSO), so
    **GitLab** (gitlab.com and self-managed, public, internal and private,
    with `glab`) follows GitHub as a second implementation; the catalog
    template then ships GitLab CI wrappers over vertra catalog alongside its
    GitHub workflows.

- [x] **Guided access in `vertra init`** (done 2026-10-18:
  `internal/access`, `init_access.go`, `docs/clouds/`; proven read-only
  against Just Ship It, acyclix-dev and GitHub). Agreed 2026-10-18. Setting up AWS showed most of the effort goes on
  finding out which account you're in and what it allows. Before planning,
  per cloud: detect, show, then ask.
  - **Sign-in:** explain the options briefly, recommend one, and run the
    interactive command (`aws login` for one person, Identity Center for a
    team; `gcloud auth login` and `application-default login`; `gh auth
    login` with its scopes). Refuse root on AWS. With several sign-ins
    (gcloud accounts, AWS profiles, gh accounts), list them and save the
    choice.
  - **Where things go:** GCP projects you can use (which already hold
    resources; recommend a new one); the AWS account's name, ID and
    organization role (standalone, member, management); GitHub owners you
    can create repositories under.
  - **What it allows:** the regions that answer (pick from those); an
    organization's guardrails (AWS SCPs: tell a denial from a missing
    permission and name the policy; GCP org policies such as allowed
    locations or external IPs); billing linked, budgets (offer to create
    one), the free-plan state, AWS's spend-limit policies; gcloud and
    OpenTofu (ADC) signed in as different accounts.
  - Probes are tested functions that judge the whole response (a shell
    one-liner misread AWS's errors as success once).
  - An **Access** block on the approval screen ("rburns (IAM user) in
    Just Ship It (…0147), member of an organization; region us-east-2,
    the only one its organization allows; budget $20/month"), recorded in
    the config and re-checked on later runs.
  - Guides for what only a browser does (`docs/clouds/aws.md`, `gcp.md`,
    `github.md`: account, root MFA, Identity Center, budgets), linked from
    the CLI when it recognises a case: a Builder ID that isn't an account,
    an Identity Center account instance, an organization a sign-up made.
- [x] **Prove the AWS sample's SecretStore** (done 2026-10-27, EKS): ESO
  2.10 signed in as team platform's `eso-aws` by IRSA (the cluster's OIDC
  issuer registered in IAM by hand, a role trusting only that
  ServiceAccount and reading one secret), synced the secret, and a step
  mounted it. Pod Identity doesn't work for a store (it isn't the Pod's
  identity ESO uses); the sample said it did. The Azure samples are after
  the MVP (decided 2026-10-25).
- [x] **`vertra` sets up SecretStores on aws** (done 2026-10-27, proven on
  EKS 2026-11-01: a store signed in by IRSA synced a secret, and one
  outside the team's prefix was refused by AWS): the aws module registers the cluster's OIDC issuer
  in IAM, the console gets it (the Team page's AWS guide, now marked
  tested), and `externalSecrets: true` has `vertra apply` install External
  Secrets Operator 2.10.0, pinned.
- [ ] **A first step on a new GKE Autopilot install can time out**: seen on
  both GKE proofs (2026-10-26, 2026-10-27). Fixed (2026-10-27): a step's
  timeout counts from its container's start, and waiting to start has its
  own limit (`scheduler.taskStartTimeoutSeconds`, 10 minutes), past which it
  fails as `TASK_NOT_STARTED` (retryable) instead of a misleading
  `TASK_TIMEOUT`. Why a minimal install had three nodes (looked at in the
  billed run): every Vertra Pod was on one; the other two, in other zones,
  held only GKE's own Pods (DaemonSets, konnectivity-agent spread across
  zones, balloon Pods). Autopilot bills Pods, so they cost nothing, but
  their boot disks count against the project's SSD quota: at 500 GB, a
  step's node couldn't be added at 40 at once. `vertra apply` warns of
  the quota; a project raising it to 1000 GB was enough.
- [x] **Let a deployment label step Pods** (I2, done 2026-10-21):
  `scheduler.taskPodLabels` (`TASK_POD_LABELS`), on the step Pod only; the
  scheduler refuses to start with `app` or a `vertra.dev/*` key. Proven on
  kind (a step's Pod carried them). The identity policy checks Jobs, not
  Pods, so the volume AKS's webhook adds to the Pod isn't checked by it.
  Left: the Azure sample signing in, when Azure is proven.
- [x] **Prove backups on each cloud** (done 2026-10-26 for GCS and S3):
  on GKE Autopilot (Workload Identity) and EKS Auto Mode (Pod Identity),
  installs made by `vertra` with `database.backups` on, a backup run by hand
  copied both databases' dumps to the bucket `vertra` made; each downloaded
  dump restored cleanly into a throwaway database with every table. Azure
  Blob is after the MVP. The GCS backup image is Google's
  `google-cloud-cli:*-slim` from gcr.io (amd64 and arm64; Docker Hub's
  `google/cloud-sdk` is amd64 only), done 2026-10-26.
- [x] **Example values for EKS** (done 2026-10-27), `helm/values/eks/`, as
  `vertra apply` writes them, and a per-cloud guide to binding identities
  (docs/operations.md, Cloud identities). AKS is after the MVP, with Azure.
- [x] **Per-team ResourceQuota and LimitRange** (done 2026-10-26): written
  with each team namespace and on every policy resync (`teamQuota.ts`), from
  the console chart's `teamNamespaces.quota` or a team's own, which an admin
  sets on its Settings tab (`TeamService/SetTeamQuota`, console migration
  0030): CPU, memory and Pods together, and memory per step (CPU only in
  total, so a step may use spare CPU). The write fence accepts only those
  two names. A step that can never fit fails at once
  (`RESOURCES_NOT_ALLOWED`, read by the kernel from its Job's FailedCreate
  events); one waiting for room waits. Proven on kind: two runs with one Pod
  allowed both ran, one after the other; a 4Gi step against a 2Gi maximum
  failed in seconds; the fence refused another name and another namespace.
- [x] **Let a product choose its own capacity** (done 2026-10-27, proven
  on kind): product.yaml's `capacity` (spot or onDemand) reaches the kernel
  with each step, which runs it on the placement the install sets for that
  kind (`scheduler.capacityPlacements`) instead of its default; `vertra`
  sets them on GKE Autopilot (the gke-spot selector, or none) and EKS
  (Karpenter's capacity-type, the steps pool taking both when it uses
  Spot). GKE standard mode has one steps pool, so no choice. Not yet seen
  on a cloud.
- [x] **The console's liveness probe killed it once while it started** on a
  minimal GKE install (2026-10-25, exit 137 a minute after start): it has a
  startup probe now, five minutes long (done 2026-10-25).
- [x] **`vertra check` could warn about GCE's SSD quota** (done 2026-10-26:
  `vertra check` and `apply` warn when the region has room for fewer than
  four Autopilot nodes' disks; found
  2026-10-25): a new project's 500 GB `SSD_TOTAL_GB` in a region holds about
  three GKE Autopilot nodes' boot disks (about 140 GB each, counted but not
  listed), so a step's Spot node can't be added ("GCE quota exceeded") while
  three are up, and the step waits until one is scaled down.
- [x] **A resource whose cleanup run just failed shows "being deleted"**
  (done 2026-10-26: a delete asked for again checks the run with the kernel)
  for up to 30 seconds (until `resourceRecorder.ts` next looks at the run),
  so asking again at once is refused (`DELETE_IN_PROGRESS`). Read the run's
  own state when it's finished but not yet recorded.
- [x] **Alerts** (done 2026-10-27, proven on kind for purges and image
  source changes): a step the cluster refused (`step_refused`: the kernel's
  admission codes) tells admins and whoever ran it, and posts to its team's
  webhook if it wants that kind; a team purged, the allowed image sources
  changed, a policy sync failing ten minutes, a run's image gone from the
  registry (`platform_alert`) tell admins. Both are emailed by default.
  The refusal alert was seen for real on EKS (2026-10-27, the reader install).
  Admins' alerts in chat (done 2026-10-27, proven on kind): an admin
  chooses a team (Admin page) whose webhook may also get `platform_alert`,
  `catalog_failing` and every team's `step_refused`; a policy-sync alert is
  keyed by policy and day, so two consoles say it once.
- [ ] **Prove the scheduler at scale on a cloud cluster:** the watches
  surviving an API server restart and the 5-minute relist, API rate limits
  at `scheduler_executor_concurrency` 16, and a reclaimed Spot step failing
  as retryable and being retried, on each cloud.
- [x] **Batch the scheduler's per-task database work** (done 2026-10-27,
  proven on kind): a pass reads every running task's attempt, execution
  state and log capture at once, renews their leases in one statement, and
  writes its events in one (in order); a start updates its attempt in one
  statement and marks an execution running once. Against the test database:
  polling 30 running steps, 94 round trips (9.9 ms) → 7 (1.7 ms); starting
  30, 278 (9.3 each, 44 ms) → 159 (5.3 each, 19 ms). Tests guard both.

## Agreed direction

From the assessment of 2026-10-19 ([docs/assessment.md](docs/assessment.md);
IDs refer to its findings). P0 first; none of it needs a new service.
This comes before Azure and GitLab, which are deferred (the Azure items
elsewhere in this file wait until then; Azure is after the MVP, decided
2026-10-25).

Order of work (decided 2026-10-20): **0** R1, R2 and R4 in the Python
scheduler (done 2026-10-20). **1** The contracts: the console's API on Connect (protos,
generated clients for the frontend and `vertra`), the
catalog format version 2, the catalog tool ported to Go in the CLI's module,
the compatibility check. **Kernel track:** the kernel in Go, Python
removed (done 2026-10-20). **2** Pull-based registration. **3** Roles,
consumers, templates, exports, targets. **4** Schema checks and forms.
**5** Default-deny networking, projected tokens, identity references from
secrets. **6** Kernel features, in Go: retry policy, concurrency keys,
approvals, attempts, `WatchRun`. **7** The console pages. **8** API products
through the gateway (decision 20), bots with keyless sign-in. **9** Preview, what a run
created, examples. **10** Production: SSO, TLS, audit store, alerts, scale,
backups, docs; then CLI releases and a public repository.
Related items elsewhere in this file: default-deny between team
namespaces and who may read a multi-team execution (Security), Pod labels
for AKS Workload Identity (Installing), run forms from schemas (Console).

- [x] **Phase 1: the contracts** (decided 2026-10-20; done the same
  day). Done: `proto/` with all ten services, `make proto` (buf
  1.74.0; protoc-gen-es 2.16.0 from the console's npm, protoc-gen-go and
  protoc-gen-connect-go as tools in `cli/go.mod`), the generated code for
  the console, frontend and CLI, and the `proto` CI job; the API's logic
  in `console/src/core/`, every service served over Connect from
  `console/src/rpc/` with authentication, audit, rate limits and error
  masking as interceptors, and `WatchExecution` streaming; the frontend's
  `api.ts` on the generated clients (proven on kind: submit, watch,
  events, logs, retry, rerun); the execution page on `WatchExecution`
  instead of polling (proven in a browser on kind; the stream resends
  every 15s so idle timeouts don't cut it, and GKE's default 30s backend
  timeout just means a reconnect); `vertra`'s `internal/consoleapi`
  on the generated Go client (proven on kind: sign-in, `EnsureTeam`,
  token rotation, submit and watch); the catalog tool ported to Go
  (`cli/cmd/vertra`; the same verdicts as the Python tool on 37
  broken and unbroken catalogs, and `make catalog-publish` proven on kind:
  teams applied, five products built, tested, scanned, pushed and
  registered over Connect, then run); the REST routes, `openapi.ts` and
  their packages removed, every REST test ported to Connect (finding and
  fixing: an unset optional field refused, wiring type names unchecked,
  refusals' extra fields dropped, now `Failure.detail`), and the API
  reference built from the protos by `make proto`; catalog format v2
  (`apiVersion: vertra.dev/v2` and a `kind` in every file; actions'
  `secretRefs` bindings, `shareWith` and `deprecated`, recorded by the
  console; `kind: Template` with parameters and steps naming actions,
  checked by vertra catalog; `vertra catalog migrate`, which converted the
  template); the compatibility check (C2: `vertra catalog check --changed`
  compares each product with its last release on the base and refuses a
  breaking change unless its `version` is raised, and a removal unless it
  was deprecated first). Phase 1 is done. Load balancers need HTTP/2 end
  to end only for gRPC callers (the charts' Ingress and the CLI's AWS and
  GCP settings); the browser and both CLIs use Connect over HTTP/1.1.
- [x] **Renamed Acyclix to Vertra** (done 2026-10-20). Everything that
  carries the name: the CLI (`acyclixctl` is now `vertra`), Go modules
  (`github.com/rburns629/vertra/...`), protos and their routes
  (`/api/vertra.console.v1.*`), the catalog format (`vertra.dev/v2`, its
  settings file `vertra.yaml`), labels (`vertra/team`), the platform
  namespace (`vertra-system`), environment variables (`VERTRA_*`) and the
  kind cluster (`vertra-local`). `vertra catalog migrate` converts a catalog
  from before; `vertra catalog create` removes a repository's `ACYCLIX_*`
  variables. Not renamed: the GCP project `acyclix-dev`, a real resource.
  An install from before keeps its old labels and namespace: reinstall it
  (none outside kind existed).
- [x] **Kernel track: kernel-scheduler in Go** (done 2026-10-20).
  `kernel/cmd/kernel-scheduler` and `kernel/internal/` (pgx, client-go
  informers), against the same schema and settings, with the same Job
  names, handles, logs and metrics, so it adopts the Python scheduler's
  tasks in flight. Every Python scheduler and executor test ported (the
  scheduler's scenarios against the real test database; the executor's
  stubbed tests on client-go's fake; the kind tests as `TestKind*`, in
  CI's kubernetes job), then the Python scheduler, executor, their tests
  and settings removed. Proven on kind: two steps in flight under the
  Python scheduler adopted and finished on attempt 1; a Go-to-Go restart
  mid-step; chain, retries with backoff then a manual retry, cancel,
  timeout, a fan-out and join; Jobs released, metrics, liveness. Found
  and fixed on the way: the watch never marked Pods synced (every status
  was read from the API until the first Pod event), a 403 with no message
  gave an empty refusal, and a misspelt toleration was silently dropped
  (Python refused it). The scheduler's ClusterRole narrowed to the calls
  it makes (no `jobs/status`, no `get` on Pods or ConfigMaps).
- [x] **Kernel track: the rest of the kernel in Go, Python removed** (done
  2026-10-20). One binary, `kernel` (`api`, `scheduler`, `migrate`,
  `sleep`), on a distroless image (about 50 MB). kernel-api is
  `KernelService` (`proto/vertra/kernel/v1`) over Connect, with the same
  TokenReview caller check; the console calls it through the generated
  client (`console/src/kernel/client.ts`), which now refuses field names it
  didn't check, as kernel-api's pydantic models did. The schema is
  `kernel/internal/migrate/sql/`, recorded in `schema_migrations`, and an
  install Alembic migrated is taken over (proven identical by `pg_dump`).
  The sleeper scales through `GetScale`/`UpdateScale` (its Role: `update`
  on `deployments/scale`, not `patch`). Every Python test ported. Proven
  on kind, as an upgrade of a running install: the takeover, a run
  submitted through the Python kernel-api finished and read through the Go
  one, the console's whole execution path, a rerun of a DAG stored before,
  retries, cancel, timeout, fan-out, the caller check (no token 401, a
  step's token 403, the wrong audience 401), and a real scheduled sleep and
  wake under the sleeper's own Role. Then on GKE Autopilot in acyclix-dev,
  a fresh install by `vertra` (the scheduler waited for the migration
  hook): a chain passing an output, retries, cancel, a timeout, a fan-out
  on Spot, the caller check; then `vertra destroy --all`, leaving
  nothing but the project's own defaults. That run found client-go
  printing Autopilot's warning on every Job unstructured; each distinct
  API warning is now logged once, as JSON.
- [x] **Release `vertra` binaries, and pin one in the catalog
  template's `./vertra`** (done 2026-10-21: v0.2.2, pinned in
  `catalog-template/vertra`; the package is public with the repository).
  `release.yml`'s `cli` job builds
  linux/darwin × amd64/arm64, pushes each to `ghcr.io/<owner>/<repo>/cli`
  as one blob (its digest the binary's SHA-256), signs it and attaches
  it with `vertra-checksums.txt` to the release; `./vertra` downloads
  its platform's blob anonymously by SHA-256 (tested against a local
  registry, then from GHCR). Each later release: `.github/scripts/pin-vertra.sh
  <version>` for `catalog-template/vertra` and each catalog's wrapper. A
  signing step that fails with Rekor's 409 "equivalent entry" is a retried
  upload that had succeeded: rerun the job.
- [x] **`buf breaking` in CI** (done 2026-10-29): the proto job compares
  `proto/` with the newest `v*` release tag's (FILE rules); a break fails
  the pull request.
- [x] **P0: pull-based catalog registration (M1, S1)** (done 2026-10-20).
  Catalog CI publishes, then `./vertra catalog release` pushes the whole
  catalog (teams, their SecretStore files, every product action pinned by
  digest; `proto/vertra/catalog/v1/release.proto`) as a signed OCI
  artifact, `<registry>/catalog-release`. Each console polls it
  (`catalog.pollSeconds`, and Sync now on the Admin page), verifies it with
  a cosign Job against `catalog.signature`, and applies it
  (`console/src/catalogSync.ts`) with the old token's rights only:
  dropped products are unregistered, dropped teams retired, never purged.
  A team the catalog didn't make is left alone until an admin adopts it
  (`AdminService/AdoptCatalogTeam`), replacing `check-new-team-names`. A
  SecretStore's stored credential is set per install
  (`TeamService/SetSecretStoreCredential`). The push workflows, the catalog tool's
  `teams` commands and every console token in the catalog are gone;
  `delete-team-images` keeps the registry clean-up; `vertra catalog create`
  sets only registry variables (and removes and revokes the old ones) and
  the install sets the console's `catalog.release`, so a catalog no
  longer needs a public console. Templates aren't in the release yet
  (they come with consumers, A1). Proven on GKE Autopilot in acyclix-dev
  (2026-10-20): a release signed by catalog CI's cosign (3.1.3, key mode)
  verified by the console's (2.5.3) and applied; one signed by another key,
  and an unsigned one, refused with nothing applied. That run found the
  verification Job signing in to Artifact Registry anonymously: it now
  passes `--k8s-keychain` (the ServiceAccount's Workload Identity) unless a
  pull Secret is configured.
- [x] **P0: consumers and templates (A1)** (done 2026-10-21):
  templates travel in the catalog release and are stored per team
  (`templates`); `TemplateService` lists what a person may run (templates
  and shared actions) and runs one with parameters only, checked against
  its schema, each step built from its product (image, ServiceAccount,
  the action's secrets, token audiences, namespace); sharing with
  specific teams runs on behalf of one; a step of an unshared action is
  refused; the submitter sees, cancels, retries and reruns their run
  (a rerun runs the template again). Proven on kind with a consumer in no
  team. The Run page lists them and runs one through a form built from its
  parameter schema (the server's problems shown on their fields), with
  "Run for" when sharing needs a team; the Products page links shared
  actions to it; an execution shows the template it came from. Proven in
  a browser on kind as a consumer in no team. Roles beyond member and
  admin are P1 below. The original item: a consumer role that may run a
  team's published templates with parameters only; templates
  (`teams/<team>/dags/`, with a `parameters` block) fix each step's
  `secretRefs` and identity. Every product action is also a one-step
  template. Maintainers keep today's rights. Secret bindings live per
  action in `product.yaml` (`actions[].secretRefs`), so an exported action
  keeps its owner's bindings in any DAG; steps use the product's latest
  release. Everyone signed in is a consumer; consumers may cancel and retry
  their own runs.
- [x] **P0: projected ServiceAccount tokens for federation (I1)** (done
  2026-10-20). A product declares `tokenAudiences` in `product.yaml`; the
  release carries them, the console stores them and sets them on its
  tasks (a submitter can't), and the kernel projects one hour-long token
  per audience at `/platform/tokens/<audience>`. The console refuses the
  Kubernetes API's audiences (read from its own token) and kernel-api's;
  the identity policy refuses an undeclared audience or a longer token.
  Proven on kind and on GKE Autopilot (2026-10-20): each declared token
  arrives from the cluster's issuer for the product's ServiceAccount,
  lasting an hour; the policy refuses the rest; registration refuses
  GKE's API audience, read from the console's own token. The sample:
  `samples/aws/products/caller-identity` (2026-10-31), AWS from any
  cluster that isn't EKS; seen on kind up to AWS refusing kind's private
  issuer, and proven from GKE in the billed run (an IAM OIDC provider for
  the cluster's issuer, no key).
- [x] **P1: check inputs and outputs against their schemas (C1)** (done
  2026-10-21). The console checks each step's literal inputs against its
  product's input schema at submit (`INPUT_INVALID`, each problem on its
  field; upstream references left for later) and attaches both schemas to
  the kernel's task; the kernel checks the resolved inputs before the step
  starts (`INPUT_INVALID`) and its outputs when it finishes
  (`OUTPUT_INVALID`), neither retried, and refuses a schema that isn't one
  or refers outside itself. Proven on kind (a refused literal, a template
  run checked both ways); the kernel's failures by its scheduler tests
  against Postgres.
- [x] **P1: exports (X2)** (done 2026-10-21): an action's `shareWith` in
  product.yaml is its export list, so there's no second list. Checked by
  `vertra catalog validate`; when a release is applied (a template whose
  step's action isn't shared with its team is a problem, not stored); on
  every run; and on retrying a consumer's own run, which is refused once the
  template, the action or a step is no longer shared. Raw DAGs need a
  maintainer of every team they run in.
- [x] **P1: allowed targets per team (X1)** (done 2026-10-21): team.yaml's
  `allowedTargets` (rules of teams and, per kind, values or `*` patterns),
  carried by releases; an action input typed `x-vertra-needs` gcp.project,
  gcp.folder, aws.account or azure.subscription is a target. Another
  team's run with any other value is refused before it starts
  (`TARGET_NOT_ALLOWED`, `console/src/targets.ts`); the Run form offers the
  allowed values. The owning team and admins aren't limited; a value from
  an earlier step isn't checked. Proven on kind. A retry is checked again
  (2026-10-29): a step aimed where the owner no longer lets the run's team
  is refused (`TARGET_NOT_ALLOWED`). GCP folder membership isn't looked
  up (patterns on IDs, by decision); scoping owner identities to folders is
  each team's cloud setup.
- [x] **P1: retry policy and idempotency per action (R3)** (done
  2026-10-21): product.yaml's `idempotent` and `maxAttempts` (1–10; more
  than 1 needs idempotent), carried by releases. A registered product's
  step gets its product's attempts, fewer if its template or DAG asks,
  never more, and one if it isn't idempotent; the kernel already retries
  retryable failures (platform ones, or a product's `retryable` error)
  with a growing backoff. Every sample's create or transform action is
  idempotent. Proven on kind. Left: the run page saying whether a manual
  retry is safe, from the same flag.
- [x] **P1: who asked and who acted, per attempt** (done 2026-10-21):
  each attempt records who asked for it (the submitter for a first
  attempt, whoever retried it, or nobody for an automatic retry: the
  console passes "user:<id>", which the kernel never resolves), the
  identity it ran as and its image (kernel migration 0005). Attempts are in
  both APIs (`TaskStatus.attempts`) with the requester as an email, and
  under each step on the run page. Proven on kind.
- [x] **P1: samples read identity references from team secrets (S2)**
  (done 2026-10-21): the gcp samples impersonate the service account in
  the team secret `gcp-target` (key `service-account`), and the aws samples
  assume the role in `aws-target` (key `role-arn`), each mounted only for
  actions that list it in `secretRefs`; the deployment-wide
  `GCP_TARGET_SERVICE_ACCOUNT` and `AWS_TARGET_ROLE_ARN` are gone from code
  and docs. Proven locally against the built images (impersonation and
  AssumeRole only with the secret mounted; the old variables ignored).
  Left: proving it against a real cloud with the next GKE or EKS run.
- [x] **P1: registry access across clouds (M2)** (done 2026-10-22): an
  install reads another install's catalog (`externalCatalog` in vertra.yaml:
  the registry, and for a Google Artifact Registry on another cloud a
  Workload Identity provider) and trusts its signing key
  (`catalogSignature.publicKeyFile`). With no stored key: the console's
  projected token, exchanged at Google's STS, signs it in
  (`console/src/registryFederation.ts`), and every policy sync it writes the
  short-lived token as `vertra-pull` in each team namespace (the kubelet)
  and `vertra-registry-token` in its own (the verify and scan Jobs; the
  write fence allows that one Secret). `vertra apply` prints the catalog
  owner's three gcloud commands (a pool, a provider for the cluster's
  issuer limited to the console's ServiceAccount, read on the repository).
  Proven 2026-10-22: one catalog in Artifact Registry (acyclix-dev), signed
  with a catalog key; a GKE install read it natively and an EKS install
  (us-east-2) by federation. Both applied the signed release, pinned,
  scanned and ran a step from it (the EKS kubelet pulling from Google), and
  both refused a release signed with another key and an unsigned one. Torn
  down after. Policy-controller on EKS: proven 2026-10-27 (below).
  Built 2026-10-30, not yet proven on a cloud:
  - The reverse direction: an install reads an Amazon ECR by AWS web
    identity (`externalCatalog.awsRoleArn`; the console chart's
    `registryCheck.awsFederation`): its projected token (audience
    `sts.amazonaws.com`) assumes the owner's role, whose credentials get
    ECR's token, handed out as the Artifact Registry federation's is.
    Unit-tested with STS and ECR faked; chart rendered.
  - `vertra catalog grant` (the owner's install; `cli/internal/grant`): a
    provider in `vertra-installs` mapped to the reader's own subject
    (`<reader>:<subject>`), or a reader's service accounts, on gcp; an IAM
    OIDC provider and a role `vertra-reader-<reader>` reading only
    `<prefix>/*` on aws. Shows, asks, changes only what differs,
    `--revoke`. apply prints it in place of the gcloud commands. Tested
    against a faked gcloud and AWS CLI only.
  - To prove (one billed run): a GKE reader of an EKS owner's ECR and an
    EKS reader in a second account (release applied, step pulled by the
    kubelet, policy-controller verifying through `vertra-pull`, the scan
    Job signing in), each granted, re-granted (no change) and revoked
    (refused within the hour); the GKE issuer accepted as an IAM OIDC
    provider with no thumbprint; gcloud accepting the prefixed
    `google.subject` mapping; ECR's token lasting no longer than the
    role's session (it's cached to the shorter); `ecr:ListImages` being
    what ECR's tags list needs (`catalogVersion: newest`).
- [x] **P1: recovering the first admin's password** (done 2026-10-22):
  `vertra admin reset-password` runs the console's `dist/db/resetAdmin.js`
  in its Pod (cluster access required): a new random password for an
  admin, printed once, every session revoked, audited. Proven on kind.
- [x] **Cross-building on Apple silicon** (done 2026-10-27): the console's
  npm stages, and now the Node sample's (reverse) build stage, run on the
  build platform, so publishing for amd64 from a Mac doesn't run npm under
  emulation, where it broke.
- [x] **P2: readiness per install** (done 2026-10-24). product.yaml's
  `check` names the action that says whether it's ready here (`ready`,
  `principal`, `missing`); the console runs it itself (a check run, no
  submitter) when a product is new or changed, daily, and on **Check now**
  (`readiness.ts`, console migration 0023), shows it in the catalog, on
  Every product and the run form, and tells the team's maintainers and
  webhook when it isn't ready. The cloud samples' checks are built
  (2026-10-30; each gcp and aws product signs in as itself and asks
  `testIamPermissions` or a read-only call, with unit and contract tests),
  proven in the billed run: on GKE each gcp product not ready naming its
  missing roles, then ready once granted; on EKS `s3-bucket` ready as its
  own role through Pod Identity.
- [x] **P2: schedules** (done 2026-10-24): a template or action on a cron
  (five fields, an IANA time zone, at most every five minutes), with set
  parameters, for a team, as one of its bots, made from the run form
  (Schedule…) and kept on the team's Schedules tab. Each run is started as
  the bot, through the same checks, by whichever console claims it first;
  a refused start is kept and told to the maintainers (`scheduleRunner.ts`,
  console migration 0024). A sleeping install wakes for them (done
  2026-10-24, below).
- [x] **P2: caps per product** (done 2026-10-27, proven on kind):
  product.yaml's `maxRunning` (1 to 100) caps how many of the product's
  steps, all its actions sharing it, are claimed or running at once; the
  rest wait READY, and the run page says why (`waiting_for_cap`). The
  console scopes it to the product's catalog folder (or its image, for one
  registered by hand); the kernel holds it in the claim, under an advisory
  lock like concurrency keys. The ticket sample allows two (vertra 0.5.0).
- [x] **Keyless bots** (done 2026-10-24): a bot signs in with its CI job's
  OIDC identity (GitHub Actions, GitLab) instead of a stored token. Its
  team's maintainers bind it to exact claims (`TokenService.AddBotIdentity`;
  console migration 0025); `AuthService/ExchangeToken` verifies the token
  (the issuer's keys, an allowed issuer, the install's audience, expiry)
  and returns an hour's session for the one bot it matches, which the
  gateway takes as is. Proven with a test issuer's real signed tokens; not
  yet from a real GitHub Actions job (that needs a console it can reach).
- [x] **P1: roles** (done 2026-10-21): a team's people are maintainers or
  members (`team_memberships.role`; memberships from before are
  maintainers). Members see the team's runs, logs, Pods and secrets'
  names, and run its actions; maintainers also manage people and roles,
  secrets, bots, raw DAGs and cancelling its runs. Everyone signed in is a
  consumer of what's shared with their teams. Managed on the team's
  Members tab (`TeamService/SetMemberRole`); never without a maintainer
  (`LAST_MAINTAINER`). Bots, and people an admin creates in a team, are
  maintainers. SSO groups map to a team with a role (2026-10-25, below).
- [x] **P1: `visibility` on actions** (done 2026-10-21): `visibility:
  hidden` on an action (product.yaml) or a template keeps it to its own
  team (and admins), and can't be combined with `shareWith`; everything
  else is listed to everyone, the Run page showing what isn't shared with
  you under "Not shared with you" with **Ask for access**: GitHub's
  new-issue page on the catalog repository, filled in with the change to
  `shareWith` and a link to the file, opened in the person's browser (the
  console only reads the catalog). Releases carry each file's path
  (`ProductAction.path`, `Template.path`) and `hidden`. Left: links for
  catalogs not on GitHub (GitLab, with GitLab).
- [x] **P1: approvals** (done 2026-10-21): product.yaml's `approval`
  (`always`, or `otherTeams`: only another team's runs) and an
  `allowedTargets` rule's `approval: true` (its targets allowed only with
  one), carried by releases. The console marks such steps
  `approvalRequired` (submitters can't); the kernel holds them in
  `AWAITING_APPROVAL` instead of `READY` (kernel migration 0006, console
  0011). A maintainer of the step's team, never whoever submitted the run,
  approves or declines on the run page (`ExecutionService/DecideApproval`,
  audited; the kernel records who in `TASK_APPROVED`); the home page lists
  what's waiting (`ListPendingApprovals`). Declined: `APPROVAL_DECLINED`;
  undecided for `scheduler.approvalTimeoutSeconds` (3 days):
  `APPROVAL_EXPIRED`. An approval lasts across retries; a declined step
  asks again. Proven on kind with the local sample's rot13
  (`approval: otherTeams`). Approvers are notified, and can preview the
  step (both 2026-10-24). And for some consumer teams and not others,
  without a target rule (2026-10-29): `approval: [team, …]`, carried by
  releases (`approval_teams`, console migration 0051).
- [x] **P1: failure help from the owner** (done 2026-10-21): product.yaml's
  `errors` (CODE: means, do) and team.yaml's `help` (chat, url) beside
  `contact`, carried by releases (console migration 0010). A failed step's
  `help` says what its code means (the owner's words first, the platform's
  for its own codes: `console/src/failureHelp.ts`), whether a retry is safe
  (the product's `idempotent`), and whom to ask; shown under the step on
  the run page. Proven on kind with a timed-out step.
- [x] **P1: concurrency keys** (done 2026-10-21): product.yaml's
  `concurrencyKey` (input names, checked to exist by vertra catalog
  validate), carried by releases; the console sends the kernel the
  product and those inputs for each step (submitters can't set one). The
  scheduler works the key out from the resolved inputs when it claims a
  step, and holds it READY while one with the same key is claimed or
  running; a transaction-scoped advisory lock per key keeps two schedulers
  apart (kernel migration 0004). Proven on kind: two runs on the same value
  ran one after the other, a third on another value alongside. A held
  step records its key, and the run page says what it waits for
  (`TaskStatus.waiting_for`, while another with the key is claimed or
  running; proven on kind with the local sample's upper-case, 2026-10-23).
- [x] **P2: the marketplace pages** (eleven mocked up 2026-10-19; done 2026-10-25):
  Catalog with readiness, Runs list and run timeline, Schedules, Admin,
  Compose (2026-10-24: type-matched wiring by `x-vertra-needs` and
  `x-vertra-provides`, drafts in the browser, Propose as a template on
  GitHub's new-file page, Run now when it's all your team's), runnable
  examples (2026-10-24: an action's passing contract tests, carried by
  releases, offered on its run form as Use this), another team's page
  (2026-10-24: `TeamService.GetTeamProfile`, where to ask it and its size,
  and what it offers you, with sharing and readiness), drafts kept by the
  console (2026-10-25: `DraftService`, for the draft's team, from any device,
  a save refused if someone saved since), templates' own examples
  (2026-10-25: a template file's `examples`, checked against its parameters,
  carried by releases, offered on its run form).
- [x] **P2: preview** (done 2026-10-24). product.yaml's `plan` names the
  action that says what this one would do (`summary`, `changes`); the run
  form's **Preview** runs it as a preview run (a template: each step with a
  plan whose inputs are known up front), and whoever may approve a waiting
  step previews it with its real inputs (`ExecutionService/PreviewStep`).
  Previews notify nobody and record nothing. Console migration 0022; the
  local `ticket` sample has one.
- [x] **P2: what a run created** (done 2026-10-23; decision 21). A step
  reports `resources` (type, id, name, link) in its outputs; the console
  keeps them with the step's inputs and outputs once the run finishes
  (`resourceRecorder.ts`, console migration 0020), so they outlive the run.
  product.yaml's `cleanup` names the action that deletes one (given
  `{"resource": ...}`, or inputs mapped with `$input`, `$output`,
  `$resource`). The run page's **What it made** and Runs' **What runs
  made** (searchable) show them; Delete runs the cleanup for the team it was
  made for, newest first, with sharing and approvals. Proven on kind with
  the local `ticket` sample. The gcp samples' `project`, `app-hosting` and
  `cloud-sql` delete what they made (labelled `vertra-made`; done
  2026-10-24, decided: only the team it was made for, whoever ran it, and
  admins; a resource keeps its first owner). Proven 2026-10-25 on GKE in
  acyclix-dev: a gcp member made a project (in a folder) and a Cloud Run
  service, another team's member was refused their Delete, an admin's
  cleanup run shut both down. The aws samples' (s3-bucket, app-runner,
  rds-postgres) and Cloud SQL's proven 2026-10-25 on EKS and GKE. Azure's
  cleanups are after the MVP (decided 2026-10-25).
- [x] **P2: notifications** (done 2026-10-24): an inbox (the bell) and
  each team's chat webhook (Slack, Google Chat, Teams; decided 2026-10-24:
  the URL kept encrypted in the console's database, write-only, allowed
  hosts only). A run that failed or finished tells whoever ran it, a
  failure posts to its team's webhook; a step waiting for approval tells
  its team's maintainers (not whoever ran it) and webhook; the catalog not
  pulled for 30 minutes tells admins (`notifier.ts`, console migration
  0021); a product not ready too (with readiness); by email (2026-10-24:
  SMTP, `notifications.email` in the console chart, each person choosing
  the kinds in Preferences; console migration 0027).
- [x] **P2: copy as API call, run again with changes** (done 2026-10-23):
  the run form's **Show as an API call** (the same run as `curl`, proven
  against kind), and a run's **Run with changes** (its form, filled in from
  the run; the catalog's current version, so a gone image doesn't stop it).
- [x] **Scale-down for development installs only**: `vertra init` says so
  before asking (done 2026-10-27). Schedules wake a sleeping install (done 2026-10-24: the
  console publishes its next schedule; the sleeper stays awake for one due
  soon and otherwise arms the kernel chart's `-wake` CronJob, `kernel
  wake`, five minutes before it. Proven on kind: slept at 21:13, woke at
  21:20, the 21:25 schedule ran as its bot, slept again at 21:27, re-armed
  for the next day).
- [x] **Trace what a retired team's running executions do** (done
  2026-10-29, traced on kind): a step already running finishes, under the
  team's identity (as when a step fails for good); its steps not yet
  started fail as `TEAM_RETIRED` (the dispatch policy says so, rather than
  a bare `DISPATCH_REJECTED`), not retryable, and the run fails; another
  team's step claimed in the same pass runs on. Un-retiring and retrying
  resumes it.

- [x] **Catalog versions, and installs reading another's catalog**
  (decision 22, `docs/assessment.md`; vertra 0.4.0). Done 2026-10-26:
  - Versions: a `vX.Y.Z` tag in the catalog repository asks CI on main
    (`version.yml`) to tag that commit's release `catalog-release:vX.Y.Z`
    (`vertra catalog promote`; immutable; only a commit main published).
    The console follows its release's tag, or the newest version
    (`catalog.newestVersion`); `vertra` sets either from `catalogVersion`.
  - A reading install (`externalCatalog`) trusts the owner's signer
    (`catalogSignature`: a public key, or the repository for keyless) on
    releases and, on gcp and aws, images (policy-controller, the modules'
    `verify` identity; apply prints the owner's grant on the same cloud).
  - `vertra catalog create` refuses a repository that already publishes to
    another install's registry, unless `--take-over`.
  Proven on kind (versions) and GKE, an owner signing keyless and a reader
  on `newest` in acyclix-dev: the tag's run started CI on main, which made
  the version; the reader applied nothing before a version, then v1.0.0,
  held there while a merge moved the owner's `latest`, then v1.1.0, each the
  owner's digest, verified against the owner's keyless identity; the owner
  ran a signed image and the reader refused an unsigned one pushed by hand
  (`IMAGE_NOT_SIGNED`). Left:
  - (Proven 2026-10-27.) A signed image running on a reader: an EKS reader
    of the GKE owner's Artifact Registry (federation, policy-controller
    signing in with the steps' pull Secret) ran a signed step and refused an
    unsigned one, and its admin got the `step_refused` alert.
  - (Built 2026-10-30, not yet proven on a cloud.) An aws reader of another
    account's ECR: it reads by web identity as any other cloud's reader does
    (the owner's role from `vertra catalog grant`), policy-controller with
    the steps' pull Secret, so its verifier role still reads only its own
    task registry.
  - (Fixed 2026-10-27, proven on EKS 2026-11-01: 59 destroyed, two EBS
    volumes listed.) `vertra destroy` stopped
    when the cluster's API didn't answer (the reader's was torn down with
    `tofu destroy` on its state): it now skips what's inside an unanswering
    cluster, deletes the cloud side, and lists the unattached disks or EBS
    volumes its volumes may have left.

## Security

- [x] **Gaps the 2026-10-28 docs audit found** (closed 2026-10-29; documented in
  `docs/security-model.md`): the scheduler may read every Pod's logs
  cluster-wide (fixed 2026-10-29: a logs-only ClusterRole the console
  binds per team namespace, its only RBAC write, fenced to exactly that;
  proven on kind: team namespaces yes, kube-system and the platform's no,
  a step's logs still read); and a compromised
  console can loosen the image, identity and scan policies (accepted:
  Kubernetes can't fence an admission policy's own edits). Proven on EKS
  Auto Mode 2026-10-28 (NetworkPolicy enforced: another team's Pod
  unreachable, the metadata server refused, TLS everywhere, kernel-api
  HTTPS only), and on standard-mode EKS 2026-10-29, after a fix: the
  no-metadata policy's IPv6 block made the VPC CNI's agent fail to program
  any of a team's policies there (egress map: invalid argument). Done 2026-10-28: sign-ins and
  password changes audited (with the client's address), failed ones logged;
  the sign-in limits counted in Postgres, shared by every console copy;
  signing out ends the session (`revoked_sessions`, checked by the gateway
  too); bot and automation tokens expire (90 days by default); the
  scheduler's deletes fenced to its own Jobs and ConfigMaps in team
  namespaces, and its Jobs required to be hardened (the dispatch policy);
  EKS: the VPC CNI's NetworkPolicy enforcement turned on (it was off: no
  policy held there) and `teamNamespaces.blockMetadata`; the gateway signs
  in to the database as its own role (`vertra_gateway`, column grants) and
  checks sessions with the console's public key (sessions now EdDSA), so it
  holds neither the console's credentials nor `JWT_SECRET`; TLS inside the
  cluster (each chart's own CA: kernel-api HTTPS, Postgres TLS-only,
  clients `verify-full`). The console's own Postgres with TLS (the
  hand-written GKE values' layout) proven 2026-10-29 on a kind cluster of
  its own.
- [x] **TLS in front of the console** in the charts. Done 2026-10-22, proven
  on kind (`make kind-tls`): the Ingress takes a certificate from
  cert-manager (an issuer of yours, or Let's Encrypt through the chart's own
  Issuer) as well as a Secret or the cloud, and refuses plain HTTP for
  Traefik, NGINX and GKE; or an HTTPRoute on a Gateway you run, with a
  redirect from its HTTP listener. `vertra` sets it up on existing clusters
  (2026-10-22, proven on a second kind cluster treated as existing: cert-manager
  installed by vertra, the certificate reported not ready until its issuer
  existed, then HTTPS verified through the cluster's own Traefik). Let's
  Encrypt proven on GKE (2026-10-22): the chart's Issuer, HTTP-01 through
  Traefik's load balancer, staging then production; a certificate for a
  real hostname trusted by an ordinary client, plain HTTP refused.
  `vertra apply` names the DNS record a hostname of yours needs and waits
  for it; `vertra status` shows it and the certificate (2026-10-22; not yet
  run against a cluster whose Ingress has a public address).
- [x] **SSO/OIDC sign-in**, with groups mapped to teams (done 2026-10-25). Sign-in with
  Google is in (2026-10-22: `console/src/auth/oidc.ts`, the console chart's
  `sso`): the authorization code flow with PKCE, a verified email in an
  allowed Workspace domain, each account bound to its Google identity at the
  first sign-in. Passwords keep working; a team an admin sets to require
  single sign-on refuses its members' passwords and password sessions
  (admins exempt; not every team can use it, decided 2026-10-22). Teams
  are still set in Vertra (decided 2026-10-22). Proven on kind with a real
  Google OAuth client (2026-10-22): a Workspace account's first sign-in
  made and bound its account; with its team restricted, a member's password
  was refused (403 SSO_REQUIRED, a wrong one still 401) and their earlier
  password session refused by the console and the gateway alike, while an
  admin's password kept working. `vertra sso google` sets it up
  (2026-10-22: the links and redirect URI, the client file checked, the
  secret written by apply through stdin). Admin-configurable and groups
  (2026-10-25, decided: optional, set on Admin, People unless the install
  set it; groups from the ID token's claim and Google Workspace; mapped
  teams owned by the provider): `SsoService`, console migration 0029,
  proven on kind (turned on and off without a restart, an issuer checked)
  and in tests against a stand-in provider. `vertra sso google-groups`
  (gcp) enables Cloud Identity's API and names the console's own service
  account for a Workspace admin to make a Groups Reader (no key, no other
  account: the console reads groups as itself). Proven on GKE (2026-10-25):
  a real Google sign-in of a Workspace account in a mapped group made it
  that team's maintainer; the console asks about each mapped group
  (checkTransitiveMembership), since a Groups Reader can't search all of a
  person's groups at once. Entra ID and Okta untried for real, skipped for
  now (decided 2026-10-25): the flow and the groups claim are generic, and
  tested against a stand-in provider.
- [x] **Force a password change on first sign-in** for admin-created
  accounts (done 2026-10-22): a password someone else set (a new account's,
  an admin's reset of someone else's, `vertra admin reset-password`) marks
  the account (`users.must_change_password`); until its owner changes it,
  a password session may only GetMe and ChangePassword
  (`PASSWORD_CHANGE_REQUIRED`), the gateway refuses it, and the console
  sends them to their account page. Single sign-on and bots aren't held
  back. The chart's bootstrap admin is marked too when its password was
  generated (2026-10-22), not when the operator set one (kind's fixed
  password).
- [x] **Limit what steps can reach inside the cluster** (S3, done
  2026-10-21): the console writes `vertra-default-deny` into every team
  namespace (`teamNetwork.ts`; with the namespace, and on every policy
  resync), letting in connections only from the same namespace. Its write
  fence accepts only that policy in that shape, and it can't delete one.
  Proven on kind: another team's Pod and the platform's were refused, the
  same team's connected, and without the policy the other team got
  through; the fence refused opening it, a second policy, one in the
  platform namespace, and deleting it. Next, when the gateway comes: let it
  reach API products' backends in team namespaces.
- [x] **Make the charts require non-root** on the kernel and console Pods
  (done 2026-10-22, proven on kind: a step ran end to end): kernel-api, the
  scheduler, the console and both migrations require `runAsNonRoot`, the
  runtime's seccomp profile, no privilege escalation, no capabilities and a
  read-only root filesystem (`/tmp` an emptyDir), like the gateway, Loki,
  the collector and Trivy already did. Postgres too (2026-10-29): a new
  install's runs as its user (999) from the start (`postgres.nonRoot:
  auto`: fsGroup with OnRootMismatch, its data directory one it makes, the
  claim marked `vertra.dev/postgres-layout: nonroot`), and the Jobs running
  only its tools (backups' dump, the console's database) run as 999; proven
  on kind, a fresh install (a step, an upgrade keeping it) and an existing
  one keeping its layout and data. An existing volume moves to it with
  `postgres.nonRoot: true` (2026-10-30; docs/operations.md, "Moving
  Postgres to its own user"): after the kubelet's first fsGroup pass opens
  every file, the Pod's `postgres-layout` init container (as 999) closes
  them again, the data directory last, and refuses what it can't move
  safely; proven on kind on `local` volumes, which get the fsGroup pass as
  a cloud disk does (a kill mid-move, reruns, refusals, going back to root
  and moving again); proven on a GKE persistent disk and on EBS in the
  billed run (data identical, a new run after). Left: the console chart's
  own Postgres, which still starts as root.
- [x] **Bind the console's Secret rights per team namespace** as teams are
  created, instead of cluster-wide fenced by an admission policy. Decided
  against (2026-10-22): the console would have to create RoleBindings (and
  `bind` the role they grant), and only the same admission policy would
  stop it binding that role anywhere, so nothing would be gained and the
  console would gain RBAC rights. What stands: the write fence is the
  boundary, and the console can't change it (it may update only the image,
  identity and scan policies, by name). Done instead: the console checks
  the fence is in force (fails closed, checks something, bound to deny)
  before it starts and refuses to start without it (proven on kind by
  deleting the binding), and Observe reports it.
- [x] **Ship audit log lines to a write-once store** (done 2026-10-22): the
  audit log is hash-chained (`audit_log.hash`), and with `audit.export` the
  console copies new entries every few minutes, their chain checked, to a
  bucket that refuses deletes and overwrites (GCS retention, S3 Object
  Lock; `vertra` makes it, kept by destroy, `audit.lock` for the permanent
  kind), create-only. Proven on kind (`make kind-audit-store`, SeaweedFS):
  copies written, an overwrite and a locked delete refused, a forged entry
  stopping the copy and Observe saying where. On GCS (GKE, 2026-10-22):
  copied by the console's own identity (objectCreator only), and a delete
  by the project's owner refused by the retention policy. Checking the
  database against the copies (done 2026-10-29): each hour the console
  compares a few copies with the database, entry by entry, round and round;
  a changed or removed entry is named (the chain misses one whose later
  hashes were rewritten too). The console's identity may now read its
  copies (GCS objectViewer; S3 GetObject and ListBucket). Proven on kind
  with SeaweedFS. Proven in the billed run: the comparison on GCS (an entry
  changed in the database named within the hour) and on S3, and deletes
  refused by GCS's retention and S3's Object Lock.
- [x] **Decide who may read a multi-team execution** (decided and done
  2026-10-22, `console/src/core/runView.ts`): a run's owners (admins, its
  submitter, the team a template run was for; a raw DAG's every team) see
  every step; a provider team's member sees their own steps in full and, of
  the rest, only product, state, timing and failure code, never inputs,
  outputs, failure messages, template parameters or logs, in the run's
  details, events, logs and Observe's log search. Cancel and retry still
  need every team.
- [ ] **Have the GKE deploy use released images** (done 2026-10-22 in the
  Makefile: `make gke-deploy VERSION=...` deploys the release's signed
  charts and images, every signature checked against the release
  workflow's identity at that tag first; the working-copy build is
  `gke-deploy-*-from-source`). The packages are public, and v0.2.2's
  images and charts verify against its release workflow (cosign v3, which
  the release signs with). Left: running a deploy with it once.
- [x] **One cloud identity per product in the gcp sample** (done
  2026-10-22): each gcp and aws sample product declares its own
  `serviceAccount` (`gcp-<product>`, `aws-<product>`), and the READMEs grant
  each only what it calls: on GCP straight to its Kubernetes identity
  (Workload Identity Federation, no Google service account or annotation),
  on AWS by Pod Identity to its own role. The gcp grants proven on GKE in
  the billed run (2026-10-31).
- [x] **Catalog: keep pull-request workflows away from secrets and cloud
  identities** (checked 2026-10-22): the cloud identities trust only `main`
  (GCP's `assertion.ref`) or the `catalog-publish` Environment (AWS's
  `sub`), so a pull request's token never matches; the publish and purge
  jobs run in `main`-only Environments; `vertra` sets no secrets (OIDC to
  the registry, keyless signing). Added: `vertra catalog create` warns, by
  name, about any repository-level secret (which every pull request's
  workflows get), and the template says where one belongs.

## Console

- [ ] **What the redesigned pages leave out** (found building boards 9–13,
  2026-10-30; #33–#38): each is something a board shows that the API doesn't
  return, so the page omits it rather than guess. Group 1, mostly data the
  console already has, is done (2026-10-30): the Runs list's starter by
  email and running step with its attempt, how long runs are kept for
  everyone, the Admin sections' install settings, Observe's Grafana link,
  a team's install limits beside its own, and team.yaml's description in
  the release, on the Teams page and the team's page. Planned already, and
  done since: Observe's alerts (#45) and whether a retry is safe. The rest,
  decided 2026-10-30:
  - ~~Group 2~~ (done 2026-10-30, #47): an alert to admins when the audit
    copy stops, breaks or differs; which schedule started a run; when a CI
    identity was added; what a catalog release held (counts); a refusal's
    detail apart from its subject; which groups give a member their role.
  - ~~Group 3~~ (boards drawn and approved 2026-10-30; built, #48): log
    search by one API (its backend's Pods labelled `vertra/api`); each
    calling team's limit on an API's page, for everyone who sees it; who
    retired a team; who last saved the image sources; what an order's cart
    held and chose; a proposed cart's lines with team, product, verb and
    wiring. The dropped items are off the boards too.
  - Dropped, and to come off the boards: the Kubernetes Job's name in "Who
    acted"; a resource's run name; "since you last looked"; sharing-change
    and template creation times (the catalog's history has them); a total
    for guide search; a team-scoped read of group mappings and each
    mapping's member count. Per-team product usage and run counts moved to
    the performance work (item 5 there), not dropped.

- [ ] **One read for the Teams page's other teams** (found reviewing #33,
  2026-10-30): an admin's Teams page reads each other team's profile and
  pods, a few at a time since #43, so 80 teams are still 160 requests and 80
  pod lists per visit. A TeamService method returning each team's people,
  owner and running count at once (one query, and running from the kernel's
  states or one pod list by label) would make it one.

- [x] **Gaps the 2026-10-30 guides found** (writing guides 10 to 16
  against the code; done 2026-10-30, #44): an API not shared with you now
  offers Ask for access, the same pre-filled catalog issue as templates and
  actions; an API whose OpenAPI document the gateway can't use shows Can't
  serve, with why (the gateway records it in `api_problems`); a bot can be
  made keyless, with no token; a schedule's time, bot and inputs can be
  edited. The Definition tab's order and the Settings tab's maintainers
  wording were fixed earlier (#42). Also fixed then: an API's page showed
  "0 a minute" for a team its limits don't name, and stale wording.
- [x] **A page for image scans** (done 2026-10-25): Admin's **Image scans**
  tab, every digest's verdict by state, its findings, Rescan now, and
  Accept with a reason; Observe's Security tab links to it for admins. The
  audit log's is Observe's Audit log tab (2026-10-22).
- [x] **A team's `owner` on its console page** (done 2026-10-27, decided:
  shown, never a grant): team.yaml's owner travels in the release and the
  Team page says who owns the team in the catalog; membership stays the
  console's and single sign-on's.
- [x] **The catalog repository for the secret-setup guides** (done
  2026-10-27): the repository the applied release came from, unless the
  console chart's `secretSources.catalogRepo` names another; no Admin
  setting needed.
- [x] **Run forms generated from each action's input schema** (done
  2026-10-23). The Catalog's Run opens a page (`/catalog/run`) whose form
  comes from the template's parameters or the action's input schema
  (`console/frontend/src/schemaForm.ts`): labels from `title`, help from
  `description`, defaults, `enum` as a choice, `required`, `pattern`,
  lengths and limits checked on the field before sending, lists for arrays
  of text or numbers, name/value rows for string maps, JSON for the rest;
  targets (`x-vertra-needs`) offered from what the owning team allows. Form
  hints, checked by `./vertra catalog validate`: `x-vertra-order`,
  `x-vertra-group`, `x-vertra-widget: textarea`, `x-vertra-pattern-message`.
  Our own small renderer rather than `@rjsf/mui`, which would have been a
  large dependency to restyle. Secrets were never inputs (they come from
  `secretRefs`); the console and kernel already check inputs against the
  schema.
- [x] **Show a product's latest tag** where people build DAGs (done
  2026-10-23): Submit a DAG's **Add a step** appends a step of one of your
  teams' products with its latest image, action, team and identity, and its
  required inputs to fill in (Every product already marks the latest).
- [x] **Stop reading `externalReference` and `idempotencyKey`** (done
  2026-10-29): migration 0049 renames them in stored submissions (`name`,
  `requestId`), and nothing reads the old names any more; a DAG written with
  one is refused, the editor naming the new field.

## Products and catalog

- [ ] **Prove the chat agent answering through Bedrock** once the acyclix
  account can: it has the Anthropic use-case form to submit, and every
  Bedrock daily token quota is 0 (AWS Support raises those). Proven so far
  (EKS Auto Mode, 2026-10-28): the console signs each request as its Pod
  Identity role, which passes IAM for its own model and is refused for any
  other; what's left is one answer.

- [x] **API products and the gateway** (done 2026-10-22; decision 20, `docs/assessment.md`;
  mocked up 2026-10-21 in the console mockups, boards 12–16). A team
  publishes a backend it already runs: `teams/<team>/apis/<name>/api.yaml`
  (`kind: Api`) and its `openapi.yaml`; the gateway forwards exactly what
  the spec describes and blocks the rest (404, never forwarded). In order:
  1. ~~The format~~ (done 2026-10-22): `kind: Api` in
     `teams/<team>/apis/<name>/api.yaml` (`tools/api.schema.json`, embedded
     in vertra); `vertra catalog validate` checks the OpenAPI file (3.0 or
     3.1 by libopenapi, `$ref`s inside it only, a schema for every
     parameter and body, `servers` including `backend.url`, no two paths
     alike, nothing under `/.vertra/`) and the limits; releases carry APIs
     with their OpenAPI as JSON (`release.proto`'s `Api`).
  2. ~~The console stores them~~ (done 2026-10-22): the `apis` table
     (console migration 0012), applied and removed with releases (only the
     named teams'), each with its ServiceAccount; the chart's `gateway`
     values (`backendHosts`, `internetTeams`, its addresses); an API under
     no allowed host is held. `ApiService`: ListApis, GetApi (with the
     spec), PauseApi and ResumeApi (a maintainer of its team, with a
     message for callers).
  3. ~~The gateway~~ (done 2026-10-22): `gateway/`, a Go process of its
     own reading published APIs from the console's database, deployed by
     the console chart (`gateway.enabled`). Per request: the API (paused,
     held, closed), caller sign-in as at the console (session, bot token),
     `shareWith` (and `Vertra-Team` to pick among the caller's teams), size,
     the spec (404 not in it, 400 unfit; libopenapi-validator), the calling
     team's rate (429), then forwarded with the caller's `Authorization`,
     hop-by-hop and `Vertra-*` headers removed, the backend credential and
     a signed `Vertra-Caller` (EdDSA, `/.vertra/jwks.json`) added, the
     answer streamed back. `Vertra-Answered-By` on every answer; logs and
     metrics without bodies or credentials. Proven on kind with an echo
     backend: forwarded, blocked, invalid, limited, not shared, paused, and
     its token fence. Keyless bots' sessions are ordinary console
     sessions, so it takes them as is (2026-10-24). Its database role is
     its own, read-only but for its traffic counts
     (`console/src/db/gatewayAccess.ts`).
  4. Backend credentials, minted per request (done and proven
     2026-10-22: a GKE install's gateway called a Cloud Run service that
     requires Google sign-in with an ID token for its invoker account, and
     a Lambda function URL that requires IAM signed as a role trusting the
     GKE cluster's issuer, both forwarded with Vertra-Caller; both torn
     down after): a token for the API's own ServiceAccount
     (TokenRequest), a Google ID token (its token federated at Google's
     STS, then generateIdToken), AWS SigV4 (AssumeRoleWithWebIdentity,
     then signing). AWS only besides Google, no Azure (decided
     2026-10-22); no static-secret fallback (the gateway reads no
     Secrets). The gateway's RBAC is
     `serviceaccounts/token` on the API ServiceAccounts alone.
  5. ~~Its chart~~ (done 2026-10-22): Deployment, Service, an Ingress for
     the public listener, egress anywhere but the cloud metadata server
     (`gateway.egress` to narrow); pausing an API and closing the gateway
     from the console (`gateway_state`, console migration 0013).
  6. The pages: ~~the APIs list and an API's page~~ (done 2026-10-22:
     endpoints from its spec, how to call it, the caller's limit, sharing,
     its backend for its own team, pausing for its maintainers, its OpenAPI
     file to download); traffic and blocked requests (the gateway counts
     them into `api_traffic`, kept a week), a team's APIs tab, and the
     admin's gateway card (done 2026-10-22).
  Proven on kind with a backend in a team namespace, then on GKE with a
  Cloud Run backend and a Lambda function URL (2026-10-22). A backend in a
  team's own namespace couldn't be reached at all (the namespace's
  default deny refused the gateway); since 2026-10-28 the console writes
  `vertra-gateway-ingress` (the gateway's Pods to Pods labelled
  `vertra/api-backend: "true"`, fenced to that shape), proven on kind with
  the samples' API products: `samples/local/apis/greetings` (its backend
  `examples/greetings-api`, `make kind-sample-api`), `gcp/apis/hello-world`
  (Cloud Run, Google ID token) and `aws/apis/orders` (Lambda URL, SigV4),
  the last two validated, not deployed. The gateway's database role reads
  only what it needs and writes only api_traffic (`gatewayAccess.ts`).
  The gcp and aws samples' API products deployed from a catalog, proven in
  the billed run: hello-world on Cloud Run from GKE, orders on a Lambda URL
  from EKS, each refused when not shared or not in its spec.

- [x] **Orders from outside the cluster** (done 2026-10-29; decision 23,
  `docs/assessment.md`, decided 2026-10-27). Through the console's public `/api`, as a bot signed
  in keylessly; kernel-api stays private. To build:
  1. An order is for the bot's own team (its caps, quota and approvals; its
     maintainers see and cancel it). Done 2026-10-27: a template runs on
     behalf of one of the caller's own teams.
  2. A per-bot list of templates it may order (done 2026-10-27): an
     ordering bot is a member of its team with `order_templates`, set when
     it's made (Automation) or by `TokenService/SetBotOrders`; it may run
     only those (`TEMPLATE_NOT_ORDERABLE`) and nothing else (`ORDERS_ONLY`:
     raw DAGs, single actions, reruns). Schedules aren't limited.
  3. Hearing back: polling (`GetExecution`) and a per-bot callback (done
     2026-10-27, `console/src/callbacks.ts`): `TokenService/
     SetBotCallback` (its team's maintainers), only under the console
     chart's `orders.callbackHosts` (none by default); each finished order
     posts `order.finished` signed (`Vertra-Signature`, HMAC-SHA256 with the
     bot's secret, shown once), five tries as webhooks. Proven on kind: a
     real order queued and posted (to an unresolvable host, its failure
     recorded on the bot), and to a real receiver (2026-10-29,
     `examples/order-receiver`): the order's post verified and answered,
     a forged one and one replayed an hour later refused.
  4. A request rate per bot (done 2026-10-27, `console/src/core/
     orderRate.ts`): the console chart's `orders.ratePerMinute` (60) orders
     a minute for each ordering bot, counted from its runs in the database,
     then `RATE_LIMITED` (429, `Retry-After`).
  5. A team's outcome webhook (done 2026-10-27, `console/src/callbacks.ts`):
     `NotificationService/SetTeamCallback` (its maintainers; on its Settings
     tab, beside its chat webhook), under the same hosts; each run it owns
     posts `run.finished` signed, with each step's state, outputs and failure
     code (outputs left out past 256 KiB, `outputsOmitted`).
- [ ] **Performance benchmarks** (phase 1 done 2026-10-28, `perf/README.md`):
  the `perf` sample's no-op product, a driver submitting DAGs through the
  console to a kind cluster of their own (`vertra-perf`), and the scheduler
  and Postgres alone with the fake executor. Found: the kernel's Kubernetes
  client ran at client-go's default 5 requests a second, about one step a
  second; now a setting (`kubernetesClient`), 50 and 100 by default since
  2026-10-28, which tripled throughput on kind. The scheduler and Postgres
  manage 160 to 515 steps a second. Next:
  1. Not yet seen on GKE or EKS at 50/100: watch the scheduler's log for
     throttling and the API server's for rejections on the next deploy.
  2. Done 2026-10-29 (phase 2, perf/README.md): a step is done when its
     container is (completion lag p50 2.6 s to 1.2 s; burst 3.24 to 3.82
     steps/s; a 20-step chain 84 s to 70.5 s).
  3. Done 2026-10-29: a pass stamps with its time as it goes.
  4. Profiling done (2026-10-29: `profiling.enabled`; the scheduler used
     under 4% of a core in a burst: the node is the limit), and `perf/`'s
     own tests in CI. Left: the sustained and higher scenarios; API load
     through the console; the failure cases not yet covered (a create that
     times out but happened, Postgres or the API server away, cancelling as
     a step finishes); repeated runs compared; a manual or nightly CI job.
  5. Per-team product usage and run counts (from the redesign's gaps,
     2026-10-30; a board drew them): how many runs each team started and which products it
     used, over a day and a week. Decide with the rest of this pass where
     they come from (kernel-api's `GetStats`, or Prometheus) and what they
     cost on a busy install, then show them on the Teams page and Observe.
- [ ] **A chat agent, then an MCP server (decision 24; the chat agent built
  2026-10-28: `console/src/chat/`, `ChatService`, the Ask panel. Seen on
  kind with Qwen 27B: a backups question answered in 229 s (the laptop
  swapping), both citations genuine, every fact from them but one: a
  `vertra config set` command made by joining two sections. Doc fixed, and
  `mustSay`/`mustNotSay` in the question set for scoring. Scored with
  Qwen3 14B (`npm run chat-eval`, 2026-10-28): the layered prompt alone, 10
  of 40 cited an answering section (half answered from memory, inventing
  commands); with the console searching first and repairing an uncited
  answer once, 38 of 40, none uncited, median 32 s. Spot-checked, about
  half are wholly right: the 14B attaches genuine citations to sentences
  its source doesn't support. Then Claude through Anthropic's API (the
  `anthropic` provider, a key in a Secret): Haiku 5.5 and Sonnet 5.5 both
  38 of 40, none uncited, every must-say and must-not-say kept, medians
  3.3 s and 5 s; six spot-checked answers all right on Haiku (two or three
  of six on the 14B). All three miss the same two: the search's misses.
  Haiku is the default worth having: Sonnet's twentyfold price bought
  nothing measurable here. The search's two misses were the docs' (the
  sections never said "before publishing" or "steps start late"): a
  sentence each, and retrieval is 40 of 40, Haiku 40 of 40 (2026-10-28).
  Ordering tasks (`test/chatTasks.ts`, judged by actions: tools in order,
  the cart, what it says): Haiku does all five, app hosting planned and
  proposed with the project it needs, a database wired in, a Kafka
  cluster nobody offers declined, a sample ticket called a sample.
  Running them found the repair turn rewriting ordering answers into
  "the docs don't cover that": an answer from the platform's tools is no
  longer repaired or flagged as not from the docs.
  Thumbs up or down on each answer (2026-10-28): a wrong one asks what
  was wrong; both go, with the question, answer and sources, to Admin's
  Chat tab (`ChatService/RateAnswer`, `ListChatFeedback`; 90 days).
  Guardrails (2026-10-28): a scope check (its own tool-less call, the
  question as data) answers what isn't about Vertra with one sentence; the
  prompt holds the same scope; an answer from neither cited docs nor the
  platform's tools is replaced with the console's "I couldn't find that";
  `chat.contextTokens` bounds every call (a conversation too long refused,
  a tool result that won't fit held back). Haiku: 10 of 10 off-topic
  questions refused (two of them trying to talk it out of its
  instructions), none of the 40 refused, 40 of 40 cited, 5 of 5 tasks; a
  stricter check first refused three (a DAG, GitHub Actions, a 429).
  Streaming (2026-10-28): the steps, not the words. `AskStream` sends
  each step as it's taken and the answer last; the answer's words can't
  stream, since the console checks (and may replace) the whole answer
  before anyone sees it. On kind, an app-hosting order: seven steps over
  15 s, the first at 1 s. Closing the conversation stops its model calls.
  Prompt caching measured (2026-10-28, `chat_answered`'s `tokens`): with
  Haiku 5.5 a docs question takes about 9,000 input tokens over three
  calls, 45% read from the cache, about $0.0009 (a fifth less than
  uncached); an order about 27,000 over six, 78% cached, about $0.0014
  (less than half); an off-topic refusal one call of about 500. Cache
  writes are most of a question's cost. The context window's estimate
  (three characters a token) ran 0.91 to 0.99 of the real count: now 2.5.
  Gemini on Vertex for GCP installs (decided 2026-10-28: "If this is
  hosted in GCP, I'd prefer we use Gemini with Vertex"): the `vertex`
  provider, Vertex AI's OpenAI-compatible endpoint in the install's
  project, signed in as the console's Workload Identity (the metadata
  server's token, as registry checks and audit export already are), no
  key; `reasoning_effort` minimal for the scope check. vertra turns it on
  for gcp (`chat.off`, `chat.model`); its module enables Vertex AI's API
  and grants the console `roles/aiplatform.user`, and gives the scan Jobs
  an identity of their own (they read images anyone can publish; they had
  the console's). Proven against Vertex in acyclix-dev (2026-10-28, from
  kind, an hour's access token standing in for Workload Identity):
  `google/gemini-3.5-flash` answers on the global endpoint (3.5-pro
  doesn't exist there). Running it found Gemini 3 refusing every tool call
  sent back without its thought signature (`extra_content.google.
  thought_signature`, now carried through; the console's own first search
  gets the placeholder Google allows) and Vertex's shared capacity
  answering 429 (a busy model is now asked twice more). Then: 40 of 40
  cited, none refused in scope, 10 of 10 off-topic refused, 5 of 5 tasks
  once the ordering recipe said to give every choice the plan names and
  to call a sample a sample (Haiku, rescored, still everything); median
  6.4 s (Haiku 4.2). Three answers spot-checked, all right. Tokens: a
  question about 7,900 in, an order about 25,000, Vertex's implicit
  cache only 4 to 10% (Haiku's explicit one 45 to 78%): explicit context
  caching on Vertex is worth a look. The window's estimate runs 1.8 times
  Gemini's count (safe). The console's own Workload Identity proven on a
  minimal GKE Autopilot install in acyclix-dev (2026-10-28, `vertra apply`
  from source, chat on Vertex by default, then destroyed): no key in the
  console at all, its ServiceAccount bound to `vertra-ch-console` (the only
  one with roles/aiplatform.user) and the scanner to its own
  `vertra-ch-scanner`; Gemini 3.5 Flash answered 10 of 10 questions cited
  and refused 10 of 10 off-topic, median 6 s. (The first apply met a
  us-central1 capacity shortage; the retry went through.)
  Admins set the chat agent's model in the console (2026-10-28, Admin, Chat
  agent): provider, model, key (sealed, write-only), limits, in place of
  the install's until reset; checked as the install's are; tried with one
  question before saving. The Admin page is now sections down the side
  (Install, Access, Integrations, Security), each its own address, with
  room for MCP and Bedrock.
  Gemini on Vertex keeps an install's questions in its own cloud (done and
  proven on GKE, above); prompt caching measured (done, above). Left:
  Claude on Bedrock (blocked on the account's model access), Claude on
  Vertex if an install asks for it; then MCP, last) (proposed
  2026-10-27)**: a chat panel in the console whose agent works as the
  signed-in person over `core/` (describe an offering, what the team has
  and what depends on what, plan and change the cart; never place it: the
  person's own Place order confirms), and answer questions from every doc
  (done first, 2026-10-28: the platform's docs ship in the console's image,
  `console/docs/reference/`, and `GuideService/SearchGuides` searches them
  and the guides by section, the Docs page's search too). Correctness
  (decision 24, part 4), done first, 2026-10-28: docs labelled by kind
  (design history searched only for "why"), citations checked against
  what was retrieved with links the console builds (`src/chat/
  citations.ts`), and a 40-question set (`test/docQuestions.ts`) whose
  retrieval CI holds at 90% or more (95% now, from 80% before stemming,
  a softer length penalty, synonyms and heading scores). Since done:
  answers scored per model, scripted tasks, thumbs up or down. The model is the install's `chat`
  setting: Vertex AI on GCP, Bedrock on AWS, keyless; two adapters
  (Anthropic's format, OpenAI-compatible); a scripted model in tests. Prove
  locally with LM Studio (Qwen3, OpenAI-compatible, at
  `host.docker.internal:1234` from kind). Then the same tools as an MCP
  server at `/mcp` for engineers' own agents (bots, then people through
  OAuth 2.1). Groundwork for Vertex AI, Bedrock, Azure AI Foundry. Builds
  on decision 25's cart. Its cart tools seen with Claude Sonnet 5.5 on kind
  (2026-10-29): it found the offering, planned, proposed the cart with the
  existing ticket chosen and the watcher filled in (placed as proposed, it
  ran), declined to place an order itself, explained a failed run, and
  questioned a run said to have failed that hadn't. Found doing it: Sonnet
  5.5 refuses `thinking: disabled` (the scope check now turns thinking down
  per model), a proposed cart couldn't carry values or choices (it can now),
  and resources made before their product typed its outputs weren't offered
  (registering a product now updates them). The MCP server waits (decided 2026-10-29) until the
  platform is solid and a team asks for it: its tools proven first in the
  Ask panel with a capable model, and the cart seen end to end on a cluster.
- [x] **The cart (decision 25, done 2026-10-28)**, what the agent and
  people order with, in this order:
  1. The catalog carries its wiring types (done 2026-10-27): each team's
     `teams/<team>/types.yaml` (`tools/types.schema.json`, checked by
     `vertra catalog validate`: defined once, default providers the team's
     own and providing the type, every type a product names defined) in
     the release's `wiring_types`, replacing the install's; the gcp sample
     typed (project, region, database, image).
  2. Resources remember what their step provided, and what they depend on
     (done 2026-10-28, `resourceRecorder.ts`, `core/resources.ts`):
     `resources.provides` (each output typed `x-vertra-provides`) and
     `resource_links` (an input wired from another step of the run, or one
     whose value a live resource provides, of its wiring type: across
     runs). Deleting something others depend on is refused
     (`HAS_DEPENDENTS`), recorded (`resource_delete_requests`) and alerts
     the admins; it runs once an admin approves it
     (`ResourceService/DecideDeleteRequest`; What runs made, Waiting for
     an admin). Deleting the dependents with it needs no approval, and they
     go first. Seen on kind (2026-10-29) with the local sample's ticket,
     now typed (`local.ticket`; `watch` needs one): a watch alone added
     open, the next was offered the ticket; the ticket, with two watches
     from two runs, was refused alone (HAS_DEPENDENTS) and deleted with
     them, watches first. A waiting request whose resources all go another
     way is now closed (decision `deleted`), not left to approve.
  3. `PreviewOrder` offers existing resources and optional suggestions
     (done 2026-10-28, `core/orders.ts`): a required input nothing in the
     cart provides is offered the team's and the caller's live resources
     of its type, none chosen (`CHOOSE_EXISTING`, with "a new one" when
     the type has a default provider; `choices` take `resourceId` or
     `addNew`); an optional one is suggested (`suggestions`); an input of
     a type its own action provides is the person's (a project.create's
     id). Gateway APIs aren't resources, so they're never offered. Compose
     shows the choices but can't make them yet: the cart (4) does. Proven
     on kind with the gcp sample registered (not run): app hosting alone
     adds project.create, asks the region once, suggests a database, and
     reports the image; with a project the team has, offers it or a new one,
     and each choice wires as asked.
  4. ~~`OrderService/PlaceOrder` and the Catalog's cart~~ (done
     2026-10-28, `core/orders.ts`, `pages/CartPage.tsx`): Add to cart on
     each action, the cart planned for one of your teams with its choices,
     suggestions and values, Place order; the run is the team's, an
     "order", its cart its parameters (rerun plans it again). Wired targets
     are now held to allowedTargets for every submission (the attached
     schema narrowed; the kernel refuses with INPUT_INVALID). Proven on
     kind: a two-step order of local actions ran as the team's order; an
     incomplete cart was refused, saying what's missing. Left: the narrowed
     schema's refusal seen on a cluster (tested in the kernel; no runnable
     sample provides a target type yet). Was: a
     member checks out a cart (decided), each step as
     `RunAction` would run it; a wired target re-checked when its step
     starts. The Catalog's cart.
- [x] **Order builder** (done 2026-10-27, decision 23, `console/src/core/
  orders.ts`): `OrderService/PreviewOrder` wires a cart of actions by wiring
  type (each input to the one output of its type), puts the steps in an order
  they can run, adds a type's default provider, asks a shared type once (a
  parameter named for it), and reports `AMBIGUOUS` (with the options, and
  `choices` to settle them), `NO_PROVIDER` and `CYCLE`. It runs nothing:
  Compose's **Build from a cart** opens the result for a person to review,
  run or propose. Not for ordering bots (carts become templates first). An
  input more than one step could fill is chosen in the card itself, which
  wires the steps again with it (2026-10-29, `components/OrderChoice.tsx`,
  shared with the Cart page).
- [x] **Base images the platform maintains** (done 2026-10-27, decided:
  mirror and pin, not required): a catalog's `bases.yaml` lists approved
  bases; catalog CI copies each weekly into `<registry>/bases/<name>` (same
  digest, every platform), scans it (reported, not blocking) and signs it
  (`vertra catalog bases mirror`), and `vertra catalog bases --use-mirror`
  points Dockerfiles at the copies. Copying is tested against a registry;
  the weekly run itself isn't seen yet (the next cloud catalog run).
- [x] **One provider identity per team** for SecretStores (done
  2026-10-27): the console records each team's store identities
  (`secret_store_identities`) and refuses another team's store naming one
  (`IDENTITY_IN_USE`), and the catalog's `secret-stores check` says so in
  the pull request. Bindings made only on the cloud's side (EKS Pod
  Identity) stay the cloud administrator's to keep per team.

## Testing and housekeeping

- [x] **Console tests failing now and then in a full parallel run**
  (2026-10-27 to 2026-10-29): one at a time, in different files (apis,
  team-lifecycle, readiness, sso), each passing alone. Causes found and
  fixed: the hourly Google groups re-read failed its whole pass on a
  person deleted mid-pass (now skipped); sso.test's groups mocks answered
  for every account, so a resync added oidc.test's person to its team;
  notifications.test's and oidc.test's tampering was a no-op one time in
  64. 32 full runs in a row passed after. readiness.test's one failure
  wasn't kept, so its cause is unknown: keep a failing run's whole output
  when one is seen, and reopen this.

- [x] **`vertra catalog publish` from a laptop builds for the laptop's
  platform** (done 2026-10-25): a catalog's `platform` (`VERTRA_PLATFORM`)
  says what to build for; unset, a local registry gets this machine's, any
  other `linux/amd64`, so a Mac's publish runs on a cloud cluster (found
  proving the gcp cleanups on GKE). One platform per catalog, not
  multi-platform images.
- [x] **`vertra` sets up a signed catalog** (done 2026-10-26): `signing`
  (none, kms, keyless), asked at init; apply makes the KMS key (gcp, aws)
  only the catalog's CI may sign with, installs policy-controller bound to a
  registry reader, and gives both charts the signer; `vertra catalog create`
  sets the repository's VERTRA_SIGNING_* variables. Proven on GKE, kms then
  keyless, and on EKS, AWS KMS with policy-controller reading ECR through
  Pod Identity (see docs/security-model.md). Found on the way, and fixed:
  the template pinned a vertra too old for its own samples (released 0.3.0
  and pinned it; CI now validates the template with its pinned vertra), and
  keyless signing failed with cosign 3 (0.3.1), and an AWS kms apply read
  no public key (the CLI's `--output json` won over `--output text`).
- [x] **An intermittent console test** (fixed 2026-10-25):
  `product-ownership.test.ts`'s startup claim read every product, then
  inserted for a team another file had deleted meanwhile. The claim now
  reads the team, locked (`FOR KEY SHARE`), in the same statement as its
  insert (reading it unlocked still raced, once).
- [x] **The docs page's diagrams under mermaid 12** (done 2026-10-27):
  every one parses under 12.2.0, and a frontend test
  (`src/docsDiagrams.test.ts`) keeps it so for the next bump. How they look
  hasn't been checked by eye.
- [x] **An end-to-end secret test** (done 2026-10-29): `make
  kind-e2e-secrets` (helm/tests/secrets-e2e.sh) on the kind install: a
  SecretStore (ESO's fake provider) syncs a value, a registered product's
  step reads it (its SHA-256), and an unregistered image or another team
  naming the Secret is refused; and a kernel kind test in CI checks a step
  gets exactly the Secrets it names. Proven by hand on EKS before
  (2026-10-27).
- [x] **`rot13`'s CVE-2026-84782 exception** (done 2026-10-29): rot13
  had already moved to a static binary on distroless `static`, which has no
  OpenSSL; its `.trivyignore` is deleted (Trivy 0.74.0 finds nothing
  fixable at HIGH or CRITICAL, and no libssl).
- [x] **actionlint in the catalog template's own CI** (done 2026-10-27):
  its pull-request check lints the workflows, with actionlint installed
  pinned as the scanners are.
- [x] **`make up` mistakes any console port-forward for its own** (done:
  `PORT_FORWARD` names the context and port, which `pgrep`/`pkill` match).
- [ ] **Switch to Sigstore's newer signature format** once policy-controller
  reads it (catalog CI signs with `--new-bundle-format=false`). Checked
  2026-10-29: the installed policy-controller (chart 0.10.8, app 0.13.1) has
  an authority's `signatureFormat: bundle`, but its docs say the bundle
  format covers attestations only, not plain signatures, which is what
  catalog CI makes. When it covers signatures: sign without the flag, and
  give the image policy both formats' authorities for the change (they're
  OR'd), then drop `legacy` once old images are gone.
