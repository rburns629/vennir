// SPDX-License-Identifier: MIT

package policy

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/google/cel-go/cel"
)

// hostile are strings a catalog release could carry into the literals:
// quotes, backslashes, control characters, the line separators JavaScript
// (and some JSON) treats specially, non-ASCII, and CEL's own syntax.
var hostile = []string{
	`a"b`, `a\b`, `a\"}, "x": [1]`, "tab\there", "nul\x00byte", "bell\x07", "line\nbreak", "cr\rlf",
	"ls ps ", "é漢字🙂", `'single'`, "${variables.x}", `A`, `'''`, `"""`, "\x7f",
}

// celValue compiles a literal as the API server would compile the
// variable's expression, and evaluates it.
func celValue(t *testing.T, literal string) any {
	t.Helper()
	env, err := cel.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	ast, issues := env.Compile(literal)
	if issues != nil && issues.Err() != nil {
		t.Fatalf("%q doesn't compile: %v", literal, issues.Err())
	}
	program, err := env.Program(ast)
	if err != nil {
		t.Fatal(err)
	}
	out, _, err := program.Eval(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	native, err := out.ConvertToNative(reflect.TypeOf(map[string]any{}))
	if err != nil {
		t.Fatalf("%q: %v", literal, err)
	}
	// Through JSON, so it compares as encoding/json decodes the literal.
	data, err := json.Marshal(native)
	if err != nil {
		t.Fatal(err)
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func jsonValue(t *testing.T, literal string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(literal), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestTheLiteralsCompileAsCELWhateverTheCatalogSays(t *testing.T) {
	listed := map[string][]Entry{}
	audiences := map[string][]string{}
	for i, s := range hostile {
		d := "sha256:" + Digits[i%16] + strings.Repeat("0", 62) + Digits[i%16]
		listed[d] = append(listed[d], Entry{Team: s, Repository: "r/" + s, Action: s, ServiceAccount: "sa", Audiences: s + "," + s})
		audiences["team/"+s] = []string{s, "x" + s}
	}
	identity, err := IdentityVariables(listed)
	if err != nil {
		t.Fatal(err)
	}
	tokens, err := AudienceVariables(audiences)
	if err != nil {
		t.Fatal(err)
	}
	for name, literal := range mergeMaps(identity, tokens) {
		if got, want := celValue(t, literal), jsonValue(t, literal); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: CEL reads %v, JSON %v", name, got, want)
		}
	}
}

func mergeMaps(a, b map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}
