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
	// Signers are the signers (Signers.IDs) that verified it.
	Signers   []string
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
// releases named now (verified by st.Signers), every other one released
// until now (if it wasn't already), and its APIs. An earlier release of a
// product at a digest this one names too (same team, repository and
// action), with another ServiceAccount or other audiences than any this one
// names there, goes at once: the release decides what that digest runs as.
// false when another process holds the lock; ErrOlder, under the lock, when
// the one applied is newer and a signer trusted now (trusted) verified it
// (another process applied it meanwhile; one no trusted signer verified
// doesn't hold a newer one back).
func (s *Store) Apply(ctx context.Context, st State, releases []Release, trusted []string) (bool, error) {
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
	var appliedSigners []string
	err = tx.QueryRow(ctx, `SELECT released_at, signers FROM catalog_policy_state WHERE id = 1`).Scan(&applied, &appliedSigners)
	switch {
	case err == nil && TrustedBy(appliedSigners, trusted) && st.ReleasedAt.Before(applied):
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
	// What this release names, at each (digest, team, repository, action):
	// recorded rows there that it doesn't name go, once, before anything is
	// inserted (two of its products may share a digest and an action).
	named := map[[4]string]map[[2]string]bool{}
	for _, r := range releases {
		at := [4]string{r.Digest, r.Team, r.Repository, r.Action}
		if named[at] == nil {
			named[at] = map[[2]string]bool{}
		}
		named[at][[2]string{r.ServiceAccount, r.Audiences}] = true
	}
	recorded, err := tx.Query(ctx, `SELECT digest, team, repository, action, service_account, audiences FROM catalog_policy_releases`)
	if err != nil {
		return false, err
	}
	var gone [][6]string
	for recorded.Next() {
		var row [6]string
		if err := recorded.Scan(&row[0], &row[1], &row[2], &row[3], &row[4], &row[5]); err != nil {
			recorded.Close()
			return false, err
		}
		if names, ok := named[[4]string{row[0], row[1], row[2], row[3]}]; ok && !names[[2]string{row[4], row[5]}] {
			gone = append(gone, row)
		}
	}
	recorded.Close()
	if err := recorded.Err(); err != nil {
		return false, err
	}
	for _, row := range gone {
		if _, err := tx.Exec(ctx, `DELETE FROM catalog_policy_releases WHERE digest = $1 AND team = $2 AND repository = $3
			AND action = $4 AND service_account = $5 AND audiences = $6`, row[0], row[1], row[2], row[3], row[4], row[5]); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE catalog_policy_releases SET released_until = now() WHERE released_until IS NULL`); err != nil {
		return false, err
	}
	for _, r := range releases {
		if _, err := tx.Exec(ctx, `INSERT INTO catalog_policy_releases
			(digest, team, repository, action, service_account, audiences, signers, released_until) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
			ON CONFLICT (digest, team, repository, action, service_account, audiences) DO UPDATE SET released_until = NULL, signers = $7`,
			r.Digest, r.Team, r.Repository, r.Action, r.ServiceAccount, r.Audiences, st.Signers); err != nil {
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

// Reverified records which signers verified the release applied, digest,
// when it was verified again (none of those recorded was trusted any more):
// it and the product releases it names are theirs now. Earlier releases
// keep the signers that verified them, and are listed only while one of
// those is trusted (TrustedReleases).
func (s *Store) Reverified(ctx context.Context, digest string, signers []string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	tag, err := tx.Exec(ctx, `UPDATE catalog_policy_state SET signers = $2 WHERE id = 1 AND release_digest = $1`, digest, signers)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE catalog_policy_releases SET signers = $1 WHERE released_until IS NULL`, signers); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Now is the database's time, which released_until is in.
func (s *Store) Now(ctx context.Context) (time.Time, error) {
	var now time.Time
	err := s.DB.QueryRow(ctx, `SELECT now()`).Scan(&now)
	return now, err
}

// Releases are every product release recorded.
func (s *Store) Releases(ctx context.Context) ([]Release, error) {
	rows, err := s.DB.Query(ctx, `SELECT digest, team, repository, action, service_account, audiences, signers, released_until
		FROM catalog_policy_releases`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Release, error) {
		var r Release
		err := row.Scan(&r.Digest, &r.Team, &r.Repository, &r.Action, &r.ServiceAccount, &r.Audiences, &r.Signers, &r.ReleasedUntil)
		return r, err
	})
}

// unfinished are the states a task may still run in (or run again).
var unfinished = []string{string(domain.TaskBlocked), string(domain.TaskReady), string(domain.TaskAwaitingApproval),
	string(domain.TaskClaimed), string(domain.TaskRunning)}

// InUse are the releases unfinished tasks run, as the policy matches them,
// each with when the earliest execution running it was submitted. An
// execution counts while it's moving: a step of it is claimed or running,
// or one became ready (or began awaiting its approval) within max, which
// is at least the approval timeout. Each step's wait is bounded, not the
// execution's age, so a long DAG or several approval gates keep their
// releases; one stalled longer than max keeps nothing listed.
func (s *Store) InUse(ctx context.Context, max time.Duration) (map[Use]time.Time, error) {
	rows, err := s.DB.Query(ctx, `SELECT t.image, t.team, t.action, t.service_account, min(e.created_at)
		FROM execution_tasks t JOIN executions e ON e.id = t.execution_id
		WHERE t.state = ANY($1) AND t.execution_id IN (
			SELECT execution_id FROM execution_tasks WHERE state = ANY($1) GROUP BY execution_id
			HAVING max(available_at) > now() - make_interval(secs => $2) OR bool_or(state IN ('CLAIMED', 'RUNNING')))
		GROUP BY t.image, t.team, t.action, t.service_account`, unfinished, max.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	uses := map[Use]time.Time{}
	for rows.Next() {
		var image, team, action, serviceAccount string
		var submitted time.Time
		if err := rows.Scan(&image, &team, &action, &serviceAccount, &submitted); err != nil {
			return nil, err
		}
		if use, ok := UseOf(image, team, action, serviceAccount); ok {
			if earlier, seen := uses[use]; !seen || submitted.Before(earlier) {
				uses[use] = submitted
			}
		}
	}
	return uses, rows.Err()
}

// Prune forgets the releases no longer listed (Kept). Returns how many.
func (s *Store) Prune(ctx context.Context, releases []Release, inUse map[Use]time.Time, now time.Time, w Window) (int, error) {
	pruned := 0
	for _, r := range releases {
		if Kept(r, inUse, now, w) {
			continue
		}
		tag, err := s.DB.Exec(ctx, `DELETE FROM catalog_policy_releases WHERE digest = $1 AND team = $2 AND repository = $3
			AND action = $4 AND service_account = $5 AND audiences = $6 AND released_until IS NOT NULL AND released_until < $7`,
			r.Digest, r.Team, r.Repository, r.Action, r.ServiceAccount, r.Audiences, now.Add(-w.Grace))
		if err != nil {
			return pruned, err
		}
		pruned += int(tag.RowsAffected())
	}
	return pruned, nil
}
