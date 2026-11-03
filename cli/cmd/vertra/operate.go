// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/rburns629/vertra/cli/internal/awscloud"
	"github.com/rburns629/vertra/cli/internal/cluster"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/gcp"
	"github.com/rburns629/vertra/cli/internal/install"
	"github.com/rburns629/vertra/cli/internal/platform"
	"github.com/rburns629/vertra/cli/internal/releases"
	"github.com/rburns629/vertra/cli/internal/run"
	"github.com/rburns629/vertra/cli/internal/tools"
)

func (a *app) checkCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "check [env]",
		Short: "Check tools, the cluster and what's installed, without changing anything",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			_, c, err := a.load(args)
			if err != nil {
				return err
			}
			ctx, out := cmd.Context(), cmd.OutOrStdout()
			problems := 0
			fmt.Fprintln(out, "Tools")
			for _, s := range tools.CheckAll(ctx, tools.For(c.Target, c.Vertra == "source")) {
				state := "ok"
				if !s.OK() {
					problems++
					state = s.Problem
					if s.Downloadable {
						state += " (`vertra tools --install` downloads it)"
					} else if s.Install != "" {
						state += ": " + s.Install
					}
				}
				fmt.Fprintf(out, "  %-22s %-9s %s\n", s.Tool, orDefault(s.Version, "-"), state)
			}

			if c.Target == "gcp" {
				gs := gcp.Inspect(ctx, a.runner, c)
				fmt.Fprintln(out, "Google Cloud")
				fmt.Fprintf(out, "  signed in as %s; project %s, region %s\n", orDefault(gs.Account, "nobody"), c.GCP.Project, c.GCP.Region)
				fmt.Fprintf(out, "  cluster %s: %s\n", c.Cluster.Name, orDefault(gs.ClusterStatus, "not yet (apply creates it)"))
				for _, p := range gs.Problems {
					problems++
					fmt.Fprintln(out, "  problem:", p)
				}
				for _, w := range gs.Warnings {
					fmt.Fprintln(out, "  warning:", w)
				}
				if gs.ClusterStatus == "RUNNING" {
					_ = gcp.Credentials(ctx, a.runner, c)
				}
			}
			if c.Target == "aws" {
				as := awscloud.Inspect(ctx, a.runner, c)
				fmt.Fprintln(out, "AWS")
				fmt.Fprintf(out, "  signed in as %s; region %s\n", orDefault(as.Identity.Arn, "nobody"), c.AWS.Region)
				if len(as.Problems) == 0 {
					fmt.Fprintf(out, "  cluster %s: %s\n", c.Cluster.Name, orDefault(as.ClusterStatus, "not yet (apply creates it)"))
				}
				for _, p := range as.Problems {
					problems++
					fmt.Fprintln(out, "  problem:", p)
				}
				for _, w := range as.Warnings {
					fmt.Fprintln(out, "  warning:", w)
				}
				if as.ClusterStatus == "ACTIVE" {
					_ = awscloud.Credentials(ctx, a.runner, c)
				}
			}
			st := cluster.Inspect(ctx, a.runner, c)
			fmt.Fprintln(out, "Cluster")
			if c.Target == "kind" {
				fmt.Fprintf(out, "  local registry %-14s %s\n", c.Kind.RegistryName, presence(st.RegistryExists, st.RegistryRunning))
				fmt.Fprintf(out, "  kind cluster   %-14s %s\n", c.Cluster.Name, presence(st.ClusterExists, st.ClusterRunning))
			}
			if st.Reachable {
				fmt.Fprintf(out, "  reachable through %s (Kubernetes %s)\n", cluster.Context(c), st.ServerVersion)
				fmt.Fprintf(out, "  namespace %s: %s\n", c.Namespace, map[bool]string{true: "exists", false: "not yet"}[st.NamespaceExists])
				var installed map[string]string
				var versions []string
				run.Together(
					func() { installed = install.Releases(ctx, a.runner, c) },
					func() { versions, _ = releases.List(ctx) },
				)
				for _, r := range []string{install.KernelRelease, install.ConsoleRelease} {
					fmt.Fprintf(out, "  release %-8s %s\n", r, orDefault(installed[r], "not installed"))
				}
				// A chart version never released is a build from source: nothing to say.
				if now := releases.ChartVersion(installed[install.KernelRelease]); len(versions) > 0 && slices.Contains(versions, now) {
					if newest := versions[0]; releases.Compare(now, newest) < 0 {
						fmt.Fprintf(out, "  Vertra %s is out (this runs %s): `vertra config set vertra %s`, then `vertra apply` (%s)\n", newest, now, newest, releases.NotesURL(newest))
					}
				}
			}
			for _, p := range st.Problems {
				problems++
				fmt.Fprintln(out, "  problem:", p)
			}
			if problems > 0 {
				return fmt.Errorf("%d problem(s) to fix before `vertra apply`", problems)
			}
			fmt.Fprintln(out, "Ready for `vertra apply`.")
			return nil
		},
	}
}

