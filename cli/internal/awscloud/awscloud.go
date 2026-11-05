// SPDX-License-Identifier: MIT

// Package awscloud is what an aws install needs from the AWS CLI, run as you
// (your profile's short-lived credentials): who you are, the cluster's
// credentials for kubectl, a short-lived ECR sign-in for Docker, the
// module's inputs, and the cleanup a destroy needs outside OpenTofu's state.
package awscloud

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/rburns629/vennir/cli/internal/cluster"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/run"
	"github.com/rburns629/vennir/cli/internal/tools"
)

// args adds the config's profile and region to an aws command.
func args(c *config.Config, a ...string) []string {
	if c.AWS.Profile != "" {
		a = append(a, "--profile", c.AWS.Profile)
	}
	return append(a, "--region", c.AWS.Region, "--output", "json")
}

// Args is args for other packages: an aws command with the config's
// profile and region.
func Args(c *config.Config) func(a ...string) []string {
	return func(a ...string) []string { return args(c, a...) }
}

// Identity is who the profile signs in as.
type Identity struct {
	Account string `json:"Account"`
	Arn     string `json:"Arn"`
}

// State is what AWS says about you and the cluster.
type State struct {
	Identity      Identity
	ClusterStatus string // ACTIVE, CREATING, ... or "" if it doesn't exist
	Problems      []string
	// Warnings don't stop an apply (the chat's model not authorized yet).
	Warnings []string
}

// Inspect checks the profile signs in, and whether the cluster exists.
func Inspect(ctx context.Context, r *run.Runner, c *config.Config) State {
	var s State
	out, err := r.Output(ctx, "aws", args(c, "sts", "get-caller-identity")...)
	if err != nil {
		hint := "`aws login`"
		if c.AWS.Profile != "" {
			hint = "`aws login --profile " + c.AWS.Profile + "`"
		}
		s.Problems = append(s.Problems, "can't sign in to AWS ("+err.Error()+"): "+hint+", or `aws sso login`")
		return s
	}
	if err := json.Unmarshal([]byte(out), &s.Identity); err != nil {
		s.Problems = append(s.Problems, err.Error())
		return s
	}
	// One regional call: an organization's policy may deny the region
	// (a region restriction), which would otherwise surface halfway
	// through OpenTofu's plan. The cluster and the chat's model are asked
	// about at the same time.
	var regionErr error
	var chat string
	run.Together(
		func() {
			_, regionErr = r.Output(ctx, "aws", args(c, "ec2", "describe-availability-zones", "--query", "AvailabilityZones[0].ZoneName")...)
		},
		func() {
			if out, err := r.Output(ctx, "aws", args(c, "eks", "describe-cluster", "--name", c.Cluster.Name, "--query", "cluster.status")...); err == nil {
				s.ClusterStatus = strings.Trim(strings.TrimSpace(out), `"`)
			}
		},
		func() { chat = chatWarning(ctx, r, c) },
	)
	if regionErr != nil {
		if strings.Contains(regionErr.Error(), "service control policy") {
			s.Problems = append(s.Problems, fmt.Sprintf("your AWS organization's policy (an SCP) denies %s to this account: choose a region it allows (`vennir config set aws.region <region>`), or have the organization's management account allow it", c.AWS.Region))
		} else {
			s.Problems = append(s.Problems, fmt.Sprintf("can't use %s: %v", c.AWS.Region, regionErr))
		}
		s.ClusterStatus = ""
		return s
	}
	if chat != "" {
		s.Warnings = append(s.Warnings, chat)
	}
	return s
}

// chatWarning is what's wrong with the console's chat on Bedrock, if
// anything: access to a model can be refused or withdrawn after init.
func chatWarning(ctx context.Context, r *run.Runner, c *config.Config) string {
	if !c.ChatOnBedrock() {
		return ""
	}
	model := c.ChatModel()
	authorized, err := BedrockAuthorized(ctx, r, c, model)
	switch {
	case err != nil:
		return fmt.Sprintf("couldn't ask Amazon Bedrock whether this account may use %s, the chat's model: %v", model, err)
	case !authorized:
		return fmt.Sprintf("this account isn't authorized for %s in Amazon Bedrock, so the console's chat fails: request access (Bedrock console: Model catalog, the model), have an admin answer with an Anthropic API key (Admin, Chat), or `vennir config set chat.off true`", model)
	}
	return ""
}

