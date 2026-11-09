# Creating resources in every cloud

Vennir's products create resources in Google Cloud, AWS and Azure, whichever cloud Vennir itself runs in. An install on GKE can create Google Cloud projects, AWS buckets and Azure Container Apps, each product signing in as an identity of its own, with no key stored anywhere. This page is the map, for whoever sets the clouds up: platform admins, and the admins of the organizations, accounts and subscriptions products will change. The step-by-step commands are in [Deploy to Google Cloud](19-deploy-to-gcp.md), [Deploy to AWS](20-deploy-to-aws.md) and [Deploy to Azure](23-deploy-to-azure.md).

## The model, the same in every cloud

- **A product is an identity.** Each product declares a Kubernetes ServiceAccount (`serviceAccount` in its `product.yaml`), which the console creates in its team's namespace. An admission policy lets only that product's reviewed image run as it; anything else runs as `default`, which is granted nothing.
- **That identity is trusted by the cloud, never handed a key.** The cluster signs short-lived tokens for the ServiceAccount, and the cloud trusts the cluster's token issuer for exactly that ServiceAccount: a Google principal, an AWS role, an Azure managed identity. A product that declares `tokenAudiences` gets a token per audience at `/platform/tokens/<audience>`, an hour long.
- **Grants are per product.** Each product's cloud identity gets only what its actions call, on the narrowest scope that works. One product's permissions never become another's.
- **Team secrets name identities, never hold credentials.** A role's ARN or a managed identity's client id says which identity a step signs in as; the cloud only lets that one ServiceAccount use it.
- **Trust is per install.** Each cluster is its own token issuer, so another install, even of the same catalog, needs its own trust and grants.

## Who does what

| Who | Does | Needs |
| --- | --- | --- |
| **Platform admin** | Installs Vennir (`vennir init`, `vennir apply`) in the host cloud, puts the gateway on the internet when backends must reach it | The host account's roles ([Get Google Cloud ready](clouds-gcp.md), [AWS](clouds-aws.md), [Azure](clouds-azure.md)) |
| **Catalog reviewers** | Approve each product's `product.yaml`: its `serviceAccount`, `tokenAudiences`, `secretRefs` and `clouds` | Owners of the team's folder in the catalog |
| **Cloud admins of each target** | Once per install: trust the cluster's issuer. Per product: its identity and its grants | Google Cloud: IAM admin on the folders, projects and billing account products use. AWS: IAM in each account. Azure: Owner, or User Access Administrator, on the subscriptions or resource groups |
| **Team maintainers** | Register the team secrets that name identities and settings (role ARNs, identity ids, the registry and runtime roles a product may use) | Maintainer of the team |
| **Team members** | Run the products, from the Catalog, templates or the API | Member of the team |

## Which way in, by where Vennir runs

| Target ↓ / install on → | GKE | EKS | AKS | Another cluster with a public issuer | kind |
| --- | --- | --- | --- | --- | --- |
| **Google Cloud** | Workload Identity for GKE: the ServiceAccount is a Google principal. **Proven** | A workload identity pool trusting EKS's issuer. **Not built in the samples yet** | The same, trusting AKS's issuer. **Not built yet** | The same | No keyless way |
| **AWS** | An IAM OIDC provider for GKE's issuer, a role per product. **Proven** (2026-11-07, 2026-11-09) | EKS Pod Identity, or IRSA. **Proven** | An IAM OIDC provider for AKS's issuer. **Not run yet** | The same | No keyless way |
| **Azure** | A federated credential per product, trusting GKE's issuer. **Proven** (2026-11-09) | The same, trusting EKS's issuer. **Not run yet** | Workload Identity's webhook, with the same federated credentials. **Proven** (2026-11-08) | The same | No keyless way |

A product says which installs it's for (`clouds`); one that calls only Azure, say, can list every install whose cluster Azure trusts.

## How each cloud's permissions are structured

### Google Cloud

**Organization → folders → projects → resources.** A grant on a folder applies to every project under it, including the ones made later.

- **The identity**: on GKE, `principal://iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<project>.svc.id.goog/subject/ns/<team>/sa/<serviceAccount>`, one product in one team on one cluster.
- **Creating projects** (the `project` sample) needs no organization-wide role. The organization's admin makes a folder for the projects Vennir creates (a folder per environment, or per team, keeps them apart), and on it grants the product `roles/browser`, `roles/resourcemanager.projectCreator` and `roles/resourcemanager.projectDeleter`; the billing account's admin grants `roles/billing.user` on the account new projects are linked to. Granting those takes **Folder IAM Admin** (or Folder Admin) on the folder and **Billing Account Administrator** on the billing account; making the folder takes **Folder Creator** on the organization.
- **Resources in the projects it creates**: the products that build and deploy there need their roles in each new project. Grant them on the folder instead, once, and every project made under it inherits them (`roles/run.developer` for `app-hosting`, and so on). A new project starts with only Google's default APIs on; the samples don't turn more on, so turn on what later steps call before chaining them into a project made in the same run.
- **Resources in existing projects**: roles on the project, or narrower (one bucket, one repository).
- **What deployed services run as**: a Google service account the team chose, with only what the service needs, that the deploying product may act as (`roles/iam.serviceAccountUser` on it alone).
- **Organization policies** can refuse a grant or a resource; the error names the constraint, and the organization's admins decide.

