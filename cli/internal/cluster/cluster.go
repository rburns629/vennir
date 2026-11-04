// SPDX-License-Identifier: MIT

// Package cluster gets a cluster ready for Vennir: for kind (local), the
// local registry and the cluster itself; for an existing cluster, checks
// that it can run Vennir. Both end with the platform namespace.
package cluster

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/run"
)

// MinKubernetesMinor is the oldest Kubernetes 1.x the charts support
// (ValidatingAdmissionPolicy is GA from 1.30).
const MinKubernetesMinor = 30

// Context is the kubectl context for a config's cluster.
func Context(c *config.Config) string {
	switch c.Target {
	case "kind":
		return "kind-" + c.Cluster.Name
	case "gcp":
		// What `gcloud container clusters get-credentials` names it.
		return fmt.Sprintf("gke_%s_%s_%s", c.GCP.Project, GKELocation(c), c.Cluster.Name)
	case "aws":
		// The alias vennir gives `aws eks update-kubeconfig`.
		return fmt.Sprintf("eks_%s_%s", c.AWS.Region, c.Cluster.Name)
	}
	return c.Cluster.Context
}

// GKELocation is where the module puts a gcp cluster: the region for
// Autopilot (regional), one zone for standard (one platform node, zonal,
// inside GKE's free tier).
func GKELocation(c *config.Config) string {
	if c.Cluster.Mode == "standard" {
		return c.GCP.Region + "-a"
	}
	return c.GCP.Region
}

// State is what already exists, for the plan.
type State struct {
	RegistryRunning bool
	RegistryExists  bool
	ClusterExists   bool
	ClusterRunning  bool
	Reachable       bool
	ServerVersion   string
	NamespaceExists bool
	// CertManager: cert-manager's Certificate resource is installed.
	CertManager bool
	// NodeArch: its first node's architecture (amd64, arm64), when read.
	NodeArch string
	// Problems that stop an apply (an unreachable or too-old cluster).
	Problems []string
}

// Inspect reads the current state without changing anything.
func Inspect(ctx context.Context, r *run.Runner, c *config.Config) State {
	var s State
	if c.Target == "kind" {
		running := func(container string, exists, running *bool) func() {
			return func() {
				status, err := r.Output(ctx, "docker", "inspect", "-f", "{{.State.Running}}", container)
				*exists, *running = err == nil, err == nil && status == "true"
			}
		}
		run.Together(
			running(c.Kind.RegistryName, &s.RegistryExists, &s.RegistryRunning),
			running(c.Cluster.Name+"-control-plane", &s.ClusterExists, &s.ClusterRunning),
		)
		if !s.ClusterRunning {
			return s
		}
	}
	version, err := ServerVersion(ctx, r, Context(c))
	if err != nil {
		if c.Target == "existing" {
			s.Problems = append(s.Problems, fmt.Sprintf("can't reach the cluster through context %q: %v", Context(c), err))
		}
		return s
	}
	s.Reachable, s.ServerVersion = true, version
	if minor := minorOf(version); minor < MinKubernetesMinor {
		s.Problems = append(s.Problems, fmt.Sprintf("Kubernetes %s is too old: Vennir needs 1.%d or later", version, MinKubernetesMinor))
	}
	run.Together(
		func() {
			s.NamespaceExists = r.Succeeds(ctx, "kubectl", "--context", Context(c), "get", "namespace", c.Namespace)
		},
		func() {
			s.CertManager = r.Succeeds(ctx, "kubectl", "--context", Context(c), "get", "crd", "certificates.cert-manager.io")
		},
		func() {
			if arch, err := r.Output(ctx, "kubectl", "--context", Context(c), "get", "nodes", "-o", "jsonpath={.items[0].status.nodeInfo.architecture}"); err == nil {
				s.NodeArch = strings.TrimSpace(arch)
			}
		},
	)
	return s
}

