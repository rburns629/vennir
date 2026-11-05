// SPDX-License-Identifier: MIT

package catalogtool

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/pb33f/libopenapi"
	v3 "github.com/pb33f/libopenapi/datamodel/high/v3"

	catalogv1 "github.com/rburns629/vennir/cli/internal/gen/vennir/catalog/v1"
)

// An API product (teams/<team>/apis/<name>/api.yaml, kind: Api) publishes a
// backend the team already runs through the install's gateway. Its OpenAPI
// file is the allowlist: the gateway forwards a request only when its
// method and path are an operation there and it fits that operation's
// schemas (decision 20, docs/assessment.md).

// maxSpecBytes is the largest OpenAPI file an API may have.
const maxSpecBytes = 1 << 20

// reservedPrefix is the gateway's own, never a team's.
const reservedPrefix = "/.vennir/"

var methods = []string{"get", "put", "post", "delete", "options", "head", "patch", "trace"}

// API is one API product's folder.
type API struct {
	Dir  string
	Spec map[string]any
}

// Team is its team's folder name.
func (a *API) Team() string { return filepath.Base(filepath.Dir(filepath.Dir(a.Dir))) }

// Name is its folder's name.
func (a *API) Name() string { return filepath.Base(a.Dir) }

// AllAPIs are every team's API folders.
func (c *Catalog) AllAPIs() []*API {
	var apis []*API
	for _, path := range c.glob("teams/*/apis/*/api.yaml") {
		apis = append(apis, &API{Dir: filepath.Dir(path)})
	}
	return apis
}

// ValidateAPIs checks every API: api.yaml against its schema and its
// folder, and its OpenAPI file (openapiProblems).
func (c *Catalog) ValidateAPIs() bool {
	ok := true
	for _, a := range c.AllAPIs() {
		path := filepath.Join(a.Dir, "api.yaml")
		problems := c.apiProblems(a)
		for _, p := range problems {
			c.errorAt(path, p)
		}
		ok = ok && len(problems) == 0
	}
	return ok
}

func (c *Catalog) apiProblems(a *API) []string {
	data, err := os.ReadFile(filepath.Join(a.Dir, "api.yaml"))
	if err != nil {
		return []string{err.Error()}
	}
	doc, problem := loadYAML(data)
	if problem == "" {
		problem = formatProblem(doc, "Api")
	}
	if problem != "" {
		return []string{problem}
	}
	if problems := schemaErrors(apiSchema(), doc); len(problems) > 0 {
		return problems
	}
	a.Spec = doc.(map[string]any)
	var problems []string
	if name := text(a.Spec, "name"); name != a.Name() {
		problems = append(problems, fmt.Sprintf("name %s isn't its folder's, %s", quote(name), quote(a.Name())))
	}
	backend, _ := a.Spec["backend"].(map[string]any)
	backendURL := text(backend, "url")
	if u, err := url.Parse(backendURL); err == nil && u.Scheme == "http" && !inClusterService(u.Hostname()) {
		problems = append(problems, fmt.Sprintf("backend.url %s: https, or http only to a Service in the cluster (<service>.<namespace>.svc, alone or with .cluster.local; on a cluster with another domain, the short form)", backendURL))
	}
	auth, _ := backend["auth"].(map[string]any)
	if sat, ok := auth["serviceAccountToken"].(map[string]any); ok {
		if aud := text(sat, "audience"); reservedAPIAudience(aud) {
			problems = append(problems, fmt.Sprintf("backend.auth.serviceAccountToken.audience %s: the Kubernetes API's, or one a cloud federates (AWS, Azure, Google): a backend's token may never carry it", quote(aud)))
		}
	}
	specFile := filepath.Join(a.Dir, text(a.Spec, "spec"))
	specData, err := os.ReadFile(specFile)
	if err != nil {
		return append(problems, fmt.Sprintf("spec %s: no such file beside api.yaml", text(a.Spec, "spec")))
	}
	return append(problems, openapiProblems(specData, backendURL)...)
}

