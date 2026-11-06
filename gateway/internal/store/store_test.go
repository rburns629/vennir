// SPDX-License-Identifier: MIT

package store

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/url"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestARequestIsNamedByTheOperationItMatched(t *testing.T) {
	a := &API{Endpoints: endpoints([]byte(`{"paths": {
		"/orders/{orderId}": {"get": {}, "parameters": []},
		"/orders": {"post": {}},
		"/a.b/{x}/refunds": {"put": {}}}}`))}
	for _, tc := range []struct{ method, path, want string }{
		{"GET", "/orders/ord_1", "GET /orders/{orderId}"},
		{"GET", "/orders/ord_1/", "GET /orders/{orderId}"},
		{"POST", "/orders", "POST /orders"},
		{"PUT", "/a.b/7/refunds", "PUT /a.b/{x}/refunds"},
		{"PUT", "/aXb/7/refunds", ""},
		{"DELETE", "/orders/1", ""},
		{"GET", "/orders/1/2", ""},
	} {
		if got := a.Match(tc.method, tc.path); got != tc.want {
			t.Errorf("%s %s: %q, want %q", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestBackendHosts(t *testing.T) {
	u, _ := url.Parse("https://orders-7xk2.a.run.app/v1")
	for hosts, want := range map[string]bool{"*.a.run.app": true, "orders-7xk2.a.run.app": true, "*.run.app.evil": false, "a.run.app": false} {
		if got := BackendAllowed(u, []string{hosts}); got != want {
			t.Errorf("%s: %v", hosts, got)
		}
	}
}

// Against the console's real, migrated test database (TEST_DATABASE_URL):
// what the API's page reads.
func TestWhyAnAPICantBeServedIsRecordedUntilItCan(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgresql://postgres@localhost/execution_console_test"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	// Closed after the cleanups below (they run last-in, first-out): a
	// deferred Close runs first, and they'd find it closed.
	t.Cleanup(pool.Close)
	var teamID, team, apiID string
	if err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-store-' || substr(md5(random()::text), 1, 6)) RETURNING id::text, name`).Scan(&teamID, &team); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM teams WHERE id = $1::uuid`, teamID); err != nil {
			t.Errorf("removing the test's team: %v", err)
		}
	})
	broken := `{"openapi": "3.1.0", "info": {"title": "Orders", "version": "1"}, "paths": {"/orders": {"get": {"responses": {"200": {"description": "ok",
		"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Missing"}}}}}}}}}`
	if err := pool.QueryRow(ctx, `INSERT INTO apis (team_id, name, display_name, openapi, backend_url, service_account)
		VALUES ($1::uuid, 'orders', 'Orders', $2::jsonb, 'https://x', 'orders-api') RETURNING id::text`, teamID, broken).Scan(&apiID); err != nil {
		t.Fatal(err)
	}
	problem := func() (string, bool) {
		var p string
		err := pool.QueryRow(ctx, `SELECT problem FROM api_problems WHERE api_id = $1::uuid`, apiID).Scan(&p)
		return p, err == nil
	}

	s := &Store{DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := s.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	served := s.Get(team, "orders")
	if served == nil || served.Problem == "" {
		t.Fatalf("the broken spec should be a problem: %+v", served)
	}
	if p, ok := problem(); !ok || p != served.Problem {
		t.Errorf("recorded %q (%v), want %q", p, ok, served.Problem)
	}

	// A release fixes it: the row goes.
	if _, err := pool.Exec(ctx, `UPDATE apis SET openapi = '{"openapi": "3.1.0", "info": {"title": "Orders", "version": "2"}, "paths": {}}', updated_at = now() WHERE id = $1::uuid`, apiID); err != nil {
		t.Fatal(err)
	}
	if err := s.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if p, ok := problem(); ok {
		t.Errorf("still recorded once it builds: %q", p)
	}
}

// Each API's active grants are read whole at every refresh, so one revoked
// stops counting at the next (decision 26), its API's row unchanged.
func TestGrantsAreReadEachRefresh(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgresql://postgres@localhost/execution_console_test"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var teamID, apiID, userID string
	if err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-grants-' || substr(md5(random()::text), 1, 6)) RETURNING id::text`).Scan(&teamID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `INSERT INTO users (email) VALUES ('gw-grants-' || gen_random_uuid() || '@example.com') RETURNING id::text`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM teams WHERE id = $1::uuid`, teamID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1::uuid`, userID)
	})
	if err := pool.QueryRow(ctx, `INSERT INTO apis (team_id, name, display_name, openapi, backend_url, service_account)
		VALUES ($1::uuid, 'orders', 'Orders', '{"openapi": "3.1.0", "info": {"title": "O", "version": "1"}, "paths": {}}', 'https://x', 'orders-api')
		RETURNING id::text`, teamID).Scan(&apiID); err != nil {
		t.Fatal(err)
	}
	var userGrant string
	if err := pool.QueryRow(ctx, `INSERT INTO api_grants (api_id, team_id, api_name, user_id, per_minute) VALUES ($1::uuid, $3::uuid, 'orders', $2::uuid, 7) RETURNING id::text`, apiID, userID, teamID).Scan(&userGrant); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO api_grants (api_id, team_id, api_name, group_name) VALUES ($1::uuid, $2::uuid, 'orders', 'eng@example.com')`, apiID, teamID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO api_grants (api_id, team_id, api_name, group_name, revoked_at) VALUES ($1::uuid, $2::uuid, 'orders', 'gone@example.com', now())`, apiID, teamID); err != nil {
		t.Fatal(err)
	}
	// One kept for an API out of the release (no api_id): it lets nobody in.
	if _, err := pool.Exec(ctx, `INSERT INTO api_grants (team_id, api_name, group_name) VALUES ($1::uuid, 'ledger', 'away@example.com')`, teamID); err != nil {
		t.Fatal(err)
	}
	s := &Store{DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := s.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	got := s.Grants(apiID)
	slices.SortFunc(got, func(a, b Grant) int { return strings.Compare(a.Group, b.Group) })
	if len(got) != 2 || got[0] != (Grant{ID: userGrant, UserID: userID, PerMinute: 7}) || got[1].Group != "eng@example.com" || got[1].PerMinute != 0 {
		t.Fatalf("grants = %+v", got)
	}
	if _, err := pool.Exec(ctx, `UPDATE api_grants SET revoked_at = now() WHERE id = $1::uuid`, userGrant); err != nil {
		t.Fatal(err)
	}
	if err := s.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if got := s.Grants(apiID); len(got) != 1 || got[0].Group != "eng@example.com" {
		t.Errorf("after revoking, grants = %+v", got)
	}
}

