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
