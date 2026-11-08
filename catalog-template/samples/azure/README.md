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
first two.

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

On a cluster that isn't AKS, the other way is OIDC federation from the
step's own token: `tokenAudiences: [api://AzureADTokenExchange]` in the
product.yaml, a federated credential trusting the cluster's issuer for
that ServiceAccount, and `AZURE_FEDERATED_TOKEN_FILE` pointed at
`/platform/tokens/api___AzureADTokenExchange` (with `AZURE_CLIENT_ID` and
`AZURE_TENANT_ID`), as the catalog's README describes. These samples don't
declare it, and that way hasn't been tried against Azure yet.

Grant each product's identity only what it needs, on the narrowest scope:

| Product | Role |
|---|---|
| `resource-group` | A custom role with `Microsoft.Resources/subscriptions/resourceGroups/read` and `/write`, on the subscription |
| `container-app` | `Contributor` on the resource group (or a custom role over `Microsoft.App/*`), plus `AcrPull` for the app's pull identity on a private registry |
| `postgres-flexible` | A custom role over `Microsoft.DBforPostgreSQL/flexibleServers/*`, on the resource group |

## Secrets

[secret-stores/secretstore.yaml](secret-stores/secretstore.yaml) syncs this
team's secrets from Azure Key Vault through External Secrets Operator,
signing in as `eso-azure`. ESO requests its token itself, so it doesn't need
the Pod label above.
