# Operations

Installing, upgrading and running Vennir: on your machine with `kind`, and
on a cloud cluster. For how it works, see [architecture.md](architecture.md);
for what it enforces, [security-model.md](security-model.md).

`vennir`, the installer, does the cloud setup, the install and the catalog
repository in one place: [Setting up Vennir](setup.md). This page is what it
does underneath, and how to do it by hand: `make` targets on `kind` while
working on Vennir itself, and the Helm charts directly anywhere else. Either
way, the charts are complete on their own: `helm install` creates both
databases, generates their passwords and creates the first admin. Every
chart setting, with its default, is in the charts' `values.yaml`
(`helm/charts/execution-kernel/`, `helm/charts/execution-console/`).

## Local install with kind

Needs Docker (running), `kind`, `kubectl`, `helm` and `curl`.

```
make quickstart    # from nothing (or any state) to a running install; safe to re-run
```

It creates the `kind` cluster `vennir-local` and a local registry
(`localhost:5001`, where task images live), builds both platform images,
installs both charts into `vennir-system` with `helm/values/kind/*.yaml`,
creates the team `team-a`, and port-forwards the console to
http://localhost:18080. Sign in as `admin@example.com` / `vennir-local`:
that password is set only in the kind values, for a cluster nobody else can
reach. Never use it anywhere else.

Every day:

| Command | Does |
| --- | --- |
| `make up` | Resumes the node, clears Pods stuck as Unknown, port-forwards the console |
| `make down` | Stops the node and keeps everything (never `kind delete cluster` unless you mean to start over) |
| `make logs` | Tails kernel-api, the scheduler and the console together (any install: `vennir logs <env> -f`) |
| `make catalog-publish` | Publishes `catalog-template/` with its `local` sample team (one product in five languages); `CATALOG=<folder>` publishes your own catalog, `SAMPLES=` other samples |
| `make kind-deploy` | Rebuilds both platform images and upgrades both releases (`kind-deploy-kernel`, `kind-deploy-console` for one) |
| `make test` | Starts a throwaway Postgres on `127.0.0.1:55432` and runs the kernel's, gateway's, console's and frontend's tests |

To try it: publish the samples, then paste the DAG from
`catalog-template/samples/local/README.md` into **Executions → Submit new**.
Each step is the same product in another language, chained with
`$fromTask`; the detail page follows it live.

## Installing on a cluster with Helm

Needs Kubernetes 1.30 or later, Helm 4, and a CNI that enforces
NetworkPolicy (GKE Dataplane V2, which Autopilot always has; on EKS the
VPC CNI's network policy agent, off until asked for: `vennir` turns it on,
and on a cluster of your own set the `vpc-cni` add-on's
`{"enableNetworkPolicy": "true"}`, or in Auto Mode the `kube-system`
ConfigMap `amazon-vpc-cni` with `enable-network-policy-controller: "true"`;
on AKS a network policy engine). Without it, no policy below holds.

1. **Images and charts.** Each release publishes both images (amd64 and
   arm64, scanned, signed keyless by the release workflow) and both charts
   to `ghcr.io/rburns629/vennir`, and the charts default to the images
   released with them: install from
   `oci://ghcr.io/rburns629/vennir/charts/execution-kernel` and
   `…/execution-console` with `--version <release>`. To run your own build
   instead, push `kernel/` and `console/` to your registry and set
   `image.repository` and `image.tag` (or `image.digest`).
2. **The platform namespace**, e.g. `vennir-system`. It's never a team's:
   the kernel's dispatch policy refuses to run steps in it. Keep who may
   create Pods there to administrators (NetworkPolicies trust its labels).
3. **Optional components**, before the charts that use them:
   - **Image signatures:** Sigstore's policy-controller
     (`helm/values/gke/policy-controller.yaml` is an example; it must exclude
     the platform namespace), then the kernel's `imageSignature` values.
     The console's Admin page says images must be signed when it finds the
     kernel's signature policy (`<release>-execution-kernel-signed-images`,
     the console chart's `imageSignature.policyName`) in the cluster, which
     its ServiceAccount may read by that name and nothing else.
   - **Syncing secrets from a vault:** External Secrets Operator
     (`helm repo add external-secrets https://charts.external-secrets.io`;
     `vennir config set externalSecrets true` has `vennir apply` install it,
     pinned). On EKS a team's store signs in by IRSA, which needs the
     cluster's OIDC issuer registered in IAM: `vennir` does that for a
     cluster it makes; the Team page's guide has the command otherwise.
     EKS Pod Identity doesn't work for a store.
4. **Values.** Copy `helm/values/gke/` (or `kind/`) as a starting point;
   each file's comments say what its settings are for, and every setting is
   documented in the charts' `values.yaml`. The files are the whole of an
   environment's settings: deploy with `--reset-values`, so nothing set by
   hand lingers. At minimum: the image source tasks may use
   (`imagePolicy.sourceRegistry`), the console's `kernelApiUrl`
   (`http://<kernel release>-execution-kernel-api.<namespace>.svc.cluster.local:8000`),
   and the first admin's email. Give the first admin a password in a
   Secret of yours (`bootstrapAdmin.existingSecret`; `mustChangePassword:
   true` to have it changed at the first sign-in), or leave it unset: the
   account then gets a random password that is shown nowhere, not even in
   the migrate Job's log (which the cluster's logging may ship and keep),
   and you give it one with `resetAdmin.js` below.
