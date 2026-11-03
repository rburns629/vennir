// SPDX-License-Identifier: MIT

package access

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// GCP is what the Google Cloud check found, beyond the report.
type GCP struct {
	Report
	Active   string   // the active gcloud account
	Accounts []string // every signed-in account
	// ADC is the account OpenTofu signs in as (application-default
	// credentials), when it can be told.
	ADC string
}

// GCPProject is one project you can use.
type GCPProject struct {
	ID   string `json:"projectId"`
	Name string `json:"name"`
}

// GCPProjects lists the projects the active account can see.
func GCPProjects(ctx context.Context, exec Exec) []GCPProject {
	out, err := exec(ctx, "gcloud", "projects", "list", "--format=json(projectId,name)", "--sort-by=projectId")
	if err != nil {
		return nil
	}
	var projects []GCPProject
	_ = json.Unmarshal([]byte(out), &projects)
	return projects
}

// TokenEmail is the account an access token belongs to (Google's tokeninfo).
type TokenEmail func(ctx context.Context, token string) string

// CheckGCP looks at the sign-ins, the project and its organization's rules.
func CheckGCP(ctx context.Context, exec Exec, tokenEmail TokenEmail, project, region string) *GCP {
	g := &GCP{}
	out, err := exec(ctx, "gcloud", "auth", "list", "--format=json(account,status)")
	var accounts []struct{ Account, Status string }
	if err == nil {
		_ = json.Unmarshal([]byte(out), &accounts)
	}
	for _, a := range accounts {
		g.Accounts = append(g.Accounts, a.Account)
		if a.Status == "ACTIVE" {
			g.Active = a.Account
		}
	}
	if g.Active == "" {
		g.problem("not signed in to Google Cloud", "`gcloud auth login`, then `gcloud auth application-default login` (OpenTofu uses the second)", "gcp.md#sign-in")
		return g
	}
	g.Identity = "gcp:" + g.Active
	signedIn := g.Active
	if len(g.Accounts) > 1 {
		signedIn += fmt.Sprintf(" (%d accounts signed in; gcloud uses this one: `gcloud config set account <email>` to change)", len(g.Accounts))
	}
	g.line("Signed in", signedIn)

	// OpenTofu signs in with application-default credentials, which can
	// belong to another account than gcloud's.
	if token, err := exec(ctx, "gcloud", "auth", "application-default", "print-access-token"); err != nil {
		g.problem("OpenTofu has no Google sign-in (application-default credentials)", "`gcloud auth application-default login`, as "+g.Active, "gcp.md#sign-in")
	} else if tokenEmail != nil {
		g.ADC = tokenEmail(ctx, strings.TrimSpace(token))
		if g.ADC != "" && g.ADC != g.Active {
			g.problem(fmt.Sprintf("gcloud is signed in as %s but OpenTofu as %s", g.Active, g.ADC),
				"`gcloud auth application-default login` as "+g.Active+" (or switch gcloud to "+g.ADC+")", "gcp.md#sign-in")
		}
	}
	if project == "" {
		return g
	}

	// What's in the project already: a dedicated one is safer.
	clusters := countLines(exec(ctx, "gcloud", "container", "clusters", "list", "--project", project, "--format=value(name)"))
	networks := countLines(exec(ctx, "gcloud", "compute", "networks", "list", "--project", project, "--format=value(name)", "--filter=name!=default"))
	switch {
	case clusters+networks > 0:
		g.line("Project", fmt.Sprintf("%s already holds %d cluster(s) and %d network(s) besides the default: Vertra only touches what it names after its cluster, but a project of its own is safer", project, clusters, networks))
	default:
		g.line("Project", project+" (nothing else in it)")
	}

	// The organization's rules that would stop an install.
	if locations := orgPolicyValues(ctx, exec, project, "constraints/gcp.resourceLocations"); len(locations) > 0 && region != "" {
		switch regionInLocations(locations, region) {
		case locationRefused:
			g.problem(fmt.Sprintf("your organization's policy allows only %s, not %s", strings.Join(locations, ", "), region),
				"choose a region it allows (`vertra config set gcp.region <region>`)", "gcp.md#organization-policies")
		case locationUnknown:
			g.line("Policy", fmt.Sprintf("your organization's policy allows only %s: Vertra can't tell whether that includes %s (if it doesn't, the apply stops at the first thing Google refuses to make there)",
				strings.Join(locations, ", "), region))
		}
	}
	if denied := orgPolicyDeniesAll(ctx, exec, project, "constraints/compute.vmExternalIpAccess"); denied {
		g.line("Policy", "your organization denies VMs external IP addresses: GKE's nodes need private nodes and Cloud NAT there, which the module doesn't make yet")
	}
	return g
}

func orgPolicyValues(ctx context.Context, exec Exec, project, constraint string) []string {
	out, err := exec(ctx, "gcloud", "resource-manager", "org-policies", "describe", constraint, "--project", project, "--effective", "--format=json")
	if err != nil {
		return nil
	}
	var p struct {
		ListPolicy struct {
			AllowedValues []string `json:"allowedValues"`
		} `json:"listPolicy"`
	}
	_ = json.Unmarshal([]byte(out), &p)
	return p.ListPolicy.AllowedValues
}

