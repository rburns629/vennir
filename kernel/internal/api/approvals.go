// SPDX-License-Identifier: MIT

package api

import (
	"context"
	"errors"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"

	"github.com/roburns/vennir/kernel/internal/domain"
	kernelv1 "github.com/roburns/vennir/kernel/internal/gen/vennir/kernel/v1"
)

// MaxApprovalTeams is how many teams one ListAwaitingApproval may ask about.
const MaxApprovalTeams = 1000

// DecideApproval approves a task awaiting approval (READY, approved for good)
// or declines it (FAILED, APPROVAL_DECLINED, failing its execution as the
// scheduler fails one: what hadn't started is cancelled). Who may decide is
// the console's to check; decided_by is recorded as is.
func (s *Service) DecideApproval(ctx context.Context, req *connect.Request[kernelv1.DecideApprovalRequest]) (*connect.Response[kernelv1.DecideApprovalResponse], error) {
	m := req.Msg
	id, err := executionID(m.GetExecutionId())
	if err != nil {
		return nil, err
	}
	if m.GetDecidedBy() == "" {
		return nil, invalid("decided_by is required")
	}
	key := m.GetTaskId()
	err = s.inTx(ctx, func(t *tx) error {
		if _, err := s.exists(ctx, t, id); err != nil {
			return err
		}
		// Conditional, like every state change here: the scheduler may be
		// expiring the same row. Tasks before the execution, its lock order.
		var taskID string
		var row pgx.Row
		failure := domain.StructuredError{Code: "APPROVAL_DECLINED", Message: "A maintainer of its team declined it."}
		if m.GetReason() != "" {
			failure.Message = "Declined: " + m.GetReason()
		}
		if m.GetApprove() {
			row = t.QueryRow(ctx, `UPDATE execution_tasks SET state = 'READY', approved_by = $3, approved_at = now(),
				available_at = now(), updated_at = now()
				WHERE execution_id = $1 AND task_key = $2 AND state = 'AWAITING_APPROVAL' RETURNING id::text`, id, key, m.GetDecidedBy())
		} else {
			row = t.QueryRow(ctx, `UPDATE execution_tasks SET state = 'FAILED', failure = $3, updated_at = now()
				WHERE execution_id = $1 AND task_key = $2 AND state = 'AWAITING_APPROVAL' RETURNING id::text`, id, key, failure.AsMap())
		}
		err := row.Scan(&taskID)
		if errors.Is(err, pgx.ErrNoRows) {
			var exists bool
			if err := t.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM execution_tasks WHERE execution_id = $1 AND task_key = $2)`, id, key).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return connect.NewError(connect.CodeNotFound, errors.New("Not found."))
			}
			return connect.NewError(connect.CodeFailedPrecondition, errors.New("Only a task awaiting approval can be approved or declined."))
		}
		if err != nil {
			return err
		}
		if m.GetApprove() {
			return t.recordEvent(ctx, id, &taskID, domain.EventTaskApproved, map[string]any{"taskKey": key, "decidedBy": m.GetDecidedBy()})
		}
		if err := t.recordEvent(ctx, id, &taskID, domain.EventTaskFailed, map[string]any{
			"taskKey": key, "error": failure.AsMap(), "willRetry": false, "decidedBy": m.GetDecidedBy()}); err != nil {
			return err
		}
		if _, err := t.Exec(ctx, `UPDATE execution_tasks SET state = 'CANCELLED', updated_at = now()
			WHERE execution_id = $1 AND state IN ('READY', 'BLOCKED', 'AWAITING_APPROVAL')`, id); err != nil {
			return err
		}
		tag, err := t.Exec(ctx, `UPDATE executions SET state = 'FAILED', updated_at = now()
			WHERE id = $1 AND state IN ('PENDING', 'RUNNING')`, id)
		if err != nil || tag.RowsAffected() == 0 {
			return err
		}
		return t.recordEvent(ctx, id, nil, domain.EventExecutionFailed, nil)
	})
	if err != nil {
		return nil, err
	}
	st, err := s.exists(ctx, s.Pool, id)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&kernelv1.DecideApprovalResponse{ExecutionId: id, State: executionState(st)}), nil
}

// ListAwaitingApproval is every task awaiting approval in the given teams,
// the longest waiting first.
func (s *Service) ListAwaitingApproval(ctx context.Context, req *connect.Request[kernelv1.ListAwaitingApprovalRequest]) (*connect.Response[kernelv1.ListAwaitingApprovalResponse], error) {
	teams := req.Msg.GetTeams()
	if len(teams) > MaxApprovalTeams {
		return nil, invalid("teams: at most %d, got %d", MaxApprovalTeams, len(teams))
	}
	out := &kernelv1.ListAwaitingApprovalResponse{}
	if len(teams) == 0 {
		return connect.NewResponse(out), nil
	}
	rows, err := s.Pool.Query(ctx, `SELECT e.id::text, e.external_reference, t.task_key, t.team, t.image, t.action,
			coalesce(e.requested_by, ''), t.available_at
		FROM execution_tasks t JOIN executions e ON e.id = t.execution_id
		WHERE t.state = 'AWAITING_APPROVAL' AND t.team = ANY($1) ORDER BY t.available_at, e.id, t.task_key`, teams)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a := &kernelv1.AwaitingApproval{}
		var since time.Time
		if err := rows.Scan(&a.ExecutionId, &a.ExecutionName, &a.TaskId, &a.Team, &a.Image, &a.Action, &a.RequestedBy, &since); err != nil {
			return nil, err
		}
		a.AwaitingSince = timestamp(&since)
		out.Tasks = append(out.Tasks, a)
	}
	return connect.NewResponse(out), rows.Err()
}
