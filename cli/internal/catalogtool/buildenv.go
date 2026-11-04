// SPDX-License-Identifier: MIT

package catalogtool

// Build Environments. A team listed in vennir.yaml's buildEnvironments has
// its products built in a GitHub Environment of its own, team-<name>, which
// only main may use, so values its builds need (a private package
// registry's token, say) reach that team's builds and nothing else. A job
// runs in one Environment only, and publishing's credentials are
// catalog-publish's, so catalog CI on main runs in three steps:
//
//	plan     catalog-publish   which products to publish, grouped by team (Plan)
//	build    team-<name>       that team's, its secrets offered to docker build;
//	                           saves the images, pushes nothing (BuildForEnvironment)
//	publish  catalog-publish   loads them (--images), then tests, scans, pushes
//	                           and signs them as it does every other product
//
// A pull request can't have a main-only Environment's secrets, so it only
// validates such a team's products; main builds, tests and scans them
// before anything is published. Values a step uses when it runs are the
// console's team secrets (secretRefs), never these.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
)

// buildSecretsVariable holds the Environment's secrets as a JSON object
// (catalog CI's toJSON(secrets)). Each is offered to docker build as a
// BuildKit secret of its own name, which a Dockerfile reads with
// RUN --mount=type=secret,id=NAME: never in a layer.
const buildSecretsVariable = "VENNIR_BUILD_SECRETS"

// buildSecretPrefix names the variable each secret reaches docker in: its
// own name could be one docker reads (DOCKER_HOST).
const buildSecretPrefix = "VENNIR_BUILD_SECRET_"

// publishingSecrets are the catalog's own (catalog-publish's): one that
// reaches a team's build is at repository level, where every job and pull
// request gets it, and a team's Dockerfile mustn't.
var publishingSecrets = []string{"COSIGN_PRIVATE_KEY", "COSIGN_PASSWORD", "REGISTRY_PASSWORD"}

var (
	buildSecretName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	teamFolder      = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	// plannedLabel is a product folder safe to hand a later job.
	plannedLabel = regexp.MustCompile(`^teams/[a-z0-9-]+/products/[a-z0-9-]+$`)
)

// environmentName is the GitHub Environment a team builds in.
func environmentName(team string) string { return "team-" + team }

// buildSecrets are the names offered to docker build and the variables
// that carry them: none when VENNIR_BUILD_SECRETS isn't set.
func (c *Catalog) buildSecrets() ([]string, []string, error) {
	raw := c.Getenv(buildSecretsVariable)
	if raw == "" {
		return nil, nil, nil
	}
	var values map[string]string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		// Never the decoder's message: it can quote the value.
		return nil, nil, fmt.Errorf("%s isn't a JSON object of strings", buildSecretsVariable)
	}
	var names []string
	for name := range values {
		// The job's own token, which toJSON(secrets) includes, is no build's.
		if strings.EqualFold(name, "github_token") {
			continue
		}
		if !buildSecretName.MatchString(name) {
			return nil, nil, fmt.Errorf("build secret %s: a name of letters, digits and _", quote(name))
		}
		if slices.Contains(publishingSecrets, strings.ToUpper(name)) {
			return nil, nil, fmt.Errorf("secret %s reached a team's build: it's a repository secret, which every job and pull request gets; move it to the catalog-publish Environment", name)
		}
		names = append(names, name)
	}
	sort.Strings(names)
	env := make([]string, 0, len(names))
	for _, name := range names {
		env = append(env, buildSecretPrefix+name+"="+values[name])
	}
	return names, env, nil
}

// ValidateBuildEnvironments: each team buildEnvironments lists is one of
// the catalog's, once.
func (c *Catalog) ValidateBuildEnvironments() bool {
	s, err := c.Settings()
	if err != nil {
		c.errorAt(c.path("vennir.yaml"), err.Error())
		return false
	}
	ok := true
	seen := map[string]bool{}
	for _, team := range s.BuildEnvironments {
		switch {
		case seen[team]:
			c.errorAt(c.path("vennir.yaml"), fmt.Sprintf("buildEnvironments: %s is listed twice", quote(team)))
			ok = false
		case !teamFolder.MatchString(team) || !isDir(c.path("teams", team)):
			c.errorAt(c.path("vennir.yaml"), fmt.Sprintf("buildEnvironments: %s isn't a team of this catalog (teams/<team>/)", quote(team)))
			ok = false
		}
		seen[team] = true
	}
	return ok
}

