// SPDX-License-Identifier: MIT

package catalogtool

import (
	"bytes"
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	"github.com/google/go-containerregistry/pkg/v1/random"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

// The repository's own catalog template.
const template = "../../../catalog-template"

func quiet(t *testing.T, root string) (*Catalog, *bytes.Buffer) {
	t.Helper()
	abs, err := filepath.Abs(root)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	return &Catalog{Root: abs, Stdout: &out, Stderr: &out, Getenv: func(string) string { return "" }}, &out
}

func TestEmbeddedSchemasMatchTheTemplates(t *testing.T) {
	for _, name := range []string{"product.schema.json", "team.schema.json", "template.schema.json", "dag.schema.json", "api.schema.json", "types.schema.json"} {
		embedded, err := schemas.ReadFile("schemas/" + name)
		if err != nil {
			t.Fatal(err)
		}
		inTemplate, err := os.ReadFile(filepath.Join(template, "tools", name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(embedded, inTemplate) {
			t.Errorf("%s: internal/catalogtool/schemas and catalog-template/tools differ; copy the one you changed over the other", name)
		}
	}
}

func TestTheTemplatesStartersValidate(t *testing.T) {
	c, out := quiet(t, template)
	ok, err := c.Products(context.Background(), "validate", nil, nil)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v\n%s", ok, err, out)
	}
	if len(c.AllProducts()) == 0 {
		t.Fatal("no starters found: the test checked nothing")
	}
}

func TestCodeownersMatching(t *testing.T) {
	for _, tc := range []struct {
		pattern, path string
		want          bool
	}{
		{"*", "anything/at/all", true},
		{"/tools/", "tools/product.schema.json", true},
		{"/vennir", "vennir", true},
		{"/teams/*/secret-stores/", "teams/x/secret-stores/secretstore.yaml", true},
		{"/teams/*/secret-stores/", "teams/x/products/p/product.yaml", false},
		{"/teams/a/", "teams/ab/team.yaml", false},
	} {
		if got := codeownersMatches(tc.pattern, tc.path); got != tc.want {
			t.Errorf("%s ~ %s = %v", tc.pattern, tc.path, got)
		}
	}
	rules, problems := codeownersRules("* @admins\n/teams/a/ @a # comment\n/teams/a/x @b\n")
	if len(problems) != 0 || len(rules) != 3 {
		t.Fatal(rules, problems)
	}
	// The last matching line wins.
	if got := ownersOf(rules, "teams/a/x/y"); len(got) != 1 || got[0] != "@b" {
		t.Errorf("owners = %v", got)
	}
}

func TestBaseImagesMustBePinned(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Dockerfile")
	os.WriteFile(path, []byte("FROM golang:1.27@sha256:abc AS build\n"+
		"FROM build AS test\n"+
		"FROM --platform=linux/amd64 alpine:3\n"+
		"from scratch\n"), 0o644)
	problems := baseProblems(path)
	if len(problems) != 1 || !strings.Contains(problems[0], "line 3: base image alpine:3") {
		t.Fatal(problems)
	}
}

func TestContainsAllKeepsJSONTypes(t *testing.T) {
	load := func(s string) any {
		v, err := loadJSON([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	actual := load(`{"status":"failed","error":{"code":"BAD","message":"why"},"n":1,"list":[1,2]}`)
	for expected, want := range map[string]bool{
		`{"status":"failed"}`:        true,
		`{"error":{"code":"BAD"}}`:   true,
		`{"error":{"code":"OTHER"}}`: false,
		`{"n":1}`:                    true,
		`{"n":1.0}`:                  false, // as Python: an int isn't a float
		`{"n":"1"}`:                  false,
		`{"list":[1,2]}`:             true,
		`{"list":[1]}`:               false, // lists are compared whole
		`{"missing":null}`:           false,
		`{"status":"failed","error":{"code":"BAD"}}`: true,
	} {
		if got := containsAll(actual, load(expected)); got != want {
			t.Errorf("contains %s = %v", expected, got)
		}
	}
}

// An action's schema resolves only references within itself: one to a
// file or a URL is refused, never read, on the machine running the check.
func TestSchemasReadNothingOutside(t *testing.T) {
	local := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(local, []byte(`{"type":"string"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, ref := range []string{"file://" + local, "outside.json", "https://example.com/schema.json"} {
		doc := map[string]any{"type": "object", "properties": map[string]any{"x": map[string]any{"$ref": ref}}}
		if schemaProblem(doc) == "" {
			t.Errorf("%s: resolved", ref)
		}
	}
	inside := map[string]any{"type": "object", "$defs": map[string]any{"name": map[string]any{"type": "string"}},
		"properties": map[string]any{"x": map[string]any{"$ref": "#/$defs/name"}}}
	if problem := schemaProblem(inside); problem != "" {
		t.Errorf("a reference within the document: %s", problem)
	}
}

func TestSecretStoreProblems(t *testing.T) {
	store := map[string]any{
		"apiVersion": "external-secrets.io/v1", "kind": "SecretStore", "metadata": map[string]any{"name": "s"},
		"spec": map[string]any{"provider": map[string]any{"x": map[string]any{
			"auth": map[string]any{"secretRef": map[string]any{"name": "eso-auth"}},
		}}},
	}
	if p := SecretStoreProblems("team", []any{store}); len(p) != 0 {
		t.Fatal(p)
	}
	foreign := map[string]any{
		"apiVersion": "external-secrets.io/v1", "kind": "SecretStore", "metadata": map[string]any{"name": "s", "namespace": "other"},
		"spec": map[string]any{"auth": map[string]any{"secretRef": map[string]any{"name": "theirs", "namespace": "x"}}},
	}
	account := map[string]any{"apiVersion": "v1", "kind": "ServiceAccount", "metadata": map[string]any{"name": "admin"}}
	problems := SecretStoreProblems("team", []any{foreign, account, "text"})
	want := []string{
		"namespace must be 'team' (or left out), not 'other'",
		"spec.auth.secretRef.namespace points into another namespace",
		"spec.auth.secretRef must name the Secret 'eso-auth'",
		"the only ServiceAccounts allowed here",
		"document 3: isn't a Kubernetes object",
	}
	joined := strings.Join(problems, "\n")
	for _, w := range want {
		if !strings.Contains(joined, w) {
			t.Errorf("no problem saying %q in:\n%s", w, joined)
		}
	}
	if p := SecretStoreProblems("team", []any{account}); !strings.Contains(strings.Join(p, "\n"), "No SecretStore in the file.") {
		t.Error(p)
	}
}

// The same rules as the console's secretStores.ts, however a provider names
// a Secret or a ServiceAccount.
func TestSecretStoreProblemsWhateverAProviderCallsThem(t *testing.T) {
	store := func(provider map[string]any) []any {
		return []any{map[string]any{"apiVersion": "external-secrets.io/v1", "kind": "SecretStore", "metadata": map[string]any{"name": "s"},
			"spec": map[string]any{"provider": provider}}}
	}
	m := func(kv ...any) map[string]any {
		out := map[string]any{}
		for i := 0; i < len(kv); i += 2 {
			out[kv[i].(string)] = kv[i+1]
		}
		return out
	}
	for name, c := range map[string]struct {
		provider map[string]any
		want     string // "" for none
	}{
		"a token from another Secret": {m("kubernetes", m("auth", m("token", m("bearerToken", m("name", "vennir-pull", "key", "x"))))),
			"spec.provider.kubernetes.auth.token.bearerToken must name the Secret 'eso-auth'"},
		"the kubernetes provider": {m("kubernetes", m("server", m("url", "https://x"))), "the kubernetes provider"},
		"the webhook provider":    {m("webhook", m("url", "http://some-service.some-namespace.svc/{{ .remoteRef.key }}")), "the webhook provider"},
		"a CA from a Secret":      {m("vault", m("caProvider", m("type", "Secret", "name", "vennir-pull", "key", "ca"))), "spec.provider.vault.caProvider must name the Secret 'eso-auth'"},
		"a selector saying it's a ConfigMap": {m("kubernetes", m("auth", m("token", m("bearerToken", m("type", "ConfigMap", "name", "vennir-pull", "key", "x"))))),
			"bearerToken must name the Secret 'eso-auth'"},
		"a CA from a ConfigMap": {m("vault", m("caProvider", m("type", "ConfigMap", "name", "ca", "key", "ca.crt"))), ""},
		"a product's ServiceAccount": {m("gcpsm", m("auth", m("workloadIdentity", m("serviceAccountRef", m("name", "product-sa"))))),
			"must name one of ESO's ServiceAccounts"},
		"ESO's":              {m("aws", m("auth", m("jwt", m("serviceAccountRef", m("name", "eso-aws"))))), ""},
		"a remote namespace": {m("x", m("remoteNamespace", "other")), "spec.provider.x.remoteNamespace points into another namespace"},
	} {
		got := strings.Join(SecretStoreProblems("team", store(c.provider)), "\n")
		if (c.want == "" && got != "") || (c.want != "" && !strings.Contains(got, c.want)) {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
}

func TestReleaseActions(t *testing.T) {
	p := &Product{Dir: "/catalog/teams/web/products/site", Spec: map[string]any{
		"displayName": "Site", "description": "A site.", "serviceAccount": "site-sa", "deprecated": "Use site2.",
		"resources": map[string]any{"cpu": "100m", "memory": "64Mi"}, "maxRunning": 3, "capacity": "onDemand",
		"actions": []any{
			map[string]any{"name": "deploy", "input": map[string]any{"type": "object"}, "output": map[string]any{"type": "object"},
				"secretRefs": []any{map[string]any{"name": "creds"}}, "shareWith": []any{"data", "*"}},
			map[string]any{"name": "remove", "displayName": "Remove it", "input": map[string]any{"type": "object"}, "output": map[string]any{"type": "object"},
				"deprecated": "Use site2.delete."},
		},
	}}
	regs, err := p.ReleaseActions("registry/web/site@sha256:abc")
	if err != nil || len(regs) != 2 {
		t.Fatal(regs, err)
	}
	deploy, remove := regs[0], regs[1]
	if deploy.GetName() != "web-site-deploy" || deploy.GetTeam() != "web" || deploy.GetImage() != "registry/web/site@sha256:abc" ||
		deploy.GetDisplayName() != "Site" || deploy.GetServiceAccount() != "site-sa" ||
		len(deploy.GetSecretRefs()) != 1 || strings.Join(deploy.GetShareWith(), ",") != "data,*" ||
		deploy.GetDeprecated() != "Use site2." || deploy.GetResources().GetCpu() != "100m" || deploy.GetResources().GetMemoryLimit() != "" ||
		deploy.GetInputSchema().AsMap()["type"] != "object" || deploy.GetMaxRunning() != 3 || deploy.GetCapacity() != "onDemand" {
		t.Errorf("deploy = %v", deploy)
	}
	// An action's own deprecation wins over its product's.
	if remove.GetDisplayName() != "Remove it" || remove.GetDescription() != "A site." || remove.GetDeprecated() != "Use site2.delete." ||
		len(remove.GetShareWith()) != 0 {
		t.Errorf("remove = %v", remove)
	}
}

func TestSettingsProblems(t *testing.T) {
	ok := Settings{Registry: "registry.example/team", SigningMode: "none"}
	if p := ok.Problems(); len(p) != 0 {
		t.Fatal(p)
	}
	bad := Settings{Registry: "https://registry/", SigningMode: "key", Platform: "amd64"}
	if p := bad.Problems(); len(p) != 3 {
		t.Fatal(p)
	}
}

func TestBuildPlatform(t *testing.T) {
	for _, c := range []struct {
		settings Settings
		want     string
	}{
		{Settings{}, ""},
		{Settings{Registry: "localhost:5001"}, ""},
		{Settings{Registry: "kind-registry:5000/catalog"}, ""},
		{Settings{Registry: "us-docker.pkg.dev/p/catalog"}, "linux/amd64"},
		{Settings{Registry: "us-docker.pkg.dev/p/catalog", Platform: "linux/arm64"}, "linux/arm64"},
		{Settings{Registry: "localhost:5001", Platform: "linux/amd64"}, "linux/amd64"},
	} {
		if got := c.settings.BuildPlatform(); got != c.want {
			t.Errorf("%+v: %q, want %q", c.settings, got, c.want)
		}
	}
}

// A store's cloud identity is one team's alone: two teams' files naming the
// same Google service account are refused, whichever is checked.
func TestSecretStoresShareNoIdentity(t *testing.T) {
	file := func(team, gsa string) string {
		return "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: eso-gcp\n  annotations:\n    iam.gke.io/gcp-service-account: " + gsa +
			"\n---\napiVersion: external-secrets.io/v1\nkind: SecretStore\nmetadata:\n  name: vault\n  namespace: " + team +
			"\nspec:\n  provider:\n    gcpsm:\n      projectID: p\n"
	}
	c := catalogWith(t, map[string]string{
		"teams/web/secret-stores/store.yaml":  file("web", "eso@p.iam.gserviceaccount.com"),
		"teams/data/secret-stores/store.yaml": file("data", "ESO@p.iam.gserviceaccount.com"),
		"teams/ops/secret-stores/store.yaml":  file("ops", "ops@p.iam.gserviceaccount.com"),
	})
	out := errorsOf(t, func(c *Catalog) bool { return !c.SecretStoresCheck([]string{"data", "ops"}) }, c)
	if !strings.Contains(out, "data signs in as gcp:eso@p.iam.gserviceaccount.com, as web's store does") || strings.Contains(out, "ops signs in") {
		t.Errorf("got:\n%s", out)
	}

	if ids := SecretStoreIdentities([]any{map[string]any{"kind": "SecretStore", "spec": map[string]any{"provider": map[string]any{
		"aws": map[string]any{"role": "arn:aws:iam::1:role/R"}}}}}); strings.Join(ids, ",") != "aws:arn:aws:iam::1:role/r" {
		t.Errorf("a role the store assumes: %v", ids)
	}
}

// An approved base is copied into the registry keeping its digest, and a
// Dockerfile's FROM of it can point at the copy, pinned.
func TestApprovedBasesAreMirroredAndUsed(t *testing.T) {
	server := httptest.NewServer(registry.New())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")
	image, err := random.Image(64, 1)
	if err != nil {
		t.Fatal(err)
	}
	source, _ := name.NewTag(host + "/upstream/python:3.12-slim")
	if err := remote.Write(source, image); err != nil {
		t.Fatal(err)
	}
	want, _ := image.Digest()
	s := Settings{Registry: host + "/catalog-products"}
	reference, err := copyBase(context.Background(), s, Base{Name: "python", Image: source.String()})
	if err != nil {
		t.Fatal(err)
	}
	if reference != host+"/catalog-products/bases/python@"+want.String() {
		t.Errorf("copied as %s, want the same digest %s", reference, want)
	}
	mirrored, _ := name.NewTag(host + "/catalog-products/bases/python:3.12-slim")
	if desc, err := remote.Head(mirrored); err != nil || desc.Digest != want {
		t.Errorf("the copy's tag: %v, %v", desc, err)
	}

	c := catalogWith(t, map[string]string{
		"bases.yaml": "apiVersion: vennir.dev/v2\nkind: Bases\nbases:\n  - {name: python, image: \"" + source.String() + "\"}\n  - {name: python, image: \"x:1\"}\n",
	})
	if out := errorsOf(t, func(c *Catalog) bool { return c.ValidateBases() }, c); !strings.Contains(out, "python is named twice") {
		t.Errorf("a name twice: %s", out)
	}
	c = catalogWith(t, map[string]string{"bases.yaml": "apiVersion: vennir.dev/v2\nkind: Bases\nbases:\n  - {name: Python, image: \"python\"}\n"})
	if out := errorsOf(t, func(c *Catalog) bool { return c.ValidateBases() }, c); !strings.Contains(out, "bases.0") {
		t.Errorf("a bad name and an untagged image: %s", out)
	}
}
