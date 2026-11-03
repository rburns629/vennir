// SPDX-License-Identifier: MIT

package catalogtool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/static"
	"github.com/google/go-containerregistry/pkg/v1/types"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	catalogv1 "github.com/rburns629/vertra/cli/internal/gen/vertra/catalog/v1"
)

// A catalog release is everything main says, as of one commit, for every
// install to read (proto/vertra/catalog/v1/release.proto): consoles pull
// it, so CI needs no console credential and one catalog serves any number
// of installs.
const (
	// ReleaseMediaType is the artifact's one layer: the release as JSON.
	ReleaseMediaType = "application/vnd.vertra.catalog.release.v1+json"
	// ReleaseConfigMediaType marks the artifact as a release, not an image.
	ReleaseConfigMediaType = "application/vnd.vertra.catalog.release.config.v1+json"
	// ReleaseRepositoryName is the release's repository, under the registry
	// beside the teams' (<registry>/<team>/<product>): no team may take it.
	ReleaseRepositoryName = "catalog-release"
)

// ReleaseRepository is where releases go: <registry>/catalog-release.
func (s Settings) ReleaseRepository() string { return s.Registry + "/" + ReleaseRepositoryName }

// ReleaseActions are a product's actions as a release carries them, one per
// action, named <team>-<product>-<action>, with everything in product.yaml
// the console uses, and its image pinned to reference.
func (p *Product) ReleaseActions(reference string) ([]*catalogv1.ProductAction, error) {
	var out []*catalogv1.ProductAction
	for _, action := range p.Actions() {
		actionName := text(action, "name")
		input, err := structOf(action["input"])
		if err != nil {
			return nil, fmt.Errorf("action %s's input schema: %w", actionName, err)
		}
		output, err := structOf(action["output"])
		if err != nil {
			return nil, fmt.Errorf("action %s's output schema: %w", actionName, err)
		}
		a := &catalogv1.ProductAction{
			Name:           fmt.Sprintf("%s-%s-%s", p.Team(), p.Name(), actionName),
			Image:          reference,
			Action:         actionName,
			Team:           p.Team(),
			InputSchema:    input,
			OutputSchema:   output,
			DisplayName:    or(text(action, "displayName"), text(p.Spec, "displayName")),
			Description:    or(text(action, "description"), text(p.Spec, "description")),
			ServiceAccount: text(p.Spec, "serviceAccount"),
			// An action's own deprecation, else its product's.
			Deprecated:     or(text(action, "deprecated"), text(p.Spec, "deprecated")),
			Hidden:         text(action, "visibility") == "hidden",
			Path:           p.Label() + "/product.yaml",
			Idempotent:     action["idempotent"] == true,
			ConcurrencyKey: stringList(action["concurrencyKey"]),
			Approval:       text(action, "approval"),
			// A list of teams instead: an approval for runs for those teams.
			ApprovalTeams: stringList(action["approval"]),
			Plan:          text(action, "plan"),
			Check:         text(p.Spec, "check"),
		}
		if errs, ok := p.Spec["errors"].(map[string]any); ok && len(errs) > 0 {
			a.Errors = map[string]*catalogv1.ErrorHelp{}
			for code, raw := range errs {
				help, _ := raw.(map[string]any)
				a.Errors[code] = &catalogv1.ErrorHelp{Means: text(help, "means"), Do: text(help, "do")}
			}
		}
		if a.Examples, err = examplesOf(p, actionName); err != nil {
			return nil, err
		}
		if cleanup, ok := action["cleanup"].(map[string]any); ok {
			a.Cleanup = &catalogv1.Cleanup{Action: text(cleanup, "action")}
			if inputs, ok := cleanup["inputs"]; ok {
				if a.Cleanup.Inputs, err = structOf(inputs); err != nil {
					return nil, fmt.Errorf("action %s's cleanup inputs: %w", actionName, err)
				}
			}
		}
		if n, ok := whole(action["maxAttempts"]); ok {
			a.MaxAttempts = n
		}
		if n, ok := whole(p.Spec["maxRunning"]); ok {
			a.MaxRunning = n
		}
		a.Capacity = text(p.Spec, "capacity")
		secrets, _ := action["secretRefs"].([]any)
		for _, s := range secrets {
			if m, ok := s.(map[string]any); ok {
				a.SecretRefs = append(a.SecretRefs, text(m, "name"))
			}
		}
		audiences, _ := p.Spec["tokenAudiences"].([]any)
		for _, audience := range audiences {
			a.TokenAudiences = append(a.TokenAudiences, fmt.Sprint(audience))
		}
		shareWith, _ := action["shareWith"].([]any)
		for _, team := range shareWith {
			a.ShareWith = append(a.ShareWith, fmt.Sprint(team))
		}
		if r, ok := p.Spec["resources"].(map[string]any); ok && len(r) > 0 {
			a.Resources = &catalogv1.Resources{Cpu: text(r, "cpu"), Memory: text(r, "memory"), MemoryLimit: text(r, "memoryLimit")}
		}
		out = append(out, a)
	}
	return out, nil
}

