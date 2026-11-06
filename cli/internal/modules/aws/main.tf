# SPDX-License-Identifier: MIT

data "aws_caller_identity" "this" {}
data "aws_partition" "this" {}

data "aws_availability_zones" "this" {
  state = "available"
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  account   = data.aws_caller_identity.this.account_id
  partition = data.aws_partition.this.partition
  # EKS needs subnets in two zones.
  zones    = slice(data.aws_availability_zones.this.names, 0, 2)
  registry = "${local.account}.dkr.ecr.${var.region}.amazonaws.com"
  # Steps on Spot, except at `scaled` (on-demand).
  spot     = var.size != "scaled"
  auto     = var.mode == "auto"
  standard = var.mode == "standard"
  # Standard mode's groups by size: the platform's (always one node) and the
  # steps' (from zero; several types, so Spot has somewhere to come from).
  groups = {
    minimal   = { platform = "c6a.large", platform_max = 2, steps_max = 3 }
    resilient = { platform = "c6a.large", platform_max = 3, steps_max = 13 }
    scaled    = { platform = "m6a.large", platform_max = 4, steps_max = 50 }
    auto      = { platform = "c6a.large", platform_max = 3, steps_max = 13 }
  }[var.size]
}

# --- network: public subnets in two zones, no NAT gateway (it would cost
# more than a small install's nodes); nodes get public addresses, and their
# security group admits nothing from outside ---------------------------------

resource "aws_vpc" "this" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.zones[count.index]
  cidr_block              = cidrsubnet(aws_vpc.this.cidr_block, 4, count.index)
  map_public_ip_on_launch = true
  tags = {
    Name                                = "${var.name}-${local.zones[count.index]}"
    "kubernetes.io/role/elb"            = "1"
    "kubernetes.io/cluster/${var.name}" = "shared"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = var.name }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# --- the cluster: EKS Auto Mode -----------------------------------------------

data "aws_iam_policy_document" "cluster_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_trust.json
}

resource "aws_iam_role_policy_attachment" "cluster" {
  for_each = toset([
    "AmazonEKSClusterPolicy",
    "AmazonEKSComputePolicy",
    "AmazonEKSBlockStoragePolicy",
    "AmazonEKSLoadBalancingPolicy",
    "AmazonEKSNetworkingPolicy",
  ])
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/${each.value}"
}

data "aws_iam_policy_document" "node_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

# The nodes' own identity: joining the cluster and pulling images; in
# standard mode also the VPC CNI's addresses.
resource "aws_iam_role" "nodes" {
  name               = "${var.name}-nodes"
  assume_role_policy = data.aws_iam_policy_document.node_trust.json
}

resource "aws_iam_role_policy_attachment" "nodes" {
  for_each = toset(local.auto ? [
    "AmazonEKSWorkerNodeMinimalPolicy",
    "AmazonEC2ContainerRegistryPullOnly",
    ] : [
    "AmazonEKSWorkerNodePolicy",
    "AmazonEKS_CNI_Policy",
    "AmazonEC2ContainerRegistryPullOnly",
  ])
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/${each.value}"
}

resource "aws_eks_cluster" "this" {
  name     = var.name
  version  = var.kubernetes_version
  role_arn = aws_iam_role.cluster.arn

  # Who signs in: EKS access entries; you (who ran this) as admin.
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }
  # Auto Mode runs CoreDNS, kube-proxy, the VPC CNI and the EBS driver
  # itself; standard mode gets them as EKS add-ons, below.
  bootstrap_self_managed_addons = false

  dynamic "compute_config" {
    for_each = local.auto ? [1] : []
    content {
      enabled       = true
      node_pools    = ["general-purpose", "system"]
      node_role_arn = aws_iam_role.nodes.arn
    }
  }
  dynamic "kubernetes_network_config" {
    for_each = local.auto ? [1] : []
    content {
      elastic_load_balancing {
        enabled = true
      }
    }
  }
  dynamic "storage_config" {
    for_each = local.auto ? [1] : []
    content {
      block_storage {
        enabled = true
      }
    }
  }
  vpc_config {
    subnet_ids              = aws_subnet.public[*].id
    endpoint_public_access  = true
    endpoint_private_access = true
  }

  depends_on = [aws_iam_role_policy_attachment.cluster, aws_route_table_association.public]
}

# --- standard mode: node groups, add-ons, the Cluster Autoscaler's identity --

