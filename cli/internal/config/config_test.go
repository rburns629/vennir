// SPDX-License-Identifier: MIT

package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// checkout makes a directory that passes for a Vennir checkout.
func checkout(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	chart := filepath.Join(dir, "helm", "charts", "execution-kernel")
	if err := os.MkdirAll(chart, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chart, "Chart.yaml"), []byte("name: execution-kernel\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func validKind(t *testing.T) *Config {
	c := Default("kind")
	c.Source = checkout(t)
	c.Admin.Email = "admin@example.com"
	return c
}

func TestDefaultsAreValid(t *testing.T) {
	if err := validKind(t).Validate(); err != nil {
		t.Fatal(err)
	}
	c := Default("existing")
	c.Vennir = "0.1.0"
	c.Cluster.Context = "my-cluster"
	c.TaskImages.Registry = "us-docker.pkg.dev/p/catalog"
	c.Admin.Email = "admin@example.com"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestValidateReportsEveryProblem(t *testing.T) {
	c := validKind(t)
	c.Target = "mars"
	c.Vennir = "latest"
	c.Size = "huge"
	c.Namespace = "Not_A_Namespace"
	c.Admin.Email = "nobody"
	err := c.Validate()
	if err == nil {
		t.Fatal("expected problems")
	}
	for _, want := range []string{`target: "mars" isn't one of`, `vennir: "latest"`, `size: "huge"`, "namespace:", "admin.email:"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("missing %q in:\n%v", want, err)
		}
	}
}

func TestValidateKindRegistryName(t *testing.T) {
	c := validKind(t)
	c.Kind.RegistryName = "bad name; rm -rf"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "kind.registryName") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateSigning(t *testing.T) {
	c := validKind(t)
	c.Signing = "kms"
	err := c.Validate()
	if err == nil || !strings.Contains(err.Error(), "signing: kms needs a cloud target") || !strings.Contains(err.Error(), "this install's own catalog") {
		t.Fatalf("got %v", err)
	}
	c.Signing = "sometimes"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), `signing: "sometimes": none, kms or keyless`) {
		t.Fatalf("got %v", err)
	}
}

func TestValidateCatalogSignature(t *testing.T) {
	c := validKind(t)
	c.CatalogSignature.Repository = "my-org/vennir-catalog"
	if err := c.Validate(); err != nil {
		t.Errorf("owner/name: %v", err)
	}
	c.CatalogSignature.Repository = "https://github.com/my-org/vennir-catalog"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "isn't owner/name") {
		t.Errorf("a URL: %v", err)
	}
	c.CatalogSignature.Repository = "my-org/vennir-catalog"
	c.Signing = "keyless"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "this install signs its own") {
		t.Errorf("signing too: %v", err)
	}
}

func TestValidateCatalogVersion(t *testing.T) {
	c := validKind(t)
	for _, ok := range []string{"", "latest", "newest", "v1.4.0", "v0.0.1"} {
		c.CatalogVersion = ok
		if err := c.Validate(); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"1.4.0", "v1.4", "prod", "v1.4.0-rc.1"} {
		c.CatalogVersion = bad
		if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "catalogVersion") {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestValidateGoogleGroupsIsGCPOnly(t *testing.T) {
	c := validKind(t)
	c.SSO.GoogleGroups = true
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "sso.googleGroups: gcp only") {
		t.Fatalf("got %v", err)
	}
}

func TestValidateChatModelIsTheCloudsOwn(t *testing.T) {
	c := validKind(t)
	c.Chat.Model = "google/gemini-3.5-flash"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "chat.model: gcp and aws only") {
		t.Fatalf("kind: %v", err)
	}
	c.Target = "gcp"
	c.Chat.Model = "gpt-5"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "Vertex's name for a Gemini model") {
		t.Fatalf("gcp: %v", err)
	}
	c.Target = "aws"
	c.Chat.Model = "google/gemini-3.5-flash"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "Bedrock's name for a Claude model") {
		t.Fatalf("aws: %v", err)
	}
}

func TestChatOnAwsIsBedrocksClaudeUnlessOff(t *testing.T) {
	c := validKind(t)
	c.Target = "aws"
	if !c.ChatOnBedrock() || c.ChatOnVertex() || c.ChatModel() != DefaultBedrockModel {
		t.Fatalf("aws: on bedrock %v, model %s", c.ChatOnBedrock(), c.ChatModel())
	}
	c.Chat.Off = true
	if c.ChatOnBedrock() {
		t.Fatal("chat.off on aws")
	}
}

