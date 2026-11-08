// SPDX-License-Identifier: MIT

// Package scheduler runs the kernel's scheduling passes: claim READY tasks,
// resolve their inputs and start them, poll the running ones, and move each
// execution along. The kernel-scheduler process runs passes forever (Run);
// a pass is one transaction, committed by the caller.
package scheduler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/roburns/vennir/kernel/internal/domain"
	"github.com/roburns/vennir/kernel/internal/executor"
	"github.com/roburns/vennir/kernel/internal/metrics"
)

// Options configure a pass.
type Options struct {
	// Owner is this scheduler's lease name (its Pod name).
	Owner         string
	LeaseDuration time.Duration
	// ClaimLimit is how many READY tasks one pass claims.
	ClaimLimit int
	// ExecutorConcurrency is how many executor calls (starts, status reads)
	// a pass has in flight at once.
	ExecutorConcurrency int
	// MaxRunning and MaxRunningPerTeam cap tasks claimed or running at once;
	// 0 is no cap.
	MaxRunning        int
	MaxRunningPerTeam int
	RetryBackoff      domain.RetryBackoff
	// MaxDispatchFailures is how many starts of one attempt may raise in a
	// row before the attempt fails.
	MaxDispatchFailures int
	// LogRefresh is how often a running task's logs are captured; 0, never.
	LogRefresh time.Duration
	// JobDeadlineGrace is how far past its timeout and StartTimeout a Job's
	// own deadline is: a timed-out or cancelled task whose Job can't be
	// stopped leaves RUNNING only after it.
	JobDeadlineGrace time.Duration
	// StartTimeout is how long an attempt may wait to start (for a node,
	// under a quota) before it fails as TASK_NOT_STARTED; its timeout counts
	// from its container's start. 0: no such wait, the timeout counts from
	// dispatch.
	StartTimeout time.Duration
	// ApprovalTimeout is how long a task may await approval before it
	// fails with APPROVAL_EXPIRED; 0, forever.
	ApprovalTimeout time.Duration
}

// DefaultOptions are the scheduler's defaults, for tests (the chart's values
// set the running scheduler's).
func DefaultOptions(owner string) Options {
	return Options{
		Owner: owner, LeaseDuration: 60 * time.Second, ClaimLimit: 50, ExecutorConcurrency: 16,
		RetryBackoff: domain.DefaultRetryBackoff, MaxDispatchFailures: 5, JobDeadlineGrace: 600 * time.Second,
		StartTimeout: 600 * time.Second, ApprovalTimeout: 72 * time.Hour,
	}
}

// Outcome is what a pass did.
type Outcome struct {
	// Progressed: it claimed a task or saw a running one finish, so the next
	// pass should run at once (a finished task's dependents are claimable).
	Progressed bool
	// Finished are the handles of tasks that left RUNNING: release them
	// (Executor.Release) only once the pass has committed.
	Finished []executor.Handle
	// Events are the event types recorded: count them once committed.
	Events []domain.EventType
}

type pass struct {
	ctx  context.Context
	db   DB
	exec executor.Executor
	opts Options
	now  time.Time
	// When the pass began, by the wall clock: what it records is stamped
	// now plus the time since (clock), not the pass's start, so a step's
	// end isn't early by however long the pass has run.
	began  time.Time
	log    *slog.Logger
	events []domain.EventType
	// Read for every running task at once before polling them (preload),
	// so a step still running costs no round trips of its own: its current
	// attempt, its execution's state (dropped once this pass changes the
	// execution), and when its logs were last captured.
	attempts        map[string]*Attempt
	executionStates map[string]string
	logsCapturedAt  map[string]time.Time
	// Tasks still running whose lease is renewed in one statement at the
	// end of the pass.
	heartbeats []string
	// The pass's events, written in one statement at its end (in order:
	// nothing in a pass reads them back); nil writes each at once.
	pendingEvents *[]pendingEvent
	// Executions this pass already moved to RUNNING.
	startedExecutions map[string]bool
	// Executions whose settling this pass holds (settling).
	settling map[string]bool
}

// clock is the pass's time as it goes: its start plus the time since.
func (p *pass) clock() time.Time { return p.now.Add(time.Since(p.began)) }

type pendingEvent struct {
	executionID string
	taskID      *string
	eventType   domain.EventType
	payload     map[string]any
}

