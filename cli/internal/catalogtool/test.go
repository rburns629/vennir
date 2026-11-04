// SPDX-License-Identifier: MIT

package catalogtool

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"
)

// contractTestTimeout bounds one test case's container.
const contractTestTimeout = 300 * time.Second

// contractCase is tests/<action>/<case>/: request.json and expected.json.
type contractCase struct{ dir string }

func (t contractCase) action() string { return filepath.Base(filepath.Dir(t.dir)) }
func (t contractCase) label() string  { return "tests/" + t.action() + "/" + filepath.Base(t.dir) }

func contractCases(p *Product) []contractCase {
	matches, _ := filepath.Glob(filepath.Join(p.Dir, "tests", "*", "*"))
	var cases []contractCase
	for _, m := range matches {
		if isDir(m) {
			cases = append(cases, contractCase{m})
		}
	}
	return cases
}

// pythonTests are older products' tests: Python files run inside the
// product's own image, which must have python3.
func pythonTests(p *Product) []string {
	matches, _ := filepath.Glob(filepath.Join(p.Dir, "actions", "test_*.py"))
	return matches
}

// containsAll says whether actual has everything expected has: objects may
// carry more keys (an error's message, say); everything else must be equal.
func containsAll(actual, expected any) bool {
	if e, ok := expected.(map[string]any); ok {
		a, ok := actual.(map[string]any)
		if !ok {
			return false
		}
		for k, v := range e {
			av, present := a[k]
			if !present || !containsAll(av, v) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(actual, expected)
}

// runContractCase runs one case the way the kernel runs a step:
// request.json mounted at /platform/input, the action as the container's
// argument, result.json read back from /platform/output, and the case's
// secrets/<name>/<key> files, if any, at /platform/secrets. Hardened as a
// step's Pod is (kernel/internal/executor/kubernetes.go): a read-only root
// filesystem with a writable /tmp, no capabilities, no privilege
// escalation; and result.json is held to the 4 KB and the strict reading
// the kernel applies. No network: a test must not depend on (or change)
// anything outside the container.
func (c *Catalog) runContractCase(p *Product, tc contractCase, action map[string]any) []string {
	read := func(name string) (any, error) {
		data, err := os.ReadFile(filepath.Join(tc.dir, name))
		if err != nil {
			return nil, err
		}
		return loadJSON(data)
	}
	request, err := read("request.json")
	if err != nil {
		return []string{err.Error()}
	}
	expected, err := read("expected.json")
	if err != nil {
		return []string{err.Error()}
	}
	full := map[string]any{
		"executionId": "contract-test",
		"taskId":      filepath.Base(tc.dir),
		"team":        p.Team(),
		"forTeam":     p.Team(),
		"action":      tc.action(),
		"attempt":     json.Number("1"),
		"inputs":      map[string]any{},
	}
	if r, ok := request.(map[string]any); ok {
		for k, v := range r {
			full[k] = v
		}
	}

	work, cleanup, err := tempDir("vennir-test-")
	if err != nil {
		return []string{err.Error()}
	}
	defer cleanup()
	input, output := filepath.Join(work, "input"), filepath.Join(work, "output")
	for _, d := range []string{input, output} {
		if err := os.Mkdir(d, 0o755); err != nil {
			return []string{err.Error()}
		}
	}
	data, _ := json.Marshal(full)
	if err := os.WriteFile(filepath.Join(input, "request.json"), data, 0o644); err != nil {
		return []string{err.Error()}
	}
	// The image's own user (often non-root) writes the result.
	_ = os.Chmod(work, 0o755)
	_ = os.Chmod(output, 0o777)
	mounts := []string{"-v", input + ":/platform/input:ro", "-v", output + ":/platform/output"}
	secrets := filepath.Join(tc.dir, "secrets")
	if isDir(secrets) {
		abs, _ := filepath.Abs(secrets)
		mounts = append(mounts, "-v", abs+":/platform/secrets:ro")
	}
	binary, err := c.dockerBinary()
	if err != nil {
		return []string{err.Error()}
	}
	hardened := []string{"--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"}
	args := append(append(append([]string{"run", "--rm", "--network", "none"}, hardened...), mounts...), p.LocalImage(), tc.action())
	run, err := c.run(contractTestTimeout, true, binary, args...)
	if err != nil {
		return []string{err.Error()}
	}
	if run.timedOut {
		return []string{fmt.Sprintf("timed out after %ds", int(contractTestTimeout.Seconds()))}
	}
	raw, err := os.ReadFile(filepath.Join(output, "result.json"))
	if err != nil {
		return []string{fmt.Sprintf("wrote no /platform/output/result.json (exit %d): %s", run.code, lastChars(strings.TrimSpace(run.stderr), 500))}
	}
	result, err := loadJSON(raw)
	if err != nil {
		return []string{fmt.Sprintf("result.json isn't valid JSON: %v", err)}
	}
	if problem := resultProblem(raw); problem != "" {
		return []string{problem}
	}

	var problems []string
	resultText, _ := json.Marshal(result)
	// A step's result is readable by anyone who can read the execution, so
	// it must never carry a secret it was given.
	if isDir(secrets) {
		var files []string
		_ = filepath.WalkDir(secrets, func(path string, d fs.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				files = append(files, path)
			}
			return nil
		})
		sort.Strings(files)
		for _, f := range files {
			value, _ := os.ReadFile(f)
			v := strings.TrimSpace(string(value))
			if v != "" && strings.Contains(string(resultText), v) {
				rel, _ := filepath.Rel(secrets, f)
				problems = append(problems, "result.json contains the value of secrets/"+filepath.ToSlash(rel))
			}
		}
	}
	if !containsAll(result, expected) {
		expectedText, _ := json.Marshal(expected)
		problems = append(problems, fmt.Sprintf("result.json %s doesn't contain expected.json %s", resultText, expectedText))
	}
	resultMap, _ := result.(map[string]any)
	if resultMap["status"] == "succeeded" {
		// A success must also keep the action's declared contract both ways.
		outputs, ok := resultMap["outputs"]
		if !ok {
			outputs = map[string]any{}
		}
		for side, value := range map[string]any{"input": full["inputs"], "output": outputs} {
			schema, err := compile("embedded:///"+side+".json", action[side])
			if err != nil {
				problems = append(problems, fmt.Sprintf("its %s schema: %v", side, err))
				continue
			}
			for _, e := range schemaErrors(schema, value) {
				if side == "input" {
					problems = append(problems, "succeeded on inputs its input schema refuses: "+e)
				} else {
					problems = append(problems, "outputs don't match its output schema: "+e)
				}
			}
		}
	}
	return problems
}

// Test runs a product's contract tests, and any older Python tests.
func (c *Catalog) Test(p *Product) bool {
	ok := true
	actions := map[string]map[string]any{}
	for _, a := range p.Actions() {
		name, _ := a["name"].(string)
		actions[name] = a
	}
	for _, tc := range contractCases(p) {
		problems := c.runContractCase(p, tc, actions[tc.action()])
		c.info("  %s %s", passFail(len(problems) == 0), tc.label())
		for _, problem := range problems {
			c.errorAt(p.Dir, tc.label()+": "+problem)
		}
		ok = ok && len(problems) == 0
	}
	for _, file := range pythonTests(p) {
		binary, err := c.dockerBinary()
		if err != nil {
			c.errorAt(p.Dir, err.Error())
			return false
		}
		actionsDir, _ := filepath.Abs(filepath.Join(p.Dir, "actions"))
		run, err := c.run(0, false, binary, "run", "--rm", "--network", "none", "--entrypoint", "python3",
			"-v", actionsDir+":/app/actions:ro", p.LocalImage(), "/app/actions/"+filepath.Base(file))
		passed := err == nil && run.code == 0
		c.info("  %s actions/%s", passFail(passed), filepath.Base(file))
		if !passed {
			c.errorAt(p.Dir, fmt.Sprintf("actions/%s failed", filepath.Base(file)))
			ok = false
		}
	}
	return ok
}

func passFail(ok bool) string {
	if ok {
		return "ok  "
	}
	return "FAIL"
}
