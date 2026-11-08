// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"testing"

	"github.com/rburns629/vennir/cli/internal/azurecloud"
	"github.com/rburns629/vennir/cli/internal/config"
)

// The azure module's outputs, as `tofu output -json` gives them, read into
// the install's cloud side.
func TestCloudFromAzure(t *testing.T) {
	outputs := map[string]json.RawMessage{
		"cluster":             json.RawMessage(`{"name":"vennir","resource_group":"vennir","region":"eastus2","issuer":"https://eastus2.oic.prod-aks.azure.com/t/c/"}`),
		"task_registry":       json.RawMessage(`"vennirbb6ebc07.azurecr.io/vennir-products"`),
		"identities":          json.RawMessage(`{"console":"c-id","scanner":"s-id","policy":"p-id"}`),
		"backup":              json.RawMessage(`{"storage_account":"vennirbkbb6ebc07","container":"backups","client_id":"b-id"}`),
		"step_placement":      json.RawMessage(`{"nodeSelector":{"vennir.dev/pool":"steps"},"tolerations":[]}`),
		"capacity_placements": json.RawMessage(`{}`),
	}
	cloud, err := cloudFromAzure(outputs)
	if err != nil {
		t.Fatal(err)
	}
	if cloud.Provider != "azure" || cloud.TaskRegistry != "vennirbb6ebc07.azurecr.io/vennir-products" || cloud.ClusterIssuer == "" ||
		cloud.ConsoleServiceAccount != "c-id" || cloud.ScannerServiceAccount != "s-id" || cloud.PolicyServiceAccount != "p-id" ||
		cloud.BackupBucket != "vennirbkbb6ebc07" || cloud.BackupContainer != "backups" || cloud.BackupServiceAccount != "b-id" {
		t.Errorf("cloud %+v", cloud)
	}
	delete(outputs, "backup") // null without backups
	if cloud, err := cloudFromAzure(outputs); err != nil || cloud.BackupBucket != "" {
		t.Errorf("without backups: %+v, %v", cloud, err)
	}
	delete(outputs, "identities")
	if _, err := cloudFromAzure(outputs); err == nil {
		t.Error("no error for a missing output")
	}
}

// vennir names the registry and the backups' storage account before
// apply, as the module does: the same hash (OpenTofu's sha1 of
// "<subscription>/<resource group>" gave bb6ebc07).
func TestAzureNamesAreTheModules(t *testing.T) {
	c := config.Default("azure")
	c.Azure = config.Azure{Subscription: "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0", ResourceGroup: "vennir"}
	if got := azurecloud.Registry(c); got != "vennirbb6ebc07.azurecr.io" {
		t.Errorf("registry %s", got)
	}
	if got := azurecloud.BackupStorageName(c); got != "vennirbkbb6ebc07" {
		t.Errorf("storage account %s", got)
	}
	c.Cluster.Name = "a-very-long-name-here"
	if got := azurecloud.BackupStorageName(c); len(got) > 24 {
		t.Errorf("storage account %s is over 24 characters", got)
	}
}
