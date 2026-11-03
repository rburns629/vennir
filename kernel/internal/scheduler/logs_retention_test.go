// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"slices"
	"testing"
	"time"
)

// A running step's log is captured as it goes, and finished executions are
// deleted once past retention.

func TestARunningStepsLogIsCapturedAndRefreshed(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "logs-while-running", task("only", team("t")))
	exec := fake()
	k := newTicker(t, tx, exec)
	k.opts.LogRefresh = 60 * time.Second
	t0 := time.Now()
	k.tick(t0) // starts it
	tk := tasksByKey(t, tx, id)["only"]
	k.tick(t0.Add(time.Second)) // running: first capture
	lines, _ := logsOf(t, tx, tk.ID)
	equal(t, "lines", lines, []string{"started only attempt 1"})

	exec.AppendLog(tk.ExecutorHandle, "halfway")
	k.tick(t0.Add(30 * time.Second)) // not due yet
	lines, _ = logsOf(t, tx, tk.ID)
	equal(t, "not refreshed", slices.Contains(lines, "halfway"), false)
	k.tick(t0.Add(62 * time.Second)) // due
	lines, _ = logsOf(t, tx, tk.ID)
	equal(t, "refreshed", lines[len(lines)-1], "halfway")
}

func TestDeletesFinishedExecutionsPastRetentionOnly(t *testing.T) {
	tx := txFor(t)
	ctx := context.Background()
	old := submit(t, tx, "retention-old", task("only"))
	recent := submit(t, tx, "retention-recent", task("only"))
	running := submit(t, tx, "retention-running", task("only"))
	for id, state := range map[string]string{old: "SUCCEEDED", recent: "FAILED", running: "RUNNING"} {
		if _, err := tx.Exec(ctx, `UPDATE executions SET state = $2 WHERE id = $1`, id, state); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{old, running} {
		if _, err := tx.Exec(ctx, `UPDATE execution_events SET created_at = '2000-01-01T00:00:00Z' WHERE execution_id = $1`, id); err != nil {
			t.Fatal(err)
		}
	}
	deleted, err := DeleteFinishedExecutions(ctx, tx, time.Now().AddDate(0, 0, -90), 500)
	if err != nil {
		t.Fatal(err)
	}
	equal(t, "deleted some", deleted >= 1, true)
	remaining := map[string]bool{}
	rows, err := tx.Query(ctx, `SELECT id::text FROM executions WHERE id = ANY($1::uuid[])`, []string{old, recent, running})
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		remaining[id] = true
	}
	rows.Close()
	equal(t, "old deleted", remaining[old], false)     // finished long ago
	equal(t, "recent kept", remaining[recent], true)   // finished, but recently
	equal(t, "running kept", remaining[running], true) // never deleted while running
}
