// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/install"
	"github.com/rburns629/vennir/cli/internal/tofu"
)

// ssoCmd sets up signing in with Google: Google has no API for its OAuth
// clients, so it says exactly what to click and paste, then reads the
// client's JSON and checks it before saving anything.
func (a *app) ssoCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sso",
		Short: "Sign people in to the console with their Google Workspace accounts",
	}
	var clientFile, domains, project string
	google := &cobra.Command{
		Use:   "google [env]",
		Short: "Set up signing in with Google (an OAuth client you make in Google's console)",
		Long: "Says which two pages of the Google Cloud console to open and what to paste there,\n" +
			"then reads the OAuth client's downloaded JSON, checks it, and saves the settings.\n" +
			"`vennir apply` then puts the client's secret in a Kubernetes Secret and turns it on.\n" +
			"Passwords keep working; a team can then be set to require Google sign-in.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, out := cmd.Context(), cmd.OutOrStdout()
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			redirect, err := install.SSORedirect(c, a.cloudConsoleHost(ctx, dir, c))
			if err != nil {
				return err
			}
			if project == "" {
				project = c.GCP.Project
			}
			if project == "" {
				if project, err = a.ask.Text("Google Cloud project to make the client in (any one in your Workspace's organization)", "", nil); err != nil {
					return err
				}
			}
			fmt.Fprintln(out, "In the Google Cloud console:")
			fmt.Fprintf(out, "  1. https://console.cloud.google.com/auth/overview?project=%s\n", project)
			fmt.Fprintln(out, "     Set up the consent screen. Audience: Internal (only your Workspace's people).")
			fmt.Fprintf(out, "  2. https://console.cloud.google.com/auth/clients/create?project=%s\n", project)
			fmt.Fprintln(out, "     Application type: Web application. Authorized redirect URI:")
			fmt.Fprintf(out, "       %s\n", redirect)
			fmt.Fprintln(out, "  3. Download its JSON, and keep it somewhere only you can read: it holds the client's secret.")
			if clientFile == "" {
				if clientFile, err = a.ask.Text("Where did you save the JSON?", "", nil); err != nil {
					return err
				}
			}
			if strings.HasPrefix(clientFile, "~/") {
				home, _ := os.UserHomeDir()
				clientFile = filepath.Join(home, clientFile[2:])
			}
			if clientFile, err = filepath.Abs(clientFile); err != nil {
				return err
			}
			client, err := install.ReadGoogleClient(clientFile)
			if err != nil {
				return err
			}
			if !slices.Contains(client.RedirectURIs, redirect) {
				return fmt.Errorf("the client's redirect URIs are %v: add %s to it in Google's console, download its JSON again, and rerun", client.RedirectURIs, redirect)
			}
			if info, err := os.Stat(clientFile); err == nil && info.Mode().Perm()&0o077 != 0 {
				fmt.Fprintf(out, "Warning: %s can be read by other users of this machine; `chmod 600` it.\n", clientFile)
			}
			def := ""
			if at := strings.LastIndex(c.Admin.Email, "@"); at >= 0 {
				def = c.Admin.Email[at+1:]
			}
			if domains == "" {
				if domains, err = a.ask.Text("Workspace domains whose people may sign in, comma-separated", def, nil); err != nil {
					return err
				}
			}
			var allowed []string
			for _, d := range strings.Split(domains, ",") {
				if d = strings.ToLower(strings.TrimSpace(d)); d != "" {
					allowed = append(allowed, d)
				}
			}
			c.SSO = config.SSO{Provider: "google", ClientID: client.ID, ClientFile: clientFile, AllowedDomains: allowed, RedirectURL: redirect}
			if err := c.Validate(); err != nil {
				return err
			}
			if err := c.Save(dir); err != nil {
				return err
			}
			fmt.Fprintf(out, "Saved. `vennir apply %s` turns it on: people from %s sign in with Google;\n", envName(dir), strings.Join(allowed, ", "))
			fmt.Fprintln(out, "passwords keep working until an admin sets a team to require Google sign-in (its page in the console).")
			return nil
		},
	}
	google.Flags().StringVar(&clientFile, "client-file", "", "the OAuth client's downloaded JSON")
	google.Flags().StringVar(&domains, "domains", "", "Workspace domains whose people may sign in, comma-separated (default: the admin's)")
	google.Flags().StringVar(&project, "project", "", "the Google Cloud project to make the client in (gcp: the install's)")
	off := &cobra.Command{
		Use:   "off [env]",
		Short: "Stop signing in with Google (passwords only)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			// Reading groups is its own setting (vennir sso google-groups).
			c.SSO = config.SSO{GoogleGroups: c.SSO.GoogleGroups}
			if err := c.Save(dir); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Saved. `vennir apply %s` turns it off; teams that required it accept passwords again.\n", envName(dir))
			return nil
		},
	}
	var groupsOff bool
	groups := &cobra.Command{
		Use:   "google-groups [env]",
		Short: "Let the console read people's Google Workspace groups, to map them to teams (gcp)",
		Long: "The console reads each person's Google Workspace groups as its own service account, at each\n" +
			"single sign-on, so admins can map groups to teams in the console. `vennir apply` enables Cloud\n" +
			"Identity's API and says which account a Workspace admin makes a Groups Reader. No key is made.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			c.SSO.GoogleGroups = !groupsOff
			if err := c.Validate(); err != nil {
				return err
			}
			if err := c.Save(dir); err != nil {
				return err
			}
			if groupsOff {
				fmt.Fprintf(cmd.OutOrStdout(), "Saved. After `vennir apply %s`, untick Google Workspace groups on the console's Admin page too.\n", envName(dir))
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "Saved. `vennir apply %s` enables it and says which account to make a Groups Reader.\n", envName(dir))
			}
			return nil
		},
	}
	groups.Flags().BoolVar(&groupsOff, "off", false, "stop reading Google Workspace groups")
	cmd.AddCommand(google, off, groups)
	return cmd
}

// cloudConsoleHost is the public console's name as the cloud side made it,
// from the module's outputs in its state (no call to the cloud): gcp's
// nip.io name for its reserved address, aws's host in its zone. "" when
// there's no cloud side or no public address yet; apply checks the same.
func (a *app) cloudConsoleHost(ctx context.Context, dir string, c *config.Config) string {
	if !c.Console.Public || (c.Target != "gcp" && c.Target != "aws") {
		return ""
	}
	outputs, err := tofu.In(a.runner, dir).Outputs(ctx)
	if err != nil {
		return ""
	}
	return consoleHostOf(c, outputs["console_address"])
}

// consoleHostOf reads the module's console_address output.
func consoleHostOf(c *config.Config, raw json.RawMessage) string {
	var address struct {
		Host string `json:"host"` // aws
		IP   string `json:"ip"`   // gcp
	}
	if len(raw) == 0 || json.Unmarshal(raw, &address) != nil {
		return ""
	}
	if address.Host != "" {
		return address.Host
	}
	if address.IP != "" {
		return install.ConsoleHostname(c, address.IP)
	}
	return ""
}
