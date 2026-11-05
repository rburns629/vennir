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
| **Shared with** | The teams that may call it (`shareWith` in `api.yaml`). Left out, only its own team |

## Finding an API: the APIs page

**APIs** in the side menu lists every API you may see, with a search box (**Search APIs**) and filters (**All**, **You can call**, **Your teams’**, **Not live**), in three groups: **Your teams’**, **Shared with your teams** and **Not shared with your teams**. Each row shows:

| Column | Means |
| --- | --- |
| **API** | Its display name, `<team>/<name>`, what it does, and whether it's deprecated |
| **State** | **Live**, **Held**, **Paused** or **Can’t serve** ([states](#what-do-live-held-paused-and-cant-serve-mean)), with why it's held or can't serve, or the pause message |
| **Endpoints** | How many operations its spec describes |
| **You** | **Your team’s** or **May call**, with your team's limit (requests a minute, request size, timeout); **Not shared** when the gateway refuses your calls, with a link to ask its team |
| **Reachable** | **In the cluster**, or **Internet** when it's also on the gateway's public address |

Beside the list, **Calling any of them** gives the gateway's addresses and how to sign in (and, for a team's maintainer, a link to its bots), and **Publishing one of yours** how an API gets here.

Everyone signed in sees the listed APIs, including ones they may not call. An API whose `api.yaml` says `visibility: hidden` is seen only by its own team and admins; to anyone else it looks the same as one that doesn't exist.

Your own team's APIs are also on your team's page, on the **APIs** tab, with each one's backend and who it's shared with.

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
- **Your team's limit**: requests a minute, the largest request body, and how long the gateway waits for the backend, or `None: it isn't shared with your teams`.
- **Shared with**: the teams that may call it, or `its own team only`.
- **Endpoints, from its OpenAPI file**: each method, path and summary. Pick one to see a sample `curl` call under **Calling `<method>` `<path>`**.
- **What happens to a request**: the gateway's checks, in order.
- **Download its OpenAPI file**: the spec as JSON, to generate a client or read the schemas.

If the API isn't shared with your teams, the page says so: the gateway refuses your calls with 403. Calls are made as one of your teams, so an account in no team can't call any API, not even one shared with everyone.

Its own team and admins also get a pill saying **You maintain it**, **Your team's** or **Viewing as admin**, and the parts only they see, linked from **On this page**: **Endpoints and traffic** (each endpoint's traffic, [traffic](#watching-your-apis-traffic)), **Backend and pausing** ([pausing](#pausing-an-api-during-an-incident)) and **Backend logs** ([logs](#where-are-my-api-backends-logs)).

## How do I get access to an API?

An API's team decides who may call it, in its `api.yaml` (`shareWith`, a list of teams, or `["*"]` for every team). On the **APIs** page, or the API's own page, **Ask for access ↗** opens a new issue on the catalog repository, filled in, in your own browser, asking the owning team to add yours. The console never changes the catalog itself: the team adds yours in a reviewed change like any other, and you may call the API once the release with it reaches this install. When the console can't build that issue (the catalog isn't on GitHub, or the API didn't come from a release), the link goes to the team's page, to ask them there.

Access is per team, not per person. Once your team is in `shareWith`, every member of your team, and your team's bots, may call it. Who's in a team is read on every request, so being added to or removed from a team counts at once.

Each calling team has its own rate limit: the one `api.yaml` sets for your team by name, else its `default`, else the install's default. The API's page lists them for everyone who can see it: each team its `api.yaml` names, and what every other team gets.

## How do I call an API through the gateway?

Send the request to the address on the API's **Overview**, with a bearer token in `Authorization`:

```console
$ curl -X GET 'https://gateway.example.com/team-b/orders/orders/<orderId>' \
    -H "Authorization: Bearer $VENNIR_TOKEN"
```

The gateway signs you in exactly as the console does. The token is one of:

- **a bot's API token** (starts with `mp_`), the usual choice for a script or a service. A maintainer makes one on the team page's **Automation** tab ([Get a token](05-calling-the-api.md#1-get-a-token));
- **a person's console session**. A session issued before your last password change, or one you signed out of, is refused. If one of your teams requires single sign-on, a password session is refused too (admins excepted).

If you're in more than one team that may call the API, the gateway picks one: the API's own team if you're in it, else the first of yours it's shared with. To choose, send `Vennir-Team: <team>`. Your calls then count against that team's limit, and it's refused with 403 if you're not in that team or it may not call the API.

Every answer carries two headers worth keeping:

- `Vennir-Answered-By`: `gateway` when the gateway refused or answered itself, `backend` when the backend did;
- `Vennir-Request-Id`: the gateway's id for this request. The backend gets the same id, so give it to the owning team when you report a problem.

These are always the gateway's: a backend's own `Vennir-*` headers aren't passed on.

## What does the gateway check, in order?

For each request to `/<team>/<name>/<path>`:

0. **Your address hasn't kept failing to sign in.** After 60 requests in a minute from one address that didn't sign in (an admin may change the number), every request from that address is refused with 429 and `Retry-After` until it's under again, whichever API it's for, signed in or not. Behind one shared address (an office's, a NAT's), one caller's bad token can hold up the rest: fix the token, and wait out `Retry-After`.
1. **The API exists here.** On the public address, only APIs reachable from the internet are served. Else 404.
2. **You're signed in.** Else 401; but 404 for a hidden or paused API, which before you sign in is answered as one that isn't there.
3. **You may see it.** A hidden API is only for its own team and admins, whatever it's shared with. Else 404, as in the console.
4. **It's open.** Not closed by an admin, not paused, not held, and its spec could be read. Else 503.
5. **It's shared with your team.** Else 403.
6. **The body isn't too large** for this API (`maxRequest`, 1 MiB unless it says otherwise), and arrives within 30 seconds. Else 413, or 408 for a body that took too long. The answer has no such limit: it streams for as long as the backend sends.
7. **The method and path are an operation in the spec.** Else 404, and the request is counted as blocked.
8. **Parameters, headers and body fit that operation's schemas**, with no query parameter it doesn't declare, a body only where it declares one, and that body with a `Content-Type`. Else 400, with what didn't fit.
9. **Your team is within its requests a minute.** Else 429, with `Retry-After`.
10. **Forwarded** to the backend, with the backend's own credential. `X-Forwarded-For` is the address the gateway got the request from (on the public address, the ingress's); a caller's own `Forwarded`, `X-Forwarded-*` and `X-Real-Ip` are dropped. A cookie the backend sets is kept to the API's own path (`/<team>/<name>/`, its `Path` as callers see it, without the backend's base path), since every API shares the gateway's address; a `__Host-` cookie, which must cover the whole address, is dropped.

A path with an encoded slash (`%2F`), a backslash (`%5C`), or a `.`, `..`, `.;…` or `..;…` segment is refused with 404 before any of this, so the path that's checked is the path that's forwarded.

The API's page shows these steps too, as **What happens to a request**.

## What does each gateway error mean?

The gateway's own answers are JSON, `{"error": "<code>", "message": "…"}`, and a 400 adds `problems`, a line each: the field and the rule it broke (`quantity: minimum 1`, `lines[0].sku: maxLength 12`, `name: required`), never the values you sent.

| Status | `error` | Means | What to do |
| --- | --- | --- | --- |
| 401 | `UNAUTHENTICATED` | No token, or it's invalid, expired or revoked | Send `Authorization: Bearer <token>`; make a new bot token if it expired |
| 403 | `NOT_SHARED` | The API isn't shared with your team, or not with the team in `Vennir-Team` | [Ask for access](#how-do-i-get-access-to-an-api) |
| 404 | `NOT_IN_SPEC` | The spec has no such method and path. Nothing was forwarded | Check the endpoint list on its **Overview** |
| 404 | `NOT_FOUND` | No such API here (or not on the public address, or one hidden from you, or one that's hidden or paused while you aren't signed in), or the path has an encoded slash, a backslash or a dot segment | Check the address on its **Overview**, and your token |
| 400 | `INVALID_REQUEST` | The request doesn't fit the spec's schemas | Read `problems`; compare with the downloaded spec |
| 408 | `REQUEST_TIMEOUT` | The body didn't arrive in time. Nothing was forwarded | Send it at once, not slowly; send less over a slow link |
| 413 | `TOO_LARGE` | The body is larger than this API takes | Send less; the limit is on its **Overview** |
| 429 | `RATE_LIMITED` | Your team used this API's requests for the minute, or your address failed to sign in too often | Wait for `Retry-After` seconds; if you weren't signed in, fix your token first |
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

`Vennir-Caller` is a short-lived token (60 seconds) the gateway signs, naming who called (their user id and email, and whether it's a bot), the team they called as, and the API. A backend that cares checks it against the gateway's public key at `/.vennir/jwks.json` on the gateway; one that doesn't can ignore it.

The backend's answer goes back to you unchanged. A redirect from the backend goes back to you too; the gateway doesn't follow it.

The gateway never records a body, a header's value or a credential. Its logs and counts name the API, the team, the caller and what happened.

## Watching your API's traffic

On your API's page, **Endpoints and traffic** shows what callers sent, what the gateway stopped and what your backend answered, for **Last 24 hours** or **Last 7 days**. Bodies are never recorded, and callers only by team.

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
