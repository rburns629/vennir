// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/roburns/vennir/kernel/internal/domain"
	"github.com/roburns/vennir/kernel/internal/executor"
)

// The scheduler's side of cancelling and manually retrying (kernel-api's
// own outcomes are in internal/api's tests).

func chain() []TaskDef {
	return []TaskDef{
		task("create-project", func(d *TaskDef) { d.Image = "x:local" }),
		task("deploy-application", dependsOn("create-project"), func(d *TaskDef) { d.Image = "x:local" },
			inputs(map[string]any{"projectId": map[string]any{"$fromTask": "create-project", "$output": "projectId"}})),
	}
}

func TestCancelRunningExecutionStopsInFlightTaskOnNextTick(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-cancel-running", chain()...)
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	handle := tasksByKey(t, tx, id)["create-project"].ExecutorHandle
	cancelExecution(t, tx, id)

	// At once: the sibling is cancelled, the running task untouched.
	tasks := tasksByKey(t, tx, id)
	equal(t, "create-project", tasks["create-project"].State, domain.TaskRunning)
	equal(t, "deploy-application", tasks["deploy-application"].State, domain.TaskCancelled)
	equal(t, "cancelled", len(exec.Cancelled), 0)

	// The next pass is what stops it.
	outcome := k.tick(t0.Add(time.Second))
	equal(t, "create-project", tasksByKey(t, tx, id)["create-project"].State, domain.TaskCancelled)
	equal(t, "cancelled", exec.Cancelled, []string{handle["fakeId"].(string)})
	equal(t, "finished, to release", outcome.Finished, []executor.Handle{handle})
}

func TestRetryFailedTaskResumesExecutionAndCanSucceed(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-retry-basic", task("create-project"))
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	exec.Fail(tasksByKey(t, tx, id)["create-project"].ExecutorHandle, domain.StructuredError{Code: "BOOM", Message: "failed"})
	k.tick(t0.Add(time.Second))
	equal(t, "state", tasksByKey(t, tx, id)["create-project"].State, domain.TaskFailed)
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionFailed)

	retryTask(t, tx, id, "create-project", t0.Add(time.Second))
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionRunning)
	// max attempts was 1: a manual retry grants another anyway.
	k.tick(t0.Add(2 * time.Second))
	tk := tasksByKey(t, tx, id)["create-project"]
	equal(t, "state", tk.State, domain.TaskRunning)
	equal(t, "attempts", tk.AttemptCount, 2)
	exec.Complete(tk.ExecutorHandle, map[string]any{"projectId": "demo-project-123"})
	k.tick(t0.Add(3 * time.Second))
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionSucceeded)
}

func TestRetryRevivesCancelledSiblingsAndExecutionCanStillSucceed(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-retry-siblings", chain()...)
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	exec.Fail(tasksByKey(t, tx, id)["create-project"].ExecutorHandle, domain.StructuredError{Code: "BOOM", Message: "failed"})
	k.tick(t0.Add(time.Second))
	equal(t, "deploy", tasksByKey(t, tx, id)["deploy-application"].State, domain.TaskCancelled)

	retryTask(t, tx, id, "create-project", t0.Add(time.Second))
	equal(t, "deploy", tasksByKey(t, tx, id)["deploy-application"].State, domain.TaskBlocked)
	k.tick(t0.Add(2 * time.Second))
	exec.Complete(tasksByKey(t, tx, id)["create-project"].ExecutorHandle, map[string]any{"projectId": "demo-project-123"})
	k.tick(t0.Add(3 * time.Second))
	deploy := tasksByKey(t, tx, id)["deploy-application"]
	equal(t, "deploy", deploy.State, domain.TaskRunning)
	equal(t, "resolved", deploy.ResolvedInputs, map[string]any{"projectId": "demo-project-123"})
	exec.Complete(deploy.ExecutorHandle, map[string]any{"applicationUrl": "https://demo.example"})
	k.tick(t0.Add(5 * time.Second))
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionSucceeded)
}

