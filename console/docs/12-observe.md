# Observe: checks, scans, metrics, logs and the audit log

**Observe** in the side menu shows what this install checks, what it refused, and what everything is doing. It has five tabs: **Security checks**, **Metrics**, **Usage**, **Logs** and **Audit log**. Everyone signed in can open it; what each person sees on a tab follows what they may see elsewhere, as this page explains. It also covers the admin pages behind it (**Admin → Image scans** and **Admin → Audit log copy**) and what to do when something is red.

## What's on the Observe page, and who sees what?

| Tab | Shows | Who sees what |
| --- | --- | --- |
| **Security checks** | What this install enforces, what it refused over the last 7 days, and every image allowed to run, with its last scan and SBOM | Everyone sees the checks, the cluster's and catalog's refusals, and every listed product's image. A refused step links to its run only for those who may see that run. Gateway refusals: the API's team, the calling team, and admins |
| **Metrics** | Steps waiting and running now, steps started and how long they waited, why steps failed, the install's alerts, and each product's step times | Everyone. A hidden product's rows only for its own team and admins; an alert about a hidden API is counted, not described, for others |
| **Usage** | Who ran what over the last day, week or month: runs started for each team and by whom, the products they used, and the teams each team's products ran for | Admins every team; anyone else their own teams, who used their teams' products, and their teams' use of others' ([reading it](#reading-the-usage-tab)) |
| **Logs** | A search over steps' output, API backends' output and, for admins, the platform's own | Your teams' lines in full; other teams' INFO lines in runs you own; admins everything ([whose logs](#whose-logs-can-i-see)) |
| **Audit log** | Who changed what, allowed or refused | Admins every entry; anyone else their own, and what was done to their teams or runs in them |

The tab is in the address (`/observe?tab=logs`), so you can share a link to one.

## What does each security check mean?

**What this install enforces** lists each check with a pill:

- **Enforced**: on, and checked by the cluster itself, not only by the console;
- **Off here**: this install has it turned off, or (for the audit copy) it has stopped; the text says which;
- **Not yet**: planned, not built.

The text under each one is read from this install's own settings, so it names the real allowed image sources, the gateway's allowed backend hosts, how long logs are searchable, and so on. The checks are:

| Check | What it means when enforced |
| --- | --- |
| Steps run only in team namespaces | A step's Job anywhere else is refused (`DISPATCH_REJECTED`) |
| Images only from allowed sources | A step's image must be under a listed source (`IMAGE_NOT_ALLOWED`) |
| Images pinned and scanned before they run | Every image is pinned to its digest and scanned; images in use are rescanned |
| Each step runs as its product's identity, with its team's secrets only | `IDENTITY_NOT_ALLOWED` for anything else |
| Teams' namespaces refuse traffic from other namespaces | Another team's steps can't reach your Pods |
| Catalog releases verified before they're applied | Only a release its trusted signer signed is applied |
| API products forward only what their reviewed specs describe | The gateway is running ([APIs](11-apis.md#what-does-the-gateway-check-in-order)) |
| Logs redacted, and searched only by who may see them | Log search is on |
| The console's writes fenced to team namespaces | The console's Secret, ServiceAccount and RBAC writes can't leave team namespaces |
| Single sign-on | People may sign in with single sign-on; a team can require it |
| Teams from the directory | Not yet: team membership is set in Vennir |
| A write-once copy of the audit log | The audit log is copied to storage that refuses deletes and overwrites ([the copy](#is-the-audit-log-intact-its-write-once-copy)) |

**Off here** is a choice the install's admins made, not a fault, except for the audit copy, where it can mean the copy stopped. If a check you rely on is off, ask an admin.

## What was refused, and why?

**Refused, last 7 days** lists three kinds of refusal, which the chips above it filter: **All**, **Cluster**, **Catalog**, **Gateway**.

- **Cluster**: steps the cluster wouldn't start, as `<team> · step <id>` with its image under it, and the code and what it means. These are the same codes a run shows when a step fails ([failure codes](09-runs-explained.md#what-does-each-failure-code-mean)).
- **Catalog**: the catalog's release, with its version (or digest) under it, when the console couldn't apply it (`CATALOG_NOT_APPLIED`, with the error).
- **Gateway**: calls the gateway answered itself instead of forwarding, as `<calling team> → <team>/<api>, N calls` with the endpoint under it, and the reason (`NOT_IN_SPEC`, `NOT_GRANTED`, `RATE_LIMITED` and so on; [gateway errors](11-apis.md#what-does-each-gateway-error-mean)). A call from no known team shows as `a caller with no team`.

The **Refused, 7 days** card at the top counts the rows. A gateway row stands for many calls, so the card counts rows, not calls.

## Is my product's image safe to run? Scans and SBOMs

**Every image allowed to run here** lists each registered product's image, with **Filter images**:

| Column | Shows |
| --- | --- |
| **Product** | The product, and its team |
| **Digest** | The start of the digest it's pinned to |
| **Last scan** | **Passed**, **Failed**, **Couldn't scan**, **Scanning** or **Not scanned**, with how many fixable findings and secrets it found, and `accepted: <reason>` when an admin accepted a failure |
| **Scanned** | When |
| **SBOM** | **Download** the image's software bill of materials, as catalog CI attached it (CycloneDX JSON). **None attached** when its catalog doesn't sign, or published it before SBOMs were attached |

The rule is catalog CI's: a HIGH or CRITICAL vulnerability that has a fix, or a secret baked into the image, fails a scan. Vulnerabilities with no fix yet are reported, not blocking. Images in use are rescanned regularly (the check's text says how often), because new vulnerabilities are published against old images.

The **Failing scans** card counts failed images that no admin accepted.

## What to do when a scan fails

A failed image can't be registered, and no new run or retry may use it; the cluster refuses it with `IMAGE_SCAN_FAILED`. Steps already running carry on.

| Last scan | Means | What to do |
| --- | --- | --- |
| **Failed** | A fixable HIGH or CRITICAL vulnerability, or a secret, is in the image | Rebuild on an updated base image or with the fixed package, and publish it through the catalog. If you can't fix it yet, ask an admin to accept it, with a reason |
| **Couldn't scan** | The scanner couldn't read it; it's tried again on its own | Wait and submit again; if it stays, tell an admin |
| **Scanning** | Its first scan hasn't finished | Wait a minute and submit again (`IMAGE_SCAN_PENDING`) |
| **Not scanned** | No scan recorded for its digest yet | It's scanned before it may run |

A secret found in an image is a leak, not just a finding: rotate that credential, then rebuild without it. Images are generic and secret-free; a product gets its secrets at run time ([Secrets, explained](04-secrets-explained.md)).

## Image scans, for admins

Admins open **Admin → Image scans** (also linked from the images list as **Every scan, its findings, and accepting one**). It lists every digest's scan, filtered by verdict (**All**, **Failed**, **Couldn't scan**, **Scanning**, **Accepted**, **Passed**, each with its count) or by **Filter by image or digest**, with when it was scanned and last used.

Click a scan to see its findings: each one's severity, id, package, and the version it's fixed in (the first 25; scan the image yourself for the rest). From there:

- **Rescan now** scans it again, for example after the advisory database changed;
- **Accept** lets a failed image run anyway. Write **Why it may run anyway** (10 to 2,000 characters). The reason is kept in the audit log and shown beside the image on Observe. It may run until a rescan finds something new.

Accepting is a risk you take on for the install. Prefer a rebuild; accept only what you've read.

## Reading the Metrics tab

The Metrics tab reads kernel-api's own tables, so it works with nothing else installed; only **Alerts** needs a Prometheus.

| Part | Shows | What to watch for |
| --- | --- | --- |
| **Waiting to start now** | Steps that are Ready but haven't started | A number that stays up means steps are queuing |
| **Running now** | Steps running | |
| **Started, 24 hours** | Every attempt, retries included | |
| **Failed attempts, 24 hours** | Failed attempts, by any code | |
| **Steps started, by hour** | Attempts started in each of the last 24 hours | |
| **Wait to start, 95th percentile** | From a step becoming Ready to its Pod starting, by hour | A rising wait means the cluster or the scheduler is short of room |
| **Why steps failed, last 24 hours** | Each failed attempt by its code, what the code means, and whether some were retried automatically | A platform code that keeps coming back ([failure codes](09-runs-explained.md#what-does-each-failure-code-mean)). A product's own codes are explained in its documentation |
| **Alerts** | Each of the charts' alerts as the install's Prometheus has it now: **Quiet**, **Pending** (true, but not yet for long enough) or **Firing**, firing ones first, with since when and what each fires for (an API, say). Shown when the console reads a Prometheus: the bundled one, the one the console chart's `monitoring.prometheusUrl` names, or Google Cloud's managed Prometheus on GKE (there, a firing alert shows its rule's summary and labels, since Google keeps no text of its own; **Unknown** when the console may not read it, saying what's missing) | Anything firing. An alert about an API you can't see is counted, not described |
| **Step times by product, last 7 days** | Per product and action: **Steps**, **Succeeded** (a percentage), **Median** and **95th percentile** run time, slowest first | A product that's slower or fails more than it used to |

For why a single step is waiting, see [Why is my step Ready but not running?](09-runs-explained.md#why-is-my-step-ready-but-not-running).

## Reading the Usage tab

The Usage tab reads the console's own record of every run, so it works with nothing else installed, and is at most a minute old. Choose **By team** or **By product**, and the last **24 hours**, **7 days** or **30 days**. Each team's last 7 days are also on its card on the **Teams** page.

A run counts for the team it was started for: a template's or an action's run for the team you chose to run it for, a DAG for every team its steps run in. Readiness checks don't count. Runs started for no team show under **No team**, for admins.

| Part | Shows |
| --- | --- |
| **Runs started** | Runs in the period, and how many in the period before it, as long. A DAG for several teams counts once here, and for each team below |
| **Steps** | The steps of those runs as submitted; retries aren't counted |
| **By team** | Per team: its runs, started by **people**, **bots** or **schedules**; their steps; the products they used, most first; and the teams its own products ran for (**itself** when it ran its own) |
| **By product** | Per product: its steps and runs, the teams whose runs used it, and when it was last used. An image that isn't a registered product shows by its repository, as does a product's image run outside its team's namespace, and a hidden product to anyone outside its team |

How runs ended (succeeded or failed) isn't here: it's on **Metrics**, by product.

## Prometheus, alerts and Grafana

Beyond **Alerts**, the console doesn't show Prometheus or Grafana itself; those belong to the install. Every component (kernel-api, the scheduler, the console and the gateway) serves Prometheus metrics, and an install can be set up with the Prometheus Operator, GKE's managed Prometheus, or a Prometheus of its own, with alerts (for example when the scheduler is down, steps wait too long, or a gateway backend is unreachable) and a Grafana dashboard for steps, the console and the gateway.

Whether your install has them, and where to find them, is your admins' to say; an admin sees on this tab which Prometheus this install uses, and a link to its Grafana when the install names it (the console chart's `monitoring.grafanaUrl`). How to set them up is in [operations](operations.md#metrics-and-alerts).

## Searching the logs

The **Logs** tab searches logs kept outside the run, when the install keeps them. If it doesn't, the tab says so; each run's page still shows its steps' output ([a step's logs](09-runs-explained.md#where-are-a-steps-logs-and-why-dont-i-see-all-of-them)).

Fill in what you know and press **Search**:

| Field | Narrows to |
| --- | --- |
| **Text to find** | Lines containing this text, any case |
| **From** | **Steps**, **API backends**, or (admins) **The platform** |
| **Team** | One team's namespace, or **Any** |
| **Run id** | One run's steps (only with **From: Steps**) |
| **API** | One API product's backend (only with **From: API backends**): its Pods labelled `vennir/api: <name>` |
| **Level** | `debug`, `info`, `warn` or `error`, or **Any** |
| **When** | **Last hour** up to **Last 30 days**, no further back than the install keeps searchable |

The newest lines come first. Each shows its time, level, and where it came from: a step's team, step and attempt with a link to its run; an API backend's team and app; or the platform component. When there are more matches than shown, the tab says **Only the newest N lines are shown**: narrow the search.

From a step on a run's page, **Search its logs in Observe** opens this tab with that run filled in, over the last 7 days.

Credentials a step or backend prints are redacted before anything is kept. Older logs than the search window are archived; only an admin can read them, with Loki's own tools.

## Whose logs can I see?

| Lines | Who sees them |
| --- | --- |
| Your teams' steps, every level | You |
| Another team's steps in a run you own (you submitted it, or it's a template run for your team) | Their `info` lines only |
| Another team's steps in runs you don't own (a raw DAG over your team and theirs that someone else submitted included) | No one but that team, the run's submitter and admins |
| An API backend's lines (Pods labelled `vennir/api-backend: "true"`), every level | Its own team and admins only: they belong to no run, so no caller sees them |
| The platform's own logs | Admins only |

A step's lines count as `info` only when it logs them as JSON with `"level": "info"`. Anything else, plain lines included, stays with its team. A product that wants its consumers to see progress logs it as JSON `info`.

## Reading the audit log

**Audit log** (headed **Who changed what**) lists every change anyone asked the console for, allowed or refused: secrets added, runs submitted, cancelled or retried, people added, APIs paused, images accepted, sign-ins, and so on. Secrets' values, passwords and tokens are never recorded. Reads aren't here: who was shown a run's outputs, failure messages or logs, or a team's secret names, is recorded apart, for admins (see [who read what](#who-read-what)).

| Column | Shows |
| --- | --- |
| **When** | When it was answered |
| **Who** | The person or bot (`bot`), or **The console** for what it did itself, such as applying a catalog release |
| **What** | The action, and the service it belongs to |
| **On** | What it acted on: a team, a secret's name, an image, a run (linked) |
| **Outcome** | **Done**, **Done, with problems**, **Refused** (not allowed), **Rejected** (a bad request) or **Failed** (an error) |

Filter with **Team**, **Only mine** and **Only refused or failed**, and press **Load older entries** for more. Each entry shows its number in the chain (**Entry**).

Admins see every entry. Anyone else sees their own, and what anyone (admins included) did to their teams or to runs in them. Entries about no team, such as users, the catalog, the gateway or policies, are for admins only.

## Who read what

The console also records who was shown sensitive content: a run's outputs or failure messages, its steps' logs (on the run or in log search), what its resources provided (listed, or filled into an order's plan), and a team's secret and secret store names. The chat agent's reads count as the person's it answered. Each record names what was read (the run, the teams, the steps seen in full, the secrets' names), never the content, with the reader's address. A step you weren't shown in full isn't recorded as read by you; opening a page that showed nothing sensitive isn't recorded, and a page that refreshes gets one record every 10 minutes for what it keeps showing, not one at each refresh: anything new it shows, or the same read from another address, is recorded at once.

These records are kept apart from the audit log, for 90 days by default (the console chart's `retention.auditReadsDays`), and only admins can read them, through the API (`AdminService/ListAuditReads`, by reader, team or run); reading them is recorded too. They have no page in the console yet.

## Is the audit log intact? Its write-once copy

Each audit entry is hash-chained to the one before it, so changing, removing or adding one breaks every later hash. When the install has its write-once copy turned on, the console regularly checks the new entries' chain and copies them to a bucket that refuses deletes and overwrites. It also compares the copy with the database, entry by entry, so even a change with every later hash rewritten shows.

On the **Audit log** tab, everyone sees the result above the list (nothing, when the copy is off):

- **Chain intact**, with when the chain was checked, last copied, and compared with the copy;
- a red message naming the entry where the chain breaks, or the entry that differs from its copy.

Admins see more under **Admin → Audit log copy**, in **The audit log's copy**: a pill (**Intact**, **Not copying**, **Chain broken**, **Changed since copied**, or **Off**), **Copied to** (the bucket), **Last copy**, **Waiting** (entries not copied yet), **Chain checked** and **Compared with the copy**. The same state is the last of Observe's security checks. Admins are also alerted, in the console and by email if they chose it: at once when the chain breaks or an entry differs from its copy, and when nothing has been copied for half an hour, or ever (once a day while that lasts).

## When something on Observe is red

| You see | Means | What to do |
| --- | --- | --- |
| A step under **Refused** (Cluster) | The cluster refused to start it; the code says why | Fix what the code names ([failure codes](09-runs-explained.md#what-does-each-failure-code-mean)), then retry the step |
| **CATALOG_NOT_APPLIED** | The latest catalog release couldn't be applied; the error says why | Tell the catalog's admins |
| A gateway refusal on your API | Callers are being stopped at the gateway | Open the API's page, **Endpoints and traffic** ([traffic](11-apis.md#watching-your-apis-traffic)) |
| A gateway refusal on your calls | Your team's calls to another API are refused | Read the code ([gateway errors](11-apis.md#what-does-each-gateway-error-mean)) |
| **Failed** on your product's image | Its last scan found a fixable vulnerability or a secret | [Fix it](#what-to-do-when-a-scan-fails) |
| A failure code climbing on **Metrics** | Many steps failing the same way | Read what it means; tell the product's team or an admin |
| **Wait to start** rising | Steps are queuing for room | Tell an admin: the cluster or the scheduler is short of room |
| **Not copying** on the audit copy | The copy stopped; the message says why (for example the bucket couldn't be reached) | An admin fixes what the message names |
| **Chain broken** or **Changed since copied** | An audit entry was changed, removed or added after it was written | Treat it as a security incident: tell your security team. The write-once copy holds the entries as they were written |

For more on what the platform enforces and why, see the [security model](security-model.md#audit).
