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
	"github.com/rburns629/vennir/cli/internal/azurecloud"
	"github.com/rburns629/vennir/cli/internal/cluster"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/install"
	"github.com/rburns629/vennir/cli/internal/modules"
	"github.com/rburns629/vennir/cli/internal/plan"
	"github.com/rburns629/vennir/cli/internal/pricing"
	"github.com/rburns629/vennir/cli/internal/tofu"
)

// planAzure checks the sign-in, gets the cluster's credentials if it
// exists, and plans the module.
func (a *app) planAzure(ctx context.Context, out io.Writer, dir string, c *config.Config, destroy bool) (*cloudPlan, error) {
	fmt.Fprintf(out, "Checking your Azure sign-in (subscription %s)...\n", c.Azure.Subscription)
	state := azurecloud.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return nil, fmt.Errorf("Azure isn't ready:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	check := access.CheckAzure(ctx, a.runner.Exec, c.Azure.Subscription, c.Azure.Region)
	if err := sameIdentity(c.Access.Cloud, check.Identity); err != nil {
		return nil, err
	}
	if err := problemsError(check.Report); err != nil {
		return nil, err
	}
	if c.Vennir == "source" {
		// Where images built from source go: the module's registry, whose
		// name is known before it's made.
		c.PlatformImages.Registry = azurecloud.Registry(c) + "/" + azurecloud.PlatformPrefix(c)
	}
	if state.ClusterState == "Succeeded" {
		if err := azurecloud.Credentials(ctx, a.runner, c); err != nil {
			return nil, err
		}
	}
	p := &cloudPlan{account: check.User, access: check.Lines, where: "subscription " + c.Azure.Subscription, tf: tofu.In(a.runner, dir)}
	if err := modules.Write("azure", p.tf.Path); err != nil {
		return nil, err
	}

	fmt.Fprintln(out, "Planning the cloud side (OpenTofu)...")
	if err := p.tf.Init(ctx); err != nil {
		return nil, err
	}
	if err := p.tf.WriteVars(azurecloud.Vars(c, false)); err != nil {
		return nil, err
	}
	changes, err := p.tf.Plan(ctx, destroy)
	if err != nil {
		return nil, err
	}
	p.changes = changes
	if !destroy {
		p.cost = a.azureCost(ctx, c)
	}
	return p, nil
}

// cloudFromAzure reads the module's outputs.
func cloudFromAzure(outputs map[string]json.RawMessage) (*install.Cloud, error) {
	var v struct {
		Cluster struct {
			Name          string `json:"name"`
			ResourceGroup string `json:"resource_group"`
			Region        string `json:"region"`
			Issuer        string `json:"issuer"`
		}
		TaskRegistry string
		Identities   map[string]string
		Backup       *struct {
			StorageAccount string `json:"storage_account"`
			Container      string `json:"container"`
			ClientID       string `json:"client_id"`
		}
		StepPlacement map[string]any
		Capacities    map[string]any
	}
	for name, into := range map[string]any{
		"cluster": &v.Cluster, "task_registry": &v.TaskRegistry, "identities": &v.Identities, "backup": &v.Backup,
		"step_placement": &v.StepPlacement, "capacity_placements": &v.Capacities,
	} {
		raw, ok := outputs[name]
		if !ok {
			// `tofu output` leaves out outputs that are null.
			if optionalOutputs[name] {
				continue
			}
			return nil, fmt.Errorf("the azure module has no %q output", name)
		}
		if err := json.Unmarshal(raw, into); err != nil {
			return nil, fmt.Errorf("the azure module's %q output: %w", name, err)
		}
	}
	cloud := &install.Cloud{
		Provider:              "azure",
		TaskRegistry:          v.TaskRegistry,
		StepPlacement:         v.StepPlacement,
		CapacityPlacements:    v.Capacities,
		ClusterName:           v.Cluster.Name,
		ClusterLocation:       v.Cluster.Region,
		ClusterIssuer:         v.Cluster.Issuer,
		ConsoleServiceAccount: v.Identities["console"],
		ScannerServiceAccount: v.Identities["scanner"],
		PolicyServiceAccount:  v.Identities["policy"],
	}
	if b := v.Backup; b != nil {
		cloud.BackupBucket, cloud.BackupContainer, cloud.BackupServiceAccount = b.StorageAccount, b.Container, b.ClientID
	}
	return cloud, nil
}

// applyAzure carries out the approved cloud plan, then readies the cluster
// for the charts: its credentials, and a Docker sign-in to push images
// built from source.
func (a *app) applyAzure(ctx context.Context, out io.Writer, c *config.Config, p *cloudPlan, img install.Images) (*install.Cloud, error) {
	fmt.Fprintln(out, "Creating the cloud side (OpenTofu; a new AKS cluster takes about ten minutes)...")
	if err := p.tf.Apply(ctx); err != nil {
		return nil, err
	}
	outputs, err := p.tf.Outputs(ctx)
	if err != nil {
		return nil, err
	}
	cloud, err := cloudFromAzure(outputs)
	if err != nil {
		return nil, err
	}
	if err := azurecloud.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	if img.Push {
		if err := azurecloud.DockerLogin(ctx, a.runner, c); err != nil {
			return nil, err
		}
	}
	return cloud, nil
}

// azureKept is what a destroy leaves for each thing kept: the resource
// group, which goes only once it's empty, with each.
var (
	azureBackups  = []string{"azurerm_storage_account.backups[0]", "azurerm_storage_container.backups[0]", "azurerm_storage_management_policy.backups[0]"}
	azureRegistry = []string{"azurerm_container_registry.this"}
	azureGroup    = "azurerm_resource_group.this"
)

// destroyAzure removes an azure install, keeping what the user chose to
// keep: the backups' storage account (unless deleteData) and the registry
// with the catalog's images (unless deleteRegistry), in the resource group,
// which then stays too. The database's disk goes with the cluster (AKS
// keeps its disks in the cluster's own node resource group): its backups
// are what's kept.
func (a *app) destroyAzure(ctx context.Context, out io.Writer, dir string, c *config.Config, deleteData, deleteRegistry bool) error {
	state := azurecloud.Inspect(ctx, a.runner, c)
	if len(state.Problems) > 0 {
		return fmt.Errorf("Azure isn't reachable:\n  - %s", strings.Join(state.Problems, "\n  - "))
	}
	kctx := cluster.Context(c)
	// What az aks get-credentials named its user and cluster, to remove
	// with the context.
	user, _ := a.runner.Output(ctx, "kubectl", "config", "view", "-o", fmt.Sprintf(`jsonpath={.contexts[?(@.name=="%s")].context.user}`, kctx))
	kcluster, _ := a.runner.Output(ctx, "kubectl", "config", "view", "-o", fmt.Sprintf(`jsonpath={.contexts[?(@.name=="%s")].context.cluster}`, kctx))
	if state.ClusterState == "Succeeded" {
		if err := azurecloud.Credentials(ctx, a.runner, c); err != nil {
			return err
		}
		if a.clusterAnswers(ctx, out, kctx) {
			for _, r := range []string{install.ConsoleRelease, install.KernelRelease} {
				if err := install.Uninstall(ctx, a.runner, c, r); err != nil {
					return err
				}
			}
		}
	}

	tf := tofu.In(a.runner, dir)
	if err := modules.Write("azure", tf.Path); err != nil {
		return err
	}
	if err := tf.Init(ctx); err != nil {
		return err
	}
	if err := tf.WriteVars(azurecloud.Vars(c, deleteData)); err != nil {
		return err
	}
	var keep []string
	if c.Database.Backups.Enabled && !deleteData {
		keep = append(keep, azureBackups...)
		fmt.Fprintf(out, "Keeping the database's backups (storage account %s), and their resource group %s.\n", azurecloud.BackupStorageName(c), c.Azure.ResourceGroup)
	}
	if !deleteRegistry {
		keep = append(keep, azureRegistry...)
		fmt.Fprintf(out, "Keeping the registry %s (the catalog's images), and its resource group %s.\n", azurecloud.Registry(c), c.Azure.ResourceGroup)
	}
	if len(keep) > 0 {
		keep = append(keep, azureGroup)
	}
	if tf.HasState(ctx) {
		if err := tf.Forget(ctx, keep...); err != nil {
			return err
		}
		fmt.Fprintln(out, "Deleting the cloud side (OpenTofu; an AKS cluster takes several minutes)...")
		if _, err := tf.Plan(ctx, true); err != nil {
			return err
		}
		if err := tf.Apply(ctx); err != nil {
			return err
		}
	}
	_ = a.runner.Succeeds(ctx, "kubectl", "config", "delete-context", kctx)
	if u := strings.TrimSpace(user); u != "" {
		_ = a.runner.Succeeds(ctx, "kubectl", "config", "delete-user", u)
	}
	if k := strings.TrimSpace(kcluster); k != "" {
		_ = a.runner.Succeeds(ctx, "kubectl", "config", "delete-cluster", k)
	}
	return nil
}

// azureCost prices the install from Azure's Retail Prices API; when that
// fails the screen says so and shows no figure.
func (a *app) azureCost(ctx context.Context, c *config.Config) []plan.Line {
	prices, err := pricing.FetchAzure(ctx, c.Azure.Region)
	if err != nil {
		return []plan.Line{{Label: "Estimated cost", Text: "unavailable (" + err.Error() + "): the resources above are what it would be for"}}
	}
	fetched := "fetched now"
	if time.Since(prices.Fetched) > time.Minute {
		fetched = "fetched " + prices.Fetched.Local().Format("Jan 2 15:04")
	}
	return pricing.Azure(prices, c, fetched)
}
