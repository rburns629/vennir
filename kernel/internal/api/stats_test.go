// SPDX-License-Identifier: MIT

package api

import (
	"context"
	"testing"

	"connectrpc.com/connect"

	kernelv1 "github.com/roburns/vennir/kernel/internal/gen/vennir/kernel/v1"
)

func TestStatsAreWhatTheStepsDid(t *testing.T) {
	c := client(t)
	repo := "registry.example/" + unique("stats") + "/orders"
	id := submit(t, c, chain(unique("stats"))).ExecutionId
	// create-project: one success (20 s), after waiting 4 s; deploy-application: a failure.
	exec(t, `UPDATE execution_tasks SET image = $2 || ':1@sha256:aa', attempt_count = 1, available_at = now() - interval '30 seconds'
		WHERE execution_id = $1 AND task_key = 'create-project'`, id, repo)
	exec(t, `INSERT INTO task_attempts (id, task_id, attempt_number, started_at, completed_at, image)
		SELECT gen_random_uuid(), id, 1, now() - interval '26 seconds', now() - interval '6 seconds', image
		FROM execution_tasks WHERE execution_id = $1 AND task_key = 'create-project'`, id)
	exec(t, `INSERT INTO task_attempts (id, task_id, attempt_number, started_at, completed_at, failure)
		SELECT gen_random_uuid(), id, 1, now() - interval '5 seconds', now() - interval '4 seconds', '{"code": "STATS_TEST_BOOM", "retryable": true}'
		FROM execution_tasks WHERE execution_id = $1 AND task_key = 'deploy-application'`, id)

	res, err := c.GetStats(context.Background(), connect.NewRequest(&kernelv1.GetStatsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	s := res.Msg
	// Both attempts started in the last 30 seconds: in the newest hour, or
	// across the turn of an hour, the one before it too.
	if n := len(s.Hours); n < 24 || s.Hours[n-1].Started+s.Hours[n-2].Started < 2 {
		t.Errorf("hours = %v", s.Hours)
	}
	var boom *kernelv1.FailureCount
	for _, f := range s.Failures {
		if f.Code == "STATS_TEST_BOOM" {
			boom = f
		}
	}
	if boom == nil || boom.Count != 1 || !boom.Retried {
		t.Errorf("failures = %v", s.Failures)
	}
	var orders *kernelv1.StepStats
	for _, st := range s.Steps {
		if st.Repository == repo {
			orders = st
		}
	}
	if orders == nil || orders.Attempts != 1 || orders.Succeeded != 1 || orders.P50Seconds < 19 || orders.P50Seconds > 21 || orders.Action != "create" {
		t.Errorf("steps = %v", orders)
	}
}
