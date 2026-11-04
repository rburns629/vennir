// SPDX-License-Identifier: MIT

// Package config is an install's settings: deploy/<env>/vennir.yaml.
// Names and references only, never a secret, so it's safe to keep in a
// private repository of your own.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// FileName is the config file inside an environment's directory.
const FileName = "vennir.yaml"

// CurrentVersion is the config file format this CLI writes.
const CurrentVersion = 1

// Targets, sizes and cluster modes: the closed support matrix (cli/DESIGN.md).
var (
	Targets      = []string{"kind", "gcp", "aws", "azure", "existing"}
	Implemented  = []string{"kind", "gcp", "aws", "existing"} // azure comes with its OpenTofu module
	Sizes        = []string{"minimal", "resilient", "scaled", "auto"}
	ClusterModes = []string{"auto", "standard", "existing"}
)

// Config is one install's settings.
type Config struct {
	Version int `yaml:"version"`
	// Vennir is the release to install, or "source" to build from Source.
	Vennir string `yaml:"vennir"`
	// Source is a checkout of the Vennir repository: charts from its
	// helm/charts, images built from its kernel/ and console/.
	Source     string     `yaml:"source,omitempty"`
	Target     string     `yaml:"target"`
	Cluster    Cluster    `yaml:"cluster"`
	Kind       Kind       `yaml:"kind,omitempty"`
	GCP        GCP        `yaml:"gcp,omitempty"`
	AWS        AWS        `yaml:"aws,omitempty"`
	Namespace  string     `yaml:"namespace"`
	TaskImages TaskImages `yaml:"taskImages"`
	// PlatformImages, when building from source onto a cluster that isn't
	// kind: the registry the built images are pushed to.
	PlatformImages PlatformImages `yaml:"platformImages,omitempty"`
	Size           string         `yaml:"size"`
	ScaleDown      ScaleDown      `yaml:"scaleDown"`
	// MinReplicas: always-on copies of the console and kernel-api when
	// ScaleDown is off.
	MinReplicas  int      `yaml:"minReplicas"`
	StepHeadroom int      `yaml:"stepHeadroom"`
	Database     Database `yaml:"database"`
	Admin        Admin    `yaml:"admin"`
	// Console says how the console is reached from outside the cluster.
	Console Console `yaml:"console,omitempty"`
	// Catalog is the catalog repository `vennir catalog create` creates.
	Catalog Catalog `yaml:"catalog,omitempty"`
	// ExternalCatalog: this install reads another install's catalog (its
	// images and release, in that install's registry) instead of one of
	// its own.
	ExternalCatalog ExternalCatalog `yaml:"externalCatalog,omitempty"`
	// CatalogSignature: who may sign the catalog's releases.
	CatalogSignature CatalogSignature `yaml:"catalogSignature,omitempty"`
	// ExternalSecrets: install External Secrets Operator, so teams'
	// SecretStores can sync their vaults' secrets (on aws, signing in by
	// IRSA, the cluster's issuer registered in IAM).
	ExternalSecrets bool `yaml:"externalSecrets,omitempty"`
	// CatalogVersion: which of the catalog's releases this install applies.
	// latest (the default): each one main publishes; newest: the newest
	// version (a vX.Y.Z tag in the catalog repository); or one version,
	// such as v1.4.0, pinned.
	CatalogVersion string `yaml:"catalogVersion,omitempty"`
	// Signing: how this install's catalog CI signs its images and releases,
	// which the install then requires (policy-controller refuses unsigned
	// images; the console, unsigned releases). none (the default); kms: a
	// key apply makes in the cloud's KMS, which only the catalog
	// repository's CI may sign with; keyless: CI's own GitHub identity,
	// through Sigstore (recorded in its public transparency log).
	Signing string `yaml:"signing,omitempty"`
	// Gateway: the API gateway, which serves the catalog's API products.
	Gateway Gateway `yaml:"gateway,omitempty"`
	// Logs: log search in Observe (Loki), and how long logs are kept.
	Logs Logs `yaml:"logs"`
	// Audit: the audit log's write-once copy (gcp, aws).
	Audit Audit `yaml:"audit,omitempty"`
	// SSO: signing in with Google (vennir sso google sets it up).
	SSO SSO `yaml:"sso,omitempty"`
	// Chat: the console's chat agent. On gcp, Gemini through Vertex AI in
	// the install's own project; on aws, Claude in Amazon Bedrock in its
	// region; unless it's off. Elsewhere, the console chart's chat values.
	Chat Chat `yaml:"chat,omitempty"`
	// Monitoring: Prometheus for the platform's metrics and alerts: the
	// cluster's Prometheus Operator, GKE's Managed Service for Prometheus,
	// or a Prometheus of the install's own.
	Monitoring Monitoring `yaml:"monitoring,omitempty"`
	// Access records who set this environment up, so a later run signed in
	// as someone else (another account, profile or project) stops first.
	Access Access `yaml:"access,omitempty"`
	// Values is a Helm values file layered last, relative to the config's
	// directory: anything vennir doesn't ask about.
	Values string `yaml:"values,omitempty"`
}

// Cluster says which cluster, and whether vennir creates it.
type Cluster struct {
	Create bool   `yaml:"create"`
	Mode   string `yaml:"mode"`
	Name   string `yaml:"name,omitempty"`
	// Context is the kubectl context for an existing cluster.
	Context string `yaml:"context,omitempty"`
	// Cloud is the cloud an existing cluster is on (gcp, aws, azure), for
	// the catalog's products made for that cloud (InstallCloud).
	Cloud string `yaml:"cloud,omitempty"`
}

// InstallCloud is the cloud the console says this install is on, which
// decides which catalog products are for it: the target's, or for an
// existing cluster the cloud it's on when cluster.cloud says.
func (c *Config) InstallCloud() string {
	if c.Target == "existing" && c.Cluster.Cloud != "" {
		return c.Cluster.Cloud
	}
	return c.Target
}

// Kind holds kind (local)'s own settings.
type Kind struct {
	RegistryName string `yaml:"registryName,omitempty"`
	RegistryPort int    `yaml:"registryPort,omitempty"`
}

