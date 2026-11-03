// SPDX-License-Identifier: MIT

// Package install installs Vertra's two Helm releases: the charts from a
// source checkout or a release, their images built from source (and loaded
// onto kind, or pushed to a registry) or the released ones, and the values
// vertra generates from the config, with the user's own values last.
package install

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/rburns629/vertra/cli/internal/cluster"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/gcp"
	"github.com/rburns629/vertra/cli/internal/plan"
	"github.com/rburns629/vertra/cli/internal/run"
	"github.com/rburns629/vertra/cli/internal/tools"
)

// Cloud is what a cloud target's OpenTofu module made, for the values.
type Cloud struct {
	Provider              string // gcp, aws
	TaskRegistry          string
	ConsoleServiceAccount string // gcp: the console's Google service account
	// ScannerServiceAccount: its scan Jobs' (gcp), reading the task
	// registry and nothing else; the console's, from a module before it.
	ScannerServiceAccount string
	BackupBucket          string
	BackupRegion          string // aws: the bucket's region
	// BackupServiceAccount is the cloud identity the backups run as (gcp);
	// on aws, EKS Pod Identity binds the role by ServiceAccount name.
	BackupServiceAccount string
	// Loki's bucket, its region (aws) and identity (gcp; on aws, Pod
	// Identity binds the role to LokiServiceAccountName).
	LogsBucket         string
	LogsRegion         string
	LogsServiceAccount string
	// The audit log's write-once copy: its bucket, and region (aws).
	AuditBucket string
	AuditRegion string
	// Amazon Managed Service for Prometheus (aws): where the bundled
	// Prometheus writes and sends alerts, signed in its region, and the SNS
	// topic its Alertmanager publishes them to.
	PrometheusRemoteWrite  string
	PrometheusAlertmanager string
	PrometheusRegion       string
	PrometheusAlertsTopic  string
	// The chart's scheduler.taskPlacement: where steps run (Spot, a pool).
	StepPlacement map[string]any
	// The chart's scheduler.capacityPlacements: where a step whose product
	// asks for spot or onDemand runs instead.
	CapacityPlacements map[string]any
	ClusterName        string
	ClusterLocation    string
	ClusterIssuer      string
	WorkloadPool       string
	// The console's public address (its global address's name and IP) and
	// hostname, when it's reached over HTTPS.
	ConsoleAddressName string
	ConsoleIP          string
	ConsoleHost        string
	// The catalog's federation: its CI's provider and identity.
	CatalogProvider       string
	CatalogServiceAccount string
	// Signing (config.Signing): the KMS key catalog CI signs with, as
	// cosign names it (kms), its public half (PEM, read at apply), and the
	// identity policy-controller reads signatures as (gcp: a service
	// account; aws: Pod Identity binds it by ServiceAccount name).
	SigningKey       string
	SigningPublicKey string
	SigningVerifier  string
	// aws: the console's certificate, its zone, and the VPC's range (where
	// the load balancer connects from).
	ConsoleCertificate string
	ConsoleZoneID      string
	ConsoleNameServers []string
	VPCCIDR            string
	// Database is the managed database, when database.type is managed.
	Database *ManagedDatabase
}

// googleFrontEnds are where Google's load balancers connect from.
var googleFrontEnds = []string{"35.191.0.0/16", "130.211.0.0/22"}

// ConsoleHostname is the console's public name: the configured one, or a
// nip.io name that resolves to its address by itself.
func ConsoleHostname(c *config.Config, ip string) string {
	if c.Console.Hostname != "" {
		return c.Console.Hostname
	}
	return "console." + strings.ReplaceAll(ip, ".", "-") + ".nip.io"
}

// certificateName is the console's Google-managed certificate.
const certificateName = "vertra-console"

// EnsureCertificate creates (or updates) the Google-managed certificate for
// the console's hostname. Google issues it once the name resolves to the
// load balancer: up to an hour.
func EnsureCertificate(ctx context.Context, r *run.Runner, c *config.Config, host string) error {
	manifest := fmt.Sprintf(`apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: %s
  namespace: %s
  labels:
    app.kubernetes.io/managed-by: vertra
spec:
  domains: [%q]
`, certificateName, c.Namespace, host)
	return r.RunInput(ctx, manifest, "kubectl", "--context", cluster.Context(c), "apply", "-f", "-")
}

// CertificateStatus is the console certificate's status (Active,
// Provisioning, ...), or "" without one.
func CertificateStatus(ctx context.Context, r *run.Runner, c *config.Config) string {
	out, _ := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"get", "managedcertificate", certificateName, "--ignore-not-found", "-o", "jsonpath={.status.certificateStatus}")
	return strings.TrimSpace(out)
}

// PrometheusServiceAccountName is the bundled Prometheus's ServiceAccount
// with Amazon Managed Prometheus (the console chart's
// monitoring.prometheus.serviceAccountName), bound to the module's role.
const PrometheusServiceAccountName = "vertra-prometheus"

// LokiServiceAccountName is the Kubernetes ServiceAccount Loki runs as (the
// console chart's logs.serviceAccountName), bound to the module's logs
// identity.
const LokiServiceAccountName = "vertra-loki"

// BackupServiceAccountName is the Kubernetes ServiceAccount the database
// backups run as (the kernel chart's backup.serviceAccountName), bound to
// the module's backup identity.
const BackupServiceAccountName = "vertra-pg-backup"

// Release names: fixed, so the console finds kernel-api's Service and the
// database Secret by name.
const (
	KernelRelease  = "kernel"
	ConsoleRelease = "console"
	// ReleaseCharts is where released charts are published.
	ReleaseCharts = "oci://ghcr.io/rburns629/vertra/charts"
)

// Chart is a chart's local directory (Dir), from a source checkout or, for
// a release, pulled from Remote at Version into the environment's
// directory. Installing from a directory gives the size presets
// (<chart>/sizes/) the same way either way.
type Chart struct {
	Dir     string
	Remote  string
	Version string
}

// Charts returns the kernel and console charts for a config; dir is the
// environment's directory.
func Charts(c *config.Config, dir string) (kernel, console Chart) {
	if c.Vertra == "source" {
		return Chart{Dir: filepath.Join(c.Source, "helm", "charts", "execution-kernel")},
			Chart{Dir: filepath.Join(c.Source, "helm", "charts", "execution-console")}
	}
	pulled := filepath.Join(dir, "charts", c.Vertra)
	return Chart{Dir: filepath.Join(pulled, "execution-kernel"), Remote: ReleaseCharts + "/execution-kernel", Version: c.Vertra},
		Chart{Dir: filepath.Join(pulled, "execution-console"), Remote: ReleaseCharts + "/execution-console", Version: c.Vertra}
}

// releaseChartSums are each released chart's SHA-256 (sha256sum's format:
// "<sum>  execution-kernel-0.8.0.tgz"), the package its release pushed. The
// release workflow adds its own to the vertra it builds, and to main in its
// pin pull request, so a vertra knows every release up to its own.
//
//go:embed release-charts.sha256
var releaseChartSums string

