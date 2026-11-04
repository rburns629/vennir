// SPDX-License-Identifier: MIT

package api

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	kernelv1 "github.com/rburns629/vennir/kernel/internal/gen/vennir/kernel/v1"
)

func TestRefusalsAreTheAttemptsTheClusterRefused(t *testing.T) {
	c := client(t)
	id := submit(t, c, chain(unique("refusals"))).ExecutionId
	attempt := func(task string, number int, code string, ago time.Duration) {
		t.Helper()
		exec(t, `INSERT INTO task_attempts (id, task_id, attempt_number, started_at, completed_at, failure, image)
			SELECT gen_random_uuid(), t.id, $5, now() - $3::interval, now() - $3::interval, jsonb_build_object('code', $2::text, 'message', 'refused: ' || $2::text), 'img@sha256:aa'
			FROM execution_tasks t WHERE t.execution_id = $1 AND t.task_key = $4`, id, code, ago.String(), task, number)
	}
	attempt("create-project", 1, "IMAGE_NOT_ALLOWED", time.Minute)
	attempt("deploy-application", 1, "TASK_TIMEOUT", time.Minute)
	attempt("deploy-application", 2, "RESOURCES_NOT_ALLOWED", 2*time.Minute) // its Pod can never fit
	since := time.Now().Add(-time.Hour)
	res, err := c.ListRefusals(context.Background(), connect.NewRequest(&kernelv1.ListRefusalsRequest{Since: timestamppb.New(since)}))
	if err != nil {
		t.Fatal(err)
	}
	var mine []*kernelv1.Refusal
	for _, r := range res.Msg.Refusals {
		if r.ExecutionId == id {
			mine = append(mine, r)
		}
	}
	if len(mine) != 2 || mine[0].Code != "IMAGE_NOT_ALLOWED" || mine[0].TaskId != "create-project" || mine[0].Image != "img@sha256:aa" ||
		mine[0].Team != "test-team" || mine[0].At == nil || mine[1].Code != "RESOURCES_NOT_ALLOWED" {
		t.Errorf("refusals = %v", mine)
	}
	later, _ := c.ListRefusals(context.Background(), connect.NewRequest(&kernelv1.ListRefusalsRequest{Since: timestamppb.New(time.Now().Add(time.Hour))}))
	for _, r := range later.Msg.Refusals {
		if r.ExecutionId == id {
			t.Errorf("one from before since: %v", r)
		}
	}
}