// RunTick runs one scheduling pass on db (a transaction the caller commits):
// ExpireApprovals, RecordPass, then DispatchPass. The scheduler's loop commits each on its own
// (Loop.pass), so a dispatch held up by the API server (an admission webhook
// waiting out its timeout, seen on GKE) never holds what finished; tests run
// both in one. A pass that fails leaves nothing behind once its transaction
// rolls back, so running the next from scratch is always safe. Only
// executor calls overlap; every row read and write is in order.
func RunTick(ctx context.Context, db DB, exec executor.Executor, opts Options, now time.Time, log *slog.Logger) (Outcome, error) {
	expired, err := ExpireApprovals(ctx, db, exec, opts, now, log)
	if err != nil {
		return Outcome{}, err
	}
	recorded, err := RecordPass(ctx, db, exec, opts, now, log)
	if err != nil {
		return Outcome{}, err
	}
	recorded = expired.and(recorded)
	dispatched, err := DispatchPass(ctx, db, exec, opts, now, log)
	if err != nil {
		return Outcome{}, err
	}
	return recorded.and(dispatched), nil
}

// and is two passes' outcomes as one.
func (o Outcome) and(other Outcome) Outcome {
	return Outcome{
		Progressed: o.Progressed || other.Progressed,
		Finished:   append(o.Finished, other.Finished...),
		Events:     append(o.Events, other.Events...),
	}
}

// ExpireApprovals fails the tasks that awaited approval too long, and
// their executions; in a transaction of its own in the loop, as it settles
// executions in an order of its own (settle).
func ExpireApprovals(ctx context.Context, db DB, exec executor.Executor, opts Options, now time.Time, log *slog.Logger) (Outcome, error) {
	p := &pass{ctx: ctx, db: db, exec: exec, opts: opts, now: now, began: time.Now(), log: log, pendingEvents: &[]pendingEvent{}}
	expired, err := p.expireApprovals()
	if err != nil {
		return Outcome{}, fmt.Errorf("expiring approvals: %w", err)
	}
	if err := p.flushEvents(); err != nil {
		return Outcome{}, fmt.Errorf("recording events: %w", err)
	}
	return Outcome{Progressed: expired > 0, Events: p.events}, nil
}

// RecordPass polls this scheduler's running tasks: what finished is
// recorded (its dependents released), the rest's leases renewed.
func RecordPass(ctx context.Context, db DB, exec executor.Executor, opts Options, now time.Time, log *slog.Logger) (Outcome, error) {
	p := &pass{ctx: ctx, db: db, exec: exec, opts: opts, now: now, began: time.Now(), log: log, pendingEvents: &[]pendingEvent{}}
	// In one order, as every pass takes them: what finishes locks its
	// dependents and then its execution, so passes taking two executions'
	// rows in opposite orders could deadlock.
	rows, err := db.Query(ctx, `SELECT `+taskColumns+` FROM execution_tasks
		WHERE state = 'RUNNING' AND lease_owner = $1 ORDER BY execution_id, id FOR UPDATE SKIP LOCKED`, opts.Owner)
	if err != nil {
		return Outcome{}, err
	}
	running, err := scanTasks(rows)
	if err != nil {
		return Outcome{}, err
	}
	statuses, statusErrors := gather(ctx, running, opts.ExecutorConcurrency, func(t *Task) (executor.Status, error) {
		return exec.Status(ctx, t.ExecutorHandle)
	})
	if err := p.preload(running); err != nil {
		return Outcome{}, fmt.Errorf("reading the running tasks: %w", err)
	}
	var finished []executor.Handle
	for i, t := range running {
		handle := t.ExecutorHandle
		left, err := p.poll(t, statuses[i], statusErrors[i])
		if err != nil {
			return Outcome{}, fmt.Errorf("polling %s/%s: %w", t.ExecutionID, t.TaskKey, err)
		}
		if left {
			finished = append(finished, handle)
		}
	}
	if len(p.heartbeats) > 0 {
		// Still alive, still ours: every lease renewed at once.
		if _, err := db.Exec(ctx, `UPDATE execution_tasks SET lease_expires_at = $2, updated_at = now() WHERE id = ANY($1::uuid[])`,
			p.heartbeats, p.now.Add(opts.LeaseDuration)); err != nil {
			return Outcome{}, fmt.Errorf("renewing leases: %w", err)
		}
	}
	if err := p.flushEvents(); err != nil {
		return Outcome{}, fmt.Errorf("recording events: %w", err)
	}
	return Outcome{Progressed: len(finished) > 0, Finished: finished, Events: p.events}, nil
}

// DispatchPass claims the ready tasks there's room for and starts them.
func DispatchPass(ctx context.Context, db DB, exec executor.Executor, opts Options, now time.Time, log *slog.Logger) (Outcome, error) {
	p := &pass{ctx: ctx, db: db, exec: exec, opts: opts, now: now, began: time.Now(), log: log, pendingEvents: &[]pendingEvent{}}
	claimed, err := p.claimReadyTasks()
	if err != nil {
		return Outcome{}, fmt.Errorf("claiming: %w", err)
	}
	if err := p.dispatch(claimed); err != nil {
		return Outcome{}, fmt.Errorf("dispatching: %w", err)
	}
	if err := p.flushEvents(); err != nil {
		return Outcome{}, fmt.Errorf("recording events: %w", err)
	}
	return Outcome{Progressed: len(claimed) > 0, Events: p.events}, nil
}

