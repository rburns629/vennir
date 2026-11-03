// SPDX-License-Identifier: MIT

package install

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/rburns629/vertra/cli/internal/cluster"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/run"
)

// AddOn is a cluster-wide chart apply installs beside the platform, when
// the cluster hasn't got it.
type AddOn struct {
	Name, Release, Namespace string
	// Loses: what uninstalling it takes from the rest of the cluster.
	Loses string
}

var (
	PolicyControllerAddOn = AddOn{"policy-controller", "policy-controller", "cosign-system",
		"Anything else's image policies stop being enforced."}
	ExternalSecretsAddOn = AddOn{"External Secrets Operator", "external-secrets", "external-secrets",
		"Anything else's SecretStores stop syncing."}
	CertManagerAddOn = AddOn{"cert-manager", "cert-manager", "cert-manager",
		"Anything else's certificates stop renewing."}
)

// AddOns are every add-on apply may install, in the order destroy offers
// to uninstall them.
var AddOns = []AddOn{PolicyControllerAddOn, ExternalSecretsAddOn, CertManagerAddOn}

// AddOnsFile, in the environment's folder, lists the add-ons (their
// releases) this environment's applies installed: those that weren't in the
// cluster before. Destroy offers to uninstall those, and only those, as
// apply also upgrades an add-on someone else installed.
const AddOnsFile = "add-ons"

// RecordAddOn adds a to dir's AddOnsFile.
func RecordAddOn(dir string, a AddOn) error {
	installed := recorded(dir)
	if slices.Contains(installed, a.Release) {
		return nil
	}
	installed = append(installed, a.Release)
	head := "# The add-ons vertra apply installed here, which vertra destroy offers to uninstall.\n"
	return os.WriteFile(filepath.Join(dir, AddOnsFile), []byte(head+strings.Join(installed, "\n")+"\n"), 0o644)
}

// RecordedAddOns are the add-ons RecordAddOn recorded in dir, in AddOns'
// order.
func RecordedAddOns(dir string) []AddOn {
	installed := recorded(dir)
	var found []AddOn
	for _, a := range AddOns {
		if slices.Contains(installed, a.Release) {
			found = append(found, a)
		}
	}
	return found
}

func recorded(dir string) []string {
	data, err := os.ReadFile(filepath.Join(dir, AddOnsFile))
	if err != nil {
		return nil
	}
	var releases []string
	for _, line := range strings.Split(string(data), "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.HasPrefix(line, "#") {
			releases = append(releases, line)
		}
	}
	return releases
}

// UninstallAddOn removes an add-on's release.
func UninstallAddOn(ctx context.Context, r *run.Runner, c *config.Config, a AddOn) error {
	return r.Run(ctx, "helm", "uninstall", a.Release, "--kube-context", cluster.Context(c), "--namespace", a.Namespace, "--wait")
}

// TeamNamespaces are the cluster's namespaces labelled vertra/team: those
// the console made (it labels them managed-by vertra-console), and the rest,
// labelled by hand (an existing namespace handed over to a team, or one
// labelled for another reason).
func TeamNamespaces(ctx context.Context, r *run.Runner, c *config.Config) (made, others []string, err error) {
	list := func(selector string) ([]string, error) {
		out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "get", "namespace", "-l", selector,
			"-o", "jsonpath={.items[*].metadata.name}")
		return strings.Fields(out), err
	}
	if made, err = list("vertra/team,app.kubernetes.io/managed-by=vertra-console"); err != nil {
		return nil, nil, err
	}
	if others, err = list("vertra/team,app.kubernetes.io/managed-by!=vertra-console"); err != nil {
		return nil, nil, err
	}
	return made, others, nil
}
