# Onboarding: from installing Vennir to your first deploy

Start here if you're setting Vennir up for your company or your team. This is the whole path, in order: install Vennir, make the catalog, bring in a team, ship and run a first product, then get a cloud ready so products can create real resources in it. Each phase says who does it, what to run or click, and how you know it worked. The details live in the guides it links to; you don't need to read them first.

## Who does what

| Role | Who it usually is | Does |
| --- | --- | --- |
| **Vennir admin** | Whoever runs the platform | Installs and upgrades it with `vennir`, creates accounts, adds a new team's first member, approves cloud access on the install's side |
| **Catalog admin** | The same people, usually | Owns the catalog repository: approves new teams, CI and workflow changes, and SecretStore files |
| **Team maintainer** | A lead in each team | Adds teammates and bots, adds the team's secrets, submits raw DAGs, approves steps that wait for approval |
| **Team member** | Everyone else in a team | Runs templates and actions from the **Catalog**, follows their runs |
| **Cloud account owner** | Whoever administers your Google Cloud or AWS | Grants each product's identity what it needs in the projects or accounts it changes |

One person can hold every role on a trial. In production, keep the cloud grants with the cloud account's owners: Vennir never grants itself anything in your clouds beyond what `vennir apply` shows on its approval screen.

## The path at a glance

1. **Choose where Vennir runs**: your laptop (kind), Google Cloud, AWS, or a cluster you have. Admin.
2. **Get `vennir`**, the installer. Admin.
3. **Install the platform**: `vennir init`, then `vennir apply`. Admin.
4. **Make the catalog**: `vennir catalog create`. Admin.
5. **Bring in a team**: a pull request in the catalog, and its first member. Team lead and catalog admin.
6. **Ship and run a first product**, from the console, the API or a pipeline. Team.
7. **Get a cloud ready for products**: each product's own identity, granted only what it does. Team and cloud account owner.
8. **Deploy a real resource**, check what it made, and delete it again. Team.

Optional, any time after phase 4: publish APIs through the gateway ([the API gateway](21-api-gateway.md)), sync secrets from your vault ([GCP Secret Manager](02-sync-secrets-gcp.md)), automate with bots ([bots and automation](14-bots-and-automation.md)).

## Phase 1: Choose where Vennir runs

| Where | Pick it for | What it can deploy to |
| --- | --- | --- |
| **kind** (your laptop) | Trying Vennir, writing and testing products. Free | Nothing in a cloud without a stored key: its products use the samples that call no cloud |
| **gcp** (GKE) | Teams that deploy to Google Cloud | Google Cloud with no keys (each product its own identity); AWS through federation |
| **aws** (EKS) | Teams that deploy to AWS | AWS with no keys (each product its own role); Google Cloud through federation (no sample yet) |
| **existing** | A cluster you already run | Whatever that cluster's identity setup allows |

The install's cloud matters most for keyless access: a product reaches the cloud it runs on through that cloud's own workload identity, and another cloud only through federation. [Where to host Vennir](18-where-to-host.md) compares them in full, including addresses, cost and what's not built yet.

**You're done when** you know your target, and for a cloud, which project (Google Cloud) or account and region (AWS) Vennir gets. Use one of its own.

## Phase 2: Get `vennir`

Download the release for your machine from GitHub, check it against the release's checksums, and put it on your `PATH`. On a Mac with Apple silicon (`darwin-arm64`; the others are `darwin-amd64`, `linux-amd64` and `linux-arm64`):

```bash
V=0.14.0 P=darwin-arm64
curl -fsSLO "https://github.com/roburns/vennir/releases/download/v$V/vennir-$P"
curl -fsSLO "https://github.com/roburns/vennir/releases/download/v$V/vennir-checksums.txt"
grep " vennir-$P\$" vennir-checksums.txt | shasum -a 256 -c -    # must say OK
chmod +x "vennir-$P" && sudo mv "vennir-$P" /usr/local/bin/vennir
vennir version
```

Then `vennir tools --target gcp --install` (or `aws`, `kind`, `existing`) downloads the other tools it drives (kubectl, Helm, OpenTofu, kind), each pinned and checksum-verified. Docker and the cloud's own CLI (gcloud, aws) are yours to install, and Docker must be running.

**You're done when** `vennir version` prints the version you downloaded and `vennir tools --target <target>` lists no missing tool. (`vennir check` needs an environment: run it after `vennir init`.)

