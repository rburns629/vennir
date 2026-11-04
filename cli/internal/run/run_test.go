// SPDX-License-Identifier: MIT

package run

import "testing"

func TestErrorsNameTheCommandsWord(t *testing.T) {
	for want, args := range map[string][]string{
		"exec":    {"--context", "kind-dev", "--namespace", "vennir-system", "exec", "deploy/x", "--", "sh"},
		"list":    {"list", "--kube-context", "x"},
		"version": {"-o=json", "version"},
		"sql":     {"sql", "backups"},
		"":        nil,
	} {
		if got := firstArg(args); got != want {
			t.Errorf("%v: %q, want %q", args, got, want)
		}
	}
}
