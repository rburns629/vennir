// SPDX-License-Identifier: MIT

// Package gcp is what a gcp install needs from gcloud, run as you: the
// project's checks, the cluster's credentials for kubectl, and a short-lived
// sign-in for pushing images to Artifact Registry.
package gcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/roburns/vennir/cli/internal/cluster"
	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/run"
)

// State is what gcloud says about the project and the cluster.
type State struct {
	// Account is who gcloud is signed in as.
	Account string
	// ClusterStatus is the cluster's status (RUNNING, PROVISIONING, ...), or
	// "" if it doesn't exist yet.
	ClusterStatus string
	Problems      []string
	// Warnings don't stop an install, but say what may go wrong in it.
	Warnings []string
}

// autopilotNodeDiskGB is about what each GKE Autopilot node's boot disk
// counts against the region's SSD quota (counted, though not listed among
// the project's disks); roomForNodes is how many an install wants room for
// (the platform's, and a step's).
const (
	autopilotNodeDiskGB = 140
	roomForNodes        = 4
)

// SSDQuotaWarning says when the region's SSD quota has room for fewer
// Autopilot nodes than an install wants, from `gcloud compute regions
// describe --format=json(quotas)`; "" otherwise. A new project's 500 GB
// holds about three, so a step's node can't be added while three are up
// (found on GKE, 2026-10-25: the step waited until one scaled down).
func SSDQuotaWarning(regionJSON, region string) string {
	var described struct {
		Quotas []struct {
			Metric string  `json:"metric"`
			Limit  float64 `json:"limit"`
			Usage  float64 `json:"usage"`
		} `json:"quotas"`
	}
	if json.Unmarshal([]byte(regionJSON), &described) != nil {
		return ""
	}
	for _, q := range described.Quotas {
		if q.Metric != "SSD_TOTAL_GB" {
			continue
		}
		free := q.Limit - q.Usage
		if free >= autopilotNodeDiskGB*roomForNodes {
			return ""
		}
		return fmt.Sprintf("region %s's SSD quota has %.0f of %.0f GB free: room for about %d Autopilot nodes' boot disks, so a step may wait for a node until another scales down. Ask for more (SSD_TOTAL_GB, Compute Engine): https://console.cloud.google.com/iam-admin/quotas",
			region, free, q.Limit, int(free/autopilotNodeDiskGB))
	}
	return ""
}