// reservedAPIAudience: a token for this audience would be good to the
// Kubernetes API, or could be exchanged for the API ServiceAccount's cloud
// identity (AWS's and Azure's federation audiences, a GKE Workload Identity
// pool or its STS audience, a GCP workload identity provider). As the
// gateway's credentials.CloudAudience and the console's
// apiTokenAudienceProblem, which also know the cluster's own.
func reservedAPIAudience(audience string) bool {
	a := strings.ToLower(audience)
	switch a {
	case "https://kubernetes.default.svc", "https://kubernetes.default.svc.cluster.local", "kubernetes.default.svc",
		"kubernetes.default.svc.cluster.local", "sts.amazonaws.com", "api://azureadtokenexchange":
		return true
	}
	return strings.HasSuffix(a, ".svc.id.goog") || strings.HasPrefix(a, "identitynamespace:") ||
		strings.HasPrefix(a, "//iam.googleapis.com/") || strings.HasPrefix(a, "https://iam.googleapis.com/")
}

// openapiProblems is what makes an OpenAPI file unusable as an allowlist:
// not OpenAPI 3.0 or 3.1, a reference outside the file, servers not
// including backendURL, a parameter or body with no schema, a path under
// the gateway's own prefix, or two paths that match the same requests.
func openapiProblems(data []byte, backendURL string) []string {
	if len(data) > maxSpecBytes {
		return []string{fmt.Sprintf("the spec is %d bytes; at most %d", len(data), maxSpecBytes)}
	}
	raw, problem := loadYAML(data)
	if problem != "" {
		return []string{"the spec: " + problem}
	}
	var problems []string
	for _, ref := range refs(raw) {
		if !strings.HasPrefix(ref, "#") {
			problems = append(problems, fmt.Sprintf("the spec refers outside itself ($ref %s): put it in components, so what's reviewed is all there is", quote(ref)))
		}
	}
	if len(problems) > 0 {
		return problems
	}
	doc, err := libopenapi.NewDocument(data)
	if err != nil {
		return []string{"the spec isn't OpenAPI: " + err.Error()}
	}
	if v := doc.GetVersion(); !strings.HasPrefix(v, "3.0.") && !strings.HasPrefix(v, "3.1.") {
		return []string{fmt.Sprintf("the spec is OpenAPI %s: 3.0 or 3.1", quote(v))}
	}
	model, err := doc.BuildV3Model()
	if err != nil {
		return []string{"the spec isn't valid OpenAPI: " + err.Error()}
	}
	m := model.Model
	if !serverListed(m.Servers, backendURL) {
		problems = append(problems, fmt.Sprintf("the spec's servers don't include backend.url (%s)", backendURL))
	}
	if m.Paths == nil || m.Paths.PathItems == nil || m.Paths.PathItems.Len() == 0 {
		return append(problems, "the spec has no paths: nothing could reach the backend")
	}
	shapes := map[string]string{}
	for path := range m.Paths.PathItems.KeysFromOldest() {
		if !strings.HasPrefix(path, "/") {
			problems = append(problems, fmt.Sprintf("path %s doesn't start with /", quote(path)))
			continue
		}
		if !pathChars.MatchString(path) {
			problems = append(problems, fmt.Sprintf("path %s has a character a path doesn't need: letters, digits, -._~/{}:@%%+,;=!* only", quote(path)))
			continue
		}
		if strings.HasPrefix(path+"/", reservedPrefix) {
			problems = append(problems, fmt.Sprintf("path %s is under %s, the gateway's own", quote(path), reservedPrefix))
		}
		shape := templateShape(path)
		if other, seen := shapes[shape]; seen {
			problems = append(problems, fmt.Sprintf("paths %s and %s match the same requests", quote(other), quote(path)))
		}
		shapes[shape] = path
	}
	return append(problems, schemaGaps(raw)...)
}

