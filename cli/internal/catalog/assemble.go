// SPDX-License-Identifier: MIT

// Package catalog makes a new catalog repository's first commit from the
// catalog template: the template itself, the first team, and the starters
// for the languages picked, with the owners and settings filled in.
package catalog

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/roburns/vennir/cli/internal/config"
)

// Options are what goes into the first commit.
type Options struct {
	// Template is a catalog-template/ directory: a checkout's, or the one
	// this release carries, extracted.
	Template string
	Team     string
	// Owners replaces the template's @your-org/catalog-admins: who approves
	// changes, e.g. "@octocat" or "@my-org/catalog-admins".
	Owners    string
	Languages []string
	// Registry goes into vennir.yaml, for running `vennir catalog` from a
	// laptop (CI takes it from the repository's variables).
	Registry string
}

// skipped are never copied: local build and tool state.
var skipped = map[string]bool{".vennir": true, ".venv": true, "__pycache__": true, "node_modules": true, "target": true, ".pytest_cache": true}

// Assemble writes the catalog's first commit into dst (which must be empty
// or missing), and returns the starters' product names.
func Assemble(o Options, dst string) ([]string, error) {
	if _, err := os.Stat(filepath.Join(o.Template, "vennir")); err != nil {
		return nil, fmt.Errorf("%s isn't a catalog template (no ./vennir)", o.Template)
	}
	if err := copyTree(o.Template, dst); err != nil {
		return nil, err
	}
	// Not offered until Azure is proven (after the MVP, decided 2026-10-25);
	// this repository's CI still checks it.
	if err := os.RemoveAll(filepath.Join(dst, "samples", "azure")); err != nil {
		return nil, err
	}
	teamDir := filepath.Join(dst, "teams", o.Team)

	// The team, from the template's team.yaml.
	teamYAML, err := os.ReadFile(filepath.Join(o.Template, "templates", "team", "team.yaml"))
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(teamDir, "products"), 0o755); err != nil {
		return nil, err
	}
	owner := strings.TrimPrefix(o.Owners, "@")
	team := setField(string(teamYAML), map[string]string{
		"name":        o.Team,
		"displayName": o.Team,
		"owner":       owner,
		"contact":     owner,
	})
	team = setFolded(team, "description", "The first team, created with the catalog by vennir.")
	team = stripHeader(team)
	if err := os.WriteFile(filepath.Join(teamDir, "team.yaml"), []byte(team), 0o644); err != nil {
		return nil, err
	}

	// Its starters, from samples/local, moved to the team.
	var products []string
	for _, lang := range o.Languages {
		product := config.Languages[lang]
		if product == "" {
			return nil, fmt.Errorf("no starter for %q", lang)
		}
		src := filepath.Join(o.Template, "samples", "local", "products", product)
		dest := filepath.Join(teamDir, "products", product)
		if err := copyTree(src, dest); err != nil {
			return nil, err
		}
		manifest := filepath.Join(dest, "product.yaml")
		data, err := os.ReadFile(manifest)
		if err != nil {
			return nil, err
		}
		data = []byte(setField(string(data), map[string]string{"team": o.Team, "owner": o.Team}))
		if err := os.WriteFile(manifest, data, 0o644); err != nil {
			return nil, err
		}
		products = append(products, product)
	}
	sort.Strings(products)

	// Owners: the placeholder everywhere, and the team's line.
	codeowners := filepath.Join(dst, ".github", "CODEOWNERS")
	data, err := os.ReadFile(codeowners)
	if err != nil {
		return nil, err
	}
	text := strings.ReplaceAll(string(data), "@your-org/catalog-admins", o.Owners)
	text = insertAfter(text, "#   /teams/<team>/", fmt.Sprintf("/teams/%s/ %s", o.Team, o.Owners))
	if err := os.WriteFile(codeowners, []byte(text), 0o644); err != nil {
		return nil, err
	}

	// Where it publishes, for `vennir catalog` from a laptop.
	settings := filepath.Join(dst, "vennir.yaml")
	data, err = os.ReadFile(settings)
	if err != nil {
		return nil, err
	}
	text = setField(string(data), map[string]string{"registry": o.Registry})
	return products, os.WriteFile(settings, []byte(text), 0o644)
}

// setField replaces top-level `key: value` lines, keeping the rest (a
// trailing comment goes: it described the placeholder).
func setField(yaml string, values map[string]string) string {
	for key, value := range values {
		re := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(key) + `:.*$`)
		yaml = re.ReplaceAllLiteralString(yaml, key+": "+value)
	}
	return yaml
}

// setFolded replaces a top-level folded block (`key: >-` and its indented
// lines).
func setFolded(yaml, key, value string) string {
	re := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(key) + `: >-\n(  .*\n)+`)
	return re.ReplaceAllLiteralString(yaml, key+": "+value+"\n")
}

// stripHeader drops a template's leading comment (its "copy me" notes).
func stripHeader(yaml string) string {
	lines := strings.Split(yaml, "\n")
	i := 0
	for i < len(lines) && strings.HasPrefix(lines[i], "#") {
		i++
	}
	return strings.Join(lines[i:], "\n")
}

// insertAfter puts line after the first line starting with prefix.
func insertAfter(text, prefix, line string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		if strings.HasPrefix(l, prefix) {
			return strings.Join(append(lines[:i+1], append([]string{line}, lines[i+1:]...)...), "\n")
		}
	}
	return text + line + "\n"
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && skipped[d.Name()] {
			return filepath.SkipDir
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			return os.MkdirAll(target, 0o755)
		case info.Mode()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		default:
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			return os.WriteFile(target, data, info.Mode().Perm())
		}
	})
}

// Pin points a catalog's ./vennir at a released vennir: its version and each
// platform's SHA-256, as .github/scripts/pin-vennir.sh does, so the
// catalog's CI runs the release its install does.
func Pin(wrapper, version string, sums map[string]string) error {
	data, err := os.ReadFile(wrapper)
	if err != nil {
		return err
	}
	s := string(data)
	versionLine := regexp.MustCompile(`(?m)^version=".*"$`)
	if !versionLine.MatchString(s) {
		return fmt.Errorf("%s has no version= line to pin", wrapper)
	}
	s = versionLine.ReplaceAllLiteralString(s, `version="`+version+`"`)
	for platform, sum := range sums {
		line := regexp.MustCompile(`(?m)^  ` + regexp.QuoteMeta(platform) + `\) sha256="[0-9a-f]*" ;;$`)
		if !line.MatchString(s) {
			return fmt.Errorf("%s has no %s line to pin", wrapper, platform)
		}
		s = line.ReplaceAllLiteralString(s, `  `+platform+`) sha256="`+sum+`" ;;`)
	}
	return os.WriteFile(wrapper, []byte(s), 0o755)
}
