// SPDX-License-Identifier: MIT

package migrate

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/rburns629/vennir/kernel/internal/dbtest"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) { dbtest.Main(m, &testPool) }

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func run(t *testing.T, pool *pgxpool.Pool) []string {
	t.Helper()
	conn, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	applied, err := Run(context.Background(), conn, quiet)
	if err != nil {
		t.Fatal(err)
	}
	return applied
}

func versions() []string {
	var v []string
	for _, m := range All() {
		v = append(v, m.Version)
	}
	return v
}

func same(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s = %#v, want %#v", what, got, want)
	}
}

func TestTheFilesAreNumberedInOrderWithoutGaps(t *testing.T) {
	for i, m := range All() {
		same(t, m.Name, m.Version, fmt.Sprintf("%04d", i+1))
	}
}

func TestTheTestDatabaseIsAtLatest(t *testing.T) {
	same(t, "version", Current(context.Background(), testPool), Latest())
}

func TestAnEmptyDatabaseGetsEveryMigrationOnce(t *testing.T) {
	pool := dbtest.Empty(t, testPool)
	same(t, "before", Current(context.Background(), pool), "")
	same(t, "applied", run(t, pool), versions())
	same(t, "after", Current(context.Background(), pool), Latest())
	same(t, "again", run(t, pool), []string(nil))
}

// Two hook Jobs at once: the lock makes the second wait, then find nothing to do.
func TestConcurrentMigratorsApplyEachMigrationOnce(t *testing.T) {
	pool := dbtest.Empty(t, testPool)
	var total atomic.Int32
	var wg sync.WaitGroup
	for range 3 {
		wg.Go(func() { total.Add(int32(len(run(t, pool)))) })
	}
	wg.Wait()
	same(t, "applied", int(total.Load()), len(All()))
}

// An install Alembic migrated: the same schema, recorded in alembic_version.
func alembicInstall(t *testing.T, revision string) *pgxpool.Pool {
	t.Helper()
	pool := dbtest.Empty(t, testPool)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, All()[0].SQL); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TABLE alembic_version (version_num varchar(32) NOT NULL PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO alembic_version VALUES ($1)`, revision); err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestAnAlembicInstallIsTakenOverWithoutReapplyingItsSchema(t *testing.T) {
	pool := alembicInstall(t, "0001")
	same(t, "applied", len(run(t, pool)), len(versions())-1)
	same(t, "version", Current(context.Background(), pool), Latest())
	var exists bool
	_ = pool.QueryRow(context.Background(), `SELECT to_regclass('alembic_version') IS NOT NULL`).Scan(&exists)
	same(t, "alembic_version dropped", exists, false)
}

func TestAnAlembicRevisionThisKernelDoesntKnowIsRefused(t *testing.T) {
	pool := alembicInstall(t, "0099")
	conn, _ := pool.Acquire(context.Background())
	defer conn.Release()
	if _, err := Run(context.Background(), conn, quiet); err == nil || !strings.Contains(err.Error(), "0099") {
		t.Fatalf("err = %v", err)
	}
}

func TestWaitingReturnsAtOnceWhenTheSchemaIsCurrent(t *testing.T) {
	done := make(chan struct{})
	go func() { Wait(context.Background(), testPool, func() {}, quiet); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("still waiting")
	}
}

type lockedWriter struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedWriter) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func TestWaitingReturnsOnceTheMigrationHasRunAndLogsNoErrors(t *testing.T) {
	defer func(d time.Duration) { waitPoll = d }(waitPoll)
	waitPoll = 50 * time.Millisecond
	pool := dbtest.Empty(t, testPool)
	logged := &lockedWriter{}
	var polls atomic.Int32
	done := make(chan struct{})
	go func() {
		Wait(context.Background(), pool, func() { polls.Add(1) }, slog.New(slog.NewTextHandler(logged, nil)))
		close(done)
	}()
	time.Sleep(300 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("returned before anything migrated the database")
	default:
	}
	run(t, pool)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("still waiting after the migration")
	}
	same(t, "polled (the heartbeat kept beating)", polls.Load() > 1, true)
	text := logged.String()
	same(t, "says what it waits for", strings.Contains(text, "waiting for database migrations"), true)
	same(t, "nothing but INFO", strings.Contains(text, "level=WARN") || strings.Contains(text, "level=ERROR"), false)
}

// The console's database guide documents the kernel's tables too
// (console/docs/06-database-schemas.md): a table or column added, renamed
// or dropped fails here until the guide says so.
func TestTheDatabaseGuideDocumentsEveryKernelTableAndColumn(t *testing.T) {
	data, err := os.ReadFile("../../../console/docs/06-database-schemas.md")
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	half := text[strings.Index(text, "## The kernel database"):strings.Index(text, "## The console database")]
	documented := map[string][]string{}
	heading := regexp.MustCompile(`^#{2,3} ([a-z_]+)$`)
	firstCell := regexp.MustCompile("^\\| (`[^|]+) \\|")
	names := regexp.MustCompile("`([a-z_]+)`")
	current := ""
	for _, line := range strings.Split(half, "\n") {
		if m := heading.FindStringSubmatch(line); m != nil {
			current = m[1]
			documented[current] = nil
			continue
		}
		if strings.HasPrefix(line, "#") {
			current = ""
		}
		if m := firstCell.FindStringSubmatch(line); current != "" && m != nil {
			for _, n := range names.FindAllStringSubmatch(m[1], -1) {
				documented[current] = append(documented[current], n[1])
			}
		}
	}
	rows, err := testPool.Query(context.Background(), `SELECT table_name, column_name FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`)
	if err != nil {
		t.Fatal(err)
	}
	actual := map[string][]string{}
	for rows.Next() {
		var table, column string
		_ = rows.Scan(&table, &column)
		actual[table] = append(actual[table], column)
	}
	rows.Close()
	sorted := func(m map[string][]string) []string {
		var out []string
		for k, v := range m {
			sort.Strings(v)
			out = append(out, k+": "+strings.Join(v, ","))
		}
		sort.Strings(out)
		return out
	}
	same(t, "tables and columns", sorted(documented), sorted(actual))
}

