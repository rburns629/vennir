// SPDX-License-Identifier: MIT

// Package api is kernel-api: KernelService (proto/vertra/kernel/v1) over
// Connect, on the same database kernel-scheduler runs. It accepts only the
// console (auth.go) and trusts it to have authorized each request against
// the caller's teams: kernel-api has no users or teams. It never calls the
// scheduler; what it stores, the scheduler runs on its next pass.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/rburns629/vertra/kernel/internal/domain"
	kernelv1 "github.com/rburns629/vertra/kernel/internal/gen/vertra/kernel/v1"
	"github.com/rburns629/vertra/kernel/internal/gen/vertra/kernel/v1/kernelv1connect"
	"github.com/rburns629/vertra/kernel/internal/metrics"
)

// MaxStatesPerRequest bounds GetExecutionStates; the console asks in batches.
const MaxStatesPerRequest = 1000

// Service implements KernelService.
type Service struct {
	Pool     *pgxpool.Pool
	MaxTasks int
	Log      *slog.Logger
}

var _ kernelv1connect.KernelServiceHandler = (*Service)(nil)

// tx is a transaction and the events it recorded, counted once it commits:
// a transaction that rolls back recorded nothing, and counts nothing.
type tx struct {
	pgx.Tx
	events []domain.EventType
}

func (t *tx) recordEvent(ctx context.Context, executionID string, taskID *string, eventType domain.EventType, payload map[string]any) error {
	if payload == nil {
		payload = map[string]any{}
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := t.Exec(ctx, `INSERT INTO execution_events (execution_id, task_id, event_type, payload) VALUES ($1, $2, $3, $4)`,
		executionID, taskID, string(eventType), data); err != nil {
		return err
	}
	t.events = append(t.events, eventType)
	return nil
}

func (s *Service) inTx(ctx context.Context, work func(*tx) error) error {
	t := &tx{}
	err := pgx.BeginFunc(ctx, s.Pool, func(pt pgx.Tx) error {
		t.Tx = pt
		return work(t)
	})
	if err != nil {
		return err
	}
	for _, e := range t.events {
		metrics.Events.WithLabelValues(string(e)).Inc()
	}
	return nil
}

func invalid(format string, args ...any) error {
	return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf(format, args...))
}

var errNotFound = connect.NewError(connect.CodeNotFound, errors.New("Execution not found."))

// executionID parses an id, refusing anything that isn't a UUID.
func executionID(id string) (string, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", invalid("execution_id: %q isn't a UUID", id)
	}
	return parsed.String(), nil
}

