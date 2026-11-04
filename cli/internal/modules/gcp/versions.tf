# SPDX-License-Identifier: MIT
# The cloud side of a Vennir install on Google Cloud. vennir runs it
# (embedded in the binary, so a CLI version always runs the module it was
# tested with); it also works on its own with OpenTofu or Terraform.

terraform {
  required_version = ">= 1.10"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "= 3.9.1"
    }
  }
}

provider "google" {
  project = var.project
  region  = var.region
  default_labels = {
    "vennir-environment" = var.name
  }
}
