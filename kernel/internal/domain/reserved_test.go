// SPDX-License-Identifier: MIT

package domain

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// Every failure code the kernel sets, and every code the chart's admission
// policies start their messages with, is reserved: a step that could
// report one would pass for the platform. Read from the source, so a new
// code can't be added without reserving it.
func TestEveryCodeThePlatformSetsIsReserved(t *testing.T) {
	set := map[string]string{}
	failure := regexp.MustCompile(`(?:StructuredError|DispatchRejected)\{\s*Code:\s*"([A-Z][A-Z0-9_]+)"`)
	err := filepath.WalkDir("..", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") ||
			strings.Contains(path, string(filepath.Separator)+"gen"+string(filepath.Separator)) ||
			strings.Contains(path, "executortest") {
			return err
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range failure.FindAllStringSubmatch(string(source), -1) {
			set[m[1]] = path
		}
		// The executor's list of the chart's policy codes.
		if list := regexp.MustCompile(`policyCodes = \[\]string\{([^}]*)\}`).FindStringSubmatch(string(source)); list != nil {
			for _, m := range regexp.MustCompile(`"([A-Z_]+)"`).FindAllStringSubmatch(list[1], -1) {
				set[m[1]] = path
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	policies, err := filepath.Glob("../../../helm/charts/execution-kernel/templates/*.yaml")
	if err != nil || len(policies) == 0 {
		t.Fatalf("the kernel chart's templates: %v", err)
	}
	refusal := regexp.MustCompile(`"([A-Z][A-Z0-9_]+): `)
	for _, path := range policies {
		source, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range refusal.FindAllStringSubmatch(string(source), -1) {
			set[m[1]] = path
		}
	}
	for _, code := range []string{"TASK_TIMEOUT", "IMAGE_NOT_SIGNED", "STEP_JOB_NOT_ALLOWED"} {
		if set[code] == "" {
			t.Fatalf("%s wasn't found: the source scan is broken", code)
		}
	}
	for code, path := range set {
		if !slices.Contains(ReservedCodes, code) {
			t.Errorf("%s (%s) isn't in ReservedCodes", code, path)
		}
	}
	for _, code := range RefusalCodes {
		if !slices.Contains(ReservedCodes, code) {
			t.Errorf("refusal %s isn't in ReservedCodes", code)
		}
	}
}