// The scheduler holds a claimed task's row lock while it dispatches it. A
// cancel arriving then must not overwrite the RUNNING the scheduler commits
// with CANCELLED: that would leave its Job running with nothing to stop it.
// The task stays RUNNING, and the scheduler's next poll stops it. Committed
// rows across two connections.
func TestACancelDuringDispatchLeavesTheTaskForTheSchedulerToStop(t *testing.T) {
	ctx := context.Background()
	var id string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		id = submit(t, tx, "idem-cancel-race-go", chain()...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id) })
	exec := fake()
	opts := DefaultOptions("scheduler-1")
	committedTick := func() {
		t.Helper()
		if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
			_, err := RunTick(ctx, tx, exec, opts, time.Now(), quietLog)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	committedTick() // create-project dispatched as "1"
	exec.Complete(executor.Handle{"fakeId": "1"}, map[string]any{"projectId": "p-1"})

	scheduler, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// As the loop does: create-project recorded done and deploy-application
	// released, committed; then deploy-application dispatched as "2", uncommitted.
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		_, err := RecordPass(ctx, tx, exec, opts, time.Now(), quietLog)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := DispatchPass(ctx, scheduler, exec, opts, time.Now(), quietLog); err != nil {
		t.Fatal(err)
	}
	cancelled := make(chan struct{})
	go func() {
		defer close(cancelled)
		_ = pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
			cancelExecution(t, tx, id)
			return nil
		})
	}()
	select {
	case <-cancelled:
		t.Fatal("the cancel should wait for the dispatch's row lock")
	case <-time.After(500 * time.Millisecond):
	}
	if err := scheduler.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	<-cancelled

	equal(t, "execution", executionState(t, testPool, id), domain.ExecutionCancelled)
	equal(t, "deploy-application", tasksByKey(t, testPool, id)["deploy-application"].State, domain.TaskRunning)
	committedTick()
	equal(t, "cancelled", exec.Cancelled, []string{"2"})
	equal(t, "deploy-application", tasksByKey(t, testPool, id)["deploy-application"].State, domain.TaskCancelled)
}

// Not known to have stopped, a cancelled execution's step stays RUNNING
// and the cancel is tried again; only the Job's own deadline ends that.
func TestACancelledExecutionsStepThatCantBeStoppedIsStoppedAgain(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-cancel-unstoppable", task("create-project", timeout(30)))
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	handle := tasksByKey(t, tx, id)["create-project"].ExecutorHandle
	cancelExecution(t, tx, id)

	exec.CancelError = errors.New("delete timed out")
	outcome := k.tick(t0.Add(time.Second))
	tk := tasksByKey(t, tx, id)["create-project"]
	equal(t, "state", tk.State, domain.TaskRunning)
	equal(t, "lease renewed", tk.LeaseExpiresAt.After(t0.Add(time.Second)), true)
	equal(t, "nothing to release", len(outcome.Finished), 0)

	exec.CancelError = nil
	outcome = k.tick(t0.Add(2 * time.Second))
	equal(t, "state", tasksByKey(t, tx, id)["create-project"].State, domain.TaskCancelled)
	equal(t, "cancelled", exec.Cancelled, []string{handle["fakeId"].(string)})
	equal(t, "finished, to release", outcome.Finished, []executor.Handle{handle})
}

func TestACancelledExecutionsStepIsGivenUpOnPastItsJobsDeadline(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-cancel-deadline", task("create-project", timeout(30)))
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	cancelExecution(t, tx, id)
	exec.CancelError = errors.New("forbidden")
	k.tick(t0.Add(30*time.Second + k.opts.StartTimeout + k.opts.JobDeadlineGrace + executor.PodTerminationGrace + time.Second))
	equal(t, "state", tasksByKey(t, tx, id)["create-project"].State, domain.TaskCancelled)
}

