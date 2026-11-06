// SPDX-License-Identifier: MIT

package policy

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	catalogv1 "github.com/rburns629/vennir/kernel/internal/gen/vennir/catalog/v1"
)

// UnregisteredServiceAccount is what a step that isn't a product's release
// runs as, with no Secrets and no tokens.
const UnregisteredServiceAccount = "default"

// AWSAudience is AWS STS's, what the gateway's awsSigV4 credentials ask for
// (gateway/internal/credentials.AWSAudience).
const AWSAudience = "sts.amazonaws.com"

// MaxMapChars is the most characters one of the sixteen maps may hold: the
// API server compiles at most 100,000 per CEL expression, and this leaves
// room for the rest (console/src/productPolicy.ts's MAX_MAP_CHARS).
const MaxMapChars = 95_000

// MaxIdentityChars and MaxAudienceChars are the most all sixteen maps of
// each policy may hold. Less than the console's 600,000 a policy: Helm's
// release Secret for the kernel chart (under 1 MiB) keeps these beside the
// console's identity policy and the scan policy, all re-encoded by the
// upgrade seed. Measured 2026-11-06 with every list at its most (the
// console's identity policy too, as while both write): about 680 KB of
// the Secret for the literals, plus about 140 KB for the rest of the
// release. Still about 1,700 product (digest, action) pairs, and 1,500 API
// ServiceAccounts.
const (
	MaxIdentityChars = 400_000
	MaxAudienceChars = 300_000
)

// MaxTokenAudiences is the most a product may declare (tokenAudiences.ts).
const MaxTokenAudiences = 8

// Digits are the sixteen maps' names' last characters.
var Digits = strings.Split("0123456789abcdef", "")

// esoServiceAccounts are the ServiceAccounts ESO reads a team's vault as,
// which no step runs as (identity policy, console/src/core/products.ts).
var esoServiceAccounts = []string{"eso-gcp", "eso-aws", "eso-azure"}

// kubernetesAudiences are the Kubernetes API's own audiences.
var kubernetesAudiences = []string{
	"https://kubernetes.default.svc",
	"https://kubernetes.default.svc.cluster.local",
	"kubernetes.default.svc",
	"kubernetes.default.svc.cluster.local",
}

var (
	pinnedDigest = regexp.MustCompile(`@(sha256:[a-f0-9]{64})$`)
	apiKey       = regexp.MustCompile(`^[a-z0-9-]+/[a-z0-9.-]+$`)
	kubeName     = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	notFileName  = regexp.MustCompile(`[^A-Za-z0-9._-]`)
)

// Entry is one product a released digest is a release of, as the policy's
// CEL matches a step against it (and as console/src/productPolicy.ts writes
// it): the team (its namespace), the image's repository, the action, the
// ServiceAccount it runs as, and its token audiences, comma-separated. Its
// fields in byte order, as Helm's toJson writes a map, so the chart's
// upgrade seed re-encodes what this wrote unchanged.
type Entry struct {
	Action         string `json:"action"`
	Audiences      string `json:"audiences"`
	Repository     string `json:"repository"`
	ServiceAccount string `json:"serviceAccount"`
	Team           string `json:"team"`
}

// Release is an Entry at its digest: one row of catalog_policy_releases.
type Release struct {
	Digest string
	Entry
	// ReleasedUntil is when a release stopped naming it; nil while the
	// release applied names it.
	ReleasedUntil *time.Time
	// Signers are the signers (Signers.IDs) that verified its release.
	Signers []string
}

// TrustedBy says whether any of these signers (that verified something) is
// one trusted now.
func TrustedBy(signers, trusted []string) bool {
	for _, s := range signers {
		for _, t := range trusted {
			if s == t {
				return true
			}
		}
	}
	return false
}

// TrustedReleases are the releases one of the signers trusted now verified:
// only those are listed, whatever's recorded.
func TrustedReleases(releases []Release, trusted []string) []Release {
	var out []Release
	for _, r := range releases {
		if TrustedBy(r.Signers, trusted) {
			out = append(out, r)
		}
	}
	return out
}

