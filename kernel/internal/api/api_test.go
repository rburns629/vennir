// SPDX-License-Identifier: MIT

package api

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/types/known/structpb"

	"github.com/rburns629/vertra/kernel/internal/dbtest"
	kernelv1 "github.com/rburns629/vertra/kernel/internal/gen/vertra/kernel/v1"
	"github.com/rburns629/vertra/kernel/internal/gen/vertra/kernel/v1/kernelv1connect"
	"github.com/rburns629/vertra/kernel/internal/migrate"
)

// Ported from the Python kernel's tests/integration/test_api_{executions,cancel_retry}.py
// and test_execution_service.py: kernel-api over HTTP, through the
// generated client, on a database of its own (these commit). Refusing
// Python field names and accepting the old ones is now the console's
// client's job (console/src/kernel/client.ts), where JSON becomes a request.

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	dbtest.MainFresh(m, &testPool, func(pool *pgxpool.Pool) error {
		conn, err := pool.Acquire(context.Background())
		if err != nil {
			return err
		}
		defer conn.Release()
		_, err = migrate.Run(context.Background(), conn, quiet)
		return err
	})
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func server(t *testing.T, pool *pgxpool.Pool, callers *Callers) (*httptest.Server, kernelv1connect.KernelServiceClient) {
	t.Helper()
	srv := httptest.NewServer(Handler(&Service{Pool: pool, MaxTasks: 500, Log: quiet}, callers, pool, quiet))
	t.Cleanup(srv.Close)
	return srv, kernelv1connect.NewKernelServiceClient(srv.Client(), srv.URL)
}

func client(t *testing.T) kernelv1connect.KernelServiceClient {
	_, c := server(t, testPool, nil)
	return c
}

func inputs(m map[string]any) *structpb.Struct {
	s, err := structpb.NewStruct(m)
	if err != nil {
		panic(err)
	}
	return s
}

func chain(requestID string) *kernelv1.SubmitExecutionRequest {
	return &kernelv1.SubmitExecutionRequest{Name: "demo-order-1", RequestId: requestID, Tasks: []*kernelv1.Task{
		{Id: "create-project", Image: "demo-project-product:local", Action: "create", Team: "test-team", ServiceAccount: "default",
			Inputs: inputs(map[string]any{"projectName": "demo-project"})},
		{Id: "deploy-application", Image: "demo-application-product:local", Action: "create", Team: "test-team", ServiceAccount: "default",
			DependsOn: []string{"create-project"},
			Inputs:    inputs(map[string]any{"projectId": map[string]any{"$fromTask": "create-project", "$output": "projectId"}})},
	}}
}

func single(requestID string) *kernelv1.SubmitExecutionRequest {
	return &kernelv1.SubmitExecutionRequest{Name: "demo-order-1", RequestId: requestID, Tasks: []*kernelv1.Task{
		{Id: "create-project", Image: "x:local", Action: "create", Team: "test-team", ServiceAccount: "default"}}}
}

func submit(t *testing.T, c kernelv1connect.KernelServiceClient, req *kernelv1.SubmitExecutionRequest) *kernelv1.SubmitExecutionResponse {
	t.Helper()
	res, err := c.SubmitExecution(context.Background(), connect.NewRequest(req))
	if err != nil {
		t.Fatal(err)
	}
	return res.Msg
}

func unique(name string) string { return name + "-" + uuid.NewString() }

func code(t *testing.T, err error, want connect.Code) *connect.Error {
	t.Helper()
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != want {
		t.Fatalf("err = %v, want %s", err, want)
	}
	return ce
}

func issueCodes(t *testing.T, err error) []string {
	t.Helper()
	ce := code(t, err, connect.CodeInvalidArgument)
	var codes []string
	for _, d := range ce.Details() {
		v, derr := d.Value()
		if issues, ok := v.(*kernelv1.ValidationIssues); derr == nil && ok {
			for _, i := range issues.Issues {
				codes = append(codes, i.Code)
			}
		}
	}
	return codes
}

