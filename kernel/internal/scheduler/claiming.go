// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"errors"
	"maps"
	"slices"
	"time"

	"github.com/roburns/vennir/kernel/internal/domain"
)

// Claiming uses SELECT ... FOR UPDATE SKIP LOCKED, so several schedulers
// poll at once without blocking each other or claiming the same task. It
// doesn't make execution exactly-once: a task can still run twice (a
// scheduler crashes after its Pod acted, and the task is retried).
// Execution is at-least-once; product actions must be idempotent.

// recoverExpiredLeases takes over every CLAIMED or RUNNING task whose lease
// has expired. A RUNNING task already has a Job, so this scheduler adopts
// it (the next poll reads the same Job through its handle); starting it
// again would run every in-flight task twice on each scheduler rollout. A
// CLAIMED task never got a Job, so it goes back to READY. Neither touches
// attempt_count.
func (p *pass) recoverExpiredLeases() (int, error) {
	rows, err := p.db.Query(p.ctx, `SELECT `+taskColumns+` FROM execution_tasks
		WHERE state IN ('CLAIMED', 'RUNNING') AND lease_expires_at < $1 FOR UPDATE SKIP LOCKED`, p.now)
	if err != nil {
		return 0, err
	}
	expired, err := scanTasks(rows)
	if err != nil {
		return 0, err
	}
	for _, t := range expired {
		if t.State == domain.TaskRunning && t.ExecutorHandle != nil {
			p.log.Info("adopting running task from an expired lease", "executionId", t.ExecutionID,
				"taskKey", t.TaskKey, "previousOwner", deref(t.LeaseOwner), "owner", p.opts.Owner)
			t.LeaseOwner = &p.opts.Owner
			t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration))
		} else {
			t.State = domain.TaskReady
			t.LeaseOwner, t.LeaseExpiresAt, t.ExecutorHandle = nil, nil, nil
		}
		if err := saveTask(p.ctx, p.db, t); err != nil {
			return 0, err
		}
	}
	return len(expired), nil
}

// returnUnstartedAttempt hands a claimed task back as if the claim never
// happened (its attempt row and number undone), for a start that raised:
// the next claim gets the same attempt number, and so the same Job name,
// which the executor adopts if that start did create it. The caller sets
// when it may be claimed again.
func (p *pass) returnUnstartedAttempt(t *Task) error {
	if _, err := p.db.Exec(p.ctx, `DELETE FROM task_attempts WHERE task_id = $1 AND attempt_number = $2`,
		t.ID, t.AttemptCount); err != nil {
		return err
	}
	t.AttemptCount--
	t.State = domain.TaskReady
	t.LeaseOwner, t.LeaseExpiresAt, t.ExecutorHandle = nil, nil, nil
	return nil
}

// ReleaseLeases expires every lease owner holds, for a scheduler shutting
// down: the next scheduler recovers (adopts) those tasks at once rather
// than when the leases run out.
func ReleaseLeases(ctx context.Context, db DB, owner string, now time.Time) (int, error) {
	tag, err := db.Exec(ctx, `UPDATE execution_tasks SET lease_expires_at = $2, updated_at = now()
		WHERE state IN ('CLAIMED', 'RUNNING') AND lease_owner = $1`, owner, now)
	return int(tag.RowsAffected()), err
}

// How many candidates to read per claimable slot when a per-team cap applies.
const perTeamCandidates = 4

// maxClaimScan bounds the READY rows one pass reads looking past held
// ones, so a long queue of held steps costs a bounded pass; minClaimPage is
// the fewest read at once, so few slots left doesn't mean many queries.
const (
	maxClaimScan = 2000
	minClaimPage = 100
)

// runningPerTeam counts the tasks claimed or running for each team they
// count against (capTeams), and in all.
func (p *pass) runningPerTeam() (map[string]int, int, error) {
	rows, err := p.db.Query(p.ctx, `SELECT x.team, count(*), count(*) FILTER (WHERE x.team = t.team)
		FROM execution_tasks t
		CROSS JOIN LATERAL (SELECT t.team UNION SELECT t.for_team WHERE t.for_team IS NOT NULL AND t.for_team <> '') x(team)
		WHERE t.state IN ('CLAIMED', 'RUNNING') GROUP BY x.team`)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	counts, total := map[string]int{}, 0
	for rows.Next() {
		var team string
		var n, own int
		if err := rows.Scan(&team, &n, &own); err != nil {
			return nil, 0, err
		}
		counts[team] = n
		total += own // each task once, by the team it runs in
	}
	return counts, total, rows.Err()
}