// gather runs call for each item, at most limit at once; results in order.
func gather[I, R any](ctx context.Context, items []I, limit int, call func(I) (R, error)) ([]R, []error) {
	results := make([]R, len(items))
	errs := make([]error, len(items))
	semaphore := make(chan struct{}, max(limit, 1))
	var wg sync.WaitGroup
	for i, item := range items {
		wg.Add(1)
		go func() {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			if ctx.Err() != nil {
				errs[i] = ctx.Err()
				return
			}
			results[i], errs[i] = call(item)
		}()
	}
	wg.Wait()
	return results, errs
}

// dispatch resolves each claimed task's inputs, starts them all
// (concurrently), then records each start in order.
func (p *pass) dispatch(tasks []*Task) error {
	type prepared struct {
		task     *Task
		resolved executor.ResolvedTask
	}
	var ready []prepared
	for _, t := range tasks {
		resolved, ok, err := p.resolve(t)
		if err != nil {
			return err
		}
		if ok {
			ready = append(ready, prepared{t, resolved})
		}
	}
	handles, errs := gather(p.ctx, ready, p.opts.ExecutorConcurrency, func(r prepared) (executor.Handle, error) {
		return p.exec.Start(p.ctx, r.resolved)
	})
	for i, r := range ready {
		if err := p.recordStart(r.task, r.resolved, handles[i], errs[i]); err != nil {
			return err
		}
	}
	return nil
}

// resolve is the task with its inputs resolved, or ok=false after failing it.
func (p *pass) resolve(t *Task) (executor.ResolvedTask, bool, error) {
	inputs, err := p.resolveInputs(t)
	var missing *domain.MissingOutputError
	if errors.As(err, &missing) {
		// A declared output that never showed up is a product-contract
		// violation, not a transient problem: never worth retrying.
		return executor.ResolvedTask{}, false, p.handleFailure(t, nil, domain.StructuredError{
			Code: "MISSING_UPSTREAM_OUTPUT", Message: missing.Error()}, nil)
	}
	if err != nil {
		return executor.ResolvedTask{}, false, err
	}
	// Inputs that don't fit the product's schema fail the step before it
	// starts, rather than minutes later inside it: never worth retrying,
	// as the same inputs would come again.
	if problems := schemaProblems(t.InputSchema, inputs); len(problems) > 0 {
		return executor.ResolvedTask{}, false, p.handleFailure(t, nil, domain.StructuredError{
			Code: "INPUT_INVALID", Message: "its inputs don't fit its product's input schema: " + strings.Join(problems, "; ")}, nil)
	}
	return executor.ResolvedTask{
		ExecutionID: t.ExecutionID, TaskKey: t.TaskKey, Image: t.Image, Action: t.Action, Attempt: t.AttemptCount,
		ResolvedInputs: inputs, TimeoutSeconds: t.TimeoutSeconds, Team: t.Team, ForTeam: deref(t.ForTeam), ServiceAccount: t.ServiceAccount, Capacity: deref(t.Capacity),
		SecretRefs: t.SecretRefs, TokenAudiences: t.TokenAudiences, Resources: t.Resources,
	}, true, nil
}

