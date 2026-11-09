// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"io"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/roburns/vennir/cli/internal/access"
	"github.com/roburns/vennir/cli/internal/awscloud"
	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/githost"
	"github.com/roburns/vennir/cli/internal/install"
	"github.com/roburns/vennir/cli/internal/plan"
	"github.com/roburns/vennir/cli/internal/prompt"
	"github.com/roburns/vennir/cli/internal/releases"
)

type initFlags struct {
	signing                                string
	force                                  bool
	target, release, source, clusterName   string
	kubeContext, namespace, size           string
	taskImages, platformImages, adminEmail string
	idleAfter                              string
	project, region, mode, taskRegistry    string
	zone, console                          string
	profile, subscription, resourceGroup   string
	catalogOwner, catalogRepo, catalogTeam string
	catalogVisibility, languages, hostname string
	noCatalog, useExistingCatalog          bool
	scaleDown                              string
	database, databaseHA                   string
	chat                                   string
	logs, auditExport, auditLock, gateway  string
	externalSecrets                        string
	monitoring                             string
	registryPort, minReplicas, headroom    int
}

func (a *app) initCmd() *cobra.Command {
	f := &initFlags{}
	cmd := &cobra.Command{
		Use:   "init <env>",
		Short: "Ask the questions and write deploy/<env>/vennir.yaml",
		Long: "Asks where and how to install Vennir, checks the tools that needs, and writes the\n" +
			"environment's settings. Nothing is created until `vennir apply`.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error { return a.runInit(cmd, args[0], f) },
	}
	fl := cmd.Flags()
	fl.BoolVar(&f.force, "force", false, "replace an existing environment's settings")
	fl.StringVar(&f.target, "target", "", "kind (local), gcp, aws, azure or existing")
	fl.StringVar(&f.release, "release", "", "install a released version (e.g. 0.1.0) instead of from source")
	fl.StringVar(&f.source, "source", "", "a Vennir checkout to install from (charts, and images built from it)")
	fl.StringVar(&f.clusterName, "cluster-name", "", "kind, gcp, aws, azure: the cluster's name (default vennir)")
	fl.IntVar(&f.registryPort, "registry-port", 0, "kind: the local registry's port (default 5001)")
	fl.StringVar(&f.kubeContext, "context", "", "existing: the kubectl context")
	fl.StringVar(&f.project, "project", "", "gcp: the project (default: gcloud's)")
	fl.StringVar(&f.profile, "profile", "", "aws: the AWS CLI profile to sign in with (default: AWS_PROFILE, or the default chain)")
	fl.StringVar(&f.subscription, "subscription", "", "azure: the subscription's id (default: az's)")
	fl.StringVar(&f.resourceGroup, "resource-group", "", "azure: the resource group vennir makes (default: the cluster's name)")
	fl.StringVar(&f.region, "region", "", "gcp, aws: the region (gcp default us-central1; aws: one the account may use)")
	fl.StringVar(&f.mode, "mode", "", "gcp, aws: auto (GKE Autopilot, EKS Auto Mode) or standard (node groups vennir sizes)")
	fl.StringVar(&f.taskRegistry, "task-registry", "", "gcp, aws: where the catalog's images go, made for you (Artifact Registry repository, ECR prefix)")
	fl.StringVar(&f.namespace, "namespace", "", "the platform's namespace (default vennir-system)")
	fl.StringVar(&f.taskImages, "task-images", "", "existing: the registry steps' images may come from")
	fl.StringVar(&f.platformImages, "platform-images", "", "existing, from source: the registry to push the built images to")
	fl.StringVar(&f.size, "size", "", "minimal, resilient, scaled or auto")
	fl.StringVar(&f.scaleDown, "scale-down", "", "true or false: sleep when idle")
	fl.StringVar(&f.database, "database", "", "gcp, aws: in-cluster (Postgres in a Pod, backed up to a bucket) or managed (Cloud SQL, Amazon RDS)")
	fl.StringVar(&f.chat, "chat", "", "aws: true or false: the console's chat answers with Claude in Amazon Bedrock (default: on when this account may use it)")
	fl.StringVar(&f.databaseHA, "database-ha", "", "with a managed database: true or false: a standby in a second zone (default: on for resilient and scaled)")
	fl.StringVar(&f.logs, "logs", "", "true or false: keep steps' and the platform's logs for Observe's search (Loki)")
	fl.StringVar(&f.auditExport, "audit-export", "", "gcp, aws: true or false: copy the audit log to a bucket that refuses deletes")
	fl.StringVar(&f.auditLock, "audit-lock", "", "gcp, aws: true or false: lock that bucket's retention for good (permanent)")
	fl.StringVar(&f.gateway, "gateway", "", "true or false: serve the catalog's API products through the API gateway")
	fl.StringVar(&f.externalSecrets, "external-secrets", "", "true or false: install External Secrets Operator, for teams' SecretStores (synced secrets)")
	fl.StringVar(&f.signing, "signing", "", "gcp, aws, with a catalog: none, kms (a key in the cloud's KMS) or keyless (Sigstore, public log)")
	fl.StringVar(&f.monitoring, "monitoring", "", "Prometheus for the platform's metrics and alerts: false, operator (the cluster's Prometheus Operator; true means this), google (gcp: GKE's managed Prometheus), amazon (aws: Amazon Managed Prometheus) or bundled (one of its own)")
	fl.StringVar(&f.idleAfter, "idle-after", "", "with scale-down: how long idle before sleeping (default 2h)")
	fl.IntVar(&f.minReplicas, "min-replicas", 0, "without scale-down: always-on copies of the console and API")
	fl.IntVar(&f.headroom, "step-headroom", -1, "without scale-down: steps that can start without waiting")
	fl.StringVar(&f.adminEmail, "admin-email", "", "the first admin's email")
	fl.StringVar(&f.hostname, "hostname", "", "the console's public hostname (gcp default: a nip.io name; aws default: console in the zone, e.g. console.vennir.example.com)")
	fl.StringVar(&f.console, "console", "", "gcp, aws: private (reached with vennir console) or public (HTTPS from the internet)")
	fl.StringVar(&f.zone, "zone", "", "aws: a DNS zone for the console's public address, created in Route 53 for you to delegate (e.g. vennir.example.com)")
	fl.BoolVar(&f.noCatalog, "no-catalog", false, "gcp, aws: no catalog repository (vennir catalog create makes one later)")
	fl.StringVar(&f.catalogOwner, "catalog-owner", "", "the catalog's GitHub owner, an account or organization (default: you)")
	fl.StringVar(&f.catalogRepo, "catalog-repo", "", "the catalog repository's name (default vennir-catalog)")
	fl.BoolVar(&f.useExistingCatalog, "catalog-use-existing", false, "if the catalog repository exists, use it (its contents stay)")
	fl.StringVar(&f.catalogVisibility, "catalog-visibility", "", "public, private (default) or internal")
	fl.StringVar(&f.catalogTeam, "catalog-team", "", "the first team's name (default platform)")
	fl.StringVar(&f.languages, "languages", "", "starter languages, comma-separated: python, typescript, go, powershell, rust (default python)")
	return cmd
}

