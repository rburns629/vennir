# Catalog

Where teams declare what they offer to Vennir. Each team has a
folder; each of its products is a container image plus a `product.yaml`
saying what its actions take, return and need. Open a pull request and CI
builds, tests and scans it; merge it and the image is pushed, and the
catalog's release names it. Each Vennir install's console reads that release
and registers what it says: CI never calls a console, and one catalog can serve
any number of installs.

CI runs one tool, `./vennir` (the platform's command line, at the release
pinned in that file: downloaded on first use from the platform's public
package by its SHA-256, and checked against it), and so
can you: `./vennir catalog check` runs every pull request check on your machine,
and `./vennir catalog publish` publishes from a laptop when there's no CI.

`teams/` starts empty: your first team goes there. `samples/` holds whole
example teams, never published from there:

- `samples/local`: no cloud, no secrets, the same small product in Python,
  TypeScript, Go, PowerShell and Rust. Copy the products in your languages
  into your team as starters, or the whole folder to `teams/local/` to
  prove an install end to end.
- `samples/gcp`, `samples/aws`, `samples/azure`: products that call real,
  billed cloud APIs (a project, bucket or resource group, a container
  service, a PostgreSQL database), keyless. Copy one into a team once its
  cloud identity is set up. The azure ones haven't called Azure yet.
- `samples/perf`: the platform's benchmark product, only ever installed
  on its own test cluster. Nothing needs it; delete it if you like.

A copied product's `team:` must be changed to its new team's name.

## Layout

```
vennir.yaml                  where products publish: registry, signing
vennir                        runs the pinned vennir (downloaded into .vennir/)
tools/                        the schemas of every catalog file (format v2), for editors
templates/                    starters to copy (checked by CI, never published)
samples/<team>/               example teams: local (five languages); gcp, aws, azure (billed); perf
teams/
  <team>/                    one team = one console team = one Kubernetes namespace
    team.yaml                 who the team is: name, description, owner, contact, help; allowedTargets; clouds
    README.md                 optional
    products/
      <product>/              its image is <registry>/<team>/<product>
        product.yaml          its actions, their input/output schemas, secrets, identity
        actions/<action>.*    each action's script, in any language
        entrypoint.sh         the same dispatcher in every product; don't edit it
        Dockerfile            installs what the actions need; ends with a non-root USER
        tests/<action>/<case>/   request.json and expected.json
    secret-stores/*.yaml      optional: the team's SecretStores (admins approve)
    dags/                     optional: templates others run, and example DAGs
    apis/
      <api>/                  optional: a backend you run, published through the gateway
        api.yaml              its backend, how the gateway signs in there, access requests, limits
        openapi.yaml          what may reach the backend (OpenAPI 3.0 or 3.1)
```

A team's folder name is its identity everywhere: its console team, its
namespace, and `team` in a DAG. It can't be `bases` or `catalog-release`
(the catalog's own repositories in the registry, beside the teams'),
`vennir-system` or `kube-*` (platform namespaces).

## Onboarding a team

The order matters: an action can't be tested until the secret it reads
exists, a secret needs the team's namespace, and the namespace comes from
merging the team's folder. So: team, access, secrets, then code.

1. **List the team.** One pull request with
   `teams/<team>/team.yaml` (copy
   [templates/team](templates/team/team.yaml)) and its line in
   [.github/CODEOWNERS](.github/CODEOWNERS), with the other teams':
   `/teams/<team>/ @<org>/<github-team>`. Catalog admins approve it. On
   merge, the next release names the team, and each install's console
   creates it and its namespace. A name that ever was a purged team's is
   refused there, and so is one already taken by a team the catalog didn't
   make, until that install's admin adopts it (Admin page → Catalog).
2. **Get access.** A Vennir admin creates your console account and adds
   you to the team; after that, members add each other.
3. **Register secrets**, in the console (Team page → Secrets): paste a value,
   or sync from a vault once your team has a SecretStore (below). Note each
   secret's name: your action reads `/platform/secrets/<name>/<key>`.
4. **Add a product.** `cp -r templates/hello teams/<team>/products/<product>`
   (or a starter in your language from `samples/local/products/`), change
   what's marked `CHANGE` (a starter's `team:` too), then run what CI will:
   `./vennir catalog check teams/<team>/products/<product>`.
5. **Run it.** Submit a DAG naming `<registry>/<team>/<product>:latest`,
   the action, your `team`, and any `secretRefs`. The console pins `:latest`
   to its digest at submission, so what runs (and is retried and scanned) is
   one exact image.

Using an AI assistant for this? [docs/onboarding-with-ai.md](docs/onboarding-with-ai.md)
says what to ask for and what to check.

## `product.yaml`

```yaml
apiVersion: vennir.dev/v2  # the catalog format: every file starts with these two
kind: Product
name: project               # the folder's name
team: gcp               # the team folder's name
displayName: GCP Project
description: Looks up a project by id, creating it if it doesn't exist.
owner: gcp-team
version: 1                  # optional: raise it for a breaking change (see below)
runtime: python3.12         # what the Dockerfile installs (for readers)
serviceAccount: project     # optional: the identity it runs as (otherwise default): its own, no other product's,
                            # and not eso-gcp, eso-aws or eso-azure (ESO's, for the team's vault)
tokenAudiences: [sts.amazonaws.com]  # optional: tokens for another cloud (below)
check: check                # optional: the action that says whether it's ready on an install (below)
maxRunning: 5               # optional: at most 5 of its steps (all its actions) at once, per install
capacity: onDemand          # optional: spot or onDemand, where the install offers both (below)
clouds: [gcp]               # optional: the installs it's for, by cloud (below); else its team.yaml's
resources: {cpu: 250m, memory: 512Mi}   # optional: what each step asks for (below)
actions:
  - name: create
    script: actions/create.py
    input:  {type: object, required: [projectId], properties: {projectId: {type: string}}}
    output: {type: object, required: [projectId], properties: {projectId: {type: string}}}
    secretRefs:             # optional: the team secrets the action uses
      - name: my-api-key
        keys: [value]
    shareWith: [web, data]  # optional: other teams that may use it, or ["*"]; left out, only yours
    # visibility: hidden    # optional: only your team sees it at all (then no shareWith)
    idempotent: true          # optional: running it again with the same inputs does no harm
    maxAttempts: 3            # optional: attempts in all (default 1); more than 1 needs idempotent
    concurrencyKey: [projectId]   # optional: one step per projectId at a time
    approval: otherTeams      # optional: a maintainer approves each step first: always, otherTeams, or [team, …]
    cleanup:                  # optional: what removes the resources its steps report (below)
      action: delete
    plan: preview             # optional: the action that says what this one would do (below)
    # deprecated: Use project.ensure instead.   # optional, here or for the whole product
```