// Inspect checks the project can take an install: it exists, you can see
// it, and billing is on.
func Inspect(ctx context.Context, r *run.Runner, c *config.Config) State {
	var s State
	project := c.GCP.Project
	// Each gcloud call is a second or two: they're made side by side, and
	// what they found is only used once the project is known to be visible.
	var projectErr, billingErr error
	var billing, regionJSON string
	run.Together(
		func() {
			s.Account, _ = r.Output(ctx, "gcloud", "auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
		},
		func() {
			_, projectErr = r.Output(ctx, "gcloud", "projects", "describe", project, "--format=value(projectId)")
		},
		func() {
			billing, billingErr = r.Output(ctx, "gcloud", "billing", "projects", "describe", project, "--format=value(billingEnabled)")
		},
		func() {
			// Only once Compute Engine's API is on (a new project's isn't): apply enables it.
			if c.Cluster.Mode == "auto" {
				regionJSON, _ = r.Output(ctx, "gcloud", "compute", "regions", "describe", c.GCP.Region, "--project", project, "--format=json(quotas)")
			}
		},
		func() {
			s.ClusterStatus, _ = r.Output(ctx, "gcloud", "container", "clusters", "list", "--project", project,
				"--filter=name="+c.Cluster.Name+" AND location="+cluster.GKELocation(c), "--format=value(status)")
		},
	)
	if projectErr != nil {
		s.Problems = append(s.Problems, fmt.Sprintf("can't see project %s as %s: check the id, or ask for access (`gcloud auth login` to switch accounts)", project, orUnknown(s.Account)))
		s.ClusterStatus = ""
		return s
	}
	switch {
	case billingErr != nil:
		s.Problems = append(s.Problems, fmt.Sprintf("can't read project %s's billing (you need billing.resourceAssociations.list, e.g. Project Billing Manager or Viewer): %v", project, billingErr))
	case !strings.EqualFold(billing, "true"):
		s.Problems = append(s.Problems, fmt.Sprintf("project %s has no billing account: link one (`gcloud billing projects link %s --billing-account=...`)", project, project))
	}
	if regionJSON != "" {
		if w := SSDQuotaWarning(regionJSON, c.GCP.Region); w != "" {
			s.Warnings = append(s.Warnings, w)
		}
	}
	return s
}

// BillingAccount is the project's billing account id, for account prices.
func BillingAccount(ctx context.Context, r *run.Runner, c *config.Config) string {
	out, err := r.Output(ctx, "gcloud", "billing", "projects", "describe", c.GCP.Project, "--format=value(billingAccountName)")
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(out, "billingAccounts/")
}

// Credentials adds the cluster to your kubeconfig (as cluster.Context), and
// puts your current context back: gcloud switches it.
func Credentials(ctx context.Context, r *run.Runner, c *config.Config) error {
	previous, _ := r.Output(ctx, "kubectl", "config", "current-context")
	if err := r.Run(ctx, "gcloud", "container", "clusters", "get-credentials", c.Cluster.Name,
		"--location", cluster.GKELocation(c), "--project", c.GCP.Project); err != nil {
		return err
	}
	if previous = strings.TrimSpace(previous); previous != "" && previous != cluster.Context(c) {
		return r.Run(ctx, "kubectl", "config", "use-context", previous)
	}
	return nil
}

// AccessToken is a short-lived token for your gcloud sign-in (prices,
// Docker). Never written anywhere.
func AccessToken(ctx context.Context, r *run.Runner) (string, error) {
	return r.Output(ctx, "gcloud", "auth", "print-access-token")
}

// DockerLogin signs Docker in to an Artifact Registry host with a
// short-lived token (an hour), passed on stdin.
func DockerLogin(ctx context.Context, r *run.Runner, host string) error {
	token, err := AccessToken(ctx, r)
	if err != nil {
		return err
	}
	return r.RunInput(ctx, token, "docker", "login", "--username", "oauth2accesstoken", "--password-stdin", "https://"+host)
}

func orUnknown(s string) string {
	if s == "" {
		return "(nobody: `gcloud auth login`)"
	}
	return s
}

// TaskRegistry is the Artifact Registry path steps' images come from.
func TaskRegistry(c *config.Config) string {
	if !c.TaskImages.Create && c.TaskImages.Registry != "" {
		return c.TaskImages.Registry
	}
	return fmt.Sprintf("%s-docker.pkg.dev/%s/%s", c.GCP.Region, c.GCP.Project, c.TaskImages.Name)
}

// PlatformRepository is the repository the module creates for platform
// images built from source ("" when installing a release).
func PlatformRepository(c *config.Config) string {
	if c.Vennir != "source" {
		return ""
	}
	return c.Cluster.Name + "-platform"
}

// PlatformRegistry is that repository's path.
func PlatformRegistry(c *config.Config) string {
	if c.Vennir != "source" {
		return ""
	}
	return fmt.Sprintf("%s-docker.pkg.dev/%s/%s", c.GCP.Region, c.GCP.Project, PlatformRepository(c))
}

// Vars are the module's inputs, from the config.
func Vars(c *config.Config, deleteData bool) map[string]any {
	return map[string]any{
		"project":              c.GCP.Project,
		"region":               c.GCP.Region,
		"name":                 c.Cluster.Name,
		"mode":                 c.Cluster.Mode,
		"size":                 c.Size,
		"namespace":            c.Namespace,
		"step_headroom":        c.StepHeadroom,
		"task_registry":        c.TaskImages.Name,
		"create_task_registry": c.TaskImages.Create,
		"platform_registry":    PlatformRepository(c),
		// A managed database backs itself up: no bucket, no backup Jobs.
		"backups":                    c.Database.Backups.Enabled && c.Database.Type != "managed",
		"backup_retention_days":      c.Database.Backups.RetentionDays,
		"managed_database":           c.Database.Type == "managed",
		"database_high_availability": c.Database.Type == "managed" && c.Database.HighAvailability,
		"logs":                       c.Logs.Enabled,
		"log_search_days":            c.Logs.SearchDays,
		"log_keep_days":              c.Logs.KeepDays,
		"audit_export":               c.Audit.Export,
		"audit_keep_days":            c.Audit.KeepDays,
		"audit_lock":                 c.Audit.Lock,
		"delete_data":                deleteData,
		"console_public":             c.Console.Public,
		"catalog_repository":         c.Catalog.Repo(),
		"catalog_repository_id":      c.Catalog.RepositoryID,
		"catalog_owner_id":           c.Catalog.OwnerID,
		"google_groups":              c.SSO.GoogleGroups,
		"chat":                       c.ChatOnVertex(),
		"managed_prometheus":         c.Monitoring.Enabled && c.Monitoring.ProviderName() == "google",
		"signing":                    orNone(c.ModuleSigning()),
	}
}

// orNone is a setting that's "none" when unset.
func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

// gcpKMSKey reads gcpkms://projects/P/locations/L/keyRings/R/cryptoKeys/K.
var gcpKMSKey = regexp.MustCompile(`^gcpkms://projects/([^/]+)/locations/([^/]+)/keyRings/([^/]+)/cryptoKeys/([^/]+)$`)

// SigningPublicKey is the catalog signing key's public half (PEM), read as
// you: only it is needed to verify, never the key itself.
func SigningPublicKey(ctx context.Context, r *run.Runner, key string) (string, error) {
	m := gcpKMSKey.FindStringSubmatch(key)
	if m == nil {
		return "", fmt.Errorf("%q isn't a Cloud KMS key", key)
	}
	file, err := os.CreateTemp("", "vennir-signing-*.pem")
	if err != nil {
		return "", err
	}
	file.Close()
	defer os.Remove(file.Name())
	if err := r.Run(ctx, "gcloud", "kms", "keys", "versions", "get-public-key", "1", "--project", m[1], "--location", m[2],
		"--keyring", m[3], "--key", m[4], "--output-file", file.Name()); err != nil {
		return "", err
	}
	pem, err := os.ReadFile(file.Name())
	if err != nil {
		return "", err
	}
	if !strings.Contains(string(pem), "BEGIN PUBLIC KEY") {
		return "", fmt.Errorf("Cloud KMS gave no PEM public key for %s", key)
	}
	return string(pem), nil
}

// LeftDisks are persistent disks a namespace's claims made that nothing
// has attached (zone/name): what a cluster deleted without its volume
// claims leaves. GKE's driver names the claim's namespace in the
// description; another cluster's unattached disks for the same namespace
// match too, so they're only listed, never deleted.
func LeftDisks(ctx context.Context, r *run.Runner, c *config.Config, namespace string) ([]string, error) {
	out, err := r.Output(ctx, "gcloud", "compute", "disks", "list", "--project", c.GCP.Project,
		`--filter=description~"kubernetes.io/created-for/pvc/namespace\":\"`+namespace+`\"" AND -users:*`,
		"--format=value(zone.basename(),name)")
	if err != nil {
		return nil, err
	}
	var disks []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if f := strings.Fields(line); len(f) == 2 {
			disks = append(disks, f[0]+"/"+f[1])
		}
	}
	return disks, nil
}