## Phase 3: Install the platform

First, the account (skip for kind):

- **Google Cloud**: a project with billing, and both gcloud sign-ins ([Get Google Cloud ready](clouds-gcp.md)).
- **AWS**: an account that isn't root, a budget, and `aws login` ([Get AWS ready](clouds-aws.md)).
- **GitHub**, for the catalog: `gh auth login --scopes repo,workflow` ([Get GitHub ready](clouds-github.md)).

Then answer the questions and apply. `init` asks one question at a time and writes the answers to `deploy/<env>/vennir.yaml`; `apply` shows exactly what it will create and what it costs a month, and changes nothing until you approve.

```bash
vennir init prod --target gcp --project my-vennir-project    # or --target aws, kind, existing
vennir apply prod
```

Say yes to **The API gateway** if any team will publish APIs, and to **External Secrets Operator** if teams will sync secrets from a vault. Both can be turned on later (`vennir config set -e prod gateway.enabled true`, then `vennir apply prod`). Every question is explained in [Set up Vennir](setup.md).

A first cloud install takes ten to twenty minutes. With a hostname of yours, `apply` tells you the one DNS record to add, and waits for it.

**Sign in.** The first admin's password is in `deploy/prod/admin-password`, readable only by you. Open the console at its address (private consoles: `vennir console prod`, then http://localhost:18080), sign in with it, and choose your own. Nothing else opens until you do.

**Invite people.** **Admin → People → Add a person** creates an account with a temporary password, changed at first sign-in. With Google Workspace, `vennir sso google prod` sets up single sign-on.

**Your kubectl context.** `apply` adds the cluster to your kubeconfig (on GKE, `gke_<project>_<region>_<cluster>`) but doesn't switch to it. The guides' `kubectl` commands, such as reading the cluster's token issuer for AWS, run against whatever context is current: `kubectl config use-context` it first, or a role made from another cluster's issuer trusts the wrong cluster.

**You're done when** `vennir status prod` says the platform is running, and you're signed in with your own password.

## Phase 4: Make the catalog

The catalog is a GitHub repository holding every team's products, templates and APIs. Its CI builds, tests, scans and signs them, and publishes a signed release that every install reads on its own. CI holds no console or cluster credential.

```bash
vennir catalog create prod
```

It creates the repository (private by default) from the template that matches your release, with a first team (`platform`, or `--catalog-team`) and starter products in the languages you chose, sets its CI variables and cloud federation, and runs a starter end to end as a smoke test.

Then, once, in the repository on GitHub:

