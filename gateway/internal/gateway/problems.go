// SPDX-License-Identifier: MIT

package gateway

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"

	"github.com/pb33f/jsonschema/v6"
	"github.com/pb33f/jsonschema/v6/kind"
	verrors "github.com/pb33f/libopenapi-validator/errors"
)

// describe is what was wrong, one line each, for the caller: the field and
// the rule it broke, from the spec, never the values sent (the validator's
// own reasons quote them).
func describe(problems []*verrors.ValidationError) []string {
	var out []string
	seen := map[*jsonschema.ValidationError]bool{}
	for _, p := range problems {
		before := len(out)
		for _, s := range p.SchemaValidationErrors {
			root := s.OriginalJsonSchemaError
			switch {
			case root == nil:
				// No detail to read: the rule, from where it is in the schema.
				line := fieldName(p, strings.Split(strings.TrimPrefix(s.FieldPath, "$."), ".")) + ": breaks its schema"
				if keyword := s.KeywordLocation[strings.LastIndex(s.KeywordLocation, "/")+1:]; keyword != "" {
					line += "'s " + keyword
				}
				out = append(out, line)
			case !seen[root]:
				seen[root] = true
				out = appendLeaves(out, p, root)
			}
		}
		if len(out) == before {
			out = append(out, unschematic(p))
		}
	}
	return out
}

// unschematic is a line for what no schema's rule says (a missing
// parameter, a body that isn't JSON), fixed here: the validator's messages
// quote the request's path, and so its path parameters' values.
func unschematic(p *verrors.ValidationError) string {
	if p.ValidationType == verrors.StrictValidationType && p.ValidationSubType == verrors.StrictSubTypeQuery {
		return p.ParameterName + ": not a query parameter its OpenAPI document takes"
	}
	if p.ParameterName != "" {
		if strings.Contains(p.Message, "missing") {
			return p.ParameterName + ": required"
		}
		return p.ParameterName + ": doesn't fit its schema"
	}
	if p.ValidationType == "requestBody" {
		switch {
		case strings.Contains(p.Message, "is empty"):
			return "the body: required"
		case strings.Contains(p.Message, "not declared"):
			return "the body: this operation takes none"
		case strings.Contains(p.Message, "no registered decoder"):
			return "the body: its Content-Type isn't one the gateway can check"
		}
		return "the body: can't be read as its Content-Type says"
	}
	return "the request: doesn't fit its OpenAPI document (" + p.ValidationType + ")"
}

func appendLeaves(out []string, p *verrors.ValidationError, e *jsonschema.ValidationError) []string {
	if _, ok := e.ErrorKind.(*kind.PropertyNames); ok {
		// Its causes are about the name, at no field of its own.
		return append(out, fieldName(p, e.InstanceLocation)+": a property's name breaks its propertyNames")
	}
	if len(e.Causes) > 0 {
		for _, c := range e.Causes {
			out = appendLeaves(out, p, c)
		}
		return out
	}
	// Named properties get a line each: the schema's names, or (not
	// allowed) the caller's own field names, never their values.
	named, says := []string(nil), ""
	switch k := e.ErrorKind.(type) {
	case *kind.Required:
		named, says = k.Missing, "required"
	case *kind.AdditionalProperties:
		named, says = k.Properties, "not in its schema"
	default:
		return append(out, fieldName(p, e.InstanceLocation)+": "+rule(e.ErrorKind))
	}
	for _, name := range named {
		out = append(out, fieldName(p, append(e.InstanceLocation[:len(e.InstanceLocation):len(e.InstanceLocation)], name))+": "+says)
	}
	return out
}

// fieldName is where in the request: a parameter by its name, a body's
// field by its path (lines[0].qty), or the body itself.
func fieldName(p *verrors.ValidationError, at []string) string {
	var b strings.Builder
	if p.ParameterName != "" {
		b.WriteString(p.ParameterName)
	}
	for _, part := range at {
		if part == "" {
			continue
		}
		if strings.Trim(part, "0123456789") == "" {
			b.WriteString("[" + part + "]")
			continue
		}
		if b.Len() > 0 {
			b.WriteString(".")
		}
		b.WriteString(part)
	}
	if b.Len() == 0 {
		return "the body"
	}
	return b.String()
}

// rule is what the schema wants, from its own side of the error only (Want,
// never Got).
func rule(k jsonschema.ErrorKind) string {
	switch k := k.(type) {
	case *kind.Type:
		return "must be " + strings.Join(k.Want, " or ")
	case *kind.Enum:
		return "must be one of " + jsonOf(k.Want)
	case *kind.Const:
		return "must be " + jsonOf(k.Want)
	case *kind.Format:
		return "must be a " + k.Want
	case *kind.Pattern:
		return "must match " + k.Want
	case *kind.MinLength:
		return fmt.Sprintf("minLength %d", k.Want)
	case *kind.MaxLength:
		return fmt.Sprintf("maxLength %d", k.Want)
	case *kind.Minimum:
		return "minimum " + number(k.Want)
	case *kind.Maximum:
		return "maximum " + number(k.Want)
	case *kind.ExclusiveMinimum:
		return "exclusiveMinimum " + number(k.Want)
	case *kind.ExclusiveMaximum:
		return "exclusiveMaximum " + number(k.Want)
	case *kind.MultipleOf:
		return "multipleOf " + number(k.Want)
	case *kind.MinItems:
		return fmt.Sprintf("minItems %d", k.Want)
	case *kind.MaxItems:
		return fmt.Sprintf("maxItems %d", k.Want)
	case *kind.MinProperties:
		return fmt.Sprintf("minProperties %d", k.Want)
	case *kind.MaxProperties:
		return fmt.Sprintf("maxProperties %d", k.Want)
	case *kind.UniqueItems:
		return "uniqueItems: its items must differ"
	case *kind.Not:
		return "mustn't match its not schema"
	case *kind.FalseSchema:
		return "not allowed"
	}
	if path := k.KeywordPath(); len(path) > 0 {
		return "breaks its schema's " + strings.Join(path, "/")
	}
	return "breaks its schema"
}

func number(r *big.Rat) string {
	if r == nil {
		return "?"
	}
	if r.IsInt() {
		return r.Num().String()
	}
	return r.FloatString(6)
}

func jsonOf(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "?"
	}
	return string(b)
}
