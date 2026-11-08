// SPDX-License-Identifier: MIT

// Package azurecloud is what an azure install needs from the az CLI, run as
// you (az's sign-in, which OpenTofu's azurerm provider uses too): whether
// you're signed in and the cluster exists, and the cluster's credentials
// for kubectl, signing in through Microsoft Entra with kubelogin.
package azurecloud

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/rburns629/vennir/cli/internal/cluster"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/run"
	"github.com/rburns629/vennir/cli/internal/tools"
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
	user, err := r.Output(ctx, "kubectl", "config", "view", "-o", fmt.Sprintf(`jsonpath={.contexts[?(@.name=="%s")].context.user}`, kctx))
	if err != nil || strings.TrimSpace(user) == "" {
		return fmt.Errorf("the kubeconfig has no user for %s: %v", kctx, err)
	}
	if err := r.Run(ctx, "kubectl", "config", "set-credentials", strings.TrimSpace(user), "--exec-command", tools.Path("kubelogin")); err != nil {
		return err
	}
	if previous = strings.TrimSpace(previous); previous != "" && previous != kctx {
		return r.Run(ctx, "kubectl", "config", "use-context", previous)
	}
	return nil
}
