// SPDX-License-Identifier: MIT

package config

import (
	"reflect"
	"strings"
)

// Setting is one key of vertra.yaml, as `vertra help settings` lists it.
type Setting struct {
	Key, About string
}

// Settings is every key of vertra.yaml, in the file's order, each said in a
// line: `vertra help settings`. A test keeps it to Config's keys.
var Settings = []Setting{
	{"version", "The file's format (vertra writes it)."},
	{"vertra", "The release to install (e.g. 0.6.0), or source to build from a checkout. Changing it and applying upgrades."},
	{"source", "With vertra: source, the Vertra checkout to build images and take charts from."},
	{"target", "Where it runs: kind (your machine), gcp, aws, or existing (a cluster you have)."},
	{"cluster.create", "Whether vertra makes the cluster (kind, gcp, aws) or uses one you have."},
	{"cluster.mode", "gcp, aws: auto (GKE Autopilot, EKS Auto Mode) or standard (node groups vertra sizes); existing."},
	{"cluster.name", "The cluster's name (kind, gcp, aws)."},
	{"cluster.context", "existing: the kubectl context of the cluster to install into."},
	{"cluster.cloud", "existing: the cloud the cluster is on (gcp, aws or azure), so the catalog's products made for that cloud run on it; empty, only those for every install."},
	{"kind.registryName", "kind: the local registry container's name (shared by kind clusters)."},
	{"kind.registryPort", "kind: the local registry's port on this machine (default 5001)."},
	{"gcp.project", "gcp: the Google Cloud project."},
	{"gcp.region", "gcp: the region (default us-central1)."},
	{"aws.profile", "aws: the AWS CLI profile to sign in with; empty for the default chain."},
	{"aws.region", "aws: the region."},
	{"namespace", "The platform's own namespace (default vertra-system)."},
	{"taskImages.registry", "Where steps' images may come from (the image policy's source), when vertra doesn't make it."},
	{"taskImages.create", "gcp, aws: make the registry steps' images come from (Artifact Registry, ECR)."},
	{"taskImages.name", "gcp, aws: that registry's name."},
	{"platformImages.registry", "existing, built from source: the registry the platform's images are pushed to."},
	{"size", "minimal, resilient, scaled or auto: copies, step caps, the database's size and connections (`vertra help sizes`)."},
	{"scaleDown.enabled", "Sleep when idle (scaled to zero, data kept); `vertra wake` or a schedule brings it back."},
	{"scaleDown.idleAfter", "With scaleDown: how long idle before sleeping (default 2h)."},
	{"scaleDown.schedule", "With scaleDown: also sleep at these times however recently used, a cron schedule (e.g. \"0 20 * * 1-5\", weekday evenings)."},
	{"minReplicas", "Without scaleDown: always-on copies of the console and kernel-api."},
	{"stepHeadroom", "Without scaleDown: steps that can start without waiting for a node (kept around the clock)."},
	{"database.type", "in-cluster (Postgres in a Pod, backed up to a bucket) or managed (gcp: Cloud SQL; aws: Amazon RDS); changing it to managed moves the data at apply."},
	{"database.highAvailability", "managed: a standby in a second zone, failed over to automatically."},
	{"database.backups.enabled", "Daily backups: of the in-cluster Postgres to a bucket; a managed database's are the cloud's."},
	{"database.backups.retentionDays", "How many days of backups are kept (at most 35 on RDS)."},
	{"admin.email", "The first admin's email: their password is generated at the first apply and saved to admin-password beside this file, readable only by you."},
	{"console.public", "gcp, aws, existing: reach the console over HTTPS from the internet (what catalog CI needs)."},
	{"console.hostname", "A public console's hostname (gcp default: a nip.io name; aws default: console.<zone>)."},
	{"console.zone", "aws: a DNS zone vertra makes in Route 53 for the console, which you delegate."},
	{"console.ingressClass", "existing: the Ingress controller serving a public console."},
	{"console.tls.issuer", "existing: a cert-manager ClusterIssuer for the console's certificate."},
	{"console.tls.letsEncryptEmail", "existing: Let's Encrypt for the console's certificate, with this contact email."},
	{"console.tls.installCertManager", "existing: install cert-manager when the cluster hasn't got it."},
	{"catalog.host", "The catalog repository's host: github."},
	{"catalog.owner", "The catalog repository's owner, an account or organization."},
	{"catalog.repository", "The catalog repository's name (default vertra-catalog)."},
	{"catalog.visibility", "public, private (default) or internal."},
	{"catalog.team", "The catalog's first team (default platform)."},
	{"catalog.languages", "The first team's starter languages: python, typescript, go, powershell, rust."},
	{"catalog.useExisting", "The catalog repository already existed: its contents stay."},
	{"catalog.subjectPrefix", "How GitHub names the repository in its OIDC tokens (vertra reads it)."},
	{"externalCatalog.registry", "Read another install's catalog: the registry holding its images and releases."},
	{"externalCatalog.gcpWorkloadIdentityProvider", "That catalog's Artifact Registry on another cloud: the provider this cluster federates through."},
	{"externalCatalog.gcpServiceAccount", "That catalog: a service account to impersonate, if not granted directly."},
	{"externalCatalog.awsRoleArn", "That catalog's Amazon ECR in another account or read from another cloud: the owner's role this cluster assumes (vertra catalog grant)."},
	{"catalogSignature.publicKeyFile", "That catalog's signing key (cosign, PEM), whose releases alone are applied."},
	{"catalogSignature.repository", "That catalog's repository, when its CI signs keyless."},
	{"externalSecrets", "Install External Secrets Operator, so teams' SecretStores sync their vaults' secrets."},
	{"catalogVersion", "Which catalog releases to apply: latest (each main publishes), newest (newest vX.Y.Z), or one version."},
	{"signing", "How catalog CI signs images and releases, which the install then requires: none, kms or keyless."},
	{"gateway.enabled", "The API gateway: serves the catalog's API products."},
	{"gateway.backendHosts", "Hosts the gateway may forward to (exactly, or *.example.com)."},
	{"gateway.internetTeams", "Teams that may publish APIs to the internet."},
	{"logs.enabled", "Keep steps' and the platform's logs for search in Observe (Loki)."},
	{"logs.searchDays", "How long logs stay searchable (then archived, on gcp and aws)."},
	{"logs.keepDays", "How long logs are kept at all."},
	{"audit.export", "gcp, aws: copy the audit log to a bucket that refuses deletes."},
	{"audit.keepDays", "How long that copy is kept."},
	{"audit.lock", "Lock the copy's retention for good: it can't be shortened or the bucket deleted until it lapses."},
	{"sso.provider", "Single sign-on: google (`vertra sso google`)."},
	{"sso.clientId", "Google's OAuth client id."},
	{"sso.clientFile", "The OAuth client's downloaded JSON, read at apply (its secret is never written here)."},
	{"sso.allowedDomains", "Google Workspace domains whose people may sign in."},
	{"sso.redirectUrl", "The console's sign-in callback, as registered with the client."},
	{"sso.googleGroups", "gcp: read people's Google Workspace groups, to map them to teams."},
	{"chat.off", "Turn off the console's chat agent on gcp (Vertex AI) and aws (Amazon Bedrock)."},
	{"chat.model", "The chat's model, in the cloud's name for it (default: a Gemini or Claude model)."},
	{"monitoring.enabled", "Prometheus for the platform's metrics and alerts (monitoring.provider says which)."},
	{"monitoring.provider", "operator (the cluster's Prometheus Operator: PodMonitors, alerts and a Grafana dashboard), google (gcp: GKE's Managed Service for Prometheus, billed per sample) bundled (a Prometheus of the install's own, on a 2 GiB volume) or amazon (aws: that one writing to Amazon Managed Service for Prometheus, its alerts to an SNS topic; a few dollars a month)."},
	{"monitoring.alertEmail", "amazon: an email subscribed to the alerts' SNS topic (it confirms by email)."},
	{"monitoring.namespace", "operator: the namespace the Prometheus Operator scrapes from."},
	{"monitoring.podMonitorLabels", "operator: labels it selects PodMonitors by."},
	{"monitoring.ruleLabels", "operator: labels it selects alerting rules by."},
	{"access.cloud", "Who set the environment up in the cloud: a run signed in as someone else stops first."},
	{"access.github", "Who set the catalog up on GitHub."},
	{"values", "A Helm values file layered last (relative to this directory): anything vertra doesn't ask about."},
}

