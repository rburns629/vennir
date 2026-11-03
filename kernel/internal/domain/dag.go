// SPDX-License-Identifier: MIT

package domain

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
)

// TaskDef is one task as submitted, already checked field by field
// (kernel-api's edge): what the DAG checks and the database rows need.
type TaskDef struct {
	ID             string
	Image          string
	Action         string
	DependsOn      []string
	Inputs         map[string]any
	TimeoutSeconds int
	MaxAttempts    int
	Team           string
	ServiceAccount string
	SecretRefs     []string
	Resources      *TaskResources
	// TokenAudiences each get a projected token at /platform/tokens/
	// <TokenFileName(audience)>.
	TokenAudiences []string
	// InputSchema and OutputSchema are the product's (JSON Schema); nil:
	// not checked.
	InputSchema  map[string]any
	OutputSchema map[string]any
	// ConcurrencyScope and ConcurrencyInputs hold the task while another
	// with the same key (ConcurrencyKey) is claimed or running; no scope:
	// never held.
	ConcurrencyScope  string
	ConcurrencyInputs []string
	// ApprovalRequired holds the task in AWAITING_APPROVAL until a person
	// approves it, instead of letting it become READY.
	ApprovalRequired bool
	// CapScope and CapLimit hold the task while CapLimit tasks of the same
	// scope (its product) are claimed or running; no scope: no cap.
	CapScope string
	CapLimit int
	// Capacity is the kind its product asks for (Capacities); "": the
	// install's own placement.
	Capacity string
	// ForTeam is the team it runs for (request.json's forTeam), a
	// namespace name; "": none.
	ForTeam string
}

// NamespaceNameProblem says what's wrong with a Kubernetes namespace name
// (an RFC 1123 label: lowercase letters, digits and "-", starting and
// ending with a letter or digit, at most 63), or "".
func NamespaceNameProblem(name string) string {
	if len(name) > 63 {
		return "must be at most 63 characters"
	}
	for i, r := range name {
		alnum := r >= 'a' && r <= 'z' || r >= '0' && r <= '9'
		if !alnum && (r != '-' || i == 0 || i == len(name)-1) {
			return "must be a namespace name: lowercase letters, digits and \"-\", starting and ending with a letter or digit"
		}
	}
	return ""
}

// MaxTokenAudiences is how many a task may ask for.
const MaxTokenAudiences = 8

// TokenFileName is where an audience's token is, under /platform/tokens/:
// the audience with every character outside [A-Za-z0-9._-] replaced by "_"
// ("api://AzureADTokenExchange" is api___AzureADTokenExchange).
func TokenFileName(audience string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			return r
		}
		return '_'
	}, audience)
}

// TokenAudiencesProblem says what's wrong with a task's audiences, or "".
func TokenAudiencesProblem(audiences []string) string {
	if len(audiences) > MaxTokenAudiences {
		return fmt.Sprintf("may name at most %d", MaxTokenAudiences)
	}
	files := map[string]string{}
	for _, a := range audiences {
		switch {
		case strings.TrimSpace(a) != a || a == "":
			return fmt.Sprintf("has an empty or space-padded audience %q", a)
		case len(a) > 256:
			return fmt.Sprintf("has an audience longer than 256 characters (%.40s…)", a)
		case TokenFileName(a) == "." || TokenFileName(a) == "..":
			return fmt.Sprintf("has an audience that can't be a file name (%q)", a)
		}
		if other, seen := files[TokenFileName(a)]; seen {
			return fmt.Sprintf("names %q and %q, which share the file %s", other, a, TokenFileName(a))
		}
		files[TokenFileName(a)] = a
	}
	return ""
}

// InitialState is BLOCKED for a task with dependencies, else
// AWAITING_APPROVAL if it needs an approval, else READY.
func (t TaskDef) InitialState() TaskState {
	if len(t.DependsOn) > 0 {
		return TaskBlocked
	}
	if t.ApprovalRequired {
		return TaskAwaitingApproval
	}
	return TaskReady
}

// ValidationIssue is one thing wrong with a submitted DAG.
type ValidationIssue struct {
	Code    string
	Message string
	TaskID  string // "" when it's about the whole DAG
}

// DAGValidationError carries every issue found, so one round trip reports
// everything wrong.
type DAGValidationError struct{ Issues []ValidationIssue }

func (e *DAGValidationError) Error() string {
	messages := make([]string, len(e.Issues))
	for i, issue := range e.Issues {
		messages[i] = issue.Message
	}
	return fmt.Sprintf("DAG validation failed with %d issue(s): %s", len(e.Issues), strings.Join(messages, "; "))
}