func get(t *testing.T, c kernelv1connect.KernelServiceClient, id string) *kernelv1.Execution {
	t.Helper()
	res, err := c.GetExecution(context.Background(), connect.NewRequest(&kernelv1.GetExecutionRequest{ExecutionId: id}))
	if err != nil {
		t.Fatal(err)
	}
	return res.Msg.Execution
}

func tasksByID(e *kernelv1.Execution) map[string]*kernelv1.TaskStatus {
	m := map[string]*kernelv1.TaskStatus{}
	for _, task := range e.Tasks {
		m[task.TaskId] = task
	}
	return m
}

func exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

// --- submitting ---

func TestANewSubmissionIsStoredPending(t *testing.T) {
	c := client(t)
	res := submit(t, c, chain(unique("new")))
	if !res.Created || res.State != kernelv1.ExecutionState_EXECUTION_STATE_PENDING || uuid.Validate(res.ExecutionId) != nil {
		t.Fatalf("response = %v", res)
	}
	e := get(t, c, res.ExecutionId)
	tasks := tasksByID(e)
	if e.Name != "demo-order-1" || tasks["create-project"].State != kernelv1.TaskState_TASK_STATE_READY ||
		tasks["deploy-application"].State != kernelv1.TaskState_TASK_STATE_BLOCKED || tasks["create-project"].Outputs != nil ||
		!slices.Equal(tasks["deploy-application"].DependsOn, []string{"create-project"}) {
		t.Fatalf("execution = %v", e)
	}
	var inputsJSON, resources string
	var timeout, attempts int
	var secretRefs []string
	if err := testPool.QueryRow(context.Background(), `SELECT original_inputs::text, coalesce(resources::text, ''), timeout_seconds, max_attempts, secret_refs
		FROM execution_tasks WHERE execution_id = $1 AND task_key = 'deploy-application'`, res.ExecutionId).Scan(&inputsJSON, &resources, &timeout, &attempts, &secretRefs); err != nil {
		t.Fatal(err)
	}
	if inputsJSON != `{"projectId": {"$output": "projectId", "$fromTask": "create-project"}}` || resources != "" || timeout != 300 || attempts != 1 || len(secretRefs) != 0 {
		t.Errorf("stored %s %q %d %d %v", inputsJSON, resources, timeout, attempts, secretRefs)
	}
}

func TestEverythingAsSubmittedIsStored(t *testing.T) {
	c := client(t)
	timeout, attempts := int32(60), int32(3)
	req := single(unique("full"))
	req.Tasks[0].SecretRefs = []string{"gcp-key"}
	req.Tasks[0].TimeoutSeconds, req.Tasks[0].MaxAttempts = &timeout, &attempts
	req.Tasks[0].Resources = &kernelv1.Resources{Cpu: "250m", MemoryLimit: "1Gi"}
	req.Tasks[0].ForTeam = "data"
	res := submit(t, c, req)
	var resources, forTeam string
	var gotTimeout, gotAttempts int
	var secretRefs []string
	if err := testPool.QueryRow(context.Background(), `SELECT resources::text, timeout_seconds, max_attempts, secret_refs, for_team
		FROM execution_tasks WHERE execution_id = $1`, res.ExecutionId).Scan(&resources, &gotTimeout, &gotAttempts, &secretRefs, &forTeam); err != nil {
		t.Fatal(err)
	}
	// The JSON names the scheduler reads (domain.TaskResources).
	if resources != `{"cpu": "250m", "memoryLimit": "1Gi"}` || gotTimeout != 60 || gotAttempts != 3 || !slices.Equal(secretRefs, []string{"gcp-key"}) ||
		forTeam != "data" {
		t.Errorf("stored %s %d %d %v %q", resources, gotTimeout, gotAttempts, secretRefs, forTeam)
	}
}

func TestTheSameRequestIDReturnsTheSameExecution(t *testing.T) {
	c := client(t)
	req := chain(unique("idem"))
	first, second := submit(t, c, req), submit(t, c, req)
	if !first.Created || second.Created || first.ExecutionId != second.ExecutionId {
		t.Fatalf("first %v, second %v", first, second)
	}
	var n int
	_ = testPool.QueryRow(context.Background(), `SELECT count(*) FROM executions WHERE idempotency_key = $1`, req.RequestId).Scan(&n)
	if n != 1 {
		t.Errorf("%d executions", n)
	}
}