func TestValidateManagedDatabaseNeedsCloud(t *testing.T) {
	c := validKind(t)
	c.Database.Type = "managed"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "managed needs a cloud target") {
		t.Fatalf("got %v", err)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	c := validKind(t)
	dir := filepath.Join(t.TempDir(), "dev")
	if err := c.Save(dir); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, FileName))
	if !strings.HasPrefix(string(data), "# A Vennir install's settings") {
		t.Errorf("no header:\n%s", data)
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, c) {
		t.Errorf("round trip changed it:\n got %+v\nwant %+v", got, c)
	}
}

func TestLoadRejectsUnknownKeys(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, FileName), []byte("version: 1\ntarget: kind\nsizee: minimal\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "sizee") {
		t.Fatalf("got %v", err)
	}
}

func TestGetSet(t *testing.T) {
	c := validKind(t)
	if v, err := Get(c, "scaleDown.enabled"); err != nil || v != "true" {
		t.Fatalf("got %q, %v", v, err)
	}
	changed, err := Set(c, "scaleDown.enabled", "false")
	if err != nil {
		t.Fatal(err)
	}
	if changed.ScaleDown.Enabled || changed.MinReplicas != 1 {
		t.Errorf("got %+v", changed.ScaleDown)
	}
	if c.ScaleDown.Enabled != true {
		t.Error("Set changed its input")
	}
	changed, err = Set(changed, "minReplicas", "3")
	if err != nil || changed.MinReplicas != 3 {
		t.Fatalf("got %d, %v", changed.MinReplicas, err)
	}
	if _, err := Set(c, "size", "huge"); err == nil {
		t.Error("an invalid value was accepted")
	}
	if _, err := Set(c, "cluster", "x"); err == nil {
		t.Error("a group was set")
	}
	if _, err := Set(c, "nope", "x"); err == nil {
		t.Error("an unknown key was set")
	}
}

func TestSetAddsAnOmittedOptionalKey(t *testing.T) {
	c := validKind(t)
	c.Values = ""
	changed, err := Set(c, "values", "extra.yaml")
	if err != nil || changed.Values != "extra.yaml" {
		t.Fatalf("got %q, %v", changed.Values, err)
	}
}

func TestKeys(t *testing.T) {
	keys, err := Keys(validKind(t))
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(keys, "\n")
	for _, want := range []string{"size: minimal", "kind.registryPort: 5001", "scaleDown.idleAfter: 2h"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in:\n%s", want, joined)
		}
	}
}

func TestDir(t *testing.T) {
	base := t.TempDir()
	if _, err := Dir(base, "Bad/Name"); err == nil {
		t.Error("accepted a bad environment name")
	}
	if _, err := Dir(base, ""); err == nil {
		t.Error("found an environment in an empty directory")
	}
	c := validKind(t)
	if err := c.Save(filepath.Join(base, "dev")); err != nil {
		t.Fatal(err)
	}
	if dir, err := Dir(base, ""); err != nil || dir != filepath.Join(base, "dev") {
		t.Errorf("got %q, %v", dir, err)
	}
}

func TestGCP(t *testing.T) {
	c := Default("gcp")
	c.Source = checkout(t)
	c.Admin.Email = "admin@example.com"
	c.GCP = GCP{Project: "my-project-123", Region: "us-central1"}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if !c.TaskImages.Create || !c.Database.Backups.Enabled || c.Cluster.Mode != "auto" {
		t.Errorf("gcp defaults: %+v", c)
	}
	// A managed database (Cloud SQL) is gcp's to make.
	c.Database.Type, c.Database.HighAvailability = "managed", true
	if err := c.Validate(); err != nil {
		t.Errorf("a managed database on gcp: %v", err)
	}
	c.GCP.Project = "My_Project"
	c.Cluster.Mode = "existing"
	err := c.Validate()
	for _, want := range []string{"gcp.project", "cluster.mode"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("missing %q in %v", want, err)
		}
	}
}

func TestAManagedDatabaseIsOnGCPAndAWS(t *testing.T) {
	for _, target := range []string{"gcp", "aws", "kind"} {
		c := Default(target)
		c.Database.Type = "managed"
		err := c.Validate()
		if refused := err != nil && strings.Contains(err.Error(), "database.type"); refused != (target == "kind") {
			t.Errorf("managed on %s: %v", target, err)
		}
	}
}

func TestAWS(t *testing.T) {
	c := Default("aws")
	c.Source = checkout(t)
	c.Admin.Email = "admin@example.com"
	c.AWS = AWS{Profile: "vennir", Region: "us-east-1"}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.AWS.Region = "us-central1"
	c.Cluster.Mode = "existing"
	c.Catalog = Catalog{Host: "github", Owner: "o", Repository: "r", Visibility: "private", Team: "t"}
	c.Console.Public = true
	err := c.Validate()
	for _, want := range []string{"aws.region", "cluster.mode", "console.zone"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("missing %q in %v", want, err)
		}
	}
}

