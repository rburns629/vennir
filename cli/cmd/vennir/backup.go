// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/rburns629/vennir/cli/internal/awscloud"
	"github.com/rburns629/vennir/cli/internal/backup"
	"github.com/rburns629/vennir/cli/internal/cluster"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/gcp"
	"github.com/rburns629/vennir/cli/internal/install"
	"github.com/rburns629/vennir/cli/internal/tofu"
)

func (a *app) backupCmd() *cobra.Command {
	var to string
	cmd := &cobra.Command{
		Use:   "backup [env]",
		Short: "Back up the databases now",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			ctx, out := cmd.Context(), cmd.OutOrStdout()
			if c.Database.Type == "managed" {
				if to != "" {
					return errors.New("--to dumps the in-cluster Postgres; this install's database is managed: its backups are its cloud's")
				}
				db, err := a.managedDatabase(ctx, dir, c)
				if err != nil {
					return err
				}
				name, err := backup.ManagedNow(ctx, a.runner, c, db)
				if err != nil {
					return err
				}
				fmt.Fprintf(out, "Backed up %s. `vennir backups %s` lists its backups.\n", name, envName(dir))
				return nil
			}
			if err := a.ensureContext(ctx, c); err != nil {
				return err
			}
			if to != "" {
				p, err := backup.Dump(ctx, a.runner, c, to)
				if err != nil {
					return err
				}
				fmt.Fprintf(out, "Dumped both databases:\n  %s\n  %s\nThey hold everything in the console, keep them safe. `vennir restore %s --from %s` restores them.\n",
					p.Kernel, p.Console, envName(dir), to)
				return nil
			}
			destination, err := backup.Destination(ctx, a.runner, c)
			if err != nil {
				return err
			}
			if destination == "" {
				return fmt.Errorf("this install's backups are off: `vennir backup %s --to <folder>` dumps the databases here, or turn backups on (gcp, aws: `vennir config set -e %s database.backups.enabled true`, then apply)", envName(dir), envName(dir))
			}
			fmt.Fprintln(out, "Running the backup Job now...")
			p, err := backup.RunNow(ctx, a.runner, c, destination)
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "Backed up, as %s:\n  %s\n  %s\n", p.Timestamp, p.Kernel, p.Console)
			return nil
		},
	}
	cmd.Flags().StringVar(&to, "to", "", "dump the in-cluster databases into this folder instead (any target, kind included)")
	return cmd
}

func (a *app) backupsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "backups [env]",
		Short: "List the databases' backups",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			ctx, out := cmd.Context(), cmd.OutOrStdout()
			if c.Database.Type == "managed" {
				db, err := a.managedDatabase(ctx, dir, c)
				if err != nil {
					return err
				}
				list, err := backup.ManagedList(ctx, a.runner, c, db)
				if err != nil {
					return err
				}
				fmt.Fprintln(out, list)
				return nil
			}
			if err := a.ensureContext(ctx, c); err != nil {
				return err
			}
			destination, err := backup.Destination(ctx, a.runner, c)
			if err != nil {
				return err
			}
			if destination == "" {
				return fmt.Errorf("this install's backups are off (dumps taken with `vennir backup --to` are wherever you put them)")
			}
			pairs, err := backup.List(ctx, a.runner, c, destination)
			if err != nil {
				return err
			}
			if len(pairs) == 0 {
				fmt.Fprintf(out, "No backups in %s yet: `vennir backup %s` takes one.\n", destination, envName(dir))
				return nil
			}
			fmt.Fprintf(out, "In %s (each the kernel's and the console's database):\n", destination)
			for _, p := range pairs {
				fmt.Fprintln(out, " ", p.Timestamp)
			}
			fmt.Fprintf(out, "`vennir restore %s <time>` restores one.\n", envName(dir))
			return nil
		},
	}
}

