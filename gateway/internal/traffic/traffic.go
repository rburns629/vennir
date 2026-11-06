// SPDX-License-Identifier: MIT

// Package traffic counts what the gateway did with each API's requests, a
// minute at a time, by calling team, endpoint and outcome, and adds the
// counts to the console's api_traffic table every so often (the API's page
// shows them). No caller's identity, body or header is kept. With them goes
// when each grant (api_grants) was last called through, so the API's team
// can revoke the ones nobody uses.
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

// GrantUseResolution is how stale a grant's last_used_at may get before a
// call through it is written again (an API token's is the same,
// auth.tokenUseResolution).
const GrantUseResolution = 5 * time.Minute

// Recorder holds counts until they're flushed.
type Recorder struct {
	DB interface {
		Begin(context.Context) (pgx.Tx, error)
	}
	Log *slog.Logger

	mu      sync.Mutex
	pending map[key]counts
	dropped int
	// used is each grant's latest call not yet written, by its id; written,
	// when its last one was, so it's written once a GrantUseResolution.
	used, written map[string]time.Time
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

// Used notes a call let in through a grant, by its id.
func (r *Recorder) Used(grantID string, at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if w, ok := r.written[grantID]; ok && at.Sub(w) < GrantUseResolution {
		return
	}
	r.use(grantID, at)
}

// use holds at as grantID's latest call, unless that's a new one past
// MaxPending (grants are the console's, not made up by callers, so only a
// database away for long gets there). r.mu is held.
func (r *Recorder) use(grantID string, at time.Time) {
	if r.used == nil {
		r.used = map[string]time.Time{}
	}
	prev, held := r.used[grantID]
	if !held && len(r.used) >= MaxPending {
		return
	}
	if at.After(prev) {
		r.used[grantID] = at
	}
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

// Flush adds what's pending to api_traffic, and grants' last calls to
// api_grants, in one transaction; what can't be written stays pending for
// the next flush.
func (r *Recorder) Flush(ctx context.Context) error {
	r.mu.Lock()
	batch, used := r.pending, r.used
	r.pending, r.used = nil, nil
	dropped := r.dropped
	r.dropped = 0
	r.mu.Unlock()
	if dropped > 0 {
		r.Log.Warn("traffic not recorded: too many different counts at once", "requests", dropped, "max", MaxPending)
	}
	if len(batch) == 0 && len(used) == 0 {
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
		for id, at := range used {
			// As a count is: in a savepoint, kept or given up on by retry.
			// Never earlier than what another replica wrote; a grant
			// deleted meanwhile has no row, and is skipped.
			err := pgx.BeginFunc(ctx, tx, func(row pgx.Tx) error {
				_, err := row.Exec(ctx, `UPDATE api_grants SET last_used_at = $2
					WHERE id = $1::uuid AND (last_used_at IS NULL OR last_used_at < $2)`, id, at)
				return err
			})
			if err == nil {
				continue
			}
			if retry(ctx, tx, err) {
				return err
			}
			r.Log.Warn("a grant's last call refused; dropped", "grant", id, "error", err)
		}
		return nil
	})
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		for k, c := range batch {
			r.add(k, c)
		}
		for id, at := range used {
			r.use(id, at)
		}
		return err
	}
	if r.written == nil {
		r.written = map[string]time.Time{}
	}
	for id, at := range used {
		r.written[id] = at
	}
	// What's past the resolution is written again at its next call anyway.
	for id, w := range r.written {
		if time.Since(w) >= GrantUseResolution {
			delete(r.written, id)
		}
	}
	return nil
}

// retry: whether a row's error says to try the whole flush again later,
// rather than that this row can't be written. A row is given up on only when
// Postgres refuses its data (a data exception, an integrity violation, the
// statement cancelled) or pgx can't send it; anything else (the connection
// or context gone, the transaction aborted or read-only, a deadlock,
// permissions) is kept for the next flush.
func retry(ctx context.Context, tx pgx.Tx, err error) bool {
	if ctx.Err() != nil || tx.Conn().IsClosed() {
		return true
	}
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		return pgconn.SafeToRetry(err) || pgconn.Timeout(err)
	}
	switch {
	case pg.Code[:2] == "22", pg.Code[:2] == "23", pg.Code == "57014":
		return false
	}
	return true
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
