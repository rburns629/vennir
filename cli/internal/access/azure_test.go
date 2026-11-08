// SPDX-License-Identifier: MIT

package access

import (
	"context"
	"errors"
	"strings"
	"testing"
)

const testSubscription = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"

// fakeAz answers like the az CLI for one person signed in to a Free Trial
// subscription, with these roles on it.
func fakeAz(roles string) Exec {
	return func(_ context.Context, name string, args ...string) (string, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.HasPrefix(joined, "account show --subscription "+testSubscription):
			return `{"user":"ada@example.com","type":"user","tenant":"t","name":"Azure subscription 1","state":"Enabled"}`, nil
		case strings.HasPrefix(joined, "account show"):
			return "", errors.New("ERROR: Subscription '" + args[2] + "' not found. Check the spelling and casing and try again.")
		case strings.HasPrefix(joined, "rest --method get"):
			return "FreeTrial_2014-09-01\n", nil
		case strings.HasPrefix(joined, "account list-locations"):
			return "eastus\neastus2\nwesteurope\n", nil
		case strings.HasPrefix(joined, "ad signed-in-user show"):
			return "a1b2c3d4-0000-0000-0000-000000000000\n", nil
		case strings.HasPrefix(joined, "role assignment list"):
			return roles, nil
		case strings.HasPrefix(joined, "account list"):
			return `[{"id":"s1","name":"Other","isDefault":false},{"id":"` + testSubscription + `","name":"Azure subscription 1","isDefault":true}]`, nil
		}
		return "", errors.New("unexpected: " + joined)
	}
}

func TestCheckAzure(t *testing.T) {
	a := CheckAzure(context.Background(), fakeAz("User Access Administrator\nOwner\n"), testSubscription, "eastus2")
	if got := report(a.Report); got != "Signed in: ada@example.com (user)\nSubscription: Azure subscription 1 ("+testSubscription+")\n"+
		"Offer: Free Trial: its credit and a few vCPUs a region, no Spot VMs (steps run on regular ones)\n" {
		t.Errorf("report:\n%s", got)
	}
	if !a.FreeTrial || a.Identity != "azure:ada@example.com" {
		t.Errorf("free trial %v, identity %q", a.FreeTrial, a.Identity)
	}
}

func TestCheckAzureProblems(t *testing.T) {
	a := CheckAzure(context.Background(), fakeAz("Reader\nStorage Blob Data Reader\n"), testSubscription, "mars1")
	got := report(a.Report)
	for _, want := range []string{"PROBLEM Region mars1", "PROBLEM Your roles on the subscription (Reader, Storage Blob Data Reader)"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	a = CheckAzure(context.Background(), fakeAz(""), "ffffffff-0000-0000-0000-000000000000", "eastus2")
	if len(a.Problems) != 1 || !strings.Contains(a.Problems[0].Fix, "az login") || a.Identity != "" {
		t.Errorf("another subscription: %+v", a.Report)
	}
}

func TestAzureSubscriptionsPutTheDefaultFirst(t *testing.T) {
	subs := AzureSubscriptions(context.Background(), fakeAz(""))
	if len(subs) != 2 || subs[0].ID != testSubscription || !subs[0].Default {
		t.Errorf("subscriptions %+v", subs)
	}
}
