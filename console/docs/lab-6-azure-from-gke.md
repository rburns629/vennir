# Lab 6: Azure from a GKE install

**Goal:** let products on your GKE install create Azure resources (a resource group, a Container App, a PostgreSQL server) with no Azure cluster and no key, and sync a secret from Azure Key Vault: each product signs in as a managed identity of its own with its step's own token. **Time:** about an hour and a half. **Cost:** billed, under a dollar or two for an afternoon: the PostgreSQL server (about $0.02 an hour, deleted at the end of step 7), a Container App on the consumption plan, a Key Vault. **You need:** [Lab 3](lab-3-gke.md)'s install; an Azure subscription with the CLI signed in as its **Owner** ([Getting Azure ready](clouds-azure.md)). A Free Trial works.

The reasons behind each step are in [Deploy to Azure](23-deploy-to-azure.md) and [Creating resources in every cloud](24-every-cloud-from-any-install.md#azure). Proven exactly this way on 2026-11-09, from the 0.15.0 release.

## 1. Put the products in a team

In your catalog repository: `cp -R samples/azure teams/azure`, and remove `teams/azure/apis` (Lab 7 adds it back). In each `product.yaml`, uncomment the `secretRefs` line naming `<serviceAccount>-identity`. Don't merge yet: step 5 fills in the team's SecretStore first.

## 2. A managed identity per product, trusting the cluster

```bash
SUB=$(az account show --query id -o tsv); TENANT=$(az account show --query tenantId -o tsv)
ISSUER=https://container.googleapis.com/v1/projects/<project>/locations/us-east1/clusters/vennir-lab
az group create -n vennir-lab-identities -l centralus
for ID in azure-resource-group azure-container-app azure-postgres-flexible eso-azure; do
  az identity create -n $ID -g vennir-lab-identities -l centralus
  az identity federated-credential create --name vennir-lab --identity-name $ID -g vennir-lab-identities \
    --issuer "$ISSUER" --subject "system:serviceaccount:azure:${ID}" --audiences api://AzureADTokenExchange
done
principal() { az identity show -n "$1" -g vennir-lab-identities --query principalId -o tsv; }
client()    { az identity show -n "$1" -g vennir-lab-identities --query clientId -o tsv; }
```

Each identity trusts tokens this cluster signs for exactly one ServiceAccount in the `azure` team's namespace (the products' are named after them; `eso-azure` is External Secrets Operator's).

## 3. What `resource-group` may do

A custom role, read and create resource groups, on the subscription:

```bash
az role definition create --role-definition "{\"Name\": \"Vennir lab resource groups\", \"Actions\": [\"Microsoft.Resources/subscriptions/resourceGroups/read\", \"Microsoft.Resources/subscriptions/resourceGroups/write\"], \"AssignableScopes\": [\"/subscriptions/${SUB}\"]}"
az role assignment create --assignee-object-id $(principal azure-resource-group) --assignee-principal-type ServicePrincipal \
  --role "Vennir lab resource groups" --scope /subscriptions/$SUB
```

The other two products get their roles on the group the run makes, once it exists (step 5).

## 4. A Key Vault, with one secret

```bash
KV=vennir-lab-$(openssl rand -hex 3)
az keyvault create -n $KV -g vennir-lab-identities -l centralus --enable-rbac-authorization true
KVID=$(az keyvault show -n $KV --query id -o tsv)
az role assignment create --assignee-object-id $(principal eso-azure) --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope $KVID
az role assignment create --assignee-object-id $(az ad signed-in-user show --query id -o tsv) --assignee-principal-type User --role "Key Vault Secrets Officer" --scope $KVID
az keyvault secret set --vault-name $KV -n greeting-word --value Howdy     # retry in a minute if the role isn't in effect yet
```

## 5. Merge, and tell each step which identity it is

In `teams/azure/secret-stores/secretstore.yaml`, set the client id annotation to `$(client eso-azure)`, the tenant to `$TENANT`, and `vaultUrl` to `https://<KV>.vault.azure.net`. Add `/teams/azure/ @<you>` to `.github/CODEOWNERS`, open the pull request, merge it once CI passes, and add yourself to `azure` in the console.

Then, as a maintainer of `azure`, **Teams → azure → Secrets → Add a secret → Paste it here**, three times:

| Secret | `client-id` | `tenant-id` |
| --- | --- | --- |
| `azure-resource-group-identity` | `$(client azure-resource-group)` | `$TENANT` |
| `azure-container-app-identity` | `$(client azure-container-app)` | `$TENANT` |
| `azure-postgres-flexible-identity` | `$(client azure-postgres-flexible)` | `$TENANT` |

Neither key is a credential: they name an identity, which only that product's ServiceAccount on this cluster can sign in as.

## 6. Sync the Key Vault secret

**Teams → azure → Secrets**: the store `azure-key-vault` shows ready. **Add a secret** → **Sync from …** the vault: name `greeting`, key `word`, from the vault's `greeting-word`.

**Check:** within a minute the secret exists in the `azure` namespace (`kubectl -n azure get externalsecret greeting` says `SecretSynced`), read by ESO as `eso-azure`, with nothing stored to sign in with.

## 7. A resource group, an app, a database

1. **Catalog → resource-group.create → Run**, for `azure`: your subscription, `name: lab`, `location: centralus`. **Check:** `az group show -n lab`.
2. Now that the group exists, give the other two their roles on it (a role just defined can take a minute before it can be assigned):

   ```bash
   az role assignment create --assignee-object-id $(principal azure-container-app) --assignee-principal-type ServicePrincipal \
     --role Contributor --scope /subscriptions/$SUB/resourceGroups/lab
   az role definition create --role-definition "{\"Name\": \"Vennir lab PostgreSQL\", \"Actions\": [\"Microsoft.DBforPostgreSQL/flexibleServers/*\"], \"AssignableScopes\": [\"/subscriptions/${SUB}\"]}"
   az role assignment create --assignee-object-id $(principal azure-postgres-flexible) --assignee-principal-type ServicePrincipal \
     --role "Vennir lab PostgreSQL" --scope /subscriptions/$SUB/resourceGroups/lab
   ```

3. **Catalog → container-app.create → Run**, for `azure`: the subscription, `resourceGroup: lab`, `location: centralus`, `environmentName: lab-env`, `appName: hello`, `image: mcr.microsoft.com/k8se/quickstart:latest`, `port: 80`, `public: true`. A new environment takes a few minutes. **Check:** the step outputs a `url` that answers in a browser.
4. **Catalog → postgres-flexible.create → Run**, for `azure`: the subscription, `resourceGroup: lab`, `serverName: vennir-lab-<something unique>`, `location: centralus`, `adminObjectId` your own (`az ad signed-in-user show --query id -o tsv`), `adminName` your sign-in name, `adminType: User`. **Check:** the server is Ready with password sign-in off. If it fails with Azure's `InternalServerError` while adding the admin, that's a passing failure: run it again, and it finds the server and adds the admin (samples after 0.15.0 retry it on their own). Then delete it: `az postgres flexible-server delete -g lab -n <server> --yes`.

A Free Trial can't create PostgreSQL servers in some regions (eastus2 among them), which is why this lab uses centralus.

## Clean up

```bash
az group delete -n lab --yes
az group delete -n vennir-lab-identities --yes
az keyvault purge -n $KV
# the custom roles, after their assignments (if az crashes deleting an assignment, delete it with az rest)
for R in "Vennir lab resource groups" "Vennir lab PostgreSQL"; do
  az role assignment list --role "$R" --all --query '[].id' -o tsv | xargs -n1 -I{} az role assignment delete --ids {}
  az role definition delete --name "$R"
done
```

## What you proved

Products on GKE acting in Azure, each as a managed identity of its own, by federation with their own tokens; roles on the narrowest scope, granted once the group exists; and ESO reading a Key Vault the same way.

**Next:** [Lab 7: APIs on every cloud, through the gateway](lab-7-apis-across-clouds.md).
