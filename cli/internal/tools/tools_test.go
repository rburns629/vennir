// SPDX-License-Identifier: MIT

package tools

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/rburns629/vennir/cli/internal/run"
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

func TestUntarRefusesAFileOverItsLimitRatherThanCuttingIt(t *testing.T) {
	dir := t.TempDir()
	pkg := filepath.Join(dir, "big.tgz")
	tgz(t, pkg, map[string]string{"chart/big": strings.Repeat("\x00", untarLimit+1)})
	if err := Untar(pkg, filepath.Join(dir, "out")); err == nil || !strings.Contains(err.Error(), "bigger than") {
		t.Fatalf("got %v, want a refusal", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "out", "chart", "big")); !os.IsNotExist(err) {
		t.Error("wrote part of it")
	}
}

// serve answers every request with the file at path, and pins a fake tool,
// "faketool", to the server with sum as its checksum (and member, if an
// archive). HOME is a new directory, so downloads land in a Dir of the
// test's own, returned.
func serve(t *testing.T, path, sum, member string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, path) }))
	t.Cleanup(srv.Close)
	pins["faketool"] = Pin{Version: "1.0.0", URL: srv.URL + "/{os}/{arch}/{version}", TarMember: member,
		SHA256: map[string]string{runtime.GOOS + "/" + runtime.GOARCH: sum}}
	t.Cleanup(func() { delete(pins, "faketool") })
	home := t.TempDir()
	t.Setenv("HOME", home)
	return filepath.Join(home, ".vennir", "bin")
}

// file writes body to a new file: its path.
func file(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "download")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// onlyIn: dir holds just these, nothing a download left part way.
func onlyIn(t *testing.T, dir string, want ...string) {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("%s holds %v, want %v", dir, got, want)
	}
}

// A download whose checksum matches its pin is put in place, executable.
func TestDownloadChecksMatch(t *testing.T) {
	body := file(t, "#!/bin/sh\necho fake\n")
	dir := serve(t, body, sum(t, body), "")
	path, err := Download(context.Background(), "faketool")
	if err != nil {
		t.Fatal(err)
	}
	if path != filepath.Join(dir, "faketool") {
		t.Errorf("path %s", path)
	}
	info, err := os.Stat(path)
	if err != nil || sum(t, path) != sum(t, body) || info.Mode().Perm()&0o100 == 0 {
		t.Errorf("not the download, executable: %v", err)
	}
	onlyIn(t, dir, "faketool")
}

// One that doesn't match is refused and never put in place, and a copy
// already there is left as it was.
func TestDownloadRefusesAMismatch(t *testing.T) {
	good := []byte("the pinned one")
	pinned := sha256.Sum256(good)
	dir := serve(t, file(t, "something else"), hex.EncodeToString(pinned[:]), "")
	if _, err := Download(context.Background(), "faketool"); err == nil || !strings.Contains(err.Error(), "checksum doesn't match") {
		t.Fatalf("err = %v", err)
	}
	onlyIn(t, dir)

	if err := os.WriteFile(filepath.Join(dir, "faketool"), good, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Download(context.Background(), "faketool"); err == nil {
		t.Fatal("a mismatch replaced the copy there")
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "faketool")); !bytes.Equal(got, good) {
		t.Errorf("the copy there is now %q", got)
	}
	onlyIn(t, dir, "faketool")
}

// From an archive, only the pinned member is taken, by its exact name; an
// archive without it puts nothing in place.
func TestDownloadExtractsTheMember(t *testing.T) {
	member := runtime.GOOS + "-" + runtime.GOARCH + "/faketool"
	pkg := filepath.Join(t.TempDir(), "tool.tgz")
	tgz(t, pkg, map[string]string{"README.md": "not the tool", "x/" + member: "a lookalike", member: "the tool"})
	dir := serve(t, pkg, sum(t, pkg), "{os}-{arch}/faketool")
	path, err := Download(context.Background(), "faketool")
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != "the tool" {
		t.Errorf("extracted %q", got)
	}
	onlyIn(t, dir, "faketool")

	pkg = filepath.Join(t.TempDir(), "notool.tgz")
	tgz(t, pkg, map[string]string{"README.md": "no tool here"})
	dir = serve(t, pkg, sum(t, pkg), "{os}-{arch}/faketool")
	if _, err := Download(context.Background(), "faketool"); err == nil || !strings.Contains(err.Error(), "not in the archive") {
		t.Fatalf("err = %v", err)
	}
	onlyIn(t, dir)
}

// With no home directory there's no tools directory: no download, and Path
// finds tools on PATH only, never in a shared directory such as the temp
// directory's vennir-bin (where the old fallback was).
func TestNoHomeNoToolsDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("home is USERPROFILE")
	}
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	planted := filepath.Join(tmp, "vennir-bin", "vennir-test-tool")
	if err := os.MkdirAll(filepath.Dir(planted), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(planted, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", "")
	if dir, err := Dir(); err == nil {
		t.Fatalf("Dir = %s", dir)
	}
	if _, err := Download(context.Background(), "kubectl"); err == nil || !strings.Contains(err.Error(), "no home directory") {
		t.Errorf("err = %v", err)
	}
	if got := Path("vennir-test-tool"); got != "vennir-test-tool" {
		t.Errorf("Path = %s", got)
	}
}
