// SPDX-License-Identifier: MIT

package modules

import (
	"regexp"
	"strings"
	"testing"
)

// The AWS catalog publish role trusts only main: every subject it accepts
// names refs/heads/main, a job in the catalog-publish Environment included,
// so a branch whose workflow names that Environment can't take the role.
func TestTheAWSPublishRoleTrustsOnlyMain(t *testing.T) {
	main, err := files.ReadFile("aws/main.tf")
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)data "aws_iam_policy_document" "publish_trust" \{.*?\n\}`).Find(main)
	if block == nil {
		t.Fatal("no publish_trust in aws/main.tf")
	}
	subjects := regexp.MustCompile(`"\$\{local\.catalog_subject\}([^"]*)"`).FindAllStringSubmatch(string(block), -1)
	if len(subjects) == 0 {
		t.Fatal("publish_trust names no subject")
	}
	for _, s := range subjects {
		if !strings.HasSuffix(s[1], ":ref:refs/heads/main") {
			t.Errorf("publish_trust accepts %q, which doesn't name main", s[1])
		}
	}
}

// Every Cloud SQL role the gcp module grants in the project is held to its
// own instance by a condition, as aws's rds-db:connect names one user on
// one instance.
func TestTheGCPDatabaseRolesNameTheInstance(t *testing.T) {
	main, err := files.ReadFile("gcp/main.tf")
	if err != nil {
		t.Fatal(err)
	}
	blocks := regexp.MustCompile(`(?s)resource "google_project_iam_member" "[^"]+" \{.*?\n\}`).FindAll(main, -1)
	found := 0
	for _, b := range blocks {
		if !strings.Contains(string(b), "roles/cloudsql.") {
			continue
		}
		found++
		if !strings.Contains(string(b), `expression = "resource.name == \"projects/${var.project}/instances/${google_sql_database_instance.this[0].name}\"`) {
			t.Errorf("a Cloud SQL role granted project-wide:\n%s", b)
		}
	}
	if found == 0 {
		t.Fatal("no Cloud SQL roles in gcp/main.tf")
	}
}
