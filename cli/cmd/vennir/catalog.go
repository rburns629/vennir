// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/rburns629/vennir/cli/internal/access"
	"github.com/rburns629/vennir/cli/internal/awscloud"
	"github.com/rburns629/vennir/cli/internal/catalog"
	"github.com/rburns629/vennir/cli/internal/catalogtemplate"
	"github.com/rburns629/vennir/cli/internal/catalogtool"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/consoleapi"
	"github.com/rburns629/vennir/cli/internal/gcp"
	"github.com/rburns629/vennir/cli/internal/githost"
	"github.com/rburns629/vennir/cli/internal/modules"
	"github.com/rburns629/vennir/cli/internal/plan"
	"github.com/rburns629/vennir/cli/internal/platform"
	"github.com/rburns629/vennir/cli/internal/releases"
	"github.com/rburns629/vennir/cli/internal/tofu"
	"github.com/rburns629/vennir/cli/internal/tools"
)

// What earlier versions set on a catalog repository: the console it called
// and its tokens, from before consoles pulled its release, and every
// variable under the platform's earlier names (Acyclix until 2026-10-20,
// Vertra until 2026-11-03). Removed from the repository, and the tokens
// revoked, when `vennir catalog create` runs again.
var (
	oldCatalogVariables = []string{"ACYCLIX_CONSOLE_URL", "ACYCLIX_REGISTRY", "ACYCLIX_SIGNING_MODE", "ACYCLIX_SIGNING_KEY",
		"VERTRA_REGISTRY", "VERTRA_SIGNING_MODE", "VERTRA_SIGNING_KEY"}
	oldCatalogSecrets = [][2]string{{"", "ACYCLIX_TOKEN"}, {"purge", "ACYCLIX_PURGE_TOKEN"}}
)

func oldTokenLabels(repo string) []string {
	return []string{"catalog CI: " + repo, "catalog purge: " + repo}
}

// catalogCmd is everything about a catalog: making its repository
// (create, here), and its own commands (catalog_commands.go).
func (a *app) catalogCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "catalog",
		Short: "A catalog: create its repository; validate, test, publish and release its products",
	}
	cmd.AddCommand(a.catalogCreateCmd(), a.catalogGrantCmd())
	cmd.AddCommand(catalogCommands()...)
	return cmd
}

func (a *app) catalogCreateCmd() *cobra.Command {
	var yes, planOnly, noSmoke, takeOver bool
	cmd := &cobra.Command{
		Use:   "create [env]",
		Short: "Create the catalog repository on GitHub, its first team and starters, and smoke-test it",
		Long: "Creates the catalog repository from the catalog template (with the first team and the\n" +
			"starters for the languages picked), sets its variables (the registry and its sign-in: no\n" +
			"console credential, since the console pulls the catalog's release), pushes it, waits for\n" +
			"its CI to publish, has the console apply the release, and runs a starter.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			return a.catalog(cmd.Context(), cmd.OutOrStdout(), dir, c, yes, planOnly, noSmoke, takeOver)
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "approve without asking")
	cmd.Flags().BoolVar(&planOnly, "plan-only", false, "show what it would do and stop")
	cmd.Flags().BoolVar(&noSmoke, "no-smoke-test", false, "don't wait for CI or run a starter")
	cmd.Flags().BoolVar(&takeOver, "take-over", false, "publish to this install even though the repository publishes to another's (that install stops getting releases)")
	return cmd
}

// ownedElsewhere refuses a repository whose CI publishes to another
// install's registry (its VENNIR_REGISTRY): one repository has one owner,
// whose variables say where it publishes and how it signs, and every other
// install reads it. Taking it over is a deliberate move.
func ownedElsewhere(repo, current, ours string, takeOver bool) error {
	if current == "" || current == ours || takeOver {
		return nil
	}
	return fmt.Errorf("github.com/%s already publishes to %s, another install's registry.\n"+
		"An install reads it there instead: `vennir config set externalCatalog.registry %s` and its signer in catalogSignature (docs/operations.md).\n"+
		"To move the catalog to this install, `vennir catalog create --take-over`: the other stops getting releases", repo, current, current)
}

// catalogSetup is what the catalog needs from the install.
type catalogSetup struct {
	registry string
	// variables are the repository's cloud sign-in variables.
	variables [][2]string
	// signing are its signing variables (VENNIR_SIGNING_MODE, and _KEY for
	// a KMS key), from config.Signing and the install.
	signing [][2]string
}