// ValidateDAG checks a submitted DAG before anything is stored: no tasks or
// too many, duplicate ids, unknown, self or repeated dependencies, cycles,
// $fromTask references to anything but a direct dependency, and inputs
// that look like credentials. It returns a deterministic topological
// order, or a *DAGValidationError with every issue found. Checks that need
// a well-formed graph are skipped once a structural issue makes it
// ambiguous, rather than report misleading follow-on errors.
func ValidateDAG(tasks []TaskDef, maxTasks int) ([]string, error) {
	if len(tasks) == 0 {
		return nil, &DAGValidationError{[]ValidationIssue{{Code: "EMPTY_DAG", Message: "An execution must contain at least one task."}}}
	}
	var issues []ValidationIssue
	if len(tasks) > maxTasks {
		issues = append(issues, ValidationIssue{Code: "MAX_TASK_COUNT_EXCEEDED",
			Message: fmt.Sprintf("Execution contains %d tasks, exceeding the maximum of %d.", len(tasks), maxTasks)})
	}
	for _, id := range duplicateIDs(tasks) {
		issues = append(issues, ValidationIssue{Code: "DUPLICATE_TASK_ID", Message: fmt.Sprintf("Task id '%s' is defined more than once.", id), TaskID: id})
	}
	if len(issues) > 0 {
		// Ambiguous id lookups (or a pointless oversized list): every check
		// below assumes neither.
		return nil, &DAGValidationError{issues}
	}
	known := map[string]bool{}
	for _, t := range tasks {
		known[t.ID] = true
	}
	if dependency := dependencyIssues(tasks, known); len(dependency) > 0 {
		// Cycle detection assumes every edge points at a real, distinct task.
		return nil, &DAGValidationError{dependency}
	}
	issues = append(issues, referenceIssues(tasks, known)...)
	// Inputs are stored and readable by anyone who can read the execution;
	// a step's credentials reach it as mounted secrets (secretRefs) instead.
	for _, t := range tasks {
		if kind := FindCredential(t.Inputs); kind != "" {
			issues = append(issues, ValidationIssue{Code: "INPUT_CONTAINS_CREDENTIAL", TaskID: t.ID, Message: fmt.Sprintf(
				"Task '%s' has an input that looks like a credential (%s). Register it as a team secret and list it in secretRefs instead.", t.ID, kind)})
		}
	}
	order, cycle := TopologicalSort(tasks)
	issues = append(issues, cycle...)
	if len(issues) > 0 {
		return nil, &DAGValidationError{issues}
	}
	return order, nil
}

// TopologicalSort orders tasks so every dependency precedes its dependents,
// ties broken by submission order; on a cycle, an issue for each task in
// or after it.
func TopologicalSort(tasks []TaskDef) ([]string, []ValidationIssue) {
	index := map[string]int{}
	inDegree := map[string]int{}
	dependents := map[string][]string{}
	for i, t := range tasks {
		index[t.ID] = i
		inDegree[t.ID] = 0
	}
	for _, t := range tasks {
		for _, dep := range t.DependsOn {
			inDegree[t.ID]++
			dependents[dep] = append(dependents[dep], t.ID)
		}
	}
	bySubmission := func(ids []string) { sort.Slice(ids, func(i, j int) bool { return index[ids[i]] < index[ids[j]] }) }
	var ready []string
	for _, t := range tasks {
		if inDegree[t.ID] == 0 {
			ready = append(ready, t.ID)
		}
	}
	var order []string
	for len(ready) > 0 {
		current := ready[0]
		ready = ready[1:]
		order = append(order, current)
		for _, dependent := range dependents[current] {
			inDegree[dependent]--
			if inDegree[dependent] == 0 {
				ready = append(ready, dependent)
			}
		}
		bySubmission(ready)
	}
	if len(order) == len(tasks) {
		return order, nil
	}
	var remaining []string
	for _, t := range tasks {
		if !slices.Contains(order, t.ID) {
			remaining = append(remaining, t.ID)
		}
	}
	sort.Strings(remaining)
	issues := make([]ValidationIssue, len(remaining))
	for i, id := range remaining {
		issues[i] = ValidationIssue{Code: "CYCLE_DETECTED", TaskID: id,
			Message: fmt.Sprintf("Cycle detected involving task(s): %s.", strings.Join(remaining, ", "))}
	}
	return nil, issues
}

