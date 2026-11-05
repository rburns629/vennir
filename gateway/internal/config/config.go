// SPDX-License-Identifier: MIT

// Package config is the gateway's settings, from its environment (the
// console chart's gateway values), checked at startup so a mistake fails
// the rollout, not a request.
package config

import (
	"crypto/ed25519"
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

// Settings are every setting.
type Settings struct {
	// The console's database, as the gateway's own role: published APIs and
	// who callers are, read; its traffic counts and what it can't serve,
	// written.
	DatabaseURL string
	// Most connections it holds: each request checks who's calling there.
	DatabaseMaxConnections int
	// Longest opening a database connection may take: one opened just as
	// Postgres's Pod is replaced would otherwise wait out TCP's retries.
	DatabaseConnectTimeout time.Duration
	// DatabaseIAMAuth signs in with its own cloud identity, no password:
	// "gcp" (Cloud SQL's IAM database authentication), "aws" (Amazon RDS's,
	// in DatabaseIAMRegion), or "".
	DatabaseIAMAuth, DatabaseIAMRegion string
	// With DatabaseIAMAuth: the Google service account it signs in as, and
	// its own projected ServiceAccount token to federate from (the
	// NetworkPolicy keeps it from the metadata server). Without them, the
	// metadata server's token.
	DatabaseIAMAccount, DatabaseIAMTokenFile string
	// The console, inside the cluster, whose session keys (its JWKS) check
	// sessions as it does.
	ConsoleURL string
	// The console signs people in with single sign-on, so a team may
	// refuse password sessions (teams.require_sso).
	SSO bool
	// SigningKey signs Vennir-Caller; Issuer is the gateway's address, its iss.
	SigningKey ed25519.PrivateKey
	Issuer     string
	// Where it listens: inside the cluster, from the internet (empty: no
	// public listener), and for metrics.
	Listen, PublicListen, MetricsListen string
	BackendHosts, InternetTeams         []string
	// TrustedProxies are the peers (an ingress, a load balancer) whose
	// X-Forwarded-For says who the caller is, on the public listener; from
	// anyone else, and on the in-cluster listener, it's dropped, and the
	// peer is the caller.
	TrustedProxies   []netip.Prefix
	DefaultPerMinute int
	// UnauthenticatedPerMinute is how many requests a minute that don't
	// sign in one client address (the peer, or behind TrustedProxies the
	// address they saw; an IPv6 /64) may make before the gateway refuses its
	// requests, before any database work, until it's under again. 0: no limit.
	UnauthenticatedPerMinute int
	// PublicPeersShared: on the public listener, with no TrustedProxies, a
	// proxy every caller shares (an Ingress) is the peer, so no address is
	// limited there (UnauthenticatedPerMinute): one caller's failures would
	// shut out the rest.
	PublicPeersShared bool
	// BodyReadTimeout is the longest reading a request's body may take.
	BodyReadTimeout time.Duration
	// Minting Google ID tokens: the STS audience API ServiceAccounts'
	// tokens are exchanged for (GKE: the cluster's Workload Identity
	// pool; elsewhere a provider trusting its issuer), and the audience
	// those tokens carry. Empty: googleIdToken APIs fail with 502.
	GCPAudience, GCPTokenAudience string
	Closed                        bool
	Refresh                       time.Duration
}

// Load reads the environment.
func Load(getenv func(string) string) (*Settings, error) {
	var problems []string
	need := func(name string) string {
		v := getenv(name)
		if v == "" {
			problems = append(problems, name+" is required")
		}
		return v
	}
	or := func(name, fallback string) string {
		if v := getenv(name); v != "" {
			return v
		}
		return fallback
	}
	number := func(name string, fallback int) int {
		v := getenv(name)
		if v == "" {
			return fallback
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			problems = append(problems, fmt.Sprintf("%s: a whole number, got %q", name, v))
		}
		return n
	}
	// At least 1: 0 would stop the refresh (a ticker of 0 panics) or refuse
	// every API with no limit of its own (the console counts 0 as unset).
	positive := func(name string, fallback int) int {
		n := number(name, fallback)
		if n == 0 {
			problems = append(problems, fmt.Sprintf("%s: at least 1, got 0", name))
		}
		return n
	}
	s := &Settings{
		DatabaseURL:              need("DATABASE_URL"),
		DatabaseMaxConnections:   number("DATABASE_MAX_CONNECTIONS", 10),
		DatabaseConnectTimeout:   time.Duration(number("DATABASE_CONNECT_TIMEOUT_SECONDS", 10)) * time.Second,
		DatabaseIAMAuth:          getenv("DATABASE_IAM_AUTH"),
		DatabaseIAMRegion:        getenv("DATABASE_IAM_REGION"),
		DatabaseIAMAccount:       getenv("DATABASE_IAM_ACCOUNT"),
		DatabaseIAMTokenFile:     getenv("DATABASE_IAM_TOKEN_FILE"),
		ConsoleURL:               strings.TrimSuffix(need("CONSOLE_URL"), "/"),
		SSO:                      getenv("SSO_ENABLED") == "true",
		Issuer:                   need("GATEWAY_ISSUER"),
		Listen:                   or("LISTEN", ":8080"),
		PublicListen:             getenv("PUBLIC_LISTEN"),
		MetricsListen:            or("METRICS_LISTEN", ":9090"),
		BackendHosts:             list(getenv("BACKEND_HOSTS")),
		InternetTeams:            list(getenv("INTERNET_TEAMS")),
		DefaultPerMinute:         positive("DEFAULT_PER_MINUTE", 600),
		UnauthenticatedPerMinute: number("UNAUTHENTICATED_PER_MINUTE", 60),
		PublicPeersShared:        getenv("PUBLIC_PEERS_SHARED") == "true",
		BodyReadTimeout:          time.Duration(positive("BODY_READ_TIMEOUT_SECONDS", 30)) * time.Second,
		GCPAudience:              getenv("GCP_STS_AUDIENCE"),
		GCPTokenAudience:         getenv("GCP_TOKEN_AUDIENCE"),
		Closed:                   getenv("CLOSED") == "true",
		Refresh:                  time.Duration(positive("REFRESH_SECONDS", 5)) * time.Second,
	}
	for _, item := range list(getenv("TRUSTED_PROXIES")) {
		prefix, err := netip.ParsePrefix(item)
		if err != nil {
			addr, addrErr := netip.ParseAddr(item)
			if addrErr != nil {
				problems = append(problems, fmt.Sprintf("TRUSTED_PROXIES: an address or CIDR range, got %q", item))
				continue
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		s.TrustedProxies = append(s.TrustedProxies, prefix.Masked())
	}
	if (s.DatabaseIAMAccount == "") != (s.DatabaseIAMTokenFile == "") {
		problems = append(problems, "DATABASE_IAM_ACCOUNT and DATABASE_IAM_TOKEN_FILE: both, or neither")
	}
	if s.DatabaseIAMAccount != "" && s.GCPAudience == "" {
		problems = append(problems, "DATABASE_IAM_ACCOUNT: needs GCP_STS_AUDIENCE, what its token is exchanged for")
	}
	switch s.DatabaseIAMAuth {
	case "", "gcp":
	case "aws":
		if s.DatabaseIAMRegion == "" {
			problems = append(problems, "DATABASE_IAM_REGION: needed with DATABASE_IAM_AUTH=aws")
		}
	default:
		problems = append(problems, fmt.Sprintf("DATABASE_IAM_AUTH: gcp, aws, or empty for a password, got %q", s.DatabaseIAMAuth))
	}
	if path := need("SIGNING_KEY_FILE"); path != "" {
		seed, err := os.ReadFile(path)
		seed = []byte(strings.TrimSpace(string(seed)))
		if err != nil || len(seed) != ed25519.SeedSize {
			problems = append(problems, fmt.Sprintf("SIGNING_KEY_FILE: %d bytes of seed, %s", ed25519.SeedSize, path))
		} else {
			s.SigningKey = ed25519.NewKeyFromSeed(seed)
		}
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("the gateway's settings: %s", strings.Join(problems, "; "))
	}
	return s, nil
}

func list(v string) []string {
	var out []string
	for _, item := range strings.Split(v, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}
