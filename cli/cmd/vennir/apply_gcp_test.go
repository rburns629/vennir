// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The gcp module's outputs as `tofu output -json` gives them (values only).
const gcpOutputs = `{
 "cluster": {"name":"vennir","location":"us-central1","issuer":"https://container.googleapis.com/v1/projects/p/locations/us-central1/clusters/vennir"},
 "workload_identity_pool": "p.svc.id.goog",
 "task_registry": "us-central1-docker.pkg.dev/p/vennir-products",
 "platform_registry": "",
 "console_service_account": "vennir-console@p.iam.gserviceaccount.com",
 "scanner_service_account": "vennir-scanner@p.iam.gserviceaccount.com",
 "backup": {"bucket":"p-vennir-backups","service_account":"vennir-backup@p.iam.gserviceaccount.com"},
 "step_placement": {"nodeSelector":{"cloud.google.com/gke-spot":"true"},"tolerations":[]},
 "capacity_placements": {"spot":{"nodeSelector":{"cloud.google.com/gke-spot":"true"},"tolerations":[]},"onDemand":{"nodeSelector":{},"tolerations":[]}},
 "console_address": {"name":"vennir-console","ip":"34.1.2.3"},
 "catalog": null
}`

func TestCloudFromGCPOutputs(t *testing.T) {
	var outputs map[string]json.RawMessage
	if err := json.Unmarshal([]byte(gcpOutputs), &outputs); err != nil {
		t.Fatal(err)
	}
	cloud, err := cloudFromGCP(outputs)
	if err != nil {
		t.Fatal(err)
	}
	if cloud.ClusterLocation != "us-central1" || cloud.BackupBucket != "p-vennir-backups" ||
		cloud.BackupServiceAccount != "vennir-backup@p.iam.gserviceaccount.com" ||
		cloud.StepPlacement["nodeSelector"].(map[string]any)["cloud.google.com/gke-spot"] != "true" {
		t.Errorf("got %+v", cloud)
	}
	if _, ok := cloud.CapacityPlacements["onDemand"]; !ok {
		t.Errorf("capacities: %+v", cloud.CapacityPlacements)
	}
	if cloud.ScannerServiceAccount != "vennir-scanner@p.iam.gserviceaccount.com" {
		t.Errorf("scanner: %q", cloud.ScannerServiceAccount)
	}
	if cloud.ConsoleIP != "34.1.2.3" || cloud.CatalogProvider != "" {
		t.Errorf("address and catalog: %+v", cloud)
	}
	// tofu leaves null outputs out: optional ones may be absent.
	delete(outputs, "backup")
	delete(outputs, "catalog")
	delete(outputs, "console_address")
	if cloud, err := cloudFromGCP(outputs); err != nil || cloud.BackupBucket != "" {
		t.Errorf("optional outputs may be absent: %+v, %v", cloud, err)
	}
	if cloud.Database != nil {
		t.Errorf("no managed database: %+v", cloud.Database)
	}
	outputs["database"] = json.RawMessage(`{"instance":"vennir-ab12","host":"10.40.0.3","ca_cert":"PEM",
	  "users":{"kernel":"vennir-kernel@p.iam","console":"vennir-console@p.iam","gateway":"vennir-gateway@p.iam","admin":"vennir-db-admin@p.iam"},
	  "kernel_sa":"vennir-kernel@p.iam.gserviceaccount.com","gateway_sa":"vennir-gateway@p.iam.gserviceaccount.com","admin_sa":"vennir-db-admin@p.iam.gserviceaccount.com"}`)
	cloud, err = cloudFromGCP(outputs)
	if err != nil || cloud.Database == nil || cloud.Database.Host != "10.40.0.3" || cloud.Database.GatewayUser != "vennir-gateway@p.iam" ||
		cloud.Database.AdminServiceAccount != "vennir-db-admin@p.iam.gserviceaccount.com" {
		t.Errorf("a managed database: %+v, %v", cloud.Database, err)
	}
	delete(outputs, "task_registry")
	if _, err := cloudFromGCP(outputs); err == nil {
		t.Error("a missing required output should fail")
	}
}

func TestCloudFromAWSOutputsWithoutTheOptionalOnes(t *testing.T) {
	var outputs map[string]json.RawMessage
	if err := json.Unmarshal([]byte(`{
 "cluster": {"name":"vennir","region":"us-east-2","issuer":"https://oidc.eks.us-east-2.amazonaws.com/id/X"},
 "account": "123456789012",
 "task_registry": "123456789012.dkr.ecr.us-east-2.amazonaws.com/vennir-products",
 "platform_registry": "",
 "backup": {"bucket":"vennir-backups-123456789012-us-east-2","region":"us-east-2"},
 "step_placement": {"nodeSelector":{"vennir.dev/pool":"steps"},"tolerations":[]},
 "spot": true
}`), &outputs); err != nil {
		t.Fatal(err)
	}
	cloud, spot, err := cloudFromAWS(outputs)
	if err != nil {
		t.Fatal(err)
	}
	if !spot || cloud.Provider != "aws" || cloud.BackupRegion != "us-east-2" || cloud.CatalogServiceAccount != "" {
		t.Errorf("got %+v, spot %v", cloud, spot)
	}
}

func TestSameIdentity(t *testing.T) {
	if sameIdentity("", "aws:arn:x") != nil || sameIdentity("aws:arn:x", "aws:arn:x") != nil {
		t.Error("nothing recorded, or the same, is fine")
	}
	err := sameIdentity("aws:arn:aws:iam::1:user/a", "aws:arn:aws:iam::2:user/b")
	if err == nil || !strings.Contains(err.Error(), "set up as arn:aws:iam::1:user/a, but you're signed in as arn:aws:iam::2:user/b") {
		t.Errorf("got %v", err)
	}
}
