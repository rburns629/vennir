# Runs, explained

A run (an execution) is one submitted DAG, or one run of a template. This page answers what you'll ask while you watch one: what its states mean, what a failure does to the rest of it, how retrying, running again and cancelling work, why a step is waiting, what each failure code means, and how long it's all kept.

## What do a run's states and a step's states mean?

A run is in one of five states:

| Run state | Means |
| --- | --- |
| Pending | Stored, and no step has started yet |
| Running | At least one step has started |
| Succeeded | Every step succeeded |
| Failed | A step failed and won't be retried; nothing more will start |
| Cancelled | Someone cancelled it |

Each step is in one of eight:

| Step state | Means |
| --- | --- |
| Blocked | Waiting for the steps it `dependsOn` to succeed |
| Ready | Free to start; the scheduler starts it on its next pass, about a second later, unless something holds it ([why a step waits](#why-is-my-step-ready-but-not-running)) |
| Awaiting approval | Held until a maintainer of its team approves it ([approvals](#who-approves-a-step-that-is-awaiting-approval)) |
| Claimed | A scheduler has taken it and is creating its Job |
| Running | Its Job exists; the container is starting or running |
| Succeeded | It wrote a valid result; its outputs are saved |
| Failed | It failed, and won't be retried on its own |
| Cancelled | It never ran, or was stopped: the run was cancelled, or failed first |

A step with no dependencies starts Ready; one with dependencies starts Blocked, and becomes Ready once every one of them has succeeded.

## What happens to the rest of the run when one step fails?

When a step fails and won't be retried, the whole run fails at once. Every step that hasn't started yet (Ready, Blocked or Awaiting approval) is cancelled, including steps on branches that don't depend on the failed one. Steps that already succeeded keep their outputs.

So a run never half-continues: either you retry the failed step, which brings the cancelled steps back, or you run it again.

## How do retries work: automatic, Retry, and Run again?

There are three different things.

**Automatic retries.** A step is retried on its own only when both are true:

- its failure is marked retryable: a timeout, a step that couldn't start, a lost Job or Pod, an image that couldn't be pulled, an unreadable result, or the product itself saying `retryable: true`;
- it has attempts left. A step gets the attempts its product's `product.yaml` allows (`maxAttempts`, 1 by default, at most 10), and only one if the product isn't marked `idempotent`. A DAG or template may ask for fewer, never more.

Most products allow one attempt, so most failures aren't retried automatically. Between attempts the step waits 5 seconds, then 10, 20, and so on, up to 5 minutes. Each attempt is a new Job; the run's page shows them all.

**Retry** (the **Retry `<step>`** button on a failed step, or `ExecutionService/RetryTask`). It gives one failed step one more attempt, whatever its attempts allow, and the same run carries on: the steps the failure cancelled come back. Before it starts, the console checks again, as of now: your access, the team's secrets, and the images and their scans. It works only on a Failed step. The failure card's **Safe to retry?** says whether the product is safe to run twice; when it isn't, check what the failed attempt made first.

**Run again** (or `ExecutionService/RerunExecution`). It starts a new run, with a new id, from the same DAG. Each image is pinned again to the digest its tag names now, so a product published since runs its new version. A template's run is run again as the template is now. **Run with changes** opens the run's form filled in with what it was given.

## What does Cancel do?

**Cancel run** (or `ExecutionService/CancelExecution`) stops the whole run:

- steps that haven't started are cancelled at once;
- running steps are stopped on the scheduler's next pass: their Job is deleted, so the container is killed;
- cancelling a cancelled run does nothing, and a finished run can't be cancelled.

Cancelling stops every team's steps in the run, which is why it takes a maintainer of every team the run names (or the person who ran it, for a template's run). A step that was killed may have done part of its work; products are written to be safe to run again for this reason.

## Who approves a step that is awaiting approval?

A product can ask that its steps wait for a person: always, or only when another team runs them, or when they aim at a target that needs an approval. Such a step waits in **Awaiting approval** and is never started until someone decides.

- A maintainer of the step's team decides, on the run's page. The person who submitted the run can't, even as a maintainer: two people agree before it runs.
- Declined, the step fails with `APPROVAL_DECLINED`, and the run fails.
- Nobody deciding within 3 days (unless your install says otherwise) fails it with `APPROVAL_EXPIRED`.
- Retrying a declined or expired step asks for approval again.

The notification bell tells a team's maintainers when a step is waiting for them.

## Why is my step Ready but not running?

Something is holding it. In order of how often you'll see them:

- **Its product's limits.** A product can run at most so many steps at once (`maxRunning`), or only one at a time for the same inputs (`concurrencyKey`), for example one deploy per service. The step starts when the earlier one finishes.
- **A retry's backoff.** A step being retried waits 5 seconds, doubling, up to 5 minutes.
- **The install's limits.** An admin can cap how many steps run at once, across the install or per team.
- **No room in the cluster.** The Job exists, but no node has room, or the team's resource quota is used up. The step is Running but its container hasn't started. After 10 minutes it fails with `TASK_NOT_STARTED`.

The team's **Running now** tab shows its steps' Pods as Kubernetes sees them, including one that can't start and why.

## What does each failure code mean?

A failed step shows a code, a message, what the code means and what to do. When the product's team wrote help for their own codes in `product.yaml`, you see theirs instead. "Retried?" says whether the step is retried on its own, if it has attempts left.

**Codes the platform sets**

| Code | Means | Retried? | What to do |
| --- | --- | --- | --- |
| `TASK_TIMEOUT` | It ran longer than its timeout (`timeoutSeconds`, 300 by default) and was stopped | Yes | Retry it; if it keeps happening, give the step a longer `timeoutSeconds` |
| `TASK_NOT_STARTED` | It never started: the cluster had no room for it (no node could be added, or a quota was reached) | Yes | Retry it; if it keeps happening, an admin can check the cloud's quotas |
| `POD_TERMINATED_UNEXPECTEDLY` | Its container stopped before reporting a result: its Pod was evicted (its node short of memory or disk), preempted, or lost with its node; the message says which | Yes | Retry it |
| `JOB_NOT_FOUND` | Its Job disappeared from the cluster before it reported a result | Yes | Retry it |
| `EXECUTOR_START_FAILED` | The cluster couldn't start it, after several tries | Yes | Retry it; if it keeps happening, tell an admin |
| `IMAGE_PULL_FAILED` | The cluster couldn't download its image for 2 minutes (registry sign-in, network) | Yes | Retry it; if it keeps happening, tell an admin |
| `IMAGE_NOT_FOUND` | Its image isn't in the registry | No | Ask the product's team to publish it, or copy the exact image from the product's page |
| `IMAGE_USER_NOT_ALLOWED` | Its image runs as a user the cluster can't confirm isn't root: a named `USER`, or root | No | Ask the product's team to end its Dockerfile with a numeric `USER`, such as `USER 65532:65532` |
| `IMAGE_INVALID` | Its image name isn't a valid image reference | No | Fix the `image` in the DAG |
| `PRODUCT_RESULT_MISSING` | It ended without writing its result | Yes | Ask the product's team; the message has the end of its logs |
| `PRODUCT_RESULT_INVALID` | It wrote a result the platform couldn't read (not JSON, the wrong shape, or over 4 KB) | Yes | Ask the product's team |
| `OUTPUT_CONTAINS_CREDENTIAL` | Its outputs held something that looked like a credential, so they were discarded | No | Ask the product's team: outputs must never echo a secret |
| `INPUT_INVALID` | Its inputs didn't fit the product's input schema, so it never started | No | Fix the inputs, or the earlier step whose output fed it, and run it again |
| `OUTPUT_INVALID` | It finished, but its outputs didn't fit the product's output schema | No | Ask the product's team: their action returned something it doesn't promise |
| `MISSING_UPSTREAM_OUTPUT` | A step it depends on finished without the output this step takes | No | Ask the team of the step before it, or fix the `$output` name |
| `RESOURCES_NOT_ALLOWED` | The step asks for more memory or CPU than its team may ever use | No | Ask an admin to raise the team's resource limits, or ask the product's team for a smaller size |
| `IMAGE_NOT_ALLOWED` | Its image isn't from a source this install allows | No | Use the catalog's image; an admin can allow another source on the Admin page |
| `IMAGE_NOT_PINNED` | Its image wasn't pinned to a digest, so the cluster refused it | No | Submit it through the console, which pins every image |
| `IMAGE_SCAN_FAILED` | Its image failed the security scan | No | Ask the product's team to rebuild it with the fixes |
| `IMAGE_NOT_SIGNED` | Its image isn't signed by the catalog's CI | No | Ask the product's team to publish it through their catalog's CI |
| `IDENTITY_NOT_ALLOWED` | It asked for an identity or secrets its product isn't registered for | No | Check the product's ServiceAccount on its page and the secret on the Secrets tab; if they look right, tell an admin |
| `TEAM_RETIRED` | Its team was retired while the run was going, so it never started (its steps already running finished) | No | An admin can un-retire the team on the Teams page, then retry it |
| `DISPATCH_REJECTED` | The cluster refused to run it in that team's namespace (not a team's) | No | Ask an admin to check the namespace |
| `APPROVAL_DECLINED` | A maintainer of its team declined it, so it never ran | No | Ask them why, then run it again |
| `APPROVAL_EXPIRED` | Nobody approved or declined it in time, so it never ran | No | Retry it to ask again, and tell its team |

**Codes the product sets.** Any other code (say `MISSING_SECRET`) comes from the product's own code, with its own message, and is retried only if the product marked it retryable. The product's page, and its team's help on the failure card, say what it means.

**Refusals before anything runs.** These come back when you submit, retry or run again, and nothing starts:

| Code | Means |
| --- | --- |
| `FORBIDDEN` | You aren't allowed this: not a maintainer of the team, a secret the team didn't register, or a ServiceAccount its product doesn't declare. The message says which |
| `TEAM_RETIRED` | A team in the DAG is retired: nothing new runs for it |
| `TEAM_PURGED` | A team in the DAG was removed for good |
| `INPUT_INVALID` | An input given as a value doesn't fit its action's input schema; each one is listed |
| `INPUT_CONTAINS_CREDENTIAL` | An input looks like a credential. Put it in a secret and list it in `secretRefs` instead |
| `IMAGE_NOT_FOUND` | An image doesn't exist in the registry |
| `IMAGE_NOT_RESOLVED` | The registry didn't answer which digest a tag is; try again |
| `IMAGE_SCAN_FAILED` | An image failed its security scan |
| `IMAGE_SCAN_PENDING` | An image is still being scanned; try again in a minute |
| `MAX_TASK_COUNT_EXCEEDED`, `CYCLE_DETECTED`, `UNKNOWN_DEPENDENCY`, `NON_UPSTREAM_INPUT_REFERENCE`, ... | The DAG itself is invalid; every problem is listed at once |

## What are the limits?

The defaults; an admin can change most of them for an install.

| Limit | Default |
| --- | --- |
| A step's running time (`timeoutSeconds`, per step in the DAG) | 300 seconds |
| Time a step may wait for room in the cluster before `TASK_NOT_STARTED` | 10 minutes |
| Time an image may fail to download before `IMAGE_PULL_FAILED` | 2 minutes |
| Attempts per step | What its product allows (1 unless it says more, at most 10) |
| Time a step waits for approval before `APPROVAL_EXPIRED` | 3 days |
| Steps in one DAG | 500 |
| A step's `result.json` | 4 KB |
| A step's stored logs | Its last 5000 lines, at most 1 MiB |
| A page of `ListExecutions` | 100 runs, at most 1000 |

## How long are runs kept?

A finished run (its steps, inputs, outputs, logs and events) is deleted 90 days after it finished, unless your install says otherwise: the foot of the **Runs** list says how long it's kept here, or that runs are kept with no time limit (an install can keep them forever). After that it's gone from **Runs** and the API, and its `requestId` starts a new run if sent again.

What a run made (on **Runs → What runs made**) is kept after the run is gone, until someone deletes it.

## Where are a step's logs, and why don't I see all of them?

Click a step on the run's page, or call `ExecutionService/GetExecutionLogs`. A step's printed output is copied into Vertra's database:

- every 60 seconds while it runs, and once more when it ends, so a running step's logs can be up to a minute behind;
- only its last 5000 lines, at most 1 MiB. When more was printed, the first line says earlier output wasn't kept;
- with anything that looks like a credential replaced by `[redacted …]`.

The container and its Pod are deleted about 30 seconds after the step finishes, so the copy is the only one left; there's nothing to `kubectl logs` afterwards.

On your own team's steps you see every line. On another team's step in your run (for example, a template that uses their products), you see only the lines it logs as JSON with `"level": "info"`; the page says how many lines were held back, and which team can see them.
