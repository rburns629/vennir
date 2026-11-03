# vertra: design

The installer CLI for Vertra: from nothing to a running install on your
machine or a cloud, and a catalog repository ready to publish to. This is
the design to build it from; decisions are recorded in [TODO.md](../TODO.md)
and here, and anything still open is listed at the end.

## Goals

- **One path from zero to working**, for people who've never seen the
  project: answer a few questions, read one summary with a cost estimate,
  approve, and get a working install, catalog and first team.
- **Nothing hidden.** Every change is shown before it's made, and the CLI
  can be re-run at any time: it finds less to do, never duplicates.
- **A closed support matrix.** A fixed set of targets, cluster modes and
  sizes, each tested; anything else goes through a Helm values passthrough,
  not new options.
- **Never required.** The Helm charts stay complete on their own, so GitOps
  and hand-run installs keep working; the CLI installs with those same
  charts.

Not goals: managing a cluster's day-to-day operation beyond Vertra's own
releases, multi-cluster installs, or a hosted service.

## Concepts

| Concept | Values | Meaning |
| --- | --- | --- |
| **Environment** | any name (`dev`, `prod`) | One install. Its settings live in `./deploy/<env>/` |
| **Target** | `kind (local)` (`kind` in config), `gcp`, `aws`, `azure` (not offered: after the MVP, decided 2026-10-25), `existing` | Where it runs |
| **Cluster mode** | `auto`, `standard`, `existing` | Only when the CLI creates the cluster: `auto` is GKE Autopilot, EKS Auto Mode or AKS Automatic; `standard` is node pools the CLI sizes; `existing` uses one you have |
| **Size** | `minimal`, `resilient`, `scaled`, `auto` | The compute floor and guardrails: replicas, step caps, the default step size, Spot. `minimal` is the absolute minimum; `auto` scales between `minimal` and `scaled` on load |
| **Database** | `in-cluster`, `managed` | Any size: the bundled Postgres Pod with daily backups to a bucket, or Cloud SQL, RDS or Azure Flexible Server (high availability optional). Built (2026-10-29): Cloud SQL on gcp and RDS on aws, each service signing in with its own identity, no passwords of Vertra's |
| **Scale down** | yes / no | Yes: the platform sleeps when idle. No: always on, with a chosen minimum of copies and optional warm headroom for steps |
| **Git host** | `github` (first), `gitlab` (next) | Where the catalog repository lives |

## Commands

```
vertra init <env>        ask the questions, write deploy/<env>/vertra.yaml
vertra check [<env>]     read-only: tools, sign-ins, policies, what exists, what's missing
vertra apply [<env>]     plan, show the approval screen, then create or change and install
vertra catalog create [<env>]   create the catalog repository and the first team, smoke-test it
vertra catalog grant [<env>] --reader <name> ...   (the owner's install) let another install read the catalog,
                             as exactly its identity; --revoke takes it away
vertra catalog check|publish|release|...   a catalog's own commands, run in it (its CI runs them through ./vertra)
vertra status [<env>]    what's running, awake or asleep, versions, last plan
vertra sleep|wake [<env>]
vertra console [<env>]   reach the console on localhost (a port-forward with the CLI's own tools)
vertra config get|set <key> [<value>]   change a setting; apply makes it so
vertra destroy [<env>]   remove what the CLI created, after its own approval screen;
                             asks about each kind of data unless --all
vertra tools             list required tools and versions; download the missing ones
vertra version
```

Common flags: `--config <dir>` (or `VERTRA_CONFIG`; default
`./deploy/<env>`), `--yes` (approve without the prompt), `--plan-only`
(print the approval screen and stop), `--non-interactive` (every answer from
flags or the config file; fail on a missing one, never prompt). An
environment name is optional when there's only one in `./deploy/`.

## `init`: the questions