`input` and `output` are JSON Schema, and they're enforced: a step's inputs
are checked against `input` when it's submitted (the values known then) and
again, resolved, before it starts (`INPUT_INVALID`), and its outputs against
`output` when it finishes (`OUTPUT_INVALID`; no later step gets them). Keep
them to what the action really takes and returns, and self-contained (no
`$ref` to another file or URL). Every field is in
[tools/product.schema.json](tools/product.schema.json); `./vennir catalog validate`
checks against it. There's no image field: the image comes from the folder.

Both are JSON Schema draft 2020-12, and each must be an object at the top
(`type: object`). Everything that constrains a value is enforced (`type`,
`required`, `enum`, `pattern`, lengths, limits, `additionalProperties`,
`oneOf` and the rest), but `format` (`email`, `uri`, `date-time`) is only a
label: nothing checks it, so use a `pattern` for what must hold. A `$ref`
may point within the same schema (`#/$defs/...`), nothing else.

The console builds the form someone fills in to run an action (or a
template, from its `parameters`) from the same schema: `title` and
`description` label and explain each field, `default` fills it, `enum`
makes a choice, an array of text or numbers a list, an object of strings
name/value rows, and `required`, `pattern`, lengths and limits are checked
on the field before anything is sent. Four hints shape the form, and
`./vennir catalog validate` checks them:

```yaml
properties:
  projectId:
    type: string
    pattern: "^[a-z][a-z0-9-]{5,29}$"
    x-vennir-pattern-message: 6 to 30 lowercase letters, digits or hyphens, starting with a letter
    x-vennir-order: 1          # lower first; the rest follow as written
    x-vennir-group: Project    # a heading, shared by the fields that name it
  notes:
    type: string
    x-vennir-widget: textarea  # a big box
```

An action's `secretRefs` are its bindings, reviewed with the code that
reads them: the team secrets it uses. Each is mounted read-only as files,
one per key, at `/platform/secrets/<name>/<key>`, never as environment
variables. A template's steps, and the action run on its own from the
Catalog, get exactly their action's `secretRefs`; a hand-written `kind:
Dag` lists a step's secrets itself (only secrets the team registered, and
only into its registered products' steps). `keys` and `description` are
for the people registering the secret: nothing checks that it holds those
keys, so a key that's missing is just a file that isn't there, and your
action should say so plainly. `shareWith` says which other
teams may run the action or put it in their templates, and `deprecated`
says what to use instead while it keeps working: the console records both
and shows them. A shared action runs with your team's secrets whoever
calls it, so an action that sends a secret to a destination its caller
chooses (a URL, a host) must never be shared: the caller would choose
where your secret goes. `idempotent` and `maxAttempts` are your retry
policy: a step of an idempotent action that fails on the platform's side
(a reclaimed node, a lost Job, a timeout), or with an error your code marks `retryable`, runs
again after a growing pause, up to `maxAttempts` in all. A template or DAG
may ask for fewer attempts, never more, and an action that isn't idempotent
gets exactly one: write it to find what it would create first (as every
sample does) before you declare it. `concurrencyKey` names the inputs that
say what a step changes: while one step with the same values is starting
or running, another waits its turn, so two runs never change the same
project at once (a value an earlier step produced counts too). `maxRunning`
is for the product as a whole: at most that many of its steps, of any of
its actions in any run, start or run at once on an install, and the rest
wait their turn (the run page says so). Use it for a backend or an API quota
that can't take more. `capacity` picks what its steps run on, where the
install offers a choice (GKE Autopilot, EKS): `spot` is cheaper but may be
reclaimed (the step fails as retryable, so make the actions idempotent);
`onDemand` isn't reclaimed, for a step that mustn't be cut short. Left out,
the install's own, usually Spot.

`clouds` says which installs a product is for, by the cloud they're on
(`gcp`, `aws`, `azure`, `kind`, `existing`), when one catalog serves
installs on several. A team.yaml's `clouds` is the default for all its
products; a product.yaml's replaces it. On an install on another cloud,
the product is still listed, marked "For aws installs", but its readiness
check isn't run there and a run naming it is refused (`NOT_FOR_THIS_INSTALL`)
before anything starts. Left out on both, it's for every install. An
install vennir made knows its cloud; one on a cluster you already had says
it (`vennir config set -e <env> cluster.cloud aws`), or runs only the
products for every install. `clouds` says where a product is meant to run,
not who may run what: that's still each team's sharing and the platform's
image and identity policies.

`resources` (`cpu`, `memory`, and optionally `memoryLimit`, as Kubernetes
quantities) is what each of the product's steps asks the cluster for; a
`kind: Dag` step may set its own instead. Left out, the step gets the
install's default, which is often nothing, so the cluster's own applies
(on GKE Autopilot, 0.5 vCPU and 2 GiB). Memory is also the limit, unless
`memoryLimit` says more; a step that goes over it is killed and fails as
`PRODUCT_RESULT_MISSING`. CPU has no limit. Asking for more than the
team's namespace allows fails the step as `RESOURCES_NOT_ALLOWED`.

A step may run for 300 seconds by default, counted from when its container
starts (waiting for a node doesn't count; after ten minutes of that it
fails as `TASK_NOT_STARTED`). product.yaml can't change it: a template
step or a DAG task sets `timeoutSeconds`, so an action that needs longer
belongs in a template that says so. Run on its own from the Catalog, an
action gets the 300 seconds. Over its time, a step fails as `TASK_TIMEOUT`.

An action that makes or changes something lists it in its outputs as
`resources`, each a `type`, an `id`, and optionally a `name` and an http(s)
`link`. The console keeps them once the run finishes, with the step's
inputs and outputs, so people find them later (Runs, **What runs made**)
and can delete them at any time, long after the run itself is gone.
`cleanup` names the action of the same product that deletes one: it's given
`{"resource": {type, id, name, link}}`, the resource as reported, unless
`cleanup.inputs` says otherwise, each input a value or `{$input: <name>}`
(what the step was given), `{$output: <name>}` (what it gave) or
`{$resource: type|id|name|link}`. Deleting runs your cleanup as a run of
its own, for the team the resource was made for, so `shareWith` and
`approval` apply to it too, and it must succeed when what it deletes is
already gone. The local `ticket` sample does all of this.

A cleanup is an action like any other: a team you share it with can run it
directly, with any resource it names. So mark what you make with the team
it's for, the request's `forTeam` (the cloud samples label or tag it
`vennir-team=<forTeam>`, beside `vennir-made=true`), and have your delete
refuse anything whose mark isn't the request's `forTeam`, and anything
without one: that keeps one team's cleanup off another team's resources,
and off anything made some other way. `forTeam` is the team the run is
for, which the console sets and nobody can choose outside their own teams:
a consumer's run of your shared product is for the consumer's team, a
cleanup run from **What runs made** for the team the resource was made for,
your own team's run for your team. A person's run for no team is for your
team when they're in it, and otherwise has no `forTeam`: refuse what needs
one. A create that finds what it would make
reports it in `resources` only when it carries both marks for this team.
A team name is a Kubernetes namespace name (lowercase letters, digits and
`-`, at most 58, so that `<team>-apis` fits too), so it's a valid GCP label value and Azure or AWS tag value
as it is.

```yaml
  - name: create
    output:
      properties:
        projectId: {type: string}
        resources: {type: array}   # [{type: gcp/project, id: acme-web, link: https://...}]
    cleanup:
      action: delete
      inputs:                      # optional; left out, {"resource": ...}
        projectId: {$resource: id}
        force: true
