// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/rburns629/vennir/kernel/internal/domain"
	"github.com/rburns629/vennir/kernel/internal/executor"
	"github.com/rburns629/vennir/kernel/internal/metrics"
	"github.com/rburns629/vennir/kernel/internal/migrate"
)

// Between back-to-back passes, so a run of progress (or a task that keeps
// failing to start) can't hold the database in a tight loop.
const pauseAfterProgress = 50 * time.Millisecond

const (
	retentionInterval   = time.Hour
	orphanSweepInterval = 5 * time.Minute
	gaugeInterval       = 15 * time.Second
)

// Loop is what Run needs beyond a pass's Options.
type Loop struct {
	Pool     *pgxpool.Pool
	Executor executor.Executor
	Options  Options
	// PollInterval is the longest wait between passes when nothing happened.
	PollInterval time.Duration
	// ReleaseAfter keeps a finished attempt's Job this long once its result
	// is committed, so a log collector can still read its Pod's output.
	ReleaseAfter time.Duration
	// RetentionDays deletes finished executions this long after their last
	// event; 0 keeps them forever.
	RetentionDays int
	// HeartbeatFile is touched each time the loop comes round; the liveness
	// probe restarts the Pod if it goes stale (a hung pass).
	HeartbeatFile string
	Log           *slog.Logger

	held heldJobs
}

// heldJobs are finished attempts' Jobs waiting out ReleaseAfter. Only in
// memory: after a crash the orphan sweep removes them.
type heldJobs []heldJob

type heldJob struct {
	handle executor.Handle
	due    time.Time
}

func (h *heldJobs) hold(handles []executor.Handle, due time.Time) {
	for _, handle := range handles {
		*h = append(*h, heldJob{handle, due})
	}
}

// take removes and returns the Jobs due by now (all of them, given the zero time).
func (h *heldJobs) take(now time.Time) []executor.Handle {
	var due []executor.Handle
	kept := (*h)[:0]
	for _, job := range *h {
		if now.IsZero() || !job.due.After(now) {
			due = append(due, job.handle)
		} else {
			kept = append(kept, job)
		}
	}
	*h = kept
	return due
}

// heartbeat touches the liveness probe's file: each time the loop comes
// round, and between the phases of one turn (recording, dispatching,
// housekeeping, releasing), so the probe bounds the slowest phase, not
// their sum.
func (l *Loop) heartbeat() {
	now := time.Now()
	if err := os.Chtimes(l.HeartbeatFile, now, now); err != nil {
		if f, err := os.Create(l.HeartbeatFile); err == nil {
			_ = f.Close()
		}
	}
}

// Run runs passes until ctx ends (SIGTERM): it then finishes the pass in
// progress, claims nothing more, and releases its leases so another
// scheduler adopts its tasks at once. A pass that fails is logged and the
// next starts from whatever is committed.
func (l *Loop) Run(ctx context.Context) error {
	l.heartbeat()
	migrate.Wait(ctx, l.Pool, l.heartbeat, l.Log)
	if ctx.Err() != nil {
		return nil
	}
	l.Log.Info("scheduler starting", "owner", l.Options.Owner)
	// The pass in progress runs to its end even once ctx is cancelled.
	work := context.WithoutCancel(ctx)
	nextRetention := time.Now()
	nextOrphanSweep := time.Now().Add(orphanSweepInterval)
	var nextGauges time.Time
	for ctx.Err() == nil {
		started := time.Now()
		outcome, err := l.pass(work)
		metrics.TickDuration.Observe(time.Since(started).Seconds())
		// What committed: all of it, or only the recorded half when the
		// dispatch failed after it.
		for _, event := range outcome.Events {
			metrics.Events.WithLabelValues(string(event)).Inc()
		}
		// Committed: only now may what finished be removed, once held.
		l.held.hold(outcome.Finished, time.Now().Add(l.ReleaseAfter))
		l.heartbeat()
		if err != nil {
			metrics.TickErrors.Inc()
			l.Log.Error("scheduler tick failed; will retry next poll", "error", err.Error())
		} else {
			l.housekeeping(work, &nextRetention, &nextOrphanSweep)
			l.heartbeat()
		}
		ReleaseFinished(work, l.Executor, l.held.take(time.Now()), l.Log)
		if time.Now().After(nextGauges) {
			nextGauges = time.Now().Add(gaugeInterval)
			if err := SampleTasks(work, l.Pool, time.Now()); err != nil {
				l.Log.Warn("couldn't sample the task gauges", "error", err.Error())
			}
		}
		if outcome.Progressed {
			// More is likely ready: go again after a pause too short to notice.
			select {
			case <-ctx.Done():
			case <-time.After(pauseAfterProgress):
			}
		} else {
			l.Executor.WaitForChange(ctx, l.PollInterval)
		}
		l.heartbeat()
	}
	// Not held any longer: another scheduler wouldn't know of them.
	ReleaseFinished(work, l.Executor, l.held.take(time.Time{}), l.Log)
	// Not retried: if this fails, the leases expire on their own and are
	// recovered then, as after a crash.
	released, err := ReleaseLeases(work, l.Pool, l.Options.Owner, time.Now())
	if err != nil {
		return err
	}
	l.Log.Info("scheduler stopped; leases released", "owner", l.Options.Owner, "released", released)
	return nil
}

