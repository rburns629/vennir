// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/rburns629/vertra/cli/internal/access"
	"github.com/rburns629/vertra/cli/internal/awscloud"
	"github.com/rburns629/vertra/cli/internal/backup"
	"github.com/rburns629/vertra/cli/internal/cluster"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/install"
	"github.com/rburns629/vertra/cli/internal/modules"
	"github.com/rburns629/vertra/cli/internal/plan"
	"github.com/rburns629/vertra/cli/internal/pricing"
	"github.com/rburns629/vertra/cli/internal/tofu"
)

// planAWS checks the sign-in, gets the cluster's credentials if it exists,
// and plans the module.
func (a *app) planAWS(ctx context.Context, out io.Writer, dir string, c *config.Config, destroy bool) (*cloudPlan, error) {
	fmt.Fprintf(out, "Checking your AWS sign-in (%s)...\n", orDefault(c.AWS.Profile, "default profile"))
	state := awscloud.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return nil, fmt.Errorf("AWS isn't ready:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	for _, w := range state.Warnings {
		fmt.Fprintln(out, "Warning:", w)
	}
	check := access.CheckAWS(ctx, a.runner.Exec, c.AWS.Profile, c.AWS.Region)
	if err := sameIdentity(c.Access.Cloud, check.Identity); err != nil {
		return nil, err
	}
	if err := problemsError(check.Report); err != nil {
		return nil, err
	}
	if c.Vertra == "source" {
		// Where images built from source go: known once the account is.
		c.PlatformImages.Registry = awscloud.Registry(state.Identity.Account, c) + "/" + awscloud.PlatformPrefix(c)
	}
	// Prices are fetched while OpenTofu plans.
	cost := later(!destroy, func() []plan.Line { return a.awsCost(ctx, c) })
	if state.ClusterStatus == "ACTIVE" {
		if err := awscloud.Credentials(ctx, a.runner, c); err != nil {
			return nil, err
		}
	}
	p := &cloudPlan{account: state.Identity.Arn, access: check.Lines, where: "account " + state.Identity.Account, tf: tofu.In(a.runner, dir)}
	if err := modules.Write("aws", p.tf.Path); err != nil {
		return nil, err
	}

	fmt.Fprintln(out, "Planning the cloud side (OpenTofu)...")
	if err := p.tf.Init(ctx); err != nil {
		return nil, err
	}
	if err := a.writeAWSVars(ctx, c, p.tf, false); err != nil {
		return nil, err
	}
	changes, err := p.tf.Plan(ctx, destroy)
	if err != nil {
		return nil, err
	}
	p.changes, p.cost = changes, cost()
	return p, nil
}

