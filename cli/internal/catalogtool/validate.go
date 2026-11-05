// SPDX-License-Identifier: MIT

package catalogtool

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

var (
	productSchema  = sync.OnceValue(func() *jsonschema.Schema { return embeddedSchema("product.schema.json") })
	teamSchema     = sync.OnceValue(func() *jsonschema.Schema { return embeddedSchema("team.schema.json") })
	templateSchema = sync.OnceValue(func() *jsonschema.Schema { return embeddedSchema("template.schema.json") })
	dagSchema      = sync.OnceValue(func() *jsonschema.Schema { return embeddedSchema("dag.schema.json") })
	apiSchema      = sync.OnceValue(func() *jsonschema.Schema { return embeddedSchema("api.schema.json") })
)

// APIVersion is the catalog format this vennir reads and writes.
const APIVersion = "vennir.dev/v2"

// formerName is a name the platform had before: a catalog in format v2
// under it (its apiVersion, its settings file, its ./<id> wrapper) is
// rewritten by ./vennir catalog migrate.
type formerName struct{ name, id, until string }

// formerNames, newest first: Acyclix until 2026-10-20, then Vertra until
// 2026-11-03.
var formerNames = []formerName{{"Vertra", "vertra", "2026-11-03"}, {"Acyclix", "acyclix", "2026-10-20"}}

func (f formerName) apiVersion() string   { return f.id + ".dev/v2" }
func (f formerName) settingsFile() string { return f.id + ".yaml" }

// formatProblem is why doc isn't a format-v2 file of one of kinds, or "".
// A document that isn't an object is left to its schema to describe.
func formatProblem(doc any, kinds ...string) string {
	m, ok := doc.(map[string]any)
	if !ok {
		return ""
	}
	version, present := m["apiVersion"]
	if !present {
		return "written in the catalog format from before v2 (it has no apiVersion): ./vennir catalog migrate rewrites it"
	}
	for _, f := range formerNames {
		if version == f.apiVersion() {
			return fmt.Sprintf("apiVersion %s: the platform was called %s until %s: ./vennir catalog migrate rewrites it to %s", f.apiVersion(), f.name, f.until, APIVersion)
		}
	}
	if version != APIVersion {
		return fmt.Sprintf("apiVersion %s: this vennir reads %s", pyRepr(version), APIVersion)
	}
	if !contains(kinds, fmt.Sprint(m["kind"])) {
		return fmt.Sprintf("kind %s: this file is kind %s", pyRepr(m["kind"]), strings.Join(kinds, " or "))
	}
	return ""
}

// teamEntries are what a team folder may hold, besides team.yaml.
var teamEntries = []string{"README.md", "apis", "dags", "products", "secret-stores", "team.yaml", "types.yaml"}

// renamed is why an old catalog's names are refused.
const renamed = "teams were called platforms until 2026-10-18"

// TeamDirs are the folders under teams/.
func (c *Catalog) TeamDirs() []string {
	entries, err := os.ReadDir(c.path("teams"))
	if err != nil {
		return nil
	}
	var dirs []string
	for _, e := range entries {
		if e.IsDir() {
			dirs = append(dirs, c.path("teams", e.Name()))
		}
	}
	return dirs
}

// TeamNames are the teams' folder names.
func (c *Catalog) TeamNames() []string {
	names := []string{}
	for _, d := range c.TeamDirs() {
		names = append(names, filepath.Base(d))
	}
	return names
}

func contains[T comparable](list []T, v T) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// apiNamespaceSuffix names a team's API backends' namespace, <team>-apis
// (the console's k8s.ts apiNamespace).
const apiNamespaceSuffix = "-apis"

// reservedTeamName says why name can't be a team's, or "" when it can. A
// team's images are <registry>/<team>/<product>, beside the catalog's own
// repositories, and its name is a Kubernetes namespace's, as is
// <team>-apis, where its API backends run (the console refuses the same).
func reservedTeamName(name string) string {
	switch {
	case strings.HasSuffix(name, apiNamespaceSuffix):
		return "<team>" + apiNamespaceSuffix + " is a team's API backends' namespace"
	case len(name)+len(apiNamespaceSuffix) > 63:
		return "it can be at most 58 characters, so that <team>" + apiNamespaceSuffix + " fits a namespace's 63"
	case name == "bases":
		return "<registry>/bases/ holds the catalog's mirrored base images (bases.yaml)"
	case name == ReleaseRepositoryName:
		return "<registry>/" + ReleaseRepositoryName + " is the catalog's release"
	case name == "vennir-system" || strings.HasPrefix(name, "kube-"):
		return "it's a platform namespace"
	}
	return ""
}

