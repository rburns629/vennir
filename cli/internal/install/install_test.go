// SPDX-License-Identifier: MIT

package install

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/rburns629/vennir/cli/internal/config"
)

func kindConfig() *config.Config {
	c := config.Default("kind")
	c.Source = "/src/vennir"
	c.Admin.Email = "admin@example.com"
	return c
}

func TestChartsFromSourceOrRelease(t *testing.T) {
	c := kindConfig()
	k, _ := Charts(c, "/deploy/dev")
	if k.Dir != "/src/vennir/helm/charts/execution-kernel" || k.Remote != "" {
		t.Errorf("source: %+v", k)
	}
	if SizeValues(k, "minimal") != "/src/vennir/helm/charts/execution-kernel/sizes/minimal.yaml" {
		t.Errorf("size: %s", SizeValues(k, "minimal"))
	}
	c.Vennir = "0.2.0"
	_, cons := Charts(c, "/deploy/dev")
	if cons.Dir != "/deploy/dev/charts/0.2.0/execution-console" || cons.Remote != ReleaseCharts+"/execution-console" || cons.Version != "0.2.0" {
		t.Errorf("release: %+v", cons)
	}
}

func TestImagesFor(t *testing.T) {
	now := time.Date(2026, 10, 18, 9, 30, 5, 0, time.UTC)
	img := ImagesFor(kindConfig(), now)
	if img.Kernel != "execution-kernel" || img.Tag != "src-20261018-093005" || !img.Build || img.Push {
		t.Errorf("kind: %+v", img)
	}

	c := config.Default("existing")
	c.PlatformImages.Registry = "us-docker.pkg.dev/p/platform/"
	img = ImagesFor(c, now)
	if img.Console != "us-docker.pkg.dev/p/platform/execution-console" || !img.Push {
		t.Errorf("existing: %+v", img)
	}

	c.Vennir = "0.2.0"
	if img := ImagesFor(c, now); img.Build || img.Kernel != "" {
		t.Errorf("release: %+v", img)
	}
}

func TestCopies(t *testing.T) {
	c := kindConfig()
	c.MinReplicas = 3
	if len(copies(c)) != 0 {
		t.Error("with scale-down the size decides the copies")
	}
	c.ScaleDown.Enabled = false
	if got := copies(c); got["replicaCount"] != 3 {
		t.Errorf("always on: %v", got)
	}
	c.Size = "auto"
	got := copies(c)["autoscaling"].(map[string]any)
	if got["minReplicas"] != 3 || got["maxReplicas"] != 3 {
		t.Errorf("auto: %v", got)
	}
	c.MinReplicas = 5
	if got := copies(c)["autoscaling"].(map[string]any); got["maxReplicas"] != 5 {
		t.Errorf("auto, max below min: %v", got)
	}
}

func TestScaleDownAndHeadroom(t *testing.T) {
	c := kindConfig()
	c.ScaleDown.IdleAfter = "90m"
	c.ScaleDown.Schedule = "0 20 * * 1-5"
	k := KernelValues(c, Images{}, "", nil)
	sd := k["scaleDown"].(map[string]any)
	if sd["enabled"] != true || sd["idleAfterMinutes"] != 90 || sd["schedule"] != "0 20 * * 1-5" || sd["consoleFullname"] != "console-execution-console" {
		t.Errorf("scaleDown: %v", sd)
	}
	if _, ok := k["postgres"].(map[string]any)["persistence"]; ok {
		t.Error("a new volume should take the size's figure")
	}

	c.ScaleDown.Enabled = false
	c.StepHeadroom = 2
	k = KernelValues(c, Images{}, "10Gi", nil)
	if k["scaleDown"].(map[string]any)["enabled"] != false || k["stepHeadroom"].(map[string]any)["replicas"] != 2 {
		t.Errorf("always on: %v", k)
	}
	if k["postgres"].(map[string]any)["persistence"].(map[string]any)["size"] != "10Gi" {
		t.Error("an existing volume's size should be kept")
	}
}

