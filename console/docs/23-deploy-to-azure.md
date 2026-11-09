# Deploy to Azure from Vennir

This guide gets a team's products creating real resources in Azure: resource groups, Container Apps, PostgreSQL flexible servers. It's for the team that owns the products and whoever can create managed identities and assign roles in the subscriptions they'll change. It follows the catalog's `samples/azure` products, proven on AKS and from GKE; your own products work the same way.

No keys or client secrets are made or stored. Each product runs as a Kubernetes ServiceAccount of its own (`serviceAccount` in its `product.yaml`), and each ServiceAccount is trusted by a user-assigned managed identity of its own, through a federated credential: Microsoft Entra accepts the step's own short-lived token for that ServiceAccount, and nothing else, as that identity. You assign the identity roles, and only that product's image can run as its ServiceAccount. This works the same from AKS, GKE, EKS or any cluster whose token issuer Entra can reach.

## Before you start

- **An install** on AKS (`vennir init --target azure`), or on GKE, EKS or an existing cluster whose token issuer is public. kind's isn't: [On kind](#on-kind).
- **Your team**, in the catalog and the console ([Onboarding](17-onboarding.md#phase-5-bring-in-a-team)). Below it's `web`.
- **The Azure CLI**, signed in (`az login`) as someone who may create managed identities and assign roles where the products will work: **Owner**, or **Contributor** with **User Access Administrator**, on the resource groups or subscription. Custom roles need that on the subscription.
- **Where resources go**: a subscription, and the resource groups in it the products create into. Keep the identities in a resource group of their own, apart from what the products make, so deleting a product's work never deletes its identity.

Set these once in your shell:

```bash
SUB=$(az account show --query id -o tsv)          # the subscription resources go in
TENANT=$(az account show --query tenantId -o tsv)
TEAM=web                                           # your team: its namespace
IDS=vennir-identities                              # a resource group for the products' identities
LOCATION=centralus
ISSUER=...                                         # the install's cluster token issuer (step 3)
az group create -n $IDS -l $LOCATION
```

## 1. Copy the products into your team

On a branch of the catalog repository:

1. Copy the products you want from `samples/azure/products/` to `teams/web/products/`.
2. In each `product.yaml`, change `team: azure` to `team: web`, set `owner`, and give `serviceAccount` a name of your own (say `web-resource-group`). Any name works except one ending in `-api`.
3. In `teams/web/team.yaml`, set `clouds`. A product that only calls Azure can run on any install whose cluster Entra trusts, so the samples say `clouds: [azure, gcp, aws, existing]`; narrow it to the installs you've set up.
4. **Off AKS**, uncomment the identity's `secretRefs` line on every action in each `product.yaml` (step 4).
5. Open a pull request. After merge, every install registers the products, and the console creates each one's ServiceAccount in the `web` namespace.

## 2. A managed identity for each product

One user-assigned managed identity per product, so one product's roles never become another's:

```bash
for P in resource-group container-app postgres-flexible; do
  az identity create -n web-$P -g $IDS -l $LOCATION
done
principal() { az identity show -n "web-$1" -g $IDS --query principalId -o tsv; }   # for role assignments
client()    { az identity show -n "web-$1" -g $IDS --query clientId -o tsv; }      # for the step to sign in as
```

## 3. Trust the cluster's tokens for each identity

A federated credential tells Entra: a token from this issuer, for exactly this Kubernetes ServiceAccount, with the audience `api://AzureADTokenExchange`, may sign in as this identity.

```bash
for P in resource-group container-app postgres-flexible; do
  az identity federated-credential create --name vennir-<install> \
    --identity-name web-$P -g $IDS \
    --issuer "$ISSUER" \
    --subject "system:serviceaccount:${TEAM}:web-${P}" \
    --audiences api://AzureADTokenExchange
done
```

The issuer is the install's own cluster's, read from that cluster:

| Install on | Its issuer |
| --- | --- |
| AKS | `az aks show -g <group> -n <cluster> --query oidcIssuerProfile.issuerUrl -o tsv` (`vennir` turns it on) |
| GKE | `https://container.googleapis.com/v1/projects/<project>/locations/<location>/clusters/<cluster>` |
| EKS, or any other | `kubectl --context <the install's> get --raw /.well-known/openid-configuration \| jq -r .issuer` |

One credential per install that runs the product: another install's cluster is another issuer. An identity takes at most 20.

## 4. Tell each step which identity it is

**On AKS**, Workload Identity's webhook hands the step its token and the identity's client id. The install already labels every step's Pod for it (`azure.workload.identity/use: "true"`, the kernel chart's `scheduler.taskPodLabels`); an admin annotates each product's ServiceAccount with its identity, since the console never changes a product's ServiceAccount:

```bash
kubectl -n $TEAM annotate serviceaccount web-resource-group azure.workload.identity/client-id=$(client resource-group)
```

**Off AKS**, each product's `product.yaml` declares `tokenAudiences: [api://AzureADTokenExchange]`, so each of its steps gets an hour-long token for its own ServiceAccount at `/platform/tokens/api___AzureADTokenExchange`. A team secret named after the ServiceAccount with `-identity` says which identity to be, with the keys `client-id` and `tenant-id`. Neither is a credential; a maintainer adds each on the team's page → **Secrets → Add a secret**, or with `SecretService/PutSecret`:

| Secret | `client-id` | `tenant-id` |
| --- | --- | --- |
| `web-resource-group-identity` | `$(client resource-group)` | `$TENANT` |
| `web-container-app-identity` | `$(client container-app)` | `$TENANT` |
| `web-postgres-flexible-identity` | `$(client postgres-flexible)` | `$TENANT` |

Each action must list its secret (`secretRefs: [{name: web-resource-group-identity, keys: [client-id, tenant-id]}]`): a template's steps, a run from the **Catalog** and **Delete** get only what their action lists, never the caller's. Another product of the team mounting the same secret can't use it, since the identity's federated credential names one ServiceAccount.

On AKS the webhook's settings win and the secret changes nothing, so one catalog serves both.

## 5. Grant each product only what it does

Azure grants roles on a scope: a management group, a subscription, a resource group, or one resource. Grant on the narrowest that works.

| Product | Role | On |
| --- | --- | --- |
| `resource-group` | A custom role with `Microsoft.Resources/subscriptions/resourceGroups/read` and `/write` | The subscription: a group is made in it |
| `container-app` | `Contributor`, or a custom role over `Microsoft.App/*` | The resource group it deploys into |
| `container-app`, with a private registry | `Managed Identity Operator` | The app's pull identity alone (step 6) |
| `postgres-flexible` | A custom role over `Microsoft.DBforPostgreSQL/flexibleServers/*` | The resource group |

```bash
cat > rg-role.json <<EOF
{"Name": "Vennir resource groups", "Description": "Read and create resource groups.",
 "Actions": ["Microsoft.Resources/subscriptions/resourceGroups/read", "Microsoft.Resources/subscriptions/resourceGroups/write"],
 "AssignableScopes": ["/subscriptions/$SUB"]}
EOF
az role definition create --role-definition @rg-role.json
az role assignment create --assignee-object-id $(principal resource-group) --assignee-principal-type ServicePrincipal \
  --role "Vennir resource groups" --scope /subscriptions/$SUB

cat > pg-role.json <<EOF
{"Name": "Vennir PostgreSQL flexible servers", "Description": "PostgreSQL flexible servers, on the groups it's assigned on.",
 "Actions": ["Microsoft.DBforPostgreSQL/flexibleServers/*"], "AssignableScopes": ["/subscriptions/$SUB"]}
EOF
az role definition create --role-definition @pg-role.json

GROUP=/subscriptions/$SUB/resourceGroups/web-apps
az role assignment create --assignee-object-id $(principal container-app) --assignee-principal-type ServicePrincipal \
  --role Contributor --scope $GROUP
az role assignment create --assignee-object-id $(principal postgres-flexible) --assignee-principal-type ServicePrincipal \
  --role "Vennir PostgreSQL flexible servers" --scope $GROUP
```

**A role on a group the run makes** can't be assigned before the group exists. When a template's first step is `resource-group`, make the group first (run `resource-group` alone, or `az group create`), assign the other products' roles on it, then run the template: its `resource-group` step finds the group and goes on.

Never federate an identity with `default` in a team namespace: every image that isn't a registered product runs as it.

## 6. Pulling images from a private registry

A Container App pulls its image as a managed identity the app is given. Make one for pulling, let it pull from the registry, and let `container-app` give it to apps:

```bash
az identity create -n web-pull -g $IDS -l $LOCATION
PULL=$(az identity show -n web-pull -g $IDS --query id -o tsv)
az role assignment create --assignee-object-id $(az identity show -n web-pull -g $IDS --query principalId -o tsv) \
  --assignee-principal-type ServicePrincipal --role AcrPull --scope $(az acr show -n <registry> --query id -o tsv)
az role assignment create --assignee-object-id $(principal container-app) --assignee-principal-type ServicePrincipal \
  --role "Managed Identity Operator" --scope $PULL
```

Run `container-app` with `registryServer: <registry>.azurecr.io` and `registryIdentity: $PULL`. `registryIdentity: system`, the app's own identity, exists only once the app does, so its first pull fails until it's granted `AcrPull`.

## 7. Run it

From the **Catalog**, run a product's `create` action, or a template that chains several. `samples/azure/dags/azure-hello-world-dag.yaml` makes a resource group and a Container App in it.

- **Timeouts.** A step has five minutes unless its DAG says otherwise. A new Container Apps environment takes a few minutes (`timeoutSeconds: 1200`), and a PostgreSQL server more (1500 or more).
- **Retries are safe.** Each `create` looks before it creates, and Azure's transient failures (`InternalServerError`, `ServiceUnavailable` and the like, even when a long-running operation reports them) are retryable, so the step is tried again and finds what the first attempt made.
- **Other teams.** Their target inputs must match your `team.yaml`'s `allowedTargets`, as for every product.
- **Through the API.** A template's parameter defaults are filled in only by the console's form for now: give every parameter in a `RunTemplate` call.

## 8. Find and delete what it made

The samples tag what they make `managed-by: vennir`, and have no `delete` action yet: delete what they made in Azure (a resource group takes everything in it with it). A product of your own should label what it makes with `vennir-made` and `vennir-team` and have a `cleanup` action, as the GCP and AWS samples do.

## Synced secrets from Key Vault

The team's secrets can be kept in Azure Key Vault and synced into its namespace by External Secrets Operator, which signs in as the ServiceAccount `eso-azure` in the team's namespace, the same way: a managed identity with a federated credential for `system:serviceaccount:web:eso-azure`, and **Key Vault Secrets User** on the vault (with RBAC authorization). The team proposes its SecretStore in the catalog (`teams/web/secret-stores/`, the azure sample's file with the identity's client id, the tenant and the vault's URL); the console applies it, and from then on **Secrets → Add a secret** offers **Sync from …** the vault (or `SecretService/SyncSecret`): a maintainer gives the secret's name in the vault instead of pasting a value. ESO asks for the token itself, so the same file works on AKS and off it.

## APIs on Azure

A backend that checks Microsoft Entra tokens, such as a Container App behind its built-in authentication (`container-app`'s `entraAuth`), can be published through the gateway with `backend.auth.entraToken`: the gateway signs in as a managed identity of its own, by federation, with nothing stored. [A Container App, or anything that checks Entra tokens](21-api-gateway.md#a-container-app-or-anything-that-checks-entra-tokens-entratoken).

## Another subscription or tenant

Another subscription in the same tenant needs nothing new: assign the product's identity its roles there. A managed identity can't sign in to another tenant; that would take a multi-tenant app registration with its own federated credential, which no sample does.

## Writing your own Azure product

Start from the closest sample and keep what makes it safe:

- **An identity of its own**, with only the roles its actions use. The samples' `_credential()` picks the AKS webhook's settings when they're there (`DefaultAzureCredential`), and otherwise signs in as the identity its team secret names, with the step's token (`WorkloadIdentityCredential`). Declare `tokenAudiences: [api://AzureADTokenExchange]`.
- **Say what's missing**: the samples fail as `NO_IDENTITY` (no webhook and no secret), `NO_TOKEN` (a secret but no token) or `AZURE_AUTH_FAILED` (Entra refused the token).
- **Look before you create**, and treat transient errors as retryable.
- **Never return a credential** in `result.json`.

Every field is in [the catalog guide](catalog-guide.md#productyaml).

## On kind

Entra can't fetch the keys of kind's token issuer, so there's no keyless way in. Use kind for products that call no cloud.

## What's been proven

- **On AKS** (2026-11-08, a Free Trial): `resource-group` then `container-app` by Workload Identity, and the app served.
- **From GKE Autopilot** (2026-11-09, the 0.15.0 release, no Azure cluster): all three products, each as its own identity with its step's token: a resource group, a Container App pulled from a private registry behind Entra authentication, and a PostgreSQL server with Entra sign-in only. ESO synced a Key Vault secret, and the gateway served an API on the Container App to the internet with `entraToken`.

## Troubleshooting

| You see | Why | Fix |
| --- | --- | --- |
| `NO_IDENTITY` | Off AKS, the step has no identity secret: the action's `secretRefs` line is still commented, or the secret isn't registered | Step 4 |
| `NO_TOKEN` | The secret is mounted but the step got no token: a release without the product's `tokenAudiences` | Add them and release |
| `AZURE_AUTH_FAILED` | Entra refused the token: no federated credential for that issuer and subject, or it can't fetch the issuer's keys | Step 3, with the install's own issuer and the product's ServiceAccount |
| `AuthorizationFailed` naming an action | The identity lacks a role on that scope | Step 5, on the scope the error names |
| A role can't be assigned on a group | The group doesn't exist yet | Make it first ([Grant each product only what it does](#5-grant-each-product-only-what-it-does)) |
| "Subscriptions are restricted from provisioning in this region" | PostgreSQL flexible servers aren't allowed there for this subscription (seen on a Free Trial in eastus2, eastus, westus2, southcentralus) | Another region; `az rest` on `Microsoft.DBforPostgreSQL/locations/<region>/capabilities` says which allow it |
| A Container Apps environment can't be made | The subscription's quota of environments in that region is used (a Free Trial had one, in eastus2) | Use the one there, or another region |
| The app's image can't be pulled | The pull identity lacks `AcrPull`, or `container-app` lacks `Managed Identity Operator` on it | Step 6 |
| `az ad app update --set api.requestedAccessTokenVersion=2` fails | `az` can't set it | Microsoft Graph: [the gateway guide](21-api-gateway.md#a-container-app-or-anything-that-checks-entra-tokens-entratoken) |
| A target refuses connections from the cluster | It allows only known addresses | [Addresses and firewall rules](22-addresses-and-firewalls.md) |