// resolveInputs replaces the task's $fromTask references with its direct
// dependencies' stored outputs.
func (p *pass) resolveInputs(t *Task) (map[string]any, error) {
	rows, err := p.db.Query(p.ctx, `SELECT d.task_key, o.outputs FROM execution_tasks d
		JOIN task_dependencies td ON td.depends_on_task_id = d.id
		JOIN task_outputs o ON o.task_id = d.id
		WHERE td.task_id = $1`, t.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	outputs := map[string]map[string]any{}
	for rows.Next() {
		var key string
		var data []byte
		if err := rows.Scan(&key, &data); err != nil {
			return nil, err
		}
		var o map[string]any
		if err := decodeJSON(data, &o); err != nil {
			return nil, err
		}
		outputs[key] = o
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return domain.ResolveInputs(t.OriginalInputs, outputs)
}

// discard removes what a failed start left behind, best effort: a Job left
// behind still has its activeDeadlineSeconds.
func (p *pass) discard(task executor.ResolvedTask) {
	if err := p.exec.Discard(p.ctx, task); err != nil {
		p.log.Error("couldn't remove what a failed start left behind", "executionId", task.ExecutionID,
			"taskKey", task.TaskKey, "attempt", task.Attempt, "error", err.Error())
	}
}

func (p *pass) recordStart(t *Task, resolved executor.ResolvedTask, handle executor.Handle, startErr error) error {
	if rejected, ok := executor.IsDispatchRejected(startErr); ok {
		// Refused by cluster policy: the same attempt would be refused again.
		p.log.Warn("task dispatch rejected by cluster policy", "code", rejected.Code, "executionId", t.ExecutionID,
			"taskKey", t.TaskKey, "team", t.Team, "image", t.Image, "reason", rejected.Message)
		p.discard(resolved)
		t.DispatchFailures = 0
		return p.handleFailure(t, nil, domain.StructuredError{Code: rejected.Code, Message: rejected.Message}, nil)
	}
	if startErr != nil {
		// The start raised but may still have created the Job. Retrying the
		// same attempt reuses its Job name, so the retry adopts that Job
		// instead of starting a second one. Bounded: past the limit the
		// attempt fails, and whatever it left is removed.
		t.DispatchFailures++
		if t.DispatchFailures < p.opts.MaxDispatchFailures {
			p.log.Warn("starting a task failed; retrying the same attempt", "executionId", t.ExecutionID,
				"taskKey", t.TaskKey, "attempt", t.AttemptCount, "dispatchFailures", t.DispatchFailures, "error", startErr.Error())
			message := startErr.Error()
			if len(message) > 500 {
				message = message[:500]
			}
			if err := p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskDispatchRetry, map[string]any{
				"taskKey": t.TaskKey, "attempt": t.AttemptCount, "dispatchFailures": t.DispatchFailures, "error": message,
			}); err != nil {
				return err
			}
			if err := p.returnUnstartedAttempt(t); err != nil {
				return err
			}
			t.AvailableAt = p.now.Add(p.opts.RetryBackoff.Delay(t.DispatchFailures))
			return saveTask(p.ctx, p.db, t)
		}
		t.DispatchFailures = 0
		p.discard(resolved)
		return p.handleFailure(t, nil, domain.StructuredError{Code: "EXECUTOR_START_FAILED", Message: startErr.Error(), Retryable: true}, nil)
	}

	t.DispatchFailures = 0
	t.ResolvedInputs = resolved.ResolvedInputs
	t.ExecutorHandle = handle
	t.State = domain.TaskRunning
	if err := saveTask(p.ctx, p.db, t); err != nil {
		return err
	}
	if _, err := p.db.Exec(p.ctx, `UPDATE task_attempts SET started_at = $3, executor_handle = $4::jsonb
		WHERE task_id = $1 AND attempt_number = $2`, t.ID, t.AttemptCount, p.clock(), jsonValue(handle)); err != nil {
		return err
	}
	if err := p.markExecutionRunning(t.ExecutionID); err != nil {
		return err
	}
	return p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskStarted, map[string]any{"taskKey": t.TaskKey, "attempt": t.AttemptCount})
}

// schemaProblems are what a task's schema refuses in v; none when it has no
// schema. One that doesn't compile (kernel-api refuses those) is a problem.
func schemaProblems(schema map[string]any, v map[string]any) []string {
	if schema == nil {
		return nil
	}
	compiled, err := domain.CompileSchema(schema)
	if err != nil {
		return []string{"the schema isn't usable: " + err.Error()}
	}
	if v == nil {
		v = map[string]any{}
	}
	return compiled.Problems(v)
}

