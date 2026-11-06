// SPDX-License-Identifier: MIT

package install

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/rburns629/vennir/cli/internal/cluster"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/run"
)

// AddOn is a cluster-wide chart apply installs beside the platform, when
// the cluster hasn't got it.
type AddOn struct {
	Name, Release, Namespace string
	// Loses: what uninstalling it takes from the rest of the cluster.
	Loses string
}

// What each loses was read from the pinned charts (2026-11-03): ESO's and
// policy-controller's resource definitions are templates with no
// helm.sh/resource-policy: keep, so uninstalling deletes them, and every
// object of their kinds in the cluster; cert-manager's are kept.
var (
	PolicyControllerAddOn = AddOn{"policy-controller", "policy-controller", "cosign-system",
		"Its resource definitions go with it, and so does every ClusterImagePolicy in the cluster, anyone's."}
	ExternalSecretsAddOn = AddOn{"External Secrets Operator", "external-secrets", "external-secrets",
		"Its resource definitions go with it, and so does every SecretStore and ExternalSecret in the cluster, anyone's, with the Secrets they own."}
	CertManagerAddOn = AddOn{"cert-manager", "cert-manager", "cert-manager",
		"Its resource definitions stay, but anything else's certificates stop renewing."}
)

// AddOns are every add-on apply may install, in the order destroy offers
// to uninstall them.
var AddOns = []AddOn{PolicyControllerAddOn, ExternalSecretsAddOn, CertManagerAddOn}

// AddOnsFile, in the environment's folder, lists the add-ons (their
// releases) this environment's applies installed: those that weren't in the
// cluster before. Destroy offers to uninstall those, and only those, as
// apply also upgrades an add-on someone else installed.
const AddOnsFile = "add-ons"

// RecordIfMissing records a as this environment's (RecordAddOn) when helm
// confirms the cluster hasn't got its release, in any state: apply calls it
// just before installing a. When helm can't tell, it's an error, never
// taken for "not installed", so someone else's add-on is never recorded.
// Recorded first, so a failed install is recorded too.
func RecordIfMissing(ctx context.Context, r *run.Runner, c *config.Config, dir string, a AddOn) error {
	// Helm 4 lists releases in any state by default (Helm 3's --all is gone).
	out, err := r.Output(ctx, "helm", "list", "--kube-context", cluster.Context(c), "--namespace", a.Namespace,
		"--filter", "^"+a.Release+"$", "--short")
	if err != nil {
		return fmt.Errorf("couldn't tell whether %s is installed already: %w", a.Name, err)
	}
	if strings.TrimSpace(out) != "" {
		return nil
	}
	return RecordAddOn(dir, a)
}

// RecordAddOn adds a to dir's AddOnsFile.
func RecordAddOn(dir string, a AddOn) error {
	installed := recorded(dir)
	if slices.Contains(installed, a.Release) {
		return nil
	}
	installed = append(installed, a.Release)
	head := "# The add-ons vennir apply installed here, which vennir destroy offers to uninstall.\n"
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

// TeamNamespaces are the cluster's namespaces labelled vennir/team: those
// the console made (it labels them managed-by vennir-console), and the rest,
// labelled by hand (an existing namespace handed over to a team, or one
// labelled for another reason).
func TeamNamespaces(ctx context.Context, r *run.Runner, c *config.Config) (made, others []string, err error) {
	list := func(selector string) ([]string, error) {
		out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "get", "namespace", "-l", selector,
			"-o", "jsonpath={.items[*].metadata.name}")
		return strings.Fields(out), err
	}
	if made, err = list("vennir/team,app.kubernetes.io/managed-by=vennir-console"); err != nil {
		return nil, nil, err
	}
	if others, err = list("vennir/team,app.kubernetes.io/managed-by!=vennir-console"); err != nil {
		return nil, nil, err
	}
	return made, others, nil
}