// signingVariables tell the catalog's CI how to sign: catalog-template's
// modes are none, key (a cosign key reference, here the install's KMS key)
// and keyless.
func signingVariables(c *config.Config, key string) [][2]string {
	switch c.Signing {
	case "kms":
		return [][2]string{{"VENNIR_SIGNING_MODE", "key"}, {"VENNIR_SIGNING_KEY", key}}
	case "keyless":
		return [][2]string{{"VENNIR_SIGNING_MODE", "keyless"}}
	}
	return [][2]string{{"VENNIR_SIGNING_MODE", "none"}}
}

func (a *app) catalog(ctx context.Context, out io.Writer, dir string, c *config.Config, yes, planOnly, noSmoke, takeOver bool) error {
	cat := c.Catalog
	if cat.Repo() == "" {
		return errors.New("no catalog in the config: `vennir config set catalog.owner <owner>` (and catalog.repository, catalog.team), or `vennir init --force`")
	}
	if c.Target != "gcp" && c.Target != "aws" {
		return errors.New("the catalog's CI publishes to the install's registry: a gcp or aws install")
	}
	// The template: a checkout's, or this release's own (whose format its
	// console reads), with ./vennir pinned to this release for its CI.
	var pinSums map[string]string
	if c.Vennir != "source" {
		mine := strings.TrimPrefix(Version, "v")
		if !catalogtemplate.Embedded() {
			return errors.New("this vennir was built from a checkout, without the catalog template: use a released vennir, or `vennir config set vennir source` (and source, the checkout)")
		}
		if mine != c.Vennir {
			return fmt.Errorf("this is vennir %s and the install runs %s: make its catalog with vennir %s, whose template its console reads (or upgrade the install first)", mine, c.Vennir, c.Vennir)
		}
		sums, err := releases.Checksums(ctx, mine)
		if err != nil {
			return err
		}
		pinSums = sums
	}
	statuses := tools.CheckAll(ctx, tools.ForCatalog())
	for _, s := range statuses {
		if !s.OK() {
			return fmt.Errorf("%s: %s %s", s.Tool, s.Problem, s.Install)
		}
	}

	// What the install made: the registry and the federation; and the GitHub
	// side.
	setup, err := a.catalogSetup(ctx, dir, c)
	if err != nil {
		return err
	}
	gh := githost.NewGitHub(a.runner)
	if err := sameIdentity(c.Access.GitHub, access.CheckGitHub(ctx, a.runner.Exec).Identity); err != nil {
		return err
	}
	me, err := gh.Me(ctx)
	if err != nil {
		return err
	}
	if missing := me.MissingScopes(); len(missing) > 0 {
		return fmt.Errorf("your gh token lacks %s: `gh auth refresh -s %s`", strings.Join(missing, ", "), strings.Join(missing, ","))
	}
	org, err := gh.IsOrganization(ctx, cat.Owner)
	if err != nil {
		return err
	}
	exists, err := gh.Exists(ctx, cat.Repo())
	if err != nil {
		return err
	}
	// One that exists but is empty (a run stopped before its push) gets
	// the push.
	push := !exists
	// One that isn't pushed and published elsewhere last (another
	// registry, after --take-over) is republished by a run by hand.
	republish := false
	if exists {
		if push, err = gh.HasBranches(ctx, cat.Repo()); err != nil {
			return err
		}
		push = !push
		if !push && !cat.UseExisting {
			return fmt.Errorf("github.com/%s already exists and isn't the one this install chose: `vennir config set catalog.useExisting true` to use it (its contents stay), or another catalog.repository", cat.Repo())
		}
		current, _, err := gh.Variable(ctx, cat.Repo(), "VENNIR_REGISTRY")
		if err != nil {
			return err
		}
		if err := ownedElsewhere(cat.Repo(), current, setup.registry, takeOver); err != nil {
			return err
		}
		republish = current != setup.registry
	}
	// Environments (the publish job's main-only gate, the reviewed image deletion)
	// need a paid plan on a private repository; on GitHub Free the
	// workflows run without them and the secrets sit at repository level.
	// An unknown plan counts as free: GitHub doesn't always say.
	paid := me.Plan != "" && me.Plan != "free"
	environments := cat.Visibility == "public" || (!org && paid)
	owners := "@" + cat.Owner
	if org {
		owners = "@" + cat.Owner + "/catalog-admins"
	}

	p := &plan.Plan{Title: fmt.Sprintf("Catalog github.com/%s (%s) for Vennir [%s]", cat.Repo(), cat.Visibility, envName(dir))}
	starters := strings.Join(cat.Languages, ", ")
	if starters == "" {
		starters = "none"
	}
	p.Settings = []plan.Line{
		{Label: "Signed in", Text: fmt.Sprintf("%s on GitHub (%s plan); gh runs as you", me.Login, orDefault(me.Plan, "unknown"))},
		{Label: "Team", Text: fmt.Sprintf("%s, with starters in %s", cat.Team, starters)},
		{Label: "Owners", Text: owners + " approve every change (CODEOWNERS)"},
		{Label: "Publishes to", Text: setup.registry + ", signing in through federation (main only, no key)"},
		{Label: "Release", Text: setup.registry + "/catalog-release, which the console reads and applies (no console credential in CI)"},
	}
	if exists && !push && republish {
		p.Changes = append(p.Changes, plan.Line{Label: "Exists", Text: "the repository is left as it is: its variables are set, and catalog-ci run by hand to republish every product to " + setup.registry})
	} else if exists && !push {
		p.Changes = append(p.Changes, plan.Line{Label: "Exists", Text: "the repository is left as it is: only its variables are set"})
	} else if exists {
		p.Changes = append(p.Changes, plan.Line{Label: "Will push", Text: fmt.Sprintf("main to the existing, empty repository: the template, teams/%s and its starters", cat.Team)})
	} else {
		p.Changes = append(p.Changes,
			plan.Line{Label: "Will create", Text: fmt.Sprintf("github.com/%s, %s, from the catalog template", cat.Repo(), cat.Visibility)},
			plan.Line{Label: "Will push", Text: fmt.Sprintf("main: the template, teams/%s and its starters", cat.Team)})
	}
	p.Changes = append(p.Changes,
		plan.Line{Label: "Will set", Text: "variables VENNIR_REGISTRY, " + variableNames(setup.signing) + " (" + setup.signing[0][1] + "), " + variableNames(setup.variables)},
		plan.Line{Label: "Will remove", Text: "a console URL and tokens an earlier vennir gave the repository, if any (and revoke those tokens)"})
	if environments {
		p.Changes = append(p.Changes, plan.Line{Label: "Environments", Text: "catalog-publish (main only), purge (main only, you review: deleting a removed team's images)"})
		p.Notes = append(p.Notes, "Not made: main's ruleset (code-owner review, and the checks check, secrets, code and codeowners). Until you add it, a failing check doesn't block a merge (publishing still reruns the scans): the catalog's README, \"Protecting main\".")
	} else {
		p.Notes = append(p.Notes, "Skipped: Environments and branch rules, which a private repository needs a paid GitHub plan for. The publish job still runs from main only (federation refuses other branches: on AWS, its tokens' subject names the branch).")
	}
	p.Notes = append(p.Notes, "Team "+cat.Team+" (and its namespace) is made by the console when it applies the first release, not before.")
	if !noSmoke && len(cat.Languages) > 0 {
		on := "main's last commit"
		switch {
		case push:
			on = "the push"
		case republish:
			on = "the run by hand"
		}
		p.Notes = append(p.Notes, "Then: waits for CI on "+on+", has the console apply the release, and runs the "+config.Languages[cat.Languages[0]]+" starter as a smoke test.")
	}
	p.Render(out)
	if planOnly {
		return nil
	}
	if !yes {
		ok, err := a.ask.Confirm("Go ahead?", false)
		if err != nil {
			return err
		}
		if !ok || !a.ask.Interactive {
			return errStopped
		}
	}

	// The console, as the admin, over a port-forward: it needn't be public.
	// The password apply saved, if it's still there.
	saved := filepath.Join(dir, "admin-password")
	password := ""
	if os.Getenv("VENNIR_ADMIN_PASSWORD") == "" {
		if b, err := os.ReadFile(saved); err == nil && strings.TrimSpace(string(b)) != "" {
			password = strings.TrimSpace(string(b))
			fmt.Fprintln(out, "Signing in with the password in", saved+".")
		}
	}
	if password == "" {
		if password, err = a.ask.Secret("Password of "+c.Admin.Email+" on the console", "VENNIR_ADMIN_PASSWORD"); err != nil {
			return err
		}
	}
	fwd, err := platform.ForwardConsole(ctx, c, out)
	if err != nil {
		return err
	}
	defer fwd.Stop()
	api := consoleapi.New(fwd.URL)
	if err := api.SignIn(ctx, c.Admin.Email, password); err != nil {
		return err
	}
	if err := a.changeGeneratedPassword(ctx, out, dir, c, api, password); err != nil {
		return err
	}

	repo := cat.Repo()
	work := ""
	if push {
		work, err = os.MkdirTemp("", "vennir-catalog-*")
		if err != nil {
			return err
		}
		defer os.RemoveAll(work)
		template := filepath.Join(c.Source, "catalog-template")
		if pinSums != nil {
			unpacked, err := os.MkdirTemp("", "vennir-template-*")
			if err != nil {
				return err
			}
			defer os.RemoveAll(unpacked)
			if template, err = catalogtemplate.Extract(unpacked); err != nil {
				return err
			}
		}
		products, err := catalog.Assemble(catalog.Options{
			Template: template, Team: cat.Team, Owners: owners,
			Languages: cat.Languages, Registry: setup.registry,
		}, work)
		if err != nil {
			return err
		}
		if pinSums != nil {
			if err := catalog.Pin(filepath.Join(work, "vennir"), c.Vennir, pinSums); err != nil {
				return err
			}
		}
		fmt.Fprintf(out, "Assembled the catalog: team %s, starters %s.\n", cat.Team, strings.Join(products, ", "))
		if err := validateCatalog(ctx, work); err != nil {
			return err
		}
		if !exists {
			fmt.Fprintln(out, "Creating", "github.com/"+repo, "...")
			if err := gh.CreateRepository(ctx, cat.Owner, cat.Repository, cat.Visibility, "Vennir catalog: what teams offer, as products", org); err != nil {
				return err
			}
			// This install made it: later runs may update it.
			c.Catalog.UseExisting = true
			if err := c.Save(dir); err != nil {
				return err
			}
		}
	}

	// The federation trusts the repository by its id and its owner's,
	// known only now it exists: AWS by the subject GitHub's tokens carry,
	// GCP by the provider's condition.
	switch c.Target {
	case "aws":
		if err := a.trustCatalogSubject(ctx, out, dir, c, gh, repo); err != nil {
			return err
		}
	case "gcp":
		if err := a.trustCatalogRepositoryGCP(ctx, out, dir, c, gh, repo); err != nil {
			return err
		}
	}

	// Variables before the push, so its first CI run has them.
	// Another cloud's sign-in, left from before, would make the publish job
	// try a cloud this install doesn't use.
	for _, name := range cloudVariables {
		if !hasVariable(setup.variables, name) {
			if err := gh.DeleteVariable(ctx, repo, name); err != nil {
				return err
			}
		}
	}
	for _, v := range append(append([][2]string{{"VENNIR_REGISTRY", setup.registry}}, setup.signing...), setup.variables...) {
		if err := gh.SetVariable(ctx, repo, v[0], v[1]); err != nil {
			return err
		}
	}
	if !hasVariable(setup.signing, "VENNIR_SIGNING_KEY") {
		// A key from an earlier signing mode would make CI try it.
		if err := gh.DeleteVariable(ctx, repo, "VENNIR_SIGNING_KEY"); err != nil {
			return err
		}
	}
	for _, name := range oldCatalogVariables {
		if err := gh.DeleteVariable(ctx, repo, name); err != nil {
			return err
		}
	}
	for _, s := range oldCatalogSecrets {
		if err := gh.DeleteSecret(ctx, repo, s[0], s[1]); err != nil {
			return err
		}
	}
	for _, label := range oldTokenLabels(repo) {
		if n, err := api.RevokeOthers(ctx, label, ""); err != nil {
			return err
		} else if n > 0 {
			fmt.Fprintf(out, "Revoked %d console token(s) the catalog no longer needs (%s).\n", n, label)
		}
	}
	if environments {
		myID, err := gh.UserID(ctx, me.Login)
		if err != nil {
			return err
		}
		for _, env := range []struct {
			name      string
			reviewers []int64
		}{{"catalog-publish", nil}, {"purge", []int64{myID}}} {
			if err := gh.CreateEnvironment(ctx, repo, env.name, env.reviewers); err != nil {
				return fmt.Errorf("environment %s: %w", env.name, err)
			}
		}
	}
	// Secrets added by hand at repository level (a signing key, a registry
	// password) reach every pull request's workflows; they belong in the
	// main-only Environment, or not at all (OIDC, keyless signing).
	if names, err := gh.RepositorySecrets(ctx, repo); err == nil && len(names) > 0 {
		where := "the catalog-publish Environment (main only)"
		if !environments {
			where = "nowhere: this repository has no Environments, so use OIDC for the registry and keyless signing, which need no secret"
		}
		fmt.Fprintf(out, "Warning: repository-level secrets %s are given to every pull request's workflows, which can print them. Move them to %s.\n",
			strings.Join(names, ", "), where)
	}
	if push {
		fmt.Fprintln(out, "Pushing main...")
		if err := gh.Push(ctx, work, repo); err != nil {
			return err
		}
	}
	// One that isn't pushed last ran CI with the old variables: a run by
	// hand republishes every product with these. It's told from the
	// commit's earlier runs by id, not by time (clocks differ).
	var by *dispatch
	if !push && republish {
		fmt.Fprintln(out, "Republishing every product to", setup.registry, "(catalog-ci, run by hand)...")
		commit, err := gh.Head(ctx, repo, "main")
		if err != nil {
			return err
		}
		earlier, err := gh.Runs(ctx, repo, commit)
		if err != nil {
			return err
		}
		by = &dispatch{commit: commit}
		for _, r := range earlier {
			by.after = max(by.after, r.ID)
		}
		if err := gh.Dispatch(ctx, repo, "ci.yml", "main"); err != nil {
			return fmt.Errorf("couldn't run catalog-ci by hand (an older catalog's ci.yml may not allow workflow_dispatch: take it from catalog-template, or push any change to main to publish): %w", err)
		}
	}
	fmt.Fprintf(out, "The catalog is at https://github.com/%s\n", repo)
	if noSmoke || len(cat.Languages) == 0 {
		return nil
	}
	return a.smokeTest(ctx, out, c, gh, api, setup, by)
}