// capTeams are the teams a task counts against for MaxRunningPerTeam: the
// team it runs in (its product's: a shared product runs in its own team's
// namespace) and, when another, the team it runs for. So a team can't
// run past its own cap by running other teams' shared products, nor
// another team's runs of a team's product go uncounted for it.
func capTeams(t *Task) []string {
	if t.ForTeam != nil && *t.ForTeam != "" && *t.ForTeam != t.Team {
		return []string{t.Team, *t.ForTeam}
	}
	return []string{t.Team}
}

// claimReadyTasks claims up to ClaimLimit READY tasks whose available_at
// has passed and whose execution is still active, after recovering expired
// leases. Pages of READY tasks are read without locking; a task is locked
// only once it's to be claimed (past its team's cap), with its execution's
// row (FOR NO KEY UPDATE, an UPDATE's own lock, as marking the execution
// RUNNING takes), held until the pass commits, task then execution as
// kernel-api's cancel takes them, both SKIP LOCKED so a claim never waits
// (lockForClaim): a task another scheduler has, or an execution being
// cancelled or settled, is passed over this pass, and one changed since the
// page was read is read again locked. What's passed over before that is
// never locked, so its cancel doesn't wait for this pass. A cancel arriving
// after the claim waits for the pass to commit, then finds the task RUNNING
// and leaves it to the next pass to stop.
// MaxRunning caps how many tasks are claimed or running across the
// platform, MaxRunningPerTeam per team (capTeams); a task over a cap stays
// READY. The caps are exact with one scheduler; with several, each counts
// on its own. Nothing is committed here: a pass commits claims and
// dispatches together, so a commit that fails after a Job was created
// rolls the claim back, and the next claim gets the same attempt number
// (and Job name) to adopt.
func (p *pass) claimReadyTasks() ([]*Task, error) {
	if _, err := p.recoverExpiredLeases(); err != nil {
		return nil, err
	}
	limit := p.opts.ClaimLimit
	var perTeam map[string]int
	total := 0
	if p.opts.MaxRunning > 0 || p.opts.MaxRunningPerTeam > 0 {
		var err error
		if perTeam, total, err = p.runningPerTeam(); err != nil {
			return nil, err
		}
	}
	if p.opts.MaxRunning > 0 {
		limit = min(limit, p.opts.MaxRunning-total)
		if limit <= 0 {
			return nil, nil
		}
	}
	candidates := limit
	if p.opts.MaxRunningPerTeam > 0 {
		// Some candidates may be teams already at their cap; reading a few
		// more keeps one busy team from starving the rest.
		candidates = limit * perTeamCandidates
	}
	// Held steps (a team or product at its cap, a concurrency key in use)
	// stay READY and keep their place, so a page of them alone isn't the
	// end: read the next page, by (available_at, id), until enough are
	// claimed, none are left, or maxClaimScan have been read this pass.
	var claimed []*Task
	keys := map[string]bool{}
	capped := map[string]int{}
	// A cap scope or key found held stays held for the rest of the pass
	// (what's claimed only grows, a lock not taken stays not taken): its
	// other tasks are passed over without asking again.
	heldScopes := map[string]bool{}
	heldKeys := map[string]bool{}
	var after *Task
	for scanned := 0; len(claimed) < limit && scanned < maxClaimScan; {
		page := min(max(candidates, minClaimPage), maxClaimScan-scanned)
		// The first page's cursor is before every task: -infinity, so the
		// cursor is always an index bound (ix_execution_tasks_ready_order).
		var afterAt *time.Time
		afterID := "00000000-0000-0000-0000-000000000000"
		if after != nil {
			afterAt, afterID = &after.AvailableAt, after.ID
		}
		rows, err := p.db.Query(p.ctx, `SELECT `+taskColumnsOf("t")+` FROM execution_tasks t
			JOIN executions e ON e.id = t.execution_id
			WHERE t.state = 'READY' AND t.available_at <= $1 AND e.state IN ('PENDING', 'RUNNING')
			AND (t.available_at, t.id) > (COALESCE($3::timestamptz, '-infinity'), $4::uuid)
			ORDER BY t.available_at, t.id LIMIT $2`, p.now, page, afterAt, afterID)
		if err != nil {
			return nil, err
		}
		ready, err := scanTasks(rows)
		if err != nil {
			return nil, err
		}
		scanned += len(ready)
		overCap := func(t *Task) bool {
			return p.opts.MaxRunningPerTeam > 0 && slices.ContainsFunc(capTeams(t), func(team string) bool {
				return perTeam[team] >= p.opts.MaxRunningPerTeam
			})
		}
		for next := 0; next < len(ready) && len(claimed) < limit; {
			// The next tasks that could be claimed (past their team's cap,
			// counting each chosen; not of a cap scope found held), up to the
			// slots left: only these are locked, together, in one query
			// (lockForClaim), so nothing passed over is.
			var batch []*Task
			tentative := maps.Clone(perTeam)
			for ; next < len(ready) && len(claimed)+len(batch) < limit; next++ {
				t := ready[next]
				if p.opts.MaxRunningPerTeam > 0 && slices.ContainsFunc(capTeams(t), func(team string) bool {
					return tentative[team] >= p.opts.MaxRunningPerTeam
				}) {
					continue
				}
				if t.CapScope != nil && heldScopes[*t.CapScope] {
					continue
				}
				if p.opts.MaxRunningPerTeam > 0 {
					for _, team := range capTeams(t) {
						tentative[team]++
					}
				}
				batch = append(batch, t)
			}
			locked, err := p.lockForClaim(batch)
			if err != nil {
				return nil, err
			}
			for _, candidate := range batch {
				// One another scheduler has (or claimed since the page was
				// read), or whose execution a cancel holds or that's no
				// longer active, is passed over without a slot or a key
				// taken for it; the rest are as read again, locked.
				t := locked[candidate.ID]
				if t == nil || overCap(t) {
					continue
				}
				if t.CapScope != nil && heldScopes[*t.CapScope] {
					continue
				}
				if held, err := p.capHold(t, capped); err != nil {
					return nil, err
				} else if held {
					heldScopes[*t.CapScope] = true
					continue // stays READY; GetExecution says it waits for its product's cap
				}
				key, held, err := p.concurrencyHold(t, keys, heldKeys)
				if err != nil {
					return nil, err
				}
				if held {
					// Stays READY; the next pass looks again. Its key says what
					// it's waiting for (kernel-api's TaskStatus.waiting_for).
					if _, err := p.db.Exec(p.ctx, `UPDATE execution_tasks SET concurrency_key = $1
						WHERE id = $2::uuid AND concurrency_key IS DISTINCT FROM $1`, key, t.ID); err != nil {
						return nil, err
					}
					continue
				}
				if key != "" {
					keys[key] = true
					t.ConcurrencyKey = &key
				}
				if t.CapScope != nil {
					capped[*t.CapScope]++
				}
				if p.opts.MaxRunningPerTeam > 0 {
					for _, team := range capTeams(t) {
						perTeam[team]++
					}
				}
				claimed = append(claimed, t)
			}
		}

		if len(ready) < page {
			break
		}
		after = ready[len(ready)-1]
	}
	for _, t := range claimed {
		t.State = domain.TaskClaimed
		t.LeaseOwner = &p.opts.Owner
		t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration))
		t.AttemptCount++
		// Who asked for this attempt: whoever retried it, else whoever
		// submitted it for its first, else nobody (an automatic retry).
		trigger, requestedBy := "automatic_retry", t.NextAttemptRequestedBy
		switch {
		case requestedBy != nil:
			trigger = "retried"
		case t.AttemptCount == 1:
			trigger = "submitted"
		}
		t.NextAttemptRequestedBy = nil
		if err := saveTask(p.ctx, p.db, t); err != nil {
			return nil, err
		}
		if _, err := p.db.Exec(p.ctx, `INSERT INTO task_attempts (id, task_id, attempt_number, requested_by, trigger, acted_as, image)
			VALUES (gen_random_uuid(), $1, $2,
				CASE WHEN $3 = 'submitted' THEN (SELECT requested_by FROM executions WHERE id = $4::uuid) ELSE $5 END, $3, $6, $7)`,
			t.ID, t.AttemptCount, trigger, t.ExecutionID, requestedBy, t.Team+"/"+t.ServiceAccount, t.Image); err != nil {
			return nil, err
		}
		if err := p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskClaimed,
			map[string]any{"taskKey": t.TaskKey, "owner": p.opts.Owner, "attempt": t.AttemptCount}); err != nil {
			return nil, err
		}
	}
	return claimed, nil
}