func (a *app) restoreCmd() *cobra.Command {
	var from string
	var yes bool
	cmd := &cobra.Command{
		Use:   "restore [env] [time]",
		Short: "Replace the databases with a backup",
		Args:  cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args[:min(1, len(args))])
			if err != nil {
				return err
			}
			ts := ""
			if len(args) == 2 {
				ts = args[1]
			}
			ctx, out := cmd.Context(), cmd.OutOrStdout()
			if c.Database.Type == "managed" {
				return managedRestoreAdvice(c)
			}
			if err := a.ensureContext(ctx, c); err != nil {
				return err
			}
			var pair backup.Pair
			var destination string
			if from != "" {
				if pair, err = backup.InFolder(from, ts); err != nil {
					return err
				}
			} else {
				if ts == "" {
					return fmt.Errorf("which backup? `vennir backups %s` lists them; or --from a folder of dumps", envName(dir))
				}
				if destination, err = backup.Destination(ctx, a.runner, c); err != nil {
					return err
				}
				if destination == "" {
					return errors.New("this install's backups are off: restore dumps taken with `vennir backup --to` with --from")
				}
				pairs, err := backup.List(ctx, a.runner, c, destination)
				if err != nil {
					return err
				}
				for _, p := range pairs {
					if p.Timestamp == ts {
						pair = p
					}
				}
				if pair.Timestamp == "" {
					return fmt.Errorf("no backup at %s in %s: `vennir backups %s` lists them", ts, destination, envName(dir))
				}
			}

			fmt.Fprintf(out, "This replaces both of %s's databases with the backup of %s: everything since is lost.\n", envName(dir), pair.Timestamp)
			if !yes {
				ok, err := a.ask.Confirm("Restore?", false)
				if err != nil {
					return err
				}
				if !a.ask.Interactive {
					return errors.New("not approved: pass --yes to restore without a prompt")
				}
				if !ok {
					return errStopped
				}
			}
			local, err := localBackups(envName(dir))
			if err != nil {
				return err
			}
			fmt.Fprintln(out, "First, dumping the databases as they are now, in case...")
			safety, err := backup.Dump(ctx, a.runner, c, filepath.Join(local, "before-restore"))
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "  %s (vennir restore %s --from %s)\n", safety.Timestamp, envName(dir), filepath.Join(local, "before-restore"))
			if destination != "" {
				fmt.Fprintln(out, "Downloading the backup...")
				if pair, err = backup.Download(ctx, a.runner, c, pair, filepath.Join(local, "downloaded")); err != nil {
					return err
				}
			}
			if err := backup.Restore(ctx, a.runner, c, out, pair); err != nil {
				return err
			}
			fmt.Fprintln(out, "Restored.")
			return nil
		},
	}
	cmd.Flags().StringVar(&from, "from", "", "a folder of dumps (vennir backup --to's); its newest unless a time is given")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "restore without asking")
	return cmd
}

// localBackups is where restore keeps dumps on this machine: outside the
// environment's folder, which may be committed, and readable only by you.
func localBackups(env string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".vennir", "backups", env)
	return dir, os.MkdirAll(dir, 0o700)
}

// managedRestoreAdvice says how a managed database is restored: by its
// cloud, which vennir doesn't drive yet.
func managedRestoreAdvice(c *config.Config) error {
	if c.Target == "gcp" {
		return errors.New("a managed database is restored by Cloud SQL, onto its own instance: `vennir sleep`, then `gcloud sql backups restore <id> --restore-instance <instance>` (`vennir backups` lists the ids), then `vennir wake`")
	}
	return errors.New("a managed database is restored by RDS, which makes a new instance from a snapshot or a point in time: vennir doesn't move an install onto it yet (docs/operations.md, Databases)")
}

// managedDatabase is the install's managed database, from the module's
// outputs (read from its state here, no call to the cloud).
func (a *app) managedDatabase(ctx context.Context, dir string, c *config.Config) (*install.ManagedDatabase, error) {
	outputs, err := tofu.In(a.runner, dir).Outputs(ctx)
	if err != nil {
		return nil, fmt.Errorf("read the install's cloud side (run `vennir apply` first): %w", err)
	}
	var cloud *install.Cloud
	if c.Target == "aws" {
		cloud, _, err = cloudFromAWS(outputs)
	} else {
		cloud, err = cloudFromGCP(outputs)
	}
	if err != nil {
		return nil, err
	}
	if cloud.Database == nil {
		return nil, errors.New("the install has no managed database yet: run `vennir apply`")
	}
	return cloud.Database, nil
}

// ensureContext adds a cloud cluster to kubeconfig when this machine
// hasn't got it (another machine applied), so kubectl can reach it.
func (a *app) ensureContext(ctx context.Context, c *config.Config) error {
	if a.runner.Succeeds(ctx, "kubectl", "config", "get-contexts", cluster.Context(c)) {
		return nil
	}
	switch c.Target {
	case "gcp":
		return gcp.Credentials(ctx, a.runner, c)
	case "aws":
		return awscloud.Credentials(ctx, a.runner, c)
	}
	return nil
}