// poll acts on a RUNNING task's status (read before, alongside the others')
// and says whether the task left RUNNING. A task only leaves RUNNING for a
// retry once its attempt is known to have stopped (finished, stopped, or
// past its Job's own deadline): otherwise a retry could run beside it.
// preload reads, for every running task at once, what polling each needs:
// its current attempt, its execution's state, and when its logs were last
// captured.
func (p *pass) preload(running []*Task) error {
	p.attempts, p.executionStates, p.logsCapturedAt = map[string]*Attempt{}, map[string]string{}, map[string]time.Time{}
	if len(running) == 0 {
		return nil
	}
	ids, numbers, executions := make([]string, len(running)), make([]int32, len(running)), make([]string, len(running))
	for i, t := range running {
		ids[i], numbers[i], executions[i] = t.ID, int32(t.AttemptCount), t.ExecutionID
	}
	rows, err := p.db.Query(p.ctx, `SELECT a.task_id::text, a.id::text, a.started_at, a.completed_at, a.failure, a.executor_handle
		FROM task_attempts a JOIN unnest($1::uuid[], $2::int[]) AS r(task_id, n) ON a.task_id = r.task_id AND a.attempt_number = r.n`,
		ids, numbers)
	if err != nil {
		return err
	}
	for rows.Next() {
		a := &Attempt{}
		var taskID string
		var failure, handle []byte
		if err := rows.Scan(&taskID, &a.ID, &a.StartedAt, &a.CompletedAt, &failure, &handle); err != nil {
			rows.Close()
			return err
		}
		if err := decodeJSON(failure, &a.Failure); err != nil {
			rows.Close()
			return err
		}
		if err := decodeJSON(handle, &a.Handle); err != nil {
			rows.Close()
			return err
		}
		p.attempts[taskID] = a
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows, err = p.db.Query(p.ctx, `SELECT id::text, state FROM executions WHERE id = ANY($1::uuid[])`, executions)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, state string
		if err := rows.Scan(&id, &state); err != nil {
			rows.Close()
			return err
		}
		p.executionStates[id] = state
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if p.opts.LogRefresh <= 0 {
		return nil
	}
	rows, err = p.db.Query(p.ctx, `SELECT task_id::text, created_at FROM task_logs WHERE task_id = ANY($1::uuid[])`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var at time.Time
		if err := rows.Scan(&id, &at); err != nil {
			return err
		}
		p.logsCapturedAt[id] = at
	}
	return rows.Err()
}

func (p *pass) poll(t *Task, status executor.Status, statusErr error) (bool, error) {
	attempt := p.attempts[t.ID]
	if attempt == nil {
		var err error
		if attempt, err = currentAttempt(p.ctx, p.db, t); err != nil {
			return false, err
		}
	}
	handle := t.ExecutorHandle

	executionState, known := p.executionStates[t.ExecutionID]
	if !known {
		if err := p.db.QueryRow(p.ctx, `SELECT state FROM executions WHERE id = $1`, t.ExecutionID).Scan(&executionState); err != nil {
			return false, err
		}
	}
	if domain.ExecutionState(executionState) == domain.ExecutionCancelled {
		// Cancelled through kernel-api, which only marks rows: only the
		// scheduler can stop an in-flight attempt.
		if err := p.exec.Cancel(p.ctx, handle); err != nil && !p.pastJobDeadline(t, attempt) {
			// Not known to have stopped: it stays ours, and the cancel is
			// tried again, until the Job's own deadline has stopped it.
			p.log.Warn("couldn't stop a cancelled execution's task; trying again next pass", "executionId", t.ExecutionID,
				"taskKey", t.TaskKey, "attempt", t.AttemptCount, "error", err.Error())
			t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration))
			return false, saveTask(p.ctx, p.db, t)
		}
		attempt.CompletedAt = ptr(p.clock())
		if err := saveAttempt(p.ctx, p.db, attempt); err != nil {
			return false, err
		}
		t.State = domain.TaskCancelled
		if err := saveTask(p.ctx, p.db, t); err != nil {
			return false, err
		}
		return true, p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskCancelled, map[string]any{"taskKey": t.TaskKey, "attempt": t.AttemptCount})
	}

	if statusErr == nil && status.State != executor.Running {
		if err := p.settle(t.ExecutionID); err != nil {
			return false, err
		}
	}
	// A result already in wins over the timeout: a task that finished is
	// never failed for taking too long, even when seen late. Outputs that
	// don't fit the product's schema are a failure of the product's
	// contract, not worth retrying: no later step gets them.
	if statusErr == nil && status.State == executor.Succeeded {
		if problems := schemaProblems(t.OutputSchema, status.Outputs); len(problems) > 0 {
			return true, p.handleFailure(t, attempt, domain.StructuredError{
				Code: "OUTPUT_INVALID", Message: "its outputs don't fit its product's output schema: " + strings.Join(problems, "; ")}, handle)
		}
		attempt.CompletedAt = ptr(p.clock())
		if err := saveAttempt(p.ctx, p.db, attempt); err != nil {
			return false, err
		}
		if _, err := p.db.Exec(p.ctx, `INSERT INTO task_outputs (task_id, outputs) VALUES ($1, $2::jsonb)
			ON CONFLICT (task_id) DO UPDATE SET outputs = EXCLUDED.outputs, created_at = now()`, t.ID, jsonValue(status.Outputs)); err != nil {
			return false, err
		}
		if err := p.captureLogs(t, handle, nil); err != nil {
			return false, err
		}
		t.State = domain.TaskSucceeded
		if err := saveTask(p.ctx, p.db, t); err != nil {
			return false, err
		}
		if err := p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskSucceeded, map[string]any{
			"taskKey": t.TaskKey, "attempt": t.AttemptCount, "outputs": status.Outputs}); err != nil {
			return false, err
		}
		if err := p.releaseReadyDependents(t); err != nil {
			return false, err
		}
		return true, p.settleExecution(t.ExecutionID)
	}
	if statusErr == nil && status.State == executor.Failed {
		return true, p.handleFailure(t, attempt, *status.Error, handle)
	}

	if attempt.StartedAt != nil {
		// The timeout counts from the container's start (never before the
		// dispatch: clocks differ); until then the attempt may wait
		// StartTimeout for room. Not knowing, it counts from the dispatch,
		// as a timed-out attempt must be stopped even when it can't be read.
		elapsed := p.now.Sub(*attempt.StartedAt)
		timeout := time.Duration(t.TimeoutSeconds) * time.Second
		failure := domain.StructuredError{
			Code: "TASK_TIMEOUT", Message: fmt.Sprintf("Task exceeded its %ds timeout.", t.TimeoutSeconds), Retryable: true,
		}
		switch {
		case p.opts.StartTimeout <= 0, statusErr != nil:
		case status.StartedAt != nil:
			if status.StartedAt.After(*attempt.StartedAt) {
				elapsed = p.now.Sub(*status.StartedAt)
			}
		default:
			timeout = p.opts.StartTimeout
			failure = domain.StructuredError{
				Code: "TASK_NOT_STARTED", Retryable: true,
				Message: fmt.Sprintf("Task didn't start within %s: the cluster had no room for it (no node could be added, or a quota).", p.opts.StartTimeout),
			}
		}
		if elapsed > timeout {
			if err := p.exec.Cancel(p.ctx, handle); err != nil && !p.pastJobDeadline(t, attempt) {
				// Before the Job's own deadline the attempt may still be
				// running: it stays ours, and the cancel is tried again.
				p.log.Warn("couldn't stop a task past its timeout; trying again next pass", "executionId", t.ExecutionID,
					"taskKey", t.TaskKey, "attempt", t.AttemptCount, "error", err.Error())
				t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration))
				return false, saveTask(p.ctx, p.db, t)
			}
			if err := p.settle(t.ExecutionID); err != nil {
				return false, err
			}
			return true, p.handleFailure(t, attempt, failure, handle)
		}
	}

	if statusErr != nil {
		// Not knowing isn't failing: the attempt may still be running, and a
		// retry would start a second one beside it. Read again next pass;
		// the timeout above still applies.
		metrics.StatusReadErrors.Inc()
		p.log.Warn("couldn't read a running task's status; reading it again next pass", "executionId", t.ExecutionID,
			"taskKey", t.TaskKey, "attempt", t.AttemptCount, "error", statusErr.Error())
		t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration))
		return false, saveTask(p.ctx, p.db, t)
	}

	// Heartbeat: still alive, still ours (renewed with the rest at the end).
	t.LeaseExpiresAt = ptr(p.now.Add(p.opts.LeaseDuration))
	p.heartbeats = append(p.heartbeats, t.ID)
	if p.opts.LogRefresh > 0 {
		// So a long step's progress shows while it runs, not only at the end.
		capturedAt, captured := p.logsCapturedAt[t.ID]
		if !captured || p.now.Sub(capturedAt) >= p.opts.LogRefresh {
			return false, p.captureLogs(t, handle, &p.now)
		}
	}
	return false, nil
}