// azure's settings, and what isn't built on azure yet.
func TestAzure(t *testing.T) {
	c := Default("azure")
	c.Source = checkout(t)
	c.Admin.Email = "admin@example.com"
	c.Azure = Azure{Subscription: "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0", Region: "eastus2"}
	c.FillDefaults()
	if c.Azure.ResourceGroup != "vennir" {
		t.Errorf("resource group %q", c.Azure.ResourceGroup)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.Azure = Azure{Subscription: "nope", Region: "East US 2", ResourceGroup: "ends-in-a-dot."}
	c.Cluster.Mode = "auto"
	c.Database.Type = "managed"
	err := c.Validate()
	for _, want := range []string{"azure.subscription", "azure.region", "azure.resourceGroup", "cluster.mode", "database.type"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("missing %q in %v", want, err)
		}
	}
}

func TestExternalCatalog(t *testing.T) {
	c := Default("aws")
	c.Source = checkout(t)
	c.Admin.Email = "admin@example.com"
	c.AWS = AWS{Profile: "vennir", Region: "us-east-1"}
	c.ExternalCatalog = ExternalCatalog{
		Registry:                    "us-central1-docker.pkg.dev/acyclix-dev/vennir-products",
		GCPWorkloadIdentityProvider: "projects/123/locations/global/workloadIdentityPools/vennir-installs/providers/vennir-eks",
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.ExternalCatalog = ExternalCatalog{Registry: "nope", GCPWorkloadIdentityProvider: "pools/x", GCPServiceAccount: "a@b"}
	c.Catalog = Catalog{Host: "github", Owner: "o", Repository: "r", Visibility: "private", Team: "t"}
	err := c.Validate()
	for _, want := range []string{"externalCatalog.registry", "externalCatalog.gcpWorkloadIdentityProvider: \"pools/x\"", "not both"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("missing %q in %v", want, err)
		}
	}
	c.Catalog = Catalog{}
	c.ExternalCatalog = ExternalCatalog{Registry: "123456789012.dkr.ecr.us-east-1.amazonaws.com/p",
		GCPWorkloadIdentityProvider: "projects/123/locations/global/workloadIdentityPools/vennir-installs/providers/vennir-eks"}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "only for an Artifact Registry") {
		t.Errorf("an ECR registry with a Google provider: %v", err)
	}

	// Another account's ECR, or one read from another cloud: the owner's role.
	c.Target, c.GCP = "gcp", GCP{Project: "reader-project", Region: "us-central1"}
	c.ExternalCatalog = ExternalCatalog{Registry: "123456789012.dkr.ecr.us-east-1.amazonaws.com/vennir-products",
		AWSRoleArn: "arn:aws:iam::123456789012:role/vennir-reader-gke"}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if !c.ExternalCatalog.Federated() {
		t.Error("a role is federation")
	}
	for role, want := range map[string]string{
		"arn:aws:iam::210987654321:role/vennir-reader-gke": "it must be the registry owner's",
		"vennir-reader-gke": "isn't arn:aws:iam::",
	} {
		c.ExternalCatalog.AWSRoleArn = role
		if err := c.Validate(); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want %q", role, err, want)
		}
	}
	c.ExternalCatalog = ExternalCatalog{Registry: "us-central1-docker.pkg.dev/acyclix-dev/vennir-products",
		AWSRoleArn: "arn:aws:iam::123456789012:role/vennir-reader-gke"}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "only for an Amazon ECR registry") {
		t.Errorf("an Artifact Registry with a role: %v", err)
	}
	c.ExternalCatalog = ExternalCatalog{Registry: "123456789012.dkr.ecr.us-east-1.amazonaws.com/vennir-products",
		AWSRoleArn:                  "arn:aws:iam::123456789012:role/vennir-reader-gke",
		GCPWorkloadIdentityProvider: "projects/123/locations/global/workloadIdentityPools/vennir-installs/providers/vennir-eks"}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "not both") {
		t.Errorf("both: %v", err)
	}
}

