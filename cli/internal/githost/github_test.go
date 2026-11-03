// SPDX-License-Identifier: MIT

package githost

import (
	"encoding/json"
	"testing"
)

func TestSingleSignOnIsRecognised(t *testing.T) {
	out := "HTTP/2.0 403 Forbidden\r\nX-Github-Sso: required; url=https://github.com/orgs/acme/sso?authorization_request=AB12\r\n\r\n{\"message\":\"Resource protected by organization SAML enforcement.\"}"
	body, sso := parseResponse(out)
	if sso != "https://github.com/orgs/acme/sso?authorization_request=AB12" {
		t.Errorf("sso: %q", sso)
	}
	if body == "" {
		t.Error("the body should still be returned")
	}
	if _, sso := parseResponse("HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{}"); sso != "" {
		t.Errorf("no sso expected, got %q", sso)
	}
}

func TestMissingScopes(t *testing.T) {
	a := &Account{Scopes: []string{"gist", "read:org", "repo"}}
	if m := a.MissingScopes(); len(m) != 1 || m[0] != "workflow" {
		t.Errorf("got %v", m)
	}
	if m := (&Account{}).MissingScopes(); m != nil {
		t.Errorf("a fine-grained token lists no scopes: %v", m)
	}
}

func TestNewRepositoriesSayPrivateTheWayEveryEndpointReads(t *testing.T) {
	for visibility, private := range map[string]bool{"private": true, "internal": true, "public": false} {
		var body map[string]any
		if err := json.Unmarshal([]byte(createBody("c", visibility, "")), &body); err != nil {
			t.Fatal(err)
		}
		if body["private"] != private || body["visibility"] != visibility {
			t.Errorf("%s: %v", visibility, body)
		}
	}
}

func TestHasItems(t *testing.T) {
	for body, want := range map[string]bool{`[{"name":"main"}]`: true, `[]`: false} {
		if got, err := hasItems(body); err != nil || got != want {
			t.Errorf("%s: %v, %v", body, got, err)
		}
	}
}

// Only exactly repo, context and ref, in that order, is the template the
// AWS publish role's trust is written for.
func TestTheSubjectTemplateIsReadAsGitHubAnswers(t *testing.T) {
	for body, want := range map[string]bool{
		`{"use_default":false,"include_claim_keys":["repo","context","ref"]}`: true,
		`{"use_default":true}`: false,
		`{"use_default":false,"include_claim_keys":["repo","context"]}`:       false,
		`{"use_default":false,"include_claim_keys":["repo","ref","context"]}`: false,
		`{"use_default":true,"include_claim_keys":["repo","context","ref"]}`:  false,
	} {
		if got, err := subjectTemplateSet(body); err != nil || got != want {
			t.Errorf("%s: %v, %v; want %v", body, got, err, want)
		}
	}
	if _, err := subjectTemplateSet("not json"); err == nil {
		t.Error("an answer that isn't JSON should be an error")
	}
}