// catalogSetup reads what the install made from the module's outputs.
func (a *app) catalogSetup(ctx context.Context, dir string, c *config.Config) (*catalogSetup, error) {
	tf := tofu.In(a.runner, dir)
	outputs, err := tf.Outputs(ctx)
	if err != nil {
		return nil, fmt.Errorf("read the install's cloud side (run `vennir apply` first): %w", err)
	}
	if c.Target == "aws" {
		return a.catalogSetupAWS(ctx, c, outputs)
	}
	cloud, err := cloudFromGCP(outputs)
	if err != nil {
		return nil, err
	}
	if cloud.CatalogProvider == "" {
		return nil, errors.New("the install has no federation for the catalog yet: run `vennir apply` (it creates it from catalog.owner and catalog.repository)")
	}
	if err := gcp.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	if c.Signing == "kms" && cloud.SigningKey == "" {
		return nil, errors.New("the install has no signing key yet: run `vennir apply` (it makes it, as signing is kms)")
	}
	return &catalogSetup{
		registry: cloud.TaskRegistry,
		variables: [][2]string{
			{"GCP_WORKLOAD_IDENTITY_PROVIDER", cloud.CatalogProvider}, {"PUBLISH_GCP_SERVICE_ACCOUNT", cloud.CatalogServiceAccount},
		},
		signing: signingVariables(c, cloud.SigningKey),
	}, nil
}

