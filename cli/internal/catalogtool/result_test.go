// SPDX-License-Identifier: MIT

package catalogtool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResultsAreReadAsTheKernelReadsThem(t *testing.T) {
	for name, c := range map[string]struct {
		result string
		ok     bool
	}{
		"succeeded":                 {`{"status":"succeeded","outputs":{"id":"x"}}`, true},
		"succeeded, no outputs":     {`{"status":"succeeded"}`, true},
		"failed":                    {`{"status":"failed","error":{"code":"NOPE","message":"no","retryable":true}}`, true},
		"failed, retryable omitted": {`{"status":"failed","error":{"code":"NOPE","message":"no"}}`, true},
		"a field of its own":        {`{"status":"succeeded","outputs":{},"took":3}`, false},
		"error details":             {`{"status":"failed","error":{"code":"NOPE","message":"no","details":{}}}`, false},
		"failed without an error":   {`{"status":"failed"}`, false},
		"succeeded with an error":   {`{"status":"succeeded","error":{"code":"A","message":"b"}}`, false},
		"an empty code":             {`{"status":"failed","error":{"code":"","message":"b"}}`, false},
		"another status":            {`{"status":"done"}`, false},
		"something after it":        {`{"status":"succeeded"} {}`, false},
		"the cluster's own code":    {`{"status":"failed","error":{"code":"IMAGE_NOT_ALLOWED","message":"no"}}`, false},
		"over 4 KB":                 {`{"status":"succeeded","outputs":{"x":"` + strings.Repeat("a", 4100) + `"}}`, false},
	} {
		if got := resultProblem([]byte(c.result)) == ""; got != c.ok {
			t.Errorf("%s: accepted %v, want %v (%s)", name, got, c.ok, resultProblem([]byte(c.result)))
		}
	}
}

func TestTheFinalStageMustRunAsANumericNonRootUser(t *testing.T) {
	for name, c := range map[string]struct {
		dockerfile string
		ok         bool
	}{
		"numeric":              {"FROM a@sha256:1\nUSER 65532:65532\n", true},
		"uid only":             {"FROM a@sha256:1\nUSER 1000\n", true},
		"a name":               {"FROM a@sha256:1\nUSER app\n", false},
		"root":                 {"FROM a@sha256:1\nUSER 0\n", false},
		"none":                 {"FROM a@sha256:1\nRUN true\n", false},
		"set in another stage": {"FROM a@sha256:1 AS build\nUSER 1000\nFROM b@sha256:2\nCOPY --from=build /x /x\n", false},
		"the last one counts":  {"FROM a@sha256:1\nUSER 1000\nRUN true\nUSER app\n", false},
	} {
		path := filepath.Join(t.TempDir(), "Dockerfile")
		if err := os.WriteFile(path, []byte(c.dockerfile), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := len(userProblems(path)) == 0; got != c.ok {
			t.Errorf("%s: accepted %v, want %v (%v)", name, got, c.ok, userProblems(path))
		}
	}
}
