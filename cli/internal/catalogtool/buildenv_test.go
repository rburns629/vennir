// SPDX-License-Identifier: MIT

package catalogtool

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// buildEnvCatalog has team a, which builds in its own Environment, and
// team b, which doesn't.
func buildEnvCatalog(t *testing.T) *Catalog {
	t.Helper()
	files := product("mine", "[]")
	files["teams/b/products/theirs/product.yaml"] = productFile("theirs", "b", "[]")
	files["teams/b/products/theirs/Dockerfile"] = "FROM scratch\nUSER 65532:65532\n"
	files["vennir.yaml"] = "registry: registry.test/catalog\nbuildEnvironments: [a]\n"
	return catalogWith(t, files)
}

// fakeBuildTools puts a docker and a gh that log their calls on PATH, and
// has c read env. docker load reports $FAKE_LOADED; docker build logs the
// secret it was handed; gh api answers a GET from gh-answers/<path, / and ? as _>
// and logs a write's --input.
func fakeBuildTools(t *testing.T, c *Catalog, env map[string]string) (string, string) {
	t.Helper()
	bin := t.TempDir()
	log := filepath.Join(bin, "calls")
	answers := filepath.Join(bin, "gh-answers")
	if err := os.Mkdir(answers, 0o755); err != nil {
		t.Fatal(err)
	}
	docker := `#!/bin/sh
echo "docker $*" >> "` + log + `"
case "$1" in
  load) echo "Loaded image: $FAKE_LOADED" ;;
  save) touch "$3" ;;
  build) echo "secret NPM_TOKEN=$VENNIR_BUILD_SECRET_NPM_TOKEN" >> "` + log + `" ;;
esac
`
	gh := `#!/bin/sh
echo "gh $*" >> "` + log + `"
shift
method=GET
if [ "$1" = --method ]; then method=$2; shift 2; fi
path=$1
if [ "$method" != GET ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = --input ]; then echo "body $(cat "$2")" >> "` + log + `"; fi
    shift
  done
  echo '{}'; exit 0
fi
file="` + answers + `/$(echo "$path" | tr '/?=&' '____')"
if [ -f "$file" ]; then cat "$file"; exit 0; fi
echo "gh: Not Found (HTTP 404)" >&2; exit 1
`
	for file, script := range map[string]string{"docker": docker, "gh": gh} {
		if err := os.WriteFile(filepath.Join(bin, file), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	c.Getenv = func(key string) string {
		if key == "DOCKER" {
			return filepath.Join(bin, "docker")
		}
		return env[key]
	}
	return log, answers
}

func answer(t *testing.T, answers, path, body string) {
	t.Helper()
	name := strings.NewReplacer("/", "_", "?", "_", "=", "_", "&", "_").Replace(path)
	if err := os.WriteFile(filepath.Join(answers, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func calls(t *testing.T, log string) string {
	t.Helper()
	data, _ := os.ReadFile(log)
	return string(data)
}

func TestBuildSecretsAreOfferedByNameNeverAsTheirOwnVariables(t *testing.T) {
	c := buildEnvCatalog(t)
	log, _ := fakeBuildTools(t, c, map[string]string{
		buildSecretsVariable: `{"NPM_TOKEN": "s3cret", "github_token": "ghs_x"}`,
	})
	if !c.Build(c.AllProducts()[0]) {
		t.Fatal("not built")
	}
	got := calls(t, log)
	if !strings.Contains(got, "--secret id=NPM_TOKEN,env=VENNIR_BUILD_SECRET_NPM_TOKEN") {
		t.Errorf("NPM_TOKEN not offered as a BuildKit secret:\n%s", got)
	}
	if !strings.Contains(got, "secret NPM_TOKEN=s3cret") {
		t.Errorf("its value didn't reach docker:\n%s", got)
	}
	if strings.Contains(got, "github_token") || strings.Contains(got, "s3cret --") {
		t.Errorf("the job's token offered, or a value on the command line:\n%s", got)
	}

	for raw, want := range map[string]string{
		`{"BAD-NAME": "x"}`:                "build secret 'BAD-NAME': a name of letters, digits and _",
		`{"A": "s3cret",`:                  "VENNIR_BUILD_SECRETS isn't a JSON object of strings",
		`{"A": ["s3cret"]}`:                "VENNIR_BUILD_SECRETS isn't a JSON object of strings",
		`"just a string"`:                  "VENNIR_BUILD_SECRETS isn't a JSON object of strings",
		`{"A": 5, "B": "x"}`:               "VENNIR_BUILD_SECRETS isn't a JSON object of strings",
		`{"COSIGN_PRIVATE_KEY": "s3cret"}`: "secret COSIGN_PRIVATE_KEY reached a team's build: it's a repository secret, which every job and pull request gets; move it to the catalog-publish Environment",
	} {
		c.Getenv = func(key string) string {
			if key == buildSecretsVariable {
				return raw
			}
			return ""
		}
		_, _, err := c.buildSecrets()
		if err == nil || err.Error() != want || strings.Contains(err.Error(), "s3cret") {
			t.Errorf("%s: %v, want %q", raw, err, want)
		}
	}
}

// A pull request has no Environment's secrets: a product of a team that
// builds in one is only validated there, and publishing it takes the
// images its build made.
func TestATeamsEnvironmentBuildsItsProducts(t *testing.T) {
	c := buildEnvCatalog(t)
	s, err := c.Settings()
	if err != nil {
		t.Fatal(err)
	}
	var mine, theirs *Product
	for _, p := range c.AllProducts() {
		if p.Team() == "a" {
			mine = p
		} else {
			theirs = p
		}
	}
	log, _ := fakeBuildTools(t, c, nil)

	if out := errorsOf(t, func(c *Catalog) bool { return c.checkProduct(mine, s, false) }, c); !strings.Contains(out, "validated only: team a builds in Environment team-a") {
		t.Errorf("a pull request's check: %s", out)
	}
	if strings.Contains(calls(t, log), "docker build") {
		t.Errorf("built without its Environment:\n%s", calls(t, log))
	}
	if out := errorsOf(t, func(c *Catalog) bool { return c.checkProduct(mine, s, true) }, c); !strings.Contains(out, "publish the images its build made (--images)") {
		t.Errorf("published without its build: %s", out)
	}

	// --images: loaded, never built, and only if the file holds it alone.
	images := t.TempDir()
	c.Images = images
	if c.Load(mine) {
		t.Error("loaded with no image saved")
	}
	if err := os.MkdirAll(filepath.Join(images, "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(images, "a", "mine.tar"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_LOADED", "vennir-catalog/b/theirs:ci")
	if out := errorsOf(t, func(c *Catalog) bool { return c.Load(mine) }, c); !strings.Contains(out, "holds vennir-catalog/b/theirs:ci, not just vennir-catalog/a/mine:ci") {
		t.Errorf("another product's image loaded: %s", out)
	}
	t.Setenv("FAKE_LOADED", mine.LocalImage())
	if !c.Load(mine) {
		t.Error("its own image refused")
	}
	if strings.Contains(calls(t, log), "docker build") {
		t.Errorf("built though its image was given:\n%s", calls(t, log))
	}

	// Another team's products are built as ever, --images or not.
	if err := os.Truncate(log, 0); err != nil {
		t.Fatal(err)
	}
	c.Build(theirs)
	if got := calls(t, log); !strings.Contains(got, "docker build") || strings.Contains(got, "--secret") {
		t.Errorf("team b's build:\n%s", got)
	}
}

func TestBuildingForAnEnvironmentSavesOneTeamsImages(t *testing.T) {
	c := buildEnvCatalog(t)
	log, _ := fakeBuildTools(t, c, nil)
	out := t.TempDir()
	// SelectProducts resolves the names given, so the root must be too (a
	// Mac's temporary folders are under a symlink).
	root, err := filepath.EvalSymlinks(c.Root)
	if err != nil {
		t.Fatal(err)
	}
	c.Root = root
	t.Chdir(root)
	if _, err := c.BuildForEnvironment([]string{"teams/b/products/theirs"}, out); err == nil || !strings.Contains(err.Error(), "team b doesn't build in an Environment of its own") {
		t.Errorf("team b's product: %v", err)
	}
	if _, err := c.BuildForEnvironment([]string{"teams/a/products/mine", "teams/b/products/theirs"}, out); err == nil {
		t.Error("two teams' products built in one Environment")
	}
	ok, err := c.BuildForEnvironment([]string{"teams/a/products/mine"}, out)
	if err != nil || !ok {
		t.Fatalf("%v %v", ok, err)
	}
	if !strings.Contains(calls(t, log), "docker save --output "+filepath.Join(out, "a", "mine.tar")+" vennir-catalog/a/mine:ci") {
		t.Errorf("not saved for publish --images:\n%s", calls(t, log))
	}
}

func TestBuildEnvironmentsNameTheCatalogsTeams(t *testing.T) {
	files := product("mine", "[]")
	files["vennir.yaml"] = "buildEnvironments: [a, a, nobody, ../teams/a]\n"
	c := catalogWith(t, files)
	out := errorsOf(t, (*Catalog).ValidateBuildEnvironments, c)
	for _, want := range []string{"'a' is listed twice", "'nobody' isn't a team of this catalog", "'../teams/a' isn't a team of this catalog"} {
		if !strings.Contains(out, want) {
			t.Errorf("no %q in:\n%s", want, out)
		}
	}
}

const mainOnly = `{"branch_policies": [{"id": 7, "name": "main", "type": "branch"}]}`

// In CI the plan refuses a team whose Environment a pull request could
// use: missing (a job naming it would make it, open to every branch), or
// open to another branch.
func TestThePlanNeedsEachTeamsEnvironmentMainOnly(t *testing.T) {
	c := buildEnvCatalog(t)
	since := ""
	env := map[string]string{"GITHUB_REPOSITORY": "org/catalog"}
	_, answers := fakeBuildTools(t, c, env)

	if _, ok, _ := c.Plan(context.Background(), &since); ok {
		t.Error("planned a build in an Environment that doesn't exist")
	}
	answer(t, answers, "repos/org/catalog/environments/team-a", `{"deployment_branch_policy": null}`)
	if _, ok, _ := c.Plan(context.Background(), &since); ok {
		t.Error("planned a build in an Environment open to every branch")
	}
	answer(t, answers, "repos/org/catalog/environments/team-a", `{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}`)
	answer(t, answers, "repos/org/catalog/environments/team-a/deployment-branch-policies?per_page=100",
		`{"branch_policies": [{"id": 7, "name": "main", "type": "branch"}, {"id": 8, "name": "release/*", "type": "branch"}]}`)
	if _, ok, _ := c.Plan(context.Background(), &since); ok {
		t.Error("planned a build in an Environment open to release/*")
	}
	answer(t, answers, "repos/org/catalog/environments/team-a/deployment-branch-policies?per_page=100", mainOnly)
	builds, ok, err := c.Plan(context.Background(), &since)
	if err != nil || !ok {
		t.Fatalf("%v %v", ok, err)
	}
	data, _ := json.Marshal(builds)
	if string(data) != `[{"team":"a","products":["teams/a/products/mine"]}]` {
		t.Errorf("planned %s", data)
	}
}

func TestEnvironmentsAreMadeMainOnlyKeepingTheirRules(t *testing.T) {
	c := buildEnvCatalog(t)
	log, answers := fakeBuildTools(t, c, nil)
	path := "repos/org/catalog/environments/team-a"

	// Missing: made, then limited to main.
	if ok, err := c.Environments("org/catalog"); err != nil || !ok {
		t.Fatalf("%v %v", ok, err)
	}
	got := calls(t, log)
	for _, want := range []string{
		"gh api --method PUT " + path + " --input",
		`body {"deployment_branch_policy":{"custom_branch_policies":true,"protected_branches":false}}`,
		"gh api --method POST " + path + "/deployment-branch-policies -f name=main -f type=branch",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("no %q in:\n%s", want, got)
		}
	}

	// Open to every branch, with a reviewer: limited, the reviewer kept.
	_ = os.Truncate(log, 0)
	answer(t, answers, path, `{"can_admins_bypass": false, "deployment_branch_policy": null, "protection_rules": [
		{"type": "required_reviewers", "prevent_self_review": true, "reviewers": [{"type": "Team", "reviewer": {"id": 42}}]},
		{"type": "wait_timer", "wait_timer": 5}]}`)
	if ok, _ := c.Environments("org/catalog"); !ok {
		t.Fatal("not limited")
	}
	if got := calls(t, log); !strings.Contains(got, `"reviewers":[{"id":42,"type":"Team"}]`) || !strings.Contains(got, `"wait_timer":5`) || !strings.Contains(got, `"prevent_self_review":true`) || !strings.Contains(got, `"can_admins_bypass":false`) {
		t.Errorf("its reviewers, wait timer or admin bypass dropped:\n%s", got)
	}

	// Open to another branch too: that branch removed, main kept.
	_ = os.Truncate(log, 0)
	answer(t, answers, path, `{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}`)
	answer(t, answers, path+"/deployment-branch-policies?per_page=100",
		`{"branch_policies": [{"id": 7, "name": "main", "type": "branch"}, {"id": 8, "name": "release/*", "type": "branch"}]}`)
	if ok, _ := c.Environments("org/catalog"); !ok {
		t.Fatal("not limited")
	}
	got = calls(t, log)
	if !strings.Contains(got, "gh api --method DELETE "+path+"/deployment-branch-policies/8") || strings.Contains(got, "/deployment-branch-policies/7") || strings.Contains(got, "--method POST") || strings.Contains(got, "--method PUT") {
		t.Errorf("release/* not removed alone:\n%s", got)
	}

	// Main only already: nothing written.
	_ = os.Truncate(log, 0)
	answer(t, answers, path+"/deployment-branch-policies?per_page=100", mainOnly)
	if ok, _ := c.Environments("org/catalog"); !ok {
		t.Fatal("refused")
	}
	if got := calls(t, log); strings.Contains(got, "--method") {
		t.Errorf("changed an Environment that was main only:\n%s", got)
	}
}
