// SPDX-License-Identifier: MIT

package catalogtool

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Product is a product folder: teams/<team>/products/<product>, or a
// starter in templates/<product>.
type Product struct {
	Dir string
	// Spec is product.yaml, once validated.
	Spec  map[string]any
	label string
	// SBOM is its image's software bill of materials (CycloneDX JSON), as
	// its scan found it; publishing attaches it, signed. Empty: none.
	SBOM []byte
}

// IsTemplate says whether it's a starter (checked, never published).
func (p *Product) IsTemplate() bool { return filepath.Base(filepath.Dir(p.Dir)) == "templates" }

// Team is the team whose folder it's in; a starter stands in for whichever
// team copies it.
func (p *Product) Team() string {
	if p.IsTemplate() {
		return "templates"
	}
	return filepath.Base(filepath.Dir(filepath.Dir(p.Dir)))
}

// Name is its folder's name.
func (p *Product) Name() string { return filepath.Base(p.Dir) }

// Label is its folder, relative to the catalog's root.
func (p *Product) Label() string { return p.label }

// LocalImage is what it's built as, before it passes.
func (p *Product) LocalImage() string {
	return fmt.Sprintf("vennir-catalog/%s/%s:ci", p.Team(), p.Name())
}

// Repository is where it's pushed: <registry>/<team>/<product>, from its
// folder, so no product can publish under another team's name.
func (p *Product) Repository(s Settings) string {
	return fmt.Sprintf("%s/%s/%s", s.Registry, p.Team(), p.Name())
}

// Actions are product.yaml's actions.
func (p *Product) Actions() []map[string]any {
	list, _ := p.Spec["actions"].([]any)
	var actions []map[string]any
	for _, a := range list {
		if m, ok := a.(map[string]any); ok {
			actions = append(actions, m)
		}
	}
	return actions
}

func (c *Catalog) product(dir string) *Product {
	return &Product{Dir: dir, label: c.rel(dir)}
}

// AllProducts are every team's products, then the starters.
func (c *Catalog) AllProducts() []*Product {
	var products []*Product
	for _, pattern := range []string{"teams/*/products/*/product.yaml", "templates/*/product.yaml"} {
		for _, path := range c.glob(pattern) {
			products = append(products, c.product(filepath.Dir(path)))
		}
	}
	return products
}

// SelectProducts are the products named (folders, relative to the working
// directory), the ones changed since a ref, or else all of them.
func (c *Catalog) SelectProducts(names []string, changedSince *string) ([]*Product, error) {
	products := c.AllProducts()
	if changedSince != nil {
		wanted := map[string]bool{}
		for _, label := range c.ChangedProducts(*changedSince, products) {
			wanted[label] = true
		}
		var chosen []*Product
		for _, p := range products {
			if wanted[p.Label()] {
				chosen = append(chosen, p)
			}
		}
		return chosen, nil
	}
	if len(names) == 0 {
		return products, nil
	}
	byDir := map[string]*Product{}
	for _, p := range products {
		byDir[p.Dir] = p
	}
	var chosen []*Product
	for _, name := range names {
		dir, err := filepath.Abs(name)
		if err == nil {
			dir, err = filepath.EvalSymlinks(dir)
		}
		p := byDir[dir]
		if err != nil || p == nil {
			return nil, fmt.Errorf("not a product folder (no product.yaml): %s", name)
		}
		chosen = append(chosen, p)
	}
	return chosen, nil
}

func (c *Catalog) git(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = c.Root
	out, err := cmd.Output()
	return string(out), err
}

// usableBase says whether base names a commit here: not a first push's
// zeros, not a force-pushed-away commit.
func (c *Catalog) usableBase(base string) bool {
	if base == "" || strings.Trim(base, "0") == "" {
		return false
	}
	_, err := c.git("cat-file", "-e", base+"^{commit}")
	return err == nil
}

// republishPaths are what every product is checked and published again
// for when it changes: the tooling, its settings and the pinned vennir.
var republishPaths = []string{"tools", "vennir.yaml", "vennir"}

// ChangedProducts are the product folders changed since base (committed or
// not).
// Everything, when there's no usable base (a first push, a force-push, a
// manual run) rather than silently nothing, and when the tooling itself
// changed: a new check applies to every product.
func (c *Catalog) ChangedProducts(base string, products []*Product) []string {
	var labels []string
	for _, p := range products {
		labels = append(labels, p.Label())
	}
	if !c.usableBase(base) {
		return labels
	}
	// Against the working tree, not HEAD, so a laptop's uncommitted edits
	// count too (in CI the tree is the commit); and new, untracked files.
	out, err := c.git("diff", "--name-only", base)
	if err != nil {
		return labels
	}
	untracked, err := c.git("ls-files", "--others", "--exclude-standard")
	if err != nil {
		return labels
	}
	names := strings.Split(strings.TrimSpace(out+"\n"+untracked), "\n")
	for _, n := range names {
		for _, path := range republishPaths {
			if n == path || strings.HasPrefix(n, path+"/") {
				return labels
			}
		}
	}
	changed := []string{}
	for _, label := range labels {
		for _, n := range names {
			if strings.HasPrefix(n, label+"/") {
				changed = append(changed, label)
				break
			}
		}
	}
	return changed
}

// root finds the catalog a command runs in: VENNIR_CATALOG_ROOT (set by
// the ./vennir wrapper), else the working directory.
func Root() (string, error) {
	root := os.Getenv("VENNIR_CATALOG_ROOT")
	if root == "" {
		var err error
		if root, err = os.Getwd(); err != nil {
			return "", err
		}
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(root)
}
