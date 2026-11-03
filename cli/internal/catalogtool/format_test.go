// SPDX-License-Identifier: MIT

package catalogtool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// catalogWith writes files (path → content) into a fresh catalog.
func catalogWith(t *testing.T, files map[string]string) *Catalog {
	t.Helper()
	root := t.TempDir()
	for path, content := range files {
		full := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	c, _ := quiet(t, root)
	return c
}

func errorsOf(t *testing.T, check func(*Catalog) bool, c *Catalog) string {
	t.Helper()
	var out strings.Builder
	c.Stdout, c.Stderr = &out, &out
	check(c)
	return out.String()
}

const productV2 = `apiVersion: vertra.dev/v2
kind: Product
name: %s
team: %s
displayName: X
description: X
owner: x
actions:
  - name: run
    shareWith: %s
    input:
      type: object
      additionalProperties: false
      required: [text]
      properties:
        text: {type: string}
        loud: {type: boolean}
    output:
      type: object
      properties:
        text: {type: string}
`

func productFile(name, team, shareWith string) string {
	s := strings.Replace(productV2, "%s", name, 1)
	s = strings.Replace(s, "%s", team, 1)
	return strings.Replace(s, "%s", shareWith, 1)
}

func TestFormatVersionIsRequired(t *testing.T) {
	c := catalogWith(t, map[string]string{
		"teams/a/team.yaml": "name: a\ndisplayName: A\ndescription: A\nowner: a\n",
		"teams/b/team.yaml": "apiVersion: vertra.dev/v2\nkind: Product\nname: b\ndisplayName: B\ndescription: B\nowner: b\n",
		"teams/c/team.yaml": "apiVersion: vertra.dev/v1\nkind: Team\nname: c\ndisplayName: C\ndescription: C\nowner: c\n",
	})
	out := errorsOf(t, (*Catalog).ValidateTeams, c)
	for _, want := range []string{
		"teams/a/team.yaml: written in the catalog format from before v2 (it has no apiVersion): ./vertra catalog migrate rewrites it",
		"teams/b/team.yaml: kind 'Product': this file is kind Team",
		"teams/c/team.yaml: apiVersion 'vertra.dev/v1': this vertra reads vertra.dev/v2",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("no %q in:\n%s", want, out)
		}
	}
}

const goodTemplate = `apiVersion: vertra.dev/v2
kind: Template
name: chain
displayName: Chain
description: Two steps.
parameters:
  type: object
  properties:
    text: {type: string}
examples:
  - {name: a greeting, parameters: {text: hello}}
steps:
  - id: first
    action: mine.run
    inputs:
      text: {$param: text}
  - id: second
    action: b/theirs.run
    dependsOn: [first]
    inputs:
      text: {$fromStep: first, $output: text}
`

func templateCatalog(t *testing.T, template string) *Catalog {
	return catalogWith(t, map[string]string{
		"teams/a/products/mine/product.yaml":    productFile("mine", "a", "[]"),
		"teams/b/products/theirs/product.yaml":  productFile("theirs", "b", "[a]"),
		"teams/c/products/private/product.yaml": productFile("private", "c", "[]"),
		"teams/a/dags/chain.yaml":               template,
	})
}