// GCP is where a gcp install goes.
type GCP struct {
	Project string `yaml:"project,omitempty"`
	Region  string `yaml:"region,omitempty"`
}

// AWS is where an aws install goes: the account is the profile's.
type AWS struct {
	// Profile is the AWS CLI profile to sign in with (`aws login` or
	// `aws configure sso`); empty for the default credential chain.
	Profile string `yaml:"profile,omitempty"`
	Region  string `yaml:"region,omitempty"`
}

// TaskImages is where steps' images may come from: the image policy's
// source registry, e.g. localhost:5001 or us-docker.pkg.dev/p/catalog. On
// a cloud target it can instead be a repository the module creates
// (Create, Name), whose path is then known after apply.
type TaskImages struct {
	Registry string `yaml:"registry,omitempty"`
	Create   bool   `yaml:"create,omitempty"`
	Name     string `yaml:"name,omitempty"`
}

// PlatformImages is where images built from source are pushed.
type PlatformImages struct {
	Registry string `yaml:"registry,omitempty"`
}

// ScaleDown: sleep when idle, or stay up.
type ScaleDown struct {
	Enabled   bool   `yaml:"enabled"`
	IdleAfter string `yaml:"idleAfter,omitempty"`
	Schedule  string `yaml:"schedule,omitempty"`
}

// Database: in-cluster Postgres (with backups) or managed.
type Database struct {
	Type             string  `yaml:"type"`
	HighAvailability bool    `yaml:"highAvailability,omitempty"`
	Backups          Backups `yaml:"backups"`
}

// Backups of the in-cluster database.
type Backups struct {
	Enabled       bool `yaml:"enabled"`
	RetentionDays int  `yaml:"retentionDays,omitempty"`
}

// Logs: steps' and the platform's logs collected into Loki for Observe's
// search. Searchable for SearchDays; then, on gcp and aws, moved to the
// bucket's archive storage class; deleted after KeepDays.
type Logs struct {
	Enabled    bool `yaml:"enabled"`
	SearchDays int  `yaml:"searchDays,omitempty"`
	KeepDays   int  `yaml:"keepDays,omitempty"`
}

// Audit: a bucket that refuses deletes and overwrites, which the console
// copies its audit log to every few minutes. Lock makes the retention
// permanent: it can't be shortened, nor the bucket deleted, until it lapses.
type Audit struct {
	Export   bool `yaml:"export"`
	KeepDays int  `yaml:"keepDays,omitempty"`
	Lock     bool `yaml:"lock,omitempty"`
}

// Chat is the console's chat agent on gcp and aws.
type Chat struct {
	Off bool `yaml:"off,omitempty"`
	// Model is the cloud's name for it (Vertex's, Bedrock's); empty for
	// DefaultChatModel or DefaultBedrockModel.
	Model string `yaml:"model,omitempty"`
}

// DefaultChatModel answers on gcp unless chat.model says otherwise: the
// one scored, and the console's own default on Vertex.
const DefaultChatModel = "google/gemini-3.5-flash"

// DefaultBedrockModel answers on aws unless chat.model says otherwise: a
// Claude open to every Bedrock account, and the console's own default there.
const DefaultBedrockModel = "anthropic.claude-sonnet-5"

// ChatOnVertex: the chat agent answers through Vertex AI in the install's project.
func (c *Config) ChatOnVertex() bool { return c.Target == "gcp" && !c.Chat.Off }

// ChatOnBedrock: the chat agent answers through Amazon Bedrock in the install's region.
func (c *Config) ChatOnBedrock() bool { return c.Target == "aws" && !c.Chat.Off }

// ChatModel is the model it answers with.
func (c *Config) ChatModel() string {
	if c.Chat.Model != "" {
		return c.Chat.Model
	}
	if c.Target == "aws" {
		return DefaultBedrockModel
	}
	return DefaultChatModel
}

// SSO is single sign-on with Google: an OAuth web client made in Google's
// console. ClientFile is the client's downloaded JSON, read at apply to
// make the console's Secret; the secret itself is never written here.
type SSO struct {
	Provider       string   `yaml:"provider,omitempty"` // google
	ClientID       string   `yaml:"clientId,omitempty"`
	ClientFile     string   `yaml:"clientFile,omitempty"`
	AllowedDomains []string `yaml:"allowedDomains,omitempty"`
	// RedirectURL: the console's sign-in callback, as registered with the client.
	RedirectURL string `yaml:"redirectUrl,omitempty"`
	// GoogleGroups: the console reads people's Google Workspace groups, as
	// its own service account (which a Workspace admin makes a Groups
	// Reader), for mapping groups to teams. gcp only; whatever the provider.
	GoogleGroups bool `yaml:"googleGroups,omitempty"`
}

// Monitoring is which Prometheus scrapes the platform and evaluates its
// alerts (Provider): the cluster's Prometheus Operator (operator, as vennir
// init found it: the namespace it scrapes from, and the labels it selects
// PodMonitors and rules by), GKE's Managed Service for Prometheus
// (google, gcp; billed per sample), one the console chart runs (bundled: a
// Pod and a small volume), or that one writing to Amazon Managed Service
// for Prometheus, whose Alertmanager sends its alerts to an SNS topic
// (amazon, aws).
type Monitoring struct {
	Enabled bool `yaml:"enabled,omitempty"`
	// Provider: operator (empty means operator, as before), google,
	// bundled or amazon.
	Provider string `yaml:"provider,omitempty"`
	// AlertEmail (amazon): subscribed to the alerts' SNS topic.
	AlertEmail       string            `yaml:"alertEmail,omitempty"`
	Namespace        string            `yaml:"namespace,omitempty"`
	PodMonitorLabels map[string]string `yaml:"podMonitorLabels,omitempty"`
	RuleLabels       map[string]string `yaml:"ruleLabels,omitempty"`
}

// Console: reached over HTTPS from the internet (what the catalog's CI
// needs), on Hostname or, if empty, a nip.io name for its address.
type Console struct {
	Public   bool   `yaml:"public,omitempty"`
	Hostname string `yaml:"hostname,omitempty"`
	// Zone (aws): a DNS zone the module creates in Route 53 for the
	// console's address (e.g. vennir.example.com), which you delegate with
	// its NS records; the hostname defaults to console.<zone>.
	Zone string `yaml:"zone,omitempty"`
	// IngressClass (existing clusters): the Ingress controller serving it.
	IngressClass string `yaml:"ingressClass,omitempty"`
	// TLS (existing clusters): its certificate, from cert-manager.
	TLS ConsoleTLS `yaml:"tls,omitempty"`
}