// Two at once with the same request_id: one creates, the other gets it.
func TestConcurrentSubmissionsWithOneRequestIDMakeOneExecution(t *testing.T) {
	c := client(t)
	req := single(unique("race"))
	results := make(chan *kernelv1.SubmitExecutionResponse, 8)
	for range 8 {
		go func() {
			res, err := c.SubmitExecution(context.Background(), connect.NewRequest(req))
			if err != nil {
				t.Error(err)
				results <- nil
				return
			}
			results <- res.Msg
		}()
	}
	ids, created := map[string]bool{}, 0
	for range 8 {
		if r := <-results; r != nil {
			ids[r.ExecutionId] = true
			if r.Created {
				created++
			}
		}
	}
	if len(ids) != 1 || created != 1 {
		t.Errorf("%d executions, %d created", len(ids), created)
	}
}

func TestWithoutARequestIDEverySubmissionIsNew(t *testing.T) {
	c := client(t)
	first, second := submit(t, c, chain("")), submit(t, c, chain(""))
	if !first.Created || !second.Created || first.ExecutionId == second.ExecutionId {
		t.Fatalf("first %v, second %v", first, second)
	}
}

func TestAnInvalidDAGIsRefusedWithEveryIssueAndNothingStored(t *testing.T) {
	c := client(t)
	req := single(unique("cycle"))
	req.Tasks = []*kernelv1.Task{
		{Id: "a", Image: "a:1", Action: "run", Team: "t", ServiceAccount: "default", DependsOn: []string{"b"}},
		{Id: "b", Image: "b:1", Action: "run", Team: "t", ServiceAccount: "default", DependsOn: []string{"a"}},
	}
	_, err := c.SubmitExecution(context.Background(), connect.NewRequest(req))
	if codes := issueCodes(t, err); !slices.Contains(codes, "CYCLE_DETECTED") {
		t.Errorf("codes = %v", codes)
	}
	var n int
	_ = testPool.QueryRow(context.Background(), `SELECT count(*) FROM executions WHERE idempotency_key = $1`, req.RequestId).Scan(&n)
	if n != 0 {
		t.Error("stored anyway")
	}
}