// taskDefs checks each task field by field (what a field must be, before
// the DAG as a whole is checked) and fills in the defaults.
func taskDefs(tasks []*kernelv1.Task) ([]domain.TaskDef, []domain.ValidationIssue) {
	defs := make([]domain.TaskDef, 0, len(tasks))
	var issues []domain.ValidationIssue
	for i, t := range tasks {
		bad := func(field, problem string) {
			issues = append(issues, domain.ValidationIssue{Code: "INVALID_TASK", TaskID: t.GetId(),
				Message: fmt.Sprintf("tasks[%d].%s %s.", i, field, problem)})
		}
		for field, value := range map[string]string{"id": t.GetId(), "image": t.GetImage(), "action": t.GetAction(),
			"team": t.GetTeam(), "service_account": t.GetServiceAccount()} {
			if value == "" {
				bad(field, "is required")
			}
		}
		def := domain.TaskDef{ID: t.GetId(), Image: t.GetImage(), Action: t.GetAction(), DependsOn: t.GetDependsOn(),
			Inputs: t.GetInputs().AsMap(), TimeoutSeconds: 300, MaxAttempts: 1, Team: t.GetTeam(),
			ServiceAccount: t.GetServiceAccount(), SecretRefs: t.GetSecretRefs(), TokenAudiences: t.GetTokenAudiences(),
			ApprovalRequired: t.GetApprovalRequired()}
		if def.DependsOn == nil {
			def.DependsOn = []string{}
		}
		if def.SecretRefs == nil {
			def.SecretRefs = []string{}
		}
		if def.TokenAudiences == nil {
			def.TokenAudiences = []string{}
		}
		if problem := domain.TokenAudiencesProblem(def.TokenAudiences); problem != "" {
			bad("token_audiences", problem)
		}
		for field, schema := range map[string]*structpb.Struct{"input_schema": t.GetInputSchema(), "output_schema": t.GetOutputSchema()} {
			if schema == nil {
				continue
			}
			if _, err := domain.CompileSchema(schema.AsMap()); err != nil {
				bad(field, "isn't a usable JSON Schema: "+err.Error())
			}
		}
		if t.GetInputSchema() != nil {
			def.InputSchema = t.GetInputSchema().AsMap()
		}
		if key := t.GetConcurrencyKey(); key != nil {
			def.ConcurrencyScope, def.ConcurrencyInputs = key.GetScope(), key.GetInputs()
		}
		if def.ConcurrencyInputs == nil {
			def.ConcurrencyInputs = []string{}
		}
		if problem := domain.ConcurrencyKeyProblem(def.ConcurrencyScope, def.ConcurrencyInputs); problem != "" {
			bad("concurrency_key", problem)
		}
		if c := t.GetProductCap(); c != nil {
			def.CapScope, def.CapLimit = c.GetScope(), int(c.GetMaxRunning())
		}
		if problem := domain.ProductCapProblem(def.CapScope, def.CapLimit); problem != "" {
			bad("product_cap", problem)
		}
		def.Capacity = t.GetCapacity()
		if def.Capacity != "" && !slices.Contains(domain.Capacities, def.Capacity) {
			bad("capacity", "must be one of "+strings.Join(domain.Capacities, ", ")+" (or empty)")
		}
		if t.GetOutputSchema() != nil {
			def.OutputSchema = t.GetOutputSchema().AsMap()
		}
		if t.TimeoutSeconds != nil {
			def.TimeoutSeconds = int(t.GetTimeoutSeconds())
			if def.TimeoutSeconds <= 0 {
				bad("timeout_seconds", "must be greater than 0")
			}
		}
		if t.MaxAttempts != nil {
			def.MaxAttempts = int(t.GetMaxAttempts())
			if def.MaxAttempts < 1 {
				bad("max_attempts", "must be at least 1")
			}
		}
		if r := t.GetResources(); r != nil {
			def.Resources = &domain.TaskResources{CPU: r.GetCpu(), Memory: r.GetMemory(), MemoryLimit: r.GetMemoryLimit()}
			if err := def.Resources.Check(); err != nil {
				bad("resources", err.Error())
			}
			if *def.Resources == (domain.TaskResources{}) {
				def.Resources = nil
			}
		}
		defs = append(defs, def)
	}
	return defs, issues
}

func refused(issues []domain.ValidationIssue) error {
	err := connect.NewError(connect.CodeInvalidArgument, (&domain.DAGValidationError{Issues: issues}))
	details := &kernelv1.ValidationIssues{}
	for _, issue := range issues {
		details.Issues = append(details.Issues, &kernelv1.ValidationIssue{Code: issue.Code, Message: issue.Message, TaskId: issue.TaskID})
	}
	if detail, detailErr := connect.NewErrorDetail(details); detailErr == nil {
		err.AddDetail(detail)
	}
	return err
}

func state[E ~int32](name string, values map[string]int32) E { return E(values[name]) }

func executionState(name string) kernelv1.ExecutionState {
	return state[kernelv1.ExecutionState]("EXECUTION_STATE_"+name, kernelv1.ExecutionState_value)
}

func taskState(name string) kernelv1.TaskState {
	return state[kernelv1.TaskState]("TASK_STATE_"+name, kernelv1.TaskState_value)
}