// catalogSetupAWS is catalogSetup for aws: ECR and the GitHub role.
func (a *app) catalogSetupAWS(ctx context.Context, c *config.Config, outputs map[string]json.RawMessage) (*catalogSetup, error) {
	cloud, _, err := cloudFromAWS(outputs)
	if err != nil {
		return nil, err
	}
	if cloud.CatalogServiceAccount == "" {
		return nil, errors.New("the install has no GitHub role for the catalog yet: run `vennir apply` (it creates it from catalog.owner and catalog.repository)")
	}
	if err := awscloud.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	if c.Signing == "kms" && cloud.SigningKey == "" {
		return nil, errors.New("the install has no signing key yet: run `vennir apply` (it makes it, as signing is kms)")
	}
	return &catalogSetup{
		registry:  cloud.TaskRegistry,
		variables: [][2]string{{"AWS_ROLE_ARN", cloud.CatalogServiceAccount}, {"AWS_REGION", c.AWS.Region}},
		signing:   signingVariables(c, cloud.SigningKey),
	}, nil
}

// cloudVariables are every cloud's sign-in variables the template reads.
var cloudVariables = []string{"GCP_WORKLOAD_IDENTITY_PROVIDER", "PUBLISH_GCP_SERVICE_ACCOUNT", "AWS_ROLE_ARN", "AWS_REGION"}

