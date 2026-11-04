// slug's "transform" action: the text as a URL slug, such as
// "Hello, Vennir World!" -> "hello-vennir-world". Letters in any script
// are kept; everything else becomes a single dash.
//
// The binary is the image's entrypoint: the platform passes the action as
// its first argument. It reads /platform/input/request.json and writes
// /platform/output/result.json:
// {"status": "succeeded", "outputs": {...}} or
// {"status": "failed", "error": {"code", "message", "retryable"}}.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	inputPath  = "/platform/input/request.json"
	outputPath = "/platform/output/result.json"
	// result.json is limited to 4 KB, and the output carries the text back.
	maxLength = 1000
)

type failure struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type result struct {
	Status  string            `json:"status"`
	Outputs map[string]string `json:"outputs,omitempty"`
	Error   *failure          `json:"error,omitempty"`
}

func writeResult(r result) {
	data, _ := json.Marshal(r)
	if err := os.WriteFile(outputPath, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "can't write result.json:", err)
	}
}

func fail(code, message string) int {
	writeResult(result{Status: "failed", Error: &failure{Code: code, Message: message}})
	return 1
}

func slugify(text string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(text) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.TrimSuffix(b.String(), "-")
}

func run(args []string) int {
	if len(args) < 1 || args[0] != "transform" {
		action := ""
		if len(args) > 0 {
			action = args[0]
		}
		return fail("UNSUPPORTED_ACTION", fmt.Sprintf("no action %q: this product has transform", action))
	}

	data, err := os.ReadFile(inputPath)
	if err != nil {
		return fail("MISSING_INPUT", "can't read request.json: "+err.Error())
	}
	var request struct {
		Inputs map[string]any `json:"inputs"`
	}
	if err := json.Unmarshal(data, &request); err != nil {
		return fail("INVALID_INPUT", "request.json isn't valid JSON: "+err.Error())
	}
	text, ok := request.Inputs["text"].(string)
	if !ok || strings.TrimSpace(text) == "" {
		return fail("MISSING_INPUT", "inputs.text is required: the text to change.")
	}
	// Counted in code points, the way the other language samples count.
	if n := utf8.RuneCountInString(text); n > maxLength {
		return fail("TEXT_TOO_LONG", fmt.Sprintf("inputs.text is %d characters; the limit is %d.", n, maxLength))
	}
	slug := slugify(text)
	if slug == "" {
		return fail("NOTHING_TO_SLUG", "inputs.text has no letters or digits to make a slug from.")
	}

	// A JSON line with level info: what everyone who can see the run sees.
	// Anything else (debug, warn, error, plain) only this team sees.
	fmt.Printf("{\"level\":\"info\",\"msg\":\"slugged %d characters\"}\n", utf8.RuneCountInString(text))
	writeResult(result{Status: "succeeded", Outputs: map[string]string{"text": slug, "language": "Go"}})
	return 0
}

func main() {
	os.Exit(run(os.Args[1:]))
}