// API is what one of the release's APIs needs minted: its ServiceAccount
// (team/serviceAccount) and its backend's sign-in, before the install's
// settings say what audiences that means.
type API struct {
	Team           string `json:"team"`
	ServiceAccount string `json:"serviceAccount"`
	// Kind is backend.auth's: serviceAccountToken, awsSigV4, googleIdToken,
	// or "" (none).
	Kind     string `json:"kind"`
	Audience string `json:"audience,omitempty"`
}

// Use is a step as the policy matches it: an unfinished task that keeps a
// release listed while it runs it.
type Use struct {
	Digest, Team, Repository, Action, ServiceAccount string
}

// Problem is something in the release that wasn't listed, and why.
type Problem struct {
	Item    string
	Message string
}

// NormalizedImage is an image as the kubelet reads it (and the policies'
// CEL, and console/src/imageRef.ts): a bare name is Docker Hub's library's.
func NormalizedImage(image string) string {
	first, _, hasSlash := strings.Cut(image, "/")
	switch {
	case hasSlash && (strings.ContainsAny(first, ".:") || first == "localhost" || strings.ToLower(first) != first):
		return image
	case hasSlash:
		return "docker.io/" + image
	default:
		return "docker.io/library/" + image
	}
}

// Repository is an image's repository: normalized, its digest and then its
// tag off.
func Repository(image string) string {
	unpinned, _, _ := strings.Cut(NormalizedImage(image), "@")
	if colon := strings.LastIndex(unpinned, ":"); colon > strings.LastIndex(unpinned, "/") {
		return unpinned[:colon]
	}
	return unpinned
}

// DigestOf is an image's pinned digest, "" when it isn't pinned to one.
func DigestOf(image string) string {
	if m := pinnedDigest.FindStringSubmatch(image); m != nil {
		return m[1]
	}
	return ""
}

// UseOf is a task as the policy would match its Job; false when its image
// isn't pinned (no release is, then).
func UseOf(image, team, action, serviceAccount string) (Use, bool) {
	digest := DigestOf(NormalizedImage(image))
	if digest == "" {
		return Use{}, false
	}
	if serviceAccount == "" {
		serviceAccount = UnregisteredServiceAccount
	}
	return Use{Digest: digest, Team: team, Repository: Repository(image), Action: action, ServiceAccount: serviceAccount}, true
}

// Reserved says whether an audience is this cluster's own: the Kubernetes
// API's, its ServiceAccount issuer's, or kernel-api's.
type Reserved func(audience string) bool

// ReservedAudiences are the Kubernetes API's audiences and these (the
// issuer's, read from this process's own token; kernel-api's).
func ReservedAudiences(extra ...string) Reserved {
	set := map[string]bool{}
	for _, a := range append(slices.Clone(kubernetesAudiences), extra...) {
		if a != "" {
			set[a] = true
		}
	}
	return func(audience string) bool { return set[audience] }
}

