# Troubleshooting

This page is for anyone whose run, step, image, secret or sign-in isn't doing what they expected. It's organized by what you see. Each entry says what you see, why it happens, and what to do. For every failure code and what it means, see [Runs, explained](09-runs-explained.md#what-does-each-failure-code-mean); this page doesn't repeat that table.

## Where do I start when a run fails?

Open the run from **Runs**. A failed run has a card at the top of its page:

- **Failed at step N of M, <step>: <message>**, with the failure code below it.
- **What it means** and **What to do**: the explanation. If the product's team wrote help for its own codes in `product.yaml`, you see their words, and the card says "Explanation written by <team> for this error code". Otherwise it says "Explanation from Vennir".
- **Safe to retry?**: whether the product says it's safe to run twice. "Yes" means it finds what an earlier attempt made instead of making it again. "With care" means the product doesn't say so: check what the failed attempt made before you retry.
- **Ask <team>**: the owning team's chat channel, contact, and **Runbooks** link, from its `team.yaml`.
- **Retry <step>** gives that step one more attempt. Hover over it if it's greyed out to see why. **Show its attempts and logs** opens the step.

Then:

1. **Read the message.** Most codes say exactly what to change. Look the code up in [the failure codes](09-runs-explained.md#what-does-each-failure-code-mean): it tells you whether the step is retried on its own and what to do.
2. **Read the step's logs.** Click the step. Logs are copied every 60 seconds, so a running step's logs can be up to a minute behind. On another team's step you see only its info lines ([why](09-runs-explained.md#where-are-a-steps-logs-and-why-dont-i-see-all-of-them)).
3. **Decide: Retry, or Run again.** Retry continues the same run with the same inputs. Run again starts a new run with each image pinned again, so it picks up a product fixed since ([which one](09-runs-explained.md#how-do-retries-work-automatic-retry-and-run-again)).

A code the platform doesn't know comes from the product itself, for example `MISSING_SECRET`. The product's page and its team's help explain it. If they don't, ask the team named on the card.

## My submission was refused before anything ran

**What you see:** submitting, retrying or running again returns an error, and no run starts.

**Why:** the console checks a DAG before it reaches the cluster: your access, the team's secrets, each product's identity, the inputs against their schemas, and the images. The message names every problem it found.

**What to do:** fix what the message says. The common ones:

| Message or code | What to do |
| --- | --- |
| `Managing team "…" takes a maintainer` | Run the team's templates from **Catalog** instead, or ask a maintainer ([roles](13-teams-and-roles.md#what-may-a-member-a-maintainer-and-an-admin-do)) |
| `Secret "…" is not registered for team "…"` | Add the secret on the team's **Secrets** tab, or fix its name in `secretRefs` |
| `… isn't a registered product of team …` | Copy `image` and `action` from the **Products** page, or publish the product first |
| `Inputs that don't fit their product's input schema` | Fix each input listed. The **Products** page shows the schema |
| `INPUT_CONTAINS_CREDENTIAL` | Put the value in a secret and list it in `secretRefs` |
| `TEAM_RETIRED`, `TEAM_PURGED` | A team in the DAG is retired or gone. See [retiring](13-teams-and-roles.md#what-does-retiring-a-team-do) |
| An image error | See [an image was refused](#an-image-was-refused) |

[Runs, explained](09-runs-explained.md#what-does-each-failure-code-mean) lists the other refusal codes.

## My step is Ready but not running

**What you see:** the step stays **Ready** for more than a few seconds.

**Why:** something is holding it: its product's limits (`maxRunning`, `concurrencyKey`), a retry's backoff, the install's limits, or no room in the cluster.

**What to do:** see [Why is my step Ready but not running?](09-runs-explained.md#why-is-my-step-ready-but-not-running). Check the team's **Running now** tab: it shows a step whose Pod **Can't start**, and why. A step that waits for room for 10 minutes fails with `TASK_NOT_STARTED`. If that keeps happening, ask an admin to check the cluster's capacity, or the team's **Resource limits** on its **Settings** tab.

## My step is awaiting approval

**What you see:** the step says **Awaiting approval**, and the run page shows "Waiting for an approval from a maintainer of its team".

**Why:** its product asks a person to approve its steps: always, when another team runs them, or when they aim at a target that needs approval.

**What to do:** a maintainer of the step's team, who didn't submit the run, clicks **Approve** or **Decline** on the run's page. **Preview what it would do** shows what the step would do first, if the product supports it. If nobody decides within 3 days (unless the install says otherwise), the step fails with `APPROVAL_EXPIRED`. Retrying it asks again. See [Who approves a step?](09-runs-explained.md#who-approves-a-step-that-is-awaiting-approval).

## An image was refused

Images are checked twice: by the console when you submit, retry or run again, and by the cluster when the step starts. The cluster refuses an image even if the console allowed it.

| You see | Why | What to do |
| --- | --- | --- |
| `IMAGE_NOT_ALLOWED` | The image isn't under an allowed source: the catalog's registry, or another source an admin added | Publish the product through a catalog pull request and use the image from the **Products** page. Only an admin can allow another source ([image sources](16-admin-settings.md#image-sources)) |
| `IMAGE_POLICY_NOT_CONFIGURED` | The install has no allowed image source yet, so nothing can run | Ask an admin to set the source registry |
| `IMAGE_NOT_FOUND` | The image isn't in the registry: a typo, or the product's pull request isn't merged yet | Copy the exact image from the **Products** page, or wait for catalog CI to publish it |
| `IMAGE_NOT_RESOLVED` | The registry didn't say which digest the tag points to | Try again |
| `IMAGE_NOT_PINNED` | The image reached the cluster without a digest | Submit through the console or its API, which pins every image to a digest |
| `IMAGE_SCAN_PENDING` | The image is being scanned for the first time | Try again in a minute |
| `IMAGE_SCAN_ERROR` | The scan couldn't run, and is being retried | Try again in a minute. If it persists, tell an admin |
| `IMAGE_SCAN_FAILED` | Its image hasn't passed a scan on this install: the scan found a HIGH or CRITICAL vulnerability with a fix available, or a secret in the image, or the image was never scanned here (its Job didn't come through the console) | Retry it from the console, which scans it first. If the scan fails, ask the product's team to rebuild it with the fixes. An admin can accept a failed scan with a reason ([image scans](16-admin-settings.md#image-scans)) |
| `IMAGE_NOT_SIGNED` | The install requires catalog images to be signed, and this one wasn't signed by catalog CI | Publish it through a catalog pull request, not by pushing it yourself |
| `IMAGE_USER_NOT_ALLOWED` | The image runs as root, or as a named user | Ask the product's team to end the Dockerfile with a numeric `USER`, such as `USER 65532:65532` |

Images are scanned again daily while they're in use. So an image that ran yesterday can be refused today if a new fixable vulnerability has been published for it.

## My step doesn't get its secret

**What you see:** the step fails with a product code such as `MISSING_SECRET`, or its logs say a file under `/platform/secrets/` isn't there.

**Why:** a step only gets the secrets its task lists in `secretRefs`. Even then, it gets them only if each one is registered for the step's own team, and only if the step runs one of that team's registered products. Common causes:

- The task doesn't list the secret in `secretRefs`. Templates list it for you; in a raw DAG you list it yourself.
- The secret was added to a different team. Secrets are per team, and the step runs in its product's team.
- The secret's name differs from the one the product expects. The product's actions name theirs under `secretRefs` in `product.yaml`, shown on the **Products** page.
- The secret syncs from a vault and isn't there yet. On the team's **Secrets** tab, a synced secret shows **Synced**, **Syncing**, **Sync error** or **Missing**. A change in your vault can take up to an hour to arrive.

**What to do:** check the secret's status on the team's **Secrets** tab, and that the task lists the exact name. If you submitted with a secret name the team doesn't have, the console refuses the submission instead, with `Secret "…" is not registered for team "…"`. If a step fails with `IDENTITY_NOT_ALLOWED`, the console and the cluster disagree about the product, its released digests or the secret, often because one changed after you submitted. Run it again. If it persists, tell an admin. See [Secrets, explained](04-secrets-explained.md) for how a secret reaches a step.

## "Not run: it's for aws installs" (NOT_FOR_THIS_INSTALL)

**What you see:** a product marked **For aws installs** (or another cloud) with **Run** and **Add to cart** off, or a run refused with `NOT_FOR_THIS_INSTALL`: "<product> is for aws installs; this install is on gcp."

**Why:** its team said, in the catalog (`clouds` in its product.yaml, or its team.yaml for all its products), which installs it's for, and this install is on another cloud. It's listed so you know it exists, but it isn't checked or run here. Nothing was made: the refusal comes before anything starts.

**What to do:** run it on an install on its cloud. If it should run here too, ask its team to add this install's cloud to its `clouds`. A template with such a step is refused the same way until the template changes.

## A product says it isn't ready here

**What you see:** a **Not ready** or **Check failed** pill on the product in **Catalog** or **Products**, or a warning on its run form: "<team> says it isn't ready on this install".

**Why:** the product has a check action, which the console runs on this install as the product's own identity, with its secrets. **Not ready** means the check ran and reported something missing, such as a secret, a cloud permission, or the identity it runs as. **Check failed** means the check couldn't say either way. Checks run when a product is new, when its image changes, once a day, and when someone clicks **Check now**.

**What to do:** on the **Products** page, open the product. It shows who the product acts as, what's missing, and a link to **The check run** with its logs.

- If it's your team's product, fix what's missing (often a secret on the **Secrets** tab, or a cloud grant for the identity shown), then click **Check now**. Every grant the cloud samples need, and how: [Deploy to Google Cloud](19-deploy-to-gcp.md), [Deploy to AWS](20-deploy-to-aws.md).
- If it's another team's, tell them. When a check finds a product not ready, its team's maintainers and the admins are notified, but a word from you helps.

A run may fail until the product is ready.

## A step can't connect to its target

**What you see:** a step fails with a connection timeout or refused connection to a database, a partner's API or a service, while other steps' calls work, or it works on one run and not the next.

**Why:** the target lets in only addresses it knows, and Vennir's steps leave from the cluster's nodes, whose addresses aren't fixed on a cloud install: they change as nodes come and go.

**What to do:** use the target's own sign-in instead of an address rule where it has one (IAM for Cloud SQL, RDS, Cloud Run, Lambda), or give the cluster a fixed outbound address. [Addresses and firewall rules](22-addresses-and-firewalls.md) shows how to find the current addresses and both ways out.

## I can't sign in

| You see | Why | What to do |
| --- | --- | --- |
| `Invalid email or password.` | Wrong email or password, or no account | Check both. There's no sign-up page unless the install allows it: ask an admin for an account |
| Sign-ins are refused for a while after several failures | After 10 failed sign-ins for an account, each new try must wait, up to a minute. Too many tries from one place also wait a few minutes | Wait, then try once with the right password. A successful sign-in clears the count |
| `… signs in with <provider>: use that instead of a password.` | A team you're in requires single sign-on | Click **Sign in with <provider>** |
| "That account isn't from a domain allowed to sign in here." | You signed in to your provider with an account outside the install's allowed email domains | Choose your work account |
| "This email's Vennir account signs in with a different account." | Your Vennir account is already linked to another provider account | Ask an admin |
| "Your groups couldn't be read, so your teams can't be checked." | The install maps groups to teams, and your provider didn't send your groups, or Google's API failed | Try again shortly. If it persists, ask an admin to check the groups settings ([groups](13-teams-and-roles.md#how-do-single-sign-on-groups-decide-who-is-in-a-team)) |
| "Single sign-on isn't on here any more" | An admin turned single sign-on off | Sign in with your password, or ask an admin for one |
| "Your session has ended." | Sessions last 8 hours unless the install says otherwise, and changing or resetting a password signs you out everywhere else | Sign in again |
| You're asked to choose a password before anything else | An admin created your account or reset your password | Choose your own: at least 12 characters |

**Forgot your password?** There's no email reset. Ask a Vennir admin to reset it on [People](16-admin-settings.md#people). You choose your own when you next sign in. If every admin is locked out, someone with access to the cluster can run `vennir admin reset-password <env>`.

**Signed in, but you see no teams?** You're not in any team yet: see [How do I join a team?](13-teams-and-roles.md#how-do-i-join-a-team).

## The catalog isn't syncing

**What you see:** a product or team merged in the catalog doesn't appear, or the old version still runs.

**Why:** the console reads the catalog's release from the registry every few minutes (every 5 by default) and applies it. Some things that stop it:

- Catalog CI hasn't published a release yet: the merge's workflow is still running, or it failed.
- The install follows catalog versions, not every merge, so nothing new arrives until someone tags a new version.
- The release isn't signed by a signer the install trusts. Then nothing is applied: "no trusted signer signed the catalog release …".
- The release was applied except for some items, such as a team the catalog didn't make, or a product with an invalid schema.

**What to do:**

- **Anyone:** check the catalog repository's CI run for your merge. Then look at Observe's **Security checks**, under **Refused, last 7 days**, which shows a release that couldn't be applied.
- **Admins:** open [Catalog](16-admin-settings.md#catalog). It shows the release followed, the commit and version applied and when, and when the console last looked. An error is shown there. A partly applied release lists each item that wasn't applied and why. **Sync now** reads and applies the release at once. A team the catalog didn't make has an **Adopt** button.

Admins are also alerted when the catalog hasn't been pulled for 30 minutes.

## When should I ask an admin?

Ask an admin when the fix is outside your team:

- you need a console account, an admin role, or a password reset;
- you need to join a team that has no maintainer you can reach;
- a team needs to be created, retired, restored or purged;
- an image source must be allowed, or a failed scan accepted;
- a step fails with `DISPATCH_REJECTED`, or keeps failing with `TASK_NOT_STARTED`, `IMAGE_PULL_FAILED` or `EXECUTOR_START_FAILED`;
- a step needs more than the team's resource limits allow (`RESOURCES_NOT_ALLOWED`);
- `IDENTITY_NOT_ALLOWED` persists after running again;
- the catalog isn't applied, or the chat agent or the API gateway isn't working.

Ask the product's team, named on the failure card, when the problem is in their product: a bad result, an output that doesn't fit its schema, a failed scan, or a product that isn't ready. Ask a maintainer of your own team for anything about its secrets, members, bots or schedules.

When you ask, include the run's address and the failure code. They're enough to find the rest.
