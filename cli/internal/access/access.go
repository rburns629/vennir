// SPDX-License-Identifier: MIT

// Package access finds out who you're signed in as, where an install would
// go, and what that place allows, before anything is planned: detect, show,
// then ask. Each cloud's check returns a Report: lines for the approval
// screen's Access block, and problems, each with its fix and, where a
// browser is needed, a guide.
package access

import (
	"context"
	"regexp"
	"strings"

	"github.com/rburns629/vennir/cli/internal/plan"
)

// Exec runs a command and returns its output; the checks take one so tests
// can answer as the clouds do.
type Exec func(ctx context.Context, name string, args ...string) (string, error)

// Problem is something to fix before an install can go ahead.
type Problem struct {
	Text  string
	Fix   string
	Guide string // a section of docs/clouds/, for what only a browser does
}

// Report is what a check found.
type Report struct {
	Lines    []plan.Line
	Problems []Problem
	// Identity is who is signed in, recorded in the config so later runs
	// notice a different sign-in.
	Identity string
}

func (r *Report) line(label, text string) {
	r.Lines = append(r.Lines, plan.Line{Label: label, Text: text})
}

func (r *Report) problem(text, fix, guide string) {
	r.Problems = append(r.Problems, Problem{Text: text, Fix: fix, Guide: guide})
}

// Kind is what an AWS refusal means.
type Kind int

const (
	OK Kind = iota
	// DeniedByOrganization: an organization's policy (an SCP) denies it,
	// whatever the account's own permissions say.
	DeniedByOrganization
	// NotPermitted: the signed-in identity's own permissions lack it.
	NotPermitted
	// NotSignedIn: no credentials, or expired ones.
	NotSignedIn
	// Failed: anything else.
	Failed
)

var scpARN = regexp.MustCompile(`arn:aws[-a-z]*:organizations::\d+:policy/[\w/-]+`)

// ClassifyAWS reads an AWS CLI call's whole output and error (never only
// its first line: the CLI prints a blank line before an error), and
// returns what it means and, for an organization's denial, the policy.
func ClassifyAWS(out string, err error) (Kind, string) {
	if err == nil {
		return OK, ""
	}
	text := out + "\n" + err.Error()
	switch {
	case strings.Contains(text, "service control policy"):
		return DeniedByOrganization, scpARN.FindString(text)
	case strings.Contains(text, "UnauthorizedOperation"), strings.Contains(text, "AccessDenied"),
		strings.Contains(text, "is not authorized to perform"):
		return NotPermitted, ""
	case strings.Contains(text, "Unable to locate credentials"), strings.Contains(text, "ExpiredToken"),
		strings.Contains(text, "token has expired"), strings.Contains(text, "aws login"),
		strings.Contains(text, "The config profile") && strings.Contains(text, "could not be found"),
		strings.Contains(text, "InvalidClientTokenId"), strings.Contains(text, "Error loading SSO Token"):
		return NotSignedIn, ""
	}
	return Failed, ""
}
