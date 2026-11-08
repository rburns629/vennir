# SPDX-License-Identifier: MIT
# The cloud side of a Vennir install on Azure. vennir runs it (embedded in
# the binary, so a CLI version always runs the module it was tested with);
# it also works on its own with OpenTofu or Terraform, signed in with az.

terraform {
  required_version = ">= 1.10"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "= 5.11.0"
    }
  }
}

provider "azurerm" {
  subscription_id = var.subscription
  # Blob storage signed in as you (the storage account takes no keys).
  storage_use_azuread = true
  # A new subscription has none registered: what the module uses.
  resource_provider_registrations = "none"
  resource_providers_to_register = [
    "Microsoft.Authorization",
    "Microsoft.Compute",
    "Microsoft.ContainerRegistry",
    "Microsoft.ContainerService",
    "Microsoft.ManagedIdentity",
    "Microsoft.Network",
    "Microsoft.Storage",
  ]
  features {
    resource_group {
      # The resource group holds only what this module made (and AKS's own
      # node resource group, apart): anything else in it is someone's.
      prevent_deletion_if_contains_resources = true
    }
  }
}
