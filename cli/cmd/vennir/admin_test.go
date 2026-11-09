// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/roburns/vennir/cli/internal/config"
)

func TestSavePassword(t *testing.T) {
	dir := t.TempDir()
	// An older file anyone could read, and a .gitignore without a last newline.
	if err := os.WriteFile(filepath.Join(dir, "admin-password"), []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("tofu/"), 0o644); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		path, err := savePassword(dir, "s3cret")
		if err != nil {
			t.Fatal(err)
		}
		if path != filepath.Join(dir, "admin-password") {
			t.Errorf("path %q", path)
		}
	}
	info, err := os.Stat(filepath.Join(dir, "admin-password"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v, want 0600", info.Mode().Perm())
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "admin-password")); string(b) != "s3cret\n" {
		t.Errorf("password file %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, ".gitignore")); string(b) != "tofu/\nadmin-password\n" {
		t.Errorf(".gitignore %q", b)
	}
}

func TestSavePasswordNewFolder(t *testing.T) {
	dir := t.TempDir()
	if _, err := savePassword(dir, "s3cret"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, ".gitignore")); string(b) != "admin-password\n" {
		t.Errorf(".gitignore %q", b)
	}
}

// A symlink at the path is replaced, not written through (into a file git
// may track), and a .gitignore already listing it, CRLF or rooted, isn't
// added to.
func TestSavePasswordSymlinkAndListed(t *testing.T) {
	dir := t.TempDir()
	tracked := filepath.Join(dir, "tracked.txt")
	if err := os.WriteFile(tracked, []byte("keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(tracked, filepath.Join(dir, "admin-password")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("tofu/\r\n/admin-password\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := savePassword(dir, "s3cret"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(tracked); string(b) != "keep\n" {
		t.Errorf("written through the symlink: %q", b)
	}
	info, err := os.Lstat(filepath.Join(dir, "admin-password"))
	if err != nil {
		t.Fatal(err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Errorf("admin-password is %v", info.Mode())
	}
	if b, _ := os.ReadFile(filepath.Join(dir, ".gitignore")); string(b) != "tofu/\r\n/admin-password\r\n" {
		t.Errorf(".gitignore %q", b)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 3 {
		t.Errorf("left behind: %v", entries)
	}
}

// The first admin's password is given until an apply has finished: a first
// console install that failed is listed by helm, but its retry's migrate may
// be the one that creates the account.
func TestFirstAdminPending(t *testing.T) {
	dir := t.TempDir()
	if !firstAdminPending(dir, "") {
		t.Error("a fresh install")
	}
	if firstAdminPending(dir, "execution-console-0.1.0") {
		t.Error("installed, and no password saved: nothing to give")
	}
	if _, err := savePassword(dir, "s3cret"); err != nil {
		t.Fatal(err)
	}
	if !firstAdminPending(dir, "execution-console-0.1.0") || savedPassword(dir) != "s3cret" {
		t.Error("a first install that stopped part way gives the saved password again")
	}
	if err := config.Default("kind").SaveApplied(dir); err != nil {
		t.Fatal(err)
	}
	if firstAdminPending(dir, "execution-console-0.1.0") {
		t.Error("an apply has finished: the account has its password")
	}
}
