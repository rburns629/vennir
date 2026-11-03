// SPDX-License-Identifier: MIT

// Package traffic counts what the gateway did with each API's requests, a
// minute at a time, by calling team, endpoint and outcome, and adds the
// counts to the console's api_traffic table every so often (the API's page
// shows them). The only thing the gateway writes. No caller's identity,
// body or header is kept.
package traffic

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// MaxEndpoint is the most of a blocked request's "METHOD /path" kept, in bytes.
const MaxEndpoint = 160

// MaxPending is the most distinct counts held between flushes: past it, a
// new one is dropped (and counted) rather than held, so callers making up
// paths, or a database that's away, can't grow the gateway's memory.
const MaxPending = 10000

type key struct {
	api, team, endpoint, outcome string
	minute                       time.Time
}

type counts struct {
	n          int
	durationMs int64
}

// Recorder holds counts until they're flushed.
type Recorder struct {
	DB interface {
		Begin(context.Context) (pgx.Tx, error)
	}
	Log *slog.Logger

	mu      sync.Mutex
	pending map[key]counts
	dropped int
}

// text is endpoint as Postgres takes it: valid UTF-8 with no NUL (a
// caller's path is neither, necessarily), at most MaxEndpoint bytes, cut
// between characters.
func text(endpoint string) string {
	endpoint = strings.ReplaceAll(strings.ToValidUTF8(endpoint, "\uFFFD"), "\x00", "\uFFFD")
	if len(endpoint) <= MaxEndpoint {
		return endpoint
	}
	cut := MaxEndpoint
	for cut > 0 && !utf8.RuneStart(endpoint[cut]) {
		cut--
	}
	return endpoint[:cut]
}

// Record counts one request.
func (r *Recorder) Record(apiID, team, endpoint, outcome string, at time.Time, took time.Duration) {
	k := key{api: apiID, team: team, endpoint: text(endpoint), outcome: outcome, minute: at.UTC().Truncate(time.Minute)}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.add(k, counts{n: 1, durationMs: took.Milliseconds()})
}

// add holds c under k, unless that's a new count past MaxPending. r.mu is held.
func (r *Recorder) add(k key, c counts) {
	if r.pending == nil {
		r.pending = map[key]counts{}
	}
	p, held := r.pending[k]
	if !held && len(r.pending) >= MaxPending {
		r.dropped += c.n
		return
	}
	p.n += c.n
	p.durationMs += c.durationMs
	r.pending[k] = p
}

// Flush adds what's pending to api_traffic, in one transaction; what can't
// be written stays pending for the next flush.
func (r *Recorder) Flush(ctx context.Context) error {
	r.mu.Lock()
	batch := r.pending
	r.pending = nil
	dropped := r.dropped
	r.dropped = 0
	r.mu.Unlock()
	if dropped > 0 {
		r.Log.Warn("traffic not recorded: too many different counts at once", "requests", dropped, "max", MaxPending)
	}
	if len(batch) == 0 {
		return nil
	}
	err := pgx.BeginFunc(ctx, txStarter{r.DB}, func(tx pgx.Tx) error {
		for k, c := range batch {
			// Each in a savepoint: a row Postgres refuses is dropped, not
			// left to fail every flush after it.
			err := pgx.BeginFunc(ctx, tx, func(row pgx.Tx) error {
				// An API deleted meanwhile has no row to count against: skipped.
				_, err := row.Exec(ctx, `INSERT INTO api_traffic (api_id, minute, team, endpoint, outcome, count, duration_ms)
					SELECT $1::uuid, $2, $3, $4, $5, $6, $7 WHERE EXISTS (SELECT 1 FROM apis WHERE id = $1::uuid)
					ON CONFLICT (api_id, minute, team, endpoint, outcome) DO UPDATE
					SET count = api_traffic.count + EXCLUDED.count, duration_ms = api_traffic.duration_ms + EXCLUDED.duration_ms`,
					k.api, k.minute, k.team, k.endpoint, k.outcome, c.n, c.durationMs)
				return err
			})
			if err == nil {
				continue
			}
			if retry(ctx, tx, err) {
				return err
			}
			r.Log.Warn("traffic count refused; dropped", "api", k.api, "outcome", k.outcome, "requests", c.n, "error", err)
		}
		return nil
	})
	if err != nil {
		r.mu.Lock()
		for k, c := range batch {
			r.add(k, c)
		}
		r.mu.Unlock()
	}
	return err
}

// retry: whether a row's error says to try the whole flush again later (the
// connection or the context gone, or Postgres asking for a retry) rather
// than that this row can't be written.
func retry(ctx context.Context, tx pgx.Tx, err error) bool {
	if ctx.Err() != nil || tx.Conn().IsClosed() {
		return true
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		// Connection, transaction rollback (deadlock, serialization),
		// insufficient resources, operator intervention (shutdown).
		switch pg.Code[:2] {
		case "08", "40", "53", "57":
			return true
		}
	}
	return false
}

type txStarter struct {
	db interface {
		Begin(context.Context) (pgx.Tx, error)
	}
}

func (t txStarter) Begin(ctx context.Context) (pgx.Tx, error) { return t.db.Begin(ctx) }

// Run flushes every interval until ctx ends, then once more.
func (r *Recorder) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := r.Flush(flush); err != nil {
				r.Log.Error("couldn't record the last traffic", "error", err)
			}
			cancel()
			return
		case <-t.C:
			if err := r.Flush(ctx); err != nil {
				r.Log.Error("couldn't record traffic; kept for the next try", "error", err)
			}
		}
	}
}
