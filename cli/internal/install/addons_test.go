// SPDX-License-Identifier: MIT

package install

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/rburns629/vertra/cli/internal/run"
)

// Only the add-ons an apply recorded are offered to destroy, once each, in
// AddOns' order; a folder with no record has none.
func TestRecordedAddOns(t *testing.T) {
	dir := t.TempDir()
	if got := RecordedAddOns(dir); len(got) != 0 {
		t.Fatalf("no record: %v", got)
	}
	for _, a := range []AddOn{CertManagerAddOn, PolicyControllerAddOn, CertManagerAddOn} {
		if err := RecordAddOn(dir, a); err != nil {
			t.Fatal(err)
		}
	}
	if got := RecordedAddOns(dir); !slices.Equal(got, []AddOn{PolicyControllerAddOn, CertManagerAddOn}) {
		t.Errorf("recorded %v", got)
	}
	data, _ := os.ReadFile(filepath.Join(dir, AddOnsFile))
	if strings.Count(string(data), "cert-manager\n") != 1 || strings.Contains(string(data), "external-secrets") {
		t.Errorf("the file: %q", data)
	}
}

// An add-on is recorded as this environment's only when helm confirms its
// release isn't there; helm failing isn't taken for "not installed".
func TestRecordIfMissing(t *testing.T) {
	for _, tc := range []struct {
		name, script  string
		recorded, err bool
	}{
		{"not installed", "exit 0", true, false},
		{"someone else's", "echo external-secrets", false, false},
		{"helm can't tell", "echo 'Kubernetes cluster unreachable' >&2; exit 1", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bin := t.TempDir()
			script := filepath.Join(bin, "helm")
			if err := os.WriteFile(script, []byte("#!/bin/sh\necho \"$@\" > \""+bin+"/args\"\n"+tc.script+"\n"), 0o755); err != nil {
				t.Fatal(err)
			}
			r := &run.Runner{Out: os.Stdout, Err: os.Stderr, Resolve: func(string) string { return script }}
			dir := t.TempDir()
			err := RecordIfMissing(context.Background(), r, kindConfig(), dir, ExternalSecretsAddOn)
			if (err != nil) != tc.err {
				t.Errorf("err = %v", err)
			}
			if got := len(RecordedAddOns(dir)) == 1; got != tc.recorded {
				t.Errorf("recorded = %v", got)
			}
			args, _ := os.ReadFile(filepath.Join(bin, "args"))
			if !strings.Contains(string(args), "list") || !strings.Contains(string(args), "--namespace external-secrets --all --filter ^external-secrets$") {
				t.Errorf("args: %s", args)
			}
		})
	}
}

// The team namespaces destroy may delete are the console's, by its label;
// those labelled vertra/team by hand are listed apart.
func TestTeamNamespaces(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "kubectl")
	body := `#!/bin/sh
echo "$@" >> "` + dir + `/args"
case "$*" in
  *"managed-by=vertra-console"*) printf 'platform payments' ;;
  *"managed-by!=vertra-console"*) printf 'default legacy' ;;
esac
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	r := &run.Runner{Out: os.Stdout, Err: os.Stderr, Resolve: func(string) string { return script }}
	made, others, err := TeamNamespaces(context.Background(), r, kindConfig())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(made, []string{"platform", "payments"}) || !slices.Equal(others, []string{"default", "legacy"}) {
		t.Errorf("made %v, others %v", made, others)
	}
	args, _ := os.ReadFile(filepath.Join(dir, "args"))
	if !strings.Contains(string(args), "get namespace -l vertra/team,app.kubernetes.io/managed-by=vertra-console") {
		t.Errorf("args: %s", args)
	}

	r = &run.Runner{Out: os.Stdout, Err: os.Stderr, Resolve: func(string) string { return "/nonexistent/kubectl" }}
	if _, _, err := TeamNamespaces(context.Background(), r, kindConfig()); err == nil {
		t.Error("a failed listing isn't an empty one")
	}
}
