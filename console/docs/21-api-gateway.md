# The API gateway, start to finish

The API gateway publishes backends that teams already run (a Service in their API backends' namespace, a Cloud Run service, a Lambda function URL) as **API products**: reviewed in the catalog like any product, called at one address with a Vennir sign-in, checked request by request against the API's own OpenAPI file, and called only by its own team and those its access list grants: single sign-on groups and users, people or bots. This guide takes it in order: turning it on, publishing an API (with each kind of backend), calling it, putting it on the internet, and running it day to day.

The console's side of it, every state, error code and page, is in [APIs and the gateway](11-apis.md). Every field of `api.yaml` is in the catalog guide's [API products](catalog-guide.md#api-products-apis).

## How it works

```
caller ──Bearer token──▶ gateway /<team>/<api>/<path> ──backend's own credential──▶ backend
                          │
                          ├─ signs the caller in, as the console does (a session or a bot token)
                          ├─ checks the caller may call it (its team, a grant to them or a group of theirs), and within their rate
                          ├─ checks the method, path, parameters and body against the API's OpenAPI file
                          └─ swaps the caller's token for the backend's, and adds Vennir-Caller
```

- **The OpenAPI file is the allowlist.** A request that isn't an operation in it, or doesn't fit its schemas, is answered by the gateway (404 or 400) and never reaches the backend.
- **No stored keys.** The gateway signs in to each backend per request, as the API's own Kubernetes ServiceAccount (`<api>-api` in the team's namespace): a Google ID token, an AWS SigV4 signature, or the Kubernetes token itself. A backend that only takes a static key can't be published.
- **The backend learns who called** from `Vennir-Caller`, a 60-second token the gateway signs (its keys at `/.vennir/jwks.json` on the gateway).
- **Admins decide where backends may be** (`gateway.backendHosts`). An API pointed anywhere else is held: the catalog alone can't aim the gateway at an arbitrary host.

## 1. Turn it on

A Vennir admin, once per install:

```bash
vennir config set -e prod gateway.enabled true
vennir config set -e prod gateway.backendHosts "*.a.run.app,*.lambda-url.us-east-2.on.aws,*.web.svc.cluster.local"
vennir apply prod
```

`gateway.backendHosts` lists the hosts backends may be under, exactly (`orders.example.com`) or a whole domain below a name (`*.a.run.app`). An in-cluster backend is a host too: `<service>.<team>-apis.svc.cluster.local`, in the team's API backends' namespace, so allow `*.<team>-apis.svc.cluster.local` per team that publishes in-cluster APIs. An API may only use an in-cluster backend in its own team's API backends' namespace, whatever this list says. (For one release, one still in the team's own namespace, `<service>.<team>.svc.cluster.local`, is served too, if this list allows it, and the gateway logs a warning until it moves.) An API whose backend isn't covered shows **Held**, and turns **Live** on its own once an admin adds its host.

The gateway reads the namespace from a Service's name (`<service>.<namespace>.svc`) or a headless Service's Pod's (`<pod>.<service>.<namespace>.svc`), with or without the cluster's domain. Use a Service: a Pod's own name (`<a-b-c-d>.<namespace>.pod`) is held, because cluster DNS answers it with the address in it whatever namespace it says. A cluster set up with a domain other than `cluster.local` needs the console chart's `clusterDomain` set to it, and its APIs' `backend.url` in the short form (`http://<service>.<team>-apis.svc:<port>`): the catalog checks accept http only for that or `.svc.cluster.local`, since a catalog serves every install. A host that's inside the cluster but names no namespace is always held, whatever this list says: an IP address (a Pod's or a Service's could be any team's), a single name such as `orders` (it would be found in the platform's own namespace), or any other name under the cluster's domain. Every other host is looked up exactly as written, never through the cluster's DNS search path, so `orders.web` is never `orders.web.svc.cluster.local`. Only the loopback (`localhost`, `127.0.0.1`, `::1`), the gateway's own Pod, is exempt.

**Admin → API gateway** then shows the settings, the gateway's address inside the cluster, and the last day's traffic.

**Where it's reached.** Inside the cluster, every Pod (steps, services, other APIs' backends) reaches it at `http://console-execution-console-gateway.vennir-system.svc.cluster.local:8080`. From your laptop, for trying it:

```bash
kubectl -n vennir-system port-forward svc/console-execution-console-gateway 8080:8080
```

Callers outside the cluster need the internet listener: [Putting it on the internet](#putting-it-on-the-internet).

## 2. Publish an API

A team publishes an API from its catalog folder: `teams/<team>/apis/<api>/api.yaml` and an OpenAPI file beside it. The flow is the same for every backend:

1. **Write the OpenAPI file** (3.0 or 3.1): every operation callers may use, with a schema for every parameter and request body, and `servers` including the backend's URL. Anything not in it is refused.
2. **Write `api.yaml`**: the backend's URL, how the gateway signs in to it, how requests for access are answered, and the limits.
3. **Let the API's ServiceAccount in to the backend** (below, by kind of backend).
4. **Check it**: `./vennir catalog validate` reads the OpenAPI file as the gateway will (every `$ref` resolves, no two paths overlap, `servers` includes the backend).
5. **Open a pull request.** After merge, each install applies the release, creates the API's ServiceAccount (`<api>-api` in the team's namespace), and the gateway serves it within seconds.

```yaml
apiVersion: vennir.dev/v2
kind: Api
name: orders                  # callers use /<team>/orders/ on the gateway
displayName: Orders API
description: Create and look up orders.
spec: openapi.yaml
backend:
  url: https://orders-7xk2abcdq-uc.a.run.app
  auth:
    googleIdToken:
      serviceAccount: orders-invoker@web-prod.iam.gserviceaccount.com
      audience: https://orders-7xk2abcdq-uc.a.run.app
access:
  requests: approval          # open (granted at once) | approval (the default) | closed
reachable: cluster            # or internet, if your team is in gateway.internetTeams
limits:
  default: 600/min            # your team's, and a grant's unless it has its own rate
  data: 60/min                # a calling team by name (yours, or a shareWith team)
timeout: 30s
maxRequest: 1MiB
visibility: listed            # or hidden: only your team and admins know it exists
```

### A Service in your namespace (no `auth`, or `serviceAccountToken`)

The backend runs in your team's API backends' namespace, `<team>-apis`, which the console makes beside your team's namespace: your steps, their identities and your team's Secrets stay in the team's namespace, and reach the backend only through the gateway. Your cluster administrator gives whatever deploys it rights there alone. The gateway may reach only Pods labelled `vennir/api-backend: "true"`; every other Pod there stays closed to everything outside the namespace. Label them `vennir/api: <api>` too, so the API's page can show their logs. A backend still in the team's own namespace is served for one release; move it, and point `backend.url` at `<service>.<team>-apis.svc.cluster.local`.

```yaml
backend:
  url: http://orders.web.svc.cluster.local:8080
```

With no `auth`, the backend trusts what the gateway signs instead: it checks `Vennir-Caller` against `/.vennir/jwks.json`, its `aud` and its `api`. `samples/local/apis/greetings` does exactly that, with no cloud. With `auth: {serviceAccountToken: {audience: <aud>}}` the gateway sends a Kubernetes token for the API's ServiceAccount, for a backend that checks those. The audience is the backend's own, never the Kubernetes API's, kernel-api's, or one a cloud exchanges for an identity (`sts.amazonaws.com`, `api://AzureADTokenExchange`, a GKE Workload Identity pool `<project>.svc.id.goog` or its `identitynamespace:` audience, a GCP workload identity provider `//iam.googleapis.com/…`): with one of those, the backend could sign in to that cloud as the API's ServiceAccount. `vennir catalog validate`, the console's catalog sync and the gateway each refuse them, and the cluster does too: its admission policy lets the gateway mint each API's ServiceAccount a token only for the audiences that API needs (its backend's for `serviceAccountToken`, AWS STS's for `awsSigV4`, the Google pool's for `googleIdToken`), which the console keeps current. A newly published API may answer 502 `BACKEND_CREDENTIAL` for the moment before the console has written its audience; the next request is tried again.