func duplicateIDs(tasks []TaskDef) []string {
	seen, duplicate := map[string]bool{}, map[string]bool{}
	for _, t := range tasks {
		if seen[t.ID] {
			duplicate[t.ID] = true
		}
		seen[t.ID] = true
	}
	ids := make([]string, 0, len(duplicate))
	for id := range duplicate {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func dependencyIssues(tasks []TaskDef, known map[string]bool) []ValidationIssue {
	var issues []ValidationIssue
	for _, t := range tasks {
		counts := map[string]int{}
		for _, dep := range t.DependsOn {
			counts[dep]++
		}
		var repeated []string
		for dep, n := range counts {
			if n > 1 {
				repeated = append(repeated, dep)
			}
		}
		sort.Strings(repeated)
		for _, dep := range repeated {
			issues = append(issues, ValidationIssue{Code: "DUPLICATE_DEPENDENCY", TaskID: t.ID,
				Message: fmt.Sprintf("Task '%s' lists '%s' in dependsOn more than once.", t.ID, dep)})
		}
		for _, dep := range t.DependsOn {
			switch {
			case dep == t.ID:
				issues = append(issues, ValidationIssue{Code: "SELF_DEPENDENCY", TaskID: t.ID, Message: fmt.Sprintf("Task '%s' cannot depend on itself.", t.ID)})
			case !known[dep]:
				issues = append(issues, ValidationIssue{Code: "UNKNOWN_DEPENDENCY", TaskID: t.ID, Message: fmt.Sprintf("Task '%s' depends on unknown task '%s'.", t.ID, dep)})
			}
		}
	}
	return issues
}

func referenceIssues(tasks []TaskDef, known map[string]bool) []ValidationIssue {
	var issues []ValidationIssue
	for _, t := range tasks {
		for _, ref := range InputReferences(t.Inputs) {
			switch {
			case !known[ref.FromTask]:
				issues = append(issues, ValidationIssue{Code: "UNKNOWN_INPUT_REFERENCE_TASK", TaskID: t.ID,
					Message: fmt.Sprintf("Task '%s' references output of unknown task '%s'.", t.ID, ref.FromTask)})
			case !slices.Contains(t.DependsOn, ref.FromTask):
				issues = append(issues, ValidationIssue{Code: "NON_UPSTREAM_INPUT_REFERENCE", TaskID: t.ID,
					Message: fmt.Sprintf("Task '%s' references output of task '%s', which is not declared in its dependsOn list.", t.ID, ref.FromTask)})
			}
		}
	}
	return issues
}

// InputReferences is every $fromTask/$output reference in value, at any
// depth, in a deterministic order.
func InputReferences(value any) []InputReference {
	if ref, ok := ParseInputReference(value); ok {
		return []InputReference{ref}
	}
	var found []InputReference
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			found = append(found, InputReferences(v[k])...)
		}
	case []any:
		for _, item := range v {
			found = append(found, InputReferences(item)...)
		}
	}
	return found
}

// MaxConcurrencyInputs is how many inputs a concurrency key may name.
const MaxConcurrencyInputs = 8

// ConcurrencyKeyProblem is why a task's concurrency key can't be used, or "".
func ConcurrencyKeyProblem(scope string, inputs []string) string {
	switch {
	case scope == "" && len(inputs) == 0:
		return ""
	case scope == "" || len(scope) > 256:
		return "needs a scope of at most 256 characters"
	case len(inputs) == 0 || len(inputs) > MaxConcurrencyInputs:
		return fmt.Sprintf("needs 1 to %d inputs", MaxConcurrencyInputs)
	}
	return ""
}

// Capacities are the kinds of capacity a product may ask for, each a
// placement the install may set.
var Capacities = []string{"spot", "onDemand"}

// MaxProductCap is the most a product's cap may be.
const MaxProductCap = 100

// ProductCapProblem is why a task's product cap can't be used, or "".
func ProductCapProblem(scope string, limit int) string {
	switch {
	case scope == "" && limit == 0:
		return ""
	case scope == "" || len(scope) > 256:
		return "needs a scope of at most 256 characters"
	case limit < 1 || limit > MaxProductCap:
		return fmt.Sprintf("needs max_running from 1 to %d", MaxProductCap)
	}
	return ""
}

// ConcurrencyKey is the key two tasks share when they'd change the same
// thing: the scope and the named inputs' resolved values, in order. A
// missing input counts as null.
func ConcurrencyKey(scope string, names []string, inputs map[string]any) string {
	values := make([]any, 0, len(names)+1)
	values = append(values, scope)
	for _, name := range names {
		values = append(values, inputs[name])
	}
	key, err := json.Marshal(values)
	if err != nil {
		// Inputs came from JSON, so they always encode; fall back to a key
		// that still keeps tasks of this scope apart from each other's.
		return fmt.Sprintf("%q", scope)
	}
	return string(key)
}

// ConcurrencyValues is a key's input values by name (ConcurrencyKey the
// other way), or nil when the key wasn't made from these names.
func ConcurrencyValues(key string, names []string) map[string]any {
	var values []any
	if json.Unmarshal([]byte(key), &values) != nil || len(values) != len(names)+1 {
		return nil
	}
	out := make(map[string]any, len(names))
	for i, name := range names {
		out[name] = values[i+1]
	}
	return out
}