func TestMalformedSubmissionsAreRefused(t *testing.T) {
	c := client(t)
	zero := int32(0)
	for name, change := range map[string]func(*kernelv1.SubmitExecutionRequest){
		"no name":            func(r *kernelv1.SubmitExecutionRequest) { r.Name = "" },
		"no tasks":           func(r *kernelv1.SubmitExecutionRequest) { r.Tasks = nil },
		"a task with no id":  func(r *kernelv1.SubmitExecutionRequest) { r.Tasks[0].Id = "" },
		"no service account": func(r *kernelv1.SubmitExecutionRequest) { r.Tasks[0].ServiceAccount = "" },
		"a zero timeout":     func(r *kernelv1.SubmitExecutionRequest) { r.Tasks[0].TimeoutSeconds = &zero },
		"zero attempts":      func(r *kernelv1.SubmitExecutionRequest) { r.Tasks[0].MaxAttempts = &zero },
		"a size that isn't a quantity": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].Resources = &kernelv1.Resources{Memory: "512 MiB"}
		},
		"a token audience that can't be a file": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].TokenAudiences = []string{".."}
		},
		"an input schema that isn't one": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].InputSchema, _ = structpb.NewStruct(map[string]any{"type": "no-such-type"})
		},
		"an output schema that refers outside itself": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].OutputSchema, _ = structpb.NewStruct(map[string]any{"$ref": "https://example.com/s.json"})
		},
		"a concurrency key with no inputs": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].ConcurrencyKey = &kernelv1.ConcurrencyKey{Scope: "acme-project"}
		},
		"a concurrency key with no scope": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].ConcurrencyKey = &kernelv1.ConcurrencyKey{Inputs: []string{"projectId"}}
		},
		"a product cap of none": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].ProductCap = &kernelv1.ProductCap{Scope: "teams/web/products/site"}
		},
		"a product cap past the most": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].ProductCap = &kernelv1.ProductCap{Scope: "teams/web/products/site", MaxRunning: 101}
		},
		"a product cap with no scope": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].ProductCap = &kernelv1.ProductCap{MaxRunning: 2}
		},
		"a capacity that isn't one": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].Capacity = "preemptible"
		},
		"a for_team that isn't a namespace name": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].ForTeam = "Data Team"
		},
		"a for_team that ends in a hyphen": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].ForTeam = "data-"
		},
		"a for_team past 63 characters": func(r *kernelv1.SubmitExecutionRequest) {
			r.Tasks[0].ForTeam = strings.Repeat("a", 64)
		},
	} {
		req := single(unique("malformed"))
		change(req)
		_, err := c.SubmitExecution(context.Background(), connect.NewRequest(req))
		var ce *connect.Error
		if !errors.As(err, &ce) || ce.Code() != connect.CodeInvalidArgument {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// --- reading ---

func TestAnUnknownOrMalformedExecutionID(t *testing.T) {
	c := client(t)
	_, err := c.GetExecution(context.Background(), connect.NewRequest(&kernelv1.GetExecutionRequest{ExecutionId: uuid.NewString()}))
	code(t, err, connect.CodeNotFound)
	_, err = c.GetExecution(context.Background(), connect.NewRequest(&kernelv1.GetExecutionRequest{ExecutionId: "not-a-uuid"}))
	code(t, err, connect.CodeInvalidArgument)
	_, err = c.ListExecutionEvents(context.Background(), connect.NewRequest(&kernelv1.ListExecutionEventsRequest{ExecutionId: uuid.NewString()}))
	code(t, err, connect.CodeNotFound)
	_, err = c.GetExecutionLogs(context.Background(), connect.NewRequest(&kernelv1.GetExecutionLogsRequest{ExecutionId: uuid.NewString()}))
	code(t, err, connect.CodeNotFound)
}

// The API reads the rows as they are now, not a snapshot.
func TestItReflectsTheSchedulersProgress(t *testing.T) {
	c := client(t)
	id := submit(t, c, chain(unique("live"))).ExecutionId
	var taskID string
	_ = testPool.QueryRow(context.Background(), `SELECT id::text FROM execution_tasks WHERE execution_id = $1 AND task_key = 'create-project'`, id).Scan(&taskID)
	exec(t, `UPDATE execution_tasks SET state = 'SUCCEEDED', attempt_count = 1 WHERE id = $1`, taskID)
	exec(t, `INSERT INTO task_outputs (task_id, outputs) VALUES ($1, '{"projectId": "p-1"}')`, taskID)
	exec(t, `INSERT INTO task_attempts (id, task_id, attempt_number, started_at, completed_at) VALUES (gen_random_uuid(), $1, 1, now() - interval '1 minute', now())`, taskID)
	exec(t, `INSERT INTO task_logs (task_id, lines) VALUES ($1, '{"made p-1"}')`, taskID)
	task := tasksByID(get(t, c, id))["create-project"]
	if task.State != kernelv1.TaskState_TASK_STATE_SUCCEEDED || task.AttemptCount != 1 || task.Outputs.AsMap()["projectId"] != "p-1" ||
		task.StartedAt == nil || task.CompletedAt == nil {
		t.Fatalf("task = %v", task)
	}
	logs, err := c.GetExecutionLogs(context.Background(), connect.NewRequest(&kernelv1.GetExecutionLogsRequest{ExecutionId: id}))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]string{}
	for _, l := range logs.Msg.Tasks {
		got[l.TaskId] = l.Lines
	}
	if !slices.Equal(got["create-project"], []string{"made p-1"}) || len(got["deploy-application"]) != 0 || len(got) != 2 {
		t.Errorf("logs = %v", got)
	}
}

func TestEventsComeInOrderAPageAtATime(t *testing.T) {
	c := client(t)
	id := submit(t, c, chain(unique("events"))).ExecutionId
	res, err := c.ListExecutionEvents(context.Background(), connect.NewRequest(&kernelv1.ListExecutionEventsRequest{ExecutionId: id}))
	if err != nil {
		t.Fatal(err)
	}
	events := res.Msg.Events
	if len(events) != 1 || events[0].EventType != "EXECUTION_CREATED" || events[0].Payload.AsMap()["taskCount"] != 2.0 || res.Msg.NextCursor != nil {
		t.Fatalf("events = %v, next %v", events, res.Msg.NextCursor)
	}
	if _, err := c.CancelExecution(context.Background(), connect.NewRequest(&kernelv1.CancelExecutionRequest{ExecutionId: id})); err != nil {
		t.Fatal(err)
	}
	var all []*kernelv1.ExecutionEvent
	var after *int64
	for range 10 {
		page, err := c.ListExecutionEvents(context.Background(), connect.NewRequest(&kernelv1.ListExecutionEventsRequest{ExecutionId: id, After: after, Limit: 2}))
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, page.Msg.Events...)
		if after = page.Msg.NextCursor; after == nil {
			break
		}
	}
	var types []string
	for _, e := range all {
		types = append(types, e.EventType+":"+e.TaskId)
	}
	want := []string{"EXECUTION_CREATED:", "EXECUTION_CANCELLED:", "TASK_CANCELLED:create-project", "TASK_CANCELLED:deploy-application"}
	slices.Sort(types[2:])
	if !slices.Equal(types, want) {
		t.Errorf("events = %v", types)
	}
	_, err = c.ListExecutionEvents(context.Background(), connect.NewRequest(&kernelv1.ListExecutionEventsRequest{ExecutionId: id, Limit: 1001}))
	code(t, err, connect.CodeInvalidArgument)
}