Requirements for the chosen target are checked as soon as the target is
known, before any further question (see [Requirements](#requirements-and-tools)).

1. **Target:** kind (local), gcp, aws, azure, existing.
2. **Where:**
   - gcp: project, region. aws: account (from the signed-in profile),
     region. azure: subscription, region, resource group.
   - existing: kubectl context, namespace (default `vertra-system`).
3. **Cluster:** create one or use an existing one (cloud targets); if
   creating, **cluster mode** `auto` or `standard`, and its name.
4. **Size:** minimal, resilient, scaled or auto, each shown with its
   resources (the table under [Sizes](#sizes)).
5. **Scale down when idle?** yes / no.
   - Yes: idle period (default 2 hours).
   - No: always-on copies of the console and API (default from the size),
     and warm headroom: "keep room for how many steps to start without
     waiting?" (default 0; suggested for scaled).
6. **Registry for task images:** create one (cloud targets), use an
   existing one, or the local registry (kind (local)).
7. **Image signing:** off, a cloud KMS key (created), or keyless (the
   catalog CI's own identity).
8. **Database:** in-cluster (the default; daily backups to a bucket the
   module creates, or to a volume on kind (local), with a retention), or
   managed (Cloud SQL, RDS, Azure Flexible Server), and then whether it's
   highly available (default: off for minimal and auto, on for resilient
   and scaled).
9. **First admin's email.**
10. **Catalog** (asked here so `apply` can create its cloud federation; the
    repository itself is created by `catalog`): git host, owner (account or
    organization), repository name, visibility (public, private, internal
    where the owner supports it), first team's name, starter languages
    (multi-select: Python, TypeScript, Go, PowerShell, Rust), and any of the
    billed cloud samples.

Every answer has a flag, and `init` writes them all to the config file.

## The config file

`deploy/<env>/vertra.yaml`: names and references only, never a secret, so
it's safe to commit to a private repository of your own. `deploy/` is
gitignored in this repository.

```yaml
version: 1
vertra: 0.1.0               # the release installed; apply upgrades to a newer one when changed
target: gcp
gcp: {project: my-project, region: us-central1}
cluster:
  create: true
  mode: auto                 # auto | standard | existing
  name: vertra
  context: ""                # existing only
namespace: vertra-system
size: minimal              # minimal | resilient | scaled | auto
scaleDown:
  enabled: true
  idleAfter: 2h
  schedule: ""               # advanced: "awake Mon-Fri 08:00-19:00 Europe/Amsterdam"
minReplicas: 1               # console and kernel-api, when scaleDown is off
stepHeadroom: 0
registry: {create: true, name: vertra-products}
signing: kms                 # none (the default) | kms | keyless: with a catalog, on gcp or aws
database:
  type: in-cluster           # in-cluster | managed
  highAvailability: false    # managed only
  backups: {enabled: true, retentionDays: 30}   # in-cluster only
logs: {enabled: false, searchDays: 30, keepDays: 365}   # Observe's log search; archived after searchDays (gcp, aws)
console:                     # existing clusters: a public console behind your Ingress
  public: false
  hostname: console.example.com
  ingressClass: nginx
  tls: {letsEncryptEmail: you@example.com, installCertManager: true}   # or issuer: <ClusterIssuer>
audit: {export: false, keepDays: 365, lock: false}
sso: {provider: google, clientId: ..., clientFile: ~/vertra-oauth.json, allowedDomains: [example.com]}   # vertra sso google       # the audit log's write-once copy (gcp, aws); lock is permanent
chat: {off: false, model: google/gemini-3.5-flash}   # gcp: the chat agent on Vertex AI, as the console
admin: {email: you@example.com}
catalog:
  host: github
  owner: my-org
  repository: vertra-catalog
  visibility: private        # public | private | internal
  team: platform
  languages: [python, go]
  samples: []
values: values.yaml          # optional: Helm values layered last, for anything not asked
```

Next to it, the CLI keeps `tofu/` (the OpenTofu working directory and its
state, unless a remote backend is configured), `last-plan.txt` (the approved
approval screen), `applied.yaml` (the config as last applied, so the next
screen names the settings changed since), `admin-password` (the first admin's generated password,
0600, kept out of git by a `.gitignore` beside it; delete it once you've
signed in), and nothing else. The state holds resource attributes and
must be treated like the config's private companion: gitignored here, and
kept wherever the config is kept.

## Requirements and tools

Checked first, by `init` once the target is known, by `check`, and at the
top of the approval screen.

| Selected | Needs | Also checked |
| --- | --- | --- |
| Every install | `kubectl`, `helm` 4 | kubectl within one minor version of the cluster |
| gcp, aws, azure | `tofu` (OpenTofu) | |
| kind (local) | `docker`, `kind` | Docker running; about 4 GB of memory free |
| gcp | `gcloud`, `gke-gcloud-auth-plugin` | Signed in; project set; billing enabled; required APIs (enabled by the module) |
| aws | `aws` (v2) | Signed in (`aws sts get-caller-identity`) |
| azure | `az`, `kubelogin` | Signed in (`az account show`); subscription set |
| existing | (kubectl, helm) | The context reaches the cluster; Kubernetes 1.30+; ValidatingAdmissionPolicy available |
| `catalog` on GitHub | `git`, `gh` | Signed in; token scopes `repo`, `workflow`; SSO authorized for the owner |
| `catalog` on GitLab | `git`, `glab` | Signed in to the host |

**Missing tools.** Single static binaries (`kubectl`, `helm`, `tofu`, `kind`,
`gh`, `glab`, `kubelogin`) are downloaded with your consent into
`~/.vertra/bin`, at versions pinned in the CLI and checked against each
project's published checksum. The CLI uses its own copies; it never uses
`sudo` or changes your `PATH`. Tools that need an installer or a background
service (`docker`, `gcloud`, `aws`, `az`) aren't downloaded: the CLI prints
the exact install command for your system (Homebrew, winget, apt or dnf) and
the sign-in that follows.

## `apply`

1. Load the config; run every check (failures stop here, with what to do).
2. **Cloud side** (gcp, aws, azure): `tofu init` and `tofu plan` on the
   target's module, with inputs from the config.
3. **Install side:** render the Helm releases (`helm template` and a diff
   against what's installed): chart version, values composed from the size,
   the cloud outputs and your passthrough.
4. **Price it** (see [Cost](#the-approval-screen-and-cost)).
5. **Show the approval screen; wait for approval** (or `--yes`).
6. `tofu apply` the saved plan; then the cluster's credentials; the
   platform namespace; policy-controller if signing is on; External
   Secrets Operator; `helm upgrade --install` of the kernel, then the
   console (`--reset-values`, `--force-conflicts` for the kernel).
7. Wait until both are ready; print where the console is and how to reach
   it, and where the first admin's password is: `admin-password` in the
   environment's folder, readable only by you and listed in a
   `.gitignore` there (never printed: it would land in CI logs).

### Values composition

From lowest to highest precedence:

1. The charts' defaults.
2. **The size preset**, each chart's `sizes/<size>.yaml`, packaged with the
   charts so Helm users can use them directly (for a release, vertra
   pulls the charts into `deploy/<env>/charts/<version>/` and installs from
   there).
3. **Generated values:** the target's (image source, registry, identities'
   annotations, Spot selectors, backups, signing), scale-down, minimum
   copies and headroom.
4. **Your passthrough** (`values:` in the config).

### Sizes

What each preset sets: first figures, from what the charts request today,
to be tuned against measurements (and checked against GKE Autopilot's
per-Pod minimums).

**Platform Pods, awake, database in-cluster**

| Component | Each Pod requests | minimal | resilient | scaled | auto |
| --- | --- | --- | --- | --- | --- |
| kernel-api | 0.1 vCPU, 256 MiB | 1 | 2 | 3 | 1 → 3 on load |
| kernel-scheduler | 0.1 vCPU, 512 MiB | 1 | 1 | 2 | 1 |
| console | 0.1 vCPU, 512 MiB | 1 | 2 | 3 | 1 → 3 on load |
| Postgres (both databases, one instance; no CPU limit) | minimal 0.25 vCPU, 512 MiB; resilient and auto 0.5 vCPU, 1 GiB; scaled 1 vCPU, 2 GiB | 1 | 1 | 1 | 1 |
| **Total** | | **0.55 vCPU, 1.75 GiB** | **1 vCPU, 3 GiB** | **1.8 vCPU, 5.25 GiB** | **0.8–1.2 vCPU, 2.25–3.75 GiB** |
| Database volume | | 10 GiB | 50 GiB | 100 GiB | 50 GiB |
| Survives upgrades and node maintenance | | No (a brief interruption) | Yes (PodDisruptionBudgets) | Yes | Only while at 2+ copies |
| Retention | | 30 days | 90 days | 90 days | 90 days |

With a managed database, the Postgres Pod and its volume drop out and the
managed instance is billed on its own. Occasional Pods, any size: the image
scanner (0.1 vCPU, 512 MiB to 2 GiB) only while scans are pending; the
backup job (0.1 vCPU, 256 MiB) a few minutes a day; the sleeper, seconds at
a time.

**Steps**

| | minimal | resilient | scaled | auto |
| --- | --- | --- | --- | --- |
| Default step size | 0.25 vCPU, 512 MiB | 0.5 vCPU, 1 GiB | 0.5 vCPU, 1 GiB | 0.5 vCPU, 1 GiB |
| Steps at once (per team) | 10 (5) | 50 (20) | 200 (50) | 50 (20) |
| Most steps can use at once, at the default size | 2.5 vCPU, 5 GiB | 25 vCPU, 50 GiB | 100 vCPU, 200 GiB | 25 vCPU, 50 GiB |
| Capacity | Spot | Spot | On-demand (Spot per product later) | Spot |
| When nothing runs | 0 | 0 | 0 | 0 |

The caps are ceilings, not reservations; a product can declare a larger size
in `product.yaml`; warm headroom, when chosen, adds one default-size step per
reserved slot, around the clock. Every preset sets the default step size: on
GKE Autopilot a Pod with no requests is given 0.5 vCPU and 2 GiB, and on
every cluster a step's request is what's paid for or reserved. `scaled` also
raises the scheduler's `claimLimit` and `executorConcurrency`.

**`auto`** scales the console and kernel-api between one and three copies on
CPU load (a HorizontalPodAutoscaler), so a quiet install costs about
`minimal` and a busy one gets `resilient`-like capacity. The scheduler and
Postgres stay at one, and steps already scale from 0 to the cap. At one
copy it has `minimal`'s availability (an upgrade or node drain interrupts
it briefly). It needs the cluster's metrics service: built into GKE, EKS
Auto Mode and AKS Automatic; on kind (local) the CLI installs
metrics-server. It pairs naturally with the `auto` cluster mode, where the
nodes follow the Pods, and with scale-down.

### Cluster modes, per cloud

| | auto | standard |
| --- | --- | --- |
| gcp | GKE Autopilot: billed per Pod request | GKE Standard: a `platform` pool (min 1) and a `steps` pool (min 0, or the headroom; Spot) with the cluster autoscaler |
| aws | EKS Auto Mode (Karpenter): billed per node; empty nodes removed | EKS with managed node groups (`platform` min 1, in one zone, its volumes'; `steps` min 0, Spot) and the Cluster Autoscaler |
| azure | AKS Automatic: billed per node; node autoprovisioning | AKS with a system pool (min 1, required) and a `steps` user pool (min 0, Spot) |

## The cloud side: OpenTofu modules

One module per cloud, embedded in the CLI binary (so a CLI version always
runs the modules it was tested with) and also published in the repository
for teams that run OpenTofu or Terraform themselves.

| Creates | gcp | aws | azure |
| --- | --- | --- | --- |
| Network | VPC and subnet (or uses one given) | VPC, subnets, NAT | VNet and subnet |
| Cluster | Autopilot or Standard with Workload Identity | Auto Mode or managed node groups with Pod Identity | Automatic or standard, with Workload Identity and network policy |
| Registries | Artifact Registry: platform images, task images | ECR repositories | ACR |
| Identities | Service accounts and Workload Identity bindings for the console, the scanner (its own, read-only), backups, and ESO | IAM roles and Pod Identity associations | Managed identities and federated credentials |
| Signing | Cloud KMS key (signing: kms) | KMS key | Key Vault key |
| Catalog CI | Workload Identity Federation limited to the catalog repository | GitHub OIDC provider and a role limited to the repository | Federated credential for the repository |
| Database (managed) | Cloud SQL for PostgreSQL (HA optional) | RDS PostgreSQL (Multi-AZ optional) | Azure Database for PostgreSQL Flexible Server (zone-redundant optional) |
| Backups (in-cluster database) | Bucket with a lifecycle rule | S3 bucket with a lifecycle rule | Storage container with a lifecycle rule |
| Observe's alerts on GKE's managed Prometheus | Cloud Monitoring's API, and `roles/monitoring.viewer` for the console (`monitoring.provider: google`) | (the chart's monitoring values) | (the chart's monitoring values) |
| The chat agent's model | Vertex AI's API, and `roles/aiplatform.user` for the console (Gemini; `chat.off` for none) | (the chart's chat values) | (the chart's chat values) |

Outputs feed the generated Helm values (registry paths, identity
annotations, the database URL, the backup destination). State lives in
`deploy/<env>/tofu/` unless the config names a remote backend. OpenTofu runs
on your machine under your own cloud sign-in; nothing is delegated to CI.
Providers and the OpenTofu version are pinned.

## The approval screen and cost

```
Vertra 0.1.0 → gcp / my-project / us-central1, new cluster vertra (auto: GKE Autopilot)

Tools        kubectl 1.33, helm 4.3, tofu 1.10, gcloud 540: all present
Size         minimal: platform 0.55 vCPU, 1.75 GiB awake; in-cluster Postgres, 10 GiB
Scale down   yes: sleeps after 2h idle; `vertra wake` to resume
Steps        at most 10 at once (5 per team), 0.25 vCPU / 512 MiB each, Spot
Images       scanned; signed with a Cloud KMS key
Backups      daily to a new bucket, kept 30 days
Catalog      github.com/my-org/vertra-catalog (private), team platform, Python and Go starters
Skipped      branch rules and secret scanning (a private repository on GitHub's free plan)

Will create  cluster, network, 2 registries, KMS key, backup bucket, 4 identities, catalog federation
Will install execution-kernel 0.1.0, execution-console 0.1.0 into vertra-system

Estimated monthly cost (list prices, us-central1, fetched now)
  Always        control plane (free tier), disks and storage ~$…
  While awake   platform ~$… a month if never asleep
  While asleep  ~$…
  Steps         ~$… per step-hour at the default size; at the cap, ~$… a month if always busy
  Likely        $…–$… a month for light use
  Not included: discounts, taxes, network egress, your products' own cloud usage

Note  While asleep, the console and API are unreachable: catalog CI and automation fail until `wake`.

Apply? [y/N]
```

- **Live prices**, looked up when planning; nothing is priced from numbers
  built into the CLI:
  - **Azure:** the Retail Prices API (`prices.azure.com/api/retail/prices`),
    which needs no sign-in. Prices in USD.
  - **AWS:** the Price List Query API (`aws pricing get-products`), signed
    with your AWS sign-in (`pricing:GetProducts`, `DescribeServices`,
    `GetAttributeValues`), served only from `us-east-1`, `eu-central-1` and
    `ap-south-1` whatever the deploy region; throttled to about 5 calls a
    second. Fallback: AWS's public bulk price files, no sign-in.
  - **GCP:** the Cloud Billing Pricing API. With your gcloud sign-in and
    Billing Account Viewer on the project's billing account, it returns
    your account's actual prices, discounts included (preferred). Public
    list prices need an API key instead: the CLI creates one in your
    project restricted to the Cloud Billing API, uses it for that plan, and
    deletes it; it's never stored. (To verify when building: whether the
    older Catalog API v1 accepts a gcloud token for public prices; and the
    exact SKUs for GKE Autopilot, EKS Auto Mode and AKS Automatic.)
    Settled for GCP (2026-10-18): the Catalog API v1 (`services.skus.list`)
    accepts a gcloud token (it takes the `cloud-platform` scope), so list
    prices need no API key; the SKUs are "Autopilot Pod mCPU Requests
    (<region>)", "Autopilot Pod Memory Requests (<region>)", their "Spot"
    versions, "Autopilot Kubernetes Clusters" (the fee), "E2 Instance
    Core/Ram running in <group>" (and "Spot Preemptible ..."), and
    "Balanced PD Capacity". Account prices are in (2026-10-29): each
    priced SKU's account price from the Pricing API (`billingAccounts.skus.
    price`, v1beta), as a ratio to its list price that scales the list
    price (so units never need converting), cached a day per billing
    account. Without Billing Account Viewer the screen says list prices,
    and why.
- **The model follows the cluster mode:** per Pod request on Autopilot; per
  node (the nodes the requests need, including the platform pool's floor)
  for EKS Auto Mode, AKS Automatic and standard; the control plane and
  storage always. kind (local) is $0. existing shows Vertra's share of
  requests only.
- **If prices can't be fetched,** the screen shows resource totals and says
  the cost is unavailable; it never guesses.
- On a later `apply`, the screen shows what changes: the settings changed
  since the last apply (against `applied.yaml`), a rerun at the same
  version as applied again rather than upgraded, and policy-controller or
  External Secrets Operator only when they're missing or older than vertra
  pins. The approved screen is saved as `deploy/<env>/last-plan.txt`.
- The resources it states are the size's, plus the parts turned on that
  request their own: the gateway, log search, a Prometheus of the
  install's own.

## Scale down, sleep and wake

New chart features, so Helm users get them too:

- **A sleeper** (kernel chart, `scaleDown.*`; `kernel/internal/sleeper`): a
  CronJob in the platform namespace, with a Role that can only change the
  replica counts of the platform's named Deployments (the scale
  subresource), that checks for activity (an unfinished execution, the
  last execution event, the console's last use, kernel-api's start) and
  scales the platform to zero after `idleAfter` with none, the databases
  last. It never sleeps while an execution is unfinished, and a scheduled
  sleep (`scaleDown.schedule`) waits for them. The counts to wake to go in
  the kernel chart's `-sleep` ConfigMap, which `vertra sleep` and
  `wake` use too. Postgres keeps its volume.
- **The console's last use** (console chart, `activity`): any signed-in
  request, at most once a minute, written to an `-activity` ConfigMap, the
  only one the console may update. Reads count, not only the audited
  changes.
- **`vertra sleep|wake`** scale the platform down or up (wake waits until
  it's ready), whatever the setting. A sleeping console can't wake itself,
  but its schedules can: the console keeps its next schedule's time in its
  activity ConfigMap; the sleeper stays awake for one due within the idle
  window, and otherwise arms a one-off wake CronJob (`kernel wake`, under
  the sleeper's Role) for five minutes before it, which restores the
  platform and stands itself down.
- **The image scanner idles to zero** on its own (console chart,
  `scanning.idleMinutes`): the console scales the Trivy server up for
  pending scans (which wait for it) and down after a quiet period.
- **Warm headroom** (kernel chart, `stepHeadroom`): low-priority placeholder
  Pods at the default step size, which steps preempt; in standard mode it
  also sets the steps pool's minimum nodes.
- **PodDisruptionBudgets** for the console and kernel-api at two or more
  copies.

## The catalog step

1. Check the git host: signed in, scopes, the owner's plan and policies
   (repository creation, allowed actions, OIDC), the visibilities it
   supports, and which settings it would refuse.
2. Create the repository with the chosen visibility; copy in
   `catalog-template/` from the CLI's release (embedded, like the modules:
   the release workflow writes `internal/catalogtemplate/template.tgz`; a
   `vertra: source` install takes the checkout's), with `./vertra` pinned
   to that release,
   with the owners in CODEOWNERS replaced, the first team created from
   `templates/team/`, and the chosen language starters copied from
   `samples/local/products/` with their `team:` rewritten; plus any billed
   samples. Push `main`.
3. Set the variables (registry, its sign-in, signing): no console
   credential, since each console pulls the catalog's release; remove and
   revoke the console URL and tokens an earlier version stored; create the
   `catalog-publish` and `purge`
   Environments and the branch rules where the plan allows. A repository
   that already has commits isn't pushed: when it last published to another
   registry (`--take-over`), `catalog-ci` is run by hand
   (`workflow_dispatch`) to republish every product to this install's.
4. Wait for the first publish and release (that run by hand, told by its
   run id, for an existing repository); have the console apply it
   (`AdminService/SyncCatalog`, over a port-forward that's started again
   whenever kubectl's drops); submit a DAG using a starter; report the
   result. It signs in as the first admin with the password `apply` saved
   (or `VERTRA_ADMIN_PASSWORD`, or asks), and when the console wants that
   generated password changed first, asks for a new one
   (`VERTRA_NEW_ADMIN_PASSWORD` without a terminal) and deletes the file.

As built (2026-10-18), for gcp: `init` asks the catalog's owner,
repository, visibility, first team and starter languages, and whether the
console is public; `apply` then reserves the console's global address
(the chart's Ingress, a Google-managed certificate for its hostname, a nip.io
name by default, and `trustProxy` for Google's front ends) and the
federation (a Workload Identity pool whose provider accepts only the
repository's `main`, and a publish identity that may write the task
registry). `vertra catalog create` sets the variables before the push (the
console makes the team when it applies the first release), and
creates the Environments only where the plan has them (a public
repository, or a paid plan; GitHub doesn't always report the plan, and an
unknown one counts as free). A public console's load balancer is priced
("Cloud Load Balancer Forwarding Rule Minimum Global"), and `destroy`
removes its certificate and waits for GKE to remove it before the cluster.

**How the console is reached** is asked on every cloud (decided
2026-10-18), private by default: *private* (nothing outside the cluster;
`vertra console` port-forwards) or
*public* (HTTPS from the internet: a load balancer, about $18 a month,
and a sign-in page on the internet; on gcp a nip.io name or your hostname,
on aws a Route 53 zone you delegate, with Auto Mode). A catalog works
either way since 2026-10-20: its CI only pushes to the registry, and the
console pulls the release.

**An existing repository** is never written to by surprise: if the name
`init` is given exists, you choose to use it (`catalog.useExisting`: its
contents stay, and `catalog` sets its variables and federation for this
install) or another name; `catalog` refuses an existing, non-empty
repository the config didn't choose. A repository created for you is
checked to have come out with the visibility asked for (GitHub's
`/user/repos` reads `private`, not `visibility`).

**SSO.** A 403 carrying GitHub's `X-GitHub-SSO` header means the token isn't
authorized for that organization: the CLI shows and opens the URL in it,
waits, and retries. Missing scopes go through `gh auth refresh -s <scope>`.

**Git hosts behind one interface** (create repository, push, variables and
secrets, environments, protected branches, code owners, OIDC subject format,
authorization errors), implemented for GitHub with `gh`, then GitLab with
`glab` (gitlab.com and self-managed; public, internal, private), with the
catalog template gaining GitLab CI wrappers over vertra catalog.

## `destroy`

Shows what it will remove, like `apply`'s approval screen, then asks about
each kind of data separately, each defaulting to keep: the database (its
volume, or the managed instance), the backups, the registries' images, and
the catalog repository. Everything else the CLI created (the cluster,
identities, keys, the releases) is removed. `--all` removes the data too,
without those questions; it still shows the plan and asks for one final
confirmation unless `--yes` is also given.

## Security

- **No standing secrets on disk:** the config holds names; database
  passwords are generated in the cluster by the charts; tokens go straight
  from the console's API to the git host's secret store.
- **Your own credentials:** OpenTofu, the cloud CLIs, `gh` and `kubectl`
  run as you; the CLI holds no credentials of its own and creates none
  beyond what the approval screen lists.
- **Least privilege in what it creates:** each identity gets only its own
  job (registry pull, one bucket, one vault, signing).
- **Verified tools:** pinned versions and checksums; released CLI binaries
  are signed like the images.
- **Verified charts:** every chart is checked before Helm installs it. The
  third-party ones (metrics-server, cert-manager, External Secrets,
  policy-controller, the Cluster Autoscaler) are pinned by their package's
  SHA-256 (`internal/tools/pins.go`) and installed from the checked file,
  never the repository. A release's own are checked against the SHA-256s
  its release recorded (`internal/install/release-charts.sha256`, which the
  release workflow adds to each release's vertra, with any earlier
  release's missing, and to main). The package is kept in
  `deploy/<env>/charts/<version>/`, checked again on each apply, and the
  chart unpacked afresh from it, so an edit there is never installed; a
  release the running vertra doesn't know (a newer one) is refused before
  the approval screen. kind's local registry runs `registry` by digest.
- **The OpenTofu state** can contain resource details: it stays next to the
  config, gitignored, or in a remote backend you control.

## Project layout

```
cli/
  DESIGN.md
  go.mod
  cmd/vertra/          main: commands and flags
  internal/
    config/                the config file: load, validate, defaults, migrate
    prompt/                interactive questions; non-interactive answers
    tools/                 requirements, version checks, pinned downloads and checksums
    run/                   running external commands
    cluster/               kind and its registry; cluster access and readiness
    install/               platform images, values composition, helm install
    platform/              status, sleep and wake
    plan/                  plan assembly and the approval screen
    tofu/                  running OpenTofu: init, plan, apply, outputs
    modules/{gcp,aws,azure}/   the OpenTofu modules (embedded)
    githost/               the interface; github/, later gitlab/
    pricing/{gcp,aws,azure}/   live price lookups and the cost model
    catalog/               repository creation from the embedded template
```

Tests: unit tests per package (prompts, config, values composition, the
cost model against recorded price responses), golden files for the approval
screen, `tofu validate` and plan tests for each module, and a kind (local)
end-to-end run in CI (init, apply, sleep, wake, destroy). Cloud end-to-end
runs are manual, on a real account, before a target is called supported.
Releases build the binary for macOS and Linux (no Windows) on amd64 and
arm64, signed, attached to the GitHub release, and a Homebrew formula.

## Build order

1. **kind (local) and existing, end to end:** init, check, apply (no cloud
   side), status, sleep, wake, destroy; `make quickstart` becomes a wrapper.
2. **Chart features:** size presets, the sleeper, the idle scanner,
   headroom, PodDisruptionBudgets, the `auto` size's autoscalers (and
   metrics-server on kind).
3. **gcp:** the module (auto and standard), pricing, apply and destroy;
   proven on a real project.
4. **catalog on GitHub:** repository, starters, secrets and variables,
   federation, SSO handling, the smoke test.
5. **aws:** the module, pricing; proven on a real account (with the AWS
   sample).
6. **azure:** the kernel's step Pod labels (for Workload Identity), the
   module, pricing; proven (with the Azure sample). *Deferred
   (2026-10-19).*
7. **GitLab** as a second git host. *Deferred (2026-10-19).*
8. **Releases:** signed binaries and the Homebrew formula.

Steps 1–5 are done. On 2026-10-19 Azure and GitLab were set aside to work
on the platform and its user experience first
([`docs/assessment.md`](../docs/assessment.md)): pull-based catalog
registration changes what `vertra catalog create` does, so it comes before
the CLI is called finished.

The catalog tool moved here too (decided 2026-10-20; ported the same day),
first as a second binary, `catalogctl`; since 2026-10-21 it's part of
`vertra` itself, one command line for everything: `vertra catalog ...`
(`cmd/vertra/catalog_commands.go`, `internal/catalogtool`), which each
catalog's `./vertra` wrapper downloads (pinned, checksum-verified). Its commands stay the same. It embeds the schemas it checks
`product.yaml` and `team.yaml` against, so a catalog's pull request can't
loosen them. Until a release is pinned in the wrapper, `VERTRA_BIN`
names a binary built from a checkout (`.github/scripts/build-vertra.sh`).

## Open questions

- **The sizes' figures** once measured (step caps, default step sizes,
  volumes), and GKE Autopilot's per-Pod minimums.
- **Pricing details** to confirm while building each cloud: the SKUs for
  EKS Auto Mode and AKS Automatic (GCP's are settled, under the approval
  screen above).
- **aws, as built (2026-10-18):** EKS Auto Mode only (standard node groups
  need the Cluster Autoscaler; next). Nodes sit in public subnets with no
  NAT gateway (about $32 a month saved); steps run on an `vertra-steps`
  node pool vertra adds (Spot, falling back to on-demand), the
  platform on Auto Mode's own; a default gp3 StorageClass is added since
  Auto Mode ships none. ECR creates each product's repository on its
  first push (a repository creation template), so `destroy` deletes them
  by prefix. Credentials: the AWS CLI profile (`aws login` works, read by
  OpenTofu directly); the console reads ECR with its own role through EKS
  Pod Identity (`registryCheck.ecrToken`). Prices: the cluster fee (no free
  tier), Auto Mode's per-instance fee, EC2, gp3, public IPv4 and Spot,
  estimated on the instance Auto Mode would likely pick. An organization's
  region restriction (an SCP) is caught up front. The sleeper suspends its
  own CronJob while asleep, since on Auto Mode each run would start a node.
  The public console (an ACM certificate needs DNS you control, so no
  nip.io) and with it the catalog step on aws come next.
- **gcp, still to do:** signing (a Cloud KMS key) and catalog CI's
  federation come with the catalog step; Cloud SQL (managed database);
  account prices (all three since done); private nodes with Cloud NAT. Standard mode is zonal
  (one platform node, inside GKE's free tier), Autopilot regional.

Decided 2026-10-18: sizes `minimal`, `resilient`, `scaled` and `auto`; a managed database is an option for every size (else the
in-cluster Postgres with backups to a bucket); macOS and Linux only;
`destroy` asks about data unless `--all`.