// Credentials adds the cluster to your kubeconfig (as cluster.Context, which
// signs in with your profile), and puts your current context back.
func Credentials(ctx context.Context, r *run.Runner, c *config.Config) error {
	previous, _ := r.Output(ctx, "kubectl", "config", "current-context")
	if err := r.Run(ctx, "aws", args(c, "eks", "update-kubeconfig", "--name", c.Cluster.Name, "--alias", cluster.Context(c))...); err != nil {
		return err
	}
	if previous = strings.TrimSpace(previous); previous != "" && previous != cluster.Context(c) {
		return r.Run(ctx, "kubectl", "config", "use-context", previous)
	}
	return nil
}

// DockerLogin signs Docker in to an ECR registry with a short-lived
// password (12 hours), passed on stdin.
func DockerLogin(ctx context.Context, r *run.Runner, c *config.Config, host string) error {
	password, err := r.Output(ctx, "aws", args(c, "ecr", "get-login-password")...)
	if err != nil {
		return err
	}
	return r.RunInput(ctx, password, "docker", "login", "--username", "AWS", "--password-stdin", host)
}

// Registry is the account's ECR registry host.
func Registry(account string, c *config.Config) string {
	return fmt.Sprintf("%s.dkr.ecr.%s.amazonaws.com", account, c.AWS.Region)
}

// PlatformPrefix is the ECR prefix for platform images built from source
// ("" when installing a release).
func PlatformPrefix(c *config.Config) string {
	if c.Vennir != "source" {
		return ""
	}
	return c.Cluster.Name + "-platform"
}

// GitHubProvider is the account's GitHub OIDC provider's ARN for the
// module to use, or "" when it has none yet, for the module to make. An
// account has at most one, which every install in it uses.
func GitHubProvider(ctx context.Context, r *run.Runner, c *config.Config) (string, error) {
	out, err := r.Output(ctx, "aws", args(c, "iam", "list-open-id-connect-providers")...)
	if err != nil {
		return "", err
	}
	var list struct {
		OpenIDConnectProviderList []struct{ Arn string } `json:"OpenIDConnectProviderList"`
	}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return "", err
	}
	for _, p := range list.OpenIDConnectProviderList {
		if strings.HasSuffix(p.Arn, "/token.actions.githubusercontent.com") {
			return p.Arn, nil
		}
	}
	return "", nil
}

// Vars are the module's inputs, from the config.
func Vars(c *config.Config, deleteData bool, githubProvider string) map[string]any {
	return map[string]any{
		"profile":           c.AWS.Profile,
		"region":            c.AWS.Region,
		"name":              c.Cluster.Name,
		"mode":              c.Cluster.Mode,
		"size":              c.Size,
		"namespace":         c.Namespace,
		"task_registry":     c.TaskImages.Name,
		"platform_registry": PlatformPrefix(c),
		// A managed database backs itself up: no bucket, no backup Jobs.
		"backups":                    c.Database.Backups.Enabled && c.Database.Type != "managed",
		"managed_database":           c.Database.Type == "managed",
		"database_high_availability": c.Database.Type == "managed" && c.Database.HighAvailability,
		"backup_retention_days":      c.Database.Backups.RetentionDays,
		"logs":                       c.Logs.Enabled,
		"log_search_days":            c.Logs.SearchDays,
		"log_keep_days":              c.Logs.KeepDays,
		"audit_export":               c.Audit.Export,
		"audit_keep_days":            c.Audit.KeepDays,
		"audit_lock":                 c.Audit.Lock,
		"delete_data":                deleteData,
		"catalog_repository":         c.Catalog.Repo(),
		"signing":                    signingOrNone(c.ModuleSigning()),
		"kubernetes_version":         KubernetesVersion,
		"console_zone":               consoleZone(c),
		"console_hostname":           c.Console.Hostname,
		"step_headroom":              c.StepHeadroom,
		"github_oidc_provider_arn":   githubProvider,
		"catalog_subject_prefix":     c.Catalog.SubjectPrefix,
		"catalog_repository_id":      c.Catalog.RepositoryID,
		"catalog_owner_id":           c.Catalog.OwnerID,
		"chat_model":                 chatModel(c),
		"amazon_prometheus":          c.Monitoring.Enabled && c.Monitoring.ProviderName() == "amazon",
		"alert_email":                alertEmail(c),
	}
}

