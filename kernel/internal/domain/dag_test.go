// SPDX-License-Identifier: MIT

package domain

import (
	"errors"
	"fmt"
	"testing"
)

func task(id string, dependsOn []string, inputs map[string]any) TaskDef {
	return TaskDef{ID: id, Image: id + ":local", Action: "create", DependsOn: dependsOn, Inputs: inputs, Team: "test-team", ServiceAccount: "default"}
}

func t(id string, dependsOn ...string) TaskDef { return task(id, dependsOn, map[string]any{}) }

func valid(tb testing.TB, tasks []TaskDef, maxTasks int) []string {
	tb.Helper()
	order, err := ValidateDAG(tasks, maxTasks)
	if err != nil {
		tb.Fatal(err)
	}
	return order
}

func codes(tb testing.TB, tasks []TaskDef, maxTasks int) map[string]bool {
	tb.Helper()
	_, err := ValidateDAG(tasks, maxTasks)
	var invalid *DAGValidationError
	if !errors.As(err, &invalid) {
		tb.Fatalf("err = %v, want a DAGValidationError", err)
	}
	found := map[string]bool{}
	for _, issue := range invalid.Issues {
		found[issue.Code] = true
	}
	return found
}

func TestValidDAGsAreOrdered(t_ *testing.T) {
	refTo := func(from, output string) map[string]any { return map[string]any{"$fromTask": from, "$output": output} }
	for name, c := range map[string]struct {
		tasks []TaskDef
		want  []string
	}{
		"a chain": {[]TaskDef{t("create-project"),
			task("deploy-application", []string{"create-project"}, map[string]any{"projectId": refTo("create-project", "projectId")})},
			[]string{"create-project", "deploy-application"}},
		"independent, in submission order": {[]TaskDef{t("a"), t("b"), t("c")}, []string{"a", "b", "c"}},
		"a diamond":                        {[]TaskDef{t("a"), t("b", "a"), t("c", "a"), t("d", "b", "c")}, []string{"a", "b", "c", "d"}},
		"a diamond, reordered":             {[]TaskDef{t("a"), t("c", "a"), t("b", "a"), t("d", "b", "c")}, []string{"a", "c", "b", "d"}},
		"a nested reference": {[]TaskDef{t("create-project"), task("deploy-application", []string{"create-project"},
			map[string]any{"config": map[string]any{"nested": []any{refTo("create-project", "projectId")}}})}, []string{"create-project", "deploy-application"}},
		"literals beside references": {[]TaskDef{t("create-project"), task("deploy-application", []string{"create-project"},
			map[string]any{"projectId": refTo("create-project", "projectId"), "replicas": 3, "tags": []any{"blue", "green"}})}, []string{"create-project", "deploy-application"}},
		"two independent tasks": {[]TaskDef{t("t0"), t("t1")}, []string{"t0", "t1"}},
		"a direct dependency":   {[]TaskDef{t("a"), task("b", []string{"a"}, map[string]any{"x": refTo("a", "y")})}, []string{"a", "b"}},
	} {
		got := valid(t_, c.tasks, len(c.tasks)) // every one at its limit: allowed
		if fmt.Sprint(got) != fmt.Sprint(c.want) {
			t_.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
}

func TestInvalidDAGsAreRefusedWithEveryIssue(t_ *testing.T) {
	ref := func(from string) map[string]any {
		return map[string]any{"x": map[string]any{"$fromTask": from, "$output": "y"}}
	}
	for name, c := range map[string]struct {
		tasks    []TaskDef
		maxTasks int
		want     []string
		only     bool // exactly these codes
	}{
		"empty":                         {nil, 500, []string{"EMPTY_DAG"}, true},
		"too many":                      {[]TaskDef{t("t0"), t("t1"), t("t2")}, 2, []string{"MAX_TASK_COUNT_EXCEEDED"}, false},
		"a duplicate id":                {[]TaskDef{t("a"), t("a")}, 500, []string{"DUPLICATE_TASK_ID"}, false},
		"an unknown dependency":         {[]TaskDef{t("a", "does-not-exist")}, 500, []string{"UNKNOWN_DEPENDENCY"}, false},
		"a self dependency":             {[]TaskDef{t("a", "a")}, 500, []string{"SELF_DEPENDENCY"}, false},
		"a dependency twice":            {[]TaskDef{t("a"), t("b", "a", "a")}, 500, []string{"DUPLICATE_DEPENDENCY"}, true},
		"a direct cycle":                {[]TaskDef{t("a", "b"), t("b", "a")}, 500, []string{"CYCLE_DETECTED"}, false},
		"an indirect cycle":             {[]TaskDef{t("a", "c"), t("b", "a"), t("c", "b")}, 500, []string{"CYCLE_DETECTED"}, false},
		"a cycle beside a healthy task": {[]TaskDef{t("healthy"), t("a", "b"), t("b", "a")}, 500, []string{"CYCLE_DETECTED"}, false},
		"several at once":               {[]TaskDef{t("a", "a"), t("b", "missing")}, 500, []string{"SELF_DEPENDENCY", "UNKNOWN_DEPENDENCY"}, false},
		"a reference to an unknown task": {[]TaskDef{t("a"), task("b", []string{"a"}, ref("ghost"))}, 500,
			[]string{"UNKNOWN_INPUT_REFERENCE_TASK"}, false},
		"a reference to a task not depended on": {[]TaskDef{t("a"), t("b"), task("c", []string{"a"}, ref("b"))}, 500,
			[]string{"NON_UPSTREAM_INPUT_REFERENCE"}, false},
		"a reference to itself": {[]TaskDef{task("a", nil, ref("a"))}, 500, []string{"NON_UPSTREAM_INPUT_REFERENCE"}, false},
		"a credential in the inputs": {[]TaskDef{task("ok", nil, map[string]any{"bucket": "b"}),
			task("leaky", nil, map[string]any{"auth": map[string]any{"key": aws}})}, 500, []string{"INPUT_CONTAINS_CREDENTIAL"}, true},
	} {
		got := codes(t_, c.tasks, c.maxTasks)
		for _, code := range c.want {
			if !got[code] {
				t_.Errorf("%s: %v, want %s", name, got, code)
			}
		}
		if c.only && len(got) != len(c.want) {
			t_.Errorf("%s: %v, want only %v", name, got, c.want)
		}
	}
}

func TestACredentialIssueNamesItsTask(t_ *testing.T) {
	_, err := ValidateDAG([]TaskDef{task("leaky", nil, map[string]any{"key": aws})}, 500)
	var invalid *DAGValidationError
	if !errors.As(err, &invalid) || invalid.Issues[0].TaskID != "leaky" {
		t_.Fatalf("err = %v", err)
	}
}

func TestConcurrencyKeysNameTheScopeAndTheValuesInOrder(t *testing.T) {
	inputs := map[string]any{"projectId": "web-1", "region": "us", "size": 2}
	if got := ConcurrencyKey("acme-sql", []string{"projectId", "region"}, inputs); got != `["acme-sql","web-1","us"]` {
		t.Errorf("key = %s", got)
	}
	if got := ConcurrencyKey("acme-sql", []string{"missing"}, inputs); got != `["acme-sql",null]` {
		t.Errorf("missing input = %s", got)
	}
	for scope, names := range map[string][]string{"": {"a"}, "x": nil, "y": {"1", "2", "3", "4", "5", "6", "7", "8", "9"}} {
		if ConcurrencyKeyProblem(scope, names) == "" {
			t.Errorf("%q %v accepted", scope, names)
		}
	}
	if ConcurrencyKeyProblem("", nil) != "" || ConcurrencyKeyProblem("x", []string{"a"}) != "" {
		t.Error("a valid key was refused")
	}
	values := ConcurrencyValues(ConcurrencyKey("acme-sql", []string{"projectId", "size"}, inputs), []string{"projectId", "size"})
	if len(values) != 2 || values["projectId"] != "web-1" || values["size"] != 2.0 {
		t.Errorf("values = %v", values)
	}
	if ConcurrencyValues(`["acme-sql","web-1"]`, []string{"projectId", "region"}) != nil || ConcurrencyValues("not json", nil) != nil {
		t.Error("a key that doesn't fit its names gave values")
	}
}