// settle takes the execution's transaction-scoped advisory lock, once a
// pass, before a task of it that finished (or whose approval expired)
// locks its dependents, its waiting siblings or the execution. Two
// schedulers finishing tasks of one execution would otherwise lock its
// dependents in opposite orders (one finishing T1 then T3, the other T2,
// each releasing a join) and deadlock; with it, one settles the execution
// at a time. Each transaction that settles takes these in execution order
// (RecordPass and ExpireApprovals read their tasks so, before locking
// any), so settling passes never deadlock each other. Other writers to an
// execution don't take it and can: a dispatch failing its execution
// (MISSING_UPSTREAM_OUTPUT, INPUT_INVALID, a refusal, EXECUTOR_START_FAILED)
// holds the rows it claimed and their executions', in the queue's order, so
// it can't wait here without risking a cycle of its own (a settling pass
// waits for such an execution's row until the dispatch commits); and
// kernel-api's cancel and retry
// lock tasks, then the execution. Postgres aborts one of a deadlock, and
// that pass is redone from the rows (a cancel or retry errs, and is sent
// again).
func (p *pass) settle(executionID string) error {
	if p.settling[executionID] {
		return nil
	}
	if _, err := p.db.Exec(p.ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "settle:"+executionID); err != nil {
		return err
	}
	if p.settling == nil {
		p.settling = map[string]bool{}
	}
	p.settling[executionID] = true
	return nil
}

// pastJobDeadline says the attempt's Job has passed its own deadline
// (activeDeadlineSeconds: the task's timeout, plus StartTimeout, plus
// JobDeadlineGrace, from its creation) and its Pod's termination grace,
// so Kubernetes has stopped it. It counts from the attempt's started_at,
// stamped once Start returned, so never before the Job was made.
func (p *pass) pastJobDeadline(t *Task, attempt *Attempt) bool {
	if attempt.StartedAt == nil {
		return true // not known: never waited for forever
	}
	deadline := time.Duration(t.TimeoutSeconds)*time.Second + p.opts.StartTimeout + p.opts.JobDeadlineGrace + executor.PodTerminationGrace
	return p.now.Sub(*attempt.StartedAt) > deadline
}

