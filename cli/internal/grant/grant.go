// SPDX-License-Identifier: MIT

// Package grant is the catalog owner's side of an install reading its
// catalog (`vennir catalog grant`): read on the owner's catalog registry
// (its images and its release, nothing else) for exactly one reader's
// identity, with no key stored anywhere.
//
//   - A reader on another cloud, or in another AWS account, is its
//     cluster's OIDC identity: the console's ServiceAccount, and kernel
//     policy's when it verifies the catalog itself, from one issuer. On gcp
//     the owner's Workload Identity pool (vennir-installs) gets a provider
//     for that issuer accepting those subjects alone, each mapped to a
//     subject of the reader's own, and those principals read the
//     repository. On aws the account gets an IAM OIDC provider for the
//     issuer and a role (vennir-reader-<reader>) only they may
//     assume by web identity, which may read only the registry's
//     repositories: a role scoped to <prefix>/* covers every product
//     published later, where a repository policy would have to be added
//     to each repository ECR creates on its first push.
//   - A reader on Google Cloud reading an Artifact Registry is its own
//     service accounts (console, scanner, nodes, policy-controller's), each
//     given read on the repository.
//
// It reads what exists first and changes only what differs, so running it
// again does nothing; --revoke undoes it. Every change runs the cloud's own
// CLI as the owner, as an argument list (never a shell).
package grant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"strings"
)

// Exec runs a cloud CLI and returns its standard output; its error carries
// the CLI's standard error (run.Runner.Output).
type Exec func(ctx context.Context, name string, args ...string) (string, error)

// Reader is the install being granted.
type Reader struct {
	// Name names what the grant makes (the provider, the role): the
	// reader's cluster name.
	Name string
	// Issuer and Subject are a cluster's OIDC identity: its issuer, and
	// the console's ServiceAccount (system:serviceaccount:<ns>:<name>).
	Issuer, Subject string
	// PolicySubject is its kernel policy's ServiceAccount, which verifies
	// the catalog's release itself, when it does; trusted beside the
	// console's, never instead of it.
	PolicySubject string
	// ServiceAccounts are a reader's Google service accounts (gcp only).
	ServiceAccounts []string
}