```

`plan` names the action of the same product that says what this one would
do, without doing it: given the same inputs, it outputs a `summary` and
`changes`, each `{action: create|update|delete|none, type, id, name,
detail}`. The run form then offers **Preview**, which runs your plan action
as a run of its own (a preview) and shows its answer; a template previews
each step that has a plan and whose inputs are known before anything runs.
Whoever approves a step (`approval`) can preview it too, with the inputs it
will really get. A plan action must change nothing, and can't itself need
an approval, clean up, or have a plan. The local `ticket` sample has one.

`check` names the action that says whether the product is ready on an
install: run with no inputs, as the product's identity with its secrets, it
outputs `ready` (true or false), the `principal` it acts as there, and what
it's `missing` (["roles/browser on folder 12"]). Each install runs it when
the product is registered or its image changes, and daily; the console
shows the answer with the product and in the catalog, and tells your team's
maintainers (and its chat webhook) when it isn't ready. Ask your cloud who
you are and whether you may do what your actions do; change nothing. The
local `ticket` sample has one, and every gcp and aws sample has a real one
(Google's `testIamPermissions`; AWS's read-only calls): their READMEs say
what each asks. Fail the step, rather than answer, when the cloud can't be
reached: an answer is only what the cloud said.

`approval` makes a step wait for a person before it runs: `always`,
`otherTeams` (only when another team runs the action), or a list of teams
(`approval: [payments, web]`: only when one of them runs it, so one
consumer team needs an approval and another doesn't). A maintainer of your
team approves or declines it on the run's page (the home page lists what's
waiting), never whoever ran it. A declined step fails with
`APPROVAL_DECLINED`; one nobody decides on within the install's approval
timeout (3 days by default) fails with `APPROVAL_EXPIRED`. Retrying an
approved step doesn't ask again; retrying a declined or expired one does.

When a step of yours fails, the run page explains it in your words, if you
give them. product.yaml's top-level `errors` says what each code your
actions report means and what to do:

```yaml
errors:
  QUOTA_EXCEEDED:
    means: The project has no Cloud SQL quota left.
    do: Ask your GCP admin for more, then retry.
```

and team.yaml's `help` says where to ask (`chat`, `url`), next to your
`contact`. The page also says whether retrying is safe, from `idempotent`.
Codes you don't explain that the platform reports (a timeout, a failed
scan) get the platform's own explanation. A product with a `serviceAccount` runs as it in every step
(the console creates it in the team's namespace); bind a cloud identity to
that one, never to `default`. To sign in to a cloud other than the one
running the cluster (OIDC federation), list its audiences in
`tokenAudiences`: each step gets a short-lived token for each at
`/platform/tokens/<audience>` (characters outside `[A-Za-z0-9._-]` become
`_`, so `api://AzureADTokenExchange` is `api___AzureADTokenExchange`).
Point the cloud's SDK at it (`AWS_WEB_IDENTITY_TOKEN_FILE`,
`AZURE_FEDERATED_TOKEN_FILE`) and have the cloud trust exactly this
product's ServiceAccount.

### Changing a product other teams use

Other teams' templates rely on a product's contract, so `./vennir catalog check
--changed <base>` (what CI runs on every pull request) compares each changed
product with the same product at the base, which is what's published, and
refuses a change that could break them:

- an action removed, or a product removed;
- an input newly required, no longer accepted, or of a new type, or the
  input schema newly closed (`additionalProperties: false`);
- an output removed, of a new type, or no longer always returned;
- a team no longer in `shareWith`.

If the change is meant, raise the product's `version`: that's the breaking
change, visible in the diff for its reviewers. It doesn't keep the old
contract for anyone: an install holds one version of each action, the
newest released, and every template using it gets the new one at the next
sync. Tell the teams that use it (the console shows who) before you merge.

Runs already submitted keep the image digest they were pinned to, but each
step is checked against what's registered when it starts. A step (or a
retry) of an action that's been removed, or of a product whose
`serviceAccount` or `tokenAudiences` changed since, is refused as
`IDENTITY_NOT_ALLOWED` and not retried; the run has to be run again. To retire an action or a
product, mark it `deprecated: <what to use instead>` first and publish that
(templates using it get a warning); a later pull request may then remove
it. Adding things (an action, an optional input, an output, a team to
share with) never needs a new version. On a laptop, `--changed origin/main`
checks your uncommitted edits too.

## Templates and DAGs (`dags/`)

A team's `dags/` folder holds two kinds of file:

