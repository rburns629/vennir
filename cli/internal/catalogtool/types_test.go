// SPDX-License-Identifier: MIT

package catalogtool

import (
	"strings"
	"testing"
)

// typedProduct is a product of team whose run action needs `needs` and
// provides `provides` (wiring types; "" for none).
func typedProduct(team, name, needs, provides string) string {
	hint := func(key, wiring string) string {
		if wiring == "" {
			return ""
		}
		return ", " + key + ": " + wiring
	}
	return `apiVersion: vennir.dev/v2
kind: Product
name: ` + name + `
team: ` + team + `
displayName: X
description: X
owner: x
actions:
  - name: run
    input:
      type: object
      properties:
        project: {type: string` + hint("x-vennir-needs", needs) + `}
    output:
      type: object
      properties:
        id: {type: string` + hint("x-vennir-provides", provides) + `}
`
}

const cloudTypes = `apiVersion: vennir.dev/v2
kind: WiringTypes
types:
  - name: cloud.project
    jsonType: string
    description: A project's id.
    defaultProvider: project.run
  - name: cloud.region
    jsonType: string
    description: A region.
    shared: true
`

// Each team defines the types it's the authority on; any team's products
// use them; a default provider must be the team's own and provide its type.
func TestWiringTypesAreDefinedOnceAndUsedAsDefined(t *testing.T) {
	c := catalogWith(t, map[string]string{
		"teams/cloud/types.yaml":                    cloudTypes,
		"teams/cloud/products/project/product.yaml": typedProduct("cloud", "project", "", "cloud.project"),
		"teams/web/products/hosting/product.yaml":   typedProduct("web", "hosting", "cloud.project", ""),
	})
	types, problems := c.LoadWiringTypes()
	if len(problems) > 0 {
		t.Fatalf("problems: %v", problems)
	}
	if len(types) != 2 || types[0] != (WiringType{Name: "cloud.project", Team: "cloud", JSONType: "string", Description: "A project's id.", DefaultProvider: "cloud/project.run"}) || !types[1].Shared {
		t.Errorf("types = %+v", types)
	}
	release, err := c.releaseWiringTypes()
	if err != nil || len(release.GetTypes()) != 2 || release.GetTypes()[0].GetDefaultProvider() != "cloud/project.run" || release.GetTypes()[0].GetTeam() != "cloud" {
		t.Errorf("release = %v, %v", release, err)
	}

	// No team defines any: nothing is checked, and the release carries none.
	c = catalogWith(t, map[string]string{"teams/web/products/hosting/product.yaml": typedProduct("web", "hosting", "cloud.project", "")})
	if release, err := c.releaseWiringTypes(); release != nil || err != nil {
		t.Errorf("no types.yaml: %v, %v", release, err)
	}

	c = catalogWith(t, map[string]string{
		"teams/cloud/types.yaml": cloudTypes,
		// Its default provider doesn't provide it.
		"teams/cloud/products/project/product.yaml": typedProduct("cloud", "project", "", ""),
		// Defined twice; and a product naming a type nobody defines.
		"teams/web/types.yaml":                    strings.Replace(cloudTypes, "    defaultProvider: project.run\n", "", 1),
		"teams/web/products/hosting/product.yaml": typedProduct("web", "hosting", "cloud.network", ""),
	})
	out := errorsOf(t, (*Catalog).ValidateWiringTypes, c)
	for _, want := range []string{
		"teams/web/types.yaml: cloud.project is defined by team cloud already",
		"teams/cloud/types.yaml: cloud.project's defaultProvider project.run isn't one of this team's actions with an output that provides it",
		"teams/web/products/hosting/product.yaml: action run's input project: x-vennir-needs cloud.network isn't defined in any team's types.yaml",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("no %q in:\n%s", want, out)
		}
	}
	if _, err := c.releaseWiringTypes(); err == nil {
		t.Error("a release with invalid types was made")
	}

	c = catalogWith(t, map[string]string{
		"teams/cloud/types.yaml":                    "apiVersion: vennir.dev/v2\nkind: WiringTypes\ntypes:\n  - {name: Cloud, jsonType: text, description: x}\n",
		"teams/cloud/products/project/product.yaml": typedProduct("cloud", "project", "", ""),
	})
	if out := errorsOf(t, (*Catalog).ValidateWiringTypes, c); !strings.Contains(out, "types.0") {
		t.Errorf("a malformed types.yaml: %s", out)
	}
}
