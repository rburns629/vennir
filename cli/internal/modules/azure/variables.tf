# SPDX-License-Identifier: MIT

variable "subscription" {
  description = "The subscription's id."
  type        = string
}

variable "region" {
  description = "The region, such as eastus2."
  type        = string
}

variable "resource_group" {
  description = "The resource group the module makes and puts everything in."
  type        = string
}

variable "name" {
  description = "The install's name: the cluster's, and the prefix of what else is made."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.name))
    error_message = "3 to 20 lowercase letters, digits and dashes, starting with a letter."
  }
}

variable "size" {
  description = "minimal, resilient, scaled or auto: the node pools' sizes."
  type        = string
  validation {
    condition     = contains(["minimal", "resilient", "scaled", "auto"], var.size)
    error_message = "minimal, resilient, scaled or auto."
  }
}

variable "namespace" {
  description = "The platform's namespace, where its ServiceAccounts are."
  type        = string
  default     = "vennir-system"
}

variable "step_headroom" {
  description = "Steps that can start without waiting for a node: the steps pool keeps one node when it's more than 0."
  type        = number
  default     = 0
}

variable "on_demand_steps" {
  description = "The steps pool on regular VMs, not Spot (a subscription that can't have Spot VMs, such as a Free Trial)."
  type        = bool
  default     = false
}

variable "task_registry" {
  description = "The repository prefix in the registry for the catalog's product images."
  type        = string
  default     = "vennir-products"
}

variable "platform_registry" {
  description = "The repository prefix for the platform's images built from source; empty when installing a release."
  type        = string
  default     = ""
}

variable "backups" {
  description = "Back up the in-cluster database to a storage container."
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "Days a backup is kept."
  type        = number
  default     = 30
}

variable "delete_data" {
  description = "Set by vennir destroy when told to delete data: nothing here holds data back from deletion then."
  type        = bool
  default     = false
}
