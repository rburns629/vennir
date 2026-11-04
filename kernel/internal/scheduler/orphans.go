// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/rburns629/vennir/kernel/internal/domain"
	"github.com/rburns629/vennir/kernel/internal/executor"
)

// Normally every Job is released once its task's outcome is committed.
// What that misses: a Job started in a pass whose commit then failed, for a
// task cancelled before any pass claimed it again; a release that failed; a
// Job whose execution was deleted. Every few minutes the scheduler lists
// the attempts that still exist and releases the ones no task needs.

// OrphanMinAge is how old an attempt must be before the sweep considers it:
// well past any pass still settling it.
const OrphanMinAge = 5 * time.Minute

func sameHandle(a, b executor.Handle) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if w, ok := b[k]; !ok || w != v {
			return false
		}
	}
	return true
}

// stillNeeded says whether a task may still use this attempt's unit.
func stillNeeded(attempt executor.LaunchedAttempt, t *Task) bool {
	if t == nil {
		return false
	}
	switch t.State {
	case domain.TaskRunning:
		return sameHandle(t.ExecutorHandle, attempt.Handle)
	case domain.TaskReady, domain.TaskClaimed:
		// A pass that started this attempt and rolled back left the task
		// READY one attempt behind it; its next claim takes this attempt's
		// number and adopts the Job.
		return attempt.Attempt == t.AttemptCount+1 || (t.State == domain.TaskClaimed && attempt.Attempt == t.AttemptCount)
	}
	return false // finished, or BLOCKED (never started)
}

// ReleaseOrphanedAttempts releases every attempt created before olderThan
// that no task needs, and returns how many. It only reads the database.
func ReleaseOrphanedAttempts(ctx context.Context, db DB, exec executor.Executor, olderThan time.Time, log *slog.Logger) (int, error) {
	listed, err := exec.ListAttempts(ctx)
	if err != nil {
		return 0, err
	}
	var attempts []executor.LaunchedAttempt
	ids := map[string]bool{}
	for _, a := range listed {
		if a.CreatedAt.Before(olderThan) {
			attempts = append(attempts, a)
			ids[a.ExecutionID] = true
		}
	}
	tasks := map[[2]string]*Task{}
	if len(ids) > 0 {
		var executionIDs []string
		for id := range ids {
			executionIDs = append(executionIDs, id)
		}
		// Ids that aren't UUIDs (not this kernel's) simply match nothing.
		rows, err := db.Query(ctx, `SELECT `+taskColumns+` FROM execution_tasks
			WHERE execution_id::text = ANY($1)`, executionIDs)
		if err != nil {
			return 0, err
		}
		found, err := scanTasks(rows)
		if err != nil {
			return 0, err
		}
		for _, t := range found {
			tasks[[2]string{t.ExecutionID, t.TaskKey}] = t
		}
	}
	released := 0
	for _, a := range attempts {
		t := tasks[[2]string{a.ExecutionID, a.TaskKey}]
		if stillNeeded(a, t) {
			continue
		}
		if err := exec.Release(ctx, a.Handle); err != nil {
			log.Warn("couldn't remove an orphaned attempt", "handle", a.Handle, "error", err.Error())
			continue
		}
		released++
		state := ""
		if t != nil {
			state = string(t.State)
		}
		log.Warn("removed an attempt no task needs", "executionId", a.ExecutionID, "taskKey", a.TaskKey,
			"attempt", a.Attempt, "taskState", state, "handle", a.Handle)
	}
	return released, nil
}
