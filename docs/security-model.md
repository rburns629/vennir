# Security model

How Vennir keeps each team's secrets to that team's reviewed products: what's
enforced today, by which layer, what isn't enforced yet, and what's out of
scope. Written for security reviewers evaluating Vennir, and kept honest:
where something is a plan rather than a fact, it says so.

Last reviewed 2026-10-28, for 0.x. Vennir is not production-ready yet; the
gaps in [Not yet enforced](#not-yet-enforced) are why.

## At a glance

| Question | Answer |
| --- | --- |
| Where do secret values live? | In Kubernetes Secrets, in the owning team's namespace. Synced secrets keep their source of truth in the team's own store (GCP Secret Manager and others, through External Secrets Operator). |
| Does Vennir's database store secret values? | No. The console stores which secrets each team registered, and the names of their keys, never values. The kernel never sees them. |
| Who can read a secret? | Steps of its team's registered products that list it in `secretRefs`, and cluster administrators. Not the console: it writes Secrets but has no right to read them. See [Who can read a secret](#who-can-read-a-secret). |
| Can one team's step reach another team's secret? | No. A step runs in its own team's namespace, and a Pod can only mount Secrets from its own namespace. |
| Can one product reach another product's secret in the same team? | By design, yes: a team's secrets are the team's, and the team chooses per step which ones it gets (`secretRefs`). What a team can't do is give one to an image that isn't its registered product's release (it runs with no secrets), or mount a Secret it never registered. A product's release is a digest it was registered at, so another image pushed to the product's repository, at any tag or digest, isn't one. The console checks this at submit time, and an admission policy makes the cluster enforce it on every step's Job. A product's own cloud identity (its declared ServiceAccount) is still its own: another product can't run as it, since the console refuses a second image repository declaring it in the same namespace, and no product may declare `eso-gcp`, `eso-aws` or `eso-azure`, the ServiceAccounts ESO reads the team's vault as (the identity admission policy refuses a step running as those, too). |
| Can a team register another team's product, or its image, as its own? | No. A team doesn't register products at all: the catalog's release does (`products:register`), or an admin, so what code runs, and as what, is decided by the catalog's review. A product name and an image repository belong to the first team that registers them, the repository even after its products are deleted (an admin can release an unused one). Catalog CI also derives each image's path from its team's folder, so one team can't publish under another's name. A product's name is its team's, product's and action's (`<team>-<product>-<action>`), so two teams' folders could make the same one (team `a`'s `b-c`, team `a-b`'s `c`): `vennir catalog check` and the release refuse that, naming both, and a console applying a release that has it registers neither. |
| Can anything but the console submit work? | No. kernel-api accepts only the console's ServiceAccount token, issued for kernel-api alone and checked with a TokenReview. See [How kernel-api knows its caller](#how-kernel-api-knows-its-caller). |
| Is anything enforced if the console is bypassed? | Yes: which namespaces steps may run in, which image sources they may use, that images are pinned and passed their scan, which ServiceAccount and Secrets a step may have, image signatures (with Sigstore's policy-controller installed) and who may delete a team namespace. These are admission policies the Kubernetes API server applies to the scheduler's Jobs. They don't hold if the console itself is compromised: it can rewrite three of them. See [If a component is compromised](#if-a-component-is-compromised). |
| Are secrets encrypted at rest? | That depends on the cluster. Enabling encryption of Secrets at rest in etcd, ideally with a KMS provider, is the cluster operator's responsibility and a prerequisite for production. |
| Is Vennir's own data encrypted at rest? | Only the few credentials the console keeps itself. Step inputs, outputs and logs, and the audit log, are plain in Postgres; encrypting its disks and backups is the operator's. See [What Vennir stores](#what-vennir-stores). |
| Is traffic inside the cluster encrypted? | Yes, with each chart's `tls` (on by default): kernel-api serves HTTPS and the bundled Postgres instances accept only TLS, each with a certificate from its chart's own CA, which every client checks (`verify-full`). Metrics ports and the scanner's are plain; NetworkPolicies limit who reaches them. See [What Vennir stores](#what-vennir-stores). |
| Where are the database passwords? | With the bundled Postgres, generated on install and kept in the releases' Secrets. With a managed database (`database.type: managed`) there are none of Vennir's: each service signs in as its own cloud identity with a short-lived token (IAM database authentication; Cloud SQL: an hour's Google token; Amazon RDS: a 15-minute token its role signs), over TLS checked against the server's CA, from inside the install's network only (the kernel refuses to start with a URL that wouldn't check it). A separate administrator identity, used only by `kernel database-setup`, opens each database to its own service alone; on RDS, whose administrator must have a password, RDS keeps it in Secrets Manager, readable only by that identity. See [Databases](operations.md#databases). |
| What reaches logs and outputs? | Whatever a step prints or returns. Vennir stores step outputs and logs; a product must never print or return a secret. |

## Who is trusted

| Actor | Trusted to | Limited by |
| --- | --- | --- |
| Cluster administrators | Everything; they can read any Secret | Outside Vennir's control |
| Vennir admins (console) | Manage teams, people, bots, allowed image sources; act in any team | Console authorization; every admin action is logged |
| Catalog reviewers | Decide which product images exist, and which ServiceAccount and secrets each product declares | The catalog repository's review rules (CODEOWNERS, protected branches) |
| Team maintainers | Manage their team: its people and their roles, register its secrets and choose which step gets which, its bots, raw DAGs, cancelling its runs | Console authorization (`auth/access.ts`): the maintainer role, per-product identity, registered team secrets |
| Team members | See their team's runs, logs, Pods and secrets' names; run its actions and what's shared with it; delete what its runs made (its products' cleanup actions, decided 2026-11-04) | The member role: none of the team's settings, people, secrets or bots |
| Product images | Do their one job with the inputs and secrets they're given | Their namespace, ServiceAccount and mounted secrets; admission policies |
| Pipelines (bots) | A team's bot: what a maintainer of its team may do, except make tokens, bots or identities or change its people; an ordering bot, only its listed templates, and deleting what its team's runs made; an automation token, only its scopes, in no team | Hashed API tokens that expire (90 days unless their maker chose otherwise) or are revoked; `auth/access.ts`'s `ensureMayOrder`. See [Bot tokens](#bot-tokens) |

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
  vennir-console`) and won't replace, or register, a Secret it didn't
  create, such as a SecretStore's own credentials: that's refused with a 409.
  So a SecretStore's credentials can never be mounted by a step. Nor does
  it replace or register an ExternalSecret it didn't label (one applied by
  hand, syncing whatever it names): syncing a secret of that name is
  refused the same way, and the write fence refuses the console creating
  an unlabelled ExternalSecret or updating one that wasn't labelled.
- No RBAC is involved: mounting doesn't consult it, and steps don't read
  Secrets through the API. The console creates no Roles (older versions made
  one per secret; the console removes them at startup).
- Revoking a secret (Team page, or `SecretService/RevokeSecret`)
  removes the registration and the Secret or ExternalSecret the console
  created. Tasks already running keep what they mounted.

Values a team's *builds* need (a private package registry's token) are
the one exception, and never reach the console or a step: they live in the
team's own GitHub Environment in its catalog repository, `team-<team>`,
which only `main` may use, and catalog CI offers them to that team's
`docker build` as BuildKit secrets, never in a layer. The job that builds
with them holds no registry or cloud credential; the publish job, in
`catalog-publish`, tests, scans, pushes and signs the images it made. The
catalog guide's "Values your builds need" says which values go where.

### What a secret can hold

A secret is a set of named keys, each mounted as a file at
`/platform/secrets/<secret>/<key>`; Vennir doesn't interpret the values.
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
| **SecretStore** | This namespace may read this vault, as this identity: a scope grant | The team proposes it in the catalog (`teams/<team>/secret-stores/`); catalog admins approve; the console applies it after checking it only names a store in the team's namespace, ESO's own ServiceAccounts, and, for a store that needs a stored credential, the Secret `eso-auth`: wherever its provider names a Secret (any `*SecretRef`, any `{name, key}`, a CA from a Secret) or a ServiceAccount, with nothing in another namespace (`namespace`, `remoteNamespace`) and no `kubernetes` provider (`console/src/secretStores.ts`, and `vennir catalog validate`) |
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
change in Vennir.

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

A step is its product only when it runs one of the product's releases: a
digest the product was registered at (`product_releases`), from the same
repository. A catalog release names every product by digest (what its CI
built, tested, scanned and signed); an admin registering one by tag has it
pinned to the digest the tag names then (refused when the registry can't
say). The console pins each step's image before it checks the identity, so
a DAG saying `:latest` is its product only while `latest` is a release.
Each product's current release counts, and an earlier one while it's still
in use: a step of an execution the console hasn't seen finish runs it as
that product (the kernel starts its later steps and attempts by itself),
matched as the identity policy matches a step (its team, the release's
repository, the product's action and ServiceAccount), so a step of another
product released at the same digest doesn't keep it; or it was registered
or run in the last hour. The rest are pruned: a retry or rerun of a step of
one, once its execution has finished and the hour has passed, runs it as an
unregistered image, so it's refused if it asks for the product's
ServiceAccount or Secrets. A submission marks the releases it runs used
and writes any the cluster doesn't list yet before kernel-api has it
(`console/src/productPolicy.ts`). With image pinning off, a product
registered by tag never gets its identity.

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
any Job. Nothing runs for a retired or purged team, even in other teams'
namespaces: a run on its behalf, a retry of one, and anything its bots run
once every team they're in is retired are refused (`TEAM_RETIRED`,
`TEAM_PURGED`), as a step in its own namespace is. The one exception is
an admin's cleanup of what a retired team's runs made (not a purged one's):
it runs without un-retiring the team, which would let its people run anything
again, and only where the product that made it is of a team that isn't
retired, since nothing runs in a retired team's namespace.

Where another team may aim a team's products is the owning team's: an
input typed as a target (`x-vennir-needs: gcp.project`, `gcp.folder`,
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
console's, not the model's: a link in an answer to anywhere but the
console's own pages is shown as its text (`console/src/chat/citations.ts`,
and the chat panel). It answers only about Vennir: a question
judged not about it (by a separate, tool-less call that treats the
question as data) gets a fixed sentence and never reaches the agent, and an
answer resting on neither the docs it cites nor its tools' results is
replaced, so neither a question that talks it out of its instructions nor
the model's memory can put an answer in front of someone. A conversation
is bounded by `chat.contextTokens`. Admins may set its model in the console
(`console/src/core/chatSettings.ts`): its key sealed with a key derived
from `JWT_SECRET`, write-only, and sent only to the address it was given
for: one kept, or the install's own, never goes to an address an admin
changes it to, and Vertex's and Bedrock's address is always built from the
project or region, so the console's own cloud identity can't be pointed
elsewhere. Each change and test is audited with where it points. An
address an admin gives is fetched by the
console from inside the cluster, so testing one reports only whether it
answered as a model (or its status code), never what it replied, nor the
connection's error, which can name internal hosts; that's logged in full
(`chat_model_unavailable`). On GCP it's Gemini through Vertex AI in
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
maintainer, and nor can, for a bot's run, whoever made the bot a token, a
keyless identity or a schedule, or last changed that schedule (and so on
through any bot among them), and a bot never decides: two people agree
before it runs. Who can't is worked out when the run is submitted and kept
with it (`console/src/core/approvals.ts`; a token from before its maker was
recorded names them only when the audit log does). Each decision is in the audit log and, with who decided, in
the step's events; a declined or expired step fails (`APPROVAL_DECLINED`,
`APPROVAL_EXPIRED`), and retrying it asks again. The check is the console's:
kernel-api trusts its caller, as it does for everything else.

A raw DAG needs a maintainer of every team it names. Its steps' teams'
members may see it, each team seeing its own steps in full
([below](#who-sees-a-run-that-spans-teams)); cancelling, retrying or
rerunning it takes a maintainer of every one of its teams (or an admin).
Whoever ran a template may see, cancel, retry and rerun that run: a rerun
runs the template again, as it is now, and a retry is refused once it, or a
step's action, is no longer shared.

## Who sees a run that spans teams

A template run can have steps in several teams' namespaces: the team it was
run for (its consumer) and the teams whose products it uses (its
providers). Its owners (admins, whoever submitted it, members of the team
it was run for) see every step, so a consumer sees what each provider's
step returned. A provider's member sees their own team's steps in full and,
of the rest, only each step's product, state, timing and failure code:
never its inputs, outputs, failure message, the run's template parameters
or its logs (`console/src/core/runView.ts`, in the run's details, its
events and logs, Observe's log search, the chat agent's run tool and a
team's outcome webhook).

A raw DAG is run for no one team, so its owners are admins and whoever
submitted it alone (decided 2026-11-05). A member of one of its teams sees
that team's steps in full and the others' as a provider does: state,
timing and failure code, and the run's own status. Being in a team that
one step of a shared DAG runs in no longer shows every other team's
outputs.

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
The console and the gateway both refuse an expired one. A bot belongs to the
one team that made it: a token or keyless identity asked for at another
team's bot's address, or an automation bot's, is refused, and a bot can't
be added to another team as a member (`teamBot` in `console/src/core/tokens.ts`,
`addMember` in `teams.ts`). An upgrade leaves a bot already in several teams
in its earliest one, its maker's: every token, keyless identity and order
callback made for it since a second team joined is revoked or removed, and
an ordering bot's templates are cleared for its team to list again
(console migration 0058).
What a leaked token can
do depends on its kind:

A bot is never an admin: the console refuses making one an admin
(`UserService/SetAdmin`), and the console and the gateway both resolve a
bot as no admin even if its row says it is one.

- **A team's bot** is a maintainer of its team (`console/src/core/tokens.ts`),
  so its token can do what a maintainer can there: register and replace
  the team's secrets, submit raw DAGs, retry and cancel the team's runs.
  No bot makes credentials or changes who's in the team: bots, their tokens
  and keyless identities, members, roles and the team's sign-in rule are
  people's to change (`auth/access.ts`'s `ensureNotBot`), so a keyless
  session's hour is all it ever has.
- **An ordering bot** is a member, and may only order the templates its
  maintainers list for it ([Ordering bots](#ordering-bots)); it calls no API
  through the gateway.
- **An automation token** (admins only) belongs to no team and can do
  exactly what its scopes say (`console/src/auth/scopes.ts`): create teams,
  register any team's products, retire or purge teams, apply SecretStores.
  It can't read a secret or submit a run.

Where the CI supports it, sign the bot in keylessly instead (next): then
there's no token to leak.

## Keyless bots

A bot can sign in with its CI job's own OIDC identity instead of a stored
token, so a pipeline holds no Vennir secret. It can be made that way
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
be replayed here; with neither, keyless sign-in is off) and expiry, and returns an hour's ordinary session for
the one bot whose claims it carries; two or none is a refusal. So no bot's
identity may overlap another bot's (one token could match both: every claim
they share has the same value), or one team could stop another team's bot
signing in by adding a broader identity. Each sign-in
is logged with the bot, issuer and subject, and the identity's last use is
kept.

## Ordering bots

An *ordering bot* (decision 23: a storefront or another system placing
orders) is a member of its team, not a maintainer, and may run only the
templates its team's maintainers list for it: no raw DAG, no single action,
no rerun (`ORDERS_ONLY`, `TEMPLATE_NOT_ORDERABLE`). A leaked ordering token
can order those templates for that team, under its caps, quota and
approvals, and at most the install's rate a minute
(`orders.ratePerMinute`, 60 by default; 429 past it, counted from the runs it
made, so every console replica agrees). Like any member, it may also delete
what its team's runs made (its products' cleanup actions): the system placing
orders through it decides who may ask that of it (decided 2026-11-04). The runs a schedule makes as its bot
aren't limited this way: the schedule is its team's, reviewed by its maintainers.

An ordering bot may have a callback, where each of its orders' outcomes is
posted, and a team an outcome webhook, where each of its runs' outcomes is
(`console/src/callbacks.ts`). Like a team's chat webhook, its URL
is sealed with a key derived from `JWT_SECRET`, never sent back, only under
the hosts the install allows (the console chart's `orders.callbackHosts`,
none by default) and never redirected. Each post is signed with the bot's own
secret (HMAC-SHA256 over the time and the body, `Vennir-Signature`), shown
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
Deleting the bot deletes its schedules. A retired team's schedules don't
run: each time is skipped and logged (`schedule_skipped`), and the schedule
kept, so it runs again once an admin un-retires the team; purging the team
deletes them.

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
API backends teams run (Pods labelled `vennir/api-backend: "true"`) and the
platform's own. An API backend's lines, every level, are for its own team
only (they belong to no run, so no one else owns them; a backend in
`<team>-apis` is that team's, unless a team has that very name); the
platform's own logs are for admins only.

## The API gateway

API products (decision 20) publish a team's own backend through one
gateway (`gateway/`). The gateway forwards a request only when its method
and path are an operation in the API's reviewed OpenAPI document and it fits
that operation's schemas; anything else is answered by the gateway (404 or
400) and never reaches the backend. Callers sign in as at the console (a
session or a bot token, checked against the console's database the same
way: a team requiring single sign-on refuses a password's session whether
the install's settings or an admin in the console turned it on (if the
saved client secret can't be unsealed, the console counts it off and the
gateway, which never reads it, on), and a
purged team counts for nobody), and may call an API only when it's shared
with one of their teams. An ordering bot calls none (403 `ORDERS_ONLY`): it
may only order its listed templates.
The caller's `Authorization` stops at the gateway; the backend gets its own
credential instead, minted per request, and `Vennir-Caller`, an EdDSA JWT
the gateway signs (its key at `/.vennir/jwks.json`) naming the caller,
their team and the API. An API may only use an in-cluster backend in its
own team's API backends' namespace (`<service>.<team>-apis.svc`), which the
console makes beside each team's namespace, labelled `vennir/api-backends`
and never `vennir/team`: no step is dispatched there, no product identity
or team Secret is written there, so whatever a team deploys its backend
with holds none of them, and its steps reach the backend only through the
gateway. For one release a backend still in the team's own namespace
(`<service>.<team>.svc`) is served too, and the gateway logs it
(`api_backend_in_team_namespace`) on every refresh until it moves. One
pointed at any other namespace is held, by the console and the gateway,
whatever `backendHosts` allows, so no team can serve another's backend
under its own spec and sharing (`<team>-apis` counts as the team's only
while no team has that name: none can be named `*-apis` now, and one named
so before keeps its namespace); a backend should still check the token's
`api` as well as its `aud` (the sample does). The namespace is read from a
Service's name and a headless Service's Pod's (`<pod>.<service>.<ns>.svc`),
with or without the cluster's domain (the console chart's `clusterDomain`;
`cluster.local` is read as the cluster's too). A host inside the cluster
that names no namespace is held, by the console and the gateway, whatever
`backendHosts` allows: any IP address but the loopback (a Pod's or a
Service's IP is anyone's), a Pod's name (`<a-b-c-d>.<ns>.pod`, which
cluster DNS answers with the address in it whatever namespace it says, so
it's an IP address as any other), a single name
(the Pod's DNS search path finds it in the platform's namespace), and any
other name under the cluster's domain or ending in `.svc` or `.pod`. Every
other host the gateway looks up as the absolute name it is, never through
the search path, so `orders.web` can't turn out to be
`orders.web.svc.cluster.local`, and a `.svc` or `.pod` short form with the
cluster's domain added: what it dials is what was read
(`gateway/internal/store`, the console's `core/apis.ts`, kept in step and
tested with one table of hosts). A caller's own `Vennir-*` headers are dropped, as are a backend's on its answer (they're the gateway's alone),
and so is what it says of where it's from (`Forwarded`, `X-Forwarded-*`,
`X-Real-Ip`): `X-Forwarded-For` is the gateway's own peer, or, on the
public listener behind a proxy listed in `gateway.trustedProxies`, the last
address those trusted proxies saw (never one the caller wrote before it).
Trusting a proxy needs `gateway.publicListenerFrom` too (the chart refuses
it otherwise): a NetworkPolicy lets only those proxies reach the public
listener, since anything connecting from a trusted address could say it's
anyone, and an in-cluster controller, or an ALB on the VPC CNI, shares its
addresses with every Pod (proven on kind 2026-11-03: a team's Pod can't
reach it, the controller's namespace can). A cookie a
backend sets is kept to its API's path, so one team's backend can't set or
overwrite another's on the gateway's shared origin. A path isn't a
boundary within an origin, though: script on a page one backend serves can
read another API's cookies that aren't HttpOnly, and send requests to it
with its cookies attached. So a backend that serves browsers keeps its
cookies HttpOnly and doesn't take a cookie alone as sign-in (the gateway
itself signs callers in by a bearer header only); a host for each API is in
`TODO.md`.
Paths with encoded slashes, backslashes or dot segments (`..;` too) are
refused, so what's checked is what's forwarded, and so is a `;` in a path,
as is or `%3B` (400 `INVALID_REQUEST`), unless the API's document has a
path parameter of `style: matrix`: the validator reads it as part of the
segment, where a backend's framework may read a matrix parameter or drop
what follows. Before sign-in, an API
that's hidden or paused is answered as one that isn't there (404), so its
state and pause message reach only signed-in callers who can see it; a
hidden one is 404 to anyone but its own team and admins, as in the console.
A client address (the peer, or the address trusted proxies saw; an IPv6
/64) that fails to sign in more than `gateway.unauthenticatedPerMinute`
times a minute (60) is refused with 429 before sign-in, so before any
database work, until it's under again (not on the public listener behind
a proxy every caller shares that `trustedProxies` doesn't list, as with the
chart's ingress and no `trustedProxies`: there one caller's failures would
shut out the rest, so list the proxy to keep the limit); and a request's body must arrive
within `gateway.bodyReadTimeoutSeconds` (30), so slow senders can't hold
connections open (answers aren't limited: they stream). Both are counted
per replica.

Backends must be under hosts the admins allow (`gateway.backendHosts`), or
the API is held: the gateway can't be pointed anywhere a catalog says. Its
only Kubernetes right is minting ServiceAccount tokens, and an admission
policy limits that to API ServiceAccounts (`*-api`) in active (not retired) team namespaces, for
a named audience that isn't the Kubernetes API's or kernel-api's, lasting an
hour at most, so it can't mint the platform's or a team's other identities,
or a token for the cluster itself. A backend's token (`serviceAccountToken`)
may not carry an audience a cloud exchanges for an identity either
(`sts.amazonaws.com`, `api://AzureADTokenExchange`, a GKE pool
`<project>.svc.id.goog` or its `identitynamespace:` audience, a GCP
workload identity provider), or the backend could sign in to that cloud as
the API's ServiceAccount: the catalog tool, the console's catalog sync and
the gateway refuse them. The admission policy refuses Azure's and the
`identitynamespace:` ones too, but not AWS's or the Google pool's: the
gateway asks for those itself, for the same ServiceAccounts, for its own
`awsSigV4` and `googleIdToken` exchanges, and a request doesn't say which
it's for, so there the gateway's own check is what holds. `-api` is reserved: no product may run as
such a ServiceAccount, and an API's must end in it. It reads the
console's database as a role of its own (`vennir_gateway`,
`console/src/db/gatewayAccess.ts`): it may read the columns it needs to
sign callers in and find APIs (never a password hash, a sealed value, a
secret's name or the audit log) and write only its traffic counts
(`api_traffic`), why it can't serve an API (`api_problems`) and when an API
token was last used (`api_tokens.last_used_at`, as the console keeps it).
A retired team's members and bots don't call as it. It checks sessions with the console's public key (its
JWKS, `/api/auth/jwks`), so it can verify a session but never make one,
and never holds `JWT_SECRET` (proven on kind 2026-10-28: the gateway
connects as `vennir_gateway`, accepts a console session, refuses one signed
any other way). The console publishes only the key of its current
`JWT_SECRET`, and the gateway reads the set again a minute after it last
did, so once `JWT_SECRET` changes, a session signed with the old key stops
verifying at the gateway within that minute (and at the console at once).
While the console's JWKS can't be read (the console restarting), the
gateway can't know a key is gone, and keeps the last set for at most 10
minutes before refusing every session with 503 (`gateway/internal/auth/
keys.go`, `keysFor` and `keptFor`, tested). Bot tokens are checked against
the database on every request. When it signs in to the database with a
cloud IAM token (`database.iamAuth`), the token is the password, so it
refuses at startup a `DATABASE_URL` whose `sslmode` isn't `verify-full` or
`verify-ca`, unless it connects to localhost (a Cloud SQL Auth Proxy beside
it), as the kernel does. Requests are logged and counted by
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
  audience `vennir-kernel-api` (rotated by the kubelet, valid an hour), so
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
provider account given the same email is refused. Binding an account that
already existed makes single sign-on its only way in: its password goes,
and every session from before ends (anyone may register an unclaimed email
with a password of their own, where self-registration is on). The session comes back in
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
be read then keeps their teams until the next try); this runs only while
Google Workspace is the only source. A groups claim can be read only at a
sign-in, so while one is set and single sign-on is on, a membership a group
gave (on a team that's still mapped, `team_memberships.from_groups`; the
gateway may read that, not the groups' names) counts only for a single
sign-on session signed in within the hour, at the console and the gateway
alike: an older single sign-on session is refused, so its person signs in
again and their groups are read, and a password's session (say, after an
admin's reset) or an API token goes on without those teams. A sign-in that
leaves someone such a membership gets a session of an hour at most
(`CLAIM_GROUPS_SESSION_SECONDS`, `console/src/sso.ts`), so someone the
provider takes out of a group is out of its team within the hour. While
single sign-on is off (or its saved client secret can't be read), nobody
could sign in to have their groups read, so the rule doesn't apply. Other
readers of memberships (approval and failure notifications, the Members
tab) still see a group's team until the person's next single sign-on
(`TODO.md`). Groups that can't be read (a missing claim,
too many groups for the token, Google's API failing) refuse the sign-in
(`GROUPS_UNAVAILABLE`) rather than count as none, which would take people
out of their teams. On a mapped team, a single sign-on member's membership
can't be changed by hand (`TEAM_FOLLOWS_SSO_GROUPS`); bots and password
accounts are managed there as ever.

A password someone else set (a new account's temporary one, an admin's
reset of someone else's, `vennir admin reset-password`) has to be changed
before anything else: until then its session may only read who it is and
change it (`PASSWORD_CHANGE_REQUIRED`), and the gateway refuses it.

**Passwords** are hashed with argon2id at the library's default cost
(`console/src/auth/password.ts`). A new one must be 12 to 256 characters;
nothing else is checked (no character classes, no breached-password list).
There's no second factor for password accounts; where that matters, use
single sign-on and the provider's. Password accounts are made by admins: open
registration (`ALLOW_SELF_REGISTRATION`) is off by default and, when on,
doesn't verify the email. So an account that signed itself up
(`users.self_registered`) may be anyone's: a maintainer adding it to a team
by its email is refused, saying nobody verified the address
(`EMAIL_NOT_VERIFIED`), until single sign-on binds it to the provider's
account (which checks the email); an admin, who can check it's theirs some
other way, may add it.

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
(8 hours by default; single sign-on's too, unless groups from a claim gave
the person a team, then an hour at most; a keyless bot's an hour). Nothing
extends a session: there's no refresh, so an expired one means signing in
again. The
browser keeps one in `localStorage` and sends it as a bearer header, never
a cookie, so there's no cross-site request forgery to defend, save one:
single sign-on hands the session back in `/login`'s fragment, and the page
takes it only back from a sign-in this tab started (a random value it
keeps in `sessionStorage`, carried through the provider in the flow's
signed cookie and echoed with the session), so a link carrying someone
else's session can't sign a person in as them. The token
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
  registry credential into every team namespace as `vennir-pull`, and the
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
  deleted. The owner makes either with `vennir catalog grant`, which names
  exactly one reader's identity.
- **Cluster administrators**, and anyone else the cluster's own RBAC lets read
  Secrets in a team namespace. Vennir doesn't grant people Kubernetes
  access, but doesn't prevent a cluster operator from doing so.

## Guardrails the cluster enforces

These are ValidatingAdmissionPolicies (and, optionally, Sigstore's
policy-controller), so they hold even for a request that reaches the kernel
without going through the console:

| Guardrail | What it refuses | Where |
| --- | --- | --- |
| Dispatch namespaces | Jobs in any namespace not labelled `vennir/team=true`, and in the platform's own namespace (`DISPATCH_REJECTED`) | `helm/charts/execution-kernel/templates/dispatch-policy.yaml` |
| Step Pod shape | A Job of the scheduler's whose Pod mounts any volume but its own request ConfigMap (under its Job's name), scratch space (`emptyDir`), Secrets and projected tokens; names any pull Secret but `scheduler.taskImagePullSecret` (`vennir-pull` when set); names a node, or a node selector, tolerations or affinity the install doesn't place steps with (`scheduler.taskPlacement`, `capacityPlacements`) (`DISPATCH_REJECTED`). Exactly what the executor makes: a kernel test keeps `helm/tests/step-job.json` equal to its Job, and the admission tests admit that | `templates/dispatch-policy.yaml` |
| Step Jobs | In a team namespace, anyone but the scheduler creating or changing a Job or ConfigMap named `ek-`, or a CronJob named `ek` or `ek-…` (kube-system's CronJob controller makes its Jobs, named `<cronjob>-<time>`), unless kube-system's controllers or the controller manager made or changed it (`STEP_JOB_NOT_ALLOWED`). So nobody else's ConfigMap is mounted as a step's request, and no Job made ahead of the scheduler is adopted as a step's. Deleting one isn't refused: a delete can't put anything in its place. A second install on the same cluster needs its own team label (`dispatchPolicy.teamNamespaceLabel`) | `templates/step-jobs-policy.yaml` |
| Step Pods | In a team namespace, a Pod with a task Job's `job-name` or `controller-uid` label, or owned by an `ek-` Job, unless kube-system's controllers or the controller manager made or changed it (`STEP_POD_NOT_ALLOWED`). The kernel also reads a step's result only from a Pod its Job controls, by the Job's UID | `helm/charts/execution-kernel/templates/step-pods-policy.yaml` |
| Image sources | Images outside the allowed registries, and any image with an uppercase letter in its registry or repository (`IMAGE_NOT_ALLOWED`): a registry host is case-insensitive, so it wouldn't match its source as written, and Docker reads an uppercase first part as a registry host; repositories are lowercase, so only a tag may have uppercase | `templates/image-policy.yaml` |
| Image signatures | Where policy-controller is installed, any Pod in a team namespace whose image isn't signed by catalog CI under the source registry, whoever makes it (`IMAGE_NOT_SIGNED`): images from sources an admin added don't run there either (`no-match-policy` stays `deny`, so a compromised console adding a source can't get past it). It checks Pods, not the Jobs and other workloads that make them, which a second policy passes without verifying them (the webhook still admits them): a step's Job is made, and its Pod refused (the Job's `FailedCreate` event, which the kernel reads) | `templates/image-signature.yaml` |
| Image scans | An image not pinned by digest (`IMAGE_NOT_PINNED`), or one whose digest hasn't passed its security scan on this install, failed or never scanned, unless an admin accepted a failed one (`IMAGE_SCAN_FAILED`). The policy is an allow list the console keeps: digests that passed (or were accepted) and are still in use (a registered product's, a step of an execution not yet finished, or used in the last hour); a submission, retry or rerun scans its images and writes their digests there before kernel-api has it. At most 5,000 digests: the API server compiles at most 100,000 characters per CEL expression (about 1,250 digests), so they're sixteen CEL maps by first hex digit, at most 1,200 each, about 400 KB in all. On an upgrade from the chart that refused only failed digests, the chart admits what isn't listed, refusing those it refused, until the new console has run ten minutes and writes the allow list alone, so steps of consoles still rolling out aren't refused. The console scans every image before it's registered or run, and daily while in use, for each platform the cluster runs (the console chart's `scanning.platforms`; a multi-arch cluster lists every one). The console chart's `scanning` must be on whenever this policy is, or every pinned step is refused | `templates/scan-policy.yaml` |
| Step identity | A step running as any ServiceAccount but `default` unless it runs a registered product's release (one of the digests the product was registered at, from its repository, while in use) as the one its `product.yaml` declares; any step mounting a Secret unless it runs such a release and the Secret is registered for its team; Secrets reaching a step any way but a volume (`IDENTITY_NOT_ALLOWED`). The console keeps the policy's released digests (sixteen maps by first hex digit, up to about 2,600 digest-action pairs) and team secrets current. | `templates/identity-policy.yaml` |
| Team deletion | A configured purger deleting a team namespace that isn't labelled retired (or a team's API backends' namespace, `<team>-apis`, not labelled `vennir/api-backends=retired`). None is configured by default: the console leaves a purged team's namespace, labelled retired, for a cluster administrator to delete, so the identity that retires a namespace can't also delete it (`teamNamespaces.purge` would let it) | `templates/purge-policy.yaml` |
| Console namespaces | The console creating a namespace that isn't labelled a team's, adopting one that isn't a team's, changing anything about a team namespace but its team label, or touching kube-* or the platform's own | console chart, `templates/namespace-policy.yaml` |
| Console write fence | The console's ServiceAccount creating, changing or deleting Secrets, ServiceAccounts, Roles, RoleBindings or ExternalSecrets outside team namespaces (kube-system, the platform's own); creating an ExternalSecret without its `app.kubernetes.io/managed-by: vennir-console` label, or updating one that didn't carry it | console chart, `templates/write-fence-policy.yaml` |

The platform's namespace is never a team's (never labelled `vennir/team`).
One that was would lose more than the dispatch guardrail there:
- the team's `vennir-default-deny` admits every Pod in the namespace to
  every other, so that team's steps can reach the platform's Postgres and
  kernel-api (passwords and TokenReview still hold; the network layer
  doesn't);
- a product of that team may declare one of the platform's own
  ServiceAccounts, and the identity policy lets its steps run as it (with
  its cloud identity, on Workload Identity);
- the console's write fence counts the namespace as a team's, so it may
  write the platform's own Secrets (the databases', the session key);
- policy-controller has to exclude it, so that team's steps run unsigned
  images;
- the gateway's token fence matches kernel-api's ServiceAccount there;
- the team's quota counts the platform's own Pods.

So the kernel chart has no setting that runs steps there (it had
`dispatchPolicy.allowReleaseNamespace` while the GKE reference install ran in
`default`, an admins' team namespace). `vennir` and the GKE reference values
install into `vennir-system`; moving an install out of a team's namespace is
in `docs/operations.md`.

The dispatch, image, scan and identity policies check the scheduler's own
requests and nobody else's (their `matchConditions`). Anyone else the
cluster lets create Pods in a team namespace, such as a cluster
administrator, isn't checked by them: only Pod Security
([What a step can reach](#what-a-step-can-reach)) and, where it's installed,
policy-controller's signature check apply to every Pod there.

An install `vennir` makes sets up signing itself when its catalog is signed
(`signing` in vennir.yaml, asked at `vennir init`): `kms`, a key in the
cloud's KMS (a GCP key ring with a fresh suffix, or an AWS ECC P-256 key)
that only the catalog repository's CI, through its main-only federation
(which trusts the repository by its GitHub id and its owner's, not its
name, so a repository renamed, or re-created under the name by someone
else, isn't trusted), may sign with, its public half read at apply; or `keyless`, the repository's
`ci.yml` on main by GitHub's OIDC issuer, through Sigstore's public log
(which names the repository). Either way it installs policy-controller,
scoped to team namespaces and bound to an identity that may only read the
task registry, gives the kernel's imageSignature and the console's
catalog.signature the same signer, and sets the repository's
VENNIR_SIGNING_* variables. Proven on GKE (2026-10-26), both modes: CI
signed images and releases; the console applied only signed releases ("no
trusted signer signed the catalog release … nothing was applied" for one
pushed unsigned); a signed starter ran and an image pushed by hand, unsigned,
was refused (`IMAGE_NOT_SIGNED`). Proven on EKS too (2026-10-26), `kms`:
an AWS KMS key, with policy-controller reading ECR through Pod Identity; the
same four results.

A console never applies a release older than the one it applied (by its
signed `createdAt`), so a release signed long ago can't be served again in
place of a newer one (`console/src/catalogSync.ts`); going back is
releasing that commit again.

An install reading another's catalog (`externalCatalog`) holds no signing
right: it trusts the owner's signer (`catalogSignature`: its public key, or
its repository's keyless identity) and, on gcp and aws, enforces it on
releases and images the same way, its policy-controller reading the
owner's registry (as its own identity in another Google Cloud project;
across clouds or AWS accounts, with the steps' pull Secret). The owner
grants that read with `vennir catalog grant`, to the reader's identity
alone and on the catalog's registry alone: its service accounts, or its
console's ServiceAccount from its cluster's issuer, never a key. A catalog version (decision 22) is a tag on a release
main already signed, so it needs no signature of its own, and the tag's
own CI run holds no credential: it asks main to make it.

Two platform identities only change replica counts, through the scale
subresource (which can't change what a Deployment runs), on Deployments
named in their Roles: the kernel's sleeper (`scaleDown`, the platform's
own Deployments, plus its own `-sleep` ConfigMap and a read of the
console's `-activity` one) and the console (only the image scanner's, to
idle it, and its own `-activity` ConfigMap). The sleeper also patches two
CronJobs, its own and the wake one, and an admission policy in
`sleeper.yaml` lets it change only their `suspend`, `schedule` and
`timeZone`, never the Job they run. A stolen token of either can stop the
platform, not change it.

And at the network level, NetworkPolicies (`templates/networkpolicy.yaml` in both charts) let only the platform's own Pods connect to its Postgres, and only the console connect to kernel-api (not the gateway, which forwards where catalogs say): a step's Pod can reach neither. Every team namespace also holds `vennir-default-deny`, which the console writes with the namespace and rewrites on every policy resync (`console/src/teamNetwork.ts`): its Pods accept connections only from Pods in the same namespace, so one team's steps can't reach another team's Pods or Services. With the gateway on, it also writes `vennir-gateway-ingress`: the gateway's Pods (this release's namespace and the gateway's own labels) may reach the Pods the team labels `vennir/api-backend: "true"`, its API products' in-cluster backends, and nothing else of the team's (proven on kind 2026-10-28: through the gateway, 200; from another team's namespace, no connection; from its own namespace without the gateway's signed `Vennir-Caller`, the sample backend's 401). Those backends run in the team's API backends' namespace, `<team>-apis` (labelled `vennir/api-backends`, never `vennir/team`), which holds the same `vennir-default-deny` and `vennir-gateway-ingress` (and `vennir-no-metadata` with `teamNamespaces.blockMetadata`) and nothing else of the console's: no Secrets, ServiceAccounts, RoleBindings, quota or limits, so its steps, in the team's namespace, can't reach the backend but through the gateway. For one release the team's namespace keeps its `vennir-gateway-ingress` too, for backends not yet moved. The console's write fence accepts no other NetworkPolicy from it, and only those shapes (a broader selector, any namespace, any Pod of the platform's, or an extra peer is refused), and nothing but those NetworkPolicies in an API backends' namespace; its RBAC can't delete one, so a compromised console can't open a team namespace up. The console creates `<team>-apis` with the team (and, on its policy resync, for teams made before), retires it with the team and, with `teamNamespaces.purge`, deletes it with the team's; the namespace policy lets it create only a namespace named `*-apis` with that label, and never one with both labels. Outgoing traffic isn't restricted: steps call their clouds. Every team namespace also holds a ResourceQuota (`vennir-team-quota`) and LimitRange (`vennir-team-limits`) when limits are set (`console/src/teamQuota.ts`: the chart's `teamNamespaces.quota`, or a team's own set by an admin), so one team's steps can't take the cluster's capacity from the others; the cluster refuses a Pod over them, and the write fence accepts no other quota or limits from the console. They need a CNI that enforces NetworkPolicy, and they select Pods by label, so creating Pods in the platform namespace must stay limited to administrators (and it mustn't also be a team's: see [Guardrails the cluster enforces](#guardrails-the-cluster-enforces)). The bundled databases' passwords are generated on install.

## What a step can reach

**Its Pod.** Every step Pod meets Pod Security's `restricted`
(`kernel/internal/executor/kubernetes.go`): it runs as a non-root user (the
image must name a numeric non-root `USER`), on a read-only root filesystem
with a writable `/tmp`, with every capability dropped, no privilege
escalation, the runtime's seccomp profile, and no Kubernetes API token
(`automountServiceAccountToken: false`). It's never privileged. There's no
setting to turn this off (the kernel chart's `scheduler.taskPodHardening`
was removed 2026-11-05): an image that can't run that way must be changed.

The cluster holds a step to that only where the namespace enforces Pod
Security: the console labels each namespace it creates
`pod-security.kubernetes.io/enforce: restricted` (the console chart's
`teamNamespaces.podSecurity`; `console/src/k8s.ts`, `setTeamNamespace`), and
the namespace policy won't let it remove the label. A team namespace the
console adopted rather than created, or one made with `podSecurity` empty,
has no such label. Either way, the kernel's
dispatch policy refuses any Job of the scheduler's that isn't hardened
that way (no API token, non-root, a read-only root filesystem, no
capabilities or privilege, nothing of the host's: proven on kind
2026-10-28), so a scheduler tricked into making another Job still can't.

The dispatch policy also holds a step's container
to what the executor builds: its image's own entrypoint (no `command`), the
action as its one argument, no environment but the install's
`scheduler.taskExtraEnvironment` (as values, never from a Secret or
ConfigMap), and no projected token without an audience (the Kubernetes
API's). So even a Job the scheduler was tricked into making can't run other
code as a product's identity, with its Secrets, or carry a token for the
cluster. The one change it may make to a Job is resuming one of its own:
each is created suspended, and resumed only once its request ConfigMap is
the kernel's (one planted ahead of it under its name is replaced first), so
a Job the kernel made never mounts a request it didn't write (proven on kind
2026-11-03). A Job someone else made first under the attempt's name, exactly
as the kernel would and already resumed, is still adopted; making one needs
Job-create rights in a team namespace, which teams and steps don't have
(`TODO.md`). Each container is held to the hardening too: non-root,
never user 0, seccomp `RuntimeDefault`, no host port.

**The network.** In, only Pods of its own namespace (and the gateway, to a
team's API backends). Out, anything: the internet, its cloud, the
Kubernetes API server (with no token to call it),
the console's and the gateway's public ports, and Services in namespaces
with no ingress policy; the cloud's metadata server too, except on EKS
(below). It can't reach either Postgres, kernel-api, the image scanner,
Loki, or any metrics port. All of this needs a CNI that enforces
NetworkPolicy: on EKS, `vennir` turns enforcement on (the VPC CNI's
`enableNetworkPolicy` in standard mode, the `amazon-vpc-cni` ConfigMap in
Auto Mode), off by default there.

**The metadata server**, so the node's own cloud identity:

- On GKE clusters `vennir` makes, the metadata server is Workload
  Identity's (`GKE_METADATA`, `cli/internal/modules/gcp/main.tf`): a step
  gets only the Google identity bound to its own ServiceAccount, and none
  as `default`; never the node's.
- On EKS, the console writes `vennir-no-metadata` into every team
  namespace (the console chart's `teamNamespaces.blockMetadata`, on in the
  EKS values and in what `vennir` installs there): every Pod may connect
  anywhere but `169.254.169.254`, so a step can't ask for the node role's
  credentials. IPv4 only: on an IPv4 cluster the VPC CNI's policy agent
  can't hold an IPv6 block, and failing to, it enforced none of the
  namespace's policies, the default deny included (found on standard-mode
  EKS 2026-10-29, and fixed). Steps that need AWS get their own role
  through EKS Pod Identity (`169.254.170.23`, still open) or a web-identity
  token. The write fence accepts that policy only in a shape that lets out
  everything less `169.254.169.254`, and no egress rule in the console's
  other policies (allows add up, so one would undo it). Proven on EKS Auto Mode 2026-10-28: a
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
  installed; Pod Security in the namespaces it created; and the only Jobs it
  may run in the platform's namespace are its image scans and catalog
  verifications, as the scanning identity with no token, this release's
  Trivy or cosign image, no Secret but the registry pull Secret, non-root
  and with nothing from the node (`console-jobs-policy.yaml`), so a Job
  can't read the platform's Secrets or run as another of its identities.
- **kernel-api**'s ServiceAccount may only ask the API server who a token
  belongs to (`system:auth-delegator`). It holds the kernel's database: every run's
  inputs, outputs and logs, and the task rows the scheduler runs. On the
  bundled Postgres it signs in, as the scheduler and the sleeper do, as the
  kernel's own role (`postgres.auth.kernelUsername`, `vennir_kernel`): no
  superuser, owning only the kernel's database, refused the console's on
  the same instance (proven on kind 2026-11-03); the superuser is used only
  by Postgres itself, backups, and the step before each migration that
  makes that role. With a managed database each process signs in as its own
  cloud identity, likewise kept to the kernel's database. A task it
  wrote there still passes all four Job policies when the scheduler starts
  it: a registered product of the team, as its own ServiceAccount, with
  only the team's registered secrets, from an allowed, pinned, scanned
  image, in a team namespace.
- **The scheduler** has the kernel's database too, and a ClusterRole
  (`helm/charts/execution-kernel/templates/rbac.yaml`): create Jobs and
  ConfigMaps (the dispatch policy keeps them to team namespaces, and the
  Job policies check every Job, down to its volumes, pull Secret and
  placement); list and watch every Pod in the cluster
  read steps' logs only in team namespaces (a logs-only ClusterRole the
  console binds in each one; not the platform's or kube-system's, unless
  the kernel chart's `rbac.schedulerLogs: cluster`, for an install whose
  team namespaces the console doesn't manage); delete Jobs and ConfigMaps, which the dispatch policy keeps to its own
  (labelled `app=execution-kernel`, named `ek-…`) in team namespaces,
  retired ones included (proven on kind 2026-10-28); list events.
- **The gateway** may mint ServiceAccount tokens only for `*-api`
  ServiceAccounts in team namespaces, for a backend's own audience, for an
  hour at most ([The API gateway](#the-api-gateway)).
  Its database role reads who callers are and the published APIs, and
  writes its traffic counts; it holds no `JWT_SECRET`, so it can't make a
  session, and can't read a password hash or unseal anything. It could
  forward requests it shouldn't to the APIs' backends, as any of their
  callers.
- **The sleeper** can change replica counts and stop the platform, not
  change it (above).

## Vennir's own supply chain

On each version tag, the release workflow (`.github/workflows/release.yml`)
refuses a tag whose commit isn't on `main` (which takes only reviewed pull
requests), then builds the kernel, console and gateway images (amd64 and
arm64) and pushes them to GHCR by digest. It scans each platform's image,
as pushed, with CI's gate (`.github/scripts/scan-image.sh`: a HIGH or
CRITICAL vulnerability with a fix, a secret in a layer, or a
known-malicious package fails the release), signs each digest with cosign,
keyless, as the workflow's own GitHub identity, and only once all three
have passed tags them as the version. A version's tags are written once:
a run refuses a version already published, and a re-run of its failed jobs
keeps what an earlier attempt published. The charts and the `vennir` binaries are
signed the same way, and a catalog's `./vennir` downloads its binary by
SHA-256; the release checks it with govulncheck before pushing it. Every
pull request also runs Semgrep (Go rules included), gitleaks, govulncheck
over the CLI, the kernel and the gateway, and the same scan of the three
platform images (`.github/workflows/security.yml`, `ci.yml`).

The "only from `main`" check is the tagged commit's own: a tag push runs
the `release.yml` in the commit it tags, so a branch commit whose
`release.yml` leaves the check out would still be released, and signed as
`release.yml@refs/tags/v…`. So the guarantee rests on the repository's
`release tags` ruleset (since 2026-11-03), which lets only admins create,
update or delete `v*` tags; the check itself stops mistakes, such as
tagging the wrong commit.

Nothing verifies those signatures when installing: `vennir` checks the
charts against the SHA-256s each release records (each cosign-verified
once), but the charts run their images by tag unless
`image.digest` (and `gateway.image.digest`) pins them, and policy-controller doesn't cover the platform's
own namespace. To check one by hand (a version tag's run only: the same
workflow run from a branch signs as `release.yml@refs/heads/<branch>`,
which this refuses; `make gke-verify-release` requires the exact tag).
Either proves an image came from a version tag's run, which means reviewed
code given the `v*` tag ruleset above:

```console
$ cosign verify ghcr.io/<owner>/<repo>/execution-kernel:<version> \
    --certificate-identity-regexp '^https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/tags/v.*' \
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
and single sign-on sign-ins, registering and changing a password. A call
with no one signed in to a method that needs someone is refused before it
does anything and only logged (`event: "rpc_unauthenticated"`), so
anyone who can reach the console can't fill the audit log. Each
entry is in the `audit_log`
table, hash-chained so a change or removal shows, and in the console's log
as `event: "audit"`. A catalog release's changes are recorded too, and
so is each team membership single sign-on groups add, remove or change (at
a sign-in or the hourly resync). Settings are recorded as they're set (the
chat agent's provider and endpoint, single sign-on's issuer, client id and
domains), never a key or secret, only that one was given.
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

## What Vennir stores

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
goes through end to end. That's the layout of every install `vennir`
makes (EKS and GKE too): one Postgres, in a Pod, for both databases. The
console's own Postgres, which the hand-written GKE values use, is proven
too (2026-10-29, those charts' layout on a kind cluster of its own): every
connection to it TLS, the gateway's as its own role, a plain one refused. To
rotate, delete a chart's `-tls` and `-tls-ca` Secrets and upgrade
([operations](operations.md#rotating-secrets)).

## Rules for product authors

Products are written by catalog contributors, not by Vennir, so these are
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
- **Use failure codes of your own.** The codes the platform sets (its
  refusals, timeouts, schema and result checks: `domain.ReservedCodes`) are
  trusted by callers and the console's failure help, and their
  retryability is the kernel's. A step that reports one fails as
  `PRODUCT_CODE_RESERVED` instead, its message kept with the code it
  claimed, and isn't retried.
- **Be idempotent.** Steps run at least once: a retried step must not create
  something twice or charge twice. Cancelling a run stops a step already
  started, but a step whose start was under way when the cancel came is
  started, then stopped on the scheduler's next pass.
- **Read secrets only from `/platform/secrets/`**, never from inputs, and never
  bake one into an image. Images are shared, cached and pulled by every team.

## Not yet enforced

Known gaps in 0.x, all tracked in [`TODO.md`](../TODO.md). They're the reason
Vennir isn't production-ready yet.

| Gap | Impact | Plan |
| --- | --- | --- |
| A compromised console can loosen the image, identity and scan policies, and write any team's Secrets | It could run a step of its choosing with any team's secrets ([If a component is compromised](#if-a-component-is-compromised)) | Accepted for now: Kubernetes can't guard admission policies from their editor; treat the console as the most privileged component |
| Reads aren't audited ([Audit](#audit)) | Who looked at a run's outputs or logs isn't recorded | Not decided |
| The audit log lives in the console's own database unless `audit.export` copies it to write-once storage (its entries are hash-chained, and with the copy compared with the database entry by entry; Observe shows the log as each caller may see it) | Without the copy, someone who can write that database could change it, rewriting the chain after it | Turn on `audit.export`, or ship the `event: "audit"` log lines to a SIEM |

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
