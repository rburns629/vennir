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
		if !strings.HasSuffix(strings.TrimSuffix(s[1], "${local.catalog_ids}"), ":ref:refs/heads/main") {
			t.Errorf("publish_trust accepts %q, which doesn't name main", s[1])
		}
	}
}

// Once vennir knows the catalog repository's ids, the AWS publish role
// trusts only subjects ending in them, in githost.SubjectClaimKeys' order,
// and GCP's federation trusts the ids, not the name: a repository renamed,
// or made again under its name by someone else, matches neither.
func TestTheCatalogFederationPinsTheRepositoryByItsIDs(t *testing.T) {
	aws, err := files.ReadFile("aws/main.tf")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(aws), `catalog_ids     = ":repository_owner_id:${var.catalog_owner_id}:repository_id:${var.catalog_repository_id}"`) {
		t.Error("aws/main.tf's catalog_ids isn't the owner's id then the repository's, as the subject template orders them")
	}
	pinned := regexp.MustCompile(`(?s)values = local\.catalog_pinned \? \[(.*?)\] : \[`).FindSubmatch(aws)
	if pinned == nil {
		t.Fatal("publish_trust's subjects don't depend on catalog_pinned")
	}
	for _, v := range regexp.MustCompile(`"([^"]*)"`).FindAllStringSubmatch(string(pinned[1]), -1) {
		if !strings.HasSuffix(v[1], "${local.catalog_ids}") {
			t.Errorf("pinned, publish_trust still accepts %q, which doesn't name the ids", v[1])
		}
	}

	gcp, err := files.ReadFile("gcp/main.tf")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"assertion.repository_id == \"${var.catalog_repository_id}\" && assertion.repository_owner_id == \"${var.catalog_owner_id}\""`,
		`"attribute.repository_id/${var.catalog_repository_id}"`,
		`attribute_condition = "${local.catalog_repository_condition} && assertion.ref == \"refs/heads/main\""`,
		`/${local.catalog_principal}"`,
	} {
		if !strings.Contains(string(gcp), want) {
			t.Errorf("gcp/main.tf hasn't %s", want)
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

// The AWS backup writer can't destroy an earlier dump: its bucket is
// versioned, and the writer may put and read objects but delete none, nor
// any version (as on gcp, where it can't replace one).
func TestTheAWSBackupsCantBeOverwritten(t *testing.T) {
	main, err := files.ReadFile("aws/main.tf")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?s)resource "aws_s3_bucket_versioning" "backups" \{\n  count  = var\.backups \? 1 : 0\n  bucket = aws_s3_bucket\.backups\[0\]\.id\n  versioning_configuration \{\n    status = "Enabled"`).Match(main) {
		t.Error("the backups bucket isn't versioned")
	}
	block := regexp.MustCompile(`(?s)data "aws_iam_policy_document" "backup" \{.*?\n\}`).Find(main)
	if block == nil {
		t.Fatal("no backup policy in aws/main.tf")
	}
	if regexp.MustCompile(`Delete|Lifecycle|Versioning|s3:\*`).Match(block) {
		t.Errorf("the backup writer may delete or unversion: %s", block)
	}
}

// The console's audit copy on AWS is create-only by IAM, not only by the
// console's own request: every statement granting s3:PutObject requires
// If-None-Match: *, so a put can't make a new version of an existing copy.
func TestTheAWSAuditCopyIsCreateOnly(t *testing.T) {
	main, err := files.ReadFile("aws/main.tf")
	if err != nil {
		t.Fatal(err)
	}
	block := regexp.MustCompile(`(?s)data "aws_iam_policy_document" "console_audit" \{.*?\n\}`).Find(main)
	if block == nil {
		t.Fatal("no console_audit in aws/main.tf")
	}
	statements := regexp.MustCompile(`(?s)\n  statement \{.*?\n  \}`).FindAll(block, -1)
	puts := 0
	for _, s := range statements {
		if !strings.Contains(string(s), `"s3:PutObject"`) {
			continue
		}
		puts++
		if !regexp.MustCompile(`(?s)condition \{\s*test\s*= "StringEquals"\s*variable = "s3:if-none-match"\s*values\s*= \["\*"\]`).Match(s) {
			t.Errorf("console_audit grants s3:PutObject without requiring If-None-Match: *:\n%s", s)
		}
	}
	if puts == 0 {
		t.Fatal("console_audit grants no s3:PutObject")
	}
}
