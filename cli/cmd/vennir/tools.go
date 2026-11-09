// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/tools"
)

// requireTools checks a target's tools, offers to download the missing
// ones it can, and fails with install instructions for the rest.
func (a *app) requireTools(ctx context.Context, out io.Writer, target string, fromSource bool) error {
	statuses := tools.CheckAll(ctx, tools.For(target, fromSource))
	var blocking []string
	for _, s := range statuses {
		if s.OK() {
			continue
		}
		if s.Downloadable {
			version, _ := tools.Pinned(s.Tool)
			dir, err := tools.Dir()
			if err != nil {
				return err
			}
			ok, err := a.ask.Confirm(fmt.Sprintf("%s: %s. Download %s %s to %s?", s.Tool, s.Problem, s.Tool, version, dir), true)
			if err != nil {
				return err
			}
			if ok && a.ask.Interactive {
				path, err := tools.Download(ctx, s.Tool)
				if err != nil {
					return err
				}
				fmt.Fprintf(out, "  %s %s downloaded to %s (checksum verified)\n", s.Tool, version, path)
				continue
			}
			blocking = append(blocking, fmt.Sprintf("%s: %s (`vennir tools --install` downloads it)", s.Tool, s.Problem))
			continue
		}
		hint := s.Problem
		if s.Install != "" {
			hint += ": " + s.Install
		}
		blocking = append(blocking, s.Tool+": "+hint)
	}
	if len(blocking) > 0 {
		return fmt.Errorf("missing tools:\n  - %s", strings.Join(blocking, "\n  - "))
	}
	return nil
}

func (a *app) toolsCmd() *cobra.Command {
	var install bool
	var target string
	cmd := &cobra.Command{
		Use:   "tools [env]",
		Short: "List the tools an environment needs; --install downloads the missing ones",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			out := cmd.OutOrStdout()
			fromSource := true
			if target == "" {
				target = "kind"
				if _, c, err := a.load(args); err == nil {
					target, fromSource = c.Target, c.Vennir == "source"
				} else if len(args) > 0 {
					return err
				}
			}
			statuses := tools.CheckAll(cmd.Context(), tools.For(target, fromSource))
			for _, s := range statuses {
				state := "ok"
				if !s.OK() {
					state = s.Problem
				}
				fmt.Fprintf(out, "  %-22s %-9s %-44s %s\n", s.Tool, orDefault(s.Version, "-"), orDefault(s.Path, "-"), state)
			}
			if !install {
				return nil
			}
			for _, s := range statuses {
				if s.OK() || !s.Downloadable {
					continue
				}
				path, err := tools.Download(cmd.Context(), s.Tool)
				if err != nil {
					return err
				}
				fmt.Fprintf(out, "Downloaded %s to %s (checksum verified)\n", s.Tool, path)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "the target to check for, before there's an environment (kind, gcp, aws, azure, existing)")
	cmd.Flags().BoolVar(&install, "install", false, "download the missing tools vennir can fetch (pinned, checksum-verified)")
	return cmd
}

func (a *app) configCmd() *cobra.Command {
	var env string
	cmd := &cobra.Command{Use: "config", Short: "Read or change an environment's settings"}
	get := &cobra.Command{
		Use:   "get [key]",
		Short: "Print a setting, or all of them",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			_, c, err := a.load(envArgs(env))
			if err != nil {
				return err
			}
			if len(args) == 0 {
				keys, err := config.Keys(c)
				if err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), strings.Join(keys, "\n"))
				return nil
			}
			v, err := config.Get(c, args[0])
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), v)
			return nil
		},
	}
	set := &cobra.Command{
		Use:   "set <key> <value>",
		Short: "Change a setting; `vennir apply` makes it so",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(envArgs(env))
			if err != nil {
				return err
			}
			changed, err := config.Set(c, args[0], args[1])
			if err != nil {
				return err
			}
			if err := changed.Save(dir); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "%s = %s. Run `vennir apply %s` to make it so.\n", args[0], args[1], envName(dir))
			return nil
		},
	}
	cmd.PersistentFlags().StringVarP(&env, "env", "e", "", "the environment (needed when there are several)")
	cmd.AddCommand(get, set)
	return cmd
}

func envArgs(env string) []string {
	if env == "" {
		return nil
	}
	return []string{env}
}