// cloudFromAWS reads the module's outputs.
func cloudFromAWS(outputs map[string]json.RawMessage) (*install.Cloud, bool, error) {
	var v struct {
		Cluster struct {
			Name   string `json:"name"`
			Region string `json:"region"`
			Issuer string `json:"issuer"`
		}
		TaskRegistry string
		Backup       *struct {
			Bucket string `json:"bucket"`
			Region string `json:"region"`
		}
		Logs *struct {
			Bucket string `json:"bucket"`
			Region string `json:"region"`
		}
		Audit *struct {
			Bucket string `json:"bucket"`
			Region string `json:"region"`
		}
		Prometheus *struct {
			RemoteWrite  string `json:"remote_write"`
			Alertmanager string `json:"alertmanager"`
			AlertsTopic  string `json:"alerts_topic"`
			Region       string `json:"region"`
		}
		StepPlacement map[string]any
		Capacities    map[string]any
		Spot          bool
		Catalog       *struct {
			RoleArn string `json:"role_arn"`
		}
		Signing *struct {
			Key string `json:"key"`
		}
		Database *struct {
			Instance    string            `json:"instance"`
			Host        string            `json:"host"`
			Region      string            `json:"region"`
			Users       map[string]string `json:"users"`
			AdminUser   string            `json:"admin_user"`
			AdminSecret string            `json:"admin_secret"`
		}
		ConsoleAddress *struct {
			Host           string   `json:"host"`
			ZoneID         string   `json:"zone_id"`
			NameServers    []string `json:"name_servers"`
			CertificateArn string   `json:"certificate_arn"`
			VPCCIDR        string   `json:"vpc_cidr"`
		}
	}
	for name, into := range map[string]any{
		"cluster": &v.Cluster, "task_registry": &v.TaskRegistry, "backup": &v.Backup, "logs": &v.Logs, "audit": &v.Audit, "prometheus": &v.Prometheus,
		"step_placement": &v.StepPlacement, "capacity_placements": &v.Capacities, "spot": &v.Spot, "catalog": &v.Catalog,
		"console_address": &v.ConsoleAddress, "signing": &v.Signing, "database": &v.Database,
	} {
		raw, ok := outputs[name]
		if !ok {
			// `tofu output` leaves out outputs that are null.
			if optionalOutputs[name] {
				continue
			}
			return nil, false, fmt.Errorf("the aws module has no %q output", name)
		}
		if err := json.Unmarshal(raw, into); err != nil {
			return nil, false, fmt.Errorf("the aws module's %q output: %w", name, err)
		}
	}
	cloud := &install.Cloud{
		Provider:           "aws",
		TaskRegistry:       v.TaskRegistry,
		StepPlacement:      v.StepPlacement,
		CapacityPlacements: v.Capacities,
		ClusterName:        v.Cluster.Name,
		ClusterLocation:    v.Cluster.Region,
		ClusterIssuer:      v.Cluster.Issuer,
	}
	if v.Backup != nil {
		cloud.BackupBucket, cloud.BackupRegion = v.Backup.Bucket, v.Backup.Region
	}
	if v.Logs != nil {
		cloud.LogsBucket, cloud.LogsRegion = v.Logs.Bucket, v.Logs.Region
	}
	if v.Audit != nil {
		cloud.AuditBucket, cloud.AuditRegion = v.Audit.Bucket, v.Audit.Region
	}
	if p := v.Prometheus; p != nil {
		cloud.PrometheusRemoteWrite, cloud.PrometheusAlertmanager = p.RemoteWrite, p.Alertmanager
		cloud.PrometheusRegion, cloud.PrometheusAlertsTopic = p.Region, p.AlertsTopic
	}
	if v.Catalog != nil {
		cloud.CatalogServiceAccount = v.Catalog.RoleArn
	}
	if v.Signing != nil {
		cloud.SigningKey = v.Signing.Key
	}
	if a := v.ConsoleAddress; a != nil {
		cloud.ConsoleHost, cloud.ConsoleZoneID, cloud.ConsoleNameServers = a.Host, a.ZoneID, a.NameServers
		cloud.ConsoleCertificate, cloud.VPCCIDR = a.CertificateArn, a.VPCCIDR
	}
	if d := v.Database; d != nil {
		cloud.Database = &install.ManagedDatabase{
			Provider: "aws", Instance: d.Instance, Host: d.Host, Region: d.Region,
			KernelUser: d.Users["kernel"], ConsoleUser: d.Users["console"], GatewayUser: d.Users["gateway"],
			AdminUser: d.AdminUser, AdminSecret: d.AdminSecret,
		}
	}
	return cloud, v.Spot, nil
}