// checkProduct validates, builds, tests and scans one product. One whose
// team builds in its own Environment is loaded from that build (--images),
// or built where the Environment's values are (VENNIR_BUILD_SECRETS);
// anywhere else, such as a pull request, it's only validated, and never
// published.
func (c *Catalog) checkProduct(p *Product, s Settings, publishing bool) bool {
	if !c.ValidateProduct(p) {
		return false
	}
	if s.BuildsInEnvironment(p.Team()) {
		switch {
		case c.Images != "":
			return c.Load(p) && c.Test(p) && c.Scan(p)
		case c.Getenv(buildSecretsVariable) != "":
		case publishing:
			c.errorAt(p.Dir, fmt.Sprintf("team %s builds in its own Environment (buildEnvironments): publish the images its build made (--images), or set %s to build here", p.Team(), buildSecretsVariable))
			return false
		default:
			c.info("  validated only: team %s builds in Environment %s, which only main may use; main builds, tests and scans it before publishing", p.Team(), environmentName(p.Team()))
			return true
		}
	}
	return c.Build(p) && c.Test(p) && c.Scan(p)
}

// imageFile is where a team's build saves a product's image, under dir.
func imageFile(dir string, p *Product) string {
	return filepath.Join(dir, p.Team(), p.Name()+".tar")
}

// Load loads the image p's team's build saved, refusing a file that holds
// anything but p's own.
func (c *Catalog) Load(p *Product) bool {
	file := imageFile(c.Images, p)
	var err error
	if !exists(file) {
		err = fmt.Errorf("no image from the build in Environment %s (%s): see catalog-ci's build job for team %s", environmentName(p.Team()), c.rel(file), p.Team())
	} else {
		var result runResult
		if result, err = c.docker(true, "load", "--input", file); err == nil {
			if loaded := loadedImages(result.stdout); len(loaded) != 1 || loaded[0] != p.LocalImage() {
				err = fmt.Errorf("%s holds %s, not just %s", c.rel(file), strings.Join(loaded, ", "), p.LocalImage())
			}
		}
	}
	if err != nil {
		c.errorAt(p.Dir, err.Error())
		return false
	}
	c.info("  loaded the image built in Environment %s", environmentName(p.Team()))
	return true
}

// loadedImages are the tags docker load reports.
func loadedImages(output string) []string {
	var tags []string
	for _, line := range strings.Split(output, "\n") {
		if tag, ok := strings.CutPrefix(strings.TrimSpace(line), "Loaded image: "); ok {
			tags = append(tags, tag)
		}
	}
	return tags
}

// BuildForEnvironment builds products of one team that builds in its own
// Environment, offering its secrets to docker build, and saves each image
// to out/<team>/<product>.tar for publishing to load: catalog CI's build
// job. It pushes nothing, so it needs no registry credential.
func (c *Catalog) BuildForEnvironment(names []string, out string) (bool, error) {
	if len(names) == 0 {
		return false, errors.New("name the products to build (the plan's)")
	}
	s, err := c.Settings()
	if err != nil {
		return false, err
	}
	products, err := c.SelectProducts(names, nil)
	if err != nil {
		return false, err
	}
	team := products[0].Team()
	for _, p := range products {
		switch {
		case p.IsTemplate() || !s.BuildsInEnvironment(p.Team()):
			return false, fmt.Errorf("%s: team %s doesn't build in an Environment of its own (buildEnvironments in vennir.yaml)", p.Label(), p.Team())
		case p.Team() != team:
			return false, fmt.Errorf("one team's products per build, each team in its own Environment: %s and %s", team, p.Team())
		}
	}
	ok := true
	for _, p := range products {
		end := c.group(p.Label())
		built := c.ValidateProduct(p) && c.Build(p) && c.save(p, out)
		c.info("%s %s", passFail(built), p.Label())
		ok = ok && built
		end()
	}
	return ok, nil
}

func (c *Catalog) save(p *Product, out string) bool {
	file := imageFile(out, p)
	err := os.MkdirAll(filepath.Dir(file), 0o755)
	if err == nil {
		_, err = c.docker(false, "save", "--output", file, p.LocalImage())
	}
	if err != nil {
		c.errorAt(p.Dir, "saving its image: "+err.Error())
		return false
	}
	return true
}

// PlannedBuild is one team's build in its Environment.
type PlannedBuild struct {
	Team     string   `json:"team"`
	Products []string `json:"products"`
}

