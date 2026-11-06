# Admin settings

This page is for the install's admins. It goes through every section of the **Admin** page in order: what each setting does, what it affects, and whether you change it in the console or it's set by the install. Install settings live in the environment's `vennir.yaml` (change one with `vennir config set -e <env> <key> <value>`, then `vennir apply <env>`) or, without `vennir`, in the console chart's Helm values. Each section has its own address, `/admin/<id>`, shown next to its name below. The list of sections down the side shows each one's state in a few words where the console knows it (such as **3 to finish**, **1 to adopt**, **In sync**). Each section opens with what it does, what's **Set here** and what's **Set by the install**, with this install's value beside each install setting the console knows (such as `jwtTtl` (this install: 8h)). Never a credential: an SMTP server's sign-in, a key or a token isn't shown. Only admins can open the Admin page; anyone else sees "Admins only".

| Section | Changed here | Set by the install |
| --- | --- | --- |
| [Overview](#overview) | Nothing: it shows status | Each optional part |
| [People](#people) | Accounts, admins, password resets | Self-registration, session length, the first admin |
| [Single sign-on and groups](#single-sign-on-and-groups) | The provider (unless the install sets it), group sources, group mappings | The provider, when `sso` is set |
| [Automation tokens](#automation-tokens) | Everything | Nothing |
| [Catalog](#catalog) | **Sync now**, **Adopt** | The release, its versions, its signature, an external catalog |
| [Image sources](#image-sources) | The allowed sources | Their first value, at install |
| [Image scans](#image-scans) | **Rescan now**, **Accept** | Whether scanning is on, how often |
| [API gateway](#api-gateway) | Closing and reopening it | Everything else |
| [Chat agent](#chat-agent) | The model, its provider and limits; questions per person | A default model |
| [Admins' alerts](#admins-alerts) | Which team's chat gets them | Email, webhook hosts |
| [Cluster policies](#cluster-policies) | **Write them again** | How often they're rewritten |
| [Audit log copy](#audit-log-copy) | Nothing: it shows status | The bucket |

## Install

### Overview

`/admin/overview`. The install at a glance. Nothing is changed here.

Across the top: the console's version and environment, how many **Teams** (and how many the catalog didn't make), **People** (and admins), **Products** (and the catalog version they came from), and how long **Runs** are kept.

**Needs you** lists what needs an admin now, each with a button to the section that settles it: images that failed their scan, no image source allowed, a catalog release that wasn't applied or a team it found but didn't make, cluster policies that weren't written, a problem with the audit log's copy, a chat agent whose settings can't be used, a closed gateway, and people who haven't chosen a password yet. With single sign-on reading groups, it also suggests (optionally) mapping a group to teams nothing maps.

**Getting this install ready** is a checklist shown until its required steps are done:

| Step | Done when | How |
| --- | --- | --- |
| Connect the catalog | A catalog release has been applied | `vennir catalog create <env>`. The first release is pulled within minutes |
| Allow an image source | At least one image source is allowed | Set at install, or in [Image sources](#image-sources) |
| Have a team | At least one team exists | A team folder in the catalog, or **Create team** on the **Teams** page |
| Add people | More than one account exists | In [People](#people) |
| Optional: single sign-on | A provider is set | In [Single sign-on and groups](#single-sign-on-and-groups), or `vennir sso google <env>` |

Once they're done, a **Ready to run** line says so instead.

**Every part, and where it's set** lists each part of the install by group, with its state and whether it's set **Here** (in this console), by the **Install** (vennir.yaml, then `vennir apply`), or **Both** (the install turns it on; it's run here). Each part with a section links to it:

| Group | Parts |
| --- | --- |
| People and access | Single sign-on, groups from the directory, automation tokens, self-registration (`allowSelfRegistration`) |
| Catalog and images | The catalog release, its signature, image sources, image scans |
| Integrations | The API gateway, the chat agent, admins' alerts, log search (`logs.enabled`, `logs.searchDays`), metrics (which Prometheus, and a link to Grafana when the console chart's `monitoring.grafanaUrl` names it) |
| Security and audit | Cluster policies, the audit log's copy, run records (kept 90 days unless the console chart's `retention.executionDays` says otherwise; keep it equal to the kernel chart's `executionRetentionDays`) |

Two install settings have no section of their own:

- **Monitoring.** Observe's **Metrics** tab works with nothing installed. For Prometheus, `monitoring` in vennir.yaml chooses the cluster's Prometheus Operator (`operator`), GKE's managed one (`google`), or one the console chart runs (`bundled`). The console chart's `monitoring.dashboard.enabled` adds a Grafana dashboard, and `monitoring.grafanaUrl` says where that Grafana is, for the link here and on Observe's **Metrics**. See [operations](operations.md#metrics-and-alerts).
- **Email.** Notifications go by email only when the console chart's `notifications.email` names an SMTP server: [Admins' alerts](#admins-alerts) names it and the address mail comes from. Each person chooses which kinds they get in their preferences.

## People and access

### People

`/admin/people`. Who has an account, and how they sign in.

**Signing in** says whether single sign-on is on, and lists the teams that require it.

**Add a person** creates an account:

- **Email**: the email they sign in with.
- **Teams**: the teams they work on. Retired teams can't be chosen. They join each team chosen as a maintainer, so a new team's first person can manage it. Its maintainers can change roles later.
- **Admin of this install**: makes them an admin.

They get a temporary password, shown once. Copy it and send it to them privately: they must choose their own (at least 12 characters) when they first sign in. If single sign-on is on and one of the chosen teams requires it, a non-admin gets no password and signs in with single sign-on as that email.

**Everyone** lists every account: how each signs in, their teams, whether they're an admin, and when they last signed in. **All**, **Admins** and **To finish** (people who haven't chosen a password yet) choose who's shown, and **Find a person or team** filters the list. A person can be marked "Hasn't chosen a password yet" or "No team yet". The **⋮** menu next to each person has:

| Action | What it does |
| --- | --- |
| **Make admin** / **Remove admin…** | Gives or takes admin access at once; their teams stay. The last admin can't be removed |
| **Reset password…** | Sets a temporary password and signs them out everywhere. They choose their own when they next sign in. Only for accounts that have a password |
| **Open *team*'s members** | Opens one of their teams |
| **Delete…** | Removes the account, its team memberships and its tokens. Runs they started stay in the history, shown as from a deleted account. Can't be undone, and you can't delete yourself or the last admin |

Bots aren't managed here. They're on each team's **Automation** tab.

Set by the install:

| Setting | What it does |
| --- | --- |
| `admin.email` (vennir.yaml), `bootstrapAdmin` (chart) | The first admin account |
| `jwtTtl` (chart) | How long a session lasts, `8h` by default |
| `allowSelfRegistration` (chart) | Lets anyone who can reach the console sign up. Off by default; only for a console behind a trusted network |

If no admin can sign in, run `vennir admin reset-password <env>` from a machine with access to the cluster.

### Single sign-on and groups

`/admin/sign-in`. Optional. People may sign in with an OpenID Connect provider (Google, Entra ID, Okta, Keycloak and others). Passwords keep working, except for members of teams that require single sign-on. Admins can always use their password, in case the provider can't be reached.

**The provider.** If the install sets one (`sso` in vennir.yaml, made with `vennir sso google <env>`; or the console chart's `sso`), this section shows it read-only: change it with `vennir sso` and `vennir apply`. Otherwise you set it here:

| Field | What it is |
| --- | --- |
| **People may sign in with single sign-on** | Turns it on or off. Turning it off stops people who have no password from signing in, and teams that require it accept passwords again meanwhile |
| **Button's name** | The sign-in button's label, such as Google or Okta (at most 40 characters) |
| **Issuer** | The provider's `https://` URL, such as `https://accounts.google.com`. Saving checks that its discovery document answers |
| **Client ID**, **Client secret** | The OAuth client registered with the provider. The secret is kept encrypted and never shown again; type a new one to replace it |
| **Redirect URL** | The console's address + `/api/auth/oidc/callback`. Register exactly this with the provider |
| **Email domains allowed** | Comma-separated, such as `example.com`. Only these accounts may sign in |

Saved settings reach every copy of the console within seconds. Someone signing in for the first time gets an account in no team.

**Where groups come from.** Always set here, whoever set the provider:

- **Groups claim**: the ID token claim listing a person's groups, usually `groups` for Entra ID, Okta and Keycloak. Empty means none.
- **Google Workspace groups too**: reads Google groups with Cloud Identity's Groups API, as the console's own Google account. A Workspace admin must make that account a Groups Reader. On GCP, `vennir sso google-groups <env>` then `vennir apply` enables the API and names the account.

A sign-in whose groups can't be read is refused. It is never treated as "no groups".

**Groups mapped to teams.** Enter a **Group** (as the provider sends it, or a Google group's email), a **Team** and a **Role**, then click **Map**. At each sign-in, a mapped team's membership follows the person's groups: they're added with the best role their groups give, or removed. When Google Workspace is the only source, the console also rereads groups every hour. A groups claim is read only at sign-in, so while one is set and single sign-on is on, a session in which a group gave someone a team lasts an hour at most, and a team a group gave counts only in a single sign-on session from the last hour (the gateway checks the same). Teams with no mapping, bots, and password users are managed by hand. A retired team can't be mapped. See [single sign-on groups](13-teams-and-roles.md#how-do-single-sign-on-groups-decide-who-is-in-a-team).

**Save**, under where groups come from, saves the provider and the group sources together; **Discard changes** puts back what's saved. Each mapping is saved when you click **Map**, and the teams nothing maps are listed under them.

Whether a team requires single sign-on is set on that team's **Settings** tab ([team settings](13-teams-and-roles.md#what-are-a-teams-settings)).

### Automation tokens

`/admin/tokens`. Install-wide tokens for automation of your own. A token belongs to no team, so it can't read secrets, submit tasks or create other tokens. It can do only what's ticked:

| Permission | Lets it |
| --- | --- |
| `teams:create` | Create teams and their namespaces |
| `products:register` | Register and update any team's products |
| `teams:retire` | Retire or restore a team |
| `teams:delete` | Purge a retired team for good. Give this to a token of its own |
| `secret-stores:apply` | Apply a team's reviewed SecretStore file |

Give it a **Label** and choose when it **Expires after**: 30 days, 90 days (the default), 1 year, 2 years, or **Until revoked**. **Create token** shows the token once; store it as a secret wherever the automation runs. **Revoke** stops it immediately.

The catalog needs no token: the console reads the catalog's release itself. Tokens for a team's own pipelines are bots, on the team's **Automation** tab.

## Catalog and images

### Catalog

`/admin/catalog`. Where teams, products, templates and SecretStores come from. Catalog CI publishes a release from the catalog repository's `main`. The console reads it every few minutes, checks its signature, and applies it. Products, teams or SecretStores a release no longer has are unregistered or retired here, never purged.

**The release** shows:

- **Applied release**: the version and commit applied last, and the repository (a newer one that failed its checks shows under Applied).
- **Signature**: whether each release's signature is checked before it's applied.
- **Applied**: when, and what the release held: its teams, products (with their actions, when a product has several), templates, APIs and SecretStores.
- **Release**: the release followed, or "the newest version of" its repository; **Last looked**: when the console last read it.
- An error, if the last attempt failed. Nothing is applied from a release that failed its signature check.

**The last release was applied except** lists each item that wasn't applied, and why.

**Sync now** reads and applies the release at once.

**Adopt** appears next to a team the catalog found already here but didn't make (`a team named … already exists here and the catalog didn't make it`). Adopting lets the catalog manage it: releases register its products, apply its SecretStores, and retire it if its folder goes. Its members, secrets and history stay. Adopt only if the catalog's folder is meant to be this team; otherwise rename the folder.

Set by the install:

| Setting | What it does |
| --- | --- |
| `catalog` (vennir.yaml, made by `vennir catalog create`); `catalog.release` (chart) | The catalog repository and the release this console reads. Empty: no catalog, so teams and products are only what admins make |
| `catalogVersion` (vennir.yaml); `catalog.newestVersion` (chart) | Which releases to apply: every one `main` publishes (`latest`), the newest `vX.Y.Z` (`newest`), or one version pinned. See [operations](operations.md#catalog-versions) |
| `signing` (vennir.yaml); `catalog.signature` (chart) | Who may sign releases: a key (`kms`), or catalog CI's own identity (`keyless`). With none, releases aren't verified |
| `externalCatalog.registry` and `catalogSignature` (vennir.yaml) | Read another install's catalog instead of owning one, and trust its signer. This page shows it "as configured": nothing the console reads confirms it. See [operations](operations.md#reading-another-installs-catalog) |
| `catalog.pollSeconds` (chart) | How often the release is read, 300 seconds by default |

Admins are alerted when the catalog hasn't been pulled for 30 minutes.

### Image sources

`/admin/images`. The registry paths task images may come from. The cluster refuses any other image when a step starts, however it was submitted (`IMAGE_NOT_ALLOWED`). A save takes effect for every team at once.

- **Source registry**: where catalog CI publishes product images, such as `us-central1-docker.pkg.dev/my-project/catalog-products`. Required.
- **Add a source**: more allowed paths, such as `docker.io/library`. Base images a Dockerfile builds from don't need listing: they're part of the published image. Where the install requires signed images (below), an added source's images still don't run: only images catalog CI signed, from the source registry, do.
- **Save image sources** saves both; **Discard changes** puts back what's saved. Under them: who last saved them here, and when (from the audit log).

Each entry is a path prefix. Saving a whole registry host, such as `docker.io`, asks you to confirm: any image anyone has published there could run. Prefer a specific path.

If no source is set, no task can run. If the card says the cluster's image policy doesn't exist, the kernel chart isn't installed: installing or upgrading it creates the policy.

Set by the install: the first value only. `taskImages.registry` in vennir.yaml (or `externalCatalog.registry`), or the kernel chart's `imagePolicy.sourceRegistry` and `imagePolicy.additionalSources`, seeds the list when the kernel is installed. Upgrades keep whatever you saved here.

Admins are alerted when the image sources change.

**What an image passes before it runs** lists the four checks the cluster makes when a step starts: it comes from an allowed source (`IMAGE_NOT_ALLOWED`), it's pinned to a digest (`IMAGE_NOT_PINNED`), it passed its scan (`IMAGE_SCAN_FAILED`), and, when the install requires it (the kernel chart's `imageSignature`), it's signed by catalog CI and from the source registry, which images from added sources aren't (`IMAGE_NOT_SIGNED`). Whether it's required is read from the cluster: the kernel chart's signature policy is there or not; if the console can't read it, the page says so.

### Image scans

`/admin/scans`. Every image is scanned before it's registered or run, and again daily while it's in use. A scan fails on a HIGH or CRITICAL vulnerability with a fix available, or a secret in the image. A failed image can't run: the console refuses it, and so does the cluster (`IMAGE_SCAN_FAILED`), which runs only the digests the console has seen pass (or an admin accepted) and that are still in use. Steps already running aren't stopped.

Filter the list by verdict: **Failed**, **Couldn't scan**, **Scanning**, **Accepted** or **Passed**. You can also filter by image or digest. Click a scan to see its findings: severity, finding, package, and the version that fixes it. In the scan you can:

- **Rescan now**: scan it again.
- **Accept**: let a failed image run anyway. Enter **Why it may run anyway** (10 to 2,000 characters), which is kept in the audit log. It may run until a rescan finds something new.

Every image allowed to run, with its last scan, is also on Observe's **Security checks** for everyone.

Set by the install, in the console chart's `scanning`: `enabled` (on by default), `rescanHours` (24), and `waitSeconds` (60): how long a submission waits for an image's first scan before asking the caller to try again.

## Integrations

### API gateway

`/admin/gateway`. One front door for every team's API products. It signs callers in, lets through only what each API's reviewed OpenAPI file describes, and forwards the request to the API's backend.

If the gateway isn't running, the section says so: turn it on with `gateway.enabled` in vennir.yaml. Otherwise it shows its state, the APIs published, the requests in the last 24 hours, and how many were refused at the door.

**This install's settings** shows, read-only:

| Shown | Install setting |
| --- | --- |
| **Backends may be under** | `gateway.backendHosts`: an API whose backend isn't under one is held, not published |
| **May publish to the internet** | `gateway.internetTeams` |
| **Inside the cluster** | `gateway.url` |
| **From the internet** | `gateway.publicUrl`, with `gateway.publicListener` |

These change with `vennir apply`, not here. See [operations](operations.md#the-api-gateway).

**Close the gateway…** takes a **Message to every caller**, and asks you to confirm. While it's closed, every API answers 503 with that message and nothing is forwarded. The console and runs carry on. **Reopen** undoes it. Both are recorded in the audit log. The console chart's `gateway.closed` keeps it closed from the install's side. A team's maintainers can pause one of their own APIs from its page.

**Refused at the door, last 24 hours** lists why requests were stopped (not in the API's spec, didn't match it, not signed in, not shared with the caller's team, over a limit, paused, and so on), what the gateway answered, how many, and the team most of them came from. Each one, with its caller, is in Observe.

### Chat agent

`/admin/chat`. The model that answers in Ask: questions from the docs, and carts from the catalog.

**The model** sets it. The card says whether these are the install's settings or ones set here, and by whom. Saving your own replaces the install's until you click **Use the install's**.

| Field | What it is |
| --- | --- |
| **People may ask the chat agent** | Turns it on or off |
| **Provider** | Choose one: Gemini on Vertex AI, Claude in Amazon Bedrock, Claude through Anthropic's API, or an OpenAI-compatible server (LM Studio, Ollama…) |
| **Model** | Its name at that provider. Empty on Vertex AI means Gemini 3.5 Flash; on Bedrock, Claude Sonnet 5 |
| **Google Cloud project**, **Location** | Vertex AI only. No key: the console signs in as its own Google identity, which needs `roles/aiplatform.user` there |
| **AWS region** | Bedrock only. No key: requests are signed as the console's own AWS identity |
| **Server's address** / **Address (optional)**, **API key** | Anthropic's API or an OpenAI-compatible server. The key is kept encrypted and never shown again |
| **Limits** | **Thinking**, **Steps per answer** (8 by default), **Context window (tokens)**, **Reply length (tokens)**. These bound each answer's cost |

**Test** asks the model one question through the agent, as you, before you save. **Save** applies it within seconds. If the saved settings can't be used, the card says why and the chat agent is off.

What the agent is sent reaches the model's provider. On a cloud, choose the install's own cloud.

**Questions per person** sets how many questions each person may ask: **An hour** (30 by default) and **A day** (200 by default, and at least the hour's), 1 to 10,000 each. Each question can take several model calls, so one more is refused (`RATE_LIMITED`) until that person's hour or day is up. Only questions the agent answers count, and bots can't ask at all. **Save** applies them on every console at once; **Use the defaults** saves 30 and 200 again. The card says who set them, and when, once an admin has. The API is `ChatService/SetChatLimits` (`perHour`, `perDay`).

**Chat answers** lists what people rated in Ask, filtered by **Wrong**, **Good** or **All**, with the question, comment, answer and the docs it cited. A wrong answer is usually a doc to fix, because the agent answers from the docs. Ratings are kept 90 days.

Set by the install: `chat` in vennir.yaml on gcp and aws (`chat.off`, `chat.model`); elsewhere, the console chart's `chat` values (`provider`, `model`, `endpoint`, `apiKeySecret`). See [operations](operations.md#the-chat-agent).

### Admins' alerts

`/admin/alerts`. Admins get alerts in the console, such as a team purged, the image sources changed, a policy not syncing, the audit log's copy stopped or its chain broken, the catalog not pulled, or a step the cluster refused. They also get them by email, if they chose that kind and the install sends email.

**Team** chooses a team whose chat webhook gets them too, then **Save**. That team's maintainers set the webhook, and which alerts it gets, on its **Settings** tab. **None** posts them nowhere else.

Set by the install: `notifications.email` (an SMTP server) and `notifications.webhookHosts` (the hosts a team's chat webhook may be under) in the console chart.

## Security and audit

### Cluster policies

`/admin/policies`. The cluster's admission policies. The cluster refuses any step these don't allow, whatever the console says.

**Written by the console** lists the ones the console writes, with the code a step it stops fails with and when each was last written:

| Policy | What it holds |
| --- | --- |
| Products, and the identities and secrets each may use | Which ServiceAccount each product runs as, and which of its team's Secrets a step may mount (`IDENTITY_NOT_ALLOWED`) |
| Images that failed their scan | [Image scans](#image-scans) (`IMAGE_SCAN_FAILED`) |
| Registry sign-in for each team | The pull secret each team namespace uses to fetch images from private registries |
| What each team's steps may reach | Each team namespace's network policies: no other team's Pods, and only the gateway into its API backends |
| The scheduler's log reading | Lets the kernel's scheduler read its steps' logs in team namespaces, and nothing else |
| What each team may use together | Each team namespace's quota and per-step memory ceiling: its own, or the install's |

One this install doesn't have the console keep says **Not used here**. The card shows **In sync**, or how many weren't written, with each one's error. The console rewrites them when products, secrets or image sources change, at startup, and every 5 minutes (the console chart's `policySyncIntervalSeconds`). **Write them again** rewrites them now. Admins are alerted when one has been failing for 10 minutes. Where images may come from ([Image sources](#image-sources), `IMAGE_NOT_ALLOWED`) is written when they're saved.

**Installed with the kernel** lists the admission policies the kernel chart installs, which hold however the console is set: where steps may run (`DISPATCH_REJECTED`), where images may come from (`IMAGE_NOT_ALLOWED`), images pinned (`IMAGE_NOT_PINNED`), catalog images signed when the install requires it (`IMAGE_NOT_SIGNED`), and who may delete a team's namespace. An upgrade changes them, not this page.

**Steps the cluster refused** says how many steps it refused in the last 24 hours, and leads to them in Observe.

### Audit log copy

`/admin/audit`. The console's audit log is hash-chained: changing, removing or adding an entry breaks every later hash. Nothing checks the chain until it's copied to a bucket that refuses deletes and overwrites. **The audit log's copy** shows that copy's state:

| Status | Means |
| --- | --- |
| **Off** | No copy: the log is only in the console's database, and nothing checks its chain. Turn it on with `audit.export` in vennir.yaml (gcp, aws), or the console chart's `audit.export.bucket` |
| **Intact** | The chain held, and the copies match the database |
| **Not copying** | The last copy failed. The reason is shown |
| **Chain broken** | An entry was changed, removed or added after it was written. Nothing from there on is copied |
| **Changed since copied** | An entry differs from its copy in the bucket |

It also shows how many entries are copied and how many are waiting for the next copy, **Copied to**, **Last copy**, when the **Chain checked**, and how far it's **Compared with the copy**. **Read the audit log in Observe →** opens the log itself.

Set by the install: `audit.export`, `audit.keepDays` and `audit.lock` in vennir.yaml. This page shows the last two "as configured": the bucket enforces them, and the console can't read them back from it. `audit.lock` makes the bucket's retention permanent: nobody can shorten it or delete the bucket until it lapses. Decide before you set it. See [operations](operations.md#the-audit-logs-copy).