// ServerVersion is the cluster's Kubernetes version, like 1.37.0.
func ServerVersion(ctx context.Context, r *run.Runner, kubeContext string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := r.Output(ctx, "kubectl", "--context", kubeContext, "version", "-o", "json")
	if err != nil {
		return "", err
	}
	var v struct {
		ServerVersion struct {
			GitVersion string `json:"gitVersion"`
		} `json:"serverVersion"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil || v.ServerVersion.GitVersion == "" {
		return "", fmt.Errorf("no server version in kubectl's answer")
	}
	return strings.TrimPrefix(regexp.MustCompile(`^v?\d+\.\d+\.\d+`).FindString(v.ServerVersion.GitVersion), "v"), nil
}

func minorOf(version string) int {
	parts := strings.Split(version, ".")
	if len(parts) < 2 {
		return 0
	}
	n, _ := strconv.Atoi(parts[1])
	return n
}

// kindConfig points containerd at per-registry config, so the node can
// pull from the local registry (kind's documented local-registry setup).
const kindConfig = `kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
`

// RegistryImage is the local registry's image, pinned by digest (the
// Makefile's kind-registry runs the same). To upgrade it: take the new
// tag's digest from `docker buildx imagetools inspect registry:<tag>`.
const RegistryImage = "registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"

// EnsureKind starts or creates the local registry and the kind cluster,
// joins them up, and waits for the node.
func EnsureKind(ctx context.Context, r *run.Runner, c *config.Config, s State) error {
	reg := c.Kind.RegistryName
	switch {
	case s.RegistryRunning:
	case s.RegistryExists:
		if err := r.Run(ctx, "docker", "start", reg); err != nil {
			return err
		}
	default:
		if err := r.Run(ctx, "docker", "run", "-d", "--restart=always",
			"-p", fmt.Sprintf("127.0.0.1:%d:5000", c.Kind.RegistryPort), "--name", reg, RegistryImage); err != nil {
			return err
		}
	}
	node := c.Cluster.Name + "-control-plane"
	switch {
	case s.ClusterRunning:
	case s.ClusterExists:
		if err := r.Run(ctx, "docker", "start", node); err != nil {
			return err
		}
	default:
		// kind switches kubectl's current context to the new cluster; put
		// back whatever the user had, since vennir names its context.
		previous, _ := r.Output(ctx, "kubectl", "config", "current-context")
		if err := r.RunInput(ctx, kindConfig, "kind", "create", "cluster", "--name", c.Cluster.Name, "--config", "-"); err != nil {
			return err
		}
		if previous = strings.TrimSpace(previous); previous != "" {
			if err := r.Run(ctx, "kubectl", "config", "use-context", previous); err != nil {
				return err
			}
		}
	}
	// Already connected is fine: the error is ignored on purpose.
	_ = r.Succeeds(ctx, "docker", "network", "connect", "kind", reg)

	// The node maps localhost:<port> to the registry inside kind's network.
	// The name and port are validated config values, not free text.
	hostDir := fmt.Sprintf("/etc/containerd/certs.d/localhost:%d", c.Kind.RegistryPort)
	hosts := fmt.Sprintf("[host.\"http://%s:5000\"]\n", reg)
	if err := r.Run(ctx, "docker", "exec", node, "mkdir", "-p", hostDir); err != nil {
		return err
	}
	if err := r.RunInput(ctx, hosts, "docker", "exec", "-i", node, "cp", "/dev/stdin", hostDir+"/hosts.toml"); err != nil {
		return err
	}
	return waitReady(ctx, r, Context(c), 5*time.Minute)
}

func waitReady(ctx context.Context, r *run.Runner, kubeContext string, limit time.Duration) error {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		out, err := r.Output(ctx, "kubectl", "--context", kubeContext, "get", "nodes", "--no-headers")
		if err == nil && strings.Contains(out, " Ready") {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("the cluster's node wasn't Ready after %s", limit)
}

// EnsureNamespace creates the platform namespace if it isn't there. It's
// never labelled as a team's: the kernel refuses to run steps in it.
func EnsureNamespace(ctx context.Context, r *run.Runner, c *config.Config) error {
	if r.Succeeds(ctx, "kubectl", "--context", Context(c), "get", "namespace", c.Namespace) {
		return nil
	}
	return r.Run(ctx, "kubectl", "--context", Context(c), "create", "namespace", c.Namespace)
}

// DeleteKind deletes the kind cluster: everything in it, data included.
func DeleteKind(ctx context.Context, r *run.Runner, c *config.Config) error {
	return r.Run(ctx, "kind", "delete", "cluster", "--name", c.Cluster.Name)
}

// OtherKindClusters are the kind clusters on this machine besides this
// environment's: they may pull from the same local registry.
func OtherKindClusters(ctx context.Context, r *run.Runner, c *config.Config) []string {
	out, err := r.Output(ctx, "kind", "get", "clusters")
	if err != nil {
		return nil
	}
	var others []string
	for _, name := range strings.Fields(out) {
		if name != c.Cluster.Name {
			others = append(others, name)
		}
	}
	return others
}

// DeleteRegistry removes the local registry container and its images.
func DeleteRegistry(ctx context.Context, r *run.Runner, c *config.Config) error {
	return r.Run(ctx, "docker", "rm", "-f", "-v", c.Kind.RegistryName)
}
