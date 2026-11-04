// SPDX-License-Identifier: MIT

package api

import (
	"context"
	"slices"
	"testing"

	"connectrpc.com/connect"

	kernelv1 "github.com/rburns629/vennir/kernel/internal/gen/vennir/kernel/v1"
	"github.com/rburns629/vennir/kernel/internal/gen/vennir/kernel/v1/kernelv1connect"
)

// gated is chain() with its first step needing an approval, in team.
func gated(requestID, team string) *kernelv1.SubmitExecutionRequest {
	req := chain(requestID)
	for _, task := range req.Tasks {
		task.Team = team
	}
	req.Tasks[0].ApprovalRequired = true
	return req
}

func decide(c kernelv1connect.KernelServiceClient, id, task string, approve bool) (*kernelv1.DecideApprovalResponse, error) {
	res, err := c.DecideApproval(context.Background(), connect.NewRequest(&kernelv1.DecideApprovalRequest{
		ExecutionId: id, TaskId: task, Approve: approve, DecidedBy: "user:7", Reason: "not this week"}))
	if err != nil {
		return nil, err
	}
	return res.Msg, nil
}

func eventTypes(t *testing.T, c kernelv1connect.KernelServiceClient, id string) []string {
	t.Helper()
	page, err := c.ListExecutionEvents(context.Background(), connect.NewRequest(&kernelv1.ListExecutionEventsRequest{ExecutionId: id}))
	if err != nil {
		t.Fatal(err)
	}
	var types []string
	for _, e := range page.Msg.Events {
		types = append(types, e.EventType)
	}
	return types
}

func TestAStepThatNeedsApprovalAwaitsItAndIsListedForItsTeam(t *testing.T) {
	c := client(t)
	team := unique("approvers")
	id := submit(t, c, gated(unique("gated"), team)).ExecutionId
	task := tasksByID(get(t, c, id))["create-project"]
	if task.State != kernelv1.TaskState_TASK_STATE_AWAITING_APPROVAL || !task.ApprovalRequired || task.AwaitingSince == nil {
		t.Fatalf("task = %v", task)
	}
	listed, err := c.ListAwaitingApproval(context.Background(), connect.NewRequest(&kernelv1.ListAwaitingApprovalRequest{Teams: []string{team}}))
	if err != nil || len(listed.Msg.Tasks) != 1 || listed.Msg.Tasks[0].ExecutionId != id || listed.Msg.Tasks[0].TaskId != "create-project" ||
		listed.Msg.Tasks[0].ExecutionName != "demo-order-1" {
		t.Fatalf("listed = %v %v", listed, err)
	}
	other, err := c.ListAwaitingApproval(context.Background(), connect.NewRequest(&kernelv1.ListAwaitingApprovalRequest{Teams: []string{unique("other")}}))
	if err != nil || len(other.Msg.Tasks) != 0 {
		t.Errorf("another team's list = %v %v", other, err)
	}
}

func TestApprovingMakesItReadyAndRecordsWho(t *testing.T) {
	c := client(t)
	id := submit(t, c, gated(unique("approve"), "test-team")).ExecutionId
	if _, err := decide(c, id, "create-project", true); err != nil {
		t.Fatal(err)
	}
	task := tasksByID(get(t, c, id))["create-project"]
	if task.State != kernelv1.TaskState_TASK_STATE_READY || task.ApprovedBy != "user:7" || task.ApprovedAt == nil || task.AwaitingSince != nil {
		t.Errorf("task = %v", task)
	}
	if types := eventTypes(t, c, id); !slices.Equal(types, []string{"EXECUTION_CREATED", "TASK_APPROVED"}) {
		t.Errorf("events = %v", types)
	}
	// Decided once.
	_, err := decide(c, id, "create-project", true)
	code(t, err, connect.CodeFailedPrecondition)
}

func TestDecliningFailsItAndItsExecution(t *testing.T) {
	c := client(t)
	id := submit(t, c, gated(unique("decline"), "test-team")).ExecutionId
	res, err := decide(c, id, "create-project", false)
	if err != nil || res.State != kernelv1.ExecutionState_EXECUTION_STATE_FAILED {
		t.Fatalf("%v %v", res, err)
	}
	tasks := tasksByID(get(t, c, id))
	failure := tasks["create-project"].Failure.AsMap()
	if tasks["create-project"].State != kernelv1.TaskState_TASK_STATE_FAILED || failure["code"] != "APPROVAL_DECLINED" ||
		failure["message"] != "Declined: not this week" || tasks["deploy-application"].State != kernelv1.TaskState_TASK_STATE_CANCELLED {
		t.Errorf("tasks = %v", tasks)
	}
	if types := eventTypes(t, c, id); !slices.Equal(types, []string{"EXECUTION_CREATED", "TASK_FAILED", "EXECUTION_FAILED"}) {
		t.Errorf("events = %v", types)
	}
	// Retrying a declined step asks again, rather than running it.
	if _, err := retry(c, id, "create-project"); err != nil {
		t.Fatal(err)
	}
	if st := tasksByID(get(t, c, id))["create-project"].State; st != kernelv1.TaskState_TASK_STATE_AWAITING_APPROVAL {
		t.Errorf("after retrying: %v", st)
	}
}

func TestAnApprovalLastsAcrossRetries(t *testing.T) {
	c := client(t)
	id := submit(t, c, gated(unique("approved-retry"), "test-team")).ExecutionId
	if _, err := decide(c, id, "create-project", true); err != nil {
		t.Fatal(err)
	}
	exec(t, `UPDATE execution_tasks SET state = 'FAILED', attempt_count = 1, failure = '{"code": "BOOM", "message": "failed", "retryable": false}'
		WHERE execution_id = $1 AND task_key = 'create-project'`, id)
	exec(t, `UPDATE executions SET state = 'FAILED' WHERE id = $1`, id)
	if _, err := retry(c, id, "create-project"); err != nil {
		t.Fatal(err)
	}
	if st := tasksByID(get(t, c, id))["create-project"].State; st != kernelv1.TaskState_TASK_STATE_READY {
		t.Errorf("after retrying: %v", st)
	}
}

func TestCancellingCancelsAStepAwaitingApproval(t *testing.T) {
	c := client(t)
	id := submit(t, c, gated(unique("cancel-gated"), "test-team")).ExecutionId
	if _, err := cancel(c, id); err != nil {
		t.Fatal(err)
	}
	if st := tasksByID(get(t, c, id))["create-project"].State; st != kernelv1.TaskState_TASK_STATE_CANCELLED {
		t.Errorf("state = %v", st)
	}
	_, err := decide(c, id, "create-project", true)
	code(t, err, connect.CodeFailedPrecondition)
}

func TestOnlyAStepAwaitingApprovalCanBeDecided(t *testing.T) {
	c := client(t)
	id := submit(t, c, single(unique("ungated"))).ExecutionId
	_, err := decide(c, id, "create-project", true)
	code(t, err, connect.CodeFailedPrecondition)
	_, err = decide(c, id, "nope", true)
	code(t, err, connect.CodeNotFound)
	_, err = c.DecideApproval(context.Background(), connect.NewRequest(&kernelv1.DecideApprovalRequest{ExecutionId: id, TaskId: "create-project", Approve: true}))
	code(t, err, connect.CodeInvalidArgument)
}
