# gcp: real Google Cloud calls

Example products that call real Google Cloud APIs, to copy from when your
product has to. Running them costs money.

| Product | What `create` does |
|---|---|
| [`project`](products/project/) | Finds a project by id, or creates it under `parent` (a folder: a workload identity has no default), linking billing |
| [`build-image`](products/build-image/) | Builds an image with Cloud Build from a source archive in GCS (with a Dockerfile at its root), unless that image already exists |
| [`app-hosting`](products/app-hosting/) | Deploys an image from the team's registry to Cloud Run, as the team's runtime account, or returns the existing service's URL; optionally connects a Cloud SQL instance |
| [`cloud-sql`](products/cloud-sql/) | Finds a Cloud SQL instance by name, or creates it (several minutes; set `timeoutSeconds` to 900 or more, and delete it after) |

Every action looks before it creates, so a retried step is harmless.

## Deleting what they made

`project`, `app-hosting` and `cloud-sql` label what they create
`vertra-made=true` and `vertra-team=<the team it was made for>` (the
request's `forTeam`: the team the run is for, which for a shared product's
run is the consumer's, not this one's), and report it as `resources`, with
a `delete` action as their `cleanup`: Delete on the run page (or **What
runs made**) runs it. A delete refuses anything without the label
(`NOT_MADE_BY_VERTRA`), so a project or service that was only found, never
made, is never deleted; and anything whose `vertra-team` isn't the run's
`forTeam` (`NOT_THIS_TEAMS`), so one team's delete, even run directly,
can't remove another team's project. A run for no team (`MISSING_TEAM`) is
refused. A create reports what it finds as made only when both labels match
the same way. One already gone counts as deleted. A project this product can't see fails
(`PROJECT_NOT_VISIBLE`) rather than being reported deleted: Google answers
403 alike for a purged project and a missing permission. The console lets only the team it was
made for, whoever ran it, and admins delete it. A deleted project is shut
down and can be restored for 30 days. Cloud SQL can take longer than a
step's five minutes to delete an instance: the step then succeeds with
`finishing: true`, since an accepted delete can't be stopped. `build-image`
has no cleanup: the repository's own cleanup policies age images out.

Made before they were labelled with a team (before 2026-11-03), a project,
service or instance has `vertra-made` but no `vertra-team`, so its delete
refuses it (`NOT_THIS_TEAMS`). Label it by hand with the team it was made
for (`gcloud projects update <id> --update-labels=vertra-team=<team>`, and
the same with `gcloud run services update` or `gcloud sql instances patch`),
then delete it again, or delete it outside Vertra.
Proven on GKE Autopilot (2026-10-25): a project, a Cloud Run service and a
Cloud SQL instance made and deleted through Vertra.
[dags/gcp-hello-world-dag.yaml](dags/gcp-hello-world-dag.yaml) chains the
first three.

## Credentials

No keys: the actions use Application Default Credentials, which GKE
Workload Identity supplies from the step's Kubernetes ServiceAccount. Each
product runs as its own (`serviceAccount` in its `product.yaml`), which the
console creates in the `gcp` namespace, and only that product's image may
run as it. Grant each one only what its product does, straight to its
Kubernetes identity (GKE Workload Identity Federation: no Google service
account, no annotation):

