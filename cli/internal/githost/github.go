// SPDX-License-Identifier: MIT

// Package githost is the catalog's git host, run as you through its CLI:
// GitHub with `gh` (GitLab with `glab` comes later, behind the same calls).
package githost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/rburns629/vertra/cli/internal/run"
)

// GitHub talks to github.com through gh.
type GitHub struct {
	r *run.Runner
}

// NewGitHub returns the GitHub host.
func NewGitHub(r *run.Runner) *GitHub { return &GitHub{r: r} }

// SSOError is GitHub refusing a token an organization's SAML single sign-on
// hasn't authorized: URL is where to authorize it.
type SSOError struct{ URL string }

func (e *SSOError) Error() string {
	return "the organization uses single sign-on and your gh token isn't authorized for it: open " + e.URL + ", authorize it, then run this again"
}

var ssoHeader = regexp.MustCompile(`(?mi)^x-github-sso:\s*required;\s*url=(\S+)`)

// parseResponse splits `gh api --include` output into its body and, when
// GitHub asks for single sign-on, the URL to authorize at.
func parseResponse(out string) (body, ssoURL string) {
	headers, body, _ := strings.Cut(strings.ReplaceAll(out, "\r\n", "\n"), "\n\n")
	if m := ssoHeader.FindStringSubmatch(headers); m != nil {
		return body, m[1]
	}
	return body, ""
}

// api calls the REST API; input, when set, is the JSON body (on stdin).
func (g *GitHub) api(ctx context.Context, method, path, input string) (string, error) {
	args := []string{"api", "--include", "-X", method, path, "-H", "Accept: application/vnd.github+json"}
	var out string
	var err error
	if input != "" {
		args = append(args, "--input", "-")
		out, err = g.r.OutputInput(ctx, input, "gh", args...)
	} else {
		out, err = g.r.Output(ctx, "gh", args...)
	}
	body, sso := parseResponse(out)
	if sso != "" {
		return "", &SSOError{URL: sso}
	}
	if err != nil {
		return body, fmt.Errorf("GitHub %s %s: %w", method, path, err)
	}
	return body, nil
}

// Account is who gh is signed in as, and their plan.
type Account struct {
	Login string
	Plan  string // free, pro, ...
	// Scopes are the token's, for a classic token ("" for fine-grained).
	Scopes []string
}

// Me returns the signed-in account.
func (g *GitHub) Me(ctx context.Context) (*Account, error) {
	body, err := g.api(ctx, "GET", "/user", "")
	if err != nil {
		return nil, err
	}
	var u struct {
		Login string `json:"login"`
		Plan  struct {
			Name string `json:"name"`
		} `json:"plan"`
	}
	if err := json.Unmarshal([]byte(body), &u); err != nil {
		return nil, err
	}
	a := &Account{Login: u.Login, Plan: u.Plan.Name}
	if status, err := g.r.Output(ctx, "gh", "auth", "status"); err == nil {
		if m := regexp.MustCompile(`Token scopes: (.*)`).FindStringSubmatch(status); m != nil {
			for _, s := range strings.Split(m[1], ",") {
				a.Scopes = append(a.Scopes, strings.Trim(strings.TrimSpace(s), "'"))
			}
		}
	}
	return a, nil
}

// MissingScopes are the scopes creating a catalog needs that the token
// lacks (none for a fine-grained token, which doesn't list them).
func (a *Account) MissingScopes() []string {
	if len(a.Scopes) == 0 {
		return nil
	}
	var missing []string
	for _, need := range []string{"repo", "workflow"} {
		found := false
		for _, s := range a.Scopes {
			found = found || s == need
		}
		if !found {
			missing = append(missing, need)
		}
	}
	return missing
}

// IsOrganization reports whether owner is an organization (not a user).
func (g *GitHub) IsOrganization(ctx context.Context, owner string) (bool, error) {
	body, err := g.api(ctx, "GET", "/users/"+owner, "")
	if err != nil {
		return false, err
	}
	var u struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(body), &u); err != nil {
		return false, err
	}
	return u.Type == "Organization", nil
}

// Exists reports whether the repository exists (and you can see it).
func (g *GitHub) Exists(ctx context.Context, repo string) (bool, error) {
	_, err := g.api(ctx, "GET", "/repos/"+repo, "")
	if err == nil {
		return true, nil
	}
	var sso *SSOError
	if errors.As(err, &sso) {
		return false, err
	}
	if strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "Not Found") {
		return false, nil
	}
	return false, err
}

// createBody is a new repository's request. `private` is what every
// endpoint honours (POST /user/repos ignores `visibility`, and a personal
// repository then comes out public); `visibility` is what an organization
// needs for internal.
func createBody(name, visibility, description string) string {
	body, _ := json.Marshal(map[string]any{
		"name": name, "private": visibility != "public", "visibility": visibility, "description": description,
		"auto_init": false, "has_wiki": false, "delete_branch_on_merge": true,
	})
	return string(body)
}

