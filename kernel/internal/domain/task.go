// SPDX-License-Identifier: MIT

package domain

import (
	"fmt"
	"regexp"
)

// quantity is the Kubernetes quantities a task's size may be written in.
var quantity = regexp.MustCompile(`^[0-9]+(\.[0-9]+)?(m|k|Ki|M|Mi|G|Gi|T|Ti)?$`)

// Check is an error naming the first field that isn't a quantity.
func (r TaskResources) Check() error {
	for _, f := range [][2]string{{"cpu", r.CPU}, {"memory", r.Memory}, {"memoryLimit", r.MemoryLimit}} {
		if f[1] != "" && !quantity.MatchString(f[1]) {
			return fmt.Errorf("%s: %q isn't a Kubernetes quantity", f[0], f[1])
		}
	}
	return nil
}

// TaskResources is a task's Pod size, as Kubernetes quantities: cpu and
// memory are requested (what the cluster reserves, and what pay-per-Pod
// clusters bill); memory is capped at MemoryLimit, or at Memory when
// that's unset. Stored as JSON in execution_tasks.resources.
type TaskResources struct {
	CPU         string `json:"cpu,omitempty"`
	Memory      string `json:"memory,omitempty"`
	MemoryLimit string `json:"memoryLimit,omitempty"`
}

// Over is r with each unset part taken from defaults.
func (r TaskResources) Over(defaults *TaskResources) TaskResources {
	if defaults == nil {
		return r
	}
	or := func(a, b string) string {
		if a != "" {
			return a
		}
		return b
	}
	return TaskResources{CPU: or(r.CPU, defaults.CPU), Memory: or(r.Memory, defaults.Memory), MemoryLimit: or(r.MemoryLimit, defaults.MemoryLimit)}
}

// InputReference is an input of exactly {"$fromTask": id, "$output": name}:
// replaced, before the task runs, by that upstream task's output.
type InputReference struct {
	FromTask string
	Output   string
}

// ParseInputReference recognizes a reference marker: an object with
// exactly the keys $fromTask and $output, both non-empty strings.
func ParseInputReference(value any) (InputReference, bool) {
	m, ok := value.(map[string]any)
	if !ok || len(m) != 2 {
		return InputReference{}, false
	}
	from, fromOK := m["$fromTask"].(string)
	output, outputOK := m["$output"].(string)
	if !fromOK || !outputOK || from == "" || output == "" {
		return InputReference{}, false
	}
	return InputReference{FromTask: from, Output: output}, true
}

// MissingOutputError is an input referring to an output its upstream task
// never produced: a product-contract violation, never worth retrying.
type MissingOutputError struct {
	TaskID string
	Output string
}

func (e *MissingOutputError) Error() string {
	return fmt.Sprintf("Task '%s' did not produce output '%s'.", e.TaskID, e.Output)
}

// ResolveInputs replaces every reference marker in inputs, at any depth,
// with the output it names from outputsByTask (task key → outputs).
func ResolveInputs(inputs map[string]any, outputsByTask map[string]map[string]any) (map[string]any, error) {
	resolved := make(map[string]any, len(inputs))
	for key, value := range inputs {
		v, err := resolveValue(value, outputsByTask)
		if err != nil {
			return nil, err
		}
		resolved[key] = v
	}
	return resolved, nil
}

func resolveValue(value any, outputsByTask map[string]map[string]any) (any, error) {
	if ref, ok := ParseInputReference(value); ok {
		outputs := outputsByTask[ref.FromTask]
		output, present := outputs[ref.Output]
		if !present {
			return nil, &MissingOutputError{TaskID: ref.FromTask, Output: ref.Output}
		}
		return output, nil
	}
	switch v := value.(type) {
	case map[string]any:
		return ResolveInputs(v, outputsByTask)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			r, err := resolveValue(item, outputsByTask)
			if err != nil {
				return nil, err
			}
			out[i] = r
		}
		return out, nil
	}
	return value, nil
}

// ProductRequest is /platform/input/request.json: what a step is asked to do.
// Team is the namespace it runs in (its product's team); ForTeam the team
// it runs for, which may be another (a shared product's run), so a product
// can mark what it makes as that team's, and clean up only that team's.
// Left out when the task has none.
type ProductRequest struct {
	ExecutionID string         `json:"executionId"`
	TaskID      string         `json:"taskId"`
	Team        string         `json:"team"`
	ForTeam     string         `json:"forTeam,omitempty"`
	Action      string         `json:"action"`
	Attempt     int            `json:"attempt"`
	Inputs      map[string]any `json:"inputs"`
}