1. **Name the catalog admins.** In `.github/CODEOWNERS`, replace `@your-org/catalog-admins` with the people or GitHub team who approve CI, templates and new teams.
2. **Protect `main`.** A ruleset requiring a code owner's review and the checks `check`, `secrets`, `code` and `codeowners` (the catalog guide's [Protecting main](catalog-guide.md#protecting-main)). Without it, a failing check doesn't stop a merge.

**You're done when** the console's **Admin → Catalog** shows the catalog's release applied, with no problems, and **Catalog → Every product** lists the starters.

## Phase 5: Bring in a team

A team is one folder in the catalog, one team in the console and one namespace in the cluster, all with the same name. The team lead:

1. Copies `templates/team/team.yaml` to `teams/<team>/team.yaml` and fills in the lines marked `CHANGE` (the `name` must be the folder's).
2. Adds `/teams/<team>/ @<org>/<github-team>` to `.github/CODEOWNERS`, so the team approves its own products from then on.
3. Opens a pull request. A catalog admin approves it (it changes `.github/`), and it's merged.

Within a few minutes every install applies the release: the team and its namespace appear. A new team starts empty, so a **Vennir admin** adds its first member as a maintainer (the team's page → **Members**). From then on its maintainers add their teammates, as members or maintainers ([Teams and roles](13-teams-and-roles.md)).

**You're done when** the team's page opens, and lists you as a maintainer.

## Phase 6: Ship and run a first product

[Try Vennir end to end](01-getting-started.md) walks a team through it with samples that need no cloud: a product shipped by pull request, run, given a secret, and chained to a second. In short:

1. Copy `templates/hello/` to `teams/<team>/products/hello/`, change its `CHANGE` lines, and open a pull request. CI checks, builds, tests and scans it; after merge it's published and signed, and every install registers it.
2. Run it, whichever way suits you:

| How | Who | Where |
| --- | --- | --- |
| **The Catalog**: pick the action or template, fill in its form, **Run** | Any member it's shared with | [Finding and running things from the catalog](10-ordering-and-the-cart.md) |
| **A DAG**: paste YAML or JSON in **Runs → Submit a DAG** | A maintainer of every team it names | [What's a DAG?](03-what-is-a-dag.md) |
| **The API**: a bot's token and `curl`, from a script or pipeline | A bot of the team | [Call the API from a pipeline](05-calling-the-api.md) |
| **CI with no stored token**: GitHub Actions signs in with its own OIDC token | A keyless bot | [Bots and automation](14-bots-and-automation.md#how-do-i-sign-in-from-ci-without-a-stored-token) |

From a terminal, `vennir logs prod --execution <id>` prints a run's step logs while its Pods are there, about a minute after a step ends, or for good with `logs.enabled`; everything else about a run is on its page in the console.

**You're done when** the run's page says **Succeeded** and shows the output you expected.

## Phase 7: Get a cloud ready for products

A product that creates cloud resources runs as an identity of its own (the `serviceAccount` in its `product.yaml`), and the cloud trusts that identity directly. There's no key to store or rotate. What you grant it decides what it may do, so grant each product only what its actions do, and never anything to `default` (every unreviewed image runs as it).

The steps differ by cloud:

- **Google Cloud**: [Deploy to Google Cloud](19-deploy-to-gcp.md). Enable the APIs, grant each product's principal its roles on the projects, folders and billing account it uses, register the team secrets it reads.
- **AWS**: [Deploy to AWS](20-deploy-to-aws.md). One IAM role per product, trusted for that product's ServiceAccount through EKS Pod Identity (or by federation from another cluster), with only the actions it calls.

The quickest start is the catalog's cloud samples (`samples/gcp`, `samples/aws`): copy one into your team's folder and follow its guide. If a target only lets in known addresses (a database's authorized networks, a partner's firewall), read [Addresses and firewall rules](22-addresses-and-firewalls.md) first: by default steps don't leave from a fixed address.

**You're done when** each product shows **Ready** in **Catalog → Every product** (its readiness check asked the cloud, as itself, whether it may do its job).

## Phase 8: Deploy a real resource

1. Run the product's `create` action (or a template chaining several) from the **Catalog**, with the project, account or region you granted it.
2. Open the run when it finishes: **What this run made** lists what it created, and so does **Runs → What runs made**.
3. Delete it from either: **Delete** runs the product's own `cleanup` action, which deletes only what Vennir made for your team (it checks the `vennir-made` and `vennir-team` labels or tags first).

**You're done when** the resource exists in your cloud, and is gone again after **Delete**.

## A checklist

- [ ] `vennir version` and `vennir check` are clean.
- [ ] `vennir apply` finished, and you've changed the first admin's password.
- [ ] The catalog exists, `main` is protected, and CODEOWNERS names your catalog admins.
- [ ] Each team has its folder, its CODEOWNERS line and a maintainer.
- [ ] A first product ran, from the console and from a bot.
- [ ] Each cloud product has its own identity, granted only what it does, and shows **Ready**.
- [ ] A real resource was made, found in **Runs → What runs made**, and deleted.

## When something doesn't go as written

| What you see | Where to look |
| --- | --- |
| `vennir init` or `apply` stops with a cloud error | [Get Google Cloud ready](clouds-gcp.md), [Get AWS ready](clouds-aws.md): organization policies, regions, quotas |
| The console can't be reached | `vennir status prod`; a private console needs `vennir console prod` running |
| The catalog's release isn't applied | **Admin → Catalog**: what the install couldn't apply, and why |
| A team folder merged, but the team isn't there | The same card: a name that clashes with a team made by hand needs an admin to adopt it |
| A run is refused, or a step fails | [Troubleshooting](15-troubleshooting.md), and every failure code in [Runs, explained](09-runs-explained.md#what-does-each-failure-code-mean) |
| A product isn't **Ready** | Its check names the missing grant: [Deploy to Google Cloud](19-deploy-to-gcp.md#troubleshooting), [Deploy to AWS](20-deploy-to-aws.md#troubleshooting) |
