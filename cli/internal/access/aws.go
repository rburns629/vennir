// SPDX-License-Identifier: MIT

package access

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// AWSRegions are the regions offered when choosing one: those every account
// has without opting in. A region the account opted in to is asked too when
// it's the one chosen.
var AWSRegions = []string{
	"us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1",
	"eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
	"ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "sa-east-1",
}

// AWS is what the AWS check found, beyond the report.
type AWS struct {
	Report
	Account   string
	Principal string // arn
	Root      bool
	// Allowed are the regions that answered; Denied, those an organization's
	// policy refuses (with the policy).
	Allowed []string
	Denied  map[string]string
	Budgets int
	// BudgetsUnread: describe-budgets failed (no budgets:ViewBudget, or an
	// organization's policy), so Budgets says nothing.
	BudgetsUnread bool
}

type awsCLI struct {
	exec    Exec
	profile string
}

func (a awsCLI) call(ctx context.Context, region string, args ...string) (string, error) {
	if a.profile != "" {
		args = append(args, "--profile", a.profile)
	}
	if region != "" {
		args = append(args, "--region", region)
	}
	return a.exec(ctx, "aws", append(args, "--output", "json")...)
}

// AWSProfiles lists the AWS CLI's profiles.
func AWSProfiles(ctx context.Context, exec Exec) []string {
	out, err := exec(ctx, "aws", "configure", "list-profiles")
	if err != nil {
		return nil
	}
	var profiles []string
	for _, p := range strings.Fields(out) {
		profiles = append(profiles, p)
	}
	return profiles
}

// CheckAWS signs in with profile and looks at the account and region.
func CheckAWS(ctx context.Context, exec Exec, profile, region string) *AWS {
	a := &AWS{Denied: map[string]string{}}
	cli := awsCLI{exec: exec, profile: profile}
	signIn := "`aws login`"
	if profile != "" {
		signIn = "`aws login --profile " + profile + "`"
	}

	out, err := cli.call(ctx, region, "sts", "get-caller-identity")
	if kind, _ := ClassifyAWS(out, err); kind != OK {
		a.problem("not signed in to AWS"+profileWords(profile),
			"sign in with "+signIn+" (an IAM user) or `aws configure sso` (Identity Center)", "aws.md#sign-in")
		return a
	}
	var id struct{ Account, Arn string }
	if err := json.Unmarshal([]byte(out), &id); err != nil {
		a.problem("AWS's identity answer was unreadable: "+err.Error(), "", "")
		return a
	}
	a.Account, a.Principal = id.Account, id.Arn
	a.Identity = "aws:" + id.Arn
	who := principalWords(id.Arn)
	if strings.HasSuffix(id.Arn, ":root") {
		a.Root = true
		a.problem("signed in as the account's root user", "create an IAM user with AdministratorAccess and sign in as it ("+signIn+"): root is for account settings only", "aws.md#an-iam-user")
	}

	// The account: its alias, and whether it's in an organization.
	account := "account …" + last4(id.Account)
	if out, err := cli.call(ctx, region, "iam", "list-account-aliases"); err == nil {
		var aliases struct{ AccountAliases []string }
		if json.Unmarshal([]byte(out), &aliases) == nil && len(aliases.AccountAliases) > 0 {
			account = aliases.AccountAliases[0] + " (…" + last4(id.Account) + ")"
		}
	}
	org := "standalone"
	out, err = cli.call(ctx, region, "organizations", "describe-organization")
	switch {
	case err == nil:
		var o struct {
			Organization struct{ MasterAccountId string }
		}
		if json.Unmarshal([]byte(out), &o) == nil {
			if o.Organization.MasterAccountId == id.Account {
				org = "the management account of an organization (prefer a member account for workloads)"
			} else {
				org = "a member of an organization (management account …" + last4(o.Organization.MasterAccountId) + "): its policies (SCPs) apply here"
			}
		}
	case strings.Contains(out+err.Error(), "AWSOrganizationsNotInUseException"):
	default:
		org = "possibly in an organization (it can't be read from here)"
	}
	a.line("Signed in", fmt.Sprintf("%s in %s, %s", who, account, org))

	// Regions: which answer at all. An organization may allow only some.
	regions := AWSRegions
	if region != "" && !contains(regions, region) {
		regions = append(regions[:len(regions):len(regions)], region)
	}
	a.probeRegions(ctx, cli, regions)
	switch {
	case region == "":
	case contains(a.Allowed, region):
		note := ""
		if len(a.Denied) > 0 {
			note = fmt.Sprintf(" (your organization allows only %s)", strings.Join(a.Allowed, ", "))
		}
		a.line("Region", region+note)
	case a.Denied[region] != "":
		a.problem(fmt.Sprintf("your organization's policy denies %s to this account (%s)", region, a.Denied[region]),
			fmt.Sprintf("use one it allows: %s (`vertra config set aws.region <region>`), or have the management account allow %s", strings.Join(a.Allowed, ", "), region), "aws.md#regions")
	default:
		a.problem("can't use "+region+" from this account", "choose another region: "+strings.Join(a.Allowed, ", "), "aws.md#regions")
	}

	// Money: budgets, and whether Spot prices can be read here.
	var b struct{ Budgets []json.RawMessage }
	out, err = cli.call(ctx, region, "budgets", "describe-budgets", "--account-id", id.Account)
	if err == nil {
		err = json.Unmarshal([]byte(out), &b)
	}
	a.Budgets, a.BudgetsUnread = len(b.Budgets), err != nil
	budget := fmt.Sprintf("%d in this account", a.Budgets)
	switch {
	case a.BudgetsUnread:
		budget = "couldn't read them (budgets:ViewBudget): check the account has one in the Billing console"
	case a.Budgets == 0:
		budget = "none in this account: set one so a forgotten cluster can't surprise you"
	}
	a.line("Budgets", budget)
	if region != "" && contains(a.Allowed, region) {
		out, err := cli.call(ctx, region, "ec2", "describe-spot-price-history", "--max-items", "1", "--instance-types", "c6a.large")
		if kind, policy := ClassifyAWS(out, err); kind == DeniedByOrganization {
			a.line("Spot", "your organization's policy denies reading Spot prices ("+policy+"): steps are priced on-demand")
		}
	}
	return a
}

