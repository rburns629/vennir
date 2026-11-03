// SPDX-License-Identifier: MIT

package catalogtool

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"gopkg.in/yaml.v3"
)

// The schemas a catalog's files are checked against (format v2). They're
// part of this binary, so a pull request can't loosen a check by editing its
// catalog's copy (tools/*.schema.json, there for editors; a test keeps the
// two the same).
//
//go:embed schemas/*.schema.json
var schemas embed.FS

var printer = message.NewPrinter(language.English)

// compile compiles a schema document (already JSON-shaped), against JSON
// Schema 2020-12 unless it says otherwise. A schema that isn't valid JSON
// Schema is refused. Only references within the document resolve: no
// loader, so a pull request's schema can't make the check read a file
// (file:///...) or a URL on the machine running it, and a reference the
// console's validator couldn't follow either is refused here too.
func compile(url string, doc any) (*jsonschema.Schema, error) {
	c := jsonschema.NewCompiler()
	c.UseLoader(jsonschema.SchemeURLLoader{})
	c.DefaultDraft(jsonschema.Draft2020)
	if err := c.AddResource(url, doc); err != nil {
		return nil, err
	}
	return c.Compile(url)
}

func embeddedSchema(name string) *jsonschema.Schema {
	data, err := schemas.ReadFile("schemas/" + name)
	if err != nil {
		panic(err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		panic(fmt.Sprintf("%s: %v", name, err))
	}
	s, err := compile("embedded:///"+name, doc)
	if err != nil {
		panic(fmt.Sprintf("%s: %v", name, err))
	}
	return s
}

// schemaErrors are what s refuses in v, one "where: what" each.
func schemaErrors(s *jsonschema.Schema, v any) []string {
	err := s.Validate(v)
	if err == nil {
		return nil
	}
	var ve *jsonschema.ValidationError
	if !errors.As(err, &ve) {
		return []string{err.Error()}
	}
	return leaves(ve)
}

// leaves are a validation error's innermost causes, one "where: what" each.
func leaves(ve *jsonschema.ValidationError) []string {
	var found []string
	var walk func(*jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) == 0 {
			where := strings.Join(e.InstanceLocation, ".")
			if where == "" {
				where = "(top level)"
			}
			found = append(found, where+": "+e.ErrorKind.LocalizedString(printer))
			return
		}
		for _, cause := range e.Causes {
			walk(cause)
		}
	}
	walk(ve)
	return found
}

// schemaProblem is why a schema document isn't a valid schema, or "".
func schemaProblem(doc any) string {
	if _, err := compile("embedded:///action.json", doc); err != nil {
		var ve *jsonschema.ValidationError
		if errors.As(err, &ve) {
			return strings.Join(leaves(ve), "; ")
		}
		return err.Error()
	}
	return ""
}

// jsonShaped turns decoded YAML or JSON into what a schema validates:
// objects, arrays, strings, booleans, nil and json.Number.
func jsonShaped(v any) (any, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return jsonschema.UnmarshalJSON(bytes.NewReader(data))
}

// loadYAML reads one YAML document as JSON-shaped data.
func loadYAML(data []byte) (any, string) {
	var v any
	if err := yaml.Unmarshal(data, &v); err != nil {
		return nil, "not valid YAML: " + err.Error()
	}
	shaped, err := jsonShaped(v)
	if err != nil {
		return nil, "not representable as JSON: " + err.Error()
	}
	return shaped, ""
}

// loadYAMLDocuments reads every document of a YAML stream, skipping empty ones.
func loadYAMLDocuments(data []byte) ([]any, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var docs []any
	for {
		var v any
		err := decoder.Decode(&v)
		if errors.Is(err, io.EOF) {
			return docs, nil
		}
		if err != nil {
			return nil, err
		}
		if v == nil {
			continue
		}
		shaped, err := jsonShaped(v)
		if err != nil {
			return nil, err
		}
		docs = append(docs, shaped)
	}
}

// loadJSON reads JSON as JSON-shaped data (numbers kept exact).
func loadJSON(data []byte) (any, error) {
	return jsonschema.UnmarshalJSON(bytes.NewReader(data))
}