- **`kind: Template`**: what other people run, filling in only its
  parameters. `parameters` is a JSON Schema (it becomes the form they fill
  in); each step names an action, `<product>.<action>` of your team or
  `<team>/<product>.<action>` of a team that shares it, never an image, so
  a template keeps working as products release. Inputs are values,
  `{$param: <name>}`, or `{$fromStep: <id>, $output: <name>}` from a step
  in `dependsOn`. `./vennir catalog validate` checks every action exists and is
  shared with your team, and that each step gets the inputs its action
  needs. `examples` (up to ten, each a `name` and its `parameters`) are
  ways to run it, which must fit `parameters`; the run form offers them
  under **Use this**. See [samples/local/dags/shout-backwards.yaml](samples/local/dags/shout-backwards.yaml).
- **`kind: Dag`**: a concrete DAG, exactly what the console's Submit page
  takes (images, teams, inputs): examples and walkthroughs.

Each install runs your templates from the catalog's release: anyone they're
shared with fills in the parameters from the console's **Catalog** (its Run)
(or `TemplateService/RunTemplate`), and nothing else. Each step runs its product as its
ServiceAccount, with its action's own `secretRefs`, in its team's
namespace, whoever runs it; the person running it can see, cancel, retry
and rerun that run, as can your team. Every action is also runnable on its
own, by whoever its `shareWith` covers.

Every other team sees your actions and templates in the console, even ones
not shared with them: those are marked "not shared with you", with **Ask
for access**, which opens a new issue on this repository in the person's
browser saying what to add to `shareWith` and where. Mark one
`visibility: hidden` (an action in product.yaml, or a template) and only
your team sees it; it can't be shared then.

Type outputs too: an output that is a project, a database, a URL of some
kind, says so with `x-vennir-provides` (a wiring type, such as
`gcp.project`), and an input that takes one says `x-vennir-needs`. The
console wires orders by them: someone who orders your app hosting and
nothing else is offered the projects their team already has, or gets the
type's default provider added to their cart, and an optional input that
needs a type (a database) is suggested. Its chat agent reads the same thing.
A required input is a dependency; an optional one, a suggestion.

Each wiring type is defined once, by the team that's the authority on it,
in `teams/<team>/types.yaml` (`tools/types.schema.json`;
`samples/gcp/types.yaml` is an example):

```yaml
apiVersion: vennir.dev/v2
kind: WiringTypes
types:
  - name: gcp.project
    jsonType: string
    description: A Google Cloud project's id.
    defaultProvider: project.create   # one of this team's actions, providing it
  - name: gcp.region
    jsonType: string
    description: A Google Cloud region.
    shared: true                      # one value for the whole order
```

Any team's products may need or provide it. Once any team defines types,
`vennir catalog validate` refuses a product naming a type no team defines,
or naming it with a different JSON type, so the vocabulary stays the one
reviewed. The catalog's release carries them to every install.

When another team runs your product, it chooses the inputs, so it could aim
your identity at something that isn't theirs. Type each input that names a
project, folder, account or subscription with `x-vennir-needs` (`gcp.project`,
`gcp.folder`, `aws.account` or `azure.subscription`), and list in your
team.yaml where each team may aim it:

```yaml
allowedTargets:
  - teams: [web]
    gcp.project: ["web-*"]        # * matches anything
  - teams: ["*"]
    gcp.project: [sandbox-1]
  - teams: [web]
    gcp.project: ["web-prod-*"]
    approval: true                # allowed, once one of your maintainers approves
```

The console refuses another team's run with any other value before it
starts (`TARGET_NOT_ALLOWED`), and its form offers only those values. With
no rule for a team, that team can't supply the target at all. Your own
team isn't limited. A value another step produces (an order wiring your
product to one that provides a project) is held to the same rules once
it's known, before your step starts.
A rule with `approval: true` lets its values through only with an approval
(as product.yaml's `approval` does), unless another rule without one
allows the same value.
Keep your identity's cloud permissions to the same folders: that's what
holds if anything else goes wrong (samples/gcp shows both).

A catalog from before format v2 (no `apiVersion` in its files) is
converted in place by `./vennir catalog migrate`, comments and all; review the
diff, then `./vennir catalog validate`.

## API products (`apis/`)

A backend your team already runs (a Cloud Run service, a Service in your
team's API backends' namespace) can be published through the install's
gateway, without changing it. Its OpenAPI file is the allowlist: the gateway forwards a
request only when its method and path are an operation in the file and it
fits that operation's schemas, with its query, headers and body as sent
(less what's the gateway's own, below) and the caller's credential swapped
for the backend's. Declare every query
parameter and every body: an undeclared one is refused, and so is a body
whose media type has a schema the gateway can't read (it reads JSON, YAML,
XML, forms, multipart, text, CSV and binary). Anything else gets
404 or 400 from the gateway and never reaches your backend.

```yaml
apiVersion: vennir.dev/v2
kind: Api
name: orders                  # its folder; callers use /<team>/orders/ on the gateway
displayName: Orders API
description: Create and look up orders.
spec: openapi.yaml
backend:
  url: https://orders-7xk2.a.run.app      # the spec's servers must include it
  auth:
    googleIdToken:                        # minted per request; nothing stored
      serviceAccount: orders-gateway@payments-prod.iam.gserviceaccount.com
access:
  requests: approval          # open (granted at once) | approval (the default) | closed
reachable: cluster            # or internet, where the install allows your team
limits:
  default: 600/min            # your team's, and every grant's without a rate of its own
  data: 60/min                # a calling team by name (shareWith, this release)
timeout: 30s
maxRequest: 1MiB
```

**Who may call it** is each install's own, not the catalog's: your team's
members and bots always may; anyone else needs a **grant**, which your
team's maintainers make in the console, to a single sign-on group
(everyone in it) or to one user, a person or a bot, each with its own rate
(by default your `limits.default`; a group's rate is each member's).
People ask for access with a reason, and a maintainer of a bot's team asks
for the bot; `access.requests` says how a request is answered: `open`
grants it at once, at the default limit; `approval` (the default) waits
for your maintainers to grant it (the person, or a group of theirs) or
decline it; `closed` takes none (grants already made stay until revoked).
Admins may call only what a grant lets them. The console's Docs page,
**APIs and the gateway**, has the
rest.

`shareWith` (a list of teams, or `["*"]`) still works for this release,
deprecated: its teams' members and bots keep calling, shown in the console
as *from the catalog*, which can't be revoked there, at the limit `limits`
names for the team. `./vennir catalog validate` warns while an `api.yaml`
has it, and the next release drops it: grant the people and bots that call
your API in the console first, then remove `shareWith`.

