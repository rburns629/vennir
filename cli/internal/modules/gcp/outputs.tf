# SPDX-License-Identifier: MIT
# What vennir turns into Helm values and kubectl access.

output "cluster" {
  value = {
    name     = google_container_cluster.this.name
    location = google_container_cluster.this.location
    issuer   = "https://container.googleapis.com/v1/projects/${var.project}/locations/${google_container_cluster.this.location}/clusters/${google_container_cluster.this.name}"
  }
}

output "workload_identity_pool" {
  value = local.workload_pool
}

output "task_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project}/${var.task_registry}"
}

output "platform_registry" {
  value = var.platform_registry == "" ? "" : "${var.region}-docker.pkg.dev/${var.project}/${var.platform_registry}"
}

output "console_service_account" {
  value = google_service_account.console.email
}

output "scanner_service_account" {
  value = google_service_account.scanner.email
}

output "policy_service_account" {
  value = google_service_account.policy.email
}

output "audit" {
  value = var.audit_export ? { bucket = google_storage_bucket.audit[0].name } : null
}

output "logs" {
  value = var.logs ? {
    bucket          = google_storage_bucket.logs[0].name
    service_account = google_service_account.logs[0].email
  } : null
}

output "backup" {
  value = var.backups ? {
    bucket          = google_storage_bucket.backups[0].name
    service_account = google_service_account.backup[0].email
  } : null
}

# Standard mode: where steps run (the chart's scheduler.taskPlacement).
output "step_placement" {
  value = local.standard ? {
    nodeSelector = { "vennir.dev/pool" = "steps" }
    tolerations  = [{ key = "vennir.dev/steps", operator = "Equal", value = "true", effect = "NoSchedule" }]
    } : {
    # Autopilot: Spot Pods, except at `scaled` (on-demand).
    nodeSelector = local.pools.spot ? { "cloud.google.com/gke-spot" = "true" } : {}
    tolerations  = []
  }
}

# Where a step whose product asks for a kind of capacity runs (the chart's
# scheduler.capacityPlacements): Autopilot has both; standard mode's one
# steps pool has one kind, so none.
output "capacity_placements" {
  value = local.standard ? {} : {
    spot     = { nodeSelector = { "cloud.google.com/gke-spot" = "true" }, tolerations = [] }
    onDemand = { nodeSelector = {}, tolerations = [] }
  }
}

output "console_address" {
  value = var.console_public ? {
    name = google_compute_global_address.console[0].name
    ip   = google_compute_global_address.console[0].address
  } : null
}

# The catalog repository's variables: GCP_WORKLOAD_IDENTITY_PROVIDER and
# PUBLISH_GCP_SERVICE_ACCOUNT.
output "catalog" {
  value = var.catalog_repository != "" ? {
    workload_identity_provider = google_iam_workload_identity_pool_provider.github[0].name
    service_account            = google_service_account.publish[0].email
  } : null
}

output "signing" {
  description = "The catalog's signing key as cosign names it (kms), and the account policy-controller reads signatures as."
  value = {
    key      = var.signing == "kms" ? "gcpkms://${google_kms_crypto_key.signing[0].id}" : ""
    verifier = var.signing != "none" ? google_service_account.verifier[0].email : ""
  }
}


# The managed database: where it is, its server CA (public), and the user
# each service signs in as (no passwords: IAM database authentication).
output "database" {
  value = var.managed_database ? {
    instance = google_sql_database_instance.this[0].name
    host     = google_sql_database_instance.this[0].private_ip_address
    # A CA certificate, public (every client is given it); the provider
    # marks the whole block sensitive.
    ca_cert    = nonsensitive(google_sql_database_instance.this[0].server_ca_cert[0].cert)
    users      = local.database_users
    kernel_sa  = google_service_account.kernel_db[0].email
    gateway_sa = google_service_account.gateway_db[0].email
    admin_sa   = google_service_account.database_admin[0].email
  } : null
}
