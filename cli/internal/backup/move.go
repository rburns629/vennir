// SPDX-License-Identifier: MIT

package backup

import (
	"context"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/install"
	"github.com/roburns/vennir/cli/internal/platform"
	"github.com/roburns/vennir/cli/internal/run"
)

// Moving an install's data from its in-cluster Postgres into a managed
// server (database.type changed to managed): after database-setup has
// opened the server's databases to the services, and before the charts
// switch to it.
//
// Each database is copied by a Job in the cluster (the data never passes
// through this machine): pg_dump from the in-cluster Postgres, piped into
// pg_restore on the server as the database's own service (so it owns what
// it restores, as when its migrations make it), in one transaction (a
// failure leaves the server's database empty). The service signs in with
// its token, which `kernel database-token` writes for pg_restore. The
// in-cluster Postgres's volume is kept: the way back.

// NeedsMove says the install's data is still in its in-cluster Postgres:
// its Deployment is there (the charts remove it once they use a managed
// server, keeping its volume).
func NeedsMove(ctx context.Context, r *run.Runner, c *config.Config) bool {
	out, err := r.Output(ctx, "kubectl", kubectl(c, "get", "deployment", postgresDeployment, "--ignore-not-found", "-o", "name")...)
	return err == nil && out != ""
}

// The ServiceAccounts the kernel's and the console's Pods run as.
const (
	kernelServiceAccount  = install.KernelRelease + "-execution-kernel"
	consoleServiceAccount = install.ConsoleRelease + "-execution-console"
)

// MoveToManaged stops what writes to the databases and copies both into
// the managed server. On success what writes stays stopped, for the charts
// to start on the server (then FinishMove); on failure it's started again
// on the in-cluster Postgres, nothing having switched. consoleIdentity is
// the console's Google service account (gcp).
func MoveToManaged(ctx context.Context, r *run.Runner, c *config.Config, out io.Writer, db *install.ManagedDatabase, kernelImage, consoleIdentity string) error {
	deps, err := platform.Deployments(ctx, r, c)
	if err != nil {
		return err
	}
	if platform.Asleep(deps) {
		return fmt.Errorf("the platform is asleep: `vennir wake`, then apply again to move its data")
	}
	postgresImage, err := r.Output(ctx, "kubectl", kubectl(c, "get", "deployment", postgresDeployment,
		"-o", `jsonpath={.spec.template.spec.containers[?(@.name=="postgres")].image}`)...)
	if err != nil || postgresImage == "" {
		return fmt.Errorf("the in-cluster Postgres's image: %v", err)
	}
	// Where to sign in on gcp: the annotation the charts give these
	// ServiceAccounts with a managed database (the same value, so Helm's
	// server-side apply takes it over without a conflict), here before the
	// charts: the copy runs as them, and so does the kernel's migration,
	// a hook that runs before Helm updates the ServiceAccounts.
	if db.Provider == "gcp" {
		for sa, identity := range map[string]string{
			kernelServiceAccount: db.KernelServiceAccount, kernelServiceAccount + "-api": db.KernelServiceAccount,
			consoleServiceAccount: consoleIdentity,
		} {
			if err := r.Run(ctx, "kubectl", kubectl(c, "annotate", "serviceaccount", sa, "--overwrite",
				"iam.gke.io/gcp-service-account="+identity)...); err != nil {
				return err
			}
		}
	}
	sourceTLS := r.Succeeds(ctx, "kubectl", kubectl(c, "get", "secret", install.KernelRelease+"-execution-kernel-tls-ca")...)

	replicas, err := recordWriters(ctx, r, c, deps)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "Stopping what writes to the databases...")
	if err := stopWriters(ctx, r, c, replicas); err != nil {
		return err
	}

	// What an earlier run copied stays current while what writes has
	// stayed stopped since, which the record's being there says.
	copied := copiedDatabases(ctx, r, c)
	moves := []struct{ job, database, user, serviceAccount string }{
		{"vennir-move-kernel", kernelDatabase, db.KernelUser, kernelServiceAccount},
		{"vennir-move-console", consoleDatabase, db.ConsoleUser, consoleServiceAccount},
	}
	var pending []func()
	errs := make([]error, len(moves))
	for i, m := range moves {
		if copied[m.database] {
			fmt.Fprintf(out, "%s was copied by an earlier run (nothing has written since).\n", m.database)
			continue
		}
		pending = append(pending, func() {
			manifest := moveJob(m.job, m.serviceAccount, kernelImage, postgresImage, m.database, db, db.URL(m.user, m.database), sourceTLS)
			if errs[i] = runJob(ctx, r, c, m.job, manifest, 2*time.Hour); errs[i] == nil {
				errs[i] = markCopied(ctx, r, c, m.database)
			}
		})
	}
	if len(pending) > 0 {
		fmt.Fprintln(out, "Copying the databases into the managed server...")
	}
	run.Together(pending...)
	for _, err := range errs {
		if err == nil {
			continue
		}
		if len(copiedDatabases(ctx, r, c)) > 0 {
			// Starting again would make the copy that's done stale.
			return fmt.Errorf("%w\nWhat writes stays stopped, the in-cluster Postgres unchanged: apply again to copy the rest (or set database.type back to in-cluster and apply, to start as before)", err)
		}
		fmt.Fprintln(out, "The copy failed: starting the platform again on the in-cluster Postgres (nothing switched)...")
		if startErr := startWriters(ctx, r, c, replicas); startErr != nil {
			return fmt.Errorf("%w; and starting again: %v", err, startErr)
		}
		return err
	}
	return nil
}

