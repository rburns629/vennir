// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/rburns629/vertra/cli/internal/access"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/install"
	"github.com/rburns629/vertra/cli/internal/prompt"
)

// guidesURL is where docs/clouds/ is published (the repository's).
const guidesURL = "https://github.com/rburns629/vertra/blob/main/docs/clouds/"

// showReport prints what a check found: its lines, then each problem with
// its fix and guide.
func showReport(out io.Writer, r access.Report) {
	for _, l := range r.Lines {
		fmt.Fprintf(out, "  %-10s %s\n", l.Label, l.Text)
	}
	for _, p := range r.Problems {
		fmt.Fprintf(out, "  ✗ %s\n", p.Text)
		if p.Fix != "" {
			fmt.Fprintf(out, "    fix: %s\n", p.Fix)
		}
		if p.Guide != "" {
			fmt.Fprintf(out, "    guide: %s%s\n", guidesURL, p.Guide)
		}
	}
}

func problemsError(r access.Report) error {
	if len(r.Problems) == 0 {
		return nil
	}
	var texts []string
	for _, p := range r.Problems {
		texts = append(texts, p.Text+": "+p.Fix)
	}
	return fmt.Errorf("access problems:\n  - %s", strings.Join(texts, "\n  - "))
}

// awsAccess picks the profile (signing it in if needed), shows who it is
// and what the account allows, and picks a region from those that answer.
func (a *app) awsAccess(ctx context.Context, out io.Writer, c *config.Config, f *initFlags) (*access.AWS, error) {
	profiles := access.AWSProfiles(ctx, a.runner.Exec)
	profile := orDefault(f.profile, os.Getenv("AWS_PROFILE"))
	switch {
	case profile != "":
	case len(profiles) == 0:
		fmt.Fprintln(out, "No AWS CLI profile yet. For one person, sign in as an IAM user with `aws login` (it opens your browser;")
		fmt.Fprintln(out, "never root, never access keys); for a team, IAM Identity Center with `aws configure sso`.")
		fmt.Fprintln(out, "  guide: "+guidesURL+"aws.md")
		profile = "vertra"
	default:
		var options []prompt.Option
		for _, p := range profiles {
			options = append(options, prompt.Option{Value: p, Label: p})
		}
		options = append(options, prompt.Option{Value: "+new", Label: "a new profile, signed in now", Note: "`aws login --profile vertra`"})
		def := profiles[0]
		if contains(profiles, "vertra") {
			def = "vertra"
		}
		var err error
		if profile, err = a.ask.Choose("Which AWS CLI profile signs in?", options, def); err != nil {
			return nil, err
		}
		if profile == "+new" {
			profile = "vertra"
		}
	}
	c.AWS.Profile = profile

	check := access.CheckAWS(ctx, a.runner.Exec, profile, "")
	if check.Account == "" && a.ask.Interactive {
		ok, err := a.ask.Confirm(fmt.Sprintf("Profile %s isn't signed in. Sign in now with `aws login --profile %s` (opens your browser)?", profile, profile), true)
		if err != nil {
			return nil, err
		}
		if ok {
			if err := a.runner.Interactive(ctx, "aws", "login", "--profile", profile); err != nil {
				return nil, err
			}
			check = access.CheckAWS(ctx, a.runner.Exec, profile, "")
		}
	}
	if check.Account == "" || check.Root {
		showReport(out, check.Report)
		return nil, problemsError(check.Report)
	}

	// The region: from those that answer for this account, the one asked
	// for (an opt-in region, say) among them if it does.
	if f.region != "" && !contains(access.AWSRegions, f.region) {
		check.ProbeRegion(ctx, a.runner.Exec, profile, f.region)
	}
	def := orDefault(f.region, "us-east-2")
	if !contains(check.Allowed, def) && len(check.Allowed) > 0 {
		def = check.Allowed[0]
	}
	if f.region != "" && !contains(check.Allowed, f.region) {
		why := "doesn't answer for this account"
		if check.Denied[f.region] != "" {
			why = "is denied to this account by your organization's policy"
		}
		if !a.ask.Interactive {
			return nil, fmt.Errorf("%s %s: use one of %s", f.region, why, strings.Join(check.Allowed, ", "))
		}
		fmt.Fprintf(out, "  %s %s.\n", f.region, why)
	}
	var options []prompt.Option
	for _, r := range check.Allowed {
		options = append(options, prompt.Option{Value: r, Label: r})
	}
	if len(check.Denied) > 0 {
		fmt.Fprintf(out, "  Your organization's policy allows this account only: %s.\n", strings.Join(check.Allowed, ", "))
	}
	region, err := a.ask.Choose("Region:", options, def)
	if err != nil {
		return nil, err
	}
	c.AWS.Region = region

	check = access.CheckAWS(ctx, a.runner.Exec, profile, region)
	fmt.Fprintln(out, "Access")
	showReport(out, check.Report)
	if err := problemsError(check.Report); err != nil {
		return nil, err
	}
	c.Access.Cloud = check.Identity
	return check, nil
}

