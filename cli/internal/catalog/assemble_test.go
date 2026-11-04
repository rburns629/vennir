// SPDX-License-Identifier: MIT

package catalog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The repository's own catalog template.
const template = "../../../catalog-template"

func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestAssemble(t *testing.T) {
	dst := filepath.Join(t.TempDir(), "catalog")
	products, err := Assemble(Options{
		Template: template, Team: "platform", Owners: "@octocat", Languages: []string{"python", "go"},
		Registry: "us-central1-docker.pkg.dev/p/vennir-products",
	}, dst)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(products, ",") != "slug,title-case" {
		t.Errorf("products: %v", products)
	}

	team := read(t, filepath.Join(dst, "teams/platform/team.yaml"))
	for _, want := range []string{"name: platform\n", "owner: octocat\n", "description: The first team"} {
		if !strings.Contains(team, want) {
			t.Errorf("team.yaml lacks %q:\n%s", want, team)
		}
	}
	if strings.Contains(team, "CHANGE") || strings.Contains(team, "anna") {
		t.Errorf("team.yaml kept the template's placeholders:\n%s", team)
	}

	product := read(t, filepath.Join(dst, "teams/platform/products/title-case/product.yaml"))
	if !strings.Contains(product, "\nteam: platform\n") || strings.Contains(product, "team: local") {
		t.Errorf("starter's team not rewritten:\n%s", product)
	}
	if _, err := os.Stat(filepath.Join(dst, "teams/platform/products/reverse")); err == nil {
		t.Error("an unpicked language's starter was copied")
	}

	owners := read(t, filepath.Join(dst, ".github/CODEOWNERS"))
	if strings.Contains(owners, "@your-org") || !strings.Contains(owners, "\n/teams/platform/ @octocat\n") || !strings.Contains(owners, "* @octocat") {
		t.Errorf("CODEOWNERS:\n%s", owners)
	}
	settings := read(t, filepath.Join(dst, "vennir.yaml"))
	if !strings.Contains(settings, "registry: us-central1-docker.pkg.dev/p/vennir-products\n") || strings.Contains(settings, "\nconsole:") {
		t.Errorf("vennir.yaml:\n%s", settings)
	}
	if info, err := os.Stat(filepath.Join(dst, "vennir")); err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Error("./vennir should stay executable")
	}
	// The samples stay, to copy from later; a second team's worth of them
	// isn't added.
	if _, err := os.Stat(filepath.Join(dst, "samples/azure")); !os.IsNotExist(err) {
		t.Error("samples/azure isn't offered until Azure is proven")
	}
	if _, err := os.Stat(filepath.Join(dst, "samples/local/products/reverse")); err != nil {
		t.Error("samples/ should stay")
	}
}

// The template's own ./vennir takes the pin, every line of it.
func TestPin(t *testing.T) {
	wrapper := filepath.Join(t.TempDir(), "vennir")
	data, err := os.ReadFile("../../../catalog-template/vennir")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wrapper, data, 0o755); err != nil {
		t.Fatal(err)
	}
	sums := map[string]string{}
	for i, p := range []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"} {
		sums[p] = strings.Repeat(string(rune('a'+i)), 64)
	}
	if err := Pin(wrapper, "9.8.7", sums); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(wrapper)
	if !strings.Contains(string(got), "\nversion=\"9.8.7\"\n") {
		t.Error("version not pinned")
	}
	for p, sum := range sums {
		if !strings.Contains(string(got), "  "+p+") sha256=\""+sum+"\" ;;") {
			t.Errorf("%s not pinned", p)
		}
	}
	if info, _ := os.Stat(wrapper); info.Mode().Perm()&0o100 == 0 {
		t.Error("no longer executable")
	}
	if err := Pin(wrapper, "1.0.0", map[string]string{"plan9-386": sums["linux-amd64"]}); err == nil {
		t.Error("an unknown platform was pinned")
	}
}