// alertEmail is subscribed to the alerts' topic with Amazon Managed
// Prometheus, or "".
func alertEmail(c *config.Config) string {
	if !c.Monitoring.Enabled || c.Monitoring.ProviderName() != "amazon" {
		return ""
	}
	return c.Monitoring.AlertEmail
}

// chatModel is the Bedrock model the console may call, or "" with chat off.
func chatModel(c *config.Config) string {
	if !c.ChatOnBedrock() {
		return ""
	}
	return c.ChatModel()
}

// DeleteTaskRepositories deletes the ECR repositories under the task
// prefix (ECR made them on push, outside OpenTofu's state), images and all.
func DeleteTaskRepositories(ctx context.Context, r *run.Runner, c *config.Config) error {
	out, err := r.Output(ctx, "aws", args(c, "ecr", "describe-repositories", "--query", "repositories[].repositoryName")...)
	if err != nil {
		return err
	}
	var names []string
	if err := json.Unmarshal([]byte(out), &names); err != nil {
		return err
	}
	for _, name := range names {
		if strings.HasPrefix(name, c.TaskImages.Name+"/") {
			if _, err := r.Output(ctx, "aws", args(c, "ecr", "delete-repository", "--repository-name", name, "--force")...); err != nil {
				return err
			}
		}
	}
	return nil
}

// KubernetesVersion is what the module runs, and the Cluster Autoscaler
// (standard mode) is matched to.
const KubernetesVersion = "1.36"

// The Cluster Autoscaler's image for KubernetesVersion (standard mode),
// pinned (its chart's default is an older release; the chart is pinned in
// tools).
const autoscalerImage = "v1.36.1@sha256:461388d03eb5b55db58941ee7a81d9a619dd15302b01cbab9f5a9946715994b4"

// InstallAutoscaler installs the Cluster Autoscaler (standard mode), which
// grows and shrinks the node groups, the steps' from zero. It signs in as
// the module's autoscaler role (EKS Pod Identity, by its ServiceAccount).
func InstallAutoscaler(ctx context.Context, r *run.Runner, c *config.Config) error {
	chart, done, err := tools.PullChart(ctx, r, "cluster-autoscaler")
	if err != nil {
		return err
	}
	defer done()
	return r.Run(ctx, "helm", "upgrade", "--install", "cluster-autoscaler", chart,
		"--kube-context", cluster.Context(c), "--namespace", "kube-system",
		"--set", "autoDiscovery.clusterName="+c.Cluster.Name,
		"--set", "awsRegion="+c.AWS.Region,
		"--set", "rbac.serviceAccount.name=cluster-autoscaler",
		"--set", "image.tag="+autoscalerImage,
		// Steps' nodes go a few minutes after their last step.
		"--set", "extraArgs.scale-down-unneeded-time=5m",
		// And not ten minutes after any scale-up (the default) before that.
		"--set", "extraArgs.scale-down-delay-after-add=5m",
		"--set", "extraArgs.balance-similar-node-groups=true",
		"--wait", "--timeout", "5m")
}

// InCluster is what the cluster needs before the charts. Auto Mode: a
// default StorageClass (its EBS driver ships none), its network policy
// controller turned on (off by default, and every NetworkPolicy the charts
// and the console write depends on it), and a node pool for steps (Spot
// unless the size is scaled), tainted so only steps land on it, empty when
// nothing runs. Standard mode: a default StorageClass for the EBS CSI
// add-on (its steps group comes from the module).
func InCluster(mode string, spot bool) string {
	if mode == "standard" {
		return `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: vennir-gp3
  labels:
    app.kubernetes.io/managed-by: vennir
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  encrypted: "true"
`
	}
	capacity := `["spot", "on-demand"]`
	if !spot {
		capacity = `["on-demand"]`
	}
	return `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: vennir-gp3
  labels:
    app.kubernetes.io/managed-by: vennir
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.eks.amazonaws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  encrypted: "true"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: amazon-vpc-cni
  namespace: kube-system
data:
  enable-network-policy-controller: "true"
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: vennir-steps
  labels:
    app.kubernetes.io/managed-by: vennir
spec:
  template:
    metadata:
      labels:
        vennir.dev/pool: steps
    spec:
      nodeClassRef:
        group: eks.amazonaws.com
        kind: NodeClass
        name: default
      taints:
        - key: vennir.dev/steps
          value: "true"
          effect: NoSchedule
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ` + capacity + `
        - key: eks.amazonaws.com/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
`
}

