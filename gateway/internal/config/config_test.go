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

// An IAM token is the database password: it's sent only where the server's
// certificate is checked, or to a connector beside the gateway.
func TestIAMSignInNeedsVerifiedTLS(t *testing.T) {
	seed := filepath.Join(t.TempDir(), "seed")
	if err := os.WriteFile(seed, []byte(strings.Repeat("s", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	for databaseURL, ok := range map[string]bool{
		"postgresql://gw@10.0.0.5:5432/console":                                              false,
		"postgresql://gw@10.0.0.5:5432/console?sslmode=require":                              false,
		"postgresql://gw@10.0.0.5:5432/console?sslmode=prefer":                               false,
		"postgresql://gw@db.example.com/console?sslmode=verify-full&sslrootcert=/etc/ca.crt": true,
		"postgresql://gw@10.0.0.5:5432/console?sslmode=verify-ca&sslrootcert=/etc/ca.crt":    true,
		"postgresql://gw@10.0.0.5:5432,10.0.0.6:5432/console?sslmode=verify-full":            true,
		"postgresql://gw@localhost:5432,10.0.0.6:5432/console?sslmode=disable":               false,
		"postgresql://gw@localhost/console?host=10.0.0.5":                                    false,
		"host=10.0.0.5 user=gw dbname=console sslmode=require":                               false,
		"host=10.0.0.5 user=gw dbname=console sslmode='verify-full'":                         true,
		"postgresql://gw@localhost:5432/console":                                             true,
		"postgresql://gw@127.0.0.1:5432/console?sslmode=disable":                             true,
		"postgresql://gw@[::1]:5432/console?sslmode=disable":                                 true,
		"postgresql://gw@/console?host=/cloudsql/project:region:instance":                    true,
		"host=localhost user=gw dbname=console":                                              true,
	} {
		env := map[string]string{"DATABASE_URL": databaseURL, "DATABASE_IAM_AUTH": "gcp", "CONSOLE_URL": "http://console", "GATEWAY_ISSUER": "http://gw", "SIGNING_KEY_FILE": seed}
		_, err := Load(func(name string) string { return env[name] })
		if ok != (err == nil) || err != nil && !strings.Contains(err.Error(), "sslmode=verify-full") {
			t.Errorf("%s: %v", databaseURL, err)
		}
		if err != nil && strings.Contains(err.Error(), "10.0.0.5") {
			t.Errorf("the error names the URL: %v", err)
		}
		// Without IAM sign-in, a password's URL is its own business.
		delete(env, "DATABASE_IAM_AUTH")
		if _, err := Load(func(name string) string { return env[name] }); err != nil {
			t.Errorf("%s, no IAM: %v", databaseURL, err)
		}
	}
	// PGSSLMODE counts where the URL says nothing, as pgx reads it.
	env := map[string]string{"DATABASE_URL": "postgresql://gw@10.0.0.5/console", "DATABASE_IAM_AUTH": "aws", "DATABASE_IAM_REGION": "us-east-2",
		"PGSSLMODE": "verify-full", "CONSOLE_URL": "http://console", "GATEWAY_ISSUER": "http://gw", "SIGNING_KEY_FILE": seed}
	if _, err := Load(func(name string) string { return env[name] }); err != nil {
		t.Errorf("PGSSLMODE=verify-full: %v", err)
	}
}

func TestTheClusterDomain(t *testing.T) {
	seed := filepath.Join(t.TempDir(), "seed")
	if err := os.WriteFile(seed, []byte(strings.Repeat("s", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"DATABASE_URL": "postgres://x", "CONSOLE_URL": "http://console", "GATEWAY_ISSUER": "http://gw", "SIGNING_KEY_FILE": seed}
	getenv := func(name string) string { return env[name] }
	if s, err := Load(getenv); err != nil || s.ClusterDomain != "cluster.local" {
		t.Fatalf("the default: %+v, %v", s, err)
	}
	env["CLUSTER_DOMAIN"] = "corp.internal."
	if s, err := Load(getenv); err != nil || s.ClusterDomain != "corp.internal" {
		t.Errorf("one of its own: %+v, %v", s, err)
	}
	for _, bad := range []string{"Corp.Internal", "corp..internal", "*.corp", "corp internal"} {
		env["CLUSTER_DOMAIN"] = bad
		if _, err := Load(getenv); err == nil || !strings.Contains(err.Error(), "CLUSTER_DOMAIN") {
			t.Errorf("%q: %v", bad, err)
		}
	}
}