### A Cloud Run service (`googleIdToken`)

Cloud Run checks a Google ID token. The gateway gets one as a Google service account of your choosing, which the API's ServiceAccount is allowed to act as. Deploy the service with `--no-allow-unauthenticated` so nothing else reaches it, then, once:

```bash
INVOKER=orders-invoker@web-prod.iam.gserviceaccount.com
gcloud iam service-accounts create orders-invoker --project web-prod
# It may invoke the service, and nothing else.
gcloud run services add-iam-policy-binding orders --region us-central1 --project web-prod \
  --member serviceAccount:$INVOKER --role roles/run.invoker
# The API's ServiceAccount may mint its ID tokens. On GKE, through the cluster's own pool:
gcloud iam service-accounts add-iam-policy-binding $INVOKER --project web-prod \
  --role roles/iam.serviceAccountOpenIdTokenCreator \
  --member "principal://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/$PROJECT.svc.id.goog/subject/ns/web/sa/orders-api"
```

`$PROJECT` and `$NUMBER` are the GKE cluster's project. From another cluster (EKS, an existing one) through a workload identity pool you made, the member is `principal://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/$POOL/subject/system:serviceaccount:web:orders-api`. `audience` is the service's own URL. The sample is `samples/gcp/apis/hello-world`.

### A Lambda function URL or API Gateway (`awsSigV4`)