// Plan is the builds publishing needs: for each team that builds in its own
// Environment, its products publish would choose (changed since
// changedSince, and on main what isn't published yet). In CI it first
// checks each one's Environment can be used from main only, since a job
// naming one that doesn't exist makes it, usable from any branch.
func (c *Catalog) Plan(ctx context.Context, changedSince *string) ([]PlannedBuild, bool, error) {
	s, err := c.Settings()
	if err != nil {
		return nil, false, err
	}
	if !c.ValidateBuildEnvironments() {
		return nil, false, nil
	}
	products, err := c.SelectProducts(nil, changedSince)
	if err != nil {
		return nil, false, err
	}
	if changedSince != nil && c.Getenv("GITHUB_SHA") != "" {
		if problems := s.Problems(); len(problems) > 0 {
			for _, p := range problems {
				c.errorAt(c.path("vennir.yaml"), p)
			}
			return nil, false, nil
		}
		products = c.withUnpublished(ctx, products, s)
	}
	ok := true
	var teams []string
	byTeam := map[string][]string{}
	for _, p := range products {
		if p.IsTemplate() || !s.BuildsInEnvironment(p.Team()) {
			continue
		}
		if !plannedLabel.MatchString(p.Label()) {
			c.errorAt(p.Dir, "a product's folder is a lowercase name: letters, digits and -")
			ok = false
			continue
		}
		if byTeam[p.Team()] == nil {
			teams = append(teams, p.Team())
		}
		byTeam[p.Team()] = append(byTeam[p.Team()], p.Label())
	}
	repo := c.Getenv("GITHUB_REPOSITORY")
	builds := []PlannedBuild{}
	for _, team := range teams {
		if repo != "" {
			if problem := c.environmentProblem(repo, team); problem != "" {
				c.errorAt(c.path("vennir.yaml"), problem)
				ok = false
				continue
			}
		}
		c.info("Building in Environment %s: %s", environmentName(team), strings.Join(byTeam[team], ", "))
		builds = append(builds, PlannedBuild{Team: team, Products: byTeam[team]})
	}
	return builds, ok, nil
}

// ghError is a gh api call's failure.
type ghError struct {
	call     string
	message  string
	notFound bool
}

func (e *ghError) Error() string { return "gh api " + e.call + ": " + e.message }

// ghAPI runs gh api (as whoever gh is signed in as: GH_TOKEN in CI).
func (c *Catalog) ghAPI(args ...string) (string, error) {
	result, err := c.run(time.Minute, true, "gh", append([]string{"api"}, args...)...)
	if err != nil {
		return "", err
	}
	if result.code != 0 {
		message := lastChars(strings.TrimSpace(result.stderr), 300)
		return "", &ghError{call: strings.Join(args, " "), message: message, notFound: strings.Contains(message, "HTTP 404")}
	}
	return result.stdout, nil
}

type branchPolicy struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// environment is what a GitHub Environment allows, as far as these
// checks care.
type environment struct {
	exists bool
	// custom: deployments only from the branches policies name (else from
	// any branch, or any protected one).
	custom   bool
	policies []branchPolicy
	// update keeps the Environment's reviewers, wait timer and admin bypass
	// when its branch rule is replaced (a PUT sets what it's given).
	update map[string]any
}

func (e environment) mainOnly() bool {
	if !e.custom || len(e.policies) != 1 {
		return false
	}
	p := e.policies[0]
	return p.Name == "main" && (p.Type == "" || p.Type == "branch")
}

func (c *Catalog) environment(repo, name string) (environment, error) {
	path := "repos/" + repo + "/environments/" + name
	body, err := c.ghAPI(path)
	var gerr *ghError
	if errors.As(err, &gerr) && gerr.notFound {
		return environment{update: map[string]any{}}, nil
	}
	if err != nil {
		return environment{}, err
	}
	var read struct {
		AdminsBypass *bool `json:"can_admins_bypass"`
		Policy       *struct {
			Custom bool `json:"custom_branch_policies"`
		} `json:"deployment_branch_policy"`
		Rules []struct {
			Type              string `json:"type"`
			WaitTimer         *int   `json:"wait_timer"`
			PreventSelfReview *bool  `json:"prevent_self_review"`
			Reviewers         []struct {
				Type     string `json:"type"`
				Reviewer struct {
					ID int64 `json:"id"`
				} `json:"reviewer"`
			} `json:"reviewers"`
		} `json:"protection_rules"`
	}
	if err := json.Unmarshal([]byte(body), &read); err != nil {
		return environment{}, fmt.Errorf("Environment %s: %w", name, err)
	}
	e := environment{exists: true, custom: read.Policy != nil && read.Policy.Custom, update: map[string]any{}}
	if read.AdminsBypass != nil {
		e.update["can_admins_bypass"] = *read.AdminsBypass
	}
	for _, rule := range read.Rules {
		switch rule.Type {
		case "wait_timer":
			if rule.WaitTimer != nil {
				e.update["wait_timer"] = *rule.WaitTimer
			}
		case "required_reviewers":
			var reviewers []map[string]any
			for _, r := range rule.Reviewers {
				reviewers = append(reviewers, map[string]any{"type": r.Type, "id": r.Reviewer.ID})
			}
			e.update["reviewers"] = reviewers
			if rule.PreventSelfReview != nil {
				e.update["prevent_self_review"] = *rule.PreventSelfReview
			}
		}
	}
	if e.custom {
		body, err := c.ghAPI(path + "/deployment-branch-policies?per_page=100")
		if err != nil {
			return environment{}, err
		}
		var list struct {
			Policies []branchPolicy `json:"branch_policies"`
		}
		if err := json.Unmarshal([]byte(body), &list); err != nil {
			return environment{}, fmt.Errorf("Environment %s's branch policies: %w", name, err)
		}
		e.policies = list.Policies
	}
	return e, nil
}

