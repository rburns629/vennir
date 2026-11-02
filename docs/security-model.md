# Security model

How Vertra keeps each team's secrets to that team's reviewed products: what's
enforced today, by which layer, what isn't enforced yet, and what's out of
scope. Written for security reviewers evaluating Vertra, and kept honest:
where something is a plan rather than a fact, it says so.

Last reviewed 2026-10-28, for 0.x. Vertra is not production-ready yet; the
gaps in [Not yet enforced](#not-yet-enforced) are why.

## At a glance

| Question | Answer |
| --- | --- |
| Where do secret values live? | In Kubernetes Secrets, in the owning team's namespace. Synced secrets keep their source of truth in the team's own store (GCP Secret Manager and others, through External Secrets Operator). |
| Does Vertra's database store secret values? | No. The console stores which secrets each team registered, and the names of their keys, never values. The kernel never sees them. |
| Who can read a secret? | Steps of its team's registered products that list it in `secretRefs`, and cluster administrators. Not the console: it writes Secrets but has no right to read them. See [Who can read a secret](#who-can-read-a-secret). |
| Can one team's step reach another team's secret? | No. A step runs in its own team's namespace, and a Pod can only mount Secrets from its own namespace. |
| Can one product reach another product's secret in the same team? | By design, yes: a team's secrets are the team's, and the team chooses per step which ones it gets (`secretRefs`). What a team can't do is give one to an image that isn't its registered product (it runs with no secrets), or mount a Secret it never registered. The console checks this at submit time, and an admission policy makes the cluster enforce it on every step's Job. A product's own cloud identity (its declared ServiceAccount) is still its own: another product can't run as it. |
| Can a team register another team's product, or its image, as its own? | No. A product name and an image repository belong to the first team that registers them, the repository even after its products are deleted (an admin can release an unused one). Catalog CI also derives each image's path from its team's folder, so one team can't publish under another's name. |
| Can anything but the console submit work? | No. kernel-api accepts only the console's ServiceAccount token, issued for kernel-api alone and checked with a TokenReview. See [How kernel-api knows its caller](#how-kernel-api-knows-its-caller). |
| Is anything enforced if the console is bypassed? | Yes: which namespaces steps may run in, which image sources they may use, that images are pinned and passed their scan, which ServiceAccount and Secrets a step may have, image signatures (with Sigstore's policy-controller installed) and who may delete a team namespace. These are admission policies the Kubernetes API server applies to the scheduler's Jobs. They don't hold if the console itself is compromised: it can rewrite three of them. See [If a component is compromised](#if-a-component-is-compromised). |
| Are secrets encrypted at rest? | That depends on the cluster. Enabling encryption of Secrets at rest in etcd, ideally with a KMS provider, is the cluster operator's responsibility and a prerequisite for production. |
| Is Vertra's own data encrypted at rest? | Only the few credentials the console keeps itself. Step inputs, outputs and logs, and the audit log, are plain in Postgres; encrypting its disks and backups is the operator's. See [What Vertra stores](#what-vertra-stores). |
| Is traffic inside the cluster encrypted? | Yes, with each chart's `tls` (on by default): kernel-api serves HTTPS and the bundled Postgres instances accept only TLS, each with a certificate from its chart's own CA, which every client checks (`verify-full`). Metrics ports and the scanner's are plain; NetworkPolicies limit who reaches them. See [What Vertra stores](#what-vertra-stores). |
| Where are the database passwords? | With the bundled Postgres, generated on install and kept in the releases' Secrets. With a managed database (`database.type: managed`) there are none of Vertra's: each service signs in as its own cloud identity with a short-lived token (IAM database authentication; Cloud SQL: an hour's Google token; Amazon RDS: a 15-minute token its role signs), over TLS checked against the server's CA, from inside the install's network only. A separate administrator identity, used only by `kernel database-setup`, opens each database to its own service alone; on RDS, whose administrator must have a password, RDS keeps it in Secrets Manager, readable only by that identity. See [Databases](operations.md#databases). |
| What reaches logs and outputs? | Whatever a step prints or returns. Vertra stores step outputs and logs; a product must never print or return a secret. |

## Who is trusted

| Actor | Trusted to | Limited by |
| --- | --- | --- |
| Cluster administrators | Everything; they can read any Secret | Outside Vertra's control |
| Vertra admins (console) | Manage teams, people, bots, allowed image sources; act in any team | Console authorization; every admin action is logged |
| Catalog reviewers | Decide which product images exist, and which ServiceAccount and secrets each product declares | The catalog repository's review rules (CODEOWNERS, protected branches) |
| Team maintainers | Manage their team: its people and their roles, register its secrets and choose which step gets which, its bots, raw DAGs, cancelling its runs | Console authorization (`auth/access.ts`): the maintainer role, per-product identity, registered team secrets |
| Team members | See their team's runs, logs, Pods and secrets' names; run its actions and what's shared with it | The member role: nothing they can change |
| Product images | Do their one job with the inputs and secrets they're given | Their namespace, ServiceAccount and mounted secrets; admission policies |
| Pipelines (bots) | A team's bot: what a maintainer of its team may do; an ordering bot, only its listed templates; an automation token, only its scopes, in no team | Hashed API tokens that expire (90 days unless their maker chose otherwise) or are revoked; `auth/access.ts`'s `ensureMayOrder`. See [Bot tokens](#bot-tokens) |

## Where secret values live

A secret enters in one of two ways, and ends up the same way:

1. **Pasted** on the console's Secrets tab. The value passes through the
   console in the request and is written straight into a Kubernetes Secret in
   the team's namespace (`console/src/k8s.ts`). It isn't stored in the console's
   database or written to its logs (request logging records method, URL and
   status, not bodies).
2. **Synced** from a team's own store. The console creates an ExternalSecret,
   which is only a reference; External Secrets Operator reads the value with the
   team's SecretStore identity and writes the Kubernetes Secret. The console
   never holds the value. SecretStores themselves arrive through a reviewed
   catalog pull request (in the catalog's release, which the console pulls
   and verifies), never from the console's own UI.

Either way, the console **registers** it for the team (`secret_grants`): the
secret's name and its key names. Only registered secrets can be mounted, and
only by the team's registered products.

- The console labels what it creates (`app.kubernetes.io/managed-by:
  vertra-console`) and won't replace, or register, a Secret it didn't
  create, such as a SecretStore's own credentials: that's refused with a 409.
  So a SecretStore's credentials can never be mounted by a step.
- No RBAC is involved: mounting doesn't consult it, and steps don't read
  Secrets through the API. The console creates no Roles (older versions made
  one per secret; the console removes them at startup).
- Revoking a secret (Team page, or `SecretService/RevokeSecret`)
  removes the registration and the Secret or ExternalSecret the console
  created. Tasks already running keep what they mounted.

### What a secret can hold

A secret is a set of named keys, each mounted as a file at
`/platform/secrets/<secret>/<key>`; Vertra doesn't interpret the values.
Typical shapes: one opaque value under `value` (an API key, a webhook
signing secret); a credential in several keys of one secret (`clientId` and
`clientSecret`, `username` and `password`, `tls.crt` and `tls.key`); or a
whole credential file under one key, for a platform with no federation to
use instead. Prefer workload identity wherever the target supports it: then
there's no secret at all.

A step that has a credential sends it to the service it authenticates to;
these rules decide which step can have it, where (one Pod) and for how long
(that process), not whether the credential exists. Short-lived credentials
(workload identity, a vault's dynamic secrets) are what shorten that window.

### Syncing secrets from a vault

A team that keeps its secrets in a vault (GCP Secret Manager, Azure Key
Vault, AWS Secrets Manager, HashiCorp Vault, 1Password) syncs them through
External Secrets Operator, an optional component. Two objects, provisioned
by different people on purpose:

| Object | Says | Who creates it |
| --- | --- | --- |
| **SecretStore** | This namespace may read this vault, as this identity: a scope grant | The team proposes it in the catalog (`teams/<team>/secret-stores/`); catalog admins approve; the console applies it after checking it only names a store in the team's namespace, ESO's own ServiceAccounts, and, for a store that needs a stored credential, the Secret `eso-auth` |
| **ExternalSecret** | Sync this key from that store into this Secret: a reference | Team members, self-service, on the Secrets tab |

So a team can sync as many secrets as it likes without ever widening what
its store can reach. And a store's cloud identity is its team's alone: the
console records the Google service account, AWS role or Azure identity each
team's stores sign in as (their ESO ServiceAccounts' bindings, and a role a
store assumes) and refuses another team's store naming one
(`IDENTITY_IN_USE`; the catalog's `secret-stores check` says so in the pull
request). A binding made only on the cloud's side (a Workload Identity
principal for the namespace, say) isn't in the file, so keeping that one per
team is the cloud administrator's. Both are namespaced (never a ClusterSecretStore): an
ExternalSecret can't use another namespace's store, even applied by hand. A
store's own credential (for a vault that can't federate, such as a
1Password service account token) is set per install by a team member or
admin (Team page → Secrets → Stored credential, `TeamService/
SetSecretStoreCredential`), never carried by the catalog; it's written to
`eso-auth`, and can never be registered or mounted by a step. A synced secret rotates on the vault's side, with no
change in Vertra.

| Vault | Sign-in | Stored credential | Proven |
| --- | --- | --- | --- |
| GCP Secret Manager | GKE Workload Identity | None | Yes |
| Azure Key Vault | AKS Workload Identity | None | Not yet (`catalog-template/samples/azure`) |
| AWS Secrets Manager | IRSA (the cluster's OIDC issuer registered in IAM) | None | Yes (2026-10-27, EKS) |
| HashiCorp Vault | Vault's Kubernetes auth | None | Not yet |
| 1Password | A service account token | One, in `eso-auth` | Not yet |

## How a secret reaches a step

1. A team submits a DAG through the console. Each step names its team
   (its namespace) and any `secretRefs`; its `serviceAccount` is optional,
   filled in with its product's own (or `default`).
2. The console checks, before anything runs
   (`console/src/core/executions.ts`):
   - the caller maintains every team named, or is an admin;
   - the step runs as the ServiceAccount its product declares in the catalog,
     or as `default`; only a registered product may mount secrets at all;
   - each secret in `secretRefs` is registered for the step's team.
     (An action's `secretRefs` in product.yaml are recorded as its bindings;
     they don't restrict yet. Once consumers run templates, each step will
     use its action's own.)

   The console reads these fields by their documented names (`serviceAccount`,
   `secretRefs`), and builds kernel-api's request from exactly those names,
   refusing any other (`service_account`, `secret_refs`;
   `console/src/kernel/client.ts`): otherwise a submission could show the
   console one identity and give the kernel another.

   Retries and reruns are checked again against current memberships and
   secrets.
3. The kernel starts the step as a Kubernetes Job in that namespace, running
   as that ServiceAccount, with each secret mounted read-only at
   `/platform/secrets/<name>/`. The kernel itself has no permission to read
   Secrets.

Mounting happens through the kubelet, which doesn't consult the Pod's RBAC. That
is why this check exists: RBAC can't stop any Pod in the namespace from
mounting any Secret there. The console makes it in step 2, and the
cluster makes it again when the scheduler creates the Job (the identity
policy, below), so it holds even for a Job the console never checked.

## Consumers and templates

Running a team's template (`TemplateService`) needs no membership of the
teams its steps run in. Who may run one: its team's members, admins, and
whoever its `shareWith` covers (everyone, `*`, or members of the teams it
lists, who then run it on behalf of one of them). What runs is built by the
console from the registered products its steps name
(`console/src/core/templates.ts`): each step's image, ServiceAccount,
secrets (its action's `secretRefs`), token audiences and namespace are the
product's; the person running it supplies parameters, checked against the
template's schema, and nothing else. A step of another team's action needs
that action shared with the template's team: the team whose identity does
the work consents through its `shareWith`, checked by catalog CI, when a
release is applied (such a template isn't stored), on every run and on
every retry. Then every check a submission gets applies (identity,
registered secrets, images, scans), and the cluster's policies hold as for
any Job.

Where another team may aim a team's products is the owning team's: an
input typed as a target (`x-vertra-needs: gcp.project`, `gcp.folder`,
`aws.account`, `azure.subscription`) must match its team.yaml's
`allowedTargets` for the running team, or the run is refused before it
starts (`TARGET_NOT_ALLOWED`, `console/src/targets.ts`). The owning team's
own runs aren't limited. A value another step will produce isn't known at
submit: the input schema the console attaches for the kernel is narrowed to
the patterns the rules allow without an approval, so the kernel refuses
any other value once it's resolved, before the step starts
(`INPUT_INVALID`); with none allowed, the run is refused at submit. That
matters since carts (decision 25) let a member wire any product that
provides a target type into another team's (since 2026-10-28; before, a
step's output went unchecked). The identity's cloud permissions, scoped to
the same folders, hold if the console's check is ever bypassed.

The chat agent (decision 24, `console/src/chat/`) acts as the person
asking: each tool calls the console's own code with their identity, so it
sees what they may, and its only effect is a proposed cart, which they open
and place themselves. Ordering bots can't use it. Its answers' citations
are kept only when they name a section it retrieved, and links are the
console's, not the model's. It answers only about Vertra: a question
judged not about it (by a separate, tool-less call that treats the
question as data) gets a fixed sentence and never reaches the agent, and an
answer resting on neither the docs it cites nor its tools' results is
replaced, so neither a question that talks it out of its instructions nor
the model's memory can put an answer in front of someone. A conversation
is bounded by `chat.contextTokens`. Admins may set its model in the console
(`console/src/core/chatSettings.ts`): its key sealed with a key derived
from `JWT_SECRET`, write-only. An address an admin gives is fetched by the
console from inside the cluster, so testing one reports only whether it
answered as a model, never what it replied. On GCP it's Gemini through Vertex AI in
the install's own project, as the console's Workload Identity; on AWS,
Claude in Amazon Bedrock in the install's region, each request signed as
the console's own role, which may call that one model and nothing else
there (`bedrock-mantle:Model`, proven on EKS 2026-10-28: the role's call
for its model passes IAM, one for any other is refused by it; the scanner's
Jobs have a role without it). Either way: no key, and nothing leaves the install's cloud. What's asked, and what its tools return, goes to
the install's chat model (`chat.endpoint`): the conversation, doc sections,
the offerings shared with the person, their team's resources (each one's
type, id, name and what it provides) and, for a run they may see, each
step's state, outputs and failure message (`console/src/chat/tools.ts`,
`get_run`; a provider's member gets only what [the run's
page](#who-sees-a-run-that-spans-teams) shows them). With `anthropic`, or
an `openai-compatible` address (the chart's or an admin's) outside the
install, all of that leaves the install's cloud. Nothing is kept by the console,
except an answer someone rates: its question, answer, sources and their
comment, for the admins only (`ChatService/RateAnswer`, a rating for a
team only by its members), deleted after 90 days.

A member checks out a cart as one run for their team (`OrderService/
PlaceOrder`, `console/src/core/orders.ts`): each step is an action shared
with them, run as it would be alone (its product's image, identity and
secrets, its targets checked as above), so it's no more than they could run
step by step; no raw DAG, and ordering bots still order templates only.

A team can also make a step wait for a person (approvals): product.yaml's
`approval` (`always`, `otherTeams` for another team's runs, or a list of
the teams whose runs need one), or an
`allowedTargets` rule's `approval: true`. The console marks such a step
`approvalRequired` (a submitter can't set or clear it), and the kernel holds
it in `AWAITING_APPROVAL`, never claimed, until a maintainer of the step's
team approves it. The person who submitted the run can't decide, even as a
maintainer, so two people agree before it runs (`console/src/core/
approvals.ts`). Each decision is in the audit log and, with who decided, in
the step's events; a declined or expired step fails (`APPROVAL_DECLINED`,
`APPROVAL_EXPIRED`), and retrying it asks again. The check is the console's:
kernel-api trusts its caller, as it does for everything else.

A raw DAG needs a maintainer of every team it names. The run belongs to
whoever ran it as well as to its steps' teams: they may see, cancel, retry
and rerun it (a rerun runs the template again, as it is now; a retry is
refused once it, or a step's action, is no longer shared).

## Who sees a run that spans teams

A template run can have steps in several teams' namespaces: the team it was
run for (its consumer) and the teams whose products it uses (its
providers). Its owners (admins, whoever submitted it, members of the team
it was run for; for a raw DAG, every team in it) see every step, so a
consumer sees what each provider's step returned. A provider's member sees
their own team's steps in full and, of the rest, only each step's product,
state, timing and failure code: never its inputs, outputs, failure message,
the run's template parameters or its logs (`console/src/core/runView.ts`,
in the run's details, its events and logs, and Observe's log search).

## What a run made, and deleting it

A step lists what it made in its outputs' `resources`; the console keeps
each one (`resources`), with that step's inputs and outputs, after the run
is gone (`console/src/core/resources.ts`). Its type, id, name and link are
seen by the team it was made for, whoever ran it, the team whose product
made it, and admins; the stored inputs and outputs are never shown, only
used to fill in its cleanup's inputs. A resource keeps the team and person
it was first made for: another run reporting the same one (say, a create
that only found it) doesn't make it theirs, unless it had been deleted.
Deleting one (the team it was made for, whoever ran it, admins) runs that product's current `cleanup` action
as a run of its own, with every check a run of that action gets: it must
be shared with the person, its inputs fit its schema, its targets be
allowed, and its approval waits for a maintainer. Asking for a delete is in
the audit log, and so is the run.

## Notifications and chat webhooks

People see their own notifications only. A team's chat webhook URL (Slack,
Google Chat, Teams) is a credential the console has to use, so it's the
one third-party credential the console keeps itself, by decision: encrypted
in its database (AES-256-GCM, with a key derived from its `JWT_SECRET`, so
a copy of the database alone doesn't give it away), never sent back by the
API (members see its host), set only by the team's maintainers (audited,
without the URL), and only under the hosts the install allows
(`notifications.webhookHosts`: Slack's, Google Chat's and Teams' by
default), over HTTPS, without following redirects, so a webhook can't
point the console at anything inside the cluster. A post says what
happened and links to the console; it carries no outputs or logs.
Rotating `JWT_SECRET` makes the stored URLs unreadable, and teams set
theirs again.

## Email

When an install sends email (the console chart's `notifications.email`),
the console sends notifications through its SMTP server, to each person
for the kinds they choose, to their account's address. The server's
password is a Secret the console mounts as a file and reads itself; it's
never in an environment variable, the database or a log. Emails say what
happened and link to the console, as the inbox does: no outputs or logs.

## Bot tokens

A bot is an account that signs in with an API token instead of a password.
A token is `mp_` and 256 random bits, shown once when it's made; the
console keeps only its SHA-256 (`console/src/auth/apiToken.ts`), and when
it was last used, to within five minutes. A token works until it expires
(`api_tokens.expires_at`: 90 days unless its maker chose 30 days, a year,
two years, or until revoked), it's revoked (`TokenService/RevokeToken`, by
a maintainer of a team its bot is in, or an admin), or its bot is deleted.
The console and the gateway both refuse an expired one. What a leaked token can
do depends on its kind:

- **A team's bot** is a maintainer of its team (`console/src/core/tokens.ts`),
  so its token can do what a maintainer can there: register and replace
  the team's secrets, submit raw DAGs, retry and cancel the team's runs,
  and manage its people and bots.
- **An ordering bot** is a member, and may only order the templates its
  maintainers list for it ([Ordering bots](#ordering-bots)).
- **An automation token** (admins only) belongs to no team and can do
  exactly what its scopes say (`console/src/auth/scopes.ts`): create teams,
  register any team's products, retire or purge teams, apply SecretStores.
  It can't read a secret or submit a run.

Where the CI supports it, sign the bot in keylessly instead (next): then
there's no token to leak.

## Keyless bots

A bot can sign in with its CI job's own OIDC identity instead of a stored
token, so a pipeline holds no Vertra secret. It can be made that way
(`TokenService/CreateKeylessBot`: its identity is checked first, and no
token is ever made), or have tokens revoked once its CI signs in. A team's
maintainers bind a
bot to an issuer the install allows (`keyless.issuers`: GitHub Actions and
gitlab.com by default) and exact claims: one naming the repository or
subject, perhaps the branch or environment; no patterns, and never `aud`
or `iss`, which are checked anyway. `AuthService/ExchangeToken` verifies the
token's signature with the issuer's published keys (an issuer not on the
list is never contacted), its issuer, its audience (`keyless.audience`,
the console's URL by default, so a token minted for another service can't
be replayed here) and expiry, and returns an hour's ordinary session for
the one bot whose claims it carries; two or none is a refusal. Each sign-in
is logged with the bot, issuer and subject, and the identity's last use is
kept.

## Ordering bots

An *ordering bot* (decision 23: a storefront or another system placing
orders) is a member of its team, not a maintainer, and may run only the
templates its team's maintainers list for it: no raw DAG, no single action,
no rerun (`ORDERS_ONLY`, `TEMPLATE_NOT_ORDERABLE`). A leaked ordering token
can order those templates for that team, under its caps, quota and
approvals, and nothing more, and at most the install's rate a minute
(`orders.ratePerMinute`, 60 by default; 429 past it, counted from the runs it
made, so every console replica agrees). The runs a schedule makes as its bot
aren't limited this way: the schedule is its team's, reviewed by its maintainers.

An ordering bot may have a callback, where each of its orders' outcomes is
posted, and a team an outcome webhook, where each of its runs' outcomes is
(`console/src/callbacks.ts`). Like a team's chat webhook, its URL
is sealed with a key derived from `JWT_SECRET`, never sent back, only under
the hosts the install allows (the console chart's `orders.callbackHosts`,
none by default) and never redirected. Each post is signed with the bot's own
secret (HMAC-SHA256 over the time and the body, `Vertra-Signature`), shown
once when it's made, so the receiver can refuse forged and replayed posts. A
bot's post says which run and order it was and how it ended, never its
outputs: those are read with `GetExecution`, as the bot. A team's carries
its steps' outputs, as its members see them on the run's page: so a team
sets one only where it would show those outputs (which never hold
credentials, the product contract).

## Schedules

A schedule runs as one of its team's bots, never as the person who made it:
a maintainer picks the bot, and the console starts each run as that bot,
with the bot's teams and roles as they are then, through the same checks
as the bot running it itself (sharing, the parameters' schema, targets,
approvals). A bot that loses access stops the schedule at its next run,
which is refused, kept on the schedule and told to the team's maintainers.
Deleting the bot deletes its schedules.

## Who sees a step's logs

A step's output is stored (the kernel redacts recognizable credentials
first) and shown by level (decided 2026-10-21, `console/src/logLevels.ts`):
lines the step logs as JSON with `"level": "info"` to everyone who can see
the run; every other line (debug, warn, error, and any plain line, so
nothing reaches a consumer by accident) only to the step's team and admins.
A consumer sees how many lines were held back and which team sees them.

Observe's log search (the console chart's `logs`, off by default) keeps the
same rule over Loki, which has no users of its own: the console adds the
caller's visibility to every query (`console/src/core/logs.ts`), and Loki
accepts only the collector's pushes and the console's queries
(NetworkPolicy). The collector, Grafana Alloy, redacts credentials before
anything is stored, with the kernel's patterns, and may read every Pod's
logs in the cluster (a read-only ClusterRole on `pods` and `pods/log`:
steps run in every team's namespace); it keeps only steps' Pods, the
API backends teams run (Pods labelled `vertra/api-backend: "true"`) and the
platform's own. An API backend's lines, every level, are for its own team
only (they belong to no run, so no one else owns them); the platform's own
logs are for admins only.

## The API gateway

API products (decision 20) publish a team's own backend through one
gateway (`gateway/`). The gateway forwards a request only when its method
and path are an operation in the API's reviewed OpenAPI document and it fits
that operation's schemas; anything else is answered by the gateway (404 or
400) and never reaches the backend. Callers sign in as at the console (a
session or a bot token, checked against the console's database the same
way), and may call an API only when it's shared with one of their teams.
The caller's `Authorization` stops at the gateway; the backend gets its own
credential instead, minted per request, and `Vertra-Caller`, an EdDSA JWT
the gateway signs (its key at `/.vertra/jwks.json`) naming the caller,
their team and the API. A caller's own `Vertra-*` headers are dropped.
Paths with encoded slashes or dot segments are refused, so what's checked
is what's forwarded.

Backends must be under hosts the admins allow (`gateway.backendHosts`), or
the API is held: the gateway can't be pointed anywhere a catalog says. Its
only Kubernetes right is minting ServiceAccount tokens, and an admission
policy limits that to API ServiceAccounts (`*-api`) in team namespaces, so
it can't mint the platform's or a team's other identities. It reads the
console's database as a role of its own (`vertra_gateway`,
`console/src/db/gatewayAccess.ts`): it may read the columns it needs to
sign callers in and find APIs (never a password hash, a sealed value, a
secret's name or the audit log) and write only its traffic counts
(`api_traffic`) and why it can't serve an API (`api_problems`). It checks sessions with the console's public key (its
JWKS, `/api/auth/jwks`), so it can verify a session but never make one,
and never holds `JWT_SECRET` (proven on kind 2026-10-28: the gateway
connects as `vertra_gateway`, accepts a console session, refuses one signed
any other way). Requests are logged and counted by
API, team, caller and outcome, never with bodies, header values or
credentials; the counts kept for each API's page (`api_traffic`, a week)
hold only the calling team, never who. What it refused there is also in
Observe's refusals, seen by the API's team, the calling team and admins
(by the API's team and admins alone when no calling team is known). Its egress excludes the cloud
metadata server, so no backend URL can reach the node's credentials
through it, and it reads no Secrets: a backend that takes only a static
key can't be published.

## Tokens for another cloud

A step can sign in to a cloud other than the one hosting the cluster by
OIDC federation (AWS web identity, Entra workload identity, a GCP workload
identity pool), with a ServiceAccount token issued for that cloud. A
product asks for one by declaring its audiences (`tokenAudiences` in
`product.yaml`); a submitter can't choose them, as they can't choose a
ServiceAccount.

- The kernel mounts one projected token per declared audience at
  `/platform/tokens/<audience>` (characters outside `[A-Za-z0-9._-]` become
  `_`), each issued for that audience only and lasting an hour; the kubelet
  renews them. Steps still get no Kubernetes API token.
- The console refuses, at registration, any audience that would make the
  token good inside this cluster: the Kubernetes API server's (read from
  the console's own API token's `aud` claim) and kernel-api's
  (`console/src/tokenAudiences.ts`).
- The identity policy refuses a Job with a token for any audience its
  product didn't declare, or one lasting over an hour, so it holds for a
  Job the console never checked.

What the token is good for is the cloud's decision: trust the cluster's
issuer for the specific ServiceAccount (`system:serviceaccount:<team>:<sa>`),
never for the whole issuer.

## How kernel-api knows its caller

kernel-api knows nothing about users or teams; it acts on whatever the
console asks, because the console has already authorized it. So it checks
one thing on every call: that the caller is the console
(`kernel/internal/api/auth.go`).

- The console's Pod gets its ServiceAccount token projected for the
  audience `vertra-kernel-api` (rotated by the kubelet, valid an hour), so
  the token is useless against the Kubernetes API or anything else.
- kernel-api asks the API server whose token it is (a TokenReview, for that
  audience) and accepts only the ServiceAccounts in
  `api.auth.allowedServiceAccounts`. kernel-api's own ServiceAccount holds
  only the built-in `system:auth-delegator` role needed for that.
- No token, or one for another audience: 401. A valid token from anyone
  else, such as a step's own ServiceAccount: 403. Proven on kind.
- A successful review is reused for up to 60 seconds, so a revoked token
  can stay accepted that long. If the API server can't be asked, the
  request fails.

`/health` and `/metrics` stay open for probes and scrapers; they carry no
execution data. Every metrics port (kernel-api's, the scheduler's, the
console's and the gateway's) accepts only `networkPolicy.metricsFrom`, so a
step can't read them, and no metric is labelled with a user, a team or a
token.

## The console's writes

The console can't read a Secret. It creates, replaces and deletes them (and
product ServiceAccounts, ExternalSecrets, SecretStores and each team's
default-deny NetworkPolicy) through a cluster-wide role, which an admission
policy, the write fence (`write-fence-policy.yaml`), confines to namespaces
labelled as teams'. The console can't change that policy or its binding,
and it checks both are in force (failing closed, bound to deny) before it
starts: without them it refuses to start, since its role would otherwise
reach every namespace. Per-namespace RoleBindings were considered and
dropped: the console would have to create them, and only the same policy
would keep it from binding the role elsewhere.

## Signing in

People sign in with a password, or with single sign-on when it's on: an
OpenID Connect provider (Google, Entra ID, Okta, Keycloak) that either the
console chart's `sso` sets (then it's read-only in the console) or admins
set on Admin, Sign-in & groups (`console/src/core/sso.ts`; its client secret sealed
in the database with a key derived from `JWT_SECRET`, write-only). Saving
a provider reads its discovery document first. Every console reads the
saved settings every few seconds, so turning it on or off needs no restart
(`console/src/sso.ts`, `console/src/auth/oidc.ts`). The sign-in uses the authorization code flow
with PKCE; its state, nonce and verifier live in a signed, HttpOnly cookie
for ten minutes. The ID token must carry the provider's signature, this
console as its audience, this sign-in's nonce, a verified email, and a
Workspace domain listed in `sso.allowedDomains` (a personal Google account
has none, so it can't sign in). The first sign-in binds the account to the
provider's identity (`users.oidc_subject`): from then on, a different
provider account given the same email is refused. The session comes back in
the URL's fragment, which browsers never send to a server.

Turning single sign-on on changes nothing else: passwords still work. A team
an admin sets to require it (`teams.require_sso`) refuses its members'
passwords (checked only after the password itself, so the refusal says
nothing to someone guessing) and every session a password made, at the
console and the gateway alike; sessions say which they are. Someone in
several teams must use single sign-on if any requires it, since a password
would open the strict team's runs and secrets too. Admins are exempt, as the
way in if the provider fails. While single sign-on is off the setting has
no effect, so nobody is locked out. Bots keep their tokens.

Groups, from the ID token's groups claim and/or Google Workspace (Cloud
Identity's Groups API, read as the console's own Google service account,
which a Workspace admin makes a Groups Reader; it asks only whether the
person is in each mapped Google group), can be mapped to teams by admins. At each
single sign-on, every mapped team's membership follows the person's groups:
added with the best role their groups give, changed, or removed. Teams
nothing maps to are left alone. Google Workspace groups are also read again
every hour for everyone who signs in with single sign-on, so leaving one
takes someone out of its team within the hour (a person whose groups can't
be read then keeps their teams until the next try). Groups that can't be read (a missing claim,
too many groups for the token, Google's API failing) refuse the sign-in
(`GROUPS_UNAVAILABLE`) rather than count as none, which would take people
out of their teams. On a mapped team, a single sign-on member's membership
can't be changed by hand (`TEAM_FOLLOWS_SSO_GROUPS`); bots and password
accounts are managed there as ever.

A password someone else set (a new account's temporary one, an admin's
reset of someone else's, `vertra admin reset-password`) has to be changed
before anything else: until then its session may only read who it is and
change it (`PASSWORD_CHANGE_REQUIRED`), and the gateway refuses it.

**Passwords** are hashed with argon2id at the library's default cost
(`console/src/auth/password.ts`). A new one must be 12 to 256 characters;
nothing else is checked (no character classes, no breached-password list).
There's no second factor for password accounts; where that matters, use
single sign-on and the provider's. Password accounts are made by admins: open
registration (`ALLOW_SELF_REGISTRATION`) is off by default and, when on,
doesn't verify the email.

**Guessing** is limited twice (`console/src/rpc/services/auth.ts`): 10
sign-ins per 15 minutes per client address and email, and, per email from
any address, after 10 failures in an hour each attempt waits 1 s, then 2 s,
4 s, up to a minute (`console/src/auth/loginThrottle.ts`), so the owner is
slowed, never locked out. A wrong email costs the same time as a wrong
password. Both are counted in the console's database (`rate_limit_windows`,
`sign_in_failures`), so every copy of the console counts the same attempts
and a restart forgets nothing. A failed sign-in is logged (`event:
"sign_in_failed"`, with the email and address) and audited. The client
address is the connection's unless `trustProxy` names the load balancer.

**Sessions** are JWTs signed with an Ed25519 key derived from `JWT_SECRET`
(`console/src/sessionKeys.ts`; EdDSA, any other algorithm refused), lasting `JWT_TTL`
(8 hours by default; single sign-on's too, a keyless bot's an hour). The
browser keeps one in `localStorage` and sends it as a bearer header, never
a cookie, so there's no cross-site request forgery to defend. The token
only says who you are: teams, roles and admin come from the database on
every request, so removing someone from a team takes effect at once.
Each session has its own id (`sid`). Signing out (`AuthService/SignOut`)
records it in `revoked_sessions`, so a copy of that token is refused from
then on, by the console and the gateway; the person's other sessions go
on. Every session of a person ends when their password is changed or
reset, or their account is deleted
(`console/src/auth/plugin.ts`); disabling someone at the single sign-on
provider ends nothing until their session expires. Anyone with
`JWT_SECRET` can make a session for anyone: only the console holds it. The
gateway gets the public key alone.

## In the browser

The console sends a Content-Security-Policy on every response: scripts only
from its own origin, no plugins, and it can't be framed (`frame-ancestors
'none'`), plus `nosniff`, `X-Frame-Options` and HSTS. The session token sits
in `localStorage`, so the policy matters: it's what stops an injected script
from running at all. Styles may be inline, because the UI library injects
them. Checked in a real browser (headless Chrome, every signed-in page: no
violations).

## Who can read a secret

- **Steps of the team's registered products that list it** in `secretRefs`,
  through the mounted files. Steps get no API access to Secrets.
- **Not the console.** Its role can create, replace and delete Secrets, but
  not read them (no `get` or `list`): whether a Secret is a team's comes
  from its own records. Its writes are fenced to team namespaces (below),
  and it can't grant RBAC (it may only delete Roles, never create them). A
  compromised console could still write a team's secret values and, by
  loosening the identity policy, have a step of its choosing mount one
  ([If a component is compromised](#if-a-component-is-compromised)), so it
  remains the most privileged component and should be treated that way.
- **Nobody, for the registry pull Secret.** With the console chart's
  `registryCheck.copyToTeams` on, the console copies the platform's
  registry credential into every team namespace as `vertra-pull`, and the
  kernel names it as every step Pod's `imagePullSecret`
  (`scheduler.taskImagePullSecret`). Only the kubelet uses it: the name is
  reserved, so it can never be registered as a team secret and mounted.
  The console has it as a mounted file and rewrites every team's copy on
  each policy resync, so a rotation reaches every team within one
  interval. Turning the option off leaves the copies; delete them by hand.
  Reading another cloud's Artifact Registry (`registryCheck.gcpFederation`),
  the copy is a token the console minted that hour by Workload Identity
  Federation, renewed every resync; it reads the catalog's repository and
  nothing else, and lapses within the hour once the provider is deleted.
  Reading another account's (or another cloud's) Amazon ECR
  (`registryCheck.awsFederation`), it's ECR's registry token for the
  owner's role, which the console assumed that hour by web identity
  (`AssumeRoleWithWebIdentity` with its projected token, audience
  `sts.amazonaws.com`); the role trusts that cluster's console
  ServiceAccount alone and may only pull and list tags in the catalog's
  `<prefix>/*`, and the token lapses within the hour once the role is
  deleted. The owner makes either with `vertra catalog grant`, which names
  exactly one reader's identity.
- **Cluster administrators**, and anyone else the cluster's own RBAC lets read
  Secrets in a team namespace. Vertra doesn't grant people Kubernetes
  access, but doesn't prevent a cluster operator from doing so.

## Guardrails the cluster enforces

These are ValidatingAdmissionPolicies (and, optionally, Sigstore's
policy-controller), so they hold even for a request that reaches the kernel
without going through the console:

| Guardrail | What it refuses | Where |
| --- | --- | --- |
| Dispatch namespaces | Jobs in any namespace not labelled `vertra/team=true`, and in the platform's own namespace (`DISPATCH_REJECTED`), unless `dispatchPolicy.allowReleaseNamespace` is on: only for an install whose platform namespace is also a team's, as the GKE reference install's `default` is (`helm/values/gke/kernel.yaml`) | `helm/charts/execution-kernel/templates/dispatch-policy.yaml` |
| Image sources | Images outside the allowed registries (`IMAGE_NOT_ALLOWED`) | `templates/image-policy.yaml` |
| Image signatures | Where policy-controller is installed, any Pod in a team namespace whose image isn't signed by catalog CI under the source registry, whoever makes it (`IMAGE_NOT_SIGNED`): images from sources an admin added don't run there either (`no-match-policy` stays `deny`, so a compromised console adding a source can't get past it). It checks Pods, not the Jobs and other workloads that make them, which a second policy passes without verifying them (the webhook still admits them): a step's Job is made, and its Pod refused (the Job's `FailedCreate` event, which the kernel reads) | `templates/image-signature.yaml` |
| Image scans | An image not pinned by digest (`IMAGE_NOT_PINNED`), or one whose digest failed its security scan unless an admin accepted it (`IMAGE_SCAN_FAILED`). The console scans every image before it's registered or run, and daily while in use | `templates/scan-policy.yaml` |
| Step identity | A step running as any ServiceAccount but `default` unless it's a registered product running as the one its `product.yaml` declares; any step mounting a Secret unless it's a registered product and the Secret is registered for its team; Secrets reaching a step any way but a volume (`IDENTITY_NOT_ALLOWED`). The console keeps the policy's products and team secrets current. | `templates/identity-policy.yaml` |
| Team deletion | A configured purger deleting a team namespace that isn't labelled retired. None is configured by default: the console leaves a purged team's namespace, labelled retired, for a cluster administrator to delete, so the identity that retires a namespace can't also delete it (`teamNamespaces.purge` would let it) | `templates/purge-policy.yaml` |
| Console namespaces | The console creating a namespace that isn't labelled a team's, adopting one that isn't a team's, changing anything about a team namespace but its team label, or touching kube-* or the platform's own | console chart, `templates/namespace-policy.yaml` |
| Console write fence | The console's ServiceAccount creating, changing or deleting Secrets, ServiceAccounts, Roles, RoleBindings or ExternalSecrets outside team namespaces (kube-system, the platform's own) | console chart, `templates/write-fence-policy.yaml` |

The dispatch, image, scan and identity policies check the scheduler's own
requests and nobody else's (their `matchConditions`). Anyone else the
cluster lets create Pods in a team namespace, such as a cluster
administrator, isn't checked by them: only Pod Security
([What a step can reach](#what-a-step-can-reach)) and, where it's installed,
policy-controller's signature check apply to every Pod there.

An install `vertra` makes sets up signing itself when its catalog is signed
(`signing` in vertra.yaml, asked at `vertra init`): `kms`, a key in the
cloud's KMS (a GCP key ring with a fresh suffix, or an AWS ECC P-256 key)
that only the catalog repository's CI, through its main-only federation, may
sign with, its public half read at apply; or `keyless`, the repository's
`ci.yml` on main by GitHub's OIDC issuer, through Sigstore's public log
(which names the repository). Either way it installs policy-controller,
scoped to team namespaces and bound to an identity that may only read the
task registry, gives the kernel's imageSignature and the console's
catalog.signature the same signer, and sets the repository's
VERTRA_SIGNING_* variables. Proven on GKE (2026-10-26), both modes: CI
signed images and releases; the console applied only signed releases ("no
trusted signer signed the catalog release … nothing was applied" for one
pushed unsigned); a signed starter ran and an image pushed by hand, unsigned,
was refused (`IMAGE_NOT_SIGNED`). Proven on EKS too (2026-10-26), `kms`:
an AWS KMS key, with policy-controller reading ECR through Pod Identity; the
same four results.

An install reading another's catalog (`externalCatalog`) holds no signing
right: it trusts the owner's signer (`catalogSignature`: its public key, or
its repository's keyless identity) and, on gcp and aws, enforces it on
releases and images the same way, its policy-controller reading the
owner's registry (as its own identity in another Google Cloud project;
across clouds or AWS accounts, with the steps' pull Secret). The owner
grants that read with `vertra catalog grant`, to the reader's identity
alone and on the catalog's registry alone: its service accounts, or its
console's ServiceAccount from its cluster's issuer, never a key. A catalog version (decision 22) is a tag on a release
main already signed, so it needs no signature of its own, and the tag's
own CI run holds no credential: it asks main to make it.

Two platform identities only change replica counts, through the scale
subresource (which can't change what a Deployment runs), on Deployments
named in their Roles: the kernel's sleeper (`scaleDown`, the platform's
own Deployments, plus its own `-sleep` ConfigMap and a read of the
console's `-activity` one) and the console (only the image scanner's, to
idle it, and its own `-activity` ConfigMap). A stolen token of either can
stop the platform, not change it.

And at the network level, NetworkPolicies (`templates/networkpolicy.yaml` in both charts) let only the platform's own Pods connect to its Postgres, and only the console connect to kernel-api: a step's Pod can reach neither. Every team namespace also holds `vertra-default-deny`, which the console writes with the namespace and rewrites on every policy resync (`console/src/teamNetwork.ts`): its Pods accept connections only from Pods in the same namespace, so one team's steps can't reach another team's Pods or Services. With the gateway on, it also writes `vertra-gateway-ingress`: the gateway's Pods (this release's namespace and the gateway's own labels) may reach the Pods the team labels `vertra/api-backend: "true"`, its API products' in-cluster backends, and nothing else of the team's (proven on kind 2026-10-28: through the gateway, 200; from another team's namespace, no connection; from its own namespace without the gateway's signed `Vertra-Caller`, the sample backend's 401). The console's write fence accepts no other NetworkPolicy from it, and only those two shapes (a broader selector, any namespace, any Pod of the platform's, or an extra peer is refused), and its RBAC can't delete one, so a compromised console can't open a team namespace up. Outgoing traffic isn't restricted: steps call their clouds. Every team namespace also holds a ResourceQuota (`vertra-team-quota`) and LimitRange (`vertra-team-limits`) when limits are set (`console/src/teamQuota.ts`: the chart's `teamNamespaces.quota`, or a team's own set by an admin), so one team's steps can't take the cluster's capacity from the others; the cluster refuses a Pod over them, and the write fence accepts no other quota or limits from the console. They need a CNI that enforces NetworkPolicy, and they select Pods by label, so creating Pods in the platform namespace must stay limited to administrators. The bundled databases' passwords are generated on install.

## What a step can reach

**Its Pod.** With the kernel chart's `scheduler.taskPodHardening` on (the
default), every step Pod meets Pod Security's `restricted`
(`kernel/internal/executor/kubernetes.go`): it runs as a non-root user (the
image must name a numeric non-root `USER`), on a read-only root filesystem
with a writable `/tmp`, with every capability dropped, no privilege
escalation, the runtime's seccomp profile, and no Kubernetes API token
(`automountServiceAccountToken: false`). It's never privileged. Turned off,
for images that can't run that way, a step runs as its image's user on a
writable filesystem and gets its ServiceAccount's API token.

The cluster holds a step to that only where the namespace enforces Pod
Security: the console labels each namespace it creates
`pod-security.kubernetes.io/enforce: restricted` (the console chart's
`teamNamespaces.podSecurity`; `console/src/k8s.ts`, `setTeamNamespace`), and
the namespace policy won't let it remove the label. A team namespace the
console adopted rather than created, or one made with `podSecurity` empty,
has no such label. Either way, while `taskPodHardening` is on the kernel's
dispatch policy refuses any Job of the scheduler's that isn't hardened
that way (no API token, non-root, a read-only root filesystem, no
capabilities or privilege, nothing of the host's: proven on kind
2026-10-28), so a scheduler tricked into making another Job still can't.

**The network.** In, only Pods of its own namespace (and the gateway, to a
team's API backends). Out, anything: the internet, its cloud, the
Kubernetes API server (with no token to call it, while hardening is on),
the console's and the gateway's public ports, and Services in namespaces
with no ingress policy; the cloud's metadata server too, except on EKS
(below). It can't reach either Postgres, kernel-api, the image scanner,
Loki, or any metrics port. All of this needs a CNI that enforces
NetworkPolicy: on EKS, `vertra` turns enforcement on (the VPC CNI's
`enableNetworkPolicy` in standard mode, the `amazon-vpc-cni` ConfigMap in
Auto Mode), off by default there.

**The metadata server**, so the node's own cloud identity:

- On GKE clusters `vertra` makes, the metadata server is Workload
  Identity's (`GKE_METADATA`, `cli/internal/modules/gcp/main.tf`): a step
  gets only the Google identity bound to its own ServiceAccount, and none
  as `default`; never the node's.
- On EKS, the console writes `vertra-no-metadata` into every team
  namespace (the console chart's `teamNamespaces.blockMetadata`, on in the
  EKS values and in what `vertra` installs there): every Pod may connect
  anywhere but `169.254.169.254`, so a step can't ask for the node role's
  credentials. IPv4 only: on an IPv4 cluster the VPC CNI's policy agent
  can't hold an IPv6 block, and failing to, it enforced none of the
  namespace's policies, the default deny included (found on standard-mode
  EKS 2026-10-29, and fixed). Steps that need AWS get their own role
  through EKS Pod Identity (`169.254.170.23`, still open) or a web-identity
  token. The write fence accepts that policy only in a shape that lets out
  everything less what it excepts. Proven on EKS Auto Mode 2026-10-28: a
  Pod in a team namespace gets no connection to the metadata server, while
  the internet answers; there, Auto Mode's nodes already refuse Pods the
  metadata server, so the policy is a second barrier. Proven on
  standard-mode EKS 2026-10-29 too: another team's Pod refused, the
  metadata server refused, the internet open, and the policy agent
  programming every rule without error.
- On any other cluster, it's the cluster operator's to close.

## If a component is compromised

What each platform identity could do if its process or credentials were
taken, and what would still hold.

- **The console** can, through its role
  (`helm/charts/execution-console/templates/rbac.yaml`): create, replace
  and delete Secrets, product ServiceAccounts, ExternalSecrets,
  SecretStores, NetworkPolicies and quotas in team namespaces (the write
  fence keeps it to those); read every Pod in the cluster, specs included;
  and update the image, identity and scan policies (and read, never
  change, the kernel's signature policy, by its name). Kubernetes doesn't
  apply admission policies to admission policies, so nothing narrows that
  last right: the console only ever writes their lists, and every kernel
  upgrade resets the rest, but a compromised console could rewrite them to
  allow any image, ServiceAccount or Secret, then submit through kernel-api,
  which trusts it, a step that mounts any team's Secret. This is a known,
  deliberate trade-off (the comment in that file). It also holds its
  database (every account, and the values it seals) and `JWT_SECRET`, so it
  can make a session as anyone. Still holding: steps run only in team
  namespaces, never the platform's (the dispatch policy, which it can't
  edit); it can't write outside team namespaces, change a team namespace's
  labels beyond its team label, delete a namespace (unless
  `teamNamespaces.purge`), widen a team's NetworkPolicy, create RBAC
  beyond one fixed RoleBinding per team namespace (the scheduler reading
  its steps' logs; the write fence refuses any other subject, role or
  name), or read a Secret through the API; policy-controller's signature check, where
  installed; Pod Security in the namespaces it created.
- **kernel-api**'s ServiceAccount may only ask the API server who a token
  belongs to (`system:auth-delegator`). It holds the kernel's database: every run's
  inputs, outputs and logs, and the task rows the scheduler runs. A task it
  wrote there still passes all four Job policies when the scheduler starts
  it: a registered product of the team, as its own ServiceAccount, with
  only the team's registered secrets, from an allowed, pinned, scanned
  image, in a team namespace.
- **The scheduler** has the kernel's database too, and a ClusterRole
  (`helm/charts/execution-kernel/templates/rbac.yaml`): create Jobs and
  ConfigMaps (the dispatch policy keeps them to team namespaces, and the
  Job policies check every Job); list and watch every Pod in the cluster
  read steps' logs only in team namespaces (a logs-only ClusterRole the
  console binds in each one; not the platform's or kube-system's, unless
  the kernel chart's `rbac.schedulerLogs: cluster`, for an install whose
  team namespaces the console doesn't manage); delete Jobs and ConfigMaps, which the dispatch policy keeps to its own
  (labelled `app=execution-kernel`, named `ek-…`) in team namespaces,
  retired ones included (proven on kind 2026-10-28); list events.
- **The gateway** may mint ServiceAccount tokens only for `*-api`
  ServiceAccounts in team namespaces ([The API gateway](#the-api-gateway)).
  Its database role reads who callers are and the published APIs, and
  writes its traffic counts; it holds no `JWT_SECRET`, so it can't make a
  session, and can't read a password hash or unseal anything. It could
  forward requests it shouldn't to the APIs' backends, as any of their
  callers.
- **The sleeper** can change replica counts and stop the platform, not
  change it (above).

## Vertra's own supply chain

On each version tag, the release workflow (`.github/workflows/release.yml`)
builds the kernel, console and gateway images, scans them with CI's gate
(`.github/scripts/scan-image.sh`: a HIGH or CRITICAL vulnerability with a
fix, a secret in a layer, or a known-malicious package fails the release),
pushes them to GHCR and signs each digest with cosign, keyless, as the
workflow's own GitHub identity. The charts and the `vertra` binaries are
signed the same way, and a catalog's `./vertra` downloads its binary by
SHA-256. Every pull request also runs Semgrep, gitleaks, and the same scan
of the three platform images (`.github/workflows/security.yml`, `ci.yml`).

Nothing verifies those signatures when installing: `vertra` pulls the
charts by version, the charts run their images by tag unless
`image.digest` pins them, and policy-controller doesn't cover the platform's
own namespace. To check one by hand:

```console
$ cosign verify ghcr.io/<owner>/<repo>/execution-kernel:<version> \
    --certificate-identity-regexp 'https://github.com/<owner>/<repo>/.github/workflows/release.yml@.*' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Audit

The console records every call that can change something, allowed or
refused, once it's answered (`console/src/audit.ts`, by one interceptor):
who (a user or bot id), the method, the fields that name what it acted on
(team, secret name, image, email, ...; never a value, password or token)
and the outcome, with the request's id and the client's address. Signing
in is recorded the same way, allowed or refused (the email tried, never
the password; a successful one's actor is who signed in), as are keyless
and single sign-on sign-ins, registering and changing a password. Each
entry is in the `audit_log`
table, hash-chained so a change or removal shows, and in the console's log
as `event: "audit"`. A catalog release's changes are recorded too.
Entries are kept `retention.auditDays` (365 by default); `audit.export`
copies them to write-once storage, and the database is compared with that
copy entry by entry, so even a change with every later hash rewritten
shows ([operations](operations.md)). On
Observe, admins see every entry; anyone else their own, and what was done
to their teams or to runs in them.

Not recorded:

- **Reads.** Who looked at a run, its outputs or logs, or a team's secrets'
  names, isn't recorded.
- **What the console does on its own**, such as a schedule's runs: the
  schedule's creation is in the log, and each run in its own records.
- **Anything done to the cluster directly**, outside the console: that's
  the cluster's audit log.

## What Vertra stores

| Where | What | Notes |
| --- | --- | --- |
| Console database | Users (argon2id password hashes), teams, memberships, bots (hashed API tokens), registered secrets (names and key names, no values), products, a record of submitted executions including their DAG, and what runs made (each resource with its step's resolved inputs and outputs) | Sessions are signed tokens that expire (8 hours by default). What runs made is kept past run retention, until it's deleted |
| Kernel database | Each execution's DAG, step inputs (as submitted and as resolved), outputs, logs and events | Never put a secret in a step's `inputs`: inputs are stored and shown to the execution's viewers. When the console's database shares this Postgres instance (`postgres.consoleDatabase`), the console signs in as its own role, which owns only its database and is refused a connection to the kernel's |
| Team namespace | A ConfigMap per step attempt holding its `request.json` (its resolved inputs), deleted with the step's Job | Readable by anyone with ConfigMap access in that namespace |

**At rest**, the console seals the few credentials it keeps and uses
itself (chat webhook and callback URLs, the single sign-on client's
secret, the chat model's key) with AES-256-GCM, under keys derived from
`JWT_SECRET` (`console/src/sealed.ts`), so a copy of the database alone
doesn't give them away. Everything else above is plain in Postgres, on its
volume, and in its backups: step inputs, outputs and logs, what runs made,
and the audit log. Encrypting those disks and the backup bucket is the
cluster operator's.

**In transit**, a person or bot reaches the console over HTTPS
([operations](operations.md)). Inside the cluster, with each chart's `tls`
(on by default), the kernel chart makes a CA of its own once
(`templates/tls.yaml`, kept across upgrades) and signs a certificate for
kernel-api and one for its Postgres; the console chart does the same for
its own Postgres, when it has one. kernel-api serves only HTTPS, so the
console's ServiceAccount token never crosses the network in the clear; each
bundled Postgres accepts network connections only over TLS (its
`pg_hba.conf`, `hostssl`), and every client (the kernel, the console, the
gateway, the migration and backup Jobs) checks the server against the CA
(`sslmode=verify-full`), so a Pod impersonating either gets nothing. An
external database is whatever its `externalDatabaseUrl` says. Still plain:
the metrics ports, the scanner's, Loki's, which NetworkPolicies limit.
Proven on kind 2026-10-28 with the console's database on the kernel's
Postgres: every connection there is TLS, a plain one is refused by
`pg_hba`, kernel-api refuses a client that doesn't trust its CA, and a run
goes through end to end. That's the layout of every install `vertra`
makes (EKS and GKE too): one Postgres, in a Pod, for both databases. The
console's own Postgres, which the hand-written GKE values use, is proven
too (2026-10-29, those charts' layout on a kind cluster of its own): every
connection to it TLS, the gateway's as its own role, a plain one refused. To
rotate, delete a chart's `-tls` and `-tls-ca` Secrets and upgrade
([operations](operations.md#rotating-secrets)).

## Rules for product authors

Products are written by catalog contributors, not by Vertra, so these are
requirements on product code:

- **Never print or return a secret.** Logs and `result.json` outputs are stored
  and shown to everyone who can see the execution. The kernel catches the
  common mistakes (`kernel/internal/domain/credentials.go`): it redacts
  well-known credential shapes from logs and error messages (PEM private
  keys, AWS/Google/Azure keys, GitHub, Slack and Stripe tokens, bearer
  tokens, JWTs), fails a step whose outputs contain one
  (`OUTPUT_CONTAINS_CREDENTIAL`), and refuses a submission whose inputs do
  (`INPUT_CONTAINS_CREDENTIAL`). It can only recognize shapes, not values
  (it never sees a secret's value), so a password or an opaque token is
  still stored if printed. Log what you did, not what you used.
- **Be idempotent.** Steps run at least once: a retried step must not create
  something twice or charge twice.
- **Read secrets only from `/platform/secrets/`**, never from inputs, and never
  bake one into an image. Images are shared, cached and pulled by every team.

## Not yet enforced

Known gaps in 0.x, all tracked in [`TODO.md`](../TODO.md). They're the reason
Vertra isn't production-ready yet.

| Gap | Impact | Plan |
| --- | --- | --- |
| A compromised console can loosen the image, identity and scan policies, and write any team's Secrets | It could run a step of its choosing with any team's secrets ([If a component is compromised](#if-a-component-is-compromised)) | Accepted for now: Kubernetes can't guard admission policies from their editor; treat the console as the most privileged component |
| Groups from an ID token's claim are read at sign-in only | Someone who leaves a group the provider reports in its token stays in its team until their session ends (8 hours by default) or they sign in again; Google Workspace groups are read again every hour | Shorter sessions where that matters (`JWT_TTL`) |
| Reads aren't audited ([Audit](#audit)) | Who looked at a run's outputs or logs isn't recorded | Not decided |
| The audit log lives in the console's own database unless `audit.export` copies it to write-once storage (its entries are hash-chained, and with the copy compared with the database entry by entry; Observe shows the log as each caller may see it) | Without the copy, someone who can write that database could change it, rewriting the chain after it | Turn on `audit.export`, or ship the `event: "audit"` log lines to a SIEM |
| Step Pod hardening is a chart setting: with `scheduler.taskPodHardening: false`, the dispatch policy no longer requires it, and only Pod Security, on namespaces the console created, holds a step to `restricted` | Steps run as root with an API token in an adopted namespace | Keep `taskPodHardening` on and let the console create team namespaces |
| Every team named in a raw DAG sees all of its steps' outputs (a template run's providers see only their own steps in full; other teams see only a step's INFO log lines) | Cross-team visibility of outputs within a shared raw DAG | Decide: filter outputs by team, or require every team for reads |

## Out of scope

- **A malicious product a reviewer approved.** Review, scanning and signing
  reduce this risk; a product that passes them runs with whatever its
  ServiceAccount and the secrets its team's steps give it allow.
- **A compromised cluster administrator, node or control plane.**
- **Side channels between Pods on the same node.**
- **The security of a team's own secret store** and of the identities it trusts.

## Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md). Please report privately, never in a
public issue.