// cloudsOf is a team.yaml's or product.yaml's clouds: a list of the clouds
// installs are on; nil when it says none.
func cloudsOf(v any) ([]string, error) {
	if v == nil {
		return nil, nil
	}
	list, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("clouds is a list, such as [aws]")
	}
	var out []string
	for _, x := range list {
		cloud := fmt.Sprint(x)
		if !slices.Contains(Clouds, cloud) {
			return nil, fmt.Errorf("clouds: %q isn't one of %s", cloud, strings.Join(Clouds, ", "))
		}
		out = append(out, cloud)
	}
	return out, nil
}

// Clouds are the clouds a catalog's clouds may name: those installs are on.
var Clouds = []string{"gcp", "aws", "azure", "kind", "existing"}

func or(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

// structOf is a JSON object (a schema from YAML) as a Struct; nil for none.
func structOf(value any) (*structpb.Struct, error) {
	if value == nil {
		return nil, nil
	}
	m, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("not an object")
	}
	return structpb.NewStruct(m)
}

// BuildRelease is the catalog as of this commit: every team, with its
// checked SecretStore documents, and every product's actions, each image
// pinned to the one published for it as of this commit (publishedImage). A
// product that doesn't validate, or whose image isn't there or isn't
// signed, fails it: left out, every install would unregister it.
func (c *Catalog) BuildRelease(ctx context.Context, s Settings, commit, repository string) (*catalogv1.Release, error) {
	release := &catalogv1.Release{Commit: commit, Repository: repository, CreatedAt: timestamppb.Now()}
	var problems []string
	dirs := map[string]string{}
	teamClouds := map[string][]string{}
	for _, d := range c.TeamDirs() {
		dirs[filepath.Base(d)] = d
	}
	for _, team := range c.TeamNames() {
		if team == ReleaseRepositoryName {
			problems = append(problems, fmt.Sprintf("teams/%s: %s is the release's own repository; rename the team", team, team))
			continue
		}
		t := &catalogv1.Team{Name: team}
		spec, err := teamSpec(filepath.Join(dirs[team], "team.yaml"))
		if err != nil {
			problems = append(problems, fmt.Sprintf("teams/%s/team.yaml: %v", team, err))
			continue
		}
		t.AllowedTargets = targetRulesOf(spec)
		help, _ := spec["help"].(map[string]any)
		t.Contact, t.HelpChat, t.HelpUrl = text(spec, "contact"), text(help, "chat"), text(help, "url")
		t.Owner, t.Description = text(spec, "owner"), text(spec, "description")
		// Not schema-checked here, as product.yaml is: a cloud nobody runs
		// would keep its products from running anywhere.
		if teamClouds[team], err = cloudsOf(spec["clouds"]); err != nil {
			problems = append(problems, fmt.Sprintf("teams/%s/team.yaml: %v", team, err))
			continue
		}
		if len(c.secretStoreFiles(team)) > 0 {
			documents, found := c.secretStoreDocuments(team)
			if len(found) == 0 {
				found = SecretStoreProblems(team, documents)
			}
			if len(found) > 0 {
				problems = append(problems, found...)
				continue
			}
			for _, d := range documents {
				m, ok := d.(map[string]any)
				if !ok {
					continue
				}
				doc, err := structpb.NewStruct(m)
				if err != nil {
					return nil, fmt.Errorf("teams/%s/secret-stores: %w", team, err)
				}
				t.SecretStoreDocuments = append(t.SecretStoreDocuments, doc)
			}
		}
		release.Teams = append(release.Teams, t)
	}
	for _, p := range c.AllProducts() {
		if p.IsTemplate() {
			continue
		}
		// Reads product.yaml, and says what's wrong with it if anything is.
		if !c.ValidateProduct(p) {
			problems = append(problems, fmt.Sprintf("%s: product.yaml isn't valid (above)", p.Label()))
			continue
		}
		repository := p.Repository(s)
		digest, problem := c.publishedImage(ctx, p, s)
		if problem != "" {
			problems = append(problems, fmt.Sprintf("%s: %s", p.Label(), problem))
			continue
		}
		actions, err := p.ReleaseActions(repository + "@" + digest)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s: %v", p.Label(), err))
			continue
		}
		// The clouds it's for: its own, else its team's.
		clouds, from := stringList(p.Spec["clouds"]), "product"
		if len(clouds) == 0 {
			clouds, from = teamClouds[p.Team()], "team"
		}
		if len(clouds) == 0 {
			from = ""
		}
		for _, a := range actions {
			a.Clouds, a.CloudsFrom = clouds, from
		}
		release.Products = append(release.Products, actions...)
	}
	if !c.ValidateDags() {
		problems = append(problems, "a dags/ file isn't valid (above)")
	} else {
		templates, err := c.releaseTemplates()
		if err != nil {
			return nil, err
		}
		release.Templates = templates
	}
	if !c.ValidateAPIs() {
		problems = append(problems, "an apis/ file isn't valid (above)")
	} else {
		apis, err := c.releaseAPIs()
		if err != nil {
			return nil, err
		}
		release.Apis = apis
	}
	if !c.ValidateWiringTypes() {
		problems = append(problems, "a types.yaml, or a type a product names, isn't valid (above)")
	} else {
		types, err := c.releaseWiringTypes()
		if err != nil {
			return nil, err
		}
		release.WiringTypes = types
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("the release can't be made:\n  %s", strings.Join(problems, "\n  "))
	}
	sort.Slice(release.Products, func(i, j int) bool { return release.Products[i].Name < release.Products[j].Name })
	return release, nil
}