// captureLogs stores the attempt's output, replacing the last capture. Best
// effort: a task's outcome never depends on reading its logs.
func (p *pass) captureLogs(t *Task, handle executor.Handle, at *time.Time) error {
	lines, err := p.exec.Logs(p.ctx, handle)
	if err != nil {
		return nil
	}
	if lines == nil {
		lines = []string{}
	}
	capturedAt := time.Now()
	if at != nil {
		capturedAt = *at
	}
	_, err = p.db.Exec(p.ctx, `INSERT INTO task_logs (task_id, lines, created_at) VALUES ($1, $2, $3)
		ON CONFLICT (task_id) DO UPDATE SET lines = EXCLUDED.lines, created_at = EXCLUDED.created_at`, t.ID, lines, capturedAt)
	return err
}

// handleFailure records a failed attempt, then retries the task (READY,
// after a backoff) or fails it and its execution. attempt and handle are
// nil for failures before anything ran (resolving inputs, starting).
func (p *pass) handleFailure(t *Task, attempt *Attempt, failure domain.StructuredError, handle executor.Handle) error {
	if attempt == nil {
		var err error
		if attempt, err = currentAttempt(p.ctx, p.db, t); err != nil {
			return err
		}
	}
	attempt.CompletedAt = ptr(p.clock())
	attempt.Failure = failure.AsMap()
	if err := saveAttempt(p.ctx, p.db, attempt); err != nil {
		return err
	}
	if handle != nil {
		// A task that failed is often the one someone most wants logs for.
		if err := p.captureLogs(t, handle, nil); err != nil {
			return err
		}
	}
	retry := domain.ShouldRetry(t.AttemptCount, t.MaxAttempts, failure.Retryable)
	if err := p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskFailed, map[string]any{
		"taskKey": t.TaskKey, "attempt": t.AttemptCount, "error": failure.AsMap(), "willRetry": retry}); err != nil {
		return err
	}
	if retry {
		t.State = domain.TaskReady
		t.LeaseOwner, t.LeaseExpiresAt, t.ExecutorHandle = nil, nil, nil
		t.AvailableAt = p.now.Add(p.opts.RetryBackoff.Delay(t.AttemptCount))
		return saveTask(p.ctx, p.db, t)
	}
	t.State = domain.TaskFailed
	t.Failure = failure.AsMap()
	if err := saveTask(p.ctx, p.db, t); err != nil {
		return err
	}
	return p.failExecution(t.ExecutionID)
}

// expireApprovals fails each task that has awaited approval longer than
// ApprovalTimeout (APPROVAL_EXPIRED), and with it its execution, as a
// decline would.
func (p *pass) expireApprovals() (int, error) {
	if p.opts.ApprovalTimeout <= 0 {
		return 0, nil
	}
	cutoff := p.now.Add(-p.opts.ApprovalTimeout)
	// Read unlocked, by execution: each execution's settling is taken
	// before any of its rows is locked (failExecution locks its waiting
	// tasks, these among them), as a settling pass takes them.
	rows, err := p.db.Query(p.ctx, `SELECT id::text, execution_id::text FROM execution_tasks
		WHERE state = 'AWAITING_APPROVAL' AND available_at <= $1 ORDER BY execution_id, id`, cutoff)
	if err != nil {
		return 0, err
	}
	type candidate struct{ id, executionID string }
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.id, &c.executionID); err != nil {
			rows.Close()
			return 0, err
		}
		candidates = append(candidates, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	expired := 0
	for _, c := range candidates {
		if err := p.settle(c.executionID); err != nil {
			return expired, err
		}
		// Still waiting, now it's locked? (Approved, declined, or cancelled
		// with its execution meanwhile: left alone.)
		rows, err := p.db.Query(p.ctx, `SELECT `+taskColumns+` FROM execution_tasks
			WHERE id = $1 AND state = 'AWAITING_APPROVAL' AND available_at <= $2 FOR NO KEY UPDATE SKIP LOCKED`, c.id, cutoff)
		if err != nil {
			return expired, err
		}
		found, err := scanTasks(rows)
		if err != nil {
			return expired, err
		}
		if len(found) == 0 {
			continue
		}
		t := found[0]
		expired++
		failure := domain.StructuredError{Code: "APPROVAL_EXPIRED", Message: "Nobody approved or declined it in time."}
		t.State = domain.TaskFailed
		t.Failure = failure.AsMap()
		if err := saveTask(p.ctx, p.db, t); err != nil {
			return expired, err
		}
		if err := p.recordEvent(t.ExecutionID, &t.ID, domain.EventTaskFailed, map[string]any{
			"taskKey": t.TaskKey, "attempt": t.AttemptCount, "error": failure.AsMap(), "willRetry": false}); err != nil {
			return expired, err
		}
		if err := p.failExecution(t.ExecutionID); err != nil {
			return expired, err
		}
	}
	return expired, nil
}

