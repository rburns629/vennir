# Sync secrets from GCP Secret Manager

In about 20 minutes your team reads secrets straight from your own Secret Manager: change a value there, and your products get it within an hour. Vennir signs in with Workload Identity, so no key is stored anywhere, and it can only read the secrets you allow, one at a time.

You need:

- **Your team**, set up and with you as a member (steps 1 and 2 of [Try Vennir end to end](01-getting-started.md)).
- **A GCP project for your secrets.** Your own; it doesn't have to be Vennir's.
- **These rights in that project:** create service accounts, and change a secret's or a service account's IAM policy (for example Owner, or Service Account Admin plus Secret Manager Admin).
- **On your laptop:** `gcloud`, signed in (`gcloud auth login`), plus `git` and `gh` if you open the pull request by hand.

In every example below, the team is `team-a` and the project is `team-a-secrets`. Lines starting with `$` are what you type; the lines under them are what you should see.

## 1. Set your values

Set these once in your terminal; every later command uses them. Change the first two lines to your team and project.

```console
$ TEAM=team-a
$ PROJECT=team-a-secrets
$ SA=vennir-eso-$TEAM@$PROJECT.iam.gserviceaccount.com
$ POOL=my-gcp-project.svc.id.goog
$ echo $SA
vennir-eso-team-a@team-a-secrets.iam.gserviceaccount.com
```

- `SA` is the identity Vennir will sign in as. It belongs to your project and only your team uses it.
- `POOL` is Vennir's cluster, which your project will trust. It's the same for every team; the console's **Connect a source** page shows it too.
- A service account's name can be 30 characters at most. If `vennir-eso-<your team>` is longer, shorten it, and use the same name everywhere below.

## 2. Create a secret in Secret Manager

Skip this if the secret already exists. Turn on Secret Manager in your project (once), then create the secret. `read -rs` keeps the value off your screen and out of your shell history.

```console
$ gcloud services enable secretmanager.googleapis.com --project=$PROJECT
Operation "operations/acat.p2-123456789012-..." finished successfully.

$ read -rs VALUE
$ printf '%s' "$VALUE" | gcloud secrets create hello-secret \
    --project=$PROJECT --replication-policy=automatic --data-file=-
Created version [1] of the secret [hello-secret].
$ unset VALUE
```

After `read -rs VALUE`, paste the value and press Enter; nothing is shown. For a file, such as a JSON key, use `--data-file=path/to/file` instead.

## 3. Create the identity Vennir signs in as

Three commands: create a service account only your team uses, let it read your secret, and let Vennir's cluster act as it. Nothing else can read your secrets this way.

**Create the service account**

```console
$ gcloud iam service-accounts create vennir-eso-$TEAM \
    --project=$PROJECT --display-name="Vennir secret sync for $TEAM"
Created service account [vennir-eso-team-a].
```

**Let it read the secret.** One command per secret; it can read nothing else.

```console
$ gcloud secrets add-iam-policy-binding hello-secret \
    --project=$PROJECT \
    --role=roles/secretmanager.secretAccessor \
    --member=serviceAccount:$SA
Updated IAM policy for secret [hello-secret].
bindings:
- members:
  - serviceAccount:vennir-eso-team-a@team-a-secrets.iam.gserviceaccount.com
  role: roles/secretmanager.secretAccessor
etag: BwYk...
version: 1
```

If it says the service account doesn't exist, wait ten seconds and run it again: a new service account takes a moment to appear.

**Let Vennir's cluster act as it.** Only the identity `eso-gcp` in your team's namespace is allowed. Keep the double quotes: the square brackets would confuse your shell otherwise.

```console
$ gcloud iam service-accounts add-iam-policy-binding $SA \
    --project=$PROJECT \
    --role=roles/iam.workloadIdentityUser \
    --member="serviceAccount:$POOL[$TEAM/eso-gcp]"
Updated IAM policy for serviceAccount [vennir-eso-team-a@team-a-secrets.iam.gserviceaccount.com].
bindings:
- members:
  - serviceAccount:my-gcp-project.svc.id.goog[team-a/eso-gcp]
  role: roles/iam.workloadIdentityUser
etag: BwYk...
version: 1
```

## 4. Open the pull request

One file in the catalog repo tells Vennir where your secrets are and who to sign in as: `teams/team-a/secret-stores/secretstore.yaml`. It holds no secret value, which is why it's safe to review in the open.

**The easy way: from the console**

1. Open your team, then **Secrets → Connect a source → GCP Secret Manager**, and **Next**.
2. Fill in your project and your first secret. The page shows the step 3 commands, filled in; you've run them already. **Next**.
3. Choose **Open the PR on GitHub**. GitHub opens with the file filled in.
4. Choose **Commit changes…**, pick **Create a new branch for this commit and start a pull request**, then **Propose changes** and **Create pull request**.

**By hand**

```console
$ git switch main && git pull
$ git switch -c $TEAM-secret-store
$ mkdir -p teams/$TEAM/secret-stores
$ cat > teams/$TEAM/secret-stores/secretstore.yaml <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: eso-gcp
  namespace: $TEAM
  annotations:
    iam.gke.io/gcp-service-account: $SA
---
apiVersion: external-secrets.io/v1
kind: SecretStore
metadata:
  name: gcp-secret-manager
  namespace: $TEAM
spec:
  provider:
    gcpsm:
      projectID: $PROJECT
      auth:
        workloadIdentity:
          clusterLocation: us-central1
          clusterName: vennir-gke
          serviceAccountRef:
            name: eso-gcp
EOF
$ ./vennir catalog secret-stores check $TEAM
  ok   teams/team-a/secret-stores
$ git add teams/$TEAM/secret-stores
$ git commit -m "$TEAM: sync secrets from GCP Secret Manager"
$ git push -u origin HEAD
$ gh pr create --fill
https://github.com/my-org/vennir-catalog/pull/57
```

