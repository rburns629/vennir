// SPDX-License-Identifier: MIT
package main

import (
	"strings"
	"testing"
)

func TestSafeRefusesAnyClusterButVennirs(t *testing.T) {
	for _, c := range []struct{ cluster, cloud, console, refusal string }{
		{"vennir-local", "", "http://localhost:18080", "only on a vennir-perf* cluster"},
		{"vennir-perf", "kind-vennir-perf", "http://localhost:18080", "a kind cluster is -cluster"},
		{"vennir-perf", "gke_basisiq-dev_us-east1_prod", "http://localhost:18080", "a vennir-perf* GKE or EKS"},
		{"vennir-perf", "arn:aws:eks:us-east-2:1:cluster/prod", "http://localhost:18080", "a vennir-perf* GKE or EKS"},
		// The Makefile's GKE cluster, or any other vennir install, isn't one.
		{"vennir-perf", "gke_my-gcp-project_us-central1_vennir-gke", "http://localhost:18080", "a vennir-perf* GKE or EKS"},
		{"vennir-perf", "arn:aws:eks:us-east-2:1:cluster/vennir-bp", "http://localhost:18080", "a vennir-perf* GKE or EKS"},
		{"vennir-perf", "gke_acyclix-dev_us-east1_vennir-perf", "https://console.example.com", "only a console on this machine"},
		// Named well: refused further on, only because it isn't reachable here.
		{"vennir-perf", "gke_acyclix-dev_us-east1_vennir-perf", "http://localhost:18080", "no Vennir in vennir-system"},
		{"vennir-perf", "arn:aws:eks:us-east-2:1:cluster/vennir-perf-bp", "http://localhost:18080", "no Vennir in vennir-system"},
	} {
		_, err := safe(c.cluster, c.cloud, c.console)
		if err == nil || !strings.Contains(err.Error(), c.refusal) {
			t.Errorf("safe(%q, %q, %q) = %v, want %q", c.cluster, c.cloud, c.console, err, c.refusal)
		}
	}
}
