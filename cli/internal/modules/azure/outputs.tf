# SPDX-License-Identifier: MIT
# What vennir reads after apply (`tofu output -json`), to make the charts'
# values.

output "cluster" {
  value = {
    name           = azurerm_kubernetes_cluster.this.name
    resource_group = azurerm_resource_group.this.name
    region         = azurerm_resource_group.this.location
    issuer         = azurerm_kubernetes_cluster.this.oidc_issuer_url
  }
}

output "tenant_id" {
  value = data.azurerm_client_config.this.tenant_id
}

output "task_registry" {
  value = "${azurerm_container_registry.this.login_server}/${var.task_registry}"
}

output "platform_registry" {
  value = var.platform_registry != "" ? "${azurerm_container_registry.this.login_server}/${var.platform_registry}" : ""
}

# Each reader's managed identity, as its ServiceAccount's
# azure.workload.identity/client-id names it.
output "identities" {
  value = { for k, v in azurerm_user_assigned_identity.readers : k => v.client_id }
}

output "backup" {
  value = var.backups ? {
    storage_account = azurerm_storage_account.backups[0].name
    container       = azurerm_storage_container.backups[0].name
    client_id       = azurerm_user_assigned_identity.backup[0].client_id
  } : null
}

# Where steps run (the chart's scheduler.taskPlacement): the steps pool,
# tolerating Spot's taint too when it's Spot.
output "step_placement" {
  value = {
    nodeSelector = { "vennir.dev/pool" = "steps" }
    tolerations = concat(
      [{ key = "vennir.dev/steps", operator = "Equal", value = "true", effect = "NoSchedule" }],
      local.spot ? [{ key = "kubernetes.azure.com/scalesetpriority", operator = "Equal", value = "spot", effect = "NoSchedule" }] : [],
    )
  }
}

# Where a step whose product asks for a kind of capacity runs (the chart's
# scheduler.capacityPlacements): the one steps pool has one kind, so none.
output "capacity_placements" {
  value = {}
}

output "spot" {
  value = local.spot
}