// What the schema itself guarantees.
func TestTheSchemaKeepsRequestIDsUniqueAndDeletesAnExecutionWhole(t *testing.T) {
	ctx := context.Background()
	tx := dbtest.Tx(t, testPool)
	insert := func(key string) (string, error) {
		var id string
		err := tx.QueryRow(ctx, `INSERT INTO executions (id, external_reference, idempotency_key, state)
			VALUES (gen_random_uuid(), 'x', $1, 'PENDING') RETURNING id::text`, key).Scan(&id)
		return id, err
	}
	id, err := insert("persistence-unique")
	if err != nil {
		t.Fatal(err)
	}
	var taskID string
	if err := tx.QueryRow(ctx, `INSERT INTO execution_tasks (id, execution_id, task_key, image, action, team, service_account,
		state, original_inputs, timeout_seconds, max_attempts, attempt_count)
		VALUES (gen_random_uuid(), $1, 'only', 'x:1', 'run', 't', 'default', 'READY', '{}', 300, 1, 0) RETURNING id::text`, id).Scan(&taskID); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{
		`INSERT INTO task_outputs (task_id, outputs) VALUES ($1, '{"a": 1}')`,
		`INSERT INTO task_logs (task_id, lines) VALUES ($1, '{"x"}')`,
		`INSERT INTO task_attempts (id, task_id, attempt_number) VALUES (gen_random_uuid(), $1, 1)`,
		`INSERT INTO execution_events (execution_id, task_id, event_type, payload) SELECT execution_id, id, 'TASK_CLAIMED', '{}' FROM execution_tasks WHERE id = $1`,
	} {
		if _, err := tx.Exec(ctx, sql, taskID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"execution_tasks", "task_outputs", "task_logs", "task_attempts", "execution_events"} {
		var n int
		column := "task_id"
		if table == "execution_tasks" {
			column = "id"
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE `+column+` = $1`, taskID).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s: %d left (%v)", table, n, err)
		}
	}
	if _, err := insert("persistence-unique-2"); err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `SAVEPOINT dup`)
	if err == nil {
		_, err = insert("persistence-unique-2")
	}
	if err == nil {
		t.Error("a second execution with the same request id was stored")
	}
}
