// SPDX-License-Identifier: MIT

package access

import (
	"context"
	"encoding/json"
	"strings"
)

// Azure is what the Azure check found, beyond the report.
type Azure struct {
	Report
	User   string
	Tenant string
	// FreeTrial: the subscription is a Free Trial, which has a few vCPUs a
	// region and no Spot VMs (so steps run on regular ones).
	FreeTrial bool
}

// AzureSubscription is one subscription az's sign-in reaches.
type AzureSubscription struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Default bool   `json:"isDefault"`
}

// AzureSubscriptions lists the enabled subscriptions az's sign-in reaches,
// the default one first.
func AzureSubscriptions(ctx context.Context, exec Exec) []AzureSubscription {
	out, err := exec(ctx, "az", "account", "list", "--query", "[?state=='Enabled'].{id:id, name:name, isDefault:isDefault}", "--output", "json")
	var subs []AzureSubscription
	if err != nil || json.Unmarshal([]byte(out), &subs) != nil {
		return nil
	}
	for i, s := range subs {
		if s.Default && i > 0 {
			subs[0], subs[i] = subs[i], subs[0]
		}
	}
	return subs
}

// What the module's role assignments need of whoever applies it: making
// identities, a cluster and storage, and granting them their roles.
var azureGranting = []string{"Owner", "User Access Administrator", "Role Based Access Control Administrator"}

// CheckAzure looks at the sign-in, the subscription and the region.
func CheckAzure(ctx context.Context, exec Exec, subscription, region string) *Azure {
	a := &Azure{}
	out, err := exec(ctx, "az", "account", "show", "--subscription", subscription,
		"--query", "{user:user.name, type:user.type, tenant:tenantId, name:name, state:state}", "--output", "json")
	var account struct{ User, Type, Tenant, Name, State string }
	if err != nil || json.Unmarshal([]byte(out), &account) != nil || account.User == "" {
		a.problem("Not signed in to Azure, or subscription "+subscription+" isn't one it reaches",
			"`az login`, then `az account list --output table`", "azure.md")
		return a
	}
	a.User, a.Tenant = account.User, account.Tenant
	a.Identity = "azure:" + account.User
	a.line("Signed in", account.User+" ("+account.Type+")")
	a.line("Subscription", account.Name+" ("+subscription+")")
	if account.State != "Enabled" {
		a.problem("Subscription "+account.Name+" is "+account.State, "re-enable it in the Azure portal (Subscriptions)", "azure.md")
	}

	policies, err := exec(ctx, "az", "rest", "--method", "get",
		"--url", "https://management.azure.com/subscriptions/"+subscription+"?api-version=2022-12-01",
		"--query", "subscriptionPolicies.quotaId", "--output", "tsv")
	if err == nil && strings.HasPrefix(strings.TrimSpace(policies), "FreeTrial") {
		a.FreeTrial = true
		a.line("Offer", "Free Trial: its credit and a few vCPUs a region, no Spot VMs (steps run on regular ones)")
	}

	if region != "" {
		regions, err := exec(ctx, "az", "account", "list-locations", "--subscription", subscription,
			"--query", "[?metadata.regionType=='Physical'].name", "--output", "tsv")
		if err == nil && !contains(strings.Fields(regions), region) {
			a.problem("Region "+region+" isn't one this subscription has", "`az account list-locations --query \"[].name\" --output tsv`", "")
		}
	}

	// A person's roles; a service principal's are left to the apply.
	if account.Type == "user" {
		roles := azureRoles(ctx, exec, subscription)
		if roles != nil && !anyOf(roles, azureGranting) {
			a.problem("Your roles on the subscription ("+strings.Join(roles, ", ")+") can't grant the install's identities their roles",
				"Owner on the subscription, or Contributor with User Access Administrator", "azure.md")
		}
	}
	return a
}

// azureRoles are the signed-in user's role names on the subscription,
// inherited ones too; nil when they can't be read.
func azureRoles(ctx context.Context, exec Exec, subscription string) []string {
	id, err := exec(ctx, "az", "ad", "signed-in-user", "show", "--query", "id", "--output", "tsv")
	if err != nil || strings.TrimSpace(id) == "" {
		return nil
	}
	out, err := exec(ctx, "az", "role", "assignment", "list", "--assignee", strings.TrimSpace(id),
		"--scope", "/subscriptions/"+subscription, "--include-inherited", "--query", "[].roleDefinitionName", "--output", "tsv")
	if err != nil {
		return nil
	}
	roles := []string{}
	for _, line := range strings.Split(out, "\n") {
		if r := strings.TrimSpace(line); r != "" {
			roles = append(roles, r)
		}
	}
	return roles
}

func anyOf(have, want []string) bool {
	for _, h := range have {
		if contains(want, h) {
			return true
		}
	}
	return false
}
