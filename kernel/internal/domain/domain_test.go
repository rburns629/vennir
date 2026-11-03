// SPDX-License-Identifier: MIT

package domain

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Credentials, retry backoff, states, input resolution and the result.json
// contract.

// Built up so no scanner mistakes this file for a leak.
var (
	aws      = "AKIA" + "ABCDEFGHIJKLMNOP"
	github   = "ghp_" + strings.Repeat("a1B2", 9)
	keyBegin = "-----BEGIN " + "RSA PRIVATE KEY-----"
	keyEnd   = "-----END " + "RSA PRIVATE KEY-----"
)

func same(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s = %#v, want %#v", what, got, want)
	}
}

func TestTokensAreRedactedInPlace(t *testing.T) {
	same(t, "redacted", RedactText("using key "+aws+" and token "+github+" for my-bucket"),
		"using key [redacted AWS access key] and token [redacted GitHub token] for my-bucket")
}

func TestBearerTokensAndJWTsAreRedactedFromLogs(t *testing.T) {
	jwt := "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3"
	if strings.Contains(RedactText("token="+jwt), "eyJ") {
		t.Error("the JWT wasn't redacted")
	}
	same(t, "bearer", RedactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"), "Authorization: [redacted bearer token]")
}

func TestAPrivateKeySpanningLinesIsReplacedWhole(t *testing.T) {
	same(t, "lines", RedactLines([]string{"starting", "key: " + keyBegin, "MIIEowIBAAKCAQEA", "x9y8z7", keyEnd, "done"}),
		[]string{"starting", "key: [redacted private key]", "done"})
}

func TestAPrivateKeyNeverEndedHidesEverythingAfterIt(t *testing.T) {
	same(t, "lines", RedactLines([]string{"a", keyBegin, "MIIE", "more"}), []string{"a", "[redacted private key]"})
}

func TestAPrivateKeyOnOneLineAsJSONEscapesIt(t *testing.T) {
	saKey := `{"private_key": "` + keyBegin + `\nMIIE\n` + keyEnd + `\n", "type": "x"}`
	same(t, "redacted", RedactText(saKey), `{"private_key": "[redacted private key]\n", "type": "x"}`)
}

func TestOrdinaryOutputIsLeftAlone(t *testing.T) {
	ordinary := []string{
		"Created project my-project-1234 in folder 98765",
		"sha256:" + strings.Repeat("a", 64),
		"https://storage.googleapis.com/bucket/object",
		"AKIA is a prefix, not a key",
	}
	same(t, "lines", RedactLines(ordinary), ordinary)
	uris := make([]any, len(ordinary))
	for i, s := range ordinary {
		uris[i] = s
	}
	same(t, "found", FindCredential(map[string]any{"projectId": "p-1", "uris": uris}), "")
}

func TestCredentialsAreFoundAnywhereInOutputs(t *testing.T) {
	same(t, "nested", FindCredential(map[string]any{"a": map[string]any{"b": []any{1, map[string]any{"c": "x " + aws}}}}), "AWS access key")
	same(t, "key", FindCredential(map[string]any{github: true}), "GitHub token")
	same(t, "pem", FindCredential(map[string]any{"serviceAccountKey": keyBegin + "\nMII\n" + keyEnd}), "private key")
}

func TestRetryBackoff(t *testing.T) {
	b := RetryBackoff{Base: 5 * time.Second, Max: 300 * time.Second}
	var delays []time.Duration
	for n := 1; n <= 4; n++ {
		delays = append(delays, b.Delay(n))
	}
	same(t, "doubles from the base", delays, []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second})
	same(t, "never exceeds the maximum", b.Delay(20), 300*time.Second)
	same(t, "never overflows", b.Delay(200), 300*time.Second)
	same(t, "zero means at once", RetryBackoff{}.Delay(3), time.Duration(0))
}

func TestShouldRetry(t *testing.T) {
	same(t, "attempts remaining", ShouldRetry(1, 2, true), true)
	same(t, "none remaining", ShouldRetry(2, 2, true), false)
	same(t, "not retryable", ShouldRetry(1, 5, false), false)
	same(t, "count past max", ShouldRetry(3, 2, true), false)
}

func ref(from, output string) map[string]any {
	return map[string]any{"$fromTask": from, "$output": output}
}