func TestStatesAnswerForTheIDsThatExist(t *testing.T) {
	c := client(t)
	id := submit(t, c, single(unique("states"))).ExecutionId
	res, err := c.GetExecutionStates(context.Background(), connect.NewRequest(&kernelv1.GetExecutionStatesRequest{ExecutionIds: []string{id, uuid.NewString()}}))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Msg.States) != 1 || res.Msg.States[0].ExecutionId != id || res.Msg.States[0].State != kernelv1.ExecutionState_EXECUTION_STATE_PENDING {
		t.Fatalf("states = %v", res.Msg.States)
	}
	// With its steps counted by state, and when it was made and last changed.
	got := res.Msg.States[0]
	if !maps.Equal(got.Steps, map[string]int32{"READY": 1}) {
		t.Errorf("steps = %v", got.Steps)
	}
	if got.CreatedAt == nil || got.UpdatedAt == nil || got.UpdatedAt.AsTime().Before(got.CreatedAt.AsTime()) {
		t.Errorf("created %v, updated %v", got.CreatedAt, got.UpdatedAt)
	}
	if len(got.Running) != 0 {
		t.Errorf("nothing runs yet, but running = %v", got.Running)
	}
	ids := func(n int) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = uuid.NewString()
		}
		return out
	}
	if _, err := c.GetExecutionStates(context.Background(), connect.NewRequest(&kernelv1.GetExecutionStatesRequest{ExecutionIds: ids(MaxStatesPerRequest)})); err != nil {
		t.Errorf("a full batch: %v", err)
	}
	_, err = c.GetExecutionStates(context.Background(), connect.NewRequest(&kernelv1.GetExecutionStatesRequest{ExecutionIds: ids(MaxStatesPerRequest + 1)}))
	code(t, err, connect.CodeInvalidArgument)
}