// ConsoleTLS is where a public console's certificate comes from on an
// existing cluster: cert-manager, with an issuer of yours or Let's Encrypt.
type ConsoleTLS struct {
	// Issuer is a cert-manager ClusterIssuer already in the cluster.
	Issuer string `yaml:"issuer,omitempty"`
	// LetsEncryptEmail: Let's Encrypt, through an Issuer the console chart
	// makes, proving the hostname over HTTP through the Ingress.
	LetsEncryptEmail string `yaml:"letsEncryptEmail,omitempty"`
	// InstallCertManager: vennir installs cert-manager (pinned) when the
	// cluster hasn't got it.
	InstallCertManager bool `yaml:"installCertManager,omitempty"`
}

// Catalog is where the catalog repository goes and what it starts with.
type Catalog struct {
	Host       string `yaml:"host,omitempty"` // github (gitlab later)
	Owner      string `yaml:"owner,omitempty"`
	Repository string `yaml:"repository,omitempty"`
	Visibility string `yaml:"visibility,omitempty"` // public | private | internal
	// Team is the first team's name; Languages its starters.
	Team      string   `yaml:"team,omitempty"`
	Languages []string `yaml:"languages,omitempty"`
	// UseExisting: the repository already existed, and you chose it: its
	// contents stay, and only its variables, secrets and federation are set.
	UseExisting bool `yaml:"useExisting,omitempty"`
	// SubjectPrefix is how GitHub names the repository in its OIDC tokens
	// (repo:<owner>@<id>/<name>@<id> with immutable subjects), read once it
	// exists; the AWS role trusts exactly it.
	SubjectPrefix string `yaml:"subjectPrefix,omitempty"`
}

// ExternalCatalog is a catalog published to another install's registry.
type ExternalCatalog struct {
	// Registry holds its images and its release (catalog-release), such as
	// us-central1-docker.pkg.dev/<project>/vennir-products: the image
	// policy's source, and where the console reads the release.
	Registry string `yaml:"registry,omitempty"`
	// GCPWorkloadIdentityProvider, for an Artifact Registry on another
	// cloud: projects/<number>/locations/global/workloadIdentityPools/
	// <pool>/providers/<provider>, a provider trusting this cluster's OIDC
	// issuer. The console reads it with no stored key, and hands the
	// kubelet and its Jobs short-lived tokens (docs/operations.md).
	GCPWorkloadIdentityProvider string `yaml:"gcpWorkloadIdentityProvider,omitempty"`
	// GCPServiceAccount, if the federated identity should impersonate one
	// rather than be granted the repository itself.
	GCPServiceAccount string `yaml:"gcpServiceAccount,omitempty"`
	// AWSRoleArn, for an Amazon ECR registry this install can't read as
	// itself (another account's, or read from another cloud): the owner's
	// role that trusts this cluster's OIDC issuer for the console's
	// ServiceAccount alone (`vennir catalog grant`). The console assumes it
	// with its projected token (AWS web identity), with no stored key, and
	// hands the kubelet and its Jobs ECR's short-lived token.
	AWSRoleArn string `yaml:"awsRoleArn,omitempty"`
}

// Federated says whether the console signs in to the catalog's registry
// by federation (another cloud's or account's identity) rather than as
// itself.
func (e ExternalCatalog) Federated() bool {
	return e.GCPWorkloadIdentityProvider != "" || e.AWSRoleArn != ""
}

// IsArtifactRegistry says whether a registry path is in Google Artifact
// Registry (<region>-docker.pkg.dev/...).
func IsArtifactRegistry(registry string) bool {
	return strings.HasSuffix(strings.SplitN(registry, "/", 2)[0], "-docker.pkg.dev")
}

// ECRRegistry is an Amazon ECR registry path's account, region and
// repository prefix; all empty when it isn't ECR.
func ECRRegistry(registry string) (account, region, prefix string) {
	host, path, _ := strings.Cut(registry, "/")
	m := ecrHost.FindStringSubmatch(host)
	if m == nil {
		return "", "", ""
	}
	return m[1], m[2], path
}

// Gateway is the API gateway's settings (the console chart's gateway).
type Gateway struct {
	Enabled bool `yaml:"enabled,omitempty"`
	// BackendHosts are the hosts API backends may be under: exactly, or
	// "*.a.run.app" for any name below it.
	BackendHosts []string `yaml:"backendHosts,omitempty"`
	// InternetTeams may publish APIs to the internet.
	InternetTeams []string `yaml:"internetTeams,omitempty"`
}

// CatalogSignature is who signs a catalog another install publishes
// (externalCatalog): its key, or its repository's CI signing keyless. On
// gcp and aws this install then refuses releases and images it didn't
// sign, as the owner does (signing); elsewhere, releases.
type CatalogSignature struct {
	// PublicKeyFile is the catalog's cosign public key (PEM), relative to
	// this directory: a generated key's, or the owner's KMS key's.
	PublicKeyFile string `yaml:"publicKeyFile,omitempty"`
	// PublicKey is its contents, read by Load.
	PublicKey string `yaml:"-"`
	// Repository is the catalog repository (owner/name) whose ci.yml on
	// main signs keyless.
	Repository string `yaml:"repository,omitempty"`
}

// Languages are the starters a catalog can begin with: the language, and
// its product in the template's samples/local.
var Languages = map[string]string{
	"python": "title-case", "typescript": "reverse", "go": "slug", "powershell": "upper-case", "rust": "rot13",
}

// Repo is the catalog's owner/name, or "" without one.
func (c Catalog) Repo() string {
	if c.Owner == "" || c.Repository == "" {
		return ""
	}
	return c.Owner + "/" + c.Repository
}

// Access is who set the environment up: "aws:<principal arn>" or
// "gcp:<account>", and "github:<login>".
type Access struct {
	Cloud  string `yaml:"cloud,omitempty"`
	GitHub string `yaml:"github,omitempty"`
}

