// SPDX-License-Identifier: MIT

package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
)

// StructuredError is a failure a caller can act on: a stable code, a
// message for a person, and whether trying again may work. A step's own
// failure, and the kernel's (TASK_TIMEOUT, IMAGE_NOT_FOUND, ...), take this
// shape; it's stored as JSON in failure columns and events.
type StructuredError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

func (e StructuredError) Error() string { return e.Code + ": " + e.Message }

// AsMap is the error as stored in JSONB (failure columns, event payloads).
func (e StructuredError) AsMap() map[string]any {
	return map[string]any{"code": e.Code, "message": e.Message, "retryable": e.Retryable}
}

// RefusalCodes are the cluster's refusals to start an attempt: its
// admission policies', policy-controller's (IMAGE_NOT_SIGNED), and a Pod
// that can never fit its team's limits (RESOURCES_NOT_ALLOWED).
var RefusalCodes = []string{"DISPATCH_REJECTED", "TEAM_RETIRED", "IMAGE_NOT_ALLOWED", "IMAGE_NOT_PINNED", "IMAGE_SCAN_FAILED",
	"IMAGE_NOT_SIGNED", "IDENTITY_NOT_ALLOWED", "RESOURCES_NOT_ALLOWED"}

// ReservedCodes are every failure code the kernel or the cluster's policies
// set (RefusalCodes among them): callers, and the console's failure help,
// trust them to mean what the platform says, and the kernel decides
// whether they're retryable. A step's own result may not use one: it's
// recorded as ProductCodeReserved instead (ParseTaskResult). A test keeps
// the list in step with the codes the kernel's code and the chart's
// policies set.
var ReservedCodes = append(slices.Clone(RefusalCodes),
	// The cluster's policies that only a step Job or Pod made by someone
	// else meets (the scheduler's are never refused so).
	"STEP_JOB_NOT_ALLOWED", "STEP_POD_NOT_ALLOWED",
	// The scheduler's, before a step starts and once it finishes.
	"MISSING_UPSTREAM_OUTPUT", "INPUT_INVALID", "OUTPUT_INVALID", "EXECUTOR_START_FAILED",
	"TASK_TIMEOUT", "TASK_NOT_STARTED", "APPROVAL_EXPIRED", "APPROVAL_DECLINED",
	// The executor's, from what the cluster says of its Job and Pod.
	"JOB_NOT_FOUND", "IMAGE_INVALID", "IMAGE_NOT_FOUND", "IMAGE_USER_NOT_ALLOWED", "IMAGE_PULL_FAILED",
	"POD_TERMINATED_UNEXPECTEDLY", "PRODUCT_RESULT_MISSING", "PRODUCT_RESULT_INVALID", "OUTPUT_CONTAINS_CREDENTIAL",
	ProductCodeReserved)

// ProductCodeReserved is a step's own failure reported under a reserved
// code: its message kept, the code it claimed noted, never retried (the
// same step would claim it again).
const ProductCodeReserved = "PRODUCT_CODE_RESERVED"

// TaskResult is what a step writes to /platform/output/result.json.
type TaskResult struct {
	Status  string           `json:"status"`
	Outputs map[string]any   `json:"outputs"`
	Error   *StructuredError `json:"error"`
}

// ParseTaskResult reads a result.json the way the contract defines it:
// status "succeeded" (with outputs, default {}) or "failed" (with an error
// of a non-empty code and message), and nothing else. A failure under one
// of ReservedCodes is recorded as ProductCodeReserved.
func ParseTaskResult(data []byte) (TaskResult, error) {
	var raw struct {
		Status  *string         `json:"status"`
		Outputs map[string]any  `json:"outputs"`
		Error   json.RawMessage `json:"error"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(&raw); err != nil {
		return TaskResult{}, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return TaskResult{}, errors.New("unexpected content after the JSON object")
	}
	result := TaskResult{Outputs: raw.Outputs}
	if raw.Status == nil {
		return TaskResult{}, errors.New("status: field required")
	}
	result.Status = *raw.Status
	if result.Status != "succeeded" && result.Status != "failed" {
		return TaskResult{}, fmt.Errorf("status: must be 'succeeded' or 'failed', got %q", result.Status)
	}
	if result.Outputs == nil {
		result.Outputs = map[string]any{}
	}
	if len(raw.Error) > 0 && string(raw.Error) != "null" {
		var e struct {
			Code      *string `json:"code"`
			Message   *string `json:"message"`
			Retryable *bool   `json:"retryable"`
		}
		errDecoder := json.NewDecoder(bytes.NewReader(raw.Error))
		errDecoder.DisallowUnknownFields()
		if err := errDecoder.Decode(&e); err != nil {
			return TaskResult{}, fmt.Errorf("error: %w", err)
		}
		if e.Code == nil || *e.Code == "" || e.Message == nil || *e.Message == "" {
			return TaskResult{}, errors.New("error: code and message are required, and not empty")
		}
		result.Error = &StructuredError{Code: *e.Code, Message: *e.Message, Retryable: e.Retryable != nil && *e.Retryable}
		if slices.Contains(ReservedCodes, *e.Code) {
			result.Error = &StructuredError{Code: ProductCodeReserved, Retryable: false, Message: fmt.Sprintf(
				"%s (The step reported its failure as %s, a code only the platform sets.)", *e.Message, *e.Code)}
		}
	}
	if result.Status == "failed" && result.Error == nil {
		return TaskResult{}, errors.New("a failed task result must include a structured error")
	}
	if result.Status == "succeeded" && result.Error != nil {
		return TaskResult{}, errors.New("a succeeded task result must not include an error")
	}
	return result, nil
}