func TestValues(t *testing.T) {
	c := kindConfig()
	img := ImagesFor(c, time.Now())
	k := KernelValues(c, img, "", nil)
	if k["imagePolicy"].(map[string]any)["sourceRegistry"] != "localhost:5001" {
		t.Errorf("kernel: %v", k)
	}
	if k["image"].(map[string]any)["tag"] != img.Tag {
		t.Errorf("kernel image: %v", k["image"])
	}

	v := ConsoleValues(c, "dev", img, nil)
	if v["kernelApiUrl"] != "https://kernel-execution-kernel-api.vennir-system.svc.cluster.local:8000" {
		t.Errorf("kernelApiUrl: %v", v["kernelApiUrl"])
	}
	if tls, _ := v["tls"].(map[string]any); tls["kernelCaSecret"] != "kernel-execution-kernel-tls-ca" {
		t.Errorf("tls: %v", v["tls"])
	}
	if v["environmentLabel"] != "dev" || v["existingSecret"] != "kernel-execution-kernel-console-db" || v["installCloud"] != c.InstallCloud() {
		t.Errorf("console: %v", v)
	}
	mirrors := v["registryCheck"].(map[string]any)["mirrors"].(map[string]any)
	if mirrors["localhost:5001"] != "http://kind-registry:5000" {
		t.Errorf("mirrors: %v", mirrors)
	}
	if _, ok := v["bootstrapAdmin"].(map[string]any)["password"]; ok {
		t.Error("a password must never be written to values")
	}

	c.Vennir = "0.2.0"
	if _, ok := ConsoleValues(c, "dev", ImagesFor(c, time.Now()), nil)["image"]; ok {
		t.Error("a release should use the chart's own image")
	}
}

// On aws the console gets the cluster's issuer, which IAM trusts (the
// module registers it), for its teams' AWS SecretStores.
func TestAnAWSConsoleKnowsTheIssuerStoresSignInWith(t *testing.T) {
	c := kindConfig()
	c.Catalog.Owner, c.Catalog.Repository = "octocat", "vennir-catalog"
	cloud := &Cloud{Provider: "aws", ClusterIssuer: "https://oidc.eks.us-east-2.amazonaws.com/id/ABC"}
	got := fmt.Sprint(ConsoleValues(c, "dev", Images{}, cloud)["secretSources"])
	if got != "map[catalogRepo:octocat/vennir-catalog clusterIssuer:https://oidc.eks.us-east-2.amazonaws.com/id/ABC]" {
		t.Errorf("secretSources: %s", got)
	}
}

func TestConsoleReadsTheCatalogsRelease(t *testing.T) {
	c := kindConfig()
	cloud := &Cloud{Provider: "gcp", TaskRegistry: "us-central1-docker.pkg.dev/p/vennir-products"}
	if _, ok := ConsoleValues(c, "dev", Images{}, cloud)["catalog"]; ok {
		t.Error("no catalog repository, no release to read")
	}
	c.Catalog.Owner, c.Catalog.Repository = "octocat", "vennir-catalog"
	got := ConsoleValues(c, "dev", Images{}, cloud)["catalog"]
	want := map[string]any{"release": "us-central1-docker.pkg.dev/p/vennir-products/catalog-release:latest"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("catalog: %v, want %v", got, want)
	}

	// Following versions: one pinned, or the newest.
	c.CatalogVersion = "v1.4.0"
	got = ConsoleValues(c, "dev", Images{}, cloud)["catalog"]
	want = map[string]any{"release": "us-central1-docker.pkg.dev/p/vennir-products/catalog-release:v1.4.0"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("pinned: %v, want %v", got, want)
	}
	c.CatalogVersion = "newest"
	got = ConsoleValues(c, "dev", Images{}, cloud)["catalog"]
	want = map[string]any{"release": "us-central1-docker.pkg.dev/p/vennir-products/catalog-release:latest", "newestVersion": true}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("newest: %v, want %v", got, want)
	}
}

