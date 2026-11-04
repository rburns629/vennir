// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/rburns629/vennir/cli/internal/access"
	"github.com/rburns629/vennir/cli/internal/cluster"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/gcp"
	"github.com/rburns629/vennir/cli/internal/install"
	"github.com/rburns629/vennir/cli/internal/modules"
	"github.com/rburns629/vennir/cli/internal/plan"
	"github.com/rburns629/vennir/cli/internal/pricing"
	"github.com/rburns629/vennir/cli/internal/tofu"
)

// cloudPlan is a cloud target's side of the approval screen: what OpenTofu
// will change, and what it costs.
type cloudPlan struct {
	account string
	// access is the approval screen's Access block (who, where, what it allows).
	access []plan.Line
	// where the cloud changes happen, e.g. "project acyclix-dev".
	where   string
	tf      tofu.Dir
	changes []tofu.Change
	cost    []plan.Line
}

// planGCP checks the project, gets the cluster's credentials if it exists
// (so what's installed can be read), and plans the module.
func (a *app) planGCP(ctx context.Context, out io.Writer, dir string, c *config.Config, destroy bool) (*cloudPlan, error) {
	fmt.Fprintf(out, "Checking project %s...\n", c.GCP.Project)
	state := gcp.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return nil, fmt.Errorf("the project isn't ready:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	for _, w := range state.Warnings {
		fmt.Fprintln(out, "Warning:", w)
	}
	check := access.CheckGCP(ctx, a.runner.Exec, access.GoogleTokenEmail, c.GCP.Project, c.GCP.Region)
	if err := sameIdentity(c.Access.Cloud, check.Identity); err != nil {
		return nil, err
	}
	if err := problemsError(check.Report); err != nil {
		return nil, err
	}
	// Prices are fetched while OpenTofu plans.
	cost := later(!destroy, func() []plan.Line { return a.gcpCost(ctx, c) })
	if state.ClusterStatus == "RUNNING" {
		if err := gcp.Credentials(ctx, a.runner, c); err != nil {
			return nil, err
		}
	}
	p := &cloudPlan{account: state.Account, access: check.Lines, where: "project " + c.GCP.Project, tf: tofu.In(a.runner, dir)}
	if err := modules.Write("gcp", p.tf.Path); err != nil {
		return nil, err
	}
	if err := p.tf.WriteVars(keepBackupBucket(ctx, p.tf, c, gcp.Vars(c, false), "google_storage_bucket.backups[0]")); err != nil {
		return nil, err
	}
	fmt.Fprintln(out, "Planning the cloud side (OpenTofu)...")
	if err := p.tf.Init(ctx); err != nil {
		return nil, err
	}
	changes, err := p.tf.Plan(ctx, destroy)
	if err != nil {
		return nil, err
	}
	p.changes, p.cost = changes, cost()
	return p, nil
}

// keepBackupBucket keeps the in-cluster database's backups bucket an
// install has once its database is managed (its data moved there): the
// backups taken before stay, aging out by the bucket's lifecycle rule,
// rather than going with the bucket (which, holding them, would fail).
func keepBackupBucket(ctx context.Context, tf tofu.Dir, c *config.Config, vars map[string]any, bucket string) map[string]any {
	if c.Database.Type == "managed" && c.Database.Backups.Enabled && tf.Has(ctx, bucket) {
		vars["backups"] = true
	}
	return vars
}

// later runs f in the background when it should, and returns a wait for
// its answer (nil when it shouldn't).
func later(should bool, f func() []plan.Line) func() []plan.Line {
	if !should {
		return func() []plan.Line { return nil }
	}
	done := make(chan []plan.Line, 1)
	go func() { done <- f() }()
	return func() []plan.Line { return <-done }
}