// applyAWS carries out the approved cloud plan, then readies the cluster for
// the charts: credentials, Auto Mode's StorageClass and steps' node pool,
// and a Docker sign-in to push images built from source.
func (a *app) applyAWS(ctx context.Context, out io.Writer, c *config.Config, p *cloudPlan, img install.Images) (*install.Cloud, error) {
	fmt.Fprintln(out, "Creating the cloud side (OpenTofu; a new EKS cluster takes about fifteen minutes)...")
	if err := p.tf.Apply(ctx); err != nil {
		return nil, err
	}
	outputs, err := p.tf.Outputs(ctx)
	if err != nil {
		return nil, err
	}
	cloud, spot, err := cloudFromAWS(outputs)
	if err != nil {
		return nil, err
	}
	if cloud.Database != nil {
		// What clients check RDS's certificate against: Amazon's bundle for
		// the region, public.
		if cloud.Database.CACert, err = awscloud.RDSCertificates(ctx, cloud.Database.Region); err != nil {
			return nil, err
		}
	}
	if err := awscloud.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	if cloud.SigningKey != "" {
		if cloud.SigningPublicKey, err = awscloud.SigningPublicKey(ctx, a.runner, c, cloud.SigningKey); err != nil {
			return nil, err
		}
	}
	if err := a.runner.RunInput(ctx, awscloud.InCluster(c.Cluster.Mode, spot), "kubectl", "--context", cluster.Context(c), "apply", "-f", "-"); err != nil {
		return nil, err
	}
	if c.Cluster.Mode == "standard" {
		fmt.Fprintln(out, "Installing the Cluster Autoscaler...")
		if err := awscloud.InstallAutoscaler(ctx, a.runner, c); err != nil {
			return nil, err
		}
	}
	if cloud.ConsoleHost != "" {
		if err := a.awsConsoleCertificate(ctx, out, c, cloud); err != nil {
			return nil, err
		}
		if err := a.runner.RunInput(ctx, awscloud.IngressClass, "kubectl", "--context", cluster.Context(c), "apply", "-f", "-"); err != nil {
			return nil, err
		}
	}
	if img.Push {
		if err := awscloud.DockerLogin(ctx, a.runner, c, strings.SplitN(c.PlatformImages.Registry, "/", 2)[0]); err != nil {
			return nil, err
		}
	}
	return cloud, nil
}

