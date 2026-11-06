// SPDX-License-Identifier: MIT

package policy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/rburns629/vennir/kernel/internal/domain"
)

// lockKey is any constant no one else uses: one policy process applies a
// release at a time.
const lockKey = 4_170_225_627

// State is the release applied (catalog_policy_state).
type State struct {
	Reference  string
	Digest     string
	ReleasedAt time.Time
	Commit     string
	// Signers is the fingerprint of the signers it was verified against
	// (Signers.Fingerprint).
	Signers   string
	AppliedAt time.Time
	APIs      []API
}

// ErrOlder is a release made before the one applied: never applied.
type ErrOlder struct {
	Release, Applied time.Time
}

func (e ErrOlder) Error() string {
	return fmt.Sprintf("it was made %s, before the one applied (%s)", e.Release.Format(time.RFC3339), e.Applied.Format(time.RFC3339))
}

// DB is the kernel's database: a pool, or (in tests) a transaction.
type DB interface {
	Begin(ctx context.Context) (pgx.Tx, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Store is what the kernel's database holds of the catalog's releases.
type Store struct {
	DB DB
}

// State is the release applied; nil before one has been.
func (s *Store) State(ctx context.Context) (*State, error) {
	var st State
	var apis []byte
	err := s.DB.QueryRow(ctx, `SELECT release_reference, release_digest, released_at, commit, signers, applied_at, apis
		FROM catalog_policy_state WHERE id = 1`).Scan(&st.Reference, &st.Digest, &st.ReleasedAt, &st.Commit, &st.Signers, &st.AppliedAt, &apis)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(apis, &st.APIs); err != nil {
		return nil, fmt.Errorf("catalog_policy_state.apis: %w", err)
	}
	return &st, nil
}

// Apply records a verified release as the one applied: its product
// releases named now, every other one released until now (if it wasn't
// already), and its APIs. false when another process holds the lock;
// ErrOlder, under the lock, when the one applied is newer (another
// process applied it meanwhile).
func (s *Store) Apply(ctx context.Context, st State, releases []Release) (bool, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, int64(lockKey)).Scan(&locked); err != nil {
		return false, err
	}
	if !locked {
		return false, nil
	}
	var applied time.Time
	err = tx.QueryRow(ctx, `SELECT released_at FROM catalog_policy_state WHERE id = 1`).Scan(&applied)
	switch {
	case err == nil && st.ReleasedAt.Before(applied):
		return false, ErrOlder{Release: st.ReleasedAt, Applied: applied}
	case err != nil && !errors.Is(err, pgx.ErrNoRows):
		return false, err
	}
	apis, err := json.Marshal(st.APIs)
	if err != nil {
		return false, err
	}
	if st.APIs == nil {
		apis = []byte("[]")
	}
	if _, err := tx.Exec(ctx, `UPDATE catalog_policy_releases SET released_until = now() WHERE released_until IS NULL`); err != nil {
		return false, err
	}
	for _, r := range releases {
		if _, err := tx.Exec(ctx, `INSERT INTO catalog_policy_releases
			(digest, team, repository, action, service_account, audiences, released_until) VALUES ($1, $2, $3, $4, $5, $6, NULL)
			ON CONFLICT (digest, team, repository, action, service_account, audiences) DO UPDATE SET released_until = NULL`,
			r.Digest, r.Team, r.Repository, r.Action, r.ServiceAccount, r.Audiences); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO catalog_policy_state (id, release_reference, release_digest, released_at, commit, signers, applied_at, apis)
		VALUES (1, $1, $2, $3, $4, $6, now(), $5)
		ON CONFLICT (id) DO UPDATE SET release_reference = $1, release_digest = $2, released_at = $3, commit = $4,
			signers = $6, applied_at = now(), apis = $5`, st.Reference, st.Digest, st.ReleasedAt, st.Commit, apis, st.Signers); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// Reverified records that the release applied, digest, was verified
// again against the signers trusted now (their fingerprint).
func (s *Store) Reverified(ctx context.Context, digest, signers string) error {
	_, err := s.DB.Exec(ctx, `UPDATE catalog_policy_state SET signers = $2 WHERE id = 1 AND release_digest = $1`, digest, signers)
	return err
}

// Now is the database's time, which released_until is in.
func (s *Store) Now(ctx context.Context) (time.Time, error) {
	var now time.Time
	err := s.DB.QueryRow(ctx, `SELECT now()`).Scan(&now)
	return now, err
}

// Releases are every product release recorded.
func (s *Store) Releases(ctx context.Context) ([]Release, error) {
	rows, err := s.DB.Query(ctx, `SELECT digest, team, repository, action, service_account, audiences, released_until
		FROM catalog_policy_releases`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Release, error) {
		var r Release
		err := row.Scan(&r.Digest, &r.Team, &r.Repository, &r.Action, &r.ServiceAccount, &r.Audiences, &r.ReleasedUntil)
		return r, err
	})
}

// unfinished are the states a task may still run in (or run again).
var unfinished = []string{string(domain.TaskBlocked), string(domain.TaskReady), string(domain.TaskAwaitingApproval),
	string(domain.TaskClaimed), string(domain.TaskRunning)}

// InUse are the releases unfinished tasks run, as the policy matches them.
func (s *Store) InUse(ctx context.Context) (map[Use]bool, error) {
	rows, err := s.DB.Query(ctx, `SELECT DISTINCT image, team, action, service_account FROM execution_tasks
		WHERE state = ANY($1)`, unfinished)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	uses := map[Use]bool{}
	for rows.Next() {
		var image, team, action, serviceAccount string
		if err := rows.Scan(&image, &team, &action, &serviceAccount); err != nil {
			return nil, err
		}
		if use, ok := UseOf(image, team, action, serviceAccount); ok {
			uses[use] = true
		}
	}
	return uses, rows.Err()
}

// Prune forgets the releases no longer listed: released over grace ago,
// and run by no unfinished task. Returns how many.
func (s *Store) Prune(ctx context.Context, releases []Release, inUse map[Use]bool, now time.Time, grace time.Duration) (int, error) {
	pruned := 0
	for _, r := range releases {
		use := Use{Digest: r.Digest, Team: r.Team, Repository: r.Repository, Action: r.Action, ServiceAccount: r.ServiceAccount}
		if r.ReleasedUntil == nil || now.Sub(*r.ReleasedUntil) < grace || inUse[use] {
			continue
		}
		tag, err := s.DB.Exec(ctx, `DELETE FROM catalog_policy_releases WHERE digest = $1 AND team = $2 AND repository = $3
			AND action = $4 AND service_account = $5 AND audiences = $6 AND released_until IS NOT NULL AND released_until < $7`,
			r.Digest, r.Team, r.Repository, r.Action, r.ServiceAccount, r.Audiences, now.Add(-grace))
		if err != nil {
			return pruned, err
		}
		pruned += int(tag.RowsAffected())
	}
	return pruned, nil
}
