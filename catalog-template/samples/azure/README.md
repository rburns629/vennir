# azure: real Azure calls

Example products that call real Azure APIs, to copy from when your product
has to. Running them costs money. `resource-group` and `container-app` are
proven on AKS (2026-11-08, a Free Trial subscription): the DAG below made a
resource group and a public Container App, each step signed in as its own
product's managed identity by Workload Identity, with the roles below.
`postgres-flexible` builds and its tests pass with the Azure clients mocked,
but hasn't called Azure yet.

| Product | What `create` does |
|---|---|
| [`resource-group`](products/resource-group/) | Finds a resource group by name, or creates it |
| [`container-app`](products/container-app/) | Deploys an image as an Azure Container App, creating its Container Apps environment if needed, or returns the existing app's URL. Internal unless `public: true`; a private registry is pulled with a managed identity |
| [`postgres-flexible`](products/postgres-flexible/) | Finds a PostgreSQL flexible server, or creates it with Microsoft Entra sign-in only and no public access, and makes the given Entra principal its administrator. Several minutes: set `timeoutSeconds` to 1500 or more, and delete it after |

Every action looks before it creates, so a retried step is harmless.
[dags/azure-hello-world-dag.yaml](dags/azure-hello-world-dag.yaml) chains the
first two. They run on AKS by Workload Identity, and on GKE, EKS or any
cluster with a public OIDC issuer by federation (Azure from another
cluster, below). [`apis/greetings`](apis/greetings/) is an API on a
Container App, behind the gateway's Entra token (An API on it, below).

## No passwords

`postgres-flexible` turns password sign-in off: only Microsoft Entra
identities sign in, such as an app's own managed identity, so there's no
database password to keep or leak.

## Credentials

No keys: the actions use `DefaultAzureCredential`, which AKS Workload
Identity fills in for the step's Kubernetes ServiceAccount. Each product has
its own, named in its `product.yaml` (`azure-resource-group`,
`azure-container-app`, `azure-postgres-flexible`: the console creates it in
the `azure` namespace, and the cluster lets only that product's image run as
it). Then, for each:

1. A user-assigned managed identity per product, with a federated credential
   for `system:serviceaccount:azure:<name>` and the cluster's OIDC issuer.
2. The annotation `azure.workload.identity/client-id: <its client id>` on the
   ServiceAccount (an admin adds it; the console never changes a product's
   ServiceAccount).

3. The label `azure.workload.identity/use: "true"` on every step's Pod,
   which Workload Identity's webhook needs: the install sets it in the
   kernel chart's values (`scheduler.taskPodLabels`). Without it these
   actions find no credentials and fail with `AZURE_AUTH_FAILED`.

On a cluster that isn't AKS, steps 2 and 3 are replaced by a team secret
(Azure from another cluster, below).

Grant each product's identity only what it needs, on the narrowest scope:

| Product | Role |
|---|---|
| `resource-group` | A custom role with `Microsoft.Resources/subscriptions/resourceGroups/read` and `/write`, on the subscription |
| `container-app` | `Contributor` on the resource group (or a custom role over `Microsoft.App/*`), plus `AcrPull` for the app's pull identity on a private registry |
| `postgres-flexible` | A custom role over `Microsoft.DBforPostgreSQL/flexibleServers/*`, on the resource group |

## Azure from another cluster

Each product declares `tokenAudiences: [api://AzureADTokenExchange]`, so on
any cluster each of its steps gets an hour-long token for its own
ServiceAccount, signed by the cluster's OIDC issuer, at
`/platform/tokens/api___AzureADTokenExchange`. With no Workload Identity
webhook (any cluster but AKS), an action signs in with that token as its
own managed identity, named by the team secret `<its ServiceAccount>-identity`.
On AKS the webhook's settings win, and the secret changes nothing.

To let a GKE or EKS install's steps in, for each product:

1. **A federated credential** on the product's managed identity (Credentials,
   step 1) for the cluster's issuer, the subject
   `system:serviceaccount:azure:<its ServiceAccount>` and the audience
   `api://AzureADTokenExchange`:

   ```bash
   az identity federated-credential create --name vennir-<install> \
     --identity-name <identity> --resource-group <its group> \
     --issuer <the cluster's issuer> \
     --subject system:serviceaccount:azure:azure-resource-group \
     --audiences api://AzureADTokenExchange
   ```

   On GKE the issuer is
   `https://container.googleapis.com/v1/projects/<project>/locations/<location>/clusters/<cluster>`;
   `kubectl get --raw /.well-known/openid-configuration` prints any
   cluster's. Entra must be able to fetch its keys from there, so a cluster
   whose issuer isn't public (kind's isn't) can't be trusted. A managed
   identity takes at most 20 federated credentials, one per install.
