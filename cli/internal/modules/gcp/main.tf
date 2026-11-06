# SPDX-License-Identifier: MIT

data "google_project" "this" {}

locals {
  standard = var.mode == "standard"
  # Standard mode's pools by size: the platform's (always one node, for the
  # console, kernel and Postgres) and the steps' (from zero, Spot except at
  # `scaled`, which runs on-demand).
  pools = {
    minimal   = { platform_type = "e2-medium", platform_max = 2, steps_type = "e2-standard-2", steps_max = 2, spot = true }
    resilient = { platform_type = "e2-standard-2", platform_max = 3, steps_type = "e2-standard-4", steps_max = 8, spot = true }
    scaled    = { platform_type = "e2-standard-2", platform_max = 4, steps_type = "e2-standard-4", steps_max = 30, spot = false }
    auto      = { platform_type = "e2-standard-2", platform_max = 3, steps_type = "e2-standard-4", steps_max = 8, spot = true }
  }[var.size]
  workload_pool = "${var.project}.svc.id.goog"
  ksa           = "serviceAccount:${local.workload_pool}[${var.namespace}"
}

resource "google_project_service" "apis" {
  # Cloud Identity: the console reads people's Workspace groups (sso.googleGroups).
  for_each = toset(concat([
    "artifactregistry.googleapis.com",
    "cloudbilling.googleapis.com", # prices on the approval screen
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "storage.googleapis.com",
    ], var.managed_database ? ["servicenetworking.googleapis.com", "sqladmin.googleapis.com"] : [],
    var.google_groups ? ["cloudidentity.googleapis.com"] : [], var.signing == "kms" ? ["cloudkms.googleapis.com"] : [], var.chat ? ["aiplatform.googleapis.com"] : [],
  var.managed_prometheus ? ["monitoring.googleapis.com"] : []))
  service = each.value
  # Other things in the project may use them.
  disable_on_destroy = false
}

# --- network ---------------------------------------------------------------

resource "google_compute_network" "this" {
  name                    = var.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "this" {
  name                     = var.name
  network                  = google_compute_network.this.id
  ip_cidr_range            = "10.10.0.0/20"
  private_ip_google_access = true
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.20.0.0/14"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.30.0.0/20"
  }
}

# --- the nodes' own identity: logs, metrics, pulling images; nothing else --

resource "google_service_account" "nodes" {
  account_id   = "${var.name}-nodes"
  display_name = "Vennir ${var.name}: GKE nodes"
  depends_on   = [google_project_service.apis]
}

resource "google_project_iam_member" "nodes" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
    "roles/autoscaling.metricsWriter",
  ])
  project = var.project
  role    = each.value
  member  = google_service_account.nodes.member
}

# --- the cluster -------------------------------------------------------------

resource "google_container_cluster" "this" {
  name     = var.name
  location = local.standard ? "${var.region}-a" : var.region

  network    = google_compute_network.this.id
  subnetwork = google_compute_subnetwork.this.id
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  release_channel {
    channel = "REGULAR"
  }
  # vennir destroy asks before deleting anything.
  deletion_protection = false

  enable_autopilot = local.standard ? null : true

  # Standard: Dataplane V2 (enforces the charts' NetworkPolicies; Autopilot
  # always has it), Workload Identity, and the node pools below.
  datapath_provider        = local.standard ? "ADVANCED_DATAPATH" : null
  remove_default_node_pool = local.standard ? true : null
  initial_node_count       = local.standard ? 1 : null
  dynamic "workload_identity_config" {
    for_each = local.standard ? [1] : []
    content {
      workload_pool = local.workload_pool
    }
  }

  # Autopilot: its nodes run as the nodes' identity above, not the
  # project's default (often an Editor).
  dynamic "cluster_autoscaling" {
    for_each = local.standard ? [] : [1]
    content {
      auto_provisioning_defaults {
        service_account = google_service_account.nodes.email
        oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
      }
    }
  }

  depends_on = [google_project_iam_member.nodes]
}

