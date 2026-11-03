// SPDX-License-Identifier: MIT

package install

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rburns629/vertra/cli/internal/run"
)

// fakeKubectl is a kubectl that records its arguments and stdin in dir and
// prints out.
func fakeKubectl(t *testing.T, out string) (*run.Runner, string) {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "kubectl")
	body := "#!/bin/sh\necho \"$@\" >> \"" + dir + "/args\"\ncat > \"" + dir + "/stdin\"\nprintf '%s' \"$FAKE_OUT\"\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_OUT", out)
	return &run.Runner{Out: os.Stdout, Err: os.Stderr, Resolve: func(string) string { return script }}, dir
}

// The first admin's password reaches the console in a Secret, through
// stdin: never an argument (a process list) or a value in the values file.
func TestGivePassword(t *testing.T) {
	r, dir := fakeKubectl(t, "")
	c := kindConfig()
	password := NewPassword()
	if len(password) < 24 || password == NewPassword() {
		t.Fatalf("not a random password: %d characters", len(password))
	}
	if err := GivePassword(context.Background(), r, c, password); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(filepath.Join(dir, "args"))
	stdin, _ := os.ReadFile(filepath.Join(dir, "stdin"))
	if strings.Contains(string(args), password) {
		t.Error("the password is in kubectl's arguments")
	}
	if !strings.Contains(string(args), "--namespace "+c.Namespace+" apply -f -") {
		t.Errorf("args: %s", args)
	}
	if !strings.Contains(string(stdin), "name: "+FirstAdminSecret) || !strings.Contains(string(stdin), `password: "`+password+`"`) {
		t.Error("the Secret isn't the one the console reads")
	}

	v := ConsoleValues(c, "dev", Images{}, nil)
	WithFirstAdmin(v)
	admin := v["bootstrapAdmin"].(map[string]any)
	if admin["existingSecret"] != FirstAdminSecret || admin["mustChangePassword"] != true || admin["password"] != nil {
		t.Errorf("bootstrapAdmin: %v", admin)
	}
}

// The account is new only when the migrate Job's log says so; a log that
// can't be read isn't taken to mean it wasn't.
func TestAdminCreated(t *testing.T) {
	c := kindConfig()
	r, _ := fakeKubectl(t, "Migrations applied.\nBootstrap admin account created: admin@example.com\n")
	if !AdminCreated(context.Background(), r, c) {
		t.Error("created, by its log")
	}
	r, _ = fakeKubectl(t, "Migrations applied.\n")
	if AdminCreated(context.Background(), r, c) {
		t.Error("already there: its log doesn't say it was created")
	}
	r = &run.Runner{Out: os.Stdout, Err: os.Stderr, Resolve: func(string) string { return "/nonexistent/kubectl" }}
	if !AdminCreated(context.Background(), r, c) {
		t.Error("an unread log isn't proof it was already there")
	}
}
