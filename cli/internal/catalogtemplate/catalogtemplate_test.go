// SPDX-License-Identifier: MIT

package catalogtemplate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// What the release workflow embeds: git archive of this checkout's template.
func TestExtractGitArchive(t *testing.T) {
	out, err := exec.Command("git", "-C", "../../..", "archive", "--format=tar.gz", "HEAD", "catalog-template").Output()
	if err != nil {
		t.Skipf("no git archive here: %v", err)
	}
	root, err := extract(out, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, "vennir"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Errorf("./vennir is %v, not executable", info.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(root, "templates", "team", "team.yaml")); err != nil {
		t.Error(err)
	}
}

func archiveOf(t *testing.T, headers ...tar.Header) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, h := range headers {
		body := "x"
		if h.Typeflag == tar.TypeReg {
			h.Size = int64(len(body))
		}
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			_, _ = tw.Write([]byte(body))
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestExtractRefuses(t *testing.T) {
	vennir := tar.Header{Name: "catalog-template/vennir", Typeflag: tar.TypeReg, Mode: 0o755}
	for name, h := range map[string]tar.Header{
		"outside":   {Name: "catalog-template/../evil", Typeflag: tar.TypeReg, Mode: 0o644},
		"elsewhere": {Name: "other/file", Typeflag: tar.TypeReg, Mode: 0o644},
		"symlink":   {Name: "catalog-template/link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"},
	} {
		dir := t.TempDir()
		if _, err := extract(archiveOf(t, vennir, h), dir); err == nil {
			t.Errorf("%s: extracted", name)
		}
		if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "evil")); err == nil {
			t.Errorf("%s: wrote outside", name)
		}
	}
	if _, err := extract(archiveOf(t, tar.Header{Name: "catalog-template/README.md", Typeflag: tar.TypeReg, Mode: 0o644}), t.TempDir()); err == nil || !strings.Contains(err.Error(), "./vennir") {
		t.Errorf("no ./vennir: %v", err)
	}
}

// A build from a checkout carries none, and says so.
func TestNotEmbedded(t *testing.T) {
	if Embedded() {
		t.Skip("built with the template")
	}
	if _, err := Extract(t.TempDir()); err == nil {
		t.Error("extracted from an empty archive")
	}
}
