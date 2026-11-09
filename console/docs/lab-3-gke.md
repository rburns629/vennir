# Lab 3: Vennir on GKE, with a catalog

**Goal:** install a released Vennir on GKE Autopilot at the smallest size, give it a catalog repository on GitHub whose CI publishes to it, and see a starter product run. Labs 4 to 7 use this install. **Time:** about an hour, mostly waiting. **Cost:** billed: about $26 a month while awake at the `minimal` size (about $0.04 an hour), with the cluster fee covered by GKE's free tier credit for one cluster per billing account; `vennir apply` shows the estimate from your own prices before it creates anything. Delete it when you're done.

**You need:**

- A Google Cloud project with billing, and you able to create things in it ([Getting Google Cloud ready](clouds-gcp.md)). Keep it for Vennir alone.
- [Your computer ready](clouds-computer.md), with `gcloud` signed in (`gcloud auth login` and `gcloud auth application-default login`).
- GitHub, with `gh` signed in with the `repo` and `workflow` scopes ([Getting GitHub ready](clouds-github.md)). The catalog repository is private, and a private repository's Actions run on your plan's minutes: a catalog's CI uses a few minutes a release.
- `vennir` from the latest release ([Phase 2 of onboarding](17-onboarding.md#phase-2-get-vennir)), and `vennir tools --install` for what's missing.

## 1. Answer the questions

```bash
vennir init lab --non-interactive --release <version> --target gcp --project <your project> \
  --region us-east1 --mode auto --cluster-name vennir-lab --size minimal \
  --scale-down false --min-replicas 1 --step-headroom 0 --database in-cluster \
  --admin-email <you@example.com> --console private --gateway true --external-secrets true \
  --logs false --monitoring false --audit-export false \
  --catalog-owner <your GitHub account> --catalog-repo vennir-lab-catalog --catalog-visibility private \
  --catalog-team platform --languages python --signing none
vennir config set -e lab database.backups.enabled false
```

Without `--non-interactive`, `vennir init lab` asks each of these, saying what each choice costs or gives up. Everything goes in `deploy/lab/vennir.yaml`: names only, never a secret.

**Check:** `vennir init` says which account it signed in as and that the project has nothing else in it.

## 2. Read the bill, then approve

```bash
vennir apply lab --plan-only     # the approval screen, and nothing else
vennir apply lab                 # the same screen, then it asks
```

The screen lists what it will create in the project (the cluster, network, registry, service accounts and their permissions, the APIs it turns on, the identity pool) and in the cluster, and the estimated monthly cost from your billing account's prices. If it says the estimate is unavailable, Google's price API refused it for a moment: run `--plan-only` again.

A first install takes about fifteen minutes. **Check:** it ends with `Vennir is running.`

## 3. Sign in

```bash
vennir console lab               # port-forwards to http://localhost:18080
```

Sign in as your admin email with the password in `deploy/lab/admin-password` (readable only by you), and choose your own. Then delete that file.

## 4. Make the catalog

```bash
VENNIR_ADMIN_PASSWORD='<the password you chose>' vennir catalog create lab
```

It creates the private repository from the catalog template with your first team and its starters, sets its variables (the registry it publishes to, and the identity its CI signs in to Google Cloud as, by federation, with no key), pushes `main`, waits for CI, has the console apply the release, and runs the `title-case` starter as a smoke test. With no password set yet, `VENNIR_NEW_ADMIN_PASSWORD` changes the generated one as it signs in.

**Check:** it ends with `The catalog works: a merge publishes and releases, the console applies it, and its products run.` In the console, **Catalog** lists the `platform` team's starter, and **Admin → Catalog** shows the release applied.

## 5. Change the catalog through a pull request

Clone the repository, copy a sample team in (`cp -R samples/local teams/local`, and a line `/teams/local/ @<you>` in `.github/CODEOWNERS`), and open a pull request. CI checks it (validate, build, test with no network, scan) and publishes nothing; merge it, and CI publishes the changed products and the release. The console checks for a new release every five minutes.

**Check:** the `local` team and its products appear in the console. Nothing in CI held a console or cluster credential: it pushed to the registry, and the console pulled.

## Clean up, when you're done with the labs

The gateway's load balancer goes first if [Lab 7](lab-7-apis-across-clouds.md) made one (that lab says how). Then:

```bash
vennir destroy lab --all         # everything it made, data included
```

The catalog repository stays on GitHub: delete it there if you don't want it (`gh repo delete <owner>/vennir-lab-catalog`).

## What you proved

A cloud install from a released, signed Vennir, priced before it was made; a catalog whose CI publishes with no stored credential; and a reviewed change reaching the install by pull, not push.

**Next:** [Lab 4: Google Cloud projects from Vennir](lab-4-gcp-projects.md).