### AWS

**Organization → organizational units → accounts → resources.**

- **The identity**: an IAM role per product. On EKS, Pod Identity binds it to the product's ServiceAccount; from any other cluster, the role trusts an IAM OIDC provider for the cluster's issuer, for exactly `system:serviceaccount:<team>:<serviceAccount>`, audience `sts.amazonaws.com`, and the team secret `<serviceAccount>-role` names it.
- **Grants**: an inline policy per role, with only its product's actions, on resources it may touch (a bucket name prefix, `service/default/*`). Roles a product hands to AWS services (ECS's execution and infrastructure roles) are passed with `iam:PassRole` on those roles alone.
- **Other accounts**: a role in the target account trusting the product's role (`aws-target`), which then needs only `sts:AssumeRole` on it.
- **Creating accounts** isn't something a sample does; account vending (AWS Organizations, Control Tower) stays outside Vennir for now.

### Azure

**Tenant → management groups → subscriptions → resource groups → resources.** A role on a scope applies to everything under it.

- **The identity**: a user-assigned managed identity per product, with a federated credential trusting the cluster's issuer for exactly `system:serviceaccount:<team>:<serviceAccount>`, audience `api://AzureADTokenExchange`. On AKS the webhook hands it to the step; elsewhere the team secret `<serviceAccount>-identity` names it. Keep the identities in a resource group of their own.
- **Grants**: built-in or custom roles, on the subscription only where the product makes resource groups, otherwise on the resource groups it works in. A role on a group can be assigned only once the group exists.
- **Images from a private registry**: the app's pull identity gets `AcrPull`; the deploying product gets `Managed Identity Operator` on that identity alone.
- **Other subscriptions** in the tenant: assign the roles there. Another tenant isn't reachable with a managed identity.
- **Creating subscriptions** isn't something a sample does; it takes billing-account roles, and stays outside Vennir for now.

## The setup, from a GKE install

Vennir on GKE is the usual starting point. Once per install, for each cloud its products reach:

1. **Google Cloud**: nothing to trust: GKE's Workload Identity is on. For `project`, a folder and a billing account with the grants above; for the rest, their roles on the folder or the target projects, and the APIs they call turned on ([Deploy to Google Cloud](19-deploy-to-gcp.md)).
2. **AWS**: in each account, an IAM OIDC provider for the GKE cluster's issuer (`https://container.googleapis.com/v1/projects/<project>/locations/<location>/clusters/<cluster>`); a role per product trusting it for that product's ServiceAccount; the team secrets `<serviceAccount>-role`; the products' `secretRefs` lines uncommented ([From an install that isn't on EKS](20-deploy-to-aws.md#from-an-install-that-isnt-on-eks)).
3. **Azure**: a resource group for identities; a managed identity per product with a federated credential for the same issuer; its roles; the team secrets `<serviceAccount>-identity`; the `secretRefs` lines uncommented ([Deploy to Azure](23-deploy-to-azure.md)).
4. **Synced secrets** from Key Vault or another vault: ESO's own identity in that cloud, trusted the same way.
5. **APIs** on those clouds' backends: the gateway on the internet when a backend checks the gateway's public keys, and the gateway's own identity for `awsSigV4` or `entraToken` ([the API gateway](21-api-gateway.md)).

To do it yourself step by step: Labs [3](lab-3-gke.md) to [7](lab-7-apis-across-clouds.md). Everything in this list was done from a GKE Autopilot install on 2026-11-09 with the 0.15.0 release: Azure resource groups, Container Apps and PostgreSQL, an S3 bucket and an ECS Express service, a Key Vault secret, and an API on each cloud through the gateway.

## Not covered yet

- **Google Cloud from a cluster other than GKE**: the pool and provider are described in [Deploy to Google Cloud](19-deploy-to-gcp.md#from-an-install-that-isnt-on-gke), but the GCP samples sign in only through GKE's Workload Identity.
- **AWS or Google Cloud from AKS**: the same mechanisms as from GKE, not run yet.
- **Creating AWS accounts or Azure subscriptions** from a product.
- **Cleaning up Azure**: the azure samples have no `delete` action yet.
