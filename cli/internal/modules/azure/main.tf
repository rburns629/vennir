# SPDX-License-Identifier: MIT

data "azurerm_client_config" "this" {}

locals {
  # The pools by size: the system pool's (the platform: the console, the
  # kernel and Postgres) and the steps' (from zero, Spot except at
  # `scaled`, or with on_demand_steps). AKS needs 2 vCPUs and 4 GiB on a
  # system node.
  pools = {
    minimal   = { platform_type = "Standard_B2ms", platform_max = 2, steps_type = "Standard_B2s", steps_max = 2, spot = true }
    resilient = { platform_type = "Standard_D2as_v5", platform_max = 3, steps_type = "Standard_D4as_v5", steps_max = 8, spot = true }
    scaled    = { platform_type = "Standard_D2as_v5", platform_max = 4, steps_type = "Standard_D4as_v5", steps_max = 30, spot = false }
    auto      = { platform_type = "Standard_D2as_v5", platform_max = 3, steps_type = "Standard_D4as_v5", steps_max = 8, spot = true }
  }[var.size]
  spot = local.pools.spot && !var.on_demand_steps
  tags = { "vennir-environment" = var.name }
  # Registry and storage account names are global and alphanumeric only:
  # the name's, and a hash of where it is, so vennir knows them before
  # apply (azurecloud.RegistryName, a registry to push to) and two installs
  # of one name don't collide.
  compact = replace(var.name, "-", "")
  where   = substr(sha1("${var.subscription}/${var.resource_group}"), 0, 8)
}

resource "azurerm_resource_group" "this" {
  name     = var.resource_group
  location = var.region
  tags     = local.tags
}

# --- the cluster -------------------------------------------------------------
# No local accounts: kubectl signs in through Microsoft Entra (kubelogin),
# and Azure RBAC decides what each may do. Workload Identity gives the
# platform's ServiceAccounts their managed identities (below); network
# policy (Cilium) enforces the charts' NetworkPolicies.

resource "azurerm_kubernetes_cluster" "this" {
  name                = var.name
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  dns_prefix          = var.name
  sku_tier            = "Free"
  tags                = local.tags

  oidc_issuer_enabled               = true
  workload_identity_enabled         = true
  local_account_disabled            = true
  role_based_access_control_enabled = true
  azure_active_directory_role_based_access_control {
    tenant_id          = data.azurerm_client_config.this.tenant_id
    azure_rbac_enabled = true
  }
  automatic_upgrade_channel = "patch"
  node_os_upgrade_channel   = "NodeImage"
  # Its own node pools, below; node autoprovisioning (mode Auto) would be
  # the way to an auto mode.
  node_provisioning_profile {
    mode = "Manual"
  }

  default_node_pool {
    name                        = "system"
    vm_size                     = local.pools.platform_type
    auto_scaling_enabled        = true
    min_count                   = 1
    max_count                   = local.pools.platform_max
    os_disk_size_gb             = 64
    temporary_name_for_rotation = "systemtmp"
    tags                        = local.tags
    upgrade_settings {
      max_surge = "10%"
    }
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_policy      = "cilium"
    network_data_plane  = "cilium"
  }
}

# Steps run here (the chart's scheduler.taskPlacement selects and tolerates
# it): scaled from zero, so it costs nothing while nothing runs.
resource "azurerm_kubernetes_cluster_node_pool" "steps" {
  name                  = "steps"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = local.pools.steps_type
  mode                  = "User"
  auto_scaling_enabled  = true
  min_count             = var.step_headroom > 0 ? 1 : 0
  max_count             = local.pools.steps_max
  os_disk_size_gb       = 64
  priority              = local.spot ? "Spot" : "Regular"
  eviction_policy       = local.spot ? "Delete" : null
  # Spot's price, up to the regular one: never more than on-demand.
  spot_max_price = local.spot ? -1 : null
  node_labels    = { "vennir.dev/pool" = "steps" }
  # AKS adds Spot's own taint (kubernetes.azure.com/scalesetpriority) to
  # Spot nodes; step_placement tolerates it.
  node_taints = ["vennir.dev/steps=true:NoSchedule"]
  tags        = local.tags
}