// SubmitExecution stores a validated DAG, or answers with the execution its
// request_id already started.
func (s *Service) SubmitExecution(ctx context.Context, req *connect.Request[kernelv1.SubmitExecutionRequest]) (*connect.Response[kernelv1.SubmitExecutionResponse], error) {
	m := req.Msg
	if m.GetName() == "" {
		return nil, invalid("name is required")
	}
	requestID := m.GetRequestId()
	if requestID == "" {
		requestID = uuid.NewString()
	}
	defs, issues := taskDefs(m.GetTasks())
	if len(issues) > 0 {
		return nil, refused(issues)
	}
	var out *kernelv1.SubmitExecutionResponse
	err := s.inTx(ctx, func(t *tx) error {
		existing := func() (bool, error) {
			var id, st string
			err := t.QueryRow(ctx, `SELECT id::text, state FROM executions WHERE idempotency_key = $1`, requestID).Scan(&id, &st)
			if errors.Is(err, pgx.ErrNoRows) {
				return false, nil
			}
			if err == nil {
				out = &kernelv1.SubmitExecutionResponse{ExecutionId: id, State: executionState(st), Created: false}
			}
			return err == nil, err
		}
		if found, err := existing(); found || err != nil {
			return err
		}
		if _, err := domain.ValidateDAG(defs, s.MaxTasks); err != nil {
			var dagErr *domain.DAGValidationError
			if errors.As(err, &dagErr) {
				return refused(dagErr.Issues)
			}
			return err
		}
		id := uuid.NewString()
		// A savepoint: if a concurrent request with the same request_id
		// committed first, only this insert rolls back.
		err := pgx.BeginFunc(ctx, t.Tx, func(sp pgx.Tx) error { return s.insert(ctx, sp, id, m.GetName(), requestID, m.GetRequestedBy(), defs) })
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "executions_idempotency_key_key" {
			_, err = existing()
			return err
		}
		if err != nil {
			return err
		}
		if err := t.recordEvent(ctx, id, nil, domain.EventExecutionCreated, map[string]any{"taskCount": len(defs)}); err != nil {
			return err
		}
		out = &kernelv1.SubmitExecutionResponse{ExecutionId: id, State: kernelv1.ExecutionState_EXECUTION_STATE_PENDING, Created: true}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(out), nil
}

func (s *Service) insert(ctx context.Context, db pgx.Tx, id, name, requestID, requestedBy string, defs []domain.TaskDef) error {
	if _, err := db.Exec(ctx, `INSERT INTO executions (id, external_reference, idempotency_key, state, requested_by) VALUES ($1, $2, $3, 'PENDING', $4)`,
		id, name, requestID, nullable(requestedBy)); err != nil {
		return err
	}
	ids := map[string]string{}
	for _, d := range defs {
		ids[d.ID] = uuid.NewString()
		inputs, err := json.Marshal(d.Inputs)
		if err != nil {
			return err
		}
		var resources, inputSchema, outputSchema []byte
		if d.Resources != nil {
			if resources, err = json.Marshal(d.Resources); err != nil {
				return err
			}
		}
		if d.InputSchema != nil {
			if inputSchema, err = json.Marshal(d.InputSchema); err != nil {
				return err
			}
		}
		if d.OutputSchema != nil {
			if outputSchema, err = json.Marshal(d.OutputSchema); err != nil {
				return err
			}
		}
		if _, err := db.Exec(ctx, `INSERT INTO execution_tasks (id, execution_id, task_key, image, action, team, service_account,
			secret_refs, token_audiences, resources, state, original_inputs, timeout_seconds, max_attempts, attempt_count,
			input_schema, output_schema, concurrency_scope, concurrency_inputs, approval_required, cap_scope, cap_limit, capacity)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15, $16, $17, $18, $19, $20, $21, $22)`,
			ids[d.ID], id, d.ID, d.Image, d.Action, d.Team, d.ServiceAccount, d.SecretRefs, d.TokenAudiences, resources,
			string(d.InitialState()), inputs, d.TimeoutSeconds, d.MaxAttempts, inputSchema, outputSchema,
			nullable(d.ConcurrencyScope), d.ConcurrencyInputs, d.ApprovalRequired, nullable(d.CapScope), d.CapLimit, nullable(d.Capacity)); err != nil {
			return err
		}
	}
	for _, d := range defs {
		for _, dep := range d.DependsOn {
			if _, err := db.Exec(ctx, `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)`, ids[d.ID], ids[dep]); err != nil {
				return err
			}
		}
	}
	return nil
}

func structOf(data []byte) (*structpb.Struct, error) {
	if data == nil {
		return nil, nil
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil || m == nil {
		return nil, err
	}
	return structpb.NewStruct(m)
}

func timestamp(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
}

// GetExecution is an execution and its tasks: state, attempts, outputs or
// failure, dependencies, and the current attempt's timing.
func (s *Service) GetExecution(ctx context.Context, req *connect.Request[kernelv1.GetExecutionRequest]) (*connect.Response[kernelv1.GetExecutionResponse], error) {
	id, err := executionID(req.Msg.GetExecutionId())
	if err != nil {
		return nil, err
	}
	execution := &kernelv1.Execution{ExecutionId: id}
	var st string
	err = s.Pool.QueryRow(ctx, `SELECT external_reference, state FROM executions WHERE id = $1`, id).Scan(&execution.Name, &st)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	execution.State = executionState(st)
	rows, err := s.Pool.Query(ctx, `SELECT t.task_key, t.state, t.attempt_count, o.outputs, t.failure,
			coalesce((SELECT array_agg(d.task_key ORDER BY d.task_key) FROM task_dependencies td
				JOIN execution_tasks d ON d.id = td.depends_on_task_id WHERE td.task_id = t.id), '{}'),
			a.started_at, a.completed_at, t.approval_required, coalesce(t.approved_by, ''), t.approved_at,
			CASE WHEN t.state = 'AWAITING_APPROVAL' THEN t.available_at END,
			CASE WHEN t.state = 'READY' AND EXISTS (SELECT 1 FROM execution_tasks h WHERE h.concurrency_key = t.concurrency_key
				AND h.state IN ('CLAIMED', 'RUNNING') AND h.id <> t.id) THEN t.concurrency_key END, t.concurrency_inputs,
			t.state = 'READY' AND t.cap_scope IS NOT NULL AND (SELECT count(*) FROM execution_tasks c WHERE c.cap_scope = t.cap_scope
				AND c.state IN ('CLAIMED', 'RUNNING')) >= t.cap_limit
		FROM execution_tasks t
		LEFT JOIN task_outputs o ON o.task_id = t.id
		LEFT JOIN LATERAL (SELECT started_at, completed_at FROM task_attempts
			WHERE task_id = t.id ORDER BY attempt_number DESC LIMIT 1) a ON true
		WHERE t.execution_id = $1 ORDER BY t.task_key`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		task := &kernelv1.TaskStatus{}
		var taskSt string
		var attempts int32
		var outputs, failure []byte
		var started, completed, approved, awaiting *time.Time
		var waitingKey *string
		var keyInputs []string
		if err := rows.Scan(&task.TaskId, &taskSt, &attempts, &outputs, &failure, &task.DependsOn, &started, &completed,
			&task.ApprovalRequired, &task.ApprovedBy, &approved, &awaiting, &waitingKey, &keyInputs, &task.WaitingForCap); err != nil {
			return nil, err
		}
		if waitingKey != nil {
			if values := domain.ConcurrencyValues(*waitingKey, keyInputs); values != nil {
				if task.WaitingFor, err = structpb.NewStruct(values); err != nil {
					return nil, err
				}
			}
		}
		task.State, task.AttemptCount = taskState(taskSt), attempts
		if task.Outputs, err = structOf(outputs); err != nil {
			return nil, err
		}
		if task.Failure, err = structOf(failure); err != nil {
			return nil, err
		}
		task.StartedAt, task.CompletedAt = timestamp(started), timestamp(completed)
		task.ApprovedAt, task.AwaitingSince = timestamp(approved), timestamp(awaiting)
		execution.Tasks = append(execution.Tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := s.attachAttempts(ctx, id, execution.Tasks); err != nil {
		return nil, err
	}
	return connect.NewResponse(&kernelv1.GetExecutionResponse{Execution: execution}), nil
}

// GetExecutionStates is many executions' states; unknown ids are left out.
func (s *Service) GetExecutionStates(ctx context.Context, req *connect.Request[kernelv1.GetExecutionStatesRequest]) (*connect.Response[kernelv1.GetExecutionStatesResponse], error) {
	ids := req.Msg.GetExecutionIds()
	if len(ids) > MaxStatesPerRequest {
		return nil, invalid("execution_ids: at most %d, got %d", MaxStatesPerRequest, len(ids))
	}
	for i, id := range ids {
		parsed, err := executionID(id)
		if err != nil {
			return nil, err
		}
		ids[i] = parsed
	}
	out := &kernelv1.GetExecutionStatesResponse{}
	if len(ids) == 0 {
		return connect.NewResponse(out), nil
	}
	// Each execution with its steps counted by state, in one query; and,
	// when asked and while the execution is still active, the steps claimed
	// or running now (a cancelled execution's last steps may run until the
	// scheduler stops them, but it isn't doing anything any more). Tasks
	// carry no submission order (one transaction inserts them all), so
	// they're listed by step id.
	rows, err := s.Pool.Query(ctx, `
		SELECT e.id::text, e.state, e.created_at, e.updated_at,
		       COALESCE((SELECT jsonb_object_agg(t.state, t.n)
		                 FROM (SELECT state, count(*)::int AS n FROM execution_tasks
		                       WHERE execution_id = e.id GROUP BY state) t), '{}'::jsonb),
		       CASE WHEN $2 AND e.state IN ($3, $4) THEN
		         COALESCE((SELECT jsonb_agg(jsonb_build_object('taskId', t.task_key, 'action', t.action,
		                                                       'attempt', t.attempt_count, 'maxAttempts', t.max_attempts)
		                                    ORDER BY t.task_key)
		                   FROM execution_tasks t
		                   WHERE t.execution_id = e.id AND t.state IN ($5, $6)), '[]'::jsonb)
		       ELSE '[]'::jsonb END
		FROM executions e WHERE e.id = ANY($1::uuid[])`,
		ids, req.Msg.GetIncludeRunning(), string(domain.ExecutionPending), string(domain.ExecutionRunning),
		string(domain.TaskClaimed), string(domain.TaskRunning))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, st string
		var created, updated time.Time
		var steps map[string]int32
		var running []struct {
			TaskID      string `json:"taskId"`
			Action      string `json:"action"`
			Attempt     int32  `json:"attempt"`
			MaxAttempts int32  `json:"maxAttempts"`
		}
		if err := rows.Scan(&id, &st, &created, &updated, &steps, &running); err != nil {
			return nil, err
		}
		entry := &kernelv1.ExecutionStateEntry{
			ExecutionId: id,
			State:       executionState(st),
			Steps:       steps,
			CreatedAt:   timestamppb.New(created),
			UpdatedAt:   timestamppb.New(updated),
		}
		for _, r := range running {
			// attempt_count counts the attempts claimed: the one running is the last.
			entry.Running = append(entry.Running, &kernelv1.RunningStep{
				TaskId: r.TaskID, Action: r.Action, Attempt: max(r.Attempt, 1), MaxAttempts: r.MaxAttempts,
			})
		}
		out.States = append(out.States, entry)
	}
	return connect.NewResponse(out), rows.Err()
}

func (s *Service) exists(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id string) (string, error) {
	var st string
	err := db.QueryRow(ctx, `SELECT state FROM executions WHERE id = $1`, id).Scan(&st)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errNotFound
	}
	return st, err
}

// ListExecutionEvents is a page of an execution's events, each task's by its
// key (callers never see row ids). Cursor-paginated by event id: stable
// while events are appended, and an indexed lookup.
func (s *Service) ListExecutionEvents(ctx context.Context, req *connect.Request[kernelv1.ListExecutionEventsRequest]) (*connect.Response[kernelv1.ListExecutionEventsResponse], error) {
	id, err := executionID(req.Msg.GetExecutionId())
	if err != nil {
		return nil, err
	}
	limit := req.Msg.GetLimit()
	if limit == 0 {
		limit = 100
	}
	if limit < 1 || limit > 1000 {
		return nil, invalid("limit: 1 to 1000, got %d", limit)
	}
	if req.Msg.After != nil && req.Msg.GetAfter() < 1 {
		return nil, invalid("after: at least 1, got %d", req.Msg.GetAfter())
	}
	if _, err := s.exists(ctx, s.Pool, id); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT e.id, e.event_type, coalesce(t.task_key, ''), e.payload, e.created_at
		FROM execution_events e LEFT JOIN execution_tasks t ON t.id = e.task_id
		WHERE e.execution_id = $1 AND e.id > $2 ORDER BY e.id LIMIT $3`, id, req.Msg.GetAfter(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &kernelv1.ListExecutionEventsResponse{}
	for rows.Next() {
		event := &kernelv1.ExecutionEvent{}
		var payload []byte
		var created time.Time
		if err := rows.Scan(&event.Id, &event.EventType, &event.TaskId, &payload, &created); err != nil {
			return nil, err
		}
		if event.Payload, err = structOf(payload); err != nil {
			return nil, err
		}
		if event.Payload == nil {
			event.Payload = &structpb.Struct{}
		}
		event.CreatedAt = timestamppb.New(created)
		out.Events = append(out.Events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// A full page may have more after it; a short one has caught up.
	if len(out.Events) == int(limit) {
		next := out.Events[len(out.Events)-1].Id
		out.NextCursor = &next
	}
	return connect.NewResponse(out), nil
}

// GetExecutionLogs is every task's captured output; [] for one with none yet.
func (s *Service) GetExecutionLogs(ctx context.Context, req *connect.Request[kernelv1.GetExecutionLogsRequest]) (*connect.Response[kernelv1.GetExecutionLogsResponse], error) {
	id, err := executionID(req.Msg.GetExecutionId())
	if err != nil {
		return nil, err
	}
	if _, err := s.exists(ctx, s.Pool, id); err != nil {
		return nil, err
	}
	rows, err := s.Pool.Query(ctx, `SELECT t.task_key, coalesce(l.lines, '{}') FROM execution_tasks t
		LEFT JOIN task_logs l ON l.task_id = t.id WHERE t.execution_id = $1 ORDER BY t.task_key`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &kernelv1.GetExecutionLogsResponse{}
	for rows.Next() {
		logs := &kernelv1.TaskLogs{}
		if err := rows.Scan(&logs.TaskId, &logs.Lines); err != nil {
			return nil, err
		}
		out.Tasks = append(out.Tasks, logs)
	}
	return connect.NewResponse(out), rows.Err()
}

var errFinished = connect.NewError(connect.CodeFailedPrecondition, errors.New("Execution has already finished and cannot be cancelled."))

// errFinishedMeanwhile rolls back CancelExecution's savepoint when the
// execution finished between being read and being cancelled.
var errFinishedMeanwhile = errors.New("finished meanwhile")

// CancelExecution cancels the unstarted tasks at once; a CLAIMED or RUNNING
// one is stopped by the scheduler's next pass, which sees the execution
// CANCELLED (kernel-api has no executor to stop it with).
func (s *Service) CancelExecution(ctx context.Context, req *connect.Request[kernelv1.CancelExecutionRequest]) (*connect.Response[kernelv1.CancelExecutionResponse], error) {
	id, err := executionID(req.Msg.GetExecutionId())
	if err != nil {
		return nil, err
	}
	finished := func(st string) error {
		if st == string(domain.ExecutionCancelled) {
			return nil // idempotent
		}
		return errFinished
	}
	err = s.inTx(ctx, func(t *tx) error {
		st, err := s.exists(ctx, t, id)
		if err != nil {
			return err
		}
		if st != string(domain.ExecutionPending) && st != string(domain.ExecutionRunning) {
			return finished(st)
		}
		// Conditional UPDATEs, not states read and written back: the
		// scheduler may be dispatching one of these tasks right now, holding
		// its row lock. An UPDATE waits for that lock, then re-checks its
		// WHERE against what the scheduler committed, so a task that just
		// became RUNNING is left for the scheduler to stop, not overwritten
		// with CANCELLED and its Job left running unwatched. The same goes
		// for the execution finishing meanwhile. Tasks first, then the
		// execution: the scheduler's lock order.
		type cancelled struct{ id, key string }
		var tasks []cancelled
		err = pgx.BeginFunc(ctx, t.Tx, func(sp pgx.Tx) error {
			rows, err := sp.Query(ctx, `UPDATE execution_tasks SET state = 'CANCELLED', updated_at = now()
				WHERE execution_id = $1 AND state IN ('READY', 'BLOCKED', 'AWAITING_APPROVAL') RETURNING id::text, task_key`, id)
			if err != nil {
				return err
			}
			for rows.Next() {
				var c cancelled
				if err := rows.Scan(&c.id, &c.key); err != nil {
					rows.Close()
					return err
				}
				tasks = append(tasks, c)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
			tag, err := sp.Exec(ctx, `UPDATE executions SET state = 'CANCELLED', updated_at = now()
				WHERE id = $1 AND state IN ('PENDING', 'RUNNING')`, id)
			if err == nil && tag.RowsAffected() == 0 {
				return errFinishedMeanwhile
			}
			return err
		})
		if errors.Is(err, errFinishedMeanwhile) {
			st, err := s.exists(ctx, t, id)
			if err != nil {
				return err
			}
			return finished(st)
		}
		if err != nil {
			return err
		}
		if err := t.recordEvent(ctx, id, nil, domain.EventExecutionCancelled, nil); err != nil {
			return err
		}
		for _, c := range tasks {
			if err := t.recordEvent(ctx, id, &c.id, domain.EventTaskCancelled, map[string]any{"taskKey": c.key}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	st, err := s.exists(ctx, s.Pool, id)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&kernelv1.CancelExecutionResponse{ExecutionId: id, State: executionState(st)}), nil
}

// RetryTask gives a FAILED task one more attempt, whatever its max_attempts
// (that only gates the scheduler's automatic retries). A failed task means
// a failed execution, so it resumes, and the tasks the failure cancelled
// come back: READY if their dependencies all succeeded, else BLOCKED. A task
// that needs an approval it hasn't had (a declined one, say) awaits it
// again instead of becoming READY.
func (s *Service) RetryTask(ctx context.Context, req *connect.Request[kernelv1.RetryTaskRequest]) (*connect.Response[kernelv1.RetryTaskResponse], error) {
	id, err := executionID(req.Msg.GetExecutionId())
	if err != nil {
		return nil, err
	}
	key := req.Msg.GetTaskId()
	notFound := connect.NewError(connect.CodeNotFound, errors.New("Not found."))
	err = s.inTx(ctx, func(t *tx) error {
		state, err := s.exists(ctx, t, id)
		if err != nil {
			return notFound
		}
		var taskID string
		var attempts int
		// Conditional, like every state change here: the scheduler may be
		// changing the same row.
		requestedBy := nullable(req.Msg.GetRequestedBy())
		err = t.QueryRow(ctx, `UPDATE execution_tasks SET state = `+domain.ReadyOrAwaitingSQL+`, lease_owner = NULL, lease_expires_at = NULL,
			executor_handle = NULL, failure = NULL, available_at = now(), next_attempt_requested_by = $3, updated_at = now()
			WHERE execution_id = $1 AND task_key = $2 AND state = 'FAILED' RETURNING id::text, attempt_count`, id, key, requestedBy).Scan(&taskID, &attempts)
		if errors.Is(err, pgx.ErrNoRows) {
			var exists bool
			if err := t.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM execution_tasks WHERE execution_id = $1 AND task_key = $2)`, id, key).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return notFound
			}
			return connect.NewError(connect.CodeFailedPrecondition, errors.New("Only a FAILED task can be retried."))
		}
		if err != nil {
			return err
		}
		// Only a failed or still-running execution's (the transaction
		// undoes the update above): a cancelled one's tasks would come back
		// READY or BLOCKED where nothing claims them.
		if state != string(domain.ExecutionFailed) && state != string(domain.ExecutionRunning) {
			return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("This execution is %s: only a failed or running execution's task can be retried.", state))
		}
		if err := t.recordEvent(ctx, id, &taskID, domain.EventTaskRetried, map[string]any{"taskKey": key, "attempt": attempts}); err != nil {
			return err
		}
		tag, err := t.Exec(ctx, `UPDATE executions SET state = 'RUNNING', updated_at = now() WHERE id = $1 AND state = 'FAILED'`, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			if err := t.recordEvent(ctx, id, nil, domain.EventExecutionResumed, nil); err != nil {
				return err
			}
		}
		_, err = t.Exec(ctx, `UPDATE execution_tasks t SET
				state = CASE WHEN waiting THEN 'BLOCKED' WHEN t.approval_required AND t.approved_at IS NULL
					THEN 'AWAITING_APPROVAL' ELSE 'READY' END,
				available_at = CASE WHEN waiting THEN t.available_at ELSE now() END,
				next_attempt_requested_by = $2,
				updated_at = now()
			FROM (SELECT c.id, EXISTS (SELECT 1 FROM task_dependencies td JOIN execution_tasks d ON d.id = td.depends_on_task_id
					WHERE td.task_id = c.id AND d.state <> 'SUCCEEDED') AS waiting
				FROM execution_tasks c WHERE c.execution_id = $1 AND c.state = 'CANCELLED') revived
			WHERE t.id = revived.id`, id, requestedBy)
		return err
	})
	if err != nil {
		return nil, err
	}
	st, err := s.exists(ctx, s.Pool, id)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&kernelv1.RetryTaskResponse{ExecutionId: id, State: executionState(st)}), nil
}