func hasVariable(vars [][2]string, name string) bool {
	for _, v := range vars {
		if v[0] == name {
			return true
		}
	}
	return false
}

func variableNames(vars [][2]string) string {
	var names []string
	for _, v := range vars {
		names = append(names, v[0])
	}
	return strings.Join(names, ", ")
}

// smokeTest waits for CI on the pushed commit, has the console apply the
// release it pushed, then runs the first starter through the console and
// reports what it returned.
func (a *app) smokeTest(ctx context.Context, out io.Writer, c *config.Config, gh *githost.GitHub, api *consoleapi.Client, setup *catalogSetup, by *dispatch) error {
	cat := c.Catalog
	var commit string
	var err error
	if by != nil {
		commit = by.commit
	} else if commit, err = gh.Head(ctx, cat.Repo(), "main"); err != nil {
		return err
	}
	fmt.Fprintln(out, "Waiting for CI on", commit[:7], "...")
	runs, err := waitForRuns(ctx, gh, cat.Repo(), commit, by)
	if err != nil {
		return err
	}
	if failed := failedRuns(runs); len(failed) > 0 {
		// Once more, for what failed: a runner may have stumbled.
		fmt.Fprintln(out, "Rerunning what failed once...")
		for _, r := range failed {
			if err := gh.Rerun(ctx, cat.Repo(), r.ID); err != nil {
				return err
			}
		}
		time.Sleep(10 * time.Second)
		if runs, err = waitForRuns(ctx, gh, cat.Repo(), commit, by); err != nil {
			return err
		}
	}
	for _, r := range runs {
		fmt.Fprintf(out, "  %-22s %s\n", r.Workflow, r.Conclusion)
	}
	if len(failedRuns(runs)) > 0 {
		return fmt.Errorf("CI failed: see the runs at https://github.com/%s/actions", cat.Repo())
	}

	// Now rather than at the console's next look.
	applied, err := api.SyncCatalog(ctx)
	if err != nil {
		return err
	}
	switch {
	case applied.Release == "":
		return errors.New("the console reads no catalog release: run `vennir apply` (it sets the console's catalog.release)")
	case applied.Error != "":
		return fmt.Errorf("the console couldn't read the catalog's release: %s", applied.Error)
	case len(applied.Problems) > 0:
		return fmt.Errorf("the console applied the release except:\n  %s", strings.Join(applied.Problems, "\n  "))
	}
	fmt.Fprintf(out, "The console applied the release (commit %.7s).\n", applied.Commit)

	product := config.Languages[cat.Languages[0]]
	task := []consoleapi.Task{{
		ID: "smoke", Image: fmt.Sprintf("%s/%s/%s:latest", setup.registry, cat.Team, product),
		Action: "transform", Team: cat.Team,
		Inputs: map[string]any{"text": "hello from vennir"},
	}}
	id, err := api.Submit(ctx, "vennir smoke test", fmt.Sprintf("vennir-smoke-%d", time.Now().Unix()), task)
	// A new image's first scan takes a few minutes; the console asks to
	// try again until it's done.
	for deadline := time.Now().Add(10 * time.Minute); scanning(err) && time.Now().Before(deadline); {
		fmt.Fprintln(out, "Waiting for the console's first scan of the starter...")
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(30 * time.Second):
		}
		id, err = api.Submit(ctx, "vennir smoke test", fmt.Sprintf("vennir-smoke-%d", time.Now().Unix()), task)
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Running %s/%s (execution %s)...\n", cat.Team, product, id)
	execution, err := api.Wait(ctx, id, 15*time.Minute)
	if err != nil {
		return err
	}
	for _, t := range execution.Tasks {
		fmt.Fprintf(out, "  %s: %s %v %s\n", t.ID, t.State, t.Outputs, t.Failure)
	}
	if execution.State != "SUCCEEDED" {
		return fmt.Errorf("the smoke test %s", strings.ToLower(execution.State))
	}
	fmt.Fprintln(out, "The catalog works: a merge publishes and releases, the console applies it, and its products run.")
	return nil
}

