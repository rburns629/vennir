// SPDX-License-Identifier: MIT

package traffic

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Against the console's real, migrated test database (TEST_DATABASE_URL).
func TestCountsAddUpInTheConsolesTable(t *testing.T) {
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
	var teamID, apiID string
	if err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-traffic-' || substr(md5(random()::text), 1, 6)) RETURNING id::text`).Scan(&teamID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM teams WHERE id = $1::uuid`, teamID); err != nil {
			t.Errorf("removing the test's team: %v", err)
		}
	})
	if err := pool.QueryRow(ctx, `INSERT INTO apis (team_id, name, display_name, openapi, backend_url, service_account)
		VALUES ($1::uuid, 'orders', 'Orders', '{}', 'https://x', 'orders-api') RETURNING id::text`, teamID).Scan(&apiID); err != nil {
		t.Fatal(err)
	}
	r := &Recorder{DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	at := time.Date(2026, 10, 22, 12, 30, 15, 0, time.UTC)
	for range 3 {
		r.Record(apiID, "web", "GET /orders/{id}", "forwarded_2xx", at, 20*time.Millisecond)
	}
	r.Record(apiID, "web", "DELETE /orders/1", "blocked", at.Add(10*time.Second), time.Millisecond)
	if err := r.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	r.Record(apiID, "web", "GET /orders/{id}", "forwarded_2xx", at.Add(20*time.Second), 40*time.Millisecond)
	r.Record("00000000-0000-0000-0000-000000000000", "web", "GET /x", "blocked", at, 0) // a deleted API: skipped
	if err := r.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	var ms int64
	if err := pool.QueryRow(ctx, `SELECT count, duration_ms FROM api_traffic WHERE api_id = $1::uuid AND outcome = 'forwarded_2xx'
		AND minute = '2026-10-22T12:30:00Z'`, apiID).Scan(&count, &ms); err != nil || count != 4 || ms != 100 {
		t.Errorf("forwarded: %d in %d ms, %v", count, ms, err)
	}
	var blocked int
	_ = pool.QueryRow(ctx, `SELECT count FROM api_traffic WHERE api_id = $1::uuid AND endpoint = 'DELETE /orders/1'`, apiID).Scan(&blocked)
	if blocked != 1 {
		t.Errorf("blocked: %d", blocked)
	}
}

