// SPDX-License-Identifier: MIT

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSettingsThatCantWorkAreRefusedAtStartup(t *testing.T) {
	seed := filepath.Join(t.TempDir(), "seed")
	if err := os.WriteFile(seed, []byte(strings.Repeat("s", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"DATABASE_URL": "postgres://x", "CONSOLE_URL": "http://console", "GATEWAY_ISSUER": "http://gw", "SIGNING_KEY_FILE": seed}
	getenv := func(name string) string { return env[name] }
	if s, err := Load(getenv); err != nil || s.Refresh.Seconds() != 5 || s.DefaultPerMinute != 600 ||
		s.UnauthenticatedPerMinute != 60 || s.BodyReadTimeout.Seconds() != 30 {
		t.Fatalf("the defaults: %+v, %v", s, err)
	}
	for _, name := range []string{"REFRESH_SECONDS", "DEFAULT_PER_MINUTE", "BODY_READ_TIMEOUT_SECONDS"} {
		env[name] = "0"
		if _, err := Load(getenv); err == nil || !strings.Contains(err.Error(), name+": at least 1") {
			t.Errorf("%s=0: %v", name, err)
		}
		delete(env, name)
	}
	// No limit before sign-in is a choice: 0 turns it off.
	env["UNAUTHENTICATED_PER_MINUTE"] = "0"
	if s, err := Load(getenv); err != nil || s.UnauthenticatedPerMinute != 0 {
		t.Errorf("UNAUTHENTICATED_PER_MINUTE=0: %+v, %v", s, err)
	}
}

func TestTrustedProxiesAreAddressesOrRanges(t *testing.T) {
	seed := filepath.Join(t.TempDir(), "seed")
	if err := os.WriteFile(seed, []byte(strings.Repeat("s", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"DATABASE_URL": "postgres://x", "CONSOLE_URL": "http://console", "GATEWAY_ISSUER": "http://gw", "SIGNING_KEY_FILE": seed,
		"TRUSTED_PROXIES": "10.244.0.0/16, 34.120.1.2,10.1.2.3/8, 2001:db8::/32"}
	getenv := func(name string) string { return env[name] }
	s, err := Load(getenv)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, p := range s.TrustedProxies {
		got = append(got, p.String())
	}
	// A bare address is itself alone; a range is kept as the range it names.
	if want := "10.244.0.0/16 34.120.1.2/32 10.0.0.0/8 2001:db8::/32"; strings.Join(got, " ") != want {
		t.Errorf("TrustedProxies = %v, want %s", got, want)
	}
	env["TRUSTED_PROXIES"] = "10.0.0.0/8,ingress.local"
	if _, err := Load(getenv); err == nil || !strings.Contains(err.Error(), `TRUSTED_PROXIES: an address or CIDR range, got "ingress.local"`) {
		t.Errorf("a name: %v", err)
	}
}
