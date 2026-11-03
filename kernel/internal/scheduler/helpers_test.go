// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/rburns629/vertra/kernel/internal/dbtest"
	"github.com/rburns629/vertra/kernel/internal/domain"
	"github.com/rburns629/vertra/kernel/internal/executor"
	"github.com/rburns629/vertra/kernel/internal/executor/executortest"
)

// The scenarios the Python scheduler was proven by (the Python kernel's
// tests/integration), against the real, migrated test database (`make
// test-db`; TEST_DATABASE_URL). Each test runs in a transaction that's
// rolled back. A missing database fails.

var testPool *pgxpool.Pool

func TestMain(m *testing.M) { dbtest.Main(m, &testPool) }

var quietLog = slog.New(slog.NewTextHandler(io.Discard, nil))

// txFor is a transaction rolled back when the test ends.
func txFor(t *testing.T) pgx.Tx { return dbtest.Tx(t, testPool) }

// TaskDef is a task as submitted (kernel-api's TaskDefinition).
type TaskDef struct {
	ID             string
	Image          string
	Action         string
	DependsOn      []string
	Inputs         map[string]any
	TimeoutSeconds int // default 300
	MaxAttempts    int // default 1
	Team           string
	ServiceAccount string
	SecretRefs     []string
	Resources      *domain.TaskResources
	InputSchema    map[string]any
	OutputSchema   map[string]any
	// One task per key at a time: its scope and the inputs naming what it changes.
	ConcurrencyScope  string
	ConcurrencyInputs []string
	ApprovalRequired  bool
	// At most CapLimit of its product's (CapScope's) tasks at once.
	CapScope string
	CapLimit int
	// The team it runs for; "": none.
	ForTeam string
}

func task(id string, fields ...func(*TaskDef)) TaskDef {
	d := TaskDef{ID: id, Image: "demo-project-product:local", Action: "create", Team: "test-team", ServiceAccount: "default"}
	for _, f := range fields {
		f(&d)
	}
	return d
}

func dependsOn(ids ...string) func(*TaskDef) { return func(d *TaskDef) { d.DependsOn = ids } }
func inputs(m map[string]any) func(*TaskDef) { return func(d *TaskDef) { d.Inputs = m } }
func maxAttempts(n int) func(*TaskDef)       { return func(d *TaskDef) { d.MaxAttempts = n } }
func timeout(seconds int) func(*TaskDef)     { return func(d *TaskDef) { d.TimeoutSeconds = seconds } }
func team(name string) func(*TaskDef)        { return func(d *TaskDef) { d.Team = name } }
func forTeam(name string) func(*TaskDef)     { return func(d *TaskDef) { d.ForTeam = name } }
func concurrency(scope string, inputs ...string) func(*TaskDef) {
	return func(d *TaskDef) { d.ConcurrencyScope, d.ConcurrencyInputs = scope, inputs }
}
func needsApproval(d *TaskDef) { d.ApprovalRequired = true }
func capped(scope string, limit int) func(*TaskDef) {
	return func(d *TaskDef) { d.CapScope, d.CapLimit = scope, limit }
}
func schemas(in, out map[string]any) func(*TaskDef) {
	return func(d *TaskDef) { d.InputSchema, d.OutputSchema = in, out }
}