// releaseTemplates are every team's templates (the starters' aren't a
// team's), already checked by ValidateDags, each step's action with its team.
func (c *Catalog) releaseTemplates() ([]*catalogv1.Template, error) {
	var out []*catalogv1.Template
	for _, path := range c.DagFiles() {
		team := c.dagTeam(path)
		if team == "templates" {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		doc, _ := loadYAML(data)
		spec, _ := doc.(map[string]any)
		if spec["kind"] != "Template" {
			continue
		}
		parameters, err := structOf(spec["parameters"])
		if err != nil {
			return nil, fmt.Errorf("%s: parameters: %w", c.rel(path), err)
		}
		t := &catalogv1.Template{
			Name: text(spec, "name"), Team: team, DisplayName: text(spec, "displayName"),
			Description: text(spec, "description"), Parameters: parameters, ShareWith: stringList(spec["shareWith"]),
			Deprecated: text(spec, "deprecated"), Hidden: text(spec, "visibility") == "hidden", Path: c.rel(path),
		}
		examples, _ := spec["examples"].([]any)
		for _, raw := range examples {
			example, _ := raw.(map[string]any)
			parameters, err := structOf(example["parameters"])
			if err != nil {
				return nil, fmt.Errorf("%s: example %s: %w", c.rel(path), text(example, "name"), err)
			}
			t.Examples = append(t.Examples, &catalogv1.Example{Name: text(example, "name"), Inputs: parameters})
		}
		steps, _ := spec["steps"].([]any)
		for _, raw := range steps {
			step, _ := raw.(map[string]any)
			action := text(step, "action")
			if !strings.Contains(action, "/") {
				action = team + "/" + action
			}
			inputs, err := structOf(step["inputs"])
			if err != nil {
				return nil, fmt.Errorf("%s: step %s's inputs: %w", c.rel(path), text(step, "id"), err)
			}
			s := &catalogv1.TemplateStep{Id: text(step, "id"), Action: action, DependsOn: stringList(step["dependsOn"]), Inputs: inputs}
			if n, ok := whole(step["timeoutSeconds"]); ok {
				s.TimeoutSeconds = &n
			}
			if n, ok := whole(step["maxAttempts"]); ok {
				s.MaxAttempts = &n
			}
			t.Steps = append(t.Steps, s)
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Team+"/"+out[i].Name < out[j].Team+"/"+out[j].Name })
	return out, nil
}

// whole is a number from a catalog file (loadYAML's json.Number) as an
// int32, if it's a whole one.
func whole(v any) (int32, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		return int32(i), err == nil && i == int64(int32(i))
	case int:
		return int32(n), true
	case int64:
		return int32(n), true
	case float64:
		return int32(n), n == float64(int32(n))
	}
	return 0, false
}