func TestTemplateChecks(t *testing.T) {
	if out := errorsOf(t, (*Catalog).ValidateDags, templateCatalog(t, goodTemplate)); out != "" {
		t.Fatalf("a good template was refused:\n%s", out)
	}
	for change, want := range map[[2]string]string{
		{"action: b/theirs.run", "action: b/missing.run"}:                                          "step second: no action b/missing.run in this catalog",
		{"action: b/theirs.run", "action: c/private.run"}:                                          "step second: c/private.run isn't shared with team a",
		{"{$param: text}", "{$param: words}"}:                                                      "uses parameter 'words', which parameters doesn't declare",
		{"    dependsOn: [first]\n", ""}:                                                           "uses step 'first''s output, but doesn't depend on it",
		{"$output: text}", "$output: colour}"}:                                                     "uses output 'colour', which step first's action doesn't declare",
		{"      text: {$param: text}\n", "      loud: true\n"}:                                     "step first: its action needs input 'text'",
		{"      text: {$param: text}", "      text: {$param: text}\n      volume: 11"}:             "step first: input 'volume' isn't one its action takes",
		{"    action: mine.run\n", "    action: mine.run\n    dependsOn: [second]\n"}:              "steps first, second depend on each other in a cycle",
		{"name: chain", "name: other"}:                                                             "name 'other' isn't the file's name, 'chain'",
		{"{text: hello}", "{text: 5}"}:                                                             "example 'a greeting': text: got number, want string",
		{"  - {name: a greeting", "  - {name: a greeting, parameters: {}}\n  - {name: a greeting"}: "example 'a greeting': another example has this name",
	} {
		broken := strings.Replace(goodTemplate, change[0], change[1], 1)
		if broken == goodTemplate {
			t.Fatalf("the change %q didn't apply", change[0])
		}
		out := errorsOf(t, (*Catalog).ValidateDags, templateCatalog(t, broken))
		if !strings.Contains(out, want) {
			t.Errorf("after %q → %q: no %q in:\n%s", change[0], change[1], want, out)
		}
	}
}

func TestDagChecks(t *testing.T) {
	dag := `apiVersion: vertra.dev/v2
kind: Dag
name: d
tasks:
  - {id: one, image: r/x:1, action: run, team: a}
  - {id: two, image: r/x:1, action: run, team: a, inputs: {text: {$fromTask: one, $output: text}}}
`
	out := errorsOf(t, (*Catalog).ValidateDags, catalogWith(t, map[string]string{"teams/a/dags/d.yaml": dag}))
	if !strings.Contains(out, "task two: input 'text' uses task 'one''s output, but doesn't depend on it") {
		t.Errorf("got:\n%s", out)
	}
	fixed := strings.Replace(dag, "team: a, inputs", "team: a, dependsOn: [one], inputs", 1)
	if out := errorsOf(t, (*Catalog).ValidateDags, catalogWith(t, map[string]string{"teams/a/dags/d.yaml": fixed})); out != "" {
		t.Errorf("a good DAG was refused:\n%s", out)
	}
}

