// SPDX-License-Identifier: MIT

package backup

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/install"
	"github.com/rburns629/vennir/cli/internal/run"
)

// ManagedNow takes an on-demand backup of a managed database, with your
// own sign-in, and waits for it: a Cloud SQL backup, or an RDS snapshot.
// It returns what to call it by.
func ManagedNow(ctx context.Context, r *run.Runner, c *config.Config, db *install.ManagedDatabase) (string, error) {
	switch db.Provider {
	case "gcp":
		return db.Instance, r.Run(ctx, "gcloud", "sql", "backups", "create", "--instance", db.Instance,
			"--project", c.GCP.Project, "--description", "vennir backup")
	case "aws":
		snapshot := "vennir-" + time.Now().UTC().Format("20060102-150405")
		if _, err := r.Output(ctx, "aws", awsArgs(c, "rds", "create-db-snapshot", "--db-instance-identifier", db.Instance,
			"--db-snapshot-identifier", snapshot, "--output", "text", "--query", "DBSnapshot.DBSnapshotIdentifier")...); err != nil {
			return "", err
		}
		return snapshot, r.Run(ctx, "aws", awsArgs(c, "rds", "wait", "db-snapshot-available", "--db-snapshot-identifier", snapshot)...)
	}
	return "", fmt.Errorf("no managed database on %s", db.Provider)
}

// ManagedList is a managed database's backups, as its cloud lists them.
func ManagedList(ctx context.Context, r *run.Runner, c *config.Config, db *install.ManagedDatabase) (string, error) {
	switch db.Provider {
	case "gcp":
		return r.Output(ctx, "gcloud", "sql", "backups", "list", "--instance", db.Instance, "--project", c.GCP.Project,
			"--format", "table(id, windowStartTime, type, status)", "--sort-by", "windowStartTime")
	case "aws":
		return r.Output(ctx, "aws", awsArgs(c, "rds", "describe-db-snapshots", "--db-instance-identifier", db.Instance,
			"--query", "sort_by(DBSnapshots, &SnapshotCreateTime)[].[DBSnapshotIdentifier, SnapshotCreateTime, SnapshotType, Status]",
			"--output", "table")...)
	}
	return "", fmt.Errorf("no managed database on %s", db.Provider)
}

// DeleteManagedSnapshots deletes the RDS snapshots vennir backup took of
// instance (named vennir-...), which RDS keeps after the instance is gone:
// for destroy, when it deletes the data.
func DeleteManagedSnapshots(ctx context.Context, r *run.Runner, c *config.Config, instance string) error {
	out, err := r.Output(ctx, "aws", awsArgs(c, "rds", "describe-db-snapshots", "--db-instance-identifier", instance,
		"--snapshot-type", "manual", "--output", "text", "--query", "DBSnapshots[?starts_with(DBSnapshotIdentifier, 'vennir-')].DBSnapshotIdentifier")...)
	if err != nil {
		return err
	}
	for _, snapshot := range strings.Fields(out) {
		if _, err := r.Output(ctx, "aws", awsArgs(c, "rds", "delete-db-snapshot", "--db-snapshot-identifier", snapshot, "--output", "text", "--query", "DBSnapshot.Status")...); err != nil {
			return err
		}
	}
	return nil
}
