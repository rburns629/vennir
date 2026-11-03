// SPDX-License-Identifier: MIT
package main

import (
	"strings"
	"testing"
)

func TestSafeRefusesAnyClusterButVertras(t *testing.T) {
	for _, c := range []struct{ cluster, cloud, console, refusal string }{
		{"vertra-local", "", "http://localhost:18080", "only on a vertra-perf* cluster"},
		{"vertra-perf", "kind-vertra-perf", "http://localhost:18080", "a kind cluster is -cluster"},
		{"vertra-perf", "gke_basisiq-dev_us-east1_prod", "http://localhost:18080", "a vertra-perf* GKE or EKS"},
		{"vertra-perf", "arn:aws:eks:us-east-2:1:cluster/prod", "http://localhost:18080", "a vertra-perf* GKE or EKS"},
		// The Makefile's GKE cluster, or any other vertra install, isn't one.
		{"vertra-perf", "gke_my-gcp-project_us-central1_vertra-gke", "http://localhost:18080", "a vertra-perf* GKE or EKS"},
		{"vertra-perf", "arn:aws:eks:us-east-2:1:cluster/vertra-bp", "http://localhost:18080", "a vertra-perf* GKE or EKS"},
		{"vertra-perf", "gke_acyclix-dev_us-east1_vertra-perf", "https://console.example.com", "only a console on this machine"},
		// Named well: refused further on, only because it isn't reachable here.
		{"vertra-perf", "gke_acyclix-dev_us-east1_vertra-perf", "http://localhost:18080", "no Vertra in vertra-system"},
		{"vertra-perf", "arn:aws:eks:us-east-2:1:cluster/vertra-perf-bp", "http://localhost:18080", "no Vertra in vertra-system"},
	} {
		_, err := safe(c.cluster, c.cloud, c.console)
		if err == nil || !strings.Contains(err.Error(), c.refusal) {
			t.Errorf("safe(%q, %q, %q) = %v, want %q", c.cluster, c.cloud, c.console, err, c.refusal)
		}
	}
}