func (a *app) runInit(cmd *cobra.Command, env string, f *initFlags) error {
	ctx := cmd.Context()
	dir, err := config.Dir(a.base, env)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dir, config.FileName)); err == nil && !f.force {
		return fmt.Errorf("%s already has settings: change one with `vennir config set`, or start over with --force", dir)
	}
	out := cmd.OutOrStdout()

	// 1. Target, and its tools straight away.
	target, err := a.ask.Choose("Where should Vennir run?", []prompt.Option{
		{Value: "kind", Label: "kind (local)", Note: "a cluster on this machine, in Docker"},
		{Value: "gcp", Label: "gcp", Note: "a new GKE cluster in a Google Cloud project, with OpenTofu"},
		{Value: "aws", Label: "aws", Note: "a new EKS Auto Mode cluster in your AWS account, with OpenTofu"},
		{Value: "azure", Label: "azure", Note: "a new AKS cluster in an Azure subscription, with OpenTofu"},
		{Value: "existing", Label: "existing", Note: "a Kubernetes cluster you already have"},
	}, orDefault(f.target, "kind"))
	if err != nil {
		return err
	}
	c := config.Default(target)

	// 2. Source or release.
	checkout := f.source
	if checkout == "" && f.release == "" {
		checkout = findCheckout()
	}
	switch {
	case f.release != "":
		c.Vennir = f.release
	case checkout != "":
		choice, err := a.ask.Choose("Install from:", []prompt.Option{
			{Value: "source", Label: "this checkout", Note: checkout + ": charts from it, images built from it"},
			{Value: "release", Label: "a release", Note: "published charts and images"},
		}, "source")
		if err != nil {
			return err
		}
		if choice == "source" {
			c.Vennir, c.Source = "source", checkout
		} else if c.Vennir, err = a.ask.Text("Release version", releaseDefault(), nil); err != nil {
			return err
		}
	default:
		if c.Vennir, err = a.ask.Text("Release version", releaseDefault(), nil); err != nil {
			return err
		}
	}
	if err := a.requireTools(ctx, out, target, c.Vennir == "source"); err != nil {
		return err
	}

	// 3. The cluster, after who you are and what you may use.
	var awsCheck *access.AWS
	switch target {
	case "kind":
		if c.Cluster.Name, err = a.ask.Text("kind cluster name", orDefault(f.clusterName, c.Cluster.Name), nil); err != nil {
			return err
		}
		port := orDefaultInt(f.registryPort, c.Kind.RegistryPort)
		if c.Kind.RegistryPort, err = a.ask.Number("Local registry port", port, 1024, 65535); err != nil {
			return err
		}
		c.TaskImages.Registry = fmt.Sprintf("localhost:%d", c.Kind.RegistryPort)
	case "gcp":
		if c.GCP.Region, err = a.ask.Text("Region", orDefault(f.region, "us-central1"), nil); err != nil {
			return err
		}
		if err := a.gcpAccess(ctx, out, c, f); err != nil {
			return err
		}
		if c.Cluster.Mode, err = a.ask.Choose("Cluster mode:", []prompt.Option{
			{Value: "auto", Label: "auto", Note: "GKE Autopilot: billed per Pod, nothing for a sleeping platform"},
			{Value: "standard", Label: "standard", Note: "node pools sized for you: billed per node, the platform's nodes always"},
		}, orDefault(f.mode, "auto")); err != nil {
			return err
		}
		if c.Cluster.Name, err = a.ask.Text("Cluster name (also names what's created)", orDefault(f.clusterName, c.Cluster.Name), nil); err != nil {
			return err
		}
		if c.TaskImages.Name, err = a.ask.Text("Artifact Registry repository for the catalog's images (created)", orDefault(f.taskRegistry, c.TaskImages.Name), nil); err != nil {
			return err
		}
	case "aws":
		if awsCheck, err = a.awsAccess(ctx, out, c, f); err != nil {
			return err
		}
		if c.Cluster.Mode, err = a.ask.Choose("Cluster mode:", []prompt.Option{
			{Value: "auto", Label: "auto", Note: "EKS Auto Mode: nodes follow the Pods, none while asleep; a fee per node"},
			{Value: "standard", Label: "standard", Note: "node groups and the Cluster Autoscaler: the platform's nodes always run"},
		}, orDefault(f.mode, "auto")); err != nil {
			return err
		}
		if c.Cluster.Name, err = a.ask.Text("Cluster name (also names what's created)", orDefault(f.clusterName, c.Cluster.Name), nil); err != nil {
			return err
		}
		if c.TaskImages.Name, err = a.ask.Text("ECR prefix for the catalog's images (repositories made on push)", orDefault(f.taskRegistry, c.TaskImages.Name), nil); err != nil {
			return err
		}
	case "azure":
		if err := a.azureAccess(ctx, out, c, f); err != nil {
			return err
		}
		fmt.Fprintln(out, "Cluster mode: standard (a system node pool, and one for steps from zero; AKS Automatic comes later).")
		if c.Cluster.Name, err = a.ask.Text("Cluster name (also names what's created)", orDefault(f.clusterName, c.Cluster.Name), nil); err != nil {
			return err
		}
		if c.Azure.ResourceGroup, err = a.ask.Text("Resource group for it (created)", orDefault(f.resourceGroup, c.Cluster.Name), nil); err != nil {
			return err
		}
		if c.TaskImages.Name, err = a.ask.Text("ACR repository prefix for the catalog's images", orDefault(f.taskRegistry, c.TaskImages.Name), nil); err != nil {
			return err
		}

	case "existing":
		current, _ := a.runner.Output(ctx, "kubectl", "config", "current-context")
		if c.Cluster.Context, err = a.ask.Text("kubectl context", orDefault(f.kubeContext, current), nil); err != nil {
			return err
		}
		if c.TaskImages.Registry, err = a.ask.Text("Registry steps' images may come from (e.g. us-docker.pkg.dev/p/catalog)", f.taskImages, nil); err != nil {
			return err
		}
		if c.Vennir == "source" {
			if c.PlatformImages.Registry, err = a.ask.Text("Registry to push the platform images built from source to", f.platformImages, nil); err != nil {
				return err
			}
		}
	}
	if c.Namespace, err = a.ask.Text("Platform namespace", orDefault(f.namespace, c.Namespace), nil); err != nil {
		return err
	}

	// 4. Size.
	var sizes []prompt.Option
	for _, s := range config.Sizes {
		fl := plan.Floors[s]
		sizes = append(sizes, prompt.Option{Value: s, Label: s, Note: fmt.Sprintf("%s; %s, %s awake", fl.Copies, fl.CPU, fl.Memory)})
	}
	if c.Size, err = a.ask.Choose("Size:", sizes, orDefault(f.size, "minimal")); err != nil {
		return err
	}

	// 5. Scale down: for development and test installs, not production.
	scaleDefault := c.Size == "minimal"
	if f.scaleDown != "" {
		scaleDefault = f.scaleDown == "true"
	}
	fmt.Fprintln(out, "Scaling down suits a development or test install: while it sleeps, the console and API don't answer,")
	fmt.Fprintln(out, "so catalog CI and automation fail until something wakes it (a schedule wakes it by itself). Keep a")
	fmt.Fprintln(out, "production install awake.")
	if c.ScaleDown.Enabled, err = a.ask.Confirm("Scale down when idle? (it sleeps, and `vennir wake` brings it back)", scaleDefault); err != nil {
		return err
	}
	if c.ScaleDown.Enabled {
		if c.ScaleDown.IdleAfter, err = a.ask.Text("Sleep after how long idle?", orDefault(f.idleAfter, "2h"), validDuration); err != nil {
			return err
		}
	} else {
		c.ScaleDown.IdleAfter = ""
		def := map[string]int{"minimal": 1, "resilient": 2, "scaled": 3, "auto": 1}[c.Size]
		if c.MinReplicas, err = a.ask.Number("Always-on copies of the console and API", orDefaultInt(f.minReplicas, def), 1, 10); err != nil {
			return err
		}
		headroom := 0
		if f.headroom >= 0 {
			headroom = f.headroom
		}
		if c.StepHeadroom, err = a.ask.Number("Keep room for how many steps to start without waiting?", headroom, 0, 100); err != nil {
			return err
		}
	}

	// 6. Database, then the admin.
	if c.Target == "gcp" || c.Target == "aws" {
		managed := "Cloud SQL: Google patches and backs it up (point-in-time recovery), private IP, no passwords; billed while asleep too"
		if c.Target == "aws" {
			managed = "Amazon RDS: AWS patches and backs it up (point-in-time recovery), no public access, no passwords of Vennir's; billed while asleep too"
		}
		if c.Database.Type, err = a.ask.Choose("Database:", []prompt.Option{
			{Value: "in-cluster", Label: "in-cluster", Note: "Postgres in a Pod, backed up daily to a bucket (kept 30 days); sleeps with the install"},
			{Value: "managed", Label: "managed", Note: managed},
		}, orDefault(f.database, "in-cluster")); err != nil {
			return err
		}
		if c.Database.Type == "managed" {
			ha := c.Size == "resilient" || c.Size == "scaled"
			if f.databaseHA != "" {
				ha = f.databaseHA == "true"
			}
			if c.Database.HighAvailability, err = a.ask.Confirm("A standby in a second zone, failed over to automatically? (about twice the instance's cost)", ha); err != nil {
				return err
			}
		}
	} else if c.Target == "azure" {
		fmt.Fprintln(out, "Database: in-cluster Postgres, backed up daily to a storage container (a managed one comes later on azure).")
	} else {
		fmt.Fprintln(out, "Database: in-cluster Postgres (a managed one comes with the cloud targets).")
	}
	if c.Admin.Email, err = a.ask.Text("First admin's email", f.adminEmail, validEmail); err != nil {
		return err
	}
	if err := a.offerBudget(ctx, out, c, awsCheck); err != nil {
		return err
	}
	if c.Target == "aws" {
		if err := a.askBedrockChat(ctx, out, c, f); err != nil {
			return err
		}
	}

	if c.Target == "existing" && a.ask.Interactive {
		if err := a.askExistingConsole(ctx, out, c); err != nil {
			return err
		}
	}
	if c.Target == "gcp" || c.Target == "aws" {
		if err := a.askConsole(ctx, out, c, f); err != nil {
			return err
		}
		// Its CI only pushes to the registry; the console pulls, so a
		// private console is fine.
		if err := a.askCatalog(ctx, out, c, f); err != nil {
			return err
		}
	}

	// 7. What else it keeps and serves.
	if err := a.askFeatures(out, c, f); err != nil {
		return err
	}
	if err := a.askMonitoring(ctx, out, c, f); err != nil {
		return err
	}

	c.FillDefaults()
	if err := c.Validate(); err != nil {
		return err
	}
	if err := c.Save(dir); err != nil {
		return err
	}
	fmt.Fprintf(out, "\nWrote %s. Next: vennir apply %s\n", filepath.Join(dir, config.FileName), env)
	fmt.Fprintf(out, "What it will ask of you, and what comes after: %s\n", strings.TrimSuffix(guidesURL, "clouds/")+"setup.md")
	return nil
}

