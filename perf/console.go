// SPDX-License-Identifier: MIT
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// console calls the console's API as a pipeline does: Connect's JSON over
// HTTP, with a bearer token (console/docs/05-calling-the-api.md). Nothing is
// bypassed: sign-in, authorization, image pinning and admission all apply.
type console struct {
	url   string
	token string
	http  *http.Client
}

type apiError struct {
	Status  int
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string { return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message) }

func (c *console) call(ctx context.Context, method string, request, response any) error {
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/api/vennir.console.v1."+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		e := &apiError{Status: resp.StatusCode}
		_ = json.Unmarshal(data, e)
		return e
	}
	return json.Unmarshal(data, response)
}

// The parts of the console's messages a benchmark reads.
type taskDefinition struct {
	ID        string         `json:"id"`
	Image     string         `json:"image"`
	Action    string         `json:"action"`
	Team      string         `json:"team"`
	DependsOn []string       `json:"dependsOn,omitempty"`
	Inputs    map[string]any `json:"inputs"`
}

type dag struct {
	Name      string           `json:"name"`
	RequestID string           `json:"requestId"`
	Tasks     []taskDefinition `json:"tasks"`
}

type attempt struct {
	Number      int        `json:"number"`
	StartedAt   *time.Time `json:"startedAt"`
	CompletedAt *time.Time `json:"completedAt"`
}

type taskStatus struct {
	TaskID       string         `json:"taskId"`
	State        string         `json:"state"`
	AttemptCount int            `json:"attemptCount"`
	Outputs      map[string]any `json:"outputs"`
	DependsOn    []string       `json:"dependsOn"`
	StartedAt    *time.Time     `json:"startedAt"`
	CompletedAt  *time.Time     `json:"completedAt"`
	Attempts     []attempt      `json:"attempts"`
}

type execution struct {
	ExecutionID string       `json:"executionId"`
	State       string       `json:"state"`
	CreatedAt   time.Time    `json:"createdAt"`
	Tasks       []taskStatus `json:"tasks"`
}

func (c *console) submit(ctx context.Context, d dag) (string, error) {
	var out struct {
		ExecutionID string `json:"executionId"`
	}
	err := c.call(ctx, "ExecutionService/SubmitExecution", map[string]any{"dag": d}, &out)
	return out.ExecutionID, err
}

func (c *console) get(ctx context.Context, id string) (*execution, error) {
	var out struct {
		Execution execution `json:"execution"`
	}
	if err := c.call(ctx, "ExecutionService/GetExecution", map[string]any{"executionId": id}, &out); err != nil {
		return nil, err
	}
	return &out.Execution, nil
}

func terminal(state string) bool {
	switch state {
	case "EXECUTION_STATE_SUCCEEDED", "EXECUTION_STATE_FAILED", "EXECUTION_STATE_CANCELLED":
		return true
	}
	return false
}
