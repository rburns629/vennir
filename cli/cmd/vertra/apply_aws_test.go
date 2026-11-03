// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/run"
	"github.com/rburns629/vertra/cli/internal/tofu"
)

const providerARN = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"

// awsTools fakes tofu and aws: the state holds the GitHub provider when
// inState, and then IAM doesn't list it yet (it was made moments ago);
// otherwise the account has it. Every call is logged to the returned file.
func awsTools(t *testing.T, inState bool) (*run.Runner, string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	state, listed := "", `,{"Arn":"`+providerARN+`"}`
	if inState {
		state, listed = githubProvider, ""
	}
	scripts := map[string]string{
		"tofu": `echo "tofu $*" >> "` + log + `"
case "$*" in
  *"state list"*) [ -n "` + state + `" ] && echo "` + state + `" ;;
  *"show -json"*) echo '{"values":{"root_module":{"resources":[{"address":"` + state + `","values":{"arn":"` + providerARN + `"}}]}}}' ;;
esac
exit 0
`,
		"aws": `echo "aws $*" >> "` + log + `"
echo '{"OpenIDConnectProviderList":[{"Arn":"arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-2.amazonaws.com/id/X"}` + listed + `]}'
`,
	}
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return &run.Runner{Out: os.Stderr, Err: os.Stderr, Resolve: func(name string) string { return filepath.Join(dir, name) }}, log
}

func writtenGitHubProvider(t *testing.T, tf tofu.Dir) any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(tf.Path, "vertra.auto.tfvars.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vars map[string]any
	if err := json.Unmarshal(data, &vars); err != nil {
		t.Fatal(err)
	}
	return vars["github_oidc_provider_arn"]
}

// The install that made the account's GitHub provider forgets it, so its
// destroy (or clearing its catalog) can't delete it from under another
// install, taking its ARN from the state (IAM may not list it yet), and
// then uses it as any other install does.
func TestWriteAWSVarsLeavesTheGitHubProviderToTheAccount(t *testing.T) {
	for _, tc := range []struct {
		name          string
		inState       bool
		catalog       bool
		forgets       bool
		wantsProvider string
	}{
		{"made by this install", true, true, true, providerARN},
		{"made by this install, catalog cleared", true, false, true, ""},
		{"made by another install", false, true, false, providerARN},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, log := awsTools(t, tc.inState)
			a := &app{runner: r}
			c := config.Default("aws")
			c.AWS.Region = "us-east-2"
			if tc.catalog {
				c.Catalog.Owner, c.Catalog.Repository = "acme", "catalog"
			}
			tf := tofu.In(r, t.TempDir())
			if err := os.MkdirAll(tf.Path, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := a.writeAWSVars(context.Background(), c, tf, false); err != nil {
				t.Fatal(err)
			}
			calls, _ := os.ReadFile(log)
			if forgot := strings.Contains(string(calls), "state rm "+githubProvider); forgot != tc.forgets {
				t.Errorf("forgot the provider: %v, want %v; calls:\n%s", forgot, tc.forgets, calls)
			}
			if listed := strings.Contains(string(calls), "list-open-id-connect-providers"); listed == tc.inState {
				t.Errorf("listed the account's providers: %v; calls:\n%s", listed, calls)
			}
			if got := writtenGitHubProvider(t, tf); got != tc.wantsProvider {
				t.Errorf("github_oidc_provider_arn = %v, want %q", got, tc.wantsProvider)
			}
		})
	}
}