func TestMigrate(t *testing.T) {
	v1Product := strings.Replace(strings.Replace(productFile("mine", "a", "[]"), "apiVersion: vertra.dev/v2\nkind: Product\n", "", 1),
		"    shareWith: []\n", "    requiredSecrets:\n      - name: token\n", 1)
	c := catalogWith(t, map[string]string{
		"teams/a/team.yaml":                  "# The A team.\nname: a\ndisplayName: A\ndescription: A\nowner: a\n",
		"teams/a/products/mine/product.yaml": "# Mine.\n" + v1Product,
		"teams/a/dags/try.yaml":              "name: try\ntasks:\n  - {id: one, image: r/x:1, action: run, team: a}\n",
		// The rest of a valid product, which migrate doesn't touch.
		"teams/a/products/mine/Dockerfile":                      "FROM alpine:3@sha256:" + strings.Repeat("a", 64) + "\nUSER 65532:65532\n",
		"teams/a/products/mine/tests/run/says-hi/request.json":  `{"inputs": {"text": "hi"}}`,
		"teams/a/products/mine/tests/run/says-hi/expected.json": `{"status": "succeeded"}`,
	})
	changed, problems, err := c.Migrate()
	if err != nil || len(problems) != 0 || changed != 3 {
		t.Fatalf("changed=%d problems=%v err=%v", changed, problems, err)
	}
	read := func(path string) string {
		data, err := os.ReadFile(filepath.Join(c.Root, path))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	if got := read("teams/a/team.yaml"); !strings.HasPrefix(got, "# The A team.\napiVersion: vertra.dev/v2\nkind: Team\nname: a\n") {
		t.Errorf("team.yaml:\n%s", got)
	}
	if got := read("teams/a/products/mine/product.yaml"); !strings.Contains(got, "    secretRefs:\n      - name: token") || strings.Contains(got, "requiredSecrets") {
		t.Errorf("product.yaml:\n%s", got)
	}
	if got := read("teams/a/dags/try.yaml"); !strings.HasPrefix(got, "apiVersion: vertra.dev/v2\nkind: Dag\n") {
		t.Errorf("dags/try.yaml:\n%s", got)
	}
	// What it wrote is valid v2, and a second run changes nothing.
	if out := errorsOf(t, func(c *Catalog) bool {
		return c.ValidateTeams() && c.ValidateDags() && c.ValidateProduct(c.AllProducts()[0])
	}, c); out != "" {
		t.Errorf("the migrated catalog doesn't validate:\n%s", out)
	}
	if again, _, _ := c.Migrate(); again != 0 {
		t.Errorf("a second migrate changed %d file(s)", again)
	}
}

// A catalog from before the platform was renamed Vertra: its apiVersion and
// settings file are rewritten, and both are refused, pointing at migrate,
// until they are.
func TestMigrateFromBeforeTheRename(t *testing.T) {
	old := strings.Replace(productFile("mine", "a", "[]"), "apiVersion: "+APIVersion, "apiVersion: "+FormerAPIVersion, 1)
	c := catalogWith(t, map[string]string{
		"teams/a/products/mine/product.yaml":                    "# Mine.\n" + old,
		"teams/a/products/mine/Dockerfile":                      "FROM alpine:3@sha256:" + strings.Repeat("a", 64) + "\nUSER 65532:65532\n",
		"teams/a/products/mine/tests/run/says-hi/request.json":  `{"inputs": {"text": "hi"}}`,
		"teams/a/products/mine/tests/run/says-hi/expected.json": `{"status": "succeeded"}`,
		FormerSettingsFile:                                      "registry: registry.example/catalog\n",
	})
	if out := errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(c.AllProducts()[0]) }, c); !strings.Contains(out, "./vertra catalog migrate rewrites it to "+APIVersion) {
		t.Errorf("the old apiVersion: %s", out)
	}
	if _, err := c.Settings(); err == nil || !strings.Contains(err.Error(), "./vertra catalog migrate renames it") {
		t.Errorf("the old settings file: %v", err)
	}

	changed, problems, err := c.Migrate()
	if err != nil || len(problems) != 0 || changed != 2 {
		t.Fatalf("changed=%d problems=%v err=%v", changed, problems, err)
	}
	data, _ := os.ReadFile(filepath.Join(c.Root, "teams/a/products/mine/product.yaml"))
	if !strings.HasPrefix(string(data), "# Mine.\napiVersion: "+APIVersion+"\nkind: Product\n") {
		t.Errorf("product.yaml:\n%s", data)
	}
	if s, err := c.Settings(); err != nil || s.Registry != "registry.example/catalog" {
		t.Errorf("settings = %+v, %v", s, err)
	}
	if out := errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(c.AllProducts()[0]) }, c); out != "" {
		t.Errorf("the migrated product doesn't validate:\n%s", out)
	}
	if again, _, _ := c.Migrate(); again != 0 {
		t.Errorf("a second migrate changed %d file(s)", again)
	}
}

