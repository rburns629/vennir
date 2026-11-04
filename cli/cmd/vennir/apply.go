// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/rburns629/vennir/cli/internal/backup"
	"github.com/rburns629/vennir/cli/internal/cluster"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/gcp"
	"github.com/rburns629/vennir/cli/internal/githost"
	"github.com/rburns629/vennir/cli/internal/install"
	"github.com/rburns629/vennir/cli/internal/plan"
	"github.com/rburns629/vennir/cli/internal/platform"
	"github.com/rburns629/vennir/cli/internal/releases"
	"github.com/rburns629/vennir/cli/internal/run"
	"github.com/rburns629/vennir/cli/internal/tools"
)

func (a *app) applyCmd() *cobra.Command {
	var yes, planOnly bool
	cmd := &cobra.Command{
		Use:   "apply [env]",
		Short: "Show what will change, then create, install or upgrade on approval",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			return a.apply(cmd.Context(), cmd, dir, c, yes, planOnly)
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "approve without asking")
	cmd.Flags().BoolVar(&planOnly, "plan-only", false, "show the approval screen and stop")
	return cmd
}

func (a *app) apply(ctx context.Context, cmd *cobra.Command, dir string, c *config.Config, yes, planOnly bool) error {
	out := cmd.OutOrStdout()
	if err := a.requireTools(ctx, out, c.Target, c.Vennir == "source"); err != nil {
		return err
	}
	if err := install.CheckSSORedirect(c, ""); err != nil {
		return err
	}
	// The release list (cached a day) is read while the rest is checked.
	versions := make(chan []string, 1)
	go func() {
		list, _ := releases.List(ctx)
		versions <- list
	}()
	var cloud *cloudPlan
	switch c.Target {
	case "gcp":
		var err error
		if cloud, err = a.planGCP(ctx, out, dir, c, false); err != nil {
			return err
		}
	case "aws":
		var err error
		if cloud, err = a.planAWS(ctx, out, dir, c, false); err != nil {
			return err
		}
	}
	state := cluster.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return fmt.Errorf("the cluster isn't ready for Vennir:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	images := install.ImagesFor(c, time.Now())
	installed := map[string]string{}
	var now current
	if state.Reachable {
		var deps []platform.Deployment
		var depsErr error
		run.Together(
			func() { installed = install.Releases(ctx, a.runner, c) },
			func() { now.volume = install.DatabaseVolume(ctx, a.runner, c) },
			func() { deps, depsErr = platform.Deployments(ctx, a.runner, c) },
			func() { now.move = c.Database.Type == "managed" && backup.NeedsMove(ctx, a.runner, c) },
			func() {
				if c.ChecksSignatures() {
					now.policyController = install.InstalledIn(ctx, a.runner, c, "cosign-system", "policy-controller")
				}
			},
			func() {
				if c.ExternalSecrets {
					now.externalSecrets = install.InstalledIn(ctx, a.runner, c, "external-secrets", "external-secrets")
				}
			},
		)
		now.applied = config.Applied(dir)
		if depsErr == nil {
			now.asleep = platform.Asleep(deps)
		}
		if now.move && now.asleep {
			return fmt.Errorf("this install's data is in its in-cluster Postgres, to be moved into the managed database while it's awake: `vennir wake %s`, then apply", envName(dir))
		}
	}

	upgrade, err := releases.Upgrade(releases.ChartVersion(installed[install.KernelRelease]), c.Vennir, Version, <-versions)
	if err != nil {
		return err
	}
	// Its charts are checked against the sums this vennir carries: before
	// anything is approved, not once the cloud side exists.
	if c.Vennir != "source" {
		if err := install.KnownRelease(c.Vennir); err != nil {
			return err
		}
	}
	p := buildPlan(ctx, c, envName(dir), state, images, installed, now, cloud)
	p.Notes = append(p.Notes, upgrade...)
	var screen bytes.Buffer
	p.Render(&screen)
	fmt.Fprint(out, screen.String())
	if planOnly {
		return nil
	}
	if !yes {
		ok, err := a.ask.Confirm("Apply?", false)
		if err != nil {
			return err
		}
		if !ok || !a.ask.Interactive {
			if !a.ask.Interactive {
				return fmt.Errorf("not approved: pass --yes to apply without a prompt")
			}
			return errStopped
		}
	}
	stamp := fmt.Sprintf("Approved %s\n\n", time.Now().UTC().Format(time.RFC3339))
	if err := os.WriteFile(filepath.Join(dir, "last-plan.txt"), []byte(stamp+screen.String()), 0o644); err != nil {
		return err
	}

	var made *install.Cloud
	switch c.Target {
	case "kind":
		fmt.Fprintln(out, "Preparing the local registry and the kind cluster...")
		if err := cluster.EnsureKind(ctx, a.runner, c, state); err != nil {
			return err
		}
	case "gcp":
		var err error
		if made, err = a.applyGCP(ctx, out, c, cloud, images); err != nil {
			return err
		}
	case "aws":
		// Before the publish role's trust changes: a catalog made before it
		// named only main needs its tokens to name their branch first.
		if repo := c.Catalog.Repo(); repo != "" {
			if err := ensureCatalogSubject(ctx, out, githost.NewGitHub(a.runner), repo); err != nil {
				return err
			}
		}
		var err error
		if made, err = a.applyAWS(ctx, out, c, cloud, images); err != nil {
			return err
		}
	}
	// A public address only the cloud side knows (gcp's nip.io name, aws's
	// zone), checked before the console is installed with the old one.
	if made != nil && made.ConsoleHost != "" {
		if err := install.CheckSSORedirect(c, made.ConsoleHost); err != nil {
			return err
		}
	}
	if err := cluster.EnsureNamespace(ctx, a.runner, c); err != nil {
		return err
	}
	if made != nil && made.BackupBucket != "" {
		if err := install.EnsureBackupServiceAccount(ctx, a.runner, c, made); err != nil {
			return err
		}
	}
	if made != nil && made.ConsoleHost != "" && made.Provider != "aws" {
		if err := install.EnsureCertificate(ctx, a.runner, c, made.ConsoleHost); err != nil {
			return err
		}
	}
	if images.Build {
		fmt.Fprintln(out, "Building the platform images from", c.Source, "...")
		if err := install.BuildImages(ctx, a.runner, c, images); err != nil {
			return err
		}
	}
	kernelChart, consoleChart := install.Charts(c, dir)
	for _, chart := range []install.Chart{kernelChart, consoleChart} {
		if err := install.Pull(ctx, a.runner, chart); err != nil {
			return err
		}
	}
	if certManagerNeeded(c) {
		if !install.CertManagerInstalled(ctx, a.runner, c) {
			if !c.Console.TLS.InstallCertManager {
				return fmt.Errorf("the console's certificate needs cert-manager, which this cluster hasn't got: install it, or `vennir config set console.tls.installCertManager true` for vennir to (%s)", install.CertManagerChart)
			}
			fmt.Fprintln(out, "Installing cert-manager", install.CertManagerChart, "(the console's certificate)...")
			if err := install.RecordIfMissing(ctx, a.runner, c, dir, install.CertManagerAddOn); err != nil {
				return err
			}
			if err := install.CertManager(ctx, a.runner, c); err != nil {
				return err
			}
		}
	}
	if c.Target == "kind" && c.Size == "auto" {
		fmt.Fprintln(out, "Installing metrics-server (the auto size's autoscalers need it)...")
		if err := install.MetricsServer(ctx, a.runner, c); err != nil {
			return err
		}
	}
	kernelValues, err := install.WriteValues(dir, "kernel", install.KernelValues(c, images, now.volume, made))
	if err != nil {
		return err
	}
	generated := install.ConsoleValues(c, envName(dir), images, made)
	var password string // the first admin's, until an apply has finished
	if firstAdminPending(dir, installed[install.ConsoleRelease]) {
		// Saved first, so it can't be lost, then given to the console in a
		// Secret (never through a log, which the cluster may keep). One
		// saved already (an install that stopped part way) is used again.
		if password = savedPassword(dir); password == "" {
			password = install.NewPassword()
			if _, err := savePassword(dir, password); err != nil {
				return fmt.Errorf("the first admin's password couldn't be saved in %s: %w", dir, err)
			}
		}
		install.WithFirstAdmin(generated)
	}
	consoleValues, err := install.WriteValues(dir, "console", generated)
	if err != nil {
		return err
	}
	if c.ChecksSignatures() {
		// Before the kernel chart, whose image policy is its kind.
		fmt.Fprintln(out, "Installing policy-controller", install.PolicyControllerChart, "(only images catalog CI signed run)...")
		if err := install.RecordIfMissing(ctx, a.runner, c, dir, install.PolicyControllerAddOn); err != nil {
			return err
		}
		if err := install.PolicyController(ctx, a.runner, c, made); err != nil {
			return err
		}
	}
	if made != nil && made.Database != nil {
		fmt.Fprintln(out, "Opening the managed database to the kernel and the console...")
		if err := install.EnsureManagedDatabase(ctx, a.runner, c, made.Database, install.KernelImage(c, images)); err != nil {
			return err
		}
		if now.move {
			if err := backup.MoveToManaged(ctx, a.runner, c, out, made.Database, install.KernelImage(c, images), made.ConsoleServiceAccount); err != nil {
				return fmt.Errorf("moving the data into the managed database: %w", err)
			}
		}
	}
	fmt.Fprintln(out, "Installing execution-kernel...")
	if err := install.Upgrade(ctx, a.runner, c, dir, install.KernelRelease, kernelChart, kernelValues); err != nil {
		return err
	}
	if c.SSO.Provider != "" {
		if err := install.EnsureSSOSecret(ctx, a.runner, c); err != nil {
			return fmt.Errorf("signing in with Google: %w", err)
		}
	}
	if c.ExternalSecrets {
		// Before the console, which writes teams' SecretStores.
		fmt.Fprintln(out, "Installing External Secrets Operator", install.ExternalSecretsChart, "(teams' SecretStores)...")
		if err := install.RecordIfMissing(ctx, a.runner, c, dir, install.ExternalSecretsAddOn); err != nil {
			return err
		}
		if err := install.ExternalSecrets(ctx, a.runner, c); err != nil {
			return err
		}
	}
	if password != "" {
		if err := install.GivePassword(ctx, a.runner, c, password); err != nil {
			return fmt.Errorf("giving the console the first admin's password: %w", err)
		}
	}
	fmt.Fprintln(out, "Installing execution-console...")
	if err := install.Upgrade(ctx, a.runner, c, dir, install.ConsoleRelease, consoleChart, consoleValues); err != nil {
		return err
	}
	// Its account has it now (or had one): the saved file is the only copy.
	install.ForgetPassword(ctx, a.runner, c)
	if now.move {
		fmt.Fprintln(out, "Starting the platform on the managed database...")
		if err := backup.FinishMove(ctx, a.runner, c); err != nil {
			return err
		}
		fmt.Fprintf(out, "Moved. The in-cluster Postgres's volume (%s) is kept, the way back: once you're sure, `kubectl --context %s -n %s delete pvc %s`.\n",
			install.KernelRelease+"-execution-kernel-postgres", cluster.Context(c), c.Namespace, install.KernelRelease+"-execution-kernel-postgres")
	}

	if made != nil && made.Provider == "aws" && made.ConsoleHost != "" {
		if err := a.awsConsoleAddress(ctx, out, c, made); err != nil {
			return err
		}
	}

	// A hostname of the user's: the record it needs, before the certificate.
	a.consoleDNS(ctx, out, c, made)

	// Awake now (an apply wakes it): the sleeper looks again.
	if err := platform.SuspendSleeper(ctx, a.runner, c, false); err != nil {
		return err
	}

	fmt.Fprintln(out, "\nVennir is running.")
	fmt.Fprintln(out, "  Console:", platform.ConsoleAccess(c, envName(dir)))
	if made != nil && made.ConsoleHost != "" {
		if made.Provider == "aws" {
			fmt.Fprintf(out, "  Public:  https://%s\n", made.ConsoleHost)
		} else {
			fmt.Fprintf(out, "  Public:  https://%s (certificate %s; Google issues it within the hour)\n",
				made.ConsoleHost, orDefault(install.CertificateStatus(ctx, a.runner, c), "requested"))
		}
	}
	if certManagerNeeded(c) {
		how := "Let's Encrypt, which proves the hostname over HTTP: point " + c.Console.Hostname + " at the Ingress first"
		if c.Console.TLS.Issuer != "" {
			how = "issuer " + c.Console.TLS.Issuer
		}
		fmt.Fprintf(out, "  Public:  https://%s (certificate %s; %s)\n", c.Console.Hostname, install.ConsoleCertificate(ctx, a.runner, c), how)
	}
	if made != nil && made.Provider == "gcp" && c.SSO.GoogleGroups {
		fmt.Fprintln(out, "\nThe console reads Google Workspace groups as", made.ConsoleServiceAccount+".")
		fmt.Fprintln(out, "A Workspace admin makes it a Groups Reader, once:")
		fmt.Fprintln(out, "  https://admin.google.com/ac/roles: Groups Reader, Admins, Assign service accounts:", made.ConsoleServiceAccount)
		fmt.Fprintln(out, "Then, on the console's Admin page (People, Single sign-on): Google Workspace groups, and map groups to teams.")
	}
	if grant := install.CatalogGrant(c, made); grant != nil {
		fmt.Fprintln(out, "\nThis install reads the catalog in", c.ExternalCatalog.Registry+": its owner lets it", grant.Why+",")
		fmt.Fprintln(out, "in the owner's environment (it shows what it will do, then asks; no key is stored anywhere):")
		fmt.Fprintln(out, "  "+grant.Command)
		if len(grant.Then) > 0 {
			fmt.Fprintln(out, "Then here:")
			for _, step := range grant.Then {
				fmt.Fprintln(out, "  "+step)
			}
		}
	}
	// Applied: what the next screen compares against.
	if err := c.SaveApplied(dir); err != nil {
		return err
	}
	if password != "" {
		path := filepath.Join(dir, "admin-password")
		if install.AdminCreated(ctx, a.runner, c) {
			fmt.Fprintf(out, "  Sign in as %s with the password in %s (only you can read it).\n", c.Admin.Email, path)
			fmt.Fprintln(out, "  "+passwordThen)
		} else {
			// Its data was kept from before: the password is what it was.
			fmt.Fprintf(out, "  %s already had an account, so its password is unchanged (not necessarily the one in %s): `vennir admin reset-password %s` if it's lost.\n", c.Admin.Email, path, envName(dir))
		}
	}
	return nil
}

// firstAdminPending: the first admin's password is still to be given to the
// console. A fresh install, or one whose first apply stopped part way (a
// failed release is still listed, and its next upgrade's migrate may be the
// one that creates the account): a password is saved and no apply has
// finished (applied.yaml). Given again to an account that exists, it's
// harmless: the console leaves that account alone.
func firstAdminPending(dir, consoleChart string) bool {
	return consoleChart == "" || (savedPassword(dir) != "" && config.Applied(dir) == nil)
}

// current is what apply finds installed, beyond the releases.
type current struct {
	volume string // the database volume's size, if it exists
	asleep bool
	// move: the data is in the in-cluster Postgres, and the database is
	// now managed: apply copies it over.
	move bool
	// The charts installed beside the platform (name-version), when used.
	policyController, externalSecrets string
	// vennir.yaml as last applied: nil if unknown.
	applied *config.Config
}

// buildPlan assembles the approval screen.
func buildPlan(ctx context.Context, c *config.Config, env string, s cluster.State, img install.Images, installed map[string]string, now current, cloud *cloudPlan) *plan.Plan {
	p := &plan.Plan{}
	what := "release " + c.Vennir
	if c.Vennir == "source" {
		what = "source (" + c.Source + ")"
	}
	where := "kind (local), cluster " + c.Cluster.Name
	switch c.Target {
	case "existing":
		where = "existing cluster, context " + c.Cluster.Context
		if s.ServerVersion != "" {
			where += " (Kubernetes " + s.ServerVersion + ")"
		}
	case "gcp":
		mode := map[string]string{"auto": "GKE Autopilot", "standard": "GKE Standard"}[c.Cluster.Mode]
		where = fmt.Sprintf("gcp / %s / %s, cluster %s (%s)", c.GCP.Project, c.GCP.Region, c.Cluster.Name, mode)
	case "aws":
		mode := map[string]string{"auto": "EKS Auto Mode", "standard": "EKS with node groups"}[c.Cluster.Mode]
		where = fmt.Sprintf("aws / %s, cluster %s (%s)", c.AWS.Region, c.Cluster.Name, mode)
	}
	p.Title = fmt.Sprintf("Vennir %s → %s [%s]", what, where, env)

	floor := plan.FloorOf(c)
	scale := fmt.Sprintf("yes: sleeps after %s with nothing running and nobody using the console", c.ScaleDown.IdleAfter)
	if c.ScaleDown.Schedule != "" {
		scale += fmt.Sprintf(", and at %q once nothing runs", c.ScaleDown.Schedule)
	}
	scale += "; `vennir wake` brings it back"
	if !c.ScaleDown.Enabled {
		scale = fmt.Sprintf("no: always on, at least %d copies of the console and API", install.AlwaysOn(c))
		if c.StepHeadroom > 0 {
			slots := "steps"
			if c.StepHeadroom == 1 {
				slots = "step"
			}
			scale += fmt.Sprintf("; room kept for %d %s to start at once (reserved around the clock)", c.StepHeadroom, slots)
		}
	}
	admin := c.Admin.Email + " (password generated at the first install, saved to admin-password here)"
	if installed[install.ConsoleRelease] != "" {
		admin = c.Admin.Email + " (set up at the first install)"
	}
	volume := floor.Volume
	if install.KeepsVolume(c, now.volume) {
		volume = now.volume
	} else if now.volume != "" && now.volume != floor.Volume {
		volume = fmt.Sprintf("%s (grown from %s)", floor.Volume, now.volume)
	}
	taskImages := "from " + c.TaskImages.Registry
	database := fmt.Sprintf("in-cluster Postgres (both databases on one instance), %s volume; no backups yet", volume)
	if c.Target == "gcp" {
		taskImages = "from " + gcp.TaskRegistry(c)
		if c.TaskImages.Create {
			taskImages += " (created)"
		}
		database = fmt.Sprintf("in-cluster Postgres (both databases on one instance), %s volume", volume)
		if c.Database.Backups.Enabled {
			database += fmt.Sprintf("; backed up daily to a bucket, kept %d days", c.Database.Backups.RetentionDays)
		}
	}
	if c.Target == "aws" {
		taskImages = fmt.Sprintf("from ECR under %s/ (each product's repository made on its first push)", c.TaskImages.Name)
		database = fmt.Sprintf("in-cluster Postgres (both databases on one instance), %s volume", volume)
		if c.Database.Backups.Enabled {
			database += fmt.Sprintf("; backed up daily to an S3 bucket, kept %d days", c.Database.Backups.RetentionDays)
		}
	}
	if c.Database.Type == "managed" {
		database = "Cloud SQL for PostgreSQL 16 (" + install.ManagedDatabaseTier(c.Target, c.Size) + "), private IP only, each service signing in as its own identity (no passwords)"
		if c.Target == "aws" {
			database = "Amazon RDS for PostgreSQL 16 (" + install.ManagedDatabaseTier(c.Target, c.Size) + "), in the install's VPC with no public access, each service signing in as its own role (no passwords of Vennir's; RDS keeps its administrator's in Secrets Manager)"
		}
		if c.Database.HighAvailability {
			database += "; a standby in a second zone"
		}
		database += fmt.Sprintf("; backed up daily with point-in-time recovery, kept %d days", c.Database.Backups.RetentionDays)
	}
	p.Settings = []plan.Line{
		{Label: "Tools", Text: tools.Summary(tools.CheckAll(ctx, tools.For(c.Target, c.Vennir == "source")))},
		{Label: "Size", Text: fmt.Sprintf("%s: %s; platform %s, %s awake", c.Size, floor.Copies, floor.CPU, floor.Memory)},
		{Label: "Steps", Text: floor.Steps},
		{Label: "Scale down", Text: scale},
		{Label: "Task images", Text: taskImages},
		{Label: "Signing", Text: signingLine(c)},
		{Label: "Database", Text: database},
		{Label: "Logs", Text: logsLine(c)},
		{Label: "Audit", Text: auditLine(c)},
		{Label: "Monitoring", Text: monitoringLine(c)},
		{Label: "Admin", Text: admin},
	}
	if cloud != nil {
		p.Access = cloud.access
		p.Changes = append(p.Changes, cloud.changeLines(cloud.where)...)
	}

	var create []string
	if c.Target == "kind" {
		switch {
		case !s.RegistryExists:
			create = append(create, fmt.Sprintf("local registry %s on localhost:%d", c.Kind.RegistryName, c.Kind.RegistryPort))
		case !s.RegistryRunning:
			create = append(create, "start the local registry "+c.Kind.RegistryName)
		}
		switch {
		case !s.ClusterExists:
			create = append(create, "kind cluster "+c.Cluster.Name)
		case !s.ClusterRunning:
			create = append(create, "start the kind cluster "+c.Cluster.Name)
		}
	}
	if !s.NamespaceExists {
		ns := "namespace " + c.Namespace
		if cloud != nil {
			ns = "in the cluster: namespace " + c.Namespace
		}
		create = append(create, ns)
	}
	if len(create) > 0 {
		p.Changes = append(p.Changes, plan.Line{Label: "Will create", Text: strings.Join(create, "; ")})
	}
	if img.Build {
		dest := "loaded onto the kind node"
		if img.Push {
			dest = "pushed to " + c.PlatformImages.Registry
			if c.Target == "existing" && s.NodeArch != "" {
				dest = "for " + s.NodeArch + " (its nodes'), pushed to " + c.PlatformImages.Registry
			}
			if c.Target == "gcp" {
				dest = "pushed to " + gcp.PlatformRegistry(c)
			}
			if c.Target == "aws" {
				dest = "for amd64, pushed to " + c.PlatformImages.Registry
			}
		}
		p.Changes = append(p.Changes, plan.Line{Label: "Will build", Text: fmt.Sprintf("%s from source, tagged %s, %s", img.Names(), img.Tag, dest)})
	}
	var installs, upgrades, same []string
	for _, r := range []struct{ release, chart string }{
		{install.KernelRelease, "execution-kernel"}, {install.ConsoleRelease, "execution-console"},
	} {
		target := r.chart + " " + c.Vennir
		if c.Vennir == "source" {
			target = r.chart + " from source"
		}
		switch prev := installed[r.release]; {
		case prev == "":
			installs = append(installs, target)
		case c.Vennir != "source" && releases.ChartVersion(prev) == c.Vennir:
			same = append(same, r.release)
		default:
			upgrades = append(upgrades, fmt.Sprintf("%s (now %s) to %s", r.release, prev, target))
		}
	}
	if len(installs) > 0 {
		p.Changes = append(p.Changes, plan.Line{Label: "Will install", Text: strings.Join(installs, " and ") + " into " + c.Namespace})
	}
	if len(upgrades) > 0 {
		p.Changes = append(p.Changes, plan.Line{Label: "Will upgrade", Text: strings.Join(upgrades, "; ")})
	}
	if len(same) > 0 {
		with := "vennir.yaml's settings"
		if c.Values != "" {
			with += " and " + c.Values + " as it is now"
		}
		p.Changes = append(p.Changes, plan.Line{Label: "Will apply", Text: fmt.Sprintf("%s again, staying at %s, with %s", strings.Join(same, " and "), c.Vennir, with)})
	}
	if len(installs) == 0 && now.applied != nil {
		changed, err := config.Changed(now.applied, c)
		switch {
		case err != nil:
		case len(changed) > 0:
			p.Changes = append(p.Changes, plan.Line{Label: "Changed", Text: "since the last apply: " + strings.Join(changed, ", ")})
		default:
			p.Notes = append(p.Notes, "Nothing in vennir.yaml changed since the last apply.")
		}
	}
	if now.move {
		server := map[string]string{"gcp": "Cloud SQL", "aws": "Amazon RDS"}[c.Target]
		p.Changes = append(p.Changes, plan.Line{Label: "Will move", Text: fmt.Sprintf(
			"both databases from the in-cluster Postgres into %s, copied in the cluster. The platform stops while they're copied (minutes for most installs) and starts on %s; if the copy fails, it starts again as it was", server, server)})
		p.Notes = append(p.Notes, "The in-cluster Postgres's volume is kept after the move: the way back, until you delete it. `vennir backup --to <folder>` first keeps a copy here too.")
	}

	switch c.Target {
	case "kind":
		p.Cost = []plan.Line{{Label: "Estimated cost", Text: "$0: it runs on this machine (give Docker about 4 GB of memory)"}}
	case "gcp", "aws":
		p.Cost = cloud.cost
	case "existing":
		p.Cost = []plan.Line{{Label: "Estimated cost", Text: fmt.Sprintf(
			"part of your cluster's own bill: Vennir requests %s and %s awake, plus up to its step cap while steps run", floor.CPU, floor.Memory)}}
	}

	if c.ChecksSignatures() {
		if line, ok := addOn("policy-controller", install.PolicyControllerChart, now.policyController, "cosign-system: in team namespaces, only images catalog CI signed run"); ok {
			p.Changes = append(p.Changes, line)
		}
	}
	if c.ExternalSecrets {
		if line, ok := addOn("External Secrets Operator", install.ExternalSecretsChart, now.externalSecrets, "external-secrets, for teams' SecretStores"); ok {
			p.Changes = append(p.Changes, line)
		}
	}
	if c.Target == "kind" && c.Size == "auto" {
		p.Changes = append(p.Changes, plan.Line{Label: "Will install", Text: "metrics-server " + install.MetricsServerChart + " into kube-system, for the auto size's autoscalers"})
	}
	if certManagerNeeded(c) && c.Console.TLS.InstallCertManager && !s.CertManager {
		p.Changes = append(p.Changes, plan.Line{Label: "Will install", Text: "cert-manager " + install.CertManagerChart + " into cert-manager, for the console's certificate"})
	}
	if certManagerNeeded(c) {
		cert := "Let's Encrypt (" + c.Console.TLS.LetsEncryptEmail + "), proving the hostname through the Ingress"
		if c.Console.TLS.Issuer != "" {
			cert = "cert-manager issuer " + c.Console.TLS.Issuer
		}
		p.Settings = append(p.Settings, plan.Line{Label: "Public", Text: fmt.Sprintf("https://%s through Ingress class %s; certificate from %s", c.Console.Hostname, c.Console.IngressClass, cert)})
	}

	if c.Monitoring.Enabled && c.Monitoring.ProviderName() == "amazon" && c.Monitoring.AlertEmail != "" {
		p.Notes = append(p.Notes, fmt.Sprintf("AWS emails %s a link to confirm the alerts' subscription; until it's followed, alerts reach no one.", c.Monitoring.AlertEmail))
	}
	if install.KeepsVolume(c, now.volume) && now.volume != floor.Volume {
		why := "volumes can't shrink"
		if c.Target == "kind" {
			why = "kind's volumes can't grow"
		}
		p.Notes = append(p.Notes, fmt.Sprintf("The database volume stays at %s (the %s size's is %s): %s.", now.volume, c.Size, floor.Volume, why))
	}
	if now.asleep {
		p.Notes = append(p.Notes, "It's asleep: applying wakes it.")
	}
	if c.ScaleDown.Enabled {
		p.Notes = append(p.Notes, "While asleep, the console and API don't answer: catalog CI and automation fail until `vennir wake`.")
	}
	return p
}

// addOn is the screen's line for a chart installed beside the platform:
// none when the version it pins is already there.
func addOn(name, version, installed, where string) (plan.Line, bool) {
	switch {
	case installed == "":
		return plan.Line{Label: "Will install", Text: name + " " + version + " into " + where}, true
	case releases.ChartVersion(installed) == version:
		return plan.Line{}, false
	case releases.Compare(releases.ChartVersion(installed), version) > 0:
		return plan.Line{Label: "Will downgrade", Text: fmt.Sprintf("%s (now %s, newer) to %s, the version vennir pins, in %s", name, installed, version, where)}, true
	}
	return plan.Line{Label: "Will upgrade", Text: fmt.Sprintf("%s (now %s) to %s, in %s", name, installed, version, where)}, true
}

// logsLine says what log search keeps, and where, for the approval screen.
func logsLine(c *config.Config) string {
	if !c.Logs.Enabled {
		return "not kept beyond each run's own (logs.enabled for Observe's search)"
	}
	switch c.Target {
	case "gcp", "aws":
		return fmt.Sprintf("searchable %d days, then archived in a bucket; deleted after %d days", c.Logs.SearchDays, c.Logs.KeepDays)
	}
	return fmt.Sprintf("searchable on a volume, deleted after %d days (no archive without a bucket)", c.Logs.KeepDays)
}

// monitoringLine says which Prometheus scrapes the platform and holds its
// alerts, for the approval screen.
func monitoringLine(c *config.Config) string {
	if !c.Monitoring.Enabled {
		return "none (Observe's Metrics tab needs none; monitoring.provider for Prometheus alerts)"
	}
	switch c.Monitoring.ProviderName() {
	case "google":
		return fmt.Sprintf("GKE's Managed Service for Prometheus (billed per sample, a few dollars a month), its collector in %s", install.GoogleCollectorNamespace(c))
	case "bundled":
		return "a Prometheus of its own: 15 days on a 2 GiB volume, its alerts on its own page (kubectl port-forward)"
	case "amazon":
		to := "an SNS topic to subscribe to"
		if c.Monitoring.AlertEmail != "" {
			to = "an SNS topic, emailed to " + c.Monitoring.AlertEmail + " once confirmed"
		}
		return "Amazon Managed Service for Prometheus (a few dollars a month): a Prometheus of its own writes to its workspace, its alerts to " + to
	}
	return fmt.Sprintf("the Prometheus Operator in %s: PodMonitors, alerts and a Grafana dashboard", c.Monitoring.Namespace)
}

// auditLine says where the audit log's copy goes, for the approval screen.
func auditLine(c *config.Config) string {
	if !c.Audit.Export {
		return "in the console's database, hash-chained (audit.export for a write-once copy)"
	}
	lock := "unlocked: an admin of the cloud account can still shorten it"
	if c.Audit.Lock {
		lock = "LOCKED: it can never be shortened, nor the bucket deleted, until it lapses"
	}
	return fmt.Sprintf("copied every 5 minutes to a bucket that refuses deletes for %d days (%s); kept by destroy", c.Audit.KeepDays, lock)
}

// certManagerNeeded: an existing cluster's public console gets its
// certificate from cert-manager.
func certManagerNeeded(c *config.Config) bool {
	return c.Target == "existing" && c.Console.Public
}

// signingLine says how the catalog is signed, and so what this install
// refuses.
func signingLine(c *config.Config) string {
	if sig := c.CatalogSignature; c.ExternalCatalog.Registry != "" && (sig.PublicKeyFile != "" || sig.Repository != "") {
		signer := sig.PublicKeyFile
		if sig.Repository != "" {
			signer = "keyless, " + sig.Repository + "'s CI (main)"
			if sig.PublicKeyFile != "" {
				signer = sig.PublicKeyFile + ", or " + signer
			}
		}
		if c.VerifiesCatalog() {
			return "the catalog's signer (" + signer + "); unsigned images and releases are refused"
		}
		return "the catalog's signer (" + signer + "); unsigned releases are refused"
	}
	switch c.Signing {
	case "kms":
		return "a KMS key only " + c.Catalog.Repo() + "'s CI (main) signs with; unsigned images and releases are refused"
	case "keyless":
		return "keyless, by " + c.Catalog.Repo() + "'s CI (main) through Sigstore's public log; unsigned images and releases are refused"
	}
	return "off: images and releases aren't signed (`vennir config set signing kms` or keyless)"
}
