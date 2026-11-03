// SPDX-License-Identifier: MIT

package catalogtool

import (
	"context"
	"errors"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/random"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	catalogv1 "github.com/rburns629/vertra/cli/internal/gen/vertra/catalog/v1"
)

// A release pushed as an artifact reads back as itself, under its commit's
// tag and latest, with the media types a console looks for.
func TestAReleaseIsPushedAsAnArtifactAConsoleCanRead(t *testing.T) {
	server := httptest.NewServer(registry.New())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")
	s := Settings{Registry: host + "/catalog-products"}
	release := &catalogv1.Release{Commit: "abc123", Repository: "github.com/my-org/vertra-catalog",
		Teams:    []*catalogv1.Team{{Name: "platform"}},
		Products: []*catalogv1.ProductAction{{Name: "platform-hello-greet", Image: host + "/catalog-products/platform/hello@sha256:" + strings.Repeat("a", 64), Action: "greet", Team: "platform"}}}

	reference, err := pushRelease(context.Background(), s, release, "abc123", unsigned)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(reference, host+"/catalog-products/catalog-release@sha256:") {
		t.Errorf("reference = %s", reference)
	}
	for _, tag := range []string{"abc123", "latest"} {
		ref, _ := name.ParseReference(s.ReleaseRepository()+":"+tag, name.Insecure)
		artifact, err := remote.Image(ref)
		if err != nil {
			t.Fatal(err)
		}
		manifest, _ := artifact.Manifest()
		if manifest.Config.MediaType != ReleaseConfigMediaType || len(manifest.Layers) != 1 ||
			manifest.Layers[0].MediaType != ReleaseMediaType || manifest.Annotations["org.opencontainers.image.revision"] != "abc123" {
			t.Fatalf("%s: manifest = %+v", tag, manifest)
		}
		layers, _ := artifact.Layers()
		blob, _ := layers[0].Uncompressed()
		data, _ := io.ReadAll(blob)
		var got catalogv1.Release
		if err := protojson.Unmarshal(data, &got); err != nil || !proto.Equal(&got, release) {
			t.Errorf("%s: read back %v (%v)", tag, &got, err)
		}
	}
}

func unsigned(string) error { return nil }

// A release is pushed by digest and signed before it's tagged: a failed
// sign leaves its commit's tag and latest where they were.
func TestAReleaseIsTaggedOnlyOnceSigned(t *testing.T) {
	server := httptest.NewServer(registry.New())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")
	s := Settings{Registry: host + "/catalog-products"}
	ctx := context.Background()
	first, err := pushRelease(ctx, s, &catalogv1.Release{Commit: "c1"}, "c1", unsigned)
	if err != nil {
		t.Fatal(err)
	}
	var signing string
	_, err = pushRelease(ctx, s, &catalogv1.Release{Commit: "c2"}, "c2", func(reference string) error {
		signing = reference
		return errors.New("the KMS key said no")
	})
	if err == nil || !strings.Contains(err.Error(), "the KMS key said no") {
		t.Fatalf("a failed sign: %v", err)
	}
	if !strings.HasPrefix(signing, s.ReleaseRepository()+"@sha256:") || signing == first {
		t.Errorf("signed %s, not the new release's digest", signing)
	}
	ref, _ := name.ParseReference(s.ReleaseRepository()+":latest", name.Insecure)
	if desc, err := remote.Head(ref); err != nil || s.ReleaseRepository()+"@"+desc.Digest.String() != first {
		t.Errorf("latest names %v (%v), not the signed %s", desc, err, first)
	}
	ref, _ = name.ParseReference(s.ReleaseRepository()+":c2", name.Insecure)
	if _, err := remote.Head(ref); !notFound(err) {
		t.Errorf("c2 is tagged though unsigned: %v", err)
	}
}

// gitIn runs git in root, as a committer, failing the test if it fails.
func gitIn(t *testing.T, root string) func(args ...string) string {
	return func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
}

// publishSigned writes an image to <repository>:tag in the test registry,
// with a signature beside it, as publish leaves a signed one.
func publishSigned(t *testing.T, repository, tag string) {
	t.Helper()
	for _, signature := range []bool{false, true} {
		image, err := random.Image(64, 1)
		if err != nil {
			t.Fatal(err)
		}
		ref, _ := name.NewTag(repository + ":" + tag)
		if err := remote.Write(ref, image); err != nil {
			t.Fatal(err)
		}
		if signature {
			return
		}
		digest, _ := image.Digest()
		tag = strings.Replace(digest.String(), ":", "-", 1) + ".sig"
	}
}