// An install reading another cloud's catalog: its registry is the image
// source and the release's home, read by federation, the kubelet pulling
// with the console's token; and only releases the catalog's key signed.
func TestAnExternalCatalogIsReadByFederation(t *testing.T) {
	c := kindConfig()
	c.Namespace = "vennir-system"
	c.Cluster.Name = "vennir-eks"
	cloud := &Cloud{Provider: "aws", TaskRegistry: "123456789012.dkr.ecr.us-east-1.amazonaws.com/vennir-products",
		ClusterIssuer: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC"}
	c.ExternalCatalog.Registry = "us-central1-docker.pkg.dev/acyclix-dev/vennir-products"
	c.CatalogSignature.PublicKey = "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----\n"

	grant := CatalogGrant(c, cloud)
	if grant == nil || grant.Command != "vennir catalog grant --reader vennir-eks --issuer https://oidc.eks.us-east-1.amazonaws.com/id/ABC "+
		"--subject system:serviceaccount:vennir-system:console-execution-console" ||
		!strings.Contains(fmt.Sprint(grant.Then), "externalCatalog.gcpWorkloadIdentityProvider") {
		t.Errorf("grant: %+v", grant)
	}

	c.ExternalCatalog.GCPWorkloadIdentityProvider = "projects/1/locations/global/workloadIdentityPools/vennir-installs/providers/vennir-eks"
	kernel := KernelValues(c, Images{}, "", cloud)
	if fmt.Sprint(kernel["imagePolicy"]) != "map[sourceRegistry:us-central1-docker.pkg.dev/acyclix-dev/vennir-products]" ||
		fmt.Sprint(kernel["scheduler"]) != "map[taskImagePullSecret:vennir-pull]" {
		t.Errorf("kernel: %v %v", kernel["imagePolicy"], kernel["scheduler"])
	}
	console := ConsoleValues(c, "dev", Images{}, cloud)
	want := "map[ecrToken:true gcpFederation:map[hosts:[us-central1-docker.pkg.dev] serviceAccount: " +
		"workloadIdentityProvider:projects/1/locations/global/workloadIdentityPools/vennir-installs/providers/vennir-eks]]"
	if fmt.Sprint(console["registryCheck"]) != want {
		t.Errorf("registryCheck: %v", console["registryCheck"])
	}
	catalog, _ := console["catalog"].(map[string]any)
	if catalog["release"] != "us-central1-docker.pkg.dev/acyclix-dev/vennir-products/catalog-release:latest" ||
		!strings.Contains(fmt.Sprint(catalog["signature"]), "BEGIN PUBLIC KEY") || catalog["external"] != true {
		t.Errorf("catalog: %v", catalog)
	}
}

// A GKE install (or an EKS one in another account) reading an Amazon ECR:
// the owner's grant trusts its console's ServiceAccount, and with the
// owner's role set the console assumes it, the kubelet pulling with ECR's
// token.
func TestAnExternalECRIsReadByWebIdentity(t *testing.T) {
	c := kindConfig()
	c.Target, c.Namespace, c.Cluster.Name, c.GCP.Project = "gcp", "vennir-system", "vennir-gke", "reader"
	cloud := &Cloud{Provider: "gcp", ClusterIssuer: "https://container.googleapis.com/v1/projects/reader/locations/us-central1/clusters/vennir-gke"}
	c.ExternalCatalog.Registry = "123456789012.dkr.ecr.us-east-2.amazonaws.com/vennir-products"

	grant := CatalogGrant(c, cloud)
	if grant == nil || grant.Command != "vennir catalog grant --reader vennir-gke --issuer "+cloud.ClusterIssuer+
		" --subject system:serviceaccount:vennir-system:console-execution-console" ||
		!strings.Contains(fmt.Sprint(grant.Then), "externalCatalog.awsRoleArn") {
		t.Errorf("grant: %+v", grant)
	}
	if KernelValues(c, Images{}, "", cloud)["scheduler"] != nil {
		t.Error("no pull Secret before the role is set")
	}

	c.ExternalCatalog.AWSRoleArn = "arn:aws:iam::123456789012:role/vennir-reader-vennir-gke"
	if CatalogGrant(c, cloud) != nil {
		t.Error("granted: nothing more to print")
	}
	if fmt.Sprint(KernelValues(c, Images{}, "", cloud)["scheduler"]) != "map[taskImagePullSecret:vennir-pull]" {
		t.Errorf("kernel: %v", KernelValues(c, Images{}, "", cloud)["scheduler"])
	}
	check, _ := ConsoleValues(c, "dev", Images{}, cloud)["registryCheck"].(map[string]any)
	if fmt.Sprint(check["awsFederation"]) != "map[hosts:[123456789012.dkr.ecr.us-east-2.amazonaws.com] roleArn:arn:aws:iam::123456789012:role/vennir-reader-vennir-gke]" ||
		check["gcpFederation"] != nil {
		t.Errorf("registryCheck: %v", check)
	}
}

// An install reading another's signed catalog enforces its signer as the
// owner does: on images (policy-controller) and releases; off a cloud, on
// releases only.
func TestAReaderTrustsTheCatalogsSigner(t *testing.T) {
	c := kindConfig()
	c.ExternalCatalog.Registry = "us-central1-docker.pkg.dev/acyclix-dev/vennir-products"
	c.CatalogSignature.Repository = "my-org/vennir-catalog"
	subject := `^https://github\.com/my-org/vennir-catalog/\.github/workflows/ci\.yml@refs/heads/main$`

	// kind: releases only.
	if c.ChecksSignatures() || KernelValues(c, Images{}, "", nil)["imageSignature"] != nil {
		t.Error("kind can't check images")
	}
	catalog, _ := ConsoleValues(c, "dev", Images{}, nil)["catalog"].(map[string]any)
	if !strings.Contains(fmt.Sprint(catalog["signature"]), subject) {
		t.Errorf("kind's console: %v", catalog)
	}

	c.Target = "gcp"
	cloud := &Cloud{Provider: "gcp", SigningVerifier: "vennir-r-verifier@p.iam.gserviceaccount.com"}
	if !c.ChecksSignatures() || c.ModuleSigning() != "verify" {
		t.Errorf("gcp: checks %v, module %q", c.ChecksSignatures(), c.ModuleSigning())
	}
	images := fmt.Sprint(KernelValues(c, Images{}, "", cloud)["imageSignature"])
	if !strings.Contains(images, "enabled:true") || !strings.Contains(images, subject) || !strings.Contains(images, GitHubActionsIssuer) {
		t.Errorf("imageSignature: %v", images)
	}
	// The console reads the kernel's policy from the cluster: nothing to tell it.
	if got, set := ConsoleValues(c, "dev", Images{}, cloud)["imageSignature"]; set {
		t.Errorf("console's imageSignature: %v", got)
	}
	catalog, _ = ConsoleValues(c, "dev", Images{}, cloud)["catalog"].(map[string]any)
	if !strings.Contains(fmt.Sprint(catalog["signature"]), subject) {
		t.Errorf("console: %v", catalog)
	}
	// The owner grants this install's own service accounts read, the
	// verifier's among them.
	c.Cluster.Name, c.GCP.Project = "vennir-r", "p"
	cloud.ConsoleServiceAccount, cloud.ScannerServiceAccount = "vennir-r-console@p.iam.gserviceaccount.com", "vennir-r-scanner@p.iam.gserviceaccount.com"
	grant := CatalogGrant(c, cloud)
	if grant == nil || grant.Command != "vennir catalog grant --reader vennir-r --service-account vennir-r-console@p.iam.gserviceaccount.com "+
		"--service-account vennir-r-scanner@p.iam.gserviceaccount.com --service-account vennir-r-nodes@p.iam.gserviceaccount.com "+
		"--service-account vennir-r-verifier@p.iam.gserviceaccount.com" || len(grant.Then) != 0 {
		t.Errorf("grant: %+v", grant)
	}
	// In its own project: nothing to grant.
	c.GCP.Project = "acyclix-dev"
	if g := CatalogGrant(c, cloud); g != nil {
		t.Errorf("own project: %+v", g)
	}

	// A key as well: either signer passes.
	c.CatalogSignature.PublicKeyFile, c.CatalogSignature.PublicKey = "cosign.pub", "-----BEGIN PUBLIC KEY-----\nk\n-----END PUBLIC KEY-----\n"
	images = fmt.Sprint(KernelValues(c, Images{}, "", cloud)["imageSignature"])
	if !strings.Contains(images, "BEGIN PUBLIC KEY") || !strings.Contains(images, subject) {
		t.Errorf("both: %v", images)
	}
}

// On GKE the chat agent answers with Gemini through Vertex AI in the
// install's project, as the console; its scan Jobs read as their own,
// narrower identity.
func TestTheChatOnGCP(t *testing.T) {
	c := kindConfig()
	if _, ok := ConsoleValues(c, "dev", Images{}, nil)["chat"]; ok {
		t.Error("kind: the chart's own chat values, not vennir's")
	}
	c.Target = "gcp"
	c.GCP.Project = "acme-dev"
	cloud := &Cloud{Provider: "gcp", ConsoleServiceAccount: "v-console@acme-dev.iam.gserviceaccount.com", ScannerServiceAccount: "v-scanner@acme-dev.iam.gserviceaccount.com"}
	v := ConsoleValues(c, "dev", Images{}, cloud)
	chat := fmt.Sprint(v["chat"])
	if chat != "map[model:google/gemini-3.5-flash provider:vertex vertex:map[location:global project:acme-dev]]" {
		t.Errorf("chat: %s", chat)
	}
	if scanning := fmt.Sprint(v["scanning"]); !strings.Contains(scanning, "v-scanner@") {
		t.Errorf("scanning: %s", scanning)
	}
	if sa := fmt.Sprint(v["serviceAccount"]); !strings.Contains(sa, "v-console@") {
		t.Errorf("serviceAccount: %s", sa)
	}
	c.Chat.Model = "google/gemini-3.5-flash-lite"
	if !strings.Contains(fmt.Sprint(ConsoleValues(c, "dev", Images{}, cloud)["chat"]), "gemini-3.5-flash-lite") {
		t.Error("chat.model")
	}
	c.Chat.Off = true
	if _, ok := ConsoleValues(c, "dev", Images{}, cloud)["chat"]; ok {
		t.Error("chat.off")
	}
	// A module from before the scanner had its own: the console's, as then.
	cloud.ScannerServiceAccount = ""
	if scanning := fmt.Sprint(ConsoleValues(c, "dev", Images{}, cloud)["scanning"]); !strings.Contains(scanning, "v-console@") {
		t.Errorf("old module: %s", scanning)
	}
}

// The gateway, when it's on: its image built from source, and on GKE the
// cluster's Workload Identity pool for minting Google ID tokens.
func TestTheGatewaysValues(t *testing.T) {
	c := kindConfig()
	c.Namespace = "vennir-system"
	c.GCP.Project = "acme-dev"
	cloud := &Cloud{Provider: "gcp", ClusterName: "vennir", ClusterLocation: "us-central1"}
	img := Images{Gateway: "us-docker.pkg.dev/acme-dev/platform/execution-gateway", Tag: "src-1"}
	if _, ok := ConsoleValues(c, "dev", img, cloud)["gateway"]; ok {
		t.Error("off unless it's enabled")
	}
	c.Gateway = config.Gateway{Enabled: true, BackendHosts: []string{"*.a.run.app"}}
	gw, _ := ConsoleValues(c, "dev", img, cloud)["gateway"].(map[string]any)
	gcp, _ := gw["gcp"].(map[string]any)
	if gw["enabled"] != true || fmt.Sprint(gw["backendHosts"]) != "[*.a.run.app]" ||
		gw["url"] != "http://console-execution-console-gateway.vennir-system.svc.cluster.local:8080" ||
		fmt.Sprint(gw["image"]) != "map[repository:us-docker.pkg.dev/acme-dev/platform/execution-gateway tag:src-1]" ||
		gcp["tokenAudience"] != "acme-dev.svc.id.goog" ||
		gcp["stsAudience"] != "identitynamespace:acme-dev.svc.id.goog:https://container.googleapis.com/v1/projects/acme-dev/locations/us-central1/clusters/vennir" {
		t.Errorf("gateway = %v", gw)
	}
}

func TestWriteValues(t *testing.T) {
	dir := t.TempDir()
	path, err := WriteValues(dir, "kernel", map[string]any{"api": map[string]any{"replicaCount": 2}})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(data), "# Written by vennir") || !strings.Contains(string(data), "replicaCount: 2") {
		t.Errorf("got:\n%s", data)
	}
}