// releaseChartSum is a released chart's SHA-256, or "" for a version this
// vertra doesn't know.
func releaseChartSum(name, version string) string {
	for line := range strings.Lines(releaseChartSums) {
		if sum, file, ok := strings.Cut(strings.TrimSpace(line), "  "); ok && file == name+"-"+version+".tgz" {
			return sum
		}
	}
	return ""
}

// KnownRelease refuses a release whose charts this vertra can't check.
func KnownRelease(version string) error {
	for _, name := range []string{"execution-kernel", "execution-console"} {
		if releaseChartSum(name, version) == "" {
			return fmt.Errorf("this vertra has no recorded checksums for release %s's charts, so it can't check them: use that release's vertra, or a newer one (`vertra version`)", version)
		}
	}
	return nil
}

// KnownReleases are the releases whose charts this vertra can check.
func KnownReleases() []string {
	var out []string
	for line := range strings.Lines(releaseChartSums) {
		if _, file, ok := strings.Cut(strings.TrimSpace(line), "  "); ok {
			if v, ok := strings.CutPrefix(strings.TrimSuffix(file, ".tgz"), "execution-kernel-"); ok && KnownRelease(v) == nil {
				out = append(out, v)
			}
		}
	}
	return out
}

// Pull fetches a released chart into its Dir: the package, kept beside it
// once per version, is checked against the release's SHA-256 on each apply
// (and pulled again if it doesn't match, or a vertra before it kept none),
// and Dir unpacked afresh from it, so what's installed is only ever the
// checked package.
func Pull(ctx context.Context, r *run.Runner, chart Chart) error {
	if chart.Remote == "" {
		return nil
	}
	name, parent := filepath.Base(chart.Dir), filepath.Dir(chart.Dir)
	sum := releaseChartSum(name, chart.Version)
	if sum == "" {
		return KnownRelease(chart.Version)
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(parent, ".pull-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	archive := filepath.Join(parent, name+"-"+chart.Version+".tgz")
	if tools.CheckSHA256(archive, sum) != nil {
		pulled, err := tools.PullChartTo(ctx, r, tmp, sum, chart.Remote, "--version", chart.Version)
		if err != nil {
			return err
		}
		if err := os.Rename(pulled, archive); err != nil {
			return err
		}
	}
	unpacked := filepath.Join(tmp, "unpacked")
	if err := tools.Untar(archive, unpacked); err != nil {
		return err
	}
	if err := os.RemoveAll(chart.Dir); err != nil {
		return err
	}
	return os.Rename(filepath.Join(unpacked, name), chart.Dir)
}

// SizeValues is the chart's preset for the config's size.
func SizeValues(chart Chart, size string) string {
	return filepath.Join(chart.Dir, "sizes", size+".yaml")
}

// Images says which platform images the releases run. Empty Repository
// means the chart's default (the release's own images).
type Images struct {
	Kernel, Console, Gateway string // repositories
	Tag                      string
	// Build: built from Source by this apply.
	Build bool
	// Push: pushed to a registry (an existing cluster) rather than loaded
	// onto kind's node.
	Push bool
}

// ImagesFor decides the platform images; a source build gets a fresh tag,
// so each apply rolls the Pods onto what it just built.
func ImagesFor(c *config.Config, now time.Time) Images {
	if c.Vertra != "source" {
		return Images{}
	}
	tag := "src-" + now.UTC().Format("20060102-150405")
	if c.Target == "kind" {
		return withGateway(c, Images{Kernel: "execution-kernel", Console: "execution-console", Tag: tag, Build: true}, "execution-gateway")
	}
	prefix := strings.TrimSuffix(c.PlatformImages.Registry, "/")
	if c.Target == "gcp" {
		prefix = gcp.PlatformRegistry(c)
	}
	return withGateway(c, Images{Kernel: prefix + "/execution-kernel", Console: prefix + "/execution-console", Tag: tag, Build: true, Push: true},
		prefix+"/execution-gateway")
}

// withGateway adds the gateway's image when the install runs it.
func withGateway(c *config.Config, img Images, repository string) Images {
	if c.Gateway.Enabled {
		img.Gateway = repository
	}
	return img
}

// Names are the images it builds, for the approval screen.
func (img Images) Names() string {
	names := []string{"execution-kernel", "execution-console"}
	if img.Gateway != "" {
		names = append(names, "execution-gateway")
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

// BuildImages builds both images from source, then loads them onto kind's
// node or pushes them.
func BuildImages(ctx context.Context, r *run.Runner, c *config.Config, img Images) error {
	for _, part := range []struct{ repo, dir string }{
		{img.Kernel, "kernel"}, {img.Console, "console"}, {img.Gateway, "gateway"},
	} {
		if part.repo == "" {
			continue
		}
		ref := part.repo + ":" + img.Tag
		args := []string{"build", "-t", ref}
		if img.Push {
			// The nodes', whatever this machine is.
			args = append(args, "--platform", NodePlatform(ctx, r, c))
		}
		if err := r.Run(ctx, "docker", append(args, filepath.Join(c.Source, part.dir))...); err != nil {
			return err
		}
		if img.Push {
			if err := r.Run(ctx, "docker", "push", ref); err != nil {
				return err
			}
		} else if err := r.Run(ctx, "kind", "load", "docker-image", ref, "--name", c.Cluster.Name); err != nil {
			return err
		}
	}
	return nil
}

// NodePlatform is what to build for: a cloud's nodes are x86; an existing
// cluster's are whatever its first node says (Graviton, Ampere and kind on
// Apple silicon are arm64), x86 when it can't be read.
func NodePlatform(ctx context.Context, r *run.Runner, c *config.Config) string {
	if c.Target != "existing" {
		return "linux/amd64"
	}
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "get", "nodes",
		"-o", "jsonpath={.items[0].status.nodeInfo.architecture}")
	if arch := strings.TrimSpace(out); err == nil && (arch == "amd64" || arch == "arm64") {
		return "linux/" + arch
	}
	return "linux/amd64"
}

// AlwaysOn is how many copies of the console and kernel-api the config
// keeps running when it doesn't scale down, or 0 to leave it to the size.
func AlwaysOn(c *config.Config) int {
	if c.ScaleDown.Enabled {
		return 0
	}
	return c.MinReplicas
}

// copies is the console's or kernel-api's count over the size preset: the
// always-on copies, as replicas or (auto) as the autoscaler's minimum.
func copies(c *config.Config) map[string]any {
	n := AlwaysOn(c)
	switch {
	case n == 0:
		return map[string]any{}
	case c.Size == "auto":
		return map[string]any{"autoscaling": map[string]any{"minReplicas": n, "maxReplicas": max(n, 3)}}
	default:
		return map[string]any{"replicaCount": n}
	}
}

// IdleMinutes is scale-down's idle period in whole minutes (at least one).
func IdleMinutes(c *config.Config) int {
	d, err := time.ParseDuration(c.ScaleDown.IdleAfter)
	if err != nil {
		return 120
	}
	return max(1, int(d.Minutes()))
}

// gibibytes is a volume size such as "10Gi" in GiB; 0 for another unit.
func gibibytes(size string) float64 {
	var n float64
	if _, err := fmt.Sscanf(size, "%gGi", &n); err != nil {
		return 0
	}
	return n
}

// KeepsVolume says the database volume stays at its current size (volume,
// "" when there's none yet) rather than the size's: when it's larger (a
// volume can't shrink), and on kind (whose volumes can't grow).
func KeepsVolume(c *config.Config, volume string) bool {
	return volume != "" && (c.Target == "kind" || gibibytes(volume) > plan.Floors[c.Size].VolumeGiB)
}

// KernelValues are the values vertra generates for the kernel chart.
// volume, when set, is the database volume's current size: kept when it's
// larger than the size's (a volume can't shrink), and on kind (whose
// volumes can't grow); otherwise the size's grows it.
func KernelValues(c *config.Config, img Images, volume string, cloud *Cloud) map[string]any {
	postgres := map[string]any{
		// One Postgres for both databases, each with its own role.
		"consoleDatabase": map[string]any{"enabled": true},
	}
	if KeepsVolume(c, volume) {
		postgres["persistence"] = map[string]any{"size": volume}
	}
	scaleDown := map[string]any{"enabled": c.ScaleDown.Enabled}
	if c.ScaleDown.Enabled {
		scaleDown["idleAfterMinutes"] = IdleMinutes(c)
		scaleDown["schedule"] = c.ScaleDown.Schedule
		scaleDown["consoleFullname"] = ConsoleRelease + "-execution-console"
	}
	v := map[string]any{
		"api":            copies(c),
		"postgres":       postgres,
		"backup":         map[string]any{"enabled": false},
		"imagePolicy":    map[string]any{"sourceRegistry": c.TaskImages.Registry},
		"dispatchPolicy": map[string]any{"allowReleaseNamespace": false},
		"scaleDown":      scaleDown,
		"stepHeadroom":   map[string]any{"replicas": c.StepHeadroom},
	}
	if img.Kernel != "" {
		v["image"] = map[string]any{"repository": img.Kernel, "tag": img.Tag}
	}
	scheduler := map[string]any{}
	if cloud != nil {
		v["imagePolicy"] = map[string]any{"sourceRegistry": cloud.TaskRegistry}
		if cloud.StepPlacement != nil {
			scheduler["taskPlacement"] = cloud.StepPlacement
		}
		if len(cloud.CapacityPlacements) > 0 {
			scheduler["capacityPlacements"] = cloud.CapacityPlacements
		}
		switch {
		case cloud.BackupBucket != "" && cloud.Provider == "aws":
			v["backup"] = map[string]any{
				"enabled": true, "destination": "s3", "serviceAccountName": BackupServiceAccountName,
				"s3": map[string]any{"bucket": cloud.BackupBucket, "region": cloud.BackupRegion},
			}
		case cloud.BackupBucket != "":
			v["backup"] = map[string]any{
				"enabled": true, "destination": "gcs", "serviceAccountName": BackupServiceAccountName,
				"gcs": map[string]any{"bucket": cloud.BackupBucket},
			}
		}
	}
	if cloud != nil && cloud.Database != nil {
		managedKernelValues(v, cloud.Database)
	}
	if e := c.ExternalCatalog; e.Registry != "" {
		// Steps run the other install's catalog images.
		v["imagePolicy"] = map[string]any{"sourceRegistry": e.Registry}
		if e.Federated() {
			// The kubelet pulls them with the console's federated token.
			scheduler["taskImagePullSecret"] = "vertra-pull"
		}
	}
	if len(scheduler) > 0 {
		v["scheduler"] = scheduler
	}
	if trust := SignatureTrust(c, cloud); trust != nil {
		// Images from the task registry (or the catalog's, read from
		// another install) run only if catalog CI signed them
		// (policy-controller, installed first, enforces it).
		v["imageSignature"] = map[string]any{"enabled": true, "publicKeys": trust["publicKeys"], "keyless": trust["keyless"]}
	}
	if c.Monitoring.Enabled {
		monitoring, metricsFrom := monitoringValues(c, nil, false)
		v["monitoring"] = monitoring
		v["networkPolicy"] = map[string]any{"metricsFrom": metricsFrom}
	}
	return v
}

// ConsoleValues are the values vertra generates for the console chart.
func ConsoleValues(c *config.Config, env string, img Images, cloud *Cloud) map[string]any {
	v := map[string]any{
		"kernelApiUrl": fmt.Sprintf("https://%s-execution-kernel-api.%s.svc.cluster.local:8000", KernelRelease, c.Namespace),
		// kernel-api's HTTPS and the kernel's Postgres, checked against the
		// kernel chart's own CA.
		"tls":              map[string]any{"kernelCaSecret": KernelRelease + "-execution-kernel-tls-ca"},
		"environmentLabel": env,
		// Which of the catalog's products are for this install (their clouds).
		"installCloud": c.InstallCloud(),
		// Its database lives on the kernel's Postgres, whose chart makes this Secret.
		"postgres":          map[string]any{"enabled": false},
		"existingSecret":    KernelRelease + "-execution-kernel-console-db",
		"existingSecretKey": "database-url",
		// No password: a fresh install's is given in a Secret (WithFirstAdmin).
		"bootstrapAdmin": map[string]any{"email": c.Admin.Email},
	}
	if cloud != nil && cloud.Database != nil {
		managedConsoleValues(v, cloud.Database)
	}
	if c.Target == "kind" {
		// Pinning images asks the local registry by its in-cluster name.
		v["registryCheck"] = map[string]any{"mirrors": map[string]any{
			c.TaskImages.Registry: fmt.Sprintf("http://%s:5000", c.Kind.RegistryName),
		}}
	}
	for k, val := range copies(c) {
		v[k] = val
	}
	if cloud != nil && cloud.Provider == "aws" {
		// Reading ECR with the console's own role (EKS Pod Identity, bound
		// to its ServiceAccounts by name: no annotations).
		v["registryCheck"] = map[string]any{"ecrToken": true}
		if c.ChatOnBedrock() {
			// The chat agent: Claude in Amazon Bedrock in the install's
			// region, signed as the console's role (the module grants it this model).
			v["chat"] = map[string]any{
				"model":    c.ChatModel(),
				"provider": "bedrock",
				"bedrock":  map[string]any{"region": c.AWS.Region},
			}
		}
		// Steps can't reach the instance metadata server, so not the node's
		// role either (a NetworkPolicy in each team namespace).
		v["teamNamespaces"] = map[string]any{"blockMetadata": true}
		if cloud.ConsoleHost != "" {
			// HTTPS only, on an Application Load Balancer with ACM's
			// certificate; the load balancer connects from inside the VPC.
			v["ingress"] = map[string]any{
				"enabled":   true,
				"host":      cloud.ConsoleHost,
				"className": "vertra-alb",
				"annotations": map[string]any{
					"alb.ingress.kubernetes.io/certificate-arn":  cloud.ConsoleCertificate,
					"alb.ingress.kubernetes.io/listen-ports":     `[{"HTTPS":443}]`,
					"alb.ingress.kubernetes.io/target-type":      "ip",
					"alb.ingress.kubernetes.io/healthcheck-path": "/health/ready",
					"alb.ingress.kubernetes.io/ssl-policy":       "ELBSecurityPolicy-TLS13-1-2-2021-06",
				},
			}
			v["trustProxy"] = []string{cloud.VPCCIDR}
		}
	}
	if cloud != nil && cloud.Provider == "aws" {
		// The issuer IAM trusts (the module registers it): a team's AWS
		// SecretStore signs in as a role only its eso-aws may assume.
		v["secretSources"] = map[string]any{"clusterIssuer": cloud.ClusterIssuer, "catalogRepo": c.Catalog.Repo()}
	}
	if cloud != nil && cloud.Provider != "aws" {
		// Reading the task registry (pinning digests, scanning) as the
		// module's console identity, through GKE's Workload Identity.
		identity := map[string]any{"iam.gke.io/gcp-service-account": cloud.ConsoleServiceAccount}
		v["serviceAccount"] = map[string]any{"annotations": identity}
		scanner := cloud.ScannerServiceAccount
		if scanner == "" {
			scanner = cloud.ConsoleServiceAccount
		}
		v["scanning"] = map[string]any{"serviceAccountAnnotations": map[string]any{"iam.gke.io/gcp-service-account": scanner}}
		if c.ChatOnVertex() {
			// The chat agent: Gemini through Vertex AI in the install's
			// project, as the console's identity (the module grants it).
			v["chat"] = map[string]any{
				"model":    c.ChatModel(),
				"provider": "vertex",
				"vertex":   map[string]any{"project": c.GCP.Project, "location": "global"},
			}
		}
		v["registryCheck"] = map[string]any{"gcpMetadataToken": true}
		v["secretSources"] = map[string]any{
			"clusterIssuer":           cloud.ClusterIssuer,
			"gcpWorkloadIdentityPool": cloud.WorkloadPool,
			"gkeClusterName":          cloud.ClusterName,
			"gkeClusterLocation":      cloud.ClusterLocation,
			"catalogRepo":             c.Catalog.Repo(),
		}
		if cloud.ConsoleHost != "" {
			// HTTPS only, on the reserved address, with Google's certificate.
			v["ingress"] = map[string]any{
				"enabled": true,
				"host":    cloud.ConsoleHost,
				"annotations": map[string]any{
					"kubernetes.io/ingress.class":                 "gce",
					"kubernetes.io/ingress.global-static-ip-name": cloud.ConsoleAddressName,
					"networking.gke.io/managed-certificates":      certificateName,
					"kubernetes.io/ingress.allow-http":            "false",
				},
			}
			v["trustProxy"] = append(append([]string{}, googleFrontEnds...), cloud.ConsoleIP)
		}
	}
	catalog := map[string]any{}
	if cloud != nil && c.Catalog.Repo() != "" {
		// The catalog's release, which its CI pushes beside the images and
		// the console reads.
		catalog["release"] = cloud.TaskRegistry + "/catalog-release:" + releaseTag(c)
	}
	if e := c.ExternalCatalog; e.Registry != "" {
		catalog["release"] = e.Registry + "/catalog-release:" + releaseTag(c)
		// For the Admin page: another install's catalog.
		catalog["external"] = true
		if e.Federated() {
			// Another cloud's (or AWS account's) registry, read by
			// federation (console/src/registryFederation.ts).
			check, _ := v["registryCheck"].(map[string]any)
			if check == nil {
				check = map[string]any{}
			}
			hosts := []string{strings.SplitN(e.Registry, "/", 2)[0]}
			if e.GCPWorkloadIdentityProvider != "" {
				check["gcpFederation"] = map[string]any{
					"workloadIdentityProvider": e.GCPWorkloadIdentityProvider,
					"serviceAccount":           e.GCPServiceAccount,
					"hosts":                    hosts,
				}
			} else {
				check["awsFederation"] = map[string]any{"roleArn": e.AWSRoleArn, "hosts": hosts}
			}
			v["registryCheck"] = check
		}
	}
	if catalog["release"] != nil && c.CatalogVersion == "newest" {
		catalog["newestVersion"] = true
	}
	if trust := SignatureTrust(c, cloud); trust != nil {
		// Only releases catalog CI signed are applied.
		catalog["signature"] = trust
	} else if trust := CatalogSignerTrust(c); trust != nil {
		// Only releases the catalog's signer signed are applied (images
		// aren't checked: off a cloud, policy-controller can't read them).
		catalog["signature"] = trust
	}
	if len(catalog) > 0 {
		v["catalog"] = catalog
	}
	if img.Console != "" {
		v["image"] = map[string]any{"repository": img.Console, "tag": img.Tag}
	}
	if c.Gateway.Enabled {
		gateway := map[string]any{
			"enabled": true,
			// Its own role on the kernel's Postgres, which the kernel chart
			// makes beside the console's.
			"database":      map[string]any{"existingSecret": KernelRelease + "-execution-kernel-gateway-db"},
			"backendHosts":  c.Gateway.BackendHosts,
			"internetTeams": c.Gateway.InternetTeams,
			"url":           fmt.Sprintf("http://%s-execution-console-gateway.%s.svc.cluster.local:8080", ConsoleRelease, c.Namespace),
		}
		if img.Gateway != "" {
			gateway["image"] = map[string]any{"repository": img.Gateway, "tag": img.Tag}
		}
		if cloud != nil && cloud.Database != nil {
			managedGatewayValues(gateway, cloud.Database)
		}
		if cloud != nil && cloud.Provider == "gcp" {
			// API ServiceAccounts federate through the cluster's own
			// Workload Identity pool: a googleIdToken API's service account
			// grants its principal roles/iam.serviceAccountOpenIdTokenCreator.
			pool := c.GCP.Project + ".svc.id.goog"
			gateway["gcp"] = map[string]any{
				"tokenAudience": pool,
				"stsAudience": fmt.Sprintf("identitynamespace:%s:https://container.googleapis.com/v1/projects/%s/locations/%s/clusters/%s",
					pool, c.GCP.Project, cloud.ClusterLocation, cloud.ClusterName),
			}
		}
		v["gateway"] = gateway
	}
	if c.Logs.Enabled {
		v["logs"] = logsValues(c, cloud)
	}
	if c.Monitoring.Enabled {
		monitoring, metricsFrom := monitoringValues(c, cloud, true)
		v["monitoring"] = monitoring
		v["networkPolicy"] = map[string]any{"metricsFrom": metricsFrom}
	}
	// Signing in with Google: the client's id here, its secret in the
	// Secret EnsureSSOSecret writes.
	if c.SSO.Provider == "google" {
		v["sso"] = map[string]any{
			"issuer": "https://accounts.google.com", "clientId": c.SSO.ClientID,
			"clientSecret":   map[string]any{"name": SSOSecretName, "key": "client-secret"},
			"redirectUrl":    c.SSO.RedirectURL,
			"allowedDomains": c.SSO.AllowedDomains,
			"label":          "Google",
		}
	}
	// An existing cluster's public console: its Ingress, and cert-manager's
	// certificate for it (an issuer of yours, or Let's Encrypt).
	if c.Target == "existing" && c.Console.Public {
		v["ingress"] = map[string]any{
			"enabled": true, "host": c.Console.Hostname, "className": c.Console.IngressClass,
			"certManager": map[string]any{
				"issuer": c.Console.TLS.Issuer,
				"acme":   map[string]any{"email": c.Console.TLS.LetsEncryptEmail},
			},
		}
	}
	// The console writes the copy as itself (Workload Identity, Pod Identity).
	if cloud != nil && cloud.AuditBucket != "" {
		export := map[string]any{"bucket": cloud.AuditBucket, "provider": "gcs"}
		if cloud.Provider == "aws" {
			export = map[string]any{"bucket": cloud.AuditBucket, "provider": "s3", "region": cloud.AuditRegion}
		}
		// What the bucket keeps, as made: shown on the Admin page, "as
		// configured" (the console can't read the bucket's retention).
		export["keepDays"], export["lock"] = c.Audit.KeepDays, c.Audit.Lock
		v["audit"] = map[string]any{"export": export}
	}
	return v
}

// logsValues: Loki on the module's bucket (archived after searchDays), or on
// a volume where there's no bucket (kind, an existing cluster).
func logsValues(c *config.Config, cloud *Cloud) map[string]any {
	logs := map[string]any{
		"enabled": true, "searchDays": c.Logs.SearchDays, "keepDays": c.Logs.KeepDays,
		"serviceAccountName": LokiServiceAccountName,
		"storage":            map[string]any{"type": "filesystem"},
	}
	switch {
	case cloud != nil && cloud.LogsBucket != "" && cloud.Provider == "aws":
		logs["storage"] = map[string]any{"type": "s3", "bucket": cloud.LogsBucket, "region": cloud.LogsRegion, "size": "2Gi"}
	case cloud != nil && cloud.LogsBucket != "":
		logs["storage"] = map[string]any{"type": "gcs", "bucket": cloud.LogsBucket, "size": "2Gi"}
		logs["serviceAccountAnnotations"] = map[string]any{"iam.gke.io/gcp-service-account": cloud.LogsServiceAccount}
	}
	return logs
}

// EnsureBackupServiceAccount creates (or updates) the Kubernetes
// ServiceAccount the backups run as: on gcp annotated with its Google
// service account; on aws, EKS Pod Identity binds it by name.
func EnsureBackupServiceAccount(ctx context.Context, r *run.Runner, c *config.Config, cloud *Cloud) error {
	annotations := ""
	if cloud.Provider != "aws" {
		annotations = fmt.Sprintf("  annotations:\n    iam.gke.io/gcp-service-account: %s\n", cloud.BackupServiceAccount)
	}
	manifest := fmt.Sprintf(`apiVersion: v1
kind: ServiceAccount
metadata:
  name: %s
  namespace: %s
  labels:
    app.kubernetes.io/managed-by: vertra
%sautomountServiceAccountToken: false
`, BackupServiceAccountName, c.Namespace, annotations)
	return r.RunInput(ctx, manifest, "kubectl", "--context", cluster.Context(c), "apply", "-f", "-")
}

// DatabaseVolume is the kernel database volume's current size, or "" if it
// doesn't exist yet.
func DatabaseVolume(ctx context.Context, r *run.Runner, c *config.Config) string {
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"get", "pvc", KernelRelease+"-execution-kernel-postgres", "--ignore-not-found",
		"-o", "jsonpath={.spec.resources.requests.storage}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// MetricsServer installs the cluster's metrics API on kind (the auto size's
// autoscalers need it; the clouds have their own). Pinned.
func MetricsServer(ctx context.Context, r *run.Runner, c *config.Config) error {
	chart, done, err := tools.PullChart(ctx, r, "metrics-server")
	if err != nil {
		return err
	}
	defer done()
	return r.Run(ctx, "helm", "upgrade", "--install", "metrics-server", chart,
		"--kube-context", cluster.Context(c), "--namespace", "kube-system",
		// kind's kubelets serve self-signed certificates.
		"--set", "args={--kubelet-insecure-tls}", "--wait", "--timeout", "5m")
}

// MetricsServerChart is the metrics-server chart version installed on kind.
var MetricsServerChart = tools.ChartVersion("metrics-server")

// Prometheus is a Prometheus Operator's Prometheus in the cluster: where it
// runs, and the labels it selects PodMonitors and rules by.
type Prometheus struct {
	Namespace                    string
	PodMonitorLabels, RuleLabels map[string]string
}

// FindPrometheus finds the cluster's first Prometheus (kube-prometheus-stack
// makes one); nil when there's no Prometheus Operator.
func FindPrometheus(ctx context.Context, r *run.Runner, c *config.Config) *Prometheus {
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "get", "prometheuses.monitoring.coreos.com",
		"--all-namespaces", "-o", "json")
	if err != nil {
		return nil
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Namespace string `json:"namespace"`
			} `json:"metadata"`
			Spec struct {
				PodMonitorSelector struct {
					MatchLabels map[string]string `json:"matchLabels"`
				} `json:"podMonitorSelector"`
				RuleSelector struct {
					MatchLabels map[string]string `json:"matchLabels"`
				} `json:"ruleSelector"`
			} `json:"spec"`
		} `json:"items"`
	}
	if json.Unmarshal([]byte(out), &list) != nil || len(list.Items) == 0 {
		return nil
	}
	p := list.Items[0]
	return &Prometheus{Namespace: p.Metadata.Namespace, PodMonitorLabels: p.Spec.PodMonitorSelector.MatchLabels, RuleLabels: p.Spec.RuleSelector.MatchLabels}
}

// monitoringValues are a chart's monitoring and metricsFrom (who may
// scrape), for the Prometheus monitoring.provider names: the cluster's
// operator as vertra init found it, GKE's managed collector, or the
// console chart's own (console: this is the console chart's values), which
// with amazon also writes to the module's workspace.
func monitoringValues(c *config.Config, cloud *Cloud, console bool) (monitoring map[string]any, metricsFrom []any) {
	m := c.Monitoring
	scrapedFrom := func(namespace string) []any {
		return []any{map[string]any{"namespaceSelector": map[string]any{"matchLabels": map[string]string{"kubernetes.io/metadata.name": namespace}}}}
	}
	switch m.ProviderName() {
	case "google":
		collector := GoogleCollectorNamespace(c)
		google := map[string]any{"collectorNamespace": collector}
		if console && cloud != nil && cloud.ClusterName != "" {
			// Where Observe reads which alerts fire: this project's managed
			// Prometheus, this cluster's (the module grants the console
			// roles/monitoring.viewer).
			google["project"], google["cluster"] = c.GCP.Project, cloud.ClusterName
		}
		monitoring = map[string]any{
			"provider":   "google",
			"google":     google,
			"podMonitor": map[string]any{"enabled": true},
			"alerts":     map[string]any{"enabled": true},
		}
		return monitoring, scrapedFrom(collector)
	case "bundled", "amazon":
		monitoring = map[string]any{"provider": "bundled", "alerts": map[string]any{"enabled": true}}
		if console {
			prometheus := map[string]any{"enabled": true, "kernelRelease": "kernel"}
			if m.ProviderName() == "amazon" && cloud != nil && cloud.PrometheusRemoteWrite != "" {
				prometheus["serviceAccountName"] = PrometheusServiceAccountName
				prometheus["externalLabels"] = map[string]any{"cluster": c.Cluster.Name}
				prometheus["remoteWrite"] = map[string]any{"url": cloud.PrometheusRemoteWrite, "sigv4Region": cloud.PrometheusRegion}
				prometheus["alertmanager"] = map[string]any{"url": cloud.PrometheusAlertmanager, "sigv4Region": cloud.PrometheusRegion}
			}
			monitoring["prometheus"] = prometheus
		}
		bundled := map[string]any{"podSelector": map[string]any{"matchLabels": map[string]string{
			"app.kubernetes.io/instance": "console", "app.kubernetes.io/component": "prometheus"}}}
		return monitoring, []any{bundled}
	}
	monitoring = map[string]any{
		"provider":   "operator",
		"podMonitor": map[string]any{"enabled": true, "labels": m.PodMonitorLabels},
		"alerts":     map[string]any{"enabled": true, "labels": m.RuleLabels},
	}
	if console {
		// Grafana's dashboard sidecar watches its own namespace by default.
		monitoring["dashboard"] = map[string]any{"enabled": true, "namespace": m.Namespace}
	}
	return monitoring, scrapedFrom(m.Namespace)
}

// GoogleCollectorNamespace is where GKE's managed Prometheus collector runs:
// its own namespace on Autopilot, gmp-system on a standard cluster.
func GoogleCollectorNamespace(c *config.Config) string {
	if c.Cluster.Mode == "auto" {
		return "gke-gmp-system"
	}
	return "gmp-system"
}

// SSOSecretName is the Secret holding the Google OAuth client's secret.
const SSOSecretName = "vertra-sso"

// GoogleClient is an OAuth client's downloaded JSON (Google Cloud console,
// Clients, Download JSON): a web client, its id, secret and redirect URIs.
type GoogleClient struct {
	ID, Secret   string
	RedirectURIs []string
}

// ReadGoogleClient reads that file, refusing anything but a web client.
func ReadGoogleClient(path string) (*GoogleClient, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var file struct {
		Web *struct {
			ClientID     string   `json:"client_id"`
			ClientSecret string   `json:"client_secret"`
			RedirectURIs []string `json:"redirect_uris"`
		} `json:"web"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		return nil, fmt.Errorf("%s isn't an OAuth client's JSON: %w", path, err)
	}
	if file.Web == nil || file.Web.ClientID == "" || file.Web.ClientSecret == "" {
		return nil, fmt.Errorf("%s isn't a web application client's JSON (Clients, Create client, Web application)", path)
	}
	return &GoogleClient{ID: file.Web.ClientID, Secret: file.Web.ClientSecret, RedirectURIs: file.Web.RedirectURIs}, nil
}

// SSORedirect is where Google sends people back: the console's public
// address, or the port-forward's (vertra console) when it has none.
func SSORedirect(ctx context.Context, r *run.Runner, c *config.Config) (string, error) {
	if !c.Console.Public {
		return "http://localhost:18080/api/auth/oidc/callback", nil
	}
	host := c.Console.Hostname
	if host == "" {
		// gcp's nip.io name: on the console's Ingress once applied.
		out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
			"get", "ingress", ConsoleRelease+"-execution-console", "--ignore-not-found", "-o", "jsonpath={.spec.rules[0].host}")
		if host = strings.TrimSpace(out); err != nil || host == "" {
			return "", fmt.Errorf("the console's public address isn't known until it's installed: `vertra apply` first")
		}
	}
	return "https://" + host + "/api/auth/oidc/callback", nil
}

// EnsureSSOSecret writes the OAuth client's secret into the console's
// namespace, through stdin: it never appears in a command line.
func EnsureSSOSecret(ctx context.Context, r *run.Runner, c *config.Config) error {
	client, err := ReadGoogleClient(c.SSO.ClientFile)
	if err != nil {
		return err
	}
	manifest, _ := json.Marshal(map[string]any{
		"apiVersion": "v1", "kind": "Secret",
		"metadata":   map[string]any{"name": SSOSecretName, "namespace": c.Namespace, "labels": map[string]string{"app.kubernetes.io/managed-by": "vertra"}},
		"stringData": map[string]string{"client-secret": client.Secret},
	})
	return r.RunInput(ctx, string(manifest), "kubectl", "--context", cluster.Context(c), "apply", "-f", "-")
}

// CertManagerChart is the cert-manager chart version vertra installs, on an
// existing cluster that hasn't got it, for the console's certificate.
var CertManagerChart = tools.ChartVersion("cert-manager")

// CertManagerInstalled is whether the cluster has cert-manager's
// Certificate resource (whoever installed it).
func CertManagerInstalled(ctx context.Context, r *run.Runner, c *config.Config) bool {
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "get", "crd", "certificates.cert-manager.io",
		"--ignore-not-found", "-o", "name")
	return err == nil && strings.TrimSpace(out) != ""
}

// CertManager installs cert-manager, pinned, with its resource definitions.
func CertManager(ctx context.Context, r *run.Runner, c *config.Config) error {
	chart, done, err := tools.PullChart(ctx, r, "cert-manager")
	if err != nil {
		return err
	}
	defer done()
	return r.Run(ctx, "helm", "upgrade", "--install", "cert-manager", chart,
		"--kube-context", cluster.Context(c), "--namespace", "cert-manager", "--create-namespace",
		"--set", "crds.enabled=true", "--wait", "--timeout", "10m")
}

// ExternalSecretsChart is External Secrets Operator's chart vertra installs
// (externalSecrets), the same as `make kind-deploy-eso`: teams' SecretStores
// sync their vaults' secrets through it.
var ExternalSecretsChart = tools.ChartVersion("external-secrets")

// ExternalSecrets installs External Secrets Operator, pinned, with its
// resource definitions, before the console, which writes SecretStores.
func ExternalSecrets(ctx context.Context, r *run.Runner, c *config.Config) error {
	chart, done, err := tools.PullChart(ctx, r, "external-secrets")
	if err != nil {
		return err
	}
	defer done()
	return r.Run(ctx, "helm", "upgrade", "--install", "external-secrets", chart,
		"--kube-context", cluster.Context(c), "--namespace", "external-secrets", "--create-namespace",
		"--wait", "--timeout", "10m")
}

// ConsoleCertificate is the console's certificate's state on an existing
// cluster: "ready", or why not yet, from cert-manager.
func ConsoleCertificate(ctx context.Context, r *run.Runner, c *config.Config) string {
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"get", "certificate", ConsoleRelease+"-execution-console-tls", "--ignore-not-found",
		"-o", `jsonpath={.status.conditions[?(@.type=="Ready")].status} {.status.conditions[?(@.type=="Ready")].message}`)
	if err != nil || strings.TrimSpace(out) == "" {
		return "not requested yet"
	}
	if strings.HasPrefix(out, "True") {
		return "ready"
	}
	return "not ready: " + strings.TrimSpace(strings.TrimPrefix(out, "False"))
}

// WriteValues writes generated values next to the config, for the record
// and for helm -f.
func WriteValues(dir, name string, values map[string]any) (string, error) {
	data, err := yaml.Marshal(values)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "generated", name+".yaml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	header := "# Written by vertra apply from vertra.yaml; changes here are overwritten.\n"
	return path, os.WriteFile(path, append([]byte(header), data...), 0o644)
}

// Upgrade installs or upgrades one release.
//
// A first install runs without --wait: both charts migrate in a
// post-install hook, which Helm runs only after --wait has seen every Pod
// ready, and the console isn't ready until its tables exist. Helm still
// waits for the hook Job; the rollout is waited for after it. Upgrades
// migrate in a pre-upgrade hook, so --wait is safe there.
func Upgrade(ctx context.Context, r *run.Runner, c *config.Config, dir, release string, chart Chart, generated string) error {
	fresh := Installed(ctx, r, c, release) == ""
	args := []string{
		"upgrade", "--install", release, chart.Dir,
		"--kube-context", cluster.Context(c), "--namespace", c.Namespace,
		"--reset-values", "--timeout", "10m",
		// Lowest first: the size preset, what vertra generates, yours.
		"-f", SizeValues(chart, c.Size),
		"-f", generated,
		// Others own fields Helm sets under server-side apply: the console
		// edits the kernel's image and identity policies, and sleep, wake and
		// the scanner's idling set replica counts. vertra's values win.
		"--force-conflicts",
	}
	if !fresh {
		args = append(args, "--wait")
	}
	if c.Values != "" {
		args = append(args, "-f", filepath.Join(dir, c.Values))
	}
	if err := r.Run(ctx, "helm", args...); err != nil || !fresh {
		return err
	}
	return r.Run(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"rollout", "status", "deployment", "--selector", "app.kubernetes.io/instance="+release, "--timeout", "10m")
}

// Installed returns a release's chart (name-version), or "" if it isn't
// installed.
func Installed(ctx context.Context, r *run.Runner, c *config.Config, release string) string {
	return InstalledIn(ctx, r, c, c.Namespace, release)
}

// InstalledIn is Installed for a release in another namespace (the charts
// vertra installs beside the platform: policy-controller, External Secrets
// Operator).
func InstalledIn(ctx context.Context, r *run.Runner, c *config.Config, namespace, release string) string {
	out, err := r.Output(ctx, "helm", "list", "--kube-context", cluster.Context(c), "--namespace", namespace,
		"--filter", "^"+release+"$", "--output", "json")
	if err != nil {
		return ""
	}
	m := regexp.MustCompile(`"chart":"([^"]+)"`).FindStringSubmatch(out)
	if m == nil {
		return ""
	}
	return m[1]
}

