// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/roburns/vennir/kernel/internal/domain"
	"github.com/roburns/vennir/kernel/internal/executor"
)

// Two schedulers finishing tasks of the same execution at the same moment.
// Without locking, each saw the other's task as still running: a task whose
// two dependencies finished together was never released, and an execution
// whose last two tasks finished together never completed. Committed rows
// across two connections, cleaned up after.

const trials = 5

func runTwoSchedulers(t *testing.T, tasks ...TaskDef) (domain.ExecutionState, map[string]domain.TaskState) {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		id = submit(t, tx, "concurrent-completion-"+time.Now().Format(time.RFC3339Nano), tasks...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id) }()

	now := time.Now()
	execs := map[string]*fakeExec{"s1": fake(), "s2": fake()}
	committedTick := func(owner string, claimLimit int, at time.Time) error {
		opts := DefaultOptions(owner)
		opts.ClaimLimit = claimLimit
		return pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
			_, err := RunTick(ctx, tx, execs[owner], opts, at, quietLog)
			return err
		})
	}
	for _, owner := range []string{"s1", "s2"} {
		if err := committedTick(owner, 1, now); err != nil {
			t.Fatal(err)
		}
	}
	for _, exec := range execs {
		exec.Complete(executor.Handle{"fakeId": "1"}, map[string]any{})
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, owner := range []string{"s1", "s2"} {
		wg.Go(func() { errs <- committedTick(owner, 0, now.Add(time.Second)) })
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	states := map[string]domain.TaskState{}
	for key, tk := range tasksByKey(t, testPool, id) {
		states[key] = tk.State
	}
	return executionState(t, testPool, id), states
}

func TestATaskWhoseDependenciesFinishTogetherIsReleased(t *testing.T) {
	for range trials {
		_, states := runTwoSchedulers(t, task("a"), task("b"), task("d", dependsOn("a", "b")))
		equal(t, "d", states["d"], domain.TaskReady)
	}
}

func TestAnExecutionWhoseLastTasksFinishTogetherCompletes(t *testing.T) {
	for range trials {
		state, states := runTwoSchedulers(t, task("a"), task("b"))
		if state != domain.ExecutionSucceeded {
			t.Errorf("execution = %s, tasks %v", state, states)
		}
	}
}

// A pass that finished a task of an execution holds its settling until it
// commits, so another scheduler's pass waits rather than locking the same
// dependents in another order (a deadlock).
func TestAPassHoldsTheSettlingOfAnExecutionItFinishedATaskOf(t *testing.T) {
	ctx := context.Background()
	tx := txFor(t)
	id := submit(t, tx, "idem-settling", task("a"), task("b"), task("join", dependsOn("a", "b")))
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	exec.Complete(tasksByKey(t, tx, id)["a"].ExecutorHandle, map[string]any{})
	k.tick(t0.Add(time.Second))

	var free bool
	if err := testPool.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`, "settle:"+id).Scan(&free); err != nil {
		t.Fatal(err)
	}
	equal(t, "another scheduler may settle it", free, false)
}