// Admin is the first admin account.
type Admin struct {
	Email string `yaml:"email"`
}

// Default returns a config with every default filled in for a target.
func Default(target string) *Config {
	c := &Config{
		Version:   CurrentVersion,
		Vennir:    "source",
		Target:    target,
		Namespace: "vennir-system",
		Size:      "minimal",
		ScaleDown: ScaleDown{Enabled: true, IdleAfter: "2h"},
		Database:  Database{Type: "in-cluster", Backups: Backups{Enabled: false, RetentionDays: 30}},
		Logs:      Logs{SearchDays: 30, KeepDays: 365},
		Audit:     Audit{KeepDays: 365},
	}
	switch target {
	case "kind":
		c.Cluster = Cluster{Create: true, Mode: "standard", Name: "vennir"}
		c.Kind = Kind{RegistryName: "kind-registry", RegistryPort: 5001}
		c.TaskImages.Registry = "localhost:5001"
	case "gcp":
		c.Cluster = Cluster{Create: true, Mode: "auto", Name: "vennir"}
		c.TaskImages = TaskImages{Create: true, Name: "vennir-products"}
		c.Database.Backups.Enabled = true
	case "aws":
		c.Cluster = Cluster{Create: true, Mode: "auto", Name: "vennir"}
		c.TaskImages = TaskImages{Create: true, Name: "vennir-products"}
		c.Database.Backups.Enabled = true
	case "existing":
		c.Cluster = Cluster{Create: false, Mode: "existing"}
	}
	return c
}

// FillDefaults sets anything left empty, so an older or hand-written file
// behaves like one init wrote.
func (c *Config) FillDefaults() {
	d := Default(c.Target)
	if c.Version == 0 {
		c.Version = CurrentVersion
	}
	if c.Vennir == "" {
		c.Vennir = d.Vennir
	}
	if c.Namespace == "" {
		c.Namespace = d.Namespace
	}
	if c.Size == "" {
		c.Size = d.Size
	}
	if c.Database.Type == "" {
		c.Database.Type = d.Database.Type
	}
	if c.ScaleDown.Enabled && c.ScaleDown.IdleAfter == "" {
		c.ScaleDown.IdleAfter = d.ScaleDown.IdleAfter
	}
	if !c.ScaleDown.Enabled && c.MinReplicas == 0 {
		c.MinReplicas = 1
	}
	if c.Target == "kind" {
		if c.Cluster.Name == "" {
			c.Cluster.Name = d.Cluster.Name
		}
		if c.Kind.RegistryName == "" {
			c.Kind.RegistryName = d.Kind.RegistryName
		}
		if c.Kind.RegistryPort == 0 {
			c.Kind.RegistryPort = d.Kind.RegistryPort
		}
		if c.TaskImages.Registry == "" {
			c.TaskImages.Registry = fmt.Sprintf("localhost:%d", c.Kind.RegistryPort)
		}
	}
}

var (
	dnsLabel = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)
	// <host>/<path>: a registry and repository path, no tag.
	registryPath = regexp.MustCompile(`^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+$`)
	chatModel    = regexp.MustCompile(`^google/[a-z0-9][a-z0-9.-]*$`)
	bedrockModel = regexp.MustCompile(`^anthropic\.claude-[a-z0-9][a-z0-9.-]*$`)
	ecrHost      = regexp.MustCompile(`^([0-9]{12})\.dkr\.ecr\.([a-z]{2}(?:-gov)?-[a-z]+-[0-9])\.amazonaws\.com$`)
	awsRole      = regexp.MustCompile(`^arn:aws(?:-us-gov)?:iam::([0-9]{12}):role/[A-Za-z0-9+=,.@_/-]{1,64}$`)
	wifProvider  = regexp.MustCompile(`^projects/[0-9]+/locations/global/workloadIdentityPools/[a-z0-9-]{4,32}/providers/[a-z0-9-]{4,32}$`)
	gcpProject   = regexp.MustCompile(`^[a-z][-a-z0-9]{4,28}[a-z0-9]$`)
	gcpRegion    = regexp.MustCompile(`^[a-z]+-[a-z]+[0-9]$`)
	gcpName      = regexp.MustCompile(`^[a-z][a-z0-9-]{1,18}[a-z0-9]$`)
	awsRegion    = regexp.MustCompile(`^[a-z]{2}(-gov)?-[a-z]+-[0-9]$`)
	ecrPrefix    = regexp.MustCompile(`^[a-z0-9]+([._-][a-z0-9]+)*$`)
	hostname     = regexp.MustCompile(`^([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.)+[a-z]{2,}$`)
	githubName   = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9._-]{0,98})$`)
	// owner/name, a GitHub repository.
	repoPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,98}/[A-Za-z0-9][A-Za-z0-9._-]{0,98}$`)
	version     = regexp.MustCompile(`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`)
)