5. **Install**, kernel first, with a size preset under your values (see
   [Sizes, sleeping and headroom](#sizes-sleeping-and-headroom)). Not
   `--wait` on a first install: each chart migrates its database in a
   post-install hook, which Helm runs only after `--wait` sees every Pod
   ready, and the console isn't ready until its tables exist. Helm still
   waits for the hook; wait for the rollout after it.

   ```
   CHARTS=oci://ghcr.io/rburns629/vennir/charts; V=<release, e.g. 0.1.0>; SIZE=minimal
   helm pull $CHARTS/execution-kernel --version $V --untar; helm pull $CHARTS/execution-console --version $V --untar
   helm install kernel ./execution-kernel -n vennir-system -f execution-kernel/sizes/$SIZE.yaml -f <values>/kernel.yaml
   helm install console ./execution-console -n vennir-system -f execution-console/sizes/$SIZE.yaml -f <values>/console.yaml
   kubectl -n vennir-system rollout status deployment -l 'app.kubernetes.io/instance in (kernel,console)'
   # No password set: give the first admin one (printed only to you; changed at the first sign-in)
   kubectl -n vennir-system exec deploy/console-execution-console -- node dist/db/resetAdmin.js <email>
   ```

   Upgrades (`helm upgrade`) can use `--wait`: they migrate before the
   rollout.

6. **Reach the console** with `kubectl port-forward svc/console-execution-console 18080:8080`,
   or over HTTPS (next section) before anyone signs in over a network.
   kernel-api must stay `ClusterIP`.
7. **Sign in, change the password**, and on the Admin page: add admins,
   mint the catalog's automation token, and set the allowed image sources.
   Keep the first admin's account. Every install and upgrade creates an
   admin with `bootstrapAdmin.email` if no account has that email, so if
   you delete it or change the setting, the next upgrade makes a new admin,
   with a random password no one has
   ([Troubleshooting](#troubleshooting)).

`make gke-deploy VERSION=v<x.y.z>` (and `gke-deploy-kernel`, `-console`)
deploys a release to GKE: the release's signed charts, which run its signed
images, each signature checked first (cosign, against the release workflow's
identity at exactly that tag; `make gke-verify-release VERSION=...` alone),
with the settings in `helm/values/gke/` and the context named in the
Makefile. It shows what's about to ship and asks you to type the cluster's
name first. The release's packages on ghcr.io must be public (once, in each
package's settings) or `docker login ghcr.io` done first. To try an
unreleased change on a cluster that isn't production,
`gke-deploy-{kernel,console}-from-source` build the working copy with Cloud
Build instead (unsigned, `:latest`). `-policy-controller` and `-eso` install
those charts.

### What the cluster needs

**Room.** What each copy of the platform's parts requests, from the charts'
`values.yaml` (steps come on top: a step without its own size requests the
size preset's `scheduler.taskDefaultResources`):

| Part | CPU | Memory | When |
| --- | --- | --- | --- |
| kernel-api | 100m | 256Mi | Always, per copy |
| Scheduler | 100m | 512Mi | Always, per copy |
| Console | 100m | 512Mi | Always, per copy |
| Postgres | 250m | 512Mi | Per instance: one when the kernel's holds the console's database (what `vennir` does), two otherwise |
| Trivy server | 100m | 512Mi, and 4Gi ephemeral storage | While scans run (`scanning.idleMinutes`) |
| Gateway | 50m | 64Mi | `gateway.enabled` |
| Loki, Alloy | 100m, 50m | 256Mi, 128Mi | `logs.enabled` |

So a `minimal` install with one Postgres needs about 650m CPU and 2.3Gi of
memory before any step runs. The migrate Jobs (100m, 256Mi) and the
sleeper's CronJob (50m, 128Mi) run briefly.

**Outbound access.** The platform's NetworkPolicies only limit what may
connect *to* its Pods (the gateway's also limit where it connects), so
nothing in the charts blocks outbound traffic. If your network does, the
platform reaches:

- the registries it pulls and checks images from: ghcr.io for its own
  images (unless you mirror them), the task images' registry, and the
  catalog release's;
- Trivy's vulnerability database (mirror.gcr.io, ghcr.io), when the scanner
  starts and every few hours;
- Sigstore's public services (Fulcio, Rekor) for keyless signatures, from
  the catalog release check and policy-controller;
- the chat agent's provider, when `chat` is set;
- Google (accounts.google.com, and cloudidentity.googleapis.com for group
  mappings) for Google sign-in, and the keyless bots' issuers (`keyless.issuers`) for their keys;
- the SMTP server (`notifications.email`), the teams' chat webhooks
  (`notifications.webhookHosts`) and order callbacks (`orders.callbackHosts`);
- on a cloud, its own APIs for workload identity, buckets (backups, logs,
  the audit copy) and registries.

There's no setting for an HTTP proxy, and no offline mode.

### HTTPS for the console

The console chart reaches the console over HTTPS one of two ways, each with
its certificate issued and renewed for you:

- **An Ingress** (`ingress`: `enabled`, `host`, `className`). The certificate:
  - cert-manager with an issuer you have: `certManager.issuer` (a
    ClusterIssuer, or an Issuer with `issuerKind: Issuer`), e.g. your
    internal CA;
  - Let's Encrypt: `certManager.acme.email`, and the chart makes the Issuer,
    proving the host over HTTP through the same Ingress class (the host must
    resolve to the Ingress from the internet);
  - a Secret you keep: `tlsSecretName`;
  - or the cloud's, through `annotations` (what `vennir` does on GKE and
    EKS).

  `httpsOnly` (on) refuses plain HTTP for the controllers the chart knows:
  Traefik (`websecure` only), NGINX (redirect) and GKE (no HTTP). For
  another, add its own annotation.
- **A Gateway** you run (Gateway API, `gatewayApi`): an HTTPRoute for
  `host` on the Gateway's HTTPS listener (`parentRefs`), and optionally a
  redirect from its HTTP listener (`redirectParentRefs`). The Gateway holds
  the certificate; cert-manager issues it from an annotation on the Gateway
  (`cert-manager.io/cluster-issuer`) with its Gateway API support on.

Either way, the console sends Strict-Transport-Security, so a browser that
has seen it keeps to HTTPS; set `trustProxy` to the load balancer's
addresses so sign-in limits see real clients.

`vennir` does this on an existing cluster: `vennir init` asks whether the
console is reached at a hostname, which Ingress class serves it, and where
its certificate comes from (Let's Encrypt, or a ClusterIssuer of yours), and
offers to install cert-manager (pinned) if the cluster hasn't got it
(`console.public`, `console.hostname`, `console.ingressClass`,
`console.tls.*` in vennir.yaml). `vennir apply` then says which DNS record
the hostname needs (an A record to the Ingress controller's address, or a
CNAME to its name), waits for it to resolve when run interactively, and
reports the certificate's state; `vennir status` shows both. Let's Encrypt
can't issue until the record resolves. On gcp with a hostname of yours,
apply names the A record to the console's reserved address the same way.

On kind, `make kind-tls` installs cert-manager, Traefik (an Ingress
controller and a Gateway at once) and a private test CA
(`helm/values/kind/tls-test.yaml`, which no browser trusts). Then deploy with
the console's `ingress` or `gatewayApi` in a values file under `_local/`
(`make kind-deploy-console KIND_CONSOLE_VALUES=_local/...`), port-forward
Traefik (`kubectl -n traefik port-forward svc/traefik 28443:443`) and check
with `curl --cacert` (the CA is `ca.crt` in `cert-manager/vennir-test-ca`)
and `--resolve <host>:28443:127.0.0.1`.

### Cloud identities

No component needs a stored cloud key. Bind these Kubernetes ServiceAccounts
to cloud identities with the cloud's workload identity (GKE Workload
Identity, EKS Pod Identity or IRSA, AKS Workload Identity), each with only
what it needs:

| ServiceAccount | Needs | Set by |
| --- | --- | --- |
| The console's | Read manifests in the registries it checks and pins (`registryCheck`) | `serviceAccount.annotations` |
| The image scanner's | Pull from those registries | `scanning.serviceAccountAnnotations` |
| `vennir-pg-backup` | Write to the backup bucket | You create it ([Backups](#backups)) |
| A team's `eso-<cloud>` | Read that team's secrets in its vault | The team's SecretStore file |
| A product's own | Whatever that product does | The product's `serviceAccount`; an admin adds the binding |

For a registry that needs a password instead, put a
`kubernetes.io/dockerconfigjson` Secret in the platform namespace and name
it in `registryCheck.pullSecretName`; with `registryCheck.copyToTeams`, the
console copies it into every team namespace as `vennir-pull` and the
kernel's `scheduler.taskImagePullSecret` names it on step Pods.

How each binding is made, per cloud (`vennir` makes all of them for an
install of its own; `helm/values/gke/` and `helm/values/eks/` are examples
of the values it writes):

| | GKE (Workload Identity) | EKS |
| --- | --- | --- |
| The console, the scanner | Each its own Google service account with `roles/artifactregistry.reader` on the registry, bound to its ServiceAccount (`roles/iam.workloadIdentityUser`), named by its `iam.gke.io/gcp-service-account` annotation; the console's also `roles/aiplatform.user` on the project with the chat agent on Vertex, and `roles/monitoring.viewer` with GKE's managed Prometheus, for Observe's alerts (the scanner, reading images anyone can publish, gets nothing more) | Each its own role that may read the ECR repositories, bound by an EKS Pod Identity association (no annotation); the console's also `bedrock-mantle:CreateInference` on the chat model with the chat agent on Bedrock (the scanner gets nothing more); `registryCheck.ecrToken: true` |
| policy-controller (`policy-controller-webhook`) | The same, read-only on the products' registry | The same, by Pod Identity |
| kernel policy (`kernel-execution-kernel-policy`, with a signed catalog) | Its own Google service account, read-only on the registry the catalog's release is in (its own, or another project's, whose owner's `vennir catalog grant` names it), and with Cloud SQL its own IAM user | Its own role, by Pod Identity: read-only on the task registry, and with RDS `rds-db:connect` as its own user |
| A team's `eso-<cloud>` (its SecretStore) | Its Google service account, by the annotation in the store file | IRSA: the `eks.amazonaws.com/role-arn` annotation, a role trusting the cluster's OIDC issuer (registered in IAM once per cluster) for `system:serviceaccount:<team>:eso-aws` only. Pod Identity doesn't work for a store |
| A product's own | Its Google service account, by the annotation an admin adds | A Pod Identity association for `<team>/<serviceAccount>`, which an admin adds |
| Catalog CI (GitHub Actions) | Workload Identity Federation, main only, the repository by its id and its owner's | An IAM OIDC provider for GitHub's issuer (the account's one, shared by its installs: `vennir destroy` leaves it), a role trusting the repository's main only, by a subject naming its id and its owner's |

### Signing in with Google

With `vennir`: `vennir sso google <env>` says which two pages of the Google
Cloud console to open and the exact redirect URI to paste, reads the
client's downloaded JSON (checking it's a web client with that URI), asks
which Workspace domains may sign in, and saves the settings (the file's
path, never its secret). `vennir apply` then writes the secret into a
Kubernetes Secret through stdin and turns it on; `vennir sso off` turns it
off. If the console's address changes later (made public, a new hostname or
address), `apply` stops until the new URI is added to the client and
`vennir sso google` is rerun. By hand, with Helm:

1. In the Google Cloud console for a project in your Workspace
   organization, set up the OAuth consent screen (Google Auth Platform) with
   the audience **Internal**, then create an OAuth client of type **Web
   application** whose authorized redirect URI is the console's address +
   `/api/auth/oidc/callback` (`http://localhost:18080/...` for a
   port-forward).
2. Put its secret in a Secret in the console's namespace:
   `kubectl -n vennir-system create secret generic console-sso --from-file=client-secret=<file>`.
3. Set the console chart's `sso`: `issuer: https://accounts.google.com`, the
   `clientId`, `clientSecret.name: console-sso`, the same `redirectUrl`, and
   `allowedDomains` (your Workspace domains). On kind, keep these in a file
   under `_local/` and pass it:
   `make kind-deploy-console KIND_CONSOLE_VALUES=_local/kind-console-sso.yaml`.

People then sign in with Google; the first sign-in makes their account (or
binds the one an admin made for that email), with no teams until someone
adds them. Turning it on changes nothing else: passwords keep working.
Teams then move to Google one at a time: an admin turns on **Require Google
sign-in** on the team's page (`TeamService/SetTeamSignIn`), and its members'
passwords stop working, including sessions they already have (the console
and the gateway both refuse them). Someone in several teams uses Google if
any of them requires it. Admins are exempt, so an admin can still get in if
Google can't be reached; `vennir admin reset-password` remains the way back
for a lost password. A team that can't use Google simply leaves it off.

### The API gateway

API products are served by the gateway, which the console chart runs when
`gateway.enabled` is on. Set `gateway.backendHosts` to the hosts backends
may be under (`orders.example.com`, or `*.a.run.app` for any name below
it); an API under none is held. `gateway.url` is where callers reach it
inside the cluster (its Service, `<release>-execution-console-gateway:8080`);
with `gateway.publicListener`, port 8081 serves the APIs of
`gateway.internetTeams` that ask to be reachable from the internet: put an
Ingress or load balancer in front of it, at `gateway.publicUrl`. With
`vennir`, set these in a values file it layers last (`vennir config set -e
<env> values <file>`): it asks only about `enabled`, `backendHosts` and
`internetTeams`. `gateway.publicListenerFrom` limits who may reach the
public listener (the Ingress controller's namespace, a load balancer's
ranges), and `gateway.trustedProxies` lists the proxies whose
`X-Forwarded-For` names the caller; the chart refuses the second without
the first. On a cluster set up with a DNS domain other than
`cluster.local`, set `clusterDomain` to it in both charts: the console
chart's is `CLUSTER_DOMAIN` for the console and the gateway (how they tell
which backend hosts are in the cluster, and in which namespace) and its own
in-cluster URLs; the kernel chart's puts it in kernel-api's certificate.
Set the console chart's `kernelApiUrl` with it too. `vennir` assumes
`cluster.local`, which every cluster it makes uses. With
`database.iamAuth`, the gateway's `DATABASE_URL` must say
`sslmode=verify-full` (or `verify-ca`) unless it connects to localhost (a
Cloud SQL Auth Proxy beside it), or the gateway won't start; the URLs
`vennir` makes for a managed database already do. The whole walk-through, per cloud:
[the API gateway](../console/docs/21-api-gateway.md#putting-it-on-the-internet).
`gateway.unauthenticatedPerMinute` (60; 0 turns it off) is how many
failed sign-ins a minute one client address gets before its requests are
refused with 429 ahead of sign-in (not on the public listener behind a
proxy every caller shares that `gateway.trustedProxies` doesn't list:
`gateway.publicPeersShared`, on by itself with the chart's ingress), and `gateway.bodyReadTimeoutSeconds`
(30) how long a request's body may take to arrive (then 408); see
[limits on callers](../console/docs/21-api-gateway.md#limits-on-callers).
An admin closes it from the Admin page (every API answers 503 with their
message), or `gateway.closed` keeps it closed; a team's maintainers pause
one of theirs from its page. With `gateway.ingress`, an Ingress serves the
public listener at `gateway.ingress.host`. Its NetworkPolicy lets it reach
anything but the cloud metadata server; narrow it with `gateway.egress`.
Backend credentials: `googleIdToken` needs `gateway.gcp` (vennir sets it
on GKE; the API's Google service account grants its ServiceAccount's
principal `roles/iam.serviceAccountOpenIdTokenCreator`), and `awsSigV4` a
role whose trust policy accepts the cluster's OIDC issuer for
`system:serviceaccount:<team>:<api>-api`, audience `sts.amazonaws.com`
(the issuer registered as an IAM OIDC provider; a GKE cluster's is public,
so a GKE install calls AWS backends with no AWS cluster). A Lambda
function URL needs both `lambda:InvokeFunctionUrl` and
`lambda:InvokeFunction` on the role. On kind, `make kind-deploy-console` builds
it and allows backends in the `vennir-samples` namespace.

### Reading another install's catalog

One catalog serves many installs. One install owns its repository (its
`catalog` block: its registry, its `signing`; `vennir catalog create`
refuses a repository that already publishes to another install's registry
unless `--take-over`, which moves it); an install that reads it
sets `externalCatalog.registry` in its vennir.yaml (the image source, and
where its release lives) and the owner's signer in `catalogSignature`:
`publicKeyFile` (a generated key's or the owner's KMS key's public half,
`cosign public-key --key <kms uri>`), and/or `repository` (the catalog
repository, `owner/name`, whose `ci.yml` on main signs keyless). On gcp and
aws the reader then refuses what that signer didn't sign as the owner does,
releases and images: `vennir apply` installs policy-controller. Elsewhere
(kind, an existing cluster) only releases are checked.

The registry's owner then lets the reader in, with no key stored anywhere:
after the reader's first `vennir apply`, which prints the command with its
flags filled in, the owner runs `vennir catalog grant` in its own
environment (it shows what it will change and asks; `--yes` doesn't). It
grants read on the catalog's registry (its products' images and its
release) and nothing else, to exactly the reader's identity:

| Owner | Reader | Granted to | `vennir catalog grant` makes |
| --- | --- | --- | --- |
| gcp | gcp, another project | its console, scanner, nodes, (verifying) policy-controller and (signed) kernel policy service accounts (`--service-account`) | `roles/artifactregistry.reader` on the repository for each |
| gcp | gcp, the same project | nothing: the reader names the owner's repository as its own task registry (`taskImages.name`, `taskImages.create: false`, `taskImages.registry`), which its module grants its own identities read on; `vennir` refuses anything else | — |
| gcp | aws, or any cluster with an OIDC issuer | its console's ServiceAccount from its issuer (`--issuer`, `--subject`) | in the pool `vennir-installs`, a provider `vennir-<reader>` trusting that issuer for that subject alone, mapped to the subject `<reader>:<subject>`; `roles/artifactregistry.reader` on the repository for that principal |
| aws | gcp, another AWS account, or any cluster with an OIDC issuer | its console's ServiceAccount from its issuer (`--issuer`, `--subject`) | an IAM OIDC provider for the issuer (audience `sts.amazonaws.com`), and a role `vennir-reader-<reader>` only that subject may assume by web identity, whose one policy may `ecr:GetAuthorizationToken` and pull and list tags in `<prefix>/*` |

```
vennir catalog grant prod --reader vennir-eks \
  --issuer https://oidc.eks.us-east-2.amazonaws.com/id/<id> \
  --subject system:serviceaccount:vennir-system:console-execution-console
```

A federated reader then sets what the grant prints and applies again:
`vennir config set externalCatalog.gcpWorkloadIdentityProvider
projects/<number>/locations/global/workloadIdentityPools/vennir-installs/providers/vennir-<reader>`
(an Artifact Registry), or `externalCatalog.awsRoleArn
arn:aws:iam::<owner's account>:role/vennir-reader-<reader>` (ECR). Its
console exchanges its own ServiceAccount token, projected for the other
side, for a short-lived credential: an hour's Google token (Workload
Identity Federation), or the role's credentials (AWS
`AssumeRoleWithWebIdentity`) and with them ECR's registry token. It uses
it itself and hands it, renewed every policy sync, to the kubelet and
policy-controller (`vennir-pull` in each team namespace) and its verify
and scan Jobs (`vennir-registry-token`). An EKS reader of another
account's ECR reads the same way, so its own roles (the verifier's
included) still read only its own registry. On aws the grant is a role
rather than a repository policy: ECR creates each product's repository on
its first push, and a role scoped to the prefix covers those too.

Running the grant again changes nothing; `--revoke` takes it away (the
binding and the provider; the role and its policy). On aws the role is
named by `--reader` alone, so when `vennir-reader-<reader>` already trusts
another issuer or subject (another reader with the same cluster name,
`vennir` by default), the grant and the revoke both refuse and say whom it
trusts: give this reader another `--reader`, or pass `--replace` to change
(or delete) that role anyway. The pool, and an IAM
OIDC provider, stay: neither lets anyone in by itself. Readers set up with
the gcloud commands earlier versions printed (the bare subject, shared by
every reader in the pool) keep working; the grant moves a reader's
provider to its own subject in place, and says when the old binding can
go.

### Catalog versions

An install applies every release its catalog's `main` publishes (`latest`)
unless it follows versions: `vennir config set -e <env> catalogVersion
newest` (the newest `vX.Y.Z`; the console chart's `catalog.newestVersion`)
or `catalogVersion v1.4.0` (pinned: `catalog.release` ends `:v1.4.0`), then
`vennir apply`. A version is made by a `vX.Y.Z` Git tag in the catalog
repository, which tags the release `main` already published for that commit
(`vennir catalog promote`, catalog-template's `version.yml`): the same
digests and signature, so a production install following `newest` gets
what a test install on `latest` already ran, when someone cuts the tag. To
roll back, pin the previous version; versions never move. The Admin page's
Catalog card shows the version applied, and its section says which versions
the install follows, how often it looks (`catalog.pollSeconds`), who may sign
a release, and the registry of another install's catalog it reads
(`catalog.external`, which vennir sets with `externalCatalog`; display only,
labelled "as configured": nothing the console reads confirms it).

### The catalog's policies

With a signed catalog, the kernel can write what the catalog decides into
the cluster itself (decision 27 in `assessment.md`): which digests are a
product's releases, as which ServiceAccount and token audiences, and each
API ServiceAccount's audiences. Then a console that's wrong, or taken
over, can't loosen them: `kernel policy` reads the release the console
reads, verifies its signature against signers set in the kernel chart, and
writes two admission policies only its own ServiceAccount may update
(`<kernel>-execution-kernel-catalog-identity` and `-catalog-tokens`), which
apply beside the console's. Turn it on in the kernel chart's values, with
the console chart's settings repeated:

```yaml
catalogPolicy:
  enabled: true
  release: us-central1-docker.pkg.dev/<project>/catalog-products/catalog-release:latest  # catalog.release
  newestVersion: false                                   # catalog.newestVersion
  signature:                                             # catalog.signature
    publicKeys: ["<PEM>"]
    keyless: {issuer: "", subjectRegExp: ""}
  registry:
    gcpMetadataToken: true    # or ecrToken (EKS), authSecret (a dockerconfigjson Secret), mirrors
  gateway:                    # with the console chart's gateway on
    serviceAccount: console-execution-console-gateway
    gcpTokenAudience: ""      # gateway.gcp.tokenAudience
```

It reads the registry as its own ServiceAccount (`kernel-execution-kernel-policy`),
never as the console: on GKE and EKS that identity needs read on the
catalog's registry, which `vennir` doesn't grant yet (`TODO.md`), so the
cloud values leave it off for now. Without a trusted signer it can't be on:
an unsigned catalog keeps the console writing these policies, and the Admin
page's policies card says which. A release it can't verify, or one older
than the one it applied, isn't applied (it logs why, and
`kernel_catalog_policy_passes_total{outcome="failed"}` counts it); what it
wrote stands. A release too big for the policies (over 400,000 characters
of product releases, 300,000 of API audiences: less than the console's
600,000, for Helm's release Secret, which keeps both) isn't applied; with
too many earlier releases kept beside the current one, they go first, then
everything, rather than what's written standing.

Keep the kernel chart's settings the console chart's: `release`,
`newestVersion` and `signature` as its `catalog`, `gateway.gcpTokenAudience`
as its `gateway.gcp.tokenAudience`, and `gateway.serviceAccount` set
whenever the console chart's gateway is on (otherwise only the console's
token policy holds each API's audiences, and the Admin page says so). The
chart refuses `catalogPolicy` without `identityPolicy` (the console's,
which holds each team's secret names). An earlier release stays listed for
`catalogPolicy.releaseGraceSeconds` (an hour) after a release dropped it,
or while an unfinished execution runs it that was submitted before then and
is still moving: a step of it running, or one that became ready or began
awaiting its approval within `catalogPolicy.inUseMaxSeconds`. That bounds
each step's wait, not the execution's age, and defaults to the scheduler's
`approvalTimeoutSeconds`, or three days if that's longer or off; the chart
(and kernel policy at startup) refuses less than the approval timeout. An
execution whose steps all wait longer (an approval with no timeout) is
refused its product's identity when the next one starts. However its
executions keep moving (retries make a step ready again), nothing keeps an
earlier release past `catalogPolicy.inUseLimitSeconds` after a release
dropped it: a week, or twice the in-use bound if longer, by default, and
never less than it. The grace is per
digest: when two products share a digest and action and a release drops
one of them (keeping the digest for the other), the dropped one is revoked
at once, with no grace and not while in use.

**Rotating its signers.** Add the new key (or identity) to
`catalogPolicy.signature` beside the old, publish a release signed by it,
and only then remove the old. Replacing it in one step leaves the release
applied unverified by the signers trusted now: both policies then list
nothing until a release they signed is applied, and every product step is
refused meanwhile. Earlier releases only the old signers signed go when
the signers change.

**GitOps.** kernel policy owns `spec.variables` and two annotations of both
policies, as the console owns its policies' lists: a tool that applies the
rendered manifests should ignore differences there (Argo CD's
`ignoreDifferences` on `/spec/variables` and the `vennir.dev/catalog-*`
annotations of `ValidatingAdmissionPolicy` `<kernel>-execution-kernel-catalog-*`).
Without lookup the chart renders them empty, and `apiAudiencesWritten`
false: product steps are refused until kernel policy's next write (a
minute), and the API audience check waits for it.

**Repairing them.** When an upgrade refuses one of these policies' literals
(it says which), set that variable's expression to `{}` (`false` for
`apiAudiencesWritten`) with `kubectl edit`: kernel policy rewrites it from
its database within a pass. Don't delete the policy: the next upgrade then
renders it empty, and the console's identity policy (holding no releases
once split) with it, so every product step is refused until kernel policy
writes again.

On kind, whose local catalog isn't signed, try it with a key of your own,
kept out of git (`_local/` is ignored): generate one with `cosign
generate-key-pair`, sign the release `make catalog-publish` printed (`cosign
sign --key cosign.key --tlog-upload=false
localhost:5001/catalog-release@sha256:<digest>`, from inside kind's network
as `kind-registry:5000/...`), put `catalogPolicy` in a values file under
`_local/` with the public key and `registry.mirrors: {localhost:5001:
http://kind-registry:5000}`, and `make kind-deploy-kernel
KIND_KERNEL_VALUES=_local/<file>.yaml`.

### Sizes, sleeping and headroom

Each chart ships four presets in `sizes/` (`minimal`, `resilient`,
`scaled`, `auto`), layered under your values with `-f`. They set the
copies of the console, kernel-api and the scheduler (with
PodDisruptionBudgets from two copies, so drains and upgrades take one at a
time), the scheduler's step caps and default step size (and, in `scaled`,
its `claimLimit` and `executorConcurrency`), how long executions are kept,
and the in-cluster Postgres: its volume, its memory with settings sized to
it (`postgres.settings`: shared buffers, cache size, working memory,
connections), and how many connections each process holds (the kernel's
`databaseMaxConnections`, the console's `databasePoolSize`, the gateway's
`gateway.databaseMaxConnections`), so every process's together stay under
Postgres's `max_connections`. Postgres has no CPU limit, so it can take a
burst. `auto` scales the console and kernel-api from one to three
copies on CPU load, and needs the cluster's metrics API (metrics-server;
built into GKE, EKS Auto Mode and AKS Automatic). `vennir` picks one
from its `size` setting. A preset doesn't say where steps run: Spot is
`scheduler.taskPlacement`. Labels every step Pod needs, such as AKS
Workload Identity's `azure.workload.identity/use: "true"`, go in
`scheduler.taskPodLabels`.

| Preset | Console | kernel-api | Scheduler | Steps at once (all, per team) | Executions kept | Kernel database volume | Postgres memory (connections) | Each process's connections |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| None (the charts' defaults) | 1 | 1 | 1 | no cap | 90 days | 1Gi | 512Mi (100) | 10 |
| `minimal` | 1 | 1 | 1 | 10, 5 | 30 days | 10Gi | 512Mi (100) | 10 |
| `resilient` | 2 | 2 | 1 | 50, 20 | 90 days | 50Gi | 1Gi (200) | 15 |
| `scaled` | 3 | 3 | 2 | 200, 50 | 90 days | 100Gi | 2Gi (300) | 20 |
| `auto` | 1 to 3 | 1 to 3 | 1 | 50, 20 | 90 days | 50Gi | 1Gi (200) | 15 |

**More than one copy.** kernel-api holds no state, so any number of
copies is safe. So is more than one scheduler: each claims steps with
`FOR UPDATE SKIP LOCKED` under a lease, so two never claim the same step,
and one that dies has its running steps adopted by another when its leases
expire. The one thing that loosens is the step caps: `maxRunningTasks` and
`maxRunningTasksPerTeam` are exact with one scheduler, and with several
each counts on its own and can overshoot by up to one `claimLimit`. A
product's own cap and concurrency key stay exact. A step of a team's
shared product, run for another team, counts against both teams'
`maxRunningTasksPerTeam`. A claim also locks each step's execution
(skipping, not waiting for, one that's being cancelled), so the steps of
one execution are claimed by one scheduler at a time. Several console copies
share everything through the database (the catalog sync and the audit copy
run on one at a time), except the sign-in throttle, which each copy keeps
in its own memory.

- **Sleeping when idle** (kernel chart, `scaleDown`): a CronJob scales both
  releases' Deployments to zero after `idleAfterMinutes` with no execution
  unfinished or recently finished, nobody using the console (the console
  records its last use in its `activity` ConfigMap) and kernel-api not
  restarted; `schedule` also sleeps it at set times once nothing runs.
  Volumes stay. Wake it with `vennir wake`, or by scaling each
  Deployment back to the copies recorded in the
  `kernel-execution-kernel-sleep` ConfigMap (the database first). While
  asleep, the console and kernel-api don't answer, so catalog CI fails
  until it's woken. A `helm upgrade` while asleep wakes it (pass
  `--force-conflicts`: the sleeper owns the replica counts it set).
- **The image scanner idles** on its own (console chart,
  `scanning.idleMinutes`, 15 by default): scaled to zero when no scan has
  been asked for in that long, and back up for the next, whose first scan
  then waits about a minute for it.
- **Warm headroom** (kernel chart, `stepHeadroom.replicas`): placeholder
  Pods the size of a default step, at a priority every step outranks, so
  a step takes a placeholder's place instead of waiting for a node. It's
  reserved around the clock: for always-on installs.

### Metrics and alerts

Everyone signed in sees the Observe page's Metrics tab, which needs nothing
installed: steps started and how long they waited, why they failed, and
each product's step times, from kernel-api's own tables.

For Prometheus, every component serves `/metrics`: kernel-api on its API
port (8000), the scheduler on `scheduler.metricsPort`, and the console
(`monitoring.port`) and gateway on 9090. The console's metrics port is
never behind its Ingress. Each is open only to
`networkPolicy.metricsFrom`, so list your Prometheus there, in both charts:

```yaml
networkPolicy:
  metricsFrom:
    - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: monitoring}}
```

Which Prometheus is `monitoring.provider`, the same in both charts:

- **operator**: the Prometheus Operator's resources (kube-prometheus-stack;
  VictoriaMetrics's operator reads the same), each off by default because
  it needs that operator's CRDs. On kind or an existing cluster, `vennir
  init` finds one and offers it (`--monitoring operator`), reading which
  labels its Prometheus selects PodMonitors and rules by and which
  namespace it scrapes from, so nothing needs looking up.
- **google**: GKE's Managed Service for Prometheus, which reads its own
  `PodMonitoring` and `Rules` (`monitoring.googleapis.com`); the kernel
  chart lets its collector read the kernel's TLS CA (that one Secret,
  public). Its collector runs in `monitoring.google.collectorNamespace`:
  `gmp-system`, or `gke-gmp-system` on Autopilot; list that in
  `metricsFrom`. It's billed per sample ingested ($0.06 a million):
  Vennir's few hundred series every 30 s are about 35 million a month, a
  few dollars. `VennirSchedulerDown` also needs GKE's kube-state-metrics
  package; without it, it never fires. Alerts go wherever the cluster's
  managed Alertmanager sends them (configured apart). `vennir init` offers
  it on gcp (`--monitoring google`).
- **bundled**: a Prometheus of the console chart's own
  (`monitoring.prometheus.enabled`): one Pod and a volume
  (`monitoring.prometheus.size`, 2Gi; `retentionDays`, 15), scraping this
  namespace's Vennir Pods (kernel-api over TLS, checked against the
  kernel's CA) through a Role that lists only this namespace's Pods, and
  evaluating both charts' alerts. The kernel chart's come as a ConfigMap
  it reloads when a kernel upgrade changes them (within a minute). Only
  the console may connect to it, to show its alerts on Observe's
  **Metrics**; read anything else with `kubectl -n <namespace>
  port-forward svc/console-execution-console-prometheus 9090`. Without an
  Alertmanager (`monitoring.prometheus.alertmanager.url`), nothing sends
  firing alerts anywhere: they show on Observe and on its own Alerts page. It can also send every sample on
  (`monitoring.prometheus.remoteWrite.url`), each signed as the Pod's AWS
  identity when given a `sigv4Region`. List it in both charts'
  `metricsFrom`:

  ```yaml
  networkPolicy:
    metricsFrom:
      - podSelector: {matchLabels: {app.kubernetes.io/instance: console, app.kubernetes.io/component: prometheus}}
  ```

  `vennir init` offers it on every target (`--monitoring bundled`).
  Without kube-state-metrics, its `VennirSchedulerDown` is a scheduler
  Pod that can't be scraped, or is but finishes no passes.
- **amazon** (`vennir` on aws, `--monitoring amazon`): the bundled
  Prometheus writing to an Amazon Managed Service for Prometheus workspace
  the aws module makes, and sending its alerts to the workspace's
  Alertmanager, which publishes them to an SNS topic (`<name>-alerts`); an
  email (`monitoring.alertEmail`, the first admin's by default) is
  subscribed and confirms by email. It runs as `vennir-prometheus`, whose
  Pod Identity role may only write to that workspace and raise alerts in
  it. Collected in the cluster rather than by AWS's agentless scraper
  (about $29 a month more), so kernel-api's certificate is still checked
  and only that one Pod may reach the metrics ports. A few dollars a month:
  Vennir's samples and SNS's emails. In the charts it's `bundled` with
  `remoteWrite` and `alertmanager` set.

- `monitoring.podMonitor.enabled` (both charts; not bundled): PodMonitors
  (or PodMonitorings). Add the
  labels your Prometheus selects them by in `monitoring.podMonitor.labels`
  (kube-prometheus-stack: `release: <its release name>`).
- `monitoring.alerts.enabled` (both charts): PrometheusRules (Rules; a
  rule file with bundled; `helm/tests/prometheus-rules.sh` evaluates them).
  `VennirSchedulerDown` (no pass in 10 minutes while the scheduler should
  be running; needs kube-state-metrics, so an install that's asleep isn't
  down), `VennirSchedulerFailing`, `VennirStepsWaiting` (the oldest ready
  step waited past `monitoring.alerts.readyWaitSeconds`),
  `VennirStepsUnschedulable` (started steps kept having no node with room
  for `monitoring.alerts.unschedulableMinutes`, 15: the cluster at its node
  limit, or out of a quota; counted across the scheduler replacing each
  Pod at its start timeout),
  `VennirConsoleFailing`, `VennirSignInBurst`, `VennirCatalogNotApplying`
  and `VennirGatewayBackendUnreachable`.
- `monitoring.dashboard.enabled` (console chart): the Grafana dashboard
  (`files/grafana-dashboard.json`: steps, the console, the gateway) as a
  ConfigMap labelled for Grafana's dashboard sidecar; set
  `monitoring.dashboard.namespace` if the sidecar watches only Grafana's.
- `monitoring.grafanaUrl` (console chart, `""`): where that Grafana is, for
  a link on the Admin page and (for admins) Observe's Metrics. The console
  never calls it. Which provider the Admin page names is `monitoring.provider`
  once any of `podMonitor`, `alerts`, `dashboard` or `prometheus` is on.
- `monitoring.prometheusUrl` (console chart, `""`): the Prometheus whose
  alerts Observe's **Metrics** shows, quiet, pending or firing (the
  console reads its `/api/v1/rules`, keeping the charts' `vennir-*`
  groups). Any Prometheus that evaluates the charts' rules: the cluster's
  (kube-prometheus-stack's `http://<release>-kube-prometheus-prometheus.<namespace>.svc:9090`)
  or one outside it, such as one on your machine for kind
  (`http://host.docker.internal:9090`). Empty: the bundled one when it's
  on, else none. A Prometheus with a NetworkPolicy of its own must admit
  the console's Pods. One Prometheus shared by several installs shows
  each install's Vennir alerts on every one of them.
- `monitoring.google.project` and `monitoring.google.cluster` (console
  chart, `""`): with `monitoring.provider: google` and no `prometheusUrl`,
  where Observe's alerts come from, since GKE's managed Prometheus serves
  no `/api/v1/rules`. The console lists the charts' `Rules` in the cluster
  (a read its RBAC gets with `google`), and which fire from the project's
  managed Prometheus (`ALERTS` and `ALERTS_FOR_STATE`, this cluster's), as
  its own Google service account, which needs `roles/monitoring.viewer`
  there. Google keeps no firing alert's own text, so each shows its rule's
  summary and its labels. Without the role, the rules show with their state
  unknown, saying what's missing. `vennir` sets both and grants the role.
  GKE's in-cluster rule evaluator (`rule-evaluator.gke-gmp-system.svc:19092`)
  does serve `/api/v1/rules`, with live states and each alert's text, but
  it's an internal endpoint, not a published API, so `vennir` doesn't point
  `prometheusUrl` at it (decided 2026-11-02).

The metrics, for alerts and dashboards of your own:

| Metric | Labels | What it counts |
| --- | --- | --- |
| `kernel_tasks` | `state` | Unfinished steps by state (`BLOCKED`, `READY`, `AWAITING_APPROVAL`, `CLAIMED`, `RUNNING`); `READY` only of running executions (a failed one's wait for a retry) |
| `kernel_oldest_ready_task_age_seconds` | | How long the longest-waiting `READY` step of a running execution has waited; 0 when none is |
| `kernel_unschedulable_steps` | | Step Pods no node has room for now (the cluster full, or unable to grow), from the scheduler's watch; the chart's unschedulable alert fires on it |
| `kernel_scheduler_tick_duration_seconds` | | One scheduler pass |
| `kernel_scheduler_tick_errors_total` | | Passes that failed (logged, retried next pass) |
| `kernel_catalog_policy_passes_total` | `outcome` | `kernel policy`'s passes (`ok`, `failed`: logged, tried again next pass) |
| `kernel_scheduler_status_read_errors_total` | | Failed reads of a running step's status (read again) |
| `kernel_events_total` | `event_type` | Step and execution events |
| `kernel_http_requests_total`, `kernel_http_request_duration_seconds` | `method`, `path` (and `status`) | kernel-api's requests |
| `console_rpc_requests_total`, `console_rpc_request_duration_seconds` | `procedure` (and `code`) | The console's API calls |
| `console_catalog_syncs_total` | `outcome` (`unchanged`, `applied`, `applied_with_problems`, `failed`) | Catalog release checks |
| `console_image_scans_total` | `status` (`passed`, `failed`, `error`) | Image scans finished |
| `vennir_gateway_requests_total` | `api`, `outcome` | Gateway requests, by what happened to them |
| `vennir_gateway_request_duration_seconds` | `api`, `answered_by` | Gateway request times |

**Health.** kernel-api and the console answer `GET /health/live` (the
process is up) and `GET /health/ready` on their API ports: kernel-api's is
ready once its database answers and is at the schema its code expects, the
console's once its database answers. The charts' probes use them. The
scheduler serves no health endpoint: its loop touches a heartbeat file each
time round and between the phases of a pass, and its liveness probe
restarts it when the file is older than `scheduler.livenessSeconds` (420;
keep it above the slowest phase a slow Kubernetes API can make, as its
comment in the chart's values works out).

**Log format.** One JSON object per line on stdout. The kernel's carry
`timestamp`, `severity` (`INFO`, `WARNING`, `ERROR`), `logger`, `message`
and `service` (`kernel-api`, `kernel-scheduler`, `kernel-migrate`,
`kernel-sleeper`), then the line's own
fields; kernel-api logs each request with its `requestId` (`X-Request-ID`,
reused or generated). The console's are Fastify's (pino's: a numeric
`level`, `time`, `msg`, `reqId`), and its own events carry an `event`
field, such as `catalog_sync_failed`. The level is fixed at INFO; there's
no setting for it.

### The audit log's copy

The console chart's `audit.export.keepDays` and `audit.export.lock` (0 and
false; vennir sets them from `audit.keepDays` and `audit.lock`) only tell the
Admin page what the bucket keeps, which shows them "as configured": the
bucket enforces them, and the console's identity may write and read the
bucket's objects but not read its retention or lock back.

The console hash-chains its audit log: each entry's hash covers the entry
before it, so changing, removing or adding one breaks every later hash. With
the console chart's `audit.export` (vennir: `audit.export` in vennir.yaml, on
gcp and aws), every `minutes` it checks the new entries' chain and copies
them as one JSON-lines object (`<prefix><yyyy>/<mm>/<dd>/<first>-<last>.jsonl`)
to a bucket that refuses deletes and overwrites, create-only on its side
too. A broken chain stops the copy where it breaks; Observe's security
checks say where, and `ObserveService/GetAuditCopy` gives the copy's state
(how far it has gone, what's waiting, the entry where the chain broke; the
bucket to admins).

The chain alone misses a change whose every later hash was rewritten too
(someone who can write the database can). So every hour the console also
compares a few copies with the database, entry by entry, round and round
through the whole copy: an entry changed or gone since it was copied is
named, in Observe's security checks, the Admin page and the log
(`audit_copy_differs`). Proven on kind with SeaweedFS (2026-10-29): a
copied entry rewritten with a new hash was caught within the minute after
a restart.

- **gcs**: a retention policy of `audit.keepDays`; the console's Google
  identity may create and read objects, never replace or delete them.
- **s3**: Object Lock, governance mode, `audit.keepDays`; the console's role
  may put, read and list objects, never delete them.
- `audit.lock: true` locks it: GCS locked retention, S3 compliance mode.
  Nobody, the cloud account's owners included, can then shorten it, and the
  bucket can't be deleted until the last object's retention lapses. That's
  the point, and it's permanent: decide before you set it.

`vennir destroy` never deletes the audit bucket. On kind, `make
kind-audit-store` runs SeaweedFS (S3 with Object Lock) with a bucket locked
for a day; point `audit.export` at it in a values file under `_local/`.

### Logs

Observe's Logs tab searches every step's output, the API backends teams
run in their API backends' namespaces (`<team>-apis`; Pods labelled
`vennir/api-backend: "true"`, each team its own; also labelled `vennir/api: <name>`, searchable by API), and, for admins, the platform's own, when the console chart's `logs.enabled` is on (`vennir`:
`logs.enabled` in vennir.yaml). Grafana Alloy collects through the
Kubernetes API, redacting credentials, into one Loki; the console queries
Loki with each caller's visibility added. Each step's Job is kept
`scheduler.releaseFinishedAfterSeconds` (kernel chart, 30) after it
finishes so the collector reads it all.

- `logs.searchDays` (30): how far back anyone searches.
- `logs.keepDays` (365): when Loki deletes them.
- `logs.storage`: `filesystem` (kind's: every log on Loki's volume),
  `gcs` or `s3` with a `bucket`. Loki always has a volume of `size` for
  its write-ahead log and the index it uploads every 15 minutes, so a
  restart loses nothing (`vennir` gives it 2Gi with a bucket). Loki's identity goes on its ServiceAccount
  (`serviceAccountName`, `serviceAccountAnnotations`).

Archiving is the bucket's: on gcp and aws, `vennir` creates
`<project>-<name>-logs` (GCS) or `<name>-logs-<account>-<region>` (S3)
with a lifecycle rule moving Loki's chunks (`fake/`) to the Archive class
(GCS) or Glacier Instant Retrieval (S3) after `searchDays`, and deleting
everything a day after `keepDays`. Loki still reads archived chunks, so an
admin can query older logs with Loki's own tools (`logcli`) through a
port-forward; the console searches only `searchDays` back. S3 moves only
objects of 128 KB or more by default, so a quiet install's smallest chunks
stay in Standard (at a negligible cost). Archived
storage costs a fraction of a cent per GB-month, but has a minimum stay
(GCS Archive 365 days, Glacier IR 90), billed if deleted earlier. A volume
has no archive class: logs are kept on it until `keepDays`.
`vennir destroy` keeps the logs bucket unless you delete the data too.

### Uninstalling

`vennir destroy` does this for you (setup.md says what it keeps). By hand,
the console first, then the kernel:

```
helm uninstall console -n vennir-system --wait
helm uninstall kernel -n vennir-system --wait
```

That removes the platform's Pods, Services, RBAC and admission policies.
It leaves:

- **The databases' volumes.** `postgres.persistence.keepOnUninstall` (on by
  default) keeps each PVC, and with it each chart's Secret of passwords
  (`kernel-execution-kernel-db`, `console-execution-console`): the data
  only opens with the passwords it was made with, and installing the same
  release names again reads them back. Delete both when you mean to:
  `kubectl -n vennir-system delete pvc -l 'app.kubernetes.io/instance in (kernel,console)'` and
  `kubectl -n vennir-system delete secret kernel-execution-kernel-db console-execution-console`
  (`vennir destroy` asks). Switching to `existingSecret` later leaves the
  kernel's kept Secret behind too; delete it the same way.
- **The team namespaces**, with their Secrets, ServiceAccounts and anything
  steps made there. The console created them, not Helm. Delete them with
  `kubectl delete namespace -l vennir/team` (retired ones included), and
  their API backends' namespaces with `kubectl delete namespace -l
  vennir/api-backends`.
- **The migration hooks' leftovers.** Helm doesn't delete hook resources
  on uninstall. The console's last migrate Job (kept for its log) and its
  `<console>-execution-console-migrate-config` ConfigMap stay. The kernel's
  `<kernel>-execution-kernel-db-migrate` Secret (the database superuser's
  URL) is deleted once its hook succeeds, even if a later hook then fails;
  it stays only if Helm was interrupted before that, or creating it
  failed. An upgrade that times out while the migrate Job is still
  retrying deletes the Secret under it, so the Job's later attempts can't
  start: run the upgrade again. Delete what's left with
  `kubectl -n <namespace> delete job/<console>-execution-console-migrate configmap/<console>-execution-console-migrate-config secret/<kernel>-execution-kernel-db-migrate --ignore-not-found`
  (`<console>` and `<kernel>` are the release names, `console` and
  `kernel`; `<namespace>` is the platform's, `vennir-system`).
- Anything outside the charts: buckets, cloud identities, the registry, and
  the platform namespace itself.

## Upgrading

`helm upgrade` with the same values files and `--reset-values`. Two things
to know:

- **Upgrade both charts with `--force-conflicts`.** The console edits
  the kernel's image, identity and scan policies, and (with the gateway on)
  its own chart's gateway token policy, so Helm's server-side apply sees it
  as their owner (and `kernel policy`, with `catalogPolicy`, its catalog
  policies); without the flag the upgrade fails with a conflict. Each
  chart writes back what they last set, so nothing is lost.
- **The gateway's exact-audience check waits for the console.** The
  gateway token policy holds each API's ServiceAccount to its API's own
  audiences only once the console has written them (`apiAudiencesWritten`).
  The upgrade onto the chart that adds them, and any render without lookup
  (`helm template`, a GitOps tool applying rendered manifests), sets the
  check off, leaving the policy's other rules; the new console turns it
  back on with its next write: at startup, and every few minutes after
  (`policySyncIntervalSeconds`). A GitOps tool that reapplies the rendered
  policy turns it off again each time, until that next write.
- **Migrations run first**, as a Helm hook, before any new Pod starts, on
  every upgrade (a no-op when nothing's pending), against the database the
  upgrade is going to: the kernel's hook reads its URL from a hook Secret
  of its own (`<release>-execution-kernel-db-migrate`), since the release's
  other resources, its main Secret included, are updated only after it. The scheduler waits for
  them on a fresh install.

**`shareWith` is gone from `api.yaml`** (unreleased, on main since
2026-11-06; decision 26): only an API's own team and whoever its access
list grants may call it. The teams an `api.yaml`'s `shareWith` named stop
calling at this upgrade (the console's migration empties what it held, so
even a gateway from before, still running, lets them in no more), and
`vennir catalog validate` refuses an `api.yaml` that still has it. Before
upgrading, have each API's team grant the people and bots that called
through it (in the console, or `ApiService/AddApiGrant`), then drop
`shareWith` from the catalog. A team named in `limits` gets no access from
it either.

**kernel policy signs in as its own database role** (unreleased, on main
since 2026-11-06): with `catalogPolicy` and the bundled Postgres, the
upgrade's migration Job makes `postgres.auth.policyUsername`
(`vennir_kernel_policy`) and the migration grants it only what it uses; its
Pod restarts onto it. On GKE and EKS, `vennir` turns `catalogPolicy` on
for an install whose own catalog is signed: the cloud's module gives kernel
policy an identity of its own (a Google service account, or a role by Pod
Identity) that reads the catalog's registry and, with Cloud SQL or RDS,
signs in as its own database user. Elsewhere, name a role of
your own with `catalogPolicy.database` (and a Secret whose `database-url`
signs in as it) to narrow it.

**Settings the console now refuses or turns off** (since 2026-11-03):

- A `jwtSecret` set by hand shorter than 32 bytes stops the console at
  startup. Set a longer random one, or leave it empty for the generated
  one. Changing it ends every session ([Rotating secrets](#rotating-secrets)).
- An install with no console host (`ingress.host` or `gatewayApi.host`),
  no `notifications.consoleUrl` and no `keyless.audience` has keyless bots
  turned off. Before, it accepted CI tokens minted for the constant
  audience `vennir`. To keep keyless sign-in, set `keyless.audience` (and
  have each CI job request a token for it).

**Settings removed** (0.12.0):

- **The kernel chart's `scheduler.taskPodHardening`.** Step Pods are
  always hardened (Pod Security's `restricted`: non-root, a read-only root
  filesystem with a writable `/tmp`, no capabilities, no privilege
  escalation, no Kubernetes token), and the dispatch policy always refuses
  a Job that isn't. Drop the key from a values file that sets it (Helm
  ignores it if left). An install that had it `false` must first rebuild
  any step image that runs as root or writes outside `/tmp` and
  `/platform/output`; until then those steps fail. The kernel ignores a
  `TASK_POD_HARDENING` left in an older ConfigMap. While the upgrade rolls
  out, a step the old scheduler still dispatches unhardened is refused
  (`DISPATCH_REJECTED`, not retried: retry it once the new scheduler runs),
  and an unhardened Job it made but hadn't started is never adopted by the
  new one; steps already running finish as they started.

**Changes people will notice** (0.12.0):

- **Who may call an API is its access list** (decision 26 in
  `assessment.md`; `console/docs/11-apis.md`). Besides the API's own team,
  only the single sign-on groups, people and bots its team's maintainers
  grant may call it, on each install; admins too need a grant. For this
  release, the teams an `api.yaml`'s `shareWith` names keep calling, shown
  as *from the catalog*, and `vennir catalog validate` warns; the next
  release drops `shareWith`, so have each API's team grant its callers
  first. A catalog's `api.yaml` may say `access.requests` only once its
  `./vennir` pin is a release that knows it (0.12.0 or later).
- **Single sign-on with a groups claim signs people in for an hour.** A
  team a groups claim gave someone counts only for a single sign-on from
  the last hour, at the console and the gateway, and that sign-in's
  session lasts an hour at most ([Signing in](security-model.md#signing-in)).
  Google Workspace groups alone keep the usual session length.
- **A raw DAG's steps are seen by their own teams.** A member of one of
  its teams sees that team's steps in full and the others' state, timing
  and failure code only; admins and whoever submitted it see everything
  ([Who sees a run that spans
  teams](security-model.md#who-sees-a-run-that-spans-teams)).
- **Reads are recorded.** Who was shown runs' outputs, logs and secret
  names goes in `audit_reads` (`AdminService/ListAuditReads`), kept for
  the console chart's `retention.auditReadsDays` (90 days by default).

**Changes an upgrade must carry together** (since 2026-11-03):

- **The kernel's image and chart.** A step's Job is now created suspended
  and resumed once its request is the kernel's, which needs the chart's
  `patch` on Jobs and its dispatch policy's rule for it. A newer kernel
  image under an older chart refuses every step (`DISPATCH_REJECTED`).
  A release's chart runs its own images, so upgrading by release keeps
  them together.
- **An AWS install's catalog repository.** The catalog publish role now
  trusts only jobs whose OIDC subject names `main`, so the repository's
  tokens must carry their branch even in an Environment (subject claims
  `repo`, `context`, `ref`). `vennir apply` sets that before it changes the
  role, with `gh` signed in as an admin of the repository; without `gh` it
  stops and gives the one command that sets it. Until it's set, publishing
  from the `catalog-publish` Environment is refused.
- **A catalog repository pinned by its id** (since 2026-11-05). Catalog
  CI's federation now trusts the repository's GitHub id and its owner's,
  not its name, which a renamed or re-created repository could hold.
  `vennir apply` reads the ids before planning, with `gh` signed in, and
  pins the federation to them: on GCP the provider's condition and the
  publish account's binding; on AWS, once approved, it has the
  repository's tokens carry them (subject claims `repo`, `context`, `ref`,
  `repository_owner_id`, `repository_id`) before the role trusts only
  subjects ending in them.
- **A catalog's `ci.yml` and its `./vennir` pin** (after 0.9.0). Catalog CI
  on `main` now plans, builds teams' products in their own Environments
  (`buildEnvironments`), then publishes, with commands only `vennir` after
  0.9.0 has, and a sign-in step in `.github/actions/`. Take the template's
  `.github/workflows/`, `.github/actions/` and the pin in one pull request
  (the catalog guide, "Updating your catalog").

**The catalog's policies, written by the kernel** (0.12.0; decision 27
in `assessment.md`). With the kernel chart's
`catalogPolicy` on ([The catalog's policies](#the-catalogs-policies)):

- **This release, both write.** The kernel chart adds two policies,
  `<kernel>-execution-kernel-catalog-identity` and `-catalog-tokens`, seeded
  on the upgrade from the console's identity and gateway token policies
  (lookup), so nothing is refused while `kernel policy` first reads the
  catalog; it writes them once it has applied a verified release. The
  console keeps writing its own policies whole, releases included. Upgrade
  the kernel chart first, as always.
- **What stops running as a product.** A product the signed catalog's
  release doesn't name: one registered by hand (ProductService/
  RegisterProduct) and platform products (no team). The console refuses
  to submit their steps as their products (`IDENTITY_PENDING`); run them
  as `default` with no Secrets, or release them through the catalog. So
  does a new release's product until `kernel policy` has read it
  (`catalogPolicy.pollSeconds`, a minute by default): try again then.
- **Let unfinished executions finish first.** A step the kernel starts
  after the upgrade (a later step of a DAG, a retry, one awaiting an
  approval) must pass the kernel's policy too: one of a platform product,
  or of a product registered by hand, or one still running an older chart's
  legacy list (by repository, which the kernel's seed doesn't carry), is
  refused, not retried (`IDENTITY_NOT_ALLOWED`). Wait for such executions to
  finish (Observe's runs list the unfinished ones), or turn `catalogPolicy` on
  when none run.
- **The release after drops the console's copy** (decision 27's second
  step, unreleased). With `catalogPolicy` on, and once the kernel's policy and
  its binding are in the cluster (an upgrade after the one that made them:
  should that one fail, the console's release rules are still there; a
  render without lookup never splits), the kernel chart renders the
  console's identity policy without the released digests and the two rules
  that read them: it holds each team's secret names alone (and, as the
  kernel's does too, one container, Secrets only as volumes, never ESO's
  ServiceAccounts). The console writes `teamSecrets` and stops computing
  releases; the release maps stay in the policy, empty and read by nothing,
  so the console from before keeps working while the upgrade rolls out.
  Upgrading straight to it from an install without the kernel's policies
  is safe too: the kernel's are seeded from the console's maps before they
  go. Turning `catalogPolicy` off again gives the console's policy back its
  releases, seeded from the kernel's. An install whose catalog isn't signed
  keeps the console writing them, as now. With `catalogPolicy` on and the
  console chart's `catalogPolicy.identityPolicyName` not naming the kernel's
  policy, submissions of products' steps fail (an internal error, logged),
  rather than pass unchecked.

**Images reused under the same tag.** With `pullPolicy: IfNotPresent` (the
default) and a reused tag such as `:latest`, a node that already has the old
image keeps it. Deploy by digest (`image.digest`) or a new tag, or set
`pullPolicy: Always` and `kubectl rollout restart` the Deployments (a Helm
upgrade that changes nothing in the Pod template doesn't restart them).
Check what's really running with
`kubectl get pods -o jsonpath='{..imageID}'`.

### Choosing the version

With `vennir`, the release an install runs is the `vennir` key in
vennir.yaml (`source` builds the working copy instead):
`vennir config set -e <env> vennir <x.y.z>`, then `vennir apply <env>`.
`vennir check` says when a newer release is out; `apply`'s screen names
the releases an upgrade passes over (their migrations run in order, but
read their notes) and says when `vennir` itself is older than the release;
it refuses an older release than the one installed.
With Helm, it's the charts' `--version`; each chart defaults to the images
released with it. Upgrade the kernel first, as on install.

### Rolling back

Migrations only go forward, so a rollback across one means restoring the
databases:

- The kernel runs only against the schema its code expects. kernel-api
  isn't ready until the database is at exactly its newest migration, and
  the scheduler waits for it, logging "waiting for database migrations"
  with the version it expects and the one it found. Older code against a
  newer schema waits forever: `helm rollback` of the kernel works only if
  the upgrade applied no migration (the release added no file to
  `kernel/internal/migrate/sql/`).
- The console doesn't check its schema. Older console code against a newer
  schema isn't tested; don't rely on it.

So take a backup before an upgrade: `vennir backup <env>`, or by running
the backup CronJob by hand (and the console's,
`console-execution-console-pg-backup`, when it has its own Postgres):
`kubectl -n vennir-system create job --from=cronjob/kernel-execution-kernel-pg-backup pre-upgrade`.
To go back: install the previous release's charts, then restore that backup
([Restoring](#backups)).

### Moving the platform out of a team's namespace

The platform's namespace is never a team's. An install made in one (the GKE
reference install ran in `default`, an admins' team namespace, until
2026-11) can't be moved in place: the releases' cluster-wide objects
(admission policies, ClusterRoles) can't belong to two installs at once. So
it's a reinstall into `vennir-system` that keeps the data. With `NS=default`
(the old namespace) and the GKE values (`helm/values/gke/`, already
`vennir-system`):

1. **Workload Identity.** Grant each Google service account
   `roles/iam.workloadIdentityUser` for its ServiceAccounts in the new
   namespace, beside the old ones: on the GKE values,
   `vennir-console-registry` for
   `serviceAccount:<project>.svc.id.goog[vennir-system/console-execution-console]`
   and `[vennir-system/console-execution-console-scanner]`
   (`gcloud iam service-accounts add-iam-policy-binding <gsa> --role
   roles/iam.workloadIdentityUser --member <member>`). policy-controller's,
   in `cosign-system`, doesn't change.
2. **Stop and dump.** Once nothing is running, scale `kernel-execution-kernel-api`,
   `kernel-execution-kernel-scheduler` and `console-execution-console` in
   `$NS` to 0, then
   `kubectl -n $NS exec deploy/kernel-execution-kernel-postgres -- pg_dump -Fc -U postgres execution_kernel > kernel.pgdump`,
   and `execution_console` the same from the Postgres that holds it
   (`deploy/console-execution-console-postgres` on the GKE values).
   Check both with `pg_restore --list`.
3. **Uninstall** both releases from `$NS` ([Uninstalling](#uninstalling));
   the volumes and the passwords' Secrets stay there until step 7.
4. **Install** both charts into `vennir-system`, as on a first install
   ([Installing](#installing-on-a-cluster-with-helm), step 5, without
   `--wait`); `make gke-deploy` upgrades it from then on.
5. **Restore** both dumps into it ([Restoring by hand](#backups), with
   `NS=vennir-system`), and start everything again. At startup the console
   rewrites what names the platform's namespace: the admission policies'
   lists and each team's `vennir-scheduler-logs` RoleBinding.
6. **What doesn't come over:** the image sources an admin added on the
   Admin page (they live in the old install's policy: add them again),
   every session (everyone signs in again), and the console's
   LoadBalancer address (a new one; update DNS and any SSO redirect URI).
   Upgrade policy-controller with its new selector, which now covers `$NS`
   as the team namespace it is (the command in
   `helm/values/gke/policy-controller.yaml`, with `--force-conflicts` once).
7. **Clean up** once it runs: in `$NS`, the old volumes
   (`kubectl -n $NS delete pvc -l 'app.kubernetes.io/instance in (kernel,console)'`),
   the passwords' Secrets and the hooks' leftovers
   ([Uninstalling](#uninstalling)); and the old Workload Identity members
   (`[default/...]`, `remove-iam-policy-binding`).

Team namespaces, their Secrets and their steps' Jobs aren't touched. Move
with nothing running: a step's Job deleted before the new scheduler reads
it fails as `JOB_NOT_FOUND` (retryable).

## Databases

Each chart can run its own Postgres (`postgres.enabled`), a single replica
on a volume (the kernel's runs as its own user, 999, from the start on a
volume made since 2026-10-29, which its claim marks
`vennir.dev/postgres-layout: nonroot`; one made before keeps the image's
way, starting as root to take ownership, until it's
[moved](#moving-postgres-to-its-own-user): `postgres.nonRoot`); or use an external database, such as the managed one `vennir`
makes on Google Cloud or AWS (below). On a small install the kernel's
Postgres can also hold the console's database (`postgres.consoleDatabase`),
where the console signs in as its own role, which owns only its database.
The kernel's processes sign in as a role of their own too
(`postgres.auth.kernelUsername`, `vennir_kernel`), which owns only the
kernel's database and isn't a superuser; the step before each migration
makes it, sets its password from the release's Secret, and hands it the
database and everything in it, so an upgrade from an install that used the
superuser moves over by itself (kernel-api and the scheduler restart onto
it). The superuser (`postgres.auth.username`) is then only Postgres's own,
the backups', and that step's. With `catalogPolicy`, `kernel policy` signs
in as a role of its own (`postgres.auth.policyUsername`,
`vennir_kernel_policy`): the same step makes it, with its own password in
its own Secret (`<release>-execution-kernel-policy-db`), and the migration
gives it what it reads and writes alone (`kernel/internal/migrate/grants.go`).

**Passwords** are generated on install when left empty, kept in the
release's Secret (`<release>-execution-kernel-db` for the kernel: the
superuser's `postgres-password`, the kernel role's `kernel-password`;
`<release>-execution-console` for the console) and read back on every
upgrade. To rotate the superuser's:

```
NS=vennir-system; PG=deploy/kernel-execution-kernel-postgres; SECRET=kernel-execution-kernel-db
NEW=$(openssl rand -hex 24)
# 1. The role, sent on stdin so it never shows in a process list.
printf "ALTER ROLE postgres PASSWORD '%s';\n" "$NEW" | kubectl -n $NS exec -i $PG -- psql -q -U postgres -v ON_ERROR_STOP=1
# 2. The Secret, before any helm upgrade (the migration hook signs in with it).
kubectl -n $NS patch secret $SECRET --type merge -p "{\"stringData\":{\"postgres-password\":\"$NEW\"}}"
# Nothing to restart: backups and the step before each migration read it when they run.
```

The kernel role's: set `kernel-password` and the password in `database-url`
together in the same Secret, then `helm upgrade` (the step before the
migration sets the role's password from it), then restart kernel-api and
the scheduler. With `kernelUsername` empty the kernel's processes use the
superuser, as before, and its rotation changes `database-url` too. kernel
policy's: set `password` and the password in `database-url` together in
`<release>-execution-kernel-policy-db`, then `helm upgrade`, then restart
`deploy/kernel-execution-kernel-policy`.

A console with its own Postgres is the same with its Secret
(`console-execution-console`, deployment `console-execution-console-postgres`),
then restart the console, and the gateway if it runs.

When the kernel's Postgres holds the console's database (what `vennir`
installs), the console signs in as the role `console`, whose password is in
`kernel-execution-kernel-console-db` (keys `password` and `database-url`).
Every kernel install and upgrade sets the role's password from that Secret
(the `console-db` hook Job), so change both together:

```
NS=vennir-system; PG=deploy/kernel-execution-kernel-postgres; SECRET=kernel-execution-kernel-console-db
NEW=$(openssl rand -hex 24)
printf "ALTER ROLE console PASSWORD '%s';\n" "$NEW" | kubectl -n $NS exec -i $PG -- psql -q -U postgres -v ON_ERROR_STOP=1
URL=$(kubectl -n $NS get secret $SECRET -o jsonpath='{.data.database-url}' | base64 -d | sed "s|^\([^:]*://[^:]*\):[^@]*@|\1:$NEW@|")
kubectl -n $NS patch secret $SECRET --type merge -p "{\"stringData\":{\"password\":\"$NEW\",\"database-url\":\"$URL\"}}"
kubectl -n $NS rollout restart deployment console-execution-console   # and console-execution-console-gateway, if it runs
```

Checking a password from inside the Postgres Pod proves nothing: local
connections are trusted there. The console's other secret, the one that
signs sessions, is under [Rotating secrets](#rotating-secrets).

**A managed database (gcp).** With `database.type: managed` (asked by
`vennir init` on gcp, or `--database managed`), the gcp module makes Cloud SQL
for PostgreSQL 16 instead of the in-cluster Postgres: both databases on one
instance, its machine and `max_connections` following the size
(`minimal`: `db-g1-small`; `resilient` and `auto`: 1 vCPU, 3.75 GB;
`scaled`: 2 vCPU, 7.5 GB; 100, 200, 300 connections), a standby in a
second zone with `database.highAvailability` (`--database-ha`, on by
default for `resilient` and `scaled`). It has a private IP only, in the
install's own network, and accepts only TLS, which each service checks
against the instance's own CA (`vennir-db-ca`).

There are no database passwords. The kernel, the console and the gateway
each sign in as their own Google service account (Cloud SQL's IAM database
authentication): the password is the workload's access token, an hour long,
from GKE Workload Identity (`database.iamAuth: gcp` in the charts, which
mount the CA from `database.caSecret`). Their Cloud SQL roles (Client and
Instance User) hold for this instance only, by an IAM condition, not for
every instance in the project. Before the charts, every apply runs
`kernel database-setup` once as a fourth identity, the database
administrator (`vennir-db-admin`), the only one in `cloudsqlsuperuser`: it
opens `execution_kernel` to the kernel alone and `execution_console` to the
console alone, which gives the gateway what it reads, as with the in-cluster
Postgres. Each service then owns its own tables; none can read another's.

**On AWS** it's Amazon RDS for PostgreSQL 16 (`db.t4g.small` at
`minimal`, `db.t4g.medium` at `resilient` and `auto`, `db.m7g.large` at
`scaled`; Multi-AZ with `database.highAvailability`), in the install's VPC
with no public access, reachable only from the cluster's security group,
TLS forced and checked in full (`verify-full`) against Amazon's RDS
certificates for the region. Each service signs in as its own role (EKS
Pod Identity) with a 15-minute token signed locally (`database.iamAuth:
aws`, `database.region`). RDS requires an administrator with a password: it
keeps it in Secrets Manager itself (it's in no state file of Vennir's), and
only `kernel database-setup`'s role may read it, to make the two databases
and the services' users (members of `rds_iam`) and open each database to
its own service alone.

A sign-in token is the password, so neither the kernel, the console nor
the gateway sends one over a connection that doesn't check the server: with `database.iamAuth` (or
`kernel database-setup`'s administrator password on RDS) each refuses to
start unless the database URL says `sslmode=verify-full`, or
`sslmode=verify-ca` with `sslrootcert` naming the server's own CA (what
`vennir` writes on gcp, where Cloud SQL's certificate names the instance,
not its address; `verify-full` on aws). A URL to a loopback address or a
Unix socket, a Cloud SQL Auth Proxy beside it, needs neither.

Cloud SQL and RDS back it up daily, with point-in-time recovery, keeping
`database.backups.retentionDays` backups (at most 35 on RDS); the
backup Jobs and their bucket aren't made. It runs whether or not the
platform sleeps, and the approval screen prices it. `vennir destroy`
deletes it only when told to delete data (on RDS, with the snapshots `vennir
backup` took, which RDS would otherwise keep).

**Moving an install onto it.** For an install whose data is in the
in-cluster Postgres, `vennir config set -e <env> database.type managed`,
then `vennir apply`, moves it: once the server is made and opened to the
services, the writers stop and a Job in the cluster per database pipes
`pg_dump` from the in-cluster Postgres into `pg_restore` on the server,
signed in as that database's own service (`kernel database-token` writes
its token for `pg_restore`), so the service owns what's restored, in one
transaction; then the charts start on the server. The data never leaves the
cluster. A server database that already has tables is never copied over. If
a copy fails before any is done, the platform starts again on the
in-cluster Postgres and nothing has switched; once one is done, the writers
stay stopped and applying again copies only the rest (what's done stays
current, nothing having written since). The in-cluster backups' bucket is
kept, its old backups ageing out as before. Proven on GKE (Cloud SQL) and
EKS (RDS), 2026-10-29. The in-cluster Postgres's volume is kept as the way
back, until you delete its claim. (`vennir backup --to <folder>` first keeps
a copy on your machine too.)

`vennir backup` takes an on-demand backup of the server, and `vennir
backups` lists them. To restore:

```
gcloud sql backups list --instance <instance> --project <project>
gcloud sql backups restore <backup-id> --restore-instance <instance> --project <project>
# or to a moment: gcloud sql instances clone <instance> <new> --point-in-time <RFC 3339 time>

# RDS restores to a new instance, which then replaces the old one's name:
aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier <name> \
  --target-db-instance-identifier <name>-restored --restore-time <RFC 3339 time>
```

**Connecting.** Neither database is exposed outside the cluster, and
NetworkPolicies admit only the platform's own Pods. To look at one:

```
kubectl -n vennir-system exec -it deploy/kernel-execution-kernel-postgres -- psql -U postgres -d execution_kernel
# or execution_console (in the console's Postgres, or the kernel's when it holds both)
```

Always pass `--context`: port-forward output doesn't say which cluster it
reached. Writing by hand bypasses every check the console makes; use the
API for anything it can do. What's in each database:
[architecture.md](architecture.md#data).

**Retention.** Finished executions (with their tasks, outputs, logs and
events) are deleted 90 days after their last event
(`executionRetentionDays`; the console's record of them, its audit log and
scan verdicts have their own settings in `retention`). 0 keeps them forever.
The scheduler deletes them once an hour, so nothing is deleted while it's
stopped or the install is asleep.

**Sizing.** What grows is the kernel's database, by step: each step keeps
its outputs (at most 4 KB), its events, and the last
`scheduler.taskLogs.maxLines` lines of its log, at most
`scheduler.taskLogs.maxBytes` (1 MiB). So a chatty step can cost up to a
megabyte, kept for `executionRetentionDays`. The size presets give the
kernel's volume 10, 50 or 100Gi; without one it's the charts' 1Gi, which a
busy install outgrows. The volume's size is a plain PVC request: raising
it on an upgrade works only if its storage class allows volume expansion,
and Kubernetes refuses to shrink one, which fails the upgrade (so going
from `scaled` to `resilient` needs `postgres.persistence.size` kept at
the larger size). Postgres doesn't hand space from deleted rows back to the
disk; it reuses it.

### Moving Postgres to its own user

The kernel's Postgres on a volume made before 2026-10-29 still starts as
root (`postgres.nonRoot: auto` leaves it so, on every upgrade). Moving it
to run as its own user (999) is one explicit upgrade, with Postgres down
for a restart:

1. **Back it up first**, and check the backup is there: `vennir backup
   <env>` (or `--to <folder>`), or the CronJob run by hand ([Upgrading](#upgrading)).
   A move changes only permissions, never data, but a backup is the way
   back from anything.
2. **Upgrade with `postgres.nonRoot: true`**: with Helm,
   `--set postgres.nonRoot=true` on the usual upgrade; with `vennir`, in
   the file its `values:` names (`postgres: {nonRoot: true}`), then
   `vennir apply <env>`. The claim is marked
   `vennir.dev/postgres-layout: nonroot`, so `auto` keeps the new layout
   afterwards; the setting can go back to `auto`.

What happens: the old Pod stops (the Deployment recreates, never two at
once), and the new one runs as 999 with the volume's group (`fsGroup`).
The data is already where the new layout keeps it (`pgdata/` on the
volume) and already owned by 999 (the image's entrypoint saw to it), so
only permissions change. Before any container starts, the kubelet's first
`fsGroup` pass gives the volume's group to every file and opens them all,
the data directory to 2770, which Postgres refuses (it wants 0700 or
0750). The Pod's first init container, `postgres-layout`, then closes
them again, as 999: the files first, the data directory last, so a move
interrupted anywhere (the Pod killed, the node gone) is finished by the
next start, and one that's done is left alone (it logs `in place`). Later
starts get no kubelet pass: the volume's root has the group by then
(`fsGroupChangePolicy: OnRootMismatch`). The pass and the check are one
walk of the data directory each; Postgres keeps a few thousand files, more
with many tables.

It refuses, changing nothing, when a move isn't safe: no `pgdata/` on a
volume that holds something else (Postgres would start an empty database
beside it), a file in it not owned by 999, or data from another Postgres
major than the image's. Postgres doesn't start; the Pod shows `Init:Error`
and says why (`kubectl -n vennir-system logs deploy/kernel-execution-kernel-postgres
-c postgres-layout`, or `describe`). The upgrade's migration hook then
waits for a database that won't come, so stop the upgrade and go back
with `helm rollback kernel <the revision before>`, which runs no
migration hook: Postgres starts as root again, and the image's entrypoint
takes the volume as it is (a file root owned is given back to 999). Fix
what it said, then upgrade with `true` again. `postgres.nonRoot: false`
goes back the same way on any later upgrade.

Proven on kind (2026-10-30), on volumes the kubelet applies `fsGroup` to
as it does a cloud disk (a `local` volume, root-owned 0755 with a
lost+found, as ext4 makes it): the data kept, Postgres as 999 with its
files 0600 and 0700, a rerun and a restart left alone, the Pod killed
mid-move and states interrupted at each step finished by the next start,
both refusals, and going back to root and moving again. Not yet on a
cloud volume.

The console's own Postgres (when it has one) still starts as root.

## Rotating secrets

The databases' passwords: [Databases](#databases). The registry pull
Secret (`registryCheck.pullSecretName`): replace it, and the next policy
sync copies it to every team.

**The certificates inside the cluster** (`tls` in each chart, on by
default) come from a CA each chart makes at install and keeps; each lasts
`tls.days` (ten years by default). To rotate them, delete the Secrets and
upgrade, the kernel first:

```
kubectl -n vennir-system delete secret kernel-execution-kernel-tls kernel-execution-kernel-tls-ca
helm upgrade kernel ...    # a new CA and certificates; Postgres and kernel-api restart with them
kubectl -n vennir-system rollout restart deployment kernel-execution-kernel-scheduler
helm upgrade console ...   # then restart the console and the gateway, which read the CA at start
kubectl -n vennir-system rollout restart deployment console-execution-console console-execution-console-gateway
```

For the console's own Postgres (when it has one), the same with
`console-execution-console-tls` and `-tls-ca`. Until everything has
restarted, a client holding the old CA refuses the new certificates.

**The console's `JWT_SECRET`** signs every session (through an Ed25519 key
derived from it, whose public half the gateway reads from the console). It also seals the values the
console keeps in its database to use itself: teams' chat webhook URLs,
order callbacks and their signing secrets, the Google sign-in client secret
set on the Admin page, and the chat agent's key set there. It's generated on
install, kept in the `jwt-secret` key of the `console-execution-console`
Secret and read back on every upgrade; the chart's `jwtSecret` overrides
it. To rotate it:

```
kubectl -n vennir-system patch secret console-execution-console --type json -p '[{"op":"remove","path":"/data/jwt-secret"}]'
helm upgrade console ...   # your usual upgrade: a new one is generated
kubectl -n vennir-system rollout restart deployment console-execution-console
```

A changed Secret restarts nothing by itself, hence the restart. The
gateway needs none: it reads the new public key the first time a session
names it, and drops the old one within a minute (it reads the console's
keys every minute; while the console can't be read, it keeps using the
last ones it read for up to ten). Then:

- every session ends, so everyone signs in again;
- every sealed value becomes unreadable and has to be entered again: each
  team's webhooks and callbacks, the Admin page's sign-in and chat
  settings (chat turns itself off and says why until then).

## Backups

Off by default, for the bundled Postgres only. With the installer, turn them
on with `vennir config set -e <env> database.backups.enabled true`, then
`vennir apply <env>`; with Helm alone, the charts' `backup.enabled`. A CronJob
in each chart runs `pg_dump -Fc`, checks the dump with `pg_restore --list`,
names it `<release>/<UTC timestamp>.pgdump` (with the console's database, on
a shared instance, as `<backupPrefix>/<same timestamp>.pgdump`), and copies it
to `backup.destination`:

| `destination` | Copies with | Signs in with | Proven |
| --- | --- | --- | --- |
| `gcs` | `gsutil cp` | GKE Workload Identity | On GKE Autopilot (2026-10-26): dumped, downloaded, restored |
| `s3` | `aws s3 cp` | EKS Pod Identity or IRSA; a key in `s3.credentialsSecret` for an S3-compatible service without one | On EKS Auto Mode with Pod Identity (2026-10-26), and on kind against an S3-compatible service |
| `azure` | `az storage blob upload --auth-mode login` | AKS Workload Identity | Not yet |
| `pvc` | `cp`, deleting dumps older than `pvc.keepDays` | Nothing | On kind |

For the cloud destinations, the copy runs as `backup.serviceAccountName`
(default `vennir-pg-backup`). Create it in the platform namespace and bind
it to an identity that may write to the bucket and nothing else: on GCS,
`roles/storage.objectCreator` and `roles/storage.objectViewer` on the bucket
(`gsutil` lists before writing); on S3, `s3:PutObject`, on a versioned bucket
so an overwrite can't destroy an earlier dump. vennir's aws module does
this, and expires noncurrent versions as long after as current ones: an
overwritten dump stays the full retention after the overwrite, but every
dump is stored (and billed) for twice the retention, since expiring a
version only makes it noncurrent. On Azure, Storage Blob Data Contributor on the container. Keep dumps
as long as you need with a lifecycle rule on the bucket. For `pvc`, create the claim yourself
(`backup.pvc.claimName`): most storage classes bind a volume only once a Pod
uses it, which would hang `helm upgrade --wait`.

**With `vennir`:** `vennir backup <env>` runs the backup Job now and waits
(or, with `--to <folder>`, dumps both databases to this machine, from any
install's in-cluster Postgres, kind included); `vennir backups <env>` lists
the bucket's; `vennir restore <env> <time>` (or `--from <folder>`) does
everything below: it checks both dumps in the Postgres Pod before stopping
anything, dumps the databases as they are to `~/.vennir/backups/<env>/` first,
stops the writers and the sleeper, restores, grants, and starts them again
at their copies (proven on kind, 2026-10-29, a failed restore resumed
included). A restore that fails partway leaves the writers stopped; running
it again finishes. If the backup's schema is older than the one it replaced,
`vennir apply` migrates it forward. With a managed database, `vennir backup`
takes the cloud's on-demand backup and `vennir backups` lists them;
restoring one is the cloud's (`vennir restore` says how).

**Restoring by hand** (proven on kind, replacing both live databases on a
shared instance; with two instances, restore each on its own):

```
# 1. Download a matching pair (gcloud storage cp, aws s3 cp, az storage blob download).
# 2. Note each Deployment's copies, then stop everything that writes
#    (the scheduler releases its leases on the way out).
kubectl -n $NS get deployment kernel-execution-kernel-api kernel-execution-kernel-scheduler console-execution-console
kubectl -n $NS scale deployment kernel-execution-kernel-api kernel-execution-kernel-scheduler console-execution-console --replicas=0
# 3. Copy the dumps into the Postgres Pod.
kubectl -n $NS exec -i deploy/kernel-execution-kernel-postgres -- sh -c 'cat > /tmp/kernel.pgdump' < kernel.pgdump
kubectl -n $NS exec -i deploy/kernel-execution-kernel-postgres -- sh -c 'cat > /tmp/console.pgdump' < console.pgdump
# 4. Inside the Pod (kubectl exec -it ... -- sh):
export PGUSER=postgres
# The kernel's own role owns its database (vennir_kernel; postgres on an
# install from before it had one).
K=vennir_kernel; [ "$(psql -Atc "SELECT 1 FROM pg_roles WHERE rolname = '$K'")" = 1 ] || K=postgres
dropdb --force execution_kernel && createdb -O $K execution_kernel
pg_restore --exit-on-error --no-owner --role=$K -d execution_kernel /tmp/kernel.pgdump
dropdb --force execution_console && createdb -O console execution_console
pg_restore --exit-on-error --no-owner --role=console -d execution_console /tmp/console.pgdump
psql -c 'REVOKE CONNECT ON DATABASE execution_kernel FROM PUBLIC' \
     -c 'REVOKE CONNECT ON DATABASE execution_console FROM PUBLIC' \
     -c 'GRANT CONNECT ON DATABASE execution_console TO console' \
     -c "GRANT CONNECT ON DATABASE execution_kernel TO $K"
# With the API gateway on, its role reads the console's database too:
psql -c 'GRANT CONNECT ON DATABASE execution_console TO vennir_gateway'
rm /tmp/*.pgdump
# 5. Start everything again, each at the copies noted in step 2.
kubectl -n $NS scale deployment kernel-execution-kernel-api --replicas=<as before>
kubectl -n $NS scale deployment kernel-execution-kernel-scheduler --replicas=<as before>
kubectl -n $NS scale deployment console-execution-console --replicas=<as before>
```

The console's database must stay owned by its own role, or the console
can't use its tables. To only check a backup, restore it into a new
database instead.

**Onto a new cluster.** The databases hold the platform's records, not
everything the cluster held. After installing the same release on the new
cluster and restoring both databases as above:

- **Team namespaces aren't re-created on their own.** The console's
  policy sync, at startup and every `policySyncIntervalSeconds` (300),
  rewrites the admission policies' lists, and each team's network policy,
  quota and pull Secret, but only into namespaces that already exist; for a
  missing one it reports a failure (Admin page, `AdminService/GetPolicySync`).
  A catalog team's namespace comes back when a catalog release is applied:
  press **Sync now** on the Admin page's Catalog card, which applies the
  current release again even though it hasn't changed. Any other team's
  namespace has to be created by hand, labelled `vennir/team=true` (and
  `pod-security.kubernetes.io/enforce=restricted`, as the console would).
- **Team secrets' values are gone.** The console records each secret's name
  and keys, never its value, and the values lived only in the old cluster's
  Secrets. Secrets synced from a vault come back once the team's SecretStore
  is applied again (a catalog release does it); the rest have to be set
  again.
- **Products' ServiceAccounts** are made again when products are
  registered, without the cloud-identity annotations an admin added: add
  those again, and the cloud side's bindings for the new cluster.
- **Unfinished steps** whose Jobs were on the old cluster fail as
  `JOB_NOT_FOUND` (retryable: retried if their `maxAttempts` allows).

This is drawn from the code, not yet rehearsed end to end.

## Network policies

Both charts ship NetworkPolicies (`networkPolicy.enabled`, on by default):

| Pod | Accepts connections from |
| --- | --- |
| Kernel Postgres | The kernel release's Pods, and, when it holds the console's database, the console, its migrations and the gateway (`networkPolicy.consoleDatabaseSelector`) |
| kernel-api | The console's own Pods, not its gateway (`networkPolicy.consoleSelector`), and `networkPolicy.metricsFrom` |
| Scheduler | `networkPolicy.metricsFrom` only |
| Console | Anyone on its port; its metrics port, `networkPolicy.metricsFrom` only |
| Gateway | Anyone on its ports; its metrics port, `networkPolicy.metricsFrom` only |
| Console Postgres | The console release's Pods |

So a step can reach neither database nor kernel-api.

Each team namespace gets one too, `vennir-default-deny`, written by the
console with the namespace and rewritten on every policy resync (console
chart, `teamNamespaces.defaultDenyIngress`, on by default; only when the
console manages team namespaces). Its Pods accept connections only from
Pods in the same namespace, so teams can't reach each other. With the
gateway on, a second one, `vennir-gateway-ingress`, lets the gateway's Pods
(and nothing else) reach the Pods a team labels `vennir/api-backend: "true"`. Outbound traffic isn't restricted, except, with
`teamNamespaces.blockMetadata` (on EKS), a third policy,
`vennir-no-metadata`, which lets a team's Pods out anywhere but the
instance metadata server (`169.254.169.254`; IPv4 clusters, which are
what `vennir` makes), so a step can't take its node's role. Never turn it on for GKE: Workload Identity is
served at that address.

### API backends' namespaces

A team's in-cluster API backends run in a namespace of their own,
`<team>-apis`, not in the team's namespace, where its steps run with its
products' ServiceAccounts and its Secrets (`samples/local/apis/greetings`
runs in `local-apis`; on kind, `make kind-sample-api`). The console makes it
with the team (and, on its policy resync, for every team made before),
labelled `vennir/api-backends=true` and never `vennir/team`, so the kernel
dispatches nothing there; it writes only `vennir-default-deny` and
`vennir-gateway-ingress` there (and `vennir-no-metadata` with
`teamNamespaces.blockMetadata`), relabels it `retired` with the team, and
deletes it with the team's when it may purge. No quota or limits: those
are a ceiling on steps; set a ResourceQuota there yourself if a team's
backends need one. A namespace the console doesn't manage needs the same
policies from whoever made it. For one release, a backend still in the
team's own namespace is served too (its namespace keeps
`vennir-gateway-ingress`), and the gateway logs
`api_backend_in_team_namespace` for each such API on every refresh: move
it, and point its `backend.url` at `<service>.<team>-apis.svc.cluster.local`
(with `gateway.backendHosts` allowing `*.<team>-apis.svc.cluster.local`).

Whatever deploys a team's backend (its CD, or a person) needs rights in
`<team>-apis` only, never in the team's namespace: a cluster administrator
binds them there, for example the built-in `edit` ClusterRole, which can't
change RBAC or the namespace itself:

```
kubectl -n payments-apis create rolebinding payments-deployer \
  --clusterrole=edit --serviceaccount=ci:payments-deployer
```

The namespace enforces the Pod Security level team namespaces do
(`teamNamespaces.podSecurity`, `restricted` by default), so the backend's
Pods must meet it, as `examples/greetings-api/deploy.yaml` does.
No team may be named `*-apis`, or longer than 58 characters (so
`<team>-apis` fits a namespace's 63): the console and `vennir catalog
validate` refuse such a name for a new team (and the console a new team
whose `<team>-apis` is an older team's name); a team named so before keeps
working, and one too long for it, or whose `<team>-apis` is another team's
name, gets no API backends' namespace. Where a namespace named
`<team>-apis` is already there and isn't the console's, a new team of that
name is refused; an existing one goes on without it, the console logging
`api_namespace_refused` and its policy resync reporting it (the Admin
page's policies) until the namespace is renamed or handed over (label it
`vennir/api-backends=true`).

## The chat agent

The console's **Ask** panel (decision 24) answers from the docs, citing
them, looks at what a person's teams have, and fills a cart for them to
check and place (with the choices they made and the values they gave; it
never places one). It's off until the console chart's `chat.model` is set, with
`chat.provider` one of four: `vertex`, Gemini through Vertex AI in
`chat.vertex.project` (on with no `chat.model`: Gemini 3.5 Flash,
`google/gemini-3.5-flash`, the one scored; name another only after
scoring it;
`chat.vertex.location` global, or a region to keep requests in it),
signed in as the console's Workload Identity with no key, its Google
service account needing `roles/aiplatform.user` there: what `vennir`
sets up on GCP (`chat.off` in vennir.yaml turns it off, `chat.model`
picks another); `bedrock`, Claude in Amazon Bedrock in
`chat.bedrock.region` (on with no `chat.model`: Claude Sonnet 5,
`anthropic.claude-sonnet-5`, open to every Bedrock account), each
request signed (SigV4) as the console's own AWS identity, its EKS Pod
Identity, with no key: its role needs `bedrock-mantle:CreateInference`
there, which `vennir` grants on AWS for that one model (the condition
`bedrock-mantle:Model`; the scanner's Jobs have a role of their own,
without it); `openai-compatible`, with `chat.endpoint` the
model's base URL (`.../v1`): LM Studio or Ollama on a laptop (kind's values
point at `host.docker.internal:1234`), any other server of
`/chat/completions`; or `anthropic`, Claude
through Anthropic's API (`chat.model` such as `claude-haiku-5-5`). A key,
when one's needed, is a Secret named in `chat.apiKeySecret` (key
`api-key`): `kubectl -n vennir-system create secret generic console-chat-key
--from-file=api-key=<file>`. What a person asks, and what
the agent's tools find for them, goes to the model: on a cloud, use one in
the install's own. Each person may ask 30 questions an hour and 200 a day
(admins change it on the Admin page's chat agent section, or with
`ChatService/SetChatLimits`), and bots none.
`chat.maxSteps` (8), `timeoutSeconds` (180) and
`maxTokens` (8000 on anthropic, bedrock and vertex, where thinking counts toward
it; else 1500) bound one answer; `chat.effort` sets how hard Claude or
Gemini thinks. `chat.contextTokens` (64000 on anthropic, bedrock and vertex, else 16000; at most the model's
own window) bounds what one model call is sent, and so its cost (Claude
Haiku 5.5 costs five times as much for a prompt over 100K tokens: keep it
under): a
conversation that won't fit is refused (`CONVERSATION_TOO_LONG`; the panel
offers a new one, and says when one passes 75%), and a tool result that
won't fit is held back from the model.

Admins can set the model in the console instead (Admin, Chat agent): the
provider, model, key and limits, tried with one question before saving,
in place of the install's until they go back to it. The key is kept
sealed (from `JWT_SECRET`), never shown again; for the install's own
provider, left out, the install's is used. An admin's settings that stop
working (a key that no longer unseals after `JWT_SECRET` changes) turn chat
off and say why there, rather than falling back.

It answers only about Vennir. A short check of each question, by the same
model with no tools, answers anything else with one fixed sentence
(`offTopic`), and the prompt holds the same scope; an answer from neither
the docs it cites nor the platform's tools is never shown, the console's
"I couldn't find that" in its place. Score a model
before trusting it: `npm run chat-eval` in `console/` asks it the question
set (`console/test/docQuestions.ts`), the ordering tasks and questions
it must refuse (`console/test/chatTasks.ts`). The console logs each answer's steps
(`chat_answered`: tools used, sources, citations, and `tokens`: input,
cache reads and writes, output, as the provider counted them), not what was
said. With Haiku 5.5 (2026-10-28, kind): a docs question about 9,000 input
tokens over three calls, under a tenth of a cent; an order about 27,000
over six, 78% read from the cache, about $0.0015; an off-topic question
one call of about 500. With Gemini 3.5 Flash on Vertex: the same scores,
a median of 6.4 s, a question about 7,900 input tokens and an order
about 25,000, little of it cached (Vertex caches only implicitly here).
People rate answers up or down in the panel; Admin's Chat agent section lists them
(question, answer, sources, what was wrong), kept 90 days. A wrong answer
is usually a doc to fix, or a question to add to the question set.

## Throughput

When steps start late, or the scheduler seems slow with steps waiting their
turn, look here first. How many steps a second an install starts and finishes is, in practice,
set by its Kubernetes API calls, not its database: the scheduler and
Postgres alone manage hundreds a second, while each step costs the kernel
about five to seven API calls. The kernel chart's `kubernetesClient` (`qps`,
`burst`) is the kernel's own limit on those calls; at client-go's default
of 5 a second the scheduler finishes about one step a second, whatever else
is set, and logs "client-side throttling". The chart sets 50 and 100, which
tripled kind's throughput (`perf/README.md`); the API server's own priority
and fairness stays in charge of a busy install. Raise it further only if the
scheduler's log still shows throttling. `scheduler.maxRunningTasks` and
`maxRunningTasksPerTeam` cap how many steps run at once (0: no cap), so a
burst of runs queues instead of starting every Pod at once. A second
scheduler (`scheduler.replicaCount`, 2 in `scaled`) is safe, but loosens
those caps ([More than one copy](#sizes-sleeping-and-headroom)).

## Troubleshooting

**Postgres was restarted or moved.** Nothing needs doing. The console and
the gateway drop the closed connections and open new ones; the scheduler's
passes fail and are retried from the database; every run carries on.
Opening a connection is bounded (`databaseConnectTimeoutSeconds`, 10, in
both charts), so one opened as Postgres's Pod is replaced fails after ten
seconds, not after TCP's two minutes of retries. Seen on kind (2026-10-31,
`perf/README.md`): deleting the kernel's Postgres Pod mid-run cost about
ten seconds, and every run ended as expected.

**The first admin's password is lost**, or was never known (a chart
install that set none: the account gets a random one that is never printed,
since a Job's log may be shipped to Cloud Logging or Loki and kept there).
`vennir apply` gives a fresh install's first admin a password it generates,
in a Secret it deletes once the console is installed, and saves it to
`admin-password`; nothing logs it. `vennir admin
reset-password <env>` gives that admin (or `--email` another) a new random
password from inside the console's Pod, saved to `admin-password` in the
environment's folder (readable only by you, never printed): only someone
with access to the cluster can. Every session the account had is signed out,
and the reset is in the audit log. The admin then has to choose their own
password before doing anything else, as anyone given a password by someone
else does (a new account's, or an admin's reset of theirs). Without vennir: `kubectl exec
deploy/console-execution-console -n vennir-system -- node
dist/db/resetAdmin.js <email>`.

**Installed before 2026-11-03, and the first admin hasn't signed in yet?**
Its generated password was printed to the migrate Job's log, which the
cluster's logging may still keep, and it still works: run `vennir admin
reset-password <env>` (or `resetAdmin.js` above) now.

**An admin account appeared after an upgrade.** Every console install and
upgrade creates an admin with the console chart's `bootstrapAdmin.email`
(`admin.email` in vennir.yaml) when no account has that email: the first
admin's account was deleted, or the setting changed. Its password is
random and shown nowhere: give it one as for a lost password (above), if
it's to be used. Delete the account on the Admin page
only after setting `bootstrapAdmin.email` to an admin who stays, or it comes
back with the next upgrade.

**`401` from the console's API.** The token is missing, malformed, expired
(sessions last 8 hours), from before a password change (which signs out
every session), signed out, or a revoked or expired bot token. Everyone at once: the console's
`JWT_SECRET` changed ([Rotating secrets](#rotating-secrets)).

**`429` signing in.** Too many attempts from one address for one account:
wait for the time shown. The counts are in the console's database, shared
by every copy, so restarting the console doesn't clear them; to let someone
in sooner, delete their row from `sign_in_failures` (and
`rate_limit_windows` rows whose key ends in their email).

**A submission is refused.** The response says why:
- `403`: not a member of a team the DAG names; a secret not registered for
  its team; or an image that isn't one of the team's products asking for
  secrets or an identity.
- `422`: the DAG itself (every problem listed), an input that looks like a
  credential, or `IMAGE_NOT_RESOLVED` (the registry doesn't have the tag,
  or the console can't reach it: check `registryCheck` and, on kind,
  `make kind-registry`).
- `409 IMAGE_SCAN_PENDING`: its first scan is still running; submit again
  in a minute. `IMAGE_SCAN_FAILED`: it has a fixable HIGH/CRITICAL
  vulnerability or a secret in it; rebuild it, or an admin accepts it with a
  reason (Admin page, or `ImageService/AcceptImageScan`).

**A task fails with a policy code** (non-retryable, refused by the cluster):

| Code | Meaning |
| --- | --- |
| `DISPATCH_REJECTED` | Its namespace isn't labelled `vennir/team=true`, or its Job isn't shaped as the executor makes it: a volume, pull Secret or placement the install doesn't give steps (after changing `scheduler.taskPlacement`, `capacityPlacements` or `taskImagePullSecret`, upgrade the kernel chart, which renders them into the dispatch policy, rather than only restarting the scheduler) |
| `STEP_JOB_NOT_ALLOWED` | Not a task's: someone other than the scheduler (a team's deploy, an admin's tooling) made or changed a Job or ConfigMap named `ek-` in a team namespace. Name it something else |
| `TEAM_RETIRED` | Its team's namespace is labelled `vennir/team=retired` (retired while the run was going) |
| `IMAGE_NOT_ALLOWED` | Its image isn't under an allowed source (Admin page) |
| `IMAGE_NOT_PINNED`, `IMAGE_SCAN_FAILED` | Not pinned by digest; its digest hasn't passed a scan on this install (failed, or never scanned: a Job that didn't come through the console's submission, or the console's `scanning` is off while the kernel chart's `scanPolicy` is on). Retrying it from the console scans it and admits it |
| `IMAGE_NOT_SIGNED` | Not signed by the catalog's key (with policy-controller) |
| `INPUT_INVALID`, `OUTPUT_INVALID` | Not refused by the cluster but by the kernel: its resolved inputs, or its outputs, don't fit its product's schema (`product.yaml`'s `input` and `output`) |
| `IDENTITY_NOT_ALLOWED` | A ServiceAccount or secret its product isn't allowed. If the console allowed it, the policy may be behind: the Admin's policy sync (`AdminService/GetPolicySync`) shows the last sync's outcome |

**A task never starts, or stays `RUNNING`.** `kubectl get pods -n <team>`
and `kubectl describe pod` name the real problem. A first pull on a cloud
cluster can take a minute while a node scales up. `IMAGE_NOT_FOUND` fails
at once; other pull errors (registry auth, network) fail as
`IMAGE_PULL_FAILED` after two minutes. A step over its team's resource
limits (`teamNamespaces.quota`, or the team's own on its Settings tab)
waits while the team's other steps use the quota (`kubectl get events -n
<team>` says "exceeded quota"), and fails at once as `RESOURCES_NOT_ALLOWED`
when it could never fit.

**A task stays `AWAITING_APPROVAL`.** Its product (or its team's
`allowedTargets`) asks a maintainer of its team to approve it, on the run's
page; the person who ran it can't. Nobody deciding within the kernel
chart's `scheduler.approvalTimeoutSeconds` (3 days; 0 never) fails it with
`APPROVAL_EXPIRED`.

**A task fails with `OUTPUT_CONTAINS_CREDENTIAL`.** Its outputs held
something shaped like a credential, so they weren't stored: the product must
output a reference instead.

**A synced secret doesn't arrive.** `kubectl describe externalsecret <name>
-n <team>` names the failure. Check the store too: `kubectl get secretstore
-n <team>` showing `Ready: False` means the store's own sign-in is broken
(its workload identity binding, or an expired bootstrap credential).

**Old code still runs after a redeploy.** See [Upgrading](#upgrading):
reused tags.

**A catalog workflow shows "a workflow file issue" and runs no jobs.** It
didn't parse. Run `actionlint` on it; a common cause is using `secrets` in a
step's `if:` (move it to `env:` and test that).

**The catalog release doesn't apply.** The Admin page's Catalog card shows
the last check's error and what was applied, and `VennirCatalogNotApplying`
fires after an hour of failures. A failed check applies nothing: the last
release applied stays in force. The console logs each failure as
`catalog_sync_failed`. The usual causes:
- "no trusted signer signed the catalog release": `catalog.signature`
  doesn't match who signed it (another key, or a keyless identity whose
  subject doesn't match `subjectRegExp`). The console's log has cosign's own
  output (`catalog_release_unverified`). The verify Job reaches the
  registry by the name in `catalog.release`, with `registryCheck`'s
  credentials or the scan Jobs' cloud identity; on kind it can't reach
  `localhost:5001`.
- "has no version yet": the install follows `newest` (or a pinned
  version) and the catalog has no `vX.Y.Z` tag for it yet.
- The registry can't be read: check `registryCheck` and the console's
  identity on the registry.

A release that applied with problems (some teams, products or SecretStores
refused, each logged as `catalog_apply_problem`) applied everything else;
the card lists what was refused. A team the catalog didn't make is one of
them until an admin adopts it. **Sync now** checks again at once and applies
the current release even if it hasn't changed.

**On kind:**
- Docker Desktop restarted and the node stopped (`docker ps -a` shows
  `vennir-local-control-plane` as `Exited`): `make up`. If `docker start`
  itself fails, restart Docker Desktop.
- The console stopped answering after a redeploy: its port-forward was on
  the old Pod; `make up`.
- The Postgres image (`postgres:16.15`, by digest) won't load with a TLS error on some networks: `docker save`
  it, `docker cp` it onto the node, and import it with
  `ctr --namespace=k8s.io images import` there.
- Forgotten local admin password:

  ```
  HASH=$(kubectl -n vennir-system exec deploy/console-execution-console -- \
    node -e "require('./dist/auth/password.js').hashPassword('vennir-local').then(console.log)")
  kubectl -n vennir-system exec deploy/kernel-execution-kernel-postgres -- \
    psql -U postgres -d execution_console -c "UPDATE users SET password_hash = '$HASH' WHERE email = 'admin@example.com';"
  ```

  On a real install, another admin creates a new admin account instead.