# In one zone: Postgres's EBS volume (and every other platform volume) lives
# in the zone its Pod first ran in and can't leave it, and the Cluster
# Autoscaler can't choose which zone a two-zone group's next node comes up
# in. With both zones, an upgrade that needed a second node could get it in
# the other zone, leaving Postgres Pending and Helm timing out. Steps keep
# both zones (no volumes; more places for Spot).
resource "aws_eks_node_group" "platform" {
  count           = local.standard ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "platform"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = [aws_subnet.public[0].id]
  instance_types  = [local.groups.platform]
  capacity_type   = "ON_DEMAND"
  disk_size       = 20
  scaling_config {
    min_size     = 1
    desired_size = 1
    max_size     = local.groups.platform_max
  }
  # The Cluster Autoscaler moves desired_size. An install made with the
  # group in both zones keeps it: changing a group's subnets replaces it,
  # and its volumes may be in the zone this one drops.
  lifecycle {
    ignore_changes = [scaling_config[0].desired_size, subnet_ids]
  }
  depends_on = [aws_iam_role_policy_attachment.nodes, aws_eks_addon.cni]
}

# Steps run here (the chart's scheduler.taskPlacement selects and tolerates
# it), from zero nodes; Spot except at `scaled`.
resource "aws_eks_node_group" "steps" {
  count           = local.standard ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "steps"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = aws_subnet.public[*].id
  instance_types  = ["c6a.large", "c5a.large", "c6i.large", "c7a.large", "m6a.large"]
  capacity_type   = local.spot ? "SPOT" : "ON_DEMAND"
  disk_size       = 20
  labels = {
    "vennir.dev/pool" = "steps"
  }
  taint {
    key    = "vennir.dev/steps"
    value  = "true"
    effect = "NO_SCHEDULE"
  }
  scaling_config {
    min_size     = var.step_headroom > 0 ? 1 : 0
    desired_size = var.step_headroom > 0 ? 1 : 0
    max_size     = local.groups.steps_max
  }
  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
  depends_on = [aws_iam_role_policy_attachment.nodes, aws_eks_addon.cni]
}

resource "aws_eks_addon" "cni" {
  for_each     = local.standard ? toset(["vpc-cni", "kube-proxy", "eks-pod-identity-agent"]) : toset([])
  cluster_name = aws_eks_cluster.this.name
  addon_name   = each.value
  # The VPC CNI enforces NetworkPolicies only when asked: every one the
  # charts and the console write (Postgres, kernel-api, each team's
  # default deny, no metadata server) depends on it. Auto Mode's is turned
  # on by a ConfigMap (awscloud.InCluster).
  configuration_values = each.value == "vpc-cni" ? jsonencode({ enableNetworkPolicy = "true" }) : null
}

# CoreDNS and the EBS driver run as Pods: after the platform's node.
resource "aws_eks_addon" "coredns" {
  count        = local.standard ? 1 : 0
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "coredns"
  depends_on   = [aws_eks_node_group.platform]
}

