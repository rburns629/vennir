// SPDX-License-Identifier: MIT

// Package executor is what the scheduler dispatches through: one task
// attempt run somewhere, started, read, cancelled and released. Kubernetes
// is the only real implementation; the interface keeps every scheduling
// decision testable against an in-memory one (executortest.Fake).
package executor

import (
	"context"
	"errors"
	"time"

	"github.com/roburns/vennir/kernel/internal/domain"
)

// Handle identifies a started attempt, opaque outside the executor that
// made it: Kubernetes stores {"namespace": ..., "jobName": ...}. The
// scheduler keeps it verbatim (JSONB) and passes it back, including after
// a restart, and including handles the Python scheduler wrote.
type Handle map[string]any

// ResolvedTask is everything needed to launch one attempt of one task.
type ResolvedTask struct {
	ExecutionID    string
	TaskKey        string
	Image          string
	Action         string
	Attempt        int
	ResolvedInputs map[string]any
	TimeoutSeconds int
	// Team is the dispatch namespace; ServiceAccount the Pod's identity.
	Team string
	// ForTeam is the team it runs for (request.json's forTeam); "": none.
	ForTeam        string
	ServiceAccount string
	// SecretRefs are the Secrets mounted at /platform/secrets/<name>/.
	SecretRefs []string
	// TokenAudiences each get a projected ServiceAccount token at
	// /platform/tokens/<domain.TokenFileName(audience)>.
	TokenAudiences []string
	// Resources are the task's own, before the deployment's defaults.
	Resources *domain.TaskResources
	// Capacity is the kind its product asks for (domain.Capacities); "":
	// the deployment's placement.
	Capacity string
}

// ProductRequest is the request.json the step reads.
func (t ResolvedTask) ProductRequest() domain.ProductRequest {
	inputs := t.ResolvedInputs
	if inputs == nil {
		inputs = map[string]any{}
	}
	return domain.ProductRequest{ExecutionID: t.ExecutionID, TaskID: t.TaskKey, Team: t.Team, ForTeam: t.ForTeam, Action: t.Action, Attempt: t.Attempt, Inputs: inputs}
}

// RunState is what an executor sees of an attempt: running, or finished.
type RunState string

const (
	Running   RunState = "RUNNING"
	Succeeded RunState = "SUCCEEDED"
	Failed    RunState = "FAILED"
)

// Status is one read of an attempt: Outputs when it succeeded, Error when
// it failed, neither while it runs. StartedAt is when its container
// started, once it has: until then it waits for room (a node, a quota),
// which its timeout doesn't count.
type Status struct {
	State     RunState
	Outputs   map[string]any
	Error     *domain.StructuredError
	StartedAt *time.Time
}

// LaunchedAttempt is an attempt whose unit still exists, as ListAttempts
// reports it (for the orphan sweep).
type LaunchedAttempt struct {
	Handle      Handle
	ExecutionID string
	TaskKey     string
	Attempt     int
	CreatedAt   time.Time
}

// DispatchRejected is the cluster refusing to create an attempt's workload
// on policy grounds: the same attempt would be refused again, so it's
// never retried. Code is IMAGE_NOT_ALLOWED, IDENTITY_NOT_ALLOWED,
// IMAGE_NOT_SIGNED, IMAGE_SCAN_FAILED, IMAGE_NOT_PINNED, TEAM_RETIRED (the
// team retired while its run was going) or DISPATCH_REJECTED.
type DispatchRejected struct {
	Code    string
	Message string
}

func (e *DispatchRejected) Error() string { return e.Code + ": " + e.Message }

// IsDispatchRejected says whether err is (or wraps) a policy refusal.
func IsDispatchRejected(err error) (*DispatchRejected, bool) {
	var rejected *DispatchRejected
	ok := errors.As(err, &rejected)
	return rejected, ok
}

// Executor runs task attempts.
type Executor interface {
	// Start launches one attempt and returns as soon as its unit exists.
	// Idempotent per attempt: a unit already there under this attempt's
	// name is adopted, not started twice.
	Start(ctx context.Context, task ResolvedTask) (Handle, error)
	// Status reads a started attempt.
	Status(ctx context.Context, handle Handle) (Status, error)
	// Cancel stops an attempt; cancelling a finished one doesn't fail.
	Cancel(ctx context.Context, handle Handle) error
	// Logs are an attempt's captured output, for diagnostics.
	Logs(ctx context.Context, handle Handle) ([]string, error)
	// Release removes a finished attempt's unit, once its outcome is
	// committed (so a pass that rolls back can read it again). Idempotent.
	Release(ctx context.Context, handle Handle) error
	// ListAttempts is every attempt whose unit still exists.
	ListAttempts(ctx context.Context) ([]LaunchedAttempt, error)
	// Discard removes whatever a Start of this attempt may have left
	// behind, when the scheduler gives up on starting it. Idempotent.
	Discard(ctx context.Context, task ResolvedTask) error
	// WaitForChange returns when a watched unit changes, the timeout
	// passes, or ctx ends.
	WaitForChange(ctx context.Context, timeout time.Duration)
}
