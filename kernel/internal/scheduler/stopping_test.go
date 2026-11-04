// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/rburns629/vennir/kernel/internal/domain"
	"github.com/rburns629/vennir/kernel/internal/executor"
	"github.com/rburns629/vennir/kernel/internal/executor/executortest"
)

// An attempt is only given up on once it's known to have stopped, and a
// finished task's Job is only removed after its outcome is committed.

const grace = 600 * time.Second

func provision() TaskDef {
	return task("provision", maxAttempts(2), timeout(30))
}

func stoppingTicker(t *testing.T, db DB, exec executor.Executor) *ticker {
	k := newTicker(t, db, exec)
	k.opts.JobDeadlineGrace = grace
	return k
}

func TestAFailedStatusReadKeepsTheTaskRunning(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "status-read-fails", provision())
	exec := fake()
	k := stoppingTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	handle := tasksByKey(t, tx, id)["provision"].ExecutorHandle

	exec.StatusError = errors.New("read timed out")
	k.tick(t0.Add(10 * time.Second))
	tk := tasksByKey(t, tx, id)["provision"]
	equal(t, "state", tk.State, domain.TaskRunning)
	equal(t, "attempts", tk.AttemptCount, 1)
	want := t0.Add(10 * time.Second).Add(k.opts.LeaseDuration).Truncate(time.Microsecond)
	equal(t, "lease still ours", tk.LeaseExpiresAt.Equal(want), true)
	equal(t, "cancelled", len(exec.Cancelled), 0)

	exec.StatusError = nil
	exec.Complete(handle, map[string]any{"projectId": "p-1"})
	k.tick(t0.Add(20 * time.Second))
	equal(t, "state", tasksByKey(t, tx, id)["provision"].State, domain.TaskSucceeded)
	equal(t, "started", len(exec.Started), 1)
}

func TestATimedOutTaskIsStoppedBeforeItsRetry(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "timeout-stopped", provision())
	exec := fake()
	k := stoppingTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	handle := tasksByKey(t, tx, id)["provision"].ExecutorHandle

	exec.StatusError = errors.New("read timed out") // nothing known about it
	k.tick(t0.Add(31 * time.Second))
	equal(t, "cancelled", exec.Cancelled, []string{handle["fakeId"].(string)})
	tk := tasksByKey(t, tx, id)["provision"]
	equal(t, "state", tk.State, domain.TaskReady) // retried, now that it's stopped
	equal(t, "attempts", tk.AttemptCount, 1)
}

func TestATimedOutTaskThatCantBeStoppedWaitsForItsJobsDeadline(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "timeout-unstoppable", provision())
	exec := fake()
	k := stoppingTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)

	exec.StatusError = errors.New("read timed out")
	exec.CancelError = errors.New("delete timed out")
	k.tick(t0.Add(31 * time.Second))
	equal(t, "state", tasksByKey(t, tx, id)["provision"].State, domain.TaskRunning) // no retry beside it
	equal(t, "starts", len(exec.StartCalls), 1)

	// Short of the Job's deadline (it allows for the wait to start too), it
	// may still be running.
	deadline := 30*time.Second + k.opts.StartTimeout + grace + executor.PodTerminationGrace
	k.tick(t0.Add(deadline))
	equal(t, "state", tasksByKey(t, tx, id)["provision"].State, domain.TaskRunning)

	// Past it, Kubernetes has stopped the Job itself.
	k.tick(t0.Add(deadline + time.Second))
	tk := tasksByKey(t, tx, id)["provision"]
	equal(t, "state", tk.State, domain.TaskReady)
	equal(t, "attempts", tk.AttemptCount, 1)
}

func TestAFinishedTaskIsHandedBackForReleaseNotReleased(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "release-after-commit", provision())
	exec := fake()
	k := stoppingTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	handle := tasksByKey(t, tx, id)["provision"].ExecutorHandle
	exec.Complete(handle, map[string]any{"projectId": "p-1"})

	outcome := k.tick(t0.Add(5 * time.Second))
	equal(t, "finished", outcome.Finished, []executor.Handle{handle})
	equal(t, "released", len(exec.Released), 0) // not committed: the caller releases

	ReleaseFinished(context.Background(), exec, outcome.Finished, quietLog)
	equal(t, "released", exec.Released, []string{handle["fakeId"].(string)})
}

type flakyRelease struct{ *executortest.Fake }

func (f flakyRelease) Release(ctx context.Context, handle executor.Handle) error {
	if handle["fakeId"] == "1" {
		return errors.New("delete timed out")
	}
	return f.Fake.Release(ctx, handle)
}

func TestAReleaseThatFailsDoesntStopTheOthers(t *testing.T) {
	exec := flakyRelease{fake()}
	ReleaseFinished(context.Background(), exec, []executor.Handle{{"fakeId": "1"}, {"fakeId": "2"}}, quietLog)
	equal(t, "released", exec.Released, []string{"2"})
}