// scanning says whether the console refused a run only until its scan of
// the image finishes.
func scanning(err error) bool {
	var r *consoleapi.Refusal
	return errors.As(err, &r) && (r.Failure == "IMAGE_SCAN_PENDING" || r.Failure == "IMAGE_SCAN_ERROR")
}

// waitForRuns waits until every run on commit has completed.
// dispatch is a run by hand on commit: the runs after the id it had.
type dispatch struct {
	commit string
	after  int64
}

// waitForRuns waits for a commit's CI runs to finish: with by, only the run
// started by hand, which must appear within a few minutes.
func waitForRuns(ctx context.Context, gh *githost.GitHub, repo, commit string, by *dispatch) ([]githost.Run, error) {
	var runs []githost.Run
	began := time.Now()
	failures := 0
	err := waitFor(ctx, 45*time.Minute, 20*time.Second, func() (bool, error) {
		all, err := gh.Runs(ctx, repo, commit)
		// A blip reaching GitHub (a TLS handshake timeout) isn't the end of
		// a wait this long; three in a row are.
		if err != nil {
			if failures++; failures == 3 {
				return false, err
			}
			return false, nil
		}
		failures = 0
		runs = sinceDispatch(all, by)
		if len(runs) == 0 {
			if by != nil && time.Since(began) > 5*time.Minute {
				return false, fmt.Errorf("the run by hand didn't start within 5 minutes: see https://github.com/%s/actions", repo)
			}
			return false, nil
		}
		for _, r := range runs {
			if r.Status != "completed" {
				return false, nil
			}
		}
		return true, nil
	})
	return runs, err
}