// A web client's JSON is read; anything else, refused.
func TestReadGoogleClient(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	web := write("web.json", `{"web":{"client_id":"id.apps.googleusercontent.com","client_secret":"s","redirect_uris":["http://localhost:18080/api/auth/oidc/callback"]}}`)
	client, err := ReadGoogleClient(web)
	if err != nil || client.ID != "id.apps.googleusercontent.com" || client.Secret != "s" || len(client.RedirectURIs) != 1 {
		t.Fatalf("a web client: %+v, %v", client, err)
	}
	if _, err := ReadGoogleClient(write("desktop.json", `{"installed":{"client_id":"x","client_secret":"y"}}`)); err == nil {
		t.Error("a desktop client was accepted")
	}
	if _, err := ReadGoogleClient(write("junk.json", `not json`)); err == nil {
		t.Error("junk was accepted")
	}
}

// Signing in with Google reaches the console chart as its sso, the secret
// by reference only.
func TestSSOValues(t *testing.T) {
	c := config.Default("kind")
	c.SSO = config.SSO{Provider: "google", ClientID: "id", ClientFile: "/x.json", AllowedDomains: []string{"example.com"}, RedirectURL: "http://localhost:18080/api/auth/oidc/callback"}
	sso, ok := ConsoleValues(c, "dev", Images{}, nil)["sso"].(map[string]any)
	if !ok {
		t.Fatal("no sso values")
	}
	if sso["issuer"] != "https://accounts.google.com" || sso["clientId"] != "id" || sso["redirectUrl"] != c.SSO.RedirectURL {
		t.Errorf("sso values: %v", sso)
	}
	if secret := sso["clientSecret"].(map[string]any); secret["name"] != SSOSecretName {
		t.Errorf("the secret's reference: %v", secret)
	}
}