// offerBudget offers a monthly budget, emailing the admin, when the account
// has none (not when its budgets couldn't be read). A budget it couldn't
// create is a warning: init's answers so far are kept.
func (a *app) offerBudget(ctx context.Context, out io.Writer, c *config.Config, check *access.AWS) error {
	if check == nil || check.Budgets > 0 || check.BudgetsUnread || !a.ask.Interactive {
		return nil
	}
	ok, err := a.ask.Confirm("This AWS account has no budget. Create one that emails "+c.Admin.Email+" before spending passes a monthly amount?", true)
	if err != nil || !ok {
		return err
	}
	amount, err := a.ask.Number("Monthly amount, in USD", 20, 1, 100000)
	if err != nil {
		return err
	}
	budget, _ := json.Marshal(map[string]any{
		"BudgetName": "vertra-" + c.Cluster.Name + "-monthly", "BudgetType": "COST", "TimeUnit": "MONTHLY",
		"BudgetLimit": map[string]string{"Amount": fmt.Sprint(amount), "Unit": "USD"},
		"CostTypes":   map[string]bool{"IncludeCredit": false, "IncludeRefund": false},
	})
	var notes []map[string]any
	for _, n := range []struct {
		kind      string
		threshold int
	}{{"ACTUAL", 85}, {"ACTUAL", 100}, {"FORECASTED", 100}} {
		notes = append(notes, map[string]any{
			"Notification": map[string]any{"NotificationType": n.kind, "ComparisonOperator": "GREATER_THAN", "Threshold": n.threshold, "ThresholdType": "PERCENTAGE"},
			"Subscribers":  []map[string]string{{"SubscriptionType": "EMAIL", "Address": c.Admin.Email}},
		})
	}
	subscribers, _ := json.Marshal(notes)
	args := []string{"budgets", "create-budget", "--account-id", check.Account, "--budget", string(budget),
		"--notifications-with-subscribers", string(subscribers), "--region", "us-east-1"}
	if c.AWS.Profile != "" {
		args = append(args, "--profile", c.AWS.Profile)
	}
	if err := a.runner.Run(ctx, "aws", args...); err != nil {
		fmt.Fprintf(out, "  Warning: the budget wasn't created (%v); set one in the Billing console.\n", err)
		return nil
	}
	fmt.Fprintf(out, "  Budget created: $%d a month; emails at 85%% and 100%%, and if the forecast passes it.\n", amount)
	return nil
}

// gcpAccess shows the gcloud sign-ins (and OpenTofu's), and picks the
// project from those you can use.
func (a *app) gcpAccess(ctx context.Context, out io.Writer, c *config.Config, f *initFlags) error {
	check := access.CheckGCP(ctx, a.runner.Exec, access.GoogleTokenEmail, "", "")
	if check.Active == "" {
		showReport(out, check.Report)
		return problemsError(check.Report)
	}
	if len(check.Accounts) > 1 && a.ask.Interactive {
		var options []prompt.Option
		for _, acct := range check.Accounts {
			options = append(options, prompt.Option{Value: acct, Label: acct})
		}
		chosen, err := a.ask.Choose("Which Google account?", options, check.Active)
		if err != nil {
			return err
		}
		if chosen != check.Active {
			ok, err := a.ask.Confirm("Switch gcloud's active account to "+chosen+" (`gcloud config set account`)?", true)
			if err != nil || !ok {
				return fmt.Errorf("stopped: gcloud is signed in as %s", check.Active)
			}
			if err := a.runner.Run(ctx, "gcloud", "config", "set", "account", chosen); err != nil {
				return err
			}
			check = access.CheckGCP(ctx, a.runner.Exec, access.GoogleTokenEmail, "", "")
		}
	}
	if (check.ADC == "" || check.ADC != check.Active) && a.ask.Interactive {
		ok, err := a.ask.Confirm("OpenTofu signs in separately (application-default credentials). Sign it in as "+check.Active+" now (opens your browser)?", check.ADC != check.Active)
		if err != nil {
			return err
		}
		if ok {
			if err := a.runner.Interactive(ctx, "gcloud", "auth", "application-default", "login"); err != nil {
				return err
			}
		}
	}

	// The project: from those this account can see.
	projects := access.GCPProjects(ctx, a.runner.Exec)
	current, _ := a.runner.Output(ctx, "gcloud", "config", "get-value", "project")
	def := orDefault(f.project, current)
	if len(projects) > 0 {
		var options []prompt.Option
		for _, p := range projects {
			options = append(options, prompt.Option{Value: p.ID, Label: p.ID, Note: p.Name})
		}
		if def == "" || !hasProject(projects, def) {
			def = projects[0].ID
		}
		var err error
		if c.GCP.Project, err = a.ask.Choose("Which project? (one of its own is safest: Vertra creates a cluster, network and identities in it)", options, def); err != nil {
			return err
		}
	} else {
		var err error
		if c.GCP.Project, err = a.ask.Text("Google Cloud project (it must exist, with billing)", def, nil); err != nil {
			return err
		}
	}
	if c.GCP.Region == "" {
		var err error
		if c.GCP.Region, err = a.ask.Text("Region", orDefault(f.region, "us-central1"), nil); err != nil {
			return err
		}
	}
	check = access.CheckGCP(ctx, a.runner.Exec, access.GoogleTokenEmail, c.GCP.Project, c.GCP.Region)
	fmt.Fprintln(out, "Access")
	showReport(out, check.Report)
	if err := problemsError(check.Report); err != nil {
		return err
	}
	c.Access.Cloud = check.Identity
	return nil
}