func TestStatesSayWhichStepRunsAndItsAttempt(t *testing.T) {
	c := client(t)
	id := submit(t, c, chain(unique("running"))).ExecutionId
	exec(t, `UPDATE executions SET state = 'RUNNING' WHERE id = $1::uuid`, id)
	exec(t, `UPDATE execution_tasks SET state = 'SUCCEEDED', attempt_count = 1 WHERE execution_id = $1::uuid AND task_key = 'create-project'`, id)
	exec(t, `UPDATE execution_tasks SET state = 'RUNNING', attempt_count = 2, max_attempts = 3 WHERE execution_id = $1::uuid AND task_key = 'deploy-application'`, id)
	states := func(include bool) *kernelv1.ExecutionStateEntry {
		t.Helper()
		res, err := c.GetExecutionStates(context.Background(), connect.NewRequest(&kernelv1.GetExecutionStatesRequest{ExecutionIds: []string{id}, IncludeRunning: include}))
		if err != nil {
			t.Fatal(err)
		}
		return res.Msg.States[0]
	}
	running := states(true).Running
	if len(running) != 1 {
		t.Fatalf("running = %v", running)
	}
	if r := running[0]; r.TaskId != "deploy-application" || r.Action != "create" || r.Attempt != 2 || r.MaxAttempts != 3 {
		t.Errorf("running = %v", r)
	}
	// Only when asked: the console's purge check, say, has no use for it.
	if got := states(false); len(got.Running) != 0 || got.Steps["RUNNING"] != 1 {
		t.Errorf("not asked for, running = %v, steps = %v", got.Running, got.Steps)
	}
	// A cancelled execution isn't doing anything, though its last step may
	// stay RUNNING until the scheduler stops it.
	exec(t, `UPDATE executions SET state = 'CANCELLED' WHERE id = $1::uuid`, id)
	if got := states(true).Running; len(got) != 0 {
		t.Errorf("cancelled, but running = %v", got)
	}
}

// --- cancelling ---

func cancel(c kernelv1connect.KernelServiceClient, id string) (*kernelv1.CancelExecutionResponse, error) {
	res, err := c.CancelExecution(context.Background(), connect.NewRequest(&kernelv1.CancelExecutionRequest{ExecutionId: id}))
	if err != nil {
		return nil, err
	}
	return res.Msg, nil
}

func TestCancellingIsIdempotent(t *testing.T) {
	c := client(t)
	id := submit(t, c, single(unique("cancel"))).ExecutionId
	for range 2 {
		res, err := cancel(c, id)
		if err != nil || res.State != kernelv1.ExecutionState_EXECUTION_STATE_CANCELLED {
			t.Fatalf("%v %v", res, err)
		}
	}
	if tasksByID(get(t, c, id))["create-project"].State != kernelv1.TaskState_TASK_STATE_CANCELLED {
		t.Error("the unstarted task wasn't cancelled")
	}
	_, err := cancel(c, uuid.NewString())
	code(t, err, connect.CodeNotFound)
}

// A running task is the scheduler's to stop, at its next pass.
func TestCancellingLeavesARunningTaskForTheScheduler(t *testing.T) {
	c := client(t)
	id := submit(t, c, chain(unique("cancel-running"))).ExecutionId
	exec(t, `UPDATE execution_tasks SET state = 'RUNNING' WHERE execution_id = $1 AND task_key = 'create-project'`, id)
	exec(t, `UPDATE executions SET state = 'RUNNING' WHERE id = $1`, id)
	if _, err := cancel(c, id); err != nil {
		t.Fatal(err)
	}
	tasks := tasksByID(get(t, c, id))
	if tasks["create-project"].State != kernelv1.TaskState_TASK_STATE_RUNNING || tasks["deploy-application"].State != kernelv1.TaskState_TASK_STATE_CANCELLED {
		t.Errorf("tasks = %v", tasks)
	}
}

func TestAFinishedExecutionCantBeCancelled(t *testing.T) {
	c := client(t)
	id := submit(t, c, single(unique("cancel-finished"))).ExecutionId
	exec(t, `UPDATE executions SET state = 'SUCCEEDED' WHERE id = $1`, id)
	_, err := cancel(c, id)
	code(t, err, connect.CodeFailedPrecondition)
}

// --- retrying ---

func retry(c kernelv1connect.KernelServiceClient, id, task string) (*kernelv1.RetryTaskResponse, error) {
	res, err := c.RetryTask(context.Background(), connect.NewRequest(&kernelv1.RetryTaskRequest{ExecutionId: id, TaskId: task}))
	if err != nil {
		return nil, err
	}
	return res.Msg, nil
}