// Validate returns every problem with the config, not just the first.
func (c *Config) Validate() error {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }

	if c.Version != CurrentVersion {
		add("version: %d isn't a format this vennir reads (it writes %d)", c.Version, CurrentVersion)
	}
	if !contains(Targets, c.Target) {
		add("target: %q isn't one of %s", c.Target, strings.Join(Targets, ", "))
	} else if !contains(Implemented, c.Target) {
		add("target: %s isn't supported by this vennir yet (kind and existing are)", c.Target)
	}
	if c.Vennir != "source" && !version.MatchString(c.Vennir) {
		add("vennir: %q is neither a release version (like 0.1.0) nor \"source\"", c.Vennir)
	}
	if c.Vennir == "source" {
		if c.Source == "" {
			add("source: needed when vennir is \"source\": the path to a Vennir checkout")
		} else if _, err := os.Stat(filepath.Join(c.Source, "helm", "charts", "execution-kernel", "Chart.yaml")); err != nil {
			add("source: %s isn't a Vennir checkout (no helm/charts/execution-kernel)", c.Source)
		}
	}
	if !dnsLabel.MatchString(c.Namespace) {
		add("namespace: %q isn't a valid namespace name", c.Namespace)
	}
	if !contains(Sizes, c.Size) {
		add("size: %q isn't one of %s", c.Size, strings.Join(Sizes, ", "))
	}
	if !contains(ClusterModes, c.Cluster.Mode) && !(c.Target == "kind" && c.Cluster.Mode == "standard") {
		add("cluster.mode: %q isn't one of %s", c.Cluster.Mode, strings.Join(ClusterModes, ", "))
	}
	switch c.Target {
	case "kind":
		if !dnsLabel.MatchString(c.Cluster.Name) {
			add("cluster.name: %q isn't a valid kind cluster name", c.Cluster.Name)
		}
		// The registry's name is also its hostname on the kind network.
		if !dnsLabel.MatchString(c.Kind.RegistryName) {
			add("kind.registryName: %q isn't a valid hostname (lowercase letters, digits and dashes)", c.Kind.RegistryName)
		}
		if c.Kind.RegistryPort < 1024 || c.Kind.RegistryPort > 65535 {
			add("kind.registryPort: %d isn't a usable port", c.Kind.RegistryPort)
		}
	case "gcp":
		if !gcpProject.MatchString(c.GCP.Project) {
			add("gcp.project: %q isn't a project id (6 to 30 lowercase letters, digits and dashes)", c.GCP.Project)
		}
		if !gcpRegion.MatchString(c.GCP.Region) {
			add("gcp.region: %q isn't a region, like us-central1", c.GCP.Region)
		}
		if !gcpName.MatchString(c.Cluster.Name) {
			add("cluster.name: %q: 3 to 20 lowercase letters, digits and dashes, starting with a letter", c.Cluster.Name)
		}
		if c.Cluster.Mode != "auto" && c.Cluster.Mode != "standard" {
			add("cluster.mode: %q: auto (GKE Autopilot) or standard on gcp", c.Cluster.Mode)
		}
		if c.TaskImages.Create && !dnsLabel.MatchString(c.TaskImages.Name) {
			add("taskImages.name: %q isn't a repository name", c.TaskImages.Name)
		}
	case "aws":
		if !awsRegion.MatchString(c.AWS.Region) {
			add("aws.region: %q isn't a region, like us-east-1", c.AWS.Region)
		}
		if !gcpName.MatchString(c.Cluster.Name) {
			add("cluster.name: %q: 3 to 20 lowercase letters, digits and dashes, starting with a letter", c.Cluster.Name)
		}
		if c.Cluster.Mode != "auto" && c.Cluster.Mode != "standard" {
			add("cluster.mode: %q: auto (EKS Auto Mode) or standard (node groups) on aws", c.Cluster.Mode)
		}
		if c.TaskImages.Create && !ecrPrefix.MatchString(c.TaskImages.Name) {
			add("taskImages.name: %q isn't an ECR repository prefix", c.TaskImages.Name)
		}
	case "existing":
		if c.Cluster.Context == "" {
			add("cluster.context: the kubectl context of the existing cluster is needed")
		}
		if c.Cluster.Cloud != "" && c.Cluster.Cloud != "gcp" && c.Cluster.Cloud != "aws" && c.Cluster.Cloud != "azure" {
			add("cluster.cloud: %q: gcp, aws or azure, the cloud the cluster is on (or empty)", c.Cluster.Cloud)
		}
		if c.Vennir == "source" && c.PlatformImages.Registry == "" {
			add("platformImages.registry: building from source onto an existing cluster needs a registry to push the images to")
		}
	}
	if c.TaskImages.Registry == "" && !c.TaskImages.Create {
		add("taskImages.registry: where steps' images may come from is needed")
	}
	if c.ScaleDown.Enabled {
		if _, err := time.ParseDuration(c.ScaleDown.IdleAfter); err != nil {
			add("scaleDown.idleAfter: %q isn't a duration like 2h or 45m", c.ScaleDown.IdleAfter)
		}
		if c.ScaleDown.Schedule != "" && len(strings.Fields(c.ScaleDown.Schedule)) != 5 {
			add("scaleDown.schedule: %q isn't a cron schedule (five fields, like \"0 20 * * 1-5\")", c.ScaleDown.Schedule)
		}
	} else if c.MinReplicas < 1 || c.MinReplicas > 10 {
		add("minReplicas: %d: at least 1 (and at most 10) when scaleDown is off", c.MinReplicas)
	}
	if c.Target == "existing" && c.Console.Public {
		if !hostname.MatchString(c.Console.Hostname) {
			add("console.hostname: %q: a public console on an existing cluster needs the hostname it's reached at", c.Console.Hostname)
		}
		if c.Console.IngressClass == "" {
			add("console.ingressClass: the Ingress class that serves it (kubectl get ingressclass)")
		}
		if (c.Console.TLS.Issuer == "") == (c.Console.TLS.LetsEncryptEmail == "") {
			add("console.tls: one of issuer (a cert-manager ClusterIssuer) or letsEncryptEmail")
		}
		if e := c.Console.TLS.LetsEncryptEmail; e != "" && !strings.Contains(e, "@") {
			add("console.tls.letsEncryptEmail: %q isn't an email address", e)
		}
	}
	if r := c.CatalogSignature.Repository; r != "" && !repoPattern.MatchString(r) {
		add("catalogSignature.repository: %q isn't owner/name, such as my-org/vennir-catalog", r)
	}
	if c.Signs() && (c.CatalogSignature.PublicKeyFile != "" || c.CatalogSignature.Repository != "") {
		add("catalogSignature: for a catalog another install publishes; this install signs its own (signing: %s)", c.Signing)
	}
	if v := c.CatalogVersion; v != "" && v != "latest" && v != "newest" && !CatalogVersionPattern.MatchString(v) {
		add("catalogVersion: %q: latest, newest, or a version such as v1.4.0", v)
	}
	switch c.Signing {
	case "", "none":
	case "kms", "keyless":
		if c.Target != "gcp" && c.Target != "aws" {
			add("signing: %s needs a cloud target (gcp, aws): policy-controller checks images in the cloud's registry", c.Signing)
		}
		if c.Catalog.Repo() == "" {
			add("signing: %s is for this install's own catalog (catalog.owner and catalog.repository), whose CI signs", c.Signing)
		}
	default:
		add("signing: %q: none, kms or keyless", c.Signing)
	}
	if c.Chat.Model != "" {
		switch {
		case c.Target == "gcp" && !chatModel.MatchString(c.Chat.Model):
			add("chat.model: %q: Vertex's name for a Gemini model, such as %s", c.Chat.Model, DefaultChatModel)
		case c.Target == "aws" && !bedrockModel.MatchString(c.Chat.Model):
			add("chat.model: %q: Bedrock's name for a Claude model, such as %s", c.Chat.Model, DefaultBedrockModel)
		case c.Target != "gcp" && c.Target != "aws":
			add("chat.model: gcp and aws only (elsewhere, set the console chart's chat values)")
		}
	}
	if c.SSO.GoogleGroups && c.Target != "gcp" {
		add("sso.googleGroups: gcp only (the console reads groups as its own Google service account)")
	}
	if c.SSO.Provider != "" {
		if c.SSO.Provider != "google" {
			add("sso.provider: %q: google, so far", c.SSO.Provider)
		}
		if c.SSO.ClientID == "" || c.SSO.ClientFile == "" {
			add("sso: clientId and clientFile (vennir sso google sets them)")
		}
		if len(c.SSO.AllowedDomains) == 0 {
			add("sso.allowedDomains: the Workspace domains whose people may sign in")
		}
	}
	if c.Logs.Enabled {
		if c.Logs.SearchDays < 1 || c.Logs.SearchDays > 365 {
			add("logs.searchDays: %d isn't between 1 and 365", c.Logs.SearchDays)
		}
		if c.Logs.KeepDays < c.Logs.SearchDays || c.Logs.KeepDays > 3650 {
			add("logs.keepDays: %d: at least logs.searchDays (%d), at most 3650", c.Logs.KeepDays, c.Logs.SearchDays)
		}
	}
	if c.Monitoring.Enabled {
		switch c.Monitoring.ProviderName() {
		case "operator":
			if c.Monitoring.Namespace == "" {
				add("monitoring.namespace: the namespace the Prometheus Operator scrapes from")
			}
		case "google":
			if c.Target != "gcp" {
				add("monitoring.provider: google (GKE's Managed Service for Prometheus) is only on gcp")
			}
		case "amazon":
			if c.Target != "aws" {
				add("monitoring.provider: amazon (Amazon Managed Service for Prometheus) is only on aws")
			}
			if c.Monitoring.AlertEmail != "" && !strings.Contains(c.Monitoring.AlertEmail, "@") {
				add("monitoring.alertEmail: %q isn't an email address", c.Monitoring.AlertEmail)
			}
		case "bundled":
		default:
			add("monitoring.provider: %q isn't operator, google, bundled or amazon", c.Monitoring.Provider)
		}
	}
	if c.Audit.Export {
		if c.Target != "gcp" && c.Target != "aws" {
			add("audit.export: only on gcp and aws, where vennir makes the bucket (elsewhere, set the console chart's audit.export)")
		}
		if c.Audit.KeepDays < 1 || c.Audit.KeepDays > 3650 {
			add("audit.keepDays: %d isn't between 1 and 3650", c.Audit.KeepDays)
		}
	}
	if c.StepHeadroom < 0 || c.StepHeadroom > 100 {
		add("stepHeadroom: %d isn't between 0 and 100", c.StepHeadroom)
	}
	switch c.Database.Type {
	case "in-cluster":
	case "managed":
		switch c.Target {
		case "kind", "existing":
			add("database.type: managed needs a cloud target; kind and existing use the in-cluster database")
		}
	default:
		add("database.type: %q isn't in-cluster or managed", c.Database.Type)
	}
	if c.Console.Hostname != "" && !hostname.MatchString(c.Console.Hostname) {
		add("console.hostname: %q isn't a hostname", c.Console.Hostname)
	}
	if c.Console.Public && c.Target != "gcp" && c.Target != "aws" && c.Target != "existing" {
		add("console.public: only gcp, aws and existing clusters can expose the console so far")
	}
	if c.Console.Public && c.Target == "aws" {
		if !hostname.MatchString(c.Console.Zone) {
			add("console.zone: %q: a DNS zone for the console's address, like vennir.example.com (Route 53 hosts it; you delegate it)", c.Console.Zone)
		}
		if c.Cluster.Mode != "auto" {
			add("console.public: on aws, only with EKS Auto Mode so far (standard mode needs the AWS Load Balancer Controller)")
		}
	}
	if c.Catalog.Repo() != "" {
		if c.Catalog.Host != "github" {
			add("catalog.host: %q: github (gitlab comes later)", c.Catalog.Host)
		}
		if !githubName.MatchString(c.Catalog.Owner) || !githubName.MatchString(c.Catalog.Repository) {
			add("catalog: %q isn't a GitHub owner/repository", c.Catalog.Repo())
		}
		if !contains([]string{"public", "private", "internal"}, c.Catalog.Visibility) {
			add("catalog.visibility: %q: public, private or internal", c.Catalog.Visibility)
		}
		if !dnsLabel.MatchString(c.Catalog.Team) {
			add("catalog.team: %q isn't a team name (lowercase letters, digits and dashes)", c.Catalog.Team)
		}
		for _, l := range c.Catalog.Languages {
			if Languages[l] == "" {
				add("catalog.languages: %q isn't one of python, typescript, go, powershell, rust", l)
			}
		}
		if c.Target != "gcp" && c.Target != "aws" {
			add("catalog: only gcp and aws installs give its CI a registry to publish to so far")
		}
	}
	if e := c.ExternalCatalog; e.Registry != "" || e.GCPWorkloadIdentityProvider != "" || e.GCPServiceAccount != "" || e.AWSRoleArn != "" {
		if c.Catalog.Repo() != "" {
			add("externalCatalog: an install reads its own catalog or another's, not both (catalog.owner is set)")
		}
		if !registryPath.MatchString(e.Registry) {
			add("externalCatalog.registry: %q isn't <host>/<path>, such as us-central1-docker.pkg.dev/<project>/vennir-products", e.Registry)
		}
		if e.GCPWorkloadIdentityProvider != "" && !wifProvider.MatchString(e.GCPWorkloadIdentityProvider) {
			add("externalCatalog.gcpWorkloadIdentityProvider: %q isn't projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>", e.GCPWorkloadIdentityProvider)
		}
		if e.GCPWorkloadIdentityProvider != "" && !IsArtifactRegistry(e.Registry) {
			add("externalCatalog.gcpWorkloadIdentityProvider: only for an Artifact Registry (<region>-docker.pkg.dev/...)")
		}
		if e.GCPServiceAccount != "" && e.GCPWorkloadIdentityProvider == "" {
			add("externalCatalog.gcpServiceAccount: needs gcpWorkloadIdentityProvider")
		}
		if e.AWSRoleArn != "" {
			account, _, _ := ECRRegistry(e.Registry)
			m := awsRole.FindStringSubmatch(e.AWSRoleArn)
			switch {
			case m == nil:
				add("externalCatalog.awsRoleArn: %q isn't arn:aws:iam::<account>:role/<name>", e.AWSRoleArn)
			case account == "":
				add("externalCatalog.awsRoleArn: only for an Amazon ECR registry (<account>.dkr.ecr.<region>.amazonaws.com/...)")
			case m[1] != account:
				// The owner's role reads its own account's registry.
				add("externalCatalog.awsRoleArn: the role is in account %s and the registry in %s: it must be the registry owner's", m[1], account)
			}
			if e.GCPWorkloadIdentityProvider != "" {
				add("externalCatalog: gcpWorkloadIdentityProvider or awsRoleArn, not both")
			}
		}
	}
	if !strings.Contains(c.Admin.Email, "@") {
		add("admin.email: %q isn't an email address", c.Admin.Email)
	}
	if len(problems) > 0 {
		return errors.New("the config has problems:\n  - " + strings.Join(problems, "\n  - "))
	}
	return nil
}

