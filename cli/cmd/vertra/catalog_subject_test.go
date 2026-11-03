// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rburns629/vertra/cli/internal/githost"
	"github.com/rburns629/vertra/cli/internal/run"
)

// fakeGH answers the subject template's GET with current (or fails every
// call when current is empty), logging each call and what it was sent.
func fakeGH(t *testing.T, current string) (*githost.GitHub, string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	script := `#!/bin/sh
echo "gh $*" >> "` + log + `"
[ -n '` + current + `' ] || { echo "gh: not signed in" >&2; exit 1; }
case "$*" in
  *"-X PUT"*) cat >> "` + log + `"; printf 'HTTP/2.0 201 Created\r\n\r\n{}' ;;
  *) printf 'HTTP/2.0 200 OK\r\n\r\n%s' '` + current + `' ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	r := &run.Runner{Out: os.Stderr, Err: os.Stderr, Resolve: func(name string) string { return filepath.Join(dir, name) }}
	return githost.NewGitHub(r), log
}

// A catalog made before the AWS publish role named only main gets the
// template it needs; one that has it is left alone; and one it can't set
// stops apply, saying how to set it, before the role changes.
func TestTheCatalogsSubjectTemplateIsSetOnlyWhenItIsnt(t *testing.T) {
	ctx := context.Background()

	gh, log := fakeGH(t, `{"use_default":true}`)
	var out bytes.Buffer
	if err := ensureCatalogSubject(ctx, &out, gh, "acme/catalog"); err != nil {
		t.Fatal(err)
	}
	calls, _ := os.ReadFile(log)
	if !strings.Contains(string(calls), "-X PUT /repos/acme/catalog/actions/oidc/customization/sub") {
		t.Errorf("no PUT of the template: %s", calls)
	}
	if !strings.Contains(string(calls), `"include_claim_keys":["repo","context","ref"]`) || !strings.Contains(string(calls), `"use_default":false`) {
		t.Errorf("the template sent: %s", calls)
	}
	if !strings.Contains(out.String(), "now name their branch") {
		t.Errorf("it should say it changed it: %q", out.String())
	}

	gh, log = fakeGH(t, `{"use_default":false,"include_claim_keys":["repo","context","ref"]}`)
	out.Reset()
	if err := ensureCatalogSubject(ctx, &out, gh, "acme/catalog"); err != nil {
		t.Fatal(err)
	}
	if calls, _ := os.ReadFile(log); strings.Contains(string(calls), "PUT") {
		t.Errorf("already set: nothing to change, got %s", calls)
	}
	if out.Len() != 0 {
		t.Errorf("already set: nothing to say, got %q", out.String())
	}

	gh, _ = fakeGH(t, "")
	err := ensureCatalogSubject(ctx, &out, gh, "acme/catalog")
	if err == nil || !strings.Contains(err.Error(), "gh api -X PUT repos/acme/catalog/actions/oidc/customization/sub") {
		t.Errorf("a template it can't set: %v", err)
	}
}
