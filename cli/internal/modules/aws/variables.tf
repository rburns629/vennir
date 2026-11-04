# SPDX-License-Identifier: MIT

variable "profile" {
  description = "The AWS CLI profile to sign in with (empty: the default credential chain)."
  type        = string
  default     = ""
}

variable "region" {
  description = "Where everything goes, e.g. us-east-1."
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
  description = "auto: EKS Auto Mode (nodes follow the Pods, from zero). standard: managed node groups this sizes (a platform group, a steps group from zero) with the Cluster Autoscaler."
  type        = string
  default     = "auto"
  validation {
    condition     = contains(["auto", "standard"], var.mode)
    error_message = "auto or standard."
  }
}

variable "kubernetes_version" {
  description = "The cluster's Kubernetes version (vennir matches the Cluster Autoscaler to it)."
  type        = string
  default     = "1.36"
}

variable "step_headroom" {
  description = "Standard mode: steps that can start without waiting, so the steps group keeps a node."
  type        = number
  default     = 0
}

variable "size" {
  description = "minimal, resilient, scaled or auto: decides whether steps run on Spot (all but scaled)."
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
  default     = "vennir-system"
}

variable "task_registry" {
  description = "The ECR prefix steps' images live under (<prefix>/<team>/<product>); ECR creates each repository on its first push."
  type        = string
  default     = "vennir-products"
}

variable "platform_registry" {
  description = "A prefix for the platform images built from source; empty when installing a release (its images come from GHCR)."
  type        = string
  default     = ""
}

variable "backups" {
  description = "A bucket for the in-cluster database's daily backups."
  type        = bool
  default     = true
}

variable "managed_database" {
  description = "Amazon RDS for PostgreSQL instead of the in-cluster Postgres: in the install's VPC, no public access, every service signing in with its own role (IAM database authentication), no passwords of Vennir's."
  type        = bool
  default     = false
}

variable "database_high_availability" {
  description = "A standby in a second zone, failed over to automatically (Multi-AZ)."
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

variable "amazon_prometheus" {
  description = "An Amazon Managed Service for Prometheus workspace the bundled Prometheus writes to, its Alertmanager publishing alerts to an SNS topic."
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "An email subscribed to the alerts' SNS topic (it confirms by email); empty for none."
  type        = string
  default     = ""
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
  description = "Let destroy delete the backup and logs buckets even when they hold data (vennir destroy asks first)."
  type        = bool
  default     = false
}

variable "catalog_repository" {
  description = "The catalog's GitHub repository (owner/name): its CI may push to the task registry from main, without a key. Empty: none."
  type        = string
  default     = ""
}

variable "github_oidc_provider_arn" {
  description = "An account has one GitHub OIDC provider: its ARN if it exists already (vennir looks), empty to create it."
  type        = string
  default     = ""
}

variable "console_zone" {
  description = "A DNS zone for the console's public address (e.g. vennir.example.com), created in Route 53; you delegate it with its NS records. Empty: no public console."
  type        = string
  default     = ""
}

variable "console_hostname" {
  description = "The console's public hostname, in console_zone (default console.<zone>)."
  type        = string
  default     = ""
}

variable "catalog_subject_prefix" {
  description = "The catalog repository's OIDC subject prefix as GitHub sends it: repo:<owner>/<name>, or with immutable subjects repo:<owner>@<id>/<name>@<id> (`vennir catalog create` reads it). Empty: repo:<catalog_repository>."
  type        = string
  default     = ""
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


variable "chat_model" {
  description = "The console's chat agent answers with this Claude model in Amazon Bedrock (Bedrock's name, such as anthropic.claude-sonnet-5), as the console's own role; empty: chat off, no grant."
  type        = string
  default     = ""
  validation {
    condition     = var.chat_model == "" || can(regex("^anthropic\\.claude-[a-z0-9][a-z0-9.-]*$", var.chat_model))
    error_message = "Bedrock's name for a Claude model, such as anthropic.claude-sonnet-5, or empty."
  }
}