// A step failing for now after its execution failed waits READY for the
// failed step's retry, which resumes the execution; then both run.
func TestARetryableFailureInAFailedExecutionRunsOnceItsResumed(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-failed-sibling", task("a"), task("b", maxAttempts(2)))
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	tasks := tasksByKey(t, tx, id)
	exec.Fail(tasks["a"].ExecutorHandle, domain.StructuredError{Code: "BOOM", Message: "failed"})
	k.tick(t0.Add(time.Second))
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionFailed)

	exec.Fail(tasks["b"].ExecutorHandle, domain.StructuredError{Code: "FLAKY", Message: "for now", Retryable: true})
	k.tick(t0.Add(2 * time.Second))
	equal(t, "b", tasksByKey(t, tx, id)["b"].State, domain.TaskReady)
	k.tick(t0.Add(time.Hour)) // its backoff long past: still not claimed
	equal(t, "b", tasksByKey(t, tx, id)["b"].State, domain.TaskReady)

	retryTask(t, tx, id, "a", t0.Add(time.Hour))
	k.tick(t0.Add(time.Hour + time.Second))
	tasks = tasksByKey(t, tx, id)
	equal(t, "a", tasks["a"].State, domain.TaskRunning)
	equal(t, "b", tasks["b"].State, domain.TaskRunning)
	equal(t, "b's attempts", tasks["b"].AttemptCount, 2)
}

// A claim locks each claimed task's execution too, never waiting for it.
// While a cancel holds the execution's row, a READY task it didn't lock
// (one a retry made READY after the cancel's own update read the tasks) is
// passed over rather than started; once the cancel commits, it never is.
// Before, the claim locked the task alone, and so started a step of an
// execution being cancelled. Committed rows across two connections.
func TestAClaimSkipsAnExecutionBeingCancelled(t *testing.T) {
	for _, state := range []string{"PENDING", "RUNNING"} {
		t.Run(state, func(t *testing.T) { claimWhileCancelling(t, state) })
	}
}

func claimWhileCancelling(t *testing.T, state string) {
	ctx := context.Background()
	var id string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		id = submit(t, tx, "idem-claim-cancel-race-"+state, task("only"))
		_, err := tx.Exec(ctx, `UPDATE executions SET state = $2 WHERE id = $1`, id, state)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id) })
	exec := fake()
	opts := DefaultOptions("scheduler-1")
	committedPass := func() {
		t.Helper()
		done := make(chan error, 1)
		go func() {
			done <- pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
				_, err := DispatchPass(ctx, tx, exec, opts, time.Now(), quietLog)
				return err
			})
		}()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the claim waited for the cancel's lock")
		}
	}

	cancel, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cancel.Rollback(ctx) }()
	if moved, err := transitionExecution(ctx, cancel, id, domain.ExecutionCancelled, domain.ActiveExecutionStates...); err != nil || !moved {
		t.Fatalf("cancel: moved=%v err=%v", moved, err)
	}
	committedPass()
	equal(t, "starts while being cancelled", len(exec.StartCalls), 0)
	equal(t, "task", tasksByKey(t, testPool, id)["only"].State, domain.TaskReady)

	if err := cancel.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	committedPass()
	equal(t, "starts once cancelled", len(exec.StartCalls), 0)
	equal(t, "task", tasksByKey(t, testPool, id)["only"].State, domain.TaskReady)
}

// A pass that claimed a task holds its execution's row until it commits, so
// a cancel waits for the dispatch rather than landing between the claim and
// the start.
func TestAClaimHoldsItsExecutionUntilItCommits(t *testing.T) {
	ctx := context.Background()
	var id string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		id = submit(t, tx, "idem-claim-holds-execution", task("a"), task("b", dependsOn("a")))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id) })
	// Already RUNNING, so marking it started doesn't take the lock instead.
	if _, err := testPool.Exec(ctx, `UPDATE executions SET state = 'RUNNING' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	scheduler, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = scheduler.Rollback(ctx) }()
	exec := fake()
	if _, err := DispatchPass(ctx, scheduler, exec, DefaultOptions("scheduler-1"), time.Now(), quietLog); err != nil {
		t.Fatal(err)
	}
	equal(t, "started", len(exec.Started), 1)
	_, err = testPool.Exec(ctx, `SELECT id FROM executions WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, id)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatalf("the execution's row was free while its task was being dispatched: %v", err)
	}
}