// copiedDatabases are the databases a move has copied while what writes
// has been stopped (kept with the writers' copies, gone once they start).
func copiedDatabases(ctx context.Context, r *run.Runner, c *config.Config) map[string]bool {
	out, _ := r.Output(ctx, "kubectl", kubectl(c, "get", "configmap", restoreRecord, "--ignore-not-found", "-o", "jsonpath={.data.copied}")...)
	copied := map[string]bool{}
	for _, d := range strings.Fields(out) {
		copied[d] = true
	}
	return copied
}

// markCopied adds a database to the record's copied ones.
func markCopied(ctx context.Context, r *run.Runner, c *config.Config, database string) error {
	moveMarks.Lock()
	defer moveMarks.Unlock()
	copied := copiedDatabases(ctx, r, c)
	copied[database] = true
	var names []string
	for d := range copied {
		names = append(names, d)
	}
	slices.Sort(names)
	patch := fmt.Sprintf(`{"data":{"copied":%q}}`, strings.Join(names, " "))
	return r.Run(ctx, "kubectl", kubectl(c, "patch", "configmap", restoreRecord, "--type", "merge", "--patch", patch)...)
}

// moveMarks keeps the two copies' marks from overwriting each other.
var moveMarks sync.Mutex

// FinishMove starts what writes again once the charts use the managed
// server: the charts set their copies, except where an autoscaler owns
// them (the auto size), which a Deployment at zero never wakes.
func FinishMove(ctx context.Context, r *run.Runner, c *config.Config) error {
	deps, err := platform.Deployments(ctx, r, c)
	if err != nil {
		return err
	}
	replicas, err := recordWriters(ctx, r, c, deps)
	if err != nil {
		return err
	}
	return startWriters(ctx, r, c, replicas)
}

func stopWriters(ctx context.Context, r *run.Runner, c *config.Config, replicas map[string]int) error {
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
	return r.Run(ctx, "kubectl", kubectl(c, "wait", "--for=delete", "pod", "--timeout=5m", "--selector",
		"app.kubernetes.io/instance in ("+install.KernelRelease+","+install.ConsoleRelease+"),app.kubernetes.io/component in (api,scheduler,policy,app,gateway)")...)
}

// startWriters starts each writer at zero at its recorded copies, waits
// until it's ready, and forgets the record.
func startWriters(ctx context.Context, r *run.Runner, c *config.Config, replicas map[string]int) error {
	deps, err := platform.Deployments(ctx, r, c)
	if err != nil {
		return err
	}
	now := map[string]int{}
	for _, d := range deps {
		now[d.Name] = d.Replicas
	}
	for _, name := range writers {
		if n := replicas[name]; n > 0 && now[name] == 0 {
			if err := r.Run(ctx, "kubectl", kubectl(c, "scale", "deployment", name, "--replicas="+strconv.Itoa(n))...); err != nil {
				return err
			}
		}
	}
	for _, name := range writers {
		if replicas[name] == 0 {
			continue
		}
		if err := r.Run(ctx, "kubectl", kubectl(c, "rollout", "status", "deployment/"+name, "--timeout=10m")...); err != nil {
			return err
		}
	}
	if err := platform.SuspendSleeper(ctx, r, c, false); err != nil {
		return err
	}
	return r.Run(ctx, "kubectl", kubectl(c, "delete", "configmap", restoreRecord, "--ignore-not-found")...)
}

// runJob applies a Job (replacing one left from an earlier run) and waits
// for it; on failure, with the end of its log.
func runJob(ctx context.Context, r *run.Runner, c *config.Config, job, manifest string, limit time.Duration) error {
	if err := r.Run(ctx, "kubectl", kubectl(c, "delete", "job", job, "--ignore-not-found", "--wait")...); err != nil {
		return err
	}
	if err := r.RunInput(ctx, manifest, "kubectl", kubectl(c, "apply", "-f", "-")...); err != nil {
		return err
	}
	if err := waitForJob(ctx, r, c, job, limit); err != nil {
		// Each container's own: one that never started fails --all-containers.
		var logs []string
		for _, container := range []string{"token", "copy"} {
			if out, _ := r.Output(ctx, "kubectl", kubectl(c, "logs", "job/"+job, "--container", container, "--tail", "30")...); out != "" {
				logs = append(logs, out)
			}
		}
		return fmt.Errorf("%w\n%s", err, strings.Join(logs, "\n"))
	}
	return nil
}