func TestEndpointsAreTextPostgresTakes(t *testing.T) {
	for in, want := range map[string]string{
		"GET /orders/1":                       "GET /orders/1",
		"GET /\xff":                           "GET /�",
		"GET /a\x00b":                         "GET /a�b",
		"a" + strings.Repeat("é", 80):         "a" + strings.Repeat("é", 79),                      // byte 160 is inside an é: cut before it
		"GET /" + strings.Repeat("\xff/", 52): "GET /" + strings.Repeat("\uFFFD/", 38) + "\uFFFD", // replacements make it longer: cut after
	} {
		if got := text(in); got != want || !utf8.ValidString(got) || len(got) > MaxEndpoint {
			t.Errorf("text(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPendingCountsAreBounded(t *testing.T) {
	r := &Recorder{Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	at := time.Now()
	for i := range MaxPending + 5 {
		r.Record("api", "web", fmt.Sprintf("GET /made-up/%d", i), "not_found", at, 0)
	}
	r.Record("api", "web", "GET /made-up/0", "not_found", at, 0) // one already held still counts
	if len(r.pending) != MaxPending || r.dropped != 5 {
		t.Errorf("held %d, dropped %d", len(r.pending), r.dropped)
	}
	if c := r.pending[key{api: "api", team: "web", endpoint: "GET /made-up/0", outcome: "not_found", minute: at.UTC().Truncate(time.Minute)}]; c.n != 2 {
		t.Errorf("a held count: %d", c.n)
	}
}

// A caller's path that isn't valid text, and a row Postgres refuses, don't
// stop the rest being recorded, then or at the next flush.
func TestABadRowDoesntStopTheRest(t *testing.T) {
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
	var teamID, apiID string
	if err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-traffic-' || substr(md5(random()::text), 1, 6)) RETURNING id::text`).Scan(&teamID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM teams WHERE id = $1::uuid`, teamID); err != nil {
			t.Errorf("removing the test's team: %v", err)
		}
	})
	if err := pool.QueryRow(ctx, `INSERT INTO apis (team_id, name, display_name, openapi, backend_url, service_account)
		VALUES ($1::uuid, 'orders', 'Orders', '{}', 'https://x', 'orders-api') RETURNING id::text`, teamID).Scan(&apiID); err != nil {
		t.Fatal(err)
	}
	r := &Recorder{DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	at := time.Date(2026, 10, 22, 12, 30, 0, 0, time.UTC)
	r.Record(apiID, "web", "GET /orders/\xff\x00", "not_found", at, 0)
	r.Record(apiID, "web", "GET /orders/{id}", "forwarded_2xx", at, 0)
	// One Postgres refuses (its count overflows the stored one's), and one
	// pgx can't send: both dropped, in their savepoints, the rest written.
	if _, err := pool.Exec(ctx, `INSERT INTO api_traffic (api_id, minute, team, endpoint, outcome, count, duration_ms)
		VALUES ($1::uuid, $2, 'web', 'GET /full', 'blocked', 2147483600, 0)`, apiID, at); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	r.pending[key{api: apiID, team: "web", endpoint: "GET /full", outcome: "blocked", minute: at}] = counts{n: 100}
	r.pending[key{api: apiID, team: "web", endpoint: "GET /too-many", outcome: "blocked", minute: at}] = counts{n: 1 << 40}
	r.mu.Unlock()
	if err := r.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if len(r.pending) != 0 {
		t.Errorf("still pending: %v", r.pending)
	}
	rows, err := pool.Query(ctx, `SELECT endpoint FROM api_traffic WHERE api_id = $1::uuid ORDER BY endpoint`, apiID)
	if err != nil {
		t.Fatal(err)
	}
	endpoints, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"GET /full", "GET /orders/{id}", "GET /orders/��"}; fmt.Sprint(endpoints) != fmt.Sprint(want) {
		t.Errorf("recorded %q, want %q", endpoints, want)
	}
}

// A grant's last call is written at the next flush, then not again within
// GrantUseResolution, and never made earlier (another replica's later one
// stands); a deleted grant's is skipped, and one Postgres refuses dropped.
func TestAGrantsLastCallIsWritten(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgresql://postgres@localhost/execution_console_test"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var teamID, grantID string
	if err := pool.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-grant-' || substr(md5(random()::text), 1, 6)) RETURNING id::text`).Scan(&teamID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `DELETE FROM teams WHERE id = $1::uuid`, teamID); err != nil {
			t.Errorf("removing the test's team: %v", err)
		}
	})
	if err := pool.QueryRow(ctx, `WITH api AS (INSERT INTO apis (team_id, name, display_name, openapi, backend_url, service_account)
		VALUES ($1::uuid, 'orders', 'Orders', '{}', 'https://x', 'orders-api') RETURNING id)
		INSERT INTO api_grants (api_id, team_id, api_name, group_name) SELECT id, $1::uuid, 'orders', 'eng' FROM api RETURNING id::text`, teamID).Scan(&grantID); err != nil {
		t.Fatal(err)
	}
	lastUsed := func() time.Time {
		var at *time.Time
		if err := pool.QueryRow(ctx, `SELECT last_used_at FROM api_grants WHERE id = $1::uuid`, grantID).Scan(&at); err != nil {
			t.Fatal(err)
		}
		if at == nil {
			return time.Time{}
		}
		return *at
	}
	r := &Recorder{DB: pool, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	first := time.Now().Truncate(time.Microsecond)
	r.Used(grantID, first)
	r.Used(grantID, first.Add(-time.Second)) // an earlier call, flushed with it: the later stands
	r.Used("00000000-0000-0000-0000-000000000000", first)
	r.Used("not-a-uuid", first) // refused by Postgres: dropped, not keeping the rest back
	if err := r.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if got := lastUsed(); !got.Equal(first) {
		t.Fatalf("after the first call: %v, want %v", got, first)
	}
	r.Used(grantID, first.Add(time.Minute))
	if err := r.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if got := lastUsed(); !got.Equal(first) {
		t.Errorf("within %v: rewritten to %v", GrantUseResolution, got)
	}
	// Another replica wrote a later call; this one's earlier isn't written over it.
	later := first.Add(10 * time.Minute)
	if _, err := pool.Exec(ctx, `UPDATE api_grants SET last_used_at = $2 WHERE id = $1::uuid`, grantID, later); err != nil {
		t.Fatal(err)
	}
	r.Used(grantID, first.Add(GrantUseResolution+time.Second))
	if err := r.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if got := lastUsed(); !got.Equal(later) {
		t.Errorf("an earlier call over a later one: %v, want %v", got, later)
	}
}
