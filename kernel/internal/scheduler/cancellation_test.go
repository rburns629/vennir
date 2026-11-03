// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/rburns629/vertra/kernel/internal/domain"
	"github.com/rburns629/vertra/kernel/internal/executor"
)

// Ported from the Python kernel's tests/integration/test_cancellation_and_retry.py: the
// scheduler's side of cancelling and manually retrying (kernel-api's own
// outcomes stay with its Python tests until it moves).

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
	k.tick(t0.Add(30*time.Second + k.opts.StartTimeout + k.opts.JobDeadlineGrace + time.Second))
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