// schemaGaps: every parameter and every request body type has a schema, so
// the gateway can check what it forwards. Read from the document itself
// (internal $refs followed), one problem per gap.
func schemaGaps(raw any) []string {
	root, _ := raw.(map[string]any)
	paths, _ := root["paths"].(map[string]any)
	var problems []string
	names := make([]string, 0, len(paths))
	for path := range paths {
		names = append(names, path)
	}
	sort.Strings(names)
	for _, path := range names {
		item, _ := resolve(root, paths[path]).(map[string]any)
		shared, _ := item["parameters"].([]any)
		for _, method := range methods {
			op, ok := resolve(root, item[method]).(map[string]any)
			if !ok {
				continue
			}
			where := strings.ToUpper(method) + " " + path
			own, _ := op["parameters"].([]any)
			for _, p := range append(append([]any{}, shared...), own...) {
				param, _ := resolve(root, p).(map[string]any)
				if param["schema"] == nil && param["content"] == nil {
					problems = append(problems, fmt.Sprintf("%s: parameter %s has no schema", where, quote(fmt.Sprint(param["name"]))))
				}
			}
			body, _ := resolve(root, op["requestBody"]).(map[string]any)
			content, _ := body["content"].(map[string]any)
			for mediaType, entry := range content {
				if m, _ := resolve(root, entry).(map[string]any); m["schema"] == nil {
					problems = append(problems, fmt.Sprintf("%s: request body %s has no schema", where, mediaType))
				}
			}
		}
	}
	return problems
}

// resolve follows an internal $ref ("#/components/...") to what it names.
func resolve(root map[string]any, node any) any {
	for range 16 {
		m, ok := node.(map[string]any)
		ref, isRef := m["$ref"].(string)
		if !ok || !isRef || !strings.HasPrefix(ref, "#/") {
			return node
		}
		var cur any = root
		for _, part := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
			part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
			next, _ := cur.(map[string]any)
			cur = next[part]
		}
		node = cur
	}
	return node
}

// serverListed: one of servers is backendURL, ignoring a trailing slash.
func serverListed(servers []*v3.Server, backendURL string) bool {
	want := strings.TrimRight(backendURL, "/")
	for _, s := range servers {
		if s != nil && strings.TrimRight(s.URL, "/") == want {
			return true
		}
	}
	return false
}

var templateSegment = regexp.MustCompile(`\{[^}/]*\}`)

// What a path may be made of: a URL path's own characters and templates'
// braces, nothing a shell or a page would read as more than text (quotes,
// $, backticks, spaces, <>), since the console shows each path in a curl
// command people paste.
var pathChars = regexp.MustCompile(`^[A-Za-z0-9\-._~/{}:@%+,;=!*]+$`)

// templateShape is a path with every {parameter} alike, so /a/{x} and
// /a/{y} are seen to be the same path.
func templateShape(path string) string {
	return templateSegment.ReplaceAllString(strings.TrimRight(path, "/"), "{}")
}

// refs are every $ref value in a document.
func refs(node any) []string {
	var out []string
	switch v := node.(type) {
	case map[string]any:
		for k, child := range v {
			if s, ok := child.(string); ok && k == "$ref" {
				out = append(out, s)
				continue
			}
			out = append(out, refs(child)...)
		}
	case []any:
		for _, child := range v {
			out = append(out, refs(child)...)
		}
	}
	sort.Strings(out)
	return out
}