```sh
PROJECT=my-gcp-project                      # the cluster's project
NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
member() { echo "principal://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/$PROJECT.svc.id.goog/subject/ns/gcp/sa/gcp-$1"; }

# project: look projects up; create them under a folder, and link billing.
gcloud resource-manager folders add-iam-policy-binding $FOLDER --role roles/browser --member "$(member project)"
gcloud resource-manager folders add-iam-policy-binding $FOLDER --role roles/resourcemanager.projectCreator --member "$(member project)"
gcloud billing accounts add-iam-policy-binding $BILLING --role roles/billing.user --member "$(member project)"
# ...and delete the projects it made (only those, by their label).
gcloud resource-manager folders add-iam-policy-binding $FOLDER --role roles/resourcemanager.projectDeleter --member "$(member project)"
# build-image: run Cloud Build, read the source bucket, look tags up.
gcloud projects add-iam-policy-binding $TARGET --role roles/cloudbuild.builds.editor --member "$(member build-image)"
gcloud storage buckets add-iam-policy-binding gs://$SOURCES --role roles/storage.objectViewer --member "$(member build-image)"
gcloud artifacts repositories add-iam-policy-binding $REPO --location $REGION --role roles/artifactregistry.reader --member "$(member build-image)"
# app-hosting: Cloud Run services, from images it may read (Cloud Run checks
# the deployer can, not just itself), run as an account made for the team's
# services: it may act as that one alone, never the default compute account.
gcloud projects add-iam-policy-binding $TARGET --role roles/run.developer --member "$(member app-hosting)"
gcloud artifacts repositories add-iam-policy-binding $REPO --location $REGION --role roles/artifactregistry.reader --member "$(member app-hosting)"
gcloud iam service-accounts create gcp-services --project $TARGET   # no roles: grant it what the services need
RUNTIME=gcp-services@$TARGET.iam.gserviceaccount.com
gcloud iam service-accounts add-iam-policy-binding $RUNTIME --project $TARGET \
  --role roles/iam.serviceAccountUser --member "$(member app-hosting)"
# cloud-sql: Cloud SQL instances.
gcloud projects add-iam-policy-binding $TARGET --role roles/cloudsql.admin --member "$(member cloud-sql)"
```

So `project` can't touch Cloud Run, and `app-hosting` can't make projects.
Don't grant anything to `default`: every unregistered image runs as it.

`app-hosting` deploys only what the team chose, as whom it chose: register
a team secret `app-hosting` with the key `image-registry`, the registry
every image must be under (`$REGION-docker.pkg.dev/$PROJECT/$REPO`; any
other image is refused, `IMAGE_NOT_ALLOWED`), and `runtime-service-account`,
`$RUNTIME`. Grant that account only what the services need (say
`roles/cloudsql.client` for one using `cloud-sql`): whoever may run
`create` runs code as it.

Optionally, the actions impersonate a second service account, using their
own identity only to mint its tokens: register a team secret `gcp-target`
whose key `service-account` is that account's email, and list it in each
action that should act as it:

```yaml
    secretRefs:
      - name: gcp-target
        keys: [service-account]
```

It's mounted at `/platform/secrets/gcp-target/service-account` for those
steps only, so each team (and each product) chooses its own. The first
account needs `roles/iam.serviceAccountTokenCreator` on the second. Leave it
out when the bound identity already is the one to act as: impersonating
yourself fails, after a minute's timeout, as `PERMISSION_DENIED`. List it in
the product's `check` too, so the check asks as the account the actions act as.

## Is it ready here?

Each product's `check` (product.yaml) says whether it's ready on an install,
and the console runs it when the product is registered, daily, and on
**Check now**. It changes nothing: it gets a token as the product's identity
(impersonating `gcp-target` when listed), then asks Google with
`testIamPermissions` whether it may do what its actions do. The projects,
folders and billing accounts are inputs of each run, so a check looks
through those its identity can see (at most 20) for one where it may:

| Product | Ready when it may | Missing names |
|---|---|---|
| `project` | create, get and delete projects under a folder or organization, and link a billing account | `roles/browser`, `roles/resourcemanager.projectCreator`, `roles/resourcemanager.projectDeleter` on the folder; `roles/billing.user` |
| `build-image` | create, get and list builds in a project (a retry waits on the build an earlier attempt left running) | `roles/cloudbuild.builds.editor`. Its source bucket and image repository are per run: only a create finds out |
| `app-hosting` | get, create and delete Cloud Run services in a project, and act as the runtime account its `app-hosting` secret names | `roles/run.developer`; `roles/iam.serviceAccountUser` on that account; the secret itself. Reading the image's repository (`roles/artifactregistry.reader`) is per run: only a create finds out |
| `cloud-sql` | get, create and delete Cloud SQL instances in a project | `roles/cloudsql.admin` |

With no Workload Identity it isn't ready, and says so. A project, folder or
billing account it can't see isn't looked at. Built, not yet proven on a
cloud.
