# Where to host Vennir

Vennir runs on any Kubernetes cluster, and `vennir` builds five kinds of install: **kind** on your laptop, **gcp** (Google Kubernetes Engine), **aws** (Amazon EKS), **azure** (AKS), or **existing**, a cluster you already have. Teams use them the same way: the console, the catalog, DAGs and the API don't change. What changes is what their products can reach without a stored key, what the install costs, and a few things the cloud provides. This page is for whoever decides, before `vennir init`.

## The short answer

| If your teams mostly… | Host on |
| --- | --- |
| Try Vennir, or write and test products | **kind**: free, ten minutes, nothing to clean up in a cloud |
| Create things in Google Cloud | **gcp**: Google Kubernetes Engine (GKE) |
| Create things in AWS | **aws**: Amazon EKS |
| Create things in Azure | **azure**: AKS, the newest target (below) |
| Create things in more than one | The cloud where most of the work is; the others through federation ([Creating resources in every cloud](24-every-cloud-from-any-install.md)) |
| Run on a platform cluster you already operate | **existing** |

One catalog can serve several installs ([reading another install's catalog](operations.md#reading-another-installs-catalog)): a team's products are reviewed and published once, and each install applies the same release. A product can say which installs it's for (`clouds` in its `product.yaml` or `team.yaml`), so a GCP product is listed on an AWS install but never run there (`NOT_FOR_THIS_INSTALL`).

## What each one gives you

| | kind | gcp | aws | azure | existing |
| --- | --- | --- | --- | --- | --- |
| **Cost** | Free | GKE, a small database and storage: `apply` prices it before you approve | EKS, nodes and storage: priced the same way | AKS, nodes and storage: priced from Azure's retail prices | Your cluster's |
| **Cluster** | One local node | GKE Autopilot, or Standard with node pools `vennir` sizes | EKS Auto Mode, or Standard with node groups | AKS Standard: a system node pool and a steps pool (Spot, or regular VMs on a subscription without Spot) | Kubernetes 1.30 or later, with a network plugin that enforces NetworkPolicy |
| **The console** | http://localhost:18080 | Private (`vennir console`), or public over HTTPS: a reserved address and Google's certificate, on a `nip.io` name or yours | Private, or public over HTTPS: an Application Load Balancer, ACM's certificate, a Route 53 zone you delegate | Private (`vennir console`); public not yet | Private, or your Ingress with cert-manager's certificate |
| **Databases** | Postgres in the cluster | In the cluster (backed up to a bucket), or Cloud SQL with IAM sign-in | In the cluster (backed up to a bucket), or RDS with IAM sign-in | In the cluster (backed up to Azure Storage); a managed server not yet | In the cluster |
| **Products reach their own cloud** | No keyless way: kind's token issuer isn't public | Google Cloud, keyless: each product's ServiceAccount is a principal Google trusts (Workload Identity) | AWS, keyless: each product's ServiceAccount gets its own role (EKS Pod Identity, or IRSA) | Azure, keyless: each product's ServiceAccount is trusted by a managed identity of its own (Workload Identity) | Whatever the cluster's own identity setup provides |
| **Products reach another cloud** | No keyless way | AWS: the product's token, trusted by an IAM OIDC provider for GKE's issuer ([AWS from another cluster](20-deploy-to-aws.md#from-an-install-that-isnt-on-eks)). Azure: the same token, trusted by each product's managed identity ([Deploy to Azure](23-deploy-to-azure.md)) | Google Cloud: a workload identity pool trusting EKS's issuer ([Google Cloud from another cluster](19-deploy-to-gcp.md#from-an-install-that-isnt-on-gke)); no sample product does this yet. Azure: each product's managed identity trusting EKS's issuer, not run yet | AWS and Google Cloud the same ways as from GKE, trusting AKS's issuer; not run yet | Either, when its issuer is reachable from the internet |
| **Only signed images run** | No: policy-controller can't reach the local registry | Yes, when the catalog signs (Sigstore's policy-controller) | Yes, when the catalog signs | Not yet | Yes, if you install policy-controller |
| **Steps leave from** | Your machine's address | The nodes' own public addresses, which change as nodes come and go | The nodes' own public addresses, which change as nodes come and go | The nodes' own public addresses, which change as nodes come and go | Whatever the cluster's network does |
| **The API gateway** | In the cluster | In the cluster; on the internet with a values file ([the API gateway](21-api-gateway.md#putting-it-on-the-internet)) | The same | In the cluster; on the internet not yet run on AKS | The same, behind your Ingress |
| **Synced secrets** | From any vault External Secrets Operator reaches with a stored credential | Secret Manager keyless; others with a credential | Secrets Manager keyless (not yet proven); others with a credential | Key Vault keyless (proven from GKE; not yet on AKS); others with a credential | Depends on the cluster |
| **The chat agent** | A model you point it at | Gemini through Vertex AI, as the console's identity | Claude through Amazon Bedrock, as the console's role | A model you point it at | A model you point it at |
| **Monitoring** | The cluster's Prometheus Operator, or one of its own | GKE's managed Prometheus | Amazon Managed Prometheus, alerts emailed | The cluster's Prometheus Operator, or one of its own | The cluster's, or one of its own |

## What changes for a team, by host

Most of a team's work is the same everywhere: the catalog, the console, DAGs, bots, secrets. Three things depend on where the install runs.

**Who its products are in the cloud.** A product's `serviceAccount` lives in the team's namespace. On GKE, Google trusts it as the principal `…/subject/ns/<team>/sa/<serviceAccount>`; on EKS, AWS hands it the role associated with it. Grants are made per install: the same product needs its grants again on another cluster. On AKS, Azure trusts it through a managed identity of its own. Step by step: [Deploy to Google Cloud](19-deploy-to-gcp.md), [Deploy to AWS](20-deploy-to-aws.md), [Deploy to Azure](23-deploy-to-azure.md); all three together: [Creating resources in every cloud](24-every-cloud-from-any-install.md).

**Which of its products run here.** Products marked for another cloud (`clouds: [aws]` on a GCP install) are listed, marked **For aws installs**, and refused if run. Leave `clouds` out for products that call no cloud.

**What addresses a target sees.** Steps, the console and the gateway leave the cluster from the nodes' addresses, which aren't fixed on any `vennir`-made cloud install. A target that admits only known addresses needs one of the approaches in [Addresses and firewall rules](22-addresses-and-firewalls.md).

## Moving later

An install's cloud isn't changed in place. To move, make a new install where you want it (`vennir init` with the new target), point it at the same catalog, grant its products in their clouds, then move teams' runs and secrets over and `vennir destroy` the old one. The catalog, and everything in it, doesn't change.

kind is the exception worth planning for: it's for trying and developing. Data on a kind cluster lives on your laptop, and its products can't reach a cloud without a stored key, which Vennir is built to avoid.

## Where to go next

- [Onboarding, from nothing to your first deploy](17-onboarding.md): the whole path, in order.
- [Set up Vennir](setup.md): every `vennir init` question.
- [Get Google Cloud ready](clouds-gcp.md), [Get AWS ready](clouds-aws.md), [Get Azure ready](clouds-azure.md): the account, before `init`.
- [Creating resources in every cloud](24-every-cloud-from-any-install.md): who sets up what in each cloud, whichever one Vennir runs in.