// publishedImage is the digest a release pins a product to, or what's
// wrong. In CI, the image tagged with its commit (productCommit), as
// publish pushed it for that commit, not whatever :latest names: a failed
// or skipped publish leaves that tag missing, or unsigned, and the release
// is refused rather than naming an old image under newer product.yaml. From
// a laptop, :latest: what it just published (its tags are times).
func (c *Catalog) publishedImage(ctx context.Context, p *Product, s Settings) (string, string) {
	tag, how := "latest", "publish it first"
	if c.Getenv("GITHUB_SHA") != "" {
		commit, err := c.productCommit(p)
		if err != nil {
			return "", err.Error()
		}
		tag, how = commit, "its publish failed or never ran: rerun catalog-ci by hand on main, which publishes every product"
	}
	reference := p.Repository(s) + ":" + tag
	digest, err := tagDigest(ctx, reference)
	if err != nil {
		return "", fmt.Sprintf("no published image (%s): %s", reference, how)
	}
	if s.SigningMode == "none" {
		return digest, ""
	}
	// cosign's legacy format (signingArgs) keeps a signature beside the
	// image, tagged after its digest. That it verifies is each install's
	// check; this is that publish got as far as signing it.
	if _, err := tagDigest(ctx, p.Repository(s)+":"+strings.Replace(digest, ":", "-", 1)+".sig"); err != nil {
		return "", fmt.Sprintf("%s@%s isn't signed: %s", p.Repository(s), digest, how)
	}
	return digest, ""
}

// tagDigest is the digest a tag names now (an index's, for a
// multi-platform image). Registry sign-in is Docker's, as for pushing.
func tagDigest(ctx context.Context, tagged string) (string, error) {
	ref, err := name.NewTag(tagged)
	if err != nil {
		return "", err
	}
	desc, err := remote.Head(ref, remote.WithContext(ctx), remote.WithAuthFromKeychain(authn.DefaultKeychain))
	if err != nil {
		return "", err
	}
	return desc.Digest.String(), nil
}

// pushRelease pushes a release as an OCI artifact by its digest, has sign
// sign that, and only then tags it with its commit and latest, so a failed
// sign leaves both tags where they were. It returns the digest reference.
// Registry sign-in is Docker's (docker login, or a credential helper such
// as gcloud's).
func pushRelease(ctx context.Context, s Settings, release *catalogv1.Release, tag string, sign func(reference string) error) (string, error) {
	data, err := protojson.MarshalOptions{Indent: "  "}.Marshal(release)
	if err != nil {
		return "", err
	}
	artifact := mutate.MediaType(empty.Image, types.OCIManifestSchema1)
	artifact = mutate.ConfigMediaType(artifact, ReleaseConfigMediaType)
	artifact, err = mutate.Append(artifact, mutate.Addendum{
		Layer:       static.NewLayer(data, ReleaseMediaType),
		Annotations: map[string]string{"org.opencontainers.image.title": "release.json"},
	})
	if err != nil {
		return "", err
	}
	annotations := map[string]string{"org.opencontainers.image.revision": release.GetCommit()}
	if release.GetRepository() != "" {
		annotations["org.opencontainers.image.source"] = "https://" + release.GetRepository()
	}
	artifact = mutate.Annotations(artifact, annotations).(v1.Image)
	digest, err := artifact.Digest()
	if err != nil {
		return "", err
	}
	options := []remote.Option{remote.WithContext(ctx), remote.WithAuthFromKeychain(authn.DefaultKeychain)}
	reference := s.ReleaseRepository() + "@" + digest.String()
	ref, err := name.NewDigest(reference)
	if err != nil {
		return "", err
	}
	if err := remote.Write(ref, artifact, options...); err != nil {
		return "", fmt.Errorf("pushing %s: %w", ref, err)
	}
	if err := sign(reference); err != nil {
		return "", err
	}
	for _, t := range []string{tag, "latest"} {
		ref, err := name.NewTag(s.ReleaseRepository() + ":" + t)
		if err != nil {
			return "", err
		}
		if err := remote.Tag(ref, artifact, options...); err != nil {
			return "", fmt.Errorf("tagging %s: %w", ref, err)
		}
	}
	return reference, nil
}