# You administer the cluster you made (Azure RBAC; no local accounts).
resource "azurerm_role_assignment" "cluster_admin" {
  scope                = azurerm_kubernetes_cluster.this.id
  role_definition_name = "Azure Kubernetes Service RBAC Cluster Admin"
  principal_id         = data.azurerm_client_config.this.object_id
}

# --- the registry ------------------------------------------------------------
# The catalog's product images (under task_registry) and, built from
# source, the platform's (under platform_registry). No admin user: every
# reader signs in as its own identity.

resource "azurerm_container_registry" "this" {
  name                = "${local.compact}${local.where}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

# The nodes pull both.
resource "azurerm_role_assignment" "nodes_pull" {
  scope                            = azurerm_container_registry.this.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_kubernetes_cluster.this.kubelet_identity[0].object_id
  skip_service_principal_aad_check = true
}

# --- the platform's identities ----------------------------------------------
# Each a managed identity of its own, which AKS Workload Identity gives to
# one ServiceAccount (its federated credential names it): the console's
# (pinning image digests), the scan Jobs' (pulling what they scan: not the
# console's, since they read images anyone can publish), and kernel
# policy's (reading the catalog's release, decision 27). Each may only
# read the registry.

locals {
  readers = {
    console = "console-execution-console"
    scanner = "console-execution-console-scanner"
    policy  = "kernel-execution-kernel-policy"
  }
}

resource "azurerm_user_assigned_identity" "readers" {
  for_each            = local.readers
  name                = "${var.name}-${each.key}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "readers" {
  for_each                  = local.readers
  name                      = each.value
  user_assigned_identity_id = azurerm_user_assigned_identity.readers[each.key].id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = azurerm_kubernetes_cluster.this.oidc_issuer_url
  subject                   = "system:serviceaccount:${var.namespace}:${each.value}"
}

resource "azurerm_role_assignment" "readers_pull" {
  for_each                         = local.readers
  scope                            = azurerm_container_registry.this.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_user_assigned_identity.readers[each.key].principal_id
  skip_service_principal_aad_check = true
}

# --- backups of the in-cluster database ------------------------------------
# A storage account that takes no keys (the backup Jobs sign in as their
# own identity), its one container writable by that identity alone, and
# backups deleted after backup_retention_days.

resource "azurerm_storage_account" "backups" {
  count                           = var.backups ? 1 : 0
  name                            = "${substr(local.compact, 0, 14)}bk${local.where}"
  resource_group_name             = azurerm_resource_group.this.name
  location                        = azurerm_resource_group.this.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  allow_nested_items_to_be_public = false
  tags                            = local.tags
}

resource "azurerm_storage_container" "backups" {
  count              = var.backups ? 1 : 0
  name               = "backups"
  storage_account_id = azurerm_storage_account.backups[0].id
}

resource "azurerm_storage_management_policy" "backups" {
  count              = var.backups ? 1 : 0
  storage_account_id = azurerm_storage_account.backups[0].id
  rule {
    name    = "expire"
    enabled = true
    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["backups/"]
    }
    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = var.backup_retention_days
      }
    }
  }
}

resource "azurerm_user_assigned_identity" "backup" {
  count               = var.backups ? 1 : 0
  name                = "${var.name}-backup"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "backup" {
  count                     = var.backups ? 1 : 0
  name                      = "vennir-pg-backup"
  user_assigned_identity_id = azurerm_user_assigned_identity.backup[0].id
  audience                  = ["api://AzureADTokenExchange"]
  issuer                    = azurerm_kubernetes_cluster.this.oidc_issuer_url
  subject                   = "system:serviceaccount:${var.namespace}:vennir-pg-backup"
}

resource "azurerm_role_assignment" "backup" {
  count                            = var.backups ? 1 : 0
  scope                            = azurerm_storage_container.backups[0].id
  role_definition_name             = "Storage Blob Data Contributor"
  principal_id                     = azurerm_user_assigned_identity.backup[0].principal_id
  skip_service_principal_aad_check = true
}