// gcpCost prices the install from Google's catalog; when that fails the
// screen says so and shows no figure.
func (a *app) gcpCost(ctx context.Context, c *config.Config) []plan.Line {
	unavailable := func(err error) []plan.Line {
		return []plan.Line{{Label: "Estimated cost", Text: "unavailable (" + err.Error() + "): the resources above are what it would be for"}}
	}
	token, err := gcp.AccessToken(ctx, a.runner)
	if err != nil {
		return unavailable(err)
	}
	prices, err := pricing.FetchGCP(ctx, token, c.GCP.Region, c.Database.Type == "managed")
	if err != nil {
		return unavailable(err)
	}
	// Your billing account's prices, its discounts applied, when you may
	// read them; list prices otherwise, and the screen says which.
	var note []plan.Line
	if account := gcp.BillingAccount(ctx, a.runner, c); account != "" {
		if mine, err := pricing.ForAccount(ctx, token, account, prices); err == nil {
			prices = mine
		} else {
			note = []plan.Line{{Label: "  Prices", Text: "list prices: " + err.Error()}}
		}
	}
	fetched := "fetched now"
	if time.Since(prices.Fetched) > time.Minute {
		fetched = "fetched " + prices.Fetched.Local().Format("Jan 2 15:04")
	}
	return append(pricing.GCP(prices, c, fetched), note...)
}

// changeLines are the approval screen's lines for what OpenTofu changes,
// in where (e.g. "project acyclix-dev").
func (p *cloudPlan) changeLines(where string) []plan.Line {
	summary := tofu.Summary(p.changes)
	var lines []plan.Line
	for _, a := range []struct{ action, label string }{
		{"create", "Will create"}, {"update", "Will change"}, {"replace", "Will replace"}, {"delete", "Will delete"},
	} {
		if s := summary[a.action]; s != "" {
			lines = append(lines, plan.Line{Label: a.label, Text: "in " + where + ": " + s})
		}
	}
	return lines
}

// sameIdentity stops a run signed in as someone other than who set the
// environment up (another account, profile or project's owner).
func sameIdentity(recorded, now string) error {
	if recorded == "" || now == "" || recorded == now {
		return nil
	}
	return fmt.Errorf("this environment was set up as %s, but you're signed in as %s: sign in as the first again, or, if the change is meant, `vennir config set access.cloud %s`",
		strings.SplitN(recorded, ":", 2)[1], strings.SplitN(now, ":", 2)[1], now)
}

// optionalOutputs are the modules' outputs that are null when not used
// (no backups, no catalog, no public console), which `tofu output` omits.
var optionalOutputs = map[string]bool{"database": true, "scanner_service_account": true, "backup": true, "logs": true, "audit": true, "catalog": true, "console_address": true, "signing": true, "capacity_placements": true, "prometheus": true}