// In CI, publish --changed also takes every product whose image for its
// commit isn't there, signed: one changed and reverted within a push (no
// net diff, but a new commit), and one whose push's run never published it
// (the concurrency group skipped it); not one that's there.
func TestInCIPublishAlsoTakesProductsWhoseCommitHasNoImage(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	server := httptest.NewServer(registry.New())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")
	s := Settings{Registry: host + "/catalog-products", SigningMode: "key"}
	ctx := context.Background()

	files := map[string]string{}
	for _, n := range []string{"reverted", "skipped", "fine", "changed"} {
		for path, content := range product(n, "[]") {
			files[path] = content
		}
	}
	c := catalogWith(t, files)
	git := gitIn(t, c.Root)
	git("init", "-q")
	git("add", "-A")
	git("commit", "-qm", "all")
	first := git("rev-parse", "HEAD")
	for _, n := range []string{"reverted", "skipped", "fine", "changed"} {
		publishSigned(t, s.Registry+"/a/"+n, first)
	}
	commit := func(path, content, message string) {
		if err := os.WriteFile(filepath.Join(c.Root, path), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		git("add", "-A")
		git("commit", "-qm", message)
	}
	// A push whose run the concurrency group skipped: skipped/ never published.
	commit("teams/a/products/skipped/notes.txt", "one\n", "skipped")
	before := git("rev-parse", "HEAD")
	// This push: reverted/ changed and changed back, changed/ changed.
	commit("teams/a/products/reverted/notes.txt", "x\n", "change")
	if err := os.Remove(filepath.Join(c.Root, "teams/a/products/reverted/notes.txt")); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-qm", "revert")
	commit("teams/a/products/changed/notes.txt", "two\n", "changed")
	head := git("rev-parse", "HEAD")
	c.Getenv = func(key string) string {
		if key == "GITHUB_SHA" {
			return head
		}
		return ""
	}

	changed, err := c.SelectProducts(nil, &before)
	if err != nil || len(changed) != 1 || changed[0].Name() != "changed" {
		t.Fatalf("the diff selects %v (%v), only changed", changed, err)
	}
	var got []string
	for _, p := range c.withUnpublished(ctx, changed, s) {
		got = append(got, p.Name())
	}
	if strings.Join(got, ",") != "changed,reverted,skipped" {
		t.Errorf("publishes %v; want changed, reverted and skipped, not fine", got)
	}
}

// In CI a release pins each product to the image tagged with the commit
// that last changed it, not :latest, and refuses one that's missing or,
// when the catalog signs, unsigned.
func TestInCIAReleasePinsEachProductsOwnCommit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	server := httptest.NewServer(registry.New())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")
	s := Settings{Registry: host + "/catalog-products", SigningMode: "key"}
	ctx := context.Background()

	files := product("mine", "[]")
	files["teams/a/team.yaml"] = "apiVersion: vertra.dev/v2\nkind: Team\nname: a\ndisplayName: A\ndescription: A\nowner: \"@acme/team-a\"\ncontact: a@acme.com\n"
	c := catalogWith(t, files)
	git := gitIn(t, c.Root)
	git("init", "-q")
	git("add", "-A")
	git("commit", "-qm", "mine")
	changed := git("rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(c.Root, "README.md"), []byte("not a product\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", "-A")
	git("commit", "-qm", "docs")
	head := git("rev-parse", "HEAD")
	c.Getenv = func(key string) string {
		if key == "GITHUB_SHA" {
			return head
		}
		return ""
	}
	if tag, err := c.imageTag(c.AllProducts()[0]); err != nil || tag != changed {
		t.Fatalf("publish tags it %s (%v), not %s", tag, err, changed)
	}

	write := func(tag string) v1.Image {
		image, err := random.Image(64, 1)
		if err != nil {
			t.Fatal(err)
		}
		ref, _ := name.NewTag(s.Registry + "/a/mine:" + tag)
		if err := remote.Write(ref, image); err != nil {
			t.Fatal(err)
		}
		return image
	}
	release := func() (*catalogv1.Release, error) { return c.BuildRelease(ctx, s, head, "") }

	// Only :latest, as a run that failed to sign leaves it: refused.
	write("latest")
	if _, err := release(); err == nil || !strings.Contains(err.Error(), "no published image ("+s.Registry+"/a/mine:"+changed+")") {
		t.Fatalf("no image for its commit: %v", err)
	}
	image := write(changed)
	digest, _ := image.Digest()
	if _, err := release(); err == nil || !strings.Contains(err.Error(), "isn't signed") {
		t.Fatalf("an unsigned image: %v", err)
	}
	write(strings.Replace(digest.String(), ":", "-", 1) + ".sig")
	got, err := release()
	if err != nil {
		t.Fatal(err)
	}
	if image := got.GetProducts()[0].GetImage(); image != s.Registry+"/a/mine@"+digest.String() {
		t.Errorf("pinned %s, not its commit's %s", image, digest)
	}
}

// product is a valid product of team a: its product.yaml, Dockerfile and a test.
func product(name, shareWith string) map[string]string {
	dir := "teams/a/products/" + name + "/"
	return map[string]string{
		dir + "product.yaml":                    productFile(name, "a", shareWith),
		dir + "Dockerfile":                      "FROM scratch\nUSER 65532:65532\n",
		dir + "tests/run/says-hi/request.json":  `{"inputs": {"text": "hi"}}`,
		dir + "tests/run/says-hi/expected.json": `{"status": "succeeded"}`,
	}
}

// From a laptop, a release names every product action at the digest its
// :latest has now,
// with its schemas read from product.yaml, and refuses to leave out a
// product that was never published.
func TestBuildReleasePinsEachPublishedProduct(t *testing.T) {
	server := httptest.NewServer(registry.New())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")
	s := Settings{Registry: host + "/catalog-products", SigningMode: "none"}
	image, err := random.Image(64, 1)
	if err != nil {
		t.Fatal(err)
	}
	ref, _ := name.NewTag(s.Registry + "/a/mine:latest")
	if err := remote.Write(ref, image); err != nil {
		t.Fatal(err)
	}
	digest, _ := image.Digest()

	files := product("mine", "[b]")
	files["teams/a/products/mine/product.yaml"] = strings.Replace(files["teams/a/products/mine/product.yaml"],
		"owner: x\n", "owner: x\ntokenAudiences: [sts.amazonaws.com]\n", 1)
	files["teams/a/team.yaml"] = "apiVersion: vertra.dev/v2\nkind: Team\nname: a\ndisplayName: A\ndescription: A\nowner: \"@acme/team-a\"\ncontact: a@acme.com\n"
	files["teams/a/dags/hello.yaml"] = `apiVersion: vertra.dev/v2
kind: Template
name: hello
displayName: Hello
description: One step.
shareWith: ["*"]
parameters:
  type: object
  required: [text]
  properties:
    text: {type: string}
examples:
  - {name: a greeting, parameters: {text: hi}}
steps:
  - id: one
    action: mine.run
    timeoutSeconds: 60
    inputs:
      text: {$param: text}
`
	c := catalogWith(t, files)
	var out strings.Builder
	c.Stdout, c.Stderr = &out, &out
	release, err := c.BuildRelease(context.Background(), s, "c1", "github.com/my-org/vertra-catalog")
	if err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if len(release.GetTeams()) != 1 || release.GetTeams()[0].GetName() != "a" || release.GetTeams()[0].GetOwner() != "@acme/team-a" || release.GetTeams()[0].GetDescription() != "A" || len(release.GetProducts()) != 1 {
		t.Fatalf("release = %v", release)
	}
	got := release.GetProducts()[0]
	if got.GetName() != "a-mine-run" || got.GetImage() != s.Registry+"/a/mine@"+digest.String() || got.GetTeam() != "a" ||
		got.GetAction() != "run" || len(got.GetShareWith()) != 1 || got.GetInputSchema().GetFields()["required"] == nil ||
		strings.Join(got.GetTokenAudiences(), ",") != "sts.amazonaws.com" ||
		got.GetPath() != "teams/a/products/mine/product.yaml" || got.GetHidden() {
		t.Errorf("action = %v", got)
	}
	if len(release.GetTemplates()) != 1 {
		t.Fatalf("templates = %v", release.GetTemplates())
	}
	tpl := release.GetTemplates()[0]
	step := tpl.GetSteps()[0]
	if tpl.GetTeam() != "a" || tpl.GetName() != "hello" || strings.Join(tpl.GetShareWith(), ",") != "*" ||
		tpl.GetParameters().GetFields()["required"] == nil || step.GetAction() != "a/mine.run" || step.GetTimeoutSeconds() != 60 ||
		step.GetInputs().GetFields()["text"].GetStructValue().GetFields()["$param"].GetStringValue() != "text" ||
		tpl.GetPath() != "teams/a/dags/hello.yaml" || tpl.GetHidden() {
		t.Errorf("template = %v", tpl)
	}
	if e := tpl.GetExamples(); len(e) != 1 || e[0].GetName() != "a greeting" || e[0].GetInputs().GetFields()["text"].GetStringValue() != "hi" {
		t.Errorf("examples = %v", e)
	}

	if len(got.GetClouds()) != 0 || got.GetCloudsFrom() != "" {
		t.Errorf("no clouds said: every install, %v %q", got.GetClouds(), got.GetCloudsFrom())
	}
	// A team's clouds are its products', unless a product says its own.
	files["teams/a/team.yaml"] += "clouds: [aws]\n"
	c = catalogWith(t, files)
	c.Stdout, c.Stderr = &out, &out
	if release, err = c.BuildRelease(context.Background(), s, "c1", ""); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if got := release.GetProducts()[0]; strings.Join(got.GetClouds(), ",") != "aws" || got.GetCloudsFrom() != "team" {
		t.Errorf("the team's clouds: %v %q", got.GetClouds(), got.GetCloudsFrom())
	}
	files["teams/a/products/mine/product.yaml"] = strings.Replace(files["teams/a/products/mine/product.yaml"], "owner: x\n", "owner: x\nclouds: [gcp, aws]\n", 1)
	c = catalogWith(t, files)
	c.Stdout, c.Stderr = &out, &out
	if release, err = c.BuildRelease(context.Background(), s, "c1", ""); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if got := release.GetProducts()[0]; strings.Join(got.GetClouds(), ",") != "gcp,aws" || got.GetCloudsFrom() != "product" {
		t.Errorf("its own clouds: %v %q", got.GetClouds(), got.GetCloudsFrom())
	}

	// A team.yaml's clouds aren't schema-checked by a release: checked here.
	files["teams/a/team.yaml"] = strings.Replace(files["teams/a/team.yaml"], "clouds: [aws]", "clouds: [eks]", 1)
	c = catalogWith(t, files)
	c.Stdout, c.Stderr = &out, &out
	if _, err := c.BuildRelease(context.Background(), s, "c1", ""); err == nil || !strings.Contains(err.Error(), `clouds: "eks" isn't one of gcp, aws, azure, kind, existing`) {
		t.Errorf("an unknown cloud: %v", err)
	}

	files = product("mine", "[]")
	for path, content := range product("never", "[]") {
		files[path] = content
	}
	c = catalogWith(t, files)
	if _, err := c.BuildRelease(context.Background(), s, "c1", ""); err == nil || !strings.Contains(err.Error(), "teams/a/products/never: no published image") {
		t.Errorf("an unpublished product: %v", err)
	}
}

// A version tags the release a commit published, the same digest; it
// stays put once made, needs a release to name, and is vX.Y.Z.
func TestAVersionNamesACommitsReleaseAndNeverMoves(t *testing.T) {
	server := httptest.NewServer(registry.New())
	defer server.Close()
	host := strings.TrimPrefix(server.URL, "http://")
	s := Settings{Registry: host + "/catalog-products"}
	ctx := context.Background()
	first, err := pushRelease(ctx, s, &catalogv1.Release{Commit: "c1"}, "c1", unsigned)
	if err != nil {
		t.Fatal(err)
	}
	second, err := pushRelease(ctx, s, &catalogv1.Release{Commit: "c2"}, "c2", unsigned)
	if err != nil {
		t.Fatal(err)
	}

	reference, made, err := promoteRelease(ctx, s, "v1.0.0", "c1")
	if err != nil || !made || reference != first {
		t.Fatalf("promote c1 = %s, %v, %v; want %s", reference, made, err, first)
	}
	ref, _ := name.ParseReference(s.ReleaseRepository()+":v1.0.0", name.Insecure)
	if desc, err := remote.Head(ref); err != nil || s.ReleaseRepository()+"@"+desc.Digest.String() != first {
		t.Errorf("v1.0.0 names %v (%v), not %s", desc, err, first)
	}
	if _, made, err := promoteRelease(ctx, s, "v1.0.0", "c1"); err != nil || made {
		t.Errorf("again: made %v, %v", made, err)
	}
	if _, _, err := promoteRelease(ctx, s, "v1.0.0", "c2"); err == nil || !strings.Contains(err.Error(), "never moves") {
		t.Errorf("moving it: %v", err)
	}
	if _, _, err := promoteRelease(ctx, s, "v1.1.0", "c3"); !errors.Is(err, errNoRelease) {
		t.Errorf("an unpublished commit: %v", err)
	}
	for _, bad := range []string{"1.0.0", "v1.0", "v1.0.0-rc.1", "v01.0.0", "latest"} {
		if _, _, err := promoteRelease(ctx, s, bad, "c2"); err == nil || !strings.Contains(err.Error(), "vX.Y.Z") {
			t.Errorf("%s: %v", bad, err)
		}
	}
	if reference, _, err := promoteRelease(ctx, s, "v1.1.0", "c2"); err != nil || reference != second {
		t.Errorf("v1.1.0 = %s, %v", reference, err)
	}
}
