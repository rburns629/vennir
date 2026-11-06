# APIs and the gateway

An API product is a backend a team already runs, published through this install's gateway. This page is for both sides: if you want to call another team's API, it says how to find it, get access and call it, and what each error means; if your team owns an API, it says how to read its traffic, pause it, find its backend's logs, and what an admin can see and do. Publishing an API is done in the catalog, and the [catalog guide](catalog-guide.md#api-products-apis) explains it. To set the gateway up, publish a first API with each kind of backend, or put it on the internet, follow [the API gateway, start to finish](21-api-gateway.md).

## What is an API product?

A team publishes a backend it already runs (a Service in its API backends' namespace, `<team>-apis`, a Cloud Run service, a Lambda function URL) by adding an `api.yaml` and an OpenAPI file to its catalog folder. Once the catalog's release is applied, the gateway answers for it at `/<team>/<name>/` and forwards requests to the backend.

The OpenAPI file is the allowlist. The gateway forwards a request only when its method and path are an operation in that file and the request fits that operation's schemas: a query parameter the operation doesn't declare is refused, and so is a body on an operation that declares none, a body without a `Content-Type`, or one whose media type has a schema the gateway can't check (it reads JSON, YAML, XML, forms, multipart, text, CSV and binary). Headers the operation doesn't mention are passed on. Anything else is answered by the gateway and never reaches the backend.

| Word | What it is |
| --- | --- |
| **API** | One backend, published as `<team>/<name>` |
| **Gateway** | The install's one front door for every API. It signs callers in, checks each request against the spec, and forwards it |
| **Spec** | The API's OpenAPI file, reviewed in the catalog like any product |
| **Backend** | Where the gateway forwards to. Only the API's own team (and admins) see its address |
| **Grant** | Who else may call it: a single sign-on group (everyone in it) or one user (a person or a bot), each at its own rate, kept by this install's console ([access](#how-do-i-get-access-to-an-api)) |
| **Shared with** | The teams that may call it from the catalog (`shareWith` in `api.yaml`; deprecated, goes in the next release). Left out, only its own team and its grants |

## Finding an API: the APIs page

**APIs** in the side menu lists every API you may see, with a search box (**Search APIs**) and filters (**All**, **You may call**, **Your teams’**, **Not live**), in three groups: **Your teams’**, **You may call** and **Not granted to you**. Each row shows:

| Column | Means |
| --- | --- |
| **API** | Its display name, `<team>/<name>`, what it does, and whether it's deprecated |
| **State** | **Live**, **Held**, **Paused** or **Can’t serve** ([states](#what-do-live-held-paused-and-cant-serve-mean)), with why it's held or can't serve, or the pause message |
| **Endpoints** | How many operations its spec describes |
| **You** | **Your team’s**, or **May call** with how (by name, through a group, from the catalog), with your limit (requests a minute, request size, timeout); **Not granted** when the gateway refuses your calls, with **Request access** (to the API's page), unless it takes no requests |
| **Reachable** | **In the cluster**, or **Internet** when it's also on the gateway's public address |

**You may call** shows instead what you may call and how (**By name**, **Through a group**, **Your team’s**, **From the catalog**), at your rate, and your requests that wait (**Withdraw**) or were declined, with the reason (**Ask again…**); a grant by name has **Give up…**. Beside it, **Your teams’ bots** (for a maintainer: each team's bots' grants and waiting requests, linking to its Automation tab) and **How access works**.

Beside the list, **Calling any of them** gives the gateway's addresses and how to sign in (and, for a team's maintainer, a link to its bots), and **Publishing one of yours** how an API gets here.

Everyone signed in sees the listed APIs, including ones they may not call. An API whose `api.yaml` says `visibility: hidden` is seen only by its own team and admins; to anyone else it looks the same as one that doesn't exist.

Your own team's APIs are also on your team's page, on the **APIs** tab, with each one's backend and how it takes requests. Under them, **Away from the catalog’s release** lists the grants kept for an API that left the release (until when), which its maintainers and admins may **Revoke…**.

## What do Live, Held, Paused and Can't serve mean?

| State | Means | What the gateway does |
| --- | --- | --- |
| **Live** | Its backend is under a host this install allows | Forwards what its spec describes |
| **Held** | Its backend's host isn't one the install's admins allow | Answers every call with 503 `API_HELD`; forwards nothing |
| **Paused** | A maintainer of its team paused it, with a message | Answers every call with 503 `API_PAUSED` and that message; forwards nothing |
| **Can’t serve** | The gateway can't use its OpenAPI document (it can't be read, or a `$ref` points nowhere); its page says what the gateway found, and when | Answers every call with 503 `API_UNAVAILABLE`; forwards nothing until a release fixes the file. `vennir catalog validate` refuses a file it can't read or whose `$ref` points nowhere, so most of these never reach a release |

An API can also be marked deprecated in its `api.yaml`. It keeps working; its page shows **Deprecated:** and what to use instead.

## What's on an API's page?

Click an API to open its page, one page from top to bottom. Everyone who can see it gets what they need to call it:

- **Call it at**: the address to use. Inside the cluster it's the gateway's address followed by `/<team>/<name>`; for an API reachable from the internet, it's the public address, with the in-cluster one under it.
- **Spec**: the spec's title, version and number of endpoints.
- **Who may call**: whoever its team grants, and its own team always; and how it takes requests (`access: { requests: … }`).
- **A grant’s rate**: the API's default rate a minute; its team may set each grant's own.
- **Your rate** (or **Your team’s limit**), when you may call it: requests a minute, the largest request body, and how long the gateway waits for the backend.
- For an API whose `api.yaml` still has `shareWith`: the teams it names, and each one's limit, *from the catalog*.
- **Endpoints, from its OpenAPI file**: each method, path and summary. Pick one to see a sample `curl` call under **Calling `<method>` `<path>`**.
- **What happens to a request**: the gateway's checks, in order.
- **Download its OpenAPI file**: the spec as JSON, to generate a client or read the schemas.

Anyone not in its team also gets **Your access**, with a pill in the header (**You may call it**, **Your request is waiting**, **You may not call it**):

- **Not granted**: **Request access…** opens the request, **For** you (or, if you maintain other teams, **A bot of a team you maintain**, then **Which bot**), with **Why you need it**; **Ask `<team>`** sends it. None where it takes no requests (`closed`): ask its team directly.
- **Waiting for `<team>`**: when you asked, your reason, and **Withdraw the request**.
- **Granted**: by name, or through which group of yours (not yours to give up), at what rate; a grant by name has **Give up my access…**.
- **Declined**: who declined and when, their reason, what you asked, and **Ask again…**.

A maintainer of other teams also gets **Request access for a bot…** there, whatever their own access; not for a retired team, whose bots get nothing new (`GetMe`'s `retired_teams` says which).

Its own team and admins also get a pill saying **You maintain it**, **Your team's** or **Viewing as admin**, and the parts only they see, linked from **On this page**: **Endpoints and traffic** (each endpoint's traffic, [traffic](#watching-your-apis-traffic)), **Who may call** (with how many requests wait: [below](#answering-requests-and-keeping-the-access-list)), **Backend and pausing** ([pausing](#pausing-an-api-during-an-incident)) and **Backend logs** ([logs](#where-are-my-api-backends-logs)).

## How do I get access to an API?

Each API has an access list, kept by this install's console (decision 26): **grants**, each naming a single sign-on group (everyone in it may call) or one user, a person or a bot (bots are in no group, so each service that calls is named). Who may call an API, as the gateway checks it on every request:

1. **Its own team's members and bots**, always, at the team's limit.
2. **A user a grant names**, at the grant's rate. A bot's grant counts while one of the bot's teams isn't retired.
3. **A person in a group a grant names**, at the grant's rate (each member's own), the best of their groups'. Bots never get in through a group. Groups count only while single sign-on is on and a group source is set, as the console last read them: at each single sign-on, and every hour for Google Workspace groups. While groups come from the ID token's claim, they count only for a single sign-on from the last hour: an older one is asked to sign in again (401), and a password's session or a bot token doesn't count them. With Google's groups alone, a group read over 90 minutes ago doesn't count, so a resync that keeps failing fails closed. When an admin changes where groups come from (or turns single sign-on off), nobody's groups count until they're read again.
4. **For this release only, a team its `api.yaml`'s `shareWith` names** (deprecated): its members and bots, at that team's limit, shown as *from the catalog*. They can't be revoked in the console; the API's team grants the people and bots that call it, then removes `shareWith`, which goes in the next release.

Anyone else is refused with 403 `NOT_GRANTED`, admins included: an admin may call only what a grant lets them, and a grant to themselves is audited like any other. A grant also lets its people see a hidden API.

| To | Who | How (`ApiService`) |
| --- | --- | --- |
| Ask for access for yourself, with a reason | Any signed-in person | `RequestApiAccess` |
| Ask for access for a bot | A maintainer of the bot's team | `RequestApiAccess` with `bot_email` |
| Withdraw a request while it waits | Whoever asked | `WithdrawApiAccessRequest` |
| Approve a request (the person; or one of their groups: one they were in when they asked, or, with Google Workspace groups, any group Google says they're in as you approve; a bot by name), at a rate, or decline it with a reason | The API's team's maintainers | `DecideApiAccessRequest` |
| Grant a group or a user directly; change a grant's rate | The API's team's maintainers (not an admin, unless they maintain it) | `AddApiGrant`, `SetApiGrantRate` |
| Revoke a grant | The API's team's maintainers; an admin (an incident); the person it names; a maintainer of the bot it names | `RevokeApiGrant` |
| See an API's grants and requests, revoked and answered ones too | Its team, and admins | `ListApiAccess` |
| See what you may call, and how, and your requests | Anyone | `ListMyApiAccess` |
| See a team's bots' grants and requests | Its members, and admins | `ListTeamBotApiAccess` |
| See the grants and requests of a team's APIs that left the release, each marked away since when; revoke one meanwhile | Its members see them; its maintainers (while the team isn't retired) and admins revoke | `ListAwayApiAccess`, `RevokeApiGrant` |
| See every active grant on the install, a page at a time, with how many there are and the requests waiting | Admins | `ListAllApiGrants` |

How a request is answered is the API's `api.yaml` (`access.requests`): `open` grants it at once, at the API's default limit; `approval` (the default) waits for its maintainers; `closed` takes none (grants already made stay until revoked). A request is refused while you may call the API already, or while one of yours waits; after a decline you may ask again at once. A revoked grant stops calls within the gateway's refresh (a few seconds; well under a minute). Grants are this install's own: the catalog doesn't carry them, and another install reading the same catalog has its own. An API that leaves the catalog's release keeps its grants and requests for 30 days, listed as away since when it left (`ListAwayApiAccess`) and revocable meanwhile by its team's maintainers and admins; they let nobody call anything while it's gone. Back within those 30 days under the same team and name, it has them again (one that would duplicate a grant or request made meanwhile is superseded: revoked, or declined, saying so); after them, its grants are deleted, its waiting requests declined ("The API left the catalog's release over 30 days ago"), and a later API of that name starts with none. A group is named as single sign-on group mappings name it: trimmed and lowercased, spaces and all. A waiting request shows the API's maintainers, and only them, the person's groups (as they were when they asked, or as read since, whichever is later) and when they were read; a group read over 24 hours ago can't be granted from them (`GROUPS_STALE`: ask them to sign in again, then decide), unless Google Workspace confirms it as you approve. Changing where groups come from empties waiting requests' copies too; the gateway keeps only the groups that matter (mapped to a team, or granted an API), never everything a sign-in read. Nothing is granted to or for a retired team's API, nor to a bot whose teams are all retired. Every request, decision, grant, rate change and revocation is audited, and told in the console's inbox (kind `api_access`) to whom it's for, whoever asked (for a bot, its team's maintainers) and the API's team's maintainers.

In the console: you ask from the API's page (**Your access**), and see everything you may call on the APIs page (**You may call**); a bot's access is on its team's **Automation** tab ([bots](14-bots-and-automation.md#calling-other-teams-apis)); the API's team answers on its page (below); admins see every grant in Admin → **API gateway**. The same methods work [from the API](05-calling-the-api.md).

### Answering requests and keeping the access list

On your API's page, **Who may call** is for its team (members see it; maintainers change it) and admins:

- **Asking for access**: each waiting request, with whom it's for (for a bot, which maintainer asked), when, and why. A maintainer picks **Grant it to** (the person by name, or one of the groups they're in, as of their sign-in; a bot only by name), **Its rate, a minute** (empty: the API's limit), then **Approve at `<rate>`**, or **Decline…** with a reason they're told.
- **Access list**: each active grant, to whom (a group, a person or a bot), its rate (a group's is each member's) and who granted it when. A maintainer has **Add a grant** (a group, or a person or bot by email, at a rate), **Change rate…** and **Revoke…**; an admin has **Revoke…** only.
- **From the catalog**: the teams `shareWith` names, not revocable here.
- Beside them, **As its api.yaml says** (how it takes requests, its default rate, its file), **Ended, last 30 days** (grants revoked, requests declined or withdrawn) and **Grants don’t expire**.

**Rates.** A team that calls (its own, or a `shareWith` team) gets the limit `api.yaml` names for it, else its `default`, else the install's default. A grant gets its own rate, else (none set) the API's `default`, else the install's default: `api.yaml`'s per-team limits are for calling teams only. A group's rate is each member's. The API's page lists the teams' limits for everyone who can see it.

## How do I call an API through the gateway?

Send the request to the address on the API's **Overview**, with a bearer token in `Authorization`:

```console
$ curl -X GET 'https://gateway.example.com/team-b/orders/orders/<orderId>' \
    -H "Authorization: Bearer $VENNIR_TOKEN"
```

The gateway signs you in exactly as the console does. The token is one of:

- **a bot's API token** (starts with `mp_`), the usual choice for a script or a service. A maintainer makes one on the team page's **Automation** tab ([Get a token](05-calling-the-api.md#1-get-a-token));
- **a person's console session**. A session issued before your last password change, or one you signed out of, is refused. If one of your teams requires single sign-on, a password session is refused too (admins excepted).

If you may call the API more than one way, the gateway picks in [its order](#how-do-i-get-access-to-an-api): the API's own team if you're in it, else a grant to you, else a group's grant, else the first of your teams it's shared with. `Vennir-Team: <team>` chooses a team to call as, for its limit: your own team's, or one it's shared with. It gives no access a grant doesn't, and it's refused with 403 if you're not in that team or it may not call the API.

Every answer carries two headers worth keeping:

- `Vennir-Answered-By`: `gateway` when the gateway refused or answered itself, `backend` when the backend did;
- `Vennir-Request-Id`: the gateway's id for this request. The backend gets the same id, so give it to the owning team when you report a problem.

These are always the gateway's: a backend's own `Vennir-*` headers aren't passed on.

## What does the gateway check, in order?

For each request to `/<team>/<name>/<path>`:

0. **Your address hasn't kept failing to sign in.** After 60 requests in a minute from one address that didn't sign in (an admin may change the number), every request from that address is refused with 429 and `Retry-After` until it's under again, whichever API it's for, signed in or not. Behind one shared address (an office's, a NAT's), one caller's bad token can hold up the rest: fix the token, and wait out `Retry-After`.
1. **The API exists here.** On the public address, only APIs reachable from the internet are served. Else 404.
2. **You're signed in.** Else 401; but 404 for a hidden or paused API, which before you sign in is answered as one that isn't there.
3. **You may see it.** A hidden API is only for its own team, admins, and those a grant lets in, whatever it's shared with. Else 404, as in the console.
4. **It's open.** Not closed by an admin, not paused, not held, and its spec could be read. Else 503.
5. **You may call it**: your own team's, a grant to you or a group of yours, or shared with one of your teams ([access](#how-do-i-get-access-to-an-api)). Else 403 `NOT_GRANTED`, or 401 for an older single sign-on session whose only way in is a group's grant while groups come from a claim.
6. **The body isn't too large** for this API (`maxRequest`, 1 MiB unless it says otherwise), and arrives within 30 seconds. Else 413, or 408 for a body that took too long. The answer has no such limit: it streams for as long as the backend sends.
7. **The method and path are an operation in the spec.** Else 404, and the request is counted as blocked.
8. **Parameters, headers and body fit that operation's schemas**, with no query parameter it doesn't declare, a body only where it declares one, and that body with a `Content-Type`. Else 400, with what didn't fit.
9. **You're within your requests a minute**: your calling team's, or your grant's (a group's, your own share of it). Else 429, with `Retry-After`.
10. **Forwarded** to the backend, with the backend's own credential. `X-Forwarded-For` is the address the gateway got the request from (on the public address, the ingress's); a caller's own `Forwarded`, `X-Forwarded-*` and `X-Real-Ip` are dropped. A cookie the backend sets is kept to the API's own path (`/<team>/<name>/`, its `Path` as callers see it, without the backend's base path), since every API shares the gateway's address; a `__Host-` cookie, which must cover the whole address, is dropped.

A path with an encoded slash (`%2F`), a backslash (`%5C`), or a `.`, `..`, `.;…` or `..;…` segment is refused with 404 before any of this, so the path that's checked is the path that's forwarded.

The API's page shows these steps too, as **What happens to a request**.

## What does each gateway error mean?

The gateway's own answers are JSON, `{"error": "<code>", "message": "…"}`, and a 400 adds `problems`, a line each: the field and the rule it broke (`quantity: minimum 1`, `lines[0].sku: maxLength 12`, `name: required`), never the values you sent.

| Status | `error` | Means | What to do |
| --- | --- | --- | --- |
| 401 | `UNAUTHENTICATED` | No token, or it's invalid, expired or revoked; or your way in is a group's grant, and your single sign-on is over an hour old while groups come from a claim | Send `Authorization: Bearer <token>`; make a new bot token if it expired; sign in again |
| 403 | `NOT_GRANTED` | You may not call it: it isn't your team's, and no grant names you or a group of yours (nor, this release, does `shareWith` name a team of yours); or you sent `Vennir-Team` for a team that may not call it. The message names the API's page | [Ask for access](#how-do-i-get-access-to-an-api) |
| 404 | `NOT_IN_SPEC` | The spec has no such method and path. Nothing was forwarded | Check the endpoint list on its **Overview** |
| 404 | `NOT_FOUND` | No such API here (or not on the public address, or one hidden from you, or one that's hidden or paused while you aren't signed in), or the path has an encoded slash, a backslash or a dot segment | Check the address on its **Overview**, and your token |
| 400 | `INVALID_REQUEST` | The request doesn't fit the spec's schemas | Read `problems`; compare with the downloaded spec |
| 408 | `REQUEST_TIMEOUT` | The body didn't arrive in time. Nothing was forwarded | Send it at once, not slowly; send less over a slow link |
| 413 | `TOO_LARGE` | The body is larger than this API takes | Send less; the limit is on its **Overview** |
| 429 | `RATE_LIMITED` | Your team, or your grant, used this API's requests for the minute, or your address failed to sign in too often | Wait for `Retry-After` seconds; if you weren't signed in, fix your token first |
| 503 | `API_PAUSED` | Its team paused it; the message says why | Wait, or ask its team |
| 503 | `API_HELD` | Its backend isn't one this install allows yet | Its team asks an admin ([held](#why-is-my-api-held)) |
| 503 | `GATEWAY_CLOSED` | An admin closed the gateway; the message says why | Wait, or ask an admin |
| 503 | `API_UNAVAILABLE` | Its spec can't be used, so nothing is forwarded; its page shows **Can’t serve** and why | Tell its team |
| 503 | `UNAVAILABLE` | The gateway couldn't check who you are just then | Try again |
| 502 | `BACKEND_CREDENTIAL` | The gateway couldn't get the backend's credential | Tell its team |
| 502 | `BACKEND_UNREACHABLE` | The backend couldn't be reached | Tell its team |
| 504 | `BACKEND_TIMEOUT` | The backend didn't start answering in time | Tell its team |

Anything with `Vennir-Answered-By: backend` came from the backend itself, unchanged; its meaning is the owning team's.

## What does the backend receive?

The request as you sent it: the same method, path (below `/<team>/<name>`), query, headers and body, with these changes:

- your `Authorization` header stops at the gateway. The backend gets its own credential instead, minted per request from the API's own ServiceAccount: a Kubernetes token, a Google ID token, or an AWS SigV4 signature, whichever its `api.yaml` asks for;
- any `Vennir-*` header you sent is dropped, so you can't forge one;
- headers that would make a backend run another method or path than the one checked against the OpenAPI document (`X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override`, `X-Original-URL`, `X-Rewrite-URL`) are dropped, and so are your `X-Amz-*` headers when the backend is signed with SigV4. A request with a `_method` field, in its query or a form body, or with two `Content-Type` headers, is refused (`INVALID_REQUEST`), and so is one with a `;` in its path (or `%3B`), unless the API's OpenAPI document has a path parameter with `style: matrix`;
- the gateway adds `Vennir-Caller` and `Vennir-Request-Id`.

`Vennir-Caller` is a short-lived token (60 seconds) the gateway signs, naming who called (their user id and email, and whether it's a bot), how they may call (`via`: `team`, `user` for a grant to them, `group` with the `group` its grant names, or `catalog` for a `shareWith` team), the team they called as (empty for a grant), and the API. A backend that cares checks it against the gateway's public key at `/.vennir/jwks.json` on the gateway; one that doesn't can ignore it.

The backend's answer goes back to you unchanged. A redirect from the backend goes back to you too; the gateway doesn't follow it.

The gateway never records a body, a header's value or a credential. Its logs and counts name the API, the team, the caller and what happened.

## Watching your API's traffic

On your API's page, **Endpoints and traffic** shows what callers sent, what the gateway stopped and what your backend answered, for **Last 24 hours** or **Last 7 days**. Bodies are never recorded, and callers only by team: those a grant lets in as `grant:user`, or `grant:group:<group>` for a group's, never by name.

| Card or table | Shows |
| --- | --- |
| **Requests** | Every request, forwarded or not |
| **Forwarded to the backend** | Requests that reached your backend |
| **Stopped at the gateway** | Not in the spec, didn't fit, over the rate, not signed in or not shared, paused, held or closed |
| **Backend errors** | Your backend answered 5xx, or couldn't be reached |
| **Endpoints, from its OpenAPI file** | Per operation: **Requests**, **Didn’t fit**, **Backend 4xx**, **Backend 5xx**, **Backend, avg**. A request from a caller who didn't sign in, to a path that isn't in the spec, is counted in **Requests** and **Stopped at the gateway** but under no endpoint, so made-up paths can't fill the table |
| **Blocked: not in the spec** | Methods and paths your spec doesn't describe, how often, from which teams, and when last |
| **By calling team** | Each team's requests, and a bar of its busiest minute against its limit |

A caller that keeps showing up under **Blocked: not in the spec** may be relying on an endpoint you never published: add it to the spec, or tell them. A team whose busiest minute is at its limit is being refused with 429.

What the gateway refused also appears on Observe, under **Refused, last 7 days**, filtered by **Gateway** ([Observe](12-observe.md#what-was-refused-and-why)). Your team sees the refusals of its own APIs and of its own calls to others'.

## Pausing an API during an incident

A maintainer of the API's team, or an admin, can pause it: on its page, under **Backend and pausing → Pause it**, write a **Message to callers** (for example, `Database failover; back by 15:00 UTC`) and press **Pause this API**. Until you press **Resume**:

- every signed-in caller who can see it gets 503 `API_PAUSED` with your message (one not signed in gets 404, as for an API that isn't there);
- nothing reaches the backend;
- the API shows **Paused** everywhere.

Pausing and resuming are recorded in the audit log. Pausing is the only change made in the console; everything else about an API (its backend, spec, sharing and limits) changes in the catalog. The page shows those as **Its backend, as the catalog says**, with the path of its `api.yaml`.

## Why is my API Held?

An API is held when its backend's host isn't one this install's admins allow (the gateway's `backendHosts`). The page says which host. The gateway answers 503 and forwards nothing, so the catalog alone can't point the gateway anywhere it likes.

It's held too, whatever the admins allow, when its backend is inside the cluster anywhere but your team's API backends' namespace (`<team>-apis`): another team's namespace, or a host that names none, such as an IP address or a single name like `orders`. Point it at `<service>.<team>-apis.svc.cluster.local` instead.

To release it, ask an admin to add the host (or a `*.` pattern above it) to the install's gateway settings. That's an install setting, changed by an upgrade, not in the console. Once it's in, the API turns **Live** on its own.

## Where are my API backend's logs?

When the install keeps logs, a backend running in your team's API backends' namespace (`<team>-apis`) has its output on Observe: **Logs**, then **From: API backends**. The API's own page shows the newest of them, from all your team's API backends, under **Its backend’s logs**, with **Search them in Observe**. Only Pods labelled `vennir/api-backend: "true"` are collected. Label them `vennir/api: <the API's name>` too, and **Search them in Observe** finds this API's backend alone (else every API backend of your team's). Those lines, at every level, are seen by your team and admins only: they belong to no run, so no caller sees them ([Observe's logs](12-observe.md#whose-logs-can-i-see)).

A backend outside the cluster (Cloud Run, Lambda) logs where it runs. Use `Vennir-Request-Id` to find a request on both sides.

## What admins see: the API gateway section

Admins open **Admin → API gateway**. It shows:

- **This install's settings**: **Backends may be under** (the allowed hosts; when there are none, every API is held), **May publish to the internet** (the teams whose APIs may be reachable from the internet), the gateway's address **Inside the cluster** and **From the internet**, and the **Last 24 hours**: requests, how many APIs, and how many were refused at the door, with a link to Observe. These are the install's settings; `vennir apply` changes them, not this page;
- **Close the gateway**: with a **Message to every caller**, every API answers 503 `GATEWAY_CLOSED` and nothing is forwarded, until an admin presses **Reopen**. The console and runs carry on. Closing and reopening are recorded in the audit log.

If the gateway isn't running on the install, the section says so (`gateway.enabled`).

Admins also see every API, hidden ones included, with its traffic, backend and logs, and may pause any of them. On Observe, they see every gateway refusal.

## Publishing or changing an API

An API is published, changed and removed in your team's catalog folder (`apis/<name>/api.yaml` and its OpenAPI file), reviewed like a product. The [catalog guide](catalog-guide.md#api-products-apis) has every field of `api.yaml`, how the gateway signs in to each kind of backend, and the samples to copy.

Once the change is merged and the catalog's release is applied, the gateway picks it up within seconds. If your team is retired, its APIs leave the list and the gateway answers 404 for them.