resource "google_container_node_pool" "platform" {
  count    = local.standard ? 1 : 0
  name     = "platform"
  cluster  = google_container_cluster.this.id
  location = google_container_cluster.this.location
  autoscaling {
    min_node_count = 1
    max_node_count = local.pools.platform_max
  }
  node_config {
    machine_type    = local.pools.platform_type
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    disk_size_gb    = 50
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

# Steps run here (the chart's scheduler.taskPlacement selects and tolerates
# it): scaled from zero, so it costs nothing while nothing runs.
resource "google_container_node_pool" "steps" {
  count    = local.standard ? 1 : 0
  name     = "steps"
  cluster  = google_container_cluster.this.id
  location = google_container_cluster.this.location
  autoscaling {
    min_node_count = var.step_headroom > 0 ? 1 : 0
    max_node_count = local.pools.steps_max
  }
  node_config {
    machine_type    = local.pools.steps_type
    spot            = local.pools.spot
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    disk_size_gb    = 50
    labels = {
      "vennir.dev/pool" = "steps"
    }
    taint {
      key    = "vennir.dev/steps"
      value  = "true"
      effect = "NO_SCHEDULE"
    }
    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}

# --- registries --------------------------------------------------------------

resource "google_artifact_registry_repository" "tasks" {
  count         = var.create_task_registry ? 1 : 0
  repository_id = var.task_registry
  location      = var.region
  format        = "DOCKER"
  description   = "Vennir ${var.name}: the catalog's product images."
  depends_on    = [google_project_service.apis]
}

resource "google_artifact_registry_repository" "platform" {
  count         = var.platform_registry != "" ? 1 : 0
  repository_id = var.platform_registry
  location      = var.region
  format        = "DOCKER"
  description   = "Vennir ${var.name}: the platform's images, built from source."
  depends_on    = [google_project_service.apis]
}

# The nodes pull both.
resource "google_artifact_registry_repository_iam_member" "nodes_pull" {
  for_each   = toset(compact([var.task_registry, var.platform_registry]))
  location   = var.region
  repository = each.value
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.nodes.member
  depends_on = [google_artifact_registry_repository.tasks, google_artifact_registry_repository.platform]
}

# --- the console's identity: reads the task registry (pinning image digests,
# and its scan Jobs pulling what they scan) ------------------------------

resource "google_service_account" "console" {
  account_id   = "${var.name}-console"
  display_name = "Vennir ${var.name}: console (reads the task registry)"
  depends_on   = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "console_read" {
  location   = var.region
  repository = var.task_registry
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.console.member
  depends_on = [google_artifact_registry_repository.tasks]
}

# Was one of two (the scan Jobs' too, now their own identity's): the
# console's binding stays as it is, and only the scanner's goes.
moved {
  from = google_service_account_iam_member.console_workload_identity["console-execution-console"]
  to   = google_service_account_iam_member.console_workload_identity
}

resource "google_service_account_iam_member" "console_workload_identity" {
  service_account_id = google_service_account.console.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.ksa}/console-execution-console]"
  depends_on         = [google_container_cluster.this]
}

# Observe's alerts: which of the charts' rules fire, read from the
# project's managed Prometheus (its query API), as the console.
resource "google_project_iam_member" "console_monitoring" {
  count      = var.managed_prometheus ? 1 : 0
  project    = var.project
  role       = "roles/monitoring.viewer"
  member     = google_service_account.console.member
  depends_on = [google_project_service.apis]
}

# The chat agent's model: Gemini through Vertex AI, as the console. Vertex
# grants calling a model only on the project.
resource "google_project_iam_member" "console_chat" {
  count      = var.chat ? 1 : 0
  project    = var.project
  role       = "roles/aiplatform.user"
  member     = google_service_account.console.member
  depends_on = [google_project_service.apis]
}

# --- the scan Jobs' identity: pulling what they scan, and nothing else. Not
# the console's: they read images anyone can publish, and the console's
# identity can do more (call Vertex AI, export the audit log). ------------

resource "google_service_account" "scanner" {
  account_id   = "${var.name}-scanner"
  display_name = "Vennir ${var.name}: image scans (reads the task registry)"
  depends_on   = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "scanner_read" {
  location   = var.region
  repository = var.task_registry
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.scanner.member
  depends_on = [google_artifact_registry_repository.tasks]
}

resource "google_service_account_iam_member" "scanner_workload_identity" {
  service_account_id = google_service_account.scanner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.ksa}/console-execution-console-scanner]"
  depends_on         = [google_container_cluster.this]
}

# --- backups of the in-cluster database ------------------------------------

resource "google_storage_bucket" "backups" {
  count                       = var.backups ? 1 : 0
  name                        = "${var.project}-${var.name}-backups"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.delete_data
  lifecycle_rule {
    condition {
      age = var.backup_retention_days
    }
    action {
      type = "Delete"
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "backup" {
  count        = var.backups ? 1 : 0
  account_id   = "${var.name}-backup"
  display_name = "Vennir ${var.name}: database backups (one bucket)"
  depends_on   = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "backup" {
  for_each = var.backups ? toset(["roles/storage.objectCreator", "roles/storage.objectViewer"]) : toset([])
  bucket   = google_storage_bucket.backups[0].name
  role     = each.value
  member   = google_service_account.backup[0].member
}

resource "google_service_account_iam_member" "backup_workload_identity" {
  count              = var.backups ? 1 : 0
  service_account_id = google_service_account.backup[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.ksa}/vennir-pg-backup]"
  depends_on         = [google_container_cluster.this]
}

# --- a managed database: Cloud SQL for PostgreSQL ---------------------------
# Private IP only, in this network (private services access); SSL required.
# No passwords: the kernel, the console and the gateway each sign in as
# their own Google identity (IAM database authentication), and an
# administrator identity, used only by `kernel database-setup`, opens each
# database to its service alone. The tier and connections follow the size,
# as the in-cluster Postgres's do. Cloud SQL backs it up (daily, with
# point-in-time recovery) instead of the backup Jobs.

locals {
  database = {
    minimal   = { tier = "db-g1-small", max_connections = 100 }
    resilient = { tier = "db-custom-1-3840", max_connections = 200 }
    scaled    = { tier = "db-custom-2-7680", max_connections = 300 }
    auto      = { tier = "db-custom-1-3840", max_connections = 200 }
  }[var.size]
  # An IAM database user is its service account's email without the domain.
  database_users = var.managed_database ? {
    kernel  = trimsuffix(google_service_account.kernel_db[0].email, ".gserviceaccount.com")
    console = trimsuffix(google_service_account.console.email, ".gserviceaccount.com")
    gateway = trimsuffix(google_service_account.gateway_db[0].email, ".gserviceaccount.com")
    admin   = trimsuffix(google_service_account.database_admin[0].email, ".gserviceaccount.com")
  } : {}
}

resource "google_compute_global_address" "database" {
  count         = var.managed_database ? 1 : 0
  name          = "${var.name}-database"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.this.id
}

resource "google_service_networking_connection" "database" {
  count                   = var.managed_database ? 1 : 0
  network                 = google_compute_network.this.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.database[0].name]
  # Removing the peering fails while Google still tears the instance down;
  # it goes with the network.
  deletion_policy = "ABANDON"
}

# A deleted instance's name can't be used again for a week.
resource "random_id" "database" {
  count       = var.managed_database ? 1 : 0
  byte_length = 2
}

resource "google_sql_database_instance" "this" {
  count            = var.managed_database ? 1 : 0
  name             = "${var.name}-${random_id.database[0].hex}"
  database_version = "POSTGRES_16"
  region           = var.region
  # Only when destroy is told to delete data (vennir destroy asks first).
  deletion_protection = !var.delete_data
  settings {
    edition                     = "ENTERPRISE"
    tier                        = local.database.tier
    availability_type           = var.database_high_availability ? "REGIONAL" : "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = 10
    disk_autoresize             = true
    deletion_protection_enabled = !var.delete_data
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.this.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = min(var.backup_retention_days, 365)
      }
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    database_flags {
      name  = "max_connections"
      value = tostring(local.database.max_connections)
    }
    user_labels = { vennir-environment = var.name }
  }
  depends_on = [google_service_networking_connection.database]
}

# Databases and users go with the instance: a role that owns tables or holds
# grants can't be dropped on its own.
resource "google_sql_database" "this" {
  for_each        = var.managed_database ? toset(["execution_kernel", "execution_console"]) : toset([])
  name            = each.value
  instance        = google_sql_database_instance.this[0].name
  deletion_policy = "ABANDON"
}

# The kernel's and the gateway's identities (the console's is above), and
# the administrator's.
resource "google_service_account" "kernel_db" {
  count        = var.managed_database ? 1 : 0
  account_id   = "${var.name}-kernel"
  display_name = "Vennir ${var.name}: the kernel's database identity"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "gateway_db" {
  count        = var.managed_database ? 1 : 0
  account_id   = "${var.name}-gateway"
  display_name = "Vennir ${var.name}: the gateway's database identity"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "database_admin" {
  count        = var.managed_database ? 1 : 0
  account_id   = "${var.name}-db-admin"
  display_name = "Vennir ${var.name}: opens each database to its service (kernel database-setup)"
  depends_on   = [google_project_service.apis]
}

# Connecting (cloudsql.client) and signing in (cloudsql.instanceUser), on
# this instance only (an IAM condition: Cloud SQL has no instance-level
# policy), so Vennir's identities can't reach another instance in the
# project.
resource "google_project_iam_member" "database" {
  for_each = var.managed_database ? merge([for who, sa in {
    kernel  = google_service_account.kernel_db[0].member
    console = google_service_account.console.member
    gateway = google_service_account.gateway_db[0].member
    admin   = google_service_account.database_admin[0].member
    } : {
    "${who}-client" = { member = sa, role = "roles/cloudsql.client" }
    "${who}-user"   = { member = sa, role = "roles/cloudsql.instanceUser" }
  }]...) : {}
  project = var.project
  role    = each.value.role
  member  = each.value.member
  condition {
    title      = "only ${google_sql_database_instance.this[0].name}"
    expression = "resource.name == \"projects/${var.project}/instances/${google_sql_database_instance.this[0].name}\" && resource.service == \"sqladmin.googleapis.com\""
  }
  # A changed condition replaces the binding: the new one first (a binding
  # with another condition is another binding), so sign-ins don't stop
  # while IAM propagates the change.
  lifecycle {
    create_before_destroy = true
  }
}

# Which Kubernetes ServiceAccounts sign in as which: every kernel Pod that
# connects (the scheduler, kernel-api and its migration, the sleeper, kernel
# policy with the chart's catalogPolicy), the
# gateway, and database-setup's Job. The console's is bound above.
resource "google_service_account_iam_member" "database_workload_identity" {
  for_each = var.managed_database ? {
    "kernel-execution-kernel"           = google_service_account.kernel_db[0].name
    "kernel-execution-kernel-api"       = google_service_account.kernel_db[0].name
    "kernel-execution-kernel-sleeper"   = google_service_account.kernel_db[0].name
    "kernel-execution-kernel-policy"    = google_service_account.kernel_db[0].name
    "console-execution-console-gateway" = google_service_account.gateway_db[0].name
    "vennir-db-admin"                   = google_service_account.database_admin[0].name
  } : {}
  service_account_id = each.value
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.ksa}/${each.key}]"
  depends_on         = [google_container_cluster.this]
}

resource "google_sql_user" "this" {
  for_each = local.database_users
  instance = google_sql_database_instance.this[0].name
  name     = each.value
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
  # See google_sql_database.
  deletion_policy = "ABANDON"
  # Only the administrator may grant: database-setup opens each database to
  # its service and to no one else.
  database_roles = each.key == "admin" ? ["cloudsqlsuperuser"] : []
}

# --- logs: Loki's bucket, archived after log_search_days --------------------
# Loki (single tenant) keeps chunks under fake/ and its index under index/;
# only chunks move to the Archive class, and Loki still reads them there.

resource "google_storage_bucket" "logs" {
  count                       = var.logs ? 1 : 0
  name                        = "${var.project}-${var.name}-logs"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.delete_data
  lifecycle_rule {
    condition {
      age            = var.log_search_days
      matches_prefix = ["fake/"]
    }
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
  }
  lifecycle_rule {
    condition {
      age = var.log_keep_days + 1
    }
    action {
      type = "Delete"
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "logs" {
  count        = var.logs ? 1 : 0
  account_id   = "${var.name}-logs"
  display_name = "Vennir ${var.name}: Loki's logs (one bucket)"
  depends_on   = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "logs" {
  count  = var.logs ? 1 : 0
  bucket = google_storage_bucket.logs[0].name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.logs[0].member
}

resource "google_service_account_iam_member" "logs_workload_identity" {
  count              = var.logs ? 1 : 0
  service_account_id = google_service_account.logs[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "${local.ksa}/vennir-loki]"
  depends_on         = [google_container_cluster.this]
}

# --- the audit log's write-once copy --------------------------------------
# Entries can't be deleted or changed for audit_keep_days (a retention
# policy; locked, it can't be shortened or removed either). The console may
# only create objects, which can't replace one. Kept by destroy: it's the
# record (docs/operations.md).

resource "google_storage_bucket" "audit" {
  count                       = var.audit_export ? 1 : 0
  name                        = "${var.project}-${var.name}-audit"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  retention_policy {
    retention_period = var.audit_keep_days * 86400
    is_locked        = var.audit_lock
  }
  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "audit" {
  count  = var.audit_export ? 1 : 0
  bucket = google_storage_bucket.audit[0].name
  role   = "roles/storage.objectCreator"
  member = google_service_account.console.member
}

# Reading its copies back, to compare the database with them (no delete:
# the retention policy refuses that anyway).
resource "google_storage_bucket_iam_member" "audit_read" {
  count  = var.audit_export ? 1 : 0
  bucket = google_storage_bucket.audit[0].name
  role   = "roles/storage.objectViewer"
  member = google_service_account.console.member
}

# --- reaching the console: an address for its load balancer -----------------

resource "google_compute_global_address" "console" {
  count      = var.console_public ? 1 : 0
  name       = "${var.name}-console"
  depends_on = [google_project_service.apis]
}

# --- the catalog's CI: pushes images from main, by GitHub's OIDC token -------

# The repository by its id and its owner's once they're known (`vennir
# catalog create` reads them), so one renamed, or deleted and made again
# under its name by someone else, isn't trusted; by its name until then.
locals {
  catalog_pinned = var.catalog_repository_id != "" && var.catalog_owner_id != ""
  catalog_repository_condition = (local.catalog_pinned ?
    "assertion.repository_id == \"${var.catalog_repository_id}\" && assertion.repository_owner_id == \"${var.catalog_owner_id}\"" :
  "assertion.repository == \"${var.catalog_repository}\"")
  catalog_principal = (local.catalog_pinned ?
    "attribute.repository_id/${var.catalog_repository_id}" :
  "attribute.repository/${var.catalog_repository}")
}

# Deleted pools keep their id for 30 days, so each gets a fresh suffix.
resource "random_id" "pool" {
  count       = var.catalog_repository != "" ? 1 : 0
  byte_length = 3
}

resource "google_iam_workload_identity_pool" "github" {
  count                     = var.catalog_repository != "" ? 1 : 0
  workload_identity_pool_id = "${var.name}-gh-${random_id.pool[0].hex}"
  display_name              = "Vennir ${var.name}: catalog CI"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count                              = var.catalog_repository != "" ? 1 : 0
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository"    = "assertion.repository"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.ref"           = "assertion.ref"
  }
  # Only the catalog repository's main branch: pull requests (any fork's
  # code) never get a token.
  attribute_condition = "${local.catalog_repository_condition} && assertion.ref == \"refs/heads/main\""
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "publish" {
  count        = var.catalog_repository != "" ? 1 : 0
  account_id   = "${var.name}-publish"
  display_name = "Vennir ${var.name}: catalog CI (pushes to the task registry)"
  depends_on   = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "publish" {
  count      = var.catalog_repository != "" ? 1 : 0
  location   = var.region
  repository = var.task_registry
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.publish[0].member
  depends_on = [google_artifact_registry_repository.tasks]
}

resource "google_service_account_iam_member" "publish_federation" {
  count              = var.catalog_repository != "" ? 1 : 0
  service_account_id = google_service_account.publish[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/${local.catalog_principal}"
}

# --- catalog signing (signing): a KMS key only the catalog's CI signs with,
# and policy-controller's identity, which reads signatures from the task
# registry and nothing else (verify: only the identity; another install's
# registry grants it read, as apply prints) ------------------------------------

# Key rings can't be deleted, so each install's gets a fresh suffix.
resource "random_id" "keyring" {
  count       = var.signing == "kms" ? 1 : 0
  byte_length = 3
}

resource "google_kms_key_ring" "catalog" {
  count      = var.signing == "kms" ? 1 : 0
  name       = "${var.name}-catalog-${random_id.keyring[0].hex}"
  location   = var.region
  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "signing" {
  count    = var.signing == "kms" ? 1 : 0
  name     = "catalog-signing"
  key_ring = google_kms_key_ring.catalog[0].id
  purpose  = "ASYMMETRIC_SIGN"
  version_template {
    algorithm = "EC_SIGN_P256_SHA256"
  }
}

# The catalog's CI (its publish account, main only) signs, and reads the
# key's metadata as cosign does; nobody else is granted anything.
resource "google_kms_crypto_key_iam_member" "publish_signs" {
  for_each      = var.signing == "kms" && var.catalog_repository != "" ? toset(["roles/cloudkms.signerVerifier", "roles/cloudkms.viewer"]) : toset([])
  crypto_key_id = google_kms_crypto_key.signing[0].id
  role          = each.value
  member        = google_service_account.publish[0].member
}

resource "google_service_account" "verifier" {
  count        = var.signing != "none" ? 1 : 0
  account_id   = "${var.name}-verifier"
  display_name = "Vennir ${var.name}: policy-controller (reads signatures from the task registry)"
  depends_on   = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "verifier_read" {
  count      = var.signing != "none" ? 1 : 0
  location   = var.region
  repository = var.task_registry
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.verifier[0].member
  depends_on = [google_artifact_registry_repository.tasks]
}

resource "google_service_account_iam_member" "verifier_workload_identity" {
  count              = var.signing != "none" ? 1 : 0
  service_account_id = google_service_account.verifier[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project}.svc.id.goog[cosign-system/policy-controller-webhook]"
  depends_on         = [google_container_cluster.this]
}