// A saved sign-in callback that isn't where the console is reached now
// stops apply: made public, a new hostname, a new address once the cloud
// side is made. One that matches, or a public address not yet known, doesn't.
func TestCheckSSORedirect(t *testing.T) {
	c := config.Default("gcp")
	if err := CheckSSORedirect(c, ""); err != nil {
		t.Errorf("no sso: %v", err)
	}
	c.SSO = config.SSO{Provider: "google", RedirectURL: "http://localhost:18080/api/auth/oidc/callback"}
	if err := CheckSSORedirect(c, ""); err != nil {
		t.Errorf("private, matching: %v", err)
	}

	c.Console.Public = true
	if err := CheckSSORedirect(c, ""); err != nil {
		t.Errorf("public, its nip.io address not known yet: %v", err)
	}
	err := CheckSSORedirect(c, "console.1-2-3-4.nip.io")
	if err == nil || !strings.Contains(err.Error(), "https://console.1-2-3-4.nip.io/api/auth/oidc/callback") || !strings.Contains(err.Error(), "vennir sso google") {
		t.Errorf("made public: %v", err)
	}

	c.SSO.RedirectURL = "https://console.1-2-3-4.nip.io/api/auth/oidc/callback"
	if err := CheckSSORedirect(c, "console.1-2-3-4.nip.io"); err != nil {
		t.Errorf("public, matching: %v", err)
	}
	if err := CheckSSORedirect(c, "console.5-6-7-8.nip.io"); err == nil {
		t.Error("a new address was accepted")
	}
	c.Console.Hostname = "console.example.com"
	if err := CheckSSORedirect(c, ""); err == nil {
		t.Error("a new hostname was accepted before the cloud side")
	}
	c.Console.Public = false
	if err := CheckSSORedirect(c, ""); err == nil {
		t.Error("made private was accepted")
	}
}

