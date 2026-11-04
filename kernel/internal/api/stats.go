// SPDX-License-Identifier: MIT

package api

import (
	"context"
	"time"

	"connectrpc.com/connect"

	kernelv1 "github.com/rburns629/vennir/kernel/internal/gen/vennir/kernel/v1"
)

// GetStats is what the steps did, from the kernel's own tables (the
// console's Observe metrics, for everyone, with no metrics system needed).
// A step's wait is from when its task last became ready (available_at) to
// when its attempt started, counted for each task's latest attempt.
func (s *Service) GetStats(ctx context.Context, _ *connect.Request[kernelv1.GetStatsRequest]) (*connect.Response[kernelv1.GetStatsResponse], error) {
	out := &kernelv1.GetStatsResponse{}
	day := time.Now().Add(-24 * time.Hour)

	rows, err := s.Pool.Query(ctx, `WITH hours AS (
			SELECT generate_series(date_trunc('hour', $1::timestamptz) + interval '1 hour', date_trunc('hour', now()), interval '1 hour') AS hour)
		SELECT h.hour, count(a.id)::int,
			coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM a.started_at - t.available_at))
				FILTER (WHERE a.attempt_number = t.attempt_count AND a.started_at >= t.available_at), 0)
		FROM hours h
		LEFT JOIN task_attempts a ON date_trunc('hour', a.started_at) = h.hour
		LEFT JOIN execution_tasks t ON t.id = a.task_id
		GROUP BY h.hour ORDER BY h.hour`, day)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		h := &kernelv1.HourStats{}
		var hour time.Time
		if err := rows.Scan(&hour, &h.Started, &h.WaitP95Seconds); err != nil {
			rows.Close()
			return nil, err
		}
		h.Hour = timestamp(&hour)
		out.Hours = append(out.Hours, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.Pool.Query(ctx, `SELECT a.failure->>'code', count(*)::int, bool_or(coalesce((a.failure->>'retryable')::boolean, false))
		FROM task_attempts a WHERE a.completed_at >= $1 AND a.failure IS NOT NULL
		GROUP BY 1 ORDER BY 2 DESC`, day)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		f := &kernelv1.FailureCount{}
		if err := rows.Scan(&f.Code, &f.Count, &f.Retried); err != nil {
			rows.Close()
			return nil, err
		}
		out.Failures = append(out.Failures, f)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.Pool.Query(ctx, `SELECT regexp_replace(split_part(coalesce(a.image, t.image), '@', 1), ':[^/]*$', '') AS repository, t.action, t.team,
			count(*)::int, count(*) FILTER (WHERE a.failure IS NULL)::int,
			coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.completed_at - a.started_at)), 0),
			coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM a.completed_at - a.started_at)), 0)
		FROM task_attempts a JOIN execution_tasks t ON t.id = a.task_id
		WHERE a.started_at >= $1 AND a.completed_at IS NOT NULL
		GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 200`, time.Now().Add(-7*24*time.Hour))
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		st := &kernelv1.StepStats{}
		if err := rows.Scan(&st.Repository, &st.Action, &st.Team, &st.Attempts, &st.Succeeded, &st.P50Seconds, &st.P95Seconds); err != nil {
			rows.Close()
			return nil, err
		}
		out.Steps = append(out.Steps, st)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// READY counts only an active execution's (a failed one's waits for a retry).
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE t.state = 'READY' AND e.state IN ('PENDING', 'RUNNING'))::int,
		count(*) FILTER (WHERE t.state IN ('CLAIMED', 'RUNNING'))::int
		FROM execution_tasks t JOIN executions e ON e.id = t.execution_id WHERE t.state IN ('READY', 'CLAIMED', 'RUNNING')`).Scan(&out.Ready, &out.Running); err != nil {
		return nil, err
	}
	return connect.NewResponse(out), nil
}