// lockForClaim locks these READY tasks, each with its execution still
// PENDING or RUNNING, without waiting for either (task then execution, as
// kernel-api's cancel takes them), in one query, and reads them again as
// locked, by id: one that can't be had now is missing.
func (p *pass) lockForClaim(tasks []*Task) (map[string]*Task, error) {
	if len(tasks) == 0 {
		return nil, nil
	}
	ids := make([]string, 0, len(tasks))
	for _, t := range tasks {
		ids = append(ids, t.ID)
	}
	rows, err := p.db.Query(p.ctx, `SELECT `+taskColumnsOf("t")+` FROM execution_tasks t
		JOIN executions e ON e.id = t.execution_id
		WHERE t.id = ANY($1::uuid[]) AND t.state = 'READY' AND e.state IN ('PENDING', 'RUNNING')
		FOR UPDATE OF t SKIP LOCKED FOR NO KEY UPDATE OF e SKIP LOCKED`, ids)
	if err != nil {
		return nil, err
	}
	locked, err := scanTasks(rows)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*Task, len(locked))
	for _, t := range locked {
		byID[t.ID] = t
	}
	return byID, nil
}

func ptr[T any](v T) *T { return &v }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// capHold says whether a task must wait for its product's cap: CapLimit
// tasks of its scope are claimed or running, counting those claimed earlier
// in this pass, or another scheduler is claiming one right now (the scope's
// transaction-scoped advisory lock, as for concurrency keys). No scope: no
// cap.
func (p *pass) capHold(t *Task, claimedNow map[string]int) (bool, error) {
	if t.CapScope == nil || *t.CapScope == "" || t.CapLimit < 1 {
		return false, nil
	}
	scope := *t.CapScope
	var locked bool
	if err := p.db.QueryRow(p.ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`, "cap:"+scope).Scan(&locked); err != nil {
		return false, err
	}
	if !locked {
		return true, nil
	}
	var running int
	if err := p.db.QueryRow(p.ctx, `SELECT count(*) FROM execution_tasks
		WHERE cap_scope = $1 AND state IN ('CLAIMED', 'RUNNING') AND id <> $2::uuid`, scope, t.ID).Scan(&running); err != nil {
		return false, err
	}
	return running+claimedNow[scope] >= t.CapLimit, nil
}

// concurrencyHold is the task's concurrency key, and whether it must wait:
// another task with the same key is claimed or running, or was claimed
// earlier in this pass, or another scheduler is claiming one right now
// (the key's transaction-scoped advisory lock, held until this pass
// commits, after which the claimed row says so). A task with no scope, or
// whose inputs can't be resolved yet (its dispatch then fails it as
// usual), has no key and never waits.
func (p *pass) concurrencyHold(t *Task, claimedNow, heldNow map[string]bool) (string, bool, error) {
	if t.ConcurrencyScope == nil || *t.ConcurrencyScope == "" || len(t.ConcurrencyInputs) == 0 {
		return "", false, nil
	}
	inputs, err := p.resolveInputs(t)
	var missing *domain.MissingOutputError
	if errors.As(err, &missing) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	key := domain.ConcurrencyKey(*t.ConcurrencyScope, t.ConcurrencyInputs, inputs)
	if claimedNow[key] || heldNow[key] {
		return key, true, nil
	}
	var locked, busy bool
	if err := p.db.QueryRow(p.ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`, key).Scan(&locked); err != nil {
		return "", false, err
	}
	if !locked {
		heldNow[key] = true
		return key, true, nil
	}
	if err := p.db.QueryRow(p.ctx, `SELECT EXISTS (SELECT 1 FROM execution_tasks
		WHERE concurrency_key = $1 AND state IN ('CLAIMED', 'RUNNING') AND id <> $2::uuid)`, key, t.ID).Scan(&busy); err != nil {
		return "", false, err
	}
	if busy {
		heldNow[key] = true
	}
	return key, busy, nil
}