// githubAccess shows gh's sign-ins and picks the one the catalog uses.
func (a *app) githubAccess(ctx context.Context, out io.Writer, c *config.Config) (string, error) {
	check := access.CheckGitHub(ctx, a.runner.Exec)
	if check.Active == "" {
		showReport(out, check.Report)
		return "", problemsError(check.Report)
	}
	if len(check.Accounts) > 1 && a.ask.Interactive {
		var options []prompt.Option
		for _, acct := range check.Accounts {
			options = append(options, prompt.Option{Value: acct, Label: acct})
		}
		chosen, err := a.ask.Choose("Which GitHub account creates the catalog?", options, check.Active)
		if err != nil {
			return "", err
		}
		if chosen != check.Active {
			if err := a.runner.Run(ctx, "gh", "auth", "switch", "--hostname", "github.com", "--user", chosen); err != nil {
				return "", err
			}
			check = access.CheckGitHub(ctx, a.runner.Exec)
		}
	}
	showReport(out, check.Report)
	c.Access.GitHub = check.Identity
	return check.Active, nil
}

func hasProject(projects []access.GCPProject, id string) bool {
	for _, p := range projects {
		if p.ID == id {
			return true
		}
	}
	return false
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// askConsole asks how the console is reached, with what each way costs and
// gives up, and what a public one needs on this cloud.
func (a *app) askConsole(ctx context.Context, out io.Writer, c *config.Config, f *initFlags) error {
	publicNote := "HTTPS from the internet, for people outside the cluster's network: a load balancer (about $18 a month) and a sign-in page on the internet (rate-limited)"
	if c.Target == "aws" {
		publicNote += "; needs a DNS zone you can delegate to Route 53, and Auto Mode"
	} else {
		publicNote += "; a nip.io name by default, or a hostname of yours"
	}
	choice, err := a.ask.Choose("How should the console be reached?", []prompt.Option{
		{Value: "private", Label: "private", Note: "nothing outside the cluster: `vertra console` port-forwards to it; a catalog works either way (its CI only pushes to the registry)"},
		{Value: "public", Label: "public", Note: publicNote},
	}, orDefault(f.console, "private"))
	if err != nil {
		return err
	}
	c.Console.Public = choice == "public"
	if !c.Console.Public {
		return nil
	}
	c.Console.Hostname = f.hostname
	switch c.Target {
	case "gcp":
		if c.Console.Hostname, err = a.ask.Text("Hostname (empty: a nip.io name for its address)", f.hostname, func(string) error { return nil }); err != nil && a.ask.Interactive {
			return err
		}
		c.Console.Hostname = orDefault(c.Console.Hostname, f.hostname)
	case "aws":
		if c.Cluster.Mode != "auto" {
			ok, err := a.ask.Confirm("A public console on aws needs Auto Mode (standard mode would need the AWS Load Balancer Controller, not yet). Switch to Auto Mode?", true)
			if err != nil {
				return err
			}
			if !ok {
				c.Console.Public = false
				return nil
			}
			c.Cluster.Mode = "auto"
		}
		if c.Console.Zone, err = a.ask.Text("DNS zone for it, created in Route 53 (e.g. vertra.example.com: you then add its NS records where the parent domain lives)", f.zone, nil); err != nil {
			return err
		}
	}
	return nil
}

// askExistingConsole asks whether an existing cluster's console is reached
// over HTTPS, and how: its hostname, the Ingress class that serves it, and
// its certificate from cert-manager (installed by vertra if it's missing).
func (a *app) askExistingConsole(ctx context.Context, out io.Writer, c *config.Config) error {
	public, err := a.ask.Confirm("Reach the console over HTTPS at a hostname of yours (an Ingress, and a certificate from cert-manager)? No: `vertra console` port-forwards to it", false)
	if err != nil || !public {
		return err
	}
	c.Console.Public = true
	if c.Console.Hostname, err = a.ask.Text("Hostname, pointed at your Ingress controller", c.Console.Hostname, nil); err != nil {
		return err
	}
	classes, _ := a.runner.Output(ctx, "kubectl", "--context", c.Cluster.Context, "get", "ingressclass", "-o", "jsonpath={.items[*].metadata.name}")
	var options []prompt.Option
	for _, name := range strings.Fields(classes) {
		options = append(options, prompt.Option{Value: name, Label: name})
	}
	if len(options) == 0 {
		if c.Console.IngressClass, err = a.ask.Text("Ingress class (none found in the cluster: install a controller first)", c.Console.IngressClass, nil); err != nil {
			return err
		}
	} else if c.Console.IngressClass, err = a.ask.Choose("Which Ingress class serves it?", options, options[0].Value); err != nil {
		return err
	}
	source, err := a.ask.Choose("Where does its certificate come from?", []prompt.Option{
		{Value: "letsencrypt", Label: "Let's Encrypt", Note: "free, renewed by itself; the hostname must reach the Ingress from the internet"},
		{Value: "issuer", Label: "an issuer of yours", Note: "a cert-manager ClusterIssuer already in the cluster, e.g. your internal CA"},
	}, "letsencrypt")
	if err != nil {
		return err
	}
	c.Console.TLS.Issuer, c.Console.TLS.LetsEncryptEmail = "", ""
	if source == "issuer" {
		if c.Console.TLS.Issuer, err = a.ask.Text("ClusterIssuer name", "", nil); err != nil {
			return err
		}
	} else if c.Console.TLS.LetsEncryptEmail, err = a.ask.Text("Email for Let's Encrypt (expiry warnings)", c.Admin.Email, nil); err != nil {
		return err
	}
	if !a.runner.Succeeds(ctx, "kubectl", "--context", c.Cluster.Context, "get", "crd", "certificates.cert-manager.io") {
		if c.Console.TLS.InstallCertManager, err = a.ask.Confirm(fmt.Sprintf("cert-manager isn't installed. Install it (%s, into cert-manager)?", install.CertManagerChart), true); err != nil {
			return err
		}
		if !c.Console.TLS.InstallCertManager {
			fmt.Fprintln(out, "Install cert-manager before `vertra apply`: it issues the console's certificate.")
		}
	}
	return nil
}

// askFeatures asks about what else the install keeps and serves, each with
// what it adds: log search, the audit log's write-once copy (and its lock,
// which is permanent), and the API gateway. A flag answers without asking.
func (a *app) askFeatures(out io.Writer, c *config.Config, f *initFlags) error {
	yes := func(flag string, question string, def bool) (bool, error) {
		if flag != "" {
			return flag == "true", nil
		}
		return a.ask.Confirm(question, def)
	}
	cloud := c.Target == "gcp" || c.Target == "aws"

	logs := "Keep steps' and the platform's logs for search in Observe (Loki; about 0.15 vCPU and 0.4 GiB while awake)"
	if cloud {
		logs += "? Searchable 30 days, then archived in a bucket (cents a GB) and deleted after a year"
	} else {
		logs += "? Searchable 30 days, on a volume"
	}
	var err error
	if c.Logs.Enabled, err = yes(f.logs, logs, c.Logs.Enabled); err != nil {
		return err
	}

	if cloud {
		if c.Audit.Export, err = yes(f.auditExport, "Copy the audit log every few minutes to a bucket that refuses deletes and overwrites (a year's retention; cents a month)?", true); err != nil {
			return err
		}
		if c.Audit.Export {
			fmt.Fprintln(out, "Locking that bucket's retention is permanent: nobody, your cloud account's owners included, can shorten it,")
			fmt.Fprintln(out, "and the bucket can't be deleted until the last copy's year is up. Unlocked, an account admin still could.")
			if c.Audit.Lock, err = yes(f.auditLock, "Lock it?", false); err != nil {
				return err
			}
		}
	}

	if c.Gateway.Enabled, err = yes(f.gateway, "Serve the catalog's API products through the API gateway (a small Deployment; backends it may reach listed later under gateway.backendHosts in vertra.yaml)?", c.Gateway.Enabled); err != nil {
		return err
	}
	// A catalog's SecretStores (teams/<team>/secret-stores) need it; without
	// it the console refuses them, saying so.
	if c.ExternalSecrets, err = yes(f.externalSecrets, "Install External Secrets Operator, so teams' SecretStores sync secrets from their vaults (a catalog with teams/<team>/secret-stores needs it)?", c.ExternalSecrets); err != nil {
		return err
	}
	return nil
}

// askMonitoring offers Prometheus for the platform's metrics and alerts:
// the cluster's Prometheus Operator when one runs there (its PodMonitors,
// alerts and Grafana dashboard), GKE's Managed Service for Prometheus on
// gcp, Amazon Managed Service for Prometheus on aws, or a Prometheus of the
// install's own. --monitoring answers it: false, operator (or true),
// google, amazon or bundled.
func (a *app) askMonitoring(ctx context.Context, out io.Writer, c *config.Config, f *initFlags) error {
	if f.monitoring == "false" {
		return nil
	}
	var p *install.Prometheus
	if c.Target == "kind" || c.Target == "existing" {
		p = install.FindPrometheus(ctx, a.runner, c)
	}
	operator := func() {
		c.Monitoring = config.Monitoring{Enabled: true, Provider: "operator", Namespace: p.Namespace, PodMonitorLabels: p.PodMonitorLabels, RuleLabels: p.RuleLabels}
		fmt.Fprintf(out, "Monitoring: scraped from %s; its alerts and dashboard go to that Prometheus and Grafana.\n", p.Namespace)
	}
	choice := f.monitoring
	if choice == "true" {
		choice = "operator"
	}
	switch choice {
	case "operator":
		if p == nil {
			return fmt.Errorf("--monitoring operator: no Prometheus Operator in this cluster (kube-prometheus-stack, for one)")
		}
		operator()
		return nil
	case "google", "bundled", "amazon":
		c.Monitoring = config.Monitoring{Enabled: true, Provider: choice, AlertEmail: c.Monitoring.AlertEmail}
		return a.askAlertEmail(c)
	case "":
	default:
		return fmt.Errorf("--monitoring: %q isn't false, operator, google, amazon or bundled", f.monitoring)
	}

	if p != nil {
		on, err := a.ask.Confirm(fmt.Sprintf("A Prometheus Operator runs in %s. Add Vertra's PodMonitors, alerts and Grafana dashboard for it?", p.Namespace), true)
		if err != nil || on {
			if on {
				operator()
			}
			return err
		}
	}
	options := []prompt.Option{
		{Value: "none", Label: "None", Note: "Observe's Metrics tab needs no Prometheus; this is for alerts and your own queries"},
		{Value: "bundled", Label: "A Prometheus of its own", Note: "one Pod (about 0.05 vCPU, 0.25 GiB) and a 2 GiB volume; its alerts on its own page"},
	}
	switch c.Target {
	case "gcp":
		options = append(options, prompt.Option{Value: "google", Label: "Google Cloud Managed Service for Prometheus",
			Note: "billed per sample: Vertra's few hundred series, a few dollars a month; alerts through Cloud Monitoring"})
	case "aws":
		options = append(options, prompt.Option{Value: "amazon", Label: "Amazon Managed Service for Prometheus",
			Note: "a Prometheus of its own writing to it: a few dollars a month; alerts emailed through SNS"})
	}
	choice, err := a.ask.Choose("Prometheus for the platform's metrics and alerts?", options, "none")
	if err != nil {
		return err
	}
	if choice != "none" {
		c.Monitoring = config.Monitoring{Enabled: true, Provider: choice}
	}
	return a.askAlertEmail(c)
}

// askAlertEmail asks where Amazon Managed Prometheus's alerts are emailed:
// the first admin's address unless another is given (monitoring.alertEmail
// later, empty for none).
func (a *app) askAlertEmail(c *config.Config) error {
	if !c.Monitoring.Enabled || c.Monitoring.ProviderName() != "amazon" || c.Monitoring.AlertEmail != "" {
		return nil
	}
	email, err := a.ask.Text("Email the alerts to (the address confirms the subscription)", c.Admin.Email, validEmail)
	if err != nil {
		return err
	}
	c.Monitoring.AlertEmail = email
	return nil
}
