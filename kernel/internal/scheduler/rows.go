// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/rburns629/vennir/kernel/internal/domain"
	"github.com/rburns629/vennir/kernel/internal/executor"
)

// DB is a transaction (or a connection) the scheduler's queries run on.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Task is an execution_tasks row, as the scheduler reads and writes it.
type Task struct {
	ID               string
	ExecutionID      string
	TaskKey          string
	Image            string
	Action           string
	Team             string
	ServiceAccount   string
	SecretRefs       []string
	TokenAudiences   []string
	Resources        *domain.TaskResources
	InputSchema      map[string]any
	OutputSchema     map[string]any
	State            domain.TaskState
	OriginalInputs   map[string]any
	ResolvedInputs   map[string]any
	TimeoutSeconds   int
	MaxAttempts      int
	AttemptCount     int
	DispatchFailures int
	LeaseOwner       *string
	LeaseExpiresAt   *time.Time
	AvailableAt      time.Time
	ExecutorHandle   executor.Handle
	Failure          map[string]any
	// What holds it while another task with the same key is claimed or
	// running (domain.ConcurrencyKey); the key is set when it's claimed.
	ConcurrencyScope  *string
	ConcurrencyInputs []string
	ConcurrencyKey    *string
	// Its product's cap: at most CapLimit tasks of CapScope claimed or
	// running at once; nil scope, no cap.
	CapScope *string
	CapLimit int
	// The capacity its product asks for; nil, the install's own.
	Capacity *string
	// The team it runs for (request.json's forTeam); nil, none.
	ForTeam *string
	// Who asked for its next attempt, by retrying it; nil when nobody did
	// (its first attempt is whoever submitted it, a later one automatic).
	NextAttemptRequestedBy *string
}

const taskColumns = `id::text, execution_id::text, task_key, image, action, team, service_account, secret_refs,
	token_audiences, resources, state, original_inputs, resolved_inputs, timeout_seconds, max_attempts, attempt_count,
	dispatch_failures, lease_owner, lease_expires_at, available_at, executor_handle, failure, input_schema, output_schema,
	concurrency_scope, concurrency_inputs, concurrency_key, next_attempt_requested_by, cap_scope, cap_limit, capacity, for_team`

// taskColumnsOf is taskColumns qualified with a table alias.
func taskColumnsOf(alias string) string {
	return fmt.Sprintf(`%[1]s.id::text, %[1]s.execution_id::text, %[1]s.task_key, %[1]s.image, %[1]s.action,
	%[1]s.team, %[1]s.service_account, %[1]s.secret_refs, %[1]s.token_audiences, %[1]s.resources, %[1]s.state, %[1]s.original_inputs,
	%[1]s.resolved_inputs, %[1]s.timeout_seconds, %[1]s.max_attempts, %[1]s.attempt_count, %[1]s.dispatch_failures,
	%[1]s.lease_owner, %[1]s.lease_expires_at, %[1]s.available_at, %[1]s.executor_handle, %[1]s.failure,
	%[1]s.input_schema, %[1]s.output_schema, %[1]s.concurrency_scope, %[1]s.concurrency_inputs, %[1]s.concurrency_key,
	%[1]s.next_attempt_requested_by, %[1]s.cap_scope, %[1]s.cap_limit, %[1]s.capacity, %[1]s.for_team`, alias)
}

func scanTasks(rows pgx.Rows) ([]*Task, error) {
	defer rows.Close()
	var tasks []*Task
	for rows.Next() {
		t := &Task{}
		var resources, original, resolved, handle, failure, inputSchema, outputSchema []byte
		var state string
		if err := rows.Scan(&t.ID, &t.ExecutionID, &t.TaskKey, &t.Image, &t.Action, &t.Team, &t.ServiceAccount,
			&t.SecretRefs, &t.TokenAudiences, &resources, &state, &original, &resolved, &t.TimeoutSeconds, &t.MaxAttempts,
			&t.AttemptCount, &t.DispatchFailures, &t.LeaseOwner, &t.LeaseExpiresAt, &t.AvailableAt, &handle,
			&failure, &inputSchema, &outputSchema, &t.ConcurrencyScope, &t.ConcurrencyInputs, &t.ConcurrencyKey,
			&t.NextAttemptRequestedBy, &t.CapScope, &t.CapLimit, &t.Capacity, &t.ForTeam); err != nil {
			return nil, err
		}
		t.State = domain.TaskState(state)
		for _, field := range []struct {
			data []byte
			into any
		}{{original, &t.OriginalInputs}, {resolved, &t.ResolvedInputs}, {handle, &t.ExecutorHandle}, {failure, &t.Failure},
			{inputSchema, &t.InputSchema}, {outputSchema, &t.OutputSchema}} {
			if err := decodeJSON(field.data, field.into); err != nil {
				return nil, err
			}
		}
		if resources != nil && string(resources) != "null" {
			t.Resources = &domain.TaskResources{}
			if err := json.Unmarshal(resources, t.Resources); err != nil {
				return nil, err
			}
		}
		if t.OriginalInputs == nil {
			t.OriginalInputs = map[string]any{}
		}
		tasks = append(tasks, t)
	}
	return tasks, rows.Err()
}

