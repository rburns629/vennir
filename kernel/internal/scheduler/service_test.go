// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rburns629/vertra/kernel/internal/domain"
	"github.com/rburns629/vertra/kernel/internal/executor"
	"github.com/rburns629/vertra/kernel/internal/executor/executortest"
)

// Ported from the Python kernel's tests/integration/test_scheduler_service.py.

func twoTasks(outputKey string, attempts int) []TaskDef {
	return []TaskDef{
		task("create-project", inputs(map[string]any{"projectName": "demo-project"}), maxAttempts(attempts)),
		task("deploy-application", dependsOn("create-project"), maxAttempts(attempts),
			inputs(map[string]any{"projectId": map[string]any{"$fromTask": "create-project", "$output": outputKey}}),
			func(d *TaskDef) { d.Image = "demo-application-product:local" }),
	}
}

func TestFullTwoTaskChainSucceedsWithOrderedEvents(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-success", twoTasks("projectId", 1)...)
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()

	k.tick(t0)
	tasks := tasksByKey(t, tx, id)
	equal(t, "create-project", tasks["create-project"].State, domain.TaskRunning)
	equal(t, "deploy-application", tasks["deploy-application"].State, domain.TaskBlocked)
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionRunning)

	exec.Complete(tasks["create-project"].ExecutorHandle, map[string]any{"projectId": "demo-project-123"})
	// Recorded first, so the task it released starts in the same pass.
	k.tick(t0.Add(time.Second))
	tasks = tasksByKey(t, tx, id)
	equal(t, "create-project", tasks["create-project"].State, domain.TaskSucceeded)
	equal(t, "deploy-application", tasks["deploy-application"].State, domain.TaskRunning)
	equal(t, "resolved inputs", tasks["deploy-application"].ResolvedInputs, map[string]any{"projectId": "demo-project-123"})

	exec.Complete(tasks["deploy-application"].ExecutorHandle, map[string]any{"applicationUrl": "https://demo.example"})
	k.tick(t0.Add(3 * time.Second))
	tasks = tasksByKey(t, tx, id)
	equal(t, "deploy-application", tasks["deploy-application"].State, domain.TaskSucceeded)
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionSucceeded)

	equal(t, "create-project outputs", outputsOf(t, tx, tasks["create-project"].ID), map[string]any{"projectId": "demo-project-123"})
	equal(t, "deploy outputs", outputsOf(t, tx, tasks["deploy-application"].ID), map[string]any{"applicationUrl": "https://demo.example"})
	lines, _ := logsOf(t, tx, tasks["create-project"].ID)
	equal(t, "create-project log", lines, []string{"started create-project attempt 1"})
	lines, _ = logsOf(t, tx, tasks["deploy-application"].ID)
	equal(t, "deploy log", lines, []string{"started deploy-application attempt 1"})

	equal(t, "events", eventTypes(t, tx, id), []string{"EXECUTION_CREATED", "TASK_CLAIMED", "EXECUTION_STARTED", "TASK_STARTED",
		"TASK_SUCCEEDED", "TASK_CLAIMED", "TASK_STARTED", "TASK_SUCCEEDED", "EXECUTION_SUCCEEDED"})
	var keys []any
	for _, e := range events(t, tx, id) {
		if e.TaskKey == nil {
			keys = append(keys, nil)
		} else {
			keys = append(keys, *e.TaskKey)
		}
	}
	equal(t, "event task keys", keys, []any{nil, "create-project", nil, "create-project", "create-project",
		"deploy-application", "deploy-application", "deploy-application", nil})
}

func TestLeaseIsRenewedWhileTaskIsStillRunning(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-renew", task("create-project"))
	k := newTicker(t, tx, fake())
	t0 := time.Now()
	k.tick(t0)
	first := *tasksByKey(t, tx, id)["create-project"].LeaseExpiresAt
	k.tick(t0.Add(30 * time.Second))
	now := tasksByKey(t, tx, id)["create-project"]
	equal(t, "state", now.State, domain.TaskRunning)
	if !now.LeaseExpiresAt.After(first) {
		t.Errorf("lease %v not renewed past %v", now.LeaseExpiresAt, first)
	}
}

