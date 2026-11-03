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
	if s, err := Load(getenv); err != nil || s.Refresh.Seconds() != 5 || s.DefaultPerMinute != 600 {
		t.Fatalf("the defaults: %+v, %v", s, err)
	}
	for _, name := range []string{"REFRESH_SECONDS", "DEFAULT_PER_MINUTE"} {
		env[name] = "0"
		if _, err := Load(getenv); err == nil || !strings.Contains(err.Error(), name+": at least 1") {
			t.Errorf("%s=0: %v", name, err)
		}
		delete(env, name)
	}
}