func TestResolveInputs(t *testing.T) {
	outputs := map[string]map[string]any{"create-project": {"projectId": "demo-project-123", "region": "us-east-1"}}
	resolve := func(inputs map[string]any) map[string]any {
		t.Helper()
		r, err := ResolveInputs(inputs, outputs)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	literal := map[string]any{"projectName": "demo-project", "replicas": 3, "tags": []any{"blue", "green"}}
	same(t, "literals", resolve(literal), literal)
	same(t, "top level", resolve(map[string]any{"projectId": ref("create-project", "projectId")}), map[string]any{"projectId": "demo-project-123"})
	same(t, "in a map", resolve(map[string]any{"config": map[string]any{"project": ref("create-project", "projectId")}}),
		map[string]any{"config": map[string]any{"project": "demo-project-123"}})
	same(t, "in a list", resolve(map[string]any{"ids": []any{ref("create-project", "projectId"), "literal-id"}}),
		map[string]any{"ids": []any{"demo-project-123", "literal-id"}})
	same(t, "several", resolve(map[string]any{"projectId": ref("create-project", "projectId"), "region": ref("create-project", "region")}),
		map[string]any{"projectId": "demo-project-123", "region": "us-east-1"})
	same(t, "empty", resolve(map[string]any{}), map[string]any{})
	// Not exactly the two keys: an ordinary value.
	extra := map[string]any{"x": map[string]any{"$fromTask": "create-project", "$output": "projectId", "other": 1}}
	same(t, "not a reference", resolve(extra), extra)
}

func TestAReferenceToAMissingOutputFails(t *testing.T) {
	for name, outputs := range map[string]map[string]map[string]any{
		"wrong key":  {"create-project": {"unrelatedOutput": "x"}},
		"no outputs": {},
	} {
		_, err := ResolveInputs(map[string]any{"projectId": ref("create-project", "projectId")}, outputs)
		var missing *MissingOutputError
		if !errors.As(err, &missing) {
			t.Fatalf("%s: err = %v", name, err)
		}
		same(t, name, *missing, MissingOutputError{TaskID: "create-project", Output: "projectId"})
	}
}

func TestParseTaskResult(t *testing.T) {
	ok, err := ParseTaskResult([]byte(`{"status": "succeeded", "outputs": {"n": 1}}`))
	if err != nil {
		t.Fatal(err)
	}
	same(t, "outputs", ok.Outputs, map[string]any{"n": json.Number("1")})
	ok, err = ParseTaskResult([]byte(`{"status": "succeeded"}`))
	if err != nil {
		t.Fatal(err)
	}
	same(t, "default outputs", ok.Outputs, map[string]any{})
	failed, err := ParseTaskResult([]byte(`{"status": "failed", "error": {"code": "QUOTA", "message": "no", "retryable": true}}`))
	if err != nil {
		t.Fatal(err)
	}
	same(t, "error", *failed.Error, StructuredError{Code: "QUOTA", Message: "no", Retryable: true})

	_, err = ParseTaskResult([]byte(`{"status": "failed", "error": {"code": "IMAGE_NOT_ALLOWED", "message": "m"}}`))
	var reserved *ReservedCodeError
	if !errors.As(err, &reserved) || reserved.Code != "IMAGE_NOT_ALLOWED" {
		t.Errorf("a reserved code: %v", err)
	}

	for _, bad := range []string{
		``, `[]`, `{}`, `{"status": "done"}`,
		`{"status": "succeeded", "extra": 1}`,
		`{"status": "failed"}`,
		`{"status": "failed", "error": {"code": "", "message": "m"}}`,
		`{"status": "failed", "error": {"code": "C"}}`,
		`{"status": "failed", "error": {"code": "C", "message": "m", "detail": 1}}`,
		`{"status": "succeeded", "error": {"code": "C", "message": "m"}}`,
		`{"status": "succeeded"} {}`,
		`{"status": "failed", "error": {"code": "IMAGE_NOT_ALLOWED", "message": "a refusal it didn't get"}}`,
		`{"status": "failed", "error": {"code": "RESOURCES_NOT_ALLOWED", "message": "m"}}`,
	} {
		if _, err := ParseTaskResult([]byte(bad)); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}

// Kubernetes quantities, and nothing else.
func TestTaskResourcesAcceptKubernetesQuantitiesOnly(t *testing.T) {
	if err := (TaskResources{CPU: "250m", Memory: "512Mi", MemoryLimit: "1Gi"}).Check(); err != nil {
		t.Error(err)
	}
	for _, bad := range []string{"lots", "512 MiB", "-1", "1Gb"} {
		if (TaskResources{Memory: bad}).Check() == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}

func TestTokenAudiences(t *testing.T) {
	if got := TokenFileName("api://AzureADTokenExchange"); got != "api___AzureADTokenExchange" {
		t.Errorf("file name = %s", got)
	}
	if problem := TokenAudiencesProblem([]string{"sts.amazonaws.com", "api://AzureADTokenExchange"}); problem != "" {
		t.Errorf("good audiences refused: %s", problem)
	}
	for name, audiences := range map[string][]string{
		"empty":      {""},
		"padded":     {" sts.amazonaws.com"},
		"same file":  {"a:b", "a/b"},
		"not a file": {".."},
		"too long":   {strings.Repeat("a", 257)},
		"too many":   {"1", "2", "3", "4", "5", "6", "7", "8", "9"},
	} {
		if TokenAudiencesProblem(audiences) == "" {
			t.Errorf("%s: accepted %v", name, audiences)
		}
	}
}

func TestSchemaProblems(t *testing.T) {
	schema, err := CompileSchema(map[string]any{
		"type": "object", "required": []any{"name"}, "additionalProperties": false,
		"properties": map[string]any{"name": map[string]any{"type": "string"}, "count": map[string]any{"type": "integer"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if problems := schema.Problems(map[string]any{"name": "a", "count": float64(2)}); problems != nil {
		t.Errorf("a fitting value: %v", problems)
	}
	problems := schema.Problems(map[string]any{"count": 2.5, "extra": true})
	if len(problems) != 3 {
		t.Errorf("problems = %v", problems)
	}
	// Nothing outside the schema is ever fetched.
	if _, err := CompileSchema(map[string]any{"$ref": "https://example.com/schema.json"}); err == nil {
		t.Error("a schema referring outside itself compiled")
	}
}