// cloudFromGCP reads the module's outputs.
func cloudFromGCP(outputs map[string]json.RawMessage) (*install.Cloud, error) {
	var v struct {
		Cluster struct {
			Name, Location, Issuer string
		}
		WorkloadPool   string
		TaskRegistry   string
		ConsoleAccount string
		ScannerAccount string
		Backup         *struct {
			Bucket         string `json:"bucket"`
			ServiceAccount string `json:"service_account"`
		}
		Logs *struct {
			Bucket         string `json:"bucket"`
			ServiceAccount string `json:"service_account"`
		}
		Audit *struct {
			Bucket string `json:"bucket"`
		}
		StepPlacement  map[string]any
		Capacities     map[string]any
		ConsoleAddress *struct {
			Name string `json:"name"`
			IP   string `json:"ip"`
		}
		Catalog *struct {
			Provider       string `json:"workload_identity_provider"`
			ServiceAccount string `json:"service_account"`
		}
		Signing *struct {
			Key      string `json:"key"`
			Verifier string `json:"verifier"`
		}
		Database *struct {
			Instance  string            `json:"instance"`
			Host      string            `json:"host"`
			CACert    string            `json:"ca_cert"`
			Users     map[string]string `json:"users"`
			KernelSA  string            `json:"kernel_sa"`
			GatewaySA string            `json:"gateway_sa"`
			AdminSA   string            `json:"admin_sa"`
		}
	}
	for name, into := range map[string]any{
		"cluster": &v.Cluster, "workload_identity_pool": &v.WorkloadPool, "task_registry": &v.TaskRegistry,
		"console_service_account": &v.ConsoleAccount, "scanner_service_account": &v.ScannerAccount, "backup": &v.Backup, "logs": &v.Logs, "audit": &v.Audit, "step_placement": &v.StepPlacement, "capacity_placements": &v.Capacities,
		"console_address": &v.ConsoleAddress, "catalog": &v.Catalog, "signing": &v.Signing, "database": &v.Database,
	} {
		raw, ok := outputs[name]
		if !ok {
			// `tofu output` leaves out outputs that are null.
			if optionalOutputs[name] {
				continue
			}
			return nil, fmt.Errorf("the gcp module has no %q output", name)
		}
		if err := json.Unmarshal(raw, into); err != nil {
			return nil, fmt.Errorf("the gcp module's %q output: %w", name, err)
		}
	}
	cloud := &install.Cloud{
		Provider:              "gcp",
		TaskRegistry:          v.TaskRegistry,
		ConsoleServiceAccount: v.ConsoleAccount,
		ScannerServiceAccount: v.ScannerAccount,
		StepPlacement:         v.StepPlacement,
		CapacityPlacements:    v.Capacities,
		ClusterName:           v.Cluster.Name,
		ClusterLocation:       v.Cluster.Location,
		ClusterIssuer:         v.Cluster.Issuer,
		WorkloadPool:          v.WorkloadPool,
	}
	if v.Backup != nil {
		cloud.BackupBucket, cloud.BackupServiceAccount = v.Backup.Bucket, v.Backup.ServiceAccount
	}
	if v.Logs != nil {
		cloud.LogsBucket, cloud.LogsServiceAccount = v.Logs.Bucket, v.Logs.ServiceAccount
	}
	if v.Audit != nil {
		cloud.AuditBucket = v.Audit.Bucket
	}
	if v.ConsoleAddress != nil {
		cloud.ConsoleAddressName, cloud.ConsoleIP = v.ConsoleAddress.Name, v.ConsoleAddress.IP
	}
	if v.Catalog != nil {
		cloud.CatalogProvider, cloud.CatalogServiceAccount = v.Catalog.Provider, v.Catalog.ServiceAccount
	}
	if v.Signing != nil {
		cloud.SigningKey, cloud.SigningVerifier = v.Signing.Key, v.Signing.Verifier
	}
	if d := v.Database; d != nil {
		cloud.Database = &install.ManagedDatabase{
			Provider: "gcp", Instance: d.Instance, Host: d.Host, CACert: d.CACert,
			KernelUser: d.Users["kernel"], ConsoleUser: d.Users["console"], GatewayUser: d.Users["gateway"], AdminUser: d.Users["admin"],
			KernelServiceAccount: d.KernelSA, GatewayServiceAccount: d.GatewaySA, AdminServiceAccount: d.AdminSA,
		}
	}
	return cloud, nil
}

// applyGCP carries out the approved cloud plan, then readies the cluster for
// the charts: credentials, the namespace, the backups' ServiceAccount, and
// a Docker sign-in to push images built from source.
func (a *app) applyGCP(ctx context.Context, out io.Writer, c *config.Config, p *cloudPlan, img install.Images) (*install.Cloud, error) {
	fmt.Fprintln(out, "Creating the cloud side (OpenTofu; a new cluster takes about ten minutes)...")
	if err := p.tf.Apply(ctx); err != nil {
		return nil, err
	}
	outputs, err := p.tf.Outputs(ctx)
	if err != nil {
		return nil, err
	}
	cloud, err := cloudFromGCP(outputs)
	if err != nil {
		return nil, err
	}
	if cloud.ConsoleIP != "" {
		cloud.ConsoleHost = install.ConsoleHostname(c, cloud.ConsoleIP)
	}
	if cloud.SigningKey != "" {
		if cloud.SigningPublicKey, err = gcp.SigningPublicKey(ctx, a.runner, cloud.SigningKey); err != nil {
			return nil, err
		}
	}
	if err := gcp.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	// A new cluster takes your IAM role to its RBAC a little after it's up:
	// until then the charts' RBAC is refused, as granting what you lack.
	if err := waitFor(ctx, 5*time.Minute, 10*time.Second, func() (bool, error) {
		out, _ := a.runner.Output(ctx, "kubectl", "--context", cluster.Context(c), "auth", "can-i", "create", "jobs.batch", "--all-namespaces")
		return out == "yes", nil
	}); err != nil {
		return nil, fmt.Errorf("the cluster doesn't yet let you manage it (kubectl auth can-i create jobs.batch --all-namespaces): %w", err)
	}
	if img.Push {
		if err := gcp.DockerLogin(ctx, a.runner, strings.SplitN(gcp.PlatformRegistry(c), "/", 2)[0]); err != nil {
			return nil, err
		}
	}
	return cloud, nil
}

