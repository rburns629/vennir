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
