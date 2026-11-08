// SPDX-License-Identifier: MIT

// Package executortest is an in-memory executor for scheduler tests:
// outcomes are driven explicitly (Complete, Fail), never on their own.
package executortest

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/roburns/vennir/kernel/internal/domain"
	"github.com/roburns/vennir/kernel/internal/executor"
)

// Fake is an Executor that records what it was asked to do.
type Fake struct {
	mu       sync.Mutex
	statuses map[string]executor.Status
	logs     map[string][]string
	nextID   int

	// Set to make the matching call fail; cleared to let calls through.
	StartError  error
	StatusError error
	CancelError error

	Started    []executor.ResolvedTask
	StartCalls []executor.ResolvedTask // every Start, failing or not
	Discarded  []executor.ResolvedTask
	Cancelled  []string
	Released   []string
	// Every attempt Start launched, as ListAttempts reports it until it's
	// released or cancelled; tests may backdate CreatedAt.
	Launched map[string]*executor.LaunchedAttempt
}

// New is an empty Fake.
func New() *Fake {
	return &Fake{statuses: map[string]executor.Status{}, logs: map[string][]string{}, Launched: map[string]*executor.LaunchedAttempt{}}
}

func id(handle executor.Handle) string { return fmt.Sprint(handle["fakeId"]) }

func (f *Fake) Start(_ context.Context, task executor.ResolvedTask) (executor.Handle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.StartCalls = append(f.StartCalls, task)
	if f.StartError != nil {
		return nil, f.StartError
	}
	f.Started = append(f.Started, task)
	f.nextID++
	handleID := fmt.Sprint(f.nextID)
	started := time.Now()
	f.statuses[handleID] = executor.Status{State: executor.Running, StartedAt: &started}
	f.logs[handleID] = []string{fmt.Sprintf("started %s attempt %d", task.TaskKey, task.Attempt)}
	handle := executor.Handle{"fakeId": handleID}
	f.Launched[handleID] = &executor.LaunchedAttempt{Handle: handle, ExecutionID: task.ExecutionID, TaskKey: task.TaskKey, Attempt: task.Attempt, CreatedAt: time.Now()}
	return handle, nil
}

func (f *Fake) Status(_ context.Context, handle executor.Handle) (executor.Status, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.StatusError != nil {
		return executor.Status{}, f.StatusError
	}
	return f.statuses[id(handle)], nil
}

func (f *Fake) Cancel(_ context.Context, handle executor.Handle) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.CancelError != nil {
		return f.CancelError
	}
	handleID := id(handle)
	f.Cancelled = append(f.Cancelled, handleID)
	delete(f.Launched, handleID) // cancelling removes the unit, as the real one does
	if f.statuses[handleID].State == executor.Running {
		f.statuses[handleID] = executor.Status{State: executor.Failed, Error: &domain.StructuredError{Code: "CANCELLED", Message: "cancelled"}}
	}
	return nil
}

func (f *Fake) Logs(_ context.Context, handle executor.Handle) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.logs[id(handle)], nil
}

func (f *Fake) Release(_ context.Context, handle executor.Handle) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Released = append(f.Released, id(handle))
	delete(f.Launched, id(handle))
	return nil
}

func (f *Fake) ListAttempts(context.Context) ([]executor.LaunchedAttempt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	attempts := make([]executor.LaunchedAttempt, 0, len(f.Launched))
	for _, a := range f.Launched {
		attempts = append(attempts, *a)
	}
	return attempts, nil
}

func (f *Fake) Discard(_ context.Context, task executor.ResolvedTask) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Discarded = append(f.Discarded, task)
	return nil
}

func (f *Fake) WaitForChange(ctx context.Context, timeout time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(timeout):
	}
}

// Complete makes an attempt succeed with outputs.
func (f *Fake) Complete(handle executor.Handle, outputs map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statuses[id(handle)] = executor.Status{State: executor.Succeeded, Outputs: outputs}
}

// Fail makes an attempt fail with err.
// Pending makes an attempt one still waiting to start (for a node).
func (f *Fake) Pending(handle executor.Handle) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statuses[id(handle)] = executor.Status{State: executor.Running}
}

// StartedAt makes an attempt's container start at at.
func (f *Fake) StartedAt(handle executor.Handle, at time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statuses[id(handle)] = executor.Status{State: executor.Running, StartedAt: &at}
}

func (f *Fake) Fail(handle executor.Handle, err domain.StructuredError) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statuses[id(handle)] = executor.Status{State: executor.Failed, Error: &err}
}

// AppendLog adds a line to an attempt's log, as a running product would.
func (f *Fake) AppendLog(handle executor.Handle, line string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs[id(handle)] = append(f.logs[id(handle)], line)
}