// keysOf is every key of a settings type, dotted, in its fields' order.
func keysOf(t reflect.Type, prefix string) []string {
	var keys []string
	for i := range t.NumField() {
		f := t.Field(i)
		name := strings.Split(f.Tag.Get("yaml"), ",")[0]
		if name == "" || name == "-" {
			continue
		}
		key := name
		if prefix != "" {
			key = prefix + "." + name
		}
		if f.Type.Kind() == reflect.Struct {
			keys = append(keys, keysOf(f.Type, key)...)
		} else {
			keys = append(keys, key)
		}
	}
	return keys
}

// settingKind is a key's kind (string, bool, int, slice, map), and whether
// it's a setting.
func settingKind(key string) (reflect.Kind, bool) {
	t := reflect.TypeOf(Config{})
	for _, part := range strings.Split(key, ".") {
		if t.Kind() != reflect.Struct {
			return 0, false
		}
		found := false
		for i := range t.NumField() {
			if strings.Split(t.Field(i).Tag.Get("yaml"), ",")[0] == part {
				t, found = t.Field(i).Type, true
				break
			}
		}
		if !found {
			return 0, false
		}
	}
	if t.Kind() == reflect.Struct {
		return 0, false // a group of settings
	}
	return t.Kind(), true
}

// AllKeys is every key vertra.yaml can have.
func AllKeys() []string { return keysOf(reflect.TypeOf(Config{}), "") }
