// SPDX-License-Identifier: MIT

package scheduler

import (
	"errors"
	"testing"
	"time"

	"github.com/roburns/vennir/kernel/internal/domain"
	"github.com/roburns/vennir/kernel/internal/executor"
)

const later = time.Hour // past any backoff

func only(attempts int) TaskDef {
	return task("only", maxAttempts(attempts), func(d *TaskDef) { d.Image, d.Action = "x:1", "run" })
}

func dispatchTicker(t *testing.T, db DB, exec executor.Executor, failures int) *ticker {
	k := newTicker(t, db, exec)
	k.opts.Owner = "test"
	k.opts.MaxDispatchFailures = failures
	return k
}

func startAttempts(calls []executor.ResolvedTask) []int {
	var attempts []int
	for _, c := range calls {
		attempts = append(attempts, c.Attempt)
	}
	return attempts
}

// A start that raises may still have made the Job: the same attempt is
// retried (its start adopts that Job), not a new one started beside it.
func TestAStartThatRaisesRetriesTheSameAttemptLater(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "dispatch-retry-same", only(3))
	exec := fake()
	k := dispatchTicker(t, tx, exec, 3)
	t0 := time.Now()
	exec.StartError = errors.New("read timed out")
	k.tick(t0)
	tk := tasksByKey(t, tx, id)["only"]
	equal(t, "state", tk.State, domain.TaskReady)
	equal(t, "attempts", tk.AttemptCount, 0) // the claim was handed back
	equal(t, "dispatch failures", tk.DispatchFailures, 1)
	equal(t, "after a backoff", tk.AvailableAt.After(t0), true)
	equal(t, "attempt rows", len(attemptsOf(t, tx, tk.ID)), 0)
	found := false
	for _, e := range events(t, tx, id) {
		found = found || e.Type == "TASK_DISPATCH_RETRY"
	}
	equal(t, "dispatch retry event", found, true)

	exec.StartError = nil
	k.tick(t0.Add(later))
	tk = tasksByKey(t, tx, id)["only"]
	equal(t, "start attempts", startAttempts(exec.StartCalls), []int{1, 1})
	equal(t, "state", tk.State, domain.TaskRunning)
	equal(t, "attempts", tk.AttemptCount, 1)
	equal(t, "dispatch failures", tk.DispatchFailures, 0)
	equal(t, "attempt rows", len(attemptsOf(t, tx, tk.ID)), 1)
	equal(t, "discarded", len(exec.Discarded), 0)
}

func TestGivesUpOnTheAttemptAfterTheLimitAndDiscardsIt(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "dispatch-retry-limit", only(3))
	exec := fake()
	exec.StartError = errors.New("read timed out")
	k := dispatchTicker(t, tx, exec, 3)
	now := time.Now()
	for range 3 {
		k.tick(now)
		now = now.Add(later)
	}
	tk := tasksByKey(t, tx, id)["only"]
	// Three starts of attempt 1; the third fails it (retryable: attempt 2
	// comes next) and removes what it left.
	equal(t, "start attempts", startAttempts(exec.StartCalls), []int{1, 1, 1})
	equal(t, "discarded", startAttempts(exec.Discarded), []int{1})
	equal(t, "state", tk.State, domain.TaskReady)
	equal(t, "attempts", tk.AttemptCount, 1)
	equal(t, "dispatch failures", tk.DispatchFailures, 0)
	rows := attemptsOf(t, tx, tk.ID)
	equal(t, "failure", rows[0].Failure["code"], "EXECUTOR_START_FAILED")
	exec.StartError = nil
	k.tick(now)
	equal(t, "next attempt", exec.StartCalls[len(exec.StartCalls)-1].Attempt, 2)
}

func TestALastAttemptGivenUpFailsTheTask(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "dispatch-retry-last", only(1))
	exec := fake()
	exec.StartError = errors.New("read timed out")
	k := dispatchTicker(t, tx, exec, 2)
	now := time.Now()
	for range 2 {
		k.tick(now)
		now = now.Add(later)
	}
	tk := tasksByKey(t, tx, id)["only"]
	equal(t, "state", tk.State, domain.TaskFailed)
	equal(t, "code", tk.Failure["code"], "EXECUTOR_START_FAILED")
	equal(t, "discarded", len(exec.Discarded), 1)
}