// releaseAPIs are every API, already checked by ValidateAPIs, as a release
// carries them: the OpenAPI document as JSON, limits as numbers.
func (c *Catalog) releaseAPIs() ([]*catalogv1.Api, error) {
	var out []*catalogv1.Api
	for _, a := range c.AllAPIs() {
		if problems := c.apiProblems(a); len(problems) > 0 {
			return nil, fmt.Errorf("%s: %s", c.rel(a.Dir), strings.Join(problems, "; "))
		}
		specData, err := os.ReadFile(filepath.Join(a.Dir, text(a.Spec, "spec")))
		if err != nil {
			return nil, err
		}
		raw, _ := loadYAML(specData)
		openapi, err := json.Marshal(raw)
		if err != nil {
			return nil, err
		}
		backend, _ := a.Spec["backend"].(map[string]any)
		api := &catalogv1.Api{
			Name:            a.Name(),
			Team:            a.Team(),
			DisplayName:     text(a.Spec, "displayName"),
			Description:     text(a.Spec, "description"),
			Openapi:         string(openapi),
			BackendUrl:      text(backend, "url"),
			BackendAuth:     backendAuth(backend),
			ServiceAccount:  or(text(a.Spec, "serviceAccount"), a.Name()+"-api"),
			ShareWith:       stringList(a.Spec["shareWith"]),
			Hidden:          text(a.Spec, "visibility") == "hidden",
			Deprecated:      text(a.Spec, "deprecated"),
			Internet:        text(a.Spec, "reachable") == "internet",
			PerMinute:       perMinute(a.Spec["limits"]),
			TimeoutSeconds:  30,
			MaxRequestBytes: 1 << 20,
			Path:            c.rel(filepath.Join(a.Dir, "api.yaml")),
		}
		if t := text(a.Spec, "timeout"); t != "" {
			n, _ := strconv.Atoi(strings.TrimSuffix(t, "s"))
			api.TimeoutSeconds = int32(n)
		}
		if size := text(a.Spec, "maxRequest"); size != "" {
			api.MaxRequestBytes = bytesOf(size)
		}
		out = append(out, api)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Team+"/"+out[i].Name < out[j].Team+"/"+out[j].Name })
	return out, nil
}

func backendAuth(backend map[string]any) *catalogv1.BackendAuth {
	auth, _ := backend["auth"].(map[string]any)
	switch {
	case auth["serviceAccountToken"] != nil:
		m, _ := auth["serviceAccountToken"].(map[string]any)
		return &catalogv1.BackendAuth{Kind: &catalogv1.BackendAuth_ServiceAccountToken{
			ServiceAccountToken: &catalogv1.ServiceAccountTokenAuth{Audience: text(m, "audience")}}}
	case auth["googleIdToken"] != nil:
		m, _ := auth["googleIdToken"].(map[string]any)
		return &catalogv1.BackendAuth{Kind: &catalogv1.BackendAuth_GoogleIdToken{
			GoogleIdToken: &catalogv1.GoogleIdTokenAuth{ServiceAccount: text(m, "serviceAccount"), Audience: or(text(m, "audience"), text(backend, "url"))}}}
	case auth["awsSigV4"] != nil:
		m, _ := auth["awsSigV4"].(map[string]any)
		return &catalogv1.BackendAuth{Kind: &catalogv1.BackendAuth_AwsSigV4{
			AwsSigV4: &catalogv1.AwsSigV4Auth{RoleArn: text(m, "roleArn"), Region: text(m, "region"), Service: text(m, "service")}}}
	}
	return nil
}

// perMinute turns limits ("600/min", "10/s") into requests a minute.
func perMinute(v any) map[string]int32 {
	limits, _ := v.(map[string]any)
	if len(limits) == 0 {
		return nil
	}
	out := map[string]int32{}
	for team, raw := range limits {
		n, unit, _ := strings.Cut(fmt.Sprint(raw), "/")
		count, _ := strconv.Atoi(n)
		if unit == "s" {
			count *= 60
		}
		out[team] = int32(count)
	}
	return out
}

// bytesOf turns "512KiB" or "2MiB" into bytes.
func bytesOf(size string) int64 {
	for suffix, unit := range map[string]int64{"KiB": 1 << 10, "MiB": 1 << 20} {
		if n, ok := strings.CutSuffix(size, suffix); ok {
			count, _ := strconv.ParseInt(n, 10, 64)
			return count * unit
		}
	}
	return 0
}

// inClusterService is a Service's name: <service>.<namespace>.svc, alone
// (the gateway looks it up with its install's cluster domain, whichever it
// is: a catalog serves every install) or with cluster.local. Not with any
// other domain: a catalog can't tell a cluster's from a name on the internet.
func inClusterService(host string) bool {
	labels := strings.Split(strings.TrimSuffix(strings.ToLower(host), "."), ".")
	if len(labels) != 3 && len(labels) != 5 {
		return false
	}
	if labels[0] == "" || labels[1] == "" || labels[2] != "svc" {
		return false
	}
	return len(labels) == 3 || labels[3] == "cluster" && labels[4] == "local"
}