// submit writes an execution as kernel-api's submit_execution does: the
// execution PENDING, each task READY (no dependencies) or BLOCKED, the
// dependency edges, and EXECUTION_CREATED. Returns the execution's id.
// Tasks are available from a second before the database's now(), which can
// run ahead of this host's clock (a pass at time.Now() must find them).
func submit(t *testing.T, db DB, key string, tasks ...TaskDef) string {
	t.Helper()
	ctx := context.Background()
	var executionID string
	if err := db.QueryRow(ctx, `INSERT INTO executions (id, external_reference, idempotency_key, state)
		VALUES (gen_random_uuid(), 'demo-order-1', $1, 'PENDING') RETURNING id::text`, key).Scan(&executionID); err != nil {
		t.Fatal(err)
	}
	ids := map[string]string{}
	for _, d := range tasks {
		state := domain.TaskReady
		if len(d.DependsOn) > 0 {
			state = domain.TaskBlocked
		} else if d.ApprovalRequired {
			state = domain.TaskAwaitingApproval
		}
		if d.TimeoutSeconds == 0 {
			d.TimeoutSeconds = 300
		}
		if d.MaxAttempts == 0 {
			d.MaxAttempts = 1
		}
		if d.Inputs == nil {
			d.Inputs = map[string]any{}
		}
		if d.SecretRefs == nil {
			d.SecretRefs = []string{}
		}
		var resources any
		if d.Resources != nil {
			data, _ := json.Marshal(d.Resources)
			resources = string(data)
		}
		var inputSchema, outputSchema any
		if d.InputSchema != nil {
			inputSchema = jsonValue(d.InputSchema)
		}
		if d.OutputSchema != nil {
			outputSchema = jsonValue(d.OutputSchema)
		}
		var id string
		if err := db.QueryRow(ctx, `INSERT INTO execution_tasks (id, execution_id, task_key, image, action, team,
			service_account, secret_refs, resources, state, original_inputs, timeout_seconds, max_attempts, attempt_count, available_at,
			input_schema, output_schema, concurrency_scope, concurrency_inputs, approval_required, cap_scope, cap_limit, for_team)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, 0, now() - interval '1 second',
			$13::jsonb, $14::jsonb, NULLIF($15, ''), $16, $17, NULLIF($18, ''), $19, NULLIF($20, ''))
			RETURNING id::text`,
			executionID, d.ID, d.Image, d.Action, d.Team, d.ServiceAccount, d.SecretRefs, resources, string(state),
			jsonValue(d.Inputs), d.TimeoutSeconds, d.MaxAttempts, inputSchema, outputSchema,
			d.ConcurrencyScope, append([]string{}, d.ConcurrencyInputs...), d.ApprovalRequired, d.CapScope, d.CapLimit, d.ForTeam).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids[d.ID] = id
	}
	for _, d := range tasks {
		for _, dep := range d.DependsOn {
			if _, err := db.Exec(ctx, `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)`, ids[d.ID], ids[dep]); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := db.Exec(ctx, `INSERT INTO execution_events (execution_id, event_type, payload) VALUES ($1, 'EXECUTION_CREATED', $2::jsonb)`,
		executionID, fmt.Sprintf(`{"taskCount": %d}`, len(tasks))); err != nil {
		t.Fatal(err)
	}
	return executionID
}

// cancelExecution is kernel-api's cancel_execution: unstarted tasks
// CANCELLED (conditionally), then the execution; the scheduler stops the
// running ones on its next poll.
func cancelExecution(t *testing.T, db DB, executionID string) {
	t.Helper()
	ctx := context.Background()
	rows, err := db.Query(ctx, `UPDATE execution_tasks SET state = 'CANCELLED' WHERE execution_id = $1
		AND state IN ('READY', 'BLOCKED', 'AWAITING_APPROVAL') RETURNING id::text, task_key`, executionID)
	if err != nil {
		t.Fatal(err)
	}
	type cancelled struct{ id, key string }
	var tasks []cancelled
	for rows.Next() {
		var c cancelled
		if err := rows.Scan(&c.id, &c.key); err != nil {
			t.Fatal(err)
		}
		tasks = append(tasks, c)
	}
	rows.Close()
	moved, err := transitionExecution(ctx, db, executionID, domain.ExecutionCancelled, domain.ActiveExecutionStates...)
	if err != nil || !moved {
		t.Fatalf("cancel: moved=%v err=%v", moved, err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO execution_events (execution_id, event_type, payload) VALUES ($1, 'EXECUTION_CANCELLED', '{}')`, executionID); err != nil {
		t.Fatal(err)
	}
	for _, c := range tasks {
		if _, err := db.Exec(ctx, `INSERT INTO execution_events (execution_id, task_id, event_type, payload)
			VALUES ($1, $2, 'TASK_CANCELLED', $3::jsonb)`, executionID, c.id, fmt.Sprintf(`{"taskKey": %q}`, c.key)); err != nil {
			t.Fatal(err)
		}
	}
}

// retryTask is kernel-api's retry_task: a FAILED task READY again, the
// execution resumed, and its cancelled siblings revived.
func retryTask(t *testing.T, db DB, executionID, taskKey string, now time.Time) {
	t.Helper()
	ctx := context.Background()
	tasks := tasksByKey(t, db, executionID)
	tk := tasks[taskKey]
	if tk == nil || tk.State != domain.TaskFailed {
		t.Fatalf("retry: %s isn't FAILED", taskKey)
	}
	if _, err := db.Exec(ctx, `UPDATE execution_tasks SET state = 'READY', lease_owner = NULL, lease_expires_at = NULL,
		executor_handle = NULL, failure = NULL, available_at = $2 WHERE id = $1`, tk.ID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO execution_events (execution_id, task_id, event_type, payload)
		VALUES ($1, $2, 'TASK_RETRIED', $3::jsonb)`, executionID, tk.ID, fmt.Sprintf(`{"taskKey": %q, "attempt": %d}`, taskKey, tk.AttemptCount)); err != nil {
		t.Fatal(err)
	}
	if moved, err := transitionExecution(ctx, db, executionID, domain.ExecutionRunning, domain.ExecutionFailed); err != nil {
		t.Fatal(err)
	} else if moved {
		if _, err := db.Exec(ctx, `INSERT INTO execution_events (execution_id, event_type, payload) VALUES ($1, 'EXECUTION_RESUMED', '{}')`, executionID); err != nil {
			t.Fatal(err)
		}
	}
	for _, sibling := range tasksByKey(t, db, executionID) {
		if sibling.State != domain.TaskCancelled {
			continue
		}
		var unfinished int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM execution_tasks d JOIN task_dependencies td ON td.depends_on_task_id = d.id
			WHERE td.task_id = $1 AND d.state <> 'SUCCEEDED'`, sibling.ID).Scan(&unfinished); err != nil {
			t.Fatal(err)
		}
		state, available := "BLOCKED", sibling.AvailableAt
		if unfinished == 0 {
			state, available = "READY", now
		}
		if _, err := db.Exec(ctx, `UPDATE execution_tasks SET state = $2, available_at = $3 WHERE id = $1`, sibling.ID, state, available); err != nil {
			t.Fatal(err)
		}
	}
}

func tasksByKey(t *testing.T, db DB, executionID string) map[string]*Task {
	t.Helper()
	rows, err := db.Query(context.Background(), `SELECT `+taskColumns+` FROM execution_tasks WHERE execution_id = $1`, executionID)
	if err != nil {
		t.Fatal(err)
	}
	tasks, err := scanTasks(rows)
	if err != nil {
		t.Fatal(err)
	}
	byKey := map[string]*Task{}
	for _, tk := range tasks {
		byKey[tk.TaskKey] = tk
	}
	return byKey
}

func executionState(t *testing.T, db DB, executionID string) domain.ExecutionState {
	t.Helper()
	var state string
	if err := db.QueryRow(context.Background(), `SELECT state FROM executions WHERE id = $1`, executionID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return domain.ExecutionState(state)
}

type event struct {
	Type    string
	TaskKey *string
	Payload map[string]any
}

func events(t *testing.T, db DB, executionID string) []event {
	t.Helper()
	rows, err := db.Query(context.Background(), `SELECT e.event_type, t.task_key, e.payload FROM execution_events e
		LEFT JOIN execution_tasks t ON t.id = e.task_id WHERE e.execution_id = $1 ORDER BY e.id`, executionID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []event
	for rows.Next() {
		var e event
		var payload []byte
		if err := rows.Scan(&e.Type, &e.TaskKey, &payload); err != nil {
			t.Fatal(err)
		}
		_ = decodeJSON(payload, &e.Payload)
		out = append(out, e)
	}
	return out
}

func eventTypes(t *testing.T, db DB, executionID string) []string {
	var types []string
	for _, e := range events(t, db, executionID) {
		types = append(types, e.Type)
	}
	return types
}

func outputsOf(t *testing.T, db DB, taskID string) map[string]any {
	t.Helper()
	var data []byte
	err := db.QueryRow(context.Background(), `SELECT outputs FROM task_outputs WHERE task_id = $1`, taskID).Scan(&data)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var o map[string]any
	_ = json.Unmarshal(data, &o)
	return o
}

func logsOf(t *testing.T, db DB, taskID string) ([]string, bool) {
	t.Helper()
	var lines []string
	err := db.QueryRow(context.Background(), `SELECT lines FROM task_logs WHERE task_id = $1`, taskID).Scan(&lines)
	if err == pgx.ErrNoRows {
		return nil, false
	}
	if err != nil {
		t.Fatal(err)
	}
	return lines, true
}

type attemptRow struct {
	Number      int
	StartedAt   *time.Time
	CompletedAt *time.Time
	Failure     map[string]any
}

func attemptsOf(t *testing.T, db DB, taskID string) []attemptRow {
	t.Helper()
	rows, err := db.Query(context.Background(), `SELECT attempt_number, started_at, completed_at, failure FROM task_attempts
		WHERE task_id = $1 ORDER BY attempt_number`, taskID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []attemptRow
	for rows.Next() {
		var a attemptRow
		var failure []byte
		if err := rows.Scan(&a.Number, &a.StartedAt, &a.CompletedAt, &failure); err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal(failure, &a.Failure)
		out = append(out, a)
	}
	return out
}

// ticker runs passes as one scheduler.
type ticker struct {
	t    *testing.T
	db   DB
	exec executor.Executor
	opts Options
}

func newTicker(t *testing.T, db DB, exec executor.Executor) *ticker {
	return &ticker{t: t, db: db, exec: exec, opts: DefaultOptions("scheduler-1")}
}

func (k *ticker) tick(now time.Time) Outcome {
	k.t.Helper()
	outcome, err := RunTick(context.Background(), k.db, k.exec, k.opts, now, quietLog)
	if err != nil {
		k.t.Fatal(err)
	}
	return outcome
}

type fakeExec = executortest.Fake

func fake() *fakeExec { return executortest.New() }

func equal(t *testing.T, what string, got, want any) {
	t.Helper()
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	if string(g) != string(w) {
		t.Errorf("%s = %s, want %s", what, g, w)
	}
}
