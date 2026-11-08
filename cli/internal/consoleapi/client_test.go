// SPDX-License-Identifier: MIT

package consoleapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	consolev1 "github.com/roburns/vennir/cli/internal/gen/vennir/console/v1"
	"github.com/roburns/vennir/cli/internal/gen/vennir/console/v1/consolev1connect"
)

// fakeConsole answers the calls vennir makes, recording what it was sent.
type fakeConsole struct {
	consolev1connect.UnimplementedAuthServiceHandler
	consolev1connect.UnimplementedTokenServiceHandler
	consolev1connect.UnimplementedExecutionServiceHandler

	mu        sync.Mutex
	auth      []string // the Authorization header of every call after login
	revoked   []string
	submitted *consolev1.Dag
	// Each watch plays the next script: its states, then how it ends.
	watches [][]consolev1.ExecutionState
	ending  []error
	// mustChange: the session's password was generated; changed: what
	// ChangePassword was sent.
	mustChange bool
	changed    *consolev1.ChangePasswordRequest
}

func (f *fakeConsole) saw(h http.Header) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.auth = append(f.auth, h.Get("Authorization"))
}

func (f *fakeConsole) Login(_ context.Context, req *connect.Request[consolev1.LoginRequest]) (*connect.Response[consolev1.LoginResponse], error) {
	if req.Msg.GetPassword() != "right" {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("Invalid email or password."))
	}
	return connect.NewResponse(&consolev1.LoginResponse{Token: "session"}), nil
}

func (f *fakeConsole) GetMe(_ context.Context, req *connect.Request[consolev1.GetMeRequest]) (*connect.Response[consolev1.GetMeResponse], error) {
	f.saw(req.Header())
	return connect.NewResponse(&consolev1.GetMeResponse{MustChangePassword: f.mustChange}), nil
}

func (f *fakeConsole) ChangePassword(_ context.Context, req *connect.Request[consolev1.ChangePasswordRequest]) (*connect.Response[consolev1.ChangePasswordResponse], error) {
	f.saw(req.Header())
	f.changed = req.Msg
	f.mustChange = false
	return connect.NewResponse(&consolev1.ChangePasswordResponse{Token: "fresh"}), nil
}

func (f *fakeConsole) ListAutomationTokens(_ context.Context, req *connect.Request[consolev1.ListAutomationTokensRequest]) (*connect.Response[consolev1.ListAutomationTokensResponse], error) {
	f.saw(req.Header())
	return connect.NewResponse(&consolev1.ListAutomationTokensResponse{Tokens: []*consolev1.AutomationToken{
		{Id: "old", Label: "catalog"}, {Id: "new", Label: "catalog"}, {Id: "other", Label: "purge"},
	}}), nil
}

func (f *fakeConsole) RevokeToken(_ context.Context, req *connect.Request[consolev1.RevokeTokenRequest]) (*connect.Response[consolev1.RevokeTokenResponse], error) {
	f.saw(req.Header())
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked = append(f.revoked, req.Msg.GetTokenId())
	return connect.NewResponse(&consolev1.RevokeTokenResponse{}), nil
}

func (f *fakeConsole) SubmitExecution(_ context.Context, req *connect.Request[consolev1.SubmitExecutionRequest]) (*connect.Response[consolev1.SubmitExecutionResponse], error) {
	f.saw(req.Header())
	f.submitted = req.Msg.GetDag()
	return connect.NewResponse(&consolev1.SubmitExecutionResponse{ExecutionId: "e1"}), nil
}

func (f *fakeConsole) WatchExecution(_ context.Context, req *connect.Request[consolev1.WatchExecutionRequest], stream *connect.ServerStream[consolev1.WatchExecutionResponse]) error {
	f.saw(req.Header())
	f.mu.Lock()
	if len(f.watches) == 0 {
		f.mu.Unlock()
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("no more watches scripted"))
	}
	states, ending := f.watches[0], f.ending[0]
	f.watches, f.ending = f.watches[1:], f.ending[1:]
	f.mu.Unlock()
	for _, state := range states {
		task := &consolev1.TaskStatus{TaskId: "smoke", State: consolev1.TaskState_TASK_STATE_RUNNING}
		if state == consolev1.ExecutionState_EXECUTION_STATE_SUCCEEDED {
			task.State = consolev1.TaskState_TASK_STATE_SUCCEEDED
		}
		if err := stream.Send(&consolev1.WatchExecutionResponse{Execution: &consolev1.Execution{
			ExecutionId: req.Msg.GetExecutionId(), State: state, Tasks: []*consolev1.TaskStatus{task},
		}}); err != nil {
			return err
		}
	}
	return ending
}