// sinceDispatch keeps the runs started by hand after by's, or all of them
// without one.
func sinceDispatch(runs []githost.Run, by *dispatch) []githost.Run {
	if by == nil {
		return runs
	}
	var kept []githost.Run
	for _, r := range runs {
		if r.Event == "workflow_dispatch" && r.ID > by.after {
			kept = append(kept, r)
		}
	}
	return kept
}

func failedRuns(runs []githost.Run) []githost.Run {
	var failed []githost.Run
	for _, r := range runs {
		if r.Conclusion != "success" && r.Conclusion != "skipped" {
			failed = append(failed, r)
		}
	}
	return failed
}

func waitFor(ctx context.Context, limit, every time.Duration, done func() (bool, error)) error {
	deadline := time.Now().Add(limit)
	for {
		ok, err := done()
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("gave up after %s", limit)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(every):
		}
	}
}

// validateCatalog runs the catalog's own checks (`vennir catalog validate`)
// on the assembled commit, before anything is pushed.
func validateCatalog(ctx context.Context, dir string) error {
	c := catalogtool.New(dir)
	var buf bytes.Buffer
	c.Stdout, c.Stderr = &buf, &buf
	ok, err := c.Products(ctx, "validate", nil, nil)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("the assembled catalog fails `vennir catalog validate`:\n%s", buf.String())
	}
	return nil
}

// trustCatalogSubject reads the repository's OIDC subject prefix and ids
// and, if the publish role doesn't trust them yet, records them and updates
// the role's trust.
func (a *app) trustCatalogSubject(ctx context.Context, out io.Writer, dir string, c *config.Config, gh *githost.GitHub, repo string) error {
	if err := ensureCatalogSubject(ctx, out, gh, repo); err != nil {
		return err
	}
	pinned, err := recordCatalogIDs(ctx, out, dir, c, gh, repo)
	if err != nil {
		return err
	}
	prefix, err := gh.SubjectPrefix(ctx, repo)
	if err != nil {
		return err
	}
	if !pinned && (prefix == c.Catalog.SubjectPrefix || (c.Catalog.SubjectPrefix == "" && prefix == "repo:"+repo)) {
		return nil
	}
	fmt.Fprintf(out, "GitHub names the repository %s (id %s, owner id %s) in its tokens: updating the publish role to trust exactly that...\n", prefix, c.Catalog.RepositoryID, c.Catalog.OwnerID)
	c.Catalog.SubjectPrefix = prefix
	if err := c.Save(dir); err != nil {
		return err
	}
	tf := tofu.In(a.runner, dir)
	if err := modules.Write("aws", tf.Path); err != nil {
		return err
	}
	if err := tf.Init(ctx); err != nil {
		return err
	}
	if err := a.writeAWSVars(ctx, c, tf, false); err != nil {
		return err
	}
	return tf.ApplyOnly(ctx, "aws_iam_role.publish[0]")
}

// trustCatalogRepositoryGCP pins the GCP federation (its provider's
// condition and the publish account's binding) to the repository's ids
// once it exists, rather than its name, re-applying just those two when the
// ids are new.
func (a *app) trustCatalogRepositoryGCP(ctx context.Context, out io.Writer, dir string, c *config.Config, gh *githost.GitHub, repo string) error {
	changed, err := recordCatalogIDs(ctx, out, dir, c, gh, repo)
	if err != nil || !changed {
		return err
	}
	fmt.Fprintf(out, "Pinning the catalog's federation to %s's id %s (owner id %s), not its name...\n", repo, c.Catalog.RepositoryID, c.Catalog.OwnerID)
	tf := tofu.In(a.runner, dir)
	if err := modules.Write("gcp", tf.Path); err != nil {
		return err
	}
	if err := tf.WriteVars(keepBackupBucket(ctx, tf, c, gcp.Vars(c, false), "google_storage_bucket.backups[0]")); err != nil {
		return err
	}
	if err := tf.Init(ctx); err != nil {
		return err
	}
	return tf.ApplyOnly(ctx, "google_iam_workload_identity_pool_provider.github[0]", "google_service_account_iam_member.publish_federation[0]")
}