func TestRetryingAFailedTaskResumesTheExecutionAndRevivesItsSiblings(t *testing.T) {
	c := client(t)
	id := submit(t, c, chain(unique("retry"))).ExecutionId
	// As the scheduler leaves it: the task failed, the execution failed, the
	// dependent cancelled.
	exec(t, `UPDATE execution_tasks SET state = 'FAILED', attempt_count = 1, failure = '{"code": "BOOM", "message": "failed", "retryable": false}'
		WHERE execution_id = $1 AND task_key = 'create-project'`, id)
	exec(t, `UPDATE execution_tasks SET state = 'CANCELLED' WHERE execution_id = $1 AND task_key = 'deploy-application'`, id)
	exec(t, `UPDATE executions SET state = 'FAILED' WHERE id = $1`, id)
	if failure := tasksByID(get(t, c, id))["create-project"].Failure.AsMap(); failure["code"] != "BOOM" {
		t.Errorf("failure = %v", failure)
	}
	res, err := retry(c, id, "create-project")
	if err != nil || res.State != kernelv1.ExecutionState_EXECUTION_STATE_RUNNING {
		t.Fatalf("%v %v", res, err)
	}
	tasks := tasksByID(get(t, c, id))
	if tasks["create-project"].State != kernelv1.TaskState_TASK_STATE_READY || tasks["create-project"].Failure != nil ||
		tasks["deploy-application"].State != kernelv1.TaskState_TASK_STATE_BLOCKED {
		t.Errorf("tasks = %v", tasks)
	}
	page, _ := c.ListExecutionEvents(context.Background(), connect.NewRequest(&kernelv1.ListExecutionEventsRequest{ExecutionId: id}))
	var types []string
	for _, e := range page.Msg.Events {
		types = append(types, e.EventType)
	}
	if !slices.Equal(types, []string{"EXECUTION_CREATED", "TASK_RETRIED", "EXECUTION_RESUMED"}) {
		t.Errorf("events = %v", types)
	}
}

func TestOnlyAFailedTaskCanBeRetried(t *testing.T) {
	c := client(t)
	id := submit(t, c, single(unique("retry-refused"))).ExecutionId
	_, err := retry(c, id, "create-project")
	code(t, err, connect.CodeFailedPrecondition)
	_, err = retry(c, id, "does-not-exist")
	code(t, err, connect.CodeNotFound)
	_, err = retry(c, uuid.NewString(), "create-project")
	code(t, err, connect.CodeNotFound)

	// A failed task of an execution since cancelled: its siblings would come
	// back where nothing claims them.
	cancelled := submit(t, c, chain(unique("retry-cancelled"))).ExecutionId
	exec(t, `UPDATE execution_tasks SET state = 'FAILED', attempt_count = 1 WHERE execution_id = $1 AND task_key = 'create-project'`, cancelled)
	exec(t, `UPDATE execution_tasks SET state = 'CANCELLED' WHERE execution_id = $1 AND task_key = 'deploy-application'`, cancelled)
	exec(t, `UPDATE executions SET state = 'CANCELLED' WHERE id = $1`, cancelled)
	_, err = retry(c, cancelled, "create-project")
	code(t, err, connect.CodeFailedPrecondition)
	if tasks := tasksByID(get(t, c, cancelled)); tasks["deploy-application"].State != kernelv1.TaskState_TASK_STATE_CANCELLED {
		t.Errorf("a sibling revived: %v", tasks["deploy-application"].State)
	}
}

// --- the rest of the server ---

func TestHealth(t *testing.T) {
	srv, _ := server(t, testPool, nil)
	for path, want := range map[string]int{"/health/live": 200, "/health/ready": 200, "/metrics": 200} {
		res, err := http.Get(srv.URL + path)
		if err != nil || res.StatusCode != want {
			t.Errorf("%s: %v %v", path, res.StatusCode, err)
		}
	}
	// Not ready on a database the migration hasn't reached yet.
	empty := dbtest.Empty(t, testPool)
	srv, _ = server(t, empty, nil)
	if res, err := http.Get(srv.URL + "/health/ready"); err != nil || res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("ready before migrating: %v %v", res.StatusCode, err)
	}
	if res, err := http.Get(srv.URL + "/health/live"); err != nil || res.StatusCode != 200 {
		t.Errorf("live: %v %v", res.StatusCode, err)
	}
}

