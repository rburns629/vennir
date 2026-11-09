// SPDX-License-Identifier: MIT

package api

import (
	"context"
	"time"

	"connectrpc.com/connect"

	"github.com/roburns/vennir/kernel/internal/domain"
	kernelv1 "github.com/roburns/vennir/kernel/internal/gen/vennir/kernel/v1"
)

// MaxRefusals is the most ListRefusals answers with.
const MaxRefusals = 500

// ListRefusals is every attempt the cluster refused to start since a time,
// newest first (the console's Observe page).
func (s *Service) ListRefusals(ctx context.Context, req *connect.Request[kernelv1.ListRefusalsRequest]) (*connect.Response[kernelv1.ListRefusalsResponse], error) {
	since := time.Now().Add(-7 * 24 * time.Hour)
	if req.Msg.GetSince() != nil {
		since = req.Msg.GetSince().AsTime()
	}
	rows, err := s.Pool.Query(ctx, `SELECT t.execution_id::text, t.task_key, t.team, coalesce(a.image, t.image),
			a.failure->>'code', coalesce(a.failure->>'message', ''), a.completed_at
		FROM task_attempts a JOIN execution_tasks t ON t.id = a.task_id
		WHERE a.completed_at >= $1 AND a.failure->>'code' = ANY($2)
		ORDER BY a.completed_at DESC LIMIT $3`, since, domain.RefusalCodes, MaxRefusals)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &kernelv1.ListRefusalsResponse{}
	for rows.Next() {
		r := &kernelv1.Refusal{}
		var at time.Time
		if err := rows.Scan(&r.ExecutionId, &r.TaskId, &r.Team, &r.Image, &r.Code, &r.Message, &at); err != nil {
			return nil, err
		}
		r.At = timestamp(&at)
		out.Refusals = append(out.Refusals, r)
	}
	return connect.NewResponse(out), rows.Err()
}