// recordCatalogIDs reads the catalog repository's id and its owner's, and
// saves them when they're new; it says whether they were.
func recordCatalogIDs(ctx context.Context, out io.Writer, dir string, c *config.Config, gh *githost.GitHub, repo string) (bool, error) {
	ids, err := gh.RepositoryIDs(ctx, repo)
	if err != nil {
		return false, fmt.Errorf("reading %s's id, which its federation trusts: %w", repo, err)
	}
	if ids.Repository == c.Catalog.RepositoryID && ids.Owner == c.Catalog.OwnerID {
		return false, nil
	}
	if c.Catalog.RepositoryID != "" {
		fmt.Fprintf(out, "%s is now repository %s (owner %s), not %s (owner %s): trusting the new one.\n", repo, ids.Repository, ids.Owner, c.Catalog.RepositoryID, c.Catalog.OwnerID)
	}
	c.Catalog.RepositoryID, c.Catalog.OwnerID = ids.Repository, ids.Owner
	return true, c.Save(dir)
}

// ensureCatalogSubject has the catalog repository's OIDC tokens name their
// branch even in an Environment, and the repository's and its owner's ids:
// the AWS publish role trusts a job of the catalog-publish Environment only
// on main, and only of this repository, so its tokens must say all of it
// (modules/aws publish_trust). A catalog made before that trust is fixed
// by apply, before it changes the role (or its publishing would stop).
func ensureCatalogSubject(ctx context.Context, out io.Writer, gh *githost.GitHub, repo string) error {
	changed, err := gh.EnsureSubjectTemplate(ctx, repo)
	if err != nil {
		keys := ""
		for _, k := range githost.SubjectClaimKeys {
			keys += " -f 'include_claim_keys[]=" + k + "'"
		}
		return fmt.Errorf("setting %s's OIDC subject to name its branch and ids (the AWS publish role trusts main of this repository only): %w; with gh signed in as an admin of the repository, run this again, or set it yourself: gh api -X PUT repos/%s/actions/oidc/customization/sub -F use_default=false%s", repo, err, repo, keys)
	}
	if changed {
		fmt.Fprintf(out, "%s's OIDC tokens now name their branch and ids too (%s), as the publish role requires.\n", repo, strings.Join(githost.SubjectClaimKeys, ", "))
	}
	return nil
}

// changeGeneratedPassword has the admin choose their own password when the
// console wants it changed before anything else (apply's generated one, or
// a reset's), as the console's sign-in page would; the saved file, now
// stale, goes.
func (a *app) changeGeneratedPassword(ctx context.Context, out io.Writer, dir string, c *config.Config, api *consoleapi.Client, current string) error {
	must, err := api.MustChangePassword(ctx)
	if err != nil || !must {
		return err
	}
	if !a.ask.Interactive && os.Getenv("VENNIR_NEW_ADMIN_PASSWORD") == "" {
		return fmt.Errorf("the console wants %s's password changed first (it was generated): choose your own when you sign in to the console (`vennir console %s`), then run this again with it in VENNIR_ADMIN_PASSWORD, or set VENNIR_NEW_ADMIN_PASSWORD to change it here", c.Admin.Email, envName(dir))
	}
	fmt.Fprintln(out, "The console wants this password changed first (it was generated): choose your own, at least 12 characters.")
	next, err := a.ask.Secret("New password", "VENNIR_NEW_ADMIN_PASSWORD")
	if err != nil {
		return err
	}
	if os.Getenv("VENNIR_NEW_ADMIN_PASSWORD") == "" {
		again, err := a.ask.Secret("The new password again", "VENNIR_NEW_ADMIN_PASSWORD")
		if err != nil {
			return err
		}
		if again != next {
			return errors.New("the two new passwords differ: nothing was changed")
		}
	}
	if err := api.ChangePassword(ctx, current, next); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(dir, "admin-password")); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Fprintln(out, "Changed: sign in with your own from now on.")
	return nil
}