func consoleZone(c *config.Config) string {
	if !c.Console.Public {
		return ""
	}
	return c.Console.Zone
}

// IngressClass is Auto Mode's load balancer class for the console: an
// internet-facing Application Load Balancer.
const IngressClass = `apiVersion: eks.amazonaws.com/v1
kind: IngressClassParams
metadata:
  name: vennir-alb
  labels:
    app.kubernetes.io/managed-by: vennir
spec:
  scheme: internet-facing
---
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: vennir-alb
  labels:
    app.kubernetes.io/managed-by: vennir
spec:
  controller: eks.amazonaws.com/alb
  parameters:
    apiGroup: eks.amazonaws.com
    kind: IngressClassParams
    name: vennir-alb
`

// CertificateStatus is an ACM certificate's status (ISSUED,
// PENDING_VALIDATION, ...).
func CertificateStatus(ctx context.Context, r *run.Runner, c *config.Config, arn string) string {
	out, err := r.Output(ctx, "aws", args(c, "acm", "describe-certificate", "--certificate-arn", arn, "--query", "Certificate.Status")...)
	if err != nil {
		return ""
	}
	return strings.Trim(strings.TrimSpace(out), `"`)
}

// LoadBalancerZone is a load balancer's DNS name's hosted zone (for an alias).
func LoadBalancerZone(ctx context.Context, r *run.Runner, c *config.Config, dnsName string) (string, error) {
	out, err := r.Output(ctx, "aws", args(c, "elbv2", "describe-load-balancers",
		"--query", "LoadBalancers[?DNSName=='"+dnsName+"'].CanonicalHostedZoneId | [0]")...)
	if err != nil {
		return "", err
	}
	zone := strings.Trim(strings.TrimSpace(out), `"`)
	if zone == "" || zone == "null" {
		return "", fmt.Errorf("no load balancer named %s", dnsName)
	}
	return zone, nil
}

// PointAt makes host an alias of a load balancer in the zone.
func PointAt(ctx context.Context, r *run.Runner, c *config.Config, zoneID, host, lbName, lbZone string) error {
	change, _ := json.Marshal(map[string]any{"Changes": []map[string]any{{
		"Action": "UPSERT",
		"ResourceRecordSet": map[string]any{
			"Name": host, "Type": "A",
			"AliasTarget": map[string]any{"HostedZoneId": lbZone, "DNSName": lbName, "EvaluateTargetHealth": false},
		},
	}}})
	_, err := r.Output(ctx, "aws", args(c, "route53", "change-resource-record-sets", "--hosted-zone-id", zoneID, "--change-batch", string(change))...)
	return err
}

// LoadBalancersIn lists the load balancers in a VPC (the console's, made by
// Auto Mode outside OpenTofu's state).
func LoadBalancersIn(ctx context.Context, r *run.Runner, c *config.Config, vpcCIDR string) ([]string, error) {
	vpc, err := r.Output(ctx, "aws", args(c, "ec2", "describe-vpcs", "--filters", "Name=cidr,Values="+vpcCIDR,
		"Name=tag:vennir-environment,Values="+c.Cluster.Name, "--query", "Vpcs[0].VpcId")...)
	if err != nil {
		return nil, err
	}
	vpc = strings.Trim(strings.TrimSpace(vpc), `"`)
	if vpc == "" || vpc == "null" {
		return nil, nil
	}
	out, err := r.Output(ctx, "aws", args(c, "elbv2", "describe-load-balancers", "--query", "LoadBalancers[?VpcId=='"+vpc+"'].LoadBalancerName")...)
	if err != nil {
		return nil, err
	}
	var names []string
	_ = json.Unmarshal([]byte(out), &names)
	return names, nil
}

func signingOrNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

// SigningPublicKey is the catalog signing key's public half as PEM (KMS
// gives it as base64 DER), read as you: only it is needed to verify.
func SigningPublicKey(ctx context.Context, r *run.Runner, c *config.Config, key string) (string, error) {
	arn := strings.TrimPrefix(key, "awskms:///")
	if arn == key || !strings.HasPrefix(arn, "arn:") {
		return "", fmt.Errorf("%q isn't an AWS KMS key", key)
	}
	out, err := r.Output(ctx, "aws", args(c, "kms", "get-public-key", "--key-id", arn, "--query", "PublicKey")...)
	if err != nil {
		return "", err
	}
	pem, err := publicKeyPEM(out)
	if err != nil {
		return "", fmt.Errorf("AWS KMS's public key for %s: %w", key, err)
	}
	return pem, nil
}