// ValidateTeams checks every team folder: a team.yaml matching its schema
// and its folder's name, and nothing else at the top but what's allowed.
func (c *Catalog) ValidateTeams() bool {
	ok := true
	if exists(c.path("platforms")) {
		c.errorAt(c.path("platforms"), fmt.Sprintf("rename platforms/ to teams/, and each platform.yaml to team.yaml (%s)", renamed))
		ok = false
	}
	for _, dir := range c.TeamDirs() {
		if why := reservedTeamName(filepath.Base(dir)); why != "" {
			c.errorAt(dir, fmt.Sprintf("no team may be called %s: %s; rename the folder", quote(filepath.Base(dir)), why))
			ok = false
			continue
		}
		// Its products' folders are ValidateProduct's to report.
		if links := symlinks(dir, inAProduct); len(links) > 0 {
			for _, link := range links {
				c.errorAt(link, linkProblem)
			}
			ok = false
			continue
		}
		path := filepath.Join(dir, "team.yaml")
		data, err := os.ReadFile(path)
		if err != nil {
			c.errorAt(path, "every team folder needs a team.yaml (see templates/team)")
			ok = false
			continue
		}
		doc, problem := loadYAML(data)
		if problem == "" {
			problem = formatProblem(doc, "Team")
		}
		var problems []string
		if problem != "" {
			problems = []string{problem}
		} else {
			problems = schemaErrors(teamSchema(), doc)
		}
		if len(problems) == 0 {
			if name, _ := doc.(map[string]any)["name"].(string); name != filepath.Base(dir) {
				problems = append(problems, fmt.Sprintf("name %s isn't the folder's name, %s", quote(name), quote(filepath.Base(dir))))
			}
		}
		for _, p := range problems {
			c.errorAt(path, p)
		}
		ok = ok && len(problems) == 0
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			entry := filepath.Join(dir, e.Name())
			switch {
			case e.Name() == "platform.yaml":
				c.errorAt(entry, fmt.Sprintf("rename it to team.yaml (%s)", renamed))
				ok = false
			case !contains(teamEntries, e.Name()):
				c.errorAt(entry, "a team folder holds only "+strings.Join(teamEntries, ", "))
				ok = false
			}
		}
		products, _ := os.ReadDir(filepath.Join(dir, "products"))
		for _, child := range products {
			path := filepath.Join(dir, "products", child.Name())
			if !exists(filepath.Join(path, "product.yaml")) {
				c.errorAt(path, "everything in products/ is a product folder, with a product.yaml")
				ok = false
			}
		}
	}
	return ok
}

// adminPaths are what only the catalog admins (the fallback's owners) may
// approve: what CI runs and publishes with, the starters, and SecretStores.
var adminPaths = []string{".github/CODEOWNERS", ".github/workflows/ci.yml", "tools/product.schema.json",
	"vennir.yaml", "vennir", "templates/hello/product.yaml", "teams/x/secret-stores/secretstore.yaml"}

var (
	// A team's own line: /teams/<team>/.
	teamLine        = regexp.MustCompile(`^/teams/[^/*]+/?$`)
	codeownersOwner = regexp.MustCompile(`^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:/[A-Za-z0-9._-]+)?$|^[^@\s]+@[^@\s]+$`)
)

type codeownersRule struct {
	pattern string
	owners  []string
}

// codeownersMatches handles the patterns this catalog uses: *, /dir/ and
// /file (or /dir), where a whole segment may be * (any one folder).
func codeownersMatches(pattern, path string) bool {
	if pattern == "*" {
		return true
	}
	wanted := strings.Split(strings.Trim(pattern, "/"), "/")
	parts := strings.Split(path, "/")
	if len(parts) < len(wanted) {
		return false
	}
	for i, w := range wanted {
		if w != "*" && w != parts[i] {
			return false
		}
	}
	return true
}