// Another install's catalog in this install's own project: its repository
// is this install's task registry, not made here, so the module grants
// this install's identities read on it.
func TestAnExternalCatalogInThisProjectIsTheTaskRegistry(t *testing.T) {
	c := Default("gcp")
	c.Source = checkout(t)
	c.Admin.Email = "admin@example.com"
	c.GCP.Project, c.GCP.Region = "acme-dev", "us-central1"
	c.ExternalCatalog = ExternalCatalog{Registry: "us-central1-docker.pkg.dev/acme-dev/vennir-products"}
	c.TaskImages = TaskImages{Create: true, Name: "vennir-reader-products"}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "set taskImages.name to its repository and taskImages.create to false") {
		t.Errorf("its own task registry: %v", err)
	}
	c.TaskImages = TaskImages{Create: false, Name: "vennir-products", Registry: "us-central1-docker.pkg.dev/acme-dev/vennir-products"}
	if err := c.Validate(); err != nil {
		t.Errorf("the owner's repository as its task registry: %v", err)
	}
	// Another project's: the owner's grant, whatever taskImages says.
	c.ExternalCatalog.Registry = "us-central1-docker.pkg.dev/owner/vennir-products"
	c.TaskImages = TaskImages{Create: true, Name: "vennir-reader-products"}
	if err := c.Validate(); err != nil {
		t.Errorf("another project's: %v", err)
	}
}

func TestECRRegistry(t *testing.T) {
	account, region, prefix := ECRRegistry("123456789012.dkr.ecr.eu-west-2.amazonaws.com/vennir-products")
	if account != "123456789012" || region != "eu-west-2" || prefix != "vennir-products" {
		t.Errorf("got %q %q %q", account, region, prefix)
	}
	if account, _, _ := ECRRegistry("us-central1-docker.pkg.dev/p/r"); account != "" {
		t.Errorf("Artifact Registry: %q", account)
	}
}

func TestLoadReadsTheCatalogsPublicKey(t *testing.T) {
	c := validKind(t)
	dir := filepath.Join(t.TempDir(), "dev")
	c.CatalogSignature.PublicKeyFile = "cosign.pub"
	if err := c.Save(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "catalogSignature.publicKeyFile") {
		t.Errorf("a missing key: %v", err)
	}
	pem := "-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n"
	if err := os.WriteFile(filepath.Join(dir, "cosign.pub"), []byte(pem), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := Load(dir)
	if err != nil || got.CatalogSignature.PublicKey != pem {
		t.Errorf("loaded %q, %v", got.CatalogSignature.PublicKey, err)
	}
}

func TestValidateMonitoring(t *testing.T) {
	for provider, want := range map[string]string{
		"bundled":  "",
		"google":   "only on gcp",
		"operator": "monitoring.namespace",
		"amazon":   "only on aws",
		"grafana":  `"grafana" isn't operator, google, bundled or amazon`,
	} {
		c := validKind(t)
		c.Monitoring = Monitoring{Enabled: true, Provider: provider}
		err := c.Validate()
		if want == "" && err != nil || want != "" && (err == nil || !strings.Contains(err.Error(), want)) {
			t.Errorf("%s: %v, want %q", provider, err, want)
		}
	}
}

func TestValidateAlertEmail(t *testing.T) {
	c := validKind(t)
	c.Target = "aws"
	c.Monitoring = Monitoring{Enabled: true, Provider: "amazon", AlertEmail: "nobody"}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), `monitoring.alertEmail: "nobody"`) {
		t.Errorf("%v", err)
	}
}

func TestChangedSinceApplied(t *testing.T) {
	dir := t.TempDir()
	if Applied(dir) != nil {
		t.Fatal("nothing applied yet")
	}
	c := Default("kind")
	c.FillDefaults()
	c.Monitoring.PodMonitorLabels = map[string]string{"release": "kps"}
	if err := c.SaveApplied(dir); err != nil {
		t.Fatal(err)
	}
	was := Applied(dir)
	if changed, err := Changed(was, c); err != nil || len(changed) != 0 {
		t.Fatalf("as applied: %v %v", changed, err)
	}
	c.Gateway.BackendHosts = []string{"api.example.com"}
	c.Monitoring.PodMonitorLabels = map[string]string{"release": "other"}
	c.ScaleDown.Enabled = !c.ScaleDown.Enabled
	changed, err := Changed(was, c)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(changed, " "); got != "gateway.backendHosts monitoring.podMonitorLabels scaleDown.enabled" {
		t.Errorf("changed: %s", got)
	}
}

// An existing cluster says its cloud when it's on one, for the catalog's
// products made for it; otherwise the install's cloud is its target.
func TestInstallCloud(t *testing.T) {
	c := Default("existing")
	if c.InstallCloud() != "existing" {
		t.Errorf("unsaid: %q", c.InstallCloud())
	}
	c.Cluster.Cloud = "aws"
	if c.InstallCloud() != "aws" {
		t.Errorf("on EKS: %q", c.InstallCloud())
	}
	c.Cluster.Context = "ctx"
	c.Cluster.Cloud = "eks"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), `cluster.cloud: "eks"`) {
		t.Errorf("an unknown cloud: %v", err)
	}
	if g := Default("gcp"); g.InstallCloud() != "gcp" {
		t.Errorf("gcp: %q", g.InstallCloud())
	}
}