// ProbeRegion asks one more region (one outside AWSRegions), adding it to
// Allowed or Denied by its own answer.
func (a *AWS) ProbeRegion(ctx context.Context, exec Exec, profile, region string) {
	a.probeRegions(ctx, awsCLI{exec: exec, profile: profile}, []string{region})
}

// probeRegions asks each region for its zones, in parallel.
func (a *AWS) probeRegions(ctx context.Context, cli awsCLI, regions []string) {
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, r := range regions {
		wg.Add(1)
		go func(r string) {
			defer wg.Done()
			out, err := cli.call(ctx, r, "ec2", "describe-availability-zones", "--query", "AvailabilityZones[0].ZoneName")
			kind, policy := ClassifyAWS(out, err)
			mu.Lock()
			defer mu.Unlock()
			switch kind {
			case OK:
				a.Allowed = append(a.Allowed, r)
			case DeniedByOrganization:
				if policy == "" {
					policy = "a service control policy"
				}
				a.Denied[r] = policy
			}
		}(r)
	}
	wg.Wait()
	sort.Strings(a.Allowed)
}

func principalWords(arn string) string {
	parts := strings.Split(arn, ":")
	resource := parts[len(parts)-1]
	switch {
	case strings.HasSuffix(arn, ":root"):
		return "the root user"
	case strings.HasPrefix(resource, "user/"):
		return "IAM user " + strings.TrimPrefix(resource, "user/")
	case strings.HasPrefix(resource, "assumed-role/AWSReservedSSO_"):
		role := strings.Split(strings.TrimPrefix(resource, "assumed-role/AWSReservedSSO_"), "/")
		name := role[0]
		if i := strings.LastIndex(name, "_"); i > 0 {
			name = name[:i]
		}
		who := ""
		if len(role) > 1 {
			who = role[len(role)-1] + " "
		}
		return who + "through Identity Center (" + name + ")"
	case strings.HasPrefix(resource, "assumed-role/"):
		return "role " + strings.Split(strings.TrimPrefix(resource, "assumed-role/"), "/")[0]
	}
	return resource
}

func profileWords(profile string) string {
	if profile == "" {
		return ""
	}
	return " (profile " + profile + ")"
}

func last4(s string) string {
	if len(s) <= 4 {
		return s
	}
	return s[len(s)-4:]
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