func codeownersRules(text string) ([]codeownersRule, []string) {
	var rules []codeownersRule
	var problems []string
	for i, line := range strings.Split(text, "\n") {
		number := i + 1
		line = strings.TrimSpace(strings.SplitN(line, "#", 2)[0])
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		pattern, owners := fields[0], fields[1:]
		wholeSegments := true
		for _, s := range strings.Split(strings.Trim(pattern, "/"), "/") {
			if s != "*" && strings.Contains(s, "*") {
				wholeSegments = false
			}
		}
		if pattern != "*" && !(strings.HasPrefix(pattern, "/") && wholeSegments) {
			problems = append(problems, fmt.Sprintf("line %d: %s: use *, /folder/ or /file, with * only as a whole folder "+
				"(keeps ownership easy to check)", number, quote(pattern)))
		}
		for _, owner := range owners {
			if !codeownersOwner.MatchString(owner) {
				problems = append(problems, fmt.Sprintf("line %d: %s isn't a @user, @org/team or email", number, quote(owner)))
			}
		}
		rules = append(rules, codeownersRule{pattern, owners})
	}
	return rules, problems
}

// ownersOf follows GitHub's rule: the last matching line wins, even with no owners.
func ownersOf(rules []codeownersRule, path string) []string {
	owners := []string{}
	for _, r := range rules {
		if codeownersMatches(r.pattern, path) {
			owners = r.owners
		}
	}
	sorted := append([]string{}, owners...)
	sort.Strings(sorted)
	return sorted
}

func sameOwners(a, b []string) bool {
	a, b = append([]string{}, a...), append([]string{}, b...)
	sort.Strings(a)
	sort.Strings(b)
	return strings.Join(a, " ") == strings.Join(b, " ")
}

// ValidateServiceAccounts refuses two products of one team running as one
// ServiceAccount: each runs as its own, so a cloud identity bound to one is
// that product's alone (the console refuses it too).
func (c *Catalog) ValidateServiceAccounts() bool {
	ok := true
	first := map[string]string{} // team/serviceAccount: the product that declares it
	for _, p := range c.AllProducts() {
		if p.IsTemplate() {
			continue
		}
		path := filepath.Join(p.Dir, "product.yaml")
		data, err := os.ReadFile(path)
		if err != nil {
			continue // ValidateProduct's to report
		}
		doc, problem := loadYAML(data)
		spec, isMap := doc.(map[string]any)
		if problem != "" || !isMap {
			continue
		}
		serviceAccount := text(spec, "serviceAccount")
		if serviceAccount == "" || serviceAccount == "default" {
			continue
		}
		key := p.Team() + "/" + serviceAccount
		if owner, taken := first[key]; taken {
			c.errorAt(path, fmt.Sprintf("serviceAccount %s is %s's: each product runs as its own; choose another", quote(serviceAccount), owner))
			ok = false
			continue
		}
		first[key] = p.Label()
	}
	return ok
}

// ValidateProductNames refuses two actions registered under one name. Each
// is registered as <team>-<product>-<action>, and names are one namespace
// across every team: team a's product b-c and team a-b's product c both
// make a-b-c-run, and the console registers only one of them.
func (c *Catalog) ValidateProductNames() bool {
	ok := true
	first := map[string]string{} // registered name: whose action it is
	for _, p := range c.AllProducts() {
		if p.IsTemplate() {
			continue
		}
		path := filepath.Join(p.Dir, "product.yaml")
		data, err := os.ReadFile(path)
		if err != nil {
			continue // ValidateProduct's to report
		}
		doc, problem := loadYAML(data)
		spec, isMap := doc.(map[string]any)
		if problem != "" || !isMap {
			continue
		}
		actions, _ := spec["actions"].([]any)
		for _, raw := range actions {
			action, _ := raw.(map[string]any)
			name := text(action, "name")
			if name == "" {
				continue
			}
			registered := fmt.Sprintf("%s-%s-%s", p.Team(), p.Name(), name)
			whose := fmt.Sprintf("team %s's %s action %s", p.Team(), p.Label(), quote(name))
			if other, taken := first[registered]; taken {
				c.errorAt(path, fmt.Sprintf("%s is registered as %s, as %s is: product names are one across every team; rename the product or the action", whose, quote(registered), other))
				ok = false
				continue
			}
			first[registered] = whose
		}
	}
	return ok
}