// Load reads and validates dir/vennir.yaml.
func Load(dir string) (*Config, error) {
	data, err := os.ReadFile(filepath.Join(dir, FileName))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("no %s in %s: run `vennir init` first", FileName, dir)
		}
		return nil, err
	}
	var c Config
	dec := yaml.NewDecoder(strings.NewReader(string(data)))
	dec.KnownFields(true)
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Join(dir, FileName), err)
	}
	c.FillDefaults()
	if err := c.Validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Join(dir, FileName), err)
	}
	if f := c.CatalogSignature.PublicKeyFile; f != "" {
		key, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			return nil, fmt.Errorf("catalogSignature.publicKeyFile: %w", err)
		}
		if !strings.Contains(string(key), "-----BEGIN PUBLIC KEY-----") {
			return nil, fmt.Errorf("catalogSignature.publicKeyFile: %s isn't a PEM public key (cosign.pub)", f)
		}
		c.CatalogSignature.PublicKey = string(key)
	}
	return &c, nil
}

const header = `# A Vennir install's settings, written by vennir. Names and references
# only, never a secret: safe to keep in a private repository of your own.
# Change a setting with ` + "`vennir config set <key> <value>`" + `, then ` + "`vennir apply`" + `.
`

// Save writes dir/vennir.yaml, creating dir.
func (c *Config) Save(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, FileName), append([]byte(header), data...), 0o644)
}