// nullable is NULL for an empty string.
func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// attachAttempts adds every attempt of the execution's tasks, first to last:
// when it ran, how it ended, who asked for it and what acted in it.
func (s *Service) attachAttempts(ctx context.Context, executionID string, tasks []*kernelv1.TaskStatus) error {
	byKey := map[string]*kernelv1.TaskStatus{}
	for _, t := range tasks {
		byKey[t.TaskId] = t
	}
	rows, err := s.Pool.Query(ctx, `SELECT t.task_key, a.attempt_number, a.started_at, a.completed_at, a.failure,
			coalesce(a.requested_by, ''), coalesce(a.trigger, ''), coalesce(a.acted_as, ''), coalesce(a.image, '')
		FROM task_attempts a JOIN execution_tasks t ON t.id = a.task_id
		WHERE t.execution_id = $1 ORDER BY t.task_key, a.attempt_number`, executionID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var started, completed *time.Time
		var failure []byte
		a := &kernelv1.Attempt{}
		if err := rows.Scan(&key, &a.Number, &started, &completed, &failure, &a.RequestedBy, &a.Trigger, &a.ActedAs, &a.Image); err != nil {
			return err
		}
		a.StartedAt, a.CompletedAt = timestamp(started), timestamp(completed)
		if a.Failure, err = structOf(failure); err != nil {
			return err
		}
		if t := byKey[key]; t != nil {
			t.Attempts = append(t.Attempts, a)
		}
	}
	return rows.Err()
}
