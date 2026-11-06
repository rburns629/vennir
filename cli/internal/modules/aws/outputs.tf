# SPDX-License-Identifier: MIT
# What vennir turns into Helm values and kubectl access.

output "cluster" {
  value = {
    name    = aws_eks_cluster.this.name
    region  = var.region
    issuer  = aws_eks_cluster.this.identity[0].oidc[0].issuer
    mode    = var.mode
    version = var.kubernetes_version
  }
}

output "account" {
  value = local.account
}

output "task_registry" {
  value = "${local.registry}/${var.task_registry}"
}

output "platform_registry" {
  value = var.platform_registry == "" ? "" : "${local.registry}/${var.platform_registry}"
}

output "audit" {
  value = var.audit_export ? { bucket = aws_s3_bucket.audit[0].bucket, region = var.region } : null
}

output "logs" {
  value = var.logs ? {
    bucket = aws_s3_bucket.logs[0].bucket
    region = var.region
  } : null
}

output "backup" {
  value = var.backups ? {
    bucket = aws_s3_bucket.backups[0].bucket
    region = var.region
  } : null
}

# Where steps run: the node pool vennir adds to Auto Mode
# (vennir-steps), or standard mode's steps group; the same label and taint.
output "step_placement" {
  value = {
    nodeSelector = { "vennir.dev/pool" = "steps" }
    tolerations  = [{ key = "vennir.dev/steps", operator = "Equal", value = "true", effect = "NoSchedule" }]
  }
}

output "spot" {
  value = local.spot
}

# Where a step whose product asks for a kind of capacity runs (the chart's
# scheduler.capacityPlacements): the steps pool takes both kinds when it
# uses Spot, and Karpenter's label picks one; otherwise it's on-demand only.
output "capacity_placements" {
  value = local.spot ? {
    spot = {
      nodeSelector = { "vennir.dev/pool" = "steps", "karpenter.sh/capacity-type" = "spot" }
      tolerations  = [{ key = "vennir.dev/steps", operator = "Equal", value = "true", effect = "NoSchedule" }]
    }
    onDemand = {
      nodeSelector = { "vennir.dev/pool" = "steps", "karpenter.sh/capacity-type" = "on-demand" }
      tolerations  = [{ key = "vennir.dev/steps", operator = "Equal", value = "true", effect = "NoSchedule" }]
    }
  } : {}
}

output "catalog" {
  value = var.catalog_repository != "" ? {
    role_arn = aws_iam_role.publish[0].arn
  } : null
}

output "console_address" {
  value = var.console_zone != "" ? {
    host            = local.console_host
    zone_id         = aws_route53_zone.console[0].zone_id
    name_servers    = aws_route53_zone.console[0].name_servers
    certificate_arn = aws_acm_certificate.console[0].arn
    vpc_cidr        = aws_vpc.this.cidr_block
  } : null
}

output "signing" {
  description = "The catalog's signing key as cosign names it (kms)."
  value = {
    key = var.signing == "kms" && var.catalog_repository != "" ? "awskms:///${aws_kms_key.signing[0].arn}" : ""
  }
}

# The managed database: where it is, the users the services sign in as (no
# passwords of Vennir's), and the administrator's password's secret, which
# only database-setup's role may read.
# kernel policy's role (Pod Identity binds it to its ServiceAccount by
# name): reads the task registry, where the catalog's release is.
output "policy_role" {
  value = aws_iam_role.policy.arn
}

output "database" {
  value = var.managed_database ? {
    instance     = aws_db_instance.this[0].identifier
    host         = aws_db_instance.this[0].address
    port         = aws_db_instance.this[0].port
    region       = var.region
    users        = local.database_users
    admin_user   = aws_db_instance.this[0].username
    admin_secret = aws_db_instance.this[0].master_user_secret[0].secret_arn
  } : null
}

output "prometheus" {
  value = var.amazon_prometheus ? {
    remote_write = "${aws_prometheus_workspace.this[0].prometheus_endpoint}api/v1/remote_write"
    alertmanager = "${aws_prometheus_workspace.this[0].prometheus_endpoint}alertmanager/"
    alerts_topic = aws_sns_topic.alerts[0].arn
    region       = var.region
  } : null
}