// environmentProblem is why team's Environment mustn't be given its
// secrets, or "".
func (c *Catalog) environmentProblem(repo, team string) string {
	name := environmentName(team)
	e, err := c.environment(repo, name)
	switch {
	case err != nil:
		return fmt.Sprintf("reading Environment %s: %v", name, err)
	case !e.exists:
		return fmt.Sprintf("team %s builds in Environment %s, which doesn't exist (or this job's token can't read it: catalog-ci's plan job needs actions: read): a catalog admin runs ./vennir catalog environments", team, name)
	case !e.mainOnly():
		return fmt.Sprintf("Environment %s can be used from more than main, so a pull request could have its secrets: a catalog admin runs ./vennir catalog environments", name)
	}
	return ""
}

// Environments makes each buildEnvironments team's Environment and limits
// it to main, leaving its secrets, reviewers and wait timer as they are. A
// catalog admin runs it (gh signed in as them) after listing a team, and
// before adding the team's secrets to it.
func (c *Catalog) Environments(repo string) (bool, error) {
	s, err := c.Settings()
	if err != nil {
		return false, err
	}
	if !c.ValidateBuildEnvironments() {
		return false, nil
	}
	if len(s.BuildEnvironments) == 0 {
		c.info("No team builds in an Environment of its own (buildEnvironments in vennir.yaml).")
		return true, nil
	}
	if repo == "" {
		if repo, err = c.repository(); err != nil {
			return false, err
		}
	}
	ok := true
	for _, team := range s.BuildEnvironments {
		if err := c.ensureEnvironment(repo, environmentName(team)); err != nil {
			c.errorAt("", err.Error())
			ok = false
		}
	}
	return ok, nil
}

func (c *Catalog) ensureEnvironment(repo, name string) error {
	path := "repos/" + repo + "/environments/" + name
	e, err := c.environment(repo, name)
	if err != nil {
		return err
	}
	if e.mainOnly() {
		c.info("%s: main only already", name)
		return nil
	}
	if !e.custom {
		e.update["deployment_branch_policy"] = map[string]any{"protected_branches": false, "custom_branch_policies": true}
		body, _ := json.Marshal(e.update)
		file, err := os.CreateTemp("", "vennir-environment-*.json")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		_, err = file.Write(body)
		if cerr := file.Close(); err == nil {
			err = cerr
		}
		if err == nil {
			_, err = c.ghAPI("--method", "PUT", path, "--input", file.Name())
		}
		if err != nil {
			var gerr *ghError
			if errors.As(err, &gerr) && !e.exists {
				return fmt.Errorf("making Environment %s (a private repository on GitHub Free has none: a team that needs build values keeps a catalog repository of its own): %w", name, err)
			}
			return err
		}
		if e.exists {
			c.info("%s: deployments limited to the branches it names", name)
		} else {
			c.info("%s: made", name)
		}
	}
	main := false
	for _, p := range e.policies {
		if !main && p.Name == "main" && (p.Type == "" || p.Type == "branch") {
			main = true
			continue
		}
		if _, err := c.ghAPI("--method", "DELETE", fmt.Sprintf("%s/deployment-branch-policies/%d", path, p.ID)); err != nil {
			return err
		}
		c.info("%s: removed %s %s", name, orDefault(p.Type, "branch"), p.Name)
	}
	if !main {
		if _, err := c.ghAPI("--method", "POST", path+"/deployment-branch-policies", "-f", "name=main", "-f", "type=branch"); err != nil {
			return err
		}
		c.info("%s: main only", name)
	}
	return nil
}

// githubRemote is a GitHub remote's owner/name.
var githubRemote = regexp.MustCompile(`github\.com[:/]([^/]+/[^/]+?)(\.git)?/?$`)

// repository is the catalog's GitHub repository, from its origin remote.
func (c *Catalog) repository() (string, error) {
	url, err := c.git("remote", "get-url", "origin")
	if m := githubRemote.FindStringSubmatch(strings.TrimSpace(url)); err == nil && m != nil {
		return m[1], nil
	}
	return "", errors.New("this catalog's origin isn't a GitHub repository: pass --repo OWNER/NAME")
}

func orDefault(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
