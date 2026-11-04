// SPDX-License-Identifier: MIT

package sleeper

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/rburns629/vennir/kernel/internal/dbtest"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) { dbtest.Main(m, &testPool) }

func TestAnUnfinishedExecutionIsBusyAndAFinishedOneIsNot(t *testing.T) {
	ctx := context.Background()
	tx := dbtest.Tx(t, testPool)
	beforeBusy, beforeLast, err := KernelActivity(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO executions (id, external_reference, idempotency_key, state)
		VALUES (gen_random_uuid(), 'sleeper-activity', gen_random_uuid()::text, 'PENDING') RETURNING id::text`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO execution_events (execution_id, event_type, payload) VALUES ($1, 'EXECUTION_CREATED', '{}')`, id); err != nil {
		t.Fatal(err)
	}
	busy, last, err := KernelActivity(ctx, tx)
	if err != nil || !busy || last == nil || (beforeLast != nil && last.Before(*beforeLast)) {
		t.Fatalf("during: busy=%v last=%v err=%v", busy, last, err)
	}
	if _, err := tx.Exec(ctx, `UPDATE executions SET state = 'SUCCEEDED' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	// Back to what it was (not busy, unless something else is running).
	if busy, _, _ := KernelActivity(ctx, tx); busy != beforeBusy {
		t.Errorf("after: busy=%v, before %v", busy, beforeBusy)
	}
}