// CreateRepository creates an empty repository, and checks it came out
// with the visibility asked for.
func (g *GitHub) CreateRepository(ctx context.Context, owner, name, visibility, description string, organization bool) error {
	path := "/user/repos"
	if organization {
		path = "/orgs/" + owner + "/repos"
	}
	body, err := g.api(ctx, "POST", path, createBody(name, visibility, description))
	if err != nil {
		return err
	}
	var made struct {
		Visibility string `json:"visibility"`
	}
	if err := json.Unmarshal([]byte(body), &made); err != nil {
		return err
	}
	if made.Visibility != visibility {
		return fmt.Errorf("GitHub created %s/%s as %s, not %s: change it in its settings before going on", owner, name, made.Visibility, visibility)
	}
	return nil
}

// Push pushes dir's main branch to the repository, signing git in with gh
// for this command only (your git config isn't changed).
func (g *GitHub) Push(ctx context.Context, dir, repo string) error {
	url := "https://github.com/" + repo + ".git"
	git := func(args ...string) error {
		return g.r.Run(ctx, "git", append([]string{"-C", dir,
			"-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"}, args...)...)
	}
	for _, step := range [][]string{
		{"init", "--quiet", "--initial-branch=main"},
		{"add", "--all"},
		{"commit", "--quiet", "-m", "A new catalog, from vertra"},
		{"push", "--quiet", url, "main"},
	} {
		if err := git(step...); err != nil {
			return err
		}
	}
	return nil
}

// SetVariable sets a repository variable.
func (g *GitHub) SetVariable(ctx context.Context, repo, name, value string) error {
	return g.r.Run(ctx, "gh", "variable", "set", name, "--repo", repo, "--body", value)
}

// DeleteSecret deletes a repository secret, or an Environment's with env;
// one that isn't there is fine.
func (g *GitHub) DeleteSecret(ctx context.Context, repo, env, name string) error {
	path := "/repos/" + repo + "/actions/secrets/" + name
	if env != "" {
		path = "/repos/" + repo + "/environments/" + env + "/secrets/" + name
	}
	_, err := g.api(ctx, "DELETE", path, "")
	if err != nil && (strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "Not Found")) {
		return nil
	}
	return err
}

// RepositorySecrets are the names of the repository-level Actions secrets:
// every workflow run gets them, a pull request's from a branch of the
// repository included (one that edits a workflow can print them). Only a
// main-only Environment keeps a secret from pull requests.
func (g *GitHub) RepositorySecrets(ctx context.Context, repo string) ([]string, error) {
	body, err := g.api(ctx, "GET", "/repos/"+repo+"/actions/secrets?per_page=100", "")
	if err != nil {
		return nil, err
	}
	var list struct {
		Secrets []struct {
			Name string `json:"name"`
		} `json:"secrets"`
	}
	if err := json.Unmarshal([]byte(body), &list); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(list.Secrets))
	for _, s := range list.Secrets {
		names = append(names, s.Name)
	}
	return names, nil
}

// CreateEnvironment creates an Environment limited to the main branch,
// with reviewers (user ids) when given. It fails where the plan has no
// Environments (a private repository on GitHub Free).
func (g *GitHub) CreateEnvironment(ctx context.Context, repo, name string, reviewers []int64) error {
	spec := map[string]any{
		"deployment_branch_policy": map[string]any{"protected_branches": false, "custom_branch_policies": true},
	}
	if len(reviewers) > 0 {
		var rs []map[string]any
		for _, id := range reviewers {
			rs = append(rs, map[string]any{"type": "User", "id": id})
		}
		spec["reviewers"] = rs
	}
	body, _ := json.Marshal(spec)
	if _, err := g.api(ctx, "PUT", "/repos/"+repo+"/environments/"+name, string(body)); err != nil {
		return err
	}
	branch, _ := json.Marshal(map[string]string{"name": "main", "type": "branch"})
	_, err := g.api(ctx, "POST", "/repos/"+repo+"/environments/"+name+"/deployment-branch-policies", string(branch))
	return err
}

// UserID is a user's numeric id (for Environment reviewers).
func (g *GitHub) UserID(ctx context.Context, login string) (int64, error) {
	body, err := g.api(ctx, "GET", "/users/"+login, "")
	if err != nil {
		return 0, err
	}
	var u struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal([]byte(body), &u); err != nil {
		return 0, err
	}
	return u.ID, nil
}

