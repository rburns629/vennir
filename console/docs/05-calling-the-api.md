# Calling the API from a pipeline

Everything the console does, a pipeline can do over HTTP: submit a DAG, wait for it, read its outputs and logs. A team's bot signs in with an API token; every method is listed in the [API reference](api-reference.md).

Each method is one URL, `POST /api/vennir.console.v1.<Service>/<Method>`, taking a JSON body and returning JSON: the Connect protocol, which is plain HTTP, so `curl` and `jq` are all you need. The same methods can be called over gRPC, or with a typed client generated from the protos in the platform's repository (`proto/vennir/console/v1`).

In the examples, the console is `https://vennir.example.com` and the team is `team-a`. Lines starting with `$` are what you type; the lines under them are what you get back.

## 1. Get a token

In the console, open your team → **Automation → Add a bot**, say what will use it, and copy the token: it's shown only once. Only a maintainer of the team can add a bot. The bot acts as a maintainer of your team, and of nothing else: it can submit and retry your team's DAGs. It can't make tokens or bots, or change the team's people: those are a person's to do. Its address is your team's alone: another team's bot's address is refused, so choose a new one. Store the token as a secret in your pipeline, for example:

```console
$ gh secret set VENNIR_TOKEN --repo <your-org>/<your-repo>
```

A token lasts 90 days unless you choose otherwise when you make it (30 days, a year, two years, or until revoked); the bot's card shows when each expires. An expired token is refused like a revoked one. To rotate one before it expires, add a bot again with the same answer to "What will use it?": that gives the same bot a second token. Put the new token in your pipeline, then revoke the old one on the bot's card. Revoking stops a token at once.

### Or no token at all: sign in from CI

A pipeline on GitHub Actions or GitLab can sign in with its job's own
identity instead of a stored token. On the bot's card (**Automation**),
choose **Sign in from CI…** and give the repository (and, if you like, the
only branch it may run from). Then, in the job, ask the CI for an ID token
for this install's audience (shown there) and exchange it:

```console
$ curl -s -X POST "$VENNIR/api/vennir.console.v1.AuthService/ExchangeToken" -H "Content-Type: application/json" -d "{\"idToken\":\"$ID_TOKEN\"}"
{"token":"eyJ…","email":"team-a-release-pipeline@bots.vennir.local","expiresAt":"…"}
```

The token it gives back is good for an hour, as that bot; nothing is stored
in your pipeline. A token from any other repository or branch is refused.

Every call sends its token as a bearer token. A small helper keeps the examples short:

```console
$ export VENNIR=https://vennir.example.com
$ call() { curl -s -X POST "$VENNIR/api/vennir.console.v1.$1" -H "Authorization: Bearer $VENNIR_TOKEN" -H "Content-Type: application/json" -d "${2:-{\}}"; }
$ call AuthService/GetMe
{"userId":"3f0c…","email":"team-a-release-pipeline@bots.vennir.local","teamNames":["team-a"],"isAdmin":false}
```

## 2. Submit a DAG

Send the DAG as `dag`. A pipeline that might retry after a timeout should set a `requestId` it can repeat, for example its run id: the same `requestId` returns the run already started instead of starting a second one. Each team's `requestId`s are its own, and a finished run is kept 90 days (unless your install says otherwise); after that, its `requestId` starts a new run.

```console
$ cat dag.json
{
  "name": "nightly-check",
  "requestId": "nightly-check-run-4812",
  "tasks": [
    {
      "id": "say-hello",
      "image": "us-central1-docker.pkg.dev/my-gcp-project/catalog-products/team-a/hello:latest",
      "action": "greet",
      "team": "team-a",
      "inputs": { "name": "Anna" }
    }
  ]
}
$ call ExecutionService/SubmitExecution "$(jq -c '{dag: .}' dag.json)"
{"executionId":"6b7a4378-6939-4270-8f96-c288e78571a6","state":"EXECUTION_STATE_PENDING"}
```

### Or run a template

A team's template runs with its parameters only: its steps, images,
identities and secrets are the team's, whatever you're allowed to submit.
List what's shared with you, then run one:

```console
$ call TemplateService/ListTemplates | jq -r '.runnables[] | "\(.team)/\(.name)"'
local/shout-backwards
$ call TemplateService/RunTemplate '{"team":"local","name":"shout-backwards","parameters":{"text":"hello"}}'
{"executionId":"0c1f…","state":"EXECUTION_STATE_PENDING"}
```

Parameters that don't fit the template's schema are refused before
anything runs. A template shared with specific teams runs on behalf of one
of yours (`onBehalfOf`). `TemplateService/RunAction` runs one shared action
the same way, its inputs as the parameters.