// visibility: hidden keeps an action or a template to its own team, so it
// can't be shared too; a release says which are hidden.
func TestVisibility(t *testing.T) {
	// A complete product of team a whose product.yaml is this.
	withFile := func(productYAML string) *Catalog {
		files := product("mine", "[]")
		files["teams/a/products/mine/product.yaml"] = productYAML
		return catalogWith(t, files)
	}
	validate := func(c *Catalog) bool { return c.ValidateProduct(c.AllProducts()[0]) }
	hidden := strings.Replace(productFile("mine", "a", "[]"), "    shareWith: []\n", "    visibility: hidden\n", 1)
	c := withFile(hidden)
	p := c.AllProducts()[0]
	if out := errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(p) }, c); out != "" {
		t.Fatalf("a hidden action was refused:\n%s", out)
	}
	actions, err := p.ReleaseActions("registry/a/mine@sha256:abc")
	if err != nil || len(actions) != 1 || !actions[0].GetHidden() {
		t.Errorf("actions = %v, %v", actions, err)
	}

	both := strings.Replace(productFile("mine", "a", "[b]"), "    shareWith: [b]\n", "    shareWith: [b]\n    visibility: hidden\n", 1)
	if out := errorsOf(t, validate, withFile(both)); !strings.Contains(out, "product.yaml") {
		t.Errorf("a hidden action that's also shared was accepted:\n%s", out)
	}
	odd := strings.Replace(productFile("mine", "a", "[]"), "    shareWith: []\n", "    visibility: secret\n", 1)
	if out := errorsOf(t, validate, withFile(odd)); !strings.Contains(out, "product.yaml") {
		t.Errorf("an unknown visibility was accepted:\n%s", out)
	}

	tpl := strings.Replace(goodTemplate, "parameters:", "visibility: hidden\nshareWith: [b]\nparameters:", 1)
	if out := errorsOf(t, (*Catalog).ValidateDags, templateCatalog(t, tpl)); out == "" {
		t.Error("a hidden template that's also shared was accepted")
	}
}

// allowedTargets in team.yaml: checked against the schema, and carried in
// the release as rules of kinds and values.
func TestAllowedTargets(t *testing.T) {
	team := func(targets string) *Catalog {
		return catalogWith(t, map[string]string{"teams/a/team.yaml": "apiVersion: " + APIVersion +
			"\nkind: Team\nname: a\ndisplayName: A\ndescription: A\nowner: a\n" + targets})
	}
	good := "allowedTargets:\n  - teams: [web]\n    gcp.project: [\"web-*\"]\n    gcp.folder: [folders/12]\n    approval: true\n"
	c := team(good)
	if out := errorsOf(t, (*Catalog).ValidateTeams, c); out != "" {
		t.Fatalf("good rules were refused:\n%s", out)
	}
	rules, err := targetRules(filepath.Join(c.Root, "teams/a/team.yaml"))
	if err != nil || len(rules) != 1 || strings.Join(rules[0].GetTeams(), ",") != "web" || len(rules[0].GetTargets()) != 2 ||
		rules[0].GetTargets()[0].GetType() != "gcp.project" || rules[0].GetTargets()[0].GetValues()[0] != "web-*" || !rules[0].GetApproval() {
		t.Errorf("rules = %v, %v", rules, err)
	}
	for name, bad := range map[string]string{
		"an unknown kind": "allowedTargets:\n  - teams: [web]\n    gcp.org: [\"1\"]\n",
		"no targets":      "allowedTargets:\n  - teams: [web]\n",
		"only approval":   "allowedTargets:\n  - teams: [web]\n    approval: true\n",
		"no teams":        "allowedTargets:\n  - gcp.project: [x]\n",
	} {
		if out := errorsOf(t, (*Catalog).ValidateTeams, team(bad)); out == "" {
			t.Errorf("%s was accepted", name)
		}
	}
}

