// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"testing"
	"time"

	"github.com/roburns/vennir/kernel/internal/domain"
)

// A step that needs an approval waits for it, never claimed, and fails if
// nobody decides in time (kernel-api's DecideApproval decides).

func TestAStepAwaitingApprovalIsNeverClaimed(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "approval-unclaimed", task("gated", needsApproval))
	equal(t, "claimed", len(claim(t, tx, "scheduler-1", time.Minute, time.Now())), 0)
}

func TestADependentThatNeedsApprovalAwaitsItOnceReleased(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "approval-dependent", task("first"), task("second", dependsOn("first"), needsApproval))
	exec := fake()
	k := newTicker(t, tx, exec)
	now := time.Now()
	k.tick(now)
	exec.Complete(tasksByKey(t, tx, id)["first"].ExecutorHandle, map[string]any{})
	k.tick(now.Add(time.Second))
	equal(t, "second", tasksByKey(t, tx, id)["second"].State, domain.TaskAwaitingApproval)
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionRunning)
	k.tick(now.Add(2 * time.Second))
	equal(t, "still", tasksByKey(t, tx, id)["second"].State, domain.TaskAwaitingApproval)

	// Approved (as kernel-api approves), it runs.
	if _, err := tx.Exec(context.Background(), `UPDATE execution_tasks SET state = 'READY', approved_at = now(), approved_by = 'user:1'
		WHERE execution_id = $1 AND task_key = 'second'`, id); err != nil {
		t.Fatal(err)
	}
	k.tick(now.Add(3 * time.Second))
	equal(t, "approved", tasksByKey(t, tx, id)["second"].State, domain.TaskRunning)
}

func TestAnUndecidedApprovalExpiresAndFailsTheExecution(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "approval-expiry", task("gated", needsApproval), task("after", dependsOn("gated")))
	k := newTicker(t, tx, fake())
	k.opts.ApprovalTimeout = time.Hour
	now := time.Now()
	k.tick(now.Add(59 * time.Minute))
	equal(t, "before the timeout", tasksByKey(t, tx, id)["gated"].State, domain.TaskAwaitingApproval)
	k.tick(now.Add(61 * time.Minute))
	tasks := tasksByKey(t, tx, id)
	equal(t, "gated", tasks["gated"].State, domain.TaskFailed)
	equal(t, "code", tasks["gated"].Failure["code"], "APPROVAL_EXPIRED")
	equal(t, "after", tasks["after"].State, domain.TaskCancelled)
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionFailed)
	equal(t, "events", eventTypes(t, tx, id), []string{"EXECUTION_CREATED", "TASK_FAILED", "EXECUTION_FAILED"})

	// Failing it, the pass settles the execution as a finishing one does,
	// so it can't deadlock with another scheduler's settling.
	var free bool
	if err := testPool.QueryRow(context.Background(), `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`, "settle:"+id).Scan(&free); err != nil {
		t.Fatal(err)
	}
	equal(t, "another scheduler may settle it", free, false)
}

func TestNoTimeoutNeverExpires(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "approval-forever", task("gated", needsApproval))
	k := newTicker(t, tx, fake())
	k.opts.ApprovalTimeout = 0
	k.tick(time.Now().Add(365 * 24 * time.Hour))
	equal(t, "gated", tasksByKey(t, tx, id)["gated"].State, domain.TaskAwaitingApproval)
}
