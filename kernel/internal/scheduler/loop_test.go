// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/roburns/vennir/kernel/internal/domain"
	"github.com/roburns/vennir/kernel/internal/executor"
	"github.com/roburns/vennir/kernel/internal/executor/executortest"
)

// The loop's concurrency and shutdown. Waiting for the schema is tested in
// internal/migrate.

func TestCallsOverlapUpToTheLimitAndResultsKeepTheirOrder(t *testing.T) {
	var inFlight, most atomic.Int32
	items := []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}
	results, errs := gather(context.Background(), items, 4, func(v int) (int, error) {
		n := inFlight.Add(1)
		for {
			m := most.Load()
			if n <= m || most.CompareAndSwap(m, n) {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
		inFlight.Add(-1)
		return v, nil
	})
	equal(t, "results", results, items)
	equal(t, "errors", errs, make([]error, 10))
	equal(t, "most in flight", most.Load(), 4)
}

func TestAFailingCallYieldsItsErrorWithoutStoppingTheRest(t *testing.T) {
	results, errs := gather(context.Background(), []string{"ok", "boom", "ok"}, 2, func(s string) (string, error) {
		if s == "boom" {
			return "", errors.New("boom")
		}
		return s, nil
	})
	equal(t, "results", []string{results[0], results[2]}, []string{"ok", "ok"})
	equal(t, "error", errs[1] != nil && errs[0] == nil && errs[2] == nil, true)
}

// End to end: told to stop, the loop cuts its wait short, finishes, and
// hands back its leases.
func TestStoppingCutsTheWaitShortAndReleasesLeases(t *testing.T) {
	ctx := context.Background()
	var id string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		id = submit(t, tx, fmt.Sprintf("loop-stop-%d", time.Now().UnixNano()), task("only"))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id) })

	exec := fake()
	owner := fmt.Sprintf("loop-test-%d", time.Now().UnixNano())
	loop := &Loop{Pool: testPool, Executor: exec, Options: DefaultOptions(owner), PollInterval: time.Minute,
		RetentionDays: 36500, HeartbeatFile: filepath.Join(t.TempDir(), "heartbeat"), Log: quietLog}
	run, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- loop.Run(run) }()
	deadline := time.Now().Add(10 * time.Second)
	for tasksByKey(t, testPool, id)["only"].State != domain.TaskRunning {
		if time.Now().After(deadline) {
			t.Fatal("never dispatched")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := os.Stat(loop.HeartbeatFile); err != nil {
		t.Errorf("no heartbeat: %v", err)
	}
	time.Sleep(200 * time.Millisecond) // into its minute-long wait
	stopped := time.Now()
	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("still waiting")
	}
	equal(t, "stopped promptly", time.Since(stopped) < 2*time.Second, true)
	tk := tasksByKey(t, testPool, id)["only"]
	equal(t, "still running", tk.State, domain.TaskRunning)
	// Expired, not cleared: the next scheduler adopts it at once.
	equal(t, "lease handed back", tk.LeaseExpiresAt != nil && !tk.LeaseExpiresAt.After(time.Now()), true)
}

// blockingStart holds the Start of this test's tasks until release is
// closed, as an admission webhook waiting out its timeout does a Job's
// creation; any other ready task in the shared database passes straight on.
type blockingStart struct {
	*executortest.Fake
	ours     map[string]bool
	starting chan struct{}
	release  chan struct{}
}

func (b *blockingStart) Start(ctx context.Context, task executor.ResolvedTask) (executor.Handle, error) {
	if b.ours[task.ExecutionID] {
		b.starting <- struct{}{}
		<-b.release
	}
	return b.Fake.Start(ctx, task)
}