// Backend credential settings or limits that don't decode are a problem,
// never "none": forwarding without the backend's credential, or the API's
// limits, isn't what its team set up.
func TestSettingsThatDontDecodeAreAProblem(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgresql://postgres@localhost/execution_console_test"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	// Closed after the cleanups below (they run last-in, first-out): a
	// deferred Close runs first, and they'd find it closed.
	t.Cleanup(pool.Close)
	var teamID, team string
	if err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-store-' || substr(md5(random()::text), 1, 6)) RETURNING id::text, name`).Scan(&teamID, &team); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM teams WHERE id = $1::uuid`, teamID); err != nil {
			t.Errorf("removing the test's team: %v", err)
		}
	})
	spec := `{"openapi": "3.1.0", "info": {"title": "Orders", "version": "1"}, "paths": {}}`
	for name, c := range map[string]struct{ auth, perMinute, want string }{
		"auth":   {`{"serviceAccountToken": {"audience": 7}}`, `{}`, "its backend credential settings can't be read"},
		"limits": {`{}`, `{"default": "lots"}`, "its rate limits can't be read"},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO apis (team_id, name, display_name, openapi, backend_url, service_account, backend_auth, per_minute)
			VALUES ($1::uuid, $2, $2, $3::jsonb, 'https://x', 'orders-api', $4::jsonb, $5::jsonb)`, teamID, name, spec, c.auth, c.perMinute); err != nil {
			t.Fatal(err)
		}
		s := &Store{DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
		if err := s.Refresh(ctx); err != nil {
			t.Fatal(err)
		}
		if got := s.Get(team, name); got == nil || got.Problem != c.want || got.Validator != nil {
			t.Errorf("%s: %+v, want the problem %q and no validator", name, got, c.want)
		}
	}
}

// A backend still in its team's own namespace is logged once a refresh,
// changed or not, never per request; a team named for another's API
// backends' namespace makes it that team's.
func TestABackendInItsTeamsNamespaceIsLoggedEachRefresh(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgresql://postgres@localhost/execution_console_test"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var teamID, team string
	if err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-ns-' || substr(md5(random()::text), 1, 6)) RETURNING id::text, name`).Scan(&teamID, &team); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM teams WHERE id = $1::uuid OR name = $2`, teamID, APINamespace(team)); err != nil {
			t.Errorf("removing the test's teams: %v", err)
		}
	})
	spec := `{"openapi": "3.1.0", "info": {"title": "Orders", "version": "1"}, "paths": {}}`
	for name, backend := range map[string]string{
		"unmoved": "http://orders." + team + ".svc.cluster.local",
		"moved":   "http://orders." + APINamespace(team) + ".svc.cluster.local",
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO apis (team_id, name, display_name, openapi, backend_url, service_account)
			VALUES ($1::uuid, $2, $2, $3::jsonb, $4, 'orders-api')`, teamID, name, spec, backend); err != nil {
			t.Fatal(err)
		}
	}
	var logged bytes.Buffer
	s := &Store{DB: pool, Log: slog.New(slog.NewJSONHandler(&logged, nil))}
	warnings := func() []string {
		var apis []string
		for _, line := range strings.Split(strings.TrimSpace(logged.String()), "\n") {
			var entry struct{ Event, API string }
			if json.Unmarshal([]byte(line), &entry) == nil && entry.Event == "api_backend_in_team_namespace" {
				apis = append(apis, entry.API)
			}
		}
		logged.Reset()
		return apis
	}
	for range 2 {
		if err := s.Refresh(ctx); err != nil {
			t.Fatal(err)
		}
		if got := warnings(); !slices.Equal(got, []string{team + "/unmoved"}) {
			t.Errorf("warned of %v, want only %s/unmoved", got, team)
		}
	}
	if got := s.Get(team, "moved"); got == nil || got.APINamespaceTaken {
		t.Fatalf("moved: %+v", got)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO teams (name) VALUES ($1)`, APINamespace(team)); err != nil {
		t.Fatal(err)
	}
	if err := s.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if got := s.Get(team, "moved"); got == nil || !got.APINamespaceTaken || BackendPlace(got.BackendURL, team, got.APINamespaceTaken, "") != BackendElsewhere {
		t.Errorf("a team named %s: %+v", APINamespace(team), got)
	}
}

// A team's backend runs in its API backends' namespace, or for one release
// its own; anywhere else in the cluster is another team's.
func TestBackendPlace(t *testing.T) {
	for _, c := range []struct {
		backend string
		taken   bool
		want    string
	}{
		{"http://orders.payments-apis.svc.cluster.local:8080", false, BackendInAPIs},
		{"http://orders.payments-apis.svc", false, BackendInAPIs},
		{"http://orders.payments.svc.cluster.local", false, BackendInTeam},
		{"http://orders.payments.svc.cluster.local", true, BackendInTeam},
		{"http://orders.payments-apis.svc.cluster.local", true, BackendElsewhere},
		{"http://orders.web.svc.cluster.local", false, BackendElsewhere},
		{"http://orders.web-apis.svc.cluster.local", false, BackendElsewhere},
		{"http://orders.payments-apis-apis.svc.cluster.local", false, BackendElsewhere},
		{"https://orders.example.run.app", false, BackendOutside},
	} {
		u, err := url.Parse(c.backend)
		if err != nil {
			t.Fatal(err)
		}
		if got := BackendPlace(u, "payments", c.taken, ""); got != c.want {
			t.Errorf("BackendPlace(%s, taken %v) = %q, want %q", c.backend, c.taken, got, c.want)
		}
	}
}

// The hosts a backend may have, for the team payments: the namespace each
// names, whether it's in the cluster, and so where it runs. The console's
// test/apis.test.ts has the same table (backendHosts), kept in step.
var backendHostTable = []struct {
	backend, domain string
	namespace       string
	inCluster       bool
	place           string
}{
	// Services, with and without the cluster's domain.
	{"http://orders.payments-apis.svc.cluster.local:8080", "", "payments-apis", true, BackendInAPIs},
	{"http://orders.payments-apis.svc", "", "payments-apis", true, BackendInAPIs},
	{"http://ORDERS.Payments-Apis.svc.cluster.local.", "", "payments-apis", true, BackendInAPIs},
	{"http://orders.payments.svc.cluster.local", "", "payments", true, BackendInTeam},
	{"http://orders.web.svc.cluster.local", "", "web", true, BackendElsewhere},
	// A headless Service's Pods, and Pods.
	{"http://pod-1.orders.web.svc.cluster.local", "", "web", true, BackendElsewhere},
	{"http://pod-1.orders.payments-apis.svc", "", "payments-apis", true, BackendInAPIs},
	// A Pod's name is its address: cluster DNS answers it whatever
	// namespace it says, so it names none, and is held.
	{"http://10-1-2-3.web.pod.cluster.local", "", "", true, BackendElsewhere},
	{"http://10-1-2-3.payments-apis.pod", "", "", true, BackendElsewhere},
	{"http://10-1-2-3.payments-apis.pod.cluster.local", "", "", true, BackendElsewhere},
	// A cluster with a domain of its own, where cluster.local is still read
	// as the cluster's; on one without, that domain is a name outside.
	{"http://orders.web.svc.corp.internal", "corp.internal", "web", true, BackendElsewhere},
	{"http://orders.payments-apis.svc.corp.internal", "corp.internal", "payments-apis", true, BackendInAPIs},
	{"http://orders.web.svc.cluster.local", "corp.internal", "web", true, BackendElsewhere},
	{"http://foo.corp.internal", "corp.internal", "", true, BackendElsewhere},
	{"http://orders.web.svc.corp.internal", "", "", false, BackendOutside},
	// In the cluster, naming no namespace: held.
	{"http://orders.svc.cluster.local", "", "", true, BackendElsewhere},
	{"http://cluster.local", "", "", true, BackendElsewhere},
	{"http://a.b.orders.web.svc.cluster.local", "", "", true, BackendElsewhere},
	{"http://orders.pod", "", "", true, BackendElsewhere},
	{"http://10.96.0.10:8080", "", "", true, BackendElsewhere},
	{"http://[fd00::1]:8080", "", "", true, BackendElsewhere},
	{"http://[::ffff:10.96.0.10]", "", "", true, BackendElsewhere},
	{"http://[::ffff:127.0.0.1]", "", "", true, BackendElsewhere},
	{"http://orders:8080", "", "", true, BackendElsewhere},
	// The gateway's own Pod, and names outside (looked up as absolute
	// names, so orders.web is never orders.web.svc).
	{"http://127.0.0.1:8080", "", "", false, BackendOutside},
	{"http://[::1]:8080", "", "", false, BackendOutside},
	{"http://localhost:8080", "", "", false, BackendOutside},
	{"http://orders.web", "", "", false, BackendOutside},
	{"https://api.example.com", "", "", false, BackendOutside},
	{"https://svc.example.com", "", "", false, BackendOutside},
}

// A host that names a namespace yields it; one in the cluster that names
// none is held, never outside.
func TestBackendNamespace(t *testing.T) {
	for _, c := range backendHostTable {
		u, err := url.Parse(c.backend)
		if err != nil {
			t.Fatal(err)
		}
		if ns, in := BackendNamespace(u, c.domain); ns != c.namespace || in != c.inCluster {
			t.Errorf("BackendNamespace(%s, %q) = %q, %v; want %q, %v", c.backend, c.domain, ns, in, c.namespace, c.inCluster)
		}
		if got := BackendPlace(u, "payments", false, c.domain); got != c.place {
			t.Errorf("BackendPlace(%s, %q) = %q, want %q", c.backend, c.domain, got, c.place)
		}
	}
}

// What's looked up is what was read: a Service's or Pod's short form with
// the cluster's domain, and every name absolute.
func TestDialHost(t *testing.T) {
	for _, c := range []struct{ host, domain, want string }{
		{"orders.payments-apis.svc", "", "orders.payments-apis.svc.cluster.local."},
		{"orders.payments-apis.svc", "corp.internal", "orders.payments-apis.svc.corp.internal."},
		{"10-1-2-3.payments-apis.pod.", "", "10-1-2-3.payments-apis.pod.cluster.local."},
		{"orders.payments-apis.svc.cluster.local", "", "orders.payments-apis.svc.cluster.local."},
		{"orders.web", "", "orders.web."},
		{"API.example.com", "", "api.example.com."},
		{"orders", "", "orders."},
		{"localhost", "", "localhost"},
		{"127.0.0.1", "", "127.0.0.1"},
		{"::1", "", "::1"},
	} {
		if got := DialHost(c.host, c.domain); got != c.want {
			t.Errorf("DialHost(%s, %q) = %q, want %q", c.host, c.domain, got, c.want)
		}
	}
}