`./vennir catalog validate` checks the OpenAPI file: 3.0 or 3.1, every
`$ref` inside the file, `servers` including `backend.url`, a schema for
every parameter and request body, no two paths matching the same requests,
paths made only of a URL path's characters (letters, digits, `-._~/{}:@%+,;=!*`:
no quotes, `$`, backticks or spaces, since the console shows each one in a
`curl` command people paste), and nothing under `/.vennir/` (the gateway's
own). Every field of
`api.yaml` is in [tools/api.schema.json](tools/api.schema.json). The
backend's host must be one the install's admins allow, or the API is held,
not published. `backend.auth` is minted per request from the API's own
ServiceAccount (`<name>-api` in your namespace), so nothing is stored:
`googleIdToken` (Cloud Run, Cloud Functions, IAP: a Google ID token as a
service account that federation lets the API's ServiceAccount act as),
`awsSigV4` (a Lambda function URL or API Gateway that takes IAM: the
request signed as a role trusting the cluster's OIDC issuer for
`system:serviceaccount:<team>:<api>-api`, audience `sts.amazonaws.com`; for
a function URL the role needs both `lambda:InvokeFunctionUrl` and
`lambda:InvokeFunction`), or
`serviceAccountToken` (the Kubernetes token itself, for a backend that
checks those, for the backend's own audience: never one a cloud exchanges
for an identity, such as `sts.amazonaws.com` or a Workload Identity
pool's, which `vennir catalog validate` refuses). A backend that takes only a static key can't be published:
the gateway reads no secrets. Your backend learns who called from the
`Vennir-Caller` header, which the gateway signs (its public key at
`/.vennir/jwks.json` on the gateway).

An in-cluster backend runs in your team's API backends' namespace,
`<team>-apis`, which each install makes beside your team's namespace (your
steps, their identities and your Secrets stay in the team's), and its
`backend.url` is `http://<service>.<team>-apis.svc.cluster.local:<port>`.
It's reachable by the gateway only when its Pods are labelled
`vennir/api-backend: "true"` (every other Pod there stays closed to
everything outside the namespace). For one release, a backend still in the
team's own namespace is served too; move it. So no team may be called
`*-apis`, or more than 58 characters long. What those Pods
print is searchable by your team, and only your team, on Observe's Logs tab
(From: API backends), when the install keeps logs. The samples show
each way: `samples/local/apis/greetings` (a Service in `local-apis`, no
cloud, checking `Vennir-Caller`), `samples/gcp/apis/hello-world` (Cloud
Run, `googleIdToken`) and `samples/aws/apis/orders` (a Lambda function URL,
`awsSigV4`).

What your backend gets, and what the gateway keeps to itself:

- **Headers.** The caller's `Authorization`, any `Vennir-*`, hop-by-hop
  headers, and what a caller could claim about where it's from
  (`Forwarded`, `X-Forwarded-*`, `X-Real-Ip`) never reach you.
  `X-Forwarded-For` is the address the gateway's connection came from:
  behind the install's trusted proxies (`gateway.trustedProxies`, on its
  internet listener), the caller's own.
- **Cookies.** Every API is served from the gateway's one origin. A cookie
  your backend sets is kept to your API's path (`/<team>/<api>/…`, any
  `Domain` dropped), and a `__Host-` cookie isn't passed on (it must be
  `Path=/`). A path isn't a boundary inside one origin, though: a page
  another API serves can read your cookies that aren't HttpOnly, and send
  requests to your API with them. Keep cookies HttpOnly, and never take a
  cookie alone as who's calling: `Vennir-Caller` says that.
- **Paths.** Encoded slashes, backslashes and dot segments (`..;` too) are
  refused, so what's checked against your file is what you get.