The gateway signs each request with SigV4, as a role it assumes with the API's ServiceAccount token:

```yaml
backend:
  url: https://abcdefghijklmnop.lambda-url.us-east-2.on.aws
  auth:
    awsSigV4:
      roleArn: arn:aws:iam::123456789012:role/vennir-web-orders-api
      region: us-east-2
      service: lambda           # execute-api for an API Gateway that takes IAM
```

The role trusts the cluster's OIDC issuer (registered in IAM as an OIDC provider) for exactly `system:serviceaccount:web:orders-api`, audience `sts.amazonaws.com`, the same trust policy as [AWS from another cluster](20-deploy-to-aws.md#from-an-install-that-isnt-on-eks). On EKS the issuer is already registered; a GKE cluster's is public, so a GKE install can call AWS backends with no AWS cluster at all. For a function URL (`AuthType AWS_IAM`), the role needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on the function. The sample is `samples/aws/apis/orders`.

## 3. Call it

Callers sign in to the gateway exactly as to the console, and call as one of their teams:

```bash
curl -H "Authorization: Bearer $VENNIR_TOKEN" \
  https://api.example.com/web/orders/orders/1234
```

- **A bot's token** (`mp_…`) for scripts and services: a maintainer makes one on their team's page → **Automation** ([Bots and automation](14-bots-and-automation.md)). Or a person's console session.
- **Who may call.** The API's own team's members and bots; the people and bots a grant names; the people in a single sign-on group a grant names; and, for this release, the teams its `api.yaml`'s `shareWith` names (deprecated). Anyone else, admins included, gets 403 `NOT_GRANTED`. The order, the rates and who grants what: [How do I get access to an API?](11-apis.md#how-do-i-get-access-to-an-api)
- **Asking for access.** Ask with a reason (`ApiService/RequestApiAccess`: for yourself, or as a maintainer of a bot's team, for the bot). The API's `access.requests` decides: `open` grants it at once, `approval` waits for its team's maintainers, who grant you or one of your groups, or decline; `closed` takes none. The console's pages for it come in the next release.
- **Calling for a team.** If you're in several teams that may call it, send `Vennir-Team: <team>` to choose which one's limit you use. It never gives access a grant doesn't.
- **Groups are at most an hour old.** A group's grant counts the groups the console last read: at each single sign-on, and every hour for Google Workspace groups. While groups come from the ID token's claim, a single sign-on older than an hour whose only way in is a group's grant gets 401: sign in again. A revoked grant stops calls within the gateway's refresh, well under a minute.
- **Reporting a problem.** Every answer carries `Vennir-Request-Id`, and the backend gets the same id; `Vennir-Answered-By` says whether the gateway or the backend answered.
- **Paths are taken as the OpenAPI file reads them.** A path with an encoded slash, a backslash or a dot segment is refused (404). So is one with a `;`, written as is or as `%3B` (400 `INVALID_REQUEST`), unless the API's OpenAPI file has a path parameter with `style: matrix`: some backends' frameworks read what follows a `;` as a parameter, or drop it, where the gateway would check it as part of the path.
- **After the console's `jwtSecret` changes**, sessions signed with the old one stop working at the gateway within a minute, the time it keeps the console's keys before reading them again. While it can't read them (the console restarting), it keeps using the last ones for up to 10 minutes. Bot tokens are checked against the database on every request.

Every error code, and what to do about it: [What does each gateway error mean?](11-apis.md#what-does-each-gateway-error-mean)

## Putting it on the internet

By default the gateway is reachable only inside the cluster. For callers outside it, it has a second listener (port 8081) that serves only the APIs that ask for it (`reachable: internet`), and only for teams the admins allow:

```bash
vennir config set -e prod gateway.internetTeams "web,partners"
```

`vennir` doesn't yet put a load balancer in front of that listener; it's set with a Helm values file, which `vennir apply` layers last. Write `deploy/prod/gateway-public.yaml`:

```yaml
gateway:
  publicListener: true
  publicUrl: https://api.example.com
  ingress:
    enabled: true
    host: api.example.com
    className: traefik                 # your Ingress controller's class
    tlsSecretName: api-example-com-tls # a certificate for the host, unless the controller makes its own
  # Only the Ingress controller may reach the internet listener...
  publicListenerFrom:
    - namespaceSelector:
        matchLabels: {kubernetes.io/metadata.name: traefik}
  # ...so its X-Forwarded-For can be trusted, and backends see the real caller.
  trustedProxies: ["10.244.0.0/16"]    # the Pod range the controller connects from
```

```bash
vennir config set -e prod values gateway-public.yaml
vennir apply prod
```

Then point a DNS record for the host at the Ingress's address (`kubectl -n vennir-system get ingress`). Health checks should ask `/.vennir/health`, which answers 200 while the gateway is up.

What each cloud needs on top. This hasn't been run on a cloud yet:

| Where | What it takes |
| --- | --- |
| **kind, existing** | An Ingress controller (Traefik, NGINX) and a certificate (cert-manager): the file above as it is. Proven on kind with Traefik, including trusted proxies |
| **gcp** | GKE's load balancer (class `gce`): a reserved global address (`gcloud compute addresses create`) named in `kubernetes.io/ingress.global-static-ip-name`, a Google-managed certificate for the host, and a health check on `/.vennir/health`. Google's load balancer connects from `35.191.0.0/16` and `130.211.0.0/22` and adds its own address after the caller's: list those ranges in `publicListenerFrom` (as `ipBlock`s) and those ranges plus the address in `trustedProxies` |
| **aws** | An Application Load Balancer: on EKS Auto Mode, the class `vennir-alb` that `vennir` makes for a public console (otherwise the AWS Load Balancer Controller's), an ACM certificate (`alb.ingress.kubernetes.io/certificate-arn`), `target-type: ip`, and `alb.ingress.kubernetes.io/healthcheck-path: /.vennir/health`. With the VPC CNI, Pods share the VPC's addresses, so let in and trust only the ALB's subnets, never the whole VPC |

Leave `trustedProxies` empty if you can't narrow `publicListenerFrom` to the proxies alone: then every backend sees the proxy as the caller, which is safe, rather than a caller's claim, which isn't. The chart refuses `trustedProxies` without `publicListenerFrom`.

## Running it

| To | Who | How |
| --- | --- | --- |
| Watch an API's traffic | Its team, admins | Its page → **Endpoints and traffic**: requests, what was stopped and why, backend errors, each calling team's busiest minute (a grant's callers as `grant:user` or `grant:group:<group>`) |
| Stop calls during an incident | A maintainer of its team, or an admin | Its page → **Backend and pausing → Pause it**, with a message every caller gets (503 `API_PAUSED`) |
| Stop every API | An admin | **Admin → API gateway → Close the gateway**, with a message (503 `GATEWAY_CLOSED`). Runs and the console carry on |
| Release a held API | An admin | Add its host to `gateway.backendHosts`, then `vennir apply` |
| Change an API's backend, spec, how its requests are answered, or limits | Its team | A catalog pull request: the console never changes an API itself |
| Grant a group or a user, change a grant's rate, or decide a request | Its team's maintainers | `ApiService` (`AddApiGrant`, `SetApiGrantRate`, `DecideApiAccessRequest`): each install's own, audited and told |
| Revoke a grant | Its team's maintainers, an admin, the person it names, or the bot's team's maintainers | `ApiService/RevokeApiGrant` |
| See refusals across APIs | Teams, for their own APIs and calls; admins, all | **Observe → Refused**, filtered by **Gateway** |
| Find a backend's logs | Its team | Its page → **Its backend's logs** (in-cluster backends with `vennir/api-backend` and `vennir/api` labels); Cloud Run or Lambda log where they run |

## Limits on callers

Two settings in the console chart's `gateway` values, besides each API's own rate, `maxRequest` and `timeout`:

| Setting | Default | What it does |
| --- | --- | --- |
| `gateway.unauthenticatedPerMinute` | `60` | Requests a minute one client address may make that fail to sign in. Past it, that address's requests are refused with 429 before sign-in, so before the gateway does any database work for them, until it's under again. The address is the peer, or on the public listener behind `trustedProxies` the address they saw; an IPv6 address counts as its /64. Not on the public listener behind a proxy every caller shares that `trustedProxies` doesn't list (`gateway.publicPeersShared`, on by itself with the chart's ingress): list the proxy to keep the limit. `0`: no limit |
| `gateway.bodyReadTimeoutSeconds` | `30` | The longest a request's body may take to arrive; then 408 and nothing is forwarded. Answers have no such limit |

Each replica counts on its own, as with API rates.

## Addresses and firewalls

Two directions matter, and neither address is fixed by default:

- **Callers reaching the gateway** use the internet listener's host name. On AWS an Application Load Balancer's addresses change; give callers the name, never an address. On GKE the reserved address is fixed.
- **Backends seeing the gateway**: the gateway connects to backends from the cluster's nodes, whose public addresses change as nodes come and go. Prefer the backend checking who's calling (an ID token, a SigV4 signature, `Vennir-Caller`) to an address allowlist.

[Addresses and firewall rules](22-addresses-and-firewalls.md) shows how to find the current addresses, and how to get fixed ones when a firewall needs them.
