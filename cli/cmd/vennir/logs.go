// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/rburns629/vennir/cli/internal/cluster"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/run"
)

// logComponents are the platform's parts whose logs `vennir logs` shows:
// each one's chart component labels (both charts label their Pods with
// their release as app.kubernetes.io/instance).
var logComponents = map[string][]string{
	"console":   {"app"},
	"gateway":   {"gateway"},
	"api":       {"api"},
	"scheduler": {"scheduler"},
	"postgres":  {"postgres"},
	"migrate":   {"migrate", "console-db"},
	"backup":    {"pg-backup"},
	"sleeper":   {"sleeper"},
	"scanner":   {"trivy-server", "image-scan"},
	"loki":      {"loki", "logs-collector"},
}

// defaultLogComponents are what it shows unless told: the parts a request
// passes through.
var defaultLogComponents = []string{"console", "gateway", "api", "scheduler"}

func (a *app) logsCmd() *cobra.Command {
	var follow bool
	var since, execution string
	var tail int
	cmd := &cobra.Command{
		Use:   "logs [env] [component...]",
		Short: "Show the platform's logs, or one execution's steps'",
		RunE: func(cmd *cobra.Command, args []string) error {
			env, components := a.splitLogArgs(args)
			for _, name := range components {
				if _, ok := logComponents[name]; !ok {
					return fmt.Errorf("no component %q: one of %s", name, strings.Join(componentNames(), ", "))
				}
			}
			_, c, err := a.load(env)
			if err != nil {
				return err
			}
			opts := []string{"--prefix", "--timestamps", "--max-log-requests", "30", "--ignore-errors", "--tail", fmt.Sprint(tail)}
			if since != "" {
				opts = append(opts, "--since", since)
			}
			if follow {
				opts = append(opts, "--follow")
			}
			if execution != "" {
				return a.stepLogs(cmd.Context(), c, execution, opts)
			}
			if len(components) == 0 {
				components = defaultLogComponents
			}
			return a.runner.Run(cmd.Context(), "kubectl", append([]string{"--context", cluster.Context(c), "--namespace", c.Namespace,
				"logs", "--selector", platformSelector(components)}, opts...)...)
		},
	}
	cmd.Flags().BoolVarP(&follow, "follow", "f", false, "keep showing new lines until Ctrl-C")
	cmd.Flags().StringVar(&since, "since", "1h", "only lines newer than this (e.g. 10m, 2h); empty for all a Pod still has")
	cmd.Flags().IntVar(&tail, "tail", 200, "at most this many lines from each Pod (-1 for all)")
	cmd.Flags().StringVar(&execution, "execution", "", "an execution's id: its steps' logs, from the team namespaces they ran in")
	return cmd
}

// splitLogArgs separates the environment from the components: the first
// argument is a component when it names one and no environment has its
// name (with one environment, its name can be left out).
func (a *app) splitLogArgs(args []string) (env, components []string) {
	if len(args) == 0 {
		return nil, nil
	}
	if _, isComponent := logComponents[args[0]]; isComponent {
		if _, err := os.Stat(filepath.Join(a.base, args[0], config.FileName)); err != nil {
			return nil, args
		}
	}
	return args[:1], args[1:]
}

// platformSelector picks the components' Pods, in either chart's release.
func platformSelector(components []string) string {
	var labels []string
	for _, c := range components {
		labels = append(labels, logComponents[c]...)
	}
	slices.Sort(labels)
	return fmt.Sprintf("app.kubernetes.io/instance in (console,kernel),app.kubernetes.io/component in (%s)", strings.Join(slices.Compact(labels), ","))
}

func componentNames() []string {
	var names []string
	for name := range logComponents {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// stepLogs shows an execution's steps' logs: its Pods are in the team
// namespaces the steps ran in, found by the kernel's label, and each
// namespace's are read side by side. A step's Pod is gone once its Job
// is cleaned up: Observe in the console keeps them (with logs on).
func (a *app) stepLogs(ctx context.Context, c *config.Config, execution string, opts []string) error {
	label := "vennir.dev/execution-id=" + execution
	out, err := a.runner.Output(ctx, "kubectl", "--context", cluster.Context(c), "get", "pods", "--all-namespaces",
		"--selector", label, "-o", "jsonpath={range .items[*]}{.metadata.namespace}{\"\\n\"}{end}")
	if err != nil {
		return err
	}
	namespaces := slices.Compact(slices.Sorted(slices.Values(strings.Fields(out))))
	if len(namespaces) == 0 {
		return fmt.Errorf("no step Pods for execution %s: its Jobs may have been cleaned up (Observe in the console keeps their logs, with logs on)", execution)
	}
	errs := make([]error, len(namespaces))
	reads := make([]func(), len(namespaces))
	for i, ns := range namespaces {
		reads[i] = func() {
			errs[i] = a.runner.Run(ctx, "kubectl", append([]string{"--context", cluster.Context(c), "--namespace", ns,
				"logs", "--selector", label, "--all-containers"}, opts...)...)
		}
	}
	run.Together(reads...)
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}