func TestTerminalTaskFailureFailsExecutionAndCancelsSiblings(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-fail", twoTasks("projectId", 1)...)
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	tasks := tasksByKey(t, tx, id)
	exec.Fail(tasks["create-project"].ExecutorHandle, domain.StructuredError{Code: "PRODUCT_EXECUTION_FAILED", Message: "boom"})
	k.tick(t0.Add(time.Second))

	tasks = tasksByKey(t, tx, id)
	equal(t, "create-project", tasks["create-project"].State, domain.TaskFailed)
	equal(t, "failure code", tasks["create-project"].Failure["code"], "PRODUCT_EXECUTION_FAILED")
	equal(t, "deploy-application", tasks["deploy-application"].State, domain.TaskCancelled)
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionFailed)
	lines, _ := logsOf(t, tx, tasks["create-project"].ID)
	equal(t, "log", lines, []string{"started create-project attempt 1"})
	equal(t, "events", eventTypes(t, tx, id), []string{"EXECUTION_CREATED", "TASK_CLAIMED", "EXECUTION_STARTED", "TASK_STARTED", "TASK_FAILED", "EXECUTION_FAILED"})
}

func TestRetryableFailureRetriesAndEventuallySucceeds(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-retry", task("create-project", maxAttempts(2)))
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	equal(t, "attempts", tasksByKey(t, tx, id)["create-project"].AttemptCount, 1)
	exec.Fail(tasksByKey(t, tx, id)["create-project"].ExecutorHandle, domain.StructuredError{Code: "TRANSIENT", Message: "try again", Retryable: true})
	k.tick(t0.Add(time.Second))
	equal(t, "state", tasksByKey(t, tx, id)["create-project"].State, domain.TaskReady)

	// Not straight away: the first retry waits the backoff's base, 5s.
	k.tick(t0.Add(5 * time.Second))
	equal(t, "state", tasksByKey(t, tx, id)["create-project"].State, domain.TaskReady)
	equal(t, "attempts", tasksByKey(t, tx, id)["create-project"].AttemptCount, 1)

	k.tick(t0.Add(7 * time.Second))
	equal(t, "state", tasksByKey(t, tx, id)["create-project"].State, domain.TaskRunning)
	equal(t, "attempts", tasksByKey(t, tx, id)["create-project"].AttemptCount, 2)
	exec.Complete(tasksByKey(t, tx, id)["create-project"].ExecutorHandle, map[string]any{"projectId": "demo-project-123"})
	k.tick(t0.Add(8 * time.Second))
	equal(t, "state", tasksByKey(t, tx, id)["create-project"].State, domain.TaskSucceeded)
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionSucceeded)
}

func TestMissingDeclaredOutputFailsTheDownstreamTask(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-missing-output", twoTasks("doesNotExist", 1)...)
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	exec.Complete(tasksByKey(t, tx, id)["create-project"].ExecutorHandle, map[string]any{"projectId": "demo-project-123"})
	k.tick(t0.Add(time.Second))
	deploy := tasksByKey(t, tx, id)["deploy-application"]
	equal(t, "deploy", deploy.State, domain.TaskFailed)
	equal(t, "code", deploy.Failure["code"], "MISSING_UPSTREAM_OUTPUT")
	equal(t, "retryable", deploy.Failure["retryable"], false)
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionFailed)
}

// The product's schemas: inputs that don't fit fail the step before it
// starts, outputs that don't fit fail it when it finishes; neither retries.
var countSchema = map[string]any{
	"type": "object", "required": []any{"count"},
	"properties": map[string]any{"count": map[string]any{"type": "integer"}},
}

func TestInputsThatDontFitTheSchemaFailTheStepBeforeItStarts(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-input-schema",
		task("create-project", inputs(map[string]any{"count": "three"}), maxAttempts(3), schemas(countSchema, nil)))
	k := newTicker(t, tx, fake())
	k.tick(time.Now())
	created := tasksByKey(t, tx, id)["create-project"]
	equal(t, "state", created.State, domain.TaskFailed)
	equal(t, "code", created.Failure["code"], "INPUT_INVALID")
	equal(t, "retryable", created.Failure["retryable"], false)
	equal(t, "started", created.ExecutorHandle == nil, true)
	if !strings.Contains(fmt.Sprint(created.Failure["message"]), "count") {
		t.Errorf("message = %v", created.Failure["message"])
	}
}

