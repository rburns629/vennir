// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/spf13/cobra"

	"github.com/rburns629/vertra/cli/internal/awscloud"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/gcp"
	"github.com/rburns629/vertra/cli/internal/grant"
	"github.com/rburns629/vertra/cli/internal/plan"
)

// grantOptions are `vertra catalog grant`'s flags.
type grantOptions struct {
	reader                         grant.Reader
	revoke, replace, yes, planOnly bool
}

func (a *app) catalogGrantCmd() *cobra.Command {
	var o grantOptions
	cmd := &cobra.Command{
		Use:   "grant [env]",
		Short: "Let another install read this install's catalog (its images and release), as exactly its own identity",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			return a.catalogGrant(cmd.Context(), cmd.OutOrStdout(), envName(dir), c, o)
		},
	}
	f := cmd.Flags()
	f.StringVar(&o.reader.Name, "reader", "", "the reading install's cluster `NAME`, naming what the grant makes")
	f.StringVar(&o.reader.Issuer, "issuer", "", "the reader's cluster's OIDC issuer `URL`")
	f.StringVar(&o.reader.Subject, "subject", "", "the reader's console ServiceAccount, as its tokens name it (`SUBJECT`)")
	f.StringArrayVar(&o.reader.ServiceAccounts, "service-account", nil, "a reader on Google Cloud: one of its service accounts (`EMAIL`; repeat it)")
	f.BoolVar(&o.revoke, "revoke", false, "take the grant away instead")
	f.BoolVar(&o.replace, "replace", false, "aws: change (or with --revoke, delete) the reader's role even when it trusts another issuer or subject (another reader of the same name)")
	f.BoolVarP(&o.yes, "yes", "y", false, "approve without asking")
	f.BoolVar(&o.planOnly, "plan-only", false, "show what it would do and stop")
	_ = cmd.MarkFlagRequired("reader")
	return cmd
}

func (a *app) catalogGrant(ctx context.Context, out io.Writer, env string, c *config.Config, o grantOptions) error {
	if c.Target != "gcp" && c.Target != "aws" {
		return errors.New("the catalog's registry is a gcp or aws install's: run this in that install's environment")
	}
	if err := o.reader.Validate(c.Target); err != nil {
		return err
	}
	if c.ExternalCatalog.Registry != "" {
		return fmt.Errorf("this install reads another's catalog (externalCatalog.registry %s): run this in the owner's environment", c.ExternalCatalog.Registry)
	}
	var p *grant.Plan
	var err error
	if c.Target == "gcp" {
		var owner grant.GCPOwner
		if owner, err = grant.ArtifactRegistry(gcp.TaskRegistry(c)); err != nil {
			return err
		}
		owner.Project = c.GCP.Project
		p, err = grant.PlanGCP(ctx, a.runner.Output, owner, o.reader, o.revoke)
	} else {
		if c.TaskImages.Name == "" {
			return errors.New("taskImages.name is empty: the ECR prefix the catalog publishes under")
		}
		p, err = grant.PlanAWS(ctx, a.runner.Output, grant.AWSOwner{Region: c.AWS.Region, Prefix: c.TaskImages.Name, Args: awscloud.Args(c)}, o.reader, o.revoke, o.replace)
	}
	if err != nil {
		return err
	}

	verb := "Grant"
	if o.revoke {
		verb = "Revoke"
	}
	screen := &plan.Plan{
		Title: fmt.Sprintf("%s %s read on the catalog in %s [%s]", verb, o.reader.Name, p.Registry, env),
		Access: []plan.Line{
			{Label: "Signed in", Text: orDefault(p.SignedIn, "unknown") + "; the changes run as you"},
		},
		Settings: []plan.Line{
			{Label: "Reader", Text: p.Identity},
			{Label: "May", Text: p.Access},
		},
		Notes: p.Notes,
	}
	for _, act := range p.Actions {
		screen.Changes = append(screen.Changes, plan.Line{Label: act.Label, Text: act.Text})
	}
	screen.Render(out)
	if !p.Changes() {
		fmt.Fprintln(out, "Nothing to change.")
		grantNext(out, o, p)
		return nil
	}
	if o.planOnly {
		return nil
	}
	if !o.yes {
		ok, err := a.ask.Confirm("Go ahead?", false)
		if err != nil {
			return err
		}
		if !ok || !a.ask.Interactive {
			return errStopped
		}
	}
	if err := p.Apply(ctx, a.runner.Output, func(act grant.Action) { fmt.Fprintf(out, "%s %s...\n", act.Label, act.Text) }); err != nil {
		return err
	}
	grantNext(out, o, p)
	return nil
}

// grantNext says what the reader does now.
func grantNext(out io.Writer, o grantOptions, p *grant.Plan) {
	switch {
	case o.revoke:
		fmt.Fprintf(out, "%s can no longer read %s.\n", o.reader.Name, p.Registry)
	case p.ReaderSets[0] != "":
		fmt.Fprintf(out, "Granted. In %s's environment:\n  vertra config set %s %s\n  vertra apply\n", o.reader.Name, p.ReaderSets[0], p.ReaderSets[1])
	default:
		fmt.Fprintf(out, "Granted: %s reads %s as itself.\n", o.reader.Name, p.Registry)
	}
}