resource "aws_iam_role" "ebs" {
  count              = local.standard ? 1 : 0
  name               = "${var.name}-ebs"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

resource "aws_iam_role_policy_attachment" "ebs" {
  count      = local.standard ? 1 : 0
  role       = aws_iam_role.ebs[0].name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

resource "aws_eks_addon" "ebs" {
  count        = local.standard ? 1 : 0
  cluster_name = aws_eks_cluster.this.name
  addon_name   = "aws-ebs-csi-driver"
  # Volumes it makes carry this cluster's tag (kubernetes.io/cluster/<name>
  # and KubernetesCluster), so a destroy that can't reach the cluster tells
  # its left volumes from another install's (awscloud.LeftVolumes).
  configuration_values = jsonencode({ controller = { k8sTagClusterId = aws_eks_cluster.this.name } })
  pod_identity_association {
    role_arn        = aws_iam_role.ebs[0].arn
    service_account = "ebs-csi-controller-sa"
  }
  depends_on = [aws_eks_node_group.platform, aws_eks_addon.cni]
}

# The Cluster Autoscaler (vennir installs it): resize this cluster's
# groups only, by their tags.
resource "aws_iam_role" "autoscaler" {
  count              = local.standard ? 1 : 0
  name               = "${var.name}-autoscaler"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

data "aws_iam_policy_document" "autoscaler" {
  count = local.standard ? 1 : 0
  statement {
    actions = [
      "autoscaling:DescribeAutoScalingGroups", "autoscaling:DescribeAutoScalingInstances",
      "autoscaling:DescribeLaunchConfigurations", "autoscaling:DescribeScalingActivities",
      "autoscaling:DescribeTags", "ec2:DescribeImages", "ec2:DescribeInstanceTypes",
      "ec2:DescribeLaunchTemplateVersions", "ec2:GetInstanceTypesFromInstanceRequirements",
      "eks:DescribeNodegroup",
    ]
    resources = ["*"]
  }
  statement {
    actions   = ["autoscaling:SetDesiredCapacity", "autoscaling:TerminateInstanceInAutoScalingGroup"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/k8s.io/cluster-autoscaler/${var.name}"
      values   = ["owned"]
    }
  }
}

resource "aws_iam_role_policy" "autoscaler" {
  count  = local.standard ? 1 : 0
  name   = "resize-node-groups"
  role   = aws_iam_role.autoscaler[0].id
  policy = data.aws_iam_policy_document.autoscaler[0].json
}

resource "aws_eks_pod_identity_association" "autoscaler" {
  count           = local.standard ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "kube-system"
  service_account = "cluster-autoscaler"
  role_arn        = aws_iam_role.autoscaler[0].arn
  depends_on      = [aws_eks_addon.cni]
}

# --- registries: ECR creates a product's repository on its first push -------

resource "aws_ecr_repository_creation_template" "tasks" {
  prefix               = var.task_registry
  applied_for          = ["CREATE_ON_PUSH"]
  description          = "Vennir ${var.name}: the catalog's product images"
  image_tag_mutability = "MUTABLE"
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_repository" "platform" {
  # The gateway's too, whether or not it runs: an empty repository costs nothing.
  for_each             = var.platform_registry != "" ? toset(["execution-kernel", "execution-console", "execution-gateway"]) : toset([])
  name                 = "${var.platform_registry}/${each.value}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

# --- identities for Pods (EKS Pod Identity) ----------------------------------

data "aws_iam_policy_document" "pod_trust" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

# The console and its scan Jobs read the task registry (pinning digests,
# scanning what they pin).
resource "aws_iam_role" "console" {
  name               = "${var.name}-console"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

data "aws_iam_policy_document" "console" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability", "ecr:DescribeImages"]
    resources = ["arn:${local.partition}:ecr:${var.region}:${local.account}:repository/${var.task_registry}/*"]
  }
}

resource "aws_iam_role_policy" "console" {
  name   = "read-task-registry"
  role   = aws_iam_role.console.id
  policy = data.aws_iam_policy_document.console.json
}

resource "aws_eks_pod_identity_association" "console" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.namespace
  service_account = "console-execution-console"
  role_arn        = aws_iam_role.console.arn
}

# The scan Jobs run Trivy, a third-party image: a role of their own that
# reads the task registry and nothing else of the console's (its audit
# copy, its chat model).
resource "aws_iam_role" "scanner" {
  name               = "${var.name}-scanner"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

resource "aws_iam_role_policy" "scanner" {
  name   = "read-task-registry"
  role   = aws_iam_role.scanner.id
  policy = data.aws_iam_policy_document.console.json
}

resource "aws_eks_pod_identity_association" "scanner" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.namespace
  service_account = "console-execution-console-scanner"
  role_arn        = aws_iam_role.scanner.arn
}

# kernel policy (decision 27) reads the task registry, where the catalog's
# release is, to verify it itself, and with a managed database signs in as
# its own user, which kernel migrate gives only what it uses: a role of its
# own, not the kernel's.
resource "aws_iam_role" "policy" {
  name               = "${var.name}-policy"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

resource "aws_iam_role_policy" "policy" {
  name   = "read-task-registry"
  role   = aws_iam_role.policy.id
  policy = data.aws_iam_policy_document.console.json
}

resource "aws_eks_pod_identity_association" "policy" {
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.namespace
  service_account = "kernel-execution-kernel-policy"
  role_arn        = aws_iam_role.policy.arn
}

# With a managed database it was the kernel's role's: the same
# association, given its own role in place (a second one for a
# ServiceAccount is refused).
moved {
  from = aws_eks_pod_identity_association.database["kernel-execution-kernel-policy"]
  to   = aws_eks_pod_identity_association.policy
}

# Both were one for_each of the console's role: moved, not made again
# (a second association for a ServiceAccount is refused), the scanner's
# then given its own role in place.
moved {
  from = aws_eks_pod_identity_association.console["console-execution-console"]
  to   = aws_eks_pod_identity_association.console
}

moved {
  from = aws_eks_pod_identity_association.console["console-execution-console-scanner"]
  to   = aws_eks_pod_identity_association.scanner
}

# The chat agent: Claude in Amazon Bedrock (Messages API, the bedrock-mantle
# endpoint), this one model in this region, as the console's own role.
data "aws_iam_policy_document" "console_chat" {
  count = var.chat_model != "" ? 1 : 0
  statement {
    actions   = ["bedrock-mantle:CreateInference"]
    resources = ["arn:${local.partition}:bedrock-mantle:${var.region}:${local.account}:project/*"]
    condition {
      test     = "StringEquals"
      variable = "bedrock-mantle:Model"
      values   = [var.chat_model]
    }
  }
}

resource "aws_iam_role_policy" "console_chat" {
  count  = var.chat_model != "" ? 1 : 0
  name   = "call-chat-model"
  role   = aws_iam_role.console.id
  policy = data.aws_iam_policy_document.console_chat[0].json
}

# --- backups of the in-cluster database: one bucket, one writer --------------

resource "aws_s3_bucket" "backups" {
  count         = var.backups ? 1 : 0
  bucket        = "${var.name}-backups-${local.account}-${var.region}"
  force_destroy = var.delete_data
}

resource "aws_s3_bucket_public_access_block" "backups" {
  count                   = var.backups ? 1 : 0
  bucket                  = aws_s3_bucket.backups[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Versioned, so the writer can't destroy a dump it made before: its
# s3:PutObject over an existing key keeps the old one as a noncurrent
# version, which it has no permission to delete (as on gcp, where it may
# create objects but not replace them). Each backup has a key of its own,
# so there's normally no noncurrent version to keep.
resource "aws_s3_bucket_versioning" "backups" {
  count  = var.backups ? 1 : 0
  bucket = aws_s3_bucket.backups[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  count  = var.backups ? 1 : 0
  bucket = aws_s3_bucket.backups[0].id
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = var.backup_retention_days
    }
    # On a versioned bucket, expiring a dump only makes it noncurrent (a
    # delete marker goes on top); this deletes it. An overwritten dump is
    # noncurrent from the overwrite, and kept the full retention after it,
    # as on gcp it couldn't be touched. The price: S3 can't tell the two
    # apart, so every dump is kept, and billed, for twice the retention
    # (retention days current, then as many noncurrent).
    noncurrent_version_expiration {
      noncurrent_days = var.backup_retention_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.backups]
}

resource "aws_iam_role" "backup" {
  count              = var.backups ? 1 : 0
  name               = "${var.name}-backup"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

data "aws_iam_policy_document" "backup" {
  count = var.backups ? 1 : 0
  statement {
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.backups[0].arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups[0].arn]
  }
}

resource "aws_iam_role_policy" "backup" {
  count  = var.backups ? 1 : 0
  name   = "write-backups"
  role   = aws_iam_role.backup[0].id
  policy = data.aws_iam_policy_document.backup[0].json
}

resource "aws_eks_pod_identity_association" "backup" {
  count           = var.backups ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.namespace
  service_account = "vennir-pg-backup"
  role_arn        = aws_iam_role.backup[0].arn
}

# --- logs: Loki's bucket, archived after log_search_days --------------------
# Loki (single tenant) keeps chunks under fake/ and its index under index/;
# only chunks move to Glacier Instant Retrieval, which Loki still reads.

resource "aws_s3_bucket" "logs" {
  count         = var.logs ? 1 : 0
  bucket        = "${var.name}-logs-${local.account}-${var.region}"
  force_destroy = var.delete_data
}

resource "aws_s3_bucket_public_access_block" "logs" {
  count                   = var.logs ? 1 : 0
  bucket                  = aws_s3_bucket.logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  count  = var.logs ? 1 : 0
  bucket = aws_s3_bucket.logs[0].id
  rule {
    id     = "archive"
    status = "Enabled"
    filter {
      prefix = "fake/"
    }
    transition {
      days          = var.log_search_days
      storage_class = "GLACIER_IR"
    }
  }
  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = var.log_keep_days + 1
    }
  }
}

resource "aws_iam_role" "logs" {
  count              = var.logs ? 1 : 0
  name               = "${var.name}-logs"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

data "aws_iam_policy_document" "logs" {
  count = var.logs ? 1 : 0
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.logs[0].arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.logs[0].arn]
  }
}

resource "aws_iam_role_policy" "logs" {
  count  = var.logs ? 1 : 0
  name   = "loki-bucket"
  role   = aws_iam_role.logs[0].id
  policy = data.aws_iam_policy_document.logs[0].json
}

resource "aws_eks_pod_identity_association" "logs" {
  count           = var.logs ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.namespace
  service_account = "vennir-loki"
  role_arn        = aws_iam_role.logs[0].arn
}

# --- metrics: Amazon Managed Service for Prometheus -------------------------
# The bundled Prometheus (vennir-prometheus) scrapes in the cluster and
# writes every sample to this workspace, and sends its firing alerts to the
# workspace's Alertmanager, which publishes them to an SNS topic (an email
# subscribed to it when alert_email is set). Its role may do only those two
# things, on this workspace.

resource "aws_prometheus_workspace" "this" {
  count = var.amazon_prometheus ? 1 : 0
  alias = var.name
}

resource "aws_sns_topic" "alerts" {
  count = var.amazon_prometheus ? 1 : 0
  name  = "${var.name}-alerts"
}

data "aws_iam_policy_document" "alerts" {
  count = var.amazon_prometheus ? 1 : 0
  statement {
    actions   = ["sns:Publish", "sns:GetTopicAttributes"]
    resources = [aws_sns_topic.alerts[0].arn]
    principals {
      type        = "Service"
      identifiers = ["aps.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_prometheus_workspace.this[0].arn]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  count  = var.amazon_prometheus ? 1 : 0
  arn    = aws_sns_topic.alerts[0].arn
  policy = data.aws_iam_policy_document.alerts[0].json
}

resource "aws_sns_topic_subscription" "alert_email" {
  count     = var.amazon_prometheus && var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_prometheus_alert_manager_definition" "this" {
  count        = var.amazon_prometheus ? 1 : 0
  workspace_id = aws_prometheus_workspace.this[0].id
  definition   = <<-EOT
    alertmanager_config: |
      route:
        receiver: sns
        group_by: [alertname]
        repeat_interval: 4h
      receivers:
        - name: sns
          sns_configs:
            - topic_arn: ${aws_sns_topic.alerts[0].arn}
              sigv4:
                region: ${var.region}
              subject: '[{{ .Status | toUpper }}] {{ .CommonLabels.alertname }} (${var.name})'
  EOT
  depends_on   = [aws_sns_topic_policy.alerts]
}

resource "aws_iam_role" "prometheus" {
  count              = var.amazon_prometheus ? 1 : 0
  name               = "${var.name}-prometheus"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

data "aws_iam_policy_document" "prometheus" {
  count = var.amazon_prometheus ? 1 : 0
  statement {
    actions   = ["aps:RemoteWrite", "aps:CreateAlertManagerAlerts"]
    resources = [aws_prometheus_workspace.this[0].arn]
  }
}

resource "aws_iam_role_policy" "prometheus" {
  count  = var.amazon_prometheus ? 1 : 0
  name   = "prometheus-workspace"
  role   = aws_iam_role.prometheus[0].id
  policy = data.aws_iam_policy_document.prometheus[0].json
}

resource "aws_eks_pod_identity_association" "prometheus" {
  count           = var.amazon_prometheus ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.namespace
  service_account = "vennir-prometheus"
  role_arn        = aws_iam_role.prometheus[0].arn
}

# --- the audit log's write-once copy --------------------------------------
# Object Lock: every object kept audit_keep_days (governance; compliance
# when audit_lock, which nobody can shorten, the root account included).
# The console may only put new objects. Kept by destroy: it's the record.

resource "aws_s3_bucket" "audit" {
  count               = var.audit_export ? 1 : 0
  bucket              = "${var.name}-audit-${local.account}-${var.region}"
  object_lock_enabled = true
}

resource "aws_s3_bucket_public_access_block" "audit" {
  count                   = var.audit_export ? 1 : 0
  bucket                  = aws_s3_bucket.audit[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "audit" {
  count  = var.audit_export ? 1 : 0
  bucket = aws_s3_bucket.audit[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  count  = var.audit_export ? 1 : 0
  bucket = aws_s3_bucket.audit[0].id
  rule {
    default_retention {
      mode = var.audit_lock ? "COMPLIANCE" : "GOVERNANCE"
      days = var.audit_keep_days
    }
  }
  depends_on = [aws_s3_bucket_versioning.audit]
}

data "aws_iam_policy_document" "console_audit" {
  count = var.audit_export ? 1 : 0
  # Create-only: a put must carry If-None-Match: *, which S3 refuses for a
  # key that exists. Without it a put to an existing key would make a new
  # current version, leaving the locked original noncurrent.
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit[0].arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "s3:if-none-match"
      values   = ["*"]
    }
  }
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.audit[0].arn}/*"]
  }
  # Reading its copies back, to compare the database with them.
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.audit[0].arn]
  }
}

resource "aws_iam_role_policy" "console_audit" {
  count  = var.audit_export ? 1 : 0
  name   = "write-audit-copy"
  role   = aws_iam_role.console.id
  policy = data.aws_iam_policy_document.console_audit[0].json
}

# --- the cluster's own issuer, which IAM trusts for IRSA: a team's SecretStore
# signs in as a role only its eso-aws ServiceAccount may assume (EKS Pod
# Identity gives credentials to Pods, not to the tokens ESO asks for) --------

resource "aws_iam_openid_connect_provider" "cluster" {
  url            = aws_eks_cluster.this.identity[0].oidc[0].issuer
  client_id_list = ["sts.amazonaws.com"]
  tags           = { "vennir-environment" = var.name }
}

# --- the catalog's CI: pushes images from main, by GitHub's OIDC token -------

# The account has at most one, which every install in it uses: made here
# when it has none, and forgotten by vennir on the install's next run, so no
# install's destroy deletes it (writeAWSVars).
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.catalog_repository != "" && var.github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  catalog_subject = var.catalog_subject_prefix != "" ? var.catalog_subject_prefix : "repo:${var.catalog_repository}"
  # The subject's last claims, once vennir has read the repository's ids
  # and set its template to carry them (githost.SubjectClaimKeys).
  catalog_pinned  = var.catalog_repository_id != "" && var.catalog_owner_id != ""
  catalog_ids     = ":repository_owner_id:${var.catalog_owner_id}:repository_id:${var.catalog_repository_id}"
  github_provider = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : try(aws_iam_openid_connect_provider.github[0].arn, "")
}

data "aws_iam_policy_document" "publish_trust" {
  count = var.catalog_repository != "" ? 1 : 0
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_provider]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # main only, always. `vennir catalog create` sets the repository's
    # subject template to repo, context and ref, so a job in the
    # catalog-publish Environment names its branch too: whether or not the
    # Environment exists with its main-only rule, a branch's job can't match.
    # (The template-less form of a main job's subject is kept for a job
    # before the template takes effect: it names the branch.) Pull requests
    # (any fork's code) never match. GitHub's subject names the repository;
    # once vennir has read its ids, the template adds them (repository_owner_id,
    # repository_id) and only a subject ending in them is trusted, so a
    # repository renamed, or deleted and made again under its name by
    # someone else, can't match (nor can a template-less subject, which
    # carries no ids).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = local.catalog_pinned ? [
        "${local.catalog_subject}:environment:catalog-publish:ref:refs/heads/main${local.catalog_ids}",
        "${local.catalog_subject}:ref:refs/heads/main:ref:refs/heads/main${local.catalog_ids}",
        ] : [
        "${local.catalog_subject}:environment:catalog-publish:ref:refs/heads/main",
        "${local.catalog_subject}:ref:refs/heads/main:ref:refs/heads/main",
        "${local.catalog_subject}:ref:refs/heads/main",
      ]
    }
  }
}

resource "aws_iam_role" "publish" {
  count              = var.catalog_repository != "" ? 1 : 0
  name               = "${var.name}-publish"
  assume_role_policy = data.aws_iam_policy_document.publish_trust[0].json
}

data "aws_iam_policy_document" "publish" {
  count = var.catalog_repository != "" ? 1 : 0
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    # Creating a product's repository on its first push, and pushing to it.
    actions = [
      "ecr:CreateRepository", "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
      "ecr:DescribeImages", "ecr:DescribeRepositories", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload",
      "ecr:PutImage", "ecr:UploadLayerPart",
    ]
    resources = ["arn:${local.partition}:ecr:${var.region}:${local.account}:repository/${var.task_registry}/*"]
  }
}

resource "aws_iam_role_policy" "publish" {
  count  = var.catalog_repository != "" ? 1 : 0
  name   = "push-task-registry"
  role   = aws_iam_role.publish[0].id
  policy = data.aws_iam_policy_document.publish[0].json
}

# --- the console's public address: a Route 53 zone you delegate, and an ACM
# certificate validated through it ------------------------------------------

locals {
  console_host = var.console_zone == "" ? "" : (var.console_hostname != "" ? var.console_hostname : "console.${var.console_zone}")
}

resource "aws_route53_zone" "console" {
  count   = var.console_zone != "" ? 1 : 0
  name    = var.console_zone
  comment = "Vennir ${var.name}: the console's public address"
  # Records vennir adds (the load balancer's alias) go first on destroy.
  force_destroy = true
}

resource "aws_acm_certificate" "console" {
  count             = var.console_zone != "" ? 1 : 0
  domain_name       = local.console_host
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# ACM's validation record. ACM issues the certificate once the zone is
# delegated to Route 53 (vennir waits for it; OpenTofu doesn't).
resource "aws_route53_record" "console_validation" {
  for_each = var.console_zone != "" ? {
    for o in aws_acm_certificate.console[0].domain_validation_options : o.domain_name => o
  } : {}
  zone_id         = aws_route53_zone.console[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

# --- catalog signing (signing): a KMS key only the catalog's CI signs with,
# and policy-controller's identity, which reads signatures from the task
# registry and nothing else (verify: only the identity; another install's
# registry grants it read, as apply prints) ------------------------------------

data "aws_iam_policy_document" "signing_key" {
  count = var.signing == "kms" && var.catalog_repository != "" ? 1 : 0
  # The account administers the key (as any KMS key needs); it signs nothing.
  statement {
    sid = "Administer"
    actions = [
      "kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*",
      "kms:Disable*", "kms:Get*", "kms:Delete*", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
    ]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account}:root"]
    }
  }
  # Only the catalog's CI (its publish role, main only) signs.
  statement {
    sid       = "CatalogCISigns"
    actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.publish[0].arn]
    }
  }
}

resource "aws_kms_key" "signing" {
  count                    = var.signing == "kms" && var.catalog_repository != "" ? 1 : 0
  description              = "Vennir ${var.name}: signs the catalog's images and releases"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_P256"
  deletion_window_in_days  = 7
  policy                   = data.aws_iam_policy_document.signing_key[0].json
}

resource "aws_iam_role" "verifier" {
  count              = var.signing != "none" ? 1 : 0
  name               = "${var.name}-verifier"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

data "aws_iam_policy_document" "verifier" {
  count = var.signing != "none" ? 1 : 0
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability", "ecr:DescribeImages"]
    resources = ["arn:${local.partition}:ecr:${var.region}:${local.account}:repository/${var.task_registry}/*"]
  }
}

resource "aws_iam_role_policy" "verifier" {
  count  = var.signing != "none" ? 1 : 0
  name   = "read-task-registry"
  role   = aws_iam_role.verifier[0].id
  policy = data.aws_iam_policy_document.verifier[0].json
}

resource "aws_eks_pod_identity_association" "verifier" {
  count           = var.signing != "none" ? 1 : 0
  cluster_name    = aws_eks_cluster.this.name
  namespace       = "cosign-system"
  service_account = "policy-controller-webhook"
  role_arn        = aws_iam_role.verifier[0].arn
}

# --- a managed database: Amazon RDS for PostgreSQL --------------------------
# In the install's VPC with no public access, reachable only from the
# cluster's own security group; TLS forced. No passwords of Vennir's: the
# kernel, the console and the gateway each sign in as their own role (IAM
# database authentication, a 15-minute token their Pod Identity signs).
# RDS keeps its administrator's password in Secrets Manager itself (so it's
# in no state file), readable only by `kernel database-setup`'s role, which
# makes the databases and the services' users and opens each database to
# its service alone. Sized as the in-cluster Postgres is; RDS backs it up
# (daily, with point-in-time recovery) instead of the backup Jobs.

locals {
  database_class = {
    minimal   = { class = "db.t4g.small", max_connections = 100 }
    resilient = { class = "db.t4g.medium", max_connections = 200 }
    scaled    = { class = "db.m7g.large", max_connections = 300 }
    auto      = { class = "db.t4g.medium", max_connections = 200 }
  }[var.size]
  # Its users: made by database-setup, signed in to by IAM.
  database_users = { kernel = "vennir_kernel", console = "vennir_console", gateway = "vennir_gateway", policy = "vennir_kernel_policy" }
}

resource "aws_db_subnet_group" "this" {
  count      = var.managed_database ? 1 : 0
  name       = var.name
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_security_group" "database" {
  count       = var.managed_database ? 1 : 0
  name        = "${var.name}-database"
  description = "Vennir ${var.name}: Postgres, from the cluster only"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "database" {
  count                        = var.managed_database ? 1 : 0
  security_group_id            = aws_security_group.database[0].id
  referenced_security_group_id = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_parameter_group" "this" {
  count  = var.managed_database ? 1 : 0
  name   = var.name
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name         = "max_connections"
    value        = tostring(local.database_class.max_connections)
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "this" {
  count                               = var.managed_database ? 1 : 0
  identifier                          = var.name
  engine                              = "postgres"
  engine_version                      = "16"
  instance_class                      = local.database_class.class
  allocated_storage                   = 20
  max_allocated_storage               = 1000
  storage_type                        = "gp3"
  storage_encrypted                   = true
  db_subnet_group_name                = aws_db_subnet_group.this[0].name
  vpc_security_group_ids              = [aws_security_group.database[0].id]
  parameter_group_name                = aws_db_parameter_group.this[0].name
  publicly_accessible                 = false
  multi_az                            = var.database_high_availability
  iam_database_authentication_enabled = true
  username                            = "vennir_admin"
  manage_master_user_password         = true
  backup_retention_period             = min(var.backup_retention_days, 35)
  copy_tags_to_snapshot               = true
  auto_minor_version_upgrade          = true
  apply_immediately                   = true
  # Only when destroy is told to delete data (vennir destroy asks first).
  deletion_protection = !var.delete_data
  skip_final_snapshot = true
}

# The kernel's and the gateway's roles (the console's is above), and the
# administrator's; each may sign in as its own database user and no other.
resource "aws_iam_role" "kernel_db" {
  count              = var.managed_database ? 1 : 0
  name               = "${var.name}-kernel"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

resource "aws_iam_role" "gateway_db" {
  count              = var.managed_database ? 1 : 0
  name               = "${var.name}-gateway"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

resource "aws_iam_role" "database_admin" {
  count              = var.managed_database ? 1 : 0
  name               = "${var.name}-db-admin"
  assume_role_policy = data.aws_iam_policy_document.pod_trust.json
}

resource "aws_iam_role_policy" "database_connect" {
  for_each = var.managed_database ? {
    kernel  = aws_iam_role.kernel_db[0].id
    console = aws_iam_role.console.id
    gateway = aws_iam_role.gateway_db[0].id
    policy  = aws_iam_role.policy.id
  } : {}
  name = "connect-to-the-database"
  role = each.value
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "rds-db:connect"
      Resource = "arn:${local.partition}:rds-db:${var.region}:${local.account}:dbuser:${aws_db_instance.this[0].resource_id}/${local.database_users[each.key]}"
    }]
  })
}

resource "aws_iam_role_policy" "database_admin" {
  count = var.managed_database ? 1 : 0
  name  = "read-the-administrators-password"
  role  = aws_iam_role.database_admin[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_db_instance.this[0].master_user_secret[0].secret_arn
    }]
  })
}

# Which ServiceAccounts sign in as which role: every kernel Pod that
# connects (the scheduler, kernel-api and its migration, the sleeper), the
# gateway, and database-setup's Job. The console's and kernel policy's are
# bound above.
resource "aws_eks_pod_identity_association" "database" {
  for_each = var.managed_database ? {
    "kernel-execution-kernel"           = aws_iam_role.kernel_db[0].arn
    "kernel-execution-kernel-api"       = aws_iam_role.kernel_db[0].arn
    "kernel-execution-kernel-sleeper"   = aws_iam_role.kernel_db[0].arn
    "console-execution-console-gateway" = aws_iam_role.gateway_db[0].arn
    "vennir-db-admin"                   = aws_iam_role.database_admin[0].arn
  } : {}
  cluster_name    = aws_eks_cluster.this.name
  namespace       = var.namespace
  service_account = each.key
  role_arn        = each.value
}