// A team's images sit beside the catalog's own repositories, and its name
// is a namespace's: the names those take are refused, by the validator and
// by the schema an editor reads.
func TestReservedTeamNames(t *testing.T) {
	team := func(name string) string {
		return "apiVersion: " + APIVersion + "\nkind: Team\nname: " + name + "\ndisplayName: X\ndescription: X\nowner: x\n"
	}
	for _, name := range []string{"bases", "catalog-release", "vertra-system", "kube-system", "kube-x"} {
		c := catalogWith(t, map[string]string{"teams/" + name + "/team.yaml": team(name)})
		if out := errorsOf(t, (*Catalog).ValidateTeams, c); !strings.Contains(out, "no team may be called '"+name+"'") {
			t.Errorf("%s: %q", name, out)
		}
		doc, _ := loadYAML([]byte(team(name)))
		if len(schemaErrors(teamSchema(), doc)) == 0 {
			t.Errorf("the schema accepts %s", name)
		}
	}
	for _, name := range []string{"base", "kube", "my-bases", "vertra"} {
		c := catalogWith(t, map[string]string{"teams/" + name + "/team.yaml": team(name)})
		if out := errorsOf(t, (*Catalog).ValidateTeams, c); out != "" {
			t.Errorf("%s was refused: %s", name, out)
		}
	}
}

// An action may be retried only when it says running it again is safe, and
// a release carries both.
func TestRetries(t *testing.T) {
	withRun := func(extra string) string {
		return strings.Replace(productFile("mine", "a", "[]"), "    shareWith: []\n", "    shareWith: []\n"+extra, 1)
	}
	check := func(productYAML string) (string, *Product, *Catalog) {
		files := product("mine", "[]")
		files["teams/a/products/mine/product.yaml"] = productYAML
		c := catalogWith(t, files)
		p := c.AllProducts()[0]
		return errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(p) }, c), p, c
	}
	out, p, _ := check(withRun("    idempotent: true\n    maxAttempts: 3\n"))
	if out != "" {
		t.Fatalf("an idempotent action with retries was refused:\n%s", out)
	}
	actions, err := p.ReleaseActions("registry/a/mine@sha256:abc")
	if err != nil || !actions[0].GetIdempotent() || actions[0].GetMaxAttempts() != 3 {
		t.Errorf("actions = %v, %v", actions, err)
	}
	for name, extra := range map[string]string{
		"retries without idempotent":  "    maxAttempts: 3\n",
		"retries said not to be safe": "    idempotent: false\n    maxAttempts: 2\n",
		"too many":                    "    idempotent: true\n    maxAttempts: 11\n",
	} {
		if out, _, _ := check(withRun(extra)); !strings.Contains(out, "product.yaml") {
			t.Errorf("%s was accepted:\n%s", name, out)
		}
	}
}

// A concurrency key names inputs the action takes, and a release carries it.
func TestConcurrencyKeys(t *testing.T) {
	check := func(extra string) (string, *Product) {
		files := product("mine", "[]")
		files["teams/a/products/mine/product.yaml"] = strings.Replace(productFile("mine", "a", "[]"), "    shareWith: []\n", "    shareWith: []\n"+extra, 1)
		c := catalogWith(t, files)
		p := c.AllProducts()[0]
		return errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(p) }, c), p
	}
	out, p := check("    concurrencyKey: [text]\n")
	if out != "" {
		t.Fatalf("a key naming an input was refused:\n%s", out)
	}
	actions, err := p.ReleaseActions("registry/a/mine@sha256:abc")
	if err != nil || strings.Join(actions[0].GetConcurrencyKey(), ",") != "text" {
		t.Errorf("actions = %v, %v", actions, err)
	}
	if out, _ := check("    concurrencyKey: [colour]\n"); !strings.Contains(out, "concurrencyKey names 'colour'") {
		t.Errorf("a key naming no input was accepted:\n%s", out)
	}
}

