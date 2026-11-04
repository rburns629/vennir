# Try Vennir end to end

In about an hour you take a trial team from nothing to a product that runs on Vennir, reads a secret, and passes its output to a second product. Every step copies a sample from the catalog's `templates/` folder: they run anywhere, call no cloud, and cost nothing.

This assumes Vennir is installed and has a catalog. If it isn't yet, or you're the one installing it, start with [Onboarding](17-onboarding.md), which comes back here for the team's part.

You need:

- **A Vennir console account.** A Vennir admin creates it; there is no sign-up page.
- **Access to the catalog repo** (`my-org/vennir-catalog`), to open pull requests.
- **Docker on your laptop** (optional). It lets you run a product's test before you push, instead of waiting for CI.
- **A team name.** Lowercase letters, digits and dashes, not used by anyone before; a removed team's name stays reserved. For a trial, use `try-<your-name>`, for example `team-a`.

Throughout, replace `team-a` with your team name.

## Six words to know

A team offers products; a DAG runs some of their actions in order; a team's secrets are given to its products' tasks, one task at a time.

| Word | What it is | Where it lives |
| --- | --- | --- |
| **Team** | You and your colleagues, as Vennir sees you: one folder in the catalog, one team in the console, one namespace on the cluster, all with the same name | `teams/team-a/` |
| **Product** | A container image that does one kind of job, plus a `product.yaml` describing it | `teams/team-a/products/hello/` |
| **Action** | One thing a product can do, as a script named after it | `actions/greet.py` |
| **DAG** | A list of tasks to run, where a task can wait for another and use its output ([more](03-what-is-a-dag.md)) | Pasted into the console's Submit page |
| **Task** | One action of one product, run once, with its inputs and the secrets it lists | A line in a DAG |
| **Secret** | A value your products need at run time, read as a file. It's your team's: only your products' tasks can mount it, and only when they list it ([more](04-secrets-explained.md)) | Console, Team page, Secrets tab |

## Members and maintainers

Everyone in a team is a member or a maintainer. What each may do:

| | Member | Maintainer |
| --- | --- | --- |
| See the team's runs, their outputs and logs, its Pods, and its secrets' names | Yes | Yes |
| Run templates and actions shared with the team, from **Catalog** | Yes | Yes |
| Retry, cancel and run again a template run they started | Yes | Yes |
| Submit a raw DAG (**Runs → Submit a DAG**) | No | Yes, if they maintain every team it names |
| Retry, cancel or run again any other run of the team | No | Yes, if they maintain every team in it |
| Add, change or remove the team's secrets | No | Yes |
| Add people, change roles, add or revoke bots | No | Yes |
| Approve or decline a step waiting for approval | No | Yes, unless they submitted the run |

A member who tries a maintainer's action is refused with `Managing team "team-a" takes a maintainer; you're a member, not a maintainer`. Ask a maintainer, or ask one to make you a maintainer.

Who's in a team is read on every request, so being added, removed or changed takes effect at once. Once you're removed you no longer see the team's runs, even ones you submitted yourself; template runs you started stay yours to see.

## Step 1: Claim your team

One pull request creates your team. Once it's merged, the catalog's next release makes your team in the console and its namespace in the cluster, both named `team-a`, within a few minutes.

1. In the catalog repo, create a branch and copy `templates/team/team.yaml` to `teams/team-a/team.yaml`.
2. Change every line marked `CHANGE`. The `name` must match the folder name.
3. Add your team's line to `.github/CODEOWNERS`, with the other teams' lines: `/teams/team-a/ @<your-org>/<your-team>`. From then on, your team approves changes to your products.
4. Open a pull request. A catalog admin approves it, since it changes `.github/`. `./vennir catalog validate` (and CI) refuses a name that's the platform's own (`vennir-system`, `kube-…`, `bases`, `catalog-release`); a name a removed team had stays reserved, and each install refuses it when it applies the release, saying so on **Admin → Catalog**: then pick another.
5. Merge once it's approved.
6. Ask a Vennir admin to add you to the `team-a` team. A new team starts empty, so its first person comes from an admin, as a maintainer; after that, its maintainers add teammates on the Members tab, as members or maintainers ([what each may do](#members-and-maintainers)).

**You're done when** the console's Teams page lists `team-a` and you can open it.

Keep the team pull request on its own. Products go in a later one, because a product can only be registered once its team exists.

## Step 2: Ship the hello product

Copy the `hello` sample, rename three things, and merge: CI builds it, tests it, scans it, signs it and lists it in the console.

1. On a new branch, copy the folder `templates/hello/` to `teams/team-a/products/hello/`.
2. In `product.yaml`, change the lines marked `CHANGE`: `team` and `owner`. There's no image name to pick: it's `<registry>/team-a/hello`, from the folder.
3. Optional, before pushing: run what CI will, from the catalog repo's root.

   ```bash
   ./vennir catalog check teams/team-a/products/hello
   ```

4. Open a pull request. CI checks `product.yaml`, builds the image, runs its tests (each `tests/<action>/<case>/` folder: a `request.json` and the `expected.json` its result must contain), and scans it for fixable vulnerabilities, baked-in secrets and malicious packages. Nothing is published from a pull request.
5. Get one approval and merge. CI then pushes the image tagged with the commit, signs it, and publishes the catalog's release; within a few minutes each install applies it, registering each action pinned by digest.

**You're done when** the console's product list (**Catalog → Every product**) lists `team-a-hello-greet`. Its image is `<registry>/team-a/hello:latest` (CI also tags it with the commit).

## Step 3: Run it

Paste a one-task DAG into the console and you'll get `Hello, Anna!` back in under a minute.

1. Open `templates/dags/1-hello.yaml` and replace `team-a` with your team, and the registry with yours.
2. In the console, open **Runs → Submit a DAG**, paste it, and submit.
3. On the execution's page, watch the task go from Ready to Running to Succeeded. ([Runs, explained](09-runs-explained.md) has every state.)

Submitting a raw DAG takes a maintainer of its team; a member runs the team's products from **Catalog** instead.

```yaml
name: my-first-hello           # a label for this run; it can repeat
tasks:
  - id: say-hello
    image: <registry>/team-a/hello:latest   # pinned to its digest when you submit
    action: greet
    team: team-a
    inputs:
      name: Anna