// findCheckout looks for a Vennir checkout at or above the working directory.
func findCheckout() string {
	dir, err := os.Getwd()
	if err != nil {
		return ""
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "helm", "charts", "execution-kernel", "Chart.yaml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func releaseDefault() string {
	if Version != "dev" {
		return strings.TrimPrefix(Version, "v")
	}
	// Built from a checkout: the newest release whose charts it can check.
	newest := "0.1.0"
	for _, v := range install.KnownReleases() {
		if releases.Compare(v, newest) > 0 {
			newest = v
		}
	}
	return newest
}

func orDefault(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

func orDefaultInt(v, def int) int {
	if v > 0 {
		return v
	}
	return def
}

func validDuration(s string) error {
	if _, err := time.ParseDuration(s); err != nil {
		return fmt.Errorf("a duration like 2h or 45m")
	}
	return nil
}

func validEmail(s string) error {
	if _, err := mail.ParseAddress(s); err != nil || !strings.Contains(s, "@") {
		return fmt.Errorf("an email address, like you@example.com")
	}
	return nil
}

// askCatalog asks where the catalog repository goes (created later by
// `vennir catalog create`; apply needs it now for its CI's federation).
func (a *app) askCatalog(ctx context.Context, out io.Writer, c *config.Config, f *initFlags) error {
	var err error
	want := !f.noCatalog
	if want, err = a.ask.Confirm("Create a catalog repository on GitHub? (`vennir catalog create`, after apply)", want); err != nil || !want {
		return err
	}
	login, err := a.githubAccess(ctx, out, c)
	if err != nil {
		return err
	}
	cat := &c.Catalog
	cat.Host = "github"
	if cat.Owner, err = a.ask.Text("GitHub owner (an account or organization)", orDefault(f.catalogOwner, login), nil); err != nil {
		return err
	}
	name := orDefault(f.catalogRepo, "vennir-catalog")
	gh := githost.NewGitHub(a.runner)
	for {
		if cat.Repository, err = a.ask.Text("Repository name", name, nil); err != nil {
			return err
		}
		exists, err := gh.Exists(ctx, cat.Repo())
		if err != nil {
			return err
		}
		cat.UseExisting = false
		if !exists {
			break
		}
		def := "other"
		if f.useExistingCatalog {
			def = "use"
		}
		choice, err := a.ask.Choose(fmt.Sprintf("github.com/%s already exists:", cat.Repo()), []prompt.Option{
			{Value: "use", Label: "use it", Note: "its contents stay; `vennir catalog create` sets its variables, secrets and federation for this install"},
			{Value: "other", Label: "choose another name", Note: "a new repository"},
		}, def)
		if err != nil {
			return err
		}
		if choice == "use" {
			cat.UseExisting = true
			break
		}
		if !a.ask.Interactive {
			return fmt.Errorf("github.com/%s already exists: pass --catalog-use-existing to use it, or another --catalog-repo", cat.Repo())
		}
		name = ""
	}
	if cat.Visibility, err = a.ask.Choose("Visibility:", []prompt.Option{
		{Value: "private", Label: "private", Note: "on GitHub Free: no Environments or branch rules"},
		{Value: "public", Label: "public", Note: "every setting applies"},
		{Value: "internal", Label: "internal", Note: "organizations on GitHub Enterprise"},
	}, orDefault(f.catalogVisibility, "private")); err != nil {
		return err
	}
	if cat.Team, err = a.ask.Text("First team's name", orDefault(f.catalogTeam, "platform"), nil); err != nil {
		return err
	}
	langs, err := a.ask.Text("Starter languages (python, typescript, go, powershell, rust)", orDefault(f.languages, "python"), nil)
	if err != nil {
		return err
	}
	cat.Languages = nil
	for _, l := range strings.Split(langs, ",") {
		if l = strings.ToLower(strings.TrimSpace(l)); l != "" {
			cat.Languages = append(cat.Languages, l)
		}
	}
	if c.Target == "gcp" || c.Target == "aws" {
		kms := map[string]string{"gcp": "Cloud KMS", "aws": "AWS KMS"}[c.Target]
		if c.Signing, err = a.ask.Choose("Image signing: only images and releases the catalog's CI signed run here", []prompt.Option{
			{Value: "kms", Label: "kms", Note: "a " + kms + " key apply makes, which only the catalog's CI (main) may sign with; nothing published outside your cloud"},
			{Value: "keyless", Label: "keyless", Note: "the CI's own GitHub identity through Sigstore, no key; each signature is in its public log, which names the repository"},
			{Value: "none", Label: "none", Note: "not signed: anyone who can push to the registry can publish what runs"},
		}, orDefault(f.signing, "kms")); err != nil {
			return err
		}
	}
	return nil
}

// askBedrockChat decides the console's chat on aws: Claude in Amazon
// Bedrock as the console's own identity, when this account may use it.
// AWS may refuse an account Anthropic's models (its use-case form), and a
// chat on a model it can't call only fails, so then it's left off, with
// another way to have one.
func (a *app) askBedrockChat(ctx context.Context, out io.Writer, c *config.Config, f *initFlags) error {
	model := c.Chat.Model
	if model == "" {
		model = config.DefaultBedrockModel
	}
	authorized, err := awscloud.BedrockAuthorized(ctx, a.runner, c, model)
	switch {
	case f.chat != "":
		c.Chat.Off = f.chat != "true"
		if !c.Chat.Off && err == nil && !authorized {
			fmt.Fprintf(out, "Warning: this account isn't authorized for %s in Amazon Bedrock yet: the chat fails until it is (Bedrock console: Model catalog, the model, Submit use case details).\n", model)
		}
		return nil
	case err != nil:
		fmt.Fprintf(out, "Couldn't ask Amazon Bedrock whether this account may use %s (%v).\n", model, err)
	case !authorized:
		fmt.Fprintf(out, "Chat: this account isn't authorized for %s in Amazon Bedrock (AWS asks for Anthropic's use-case form, and may refuse it).\n", model)
		fmt.Fprintln(out, "It's left off. An admin can answer with an Anthropic API key instead (Admin, Chat), or turn Bedrock on once access is granted: `vennir config set chat.off false`.")
		c.Chat.Off = true
		return nil
	}
	on, err := a.ask.Confirm(fmt.Sprintf("Answer the console's chat with Claude in Amazon Bedrock (%s, as the console's own AWS identity)?", model), err == nil)
	if err != nil {
		return err
	}
	c.Chat.Off = !on
	return nil
}