- **Who hears of it.** `visibility: hidden` keeps an API to your team (and
  the install's admins): anyone else gets 404, as for no API at all. Before
  a caller signs in, a hidden or paused API is 404 too, so its state and
  pause message reach only those who can see it.

## The container contract

- The step's request is `/platform/input/request.json`; the action is the
  container's argument. `entrypoint.sh` runs `actions/<action>.*` by its
  shebang, or fails with `UNSUPPORTED_ACTION`, so language support lives
  entirely in the Dockerfile. The request is
  `{"executionId", "taskId", "team", "forTeam", "action", "attempt",
  "inputs"}`: `team` the namespace it runs in (your team), `forTeam` the
  team the run is for (left out for a person's run for no team when
  they aren't in yours; see `cleanup` above), `inputs` always an object, with every `$fromStep` already
  replaced by its value.
  `executionId` and `taskId` together make a good idempotency key.
  A step's own inputs are at most 256 KiB as JSON (a run asking for more is
  refused when it's submitted), and its whole request, with upstream
  outputs filled in, must fit a ConfigMap's 1 MiB: pass references (names,
  IDs, URIs), not data, in as well as out.
- The action writes `/platform/output/result.json`, at most 4 KB, exactly
  one of:
  `{"status": "succeeded", "outputs": {...}}` (`outputs` may be left out)
  or `{"status": "failed", "error": {"code": "...", "message": "...",
  "retryable": false}}` (`code` and `message` not empty; `retryable`
  optional, false if left out). Nothing else: any other field, at the top
  or in `error`, anything after the object, a `failed` without an
  `error`, or a `code` that's the cluster's own refusal (such as
  `IMAGE_NOT_ALLOWED`; that one isn't retried), fails the step as
  `PRODUCT_RESULT_INVALID`. Output references
  (IDs, names, URIs), not data. What a step made goes in
  `outputs.resources` (see `cleanup` above).
- The exit code doesn't matter once result.json is written: it decides.
  With no result.json (a crash, or killed for memory), the step fails as
  `PRODUCT_RESULT_MISSING`, with the last lines of its log in the message.
  Both are retried, if the action is idempotent.
- Steps run at least once: an action must be safe to run again (look up
  before creating).
- Cancelling a run, or a step running out of time, deletes its Job: the
  container gets SIGTERM, then is killed 30 seconds later, and isn't told
  why. Leave what you were doing in a state the next attempt can pick up.
  A failure is retried only when it's retryable (your `retryable`, or the
  platform's: a timeout, a reclaimed node, an image that wouldn't pull),
  the action is idempotent and attempts remain, after 5 seconds, then 10,
  doubling up to 5 minutes.
- Log JSON lines with a `level`: `{"level": "info", "msg": "Created the
  project"}`. INFO lines are shown to everyone who can see the run, so
  write them for the person who ran it; `debug`, `warn` and `error` lines,
  and any plain line, only your team (and admins) sees. Every sample does.
  The platform keeps the last 5,000 lines (at most 1 MiB) of a step's log,
  refreshed every minute while it runs.
- Never print or return a credential. Logs and outputs are stored; the
  kernel redacts recognizable credentials from logs and fails a step whose
  outputs contain one (`OUTPUT_CONTAINS_CREDENTIAL`, not retried).
  Recognizable means: a private key (PEM), an AWS access key, a GitHub
  token, a Google API key, a Slack or Stripe key, an Azure account key, a
  bearer token, or a JWT. So an action can't output an ID token, even on
  purpose.
- The image runs as non-root with a read-only filesystem (`/tmp` is
  writable), every capability dropped, and no Kubernetes token. Its final
  `USER` must be numeric (`USER 65532:65532`, as the templates have):
  Kubernetes can't tell that a name like `app` isn't root, so it refuses
  to start the container, and the step fails as `IMAGE_USER_NOT_ALLOWED`.
  `./vennir catalog check` refuses such a Dockerfile before that.

## Testing

Test a product before publishing it: `./vennir catalog check` builds it and
runs its tests on your machine, as CI does before anything is published.
A product's tests are contract tests: `tests/<action>/<case>/request.json`
and the `expected.json` its result must contain. `./vennir catalog check` runs
each against the built image with the request mounted where the platform
mounts it, with no network. A succeeding case must also match the action's
schemas. A case's request.json may be just `{"inputs": {...}}`: the rest
is filled in (`executionId: contract-test`, `taskId` the case's name,
`team` and `forTeam` the product's team (`templates` for a starter),
`attempt: 1`).

Each case runs hardened as a step does on an install: a read-only root
filesystem (only `/tmp` is writable), no capabilities, no privilege
escalation, and result.json held to 4 KB and read as strictly as the
platform reads it (above); `./vennir catalog validate` refuses a
Dockerfile whose final stage doesn't end with a numeric, non-root `USER`.
What it can't give a case is `/platform/tokens`, or the cluster's network
and quotas. A case that
needs a secret puts a placeholder in `secrets/<name>/<key>` beside it (the
case fails if the result contains it). Nothing in a team's folder may be a
symbolic link: validate refuses one, since CI reads and mounts these files. Logic that calls a cloud API is tested
in the image with the client mocked, as `actions/test_<action>.py`. Every
product needs at least one test.

Your passing cases are also your examples: a release carries up to ten per
action (each under 8 KB), named after the case's folder, and the run form
offers them (**Use this** fills the form with the case's inputs, beside
what it gave). Name cases for the people reading them (`tests/create/
a-new-project/`), and keep their inputs realistic and free of anything
private.

## What CI blocks

Per product (`./vennir catalog check`, in `ci.yml`):

| Blocks on | Fix |
|---|---|
| A HIGH or CRITICAL vulnerability with a fix | Usually OS packages: keep the templates' `apt-get upgrade`, or pin a fixed package version |
| A secret in the image | Remove it; secrets are mounted at run time |
| A known-malicious package ([OSV](https://osv.dev)) | Check the package name for a typo |
| A base image not pinned by digest | `./vennir catalog bases` pins it; `./vennir catalog bases --update` moves every pin to its tag's current image |

Across the repository (`security.yml`): committed secrets (gitleaks; rotate
anything it finds), and Semgrep: its Python, TypeScript, JavaScript, Go,
Rust and Dockerfile rules (including the final `USER` being non-root,
though not that it's numeric) plus the catalog's own
[.semgrep/malicious.yml](.semgrep/malicious.yml), which also covers shell
and PowerShell. A product in another language gets only the malicious-code
patterns that are plain text (a download piped to a shell, a bare IP) and
the secret scans.

What blocks a merge is what `main`'s ruleset requires ([Protecting
main](#protecting-main)). Publishing is gated either way: on `main`,
`ci.yml` reruns the product checks and `security.yml`'s scans before it
pushes or signs anything, so a finding that was merged is still never
published.

An accepted finding gets its exception where it applies, with the reason, so
the pull request's review decides: a vulnerability ID in the product's
`.trivyignore`, or `# nosemgrep: <rule>` on the line. Every product is
rechecked each Monday, since new vulnerabilities are published against old
images; the Vennir console also rescans images in use daily and refuses ones
that fail.

## Who approves what

[.github/CODEOWNERS](.github/CODEOWNERS), with `main`'s ruleset
requiring a code owner's review ([Protecting main](#protecting-main)): the catalog admins own everything by
default, each team's owners own `/teams/<team>/`, and the admins
own, last so nothing overrides them, `.github/`, `tools/`, `vennir.yaml`,
`vennir` (the wrapper), `templates/` and every `/teams/*/secret-stores/`. A
team ships its own products, but can't change how CI builds and
publishes, take another team's folder, add a team, or change what
vault its namespace can read. `./vennir catalog validate` checks this layout, and
`check-codeowners.yml` checks every owner exists.

### Protecting main

None of that holds until `main` has a ruleset, which `vennir catalog
create` doesn't make: add one under **Settings → Rules → Rulesets → New
branch ruleset**, targeting the default branch, with:

- **Restrict deletions** and **Block force pushes**.
- **Require a pull request before merging**, with at least one approval
  and **Require review from Code Owners** (and **Dismiss stale pull request
  approvals when new commits are pushed**).
- **Require status checks to pass**, with these checks, each from GitHub
  Actions:

  | Check | Workflow | What |
  |---|---|---|
  | `check` | `ci.yml` | the changed products validated, built, tested and scanned; the workflows linted |
  | `secrets` | `security.yml` | gitleaks |
  | `code` | `security.yml` | Semgrep, with `.semgrep/malicious.yml` |
  | `codeowners` | `check-codeowners.yml` | every owner in CODEOWNERS exists |

  Each of these runs on every pull request (no paths filter), so none can
  leave one waiting forever. `secret-stores` (`check-secret-stores.yml`)
  is deliberately not on the list: it runs only on pull requests that touch
  a `secret-stores/` folder, so requiring it would block every other one;
  it still fails the pull request it runs on, and the release on `main`
  refuses SecretStore files that fail it. A check shows up in the list once it has run
  in the repository at least once.
- No bypass list, or only the catalog admins, and only for pull requests.

A ruleset on a private repository needs a paid GitHub plan. Without one,
nothing stops a merge that fails these checks, but the publish on `main`
reruns the product checks and scans and publishes nothing that fails them.

## Publishing

`./vennir catalog publish` checks each product, then pushes its image tagged with
the commit that last changed it (its folder, `tools/`, `vennir.yaml` or
`vennir`; the time, from a laptop), signs it if the
catalog signs, and attaches its software bill of materials (CycloneDX, from
its scan) as an attestation signed the same way, which each install's
Observe page offers for download; only then does it move `:latest` to it. `./vennir catalog release` then pushes the catalog's release to
`<registry>/catalog-release`, signs it the same way and only then tags it
with the commit and `latest`: every team, its SecretStore files, and every action as
`<team>-<product>-<action>`, its image pinned by digest to the image tagged
with the product's commit (`:latest`, from a laptop). A product whose image
for that commit is missing, or unsigned when the catalog signs (its publish
failed), fails the release. In CI, `publish --changed` therefore also
publishes every product whose image for its commit is missing or unsigned,
so the next run on `main` (or rerunning the failed one) puts it right. Two actions
under one name fail it too (team `a`'s product `b-c` and team `a-b`'s `c` both
make `a-b-c-run`; `check` says so first). It's complete, not a
change: an install unregisters what a release no longer has, and retires a
team whose folder is gone. Each console reads it every few minutes (an admin
can press **Sync now**), verifies its signature, and applies it.

In CI, pull requests run `check` on the changed products, and a merge to
`main` runs `publish` on them and then `release`, one run at a time, in the
`catalog-publish` Environment (`main` only). Settings are in
[vennir.yaml](vennir.yaml), each overridable by an environment variable:

| Name | Kind | What |
|---|---|---|
| `VENNIR_REGISTRY` | variable | where images and releases go, such as `us-docker.pkg.dev/my-project/catalog` |
| `VENNIR_SIGNING_MODE`, `VENNIR_SIGNING_KEY` | variables | `none`, `key` (a key pair or cloud KMS key) or `keyless` |
| `COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD` | secrets | a generated signing key |
| `GCP_WORKLOAD_IDENTITY_PROVIDER`, `PUBLISH_GCP_SERVICE_ACCOUNT` | variables | sign in to Artifact Registry through OIDC |
| `AWS_ROLE_ARN`, `AWS_REGION` | variables | or to ECR through OIDC (a role that may push under the registry's prefix) |
| `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` | variable / secret | or a username and password |

CI needs only the registry: no console token, no cluster credential. Each
install points its console at the release (the console chart's
`catalog.release`) and trusts the same signing key or identity as its images.

The cloud's federation trusts this repository by its GitHub id and its
owner's, not its name, since a name can pass to another repository (yours
renamed, or deleted and made again by someone else). `vennir catalog
create` reads the ids once the repository exists and pins them: on GCP the
provider's condition is `assertion.repository_id == "<id>" &&
assertion.repository_owner_id == "<owner id>"` (and `assertion.ref ==
"refs/heads/main"`), and the publish account trusts `attribute.repository_id`;
on AWS the repository's tokens carry the ids at the end of their subject
(below) and the role trusts only subjects ending in them. Setting up
federation by hand, do the same: a condition on `assertion.repository`
alone, or a `repo:<owner>/<name>` subject, trusts whoever holds the name.
Renaming or moving the repository, run `vennir catalog create` again.

From a laptop: `./vennir catalog publish [teams/<team>/products/<product> ...]`,
then `./vennir catalog release`, signed in to the registry with `docker login`.

If a merged product doesn't show up on an install, the install refused
it: each console applies a release item by item, and keeps a list of what
it couldn't apply, with why (Admin → Catalog, which only admins
see, so ask one). The usual reasons: the install's own scan failed the
image (`IMAGE_SCAN_FAILED`: a vulnerability published since your CI ran),
the release's signature isn't one the install trusts, or the team's
namespace isn't there. Fix it in the catalog and merge again; the next
release retries everything.

### Values your builds need

Keep values out of the repository: every team can read every team's
folder, so anything committed (an address, a host name, an account) is
visible to all of them, and stays in history for good. Where a value goes
depends on when it's needed:

| When | Where | How it's read |
|---|---|---|
| A step runs (a database host, a private IP, a password, an API key) | a team secret in the console, synced from your vault | your action lists it in `secretRefs` and reads `/platform/secrets/<name>/<key>` |
| An image builds (a private package registry's token) | your team's GitHub Environment, `team-<team>` | `RUN --mount=type=secret,id=<NAME>` in your Dockerfile |

Neither goes in a template's or DAG's inputs (a run's inputs are shown to
anyone who can see the run), in `result.json`, or in an image.

**Values a build needs.** A team whose builds need one is listed in
[vennir.yaml](vennir.yaml)'s `buildEnvironments`. On `main` its products are
then built in a job of their own, in the team's Environment (which only
`main` may use), with each of that Environment's secrets offered to `docker
build` under its own name. The images are handed to the publish job, which
tests, scans, pushes and signs them as it does every other product. The
build job holds no registry credential and pushes nothing, and no other
team's job gets the Environment's secrets. A pull request can't have them,
so it only validates such a team's products; `main` builds, tests and scans
them before anything is published, and a failed build fails only that
team's products.

To set one up, in this order:

1. A pull request adds the team to `buildEnvironments` in `vennir.yaml`
   (catalog admins approve it).
2. A catalog admin runs `./vennir catalog environments`, which makes
   `team-<team>` and limits it to `main`. Run it again any time: it changes
   only what isn't so, and keeps the Environment's secrets and reviewers.
3. Add the team's secrets to that Environment (Settings → Environments, or
   `gh secret set NPM_TOKEN --env team-<team>`). Never at repository level:
   every job and pull request gets those, and the build refuses the catalog's
   own (`COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`, `REGISTRY_PASSWORD`) if
   they're there.

`main`'s plan job refuses to build a listed team whose Environment doesn't
exist or can be used from another branch. Then read the secret in the
Dockerfile, in the one `RUN` that needs it:

```dockerfile
RUN --mount=type=secret,id=NPM_TOKEN,required=true \
    NPM_TOKEN="$(cat /run/secrets/NPM_TOKEN)" npm ci
```

A secret mounted this way is never in a layer. Don't copy it into one, or
write it into a file the image keeps: the image's scan fails on a secret it
finds. To build on a laptop, hand it the values as JSON:
`VENNIR_BUILD_SECRETS='{"NPM_TOKEN":"..."}' ./vennir catalog check
teams/<team>/products/<product>`.

The separation depends on `main` being protected (code-owner review, with
`.github/` and `vennir.yaml` approved by catalog admins: "Protecting main"),
and on GitHub Environments, which a private repository has only on a paid
plan. On GitHub Free a private catalog has no per-team separation in CI: a
team that needs build values there keeps a catalog repository of its own.

### Base images

[bases.yaml](bases.yaml) lists the base images the catalog approves. Each
week CI copies each into the registry, `<registry>/bases/<name>`, with the
same digest, scans the copy and signs it as products are (`./vennir catalog
bases mirror`; run `ci.yml` by hand to do it now). A product can then build
FROM the catalog's own copy, which stays put if the source moves or goes
away: `./vennir catalog bases --use-mirror` points each Dockerfile's FROM of
an approved base at its copy, pinned. Products may use other bases too;
their own checks scan them either way.

### Versions

Every release `main` publishes is `latest`, and an install following
`latest` applies it within minutes. An install can follow versions
instead (`catalogVersion` in its vennir.yaml: `newest`, or one such as
`v1.4.0`), so a catalog can reach a test install first and a production one
when you choose. A version is a Git tag:

```
git tag v1.4.0 <commit test ran>   # a commit main published
git push origin v1.4.0
```

`version.yml` then asks CI on `main` to tag that commit's release
`<registry>/catalog-release:v1.4.0` (`./vennir catalog promote`). Nothing is
rebuilt or re-signed: a version is the same digests, under the same
signature, as the release test already applied. A version never moves:
tagging it again on another commit is refused, so make a new one, or pin
an install to an older one to roll back. Protect `v*` tags with a ruleset
as you protect `main`, since cutting one ships to every install following
the newest. A tag on a commit from before `version.yml` existed starts
nothing; run `ci.yml` on `main` by hand with the version and commit.

## A team's SecretStore

A team that keeps secrets in a vault syncs them through External Secrets
Operator once its SecretStore exists. Which vault and identity a namespace
may read is a scope grant, so it's reviewed here rather than set in the
console: `teams/<team>/secret-stores/*.yaml`, approved by the catalog
admins. The console writes the file for you (Team page → Secrets → Connect a
source), with the provider-side commands.

The files may hold only SecretStores in the team's namespace, the
ServiceAccounts ESO signs in as (`eso-gcp`, `eso-azure`, `eso-aws`), and, for
a provider that can't federate, a reference to the Secret `eso-auth`.
`check-secret-stores.yml` checks that on the pull request, `release` again,
and each console again before applying them from the release. A stored
credential (a 1Password token, say) is never in the catalog: a team member
sets it in each install (Team page → Secrets → Stored credential), and the
console writes it to `eso-auth`, which no step can mount. GCP Secret Manager is proven;
other providers are designed but not yet proven.

## Removing a team

- **Retire** (automatic, reversible): merge a pull request that deletes
  `teams/<team>/`. Each install retires the team when it reads the next
  release (read-only, products unregistered) and relabels its namespace so
  nothing new runs there. Restoring the folder brings it back, unless an
  install's admin retired the team by hand: there it stays retired until
  an admin un-retires it.
- **Purge** (permanent): each install's admin, in its console (Team page →
  Purge), once nothing is running. History is kept, the name can never be
  reused, and the namespace stays, labelled retired, for a cluster
  administrator to delete. A release never purges.
- **Images**: run `delete-team-images` from the Actions tab, typing the name
  twice, once every install has retired the team. It needs a `purge`
  Environment with required reviewers, restricted to `main`, holding the
  registry identity that may delete (`PURGE_GCP_SERVICE_ACCOUNT`).

## Updating your catalog

Your catalog is a copy of this template, so a new Vennir release changes
nothing in it by itself. Each release's notes say what a catalog changes
with it. Then:

1. **Pin the release's `./vennir`.** It's what runs your checks, tests and
   publishing, with the catalog schemas built in, so a new check or fix
   reaches your catalog only through this pin. From a platform checkout:
   `.github/scripts/pin-vennir.sh <version> <your-catalog>/vennir` writes
   the version and each platform's SHA-256, after checking each binary
   downloads anonymously and matches the release. Merge it as any change.
2. **Copy what the template changed at that release**, after comparing:
   `.github/workflows/`, `.github/actions/`, `.github/scripts/`,
   `.semgrep/`, `.gitignore`, and `tools/` (the schemas your editor reads;
   `./vennir` has its own copy). You may have changed some of these
   yourself. Copy them in the same pull request as the pin: a workflow can
   run commands only the new `./vennir` has.
3. **Leave the rest:** `teams/` and `vennir.yaml` are yours, and
   `samples/` and `templates/` are examples: take what's new from them by
   hand, as you'd copy a starter.

**From a Vertra catalog** (the platform's name until 2026-11-03; releases
through 0.10.0), in one pull request:

1. Copy the template's `./vennir` (pinned to a Vennir release) into the
   catalog's root, and run `./vennir catalog migrate`. It rewrites every
   file's `apiVersion` to `vennir.dev/v2`, renames `vertra.yaml` to
   `vennir.yaml`, and removes `./vertra`, pointing CODEOWNERS' and
   `.gitignore`'s lines for it at `./vennir`.
2. Copy the template's `.github/` as in step 2 above: its workflows read
   `VENNIR_*` variables.
3. Rename the repository's variables (`VERTRA_REGISTRY`,
   `VERTRA_SIGNING_MODE`, `VERTRA_SIGNING_KEY`) to `VENNIR_*`, or run
   `vennir catalog create` again from the install, which sets the new ones
   and removes the old.

The first run on `main` after the merge publishes a release Vennir installs
read; a Vennir install doesn't read a Vertra release.

On AWS, the publish role trusts only jobs whose OIDC subject names `main`
and this repository's ids, so the repository's tokens carry their branch
even in an Environment, and its owner's id and its own (subject claims
`repo`, `context`, `ref`, `repository_owner_id`, `repository_id`). `vennir
catalog create` sets that, and `vennir apply` sets it on a catalog made
before it did (with `gh` signed in as an admin of the repository), before
it changes the role.
