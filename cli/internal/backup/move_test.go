// SPDX-License-Identifier: MIT

package backup

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/rburns629/vennir/cli/internal/install"
)

func TestMoveJobsSignInAsTheirServiceAndReachThePostgres(t *testing.T) {
	for _, tc := range []struct {
		db  *install.ManagedDatabase
		tls bool
	}{
		{&install.ManagedDatabase{Provider: "gcp", Host: "10.0.0.5", KernelUser: "vennir-kernel@acme.iam"}, true},
		{&install.ManagedDatabase{Provider: "aws", Host: "vennir.abc.us-east-2.rds.amazonaws.com", Region: "us-east-2", KernelUser: "kernel"}, false},
	} {
		target := tc.db.URL(tc.db.KernelUser, "execution_kernel")
		manifest := moveJob("vennir-move-kernel", "kernel-execution-kernel", "ghcr.io/x/execution-kernel:0.6.0", "postgres:16.15", "execution_kernel", tc.db, target, tc.tls)
		var job struct {
			Spec struct {
				Template struct {
					Metadata struct{ Labels map[string]string }
					Spec     struct {
						ServiceAccountName string `yaml:"serviceAccountName"`
						InitContainers     []struct {
							Command      []string
							Env          []struct{ Name, Value string }
							VolumeMounts []struct {
								Name      string
								MountPath string `yaml:"mountPath"`
							} `yaml:"volumeMounts"`
						} `yaml:"initContainers"`
						Containers []struct {
							Command      []string
							Env          []struct{ Name, Value string }
							VolumeMounts []struct{ Name string } `yaml:"volumeMounts"`
						}
						Volumes []struct{ Name string }
					}
				}
			}
		}
		if err := yaml.Unmarshal([]byte(manifest), &job); err != nil {
			t.Fatalf("%s: %v\n%s", tc.db.Provider, err, manifest)
		}
		spec := job.Spec.Template.Spec
		// The in-cluster Postgres's NetworkPolicy admits the kernel release's Pods.
		if l := job.Spec.Template.Metadata.Labels; l["app.kubernetes.io/name"] != "execution-kernel" || l["app.kubernetes.io/instance"] != "kernel" {
			t.Errorf("%s: labels %v", tc.db.Provider, l)
		}
		if spec.ServiceAccountName != "kernel-execution-kernel" || len(spec.InitContainers) != 1 || spec.InitContainers[0].Command[1] != "database-token" {
			t.Errorf("%s: sign-in %+v", tc.db.Provider, spec)
		}
		// pgx reads the CA the URL names as it parses it.
		mounts := map[string]string{}
		for _, m := range spec.InitContainers[0].VolumeMounts {
			mounts[m.Name] = m.MountPath
		}
		if mounts["db-ca"] != "/etc/vennir/tls-db" || mounts["token"] != "/token" {
			t.Errorf("%s: token mounts %v", tc.db.Provider, mounts)
		}
		env := map[string]string{}
		for _, e := range spec.InitContainers[0].Env {
			env[e.Name] = e.Value
		}
		if env["DATABASE_URL"] != target || env["DATABASE_IAM_AUTH"] != tc.db.Provider || (tc.db.Provider == "aws") != (env["DATABASE_IAM_REGION"] == "us-east-2") {
			t.Errorf("%s: token env %v", tc.db.Provider, env)
		}
		copyEnv := map[string]string{}
		for _, e := range spec.Containers[0].Env {
			copyEnv[e.Name] = e.Value
		}
		wantMode := map[bool]string{true: "verify-full", false: "prefer"}[tc.tls]
		if copyEnv["TARGET"] != target || copyEnv["SOURCE_SSLMODE"] != wantMode || (copyEnv["PGSSLROOTCERT"] != "") != tc.tls {
			t.Errorf("%s: copy env %v", tc.db.Provider, copyEnv)
		}
		if mounts := len(spec.Containers[0].VolumeMounts); mounts != map[bool]int{true: 3, false: 2}[tc.tls] || len(spec.Volumes) != mounts {
			t.Errorf("%s: %d mounts, %d volumes", tc.db.Provider, mounts, len(spec.Volumes))
		}
		// Each side's password only for its own command, and never over data.
		script := spec.Containers[0].Command[2]
		for _, want := range []string{`PGPASSWORD="$SOURCE_PASSWORD" PGSSLMODE="$SOURCE_SSLMODE" pg_dump`, "--single-transaction", "--no-owner", "already has $tables tables"} {
			if !strings.Contains(script, want) {
				t.Errorf("%s: script lacks %q", tc.db.Provider, want)
			}
		}
	}
}