```

**You're done when** the task's output reads `{"message": "Hello, Anna!", "secretFound": false}` and its logs show `greeting Anna`.

Every submission is a new run, so you can paste the same DAG again as often as you like. A pipeline that may retry a submission adds a `requestId`: sending the same one again returns the run it already started instead of starting a second.

Templates other teams share with you don't need a DAG at all: open **Catalog**, pick one, fill in what it asks for, and it runs as that team's products, with their own identities and secrets. The run is yours to follow, cancel and rerun from **Runs**.

## Step 4: Give it a secret

A secret is your team's. Any of your products' tasks can be given it, as a file, by listing it in `secretRefs`; nothing else can read it: not another team, and not an image that isn't one of your products.

1. In the console, open your team, then **Secrets → Add a secret**.
2. **Source:** pick **Paste it here**.
3. **Details:** name it `hello-secret`, keep the file name `value`, paste any value, and save.
4. Submit `templates/dags/2-hello-with-secret.yaml`, with your team name in it. Compared with step 3, the task now lists the secret and asks the action to check it:

   ```yaml
       secretRefs: [hello-secret]
       inputs:
         name: Anna
         useSecret: true
   ```

**You're done when** the output shows `"secretFound": true`. The value itself never appears in the output or the logs.

Inside the container the secret is the file `/platform/secrets/hello-secret/value`. Look at `actions/greet.py` to see it read, checked, and never printed.

## Step 5: Chain two products

A DAG can pass one task's output to the next task's input, so two products work together without knowing about each other.

1. Ship a second product the same way as step 2: copy `templates/name-maker/` to `teams/team-a/products/name-maker/`, change its `CHANGE` lines, open a pull request and merge.
2. Submit `templates/dags/3-chain.yaml`, with your team name in it. The second task waits for the first and takes its output:

   ```yaml
     - id: say-hello
       dependsOn: [make-name]
       inputs:
         name: {$fromTask: make-name, $output: name}
   ```

**You're done when** `make-name` outputs `{"name": "Anna Berg"}` and `say-hello` outputs `{"message": "Hello, Anna Berg!", ...}`.

A task that uses another's output must list it in `dependsOn`; the DAG is refused otherwise.

## Step 6: Sync secrets from your own vault (optional)

If your secrets already live in a vault, connect it once and add them from there; a change in the vault reaches Vennir within an hour. You keep the vault in your own cloud account.

1. On your team's **Secrets** tab, choose **Connect a source** and pick your provider.
2. Fill in its few details. The page then shows the commands to run in your own account, already filled in, and who Vennir will sign in as.
3. Run them, then open the pull request the page prepares: one file, `teams/team-a/secret-stores/secretstore.yaml`. A catalog admin approves it.
4. After merge, the source appears under **Where secrets come from**, showing whether Vennir could sign in.
5. From then on, **Add a secret** offers **Sync from …**: give the secret's name in the vault instead of pasting a value.

| Provider | What Vennir stores | Status |
| --- | --- | --- |
| GCP Secret Manager | Nothing: it signs in with Workload Identity | Tested ([step by step](02-sync-secrets-gcp.md)) |
| AWS Secrets Manager | Nothing: AWS trusts the cluster's identity | Guide only, not yet tested |
| 1Password | One read-only service-account token, set on your team's **Secrets** tab (**Stored credential**) in each install | Guide only, not yet tested |

The file may only hold your team's secret source and the identity it signs in as; anything else fails its pull request check.

## Sample products to copy

Three tested products in the catalog's `templates/` folder cover the patterns most products need; start from the closest one rather than from scratch.

| Sample | Action | What it teaches | Copy it when your product… |
| --- | --- | --- | --- |
| `hello` | `greet` | The whole contract: read inputs, write a result, fail with a clear code, read a secret without printing it | Is new, or does simple work |
| `name-maker` | `make` | Producing an output for a later task (`$fromTask`) | Feeds another product |
| `http-check` | `check` | Calling an API: HTTPS only, a timeout, a token from a secret, failures marked retryable or not | Talks to a service or cloud API |

Every sample has the same parts:

```
teams/team-a/products/hello/
  product.yaml          what it does: actions, inputs, outputs, secrets
  Dockerfile            what it installs; runs as a non-root user
  entrypoint.sh         copied as is; runs actions/<action>.*
  actions/greet.py      the action itself
  actions/test_greet.py its unit test, run inside the image
  tests/greet/<case>/   request.json and expected.json: run against the built image
