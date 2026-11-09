// SPDX-License-Identifier: MIT

// Package consoleapi is the little of the console's API vennir needs:
// signing in as the admin, revoking the tokens catalogs once held, having
// the console apply its catalog's release now, and running a DAG. It calls the console's Connect services (generated
// from proto/ into internal/gen). Tokens and passwords pass through memory
// only.
package consoleapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/structpb"

	consolev1 "github.com/roburns/vennir/cli/internal/gen/vennir/console/v1"
	"github.com/roburns/vennir/cli/internal/gen/vennir/console/v1/consolev1connect"
)

// callTimeout bounds each call but a watch, which lasts as long as its run.
const callTimeout = 2 * time.Minute

// Client talks to one console as one user.
type Client struct {
	URL        string
	token      string
	auth       consolev1connect.AuthServiceClient
	admin      consolev1connect.AdminServiceClient
	tokens     consolev1connect.TokenServiceClient
	executions consolev1connect.ExecutionServiceClient
}

// New returns a client for the console at url.
func New(url string) *Client {
	c := &Client{URL: url}
	// No client-wide timeout: it would cut a watch short.
	httpClient := &http.Client{}
	base := strings.TrimSuffix(url, "/") + "/api"
	opts := []connect.ClientOption{connect.WithInterceptors(c.session())}
	c.auth = consolev1connect.NewAuthServiceClient(httpClient, base, opts...)
	c.admin = consolev1connect.NewAdminServiceClient(httpClient, base, opts...)
	c.tokens = consolev1connect.NewTokenServiceClient(httpClient, base, opts...)
	c.executions = consolev1connect.NewExecutionServiceClient(httpClient, base, opts...)
	return c
}

// session sends the signed-in session's token with every call.
func (c *Client) session() connect.Interceptor {
	return sessionInterceptor{c}
}

type sessionInterceptor struct{ c *Client }

func (s sessionInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		if s.c.token != "" {
			req.Header().Set("Authorization", "Bearer "+s.c.token)
		}
		return next(ctx, req)
	}
}

func (s sessionInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		conn := next(ctx, spec)
		if s.c.token != "" {
			conn.RequestHeader().Set("Authorization", "Bearer "+s.c.token)
		}
		return conn
	}
}

func (sessionInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

// Refusal is the console saying no: its Connect code, its message and,
// for a refused document, each problem it found.
type Refusal struct {
	Code    connect.Code
	Message string
	// Failure is the console's stable code for it (IMAGE_SCAN_PENDING, ...).
	Failure  string
	Problems []string
}

func (r *Refusal) Error() string {
	return fmt.Sprintf("the console refused (%s): %s", r.Code, r.Message)
}

// refused says what the console refused, without Connect's code prefix.
func refused(err error) error {
	var ce *connect.Error
	if !errors.As(err, &ce) || noAnswer(err) {
		return fmt.Errorf("reaching the console: %w", err)
	}
	r := &Refusal{Code: ce.Code(), Message: ce.Message()}
	for _, d := range ce.Details() {
		if v, err := d.Value(); err == nil {
			if f, ok := v.(*consolev1.Failure); ok {
				r.Failure = f.GetCode()
			}
			if p, ok := v.(*consolev1.Problem); ok {
				where := ""
				if p.GetField() != "" {
					where = p.GetField() + ": "
				}
				r.Problems = append(r.Problems, where+p.GetMessage())
			}
		}
	}
	return r
}

// noAnswer says whether a call failed without the console answering (it
// couldn't be reached, or the connection dropped): an answer carries
// response headers; a network failure has none.
func noAnswer(err error) bool {
	var ce *connect.Error
	if !errors.As(err, &ce) {
		return true
	}
	switch ce.Code() {
	case connect.CodeUnavailable, connect.CodeUnknown, connect.CodeDeadlineExceeded, connect.CodeCanceled:
		return len(ce.Meta()) == 0
	}
	return false
}

// RetryDelay is the wait before the first retry of a call that got no
// answer; each later one waits that much longer.
var RetryDelay = 5 * time.Second

// idempotent makes a call that's safe to repeat, again when it got no
// answer (up to four tries), each try with its own time limit.
func idempotent(ctx context.Context, call func(context.Context) error) error {
	var err error
	for attempt := 1; attempt <= 4; attempt++ {
		tryCtx, cancel := context.WithTimeout(ctx, callTimeout)
		err = call(tryCtx)
		cancel()
		if err == nil || !noAnswer(err) || ctx.Err() != nil || attempt == 4 {
			break
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Duration(attempt) * RetryDelay):
		}
	}
	if err != nil {
		return refused(err)
	}
	return nil
}

// SignIn signs in with an email and password.
func (c *Client) SignIn(ctx context.Context, email, password string) error {
	return idempotent(ctx, func(ctx context.Context) error {
		resp, err := c.auth.Login(ctx, connect.NewRequest(&consolev1.LoginRequest{Email: email, Password: password}))
		if err == nil {
			c.token = resp.Msg.GetToken()
		}
		return err
	})
}

// MustChangePassword says whether the console wants the signed-in
// password changed before anything else (it was generated, or an admin
// set it): every other call is refused until it is.
func (c *Client) MustChangePassword(ctx context.Context) (bool, error) {
	var must bool
	err := idempotent(ctx, func(ctx context.Context) error {
		resp, err := c.auth.GetMe(ctx, connect.NewRequest(&consolev1.GetMeRequest{}))
		if err == nil {
			must = resp.Msg.GetMustChangePassword()
		}
		return err
	})
	if err != nil {
		return false, refused(err)
	}
	return must, nil
}

