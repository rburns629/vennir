// SPDX-License-Identifier: MIT

package catalogtool

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const baseProduct = `apiVersion: vennir.dev/v2
kind: Product
name: db
team: a
displayName: DB
description: A database.
owner: a
actions:
  - name: create
    shareWith: [b]
    input:
      type: object
      required: [name]
      properties:
        name: {type: string}
        size: {type: integer}
    output:
      type: object
      required: [host]
      properties:
        host: {type: string}
        port: {type: integer}
  - name: drop
    input: {type: object}
    output: {type: object}
`

// history commits files as the base, applies change, and returns the
// catalog and the base commit.
func history(t *testing.T, files map[string]string, change func(root string)) (*Catalog, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	c := catalogWith(t, files)
	run := func(args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = c.Root
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init", "-q")
	run("add", "-A")
	run("commit", "-qm", "base")
	base := run("rev-parse", "HEAD")
	change(c.Root)
	return c, base
}

func edit(t *testing.T, root, path, old, replacement string) {
	t.Helper()
	full := filepath.Join(root, path)
	data, err := os.ReadFile(full)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), old) {
		t.Fatalf("%s has no %q", path, old)
	}
	if err := os.WriteFile(full, []byte(strings.Replace(string(data), old, replacement, 1)), 0o644); err != nil {
		t.Fatal(err)
	}
}

// compatibility runs the check on every product, as `check --changed` does.
func compatibility(t *testing.T, c *Catalog, base string) (bool, string) {
	t.Helper()
	var out strings.Builder
	c.Stdout, c.Stderr = &out, &out
	products := c.AllProducts()
	for _, p := range products {
		data, _ := os.ReadFile(filepath.Join(p.Dir, "product.yaml"))
		doc, _ := loadYAML(data)
		p.Spec, _ = doc.(map[string]any)
	}
	ok := c.Compatibility(base, products)
	return ok, out.String()
}

const productPath = "teams/a/products/db/product.yaml"

func TestCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name     string
		old, new string
		breaking string // "" for an allowed change
	}{
		{"an unchanged product", "", "", ""},
		{"a new optional input", "        size: {type: integer}\n", "        size: {type: integer}\n        zone: {type: string}\n", ""},
		{"a new action", "  - name: drop\n", "  - name: resize\n    input: {type: object}\n    output: {type: object}\n  - name: drop\n", ""},
		{"sharing with everyone", "shareWith: [b]", `shareWith: ["*"]`, ""},
		{"a newly required input", "required: [name]", "required: [name, size]", "action create: input 'size' is newly required"},
		{"a retyped input", "size: {type: integer}", "size: {type: string}", "action create: input 'size' changed type, integer → string"},
		{"a closed input schema", "      type: object\n      required: [name]", "      type: object\n      additionalProperties: false\n      required: [name]", "its input no longer accepts properties it doesn't declare"},
		{"a removed output", "        port: {type: integer}\n", "", "action create: output 'port' was removed"},
		{"a retyped output", "port: {type: integer}", "port: {type: string}", "action create: output 'port' changed type, integer → string"},
		{"an output no longer guaranteed", "required: [host]", "required: []", "action create: output 'host' is no longer always returned"},
		{"a team no longer shared with", "shareWith: [b]", "shareWith: [c]", "action create: no longer shared with 'b'"},
		{"an action removed undeprecated", "  - name: drop\n    input: {type: object}\n    output: {type: object}\n", "", "action drop was removed without being deprecated first"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, base := history(t, map[string]string{productPath: baseProduct}, func(root string) {
				if tc.old != "" {
					edit(t, root, productPath, tc.old, tc.new)
				}
			})
			ok, out := compatibility(t, c, base)
			if tc.breaking == "" {
				if !ok {
					t.Fatalf("refused an allowed change:\n%s", out)
				}
				return
			}
			if ok || !strings.Contains(out, tc.breaking) || !strings.Contains(out, "raise version (now 1) to 2") {
				t.Fatalf("want %q refused with the version hint, got ok=%v:\n%s", tc.breaking, ok, out)
			}
			// Raising the version allows it.
			edit(t, c.Root, productPath, "owner: a\n", "owner: a\nversion: 2\n")
			if ok, out := compatibility(t, c, base); !ok {
				t.Fatalf("refused after raising the version:\n%s", out)
			}
		})
	}
}

func TestRemovalNeedsDeprecationFirst(t *testing.T) {
	deprecated := strings.Replace(baseProduct, "owner: a\n", "owner: a\ndeprecated: Use db2.\n", 1)
	other := strings.NewReplacer("name: db\n", "name: other\n").Replace(baseProduct)
	for _, tc := range []struct {
		name    string
		files   map[string]string
		remove  string
		refused bool
	}{
		{"a product removed undeprecated", map[string]string{productPath: baseProduct, "teams/a/products/other/product.yaml": other}, "teams/a/products/db", true},
		{"a product deprecated first", map[string]string{productPath: deprecated, "teams/a/products/other/product.yaml": other}, "teams/a/products/db", false},
		{"a whole team retired", map[string]string{productPath: baseProduct}, "teams/a", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, base := history(t, tc.files, func(root string) {
				if err := os.RemoveAll(filepath.Join(root, tc.remove)); err != nil {
					t.Fatal(err)
				}
			})
			ok, out := compatibility(t, c, base)
			if ok == tc.refused || (tc.refused && !strings.Contains(out, "removed without being deprecated first")) {
				t.Fatalf("ok=%v:\n%s", ok, out)
			}
		})
	}
}

func TestTemplatesWarnAboutDeprecatedActions(t *testing.T) {
	product := strings.Replace(productFile("mine", "a", "[]"), "  - name: run\n", "  - name: run\n    deprecated: Use mine.go instead.\n", 1)
	// goodTemplate's first step only: it uses a/mine.run.
	template := strings.Replace(goodTemplate, "  - id: second\n    action: b/theirs.run\n    dependsOn: [first]\n    inputs:\n      text: {$fromStep: first, $output: text}\n", "", 1)
	c := catalogWith(t, map[string]string{"teams/a/products/mine/product.yaml": product, "teams/a/dags/chain.yaml": template})
	var out strings.Builder
	c.Stdout, c.Stderr = &out, &out
	if !c.ValidateDags() {
		t.Fatalf("a deprecated action refused the template:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "WARNING: teams/a/dags/chain.yaml: step first uses a/mine.run, which is deprecated: Use mine.go instead.") {
		t.Errorf("no warning in:\n%s", out.String())
	}
}

func TestChangedProductsSeesUncommittedAndNewFolders(t *testing.T) {
	other := strings.Replace(baseProduct, "name: db\n", "name: other\n", 1)
	c, base := history(t, map[string]string{productPath: baseProduct, "teams/a/products/other/product.yaml": other}, func(root string) {
		edit(t, root, productPath, "description: A database.", "description: A bigger database.")
		full := filepath.Join(root, "teams/a/products/fresh/product.yaml")
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(strings.Replace(baseProduct, "name: db\n", "name: fresh\n", 1)), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	got := strings.Join(c.ChangedProducts(base, c.AllProducts()), " ")
	if got != "teams/a/products/db teams/a/products/fresh" {
		t.Errorf("changed = %q", got)
	}
}