```

Each sample builds, passes its tests and passes CI's security scan exactly as it is, and CI checks that on every change to `templates/`, so a copy starts from green. Every line you must change is marked `CHANGE`.

For a real cloud product, the catalog's `samples/gcp` and `samples/aws` teams have working examples that create projects, Cloud Run services, Cloud SQL instances, S3 buckets, App Runner services and RDS databases; they call real cloud APIs and cost money. [Deploy to Google Cloud](19-deploy-to-gcp.md) and [Deploy to AWS](20-deploy-to-aws.md) take you through them.

## Guardrails

Some rules are enforced for you and fail loudly; the rest are yours, and reviewers check them.

**Enforced**

| Rule | Checked by | When |
| --- | --- | --- |
| The image builds and at least one `actions/test_*.py` passes inside it | CI | Every pull request |
| No high or critical vulnerability that has a fix; no secret baked into the image; no known-malicious package | CI scans | Every pull request |
| The image runs as a non-root `USER`; no risky code patterns; no committed credentials | CI code and secret scans | Every pull request |
| A team name isn't the platform's own | `./vennir catalog validate`, in CI | Team pull request |
| A team name was never used by a removed team | Each install, applying the release | After merge (**Admin → Catalog** says why) |
| A secret-store file holds only your source and its identity, in your namespace | `check-secret-stores` | Secret-store pull request |
| Tasks only run images from the catalog's registry (or a source an admin allowed), and on GKE only images catalog CI signed | The cluster | Every task |
| A task only gets secrets added for its own team, only if it's one of the team's products, and only those it lists | The console, then the cluster | Every submission |

**Your checklist for every product**

- [ ] One product does one kind of job; each action is one script named after it.
- [ ] Every input and output is declared in `product.yaml`, and the action checks its inputs before doing anything.
- [ ] Running an action twice is safe: tasks can be retried, so "create" means "create or find the existing one".
- [ ] Failures return a `code`, a message that says what to do, and `retryable: true` only when trying again could help.
- [ ] Network calls have a timeout and use HTTPS.
- [ ] Secrets are read from `/platform/secrets/<name>/<key>`, named under the action's `secretRefs` so DAG authors know what to list, and never printed, logged or returned.
- [ ] No credentials in the repo or the image, ever; they are added in the console.
- [ ] Dependencies are pinned to exact versions in the `Dockerfile`.

## When something goes wrong

Every error names its cause; this table maps the common ones to the fix.

| You see | Why | Fix |
| --- | --- | --- |
| Submit refused: `Secret "hello-secret" is not registered for team "team-a"` | The secret isn't added yet, or its name in `secretRefs` has a typo | Add it on the Secrets tab (step 4), or fix the name |
| Submit refused: `... runs as ServiceAccount "hello" (its product.yaml), not "default"` | The task names a ServiceAccount its product doesn't declare | Leave `serviceAccount` out: the task gets its product's |
| Submit refused: `... isn't a registered product of team ...` | The image or action isn't in the catalog for your team, so it can only run as `default`, with no secrets | Copy `image` and `action` from the Products page, or publish the product first |
| Submit refused: `Inputs that don't fit their product's input schema: tasks.<id>.inputs.<name> ...` | An input the step gives isn't what its action's `input` schema in `product.yaml` asks for (a missing one, a wrong type, too long) | Fix the input: the Products page shows each action's schema |
| Task failed: `INPUT_INVALID` | An input that came from an earlier step's output didn't fit this step's input schema once it was known | Fix the earlier step's output, or how the DAG wires it |
| Task failed: `OUTPUT_INVALID` | The step's `result.json` didn't fit its action's `output` schema, so no later step got it | Fix the product, or its schema, in the catalog |
| Task failed: `MISSING_SECRET` | The action wanted its secret, but the task didn't list it | Add the secret to the task's `secretRefs` |
| Task failed: `IMAGE_NOT_FOUND` | A typo in `image`, or the product's pull request isn't merged yet | Copy the exact image from the Products page |
| Task failed: `IMAGE_NOT_ALLOWED` | The image isn't from the catalog's registry, or another source an admin allowed | Publish it through a catalog pull request; an admin can allow another source on the Admin page |
| Task failed: `IDENTITY_NOT_ALLOWED` | The step ran as a ServiceAccount its product doesn't declare, or mounted a secret that isn't one of its team's (normally the console refuses this first; seeing it means the console and cluster disagree, e.g. the product or secret changed after submitting) | Check the product's `serviceAccount` on the Products page and the secret on the Secrets tab; an admin can check the console's log for an identity policy sync error |
| Task failed: `IMAGE_NOT_SIGNED` | The image wasn't published by catalog CI | Publish it through a catalog pull request |
| Submitting shows an old run instead of a new one | The DAG's `requestId` was used before | Remove the `requestId`, or change it |
| The Admin page's Catalog card: `a team named ... already exists here and the catalog didn't make it` | A new team folder has the name of a team someone made by hand | An admin adopts the team (if it's meant to be the same one), or the folder gets another name |
| CI: `no tests` | The product has no `tests/<action>/<case>/` folders | Add one; copy the sample's |
| CI: a `HIGH`/`CRITICAL` vulnerability, a secret, or a malicious package | The image failed its security scan | The run's summary lists each; usually keep the `apt-get upgrade` line and pin a fixed version |
| You can't open your team | You're not a member yet | Ask a Vennir admin (first member) or a teammate |
| Refused: `Managing team "team-a" takes a maintainer` | You're a member, and this takes a maintainer | Ask a maintainer to do it, or to make you one ([who may do what](#members-and-maintainers)) |
| Refused: `TEAM_RETIRED` | The team is retired, so nothing new runs for it | See [a retired team](#if-your-team-is-retired) |

A task's own logs are on its execution's page; the team's **Running now** tab shows a task that can't start and why. Every failure code, what it means and whether it's retried is in [Runs, explained](09-runs-explained.md#what-does-each-failure-code-mean).

## Your account

- **Signing in.** With your email and password, or with single sign-on when your install has it. A team can require single sign-on; then your password no longer works while you're in that team.
- **A new or reset password.** A password an admin set for you must be changed before you can do anything else.
- **A forgotten password.** There's no email reset: ask a Vennir admin to reset it, then change it.
- **Changing your password** signs you out everywhere else.
- **Sessions** last 8 hours, unless your install says otherwise; then you sign in again.
- **Too many wrong passwords.** After 10 failed sign-ins, you must wait before the next try; a successful sign-in clears the count.

## If your team is retired

A team is retired when its folder is removed from the catalog, or by an admin. It can be undone: by an admin, or by restoring the folder.

- The team is read-only: nothing new can be run, retried, added or changed for it (`TEAM_RETIRED`).
- Its products are unregistered, so templates that use them stop working too.
- Its history stays: you can still open its runs, outputs and logs.
- Steps already running finish. Steps of its runs that hadn't started yet usually fail with `DISPATCH_REJECTED`: the cluster no longer starts anything in its namespace.

An admin can later remove a retired team for good. Its name stays reserved.

## Help, and what isn't ready yet

Ask the Vennir team; for an account, or the first member of a new team, ask a Vennir admin.

Known gaps today:

- **AWS and 1Password syncing** have guides in the console but haven't been tested end to end. Expect rough edges and tell us what you hit.
- **No "sync now".** A secret changed in your vault reaches Vennir within an hour.
- **One namespace per team.** Separate environments by secret name for now, for example `db-password-prod`.

**Cleaning up a trial team:** a pull request that deletes `teams/team-a/` retires it ([what that means](#if-your-team-is-retired)); a Vennir admin can then remove it for good. Its name stays reserved.
