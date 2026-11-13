// SPDX-License-Identifier: MIT

package catalogtool

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// A team folder is a team: each install's console makes its namespace when
// a release names it, and retires it when a release no longer does
// (release.go).

// What a team's secret-stores/*.yaml may hold (together, one team's
// SecretStores). Each install's console applies it from a release and
// enforces the same rules; this check tells the author on their pull
// request, and a release refuses a file that fails it.
var (
	esoServiceAccounts = []string{"eso-aws", "eso-azure", "eso-gcp"}
	secretStoreAPIs    = []string{"external-secrets.io/v1", "external-secrets.io/v1beta1"}
)

const credentialSecret = "eso-auth"

func orQuestion(v any) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return "?"
}

func pyRepr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case string:
		return quote(x)
	default:
		return fmt.Sprint(x)
	}
}

// specProblems is what a store's spec may not name, wherever it names it
// (as the console's secretStores.ts): only the Secret the team stored its
// credential in (eso-auth), any Secret selector included (a key ending in
// secretRef, or any {name, key}: a bearer token, a client certificate, a CA
// from a Secret), and only ESO's ServiceAccounts (a key ending in
// serviceAccountRef, or serviceAccount). Nothing in another namespace
// (namespace, remoteNamespace), and not the kubernetes provider, which reads
// a cluster's Secrets, or the webhook provider, which reads any URL the
// External Secrets Operator can reach. Which other providers a store may
// use is each install's setting (the console's secretStores.providers),
// which this check can't know. A CA from a ConfigMap names no Secret.
func specProblems(node any, path string) []string {
	var problems []string
	switch n := node.(type) {
	case []any:
		for i, v := range n {
			problems = append(problems, specProblems(v, fmt.Sprintf("%s[%d]", path, i))...)
		}
	case map[string]any:
		named := func(v any) any {
			if m, ok := v.(map[string]any); ok {
				return m["name"]
			}
			return v
		}
		name, hasName := n["name"].(string)
		if _, hasKey := n["key"].(string); hasName && hasKey && name != credentialSecret {
			problems = append(problems, fmt.Sprintf("%s must name the Secret %s (where the team's BOOTSTRAP_CREDENTIAL is stored), not %s.",
				path, quote(credentialSecret), pyRepr(name)))
		}
		keys := make([]string, 0, len(n))
		for k := range n {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, key := range keys {
			value, child, lower := n[key], path+"."+key, strings.ToLower(key)
			ref, isMap := value.(map[string]any)
			// A CA from a ConfigMap names no Secret (only a caProvider says which).
			if key == "caProvider" && isMap && ref["type"] == "ConfigMap" {
				if _, present := ref["namespace"]; present {
					problems = append(problems, fmt.Sprintf("%s.namespace points into another namespace; leave it out.", child))
				}
				continue
			}
			_, refHasKey := ref["key"].(string)
			switch {
			case key == "namespace" || lower == "remotenamespace":
				problems = append(problems, fmt.Sprintf("%s points into another namespace; leave it out.", child))
			case path == "spec.provider" && key == "kubernetes":
				problems = append(problems, fmt.Sprintf("%s: the kubernetes provider reads a cluster's Secrets; use the team's own vault.", child))
			case path == "spec.provider" && key == "webhook":
				problems = append(problems, fmt.Sprintf("%s: the webhook provider reads any URL the External Secrets Operator can reach; use the team's own vault.", child))
			case strings.HasSuffix(lower, "secretref") && !(isMap && refHasKey):
				if named(value) != credentialSecret {
					problems = append(problems, fmt.Sprintf("%s must name the Secret %s (where the team's BOOTSTRAP_CREDENTIAL is stored), not %s.",
						child, quote(credentialSecret), pyRepr(named(value))))
				}
			case (strings.HasSuffix(lower, "serviceaccountref") || key == "serviceAccount") && isMap:
				if sa, _ := ref["name"].(string); !contains(esoServiceAccounts, sa) {
					problems = append(problems, fmt.Sprintf("%s must name one of ESO's ServiceAccounts (%s), not %s.",
						child, strings.Join(esoServiceAccounts, ", "), pyRepr(ref["name"])))
				}
			}
			problems = append(problems, specProblems(value, child)...)
		}
	}
	return problems
}

// SecretStoreProblems checks a team's SecretStore documents.
func SecretStoreProblems(team string, documents []any) []string {
	var problems []string
	stores := 0
	for i, doc := range documents {
		where := fmt.Sprintf("document %d", i+1)
		m, ok := doc.(map[string]any)
		if !ok {
			problems = append(problems, where+": isn't a Kubernetes object.")
			continue
		}
		kind, api := m["kind"], m["apiVersion"]
		metadata, _ := m["metadata"].(map[string]any)
		name := metadata["name"]
		where = fmt.Sprintf("%s %s (%s)", orQuestion(kind), orQuestion(name), where)
		if ns, present := metadata["namespace"]; present && ns != nil && ns != team {
			problems = append(problems, fmt.Sprintf("%s: namespace must be %s (or left out), not %s.", where, quote(team), pyRepr(ns)))
		}
		switch {
		case kind == "ServiceAccount" && api == "v1":
			if n, _ := name.(string); !contains(esoServiceAccounts, n) {
				problems = append(problems, fmt.Sprintf("%s: the only ServiceAccounts allowed here are the ones ESO signs in as: %s.",
					where, strings.Join(esoServiceAccounts, ", ")))
			}
		case kind == "SecretStore" && contains(secretStoreAPIs, fmt.Sprint(api)):
			stores++
			spec := m["spec"]
			if spec == nil {
				spec = map[string]any{}
			}
			for _, problem := range specProblems(spec, "spec") {
				problems = append(problems, where+": "+problem)
			}
		default:
			problems = append(problems, fmt.Sprintf("%s: only SecretStore (%s) and ServiceAccount (v1) are allowed here.",
				where, strings.Join(secretStoreAPIs, " or ")))
		}
	}
	if stores == 0 {
		problems = append(problems, "No SecretStore in the file.")
	}
	return problems
}

// identityAnnotations bind an ESO ServiceAccount to a cloud identity.
var identityAnnotations = map[string]string{
	"iam.gke.io/gcp-service-account":    "gcp",
	"eks.amazonaws.com/role-arn":        "aws",
	"azure.workload.identity/client-id": "azure",
}

// SecretStoreIdentities are the cloud identities a team's stores sign in
// as, as the console reads them (console/src/secretStores.ts
// cloudIdentities): its ESO ServiceAccounts' bindings and the role or
// identity a store names, as <cloud>:<id>, lowercased.
func SecretStoreIdentities(documents []any) []string {
	found := map[string]bool{}
	add := func(cloud string, v any) {
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			found[cloud+":"+strings.ToLower(strings.TrimSpace(s))] = true
		}
	}
	for _, doc := range documents {
		m, _ := doc.(map[string]any)
		metadata, _ := m["metadata"].(map[string]any)
		annotations, _ := metadata["annotations"].(map[string]any)
		for key, value := range annotations {
			if cloud, ok := identityAnnotations[key]; ok {
				add(cloud, value)
			}
		}
		spec, _ := m["spec"].(map[string]any)
		provider, _ := spec["provider"].(map[string]any)
		if aws, ok := provider["aws"].(map[string]any); ok {
			add("aws", aws["role"])
		}
		if azure, ok := provider["azurekv"].(map[string]any); ok {
			add("azure", azure["identityId"])
		}
	}
	ids := make([]string, 0, len(found))
	for id := range found {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func without(list []string, s string) []string {
	var out []string
	for _, v := range list {
		if v != s {
			out = append(out, v)
		}
	}
	return out
}

func (c *Catalog) secretStoreFolder(team string) string {
	return c.path("teams", team, "secret-stores")
}

func (c *Catalog) secretStoreFiles(team string) []string {
	files, _ := filepath.Glob(filepath.Join(c.secretStoreFolder(team), "*.yaml"))
	return files
}

// SecretStoreTeams are the teams with SecretStore files.
func (c *Catalog) SecretStoreTeams() []string {
	var teams []string
	for _, t := range c.TeamNames() {
		if len(c.secretStoreFiles(t)) > 0 {
			teams = append(teams, t)
		}
	}
	return teams
}

func (c *Catalog) secretStoreDocuments(team string) ([]any, []string) {
	files := c.secretStoreFiles(team)
	if len(files) == 0 {
		return nil, []string{fmt.Sprintf("no teams/%s/secret-stores/*.yaml", team)}
	}
	var documents []any
	for _, path := range files {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, []string{err.Error()}
		}
		docs, err := loadYAMLDocuments(data)
		if err != nil {
			return nil, []string{fmt.Sprintf("%s: not valid YAML: %v", filepath.Base(path), err)}
		}
		documents = append(documents, docs...)
	}
	return documents, nil
}

// SecretStoresCheck checks each team's SecretStore files.
func (c *Catalog) SecretStoresCheck(teams []string) bool {
	// Each cloud identity a store signs in as is one team's alone (the
	// console refuses a second, IDENTITY_IN_USE): who holds which, across
	// every team here, not only the ones checked.
	holders := map[string][]string{}
	for _, team := range c.SecretStoreTeams() {
		if documents, problems := c.secretStoreDocuments(team); len(problems) == 0 {
			for _, id := range SecretStoreIdentities(documents) {
				holders[id] = append(holders[id], team)
			}
		}
	}
	ok := true
	for _, team := range teams {
		documents, problems := c.secretStoreDocuments(team)
		if len(problems) == 0 {
			problems = SecretStoreProblems(team, documents)
		}
		for _, id := range SecretStoreIdentities(documents) {
			if others := without(holders[id], team); len(others) > 0 {
				problems = append(problems, fmt.Sprintf("%s signs in as %s, as %s's store does: each team needs its own cloud identity.",
					team, id, strings.Join(others, " and ")))
			}
		}
		for _, p := range problems {
			c.errorAt(c.secretStoreFolder(team), p)
		}
		c.info("  %s teams/%s/secret-stores", passFail(len(problems) == 0), team)
		ok = ok && len(problems) == 0
	}
	return ok
}