func presence(exists, running bool) string {
	switch {
	case running:
		return "running"
	case exists:
		return "stopped (apply starts it)"
	default:
		return "not yet (apply creates it)"
	}
}

func (a *app) statusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status [env]",
		Short: "What's installed, and whether it's awake or asleep",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			ctx, out := cmd.Context(), cmd.OutOrStdout()
			st := cluster.Inspect(ctx, a.runner, c)
			if !st.Reachable {
				fmt.Fprintln(out, "The cluster isn't reachable (", cluster.Context(c), "): run `vertra apply` or `vertra check`.")
				return nil
			}
			var installed map[string]string
			var deps []platform.Deployment
			var public string // a cloud install's public console
			run.Together(
				func() { installed = install.Releases(ctx, a.runner, c) },
				func() { deps, err = platform.Deployments(ctx, a.runner, c) },
				func() {
					if c.Console.Public && (c.Target == "gcp" || c.Target == "aws") {
						public = a.publicConsole(ctx, c)
					}
				},
			)
			if err != nil {
				return err
			}
			for _, r := range []string{install.KernelRelease, install.ConsoleRelease} {
				fmt.Fprintf(out, "%-8s %s\n", r, orDefault(installed[r], "not installed"))
			}
			for _, d := range deps {
				fmt.Fprintf(out, "  %-42s %d/%d ready\n", d.Name, d.Ready, d.Replicas)
			}
			switch {
			case len(deps) == 0:
				fmt.Fprintln(out, "Not installed: run `vertra apply`.")
			case platform.Asleep(deps):
				fmt.Fprintln(out, "Asleep: `vertra wake` brings it back.")
			default:
				fmt.Fprintln(out, "Awake. Console:", platform.ConsoleAccess(c, envName(dir)))
			}
			if public != "" {
				fmt.Fprintln(out, "Public: ", public)
			}
			// An existing cluster's public console: its record and certificate.
			if c.Target == "existing" && c.Console.Public {
				dns := "no address published on the Ingress yet"
				if host, kind, target := a.consoleRecord(ctx, c, nil); target != "" {
					dns = fmt.Sprintf("needs %s %s → %s", kind, host, target)
					if resolvesTo(ctx, host, kind, target) {
						dns = "→ " + target + " ✓"
					}
				}
				fmt.Fprintf(out, "Public:  https://%s (DNS %s; certificate %s)\n", c.Console.Hostname, dns, install.ConsoleCertificate(ctx, a.runner, c))
			}
			return nil
		},
	}
}

func (a *app) sleepCmd() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "sleep [env]",
		Short: "Scale the platform to zero (data kept); `wake` brings it back",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			_, c, err := a.load(args)
			if err != nil {
				return err
			}
			ctx, out := cmd.Context(), cmd.OutOrStdout()
			deps, err := platform.Deployments(ctx, a.runner, c)
			if err != nil {
				return err
			}
			if len(deps) == 0 {
				return fmt.Errorf("nothing installed in %s", c.Namespace)
			}
			if platform.Asleep(deps) {
				fmt.Fprintln(out, "Already asleep.")
				return nil
			}
			if !force {
				n, err := platform.RunningSteps(ctx, a.runner, c)
				if err != nil {
					return err
				}
				if n > 0 {
					return fmt.Errorf("%d step(s) are running: sleep after they finish, or pass --force", n)
				}
			}
			if err := platform.Sleep(ctx, a.runner, c, deps); err != nil {
				return err
			}
			if err := platform.SuspendSleeper(ctx, a.runner, c, true); err != nil {
				return err
			}
			fmt.Fprintln(out, "Asleep. The console and API are unreachable until `vertra wake`.")
			return nil
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "sleep even while steps are running")
	return cmd
}