**Either way, then:** the pull request's `check-secret-stores` check confirms the file only touches your team; a catalog admin approves it; after merge, catalog CI puts it in the catalog's next release, and each console checks it again and applies it when it reads that release, within a few minutes (an admin can press **Sync now** on the Admin page).

## 5. Check it's connected

A few minutes after the merge, open your team's **Secrets** tab. Under **Where secrets come from** you should see:

| Field | Example |
| --- | --- |
| Card | GCP Secret Manager, **Connected** |
| Project | `team-a-secrets` |
| Signs in as | `vennir-eso-team-a@team-a-secrets.iam.gserviceaccount.com` |
| Name | `gcp-secret-manager` |

**Checking** for a minute is normal. **Can't connect** shows the reason underneath; the usual one is a missing step 3 command, so run the three again (they're safe to repeat). A **Shared with another team** warning means the same service account is used by another team: give yours its own.

## 6. Add the secret, and use it

In the console: your team → **Secrets → Add a secret**.

| Step | Choose or type | Example |
| --- | --- | --- |
| Source | **Sync from GCP Secret Manager** | |
| Secret name | What your DAG lists in `secretRefs` | `hello-secret` |
| Secret name in Secret Manager | Its name in your project | `hello-secret` |
| JSON field | Only for a JSON secret, to take one field of it | (empty) |
| File name inside the container | The file your action reads | `value` |

**Save and check access** waits a few seconds for the first sync and should say **Synced**. Your action reads it from `/platform/secrets/hello-secret/value`.

Then run the walkthrough's `templates/dags/2-hello-with-secret.yaml`, with your team name in it:

```yaml
name: hello-with-secret
tasks:
  - id: say-hello
    image: <registry>/team-a/hello:latest
    action: greet
    team: team-a
    secretRefs: [hello-secret]     # your team's secret: any of your products may list it
    inputs:
      name: Anna
      useSecret: true
```

The task's output should be:

```json
{"message": "Hello, Anna!", "secretFound": true}
```

## Day to day

Once connected, you never need another pull request: add secrets and change values in your own project, then in the console.

**Another secret.** Create it, let the service account read it, then **Add a secret** in the console as in step 6.

```console
$ printf '%s' "$VALUE" | gcloud secrets create db-password \
    --project=$PROJECT --replication-policy=automatic --data-file=-
Created version [1] of the secret [db-password].
$ gcloud secrets add-iam-policy-binding db-password \
    --project=$PROJECT --role=roles/secretmanager.secretAccessor --member=serviceAccount:$SA
Updated IAM policy for secret [db-password].
```

**A new value.** Add a version; Vennir always reads the latest, and picks it up within an hour. Tasks already running keep the value they started with.

```console
$ read -rs VALUE
$ printf '%s' "$VALUE" | gcloud secrets versions add hello-secret --project=$PROJECT --data-file=-
Created version [2] of the secret [hello-secret].
$ unset VALUE
```

Once the new value works, retire the old one: `gcloud secrets versions disable 1 --secret=hello-secret --project=$PROJECT`.

**Take one secret away from Vennir.** Its sync fails from the next refresh, but Vennir keeps the last value it fetched, and tasks still get that copy until an admin removes it. If the value leaked, change it in Secret Manager first.

```console
$ gcloud secrets remove-iam-policy-binding hello-secret \
    --project=$PROJECT --role=roles/secretmanager.secretAccessor --member=serviceAccount:$SA
Updated IAM policy for secret [hello-secret].
```

Removing a secret from the console's list, or disconnecting the source entirely, isn't self-service yet: ask a Vennir admin.

## When something goes wrong

| You see | Why | Fix |
| --- | --- | --- |
| `PERMISSION_DENIED ... iam.serviceAccounts.create` (step 3) | You can't create service accounts in that project | Ask the project's owner to run step 3, or to grant you Service Account Admin |
| `NOT_FOUND ... service account ... does not exist` (step 3) | The new service account isn't visible yet | Wait ten seconds and run the command again |
| `zsh: no matches found: serviceAccount:...[...]` | The shell read the square brackets | Put the `--member` value in double quotes, as shown |
| Pull request check `check-secret-stores` fails | The file touches something other than your team's store and `eso-gcp` | Its message names the line; copy the example file from step 4 |
| Console: **Can't connect** | Vennir can't act as your service account | Rerun the step 3 commands; check the member reads `[<your team>/eso-gcp]` and the file's `projectID` is your project |
| Console: secret shows **Sync error**, permission denied | The service account can't read that secret | The console shows the exact `gcloud secrets add-iam-policy-binding` command; run it. The next refresh picks it up |
| Console: **Sync error**, not found | The secret's name or project is wrong | Check `gcloud secrets list --project=$PROJECT` |
| Submit refused: secret not registered | The DAG names a secret your team hasn't added, or misspells it | See **When something goes wrong** in [Try Vennir end to end](01-getting-started.md) |
