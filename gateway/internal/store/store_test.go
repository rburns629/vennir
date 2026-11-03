// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"io"
	"log/slog"
	"net/url"
	"os"
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
	defer pool.Close()
	var teamID, team, apiID string
	if err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-store-' || substr(md5(random()::text), 1, 6)) RETURNING id::text, name`).Scan(&teamID, &team); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM teams WHERE id = $1::uuid`, teamID) })
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
	defer pool.Close()
	var teamID, team string
	if err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-store-' || substr(md5(random()::text), 1, 6)) RETURNING id::text, name`).Scan(&teamID, &team); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM teams WHERE id = $1::uuid`, teamID) })
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

// An in-cluster backend host names its namespace; any other host names none.
func TestBackendNamespace(t *testing.T) {
	for raw, want := range map[string]string{
		"http://orders.team-b.svc.cluster.local:8080":  "team-b",
		"http://orders.team-b.svc:8080":                "team-b",
		"http://ORDERS.Team-B.svc.cluster.local.":      "team-b",
		"http://pod-1.orders.team-b.svc.cluster.local": "team-b",
		"http://orders:8080":                           "",
		"http://orders.svc.cluster.local":              "",
		"https://api.example.com":                      "",
		"https://svc.example.com":                      "",
	} {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := BackendNamespace(u); got != want {
			t.Errorf("BackendNamespace(%s) = %q, want %q", raw, got, want)
		}
	}
}