// Releases is each platform release's installed chart (KernelRelease,
// ConsoleRelease), "" when it isn't installed: looked up side by side.
func Releases(ctx context.Context, r *run.Runner, c *config.Config) map[string]string {
	var kernel, console string
	run.Together(
		func() { kernel = Installed(ctx, r, c, KernelRelease) },
		func() { console = Installed(ctx, r, c, ConsoleRelease) },
	)
	return map[string]string{KernelRelease: kernel, ConsoleRelease: console}
}

// FirstAdminSecret holds the first admin's password, which vertra
// generates, for the console's migrate Job, during a fresh install only.
const FirstAdminSecret = "vertra-first-admin"

// NewPassword is a random password for the first admin.
func NewPassword() string {
	b := make([]byte, 18)
	_, _ = rand.Read(b) // never fails (crypto/rand)
	return base64.RawURLEncoding.EncodeToString(b)
}

// GivePassword puts the first admin's password where a fresh install's
// migrate Job reads it (WithFirstAdmin): a Secret, written through stdin, so
// it's never in an argument list, and never printed by the console, whose
// logs the cluster may ship and keep.
func GivePassword(ctx context.Context, r *run.Runner, c *config.Config, password string) error {
	manifest := fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vertra}
stringData:
  password: %q
`, FirstAdminSecret, password)
	return r.RunInput(ctx, manifest, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace, "apply", "-f", "-")
}

// WithFirstAdmin has a fresh install's console create the first admin with
// the password GivePassword gave it, to be changed at the first sign-in.
func WithFirstAdmin(consoleValues map[string]any) {
	admin := consoleValues["bootstrapAdmin"].(map[string]any)
	admin["existingSecret"] = FirstAdminSecret
	admin["mustChangePassword"] = true
}

// AdminCreated reports whether this install's migrate Job created the first
// admin (with GivePassword's password), from the line its log has for that
// (never a password). False only when the logs were read and haven't it:
// the account was already there, its data kept from before. Every attempt's
// Pod is read (`logs job/...` reads only one, maybe a failed first try).
func AdminCreated(ctx context.Context, r *run.Runner, c *config.Config) bool {
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"logs", "--selector", "batch.kubernetes.io/job-name="+ConsoleRelease+"-execution-console-migrate",
		"--tail=-1", "--max-log-requests=20")
	// No Pod at all (the Job gone) says nothing either way.
	// The console keeps emails lowercase (console/src/db/schema.ts normalEmail).
	return err != nil || out == "" || strings.Contains(strings.ToLower(out), strings.ToLower("Bootstrap admin account created: "+strings.TrimSpace(c.Admin.Email)))
}

// ForgetPassword deletes GivePassword's Secret once the console is
// installed: the account has the password by then, and the file apply saved
// is the only other copy. Best effort: every apply tries again.
func ForgetPassword(ctx context.Context, r *run.Runner, c *config.Config) {
	_ = r.Succeeds(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"delete", "secret", FirstAdminSecret, "--ignore-not-found")
}

// Uninstall removes a release. The database volume stays: the charts mark
// it to be kept (postgres.persistence.keepOnUninstall).
func Uninstall(ctx context.Context, r *run.Runner, c *config.Config, release string) error {
	if Installed(ctx, r, c, release) == "" {
		return nil
	}
	return r.Run(ctx, "helm", "uninstall", release, "--kube-context", cluster.Context(c), "--namespace", c.Namespace, "--wait")
}

// ConsoleSubject is the console's ServiceAccount as its cluster's OIDC
// tokens name it: the one identity another cloud's grant trusts.
func ConsoleSubject(c *config.Config) string {
	return fmt.Sprintf("system:serviceaccount:%s:%s-execution-console", c.Namespace, ConsoleRelease)
}

// Grant is what the catalog registry's owner runs, in its own environment,
// to let this install read the catalog (`vertra catalog grant`), and what
// this install does after.
type Grant struct {
	// Why: what the grant lets this install do.
	Why     string
	Command string
	// Then is run here after the grant (setting what it printed), if
	// anything.
	Then []string
}

// CatalogGrant is the owner's grant this install needs to read another
// install's catalog, or nil when it needs none (it reads no other catalog,
// or already signs in by federation, or the registry is its own project's):
//   - another cloud's registry, or another AWS account's ECR: its cluster's
//     OIDC identity, the console's ServiceAccount alone, which the owner
//     trusts (a Workload Identity provider, or an IAM role); the console then
//     hands the kubelet, policy-controller and its Jobs short-lived tokens.
//   - another project's Artifact Registry, on Google Cloud: its own service
//     accounts (the console, the scanner, the nodes, policy-controller's),
//     each given read on the repository.
func CatalogGrant(c *config.Config, cloud *Cloud) *Grant {
	e := c.ExternalCatalog
	if e.Registry == "" || cloud == nil || e.Federated() {
		return nil
	}
	reader := strings.ToLower(c.Cluster.Name)
	if config.IsArtifactRegistry(e.Registry) && cloud.Provider == "gcp" {
		project := strings.SplitN(e.Registry, "/", 3)[1]
		if project == c.GCP.Project {
			return nil
		}
		accounts := []string{cloud.ConsoleServiceAccount}
		if cloud.ScannerServiceAccount != "" && cloud.ScannerServiceAccount != cloud.ConsoleServiceAccount {
			accounts = append(accounts, cloud.ScannerServiceAccount)
		}
		// The nodes' identity (the module's ${name}-nodes) pulls steps' images.
		accounts = append(accounts, fmt.Sprintf("%s-nodes@%s.iam.gserviceaccount.com", c.Cluster.Name, c.GCP.Project))
		if c.VerifiesCatalog() && cloud.SigningVerifier != "" {
			accounts = append(accounts, cloud.SigningVerifier)
		}
		command := "vertra catalog grant --reader " + reader
		for _, a := range accounts {
			command += " --service-account " + a
		}
		return &Grant{Why: "read it as this install's own service accounts", Command: command}
	}
	if cloud.ClusterIssuer == "" {
		return nil
	}
	set := ""
	switch {
	case config.IsArtifactRegistry(e.Registry):
		set = "vertra config set externalCatalog.gcpWorkloadIdentityProvider <the provider it prints>"
	default:
		if account, _, _ := config.ECRRegistry(e.Registry); account == "" {
			return nil
		}
		set = "vertra config set externalCatalog.awsRoleArn <the role it prints>"
	}
	return &Grant{
		Why: "sign in to it with no stored key, as this cluster's console alone",
		Command: fmt.Sprintf("vertra catalog grant --reader %s --issuer %s --subject %s",
			reader, cloud.ClusterIssuer, ConsoleSubject(c)),
		Then: []string{set, "vertra apply"},
	}
}

// releaseTag is the tag of the catalog's release the console reads: a
// pinned version, or latest (which newest ignores, reading the newest
// version instead).
func releaseTag(c *config.Config) string {
	if config.CatalogVersionPattern.MatchString(c.CatalogVersion) {
		return c.CatalogVersion
	}
	return "latest"
}

// GitHubActionsIssuer is the issuer of GitHub Actions' OIDC tokens, which
// keyless signatures carry.
const GitHubActionsIssuer = "https://token.actions.githubusercontent.com"

// KeylessSubject is the identity keyless signatures must name: the
// catalog repository's ci.yml (catalog-template's), on main.
func KeylessSubject(repo string) string {
	return `^https://github\.com/` + regexp.QuoteMeta(repo) + `/\.github/workflows/ci\.yml@refs/heads/main$`
}