// destroyAWS removes an aws install, keeping what the user chose to keep.
func (a *app) destroyAWS(ctx context.Context, out io.Writer, dir string, c *config.Config, deleteData, deleteRegistry bool) error {
	state := awscloud.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return fmt.Errorf("AWS isn't reachable:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	kctx := cluster.Context(c)
	unreached := false
	if state.ClusterStatus == "ACTIVE" {
		if err := awscloud.Credentials(ctx, a.runner, c); err != nil {
			return err
		}
		unreached = !a.clusterAnswers(ctx, out, kctx)
	}
	if state.ClusterStatus == "ACTIVE" && !unreached {
		for _, r := range []string{install.ConsoleRelease, install.KernelRelease} {
			if err := install.Uninstall(ctx, a.runner, c, r); err != nil {
				return err
			}
		}
		// Volumes' disks outlive a deleted cluster: delete the claims while
		// it's there, so their EBS volumes go with them.
		if deleteData {
			fmt.Fprintln(out, "Deleting the database volume...")
			if err := a.runner.Run(ctx, "kubectl", "--context", kctx, "--namespace", c.Namespace,
				"delete", "pvc", "--all", "--wait=true", "--timeout=5m"); err != nil {
				return err
			}
			if err := waitNoVolumes(ctx, a, kctx, c.Namespace); err != nil {
				return err
			}
		} else if vols, _ := a.runner.Output(ctx, "kubectl", "--context", kctx, "get", "pv",
			"-o", "jsonpath={range .items[*]}{.spec.csi.volumeHandle}{\"\\n\"}{end}"); vols != "" {
			fmt.Fprintln(out, "Keeping the database's EBS volume:", strings.ReplaceAll(vols, "\n", ", "))
			fmt.Fprintln(out, "Its passwords were in the cluster, which goes with it: a new install can open it only after resetting them in Postgres by hand.")
		}
		// The console's load balancer (made by Auto Mode, outside OpenTofu's
		// state) goes with its Ingress: wait, or it holds the network.
		if c.Console.Public {
			fmt.Fprintln(out, "Waiting for the console's load balancer to go...")
			if err := waitFor(ctx, 10*time.Minute, 10*time.Second, func() (bool, error) {
				lbs, err := awscloud.LoadBalancersIn(ctx, a.runner, c, "10.40.0.0/16")
				return err == nil && len(lbs) == 0, nil
			}); err != nil {
				return fmt.Errorf("the console's load balancer is still there: %w", err)
			}
		}
		// Auto Mode's steps nodes go before the cluster, so none is left
		// running (standard mode's steps group goes with OpenTofu's state).
		if c.Cluster.Mode == "auto" {
			_ = a.runner.Run(ctx, "kubectl", "--context", kctx, "delete", "nodepool", "vertra-steps", "--ignore-not-found", "--wait=true")
		}
	}

	tf := tofu.In(a.runner, dir)
	if err := modules.Write("aws", tf.Path); err != nil {
		return err
	}
	if err := tf.Init(ctx); err != nil {
		return err
	}
	if err := a.writeAWSVars(ctx, c, tf, deleteData); err != nil {
		return err
	}
	const bucket = "aws_s3_bucket.backups[0]"
	var keep []string
	if c.Database.Backups.Enabled && !deleteData {
		keep = append(keep, bucket, "aws_s3_bucket_public_access_block.backups[0]", "aws_s3_bucket_lifecycle_configuration.backups[0]")
	}
	// The audit log's copy is the record, and Object Lock refuses deletes.
	if c.Audit.Export {
		keep = append(keep, "aws_s3_bucket.audit[0]", "aws_s3_bucket_public_access_block.audit[0]",
			"aws_s3_bucket_versioning.audit[0]", "aws_s3_bucket_object_lock_configuration.audit[0]")
	}
	const logsBucket = "aws_s3_bucket.logs[0]"
	if c.Logs.Enabled && !deleteData {
		keep = append(keep, logsBucket, "aws_s3_bucket_public_access_block.logs[0]", "aws_s3_bucket_lifecycle_configuration.logs[0]")
	}
	const instance = "aws_db_instance.this[0]"
	managed := c.Database.Type == "managed" && tf.Has(ctx, instance)
	if managed && !deleteData {
		// A managed database keeps its data, and the network it's in (its
		// subnets can't go while it's there). Its rule letting the cluster
		// in goes, or the cluster's security group couldn't.
		keep = append(keep, instance, "aws_db_subnet_group.this[0]", "aws_db_parameter_group.this[0]", "aws_security_group.database[0]",
			"aws_vpc.this", "aws_subnet.public[0]", "aws_subnet.public[1]", "aws_internet_gateway.this", "aws_route_table.public",
			"aws_route_table_association.public[0]", "aws_route_table_association.public[1]")
		fmt.Fprintf(out, "Keeping the database (Amazon RDS, %s) and its VPC: `aws rds describe-db-instances`, or `vertra destroy --all` to delete them too.\n", c.AWS.Region)
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
			// Its deletion protection is lifted only once the state says so.
			emptied = append(emptied, instance)
			// RDS keeps manual snapshots after their instance: vertra
			// backup's are data too.
			if err := backup.DeleteManagedSnapshots(ctx, a.runner, c, c.Cluster.Name); err != nil {
				return err
			}
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
		fmt.Fprintln(out, "Deleting the cloud side (OpenTofu; an EKS cluster takes several minutes)...")
		if _, err := tf.Plan(ctx, true); err != nil {
			return err
		}
		if err := tf.Apply(ctx); err != nil {
			return err
		}
	}
	// ECR made the products' repositories on push, outside the state.
	if deleteRegistry {
		if err := awscloud.DeleteTaskRepositories(ctx, a.runner, c); err != nil {
			return err
		}
	}
	if unreached {
		vols, err := awscloud.LeftVolumes(ctx, a.runner, c, c.Namespace)
		leftBehind(out, "EBS volume", vols, err, "aws ec2 delete-volume --volume-id <id> --region "+c.AWS.Region)
	}
	for _, kind := range []string{"context", "cluster", "user"} {
		_ = a.runner.Succeeds(ctx, "kubectl", "config", "delete-"+kind, kctx)
	}
	return nil
}

// awsCost prices the install from AWS's price list; when that fails the
// screen says so and shows no figure.
func (a *app) awsCost(ctx context.Context, c *config.Config) []plan.Line {
	prices, err := pricing.FetchAWS(ctx, a.runner, c.AWS.Profile, c.AWS.Region, c.Database.Type == "managed")
	if err != nil {
		return []plan.Line{{Label: "Estimated cost", Text: "unavailable (" + err.Error() + "): the resources above are what it would be for"}}
	}
	fetched := "fetched now"
	if time.Since(prices.Fetched) > time.Minute {
		fetched = "fetched " + prices.Fetched.Local().Format("Jan 2 15:04")
	}
	return pricing.AWS(prices, c, fetched)
}

// awsConsoleCertificate shows the zone's name servers to delegate it with,
// and waits for ACM to issue the console's certificate (it can once the
// delegation is in place).
func (a *app) awsConsoleCertificate(ctx context.Context, out io.Writer, c *config.Config, cloud *install.Cloud) error {
	status := awscloud.CertificateStatus(ctx, a.runner, c, cloud.ConsoleCertificate)
	if status == "ISSUED" {
		return nil
	}
	zone := c.Console.Zone
	fmt.Fprintf(out, "\nThe console's address, %s, is in a Route 53 zone (%s) the parent domain must delegate to.\n", cloud.ConsoleHost, zone)
	fmt.Fprintf(out, "Where %s's DNS is managed, add these NS records for %s (once; leave the rest of the domain as it is):\n", parentDomain(zone), zone)
	for _, ns := range cloud.ConsoleNameServers {
		fmt.Fprintf(out, "  %s  NS  %s\n", zone, ns)
	}
	fmt.Fprintln(out, "Waiting for the certificate (ACM issues it minutes after the records resolve)...")
	return waitFor(ctx, 90*time.Minute, 30*time.Second, func() (bool, error) {
		status = awscloud.CertificateStatus(ctx, a.runner, c, cloud.ConsoleCertificate)
		if status == "FAILED" || status == "VALIDATION_TIMED_OUT" {
			return false, fmt.Errorf("ACM couldn't issue the certificate (%s): check the NS records, then `vertra apply` again", status)
		}
		return status == "ISSUED", nil
	})
}

// awsConsoleAddress points the console's hostname at its load balancer once
// Auto Mode has made it.
func (a *app) awsConsoleAddress(ctx context.Context, out io.Writer, c *config.Config, cloud *install.Cloud) error {
	var lb string
	fmt.Fprintln(out, "Waiting for the console's load balancer...")
	if err := waitFor(ctx, 10*time.Minute, 10*time.Second, func() (bool, error) {
		lb, _ = a.runner.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
			"get", "ingress", install.ConsoleRelease+"-execution-console", "-o", "jsonpath={.status.loadBalancer.ingress[0].hostname}")
		return strings.TrimSpace(lb) != "", nil
	}); err != nil {
		return err
	}
	lb = strings.TrimSpace(lb)
	lbZone, err := awscloud.LoadBalancerZone(ctx, a.runner, c, lb)
	if err != nil {
		return err
	}
	return awscloud.PointAt(ctx, a.runner, c, cloud.ConsoleZoneID, cloud.ConsoleHost, lb, lbZone)
}