2. **A team secret** `<its ServiceAccount>-identity`, such as
   `azure-resource-group-identity`, with the keys `client-id` (the
   identity's client id) and `tenant-id`. Neither is a credential: the
   secret only says which identity to be, as the aws samples' role secrets
   do.
3. **Its `secretRefs`**: uncomment the line in the action's product.yaml, so
   the step gets that secret.

No annotation and no Pod label: those are for AKS's webhook. Its failures
say which part is missing: `NO_IDENTITY` (no secret mounted and no webhook:
the `secretRefs` line still commented), `NO_TOKEN` (the secret is mounted
but the step got no token: a release without the product's
`tokenAudiences`) and
`AZURE_AUTH_FAILED` (Entra refused the token: no federated credential for
that issuer and subject, or it couldn't fetch the issuer's keys).
`postgres-flexible` takes its tenant from the secret too, when it isn't
given `tenantId`.

Built 2026-11-09 and tested with the Azure clients mocked; not yet tried
against Azure from another cluster.

## An API on it (greetings)

[`apis/greetings`](apis/greetings/) publishes a backend on Azure Container
Apps through the gateway, and [`dags/greetings-backend.yaml`](dags/greetings-backend.yaml)
hosts that backend with `resource-group` and `container-app`. The backend is
`examples/greetings-api` in the platform's repository: it greets someone by
name, and answers only requests whose `Vennir-Caller` the gateway signed.

In front of it, the app's built-in authentication (`container-app`'s
`entraAuth`) answers 401 to any request without a Microsoft Entra token
for the backend's app registration from the gateway's identity. The gateway
gets that token per request (`backend.auth.entraToken`): it signs in as a
managed identity with its API ServiceAccount's own token as the federated
credential, so nothing is stored, as for AWS (`awsSigV4`) and Google
(`googleIdToken`). Once, in the tenant:

1. **The backend's app registration**, whose client id is the audience the
   gateway's tokens carry. Version 2 tokens, so their issuer is the one
   `entraAuth` checks:

   ```bash
   APP=$(az ad app create --display-name greetings-api --query appId -o tsv)
   az ad app update --id "$APP" --identifier-uris "api://$APP" --set api.requestedAccessTokenVersion=2
   az ad sp create --id "$APP"
   ```

2. **The gateway's identity**: a user-assigned managed identity with a
   federated credential for the cluster's issuer (Azure from another
   cluster, above), the subject `system:serviceaccount:azure:greetings-api`
   (the API's ServiceAccount, which the console creates) and the audience
   `api://AzureADTokenExchange`. It needs no role: the app's
   `allowedApplications` names it.

   ```bash
   az identity create --name vennir-greetings-gateway --resource-group <group>
   az identity federated-credential create --name vennir-<install> \
     --identity-name vennir-greetings-gateway --resource-group <group> \
     --issuer <the cluster's issuer> \
     --subject system:serviceaccount:azure:greetings-api \
     --audiences api://AzureADTokenExchange
   ```

Then:

3. **The image**, in a registry the app can pull without a password: a
   public one, or an Azure Container Registry with `registryServer` and
   `registryIdentity` added to the template's `app` step:
   `docker buildx build --platform linux/amd64 -t <registry>/greetings:1 --push examples/greetings-api`.
4. **The gateway on the internet**: the backend fetches the gateway's
   public keys from `https://<its public host>/.vennir/jwks.json`, which
   only the internet listener serves (the gateway guide, Putting it on the
   internet), and an admin allows `*.<region>.azurecontainerapps.io` in
   `gateway.backendHosts`.
5. **Run the template** with the image, that keys URL, the tenant, the app
   registration's client id and the gateway identity's, then read the `app`
   step's `url`.
6. **Publish the API**: put that URL in `api.yaml`'s `backend.url` and
   `openapi.yaml`'s `servers`, the ids in its `entraToken` (`clientId`, the
   gateway's identity; `scope`, `api://<the app registration's client id>/.default`),
   and open a pull request.

The app's URL isn't known until Container Apps make it, so the template
sets `AUDIENCE_FROM_HOST=true`: the audience the backend checks is the
request's own origin, which their ingress, routing each app by its host,
makes sound. For the seconds between the app being made and its
authentication being turned on, the backend's own check of `Vennir-Caller`
still refuses anything that didn't come through the gateway. Take the API
out of the catalog before deleting the app.

Built 2026-11-09 and tested with the Azure clients and Entra mocked; not
yet tried against Azure.

## Secrets

[secret-stores/secretstore.yaml](secret-stores/secretstore.yaml) syncs this
team's secrets from Azure Key Vault through External Secrets Operator,
signing in as `eso-azure`. ESO requests its token itself, so it doesn't need
the Pod label above.
