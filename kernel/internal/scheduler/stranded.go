// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"log/slog"

	"github.com/rburns629/vennir/kernel/internal/domain"
)

// CancelStranded cancels the tasks still waiting (READY, BLOCKED or
// AWAITING_APPROVAL) in a cancelled execution, which nothing would ever
// claim: a writer that made one waiting while the execution was being
// cancelled (a retry committing as kernel-api's cancel held the execution,
// or a claim holding the task's row as the cancel looked again) leaves it
// so. kernel-api's cancel catches what it can; this catches the rest, a
// few hundred at a time, never waiting for a row someone holds (the next
// sweep has it), each with the event a cancel records. Returns how many.
func CancelStranded(ctx context.Context, db DB, log *slog.Logger) (int, error) {
	rows, err := db.Query(ctx, `UPDATE execution_tasks t SET state = 'CANCELLED', updated_at = now()
		WHERE t.id IN (SELECT s.id FROM execution_tasks s JOIN executions e ON e.id = s.execution_id
			WHERE e.state = 'CANCELLED' AND s.state IN ('READY', 'BLOCKED', 'AWAITING_APPROVAL')
			LIMIT 500 FOR UPDATE OF s SKIP LOCKED)
		RETURNING t.execution_id::text, t.id::text, t.task_key`)
	if err != nil {
		return 0, err
	}
	type stranded struct{ execution, id, key string }
	var found []stranded
	for rows.Next() {
		var s stranded
		if err := rows.Scan(&s.execution, &s.id, &s.key); err != nil {
			rows.Close()
			return 0, err
		}
		found = append(found, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, s := range found {
		if _, err := db.Exec(ctx, `INSERT INTO execution_events (execution_id, task_id, event_type, payload)
			VALUES ($1, $2, $3, $4::jsonb)`, s.execution, s.id, string(domain.EventTaskCancelled), jsonValue(map[string]any{"taskKey": s.key})); err != nil {
			return 0, err
		}
	}
	if len(found) > 0 {
		log.Warn("cancelled tasks left waiting in cancelled executions", "event", "stranded_tasks_cancelled", "count", len(found))
	}
	return len(found), nil
}
