// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/install"
	"github.com/rburns629/vennir/cli/internal/run"
)

// A console made public after SSO was set up: apply stops once the cloud
// side has made its address, before the console is installed, and
// `vennir sso google` then finds that address in the module's outputs (no
// Ingress yet), so rerunning it, as the error says, lets apply through.
func TestSSOAfterTheConsoleIsMadePublic(t *testing.T) {
	dir := t.TempDir()
	tofu := "#!/bin/sh\necho '{\"console_address\":{\"value\":{\"name\":\"vennir-console\",\"ip\":\"1.2.3.4\"}}}'\n"
	if err := os.WriteFile(filepath.Join(dir, "tofu"), []byte(tofu), 0o755); err != nil {
		t.Fatal(err)
	}
	a := &app{runner: &run.Runner{Out: os.Stderr, Err: os.Stderr, Resolve: func(name string) string { return filepath.Join(dir, name) }}}
	c := config.Default("gcp")
	c.SSO = config.SSO{Provider: "google", RedirectURL: "http://localhost:18080/api/auth/oidc/callback"}
	c.Console.Public, c.Console.Hostname = true, ""

	if err := install.CheckSSORedirect(c, ""); err != nil {
		t.Fatalf("before the cloud side, the address isn't known: %v", err)
	}
	host := a.cloudConsoleHost(context.Background(), dir, c)
	if host != "console.1-2-3-4.nip.io" {
		t.Fatalf("the cloud side's host: %q", host)
	}
	stop := install.CheckSSORedirect(c, host)
	if stop == nil {
		t.Fatal("apply went on with the old callback")
	}
	redirect, err := install.SSORedirect(c, host)
	if err != nil {
		t.Fatalf("sso google refused before the console is installed: %v", err)
	}
	if !strings.Contains(stop.Error(), "is now "+redirect+":") {
		t.Errorf("apply names %q, sso google registers %q", stop, redirect)
	}
	c.SSO.RedirectURL = redirect
	if err := install.CheckSSORedirect(c, host); err != nil {
		t.Errorf("after rerunning sso google: %v", err)
	}

	// No cloud side yet, or a private console: nothing read from it.
	c.Console.Public = false
	if host := a.cloudConsoleHost(context.Background(), dir, c); host != "" {
		t.Errorf("private: %q", host)
	}
}

// aws's console_address names its host.
func TestConsoleHostOfAWS(t *testing.T) {
	c := config.Default("aws")
	if got := consoleHostOf(c, []byte(`{"host":"console.vennir.example.com","zone_id":"Z1"}`)); got != "console.vennir.example.com" {
		t.Errorf("aws: %q", got)
	}
	if got := consoleHostOf(c, nil); got != "" {
		t.Errorf("none: %q", got)
	}
}