// A target another step fills, for another team's run: the console narrows
// the input's schema to what the owning team allows (console/src/targets.ts's
// narrowWiredTargets), and the resolved value is held to it before the step
// starts.
func TestAWiredTargetOutsideWhatItsOwnerAllowsFailsTheStepBeforeItStarts(t *testing.T) {
	narrowed := map[string]any{
		"type": "object", "required": []any{"projectId"},
		"properties": map[string]any{"projectId": map[string]any{"allOf": []any{
			map[string]any{"type": "string", "x-vertra-needs": "gcp.project"},
			map[string]any{"anyOf": []any{
				map[string]any{"type": "string", "pattern": "^apps-.*$"},
				map[string]any{"type": "string", "pattern": "^shared\\.sandbox$"},
			}},
		}}},
	}
	for _, c := range []struct {
		project string
		want    domain.TaskState
	}{{"apps-web", domain.TaskRunning}, {"shared.sandbox", domain.TaskRunning}, {"payments-prod", domain.TaskFailed}, {"sharedXsandbox", domain.TaskFailed}} {
		tx := txFor(t)
		id := submit(t, tx, "idem-sched-wired-target-"+c.project,
			task("source"),
			task("make", dependsOn("source"), inputs(map[string]any{"projectId": map[string]any{"$fromTask": "source", "$output": "projectId"}}), schemas(narrowed, nil)))
		exec := fake()
		k := newTicker(t, tx, exec)
		t0 := time.Now()
		k.tick(t0)
		exec.Complete(tasksByKey(t, tx, id)["source"].ExecutorHandle, map[string]any{"projectId": c.project})
		k.tick(t0.Add(time.Second))
		k.tick(t0.Add(2 * time.Second))
		made := tasksByKey(t, tx, id)["make"]
		equal(t, c.project, made.State, c.want)
		if c.want == domain.TaskFailed {
			equal(t, c.project+" code", made.Failure["code"], "INPUT_INVALID")
			equal(t, c.project+" started", made.ExecutorHandle == nil, true)
		}
	}
}

func TestOutputsThatDontFitTheSchemaFailTheStep(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-output-schema",
		task("create-project", inputs(map[string]any{"count": 3}), maxAttempts(3), schemas(countSchema, countSchema)))
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	equal(t, "state", tasksByKey(t, tx, id)["create-project"].State, domain.TaskRunning)
	exec.Complete(tasksByKey(t, tx, id)["create-project"].ExecutorHandle, map[string]any{"count": "three"})
	k.tick(t0.Add(time.Second))
	created := tasksByKey(t, tx, id)["create-project"]
	equal(t, "state", created.State, domain.TaskFailed)
	equal(t, "code", created.Failure["code"], "OUTPUT_INVALID")
	equal(t, "retryable", created.Failure["retryable"], false)
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionFailed)
}

func TestValuesThatFitTheSchemasRunAsUsual(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-schemas-fit",
		task("create-project", inputs(map[string]any{"count": 3}), schemas(countSchema, countSchema)))
	exec := fake()
	k := newTicker(t, tx, exec)
	t0 := time.Now()
	k.tick(t0)
	exec.Complete(tasksByKey(t, tx, id)["create-project"].ExecutorHandle, map[string]any{"count": 4})
	k.tick(t0.Add(time.Second))
	equal(t, "state", tasksByKey(t, tx, id)["create-project"].State, domain.TaskSucceeded)
}

func TestDispatchRejectedByClusterPolicyFailsWithoutRetrying(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-dispatch-rejected", task("create-project", maxAttempts(3)))
	exec := fake()
	exec.StartError = &executor.DispatchRejected{Code: "DISPATCH_REJECTED", Message: "namespace test-team is not a Vertra team namespace"}
	newTicker(t, tx, exec).tick(time.Now())
	tk := tasksByKey(t, tx, id)["create-project"]
	equal(t, "state", tk.State, domain.TaskFailed)
	equal(t, "attempts", tk.AttemptCount, 1)
	equal(t, "failure", tk.Failure, map[string]any{"code": "DISPATCH_REJECTED", "message": "namespace test-team is not a Vertra team namespace", "retryable": false})
	equal(t, "execution", executionState(t, tx, id), domain.ExecutionFailed)
}

func TestTaskExceedingTimeoutIsCancelledAndFailed(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-timeout", task("create-project", timeout(30)))
	exec := fake()
	k := newTicker(t, tx, exec)
	k.opts.LeaseDuration = 300 * time.Second
	t0 := time.Now()
	k.tick(t0)
	handle := tasksByKey(t, tx, id)["create-project"].ExecutorHandle
	k.tick(t0.Add(31 * time.Second))
	if len(exec.Cancelled) != 1 || exec.Cancelled[0] != handle["fakeId"] {
		t.Errorf("cancelled = %v", exec.Cancelled)
	}
	tk := tasksByKey(t, tx, id)["create-project"]
	equal(t, "state", tk.State, domain.TaskFailed)
	equal(t, "code", tk.Failure["code"], "TASK_TIMEOUT")
}