// publicKeyPEM turns `aws kms get-public-key --query PublicKey` (JSON: a
// quoted base64 DER string) into PEM.
func publicKeyPEM(out string) (string, error) {
	var der string
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &der); err != nil {
		return "", err
	}
	if _, err := base64.StdEncoding.DecodeString(der); err != nil || der == "" {
		return "", fmt.Errorf("not base64 DER")
	}
	var b strings.Builder
	b.WriteString("-----BEGIN PUBLIC KEY-----\n")
	for len(der) > 64 {
		b.WriteString(der[:64] + "\n")
		der = der[64:]
	}
	b.WriteString(der + "\n-----END PUBLIC KEY-----\n")
	return b.String(), nil
}

// LeftVolumes are EBS volumes a namespace's claims made that nothing has
// attached: what a cluster deleted without its volume claims leaves. Every
// install's namespace is vennir-system by default, and a sleeping install's
// database volume is unattached too, so they're told apart by the cluster
// the EBS driver tagged them with: mine name this cluster, unknown name
// none (to check by hand), and another cluster's aren't returned.
func LeftVolumes(ctx context.Context, r *run.Runner, c *config.Config, namespace string) (mine, unknown []string, err error) {
	out, err := r.Output(ctx, "aws", args(c, "ec2", "describe-volumes", "--filters",
		"Name=tag:kubernetes.io/created-for/pvc/namespace,Values="+namespace, "Name=status,Values=available",
		"--query", "Volumes[].{id: VolumeId, tags: Tags}")...)
	if err != nil {
		return nil, nil, err
	}
	return volumesOf(out, c.Cluster.Name)
}

// volumesOf sorts describe-volumes' answer by the cluster each volume's
// tags name: the EBS CSI driver's kubernetes.io/cluster/<name> and
// KubernetesCluster (with its cluster id set), and Auto Mode's
// eks:eks-cluster-name.
func volumesOf(out, cluster string) (mine, unknown []string, err error) {
	var vols []struct {
		ID   string `json:"id"`
		Tags []struct{ Key, Value string }
	}
	if err := json.Unmarshal([]byte(out), &vols); err != nil {
		return nil, nil, fmt.Errorf("describe-volumes' answer: %w", err)
	}
	for _, v := range vols {
		var named []string
		for _, t := range v.Tags {
			switch {
			case strings.HasPrefix(t.Key, "kubernetes.io/cluster/"):
				named = append(named, strings.TrimPrefix(t.Key, "kubernetes.io/cluster/"))
			case t.Key == "KubernetesCluster" || t.Key == "eks:eks-cluster-name":
				named = append(named, t.Value)
			}
		}
		switch {
		case len(named) == 0:
			unknown = append(unknown, v.ID)
		case !slices.ContainsFunc(named, func(n string) bool { return n != cluster }):
			mine = append(mine, v.ID)
		}
	}
	return mine, unknown, nil
}

// BedrockAuthorized says whether this account may call model in Amazon
// Bedrock (an account's first use of Anthropic's models needs its use-case
// form accepted, and AWS may refuse it). An error, when it can't tell.
func BedrockAuthorized(ctx context.Context, r *run.Runner, c *config.Config, model string) (bool, error) {
	out, err := r.Output(ctx, "aws", args(c, "bedrock", "get-foundation-model-availability", "--model-id", model)...)
	if err != nil {
		return false, err
	}
	var v struct {
		AuthorizationStatus string `json:"authorizationStatus"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		return false, fmt.Errorf("Bedrock's answer: %w", err)
	}
	return v.AuthorizationStatus == "AUTHORIZED", nil
}

// RDSCertificates are Amazon's RDS certificate authorities for region
// (PEM): what a client checks an RDS instance's certificate against.
func RDSCertificates(ctx context.Context, region string) (string, error) {
	u := fmt.Sprintf("https://truststore.pki.rds.amazonaws.com/%s/%s-bundle.pem", region, region)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("Amazon's RDS certificates (%s): %w", u, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "BEGIN CERTIFICATE") {
		return "", fmt.Errorf("Amazon's RDS certificates (%s): %d, %v", u, resp.StatusCode, err)
	}
	return string(body), nil
}
