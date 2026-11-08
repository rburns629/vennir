# Setting up Vennir

From an empty account to people running steps, with `vennir`, the installer.
[Onboarding](../console/docs/17-onboarding.md) is the whole path in order,
from getting `vennir` to a first resource deployed to your cloud, and
[Where to host Vennir](../console/docs/18-where-to-host.md) compares the
targets.
It asks what it needs, shows what it will create and what that costs, and
changes nothing until you approve. Every answer is kept in
`deploy/<env>/vennir.yaml`, so `vennir apply` again makes the install match it,
and `vennir config set` changes one thing.

## Before you start

- **Where it runs.** Your laptop (`kind`, free), Google Cloud (`gcp`), AWS
  (`aws`), Azure (`azure`), or a Kubernetes cluster you already have
  (`existing`). For a cloud, get the account ready first: [Google
  Cloud](clouds/gcp.md), [AWS](clouds/aws.md), [Azure](clouds/azure.md). For
  the catalog, [GitHub](clouds/github.md).
- **The tools.** `vennir tools --install` downloads what's missing (kubectl,
  helm, OpenTofu, kind, kubelogin), each pinned and checksum-verified. Docker
  and your cloud's CLI are yours to install.

## 1. `vennir init <env>`

It asks, in order, with what each choice costs or gives up:

