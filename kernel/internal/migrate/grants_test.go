// SPDX-License-Identifier: MIT

package migrate

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/roburns/vennir/kernel/internal/dbtest"
)

// kernel policy's role gets what it uses and nothing else, however often
// it's granted, and loses what it was given besides.
func TestKernelPolicysRoleHoldsWhatItUsesAlone(t *testing.T) {
	ctx := context.Background()
	pool := dbtest.Empty(t, testPool)
	run(t, pool)
	role := fmt.Sprintf("kernel_policy_test_%d", time.Now().UnixNano())
	who := pgx.Identifier{role}.Sanitize()
	if _, err := pool.Exec(ctx, `CREATE ROLE `+who); err != nil {
		t.Fatal(err)
	}
	// Before dbtest.Empty's cleanup drops the database (the last one
	// registered runs first): what it holds there, then the role.
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DROP OWNED BY `+who)
		pool.Close()
		_, _ = testPool.Exec(ctx, `DROP ROLE IF EXISTS `+who)
	})
	// Something an earlier grant (or a hand) gave it, which it doesn't use.
	if _, err := pool.Exec(ctx, `GRANT SELECT, UPDATE ON task_outputs TO `+who); err != nil {
		t.Fatal(err)
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := GrantPolicy(ctx, conn, role); err != nil {
			t.Fatal(err)
		}
	}
	conn.Release()

	rows, err := pool.Query(ctx, `SELECT table_name,
			has_table_privilege($1, quote_ident(table_name), 'SELECT'),
			has_table_privilege($1, quote_ident(table_name), 'INSERT'),
			has_table_privilege($1, quote_ident(table_name), 'UPDATE'),
			has_table_privilege($1, quote_ident(table_name), 'DELETE'),
			has_table_privilege($1, quote_ident(table_name), 'TRUNCATE,REFERENCES,TRIGGER')
		FROM information_schema.tables WHERE table_schema = 'public'`, role)
	if err != nil {
		t.Fatal(err)
	}
	tables := 0
	for rows.Next() {
		var table string
		var sel, ins, upd, del, other bool
		if err := rows.Scan(&table, &sel, &ins, &upd, &del, &other); err != nil {
			t.Fatal(err)
		}
		tables++
		write := slices.Contains(PolicyWrites, table)
		read := write || slices.Contains(PolicyReads, table)
		if sel != read || ins != write || upd != write || del != write || other {
			t.Errorf("%s: select %v insert %v update %v delete %v other %v; want select %v, the rest %v and no other",
				table, sel, ins, upd, del, other, read, write)
		}
	}
	if rows.Err() != nil || tables < len(PolicyReads)+len(PolicyWrites)+1 {
		t.Fatalf("%d tables, %v", tables, rows.Err())
	}
	var connect, usage, create bool
	if err := pool.QueryRow(ctx, `SELECT has_database_privilege($1, current_database(), 'CONNECT'),
			has_schema_privilege($1, 'public', 'USAGE'), has_schema_privilege($1, 'public', 'CREATE')`, role).Scan(&connect, &usage, &create); err != nil {
		t.Fatal(err)
	}
	if !connect || !usage || create {
		t.Errorf("connect %v, usage %v, create %v: want connect and usage, never create", connect, usage, create)
	}
}