// Run is one workflow run.
type Run struct {
	ID         int64  `json:"databaseId"`
	Workflow   string `json:"workflowName"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	URL        string `json:"url"`
	Event      string `json:"event"`
}

// Runs lists the workflow runs for a commit.
func (g *GitHub) Runs(ctx context.Context, repo, commit string) ([]Run, error) {
	out, err := g.r.Output(ctx, "gh", "run", "list", "--repo", repo, "--commit", commit,
		"--json", "databaseId,workflowName,status,conclusion,url,event")
	if err != nil {
		return nil, err
	}
	var runs []Run
	if err := json.Unmarshal([]byte(out), &runs); err != nil {
		return nil, err
	}
	return runs, nil
}

// Dispatch starts a workflow by hand (its workflow_dispatch) on a branch.
func (g *GitHub) Dispatch(ctx context.Context, repo, workflow, branch string) error {
	return g.r.Run(ctx, "gh", "workflow", "run", workflow, "--repo", repo, "--ref", branch)
}

// Head is a branch's latest commit.
func (g *GitHub) Head(ctx context.Context, repo, branch string) (string, error) {
	body, err := g.api(ctx, "GET", "/repos/"+repo+"/commits/"+branch, "")
	if err != nil {
		return "", err
	}
	var c struct {
		SHA string `json:"sha"`
	}
	if err := json.Unmarshal([]byte(body), &c); err != nil {
		return "", err
	}
	return c.SHA, nil
}

// HasBranches reports whether the repository has any commit yet.
func (g *GitHub) HasBranches(ctx context.Context, repo string) (bool, error) {
	body, err := g.api(ctx, "GET", "/repos/"+repo+"/branches", "")
	if err != nil {
		return false, err
	}
	return hasItems(body)
}

// hasItems reports whether a JSON array has anything in it.
func hasItems(body string) (bool, error) {
	var items []json.RawMessage
	if err := json.Unmarshal([]byte(body), &items); err != nil {
		return false, err
	}
	return len(items) > 0, nil
}

// Rerun reruns a workflow run's failed jobs.
func (g *GitHub) Rerun(ctx context.Context, repo string, id int64) error {
	return g.r.Run(ctx, "gh", "run", "rerun", fmt.Sprint(id), "--failed", "--repo", repo)
}

// Variable is a repository variable's value, and whether it's set.
func (g *GitHub) Variable(ctx context.Context, repo, name string) (string, bool, error) {
	body, err := g.api(ctx, "GET", "/repos/"+repo+"/actions/variables/"+name, "")
	if err != nil && (strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "Not Found")) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	var v struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return "", false, fmt.Errorf("GitHub's variable %s: %w", name, err)
	}
	return v.Value, true, nil
}

// DeleteVariable removes a repository variable; one that isn't there is fine.
func (g *GitHub) DeleteVariable(ctx context.Context, repo, name string) error {
	_, err := g.api(ctx, "DELETE", "/repos/"+repo+"/actions/variables/"+name, "")
	if err != nil && (strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "Not Found")) {
		return nil
	}
	return err
}

// SubjectClaimKeys is the subject template vertra sets on a catalog
// repository: the job's context (its branch, or its Environment) and its
// branch, so a job in an Environment says which branch it ran from too.
var SubjectClaimKeys = []string{"repo", "context", "ref"}

// EnsureSubjectTemplate has the repository's Actions OIDC tokens carry
// SubjectClaimKeys in their subject, unless they already do: a role
// trusting a job of the catalog-publish Environment can then require main
// as well, whether or not the Environment exists with its main-only rule
// (GitHub makes one a workflow names, unprotected, where the plan has
// Environments). It says whether it changed anything.
func (g *GitHub) EnsureSubjectTemplate(ctx context.Context, repo string) (bool, error) {
	current, err := g.api(ctx, "GET", "/repos/"+repo+"/actions/oidc/customization/sub", "")
	if err != nil {
		return false, err
	}
	if set, err := subjectTemplateSet(current); err != nil || set {
		return false, err
	}
	body, err := json.Marshal(map[string]any{"use_default": false, "include_claim_keys": SubjectClaimKeys})
	if err != nil {
		return false, err
	}
	if _, err := g.api(ctx, "PUT", "/repos/"+repo+"/actions/oidc/customization/sub", string(body)); err != nil {
		return false, err
	}
	return true, nil
}

// subjectTemplateSet reads GitHub's answer for a repository's subject
// template: whether its tokens carry exactly SubjectClaimKeys, in order.
func subjectTemplateSet(body string) (bool, error) {
	var sub struct {
		UseDefault       bool     `json:"use_default"`
		IncludeClaimKeys []string `json:"include_claim_keys"`
	}
	if err := json.Unmarshal([]byte(body), &sub); err != nil {
		return false, fmt.Errorf("GitHub's subject template answer: %w", err)
	}
	return !sub.UseDefault && slices.Equal(sub.IncludeClaimKeys, SubjectClaimKeys), nil
}

// SubjectPrefix is how GitHub names the repository in its Actions OIDC
// tokens' subject: repo:<owner>/<name>, or with immutable subjects
// repo:<owner>@<id>/<name>@<id>.
func (g *GitHub) SubjectPrefix(ctx context.Context, repo string) (string, error) {
	body, err := g.api(ctx, "GET", "/repos/"+repo+"/actions/oidc/customization/sub", "")
	if err != nil {
		return "", err
	}
	var sub struct {
		SubClaimPrefix string `json:"sub_claim_prefix"`
	}
	if err := json.Unmarshal([]byte(body), &sub); err != nil {
		return "", err
	}
	if sub.SubClaimPrefix == "" {
		return "repo:" + repo, nil
	}
	return sub.SubClaimPrefix, nil
}
