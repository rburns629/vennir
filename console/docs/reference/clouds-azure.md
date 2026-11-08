# Getting Azure ready for Vennir

What only the Azure portal can do, before `vennir init`. `init` checks the
rest itself (who you're signed in as, the subscription, a Free Trial's
limits, your roles, the region) and links back here when something needs
fixing.

## A subscription

You need an **Azure subscription**: create one at
<https://azure.microsoft.com/free/> (a Free Trial: a month's credit) or
<https://portal.azure.com/> → **Subscriptions** → **Add** (pay as you go).
Vennir creates everything in one resource group of its own (`vennir` by
default), plus the node resource group AKS makes for the cluster.

- **A Free Trial works, within its limits:** about 4 vCPUs a region and no
  Spot VMs. `init` notices one and runs steps on regular VMs
  (`azure.onDemandSteps`); the `minimal` size (one 2-vCPU node for the
  platform, 2-vCPU nodes for steps) fits, one step node at a time. When the
  credit runs out the subscription stops, and so does the install.
- **A dedicated subscription is safest:** an install's identities get roles
  only on what it makes, but a subscription of its own keeps its bill apart.

## Your roles

`apply` grants the install's identities their roles (read the registry,
write the backups) and makes you the cluster's administrator, so you need
**Owner** on the subscription, or **Contributor** with **User Access
Administrator**. Whoever created the subscription is its Owner. To grant
someone else: **Subscriptions** → the subscription → **Access control
(IAM)** → **Add role assignment**.

## A budget

**Cost Management** → **Budgets** → **Add**: a monthly budget with an alert to
your email. A Free Trial's spending limit already stops the subscription at
its credit.

## Sign in

Install the Azure CLI (`brew install azure-cli`, or
<https://learn.microsoft.com/cli/azure/install-azure-cli>), then:

```
az login
az account list --output table
```

`vennir init` asks which subscription to use, and OpenTofu signs in as you
the same way. `vennir tools --install` downloads `kubelogin`, which kubectl
uses to sign in to the cluster through Microsoft Entra: the cluster has no
local accounts, so no cluster password exists.