The quickest way to get one right: fill in its form in the console
(**Catalog**, then **Run**) and choose **Show as an API call**, which gives
the same run as a `curl` command to copy. A run's page has **Run with
changes**, which opens that form filled in with what the run was given.

## 3. Wait for it to finish

Ask for the execution until its `state` is `EXECUTION_STATE_SUCCEEDED`, `_FAILED` or `_CANCELLED`:

```console
$ ID=6b7a4378-6939-4270-8f96-c288e78571a6
$ call ExecutionService/GetExecution "{\"executionId\":\"$ID\"}" | jq '.execution | {state, tasks: [.tasks[] | {taskId, state, outputs, failure}]}'
{
  "state": "EXECUTION_STATE_SUCCEEDED",
  "tasks": [
    { "taskId": "say-hello", "state": "TASK_STATE_SUCCEEDED", "outputs": { "message": "Hello, Anna!", "secretFound": false }, "failure": null }
  ]
}
```

A small loop, for a pipeline step:

```bash
while :; do
  state=$(call ExecutionService/GetExecution "{\"executionId\":\"$ID\"}" | jq -r .execution.state)
  case "$state" in
    EXECUTION_STATE_SUCCEEDED) break ;;
    EXECUTION_STATE_FAILED|EXECUTION_STATE_CANCELLED) echo "Execution $ID ended $state"; exit 1 ;;
  esac
  sleep 10
done
```

A client generated from the protos can call `ExecutionService/WatchExecution` instead, which streams the execution each time it changes until it finishes.

## 4. Read the logs

```console
$ call ExecutionService/GetExecutionLogs "{\"executionId\":\"$ID\"}"
{"tasks":[{"taskId":"say-hello","lines":["greeting Anna"]}]}
```

