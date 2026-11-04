// SPDX-License-Identifier: MIT

package main

// The catalog's own commands (`vennir catalog ...`): what a catalog
// repository's CI and its contributors run, through the repository's
// ./vennir wrapper (the pinned vennir, checksum-verified). They validate,
// build, test, scan and publish a catalog's products, and release the
// catalog for each install's console to pull; none of them calls a console
// or a cluster. `vennir catalog create` (catalog.go) makes the repository.
//
//	vennir catalog validate [PRODUCT ...]   product.yaml and team.yaml, tests present
//	vennir catalog check    [PRODUCT ...]   validate, build, test and scan: what a PR runs
//	vennir catalog publish  [PRODUCT ...]   check, then push and sign
//	vennir catalog plan     --out FILE      the builds teams' own Environments must make
//	vennir catalog build    --out DIR PRODUCT ...   build one team's products in its Environment
//	vennir catalog environments [--repo OWNER/NAME]   make teams' Environments, main only
//	vennir catalog release                  push and sign the catalog's release: every team,
//	                                        SecretStore, product and template, as of this commit
//	vennir catalog promote  VERSION [--from COMMIT]   tag a commit's release vX.Y.Z (a Git tag's CI does)
//	vennir catalog changed  --base REF      the products changed since REF, as JSON
//	vennir catalog secret-stores check [TEAM ...]
//	vennir catalog bases [--update] [--use-mirror]   pin every Dockerfile's FROM to its digest
//	vennir catalog bases mirror             copy the approved bases (bases.yaml) into the registry
//	vennir catalog migrate                  rewrite a catalog from before format v2 or the rename

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/rburns629/vennir/cli/internal/catalogtool"
)

// errReported ends a command that reported its own problems: exit 1, no
// more said.
var errReported = errors.New("reported")

// catalogCommands are the catalog's own commands, for `vennir catalog`.
func catalogCommands() []*cobra.Command {
	var cmds []*cobra.Command
	for _, name := range []string{"validate", "check", "publish"} {
		cmds = append(cmds, catalogProductsCmd(name))
	}
	return append(cmds, catalogPlanCmd(), catalogBuildCmd(), catalogEnvironmentsCmd(), catalogChangedCmd(), catalogSecretStoresCmd(), catalogReleaseCmd(), catalogPromoteCmd(), catalogBasesCmd(), catalogMigrateCmd())
}

func openCatalog() (*catalogtool.Catalog, error) {
	root, err := catalogtool.Root()
	if err != nil {
		return nil, err
	}
	return catalogtool.New(root), nil
}

// result turns a command's verdict into its exit.
func catalogResult(ok bool, err error) error {
	if err != nil {
		return err
	}
	if !ok {
		return errReported
	}
	return nil
}

func printJSONList(list []string) error {
	if list == nil {
		list = []string{}
	}
	data, err := json.Marshal(list)
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

func catalogProductsCmd(name string) *cobra.Command {
	short := map[string]string{
		"validate": "Check product.yaml and team.yaml, and that tests are present",
		"check":    "Validate, build, test and scan: what a pull request runs",
		"publish":  "Check, then push and sign each product",
	}[name]
	var changed, images string
	cmd := &cobra.Command{
		Use:   name + " [PRODUCT ...]",
		Short: short,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			var since *string
			if cmd.Flags().Changed("changed") {
				since = &changed
			}
			c.Images = images
			return catalogResult(c.Products(cmd.Context(), name, args, since))
		},
	}
	cmd.Flags().StringVar(&changed, "changed", "", "the products changed since `REF`")
	if name != "validate" {
		cmd.Flags().StringVar(&images, "images", "", "load the images teams' own Environments built from `DIR` (vennir catalog build's --out)")
	}
	return cmd
}

func catalogPlanCmd() *cobra.Command {
	var changed, out string
	cmd := &cobra.Command{
		Use:   "plan --out FILE",
		Short: "Write the builds publishing needs from teams' own Environments (buildEnvironments), as JSON",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			var since *string
			if cmd.Flags().Changed("changed") {
				since = &changed
			}
			builds, ok, err := c.Plan(cmd.Context(), since)
			if err != nil || !ok {
				return catalogResult(ok, err)
			}
			data, err := json.Marshal(builds)
			if err != nil {
				return err
			}
			return os.WriteFile(out, append(data, '\n'), 0o644)
		},
	}
	cmd.Flags().StringVar(&changed, "changed", "", "the products changed since `REF` (and, in CI, those not yet published), as publish chooses")
	cmd.Flags().StringVar(&out, "out", "", "the `FILE` to write")
	_ = cmd.MarkFlagRequired("out")
	return cmd
}

