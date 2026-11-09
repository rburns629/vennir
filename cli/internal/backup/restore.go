// SPDX-License-Identifier: MIT

package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strconv"

	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/install"
	"github.com/roburns/vennir/cli/internal/platform"
	"github.com/roburns/vennir/cli/internal/run"
)

// writers are the Deployments that write to the databases, stopped while
// they're replaced: started again in this order.
var writers = []string{
	install.KernelRelease + "-execution-kernel-api",
	install.KernelRelease + "-execution-kernel-scheduler",
	// kernel policy (the kernel chart's catalogPolicy): its applied
	// release and the releases it lists live in the kernel's database.
	install.KernelRelease + "-execution-kernel-policy",
	install.ConsoleRelease + "-execution-console",
	install.ConsoleRelease + "-execution-console-gateway",
}

// restoreRecord keeps the writers' copies while a restore runs, so a
// restore that failed partway can be run again and still start them at
// what they were.
const restoreRecord = "vennir-restore"

// restoreScript replaces both databases with the dumps at $1 (the
// kernel's) and $2 (the console's), as the Postgres superuser, keeping
// each owned by its own role (the kernel's, once the install has one) and
// reachable only by it (and the gateway's, for the console's).
const restoreScript = `set -eu
export PGUSER=postgres
kernel_owner=postgres
if [ "$(psql -Atc "SELECT 1 FROM pg_roles WHERE rolname = '` + kernelRole + `'")" = 1 ]; then kernel_owner=` + kernelRole + `; fi
dropdb --force ` + kernelDatabase + `
createdb -O "$kernel_owner" ` + kernelDatabase + `
pg_restore --exit-on-error --no-owner --role="$kernel_owner" -d ` + kernelDatabase + ` "$1"
dropdb --force ` + consoleDatabase + `
createdb -O ` + consoleRole + ` ` + consoleDatabase + `
pg_restore --exit-on-error --no-owner --role=` + consoleRole + ` -d ` + consoleDatabase + ` "$2"
psql -v ON_ERROR_STOP=1 -q \
  -c 'REVOKE CONNECT ON DATABASE ` + kernelDatabase + ` FROM PUBLIC' \
  -c 'REVOKE CONNECT ON DATABASE ` + consoleDatabase + ` FROM PUBLIC' \
  -c 'GRANT CONNECT ON DATABASE ` + consoleDatabase + ` TO ` + consoleRole + `' \
  -c "GRANT CONNECT ON DATABASE ` + kernelDatabase + ` TO $kernel_owner"
if [ "$(psql -Atc "SELECT 1 FROM pg_roles WHERE rolname = '` + gatewayRole + `'")" = 1 ]; then
  psql -v ON_ERROR_STOP=1 -q -c 'GRANT CONNECT ON DATABASE ` + consoleDatabase + ` TO ` + gatewayRole + `'
fi
rm -f "$1" "$2"`

