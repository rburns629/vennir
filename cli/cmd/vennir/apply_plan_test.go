// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"strings"
	"testing"

	"github.com/roburns/vennir/cli/internal/cluster"
	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/install"
	"github.com/roburns/vennir/cli/internal/plan"
)

func changes(p *plan.Plan) string {
	var lines []string
	for _, l := range p.Changes {
		lines = append(lines, l.Label+": "+l.Text)
	}
	return strings.Join(append(lines, p.Notes...), "\n")
}

// A rerun at the same version says what it applies and what changed, and
// leaves out what's already installed.
func TestPlanOfARerun(t *testing.T) {
	c := config.Default("kind")
	c.Vennir = "0.6.0"
	c.ExternalSecrets = true
	c.FillDefaults()
	installed := map[string]string{install.KernelRelease: "execution-kernel-0.6.0", install.ConsoleRelease: "execution-console-0.6.0"}
	s := cluster.State{Reachable: true, NamespaceExists: true}
	was := *c
	now := current{applied: &was, externalSecrets: "external-secrets-" + install.ExternalSecretsChart}

	got := changes(buildPlan(context.Background(), c, "dev", s, install.Images{}, installed, now, nil))
	for _, want := range []string{"Will apply: kernel and console again, staying at 0.6.0, with vennir.yaml's settings", "Nothing in vennir.yaml changed since the last apply."} {
		if !strings.Contains(got, want) {
			t.Errorf("no %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "upgrade") || strings.Contains(got, "External Secrets") {
		t.Errorf("nothing to upgrade or install:\n%s", got)
	}

	c.Gateway.BackendHosts = []string{"api.example.com"}
	c.Size = "resilient"
	now.externalSecrets = "external-secrets-2.9.0"
	got = changes(buildPlan(context.Background(), c, "dev", s, install.Images{}, installed, now, nil))
	for _, want := range []string{
		"Changed: since the last apply: gateway.backendHosts, size",
		"Will upgrade: External Secrets Operator (now external-secrets-2.9.0) to " + install.ExternalSecretsChart,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("no %q in:\n%s", want, got)
		}
	}

	now.externalSecrets = "external-secrets-99.0.0"
	if got = changes(buildPlan(context.Background(), c, "dev", s, install.Images{}, installed, now, nil)); !strings.Contains(got, "Will downgrade: External Secrets Operator (now external-secrets-99.0.0, newer)") {
		t.Errorf("a newer one is downgraded, and said so:\n%s", got)
	}
}
