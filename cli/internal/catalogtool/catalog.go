// SPDX-License-Identifier: MIT

// Package vennir catalog validates, builds, tests, scans and publishes a
// catalog's products, and manages its teams and SecretStores through the
// console. It's the one implementation behind both ways of publishing: the
// catalog's CI workflows call it, and so does a laptop in local mode
// (./vennir catalog publish, or make catalog-publish in the platform
// repository). Settings come from vennir.yaml at the catalog's root,
// overridable by environment variables.
package catalogtool

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Catalog is one catalog repository, and where its output goes.
type Catalog struct {
	// Root is the repository's top folder (where ./vennir is).
	Root   string
	Stdout io.Writer
	Stderr io.Writer
	// GitHub is set inside GitHub Actions: errors become annotations and
	// each product's output a collapsible group.
	GitHub bool
	// SummaryPath is the run summary's file, when there is one.
	SummaryPath string
	// Getenv reads settings and credentials (os.Getenv outside tests).
	Getenv func(string) string
	// Images is where the images teams' own Environments built are
	// (<team>/<product>.tar, BuildForEnvironment), for check and publish to
	// load rather than build: catalog CI's --images.
	Images string
}

// New returns the catalog at root, writing to the process's output.
func New(root string) *Catalog {
	return &Catalog{
		Root:        root,
		Stdout:      os.Stdout,
		Stderr:      os.Stderr,
		GitHub:      os.Getenv("GITHUB_ACTIONS") == "true",
		SummaryPath: os.Getenv("GITHUB_STEP_SUMMARY"),
		Getenv:      os.Getenv,
	}
}

func (c *Catalog) path(parts ...string) string {
	return filepath.Join(append([]string{c.Root}, parts...)...)
}

// rel is path relative to the catalog's root, with forward slashes.
func (c *Catalog) rel(path string) string {
	r, err := filepath.Rel(c.Root, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(r)
}

// errorAt reports a problem, at path when there is one ("" for none).
func (c *Catalog) errorAt(path, message string) {
	if c.GitHub {
		where := ""
		if path != "" {
			where = " file=" + c.rel(path)
		}
		fmt.Fprintf(c.Stdout, "::error%s::%s\n", where, message)
		return
	}
	where := ""
	if path != "" {
		where = c.rel(path) + ": "
	}
	fmt.Fprintf(c.Stderr, "ERROR: %s%s\n", where, message)
}

// warnAt reports something worth knowing that doesn't fail the check.
func (c *Catalog) warnAt(path, message string) {
	if c.GitHub {
		fmt.Fprintf(c.Stdout, "::warning file=%s::%s\n", c.rel(path), message)
		return
	}
	fmt.Fprintf(c.Stderr, "WARNING: %s: %s\n", c.rel(path), message)
}

func (c *Catalog) info(format string, args ...any) {
	fmt.Fprintf(c.Stdout, format+"\n", args...)
}

// group starts a collapsible section in a GitHub Actions log (a heading
// elsewhere); the function it returns ends it.
func (c *Catalog) group(title string) func() {
	if c.GitHub {
		fmt.Fprintf(c.Stdout, "::group::%s\n", title)
		return func() { fmt.Fprintln(c.Stdout, "::endgroup::") }
	}
	fmt.Fprintf(c.Stdout, "\n== %s\n", title)
	return func() {}
}

// summary appends to the GitHub Actions run summary, when there is one.
func (c *Catalog) summary(markdown string) {
	if c.SummaryPath == "" {
		return
	}
	f, err := os.OpenFile(c.SummaryPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		c.errorAt("", "writing the run summary: "+err.Error())
		return
	}
	defer f.Close()
	fmt.Fprintln(f, markdown)
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// glob is filepath.Glob sorted, under the catalog's root.
func (c *Catalog) glob(pattern string) []string {
	matches, _ := filepath.Glob(c.path(filepath.FromSlash(pattern)))
	return matches // Glob's results are already sorted
}

func quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `\'`) + "'"
}