// An action may wait for an approval, always, for other teams' runs, or for
// some teams' runs, and a release carries which.
func TestApprovals(t *testing.T) {
	check := func(extra string) (string, *Product) {
		files := product("mine", "[]")
		files["teams/a/products/mine/product.yaml"] = strings.Replace(productFile("mine", "a", "[]"), "    shareWith: []\n", "    shareWith: []\n"+extra, 1)
		c := catalogWith(t, files)
		p := c.AllProducts()[0]
		return errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(p) }, c), p
	}
	out, p := check("    approval: otherTeams\n")
	if out != "" {
		t.Fatalf("an approval was refused:\n%s", out)
	}
	actions, err := p.ReleaseActions("registry/a/mine@sha256:abc")
	if err != nil || actions[0].GetApproval() != "otherTeams" {
		t.Errorf("actions = %v, %v", actions, err)
	}
	if out, _ := check("    approval: sometimes\n"); !strings.Contains(out, "product.yaml") {
		t.Errorf("an unknown approval was accepted:\n%s", out)
	}
	// For some consumer teams, not others.
	out, p = check("    approval: [payments, web]\n")
	if out != "" {
		t.Fatalf("an approval for some teams was refused:\n%s", out)
	}
	actions, err = p.ReleaseActions("registry/a/mine@sha256:abc")
	if err != nil || actions[0].GetApproval() != "" || strings.Join(actions[0].GetApprovalTeams(), ",") != "payments,web" {
		t.Errorf("actions = %v, %v", actions, err)
	}
	if out, _ := check("    approval: [Not A Team]\n"); !strings.Contains(out, "product.yaml") {
		t.Errorf("a team name that can't be one was accepted:\n%s", out)
	}
	if out, _ := check("    approval: []\n"); !strings.Contains(out, "product.yaml") {
		t.Errorf("an empty list was accepted:\n%s", out)
	}
}

// A product explains its error codes; a release carries the explanations.
func TestErrorHelp(t *testing.T) {
	check := func(errorsYAML string) (string, *Product) {
		files := product("mine", "[]")
		files["teams/a/products/mine/product.yaml"] = strings.Replace(productFile("mine", "a", "[]"), "owner: x\n", "owner: x\n"+errorsYAML, 1)
		c := catalogWith(t, files)
		p := c.AllProducts()[0]
		return errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(p) }, c), p
	}
	out, p := check("errors:\n  QUOTA_EXCEEDED:\n    means: No quota left.\n    do: Ask for more, then retry.\n")
	if out != "" {
		t.Fatalf("errors were refused:\n%s", out)
	}
	actions, err := p.ReleaseActions("registry/a/mine@sha256:abc")
	if err != nil || actions[0].GetErrors()["QUOTA_EXCEEDED"].GetDo() != "Ask for more, then retry." {
		t.Errorf("actions = %v, %v", actions, err)
	}
	for name, bad := range map[string]string{
		"a code that isn't SHOUTED": "errors:\n  quota:\n    means: x\n",
		"no meaning":                "errors:\n  QUOTA_EXCEEDED:\n    do: x\n",
	} {
		if out, _ := check(bad); !strings.Contains(out, "product.yaml") {
			t.Errorf("%s was accepted:\n%s", name, out)
		}
	}
}

// An input schema's form hints (x-vertra-order, -group, -widget,
// -pattern-message) are checked: a misspelt widget or a non-number order is
// named, so a form doesn't silently ignore it.
func TestFormHintsAreChecked(t *testing.T) {
	withHints := func(hints string) string {
		return strings.Replace(productFile("mine", "a", "[]"), "        text: {type: string}\n", "        text: {type: string, "+hints+"}\n", 1)
	}
	validate := func(c *Catalog) bool { return c.ValidateProduct(c.AllProducts()[0]) }
	good := catalogWith(t, map[string]string{"teams/a/products/mine/product.yaml": withHints(
		`x-vertra-order: 1, x-vertra-group: Project, x-vertra-widget: textarea, pattern: "^[a-z]+$", x-vertra-pattern-message: lowercase letters`)})
	if out := errorsOf(t, validate, good); strings.Contains(out, "x-vertra") {
		t.Errorf("good hints refused:\n%s", out)
	}
	bad := catalogWith(t, map[string]string{"teams/a/products/mine/product.yaml": withHints(`x-vertra-widget: bigbox, x-vertra-order: first`)})
	out := errorsOf(t, validate, bad)
	for _, want := range []string{"x-vertra-widget", "x-vertra-order"} {
		if !strings.Contains(out, want) {
			t.Errorf("no %q in:\n%s", want, out)
		}
	}
}