// Restore replaces both databases of the in-cluster Postgres with a pair
// on this machine: it stops what writes to them (and the sleeper),
// restores, and starts them again at the copies they had. If it fails
// partway, what writes stays stopped and running it again finishes the
// job. It says when the backup's schema is older than the one replaced,
// which `vennir apply` migrates forward.
func Restore(ctx context.Context, r *run.Runner, c *config.Config, out io.Writer, p Pair) error {
	deps, err := platform.Deployments(ctx, r, c)
	if err != nil {
		return err
	}
	if platform.Asleep(deps) {
		return fmt.Errorf("the platform is asleep: `vennir wake` first")
	}
	kernelBefore, consoleBefore := schemaVersions(ctx, r, c)

	// The dumps go in and are checked first: a bad one stops nothing.
	fmt.Fprintln(out, "Copying the backup into the Postgres Pod and checking it...")
	const kernelIn, consoleIn = "/tmp/vennir-restore-kernel.pgdump", "/tmp/vennir-restore-console.pgdump"
	for _, f := range [][2]string{{p.Kernel, kernelIn}, {p.Console, consoleIn}} {
		if err := copyIn(ctx, r, c, f[0], f[1]); err != nil {
			return err
		}
		if _, err := r.Output(ctx, "kubectl", kubectl(c, "exec", "deploy/"+postgresDeployment, "--container", "postgres", "--",
			"pg_restore", "--list", f[1])...); err != nil {
			return fmt.Errorf("%s isn't a whole dump (nothing was changed): %w", f[0], err)
		}
	}
	replicas, err := recordWriters(ctx, r, c, deps)
	if err != nil {
		return err
	}

	fmt.Fprintln(out, "Stopping what writes to the databases...")
	if err := platform.SuspendSleeper(ctx, r, c, true); err != nil {
		return err
	}
	for _, name := range writers {
		if _, ok := replicas[name]; !ok {
			continue
		}
		if err := r.Run(ctx, "kubectl", kubectl(c, "scale", "deployment", name, "--replicas=0")...); err != nil {
			return err
		}
	}
	// The scheduler releases its leases on the way out.
	if err := r.Run(ctx, "kubectl", kubectl(c, "wait", "--for=delete", "pod", "--timeout=5m", "--selector",
		"app.kubernetes.io/instance in ("+install.KernelRelease+","+install.ConsoleRelease+"),app.kubernetes.io/component in (api,scheduler,policy,app,gateway)")...); err != nil {
		return err
	}

	fmt.Fprintf(out, "Restoring the backup of %s...\n", p.Timestamp)
	if err := r.Run(ctx, "kubectl", kubectl(c, "exec", "deploy/"+postgresDeployment, "--container", "postgres", "--",
		"sh", "-c", restoreScript, "sh", kernelIn, consoleIn)...); err != nil {
		return stopped(err)
	}
	kernelAfter, consoleAfter := schemaVersions(ctx, r, c)

	fmt.Fprintln(out, "Starting them again...")
	for _, name := range writers {
		n, ok := replicas[name]
		if !ok {
			continue
		}
		if err := r.Run(ctx, "kubectl", kubectl(c, "scale", "deployment", name, "--replicas="+strconv.Itoa(n))...); err != nil {
			return err
		}
	}
	older := isOlder(kernelAfter, kernelBefore) || isOlder(consoleAfter, consoleBefore)
	// kernel-api and the scheduler aren't ready until the schema is current:
	// with an older one, they wait for vennir apply instead.
	for _, name := range writers {
		if replicas[name] == 0 || older {
			continue
		}
		if err := r.Run(ctx, "kubectl", kubectl(c, "rollout", "status", "deployment/"+name, "--timeout=10m")...); err != nil {
			return err
		}
	}
	if err := platform.SuspendSleeper(ctx, r, c, false); err != nil {
		return err
	}
	if err := r.Run(ctx, "kubectl", kubectl(c, "delete", "configmap", restoreRecord, "--ignore-not-found")...); err != nil {
		return err
	}
	if older {
		fmt.Fprintln(out, "The backup's schema is older than the one it replaced: run `vennir apply` to migrate it forward (kernel-api and the scheduler wait until then).")
	}
	return nil
}

// recordWriters keeps the writers' copies in a ConfigMap, or reads them
// from the one a failed restore left.
func recordWriters(ctx context.Context, r *run.Runner, c *config.Config, deps []platform.Deployment) (map[string]int, error) {
	replicas := map[string]int{}
	if out, err := r.Output(ctx, "kubectl", kubectl(c, "get", "configmap", restoreRecord, "--ignore-not-found", "-o", "jsonpath={.data.replicas}")...); err == nil && out != "" {
		if err := json.Unmarshal([]byte(out), &replicas); err == nil {
			return replicas, nil
		}
	}
	for _, d := range deps {
		for _, w := range writers {
			if d.Name == w {
				replicas[w] = d.Replicas
			}
		}
	}
	record, err := json.Marshal(replicas)
	if err != nil {
		return nil, err
	}
	manifest := fmt.Sprintf(`{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":%q,"namespace":%q},"data":{"replicas":%q}}`,
		restoreRecord, c.Namespace, string(record))
	return replicas, r.RunInput(ctx, manifest, "kubectl", kubectl(c, "apply", "-f", "-")...)
}

func stopped(err error) error {
	return fmt.Errorf("%w\nWhat writes to the databases is still stopped: run the restore again (it starts them at their old copies once it succeeds)", err)
}

// isOlder says a schema version is behind another (both counts or numbers;
// unknown is never older).
func isOlder(after, before string) bool {
	a, errA := strconv.Atoi(after)
	b, errB := strconv.Atoi(before)
	return errA == nil && errB == nil && a < b
}
