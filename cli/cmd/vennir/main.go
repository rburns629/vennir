// SPDX-License-Identifier: MIT

// vennir installs and operates Vennir: from nothing to a running
// install on your machine (kind) or a cluster you have, and later the
// clouds. See cli/DESIGN.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/prompt"
	"github.com/rburns629/vennir/cli/internal/releases"
	"github.com/rburns629/vennir/cli/internal/run"
	"github.com/rburns629/vennir/cli/internal/tools"
)

// Version is set at build time (-ldflags "-X main.Version=…").
var Version = "dev"

// app holds what every command shares.
type app struct {
	base           string // where environments live (./deploy)
	verbose        bool
	nonInteractive bool
	runner         *run.Runner
	ask            *prompt.Asker
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := newRoot().ExecuteContext(ctx); err != nil {
		// A catalog command that failed has said why already.
		if !errors.Is(err, errReported) {
			fmt.Fprintln(os.Stderr, "Error:", err)
		}
		os.Exit(1)
	}
}

func newRoot() *cobra.Command {
	a := &app{}
	root := &cobra.Command{
		Use:           "vennir",
		Short:         "Install and operate Vennir",
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRun: func(cmd *cobra.Command, _ []string) {
			tools.ExtendPath()
			a.runner = run.New(a.verbose, tools.Path)
			a.ask = prompt.New(os.Stdin, os.Stdout, !a.nonInteractive && isTerminal(os.Stdin))
		},
	}
	defaultBase := os.Getenv("VENNIR_CONFIG")
	if defaultBase == "" {
		defaultBase = "deploy"
	}
	root.PersistentFlags().StringVar(&a.base, "config", defaultBase, "where environments live, each in a folder named for it; or VENNIR_CONFIG")
	root.PersistentFlags().BoolVarP(&a.verbose, "verbose", "v", false, "show every command vennir runs")
	root.PersistentFlags().BoolVar(&a.nonInteractive, "non-interactive", false, "never prompt: answers come from flags and defaults")

	root.AddCommand(
		a.initCmd(), a.checkCmd(), a.applyCmd(), a.statusCmd(),
		a.sleepCmd(), a.wakeCmd(), a.destroyCmd(), a.configCmd(),
		a.logsCmd(), a.backupCmd(), a.backupsCmd(), a.restoreCmd(), a.catalogCmd(), a.toolsCmd(), a.consoleCmd(), a.adminCmd(), a.ssoCmd(), versionCmd(),
	)
	return withHelp(root)
}

// load finds an environment's directory and reads its config.
func (a *app) load(args []string) (string, *config.Config, error) {
	env := ""
	if len(args) > 0 {
		env = args[0]
	}
	dir, err := config.Dir(a.base, env)
	if err != nil {
		return "", nil, err
	}
	c, err := config.Load(dir)
	if err != nil {
		return "", nil, err
	}
	return dir, c, nil
}

// envName is the environment's name, from its directory.
func envName(dir string) string { return filepath.Base(dir) }

func versionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print vennir's version",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, _ []string) {
			fmt.Println("vennir", Version)
			if newest := releases.Newest(cmd.Context()); newest != "" && releases.Valid(Version) && releases.Compare(Version, newest) < 0 {
				fmt.Printf("Vennir %s is out: %s\n", newest, releases.NotesURL(newest))
			}
		},
	}
}

// isTerminal says whether f is a terminal: not just a character device,
// which /dev/null is too.
func isTerminal(f *os.File) bool {
	return term.IsTerminal(int(f.Fd()))
}

// errStopped ends a command the user declined, without an error message.
var errStopped = errors.New("stopped: nothing was changed")
