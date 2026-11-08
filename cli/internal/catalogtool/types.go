// SPDX-License-Identifier: MIT

package catalogtool

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"

	catalogv1 "github.com/roburns/vennir/cli/internal/gen/vennir/catalog/v1"
)

// A catalog's wiring types (decision 25, docs/assessment.md): the kinds of
// thing its products make or name, such as gcp.project. Each team defines
// the ones it's the authority on in teams/<team>/types.yaml, with its
// default providers among its own actions; an input of any team says it
// needs one (x-vennir-needs), an output that it is one (x-vennir-provides).
// The console's order builder and chat agent wire carts by them, so once a
// catalog defines any, every type a product names must be defined.

var typesSchema = sync.OnceValue(func() *jsonschema.Schema { return embeddedSchema("types.schema.json") })

// WiringType is one type, as its team's types.yaml defines it.
type WiringType struct {
	Name        string
	Team        string
	JSONType    string
	Description string
	Shared      bool
	// DefaultProvider is <team>/<product>.<action>; "" for none.
	DefaultProvider string
}

// typeProblem is a problem in one file.
type typeProblem struct{ path, message string }

// LoadWiringTypes are every team's types, sorted by name, or what's wrong
// with them: a file, a type defined twice, a default provider that doesn't
// provide its type, or a product naming a type nobody defines.
func (c *Catalog) LoadWiringTypes() ([]WiringType, []typeProblem) {
	var types []WiringType
	var problems []typeProblem
	defined := map[string]string{}
	for _, team := range c.TeamNames() {
		path := c.path("teams", team, "types.yaml")
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			problems = append(problems, typeProblem{path, err.Error()})
			continue
		}
		doc, problem := loadYAML(data)
		if problem == "" {
			problem = formatProblem(doc, "WiringTypes")
		}
		if problem != "" {
			problems = append(problems, typeProblem{path, problem})
			continue
		}
		if found := schemaErrors(typesSchema(), doc); len(found) > 0 {
			for _, p := range found {
				problems = append(problems, typeProblem{path, p})
			}
			continue
		}
		spec, _ := doc.(map[string]any)
		list, _ := spec["types"].([]any)
		for _, raw := range list {
			m, _ := raw.(map[string]any)
			t := WiringType{Name: text(m, "name"), Team: team, JSONType: text(m, "jsonType"), Description: text(m, "description"), Shared: m["shared"] == true}
			if owner, twice := defined[t.Name]; twice {
				problems = append(problems, typeProblem{path, fmt.Sprintf("%s is defined by team %s already: a type has one team", t.Name, owner)})
				continue
			}
			defined[t.Name] = team
			if provider := text(m, "defaultProvider"); provider != "" {
				t.DefaultProvider = team + "/" + provider
			}
			types = append(types, t)
		}
	}
	if len(types) == 0 {
		return nil, problems
	}
	specs := c.productSpecs()
	for _, t := range types {
		if t.DefaultProvider == "" {
			continue
		}
		team, rest, _ := strings.Cut(t.DefaultProvider, "/")
		product, action, _ := strings.Cut(rest, ".")
		if !provides(specs[team+"/"+product], action, t.Name) {
			problems = append(problems, typeProblem{c.path("teams", team, "types.yaml"),
				fmt.Sprintf("%s's defaultProvider %s.%s isn't one of this team's actions with an output that provides it (x-vennir-provides: %s)", t.Name, product, action, t.Name)})
		}
	}
	byName := map[string]WiringType{}
	for _, t := range types {
		byName[t.Name] = t
	}
	labels := make([]string, 0, len(specs))
	for label := range specs {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	for _, label := range labels {
		team, product, _ := strings.Cut(label, "/")
		path := c.path("teams", team, "products", product, "product.yaml")
		for _, action := range actionsOf(specs[label]) {
			for _, side := range []struct{ schema, hint string }{{"input", "x-vennir-needs"}, {"output", "x-vennir-provides"}} {
				for _, field := range typedFields(action[side.schema], side.hint) {
					t, ok := byName[field.wiring]
					switch {
					case !ok:
						problems = append(problems, typeProblem{path, fmt.Sprintf("action %s's %s %s: %s %s isn't defined in any team's types.yaml", text(action, "name"), side.schema, field.name, side.hint, field.wiring)})
					case field.jsonType != "" && field.jsonType != t.JSONType:
						problems = append(problems, typeProblem{path, fmt.Sprintf("action %s's %s %s is a %s, but %s is a %s", text(action, "name"), side.schema, field.name, field.jsonType, t.Name, t.JSONType)})
					}
				}
			}
		}
	}
	sort.Slice(types, func(i, j int) bool { return types[i].Name < types[j].Name })
	return types, problems
}

// ValidateWiringTypes checks every team's types.yaml, and the types its
// products name.
func (c *Catalog) ValidateWiringTypes() bool {
	_, problems := c.LoadWiringTypes()
	for _, p := range problems {
		c.errorAt(p.path, p.message)
	}
	return len(problems) == 0
}

// releaseWiringTypes is the release's vocabulary: nil when no team defines
// any, so an install's own are left alone.
func (c *Catalog) releaseWiringTypes() (*catalogv1.WiringTypes, error) {
	types, problems := c.LoadWiringTypes()
	if len(problems) > 0 {
		return nil, errors.New("a types.yaml, or a type a product names, isn't valid (above)")
	}
	if len(types) == 0 {
		return nil, nil
	}
	out := &catalogv1.WiringTypes{}
	for _, t := range types {
		out.Types = append(out.Types, &catalogv1.WiringType{
			Name: t.Name, Team: t.Team, JsonType: t.JSONType, Description: t.Description, Shared: t.Shared, DefaultProvider: t.DefaultProvider,
		})
	}
	return out, nil
}

// productSpecs are every team's product.yaml that reads as YAML, by
// <team>/<product>. One that doesn't is ValidateProduct's to report.
func (c *Catalog) productSpecs() map[string]map[string]any {
	specs := map[string]map[string]any{}
	for _, path := range c.glob("teams/*/products/*/product.yaml") {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		doc, problem := loadYAML(data)
		spec, ok := doc.(map[string]any)
		if problem != "" || !ok {
			continue
		}
		dir := filepath.Dir(path)
		specs[filepath.Base(filepath.Dir(filepath.Dir(dir)))+"/"+filepath.Base(dir)] = spec
	}
	return specs
}

func actionsOf(spec map[string]any) []map[string]any {
	return (&Product{Spec: spec}).Actions()
}

// provides says whether spec's action has an output that provides type.
func provides(spec map[string]any, action, wiring string) bool {
	for _, a := range actionsOf(spec) {
		if text(a, "name") != action {
			continue
		}
		for _, field := range typedFields(a["output"], "x-vennir-provides") {
			if field.wiring == wiring {
				return true
			}
		}
	}
	return false
}

type typedField struct{ name, wiring, jsonType string }

// typedFields are a schema's top-level properties that carry hint.
func typedFields(schema any, hint string) []typedField {
	s, _ := schema.(map[string]any)
	properties, _ := s["properties"].(map[string]any)
	var out []typedField
	for name, raw := range properties {
		p, _ := raw.(map[string]any)
		if wiring := text(p, hint); wiring != "" {
			jsonType, _ := p["type"].(string)
			out = append(out, typedField{name, wiring, jsonType})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}