// linkProblem is why a team's files may not be symbolic links: CI reads,
// builds and mounts them (a product's tests/*/secrets into its image), so a
// link could hand a team's code whatever it points at, such as the publish
// job's registry credentials.
const linkProblem = "a symbolic link: a team's folder holds only files and folders; copy what it points at instead"

// inAProduct says whether a path in a team's folder is in one of its
// products' (products/<name>/...), or is one.
func inAProduct(rel string) bool {
	parts := strings.Split(rel, string(filepath.Separator))
	return len(parts) >= 2 && parts[0] == "products"
}

// symlinks are the symbolic links in dir, itself included, never followed;
// skip (given the path relative to dir) leaves a folder's out.
func symlinks(dir string, skip func(rel string) bool) []string {
	var links []string
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if rel, _ := filepath.Rel(dir, path); skip != nil && rel != "." && skip(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			links = append(links, path)
		}
		return nil
	})
	return links
}

// ValidateCodeowners checks there's one .github/CODEOWNERS, every team is
// owned, and the admin paths are the admins'.
func (c *Catalog) ValidateCodeowners() bool {
	path := c.path(".github", "CODEOWNERS")
	ok := true
	for _, ignored := range []string{c.path("CODEOWNERS"), c.path("docs", "CODEOWNERS")} {
		if exists(ignored) {
			c.errorAt(ignored, "GitHub only reads .github/CODEOWNERS when it exists, so this file is ignored: move its lines there")
			ok = false
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		c.errorAt(path, "no .github/CODEOWNERS: without it, anyone with write access can merge any change")
		return false
	}
	rules, problems := codeownersRules(string(data))
	admins := ownersOf(rules, "any/other/path")
	if len(rules) == 0 || rules[0].pattern != "*" || len(admins) == 0 {
		c.errorAt(path, "the first line must be the fallback, * followed by the catalog admins")
		return false
	}
	for _, team := range c.TeamNames() {
		owned := false
		for _, r := range rules {
			if strings.TrimRight(r.pattern, "/") == "/teams/"+team && len(r.owners) > 0 {
				owned = true
				break
			}
		}
		if !owned {
			problems = append(problems, fmt.Sprintf("no owners for teams/%s/: add a line /teams/%s/ @<its owners>", team, team))
		}
	}
	adminList := strings.Join(admins, " ")
	for _, r := range rules {
		if teamLine.MatchString(r.pattern) && !exists(c.path(strings.TrimPrefix(r.pattern, "/"))) {
			problems = append(problems, fmt.Sprintf("%s: no such folder (a removed team's line? delete it)", r.pattern))
		}
		if !sameOwners(r.owners, admins) && !teamLine.MatchString(r.pattern) {
			problems = append(problems, fmt.Sprintf("%s: only the catalog admins (%s) may own paths other than a team's folder", r.pattern, adminList))
		}
	}
	for _, p := range adminPaths {
		if !sameOwners(ownersOf(rules, p), admins) {
			problems = append(problems, fmt.Sprintf("%s must be owned by the catalog admins (%s), as the fallback is: a later line gives it to someone else", p, adminList))
		}
	}
	for _, p := range problems {
		c.errorAt(path, p)
	}
	return ok && len(problems) == 0
}

// ValidateProduct checks product.yaml against its schema and its folder,
// its actions' schemas, its tests' layout and its Dockerfile's base pins.
// A valid product's Spec is set.
func (c *Catalog) ValidateProduct(p *Product) bool {
	path := filepath.Join(p.Dir, "product.yaml")
	// Nothing in it is read, built or mounted through a link.
	if links := symlinks(p.Dir, nil); len(links) > 0 {
		for _, link := range links {
			c.errorAt(link, linkProblem)
		}
		return false
	}
	var problems []string
	var doc any
	data, err := os.ReadFile(path)
	if err != nil {
		problems = append(problems, err.Error())
	} else {
		var problem string
		doc, problem = loadYAML(data)
		if problem == "" {
			problem = formatProblem(doc, "Product")
		}
		m, isMap := doc.(map[string]any)
		switch {
		case problem != "":
			problems = append(problems, problem)
		case isMap && m["image"] != nil:
			problems = append(problems, "remove image: a product's image is derived from its folder, <registry>/<team>/"+p.Name())
		case isMap && m["platform"] != nil:
			problems = append(problems, fmt.Sprintf("rename platform: to team: (%s)", renamed))
		}
	}
	if len(problems) == 0 {
		problems = schemaErrors(productSchema(), doc)
	}
	if len(problems) == 0 {
		spec := doc.(map[string]any)
		p.Spec = spec
		if name, _ := spec["name"].(string); name != p.Name() {
			problems = append(problems, fmt.Sprintf("name %s isn't the folder's name, %s", quote(name), quote(p.Name())))
		}
		if team, _ := spec["team"].(string); !p.IsTemplate() && team != p.Team() {
			problems = append(problems, fmt.Sprintf("team %s isn't the parent folder's name, %s", quote(team), quote(p.Team())))
		}
		names := map[string]bool{}
		for _, action := range p.Actions() {
			name, _ := action["name"].(string)
			if names[name] {
				problems = append(problems, "two actions have the same name")
			}
			names[name] = true
			secrets := map[string]bool{}
			list, _ := action["secretRefs"].([]any)
			for _, s := range list {
				secret, _ := s.(map[string]any)["name"].(string)
				if secrets[secret] {
					problems = append(problems, fmt.Sprintf("action %s: a secret is listed twice in secretRefs", name))
				}
				secrets[secret] = true
			}
			for _, side := range []string{"input", "output"} {
				if why := schemaProblem(action[side]); why != "" {
					problems = append(problems, fmt.Sprintf("action %s: %s isn't a valid JSON Schema: %s", name, side, why))
				}
			}
			// A concurrency key names inputs the action takes: a misspelt
			// one would make every step's key the same, or never the same.
			inputProps, _ := action["input"].(map[string]any)
			props, _ := inputProps["properties"].(map[string]any)
			for _, key := range stringList(action["concurrencyKey"]) {
				if _, ok := props[key]; !ok {
					problems = append(problems, fmt.Sprintf("action %s: concurrencyKey names %s, which its input doesn't have", name, quote(key)))
				}
			}
		}
		for _, action := range p.Actions() {
			problems = append(problems, cleanupProblems(action, names)...)
			problems = append(problems, planProblems(action, p.Actions())...)
		}
		problems = append(problems, checkProblems(p.Spec, p.Actions())...)
		problems = append(problems, c.testLayoutProblems(p, names)...)
	}
	dockerfile := filepath.Join(p.Dir, "Dockerfile")
	if !exists(dockerfile) {
		problems = append(problems, "no Dockerfile")
	} else {
		problems = append(problems, baseProblems(dockerfile)...)
		problems = append(problems, userProblems(dockerfile)...)
	}
	for _, problem := range problems {
		c.errorAt(path, problem)
	}
	return len(problems) == 0
}

func (c *Catalog) testLayoutProblems(p *Product, actions map[string]bool) []string {
	var problems []string
	cases := contractCases(p)
	for _, tc := range cases {
		if !actions[tc.action()] {
			problems = append(problems, fmt.Sprintf("tests/%s/: no action named %s", tc.action(), quote(tc.action())))
		}
		for _, name := range []string{"request.json", "expected.json"} {
			data, err := os.ReadFile(filepath.Join(tc.dir, name))
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s: no %s", tc.label(), name))
				continue
			}
			if _, err := loadJSON(data); err != nil {
				problems = append(problems, fmt.Sprintf("%s/%s: not valid JSON: %v", tc.label(), name, err))
			}
		}
	}
	if len(cases) == 0 && len(pythonTests(p)) == 0 {
		problems = append(problems, "no tests: add tests/<action>/<case>/{request.json,expected.json} (see templates/hello)")
	}
	return problems
}