// pass runs one tick: expired approvals failed and committed, what
// finished recorded and committed, then ready
// tasks claimed and dispatched in a transaction of their own, so this
// scheduler's slow dispatch never holds a finished task's record (another
// scheduler's can, on a row they both need). A recorded half stands
// even if the dispatch half fails: its handles are still released.
func (l *Loop) pass(ctx context.Context) (Outcome, error) {
	var expired, recorded, dispatched Outcome
	err := pgx.BeginFunc(ctx, l.Pool, func(tx pgx.Tx) error {
		var err error
		expired, err = ExpireApprovals(ctx, tx, l.Executor, l.Options, time.Now(), l.Log)
		return err
	})
	if err != nil {
		return Outcome{}, err
	}
	l.heartbeat()
	err = pgx.BeginFunc(ctx, l.Pool, func(tx pgx.Tx) error {
		var err error
		recorded, err = RecordPass(ctx, tx, l.Executor, l.Options, time.Now(), l.Log)
		return err
	})
	if err != nil {
		return expired, err
	}
	recorded = expired.and(recorded)
	l.heartbeat()
	err = pgx.BeginFunc(ctx, l.Pool, func(tx pgx.Tx) error {
		var err error
		dispatched, err = DispatchPass(ctx, tx, l.Executor, l.Options, time.Now(), l.Log)
		return err
	})
	if err != nil {
		return recorded, err
	}
	return recorded.and(dispatched), nil
}

func (l *Loop) housekeeping(ctx context.Context, nextRetention, nextOrphanSweep *time.Time) {
	if l.RetentionDays > 0 && time.Now().After(*nextRetention) {
		*nextRetention = time.Now().Add(retentionInterval)
		var deleted int
		err := pgx.BeginFunc(ctx, l.Pool, func(tx pgx.Tx) error {
			var err error
			deleted, err = DeleteFinishedExecutions(ctx, tx, time.Now().AddDate(0, 0, -l.RetentionDays), 500)
			return err
		})
		if err != nil {
			l.Log.Error("couldn't delete finished executions past retention", "error", err.Error())
		} else if deleted > 0 {
			l.Log.Info("deleted finished executions past retention", "deleted", deleted)
		}
	}
	if time.Now().After(*nextOrphanSweep) {
		*nextOrphanSweep = time.Now().Add(orphanSweepInterval)
		if _, err := ReleaseOrphanedAttempts(ctx, l.Pool, l.Executor, time.Now().Add(-OrphanMinAge), l.Log); err != nil {
			l.Log.Error("couldn't sweep orphaned attempts", "error", err.Error())
		}
		if err := pgx.BeginFunc(ctx, l.Pool, func(tx pgx.Tx) error {
			_, err := CancelStranded(ctx, tx, l.Log)
			return err
		}); err != nil {
			l.Log.Error("couldn't cancel tasks left waiting in cancelled executions", "error", err.Error())
		}
	}
}

// unfinished are the states kernel_tasks reports, each even when it's 0.
var unfinished = []domain.TaskState{domain.TaskBlocked, domain.TaskReady, domain.TaskAwaitingApproval, domain.TaskClaimed, domain.TaskRunning}

// SampleTasks sets the task gauges from the database: how many tasks are in
// each unfinished state, and how long the oldest READY one has waited.
func SampleTasks(ctx context.Context, db DB, now time.Time) error {
	states := make([]string, len(unfinished))
	for i, state := range unfinished {
		states[i] = string(state)
	}
	counts := map[string]float64{}
	// A READY task of a failed execution waits for a retry of its failed
	// sibling (which resumes the execution): not in the queue until then.
	rows, err := db.Query(ctx, `SELECT t.state, count(*) FROM execution_tasks t JOIN executions e ON e.id = t.execution_id
		WHERE t.state = ANY($1) AND (t.state <> 'READY' OR e.state IN ('PENDING', 'RUNNING')) GROUP BY t.state`, states)
	if err != nil {
		return err
	}
	for rows.Next() {
		var state string
		var n int64
		if err := rows.Scan(&state, &n); err != nil {
			rows.Close()
			return err
		}
		counts[state] = float64(n)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var oldest *time.Time
	if err := db.QueryRow(ctx, `SELECT min(t.available_at) FROM execution_tasks t JOIN executions e ON e.id = t.execution_id
		WHERE t.state = $1 AND e.state IN ('PENDING', 'RUNNING')`, string(domain.TaskReady)).Scan(&oldest); err != nil {
		return err
	}
	for _, state := range unfinished {
		metrics.Tasks.WithLabelValues(string(state)).Set(counts[string(state)])
	}
	age := 0.0
	if oldest != nil && now.After(*oldest) {
		age = now.Sub(*oldest).Seconds()
	}
	metrics.OldestReady.Set(age)
	return nil
}

// ReleaseFinished removes the units of tasks whose outcome a committed pass
// recorded. One that fails is logged and left (the orphan sweep and the
// Job's TTL remove it later); the rest are still released.
func ReleaseFinished(ctx context.Context, exec executor.Executor, finished []executor.Handle, log *slog.Logger) {
	for _, handle := range finished {
		if err := exec.Release(ctx, handle); err != nil {
			log.Warn("couldn't remove a finished task's Job", "handle", handle, "error", err.Error())
		}
	}
}