A running step's logs can be up to a minute behind, only its last 5000 lines are kept, and on another team's step you get its info lines only: [Runs, explained](09-runs-explained.md#where-are-a-steps-logs-and-why-dont-i-see-all-of-them) has the details. A step's `failure.code` is explained in [its failure codes](09-runs-explained.md#what-does-each-failure-code-mean).

To list executions, newest first, a page at a time (pass `nextCursor` back as `page.cursor` for the next page; it's empty on the last; `team`, `search` and `since` narrow it):

```console
$ call ExecutionService/ListExecutions '{"page":{"limit":20},"team":"team-a"}' | jq '{nextCursor, executions: [.executions[] | {name, state}]}'
```

## Placing orders from another system

A storefront, a Marketplace page of your own, or an event consumer places
orders: it runs a published template with its inputs, and, like any member,
can delete what your team's runs made. Give
it an **ordering bot**: on **Automation → Add a bot**, tick *It places
orders* and list the templates it may order (`<team>/<name>`). It's a member
of your team, not a maintainer, so it can't submit raw DAGs, run single
actions or rerun anything, and it may run only the templates listed (your
team's maintainers change the list on its card). An order runs for your
team, under your team's caps, quota and approvals:

```bash
curl -X POST "$CONSOLE/api/vennir.console.v1.TemplateService/RunTemplate" \
  -H "Authorization: Bearer $VENNIR_TOKEN" -H "Content-Type: application/json" \
  -d '{"team": "platform", "name": "app-on-cloud-run", "onBehalfOf": "my-team",
       "requestId": "order-1042", "parameters": {"name": "shop-api"}}'
```

`requestId` is the order's own id: sending the same one again (a retry after
a timeout) returns the same run instead of starting a second. An ordering bot
may place a set number of orders in any minute (60 unless your install says
otherwise); past it, an order is refused with `resource_exhausted` (429) and
a `Retry-After` header, in seconds. Follow it as in
[3. Wait for it to finish](#3-wait-for-it-to-finish). A template it isn't
allowed answers `permission_denied` with `TEMPLATE_NOT_ORDERABLE`; anything
else it tries, `ORDERS_ONLY`.

### Hearing back without polling

Give the ordering bot a callback: on its card, a URL under a host this
install allows (an admin lists them: the console chart's
`orders.callbackHosts`). Saving it shows its signing secret, once; store it
with your receiver. When an order finishes (succeeded, failed or cancelled),
the console posts:

```json
{"type": "order.finished", "executionId": "0c1f…", "requestId": "order-1042",
 "template": "platform/app-on-cloud-run", "onBehalfOf": "my-team",
 "state": "SUCCEEDED", "finishedAt": "2026-10-27T15:04:05Z"}
```

with a `Vennir-Signature: t=<unix seconds>,v1=<hex>` header, where `v1` is the
HMAC-SHA256 of `<t>.<body>` with the secret. Check it, and that `t` is recent
(say within five minutes), before trusting the post:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verified(secret, header, body) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return Math.abs(Date.now() / 1000 - Number(t)) < 300 && v1?.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

`examples/order-receiver` in the Vennir repository is a whole receiver in Go.

Answer with any 2xx. Anything else, or no answer in 10 seconds, is tried
again every 30 seconds, five times in all; the card shows the last error. A
post can come twice, so act on each `executionId` and `state` once. It
carries no outputs: read them with `GetExecution`, as the bot. **Save with a
new secret** replaces the secret; **Remove** stops the posts.

### Every run of your team, for your systems

A team can also have an **outcome webhook** (its Settings tab, beside its chat
notifications, set by its maintainers, under the same allowed hosts): every
template run for the team, and every raw DAG with a step in it, posts
`run.finished` there when it finishes, signed the same way, with each
step's state, outputs and failure code (a raw DAG's other teams' steps
with `"outputs": null`):

```json
{"type": "run.finished", "executionId": "6b7a…", "requestId": "nightly-check-run-4812",
 "template": null, "name": "nightly-check", "team": "team-a",
 "state": "SUCCEEDED", "finishedAt": "2026-10-27T15:04:05Z",
 "steps": [{"taskId": "say-hello", "state": "SUCCEEDED",
            "outputs": {"message": "Hello, Anna!"}, "failureCode": null}]}
```

Past 256 KiB the outputs are left out (`"outputsOmitted": true`); read them
with `GetExecution`.

## Wiring a cart of actions

`OrderService/PreviewOrder` turns several actions into steps for one run,
without running anything: each input that names a wiring type is wired to the
one output in the cart that provides it, and the steps come back in an order
they can run. For a required input nothing in the cart provides:

- what your team (or you) already has of that type is offered, none chosen:
  `CHOOSE_EXISTING`, its `options` each an existing resource
  (`resourceId`) or a new one (`addNew`), which you send back as `choices`.
  Using one fills the input with its value (`kind: "resource"`);
- with nothing there, the catalog's default provider is added
  (`added: true`), or a shared type is asked once (a parameter named for it).

An input of a type its own action provides names what it makes (a new
project's id): it's yours to fill. An optional input nothing fills comes
back in `suggestions`: its type's default provider to add to the cart, and
what you already have of it. What else it can't settle comes back in
`problems` (`AMBIGUOUS`, with `options` to send back as `choices`;
`NO_PROVIDER`; `CYCLE`).
To run it, `OrderService/PlaceOrder` takes the same cart with your
`choices` made, `values` for what you fill in (`{"<step>": {"<input>":
value}}`), `parameters` for the shared types (`{"gcp.region":
"us-central1"}`) and a `requestId`. It's refused while a choice is unmade
(`ORDER_INCOMPLETE`, with what's left). The run is your team's, each step
checked as if you ran its action alone. The Catalog's **Cart** is this, and
Compose's **Build from a cart** opens the plan for you to edit:

```console
$ call OrderService/PreviewOrder '{"team":"team-a","actions":["local-reverse-transform","local-rot13-transform"]}' | jq '[.steps[] | .id]'
```

## Errors

Every error has the same shape: a code from a short, fixed list, a message for a person, and a `Failure` detail with a stable code a pipeline can branch on (in `debug`, readable with `jq`):

```console
$ call ExecutionService/SubmitExecution "$(jq -c '{dag: .}' dag.json)" | jq '{code, message, failure: .details[0].debug.code}'
{
  "code": "permission_denied",
  "message": "Secret \"hello-secret\" is not registered for team \"team-a\". Add it on the team's Secrets tab.",
  "failure": "FORBIDDEN"
}
```

| Code (HTTP status) | Means |
| --- | --- |
| `invalid_argument` (400) | The request or the DAG is invalid; `message` says where, and a `Problem` detail names each field |
| `unauthenticated` (401) | The token is missing, wrong or revoked |
| `permission_denied` (403) | The bot isn't allowed this, e.g. a task for another team, a secret it wasn't given, or an execution none of its teams can see |
| `not_found` (404) | No such execution |
| `already_exists` (409) | It exists already, e.g. a team of that name |
| `failed_precondition` (400) | Not possible right now, e.g. the team is retired (`TEAM_RETIRED`) |
| `resource_exhausted` (429) | Too many attempts; wait the number of seconds in `Retry-After`. Or, with no `Retry-After`, a request larger than 8 MiB: the console reads none bigger |
| `unavailable` (503) | The console can't reach something it needs; try again |

Revoking the bot's token (Team page → **Automation**) stops it working immediately. Retrying, cancelling or running again an execution takes a maintainer of every team in it, which a pipeline's bot is for its own team only.