// SignatureTrust is who may sign this install's catalog, as both charts take
// it (publicKeys, keyless), or nil when it isn't signed.
func SignatureTrust(c *config.Config, cloud *Cloud) map[string]any {
	if c.VerifiesCatalog() {
		// Another install's catalog: its signer, given here.
		return CatalogSignerTrust(c)
	}
	if !c.Signs() {
		return nil
	}
	trust := map[string]any{"publicKeys": []string{}, "keyless": map[string]any{"issuer": "", "subjectRegExp": ""}}
	switch c.Signing {
	case "kms":
		if cloud == nil || cloud.SigningPublicKey == "" {
			return nil
		}
		trust["publicKeys"] = []string{cloud.SigningPublicKey}
	case "keyless":
		trust["keyless"] = map[string]any{"issuer": GitHubActionsIssuer, "subjectRegExp": KeylessSubject(c.Catalog.Repo())}
	}
	return trust
}

// CatalogSignerTrust is the signer catalogSignature names (another
// install's catalog), as both charts take it, or nil when it names none.
func CatalogSignerTrust(c *config.Config) map[string]any {
	sig := c.CatalogSignature
	if sig.PublicKey == "" && sig.Repository == "" {
		return nil
	}
	trust := map[string]any{"publicKeys": []string{}, "keyless": map[string]any{"issuer": "", "subjectRegExp": ""}}
	if sig.PublicKey != "" {
		trust["publicKeys"] = []string{sig.PublicKey}
	}
	if sig.Repository != "" {
		trust["keyless"] = map[string]any{"issuer": GitHubActionsIssuer, "subjectRegExp": KeylessSubject(sig.Repository)}
	}
	return trust
}