// AppliedFile is vennir.yaml as last applied, kept beside it: what the next
// apply's screen says changed since.
const AppliedFile = "applied.yaml"

// SaveApplied writes dir/applied.yaml, once an apply has used c.
func (c *Config) SaveApplied(dir string) error {
	data, err := yaml.Marshal(c)
	if err != nil {
		return err
	}
	head := "# vennir.yaml as last applied, written by vennir apply: its screen names what changed since.\n"
	return os.WriteFile(filepath.Join(dir, AppliedFile), append([]byte(head), data...), 0o644)
}

// Applied reads dir/applied.yaml; nil when there's none (an install applied
// by an older vennir) or it can't be read, as it only informs the screen.
func Applied(dir string) *Config {
	data, err := os.ReadFile(filepath.Join(dir, AppliedFile))
	if err != nil {
		return nil
	}
	var c Config
	if err := yaml.Unmarshal(data, &c); err != nil {
		return nil
	}
	c.FillDefaults()
	return &c
}

// Changed lists the settings whose values differ between was and now, as
// dotted keys, sorted.
func Changed(was, now *Config) ([]string, error) {
	a, err := flatten(was)
	if err != nil {
		return nil, err
	}
	b, err := flatten(now)
	if err != nil {
		return nil, err
	}
	var out []string
	for k, v := range b {
		if a[k] != v {
			out = append(out, k)
		}
	}
	for k := range a {
		if _, ok := b[k]; !ok {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out, nil
}

// flatten is every setting of c as dotted key: value, a list or a map of
// labels as its YAML.
func flatten(c *Config) (map[string]string, error) {
	node, err := toNode(c)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	var walk func(n *yaml.Node, prefix string) error
	walk = func(n *yaml.Node, prefix string) error {
		for i := 0; i+1 < len(n.Content); i += 2 {
			key := n.Content[i].Value
			if prefix != "" {
				key = prefix + "." + key
			}
			v := n.Content[i+1]
			kind, known := settingKind(key)
			switch {
			case v.Kind == yaml.MappingNode && known && kind == reflect.Map:
				data, err := yaml.Marshal(v)
				if err != nil {
					return err
				}
				out[key] = string(data)
			case v.Kind == yaml.MappingNode:
				if err := walk(v, key); err != nil {
					return err
				}
			case v.Kind == yaml.ScalarNode:
				out[key] = v.Value
			default:
				data, err := yaml.Marshal(v)
				if err != nil {
					return err
				}
				out[key] = string(data)
			}
		}
		return nil
	}
	return out, walk(node, "")
}

// Get returns the value at a dotted key, e.g. scaleDown.enabled.
func Get(c *Config, key string) (string, error) {
	node, err := toNode(c)
	if err != nil {
		return "", err
	}
	found := find(node, strings.Split(key, "."))
	if found == nil {
		return "", fmt.Errorf("no setting %q (see `vennir config get` for every key)", key)
	}
	if found.Kind == yaml.ScalarNode {
		return found.Value, nil
	}
	out, err := yaml.Marshal(found)
	return strings.TrimSpace(string(out)), err
}

// Set changes the value at a dotted key, and returns the changed config
// (validated). Only existing scalar settings can be set.
func Set(c *Config, key, value string) (*Config, error) {
	node, err := toNode(c)
	if err != nil {
		return nil, err
	}
	kind, ok := settingKind(key)
	switch {
	case !ok:
		return nil, fmt.Errorf("no setting %q (`vennir help settings` lists every key)", key)
	case kind == reflect.Map:
		return nil, fmt.Errorf("%q is a map of labels: edit vennir.yaml, then apply", key)
	case key == "version":
		return nil, fmt.Errorf("version is the file's format, which vennir writes")
	}
	// A list is given comma-separated; empty is none.
	set := &yaml.Node{Kind: yaml.ScalarNode, Value: value, Tag: scalarTag(value)}
	if kind == reflect.Slice {
		set = &yaml.Node{Kind: yaml.SequenceNode}
		for _, item := range strings.Split(value, ",") {
			if item = strings.TrimSpace(item); item != "" {
				set.Content = append(set.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: item, Tag: "!!str"})
			}
		}
	}
	if found := find(node, strings.Split(key, ".")); found != nil {
		*found = *set
	} else if err := addSetting(node, strings.Split(key, "."), set); err != nil {
		// An empty optional setting isn't in the marshalled node: add it.
		return nil, err
	}
	var out Config
	if err := node.Decode(&out); err != nil {
		return nil, fmt.Errorf("%s: %w", key, err)
	}
	out.FillDefaults()
	if err := out.Validate(); err != nil {
		return nil, err
	}
	return &out, nil
}

// Keys lists every setting as key: value, sorted.
func Keys(c *Config) ([]string, error) {
	node, err := toNode(c)
	if err != nil {
		return nil, err
	}
	var out []string
	var walk func(n *yaml.Node, prefix string)
	walk = func(n *yaml.Node, prefix string) {
		for i := 0; i+1 < len(n.Content); i += 2 {
			key := n.Content[i].Value
			if prefix != "" {
				key = prefix + "." + key
			}
			v := n.Content[i+1]
			if v.Kind == yaml.MappingNode {
				walk(v, key)
			} else {
				out = append(out, key+": "+v.Value)
			}
		}
	}
	walk(node, "")
	sort.Strings(out)
	return out, nil
}

func toNode(c *Config) (*yaml.Node, error) {
	var doc yaml.Node
	if err := doc.Encode(c); err != nil {
		return nil, err
	}
	return &doc, nil
}

func find(n *yaml.Node, path []string) *yaml.Node {
	if len(path) == 0 {
		return n
	}
	if n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == path[0] {
			return find(n.Content[i+1], path[1:])
		}
	}
	return nil
}