| Question | What it decides |
| --- | --- |
| Where | kind, gcp, aws, azure or existing; the project, subscription, region or kubectl context |
| Size | how many copies of each part, and the step caps (`minimal` to `scaled`, or `auto`) |
| Sleep when idle | scale to zero after a quiet spell (data kept); `vennir wake` brings it back |
| Database | gcp, aws: in-cluster Postgres (backed up to a bucket), or managed: Cloud SQL or Amazon RDS, no passwords of Vennir's, the cloud's backups, a standby in a second zone if chosen ([Databases](operations.md#databases)) |
| First admin | their email; the password is generated, and the first apply saves it to `deploy/<env>/admin-password`, readable only by you |
| The console | private (`vennir console` port-forwards to it) or reached over HTTPS at a hostname |
| The catalog | a GitHub repository for your teams' products, made for you |
| Log search | keep steps' logs for search in Observe (archived to a bucket after 30 days on a cloud) |
| The audit copy | gcp, aws: copy the audit log to a bucket that refuses deletes; locking it is a separate, permanent choice |
| The API gateway | serve the catalog's API products |
| External Secrets Operator | sync teams' secrets from their vaults (GCP Secret Manager, AWS Secrets Manager and others): a catalog's SecretStores need it |
| Monitoring | Prometheus for alerts: the cluster's Prometheus Operator (kind, existing), GKE's managed Prometheus (gcp, a few dollars a month), Amazon Managed Prometheus with alerts emailed (aws, a few dollars a month), or one of its own (a Pod and a 2 GiB volume) ([Metrics and alerts](operations.md#metrics-and-alerts)) |

**A public console**, by target:

- **gcp**: a reserved address and a Google-managed certificate, on a free
  `nip.io` name or a hostname of yours.
- **aws**: a Route 53 zone vennir creates (e.g. `vennir.example.com`), which you
  delegate once with its NS records; the certificate and record are made for
  you.
- **existing**: your Ingress controller and a certificate from cert-manager
  (Let's Encrypt, or a ClusterIssuer of yours); vennir installs cert-manager if
  the cluster hasn't got it.

## 2. `vennir apply <env>`

It shows the plan: what it creates in your account, what it builds and
installs, and the estimated monthly cost. Nothing happens until you approve.
A first cloud install takes about ten to twenty minutes.

**DNS.** With a hostname of yours, apply says exactly which record to add
where your domain is managed, and waits for it:

```
Add this DNS record where example.com is managed:
  A     vennir.example.com → 34.57.221.133   (TTL 300)
```

Many DNS providers add the domain themselves: then the record's name is just
`vennir`. The certificate is issued once the name resolves; `vennir status`
shows both.

**The admin's password** is in `deploy/<env>/admin-password`, readable only
by you: the first apply generates it and gives it to the console without
printing or logging it anywhere. Sign in with it and choose your own: nothing else opens until you do. If it's lost,
`vennir admin reset-password <env>` makes a new one, which then has to be
changed at the next sign-in.

## 3. Sign in, and invite people

Sign in at the console's address (or `vennir console <env>`, then
http://localhost:18080). On the Admin page, create accounts: each gets a
temporary password to change at their first sign-in, and starts in the teams
you choose.

**Signing in with Google** (Workspace accounts): `vennir sso google <env>`. It
says which two pages of the Google Cloud console to open and what to paste
there, then reads the file you download. `vennir apply` turns it on. Passwords
keep working; on a team's page, an admin can then require Google sign-in for
that team's members (admins can always use their password, in case Google
can't be reached). `vennir sso off` turns it off again.

## 4. The catalog

`vennir catalog create <env>` makes your catalog repository: its CI builds,
scans and signs your teams' products and releases them to every install that
reads the catalog. Run it with the `vennir` release your install runs: its
catalog template is that release's, and the catalog's `./vennir` is pinned
to it. It signs in to the console with the password `apply` saved, and has
you choose your own first (`VENNIR_NEW_ADMIN_PASSWORD` without a terminal). The [catalog's own guide](../catalog-template/README.md)
covers adding teams and products.

## Day to day

| Command | What it does |
| --- | --- |
| `vennir status <env>` | what's installed, awake or asleep; a public console's address and certificate |
| `vennir console <env>` | reach the console from your machine |
| `vennir backup <env>` / `vennir backups <env>` | back up the databases now (`--to <folder>`: here); list the backups |
| `vennir restore <env> <time>` | replace the databases with a backup (`--from <folder>`); asks first |
| `vennir logs <env> [component] [-f]` | the platform's logs; `--execution <id>` for a run's steps |
| `vennir sleep` / `vennir wake <env>` | scale to zero and back (data kept) |
| `vennir config set -e <env> <key> <value>` | change a setting, then `vennir apply` |
| `vennir apply <env>` | upgrade, or make the install match the settings again |
| `vennir destroy <env>` | remove it; asks about data |
| `vennir help settings` / `vennir help sizes` | every setting, and what each size gets |
| `vennir man ~/.local/share/man` | write the man pages (`man vennir`); each release also attaches them, `vennir-man.tar.gz` |

**What `destroy` keeps.** Unless you choose to delete data: the database's
disk, the backups and logs buckets, and the task registry. The audit copy's
bucket is always kept: it's the record, and its retention refuses deletion
until it lapses. A local registry another kind cluster still uses is kept too.
On an existing cluster, it offers to delete only the team namespaces the
console made, naming them, never one labelled `vennir/team` by hand; and
to uninstall only the add-ons (policy-controller, External Secrets
Operator, cert-manager) vennir installed there, asking about each, even
with `--all`.

**With the gateway on GKE's load balancer** (`gateway.ingress.gke`),
delete its Ingress and its certificate before `destroy`, so GKE's Ingress
controller removes what it made while the cluster is still there:

```bash
kubectl --context gke_<project>_<region>_<cluster> -n vennir-system delete ingress console-execution-console-gateway
kubectl --context gke_<project>_<region>_<cluster> -n vennir-system delete managedcertificate console-execution-console-gateway
gcloud compute network-endpoint-groups list --project <project>   # until it's empty, a few minutes
```

Then `destroy` goes through (proven on GKE Autopilot, 2026-11-07: the
forwarding rule, backend services and every endpoint group gone within ten
minutes, the certificate within a minute of deleting its object). If the cluster went
first, `destroy` can stop at the network: GKE's Ingress controller leaves its
network endpoint groups (`k8s1-…`, one per zone) and the certificate
(`mcrt-…`) behind. Delete those
(`gcloud compute network-endpoint-groups delete <name> --zone <zone>`,
`gcloud compute ssl-certificates delete <name> --global`), then delete
the network with OpenTofu in `deploy/<env>/tofu`
(`tofu destroy -target=google_compute_network.this`): running `destroy`
again fails instead, and remakes the backups bucket on its way. The
reserved address isn't vennir's: delete it yourself
(`gcloud compute addresses delete <name> --global`).

**Installing again for the same catalog** (after `destroy`, or a second
environment the catalog moves to): the new install makes a new identity
for catalog CI, and the repository's variables still name the old one, so
its CI can't publish (the console says the release's manifest is missing).
Run `vennir catalog create <env>` again: it sets them and leaves the
repository as it is. `vennir apply` says so at its end when they aren't
this install's.

**Upgrading.** The release an install runs is the `vennir` setting
(`vennir init --release <x.y.z>` chooses it; `source` builds your checkout
instead). To upgrade, `vennir config set -e <env> vennir <x.y.z>`, then
`vennir apply <env>`. Back up first: going back across a database
migration means restoring the databases, not just applying the older
release ([Rolling back](operations.md#rolling-back)).

## Where to read more

- Teams' side, once it's installed: [Deploy to Google Cloud](../console/docs/19-deploy-to-gcp.md),
  [Deploy to AWS](../console/docs/20-deploy-to-aws.md), [the API gateway](../console/docs/21-api-gateway.md),
  [addresses and firewall rules](../console/docs/22-addresses-and-firewalls.md).
- [Operations](operations.md): what each feature does on each cloud,
  upgrades and rolling back, backups, monitoring, troubleshooting. Every
  chart setting, with its default, is documented in the charts'
  `values.yaml` (`helm/charts/execution-kernel/`,
  `helm/charts/execution-console/`).
- [Security model](security-model.md): what's enforced, and by which part.
