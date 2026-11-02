# SPDX-License-Identifier: MIT

variable "project" {
  description = "The Google Cloud project, which must already exist with billing enabled."
  type        = string
}

variable "region" {
  description = "Where everything goes, e.g. us-central1."
  type        = string
}

variable "name" {
  description = "The cluster's name, and the prefix of everything else this creates."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.name))
    error_message = "3 to 20 lowercase letters, digits and dashes, starting with a letter."
  }
}

variable "mode" {
  description = "auto (GKE Autopilot: billed per Pod) or standard (node pools this sizes: billed per node)."
  type        = string
  default     = "auto"
  validation {
    condition     = contains(["auto", "standard"], var.mode)
    error_message = "auto or standard."
  }
}

variable "size" {
  description = "minimal, resilient, scaled or auto: sizes the standard mode's node pools (Autopilot follows the Pods)."
  type        = string
  default     = "minimal"
  validation {
    condition     = contains(["minimal", "resilient", "scaled", "auto"], var.size)
    error_message = "minimal, resilient, scaled or auto."
  }
}

variable "namespace" {
  description = "The platform's Kubernetes namespace: its ServiceAccounts get the cloud identities."
  type        = string
  default     = "vertra-system"
}

variable "step_headroom" {
  description = "Standard mode: steps that can start without waiting, so the steps pool keeps a node."
  type        = number
  default     = 0
}

variable "task_registry" {
  description = "The Artifact Registry repository steps' images come from: created unless it already exists (create_task_registry = false)."
  type        = string
  default     = "vertra-products"
}

variable "create_task_registry" {
  type    = bool
  default = true
}

variable "platform_registry" {
  description = "A repository for platform images built from source; empty when installing a release (its images come from GHCR)."
  type        = string
  default     = ""
}

variable "backups" {
  description = "A bucket for the in-cluster database's daily backups."
  type        = bool
  default     = true
}

variable "managed_database" {
  description = "Cloud SQL for PostgreSQL instead of the in-cluster Postgres: private IP only, every service signing in with its own identity (IAM database authentication), no passwords."
  type        = bool
  default     = false
}

variable "database_high_availability" {
  description = "A standby in a second zone, failed over to automatically (REGIONAL)."
  type        = bool
  default     = false
}

variable "backup_retention_days" {
  type    = number
  default = 30
}

variable "logs" {
  description = "A bucket for Loki's logs (Observe's log search), archived after log_search_days."
  type        = bool
  default     = false
}

variable "log_search_days" {
  description = "Days logs stay searchable in the standard storage class before moving to the archive class."
  type        = number
  default     = 30
}

variable "log_keep_days" {
  description = "Days logs are kept in all; Loki deletes them then, the bucket a day later if Loki didn't."
  type        = number
  default     = 365
}

variable "audit_export" {
  description = "A bucket for the console's write-once copy of the audit log."
  type        = bool
  default     = false
}

variable "audit_keep_days" {
  description = "Days each copied audit entry can't be deleted or changed."
  type        = number
  default     = 365
}

variable "audit_lock" {
  description = "Lock the retention: it can never be shortened or removed, nor the bucket deleted, until it lapses (GCS locked retention, S3 Object Lock compliance mode)."
  type        = bool
  default     = false
}

variable "delete_data" {
  description = "Let destroy delete the backup and logs buckets even when they hold data (vertra destroy asks first)."
  type        = bool
  default     = false
}

variable "console_public" {
  description = "Reserve a global address for reaching the console over HTTPS from the internet."
  type        = bool
  default     = true
}

variable "catalog_repository" {
  description = "The catalog's GitHub repository (owner/name): its CI may push to the task registry, from main only, without a key. Empty: none."
  type        = string
  default     = ""
}

variable "google_groups" {
  description = "The console reads people's Google Workspace groups (Cloud Identity's API), as its own service account, for mapping groups to teams."
  type        = bool
  default     = false
}

variable "chat" {
  description = "The console's chat agent answers with Gemini through Vertex AI here, as the console's own service account."
  type        = bool
  default     = false
}

variable "managed_prometheus" {
  description = "GKE's managed Prometheus evaluates the charts' alerts: the console reads which fire, as its own service account."
  type        = bool
  default     = false
}

variable "signing" {
  description = "How the catalog is signed: none, kms (a key here only its CI signs with) or keyless; or verify: another install signs it, and policy-controller only checks it here."
  type        = string
  default     = "none"
  validation {
    condition     = contains(["none", "kms", "keyless", "verify"], var.signing)
    error_message = "none, kms, keyless or verify."
  }
}