func TestEveryMethodNeedsAnAllowedCaller(t *testing.T) {
	callers := &Callers{Audience: "vertra-kernel-api", Allowed: []string{"system:serviceaccount:vertra-system:console"}, Log: quiet,
		Review: func(_ context.Context, token, _ string) (string, error) {
			return map[string]string{"console-token": "system:serviceaccount:vertra-system:console",
				"step-token": "system:serviceaccount:team-a:default"}[token], nil
		}}
	_, c := server(t, testPool, callers)
	ctx := context.Background()
	with := func(token string) *connect.Request[kernelv1.GetExecutionStatesRequest] {
		req := connect.NewRequest(&kernelv1.GetExecutionStatesRequest{})
		if token != "" {
			req.Header().Set("Authorization", "Bearer "+token)
		}
		return req
	}
	_, err := c.GetExecutionStates(ctx, with(""))
	code(t, err, connect.CodeUnauthenticated)
	_, err = c.GetExecutionStates(ctx, with("forged"))
	code(t, err, connect.CodeUnauthenticated)
	_, err = c.GetExecutionStates(ctx, with("step-token"))
	code(t, err, connect.CodePermissionDenied)
	if _, err := c.GetExecutionStates(ctx, with("console-token")); err != nil {
		t.Errorf("the console: %v", err)
	}
	// Every method, not just one.
	_, err = c.SubmitExecution(ctx, connect.NewRequest(single(unique("unauthenticated"))))
	code(t, err, connect.CodeUnauthenticated)
}

func TestAStepHeldByItsProductsCapSaysSo(t *testing.T) {
	c := client(t)
	scope := unique("teams/web/products/site")
	cappedSingle := func() string {
		req := single(unique("capped"))
		req.Tasks[0].ProductCap = &kernelv1.ProductCap{Scope: scope, MaxRunning: 1}
		return submit(t, c, req).ExecutionId
	}
	first, second := cappedSingle(), cappedSingle()
	exec(t, `UPDATE execution_tasks SET state = 'RUNNING' WHERE execution_id = $1::uuid`, first)
	exec(t, `UPDATE execution_tasks SET state = 'READY' WHERE execution_id = $1::uuid`, second)
	if !tasksByID(get(t, c, second))["create-project"].WaitingForCap {
		t.Error("the second doesn't say it waits for its product's cap")
	}
	if tasksByID(get(t, c, first))["create-project"].WaitingForCap {
		t.Error("the running one says it waits")
	}
	exec(t, `UPDATE execution_tasks SET state = 'SUCCEEDED' WHERE execution_id = $1::uuid`, first)
	if tasksByID(get(t, c, second))["create-project"].WaitingForCap {
		t.Error("still waiting once the other finished")
	}
}

func TestAStepHeldByItsConcurrencyKeySaysWhatItsWaitingFor(t *testing.T) {
	c := client(t)
	scope := unique("acme-project")
	keyedSingle := func() string {
		req := single(unique("keyed"))
		req.Tasks[0].ConcurrencyKey = &kernelv1.ConcurrencyKey{Scope: scope, Inputs: []string{"projectId"}}
		return submit(t, c, req).ExecutionId
	}
	first, second := keyedSingle(), keyedSingle()
	key := `["` + scope + `","web-1"]`
	exec(t, `UPDATE execution_tasks SET state = 'RUNNING', concurrency_key = $1 WHERE execution_id = $2::uuid`, key, first)
	exec(t, `UPDATE execution_tasks SET state = 'READY', concurrency_key = $1 WHERE execution_id = $2::uuid`, key, second)

	waiting := tasksByID(get(t, c, second))["create-project"].WaitingFor.AsMap()
	if len(waiting) != 1 || waiting["projectId"] != "web-1" {
		t.Errorf("waiting for = %v", waiting)
	}
	if running := tasksByID(get(t, c, first))["create-project"]; running.WaitingFor != nil {
		t.Errorf("the running one waits for %v", running.WaitingFor)
	}
	exec(t, `UPDATE execution_tasks SET state = 'SUCCEEDED' WHERE execution_id = $1::uuid`, first)
	if task := tasksByID(get(t, c, second))["create-project"]; task.WaitingFor != nil {
		t.Errorf("still waiting for %v once the other finished", task.WaitingFor)
	}
}
