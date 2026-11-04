// SPDX-License-Identifier: MIT

package domain

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// Schema is a product's input or output schema (JSON Schema, draft 2020-12
// unless it says otherwise), as the console attaches it to a task: the
// kernel checks values against it without knowing what the product does.
// It never fetches anything: a schema may only refer within itself.
type Schema struct{ compiled *jsonschema.Schema }

// noFetching refuses every reference outside the schema itself.
type noFetching struct{}

func (noFetching) Load(url string) (any, error) {
	return nil, fmt.Errorf("a task's schema may only refer within itself, not to %s", url)
}

const schemaURL = "task:///schema.json"

// printer words schema problems as vennir catalog does.
var printer = message.NewPrinter(language.English)

// CompileSchema reads a schema, or says why it isn't one.
func CompileSchema(doc map[string]any) (*Schema, error) {
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.UseLoader(noFetching{})
	if err := c.AddResource(schemaURL, doc); err != nil {
		return nil, err
	}
	compiled, err := c.Compile(schemaURL)
	if err != nil {
		return nil, err
	}
	return &Schema{compiled}, nil
}

// Problems are what the schema refuses in v ("where: what", sorted); none
// when it fits.
func (s *Schema) Problems(v any) []string {
	err := s.compiled.Validate(v)
	if err == nil {
		return nil
	}
	var invalid *jsonschema.ValidationError
	if !errors.As(err, &invalid) {
		return []string{err.Error()}
	}
	var out []string
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) == 0 {
			where := strings.Join(e.InstanceLocation, ".")
			if where == "" {
				where = "(top level)"
			}
			out = append(out, where+": "+e.ErrorKind.LocalizedString(printer))
		}
		for _, cause := range e.Causes {
			walk(cause)
		}
	}
	walk(invalid)
	sort.Strings(out)
	return out
}