func catalogBuildCmd() *cobra.Command {
	var out string
	cmd := &cobra.Command{
		Use:   "build --out DIR PRODUCT ...",
		Short: "Build one team's products in its own Environment, its secrets offered to docker build, and save the images for publish --images",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			return catalogResult(c.BuildForEnvironment(args, out))
		},
	}
	cmd.Flags().StringVar(&out, "out", "", "the `DIR` to save the images in")
	_ = cmd.MarkFlagRequired("out")
	return cmd
}

func catalogEnvironmentsCmd() *cobra.Command {
	var repo string
	cmd := &cobra.Command{
		Use:   "environments",
		Short: "Make each buildEnvironments team's GitHub Environment (team-<name>) and limit it to main; run by a catalog admin",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			return catalogResult(c.Environments(repo))
		},
	}
	cmd.Flags().StringVar(&repo, "repo", "", "the catalog's GitHub repository, `OWNER/NAME` (default: its origin remote's)")
	return cmd
}

func catalogChangedCmd() *cobra.Command {
	var base string
	cmd := &cobra.Command{
		Use:   "changed --base REF",
		Short: "List the products changed since REF, as JSON",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			return printJSONList(c.ChangedProducts(base, c.AllProducts()))
		},
	}
	cmd.Flags().StringVar(&base, "base", "", "the `REF` to compare with")
	_ = cmd.MarkFlagRequired("base")
	return cmd
}

func catalogSecretStoresCmd() *cobra.Command {
	stores := &cobra.Command{Use: "secret-stores", Short: "Check teams' SecretStore files (a release carries them to each install)"}
	stores.AddCommand(&cobra.Command{
		Use:   "check [TEAM ...]",
		Short: "Check teams' SecretStore files",
		RunE: func(_ *cobra.Command, args []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			teams := args
			if len(teams) == 0 {
				teams = c.SecretStoreTeams()
			}
			return catalogResult(c.SecretStoresCheck(teams), nil)
		},
	})
	return stores
}

func catalogReleaseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "release",
		Short: "Push and sign the catalog's release (every team, product and template, as of this commit) for each install to pull",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			return catalogResult(c.Release(cmd.Context()))
		},
	}
}

func catalogPromoteCmd() *cobra.Command {
	var from string
	var wait time.Duration
	cmd := &cobra.Command{
		Use:   "promote VERSION",
		Short: "Make a version (vX.Y.Z) of the release main published for a commit, for installs following versions",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			return catalogResult(c.Promote(cmd.Context(), args[0], from, wait))
		},
	}
	cmd.Flags().StringVar(&from, "from", "", "the commit (or local mode's release tag) whose release it is (default HEAD)")
	cmd.Flags().DurationVar(&wait, "wait", 0, "wait this long for main to publish that commit's release")
	return cmd
}

func catalogBasesCmd() *cobra.Command {
	var update, useMirror bool
	cmd := &cobra.Command{
		Use:   "bases",
		Short: "Pin every Dockerfile's FROM to its digest (and mirror the approved bases: bases mirror)",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			return c.Bases(update, useMirror)
		},
	}
	cmd.Flags().BoolVar(&update, "update", false, "re-pin already pinned bases to what their tag names now")
	cmd.Flags().BoolVar(&useMirror, "use-mirror", false, "point a FROM of an approved base (bases.yaml) at its copy in the registry")
	cmd.AddCommand(&cobra.Command{
		Use:   "mirror",
		Short: "Copy the approved bases (bases.yaml) into the registry, scanned and signed, for products to build FROM",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			return catalogResult(c.MirrorBases(cmd.Context()))
		},
	})
	return cmd
}

func catalogMigrateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "migrate",
		Short: "Rewrite an older catalog: from before format v2, or from before the rename to Vennir",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			changed, problems, err := c.Migrate()
			if err != nil {
				return err
			}
			for _, p := range problems {
				fmt.Fprintln(os.Stderr, "  "+p)
			}
			fmt.Printf("%d file(s) rewritten in format %s. Review the diff, then run vennir catalog validate.\n", changed, catalogtool.APIVersion)
			return catalogResult(len(problems) == 0, nil)
		},
	}
}
