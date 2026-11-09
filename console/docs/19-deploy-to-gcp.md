# Deploy to Google Cloud from Vennir

This guide gets a team's products creating real resources in Google Cloud: projects, Cloud Run services, Cloud SQL instances, image builds. It's for the team that owns the products and whoever can grant IAM roles in the projects they'll change. It follows the catalog's `samples/gcp` products, which are tested on GKE; your own products work the same way.

No keys are made or stored. Each product runs as a Kubernetes ServiceAccount of its own (`serviceAccount` in its `product.yaml`), and on GKE, Google trusts that ServiceAccount directly as a principal (Workload Identity Federation for GKE). You grant that principal roles, and only that product's image can run as it. So `project` can create projects and nothing else, and `app-hosting` can deploy to Cloud Run and nothing else.

## Before you start

- **An install on GKE** (`vennir init --target gcp`). On EKS, AKS, an existing cluster or kind, read [From an install that isn't on GKE](#from-an-install-that-isnt-on-gke) first. How this fits with AWS and Azure: [Creating resources in every cloud](24-every-cloud-from-any-install.md).
- **Your team**, in the catalog and the console ([Onboarding](17-onboarding.md#phase-5-bring-in-a-team)). Below it's `web`.
- **gcloud**, signed in as someone who may grant roles where the products will work: the target project, and for `project`, a folder and a billing account.
- **Where resources go.** A *target* project for Cloud Run, Cloud SQL and builds, and for new projects, a folder to create them under and a billing account to link. Keep targets apart from the install's own project.

Set these once in your shell; every command below uses them:

```bash
PROJECT=my-vennir-project            # the GKE cluster's project (vennir status shows it)
NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
TEAM=web                             # your team: its namespace
TARGET=web-sandbox-1                 # where resources are made
REGION=us-central1
FOLDER=123456789012                  # for project: where new projects go
BILLING=0X0X0X-0X0X0X-0X0X0X         # for project: the billing account they're linked to
REPO=apps                            # an Artifact Registry repository in $TARGET, for images
SOURCES=web-sandbox-1-sources        # a bucket of source archives, for build-image
```

## 1. Copy the products into your team

On a branch of the catalog repository:

1. Copy the products you want from `samples/gcp/products/` to `teams/web/products/`.
2. In each `product.yaml`, change `team: gcp` to `team: web`, set `owner`, and give `serviceAccount` a name of your own (say `web-project`, `web-app-hosting`). Any name works except one ending in `-api`.
3. In `teams/web/team.yaml`, add `clouds: [gcp]` so these products are only run on GCP installs, and `allowedTargets` if other teams may run them (step 8).
4. Open a pull request. CI builds, tests and scans each product; after merge they're published, and every install registers them.

Once registered, the console creates each product's ServiceAccount in the `web` namespace. Until you grant it something, each product shows **Not ready**: that's expected.

## 2. Name each product's principal

Google names a GKE ServiceAccount by its project's Workload Identity pool, its namespace and its name:

```bash
member() { echo "principal://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/$PROJECT.svc.id.goog/subject/ns/$TEAM/sa/$1"; }
member web-project      # prints the principal you grant roles to
```

That principal is exactly one product, in one team, on one cluster. Another install's cluster is another principal, granted separately.

## 3. Turn on the APIs the products call

A project only answers for the Google APIs turned on in it. In the target project:

```bash
gcloud services enable --project $TARGET \
  cloudresourcemanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  sqladmin.googleapis.com storage.googleapis.com cloudbilling.googleapis.com
```

| API | Used by |
| --- | --- |
| Cloud Resource Manager, IAM | Every product's readiness check (`testIamPermissions`); `project` |
| IAM Credentials | Acting as another account: `gcp-target` (step 6), `app-hosting`'s runtime account |
| Cloud Billing | `project`, linking billing |
| Cloud Run Admin | `app-hosting` |
| Cloud Build, Artifact Registry, Cloud Storage | `build-image` |
| Cloud SQL Admin | `cloud-sql` |

A project that `project` creates starts with only Google's defaults turned on, so later steps that build or deploy into it fail with `SERVICE_DISABLED` until its APIs are on. Turn them on (the command above, with its id) before chaining a build or a deploy into a project made in the same run. If an error says an API is disabled in **the cluster's** project, turn it on there too: some calls are billed to the caller's project.

## 4. Grant each product only what it does

Run what applies to the products you copied. Each line says what it lets the product do.

```bash
# project: look projects up and create them under the folder, link billing,
# and delete the projects it made (only those: its delete checks their labels).
gcloud resource-manager folders add-iam-policy-binding $FOLDER --role roles/browser --member "$(member web-project)"
gcloud resource-manager folders add-iam-policy-binding $FOLDER --role roles/resourcemanager.projectCreator --member "$(member web-project)"
gcloud resource-manager folders add-iam-policy-binding $FOLDER --role roles/resourcemanager.projectDeleter --member "$(member web-project)"
gcloud billing accounts add-iam-policy-binding $BILLING --role roles/billing.user --member "$(member web-project)"

# build-image: run Cloud Build, read the source bucket, look image tags up.
gcloud projects add-iam-policy-binding $TARGET --role roles/cloudbuild.builds.editor --member "$(member web-build-image)"
gcloud storage buckets add-iam-policy-binding gs://$SOURCES --role roles/storage.objectViewer --member "$(member web-build-image)"
gcloud artifacts repositories add-iam-policy-binding $REPO --project $TARGET --location $REGION \
  --role roles/artifactregistry.reader --member "$(member web-build-image)"

# app-hosting: Cloud Run services, from images it may read.
gcloud projects add-iam-policy-binding $TARGET --role roles/run.developer --member "$(member web-app-hosting)"
gcloud artifacts repositories add-iam-policy-binding $REPO --project $TARGET --location $REGION \
  --role roles/artifactregistry.reader --member "$(member web-app-hosting)"

# cloud-sql: Cloud SQL instances.
gcloud projects add-iam-policy-binding $TARGET --role roles/cloudsql.admin --member "$(member web-cloud-sql)"
```

Grant on the narrowest thing that works: a folder rather than the organization, one repository or bucket rather than a project. Never grant anything to `default` in a team namespace: every image that isn't a registered product runs as it.

### The organization side: projects Vennir creates

`project` needs no role on the organization itself, only on a folder and a billing account:

| Who | Does | With |
| --- | --- | --- |
| The organization's admin | Makes a folder for the projects Vennir creates (one per environment, or per team, keeps them apart) | **Folder Creator** on the organization: `gcloud resource-manager folders create --display-name vennir-web --organization <org id>` |
| The folder's admin | The three folder grants above (`roles/browser`, `projectCreator`, `projectDeleter`) | **Folder IAM Admin** (or Folder Admin) on it |
| The billing account's admin | `roles/billing.user` for `project` on the account new projects are linked to | **Billing Account Administrator** |

A grant on a folder is inherited by every project under it, including the ones `project` makes later. So instead of granting `app-hosting`, `build-image` and `cloud-sql` in each new project, grant their roles on the folder once (the same commands with `folders add-iam-policy-binding $FOLDER`), and they can work in every project made there. A new project starts with only Google's default APIs on, and the samples don't turn more on (step 3): turn on what later steps call before chaining a build or a deploy into a project made in the same run.

An organization policy can refuse a grant or a project (allowed locations, which members may be granted roles); the error names the constraint, and the organization's admins decide.

## 5. The account deployed services run as

A Cloud Run service runs as a Google service account. `app-hosting` deploys only as one your team chose, and only images from a registry your team chose, both named in a team secret. Make the account, with no roles of its own, and let `app-hosting` act as it alone (never the default compute account):

```bash
gcloud iam service-accounts create web-services --project $TARGET \
  --display-name "Services web deploys with Vennir"
RUNTIME=web-services@$TARGET.iam.gserviceaccount.com
gcloud iam service-accounts add-iam-policy-binding $RUNTIME --project $TARGET \
  --role roles/iam.serviceAccountUser --member "$(member web-app-hosting)"
```

Grant `$RUNTIME` only what the services need, such as `roles/cloudsql.client` for one using a `cloud-sql` instance. Anyone who may run `app-hosting`'s `create` runs code as it.

Then add the team secret, as a maintainer: your team's page → **Secrets → Add a secret** → **Paste it here**, named `app-hosting`, with two keys:

| Key | Value |
| --- | --- |
| `image-registry` | `us-central1-docker.pkg.dev/web-sandbox-1/apps`: every image `app-hosting` deploys must be under it (`IMAGE_OUTSIDE_REGISTRY` otherwise) |
| `runtime-service-account` | `web-services@web-sandbox-1.iam.gserviceaccount.com` |

The template or DAG lists it in `secretRefs: [app-hosting]` for that step.

## 6. Optional: act as an account in the target

Instead of granting each product's principal roles in every project, a team can keep one Google service account per target, and let its products act as it. Each product then uses its own identity only to mint that account's tokens:

```bash
gcloud iam service-accounts add-iam-policy-binding deployer@$TARGET.iam.gserviceaccount.com --project $TARGET \
  --role roles/iam.serviceAccountTokenCreator --member "$(member web-app-hosting)"
```

Add a team secret `gcp-target` whose key `service-account` is that account's email, and list it in each action that should act as it, and in the product's `check`:

```yaml
    secretRefs:
      - name: gcp-target
        keys: [service-account]
```

Leave it out when the product's own principal is the one to act as: an account impersonating itself fails, after a minute, with `PERMISSION_DENIED`.

## 7. Check it's ready

Each sample product has a readiness check, which asks Google, as the product, whether it may do its job (`testIamPermissions`), and changes nothing. The console runs it when the product is registered, daily, and on demand: **Catalog → Every product** → the product → **Check now**.

| Product | Ready when it may | If not, grant |
| --- | --- | --- |
| `project` | create, get and delete projects under a folder, and link a billing account | `roles/browser`, `roles/resourcemanager.projectCreator`, `roles/resourcemanager.projectDeleter` on the folder; `roles/billing.user` |
| `build-image` | create, get and list builds in a project | `roles/cloudbuild.builds.editor` |
| `app-hosting` | get, create and delete Cloud Run services, and act as the runtime account | `roles/run.developer`; `roles/iam.serviceAccountUser` on the account; the `app-hosting` secret |
| `cloud-sql` | get, create and delete Cloud SQL instances | `roles/cloudsql.admin` |

A check looks through the projects, folders and billing accounts its identity can see (up to 20) for one where it may act, so it says **Ready** as soon as one place is granted. Grants on a single bucket or repository are per run: only a `create` finds out.

## 8. Run it

From the **Catalog**, run the product's `create` action, or a template that chains several, and fill in its form. Or paste `samples/gcp/dags/gcp-hello-world-dag.yaml` into **Runs → Submit a DAG**, with your registry, team and project in it: it finds or creates a project, builds an image with Cloud Build and deploys it to Cloud Run.

- **Timeouts.** A step has five minutes unless its DAG says otherwise. Cloud Build needs `timeoutSeconds: 600`; a Cloud SQL instance 900 or more.
- **Other teams.** When another team runs your products, each input marked as a target (`projectId`, a `gcp.project`) must match a rule in your `team.yaml`'s `allowedTargets` for that team, or the run is refused before it starts. A rule can require one of your maintainers to approve first (`approval: true`). Your own team isn't limited.
- **Retries are safe.** Each `create` looks before it creates, so a step that's retried finds what the first attempt made.

## 9. Find and delete what it made

Each `create` labels what it makes `vennir-made=true` and `vennir-team=<the team it was made for>`, and reports it. **Runs → What runs made** lists it (so does the run's page, under **What this run made**), and **Delete** there runs the product's own `delete` action. A delete refuses anything without both labels matching the team (`NOT_MADE_BY_VENNIR`, `NOT_THIS_TEAMS`), so a project that was only found, never made, or another team's, is never deleted.

- A deleted project is shut down, and can be restored for 30 days.
- Deleting a Cloud SQL instance can outlast a step: the step succeeds with `finishing: true`, since Google finishes an accepted delete on its own.
- `build-image` has no cleanup: set a cleanup policy on the image repository.

## Writing your own Google Cloud product

Start from the sample closest to what you need, and keep what makes the samples safe:

- **An identity of its own:** its `serviceAccount`, granted only what its actions call. The Google client libraries pick it up through Application Default Credentials; there's nothing to configure.
- **A readiness check** that asks `testIamPermissions` for exactly the permissions its actions use, and names the role that grants each.
- **Look before you create**, so a retried step finds what it made instead of failing or making two.
- **Label what you make** with `vennir-made` and `vennir-team` (the request's `forTeam`), report it in `resources`, and give the product a `cleanup` action that deletes only what carries both.
- **Never return a credential** in `result.json`: a step's outputs are readable by anyone who can see the run.

The catalog guide has [every field](catalog-guide.md#productyaml) and [the container contract](catalog-guide.md#the-container-contract).

## From an install that isn't on GKE

**On EKS, AKS, or a cluster whose token issuer is public**: Google can trust the cluster's own tokens through a workload identity pool, in a project you choose (`$PROJECT` below, any project; it needn't hold a cluster). **The GCP samples don't sign in this way yet**: they rely on GKE's Workload Identity, so from another cluster they find no credentials. A product of your own can, as below; it hasn't been proven end to end, so treat it as a starting point:

```bash
ISSUER=$(kubectl --context <the install's> get --raw /.well-known/openid-configuration | jq -r .issuer)
# AKS: az aks show -g <group> -n <cluster> --query oidcIssuerProfile.issuerUrl -o tsv
gcloud iam workload-identity-pools create vennir-steps --location global --project $PROJECT
gcloud iam workload-identity-pools providers create-oidc vennir --location global \
  --workload-identity-pool vennir-steps --project $PROJECT \
  --issuer-uri "$ISSUER" --attribute-mapping "google.subject=assertion.sub" \
  --attribute-condition "assertion.sub.startsWith('system:serviceaccount:')"
# A product's principal is then its ServiceAccount's subject, granted roles as in step 4:
echo "principal://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/vennir-steps/subject/system:serviceaccount:${TEAM}:web-project"
```

One provider per install's cluster: another cluster is another issuer.

The product declares the provider as a token audience in its `product.yaml` (`tokenAudiences: [https://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/vennir-steps/providers/eks]`), so each of its steps gets a token for it at `/platform/tokens/<audience>` (characters other than letters, digits, `.`, `_` and `-` replaced with `_`). It then signs in with an *external account* credential file, which holds no secret: `gcloud iam workload-identity-pools create-cred-config` writes one, with `--credential-source-file` set to that token's path, and `GOOGLE_APPLICATION_CREDENTIALS` pointing at it. The API gateway already signs in to Google this way from other clusters ([the API gateway](21-api-gateway.md#a-cloud-run-service-googleidtoken)).

**On kind**: Google can't fetch the keys of kind's token issuer, so there's no keyless way in, and Vennir has no supported way to hand a product a stored key. Use kind for products that call no cloud, and a GKE install for Google Cloud.

## Troubleshooting

| You see | Why | Fix |
| --- | --- | --- |
| **Not ready**, naming a role | The product's principal lacks it | Grant it (step 4), then **Check now** |
| **Not ready**: no Workload Identity | The install isn't on GKE, or the product has no `serviceAccount` | Declare one in `product.yaml`; on another cluster, see above |
| `PERMISSION_DENIED` from Google | The grant is missing on the project, folder or account this run named (a check only needs one place) | Grant it where the run points, or run it where it's granted |
| `SERVICE_DISABLED`, or an API "has not been used in project" | The API isn't turned on in that project | Step 3, for the project the error names |
| `PROJECT_NOT_VISIBLE` | `project`'s delete can't see the project: deleted already, or no `roles/browser` | Grant `roles/browser` on its folder, or delete it outside Vennir |
| `IMAGE_OUTSIDE_REGISTRY` | The image isn't under the `app-hosting` secret's `image-registry` | Build into that registry, or change the secret |
| `NOT_MADE_BY_VENNIR`, `NOT_THIS_TEAMS` | The resource wasn't made by this team through Vennir (or before teams were labelled, 2026-11-03) | Delete it outside Vennir, or label it `vennir-team=<team>` if it's yours |
| `NOT_FOR_THIS_INSTALL` | The product's `clouds` names another cloud | Run it on a GCP install |
| `TASK_TIMEOUT` on a build or a database | The step's default five minutes ran out | Raise `timeoutSeconds` in the template or DAG |
| A target refuses connections from the cluster | It allows only known addresses | [Addresses and firewall rules](22-addresses-and-firewalls.md) |