// cleanupProblems is what's wrong with an action's cleanup: it names
// another action of its product, and each mapped input that refers to
// something ({$input: ...}, {$output: ...}, {$resource: ...}) names
// something the action has.
func cleanupProblems(action map[string]any, actions map[string]bool) []string {
	cleanup, ok := action["cleanup"].(map[string]any)
	if !ok {
		return nil
	}
	name, _ := action["name"].(string)
	var problems []string
	switch target, _ := cleanup["action"].(string); {
	case target == name:
		problems = append(problems, fmt.Sprintf("action %s: cleanup names the action itself", name))
	case !actions[target]:
		problems = append(problems, fmt.Sprintf("action %s: cleanup names %s, which this product doesn't have", name, quote(target)))
	}
	propsOf := func(side string) map[string]any {
		schema, _ := action[side].(map[string]any)
		props, _ := schema["properties"].(map[string]any)
		return props
	}
	inputs, _ := cleanup["inputs"].(map[string]any)
	for key, value := range inputs {
		ref, ok := value.(map[string]any)
		if !ok || !hasDollarKey(ref) {
			continue
		}
		if len(ref) != 1 {
			problems = append(problems, fmt.Sprintf("action %s: cleanup input %s refers to more than one thing", name, quote(key)))
			continue
		}
		for kind, raw := range ref {
			field, _ := raw.(string)
			switch kind {
			case "$input", "$output":
				if _, ok := propsOf(kind[1:])[field]; !ok {
					problems = append(problems, fmt.Sprintf("action %s: cleanup input %s names %s, which its %s doesn't have", name, quote(key), quote(field), kind[1:]))
				}
			case "$resource":
				if !slices.Contains([]string{"type", "id", "name", "link"}, field) {
					problems = append(problems, fmt.Sprintf("action %s: cleanup input %s: $resource is type, id, name or link, not %s", name, quote(key), quote(field)))
				}
			default:
				problems = append(problems, fmt.Sprintf("action %s: cleanup input %s: %s isn't $input, $output or $resource", name, quote(key), kind))
			}
		}
	}
	sort.Strings(problems)
	return problems
}

