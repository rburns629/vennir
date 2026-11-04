// SPDX-License-Identifier: MIT

package config

import (
	"slices"
	"strings"
	"testing"
)

// Every key has its line in `vennir help settings`, in the file's order,
// and every line a key: a new setting can't go unexplained.
func TestEverySettingIsExplained(t *testing.T) {
	var described []string
	for _, s := range Settings {
		if s.About == "" {
			t.Errorf("%s: no description", s.Key)
		}
		described = append(described, s.Key)
	}
	if keys := AllKeys(); !slices.Equal(keys, described) {
		for _, k := range keys {
			if !slices.Contains(described, k) {
				t.Errorf("%s isn't described in Settings", k)
			}
		}
		for _, k := range described {
			if !slices.Contains(keys, k) {
				t.Errorf("%s is described but isn't a setting", k)
			}
		}
		if !t.Failed() {
			t.Errorf("Settings isn't in the file's order:\n%v\n%v", keys, described)
		}
	}
}

// Any setting can be set, absent from the file or not; a list is given
// comma-separated; a map of labels, the format's version and an unknown
// key are refused, saying why.
func TestAnySettingCanBeSet(t *testing.T) {
	c := Default("aws")
	c.Vennir = "0.5.2"
	c.AWS = AWS{Profile: "p", Region: "us-east-2"}
	c.Admin.Email = "admin@example.com"
	c.Database.Type = "managed"
	for key, check := range map[string]func(*Config) bool{
		"database.highAvailability=true":         func(c *Config) bool { return c.Database.HighAvailability },
		"chat.off=true":                          func(c *Config) bool { return c.Chat.Off },
		"chat.model=anthropic.claude-sonnet-5-5": func(c *Config) bool { return c.Chat.Model == "anthropic.claude-sonnet-5-5" },
		"gateway.backendHosts=api.example.com, *.run.app": func(c *Config) bool {
			return slices.Equal(c.Gateway.BackendHosts, []string{"api.example.com", "*.run.app"})
		},
		"gateway.backendHosts=": func(c *Config) bool { return len(c.Gateway.BackendHosts) == 0 },
	} {
		k, v, _ := strings.Cut(key, "=")
		got, err := Set(c, k, v)
		if err != nil || !check(got) {
			t.Errorf("set %s: %v, %+v", key, err, got)
		}
	}
	for key, want := range map[string]string{
		"monitoring.ruleLabels": "map of labels",
		"version":               "file's format",
		"database.nope":         "no setting",
		"database":              "no setting",
	} {
		if _, err := Set(c, key, "x"); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("set %s: %v, want %q", key, err, want)
		}
	}
}