func (a *app) wakeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "wake [env]",
		Short: "Bring a sleeping platform back, and wait until it's ready",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			ctx, out := cmd.Context(), cmd.OutOrStdout()
			deps, err := platform.Deployments(ctx, a.runner, c)
			if err != nil {
				return err
			}
			if len(deps) == 0 {
				return fmt.Errorf("nothing installed in %s", c.Namespace)
			}
			if err := platform.Wake(ctx, a.runner, c, deps); err != nil {
				return err
			}
			if err := platform.SuspendSleeper(ctx, a.runner, c, false); err != nil {
				return err
			}
			fmt.Fprintln(out, "Awake. Console:", platform.ConsoleAccess(c, envName(dir)))
			return nil
		},
	}
}

func (a *app) destroyCmd() *cobra.Command {
	var all, yes bool
	cmd := &cobra.Command{
		Use:   "destroy [env]",
		Short: "Remove what vertra created; asks about data unless --all",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			ctx, out := cmd.Context(), cmd.OutOrStdout()
			st := cluster.Inspect(ctx, a.runner, c)
			ask := func(question string) (bool, error) {
				if all {
					return true, nil
				}
				return a.ask.Confirm(question, false)
			}

			var steps []string
			var deleteCluster, deleteRegistry, deleteData, deleteTeams bool
			switch c.Target {
			case "gcp", "aws":
				kind := map[string]string{"gcp": "GKE", "aws": "EKS"}[c.Target]
				steps = append(steps, fmt.Sprintf("delete the %s cluster %s and what the module created with it (network, identities, the platform registry)", kind, c.Cluster.Name))
				buckets, kept := "the backups bucket", "every backup"
				if c.Logs.Enabled {
					buckets, kept = "the backups and logs buckets", "every backup and archived log"
				}
				if deleteData, err = ask("Delete the data too: the database's disk and " + buckets + "?"); err != nil {
					return err
				}
				if deleteData {
					steps = append(steps, "delete the database's disk and "+kept)
				} else {
					steps = append(steps, "keep the database's disk and "+buckets+" (billed until you delete them)")
				}
				if c.TaskImages.Create {
					if deleteRegistry, err = ask(fmt.Sprintf("Delete the task registry %s and the catalog's images in it?", c.TaskImages.Name)); err != nil {
						return err
					}
					if deleteRegistry {
						steps = append(steps, "delete the task registry and its images")
					} else {
						steps = append(steps, "keep the task registry "+c.TaskImages.Name)
					}
				}
			case "kind":
				if !st.ClusterExists {
					fmt.Fprintln(out, "The kind cluster", c.Cluster.Name, "doesn't exist.")
				} else {
					if deleteCluster, err = ask(fmt.Sprintf("Delete the kind cluster %s? Its databases and every team's data go with it", c.Cluster.Name)); err != nil {
						return err
					}
					if deleteCluster {
						steps = append(steps, "delete the kind cluster "+c.Cluster.Name+" and everything in it")
					}
				}
				if others := cluster.OtherKindClusters(ctx, a.runner, c); st.RegistryExists && len(others) > 0 {
					// Never, not even with --all: theirs too.
					steps = append(steps, fmt.Sprintf("keep the local registry %s: kind cluster %s uses it too", c.Kind.RegistryName, strings.Join(others, ", ")))
				} else if st.RegistryExists {
					if deleteRegistry, err = ask(fmt.Sprintf("Also delete the local registry %s and its images?", c.Kind.RegistryName)); err != nil {
						return err
					}
					if deleteRegistry {
						steps = append(steps, "delete the local registry "+c.Kind.RegistryName+" and its images")
					}
				}
			case "existing":
				if !st.Reachable {
					return fmt.Errorf("can't reach the cluster through %s", cluster.Context(c))
				}
				steps = append(steps, "uninstall the console and kernel releases from "+c.Namespace)
				if deleteData, err = ask("Delete the database's volume (every execution, team and secret record)?"); err != nil {
					return err
				}
				if deleteData {
					steps = append(steps, "delete the database volume")
				}
				if deleteTeams, err = ask("Delete the team namespaces (labelled vertra/team) and their secrets?"); err != nil {
					return err
				}
				if deleteTeams {
					steps = append(steps, "delete every team namespace")
				}
			}
			if len(steps) == 0 {
				fmt.Fprintln(out, "Nothing to remove.")
				return nil
			}
			fmt.Fprintf(out, "\nvertra will:\n  - %s\nIts settings in %s stay.\n\n", strings.Join(steps, "\n  - "), dir)
			if !yes {
				ok, err := a.ask.Confirm("Go ahead?", false)
				if err != nil {
					return err
				}
				if !ok || !a.ask.Interactive {
					return errStopped
				}
			}

			switch c.Target {
			case "gcp":
				if err := a.destroyGCP(ctx, out, dir, c, deleteData, deleteRegistry); err != nil {
					return err
				}
			case "aws":
				if err := a.destroyAWS(ctx, out, dir, c, deleteData, deleteRegistry); err != nil {
					return err
				}
			case "kind":
				if deleteCluster {
					if err := cluster.DeleteKind(ctx, a.runner, c); err != nil {
						return err
					}
				}
				if deleteRegistry {
					if err := cluster.DeleteRegistry(ctx, a.runner, c); err != nil {
						return err
					}
				}
			case "existing":
				for _, r := range []string{install.ConsoleRelease, install.KernelRelease} {
					if err := install.Uninstall(ctx, a.runner, c, r); err != nil {
						return err
					}
				}
				kctx := cluster.Context(c)
				if deleteData {
					if err := a.runner.Run(ctx, "kubectl", "--context", kctx, "--namespace", c.Namespace, "delete", "pvc",
						"-l", "app.kubernetes.io/instance in ("+install.KernelRelease+","+install.ConsoleRelease+")"); err != nil {
						return err
					}
					// And the Secrets kept with them, of their passwords (not the
					// gateway's signing key, kept for its backends' sake).
					if err := a.runner.Run(ctx, "kubectl", "--context", kctx, "--namespace", c.Namespace, "delete", "secret", "--ignore-not-found",
						install.KernelRelease+"-execution-kernel-db", install.ConsoleRelease+"-execution-console"); err != nil {
						return err
					}
				}
				if deleteTeams {
					if err := a.runner.Run(ctx, "kubectl", "--context", kctx, "delete", "namespace", "-l", "vertra/team"); err != nil {
						return err
					}
				}
			}
			fmt.Fprintln(out, "Done.")
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "delete everything, data included, without asking about each")
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "skip the final confirmation")
	return cmd
}

func (a *app) consoleCmd() *cobra.Command {
	var port int
	cmd := &cobra.Command{
		Use:   "console [env]",
		Short: "Reach the console at http://localhost:18080 (a port-forward, until Ctrl-C)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			_, c, err := a.load(args)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "The console is at http://localhost:%d (Ctrl-C to stop).\n", port)
			return platform.PortForward(cmd.Context(), a.runner, c, port)
		},
	}
	cmd.Flags().IntVar(&port, "port", 18080, "the local port")
	return cmd
}

// publicConsole is a cloud install's public console address, from its
// Ingress, and on gcp its certificate's state (Google's, issued once the
// name resolves).
func (a *app) publicConsole(ctx context.Context, c *config.Config) string {
	var host, cert string
	run.Together(
		func() {
			host, _ = a.runner.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
				"get", "ingress", install.ConsoleRelease+"-execution-console", "--ignore-not-found", "-o", "jsonpath={.spec.rules[0].host}")
		},
		func() {
			if c.Target == "gcp" {
				cert = install.CertificateStatus(ctx, a.runner, c)
			}
		},
	)
	if host == "" {
		return ""
	}
	if cert != "" {
		return fmt.Sprintf("https://%s (certificate %s)", host, cert)
	}
	return "https://" + host
}