func hasDollarKey(m map[string]any) bool {
	for k := range m {
		if strings.HasPrefix(k, "$") {
			return true
		}
	}
	return false
}

// planProblems is what's wrong with an action's plan: it names another
// action of its product, one that only reports (no approval, cleanup or
// plan of its own).
func planProblems(action map[string]any, actions []map[string]any) []string {
	plan, ok := action["plan"].(string)
	if !ok {
		return nil
	}
	name, _ := action["name"].(string)
	if plan == name {
		return []string{fmt.Sprintf("action %s: plan names the action itself", name)}
	}
	for _, other := range actions {
		if other["name"] != plan {
			continue
		}
		var problems []string
		for _, field := range []string{"approval", "cleanup", "plan"} {
			if _, has := other[field]; has {
				problems = append(problems, fmt.Sprintf("action %s: its plan, %s, has %s: a plan only reports", name, quote(plan), field))
			}
		}
		return problems
	}
	return []string{fmt.Sprintf("action %s: plan names %s, which this product doesn't have", name, quote(plan))}
}

// checkProblems is what's wrong with a product's check: it names one of its
// actions, which takes no inputs it requires and only reports.
func checkProblems(spec map[string]any, actions []map[string]any) []string {
	check, ok := spec["check"].(string)
	if !ok {
		return nil
	}
	for _, action := range actions {
		if action["name"] != check {
			continue
		}
		var problems []string
		input, _ := action["input"].(map[string]any)
		if required, _ := input["required"].([]any); len(required) > 0 {
			problems = append(problems, fmt.Sprintf("check names %s, which requires inputs: a check is run with none", quote(check)))
		}
		for _, field := range []string{"approval", "cleanup", "plan"} {
			if _, has := action[field]; has {
				problems = append(problems, fmt.Sprintf("check names %s, which has %s: a check only reports", quote(check), field))
			}
		}
		return problems
	}
	return []string{fmt.Sprintf("check names %s, which this product doesn't have", quote(check))}
}
