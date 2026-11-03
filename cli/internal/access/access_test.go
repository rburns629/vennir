// SPDX-License-Identifier: MIT

package access

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Real AWS CLI failures from 2026-10-18 (account numbers changed).
func TestClassifyAWS(t *testing.T) {
	for _, tc := range []struct {
		name, err string
		want      Kind
		policy    string
	}{
		{"an organization's region restriction",
			"\naws: [ERROR]: An error occurred (UnauthorizedOperation) when calling the DescribeAvailabilityZones operation: You are not authorized to perform this operation. User: arn:aws:iam::111111111111:user/rburns is not authorized to perform: ec2:DescribeAvailabilityZones with an explicit deny in a service control policy: arn:aws:organizations::222222222222:policy/o-trg8je2v8d/service_control_policy/p-is4rktmh",
			DeniedByOrganization, "arn:aws:organizations::222222222222:policy/o-trg8je2v8d/service_control_policy/p-is4rktmh"},
		{"the identity's own permissions",
			"An error occurred (AccessDenied) when calling the ListRoles operation: User: arn:aws:iam::111111111111:user/x is not authorized to perform: iam:ListRoles because no identity-based policy allows the iam:ListRoles action",
			NotPermitted, ""},
		{"no sign-in", "Unable to locate credentials. You can configure credentials by running \"aws login\".", NotSignedIn, ""},
		{"an unknown profile", "The config profile (nope) could not be found", NotSignedIn, ""},
		{"something else", "Could not connect to the endpoint URL", Failed, ""},
	} {
		kind, policy := ClassifyAWS("", errors.New(tc.err))
		if kind != tc.want || policy != tc.policy {
			t.Errorf("%s: %v %q, want %v %q", tc.name, kind, policy, tc.want, tc.policy)
		}
	}
	if kind, _ := ClassifyAWS("us-east-2a", nil); kind != OK {
		t.Error("no error is OK")
	}
}

// fakeAWS answers like the AWS CLI for one account: a member of an
// organization whose policy allows only us-east-2.
func fakeAWS(arn string) Exec {
	return func(_ context.Context, name string, args ...string) (string, error) {
		joined := strings.Join(args, " ")
		region := ""
		for i, a := range args {
			if a == "--region" && i+1 < len(args) {
				region = args[i+1]
			}
		}
		denied := errors.New("\naws: [ERROR]: An error occurred (UnauthorizedOperation): User is not authorized to perform: ec2:X with an explicit deny in a service control policy: arn:aws:organizations::222222222222:policy/o-1/service_control_policy/p-region")
		switch {
		case strings.HasPrefix(joined, "sts get-caller-identity"):
			return `{"Account":"111111111111","Arn":"` + arn + `"}`, nil
		case strings.HasPrefix(joined, "iam list-account-aliases"):
			return `{"AccountAliases":[]}`, nil
		case strings.HasPrefix(joined, "organizations describe-organization"):
			return `{"Organization":{"MasterAccountId":"222222222222"}}`, nil
		case strings.HasPrefix(joined, "ec2 describe-availability-zones"):
			if region == "us-east-2" {
				return `"us-east-2a"`, nil
			}
			return "", denied
		case strings.HasPrefix(joined, "budgets describe-budgets"):
			return `{"Budgets":[{"BudgetName":"x"}]}`, nil
		case strings.HasPrefix(joined, "ec2 describe-spot-price-history"):
			return "", denied
		}
		return "", errors.New("unexpected: " + joined)
	}
}

func report(r Report) string {
	var b strings.Builder
	for _, l := range r.Lines {
		b.WriteString(l.Label + ": " + l.Text + "\n")
	}
	for _, p := range r.Problems {
		b.WriteString("PROBLEM " + p.Text + " | " + p.Fix + " | " + p.Guide + "\n")
	}
	return b.String()
}