// addSetting adds a setting the file hasn't got (an empty optional one),
// with the groups on its path.
func addSetting(n *yaml.Node, path []string, value *yaml.Node) error {
	for i, part := range path {
		var next *yaml.Node
		for j := 0; j+1 < len(n.Content); j += 2 {
			if n.Content[j].Value == part {
				next = n.Content[j+1]
			}
		}
		if next == nil {
			key := &yaml.Node{Kind: yaml.ScalarNode, Value: part}
			if i == len(path)-1 {
				next = value
			} else {
				next = &yaml.Node{Kind: yaml.MappingNode}
			}
			n.Content = append(n.Content, key, next)
		}
		n = next
	}
	return nil
}

func scalarTag(value string) string {
	if value == "true" || value == "false" {
		return "!!bool"
	}
	if _, err := strconv.Atoi(value); err == nil {
		return "!!int"
	}
	return "!!str"
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// Dir is the environment's directory: base/<env>, or base itself when it
// already holds a config.
func Dir(base, env string) (string, error) {
	if env != "" {
		if !dnsLabel.MatchString(env) {
			return "", fmt.Errorf("%q isn't a valid environment name (lowercase letters, digits and dashes)", env)
		}
		return filepath.Join(base, env), nil
	}
	if _, err := os.Stat(filepath.Join(base, FileName)); err == nil {
		return base, nil
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return "", fmt.Errorf("no environments in %s: run `vennir init <env>` first", base)
	}
	var envs []string
	for _, e := range entries {
		if _, err := os.Stat(filepath.Join(base, e.Name(), FileName)); e.IsDir() && err == nil {
			envs = append(envs, e.Name())
		}
	}
	switch len(envs) {
	case 0:
		return "", fmt.Errorf("no environments in %s: run `vennir init <env>` first", base)
	case 1:
		return filepath.Join(base, envs[0]), nil
	default:
		return "", fmt.Errorf("%s has several environments (%s): name one", base, strings.Join(envs, ", "))
	}
}

// Signs is whether this install's catalog is signed, and so required to be.
// CatalogVersionPattern is a catalog version: vX.Y.Z, as `vennir catalog
// promote` makes them.
var CatalogVersionPattern = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func (c *Config) Signs() bool {
	return c.Signing == "kms" || c.Signing == "keyless"
}

// VerifiesCatalog says whether this install reads another's catalog and
// enforces its signer on images too (policy-controller), not only on
// releases: on a cloud, whose registry policy-controller can read.
func (c *Config) VerifiesCatalog() bool {
	return c.ExternalCatalog.Registry != "" && (c.Target == "gcp" || c.Target == "aws") &&
		(c.CatalogSignature.PublicKeyFile != "" || c.CatalogSignature.Repository != "")
}

// ModuleSigning is signing as the cloud modules take it: verify for an
// install that only checks another's catalog (policy-controller's identity,
// no key), else signing.
func (c *Config) ModuleSigning() string {
	if c.VerifiesCatalog() {
		return "verify"
	}
	return c.Signing
}

// ChecksSignatures says whether policy-controller refuses unsigned images
// here: its own catalog signed, or another's verified.
func (c *Config) ChecksSignatures() bool {
	return c.Signs() || c.VerifiesCatalog()
}

// ProviderName is the Prometheus monitoring is for: operator when unset.
func (m Monitoring) ProviderName() string {
	if m.Provider == "" {
		return "operator"
	}
	return m.Provider
}
