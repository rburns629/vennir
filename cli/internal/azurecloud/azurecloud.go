// SPDX-License-Identifier: MIT

// Package azurecloud is what an azure install needs from the az CLI, run as
// you (az's sign-in, which OpenTofu's azurerm provider uses too): whether
// you're signed in and the cluster exists, the cluster's credentials for
// kubectl (signing in through Microsoft Entra with kubelogin), a Docker
// sign-in to ACR, and the module's inputs.
package azurecloud

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/roburns/vennir/cli/internal/cluster"
	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/run"
	"github.com/roburns/vennir/cli/internal/tools"
)

// args adds the config's subscription to an az command.
func args(c *config.Config, a ...string) []string {
	return append(a, "--subscription", c.Azure.Subscription, "--output", "json")
}

// State is what Azure says about you and the cluster.
type State struct {
	// User is who az is signed in as.
	User string
	// ClusterState is the cluster's provisioning state (Succeeded,
	// Creating, ...), "" if it doesn't exist; PowerState, Running or
	// Stopped.
	ClusterState string
	PowerState   string
	Problems     []string
}

// Inspect checks az signs in to the subscription, and whether the cluster
// exists.
func Inspect(ctx context.Context, r *run.Runner, c *config.Config) State {
	var s State
	out, err := r.Output(ctx, "az", args(c, "account", "show", "--query", "user.name")...)
	if err != nil {
		s.Problems = append(s.Problems, "can't sign in to Azure subscription "+c.Azure.Subscription+" ("+err.Error()+"): `az login`")
		return s
	}
	if err := json.Unmarshal([]byte(out), &s.User); err != nil {
		s.Problems = append(s.Problems, err.Error())
		return s
	}
	out, err = r.Output(ctx, "az", args(c, "aks", "show", "--resource-group", c.Azure.ResourceGroup, "--name", c.Cluster.Name,
		"--query", "{state: provisioningState, power: powerState.code}")...)
	if err == nil {
		var v struct{ State, Power string }
		if json.Unmarshal([]byte(out), &v) == nil {
			s.ClusterState, s.PowerState = v.State, v.Power
		}
	}
	return s
}

// Credentials adds the cluster to your kubeconfig as cluster.Context,
// signing in as you through Microsoft Entra (kubelogin with az's sign-in;
// the cluster has no local accounts), and puts your current context back.
func Credentials(ctx context.Context, r *run.Runner, c *config.Config) error {
	kctx := cluster.Context(c)
	previous, _ := r.Output(ctx, "kubectl", "config", "current-context")
	if err := r.Run(ctx, "az", args(c, "aks", "get-credentials", "--resource-group", c.Azure.ResourceGroup, "--name", c.Cluster.Name,
		"--context", kctx, "--overwrite-existing")...); err != nil {
		return err
	}
	if err := r.Run(ctx, "kubelogin", "convert-kubeconfig", "--login", "azurecli", "--context", kctx); err != nil {
		return err
	}
	// kubectl runs kubelogin by name, and vennir's own copy isn't on your
	// PATH: name it by its path, so your kubectl signs in too.
	// set-credentials replaces the whole exec, so its arguments and API
	// version go back in with it.
	user, err := r.Output(ctx, "kubectl", "config", "view", "-o", fmt.Sprintf(`jsonpath={.contexts[?(@.name=="%s")].context.user}`, kctx))
	if err != nil || strings.TrimSpace(user) == "" {
		return fmt.Errorf("the kubeconfig has no user for %s: %v", kctx, err)
	}
	user = strings.TrimSpace(user)
	exec := fmt.Sprintf(`{.users[?(@.name=="%s")].user.exec`, user)
	execArgs, err := r.Output(ctx, "kubectl", "config", "view", "-o", "jsonpath="+exec+`.args[*]}`)
	if err != nil {
		return err
	}
	apiVersion, err := r.Output(ctx, "kubectl", "config", "view", "-o", "jsonpath="+exec+`.apiVersion}`)
	if err != nil {
		return err
	}
	set := []string{"config", "set-credentials", user, "--exec-command", tools.Path("kubelogin"), "--exec-api-version", strings.TrimSpace(apiVersion)}
	for _, a := range strings.Fields(execArgs) {
		set = append(set, "--exec-arg", a)
	}
	if err := r.Run(ctx, "kubectl", set...); err != nil {
		return err
	}
	if previous = strings.TrimSpace(previous); previous != "" && previous != kctx {
		return r.Run(ctx, "kubectl", "config", "use-context", previous)
	}
	return nil
}

// where is the module's hash of where the install is (its subscription and
// resource group), which its registry and storage account names end in.
func where(c *config.Config) string {
	sum := sha256.Sum256([]byte(c.Azure.Subscription + "/" + c.Azure.ResourceGroup))
	return hex.EncodeToString(sum[:])[:8]
}

// RegistryName is the module's ACR's name, known before apply.
func RegistryName(c *config.Config) string {
	return strings.ReplaceAll(c.Cluster.Name, "-", "") + where(c)
}

// BackupStorageName is the module's backups' storage account's name (at
// most 24 characters).
func BackupStorageName(c *config.Config) string {
	compact := strings.ReplaceAll(c.Cluster.Name, "-", "")
	if len(compact) > 14 {
		compact = compact[:14]
	}
	return compact + "bk" + where(c)
}

// Registry is its host.
func Registry(c *config.Config) string {
	return RegistryName(c) + ".azurecr.io"
}

// PlatformPrefix is the repository prefix for platform images built from
// source ("" when installing a release).
func PlatformPrefix(c *config.Config) string {
	if c.Vennir != "source" {
		return ""
	}
	return c.Cluster.Name + "-platform"
}

// DockerLogin signs Docker in to the module's ACR as you (az's sign-in).
func DockerLogin(ctx context.Context, r *run.Runner, c *config.Config) error {
	return r.Run(ctx, "az", "acr", "login", "--name", RegistryName(c), "--subscription", c.Azure.Subscription)
}

// Vars are the module's inputs.
func Vars(c *config.Config, deleteData bool) map[string]any {
	return map[string]any{
		"subscription":          c.Azure.Subscription,
		"region":                c.Azure.Region,
		"resource_group":        c.Azure.ResourceGroup,
		"name":                  c.Cluster.Name,
		"size":                  c.Size,
		"namespace":             c.Namespace,
		"step_headroom":         c.StepHeadroom,
		"on_demand_steps":       c.Azure.OnDemandSteps,
		"task_registry":         c.TaskImages.Name,
		"platform_registry":     PlatformPrefix(c),
		"backups":               c.Database.Backups.Enabled,
		"backup_retention_days": c.Database.Backups.RetentionDays,
		"delete_data":           deleteData,
	}
}