// releaseReadyDependents makes each BLOCKED dependent of t READY (or
// AWAITING_APPROVAL, if it needs an approval it hasn't had) once every
// one of its dependencies has succeeded. The dependent is locked before its
// dependencies are read: two schedulers finishing two of its dependencies
// at once would otherwise each see the other still running, and neither
// would release it. FOR NO KEY UPDATE, like an ordinary UPDATE's lock:
// rows inserted meanwhile that reference it (events, outputs) take FOR KEY
// SHARE, which FOR UPDATE would conflict with, deadlocking.
func (p *pass) releaseReadyDependents(t *Task) error {
	rows, err := p.db.Query(p.ctx, `SELECT task_id::text FROM task_dependencies WHERE depends_on_task_id = $1`, t.ID)
	if err != nil {
		return err
	}
	var dependents []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		dependents = append(dependents, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range dependents {
		var state string
		if err := p.db.QueryRow(p.ctx, `SELECT state FROM execution_tasks WHERE id = $1 FOR NO KEY UPDATE`, id).Scan(&state); err != nil {
			return err
		}
		if domain.TaskState(state) != domain.TaskBlocked {
			continue
		}
		var unfinished int
		if err := p.db.QueryRow(p.ctx, `SELECT count(*) FROM execution_tasks d
			JOIN task_dependencies td ON td.depends_on_task_id = d.id
			WHERE td.task_id = $1 AND d.state <> 'SUCCEEDED'`, id).Scan(&unfinished); err != nil {
			return err
		}
		if unfinished == 0 {
			if _, err := p.db.Exec(p.ctx, `UPDATE execution_tasks SET state = `+domain.ReadyOrAwaitingSQL+`,
				available_at = $2, updated_at = now() WHERE id = $1`, id, p.now); err != nil {
				return err
			}
		}
	}
	return nil
}

// The execution transitions below are compare-and-set, never a loaded
// row's state written back: kernel-api may have cancelled it since.

func (p *pass) markExecutionRunning(executionID string) error {
	if p.startedExecutions[executionID] {
		return nil // this pass already did
	}
	delete(p.executionStates, executionID) // changed by this pass: read again
	moved, err := transitionExecution(p.ctx, p.db, executionID, domain.ExecutionRunning, domain.ExecutionPending)
	if err == nil {
		if p.startedExecutions == nil {
			p.startedExecutions = map[string]bool{}
		}
		p.startedExecutions[executionID] = true
	}
	if err != nil || !moved {
		return err
	}
	return p.recordEvent(executionID, nil, domain.EventExecutionStarted, nil)
}

// settleExecution, after a task succeeds: SUCCEEDED once every task has, or
// FAILED if a task failed and nothing that could still run is left (after
// a manual retry resumed an execution with more than one failed task). The
// execution's row is locked before its tasks are counted, as in
// releaseReadyDependents: two schedulers finishing its last two tasks would
// each count the other's as unfinished.
func (p *pass) settleExecution(executionID string) error {
	delete(p.executionStates, executionID) // changed by this pass: read again
	if _, err := p.db.Exec(p.ctx, `SELECT id FROM executions WHERE id = $1 FOR NO KEY UPDATE`, executionID); err != nil {
		return err
	}
	rows, err := p.db.Query(p.ctx, `SELECT state, count(*) FROM execution_tasks WHERE execution_id = $1 GROUP BY state`, executionID)
	if err != nil {
		return err
	}
	counts := map[domain.TaskState]int{}
	total := 0
	for rows.Next() {
		var state string
		var n int
		if err := rows.Scan(&state, &n); err != nil {
			rows.Close()
			return err
		}
		counts[domain.TaskState(state)] = n
		total += n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if counts[domain.TaskSucceeded] == total {
		moved, err := transitionExecution(p.ctx, p.db, executionID, domain.ExecutionSucceeded, domain.ActiveExecutionStates...)
		if err != nil || !moved {
			return err
		}
		return p.recordEvent(executionID, nil, domain.EventExecutionSucceeded, nil)
	}
	runnable := counts[domain.TaskReady] + counts[domain.TaskAwaitingApproval] + counts[domain.TaskClaimed] + counts[domain.TaskRunning]
	if counts[domain.TaskFailed] > 0 && runnable == 0 {
		return p.failExecution(executionID)
	}
	return nil
}

// failExecution cancels the tasks that were never going to run (waiting on
// a dependency, or to be claimed) and fails the execution. Tasks before the
// execution's own row, in the order kernel-api's cancel locks them too.
func (p *pass) failExecution(executionID string) error {
	delete(p.executionStates, executionID) // changed by this pass: read again
	if _, err := p.db.Exec(p.ctx, `UPDATE execution_tasks SET state = 'CANCELLED', updated_at = now()
		WHERE execution_id = $1 AND state IN ('READY', 'BLOCKED', 'AWAITING_APPROVAL')`, executionID); err != nil {
		return err
	}
	moved, err := transitionExecution(p.ctx, p.db, executionID, domain.ExecutionFailed, domain.ActiveExecutionStates...)
	if err != nil || !moved {
		return err
	}
	return p.recordEvent(executionID, nil, domain.EventExecutionFailed, nil)
}

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }
