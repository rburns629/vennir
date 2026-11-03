// SPDX-License-Identifier: MIT

package scheduler

import (
	"io"
	"testing"
	"time"

	"github.com/rburns629/vertra/kernel/internal/domain"
	"github.com/rburns629/vertra/kernel/internal/executor"
	"github.com/rburns629/vertra/kernel/internal/kindtest"
	"github.com/rburns629/vertra/kernel/internal/logging"
)

// Real passes, a real cluster (kind) and the real demo products
// (examples/), the project's output feeding the application's input.

func kindChain(t *testing.T, projectInputs map[string]any, outputKey string) []TaskDef {
	project, application := kindtest.Image(t, kindtest.ProjectImage), kindtest.Image(t, kindtest.ApplicationImage)
	return []TaskDef{
		task("create-project", team(kindtest.Namespace), inputs(projectInputs), func(d *TaskDef) { d.Image = project }),
		task("deploy-application", team(kindtest.Namespace), dependsOn("create-project"), func(d *TaskDef) { d.Image = application },
			inputs(map[string]any{"projectId": map[string]any{"$fromTask": "create-project", "$output": outputKey}})),
	}
}

func kindExecutor(t *testing.T) *executor.Kubernetes {
	return executor.NewKubernetes(kindtest.Cluster(t), executor.KubernetesOptions{JobTTL: time.Hour, ImagePullGrace: 120 * time.Second,
		JobDeadlineGrace: 600 * time.Second, RequestTimeout: 30 * time.Second, WatchResync: 30 * time.Second, PodHardening: true,
		LogMaxLines: 5000, LogMaxBytes: 1 << 20}, logging.NewTo(io.Discard, "kernel-scheduler-test", "kind"))
}

// untilFinished runs passes, as the loop would, until the execution ends;
// what each finished it releases, as the loop does after its commit.
func untilFinished(t *testing.T, k *ticker, id string) domain.ExecutionState {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		outcome := k.tick(time.Now())
		ReleaseFinished(t.Context(), k.exec, outcome.Finished, quietLog)
		switch state := executionState(t, k.db, id); state {
		case domain.ExecutionSucceeded, domain.ExecutionFailed, domain.ExecutionCancelled:
			return state
		}
		time.Sleep(300 * time.Millisecond)
	}
	t.Fatal("not finished in 90 s")
	return ""
}

func TestKindTheFullChainThroughRealKubernetesAndRealProducts(t *testing.T) {
	tasks := kindChain(t, map[string]any{"projectName": "demo-project"}, "projectId")
	tx := txFor(t)
	id := submit(t, tx, "kind-chain", tasks...)
	equal(t, "execution", untilFinished(t, newTicker(t, tx, kindExecutor(t)), id), domain.ExecutionSucceeded)
	got := tasksByKey(t, tx, id)
	equal(t, "resolved", got["deploy-application"].ResolvedInputs, map[string]any{"projectId": "demo-project-123"})
	equal(t, "project outputs", outputsOf(t, tx, got["create-project"].ID), map[string]any{"projectId": "demo-project-123"})
	equal(t, "application outputs", outputsOf(t, tx, got["deploy-application"].ID), map[string]any{"applicationUrl": "https://demo.example"})
	// However many passes the containers took, these are the transitions:
	// the application isn't claimed until the project succeeded.
	equal(t, "events", eventTypes(t, tx, id), []string{"EXECUTION_CREATED", "TASK_CLAIMED", "EXECUTION_STARTED", "TASK_STARTED",
		"TASK_SUCCEEDED", "TASK_CLAIMED", "TASK_STARTED", "TASK_SUCCEEDED", "EXECUTION_SUCCEEDED"})
}

func TestKindAFailedProjectMeansTheApplicationNeverRuns(t *testing.T) {
	tasks := kindChain(t, map[string]any{}, "projectId") // no projectName: the product fails
	tx := txFor(t)
	id := submit(t, tx, "kind-project-fails", tasks...)
	equal(t, "execution", untilFinished(t, newTicker(t, tx, kindExecutor(t)), id), domain.ExecutionFailed)
	got := tasksByKey(t, tx, id)
	equal(t, "code", got["create-project"].Failure["code"], "MISSING_INPUT")
	equal(t, "application", got["deploy-application"].State, domain.TaskCancelled)
	equal(t, "never resolved", got["deploy-application"].ResolvedInputs == nil, true)
	claimed := 0
	types := eventTypes(t, tx, id)
	for _, e := range types {
		if e == "TASK_CLAIMED" {
			claimed++
		}
	}
	equal(t, "claimed", claimed, 1)
	equal(t, "last", types[len(types)-1], "EXECUTION_FAILED")
}

func TestKindAMissingDeclaredOutputFailsTheDownstreamTask(t *testing.T) {
	tasks := kindChain(t, map[string]any{"projectName": "demo-project"}, "thisOutputDoesNotExist")
	tx := txFor(t)
	id := submit(t, tx, "kind-missing-output", tasks...)
	equal(t, "execution", untilFinished(t, newTicker(t, tx, kindExecutor(t)), id), domain.ExecutionFailed)
	got := tasksByKey(t, tx, id)
	equal(t, "project", got["create-project"].State, domain.TaskSucceeded)
	equal(t, "code", got["deploy-application"].Failure["code"], "MISSING_UPSTREAM_OUTPUT")
	equal(t, "retryable", got["deploy-application"].Failure["retryable"], false)
}

// Nothing about progress lives in the scheduler's memory: a new executor
// (a restarted scheduler) picks up where the first left off.
func TestKindASchedulerRestartDoesntLoseTheExecution(t *testing.T) {
	tasks := kindChain(t, map[string]any{"projectName": "demo-project"}, "projectId")
	tx := txFor(t)
	id := submit(t, tx, "kind-restart", tasks...)
	newTicker(t, tx, kindExecutor(t)).tick(time.Now())
	equal(t, "dispatched", tasksByKey(t, tx, id)["create-project"].State, domain.TaskRunning)
	equal(t, "execution", untilFinished(t, newTicker(t, tx, kindExecutor(t)), id), domain.ExecutionSucceeded)
	equal(t, "resolved", tasksByKey(t, tx, id)["deploy-application"].ResolvedInputs, map[string]any{"projectId": "demo-project-123"})
}