// A signed catalog: both charts trust the same signer, the kernel's
// imageSignature on (policy-controller enforces it), the console's
// catalog.signature set; nothing while signing is off.
func TestASignedCatalogIsRequiredByBothCharts(t *testing.T) {
	c := kindConfig()
	c.Target = "gcp"
	c.Catalog.Owner, c.Catalog.Repository = "octocat", "vennir-catalog"
	cloud := &Cloud{Provider: "gcp", TaskRegistry: "us-central1-docker.pkg.dev/p/vennir-products", SigningPublicKey: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n"}
	if _, on := KernelValues(c, Images{}, "", cloud)["imageSignature"]; on {
		t.Error("signing off: no imageSignature")
	}

	c.Signing = "kms"
	kernel := KernelValues(c, Images{}, "", cloud)["imageSignature"].(map[string]any)
	if kernel["enabled"] != true || fmt.Sprint(kernel["publicKeys"]) != fmt.Sprint([]string{cloud.SigningPublicKey}) {
		t.Errorf("kms, kernel: %v", kernel)
	}
	console := ConsoleValues(c, "dev", Images{}, cloud)["catalog"].(map[string]any)["signature"].(map[string]any)
	if fmt.Sprint(console["publicKeys"]) != fmt.Sprint([]string{cloud.SigningPublicKey}) {
		t.Errorf("kms, console: %v", console)
	}

	c.Signing = "keyless"
	keyless := KernelValues(c, Images{}, "", cloud)["imageSignature"].(map[string]any)["keyless"].(map[string]any)
	if keyless["issuer"] != GitHubActionsIssuer {
		t.Errorf("keyless issuer: %v", keyless)
	}
	subject := regexp.MustCompile(keyless["subjectRegExp"].(string))
	for name, want := range map[string]bool{
		"https://github.com/octocat/vennir-catalog/.github/workflows/ci.yml@refs/heads/main":       true,
		"https://github.com/octocat/vennir-catalog/.github/workflows/ci.yml@refs/heads/feature":    false,
		"https://github.com/octocat/vennir-catalog/.github/workflows/other.yml@refs/heads/main":    false,
		"https://github.com/octocat/vennir-catalogs/.github/workflows/ci.yml@refs/heads/main":      false,
		"https://github.com/someone/vennir-catalog/.github/workflows/ci.yml@refs/heads/main":       false,
		"https://github.com/octocat/vennir-catalog/.github/workflows/ci.yml@refs/heads/main/extra": false,
	} {
		if subject.MatchString(name) != want {
			t.Errorf("keyless subject %q: match %v", name, !want)
		}
	}
}

func TestMonitoringValues(t *testing.T) {
	c := kindConfig()
	img := ImagesFor(c, time.Now())
	metricsFrom := func(v map[string]any) string { return fmt.Sprint(v["networkPolicy"].(map[string]any)["metricsFrom"]) }

	// The cluster's operator, as before: a config without a provider.
	c.Monitoring = config.Monitoring{Enabled: true, Namespace: "monitoring", PodMonitorLabels: map[string]string{"release": "kps"}}
	k, v := KernelValues(c, img, "", nil), ConsoleValues(c, "dev", img, nil)
	if m := k["monitoring"].(map[string]any); m["provider"] != "operator" || !strings.Contains(fmt.Sprint(m["podMonitor"]), "release:kps") {
		t.Errorf("operator: %v", m)
	}
	if _, ok := v["monitoring"].(map[string]any)["dashboard"]; !ok || !strings.Contains(metricsFrom(v), "monitoring") {
		t.Errorf("operator console: %v %v", v["monitoring"], metricsFrom(v))
	}

	// Bundled: the console chart runs it; both charts admit it alone.
	c.Monitoring = config.Monitoring{Enabled: true, Provider: "bundled"}
	k, v = KernelValues(c, img, "", nil), ConsoleValues(c, "dev", img, nil)
	if _, ok := k["monitoring"].(map[string]any)["prometheus"]; ok {
		t.Error("only the console chart runs the bundled Prometheus")
	}
	if p := v["monitoring"].(map[string]any)["prometheus"].(map[string]any); p["enabled"] != true || p["kernelRelease"] != "kernel" {
		t.Errorf("bundled: %v", p)
	}
	for _, values := range []map[string]any{k, v} {
		if got := metricsFrom(values); !strings.Contains(got, "component:prometheus") || !strings.Contains(got, "instance:console") {
			t.Errorf("bundled metricsFrom: %s", got)
		}
	}

	// Amazon: the bundled one, writing to the module's workspace and sending
	// its alerts there, as the ServiceAccount Pod Identity binds.
	c.Monitoring = config.Monitoring{Enabled: true, Provider: "amazon"}
	ws := "https://aps-workspaces.us-east-2.amazonaws.com/workspaces/ws-1/"
	cloud := &Cloud{Provider: "aws", PrometheusRemoteWrite: ws + "api/v1/remote_write", PrometheusAlertmanager: ws + "alertmanager/", PrometheusRegion: "us-east-2"}
	k, v = KernelValues(c, img, "", nil), ConsoleValues(c, "dev", img, cloud)
	if m := k["monitoring"].(map[string]any); m["provider"] != "bundled" {
		t.Errorf("amazon kernel: %v", m)
	}
	p := v["monitoring"].(map[string]any)["prometheus"].(map[string]any)
	if p["serviceAccountName"] != PrometheusServiceAccountName ||
		fmt.Sprint(p["remoteWrite"]) != "map[sigv4Region:us-east-2 url:"+ws+"api/v1/remote_write]" ||
		fmt.Sprint(p["alertmanager"]) != "map[sigv4Region:us-east-2 url:"+ws+"alertmanager/]" {
		t.Errorf("amazon console: %v", p)
	}

	// Google: its collector's namespace, Autopilot's own.
	c.Monitoring = config.Monitoring{Enabled: true, Provider: "google"}
	for mode, want := range map[string]string{"auto": "gke-gmp-system", "standard": "gmp-system"} {
		c.Cluster.Mode = mode
		k = KernelValues(c, img, "", nil)
		if m := k["monitoring"].(map[string]any); m["provider"] != "google" || fmt.Sprint(m["google"]) != "map[collectorNamespace:"+want+"]" || !strings.Contains(metricsFrom(k), want) {
			t.Errorf("google on %s: %v %s", mode, m, metricsFrom(k))
		}
	}
	// The console reads which alerts fire from this project's, for this cluster.
	c.GCP.Project = "acyclix-dev"
	v = ConsoleValues(c, "dev", img, &Cloud{Provider: "gcp", ClusterName: "vennir-dev"})
	if g := v["monitoring"].(map[string]any)["google"].(map[string]any); g["project"] != "acyclix-dev" || g["cluster"] != "vennir-dev" {
		t.Errorf("google console: %v", g)
	}
}

// kernel policy (the kernel chart's catalogPolicy) on a GKE install whose
// own catalog is signed: the console's release and signers, read as its
// own Google identity, signing in as its own database user with a managed
// one, and the gateway's token audience as the console chart has it.
// Off when unsigned, from a module before its identity, or with another
// install's catalog. On EKS, as its role.
func TestKernelPolicyRunsOnACloudInstallWhoseCatalogIsSigned(t *testing.T) {
	c := kindConfig()
	c.Target = "gcp"
	c.GCP.Project = "acme"
	c.Catalog.Owner, c.Catalog.Repository = "octocat", "vennir-catalog"
	c.Gateway.Enabled = true
	cloud := &Cloud{Provider: "gcp", TaskRegistry: "us-central1-docker.pkg.dev/p/vennir-products", PolicyServiceAccount: "dev-policy@acme.iam.gserviceaccount.com",
		SigningPublicKey: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n"}
	if _, on := KernelValues(c, Images{}, "", cloud)["catalogPolicy"]; on {
		t.Error("an unsigned catalog: no catalogPolicy")
	}
	c.Signing = "kms"
	p, _ := KernelValues(c, Images{}, "", cloud)["catalogPolicy"].(map[string]any)
	console := ConsoleValues(c, "dev", Images{}, cloud)
	catalog := console["catalog"].(map[string]any)
	if p["enabled"] != true || p["release"] != catalog["release"] || fmt.Sprint(p["signature"]) != fmt.Sprint(catalog["signature"]) {
		t.Fatalf("catalogPolicy %v, the console's catalog %v", p, catalog)
	}
	if fmt.Sprint(p["registry"]) != "map[gcpMetadataToken:true]" ||
		fmt.Sprint(p["serviceAccountAnnotations"]) != "map[iam.gke.io/gcp-service-account:dev-policy@acme.iam.gserviceaccount.com]" {
		t.Errorf("its identity: %v %v", p["registry"], p["serviceAccountAnnotations"])
	}
	gateway := p["gateway"].(map[string]any)
	if gateway["serviceAccount"] != "console-execution-console-gateway" ||
		gateway["gcpTokenAudience"] != console["gateway"].(map[string]any)["gcp"].(map[string]any)["tokenAudience"] {
		t.Errorf("the gateway: %v, the console's %v", gateway, console["gateway"])
	}
	if _, set := p["database"]; set {
		t.Errorf("the bundled Postgres: the chart's own role, not %v", p["database"])
	}
	cloud.Database = &ManagedDatabase{Provider: "gcp", KernelUser: "dev-kernel@acme.iam", PolicyUser: "dev-policy@acme.iam"}
	p = KernelValues(c, Images{}, "", cloud)["catalogPolicy"].(map[string]any)
	if fmt.Sprint(p["database"]) != "map[existingSecret:vennir-kernel-policy-db role:dev-policy@acme.iam]" {
		t.Errorf("a managed database: %v", p["database"])
	}

	// EKS: its role, by Pod Identity, reading ECR with its token; no
	// Google audience for the gateway.
	eks := *cloud
	eks.Provider, eks.PolicyServiceAccount, eks.PolicyRole = "aws", "", "arn:aws:iam::1:role/dev-policy"
	eks.Database = &ManagedDatabase{Provider: "aws", KernelUser: "vennir_kernel", PolicyUser: "vennir_kernel_policy"}
	p = KernelValues(c, Images{}, "", &eks)["catalogPolicy"].(map[string]any)
	if fmt.Sprint(p["registry"]) != "map[ecrToken:true]" || p["serviceAccountAnnotations"] != nil ||
		fmt.Sprint(p["gateway"]) != "map[serviceAccount:console-execution-console-gateway]" ||
		fmt.Sprint(p["database"]) != "map[existingSecret:vennir-kernel-policy-db role:vennir_kernel_policy]" {
		t.Errorf("EKS: %v", p)
	}

	for name, change := range map[string]func(*Cloud, *config.Config){
		"EKS, a module from before": func(cl *Cloud, _ *config.Config) { cl.Provider = "aws" },
		"a module from before":      func(cl *Cloud, _ *config.Config) { cl.PolicyServiceAccount = "" },
		"another install's catalog": func(_ *Cloud, cfg *config.Config) { cfg.ExternalCatalog.Registry = "us-docker.pkg.dev/other/catalog" },
	} {
		cl, cfg := *cloud, *c
		change(&cl, &cfg)
		if _, on := KernelValues(&cfg, Images{}, "", &cl)["catalogPolicy"]; on {
			t.Errorf("%s: no catalogPolicy", name)
		}
	}
}