// Waiting for a node isn't running: the timeout counts from the container's
// start, and the wait has its own limit.
func TestATaskWaitingToStartIsntTimedOut(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-pending", task("create-project", timeout(30)))
	exec := fake()
	k := newTicker(t, tx, exec)
	k.opts.LeaseDuration = 300 * time.Second
	t0 := time.Now()
	k.tick(t0)
	handle := tasksByKey(t, tx, id)["create-project"].ExecutorHandle
	exec.Pending(handle)
	k.tick(t0.Add(5 * time.Minute)) // ten timeouts, still waiting for a node
	equal(t, "waiting", tasksByKey(t, tx, id)["create-project"].State, domain.TaskRunning)

	exec.StartedAt(handle, t0.Add(5*time.Minute))
	k.tick(t0.Add(5*time.Minute + 20*time.Second))
	equal(t, "running, within its timeout", tasksByKey(t, tx, id)["create-project"].State, domain.TaskRunning)
	k.tick(t0.Add(5*time.Minute + 31*time.Second))
	equal(t, "timed out from its start", tasksByKey(t, tx, id)["create-project"].Failure["code"], "TASK_TIMEOUT")
}

func TestATaskThatNeverStartsFailsAsNotStarted(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-sched-not-started", task("create-project", timeout(30)))
	exec := fake()
	k := newTicker(t, tx, exec)
	k.opts.LeaseDuration = 900 * time.Second
	t0 := time.Now()
	k.tick(t0)
	exec.Pending(tasksByKey(t, tx, id)["create-project"].ExecutorHandle)
	k.tick(t0.Add(k.opts.StartTimeout + time.Second))
	tk := tasksByKey(t, tx, id)["create-project"]
	equal(t, "state", tk.State, domain.TaskFailed)
	equal(t, "code", tk.Failure["code"], "TASK_NOT_STARTED")
	equal(t, "retryable", tk.Failure["retryable"], true)
	if len(exec.Cancelled) != 1 {
		t.Errorf("cancelled = %v", exec.Cancelled)
	}
}

func TestATickReportsWhetherItMovedAnything(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-progress", task("create-project"))
	exec := fake()
	k := newTicker(t, tx, exec)
	now := time.Now()
	equal(t, "claimed and started", k.tick(now).Progressed, true)
	equal(t, "still running", k.tick(now).Progressed, false)
	exec.Complete(executor.Handle{"fakeId": "1"}, map[string]any{"projectId": "p-1"})
	equal(t, "finished", k.tick(now).Progressed, true)
}

// slowExecutor takes a moment over every status read, recording the most at once.
type slowExecutor struct {
	*executortest.Fake
	inFlight, most atomic.Int32
}

func (s *slowExecutor) Status(ctx context.Context, handle executor.Handle) (executor.Status, error) {
	n := s.inFlight.Add(1)
	for {
		m := s.most.Load()
		if n <= m || s.most.CompareAndSwap(m, n) {
			break
		}
	}
	time.Sleep(20 * time.Millisecond)
	s.inFlight.Add(-1)
	return s.Fake.Status(ctx, handle)
}

func TestRunningTasksAreStartedAndReadConcurrently(t *testing.T) {
	tx := txFor(t)
	var tasks []TaskDef
	for i := range 6 {
		tasks = append(tasks, task("task-"+string(rune('0'+i))))
	}
	submit(t, tx, "idem-concurrent", tasks...)
	exec := &slowExecutor{Fake: fake()}
	k := newTicker(t, tx, exec)
	k.opts.ExecutorConcurrency = 4
	k.tick(time.Now()) // started
	k.tick(time.Now()) // read
	equal(t, "most in flight", exec.most.Load(), 4)
}

func TestATasksSizeReachesTheExecutor(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-resources",
		task("sized", func(d *TaskDef) { d.Resources = &domain.TaskResources{CPU: "50m", Memory: "64Mi"} }),
		task("unsized"))
	exec := fake()
	newTicker(t, tx, exec).tick(time.Now())
	byKey := map[string]executor.ResolvedTask{}
	for _, s := range exec.Started {
		byKey[s.TaskKey] = s
	}
	equal(t, "sized", byKey["sized"].Resources, &domain.TaskResources{CPU: "50m", Memory: "64Mi"})
	if byKey["unsized"].Resources != nil {
		t.Errorf("unsized = %v", byKey["unsized"].Resources)
	}
}

var _ = errors.New