var (
	readerName     = regexp.MustCompile(`^[a-z][a-z0-9-]{1,23}[a-z0-9]$`)
	issuerURL      = regexp.MustCompile(`^https://[a-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~-]+)*$`)
	saSubject      = regexp.MustCompile(`^system:serviceaccount:[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?:[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$`)
	serviceAccount = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}@[a-z0-9][a-z0-9.-]*\.gserviceaccount\.com$`)
)

// Pool is the owner's Workload Identity pool for reading installs (gcp).
const Pool = "vennir-installs"

// Federated says whether the reader is a cluster's OIDC identity.
func (r Reader) Federated() bool { return r.Issuer != "" }

// subjects are whom of the reader's cluster the grant trusts: its console,
// then its kernel policy when it has one.
func (r Reader) subjects() []string {
	if r.PolicySubject == "" {
		return []string{r.Subject}
	}
	return []string{r.Subject, r.PolicySubject}
}

// who says whom of the reader the grant trusts, for the screen.
func (r Reader) who() string {
	if r.PolicySubject == "" {
		return r.Name + "'s console"
	}
	return r.Name + "'s console and kernel policy"
}

// Validate checks the reader for an owner on target (gcp or aws).
func (r Reader) Validate(target string) error {
	var problems []string
	if !readerName.MatchString(r.Name) {
		problems = append(problems, fmt.Sprintf("--reader %q: 3 to 25 lowercase letters, digits and dashes (the reader's cluster name)", r.Name))
	}
	switch {
	case r.Issuer == "" && len(r.ServiceAccounts) == 0:
		problems = append(problems, "say who reads: --issuer and --subject (a cluster's OIDC identity), or --service-account (gcp)")
	case r.Issuer != "" && len(r.ServiceAccounts) > 0:
		problems = append(problems, "--issuer or --service-account, not both: one reader at a time")
	case r.Issuer != "":
		if !issuerURL.MatchString(r.Issuer) {
			problems = append(problems, fmt.Sprintf("--issuer %q isn't an https URL (the reader's cluster's OIDC issuer)", r.Issuer))
		}
		for _, s := range []struct{ flag, subject string }{{"--subject", r.Subject}, {"--policy-subject", r.PolicySubject}} {
			if s.subject == "" && s.flag == "--policy-subject" {
				continue
			}
			if !saSubject.MatchString(s.subject) {
				problems = append(problems, fmt.Sprintf("%s %q isn't system:serviceaccount:NAMESPACE:NAME", s.flag, s.subject))
			} else if len(gcpSubject(r, s.subject)) > 127 {
				problems = append(problems, fmt.Sprintf("--reader and %s are too long together (Google's subject is at most 127 characters)", s.flag))
			}
		}
		if r.PolicySubject != "" && r.PolicySubject == r.Subject {
			problems = append(problems, "--policy-subject is kernel policy's ServiceAccount, not the console's (--subject)")
		}
	default:
		if r.PolicySubject != "" {
			problems = append(problems, "--policy-subject is with --issuer and --subject: a reader on Google Cloud names kernel policy's service account with --service-account")
		}
		if target != "gcp" {
			problems = append(problems, "--service-account is for an owner on gcp; an aws owner trusts the reader's cluster (--issuer, --subject)")
		}
		for _, sa := range r.ServiceAccounts {
			if !serviceAccount.MatchString(sa) {
				problems = append(problems, fmt.Sprintf("--service-account %q isn't a Google service account's email", sa))
			}
		}
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "\n"))
	}
	return nil
}

// Action is one change, or (Args nil) what's already so.
type Action struct {
	Label, Text string
	Tool        string
	Args        []string
}

// Plan is what a grant (or revoke) finds and will do.
type Plan struct {
	Registry string
	// SignedIn is who runs it: the owner's own sign-in.
	SignedIn string
	// Identity is the reader's, as the owner's cloud names it.
	Identity string
	// Access is what that identity may do.
	Access  string
	Actions []Action
	Notes   []string
	// ReaderSets is what the reader sets in its vennir.yaml afterwards
	// (key and value), when anything.
	ReaderSets [2]string
}

// Changes says whether anything will run.
func (p *Plan) Changes() bool {
	for _, a := range p.Actions {
		if a.Args != nil {
			return true
		}
	}
	return false
}

// Apply runs the plan's changes in order, stopping at the first failure.
func (p *Plan) Apply(ctx context.Context, exec Exec, progress func(Action)) error {
	for _, a := range p.Actions {
		if a.Args == nil {
			continue
		}
		if progress != nil {
			progress(a)
		}
		if _, err := exec(ctx, a.Tool, a.Args...); err != nil {
			return err
		}
	}
	return nil
}

// notFound says whether a CLI's error is the cloud saying the thing
// doesn't exist (gcloud's NOT_FOUND, IAM's NoSuchEntity).
func notFound(err error) bool {
	s := err.Error()
	return strings.Contains(s, "NOT_FOUND") || strings.Contains(s, "NoSuchEntity") || strings.Contains(s, "was not found")
}

// --- gcp ----------------------------------------------------------------

// GCPOwner is the owner's side on Google Cloud.
type GCPOwner struct {
	// Project holds the pool.
	Project string
	// The repository: its project, region and name.
	RegistryProject, Region, Repository string
}

// ArtifactRegistry splits <region>-docker.pkg.dev/<project>/<repository>.
func ArtifactRegistry(registry string) (GCPOwner, error) {
	parts := strings.Split(registry, "/")
	region, ok := strings.CutSuffix(parts[0], "-docker.pkg.dev")
	if !ok || len(parts) != 3 {
		return GCPOwner{}, fmt.Errorf("%s isn't an Artifact Registry repository (<region>-docker.pkg.dev/<project>/<repository>)", registry)
	}
	return GCPOwner{RegistryProject: parts[1], Region: region, Repository: parts[2]}, nil
}

// ProviderID is the reader's provider in the pool: vennir-<reader>, as the
// commands earlier versions printed named it.
func ProviderID(r Reader) string {
	if strings.HasPrefix(r.Name, "vennir") {
		return r.Name
	}
	return "vennir-" + r.Name
}

// gcpSubject is a reader's subject in the pool: one of its ServiceAccounts
// (subject), prefixed with the reader, so two readers' consoles (the same
// ServiceAccount name in their own clusters) are two principals, each
// granted and revoked on its own.
func gcpSubject(r Reader, subject string) string {
	return r.Name + ":" + subject
}

// gcpCondition is the provider's: the reader's subjects alone.
func gcpCondition(r Reader) string {
	s := r.subjects()
	if len(s) == 1 {
		return fmt.Sprintf("assertion.sub=='%s'", s[0])
	}
	quoted := make([]string, len(s))
	for i, subject := range s {
		quoted[i] = "'" + subject + "'"
	}
	return "assertion.sub in [" + strings.Join(quoted, ", ") + "]"
}

const readerRole = "roles/artifactregistry.reader"

type iamPolicy struct {
	Bindings []struct {
		Role    string   `json:"role"`
		Members []string `json:"members"`
	} `json:"bindings"`
}

func (p iamPolicy) has(role, member string) bool {
	for _, b := range p.Bindings {
		if b.Role == role && slices.Contains(b.Members, member) {
			return true
		}
	}
	return false
}

type gcpProvider struct {
	State              string            `json:"state"`
	AttributeCondition string            `json:"attributeCondition"`
	AttributeMapping   map[string]string `json:"attributeMapping"`
	OIDC               struct {
		IssuerURI string `json:"issuerUri"`
	} `json:"oidc"`
}

// PlanGCP is the grant (or revoke) on an owner's Artifact Registry.
func PlanGCP(ctx context.Context, exec Exec, o GCPOwner, r Reader, revoke bool) (*Plan, error) {
	p := &Plan{Registry: fmt.Sprintf("%s-docker.pkg.dev/%s/%s", o.Region, o.RegistryProject, o.Repository),
		Access: readerRole + " on the repository " + o.Repository + " (its images and its release), nothing else"}
	p.SignedIn, _ = exec(ctx, "gcloud", "auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
	repo := []string{"--location=" + o.Region, "--project=" + o.RegistryProject}
	out, err := exec(ctx, "gcloud", append([]string{"artifacts", "repositories", "get-iam-policy", o.Repository, "--format=json"}, repo...)...)
	if err != nil {
		return nil, err
	}
	var policy iamPolicy
	if err := json.Unmarshal([]byte(orEmptyJSON(out)), &policy); err != nil {
		return nil, fmt.Errorf("the repository's IAM policy: %w", err)
	}
	binding := func(verb, member string) Action {
		return Action{Tool: "gcloud", Args: append([]string{"artifacts", "repositories", verb + "-iam-policy-binding", o.Repository,
			"--role=" + readerRole, "--member=" + member, "--format=none"}, repo...)}
	}
	readerAction := func(member string) {
		has := policy.has(readerRole, member)
		switch {
		case !revoke && !has:
			a := binding("add", member)
			a.Label, a.Text = "Will grant", "read on "+o.Repository+" to "+member
			p.Actions = append(p.Actions, a)
		case !revoke:
			p.Actions = append(p.Actions, Action{Label: "Has", Text: "read on " + o.Repository + ": " + member})
		case has:
			a := binding("remove", member)
			a.Label, a.Text = "Will remove", "read on "+o.Repository+" from "+member
			p.Actions = append(p.Actions, a)
		}
	}

	if !r.Federated() {
		members := make([]string, len(r.ServiceAccounts))
		for i, sa := range r.ServiceAccounts {
			members[i] = "serviceAccount:" + sa
			readerAction(members[i])
		}
		p.Identity = strings.Join(r.ServiceAccounts, ", ") + " (" + r.Name + "'s own service accounts)"
		return p, nil
	}

	number, err := exec(ctx, "gcloud", "projects", "describe", o.Project, "--format=value(projectNumber)")
	if err != nil {
		return nil, err
	}
	pool := []string{"--location=global", "--project=" + o.Project}
	providerID := ProviderID(r)
	poolName := fmt.Sprintf("projects/%s/locations/global/workloadIdentityPools/%s", number, Pool)
	var members []string
	for _, subject := range r.subjects() {
		members = append(members, fmt.Sprintf("principal://iam.googleapis.com/%s/subject/%s", poolName, gcpSubject(r, subject)))
	}
	p.Identity = fmt.Sprintf("%s from %s (%s), as %s", strings.Join(r.subjects(), " and "), r.Issuer, r.who(), strings.Join(members, " and "))

	poolState, err := exec(ctx, "gcloud", append([]string{"iam", "workload-identity-pools", "describe", Pool, "--format=value(state)"}, pool...)...)
	if err != nil && !notFound(err) {
		return nil, err
	} else if err != nil {
		poolState = ""
	}
	providerArgs := append([]string{"--workload-identity-pool=" + Pool}, pool...)
	out, err = exec(ctx, "gcloud", append([]string{"iam", "workload-identity-pools", "providers", "describe", providerID, "--format=json"}, providerArgs...)...)
	var provider *gcpProvider
	switch {
	case err != nil && !notFound(err):
		return nil, err
	case err == nil:
		provider = &gcpProvider{}
		if err := json.Unmarshal([]byte(out), provider); err != nil {
			return nil, fmt.Errorf("provider %s: %w", providerID, err)
		}
	}

	if revoke {
		for _, member := range members {
			readerAction(member)
		}
		if provider != nil && provider.State != "DELETED" {
			p.Actions = append(p.Actions, Action{Label: "Will delete", Text: "provider " + providerID + ": " + r.Name + "'s tokens are no longer accepted",
				Tool: "gcloud", Args: append([]string{"iam", "workload-identity-pools", "providers", "delete", providerID, "--quiet"}, providerArgs...)})
		}
		p.Notes = append(p.Notes, "The pool "+Pool+" stays, for other readers.")
		return p, nil
	}

	switch poolState {
	case "":
		p.Actions = append(p.Actions, Action{Label: "Will create", Text: "the Workload Identity pool " + Pool + " in " + o.Project + ", for installs reading the catalog",
			Tool: "gcloud", Args: append([]string{"iam", "workload-identity-pools", "create", Pool, "--display-name=Vennir installs", "--format=none"}, pool...)})
	case "DELETED":
		p.Actions = append(p.Actions, Action{Label: "Will restore", Text: "the deleted Workload Identity pool " + Pool,
			Tool: "gcloud", Args: append([]string{"iam", "workload-identity-pools", "undelete", Pool, "--format=none"}, pool...)})
	default:
		p.Actions = append(p.Actions, Action{Label: "Has", Text: "the Workload Identity pool " + Pool})
	}
	mapping := fmt.Sprintf(`google.subject="%s:"+assertion.sub`, r.Name)
	condition := gcpCondition(r)
	settings := []string{"--issuer-uri=" + r.Issuer, "--attribute-mapping=" + mapping, "--attribute-condition=" + condition, "--format=none"}
	trusts := "provider " + providerID + ": trusts " + r.Issuer + " for " + strings.Join(r.subjects(), " and ") + " alone"
	switch {
	case provider == nil:
		p.Actions = append(p.Actions, Action{Label: "Will create", Text: trusts,
			Tool: "gcloud", Args: append(append([]string{"iam", "workload-identity-pools", "providers", "create-oidc", providerID}, settings...), providerArgs...)})
	default:
		if provider.State == "DELETED" {
			p.Actions = append(p.Actions, Action{Label: "Will restore", Text: "the deleted provider " + providerID,
				Tool: "gcloud", Args: append([]string{"iam", "workload-identity-pools", "providers", "undelete", providerID, "--format=none"}, providerArgs...)})
		}
		if provider.OIDC.IssuerURI != r.Issuer || provider.AttributeCondition != condition || provider.AttributeMapping["google.subject"] != fmt.Sprintf(`"%s:"+assertion.sub`, r.Name) {
			p.Actions = append(p.Actions, Action{Label: "Will update", Text: trusts,
				Tool: "gcloud", Args: append(append([]string{"iam", "workload-identity-pools", "providers", "update-oidc", providerID}, settings...), providerArgs...)})
		} else if provider.State != "DELETED" {
			p.Actions = append(p.Actions, Action{Label: "Has", Text: trusts})
		}
	}
	for _, member := range members {
		readerAction(member)
	}
	// The commands earlier versions printed mapped the bare subject, shared
	// by every reader in the pool.
	if old := fmt.Sprintf("principal://iam.googleapis.com/%s/subject/%s", poolName, r.Subject); policy.has(readerRole, old) {
		p.Notes = append(p.Notes, "The repository also grants "+old+" (from the commands earlier versions printed): any provider in "+Pool+
			" that maps the bare subject reads through it. Once each reader is granted here, remove it: gcloud artifacts repositories remove-iam-policy-binding "+
			o.Repository+" --location="+o.Region+" --project="+o.RegistryProject+" --role="+readerRole+" --member="+old)
	}
	p.ReaderSets = [2]string{"externalCatalog.gcpWorkloadIdentityProvider", poolName + "/providers/" + providerID}
	return p, nil
}

func orEmptyJSON(s string) string {
	if strings.TrimSpace(s) == "" {
		return "{}"
	}
	return s
}

// --- aws ----------------------------------------------------------------

// AWSOwner is the owner's side on AWS.
type AWSOwner struct {
	Region string
	// Prefix is the task registry's ECR prefix (<prefix>/<team>/<product>,
	// <prefix>/catalog-release).
	Prefix string
	// Args adds the owner's profile and region to an aws command.
	Args func(a ...string) []string
}

// RoleName is the reader's role in the owner's account.
func RoleName(r Reader) string { return "vennir-reader-" + r.Name }

// PolicyName is the role's one inline policy.
const PolicyName = "read-catalog"

// ReadActions are what the role may do on the catalog's repositories:
// pull (manifests, layers), and list tags (a reader following versions).
var ReadActions = []string{
	"ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:ListImages",
}

type document struct {
	Version   string      `json:"Version"`
	Statement []statement `json:"Statement"`
}

type statement struct {
	Sid       string                    `json:"Sid,omitempty"`
	Effect    string                    `json:"Effect"`
	Principal map[string]string         `json:"Principal,omitempty"`
	Action    any                       `json:"Action"`
	Resource  any                       `json:"Resource,omitempty"`
	Condition map[string]map[string]any `json:"Condition,omitempty"`
}

func mustJSON(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(data)
}

// TrustPolicy lets the reader's console (and its kernel policy, when it
// has one), and nothing else, assume the role by web identity: a token its
// cluster issued for STS, naming one of those ServiceAccounts.
func TrustPolicy(providerArn string, r Reader) string {
	host := strings.TrimPrefix(r.Issuer, "https://")
	var sub any = r.Subject
	if r.PolicySubject != "" {
		sub = r.subjects()
	}
	return mustJSON(document{Version: "2012-10-17", Statement: []statement{{
		Sid: "ReaderConsole", Effect: "Allow", Principal: map[string]string{"Federated": providerArn},
		Action: "sts:AssumeRoleWithWebIdentity",
		Condition: map[string]map[string]any{"StringEquals": {
			host + ":aud": "sts.amazonaws.com",
			host + ":sub": sub,
		}},
	}}})
}

// ReadPolicy may sign in to ECR (a token that only reaches what the role
// may read) and read the catalog's repositories: its products' images and
// its release, and nothing else.
func ReadPolicy(partition, region, account, prefix string) string {
	return mustJSON(document{Version: "2012-10-17", Statement: []statement{
		{Sid: "SignIn", Effect: "Allow", Action: "ecr:GetAuthorizationToken", Resource: "*"},
		{Sid: "ReadTheCatalog", Effect: "Allow", Action: ReadActions,
			Resource: fmt.Sprintf("arn:%s:ecr:%s:%s:repository/%s/*", partition, region, account, prefix)},
	}})
}

// PlanAWS is the grant (or revoke) on an owner's ECR.
func PlanAWS(ctx context.Context, exec Exec, o AWSOwner, r Reader, revoke, replace bool) (*Plan, error) {
	if !r.Federated() {
		return nil, errors.New("an aws owner trusts the reader's cluster: --issuer and --subject")
	}
	out, err := exec(ctx, "aws", o.Args("sts", "get-caller-identity")...)
	if err != nil {
		return nil, err
	}
	var me struct{ Account, Arn string }
	if err := json.Unmarshal([]byte(out), &me); err != nil || me.Account == "" {
		return nil, fmt.Errorf("aws sts get-caller-identity said %q", out)
	}
	partition := "aws"
	if parts := strings.Split(me.Arn, ":"); len(parts) > 1 && parts[1] != "" {
		partition = parts[1]
	}
	host := strings.TrimPrefix(r.Issuer, "https://")
	providerArn := fmt.Sprintf("arn:%s:iam::%s:oidc-provider/%s", partition, me.Account, host)
	role := RoleName(r)
	roleArn := fmt.Sprintf("arn:%s:iam::%s:role/%s", partition, me.Account, role)
	p := &Plan{
		Registry: fmt.Sprintf("%s.dkr.ecr.%s.amazonaws.com/%s", me.Account, o.Region, o.Prefix),
		SignedIn: me.Arn,
		Identity: fmt.Sprintf("%s from %s (%s), assuming %s by web identity", strings.Join(r.subjects(), " and "), r.Issuer, r.who(), roleArn),
		Access:   "pull and list tags on " + o.Prefix + "/* (its images and its release), nothing else",
	}

	trust := TrustPolicy(providerArn, r)
	trusts := "only " + strings.Join(r.subjects(), " and ") + " from " + host + " may assume it"
	out, roleErr := exec(ctx, "aws", o.Args("iam", "get-role", "--role-name", role)...)
	if roleErr != nil && !notFound(roleErr) {
		return nil, roleErr
	}
	// The role is keyed by the reader's name alone, which another reader
	// may share (a cluster's default name is vennir): one trusting another
	// reader is left alone unless --replace says otherwise.
	var sameReader, sameTrust bool
	leaving := r.Name
	if roleErr == nil {
		var got struct {
			Role struct {
				AssumeRolePolicyDocument json.RawMessage
			}
		}
		if err := json.Unmarshal([]byte(out), &got); err != nil {
			return nil, fmt.Errorf("the role %s: %w", role, err)
		}
		has, who := trustedBy(got.Role.AssumeRolePolicyDocument)
		// This reader's: it trusts its console (with or without its kernel policy).
		sameReader = has.provider == providerArn && slices.Contains(has.subjects, r.Subject)
		if !sameReader {
			leaving = who
		}
		sameTrust = sameReader && sameJSON(got.Role.AssumeRolePolicyDocument, trust)
		if !sameReader && !replace {
			what := "replace its trust"
			if revoke {
				what = "delete it"
			}
			return nil, fmt.Errorf("the role %s lets %s assume it, not %s from %s: another reader's, of the same name? "+
				"Give this one another --reader, or --replace to %s anyway", role, who, r.Subject, host, what)
		}
	}
	if revoke {
		if roleErr == nil {
			policies, err := exec(ctx, "aws", o.Args("iam", "list-role-policies", "--role-name", role)...)
			if err != nil {
				return nil, err
			}
			if strings.Contains(policies, `"`+PolicyName+`"`) {
				p.Actions = append(p.Actions, Action{Label: "Will delete", Text: "the role's policy " + PolicyName,
					Tool: "aws", Args: o.Args("iam", "delete-role-policy", "--role-name", role, "--policy-name", PolicyName)})
			}
			p.Actions = append(p.Actions, Action{Label: "Will delete", Text: "the role " + role + ": " + leaving + " can no longer assume it",
				Tool: "aws", Args: o.Args("iam", "delete-role", "--role-name", role)})
		}
		p.Notes = append(p.Notes, "The OIDC provider for "+host+" stays: it lets nothing in by itself, and a role of another reader on the same cluster may use it. "+
			"Delete it when nothing trusts it: aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "+providerArn)
		return p, nil
	}

	out, err = exec(ctx, "aws", o.Args("iam", "get-open-id-connect-provider", "--open-id-connect-provider-arn", providerArn)...)
	switch {
	case err != nil && !notFound(err):
		return nil, err
	case err != nil:
		p.Actions = append(p.Actions, Action{Label: "Will create", Text: "an IAM OIDC provider for " + r.Issuer + " (audience sts.amazonaws.com)",
			Tool: "aws", Args: o.Args("iam", "create-open-id-connect-provider", "--url", r.Issuer, "--client-id-list", "sts.amazonaws.com",
				"--tags", "Key=vennir,Value=catalog-reader")})
	default:
		var provider struct{ ClientIDList []string }
		if err := json.Unmarshal([]byte(out), &provider); err != nil {
			return nil, fmt.Errorf("the OIDC provider for %s: %w", host, err)
		}
		if slices.Contains(provider.ClientIDList, "sts.amazonaws.com") {
			p.Actions = append(p.Actions, Action{Label: "Has", Text: "an IAM OIDC provider for " + r.Issuer})
		} else {
			p.Actions = append(p.Actions, Action{Label: "Will add", Text: "audience sts.amazonaws.com to the IAM OIDC provider for " + r.Issuer,
				Tool: "aws", Args: o.Args("iam", "add-client-id-to-open-id-connect-provider", "--open-id-connect-provider-arn", providerArn, "--client-id", "sts.amazonaws.com")})
		}
	}
	switch {
	case roleErr != nil:
		p.Actions = append(p.Actions, Action{Label: "Will create", Text: "the role " + role + ": " + trusts,
			Tool: "aws", Args: o.Args("iam", "create-role", "--role-name", role, "--assume-role-policy-document", trust,
				"--max-session-duration", "3600", "--description", "Vennir: "+r.Name+"'s console reads the catalog", "--tags", "Key=vennir,Value=catalog-reader")})
	case sameTrust:
		p.Actions = append(p.Actions, Action{Label: "Has", Text: "the role " + role + ": " + trusts})
	default:
		label := "Will set"
		if !sameReader {
			label = "Will replace"
		}
		p.Actions = append(p.Actions, Action{Label: label, Text: "the role " + role + "'s trust: " + trusts,
			Tool: "aws", Args: o.Args("iam", "update-assume-role-policy", "--role-name", role, "--policy-document", trust)})
	}
	policy := ReadPolicy(partition, o.Region, me.Account, o.Prefix)
	samePolicy := false
	if roleErr == nil {
		out, err := exec(ctx, "aws", o.Args("iam", "get-role-policy", "--role-name", role, "--policy-name", PolicyName)...)
		if err != nil && !notFound(err) {
			return nil, err
		}
		if err == nil {
			var got struct{ PolicyDocument json.RawMessage }
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				return nil, fmt.Errorf("the role %s's policy %s: %w", role, PolicyName, err)
			}
			samePolicy = sameJSON(got.PolicyDocument, policy)
		}
	}
	if samePolicy {
		p.Actions = append(p.Actions, Action{Label: "Has", Text: "its one policy, " + PolicyName + ": " + p.Access})
	} else {
		p.Actions = append(p.Actions, Action{Label: "Will set", Text: "its one policy, " + PolicyName + ": " + p.Access,
			Tool: "aws", Args: o.Args("iam", "put-role-policy", "--role-name", role, "--policy-name", PolicyName, "--policy-document", policy)})
	}
	p.ReaderSets = [2]string{"externalCatalog.awsRoleArn", roleArn}
	return p, nil
}

// trusted is whom a role's trust lets assume it: a provider's subjects.
type trusted struct {
	provider string
	subjects []string
}

// trustedBy reads whom a trust policy lets assume the role, when it's the
// one web-identity statement TrustPolicy writes, and says so for the screen.
func trustedBy(doc json.RawMessage) (trusted, string) {
	var policy struct {
		Statement []struct {
			Effect    string
			Principal struct{ Federated any }
			Action    any
			Condition map[string]map[string]any
		}
	}
	if json.Unmarshal(doc, &policy) == nil && len(policy.Statement) == 1 {
		st := policy.Statement[0]
		provider, _ := st.Principal.Federated.(string)
		for key, value := range st.Condition["StringEquals"] {
			host, ok := strings.CutSuffix(key, ":sub")
			var subjects []string
			switch v := value.(type) {
			case string:
				subjects = []string{v}
			case []any:
				for _, s := range v {
					if s, isString := s.(string); isString {
						subjects = append(subjects, s)
					}
				}
			}
			if ok && len(subjects) > 0 && provider != "" && st.Effect == "Allow" && st.Action == "sts:AssumeRoleWithWebIdentity" {
				return trusted{provider, subjects}, strings.Join(subjects, " and ") + " from " + host
			}
		}
	}
	return trusted{}, "a trust policy vennir didn't write"
}

// sameJSON says whether two JSON documents say the same, whatever their
// spacing and key order.
func sameJSON(a json.RawMessage, b string) bool {
	var x, y any
	return json.Unmarshal(a, &x) == nil && json.Unmarshal([]byte(b), &y) == nil && reflect.DeepEqual(x, y)
}