// destroyGCP removes a gcp install, keeping what the user chose to keep.
func (a *app) destroyGCP(ctx context.Context, out io.Writer, dir string, c *config.Config, deleteData, deleteRegistry bool) error {
	state := gcp.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return fmt.Errorf("the project isn't reachable:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	kctx := cluster.Context(c)
	unreached := false
	if state.ClusterStatus == "RUNNING" {
		if err := gcp.Credentials(ctx, a.runner, c); err != nil {
			return err
		}
		unreached = !a.clusterAnswers(ctx, out, kctx)
	}
	if state.ClusterStatus == "RUNNING" && !unreached {
		for _, r := range []string{install.ConsoleRelease, install.KernelRelease} {
			if err := install.Uninstall(ctx, a.runner, c, r); err != nil {
				return err
			}
		}
		// GKE made the console's load balancer (and its certificate) outside
		// OpenTofu: let its controller remove them while it's still there,
		// or they hold the address and the network.
		if c.Console.Public {
			_ = a.runner.Run(ctx, "kubectl", "--context", kctx, "--namespace", c.Namespace,
				"delete", "managedcertificate", "--all", "--ignore-not-found", "--wait=true")
			fmt.Fprintln(out, "Waiting for the console's load balancer to go...")
			if err := waitFor(ctx, 10*time.Minute, 10*time.Second, func() (bool, error) {
				rules, err := a.runner.Output(ctx, "gcloud", "compute", "forwarding-rules", "list", "--global",
					"--project", c.GCP.Project, "--filter=name~^k8s2-.*"+c.Namespace, "--format=value(name)")
				return err == nil && strings.TrimSpace(rules) == "", nil
			}); err != nil {
				return fmt.Errorf("the console's load balancer is still there: %w", err)
			}
		}
		// A cluster's deletion leaves its volumes' disks behind: delete the
		// claims while it's there, so the disks go with them.
		if deleteData {
			fmt.Fprintln(out, "Deleting the database volume...")
			if err := a.runner.Run(ctx, "kubectl", "--context", kctx, "--namespace", c.Namespace,
				"delete", "pvc", "--all", "--wait=true", "--timeout=5m"); err != nil {
				return err
			}
			if err := waitNoVolumes(ctx, a, kctx, c.Namespace); err != nil {
				return err
			}
		} else if disks, _ := a.runner.Output(ctx, "kubectl", "--context", kctx, "get", "pv",
			"-o", "jsonpath={range .items[*]}{.spec.csi.volumeHandle}{\"\\n\"}{end}"); disks != "" {
			fmt.Fprintln(out, "Keeping the database's disk:", strings.ReplaceAll(disks, "\n", ", "))
			fmt.Fprintln(out, "Its passwords were in the cluster, which goes with it: a new install can open it only after resetting them in Postgres by hand.")
		}
	}

	tf := tofu.In(a.runner, dir)
	if err := modules.Write("gcp", tf.Path); err != nil {
		return err
	}
	if err := tf.WriteVars(keepBackupBucket(ctx, tf, c, gcp.Vars(c, deleteData), "google_storage_bucket.backups[0]")); err != nil {
		return err
	}
	if err := tf.Init(ctx); err != nil {
		return err
	}
	var keep []string
	const bucket = "google_storage_bucket.backups[0]"
	if c.Database.Backups.Enabled && !deleteData {
		keep = append(keep, bucket)
	}
	const logsBucket = "google_storage_bucket.logs[0]"
	if c.Logs.Enabled && !deleteData {
		keep = append(keep, logsBucket)
	}
	if c.TaskImages.Create && !deleteRegistry {
		keep = append(keep, "google_artifact_registry_repository.tasks[0]")
	}
	// The audit log's copy is the record, and its retention refuses deletes.
	if c.Audit.Export {
		keep = append(keep, "google_storage_bucket.audit[0]")
	}
	const instance = "google_sql_database_instance.this[0]"
	managed := c.Database.Type == "managed" && tf.Has(ctx, instance)
	if managed && !deleteData {
		// A managed database keeps its data, and the network it's peered
		// into, which can't go while the peering does.
		keep = append(keep, instance, `google_sql_database.this["execution_kernel"]`, `google_sql_database.this["execution_console"]`,
			"google_service_networking_connection.database[0]", "google_compute_global_address.database[0]", "google_compute_network.this")
		for _, u := range []string{"kernel", "console", "gateway", "admin"} {
			keep = append(keep, fmt.Sprintf(`google_sql_user.this[%q]`, u))
		}
		fmt.Fprintf(out, "Keeping the database (Cloud SQL, in project %s) and its network: `gcloud sql instances list`, or `vennir destroy --all` to delete them too.\n", c.GCP.Project)
	}
	if tf.HasState(ctx) {
		var emptied []string
		if c.Database.Backups.Enabled && deleteData {
			emptied = append(emptied, bucket)
		}
		if c.Logs.Enabled && deleteData {
			emptied = append(emptied, logsBucket)
		}
		if managed && deleteData {
			// Its deletion protection is lifted, and its databases and users
			// left to go with it, only once the state says so.
			emptied = append(emptied, instance, "google_sql_database.this", "google_sql_user.this")
		}
		if len(emptied) > 0 {
			// A bucket with data in it is deleted only once the state says
			// it may be (delete_data: force_destroy).
			if err := tf.ApplyOnly(ctx, emptied...); err != nil {
				return err
			}
		}
		if err := tf.Forget(ctx, keep...); err != nil {
			return err
		}
		fmt.Fprintln(out, "Deleting the cloud side (OpenTofu; a cluster takes several minutes)...")
		if _, err := tf.Plan(ctx, true); err != nil {
			return err
		}
		if err := tf.Apply(ctx); err != nil {
			return err
		}
	}
	if unreached {
		disks, err := gcp.LeftDisks(ctx, a.runner, c, c.Namespace)
		leftBehind(out, "disk", disks, err, fmt.Sprintf("gcloud compute disks delete <name> --zone <zone> --project %s", c.GCP.Project))
	}
	for _, kind := range []string{"context", "cluster", "user"} {
		_ = a.runner.Succeeds(ctx, "kubectl", "config", "delete-"+kind, kctx)
	}
	return nil
}

// clusterAnswers says whether the cluster's API answers, trying a few
// times: destroy skips what's inside one that doesn't (it all goes with the
// cluster) rather than stop, and reports the disks its volumes may leave.
func (a *app) clusterAnswers(ctx context.Context, out io.Writer, kctx string) bool {
	for i := 0; i < 3; i++ {
		if a.runner.Succeeds(ctx, "kubectl", "--context", kctx, "--request-timeout=20s", "get", "--raw", "/readyz") {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(10 * time.Second):
		}
	}
	fmt.Fprintln(out, "The cluster's API doesn't answer: deleting it without removing what's inside first (it all goes with the cluster).")
	return false
}

// leftBehind says which of the volumes' disks a cluster deleted unreached
// may have left, and how to delete them once checked.
func leftBehind(out io.Writer, what string, found []string, err error, deleteWith string) {
	switch {
	case err != nil:
		fmt.Fprintf(out, "Couldn't list the %ss its volumes may have left (%v): check for unattached ones.\n", what, err)
	case len(found) > 0:
		fmt.Fprintf(out, "Unattached %ss its volumes may have left (another cluster's may match too): %s\n", what, strings.Join(found, ", "))
		fmt.Fprintf(out, "Delete each that's this install's: %s\n", deleteWith)
	}
}

// waitNoVolumes waits until the namespace's volumes (and their disks) are gone.
func waitNoVolumes(ctx context.Context, a *app, kctx, namespace string) error {
	for i := 0; i < 60; i++ {
		out, err := a.runner.Output(ctx, "kubectl", "--context", kctx, "get", "pv",
			"-o", "jsonpath={range .items[*]}{.spec.claimRef.namespace}{\"\\n\"}{end}")
		if err != nil {
			return err
		}
		if !strings.Contains(out+"\n", namespace+"\n") {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("the database volume is still being deleted after 5 minutes; check `kubectl --context %s get pv`", kctx)
}