// PolicyControllerChart is Sigstore's policy-controller chart vertra
// installs when the catalog is signed; it enforces the kernel chart's
// imageSignature.
var PolicyControllerChart = tools.ChartVersion("policy-controller")

// PolicyControllerServiceAccount is its webhook's ServiceAccount, which the
// cloud binds to an identity that may read the task registry.
const PolicyControllerServiceAccount = "policy-controller-webhook"

// PolicyController installs policy-controller, pinned, its webhook covering
// team namespaces only: in every namespace it covers it refuses any image it
// can't resolve, so never the platform's own.
func PolicyController(ctx context.Context, r *run.Runner, c *config.Config, cloud *Cloud) error {
	chart, done, err := tools.PullChart(ctx, r, "policy-controller")
	if err != nil {
		return err
	}
	defer done()
	args := []string{"upgrade", "--install", "policy-controller", chart,
		"--kube-context", cluster.Context(c), "--namespace", "cosign-system", "--create-namespace",
		"--set", "webhook.serviceAccount.name=" + PolicyControllerServiceAccount,
		"--set-json", `webhook.namespaceSelector={"matchExpressions":[{"key":"vertra/team","operator":"Exists"}]}`,
		// Its webhook rewrites its own namespaceSelector, so Helm's server-side
		// apply would conflict with it on every upgrade after the first.
		"--force-conflicts",
		"--wait", "--timeout", "10m"}
	if cloud != nil && cloud.Provider == "gcp" && cloud.SigningVerifier != "" {
		args = append(args, "--set-string", `webhook.serviceAccount.annotations.iam\.gke\.io/gcp-service-account=`+cloud.SigningVerifier)
	}
	if err := r.Run(ctx, "helm", args...); err != nil {
		return err
	}
	// --wait sees its Pods ready, but on a new cluster the API server may not
	// reach its webhook yet (GKE: "No agent available"), and the kernel
	// chart's policy would fail. A server-side dry run goes through the
	// webhook and stores nothing: wait until it answers.
	for deadline := time.Now().Add(5 * time.Minute); ; {
		if _, err = r.OutputInput(ctx, policyControllerProbe, "kubectl", "--context", cluster.Context(c), "apply", "--dry-run=server", "-f", "-"); err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("policy-controller's webhook doesn't answer: %w", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Second):
		}
	}
}

// policyControllerProbe is a policy for no image, only ever dry-run.
const policyControllerProbe = `{"apiVersion":"policy.sigstore.dev/v1beta1","kind":"ClusterImagePolicy",` +
	`"metadata":{"name":"vertra-webhook-probe"},` +
	`"spec":{"images":[{"glob":"vertra.invalid/**"}],"authorities":[{"static":{"action":"pass"}}]}}`
