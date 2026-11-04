// SPDX-License-Identifier: MIT

package install

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/rburns629/vennir/cli/internal/run"
)

// pullFixture is a released chart's package (execution-kernel/Chart.yaml
// saying body), the Runner whose helm "pulls" it, and a file counting pulls.
func pullFixture(t *testing.T, version, body string) (pkg string, r *run.Runner, pulls string) {
	t.Helper()
	dir := t.TempDir()
	pkg = filepath.Join(dir, "execution-kernel-"+version+".tgz")
	f, err := os.Create(pkg)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "execution-kernel/Chart.yaml", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	for _, c := range []interface{ Close() error }{tw, gz, f} {
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
	pulls = filepath.Join(dir, "pulls")
	script := filepath.Join(dir, "helm")
	sh := "#!/bin/sh\necho pull >> \"$FAKE_PULLS\"\nwhile [ $# -gt 0 ]; do [ \"$1\" = --destination ] && dest=$2; shift; done\ncp \"$FAKE_CHART\" \"$dest/\"\n"
	if err := os.WriteFile(script, []byte(sh), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_CHART", pkg)
	t.Setenv("FAKE_PULLS", pulls)
	return pkg, &run.Runner{Out: os.Stdout, Err: os.Stderr, Resolve: func(string) string { return script }}, pulls
}

func sha(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func pullCount(pulls string) int {
	b, _ := os.ReadFile(pulls)
	return strings.Count(string(b), "pull")
}

// knowing makes this vennir know a release's charts by these sums.
func knowing(t *testing.T, version, kernelSum string) {
	saved := releaseChartSums
	t.Cleanup(func() { releaseChartSums = saved })
	releaseChartSums = kernelSum + "  execution-kernel-" + version + ".tgz\n" +
		strings.Repeat("0", 64) + "  execution-console-" + version + ".tgz\n"
}

func TestEveryReleaseUpToNowIsKnown(t *testing.T) {
	line := regexp.MustCompile(`^[0-9a-f]{64}  execution-(kernel|console)-\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\.tgz$`)
	for l := range strings.Lines(releaseChartSums) {
		if !line.MatchString(strings.TrimSuffix(l, "\n")) {
			t.Errorf("not a sha256sum line: %q", l)
		}
	}
	for _, v := range []string{"0.5.2", "0.6.0", "0.7.0", "0.8.0"} {
		if err := KnownRelease(v); err != nil {
			t.Error(err)
		}
	}
	if err := KnownRelease("99.0.0"); err == nil || !strings.Contains(err.Error(), "no recorded checksums for release 99.0.0") {
		t.Errorf("an unknown release: %v", err)
	}
	if known := KnownReleases(); !slices.Contains(known, "0.8.0") || slices.Contains(known, "99.0.0") {
		t.Errorf("known: %v", known)
	}
}

func TestAReleasedChartIsCheckedThenUnpackedAndKept(t *testing.T) {
	pkg, r, pulls := pullFixture(t, "9.1.0", "name: execution-kernel\n")
	knowing(t, "9.1.0", sha(t, pkg))
	chart := Chart{Dir: filepath.Join(t.TempDir(), "charts", "9.1.0", "execution-kernel"), Remote: ReleaseCharts + "/execution-kernel", Version: "9.1.0"}

	if err := Pull(context.Background(), r, chart); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(chart.Dir, "Chart.yaml")); err != nil || string(b) != "name: execution-kernel\n" {
		t.Fatalf("unpacked: %q, %v", b, err)
	}
	kept := filepath.Join(filepath.Dir(chart.Dir), "execution-kernel-9.1.0.tgz")
	if sha(t, kept) != sha(t, pkg) {
		t.Error("the checked package isn't kept beside it")
	}
	// Once kept and still matching, it isn't pulled again, but what's
	// installed is unpacked from it afresh: an edit to the unpacked chart, or
	// a file added to it, doesn't reach Helm.
	edited := filepath.Join(chart.Dir, "Chart.yaml")
	if err := os.WriteFile(edited, []byte("name: edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chart.Dir, "extra.yaml"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Pull(context.Background(), r, chart); err != nil || pullCount(pulls) != 1 {
		t.Errorf("second apply: %v, %d pulls", err, pullCount(pulls))
	}
	if b, _ := os.ReadFile(edited); string(b) != "name: execution-kernel\n" {
		t.Errorf("the edited chart was kept: %q", b)
	}
	if _, err := os.Stat(filepath.Join(chart.Dir, "extra.yaml")); !os.IsNotExist(err) {
		t.Error("an added file was kept")
	}
	// A kept package that no longer matches, or none (a chart pulled before
	// vennir kept its package), is pulled and checked again.
	if err := os.WriteFile(kept, []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Pull(context.Background(), r, chart); err != nil || pullCount(pulls) != 2 || sha(t, kept) != sha(t, pkg) {
		t.Errorf("tampered: %v, %d pulls", err, pullCount(pulls))
	}
	if err := os.Remove(kept); err != nil {
		t.Fatal(err)
	}
	if err := Pull(context.Background(), r, chart); err != nil || pullCount(pulls) != 3 {
		t.Errorf("unkept: %v, %d pulls", err, pullCount(pulls))
	}
}

func TestAReleasedChartThatIsNotTheReleasesIsRefused(t *testing.T) {
	_, r, _ := pullFixture(t, "9.1.0", "name: something else\n")
	knowing(t, "9.1.0", strings.Repeat("a", 64))
	chart := Chart{Dir: filepath.Join(t.TempDir(), "charts", "9.1.0", "execution-kernel"), Remote: ReleaseCharts + "/execution-kernel", Version: "9.1.0"}

	err := Pull(context.Background(), r, chart)
	if err == nil || !strings.Contains(err.Error(), "checksum doesn't match") {
		t.Fatalf("got %v, want a checksum refusal", err)
	}
	entries, _ := os.ReadDir(filepath.Dir(chart.Dir))
	if len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
}

func TestAnUnknownReleaseIsNotPulled(t *testing.T) {
	_, r, pulls := pullFixture(t, "99.0.0", "name: execution-kernel\n")
	chart := Chart{Dir: filepath.Join(t.TempDir(), "execution-kernel"), Remote: ReleaseCharts + "/execution-kernel", Version: "99.0.0"}
	if err := Pull(context.Background(), r, chart); err == nil || pullCount(pulls) != 0 {
		t.Errorf("got %v, %d pulls; want a refusal before any pull", err, pullCount(pulls))
	}
}