// Only a claimed task's execution is locked for the pass: one whose task is
// passed over (its team at its cap) stays free, so its cancel and its
// settling aren't held up by a dispatch that started none of it.
func TestAPassedOverTasksExecutionStaysUnlocked(t *testing.T) {
	ctx := context.Background()
	var first, second string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		first = submit(t, tx, "idem-claim-passed-over-1", task("only"))
		second = submit(t, tx, "idem-claim-passed-over-2", task("only"))
		_, err := tx.Exec(ctx, `UPDATE executions SET state = 'RUNNING' WHERE id = ANY($1::uuid[])`, []string{first, second})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = ANY($1::uuid[])`, []string{first, second})
	})
	scheduler, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = scheduler.Rollback(ctx) }()
	exec := fake()
	opts := DefaultOptions("scheduler-1")
	opts.MaxRunningPerTeam = 1
	if _, err := DispatchPass(ctx, scheduler, exec, opts, time.Now(), quietLog); err != nil {
		t.Fatal(err)
	}
	equal(t, "started", len(exec.Started), 1)
	locked := 0
	for _, id := range []string{first, second} {
		_, err := testPool.Exec(ctx, `SELECT id FROM executions WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, id)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
			locked++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	equal(t, "executions locked", locked, 1)
	// Nor is the passed-over task's row (only the claimed one's is): a
	// cancel updates the execution's READY tasks first, and would wait for
	// this pass.
	lockedTasks := 0
	for _, id := range []string{first, second} {
		_, err := testPool.Exec(ctx, `SELECT id FROM execution_tasks WHERE execution_id = $1 FOR UPDATE NOWAIT`, id)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
			lockedTasks++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	equal(t, "task rows locked", lockedTasks, 1)
}

// An execution held elsewhere (a cancel, another scheduler) takes no claim
// slot: its older READY tasks are passed over and the pass fills its limit
// from the rest, rather than claiming them and dropping them after.
func TestAHeldExecutionTakesNoClaimSlot(t *testing.T) {
	ctx := context.Background()
	var held, other string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		held = submit(t, tx, "idem-claim-held-slot-1", task("a"), task("b"))
		other = submit(t, tx, "idem-claim-held-slot-2", task("only"))
		if _, err := tx.Exec(ctx, `UPDATE executions SET state = 'RUNNING' WHERE id = ANY($1::uuid[])`, []string{held, other}); err != nil {
			return err
		}
		// The held execution's tasks come first.
		_, err := tx.Exec(ctx, `UPDATE execution_tasks SET available_at = now() - interval '1 hour' WHERE execution_id = $1`, held)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = ANY($1::uuid[])`, []string{held, other})
	})
	holder, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if _, err := holder.Exec(ctx, `SELECT id FROM executions WHERE id = $1 FOR NO KEY UPDATE`, held); err != nil {
		t.Fatal(err)
	}
	exec := fake()
	opts := DefaultOptions("scheduler-1")
	opts.ClaimLimit = 1
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		_, err := DispatchPass(ctx, tx, exec, opts, time.Now(), quietLog)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	equal(t, "started", len(exec.Started), 1)
	equal(t, "the other execution's", tasksByKey(t, testPool, other)["only"].State, domain.TaskRunning)
}

// A task left waiting in a cancelled execution (by a writer that raced the
// cancel) is cancelled by the scheduler's sweep, with its event; one whose
// row someone holds is left for the next sweep, never waited for.
func TestStrandedTasksAreCancelled(t *testing.T) {
	ctx := context.Background()
	var id string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		id = submit(t, tx, "idem-stranded", task("a"), task("b"))
		_, err := tx.Exec(ctx, `UPDATE executions SET state = 'CANCELLED' WHERE id = $1`, id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id) })
	holder, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if _, err := holder.Exec(ctx, `SELECT id FROM execution_tasks WHERE execution_id = $1 AND task_key = 'b' FOR UPDATE`, id); err != nil {
		t.Fatal(err)
	}
	sweep := func() int {
		t.Helper()
		var n int
		if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
			var err error
			n, err = CancelStranded(ctx, tx, quietLog)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := sweep(); n < 1 {
		t.Fatalf("swept %d", n)
	}
	tasks := tasksByKey(t, testPool, id)
	equal(t, "a", tasks["a"].State, domain.TaskCancelled)
	equal(t, "b, held", tasks["b"].State, domain.TaskReady)
	var events int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM execution_events WHERE execution_id = $1 AND event_type = $2`, id, string(domain.EventTaskCancelled)).Scan(&events); err != nil {
		t.Fatal(err)
	}
	equal(t, "events", events, 1)
	if err := holder.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	sweep()
	equal(t, "b, once free", tasksByKey(t, testPool, id)["b"].State, domain.TaskCancelled)
}