// An action's cleanup names another action of its product and, when it maps
// inputs, things the action has; a release carries it.
func TestCleanupIsChecked(t *testing.T) {
	deleteAction := "  - name: delete\n    input: {type: object}\n    output: {type: object}\n"
	check := func(cleanup string) (string, *Product) {
		files := product("mine", "[]")
		files["teams/a/products/mine/product.yaml"] = strings.Replace(productFile("mine", "a", "[]"), "    shareWith: []\n", "    shareWith: []\n"+cleanup, 1) + deleteAction
		files["teams/a/products/mine/tests/delete/gone/request.json"] = `{"inputs": {}}`
		files["teams/a/products/mine/tests/delete/gone/expected.json"] = `{"status": "succeeded"}`
		c := catalogWith(t, files)
		p := c.AllProducts()[0]
		return errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(p) }, c), p
	}
	out, p := check("    cleanup:\n      action: delete\n      inputs: {project: {$input: text}, said: {$output: text}, id: {$resource: id}, force: true}\n")
	if out != "" {
		t.Fatalf("a good cleanup was refused:\n%s", out)
	}
	actions, err := p.ReleaseActions("registry/a/mine@sha256:abc")
	if err != nil || actions[0].GetCleanup().GetAction() != "delete" || actions[0].GetCleanup().GetInputs().AsMap()["force"] != true {
		t.Errorf("actions = %v, %v", actions, err)
	}
	if out, p := check("    cleanup: {action: delete}\n"); out != "" {
		t.Errorf("a cleanup with no inputs was refused:\n%s", out)
	} else if actions, _ := p.ReleaseActions("r@sha256:abc"); actions[0].GetCleanup().GetInputs() != nil {
		t.Errorf("no inputs became %v", actions[0].GetCleanup().GetInputs())
	}
	for cleanup, want := range map[string]string{
		"    cleanup: {action: remove}\n":                                             "cleanup names 'remove', which this product doesn't have",
		"    cleanup: {action: run}\n":                                                "cleanup names the action itself",
		"    cleanup: {action: delete, inputs: {a: {$input: colour}}}\n":              "cleanup input 'a' names 'colour', which its input doesn't have",
		"    cleanup: {action: delete, inputs: {a: {$output: size}}}\n":               "cleanup input 'a' names 'size', which its output doesn't have",
		"    cleanup: {action: delete, inputs: {a: {$resource: owner}}}\n":            "$resource is type, id, name or link, not 'owner'",
		"    cleanup: {action: delete, inputs: {a: {$step: x}}}\n":                    "$step isn't $input, $output or $resource",
		"    cleanup: {action: delete, inputs: {a: {$input: text, $output: text}}}\n": "refers to more than one thing",
	} {
		if out, _ := check(cleanup); !strings.Contains(out, want) {
			t.Errorf("%q: no %q in:\n%s", cleanup, want, out)
		}
	}
}

// An action's plan names another action of its product that only reports;
// a release carries it.
func TestPlanIsChecked(t *testing.T) {
	check := func(plan, planAction string) (string, *Product) {
		files := product("mine", "[]")
		files["teams/a/products/mine/product.yaml"] = strings.Replace(productFile("mine", "a", "[]"), "    shareWith: []\n", "    shareWith: []\n"+plan, 1) +
			"  - name: preview\n    input: {type: object}\n    output: {type: object}\n" + planAction
		files["teams/a/products/mine/tests/preview/says/request.json"] = `{"inputs": {}}`
		files["teams/a/products/mine/tests/preview/says/expected.json"] = `{"status": "succeeded"}`
		c := catalogWith(t, files)
		p := c.AllProducts()[0]
		return errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(p) }, c), p
	}
	out, p := check("    plan: preview\n", "")
	if out != "" {
		t.Fatalf("a good plan was refused:\n%s", out)
	}
	if actions, err := p.ReleaseActions("r@sha256:abc"); err != nil || actions[0].GetPlan() != "preview" {
		t.Errorf("actions = %v, %v", actions, err)
	}
	for plan, want := range map[string][2]string{
		"missing": {"    plan: dryrun\n", ""},
		"itself":  {"    plan: run\n", ""},
		"acts":    {"    plan: preview\n", "    approval: always\n"},
	} {
		message := map[string]string{"missing": "plan names 'dryrun', which this product doesn't have", "itself": "plan names the action itself", "acts": "its plan, 'preview', has approval"}[plan]
		if out, _ := check(want[0], want[1]); !strings.Contains(out, message) {
			t.Errorf("%s: no %q in:\n%s", plan, message, out)
		}
	}
}

// A product's check names one of its actions, run with no inputs, that only
// reports; a release carries it on each action.
func TestCheckIsChecked(t *testing.T) {
	check := func(top, checkAction string) (string, *Product) {
		files := product("mine", "[]")
		files["teams/a/products/mine/product.yaml"] = strings.Replace(productFile("mine", "a", "[]"), "actions:\n", top+"actions:\n", 1) +
			"  - name: ready\n    input: {type: object" + checkAction + "}\n    output: {type: object}\n"
		files["teams/a/products/mine/tests/ready/says/request.json"] = `{"inputs": {}}`
		files["teams/a/products/mine/tests/ready/says/expected.json"] = `{"status": "succeeded"}`
		c := catalogWith(t, files)
		p := c.AllProducts()[0]
		return errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(p) }, c), p
	}
	out, p := check("check: ready\n", "")
	if out != "" {
		t.Fatalf("a good check was refused:\n%s", out)
	}
	if actions, err := p.ReleaseActions("r@sha256:abc"); err != nil || actions[0].GetCheck() != "ready" || actions[1].GetCheck() != "ready" {
		t.Errorf("actions = %v, %v", actions, err)
	}
	if out, _ := check("check: health\n", ""); !strings.Contains(out, "check names 'health', which this product doesn't have") {
		t.Errorf("a missing check was accepted:\n%s", out)
	}
	if out, _ := check("check: ready\n", ", required: [x], properties: {x: {type: string}}"); !strings.Contains(out, "requires inputs") {
		t.Errorf("a check needing inputs was accepted:\n%s", out)
	}
}

// A release carries an action's passing contract tests as its examples, and
// leaves out the failing ones.
func TestExamplesComeFromPassingTests(t *testing.T) {
	files := product("mine", "[]")
	files["teams/a/products/mine/tests/run/says-hi/expected.json"] = `{"status": "succeeded", "outputs": {"text": "HI"}}`
	files["teams/a/products/mine/tests/run/needs-text/request.json"] = `{"inputs": {}}`
	files["teams/a/products/mine/tests/run/needs-text/expected.json"] = `{"status": "failed", "error": {"code": "MISSING_INPUT"}}`
	c := catalogWith(t, files)
	p := c.AllProducts()[0]
	if out := errorsOf(t, func(c *Catalog) bool { return c.ValidateProduct(p) }, c); out != "" {
		t.Fatal(out)
	}
	actions, err := p.ReleaseActions("r@sha256:abc")
	if err != nil {
		t.Fatal(err)
	}
	examples := actions[0].GetExamples()
	if len(examples) != 1 || examples[0].GetName() != "says hi" || examples[0].GetInputs().AsMap()["text"] != "hi" || examples[0].GetOutputs().AsMap()["text"] != "HI" {
		t.Errorf("examples = %v", examples)
	}
}
