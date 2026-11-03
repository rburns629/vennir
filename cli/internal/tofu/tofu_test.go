// SPDX-License-Identifier: MIT

package tofu

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/rburns629/vertra/cli/internal/modules"
	"github.com/rburns629/vertra/cli/internal/run"
)

// A trimmed `tofu show -json` of a first gcp plan.
const planJSON = `{"resource_changes":[
 {"address":"data.google_project.this","mode":"data","type":"google_project","change":{"actions":["read"]}},
 {"address":"google_container_cluster.this","mode":"managed","type":"google_container_cluster","change":{"actions":["create"]}},
 {"address":"google_container_node_pool.steps[0]","mode":"managed","type":"google_container_node_pool","change":{"actions":["create"]}},
 {"address":"google_container_node_pool.platform[0]","mode":"managed","type":"google_container_node_pool","change":{"actions":["create"]}},
 {"address":"google_project_iam_member.nodes[\"a\"]","mode":"managed","type":"google_project_iam_member","change":{"actions":["create"]}},
 {"address":"google_storage_bucket_iam_member.backup[\"b\"]","mode":"managed","type":"google_storage_bucket_iam_member","change":{"actions":["create"]}},
 {"address":"google_compute_network.this","mode":"managed","type":"google_compute_network","change":{"actions":["no-op"]}},
 {"address":"google_storage_bucket.backups[0]","mode":"managed","type":"google_storage_bucket","change":{"actions":["update"]}},
 {"address":"google_service_account.console","mode":"managed","type":"google_service_account","change":{"actions":["delete","create"]}}
]}`

func TestSummary(t *testing.T) {
	changes, err := parsePlan([]byte(planJSON))
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 7 {
		t.Fatalf("data sources and no-ops are left out: %+v", changes)
	}
	s := Summary(changes)
	for action, want := range map[string]string{
		"create":  "cluster, 2 node pools, 2 permissions",
		"update":  "bucket",
		"replace": "service account",
	} {
		if s[action] != want {
			t.Errorf("%s: %q, want %q", action, s[action], want)
		}
	}
}

func TestTheGCPModuleIsEmbedded(t *testing.T) {
	names := map[string]bool{}
	for _, n := range modules.Names("gcp") {
		names[n] = true
	}
	for _, want := range []string{"main.tf", "variables.tf", "outputs.tf", "versions.tf", ".terraform.lock.hcl"} {
		if !names[want] {
			t.Errorf("%s isn't embedded (have %v)", want, names)
		}
	}
}

// Every resource a module makes has a name on the approval screen, never
// its OpenTofu type.
func TestEveryResourceTypeIsNamed(t *testing.T) {
	declared := regexp.MustCompile(`(?m)^resource "([a-z0-9_]+)"`)
	for _, cloud := range []string{"gcp", "aws"} {
		for _, file := range modules.Names(cloud) {
			if !strings.HasSuffix(file, ".tf") {
				continue
			}
			data, err := modules.Read(cloud, file)
			if err != nil {
				t.Fatal(err)
			}
			for _, m := range declared.FindAllStringSubmatch(string(data), -1) {
				if _, ok := names[m[1]]; !ok {
					t.Errorf("%s/%s: %s has no name in names", cloud, file, m[1])
				}
			}
		}
	}
}

// fakeTofu answers `state list` with the given state and, as OpenTofu does,
// refuses a `state rm` of anything that isn't in it. It records what rm
// removed in the returned file.
func fakeTofu(t *testing.T, state ...string) (*run.Runner, string) {
	t.Helper()
	dir := t.TempDir()
	stateFile := filepath.Join(dir, "state")
	removed := filepath.Join(dir, "removed")
	if err := os.WriteFile(stateFile, []byte(strings.Join(state, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
shift # -chdir
case "$1 $2" in
"state list") cat "` + stateFile + `" ;;
"state rm")
  shift 2
  for a in "$@"; do
    grep -qxF "$a" "` + stateFile + `" || { echo "No matching objects found" >&2; exit 1; }
  done
  for a in "$@"; do echo "$a" >> "` + removed + `"; done ;;
*) exit 2 ;;
esac
`
	bin := filepath.Join(dir, "tofu")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return &run.Runner{Out: io.Discard, Err: io.Discard, Resolve: func(string) string { return bin }}, removed
}

// A managed database's install has no backup bucket, though destroy keeps
// it: Forget leaves out what the state doesn't have.
func TestForgetSkipsWhatTheStateDoesntHave(t *testing.T) {
	r, removed := fakeTofu(t, "google_container_cluster.this", "google_sql_database_instance.this[0]",
		`google_sql_database.this["execution_kernel"]`)
	if err := In(r, t.TempDir()).Forget(context.Background(), "google_storage_bucket.backups[0]",
		"google_sql_database_instance.this[0]", `google_sql_database.this["execution_kernel"]`); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(removed)
	if err != nil {
		t.Fatal(err)
	}
	if want := "google_sql_database_instance.this[0]\ngoogle_sql_database.this[\"execution_kernel\"]\n"; string(got) != want {
		t.Errorf("removed %q, want %q", got, want)
	}
}

func TestForgetWithNothingInStateRemovesNothing(t *testing.T) {
	r, removed := fakeTofu(t, "google_container_cluster.this")
	if err := In(r, t.TempDir()).Forget(context.Background(), "aws_s3_bucket.backups[0]"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(removed); !os.IsNotExist(err) {
		t.Errorf("state rm ran: %v", err)
	}
}