// decodeJSON reads JSONB, keeping numbers exact (json.Number).
func decodeJSON(data []byte, into any) error {
	if data == nil {
		return nil
	}
	decoder := json.NewDecoder(bytesReader(data))
	decoder.UseNumber()
	return decoder.Decode(into)
}

// jsonValue is a value as JSONB, or SQL NULL for a nil map.
func jsonValue[M ~map[string]any](m M) any {
	if m == nil {
		return nil
	}
	data, err := json.Marshal(m)
	if err != nil {
		panic(err) // decoded JSON always marshals
	}
	return string(data)
}

// saveTask writes every column the scheduler changes.
func saveTask(ctx context.Context, db DB, t *Task) error {
	_, err := db.Exec(ctx, `UPDATE execution_tasks SET state = $2, lease_owner = $3, lease_expires_at = $4,
		available_at = $5, executor_handle = $6::jsonb, failure = $7::jsonb, resolved_inputs = $8::jsonb,
		attempt_count = $9, dispatch_failures = $10, concurrency_key = $11, next_attempt_requested_by = $12,
		updated_at = now() WHERE id = $1`,
		t.ID, string(t.State), t.LeaseOwner, t.LeaseExpiresAt, t.AvailableAt, jsonValue(t.ExecutorHandle),
		jsonValue(t.Failure), jsonValue(t.ResolvedInputs), t.AttemptCount, t.DispatchFailures, t.ConcurrencyKey,
		t.NextAttemptRequestedBy)
	return err
}

// Attempt is a task_attempts row.
type Attempt struct {
	ID          string
	StartedAt   *time.Time
	CompletedAt *time.Time
	Failure     map[string]any
	Handle      executor.Handle
}

// currentAttempt is the task's attempt numbered attempt_count.
func currentAttempt(ctx context.Context, db DB, t *Task) (*Attempt, error) {
	a := &Attempt{}
	var failure, handle []byte
	err := db.QueryRow(ctx, `SELECT id::text, started_at, completed_at, failure, executor_handle FROM task_attempts
		WHERE task_id = $1 AND attempt_number = $2`, t.ID, t.AttemptCount).Scan(&a.ID, &a.StartedAt, &a.CompletedAt, &failure, &handle)
	if err != nil {
		return nil, fmt.Errorf("task %s attempt %d: %w", t.ID, t.AttemptCount, err)
	}
	if err := decodeJSON(failure, &a.Failure); err != nil {
		return nil, err
	}
	return a, decodeJSON(handle, &a.Handle)
}

func saveAttempt(ctx context.Context, db DB, a *Attempt) error {
	_, err := db.Exec(ctx, `UPDATE task_attempts SET started_at = $2, completed_at = $3, failure = $4::jsonb,
		executor_handle = $5::jsonb WHERE id = $1`, a.ID, a.StartedAt, a.CompletedAt, jsonValue(a.Failure), jsonValue(a.Handle))
	return err
}

// recordEvent is the one place lifecycle events are written. Task events
// carry the taskKey in their payload: the task's row id is internal.
func (p *pass) recordEvent(executionID string, taskID *string, eventType domain.EventType, payload map[string]any) error {
	if payload == nil {
		payload = map[string]any{}
	}
	p.events = append(p.events, eventType)
	if p.pendingEvents != nil {
		*p.pendingEvents = append(*p.pendingEvents, pendingEvent{executionID, taskID, eventType, payload})
		return nil
	}
	_, err := p.db.Exec(p.ctx, `INSERT INTO execution_events (execution_id, task_id, event_type, payload)
		VALUES ($1, $2, $3, $4::jsonb)`, executionID, taskID, string(eventType), jsonValue(payload))
	return err
}

// flushEvents writes the pass's events in one statement, in the order they
// happened (their ids, in that order).
func (p *pass) flushEvents() error {
	if p.pendingEvents == nil || len(*p.pendingEvents) == 0 {
		return nil
	}
	pending := *p.pendingEvents
	executions, tasks, types, payloads := make([]string, len(pending)), make([]*string, len(pending)), make([]string, len(pending)), make([]string, len(pending))
	for i, e := range pending {
		executions[i], tasks[i], types[i] = e.executionID, e.taskID, string(e.eventType)
		data, err := json.Marshal(e.payload)
		if err != nil {
			return err
		}
		payloads[i] = string(data)
	}
	_, err := p.db.Exec(p.ctx, `INSERT INTO execution_events (execution_id, task_id, event_type, payload)
		SELECT e, t, ty, pl FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::jsonb[]) WITH ORDINALITY AS u(e, t, ty, pl, n)
		ORDER BY n`, executions, tasks, types, payloads)
	*p.pendingEvents = nil
	return err
}

// transitionExecution moves an execution to `to` only if it's still in one
// of `from`: a compare-and-set, because kernel-api changes it too (a cancel
// must never be overwritten by a pass that read the row before it).
func transitionExecution(ctx context.Context, db DB, executionID string, to domain.ExecutionState, from ...domain.ExecutionState) (bool, error) {
	states := make([]string, len(from))
	for i, s := range from {
		states[i] = string(s)
	}
	var id string
	err := db.QueryRow(ctx, `UPDATE executions SET state = $2, updated_at = now() WHERE id = $1 AND state = ANY($3)
		RETURNING id::text`, executionID, string(to), states).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