func TestCheckAWSFindsTheRegionsAnOrganizationAllows(t *testing.T) {
	a := CheckAWS(context.Background(), fakeAWS("arn:aws:iam::111111111111:user/rburns"), "vertra", "us-east-1")
	if strings.Join(a.Allowed, ",") != "us-east-2" || a.Denied["us-east-1"] == "" {
		t.Fatalf("allowed %v, denied %v", a.Allowed, a.Denied)
	}
	out := report(a.Report)
	for _, want := range []string{
		"Signed in: IAM user rburns in account …1111, a member of an organization (management account …2222)",
		"PROBLEM your organization's policy denies us-east-1",
		"use one it allows: us-east-2",
		"Budgets: 1 in this account",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if a.Identity != "aws:arn:aws:iam::111111111111:user/rburns" {
		t.Errorf("identity: %s", a.Identity)
	}
}

func TestCheckAWSInAnAllowedRegion(t *testing.T) {
	a := CheckAWS(context.Background(), fakeAWS("arn:aws:iam::111111111111:user/rburns"), "vertra", "us-east-2")
	out := report(a.Report)
	if len(a.Problems) != 0 || !strings.Contains(out, "Region: us-east-2 (your organization allows only us-east-2)") ||
		!strings.Contains(out, "Spot: your organization's policy denies reading Spot prices") {
		t.Errorf("got:\n%s", out)
	}
}

func TestCheckAWSRefusesRoot(t *testing.T) {
	a := CheckAWS(context.Background(), fakeAWS("arn:aws:iam::111111111111:root"), "", "us-east-2")
	if !a.Root || !strings.Contains(report(a.Report), "PROBLEM signed in as the account's root user") {
		t.Errorf("got:\n%s", report(a.Report))
	}
}

func TestPrincipalWords(t *testing.T) {
	for arn, want := range map[string]string{
		"arn:aws:iam::1:user/rburns": "IAM user rburns",
		"arn:aws:sts::1:assumed-role/AWSReservedSSO_AdministratorAccess_0123abcd/rburns": "rburns through Identity Center (AdministratorAccess)",
		"arn:aws:sts::1:assumed-role/AccountFullAccessRole/5438b438":                     "role AccountFullAccessRole",
		"arn:aws:iam::1:root": "the root user",
	} {
		if got := principalWords(arn); got != want {
			t.Errorf("%s: %q, want %q", arn, got, want)
		}
	}
}

func TestCheckGCP(t *testing.T) {
	exec := func(_ context.Context, name string, args ...string) (string, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.HasPrefix(joined, "auth list"):
			return `[{"account":"me@example.com","status":"ACTIVE"},{"account":"work@corp.example","status":""}]`, nil
		case strings.HasPrefix(joined, "auth application-default print-access-token"):
			return "ya29.token", nil
		case strings.HasPrefix(joined, "container clusters list"):
			return "prod-cluster\n", nil
		case strings.HasPrefix(joined, "compute networks list"):
			return "", nil
		case strings.Contains(joined, "gcp.resourceLocations"):
			return `{"listPolicy":{"allowedValues":["in:europe-locations"]}}`, nil
		case strings.Contains(joined, "vmExternalIpAccess"):
			return `{"listPolicy":{"allValues":"DENY"}}`, nil
		}
		return "", errors.New("unexpected: " + joined)
	}
	g := CheckGCP(context.Background(), exec, func(context.Context, string) string { return "work@corp.example" }, "my-project", "us-central1")
	out := report(g.Report)
	for _, want := range []string{
		"Signed in: me@example.com (2 accounts signed in",
		"PROBLEM gcloud is signed in as me@example.com but OpenTofu as work@corp.example",
		"Project: my-project already holds 1 cluster(s)",
		"PROBLEM your organization's policy allows only in:europe-locations, not us-central1",
		"Policy: your organization denies VMs external IP addresses",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestRegionInLocations(t *testing.T) {
	for _, c := range []struct {
		values []string
		region string
		want   location
	}{
		{[]string{"in:us-locations"}, "us-east1", locationAllowed},
		{[]string{"in:us-central1-locations"}, "us-central1", locationAllowed},
		{[]string{"us-central1"}, "us-central1", locationAllowed},
		{[]string{"is:us-central1"}, "us-central1", locationAllowed},
		{[]string{"in:northamerica-locations"}, "us-central1", locationAllowed},
		{[]string{"in:northamerica-locations"}, "northamerica-northeast1", locationAllowed},
		{[]string{"in:asia-locations", "in:europe-locations"}, "europe-west12", locationAllowed},
		{[]string{"in:europe-locations"}, "us-central1", locationRefused},
		{[]string{"in:us-locations"}, "northamerica-northeast1", locationRefused},
		{[]string{"in:us-east1-locations", "europe-west1"}, "us-central1", locationRefused},
		{[]string{"us-east1"}, "me-west1", locationRefused},
		// Groups named after a jurisdiction can't be read from a region's name.
		{[]string{"in:eu-locations"}, "europe-west1", locationUnknown},
		{[]string{"in:eu-locations"}, "us-east1", locationUnknown},
		{[]string{"in:canada-locations"}, "northamerica-northeast1", locationUnknown},
		{[]string{"in:japan-locations", "in:us-locations"}, "asia-northeast1", locationUnknown},
		// in:asia-locations leaves out asia-southeast3 (in:th-locations).
		{[]string{"in:asia-locations"}, "asia-southeast3", locationUnknown},
		{[]string{"in:asia-locations"}, "us-central1", locationUnknown},
		// Nor can a region outside the prefix groups be ruled out of them.
		{[]string{"in:europe-locations"}, "me-west1", locationUnknown},
		// A zone, or global, says nothing sure about the region.
		{[]string{"in:us-central1-a-locations"}, "us-central1", locationUnknown},
		{[]string{"global"}, "us-central1", locationUnknown},
	} {
		if got := regionInLocations(c.values, c.region); got != c.want {
			t.Errorf("%v, %s: %d, want %d", c.values, c.region, got, c.want)
		}
	}
}

// A group the check can't read is a line, not a problem that stops init
// and apply.
func TestCheckGCPCantTellIsNotAProblem(t *testing.T) {
	exec := func(_ context.Context, name string, args ...string) (string, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.HasPrefix(joined, "auth list"):
			return `[{"account":"me@example.com","status":"ACTIVE"}]`, nil
		case strings.HasPrefix(joined, "auth application-default print-access-token"):
			return "ya29.token", nil
		case strings.Contains(joined, "gcp.resourceLocations"):
			return `{"listPolicy":{"allowedValues":["in:eu-locations"]}}`, nil
		}
		return "", nil
	}
	g := CheckGCP(context.Background(), exec, func(context.Context, string) string { return "me@example.com" }, "my-project", "europe-west1")
	if len(g.Problems) > 0 {
		t.Errorf("problems: %+v", g.Problems)
	}
	if out := report(g.Report); !strings.Contains(out, "Policy: your organization's policy allows only in:eu-locations: Vertra can't tell whether that includes europe-west1") {
		t.Errorf("no line saying so in:\n%s", out)
	}
}

// `gh auth status` with two accounts (2026-10-18).
func TestParseGHStatus(t *testing.T) {
	out := `github.com
  ✓ Logged in to github.com account rburns629 (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account r0bett (keyring)
  - Active account: false`
	accounts, active := parseGHStatus(out)
	if strings.Join(accounts, ",") != "rburns629,r0bett" || active != "rburns629" {
		t.Errorf("got %v, %q", accounts, active)
	}
}
