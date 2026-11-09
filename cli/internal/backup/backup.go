// SPDX-License-Identifier: MIT

// Package backup takes, lists and restores backups of an install's
// databases. With the in-cluster Postgres (one instance holding the
// kernel's database and the console's) a backup is a pair of pg_dump
// files with one timestamp, laid out as the backup CronJob stores them
// (kernel/<timestamp>.pgdump, console/<timestamp>.pgdump), in its bucket or
// a folder here. A managed database's backups are its cloud's.
package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/roburns/vennir/cli/internal/cluster"
	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/install"
	"github.com/roburns/vennir/cli/internal/run"
)

// The in-cluster Postgres, as the kernel chart makes it for vennir (its
// consoleDatabase on, the chart's names).
const (
	postgresDeployment = install.KernelRelease + "-execution-kernel-postgres"
	backupCronJob      = install.KernelRelease + "-execution-kernel-pg-backup"
	kernelDatabase     = "execution_kernel"
	consoleDatabase    = "execution_console"
	consoleRole        = "console"
	// The kernel's own login role (the kernel chart's postgres.auth.kernelUsername).
	kernelRole  = "vennir_kernel"
	gatewayRole = "vennir_gateway"
	// The prefixes the backup CronJob stores each database's dumps under.
	kernelPrefix  = install.KernelRelease
	consolePrefix = "console"
)

// Pair is one backup of both databases: their dumps, taken together.
type Pair struct {
	Timestamp string // 2026-10-29T22-15-00Z, as the CronJob names them
	// Kernel and Console are the dumps' paths: in the bucket (from List)
	// or on this machine (from Dump, Download, InFolder).
	Kernel, Console string
}

var timestamp = regexp.MustCompile(`(?m)(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.pgdump$`)

func kubectl(c *config.Config, args ...string) []string {
	return append([]string{"--context", cluster.Context(c), "--namespace", c.Namespace}, args...)
}