// ChangePassword sets the signed-in admin's own password, keeping this
// session (with the fresh token it's given).
func (c *Client) ChangePassword(ctx context.Context, current, next string) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	resp, err := c.auth.ChangePassword(ctx, connect.NewRequest(&consolev1.ChangePasswordRequest{CurrentPassword: current, NewPassword: next}))
	if err != nil {
		return refused(err)
	}
	c.token = resp.Msg.GetToken()
	return nil
}

// RevokeOthers revokes every live automation token labelled label except
// keep: what a new token replaces.
func (c *Client) RevokeOthers(ctx context.Context, label, keep string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	resp, err := c.tokens.ListAutomationTokens(ctx, connect.NewRequest(&consolev1.ListAutomationTokensRequest{}))
	if err != nil {
		return 0, refused(err)
	}
	n := 0
	for _, t := range resp.Msg.GetTokens() {
		if t.GetLabel() == label && t.GetId() != keep {
			if _, err := c.tokens.RevokeToken(ctx, connect.NewRequest(&consolev1.RevokeTokenRequest{TokenId: t.GetId()})); err != nil {
				return n, refused(err)
			}
			n++
		}
	}
	return n, nil
}

// Catalog is the catalog release a console last applied.
type Catalog struct {
	// Release is where it reads releases from; empty: no catalog configured.
	Release, Commit string
	// Problems are what it couldn't apply, as "item: message".
	Problems []string
	// Error is why its last look failed, if it did.
	Error string
}

// SyncCatalog has the console read and apply its catalog's release now
// (admins only), and returns what it applied.
func (c *Client) SyncCatalog(ctx context.Context) (*Catalog, error) {
	var status *consolev1.CatalogStatus
	err := idempotent(ctx, func(ctx context.Context) error {
		resp, err := c.admin.SyncCatalog(ctx, connect.NewRequest(&consolev1.SyncCatalogRequest{}))
		if err == nil {
			status = resp.Msg.GetStatus()
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	out := &Catalog{Release: status.GetRelease(), Commit: status.GetCommit(), Error: status.GetError()}
	for _, p := range status.GetProblems() {
		out.Problems = append(out.Problems, p.GetItem()+": "+p.GetMessage())
	}
	return out, nil
}

// Task is one step of a DAG to submit.
type Task struct {
	ID, Image, Action, Team string
	Inputs                  map[string]any
}

// Submit runs a DAG of tasks and returns its execution's id.
func (c *Client) Submit(ctx context.Context, name, requestID string, tasks []Task) (string, error) {
	dag := &consolev1.Dag{Name: name, RequestId: requestID}
	for _, t := range tasks {
		inputs, err := structpb.NewStruct(t.Inputs)
		if err != nil {
			return "", fmt.Errorf("task %s's inputs: %w", t.ID, err)
		}
		dag.Tasks = append(dag.Tasks, &consolev1.TaskDefinition{
			Id: t.ID, Image: t.Image, Action: t.Action, Team: t.Team, Inputs: inputs,
		})
	}
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	resp, err := c.executions.SubmitExecution(ctx, connect.NewRequest(&consolev1.SubmitExecutionRequest{Dag: dag}))
	if err != nil {
		return "", refused(err)
	}
	return resp.Msg.GetExecutionId(), nil
}

// Execution is an execution's state and its tasks' outcomes.
type Execution struct {
	State string
	Tasks []TaskOutcome
}

// TaskOutcome is one task's state, outputs and failure (if it failed).
type TaskOutcome struct {
	ID, State string
	Outputs   map[string]any
	Failure   string
}

// Finished says whether the execution has stopped.
func (e *Execution) Finished() bool {
	return e.State == "SUCCEEDED" || e.State == "FAILED" || e.State == "CANCELLED"
}

func execution(m *consolev1.Execution) *Execution {
	e := &Execution{State: strings.TrimPrefix(m.GetState().String(), "EXECUTION_STATE_")}
	for _, t := range m.GetTasks() {
		outcome := TaskOutcome{
			ID:      t.GetTaskId(),
			State:   strings.TrimPrefix(t.GetState().String(), "TASK_STATE_"),
			Outputs: t.GetOutputs().AsMap(),
		}
		if f := t.GetFailure(); f != nil {
			outcome.Failure = f.GetCode() + ": " + f.GetMessage()
		}
		e.Tasks = append(e.Tasks, outcome)
	}
	return e
}

// Wait follows an execution until it finishes, or until limit has passed,
// and returns it as last seen. A stream that ends or drops before the
// execution finishes (the console's limit per stream, a load balancer's
// timeout) is reopened; a refusal ends the wait.
func (c *Client) Wait(ctx context.Context, id string, limit time.Duration) (*Execution, error) {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	var last *Execution
	for {
		stream, err := c.executions.WatchExecution(ctx, connect.NewRequest(&consolev1.WatchExecutionRequest{ExecutionId: id}))
		if err == nil {
			for stream.Receive() {
				last = execution(stream.Msg().GetExecution())
				if last.Finished() {
					_ = stream.Close()
					return last, nil
				}
			}
			err = stream.Err()
			_ = stream.Close()
		}
		if ctx.Err() != nil {
			return last, fmt.Errorf("execution %s didn't finish within %s", id, limit)
		}
		var ce *connect.Error
		if errors.As(err, &ce) && ce.Code() != connect.CodeUnavailable && ce.Code() != connect.CodeUnknown && ce.Code() != connect.CodeInternal {
			return last, refused(err)
		}
		// Ended or dropped: watch again after a moment.
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
}
