# Lab 4: Google Cloud projects from Vennir

**Goal:** let a product create Google Cloud projects under a folder of their own, deploy a Cloud Run service into the new project with grants inherited from that folder, and delete both through Vennir. **Time:** about an hour. **Cost:** billed, but small: an empty project costs nothing, and a Cloud Run service with no traffic next to nothing. **You need:** [Lab 3](lab-3-gke.md)'s install, and a Google Cloud **organization** (Google Workspace or Cloud Identity): projects a product makes go under a folder, which only an organization has. Its admin does steps 2 and 3.

The commands and the reasons behind them are in [Deploy to Google Cloud](19-deploy-to-gcp.md) and [Creating resources in every cloud](24-every-cloud-from-any-install.md#google-cloud).

## 1. Put the products in a team

In your catalog repository, on a branch: copy `samples/gcp/products/project` and `samples/gcp/products/app-hosting` to `teams/web/products/`, add `teams/web/team.yaml` (from `templates/team/`, `name: web`, with `clouds: [gcp]`), set `team: web` and `owner` in both `product.yaml`s, and name their ServiceAccounts `web-project` and `web-app-hosting`. Add `/teams/web/ @<you>` to `.github/CODEOWNERS`, open a pull request, and merge it once CI passes. Add yourself to `web` in the console.

**Check:** both products are listed, **Not ready**: nothing is granted yet.

## 2. A folder, and who may create projects in it

As the organization's admin (**Folder Creator** on the organization, and **Billing Account Administrator** on the billing account):

```bash
PROJECT=<the install's project>; NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
member() { echo "principal://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/$PROJECT.svc.id.goog/subject/ns/web/sa/$1"; }
FOLDER=$(gcloud resource-manager folders create --display-name vennir-web --organization <org id> --format='value(name)' | cut -d/ -f2)
BILLING=<billing account id>

for ROLE in roles/browser roles/resourcemanager.projectCreator roles/resourcemanager.projectDeleter; do
  gcloud resource-manager folders add-iam-policy-binding $FOLDER --role $ROLE --member "$(member web-project)"
done
gcloud billing accounts add-iam-policy-binding $BILLING --role roles/billing.user --member "$(member web-project)"
```

`project` gets nothing on the organization itself: only this folder, and linking this billing account.

## 3. Grants every project in the folder inherits

`app-hosting` will deploy into projects that don't exist yet. A grant on the folder reaches every project made under it:

```bash
gcloud resource-manager folders add-iam-policy-binding $FOLDER --role roles/run.developer --member "$(member web-app-hosting)"
```

**Check:** in the console, **Catalog → Every product → project → Check now** says **Ready** (it found the folder and billing account it may use). `app-hosting` stays **Not ready** until its team secret exists (step 5).

## 4. Create a project

**Catalog → project.create → Run**, for `web`, with a new `projectId` (6 to 30 characters, lowercase, globally unique), `parent: folders/<FOLDER>` and `billingAccountId: <BILLING>`.

**Check:** the step succeeds, and `gcloud projects describe <projectId>` shows it under the folder with the labels `vennir-made=true` and `vennir-team=web`. **Runs → What runs made** lists it.

A new project starts with only Google's default APIs on, and the samples don't turn more on. Turn on Cloud Run in it:

```bash
gcloud services enable run.googleapis.com iam.googleapis.com --project <projectId>
```

## 5. What deployed services run as, and from where

`app-hosting` deploys only images under a registry your team chose, as a service account your team chose. Make the account in the new project, with no roles of its own, and let `app-hosting` act as it alone:

```bash
gcloud iam service-accounts create web-services --project <projectId>
gcloud iam service-accounts add-iam-policy-binding web-services@<projectId>.iam.gserviceaccount.com \
  --project <projectId> --role roles/iam.serviceAccountUser --member "$(member web-app-hosting)"
```

Then, as a maintainer: **Teams → web → Secrets → Add a secret → Paste it here**, named `app-hosting`, with `image-registry` = `us-docker.pkg.dev/cloudrun/container` (Google's public sample images) and `runtime-service-account` = `web-services@<projectId>.iam.gserviceaccount.com`.

## 6. Deploy into the project you made

**Catalog → app-hosting.create → Run**, for `web`: `projectId` the new project, `serviceName: hello`, `region: us-east1`, `image: us-docker.pkg.dev/cloudrun/container/hello`.

**Check:** the step outputs the service's URL. `run.developer` came from the folder: nobody granted anything in this project to `app-hosting`. The service refuses anyone unsigned, which is the point: [Lab 7](lab-7-apis-across-clouds.md) puts such a service behind the gateway.

## 7. Delete through Vennir

**Runs → What runs made**: **Delete** the Cloud Run service, then the project. Each runs its product's own `delete`, which refuses anything without both labels matching `web` (`NOT_MADE_BY_VENNIR`, `NOT_THIS_TEAMS`), so a project that was only found, or another team's, is never deleted.

**Check:** the project is **shut down** (restorable for 30 days), and the service gone.

## Clean up

Delete the folder once its projects are gone (`gcloud resource-manager folders delete $FOLDER`, after the 30 days, or restore and delete them), and remove the grants on the billing account. Keep the install for the next labs.

## What you proved

A product creating projects with no organization-wide role, a folder's grants reaching projects made later, a deploying product limited to the registry and runtime account its team chose, and deletes that touch only what the team made. The samples' parts were proven on GKE (2026-10-25).

**Next:** [Lab 5: AWS from a GKE install](lab-5-aws-from-gke.md).