func parentDomain(zone string) string {
	if i := strings.Index(zone, "."); i > 0 {
		return zone[i+1:]
	}
	return zone
}

// githubProvider is the module's GitHub OIDC provider, made when the account
// has none.
const githubProvider = "aws_iam_openid_connect_provider.github[0]"

// writeAWSVars writes the module's variables, after Init (it reads the
// state). The account's GitHub OIDC provider is every install's there, so
// no install keeps it in its state: the one that made it forgets it on its
// next run (before any plan, a destroy's included), and then uses it like
// the others. So neither a destroy nor clearing the catalog deletes it from
// under another install. The ARN of one it forgets comes from the state:
// IAM's list may not show a provider made moments ago (the catalog step
// runs right after the apply that made it), and a missing one would be
// made again.
func (a *app) writeAWSVars(ctx context.Context, c *config.Config, tf tofu.Dir, deleteData bool) error {
	github := ""
	if tf.Has(ctx, githubProvider) {
		var err error
		if github, err = tf.Attribute(ctx, githubProvider, "arn"); err != nil {
			return err
		}
		if github == "" {
			return fmt.Errorf("the state holds %s without its ARN", githubProvider)
		}
		if err := tf.Forget(ctx, githubProvider); err != nil {
			return err
		}
	}
	if c.Catalog.Repo() == "" {
		github = ""
	} else if github == "" {
		var err error
		if github, err = awscloud.GitHubProvider(ctx, a.runner, c); err != nil {
			return err
		}
	}
	return tf.WriteVars(keepBackupBucket(ctx, tf, c, awscloud.Vars(c, deleteData, github), "aws_s3_bucket.backups[0]"))
}