// Release builds the catalog's release, pushes it and signs it (as the
// images are signed). Products are published first (publish): the release
// only names what's already there.
func (c *Catalog) Release(ctx context.Context) (bool, error) {
	s, err := c.Settings()
	if err != nil {
		return false, err
	}
	if problems := s.Problems(); len(problems) > 0 {
		for _, p := range problems {
			c.errorAt(c.path("vertra.yaml"), p)
		}
		return false, nil
	}
	commit := c.Getenv("GITHUB_SHA")
	if commit == "" {
		commit, _ = c.git("rev-parse", "HEAD")
		commit = strings.TrimSpace(commit)
	}
	if commit == "" {
		// Not a git checkout (local mode's assembled catalog): its tag.
		commit = c.versionTag()
	}
	repository := ""
	if r := c.Getenv("GITHUB_REPOSITORY"); r != "" {
		repository = strings.TrimPrefix(or(c.Getenv("GITHUB_SERVER_URL"), "https://github.com"), "https://") + "/" + r
	}
	release, err := c.BuildRelease(ctx, s, commit, repository)
	if err != nil {
		c.errorAt(c.path("vertra.yaml"), err.Error())
		return false, nil
	}
	reference, err := pushRelease(ctx, s, release, c.versionTag(), func(reference string) error { return c.sign(reference, s) })
	if err != nil {
		c.errorAt(c.path("vertra.yaml"), "releasing failed: "+err.Error())
		return false, nil
	}
	c.info("Released %d team(s) and %d product action(s) as %s", len(release.GetTeams()), len(release.GetProducts()), reference)
	c.summary(fmt.Sprintf("- Released the catalog as `%s` (%d teams, %d actions)", reference, len(release.GetTeams()), len(release.GetProducts())))
	return true, nil
}

// TargetTypes are the kinds of target a team's allowedTargets lists, and an
// action input names with x-vertra-needs to be checked against them.
var TargetTypes = []string{"gcp.project", "gcp.folder", "aws.account", "azure.subscription"}

// teamSpec is a team.yaml; nil when there's none (validation asks for it).
func teamSpec(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	doc, problem := loadYAML(data)
	if problem != "" {
		return nil, errors.New(problem)
	}
	spec, _ := doc.(map[string]any)
	return spec, nil
}

// targetRules are a team.yaml's allowedTargets, as a release carries them.
func targetRules(path string) ([]*catalogv1.TargetRule, error) {
	spec, err := teamSpec(path)
	if err != nil {
		return nil, err
	}
	return targetRulesOf(spec), nil
}

func targetRulesOf(spec map[string]any) []*catalogv1.TargetRule {
	raw, _ := spec["allowedTargets"].([]any)
	var rules []*catalogv1.TargetRule
	for _, r := range raw {
		m, _ := r.(map[string]any)
		rule := &catalogv1.TargetRule{Teams: stringList(m["teams"]), Approval: m["approval"] == true}
		for _, kind := range TargetTypes {
			if values := stringList(m[kind]); len(values) > 0 {
				rule.Targets = append(rule.Targets, &catalogv1.Targets{Type: kind, Values: values})
			}
		}
		rules = append(rules, rule)
	}
	return rules
}

// maxExamples and maxExampleBytes bound what a release carries per action.
const (
	maxExamples     = 10
	maxExampleBytes = 8 << 10
)

// examplesOf is an action's passing contract tests, as examples of running
// it: their inputs and what they gave. Failing cases (refusals) aren't
// examples to follow; large ones are left out.
func examplesOf(p *Product, action string) ([]*catalogv1.Example, error) {
	var out []*catalogv1.Example
	for _, c := range contractCases(p) {
		if c.action() != action || len(out) == maxExamples {
			continue
		}
		request, err := os.ReadFile(filepath.Join(c.dir, "request.json"))
		if err != nil {
			continue
		}
		expected, err := os.ReadFile(filepath.Join(c.dir, "expected.json"))
		if err != nil || len(request)+len(expected) > maxExampleBytes {
			continue
		}
		var req struct {
			Inputs map[string]any `json:"inputs"`
		}
		var exp struct {
			Status  string         `json:"status"`
			Outputs map[string]any `json:"outputs"`
		}
		if json.Unmarshal(request, &req) != nil || json.Unmarshal(expected, &exp) != nil || exp.Status != "succeeded" {
			continue
		}
		inputs, err := structpb.NewStruct(req.Inputs)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", c.label(), err)
		}
		outputs, err := structpb.NewStruct(exp.Outputs)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", c.label(), err)
		}
		out = append(out, &catalogv1.Example{Name: strings.ReplaceAll(filepath.Base(c.dir), "-", " "), Inputs: inputs, Outputs: outputs})
	}
	return out, nil
}