func TestARefusedStartFailsAtOnceAndDiscardsWhatItLeft(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "dispatch-refused", only(3))
	exec := fake()
	exec.StartError = &executor.DispatchRejected{Code: "IMAGE_NOT_ALLOWED", Message: "not allowed"}
	dispatchTicker(t, tx, exec, 3).tick(time.Now())
	equal(t, "state", tasksByKey(t, tx, id)["only"].State, domain.TaskFailed)
	equal(t, "starts", len(exec.StartCalls), 1)
	equal(t, "discarded", len(exec.Discarded), 1)
}

// The team a step runs for reaches its request.json, beside the namespace
// it runs in; a step without one has none.
func TestAStepIsStartedForTheTeamItRunsFor(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "for-team", task("shared", team("owner"), forTeam("consumer")), task("own", team("owner")))
	exec := fake()
	dispatchTicker(t, tx, exec, 5).tick(time.Now())
	got := map[string]string{}
	for _, s := range exec.Started {
		got[s.TaskKey] = s.Team + "/" + s.ProductRequest().ForTeam
	}
	equal(t, "started", got, map[string]string{"shared": "owner/consumer", "own": "owner/"})
}

// The scheduler was down past the task's timeout; its Job had succeeded.
func TestASuccessSeenLateCountsAndIsntRunAgain(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "late-success", task("only", timeout(300), maxAttempts(2)))
	exec := fake()
	k := dispatchTicker(t, tx, exec, 5)
	t0 := time.Now()
	k.tick(t0)
	exec.Complete(executor.Handle{"fakeId": "1"}, map[string]any{"done": true})
	k.tick(t0.Add(400 * time.Second))
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionSucceeded)
	equal(t, "task", tasksByKey(t, tx, id)["only"].State, domain.TaskSucceeded)
	equal(t, "started", len(exec.Started), 1)
	equal(t, "cancelled", len(exec.Cancelled), 0)
}

func TestATaskStillRunningPastItsTimeoutStillTimesOut(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "late-running", task("only", timeout(300)))
	exec := fake()
	k := dispatchTicker(t, tx, exec, 5)
	t0 := time.Now()
	k.tick(t0)
	k.tick(t0.Add(400 * time.Second))
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionFailed)
	equal(t, "task", tasksByKey(t, tx, id)["only"].State, domain.TaskFailed)
	equal(t, "cancelled", exec.Cancelled, []string{"1"})
}

func twoFailed(t *testing.T, key string) (DB, *ticker, *fakeExec, string, time.Time) {
	tx := txFor(t)
	id := submit(t, tx, key, task("a"), task("b"))
	exec := fake()
	k := dispatchTicker(t, tx, exec, 5)
	t0 := time.Now()
	k.tick(t0)
	boom := domain.StructuredError{Code: "BOOM", Message: "boom"}
	exec.Fail(executor.Handle{"fakeId": "1"}, boom)
	exec.Fail(executor.Handle{"fakeId": "2"}, boom)
	k.tick(t0.Add(time.Second))
	return tx, k, exec, id, t0
}

func TestTheExecutionFailsAgainWhenTheRetrySucceedsButOthersFailed(t *testing.T) {
	tx, k, exec, id, t0 := twoFailed(t, "two-failures")
	retryTask(t, tx, id, "a", t0.Add(time.Second))
	k.tick(t0.Add(2 * time.Second))
	exec.Complete(executor.Handle{"fakeId": "3"}, map[string]any{})
	k.tick(t0.Add(3 * time.Second))
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionFailed)
	tasks := tasksByKey(t, tx, id)
	equal(t, "a", tasks["a"].State, domain.TaskSucceeded)
	equal(t, "b", tasks["b"].State, domain.TaskFailed)
}

func TestRetryingEveryFailureCanStillSucceed(t *testing.T) {
	tx, k, exec, id, t0 := twoFailed(t, "retry-both")
	retryTask(t, tx, id, "a", t0.Add(time.Second))
	retryTask(t, tx, id, "b", t0.Add(time.Second))
	k.tick(t0.Add(2 * time.Second))
	exec.Complete(executor.Handle{"fakeId": "3"}, map[string]any{})
	k.tick(t0.Add(3 * time.Second))
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionRunning)
	exec.Complete(executor.Handle{"fakeId": "4"}, map[string]any{})
	k.tick(t0.Add(4 * time.Second))
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionSucceeded)
}
