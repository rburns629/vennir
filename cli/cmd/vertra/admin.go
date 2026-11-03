// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"

	"github.com/rburns629/vertra/cli/internal/cluster"
	"github.com/rburns629/vertra/cli/internal/install"
)

// newPassword is the line the console's reset script prints.
var newPassword = regexp.MustCompile(`New password for (\S+): (\S+)`)

func (a *app) adminCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "admin", Short: "Recover access to the console"}
	var email string
	reset := &cobra.Command{
		Use:   "reset-password [env]",
		Short: "Give an admin a new password, saved to a file only you can read (the first admin's, unless --email)",
		Long: "Gives a console admin a new random password, inside the cluster (the console's own Pod), so only\n" +
			"someone with access to the cluster can. Every session the account had is signed out, and the\n" +
			"reset is in the audit log. The password is saved to admin-password in the environment's folder,\n" +
			"readable only by you, never printed. For a lost first admin's password, too.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			target := email
			if target == "" {
				target = c.Admin.Email
			}
			out, err := a.runner.Output(cmd.Context(), "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
				"exec", "deploy/"+install.ConsoleRelease+"-execution-console", "--", "node", "dist/db/resetAdmin.js", target)
			if err != nil {
				return fmt.Errorf("couldn't reset it (is the platform awake? `vertra wake`): %w", err)
			}
			m := newPassword.FindStringSubmatch(out)
			if m == nil {
				return fmt.Errorf("the console didn't say the new password")
			}
			path, err := savePassword(dir, m[2])
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Sign in as %s with the password in %s (only you can read it).\n%s\n", m[1], path, passwordThen)
			return nil
		},
	}
	reset.Flags().StringVar(&email, "email", "", "the admin whose password to reset (default: the first admin)")
	cmd.AddCommand(reset)
	return cmd
}

// passwordThen follows where a generated password is.
const passwordThen = "You'll choose your own when you sign in; then delete the file."

// savedPassword is the password savePassword saved in dir, "" if none.
func savedPassword(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, "admin-password"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// savePassword writes a generated admin password to admin-password in the
// environment's folder, readable only by you and kept out of git beside it,
// and returns its path. Printed, it would land in CI logs and anything
// tee'd. It's written to a new file and renamed into place, so it's never
// readable by others, even for a moment, and never written through a
// symlink at that path (into a file git tracks).
func savePassword(dir, password string) (string, error) {
	ignore := filepath.Join(dir, ".gitignore")
	b, err := os.ReadFile(ignore)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	listed := false
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimPrefix(strings.TrimSpace(line), "/") == "admin-password" {
			listed = true
		}
	}
	if !listed {
		if len(b) > 0 && !strings.HasSuffix(string(b), "\n") {
			b = append(b, '\n')
		}
		if err := os.WriteFile(ignore, append(b, "admin-password\n"...), 0o644); err != nil {
			return "", err
		}
	}
	f, err := os.CreateTemp(dir, ".admin-password-*") // 0600
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name()) // once renamed, there's nothing to remove
	if _, err := f.WriteString(password + "\n"); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "admin-password")
	return path, os.Rename(f.Name(), path)
}
