// SPDX-License-Identifier: MIT

// Package config is the gateway's settings, from its environment (the
// console chart's gateway values), checked at startup so a mistake fails
// the rollout, not a request.
package config

import (
	"crypto/ed25519"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"regexp"
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
	// ClusterDomain is the cluster's DNS domain (cluster.local unless it
	// was set up with another): which backend hosts are in the cluster.
	ClusterDomain string
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
		ClusterDomain:            strings.TrimSuffix(or("CLUSTER_DOMAIN", "cluster.local"), "."),
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
	if s.DatabaseIAMAuth != "" && s.DatabaseURL != "" {
		if problem := verifiedTLS(s.DatabaseURL, getenv); problem != "" {
			problems = append(problems, "DATABASE_URL: "+problem)
		}
	}
	if !dnsName.MatchString(s.ClusterDomain) {
		problems = append(problems, fmt.Sprintf("CLUSTER_DOMAIN: a DNS name such as cluster.local, got %q", s.ClusterDomain))
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

// dnsName is a DNS name of lowercase labels, without a trailing dot.
var dnsName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)

// verifiedTLS is why a database URL may not be signed in to with an IAM
// token, or "": the token is the password, a bearer credential for the
// database (and, on AWS, for nothing else; on Google Cloud, an access token
// for the gateway's service account), so it's only sent where the server's
// certificate is checked (sslmode verify-full, or verify-ca: Cloud SQL's
// names the instance, not its address), or to localhost (a Cloud SQL Auth
// Proxy or other connector beside it, which makes its own verified TLS
// connection), a Unix socket included. The kernel's rule too
// (kernel/internal/config).
func verifiedTLS(databaseURL string, getenv func(string) string) string {
	// As pgx reads them: a URL's hosts (several, comma-separated) or its
	// host parameter, a keyword/value string's host, else PGHOST; none is
	// a Unix socket, which is local.
	var hosts, mode string
	rest, ok := strings.CutPrefix(databaseURL, "postgres://")
	if !ok {
		rest, ok = strings.CutPrefix(databaseURL, "postgresql://")
	}
	if ok {
		// Not url.Parse, which can't read several hosts.
		authority, query, _ := strings.Cut(rest, "?")
		authority, _, _ = strings.Cut(authority, "/")
		if at := strings.LastIndex(authority, "@"); at >= 0 {
			authority = authority[at+1:]
		}
		values, err := url.ParseQuery(query)
		if err != nil {
			return "can't be read"
		}
		hosts, mode = authority, values.Get("sslmode")
		if h := values.Get("host"); h != "" {
			hosts = h
		}
	} else {
		mode, hosts = keyword(databaseURL, "sslmode"), keyword(databaseURL, "host")
	}
	if hosts == "" {
		hosts = getenv("PGHOST")
	}
	if mode == "" {
		mode = getenv("PGSSLMODE")
	}
	local := true
	for _, host := range strings.Split(hosts, ",") {
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		host = strings.Trim(host, "[]")
		if h, err := url.PathUnescape(host); err == nil {
			host = h
		}
		a, err := netip.ParseAddr(host)
		if !(host == "" || host == "localhost" || strings.HasPrefix(host, "/") || err == nil && a.IsLoopback()) {
			local = false
		}
	}
	if local {
		return ""
	}
	if mode == "verify-full" || mode == "verify-ca" {
		return ""
	}
	if mode == "" {
		mode = "prefer, the default"
	}
	return "with DATABASE_IAM_AUTH, its token is sent only over TLS that checks the server's certificate: sslmode=verify-full (or verify-ca) and sslrootcert, unless it connects to localhost (a Cloud SQL Auth Proxy); its sslmode is " + mode
}

// keyword is a keyword/value connection string's value for key, or "".
func keyword(dsn, key string) string {
	m := regexp.MustCompile(`(?:^|\s)` + key + `\s*=\s*('(?:[^'\\]|\\.)*'|\S*)`).FindStringSubmatch(dsn)
	if m == nil {
		return ""
	}
	return strings.Trim(m[1], "'")
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