func orgPolicyDeniesAll(ctx context.Context, exec Exec, project, constraint string) bool {
	out, err := exec(ctx, "gcloud", "resource-manager", "org-policies", "describe", constraint, "--project", project, "--effective", "--format=json")
	if err != nil {
		return false
	}
	var p struct {
		ListPolicy struct {
			AllValues string `json:"allValues"`
		} `json:"listPolicy"`
	}
	_ = json.Unmarshal([]byte(out), &p)
	return p.ListPolicy.AllValues == "DENY"
}

type location int

const (
	locationAllowed location = iota
	locationRefused
	locationUnknown
)

// regionName is a region's name (us-central1, europe-west12), not a zone's
// or a multi-region's.
var regionName = regexp.MustCompile(`^[a-z]+-[a-z]+[0-9]+$`)

// prefixGroups are the value groups that hold the regions named with these
// prefixes. Groups named after a jurisdiction (in:eu-locations,
// in:canada-locations, in:japan-locations…) don't follow the regions' names,
// so they aren't here: what they hold can't be told from a region's name.
// Nor is asia: in:asia-locations leaves out asia-southeast3 (Bangkok, only
// in in:th-locations).
var prefixGroups = map[string][]string{
	"us":           {"us"},
	"europe":       {"europe"},
	"australia":    {"australia"},
	"northamerica": {"northamerica", "us"},
}

// regionInLocations reads resourceLocations values ("in:us-locations",
// "in:us-central1-locations", "us-central1"…). The region is allowed when a
// value surely holds it, refused only when every value surely doesn't, and
// otherwise unknown: a group it can't read is no reason to refuse.
func regionInLocations(values []string, region string) location {
	// A region named with one of prefixGroups' prefixes is in that group,
	// so the other prefix groups surely don't hold it.
	ownGroup := prefixGroups[strings.SplitN(region, "-", 2)[0]] != nil
	sure := regionName.MatchString(region)
	for _, v := range values {
		v = strings.TrimPrefix(strings.TrimPrefix(v, "is:"), "in:")
		group, isGroup := strings.CutSuffix(v, "-locations")
		switch {
		case group == region:
			return locationAllowed
		case regionName.MatchString(group):
			// Another region.
		case isGroup && prefixGroups[group] != nil:
			for _, p := range prefixGroups[group] {
				if strings.HasPrefix(region, p+"-") {
					return locationAllowed
				}
			}
			sure = sure && ownGroup
		default:
			// A zone, a multi-region, global, or a group not named after
			// regions.
			sure = false
		}
	}
	if sure {
		return locationRefused
	}
	return locationUnknown
}

func countLines(out string, err error) int {
	if err != nil {
		return 0
	}
	n := 0
	for _, l := range strings.Split(out, "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return n
}

// GoogleTokenEmail asks Google's tokeninfo whose a token is.
func GoogleTokenEmail(ctx context.Context, token string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://oauth2.googleapis.com/tokeninfo",
		strings.NewReader(url.Values{"access_token": {token}}.Encode()))
	if err != nil {
		return ""
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var info struct {
		Email string `json:"email"`
	}
	_ = json.Unmarshal(data, &info)
	return info.Email
}

// GitHub is who gh is signed in as.
type GitHub struct {
	Report
	Active   string
	Accounts []string
}

// CheckGitHub reads gh's sign-ins.
func CheckGitHub(ctx context.Context, exec Exec) *GitHub {
	g := &GitHub{}
	out, err := exec(ctx, "gh", "auth", "status", "--hostname", "github.com")
	if err != nil && out == "" {
		g.problem("not signed in to GitHub", "`gh auth login --scopes repo,workflow`", "github.md#sign-in")
		return g
	}
	g.Accounts, g.Active = parseGHStatus(out)
	if g.Active == "" {
		g.problem("not signed in to GitHub", "`gh auth login --scopes repo,workflow`", "github.md#sign-in")
		return g
	}
	g.Identity = "github:" + g.Active
	text := g.Active
	if len(g.Accounts) > 1 {
		var others []string
		for _, a := range g.Accounts {
			if a != g.Active {
				others = append(others, a)
			}
		}
		text += " (also signed in: " + strings.Join(others, ", ") + "; `gh auth switch` to change)"
	}
	g.line("GitHub", text)
	return g
}

// parseGHStatus reads `gh auth status`: every account, and the active one.
func parseGHStatus(out string) (accounts []string, active string) {
	current := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if i := strings.Index(line, "Logged in to github.com account "); i >= 0 {
			current = strings.Fields(line[i+len("Logged in to github.com account "):])[0]
			accounts = append(accounts, current)
		}
		if strings.Contains(line, "Active account: true") && current != "" {
			active = current
		}
	}
	return accounts, active
}