func serve(t *testing.T, f *fakeConsole) *Client {
	t.Helper()
	mux := http.NewServeMux()
	for _, register := range []func() (string, http.Handler){
		func() (string, http.Handler) { return consolev1connect.NewAuthServiceHandler(f) },
		func() (string, http.Handler) { return consolev1connect.NewTokenServiceHandler(f) },
		func() (string, http.Handler) { return consolev1connect.NewExecutionServiceHandler(f) },
	} {
		path, handler := register()
		mux.Handle("/api"+path, http.StripPrefix("/api", handler))
	}
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return New(server.URL)
}

func TestSignInRefusedSaysWhy(t *testing.T) {
	c := serve(t, &fakeConsole{})
	err := c.SignIn(context.Background(), "admin@example.com", "wrong")
	if err == nil || !strings.Contains(err.Error(), "unauthenticated") || !strings.Contains(err.Error(), "Invalid email or password.") {
		t.Fatalf("err = %v", err)
	}
}

func TestRevokeOthersKeepsTheNewTokenAndOtherLabels(t *testing.T) {
	f := &fakeConsole{}
	c := serve(t, f)
	if err := c.SignIn(context.Background(), "admin@example.com", "right"); err != nil {
		t.Fatal(err)
	}
	n, err := c.RevokeOthers(context.Background(), "catalog", "new")
	if err != nil || n != 1 || len(f.revoked) != 1 || f.revoked[0] != "old" {
		t.Fatalf("n=%d err=%v revoked=%v", n, err, f.revoked)
	}
	for _, h := range f.auth {
		if h != "Bearer session" {
			t.Fatalf("a call carried %q, not the session", h)
		}
	}
}

func TestSubmitAndWaitThroughAStreamThatEndsEarly(t *testing.T) {
	running, succeeded := consolev1.ExecutionState_EXECUTION_STATE_RUNNING, consolev1.ExecutionState_EXECUTION_STATE_SUCCEEDED
	f := &fakeConsole{
		// The console's limit per stream, then the finish.
		watches: [][]consolev1.ExecutionState{{running}, {running, succeeded}},
		ending:  []error{nil, nil},
	}
	c := serve(t, f)
	if err := c.SignIn(context.Background(), "admin@example.com", "right"); err != nil {
		t.Fatal(err)
	}
	id, err := c.Submit(context.Background(), "smoke", "req-1", []Task{{
		ID: "smoke", Image: "registry/team/upper:latest", Action: "transform", Team: "team",
		Inputs: map[string]any{"text": "hello"},
	}})
	if err != nil || id != "e1" {
		t.Fatalf("id=%q err=%v", id, err)
	}
	if got := f.submitted.GetTasks()[0].GetInputs().AsMap()["text"]; got != "hello" || f.submitted.GetRequestId() != "req-1" {
		t.Fatalf("submitted %v", f.submitted)
	}

	e, err := c.Wait(context.Background(), id, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if e.State != "SUCCEEDED" || e.Tasks[0].State != "SUCCEEDED" {
		t.Fatalf("execution = %+v", e)
	}
	// Submitting, and both watches.
	if len(f.auth) != 3 || f.auth[1] != "Bearer session" || f.auth[2] != "Bearer session" {
		t.Fatalf("the calls carried %v", f.auth)
	}
}

func TestWaitStopsOnARefusal(t *testing.T) {
	f := &fakeConsole{
		watches: [][]consolev1.ExecutionState{{}},
		ending:  []error{connect.NewError(connect.CodePermissionDenied, errors.New("Not a member."))},
	}
	c := serve(t, f)
	_, err := c.Wait(context.Background(), "e1", time.Minute)
	if err == nil || !strings.Contains(err.Error(), "Not a member.") {
		t.Fatalf("err = %v", err)
	}
}

// A generated password is changed, and the session goes on with the token
// the change returns.
func TestChangeGeneratedPassword(t *testing.T) {
	f := &fakeConsole{mustChange: true}
	c := serve(t, f)
	ctx := context.Background()
	if err := c.SignIn(ctx, "admin@example.com", "right"); err != nil {
		t.Fatal(err)
	}
	if must, err := c.MustChangePassword(ctx); err != nil || !must {
		t.Fatalf("must=%v err=%v", must, err)
	}
	if err := c.ChangePassword(ctx, "right", "my own password"); err != nil {
		t.Fatal(err)
	}
	if f.changed.GetCurrentPassword() != "right" || f.changed.GetNewPassword() != "my own password" {
		t.Errorf("sent %v", f.changed)
	}
	if _, err := c.RevokeOthers(ctx, "catalog", ""); err != nil {
		t.Fatal(err)
	}
	if last := f.auth[len(f.auth)-1]; last != "Bearer fresh" {
		t.Errorf("after the change a call carried %q", last)
	}
}
