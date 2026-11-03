// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/rburns629/vertra/kernel/internal/domain"
	"github.com/rburns629/vertra/kernel/internal/executor"
)

// The sweep that removes attempts' Jobs no task can use any more (R4 in
// docs/assessment.md). The case it exists for: a pass starts a task's Job,
// its commit fails (the task is READY again, one attempt behind the Job),
// and the execution is cancelled before any pass claims the task again. The
// sweep must never touch a Job a task still needs: the running attempt's,
// or the one a ready task will adopt.

// startAsARolledBackPassWould starts the attempt the task's next claim
// would make, without recording it.
func startAsARolledBackPassWould(t *testing.T, exec *fakeExec, tk *Task) string {
	t.Helper()
	handle, err := exec.Start(context.Background(), executor.ResolvedTask{
		ExecutionID: tk.ExecutionID, TaskKey: tk.TaskKey, Image: tk.Image, Action: tk.Action,
		Attempt: tk.AttemptCount + 1, TimeoutSeconds: tk.TimeoutSeconds, Team: tk.Team, ServiceAccount: tk.ServiceAccount,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handle["fakeId"].(string)
}

func ageEverything(exec *fakeExec, by time.Duration) {
	for _, a := range exec.Launched {
		a.CreatedAt = a.CreatedAt.Add(-by)
	}
}

func sweep(t *testing.T, db DB, exec executor.Executor) int {
	t.Helper()
	n, err := ReleaseOrphanedAttempts(context.Background(), db, exec, time.Now().Add(-OrphanMinAge), quietLog)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestAJobLeftForATaskCancelledBeforeItsRetryIsRemoved(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "orphan-cancelled", task("provision"))
	exec := fake()
	orphan := startAsARolledBackPassWould(t, exec, tasksByKey(t, tx, id)["provision"])
	cancelExecution(t, tx, id)
	ageEverything(exec, 10*time.Minute)
	equal(t, "swept", sweep(t, tx, exec), 1)
	equal(t, "released", exec.Released, []string{orphan})
}

func TestTheJobAReadyTaskWillAdoptIsKept(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "orphan-adoptable", task("provision"))
	exec := fake()
	startAsARolledBackPassWould(t, exec, tasksByKey(t, tx, id)["provision"])
	ageEverything(exec, 10*time.Minute)
	equal(t, "swept", sweep(t, tx, exec), 0)
	equal(t, "released", len(exec.Released), 0)
}

func TestARunningTasksCurrentJobIsKeptAndItsEarlierOnesRemoved(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "orphan-earlier", task("provision", maxAttempts(2)))
	exec := fake()
	k := newTicker(t, tx, exec)
	k.opts.Owner = "s-1"
	t0 := time.Now()
	k.tick(t0)
	first := tasksByKey(t, tx, id)["provision"].ExecutorHandle
	exec.Fail(first, domain.StructuredError{Code: "FLAKY", Message: "flaky", Retryable: true})
	// Its release after the commit never happened (nothing releases here).
	k.tick(t0.Add(time.Second))
	k.tick(t0.Add(60 * time.Second))
	second := tasksByKey(t, tx, id)["provision"].ExecutorHandle
	if second == nil || second["fakeId"] == first["fakeId"] {
		t.Fatalf("second attempt = %v, first = %v", second, first)
	}
	ageEverything(exec, 10*time.Minute)
	equal(t, "swept", sweep(t, tx, exec), 1)
	equal(t, "released", exec.Released, []string{first["fakeId"].(string)})
}

func TestAYoungJobIsLeftAlone(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "orphan-young", task("provision"))
	exec := fake()
	startAsARolledBackPassWould(t, exec, tasksByKey(t, tx, id)["provision"])
	cancelExecution(t, tx, id)
	equal(t, "swept", sweep(t, tx, exec), 0)
}

func TestAJobWhoseExecutionIsGoneIsRemoved(t *testing.T) {
	tx := txFor(t)
	exec := fake()
	handle, err := exec.Start(context.Background(), executor.ResolvedTask{
		ExecutionID: "00000000-0000-0000-0000-00000000dead", TaskKey: "gone", Image: "demo-project-product:local",
		Action: "create", Attempt: 1, TimeoutSeconds: 60, Team: "test-team", ServiceAccount: "default",
	})
	if err != nil {
		t.Fatal(err)
	}
	ageEverything(exec, 10*time.Minute)
	equal(t, "swept", sweep(t, tx, exec), 1)
	equal(t, "released", exec.Released, []string{handle["fakeId"].(string)})
}
