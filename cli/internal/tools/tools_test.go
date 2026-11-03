// SPDX-License-Identifier: MIT

package tools

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/rburns629/vertra/cli/internal/run"
)

// fakeHelm returns a Runner whose helm copies the file $FAKE_CHART into
// helm pull's --destination, as helm pull does with the package it fetched.
func fakeHelm(t *testing.T, chart string) *run.Runner {
	t.Helper()
	script := filepath.Join(t.TempDir(), "helm")
	body := "#!/bin/sh\nwhile [ $# -gt 0 ]; do [ \"$1\" = --destination ] && dest=$2; shift; done\ncp \"$FAKE_CHART\" \"$dest/\"\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_CHART", chart)
	return &run.Runner{Out: os.Stdout, Err: os.Stderr, Resolve: func(string) string { return script }}
}

func sum(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// tgz writes a chart package: name/Chart.yaml and the given files.
func tgz(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []interface{ Close() error }{tw, gz, f} {
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEveryChartIsPinnedBySum(t *testing.T) {
	hexSum := regexp.MustCompile(`^[0-9a-f]{64}$`)
	for name, p := range charts {
		if !strings.HasPrefix(p.Repo, "https://") || p.Version == "" || !hexSum.MatchString(p.SHA256) {
			t.Errorf("%s: %+v", name, p)
		}
	}
}

func TestAPulledChartIsCheckedAgainstItsPin(t *testing.T) {
	saved := charts["cert-manager"]
	t.Cleanup(func() { charts["cert-manager"] = saved })
	pkg := filepath.Join(t.TempDir(), "cert-manager-"+saved.Version+".tgz")
	tgz(t, pkg, map[string]string{"cert-manager/Chart.yaml": "name: cert-manager\n"})

	charts["cert-manager"] = ChartPin{Repo: saved.Repo, Version: saved.Version, SHA256: sum(t, pkg)}
	archive, done, err := PullChart(context.Background(), fakeHelm(t, pkg), "cert-manager")
	if err != nil {
		t.Fatal(err)
	}
	if sum(t, archive) != charts["cert-manager"].SHA256 {
		t.Error("not the checked package")
	}
	done()
	if _, err := os.Stat(archive); !os.IsNotExist(err) {
		t.Error("cleanup left it behind")
	}
}

func TestAChartThatIsNotItsPinIsRefused(t *testing.T) {
	saved := charts["external-secrets"]
	t.Cleanup(func() { charts["external-secrets"] = saved })
	pkg := filepath.Join(t.TempDir(), "external-secrets-"+saved.Version+".tgz")
	tgz(t, pkg, map[string]string{"external-secrets/Chart.yaml": "name: something else\n"})

	archive, done, err := PullChart(context.Background(), fakeHelm(t, pkg), "external-secrets")
	if err == nil || !strings.Contains(err.Error(), "checksum doesn't match") {
		t.Fatalf("got %q, %v; want a checksum refusal", archive, err)
	}
	if done != nil {
		t.Error("a refused pull has nothing to clean up")
	}
}

func TestUntarRefusesWhatEscapes(t *testing.T) {
	dir := t.TempDir()
	pkg := filepath.Join(dir, "evil.tgz")
	tgz(t, pkg, map[string]string{"../outside": "x"})
	if err := Untar(pkg, filepath.Join(dir, "out")); err == nil {
		t.Fatal("unpacked a name outside its directory")
	}
	if _, err := os.Stat(filepath.Join(dir, "outside")); !os.IsNotExist(err) {
		t.Error("wrote outside its directory")
	}
}