// Seen on GKE: a pass that dispatched held every finished task's record
// until its dispatches were done. Now what finished commits first.
func TestWhatFinishedIsCommittedBeforeASlowDispatch(t *testing.T) {
	ctx := context.Background()
	exec := &blockingStart{Fake: fake(), ours: map[string]bool{}, starting: make(chan struct{}, 1), release: make(chan struct{})}
	submitted := func(name string) string {
		var id string
		if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
			id = submit(t, tx, fmt.Sprintf("%s-%d", name, time.Now().UnixNano()), task("only"))
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id) })
		exec.ours[id] = true
		return id
	}
	loop := &Loop{Pool: testPool, Executor: exec, Options: DefaultOptions(fmt.Sprintf("loop-slow-%d", time.Now().UnixNano())), Log: quietLog}

	first := submitted("loop-first")
	close(exec.release) // the first dispatch goes through
	if _, err := loop.pass(ctx); err != nil {
		t.Fatal(err)
	}
	<-exec.starting
	exec.Complete(tasksByKey(t, testPool, first)["only"].ExecutorHandle, map[string]any{})

	exec.release = make(chan struct{}) // the next one hangs
	second := submitted("loop-second")
	done := make(chan error, 1)
	go func() { _, err := loop.pass(ctx); done <- err }()
	<-exec.starting
	// Mid-dispatch, from another connection: the first is already recorded.
	equal(t, "first", tasksByKey(t, testPool, first)["only"].State, domain.TaskSucceeded)
	equal(t, "first's execution", executionState(t, testPool, first), domain.ExecutionSucceeded)
	close(exec.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	equal(t, "second", tasksByKey(t, testPool, second)["only"].State, domain.TaskRunning)
}

// poisonedStart starts this test's tasks with a handle the database can't
// store (jsonb refuses \u0000), so the dispatch half's transaction fails
// after it started them; any other ready task passes straight on.
type poisonedStart struct {
	*executortest.Fake
	ours map[string]bool
}

func (p *poisonedStart) Start(ctx context.Context, task executor.ResolvedTask) (executor.Handle, error) {
	handle, err := p.Fake.Start(ctx, task)
	if err == nil && p.ours[task.ExecutionID] {
		handle["poison"] = "\x00"
	}
	return handle, err
}

// A dispatch that fails after what finished was committed: that stands,
// and its handle is still handed back for release; the claim rolls back.
func TestAFailedDispatchKeepsWhatWasRecordedAndHandsItBack(t *testing.T) {
	ctx := context.Background()
	exec := &poisonedStart{Fake: fake(), ours: map[string]bool{}}
	submitted := func(name string) string {
		var id string
		if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
			id = submit(t, tx, fmt.Sprintf("%s-%d", name, time.Now().UnixNano()), task("only"))
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id) })
		return id
	}
	loop := &Loop{Pool: testPool, Executor: exec, Options: DefaultOptions(fmt.Sprintf("loop-failed-%d", time.Now().UnixNano())), Log: quietLog}

	first := submitted("loop-recorded")
	if _, err := loop.pass(ctx); err != nil {
		t.Fatal(err)
	}
	handle := tasksByKey(t, testPool, first)["only"].ExecutorHandle
	exec.Complete(handle, map[string]any{})

	second := submitted("loop-poisoned")
	exec.ours[second] = true
	outcome, err := loop.pass(ctx)
	if err == nil {
		t.Fatal("the dispatch didn't fail")
	}
	equal(t, "handed back", outcome.Finished, []executor.Handle{handle})
	equal(t, "first", tasksByKey(t, testPool, first)["only"].State, domain.TaskSucceeded)
	equal(t, "first's execution", executionState(t, testPool, first), domain.ExecutionSucceeded)
	tk := tasksByKey(t, testPool, second)["only"]
	equal(t, "second", tk.State, domain.TaskReady)
	equal(t, "second's attempts", tk.AttemptCount, 0)
}

// The heartbeat is touched between a pass's phases too, so the probe
// bounds the slowest phase rather than their sum.
func TestAPassTouchesTheHeartbeatBetweenItsPhases(t *testing.T) {
	loop := &Loop{Pool: testPool, Executor: fake(), Options: DefaultOptions(fmt.Sprintf("loop-heartbeat-%d", time.Now().UnixNano())),
		HeartbeatFile: filepath.Join(t.TempDir(), "heartbeat"), Log: quietLog}
	if _, err := loop.pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(loop.HeartbeatFile); err != nil {
		t.Errorf("no heartbeat: %v", err)
	}
}