// Destination is where the backup CronJob copies dumps: "gs://bucket" or
// "s3://bucket", from the kernel release's values; "" when backups are
// off (or go somewhere vennir can't read, a volume or Azure).
func Destination(ctx context.Context, r *run.Runner, c *config.Config) (string, error) {
	out, err := r.Output(ctx, "helm", "get", "values", install.KernelRelease, "--kube-context", cluster.Context(c),
		"--namespace", c.Namespace, "--all", "--output", "json")
	if err != nil {
		return "", err
	}
	var v struct {
		Backup struct {
			Enabled     bool   `json:"enabled"`
			Destination string `json:"destination"`
			GCS         struct {
				Bucket string `json:"bucket"`
			} `json:"gcs"`
			S3 struct {
				Bucket string `json:"bucket"`
			} `json:"s3"`
		} `json:"backup"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		return "", fmt.Errorf("the kernel release's values: %w", err)
	}
	switch b := v.Backup; {
	case !b.Enabled:
		return "", nil
	case b.Destination == "gcs" && b.GCS.Bucket != "":
		return "gs://" + b.GCS.Bucket, nil
	case b.Destination == "s3" && b.S3.Bucket != "":
		return "s3://" + b.S3.Bucket, nil
	}
	return "", nil
}

// RunNow runs the backup CronJob now, as a Job of its own, and waits for
// it: what it stored, as a pair.
func RunNow(ctx context.Context, r *run.Runner, c *config.Config, destination string) (Pair, error) {
	job := fmt.Sprintf("vennir-backup-%d", time.Now().Unix())
	if err := r.Run(ctx, "kubectl", kubectl(c, "create", "job", job, "--from=cronjob/"+backupCronJob)...); err != nil {
		return Pair{}, err
	}
	if err := waitForJob(ctx, r, c, job, 30*time.Minute); err != nil {
		logs, _ := r.Output(ctx, "kubectl", kubectl(c, "logs", "job/"+job, "--all-containers", "--tail", "20")...)
		return Pair{}, fmt.Errorf("%w\n%s", err, logs)
	}
	logs, err := r.Output(ctx, "kubectl", kubectl(c, "logs", "job/"+job, "--container", "pg-dump")...)
	if err != nil {
		return Pair{}, err
	}
	m := timestamp.FindStringSubmatch(logs)
	if m == nil {
		return Pair{}, fmt.Errorf("the backup Job %s finished, but its log names no dump", job)
	}
	return pairAt(destination, m[1]), nil
}

// waitForJob waits until a Job completes, or says it failed (its Pods are
// retried until its backoffLimit is spent).
func waitForJob(ctx context.Context, r *run.Runner, c *config.Config, job string, limit time.Duration) error {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		out, err := r.Output(ctx, "kubectl", kubectl(c, "get", "job", job, "-o", "json")...)
		if err != nil {
			return err
		}
		var j struct {
			Status struct {
				Conditions []struct{ Type, Status string } `json:"conditions"`
			} `json:"status"`
		}
		if err := json.Unmarshal([]byte(out), &j); err != nil {
			return err
		}
		for _, cond := range j.Status.Conditions {
			switch {
			case cond.Type == "Complete" && cond.Status == "True":
				return nil
			case cond.Type == "Failed" && cond.Status == "True":
				return fmt.Errorf("the Job %s failed", job)
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	return fmt.Errorf("the Job %s didn't finish in %s", job, limit)
}

func pairAt(base, ts string) Pair {
	return Pair{Timestamp: ts,
		Kernel:  base + "/" + kernelPrefix + "/" + ts + ".pgdump",
		Console: base + "/" + consolePrefix + "/" + ts + ".pgdump"}
}

// Dump dumps both databases from the in-cluster Postgres into folder, laid
// out as the bucket is. Each is dumped in the Postgres Pod, checked there
// with pg_restore --list, then copied here.
func Dump(ctx context.Context, r *run.Runner, c *config.Config, folder string) (Pair, error) {
	p := pairAt(folder, time.Now().UTC().Format("2006-01-02T15-04-05Z"))
	for _, d := range []struct{ database, path string }{{kernelDatabase, p.Kernel}, {consoleDatabase, p.Console}} {
		if err := os.MkdirAll(filepath.Dir(d.path), 0o700); err != nil {
			return Pair{}, err
		}
		if err := dumpOne(ctx, r, c, d.database, d.path); err != nil {
			return Pair{}, err
		}
	}
	return p, nil
}

func dumpOne(ctx context.Context, r *run.Runner, c *config.Config, database, path string) error {
	// The database's name is passed as $1, never written into the script.
	const script = `set -eu
f=$(mktemp)
trap 'rm -f "$f"' EXIT
pg_dump -U postgres -Fc -d "$1" -f "$f"
pg_restore --list "$f" > /dev/null
cat "$f"`
	f, err := os.OpenFile(path+".partial", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	err = r.ToWriter(ctx, f, "kubectl", kubectl(c, "exec", "deploy/"+postgresDeployment, "--container", "postgres", "--",
		"sh", "-c", script, "sh", database)...)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(path + ".partial")
		return fmt.Errorf("dumping %s: %w", database, err)
	}
	return os.Rename(path+".partial", path)
}

// InFolder is the newest pair in folder (laid out as Dump and Download
// leave it), or the one at ts.
func InFolder(folder, ts string) (Pair, error) {
	kernel, _ := filepath.Glob(filepath.Join(folder, kernelPrefix, "*.pgdump"))
	var stamps []string
	for _, k := range kernel {
		if m := timestamp.FindStringSubmatch(k); m != nil {
			if _, err := os.Stat(pairAt(folder, m[1]).Console); err == nil {
				stamps = append(stamps, m[1])
			}
		}
	}
	slices.Sort(stamps)
	switch {
	case len(stamps) == 0:
		return Pair{}, fmt.Errorf("no backup in %s: it holds %s/<time>.pgdump and %s/<time>.pgdump", folder, kernelPrefix, consolePrefix)
	case ts == "":
		return pairAt(folder, stamps[len(stamps)-1]), nil
	case slices.Contains(stamps, ts):
		return pairAt(folder, ts), nil
	}
	return Pair{}, fmt.Errorf("no backup at %s in %s (it has %s)", ts, folder, strings.Join(stamps, ", "))
}

// List is the pairs in the bucket, oldest first: those with both dumps.
func List(ctx context.Context, r *run.Runner, c *config.Config, destination string) ([]Pair, error) {
	var kernel, console []string
	var kernelErr, consoleErr error
	run.Together(
		func() { kernel, kernelErr = listObjects(ctx, r, c, destination+"/"+kernelPrefix+"/") },
		func() { console, consoleErr = listObjects(ctx, r, c, destination+"/"+consolePrefix+"/") },
	)
	if kernelErr != nil {
		return nil, kernelErr
	}
	if consoleErr != nil {
		return nil, consoleErr
	}
	consoleAt := map[string]bool{}
	for _, o := range console {
		if m := timestamp.FindStringSubmatch(o); m != nil {
			consoleAt[m[1]] = true
		}
	}
	var pairs []Pair
	for _, o := range kernel {
		if m := timestamp.FindStringSubmatch(o); m != nil && consoleAt[m[1]] {
			pairs = append(pairs, pairAt(destination, m[1]))
		}
	}
	slices.SortFunc(pairs, func(a, b Pair) int { return strings.Compare(a.Timestamp, b.Timestamp) })
	return pairs, nil
}

// listObjects lists a bucket folder with your own sign-in.
func listObjects(ctx context.Context, r *run.Runner, c *config.Config, prefix string) ([]string, error) {
	var out string
	var err error
	if strings.HasPrefix(prefix, "gs://") {
		out, err = r.Output(ctx, "gcloud", "storage", "ls", prefix)
		if err != nil && strings.Contains(err.Error(), "matched no objects") {
			return nil, nil
		}
	} else {
		out, err = r.Output(ctx, "aws", awsArgs(c, "s3", "ls", prefix)...)
		if err != nil && strings.TrimSpace(out) == "" && strings.Contains(err.Error(), "exit status 1") {
			return nil, nil // aws s3 ls: nothing under the prefix
		}
	}
	if err != nil {
		return nil, err
	}
	var objects []string
	for _, line := range strings.Split(out, "\n") {
		if fields := strings.Fields(line); len(fields) > 0 {
			objects = append(objects, fields[len(fields)-1])
		}
	}
	return objects, nil
}

// Download copies a pair from the bucket into folder, laid out the same.
func Download(ctx context.Context, r *run.Runner, c *config.Config, p Pair, folder string) (Pair, error) {
	local := pairAt(folder, p.Timestamp)
	for _, d := range [][2]string{{p.Kernel, local.Kernel}, {p.Console, local.Console}} {
		if err := os.MkdirAll(filepath.Dir(d[1]), 0o700); err != nil {
			return Pair{}, err
		}
		var err error
		if strings.HasPrefix(d[0], "gs://") {
			err = r.Run(ctx, "gcloud", "storage", "cp", d[0], d[1])
		} else {
			err = r.Run(ctx, "aws", awsArgs(c, "s3", "cp", "--no-progress", d[0], d[1])...)
		}
		if err != nil {
			return Pair{}, err
		}
	}
	return local, nil
}

func awsArgs(c *config.Config, a ...string) []string {
	if c.AWS.Profile != "" {
		a = append(a, "--profile", c.AWS.Profile)
	}
	return append(a, "--region", c.AWS.Region)
}

// copyIn puts a local file into the Postgres Pod at path.
func copyIn(ctx context.Context, r *run.Runner, c *config.Config, local, path string) error {
	f, err := os.Open(local)
	if err != nil {
		return err
	}
	defer f.Close()
	return r.FromReader(ctx, f, "kubectl", kubectl(c, "exec", "-i", "deploy/"+postgresDeployment, "--container", "postgres", "--",
		"sh", "-c", `cat > "$1"`, "sh", path)...)
}

// psqlValue is one value from the Postgres Pod, as its superuser.
func psqlValue(ctx context.Context, r *run.Runner, c *config.Config, database, query string) (string, error) {
	return r.Output(ctx, "kubectl", kubectl(c, "exec", "deploy/"+postgresDeployment, "--container", "postgres", "--",
		"psql", "-U", "postgres", "-d", database, "-Atc", query)...)
}

// schemaVersions are how far each database's migrations have gone: the
// kernel's newest migration, and how many the console has applied.
func schemaVersions(ctx context.Context, r *run.Runner, c *config.Config) (kernel, console string) {
	kernel, _ = psqlValue(ctx, r, c, kernelDatabase, "SELECT coalesce(max(version)::text, '0') FROM schema_migrations")
	console, _ = psqlValue(ctx, r, c, consoleDatabase, "SELECT count(*) FROM drizzle.__drizzle_migrations")
	return kernel, console
}