// TokenAudiences are the audiences of the ServiceAccount token in file (a
// Pod's own: its cluster issuer's), none when there's no file.
func TokenAudiences(file string) ([]string, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.TrimSpace(string(data)), ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("%s isn't a JWT", file)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("%s isn't a JWT: %w", file, err)
	}
	var claims struct {
		Audience json.RawMessage `json:"aud"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("%s isn't a JWT: %w", file, err)
	}
	var one string
	if json.Unmarshal(claims.Audience, &one) == nil {
		return []string{one}, nil
	}
	// Its issuer's audience must be reserved: a token we can't read it from
	// is an error, not "none".
	var many []string
	if err := json.Unmarshal(claims.Audience, &many); err != nil || len(many) == 0 {
		return nil, fmt.Errorf("%s has no audience (aud) a string or a list of strings", file)
	}
	return many, nil
}

// cloudFederationAudience says whether a cloud exchanges a token with this
// audience for an identity (console/src/tokenAudiences.ts).
func cloudFederationAudience(audience string) bool {
	a := strings.ToLower(audience)
	return a == AWSAudience || a == "api://azureadtokenexchange" || strings.HasSuffix(a, ".svc.id.goog") ||
		strings.HasPrefix(a, "identitynamespace:") || strings.HasPrefix(a, "//iam.googleapis.com/") ||
		strings.HasPrefix(a, "https://iam.googleapis.com/")
}

// tokenFileName is where a step finds an audience's token (as
// tokenAudiences.ts names it): two audiences may not share one.
func tokenFileName(audience string) string {
	return notFileName.ReplaceAllString(audience, "_")
}

// audienceProblem is why a product may not declare these token audiences,
// as the console refuses them (tokenAudienceProblems); "" when it may.
func audienceProblem(audiences []string, reserved Reserved) string {
	if len(audiences) > MaxTokenAudiences {
		return fmt.Sprintf("at most %d token audiences", MaxTokenAudiences)
	}
	files := map[string]bool{}
	for _, a := range audiences {
		switch {
		case a == "" || strings.TrimSpace(a) != a || strings.ContainsAny(a, " \t\r\n,"):
			return fmt.Sprintf("token audience %q may not be empty or hold spaces or commas", a)
		case reserved(a):
			return fmt.Sprintf("token audience %q is this cluster's own", a)
		}
		file := tokenFileName(a)
		if file == "." || file == ".." || files[file] {
			return fmt.Sprintf("token audience %q can't be a file name of its own", a)
		}
		files[file] = true
	}
	return ""
}

// Releases are the product releases a catalog release names, each as the
// policy lists it, and what it leaves out (and why). Left out, as the
// console refuses to register them: an action whose image isn't pinned, of
// no team, or in no team the release names; one running as an API's
// ServiceAccount (-api), ESO's, or a name Kubernetes wouldn't take; one
// whose token audiences the console refuses (this cluster's own, more than
// eight, malformed); and every product of a repository two teams' products
// claim, or of a ServiceAccount two of a team's repositories run as (a
// product runs as its own).
func Releases(release *catalogv1.Release, reserved Reserved) ([]Release, []Problem) {
	var problems []Problem
	teams := map[string]bool{}
	for _, t := range release.GetTeams() {
		teams[t.GetName()] = true
	}
	type candidate struct {
		name string
		Release
	}
	var candidates []candidate
	for _, p := range release.GetProducts() {
		item := "product " + p.GetName()
		image := NormalizedImage(p.GetImage())
		digest := DigestOf(image)
		serviceAccount := p.GetServiceAccount()
		if serviceAccount == "" {
			serviceAccount = UnregisteredServiceAccount
		}
		var message string
		switch {
		case digest == "":
			message = "its image isn't pinned to a digest"
		case p.GetTeam() == "" || !teams[p.GetTeam()]:
			message = fmt.Sprintf("its team %q isn't one of the release's teams", p.GetTeam())
		case !kubeName.MatchString(serviceAccount) || len(serviceAccount) > 63:
			message = fmt.Sprintf("its serviceAccount %q isn't a Kubernetes name", serviceAccount)
		case strings.HasSuffix(serviceAccount, "-api"):
			message = fmt.Sprintf("its serviceAccount %s is an API's (it ends in -api)", serviceAccount)
		case slices.Contains(esoServiceAccounts, serviceAccount):
			message = fmt.Sprintf("its serviceAccount %s is the one ESO reads the team's vault as", serviceAccount)
		default:
			message = audienceProblem(p.GetTokenAudiences(), reserved)
		}
		if message != "" {
			problems = append(problems, Problem{Item: item, Message: message})
			continue
		}
		candidates = append(candidates, candidate{name: p.GetName(), Release: Release{Digest: digest, Entry: Entry{
			Team: p.GetTeam(), Repository: Repository(image), Action: p.GetAction(), ServiceAccount: serviceAccount,
			Audiences: strings.Join(p.GetTokenAudiences(), ","),
		}}})
	}
	// Who claims what: a repository is one team's; a ServiceAccount (but
	// default) one repository's, within its team.
	repositoryTeams := map[string]map[string]bool{}
	accountRepositories := map[string]map[string]bool{}
	for _, c := range candidates {
		add(repositoryTeams, c.Repository, c.Team)
		if c.ServiceAccount != UnregisteredServiceAccount {
			add(accountRepositories, c.Team+"/"+c.ServiceAccount, c.Repository)
		}
	}
	var releases []Release
	seen := map[string]bool{}
	for _, c := range candidates {
		if n := len(repositoryTeams[c.Repository]); n > 1 {
			problems = append(problems, Problem{Item: "product " + c.name,
				Message: fmt.Sprintf("its repository %s is claimed by %d teams' products", c.Repository, n)})
			continue
		}
		if n := len(accountRepositories[c.Team+"/"+c.ServiceAccount]); c.ServiceAccount != UnregisteredServiceAccount && n > 1 {
			problems = append(problems, Problem{Item: "product " + c.name,
				Message: fmt.Sprintf("its serviceAccount %s is run as by %d of team %s's products", c.ServiceAccount, n, c.Team)})
			continue
		}
		key := c.Digest + "\x00" + mustJSON(c.Entry)
		if !seen[key] {
			seen[key] = true
			releases = append(releases, c.Release)
		}
	}
	return releases, problems
}

func add(m map[string]map[string]bool, key, value string) {
	if m[key] == nil {
		m[key] = map[string]bool{}
	}
	m[key][value] = true
}

// APIs are what the release's APIs need minted, as the console stores them
// (catalogSync.ts's applyApis), and what it leaves out: an API whose
// ServiceAccount isn't an API's (-api), of no team the release names.
func APIs(release *catalogv1.Release) ([]API, []Problem) {
	teams := map[string]bool{}
	for _, t := range release.GetTeams() {
		teams[t.GetName()] = true
	}
	var apis []API
	var problems []Problem
	for _, a := range release.GetApis() {
		item := fmt.Sprintf("api %s/%s", a.GetTeam(), a.GetName())
		key := a.GetTeam() + "/" + a.GetServiceAccount()
		switch {
		case !teams[a.GetTeam()]:
			problems = append(problems, Problem{Item: item, Message: fmt.Sprintf("its team %q isn't one of the release's teams", a.GetTeam())})
			continue
		case !strings.HasSuffix(a.GetServiceAccount(), "-api") || !apiKey.MatchString(key):
			problems = append(problems, Problem{Item: item, Message: fmt.Sprintf("its serviceAccount %q must be a name ending in -api", a.GetServiceAccount())})
			continue
		}
		api := API{Team: a.GetTeam(), ServiceAccount: a.GetServiceAccount()}
		switch kind := a.GetBackendAuth().GetKind().(type) {
		case *catalogv1.BackendAuth_ServiceAccountToken:
			api.Kind, api.Audience = "serviceAccountToken", kind.ServiceAccountToken.GetAudience()
		case *catalogv1.BackendAuth_AwsSigV4:
			api.Kind = "awsSigV4"
		case *catalogv1.BackendAuth_GoogleIdToken:
			api.Kind = "googleIdToken"
		}
		apis = append(apis, api)
	}
	return apis, problems
}

// Audiences are the audiences each API ServiceAccount ("<namespace>/
// <serviceAccount>") may be minted, as console/src/gatewayTokenPolicy.ts's
// backendAudiences: a serviceAccountToken backend's own audience (never
// this cluster's, one a cloud federates, or the install's Google pool's),
// AWS STS's for awsSigV4, and the install's Google pool's (gcpAudience, the
// console chart's gateway.gcp.tokenAudience) for googleIdToken. Two APIs on
// one ServiceAccount share both's.
func Audiences(apis []API, gcpAudience string, reserved Reserved) map[string][]string {
	sets := map[string]map[string]bool{}
	for _, a := range apis {
		var audiences []string
		switch a.Kind {
		case "serviceAccountToken":
			if a.Audience != "" && !reserved(a.Audience) && !cloudFederationAudience(a.Audience) && a.Audience != gcpAudience {
				audiences = []string{a.Audience}
			}
		case "awsSigV4":
			audiences = []string{AWSAudience}
		case "googleIdToken":
			if gcpAudience != "" {
				audiences = []string{gcpAudience}
			}
		}
		key := a.Team + "/" + a.ServiceAccount
		for _, audience := range audiences {
			add(sets, key, audience)
		}
	}
	out := map[string][]string{}
	for key, set := range sets {
		list := make([]string, 0, len(set))
		for audience := range set {
			list = append(list, audience)
		}
		sort.Strings(list)
		out[key] = list
	}
	return out
}

// Kept says whether a release is still listed: the applied release names
// it, it stopped naming it less than grace ago, or an unfinished task runs
// it as that product (its team, repository, action and ServiceAccount;
// another product released at the same digest doesn't count) in an
// execution submitted before a release stopped naming it. One submitted
// after (during the grace) keeps nothing: it can't hold a dropped release
// open. inUse carries each use's earliest submission, from executions
// recent enough to count at all (Store.InUse's bound).
func Kept(r Release, inUse map[Use]time.Time, now time.Time, grace time.Duration) bool {
	if r.ReleasedUntil == nil || now.Sub(*r.ReleasedUntil) < grace {
		return true
	}
	submitted, ok := inUse[Use{Digest: r.Digest, Team: r.Team, Repository: r.Repository, Action: r.Action, ServiceAccount: r.ServiceAccount}]
	return ok && !submitted.After(*r.ReleasedUntil)
}

// Listed are the releases the identity policy lists now (Kept), by digest.
func Listed(releases []Release, inUse map[Use]time.Time, now time.Time, grace time.Duration) map[string][]Entry {
	listed := map[string][]Entry{}
	seen := map[string]bool{}
	for _, r := range releases {
		if !Kept(r, inUse, now, grace) {
			continue
		}
		key := r.Digest + "\x00" + mustJSON(r.Entry)
		if seen[key] {
			continue
		}
		seen[key] = true
		listed[r.Digest] = append(listed[r.Digest], r.Entry)
	}
	for digest, entries := range listed {
		sort.Slice(entries, func(i, j int) bool { return mustJSON(entries[i]) < mustJSON(entries[j]) })
		listed[digest] = entries
	}
	return listed
}

// IdentityVariables are the identity policy's sixteen maps (releases0 to
// releasesf, by the digest's first hex digit), as JSON literals; an error
// when they'd be over what the policy holds, so nothing is written.
func IdentityVariables(listed map[string][]Entry) (map[string]string, error) {
	shards := map[string]map[string][]Entry{}
	for _, d := range Digits {
		shards[d] = map[string][]Entry{}
	}
	for digest, entries := range listed {
		shards[digest[7:8]][digest] = entries
	}
	return literals("releases", shards, "the product releases in use", MaxIdentityChars)
}

// AudienceVariables are the gateway token policy's sixteen maps
// (apiAudiences0 to apiAudiencesf, by the key's length modulo 16, as its
// CEL reads them), as JSON literals; an error when they'd be over what it
// holds.
func AudienceVariables(audiences map[string][]string) (map[string]string, error) {
	shards := map[string]map[string][]string{}
	for _, d := range Digits {
		shards[d] = map[string][]string{}
	}
	for key, list := range audiences {
		shards[Digits[len(key)%16]][key] = list
	}
	return literals("apiAudiences", shards, "the API ServiceAccounts' audiences", MaxAudienceChars)
}

func literals[V any](prefix string, shards map[string]map[string]V, what string, max int) (map[string]string, error) {
	out := map[string]string{}
	total := 0
	for _, d := range Digits {
		literal := mustJSON(shards[d])
		if len(literal) > MaxMapChars {
			return nil, fmt.Errorf("%s in map %s take %d characters, more than one map holds (%d)", what, d, len(literal), MaxMapChars)
		}
		total += len(literal)
		out[prefix+d] = literal
	}
	if total > max {
		return nil, fmt.Errorf("%s take %d characters, more than the policy holds (%d)", what, total, max)
	}
	return out, nil
}

// mustJSON is Go's encoding of a value of this package's (maps with keys in
// byte order, as Helm's toJson writes them, so the chart's upgrade seed
// re-encodes what this wrote unchanged), without HTML escaping.
func mustJSON(v any) string {
	var b bytes.Buffer
	encoder := json.NewEncoder(&b)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(v); err != nil {
		panic(err) // only this package's own types
	}
	return strings.TrimSuffix(b.String(), "\n")
}