// moveScript copies $DATABASE from the in-cluster Postgres into $TARGET
// (the server's URL), refusing a target that already has tables (its data
// is never replaced). Each side's password is set for its command only.
const moveScript = `set -eu
tables=$(PGPASSWORD="$(cat /token/password)" psql "$TARGET" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")
if [ "$tables" != 0 ]; then
  echo "$DATABASE on the managed server already has $tables tables: not copying over them" >&2
  exit 1
fi
PGPASSWORD="$SOURCE_PASSWORD" PGSSLMODE="$SOURCE_SSLMODE" pg_dump -Fc -h "$SOURCE_HOST" -U postgres -d "$DATABASE" |
  PGPASSWORD="$(cat /token/password)" pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -d "$TARGET"
echo "copied $DATABASE"`

// moveJob is one database's copy, as serviceAccount: `kernel
// database-token` signs it in to the server first, then the Postgres
// image's pg_dump and pg_restore copy it. It carries the kernel release's
// labels, which the in-cluster Postgres's NetworkPolicy admits.
func moveJob(name, serviceAccount, kernelImage, postgresImage, database string, db *install.ManagedDatabase, target string, sourceTLS bool) string {
	iam := fmt.Sprintf(`            - {name: DATABASE_IAM_AUTH, value: %q}`, db.Provider)
	if db.Provider == "aws" {
		iam += fmt.Sprintf("\n            - {name: DATABASE_IAM_REGION, value: %q}", db.Region)
	}
	sslmode := `{name: SOURCE_SSLMODE, value: prefer}`
	caMount, caVolume := "", ""
	if sourceTLS {
		sslmode = `{name: SOURCE_SSLMODE, value: verify-full}
            - {name: PGSSLROOTCERT, value: /etc/vennir/tls/ca.crt}`
		caMount = "\n            - {name: tls-ca, mountPath: /etc/vennir/tls, readOnly: true}"
		caVolume = fmt.Sprintf("\n        - name: tls-ca\n          secret: {secretName: %s}", install.KernelRelease+"-execution-kernel-tls-ca")
	}
	return fmt.Sprintf(`apiVersion: batch/v1
kind: Job
metadata:
  name: %[1]s
  labels: {app.kubernetes.io/managed-by: vennir}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels:
        app.kubernetes.io/name: execution-kernel
        app.kubernetes.io/instance: %[2]s
        app.kubernetes.io/component: database-move
    spec:
      serviceAccountName: %[3]s
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 999
        runAsGroup: 999
        fsGroup: 999
        seccompProfile: {type: RuntimeDefault}
      initContainers:
        - name: token
          image: %[4]s
          command: ["/usr/local/bin/kernel", "database-token", "/token/password"]
          env:
            - {name: DATABASE_URL, value: %[5]q}
%[6]s
          volumeMounts:
            - {name: token, mountPath: /token}
            # The URL names the server's CA, which pgx reads as it parses it.
            - {name: db-ca, mountPath: /etc/vennir/tls-db, readOnly: true}
          resources:
            requests: {cpu: 50m, memory: 64Mi}
            limits: {memory: 128Mi}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
      containers:
        - name: copy
          image: %[7]s
          command: ["sh", "-c", %[8]q]
          env:
            - {name: DATABASE, value: %[9]q}
            - {name: TARGET, value: %[5]q}
            - {name: SOURCE_HOST, value: %[10]q}
            - name: SOURCE_PASSWORD
              valueFrom:
                secretKeyRef: {name: %[11]s, key: postgres-password}
            - %[12]s
          volumeMounts:
            - {name: token, mountPath: /token, readOnly: true}
            - {name: db-ca, mountPath: /etc/vennir/tls-db, readOnly: true}%[13]s
          resources:
            requests: {cpu: 250m, memory: 256Mi}
            limits: {memory: 1Gi}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: {drop: [ALL]}
      volumes:
        - name: token
          emptyDir: {medium: Memory}
        - name: db-ca
          secret: {secretName: %[14]s}%[15]s
`, name, install.KernelRelease, serviceAccount, kernelImage, target, iam, postgresImage, moveScript, database,
		postgresDeployment, install.KernelRelease+"-execution-kernel-db", sslmode, caMount, install.DatabaseCASecret, caVolume)
}
