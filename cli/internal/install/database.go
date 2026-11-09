// SPDX-License-Identifier: MIT

package install

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/roburns/vennir/cli/internal/cluster"
	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/run"
)

// ManagedDatabase is a managed database the module made (database.type
// managed), signed in to by each service as its own cloud identity (IAM
// database authentication), so nothing here is a secret:
//   - gcp: Cloud SQL for PostgreSQL at its private IP; the services are
//     Google service accounts (GKE Workload Identity), and its users the
//     module's.
//   - aws: Amazon RDS for PostgreSQL in the install's VPC; the services are
//     roles (EKS Pod Identity, bound by ServiceAccount name), and its users
//     database-setup's to make, as RDS's administrator, whose password RDS
//     keeps in Secrets Manager (AdminSecret, its ARN).
type ManagedDatabase struct {
	Provider string // gcp, aws
	Instance string
	Host     string
	// CACert is the server's CA (PEM): clients check they reached it. On
	// aws, Amazon's RDS bundle for the region.
	CACert string
	// The database user each service signs in as, and the administrator
	// database-setup runs as.
	KernelUser, ConsoleUser, GatewayUser, AdminUser string
	// PolicyUser is kernel policy's own (empty from a module before it: it
	// then signs in as KernelUser), which kernel migrate grants what it uses.
	PolicyUser string
	// gcp: the Google service accounts the kernel's, the gateway's and
	// database-setup's Kubernetes ServiceAccounts are bound to (the
	// console's is ConsoleServiceAccount).
	KernelServiceAccount, GatewayServiceAccount, AdminServiceAccount string
	// aws: the database's region, and the administrator's password's secret.
	Region, AdminSecret string
}

const (
	// DatabaseCASecret holds the managed server's CA (ca.crt), mounted at
	// /etc/vennir/tls-db by the charts (database.caSecret).
	DatabaseCASecret = "vennir-db-ca"
	// The console's and the gateway's database URLs (no password in them).
	ConsoleDatabaseSecret = "vennir-console-db"
	GatewayDatabaseSecret = "vennir-gateway-db"
	PolicyDatabaseSecret  = "vennir-kernel-policy-db"
	// DatabaseAdminAccount is the ServiceAccount database-setup runs as,
	// bound to the module's administrator identity.
	DatabaseAdminAccount = "vennir-db-admin"
	databaseSetupJob     = "vennir-database-setup"
	// ReleaseImages is where released platform images are published.
	ReleaseImages = "ghcr.io/roburns/vennir"
)

// url is a service's URL for the managed server: its user, no password
// (its token is the password), TLS checked against the server's CA.
//   - gcp: the server's certificate names the instance, not its address,
//     so the hostname isn't checked (libpq's verify-ca); node-postgres
//     needs telling to use libpq's meaning, which pgx would refuse as an
//     unknown parameter.
//   - aws: the instance has a DNS name its certificate names: verify-full.
func (db *ManagedDatabase) url(user, database string, node bool) string {
	u := url.URL{Scheme: "postgresql", User: url.User(user), Host: db.Host + ":5432", Path: "/" + database}
	q := "sslmode=verify-ca&sslrootcert=/etc/vennir/tls-db/ca.crt"
	switch {
	case db.Provider == "aws":
		q = "sslmode=verify-full&sslrootcert=/etc/vennir/tls-db/ca.crt"
	case node:
		q = "uselibpqcompat=true&" + q
	}
	u.RawQuery = q
	return u.String()
}

// URL is a service's libpq URL for the managed server (no password: its
// token is the password), for tools such as pg_restore.
func (db *ManagedDatabase) URL(user, database string) string { return db.url(user, database, false) }

// chartDatabase is the charts' database values.
func (db *ManagedDatabase) chartDatabase() map[string]any {
	v := map[string]any{"iamAuth": db.Provider, "caSecret": DatabaseCASecret}
	if db.Provider == "aws" {
		v["region"] = db.Region
	}
	return v
}

// googleIdentity is the annotation that binds a ServiceAccount to a
// Google service account (GKE Workload Identity).
func googleIdentity(account string) map[string]any {
	return map[string]any{"iam.gke.io/gcp-service-account": account}
}

// managedKernelValues are the kernel chart's values for a managed database.
func managedKernelValues(v map[string]any, db *ManagedDatabase) {
	v["postgres"] = map[string]any{"enabled": false}
	v["externalDatabaseUrl"] = db.url(db.KernelUser, "execution_kernel", false)
	v["database"] = db.chartDatabase()
	if db.Provider == "gcp" {
		v["serviceAccount"] = map[string]any{"annotations": googleIdentity(db.KernelServiceAccount)}
	}
	// The server backs itself up (daily, with point-in-time recovery).
	v["backup"] = map[string]any{"enabled": false}
}

// managedConsoleValues are the console chart's values for a managed database.
func managedConsoleValues(v map[string]any, db *ManagedDatabase) {
	v["existingSecret"] = ConsoleDatabaseSecret
	v["existingSecretKey"] = "database-url"
	v["database"] = db.chartDatabase()
}

// managedGatewayValues are the gateway's: its own user, which the console's
// migration grants what it reads.
func managedGatewayValues(gateway map[string]any, db *ManagedDatabase) {
	gateway["database"] = map[string]any{"existingSecret": GatewayDatabaseSecret, "role": db.GatewayUser}
	if db.Provider == "gcp" {
		gateway["serviceAccountAnnotations"] = googleIdentity(db.GatewayServiceAccount)
	}
}

// ManagedDatabaseTier is the managed database's machine for a size, as the
// cloud's module picks it, for people.
func ManagedDatabaseTier(target, size string) string {
	if target == "aws" {
		return map[string]string{
			"minimal":   "db.t4g.small: 2 vCPU (burstable), 2 GB",
			"resilient": "db.t4g.medium: 2 vCPU (burstable), 4 GB",
			"auto":      "db.t4g.medium: 2 vCPU (burstable), 4 GB",
			"scaled":    "db.m7g.large: 2 vCPU, 8 GB",
		}[size]
	}
	return map[string]string{
		"minimal":   "db-g1-small: shared vCPU, 1.7 GB",
		"resilient": "db-custom-1-3840: 1 vCPU, 3.75 GB",
		"auto":      "db-custom-1-3840: 1 vCPU, 3.75 GB",
		"scaled":    "db-custom-2-7680: 2 vCPU, 7.5 GB",
	}[size]
}

// KernelImage is the kernel image an apply runs.
func KernelImage(c *config.Config, img Images) string {
	if img.Kernel != "" {
		return img.Kernel + ":" + img.Tag
	}
	return ReleaseImages + "/execution-kernel:" + c.Vennir
}

// EnsureManagedDatabase readies the cluster for a managed database before
// the charts: the server's CA and the console's and gateway's URLs as
// Secrets, database-setup's ServiceAccount, and database-setup itself,
// which makes what the cloud didn't and opens each database to its service
// alone (kernel/internal/dbsetup). Run every apply: it changes nothing once
// done.
func EnsureManagedDatabase(ctx context.Context, r *run.Runner, c *config.Config, db *ManagedDatabase, kernelImage string) error {
	k := func(args ...string) []string {
		return append([]string{"--context", cluster.Context(c), "--namespace", c.Namespace}, args...)
	}
	indent := func(s string) string { return "    " + strings.ReplaceAll(strings.TrimSpace(s), "\n", "\n    ") }
	annotations := ""
	if db.Provider == "gcp" {
		annotations = fmt.Sprintf("\n  annotations:\n    iam.gke.io/gcp-service-account: %s", db.AdminServiceAccount)
	}
	secrets := fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vennir}
stringData:
  ca.crt: |
%s
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vennir}
stringData:
  database-url: %q
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vennir}
stringData:
  database-url: %q
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vennir}%s
`, DatabaseCASecret, indent(db.CACert),
		ConsoleDatabaseSecret, db.url(db.ConsoleUser, "execution_console", true),
		GatewayDatabaseSecret, db.url(db.GatewayUser, "execution_console", false),
		DatabaseAdminAccount, annotations)
	if db.PolicyUser != "" {
		// kernel policy's own sign-in (the kernel chart's catalogPolicy.database).
		secrets += fmt.Sprintf(`---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vennir}
stringData:
  database-url: %q
`, PolicyDatabaseSecret, db.url(db.PolicyUser, "execution_kernel", false))
	}
	if err := r.RunInput(ctx, secrets, "kubectl", k("apply", "-f", "-")...); err != nil {
		return err
	}
	if err := r.Run(ctx, "kubectl", k("delete", "job", databaseSetupJob, "--ignore-not-found", "--wait")...); err != nil {
		return err
	}
	manifest, err := databaseSetupManifest(db, kernelImage)
	if err != nil {
		return err
	}
	if err := r.RunInput(ctx, manifest, "kubectl", k("apply", "-f", "-")...); err != nil {
		return err
	}
	// A new node may have to start first.
	if err := r.Run(ctx, "kubectl", k("wait", "job/"+databaseSetupJob, "--for=condition=complete", fmt.Sprintf("--timeout=%ds", int((10*time.Minute).Seconds())))...); err != nil {
		logs, _ := r.Output(ctx, "kubectl", k("logs", "job/"+databaseSetupJob, "--tail=20")...)
		return fmt.Errorf("opening the managed database to its services (job/%s): %w\n%s", databaseSetupJob, err, strings.TrimSpace(logs))
	}
	return nil
}

// databaseSetupManifest is `kernel database-setup` as a Job, as the
// administrator identity, connecting to the server's maintenance database:
// on gcp signing in by IAM; on aws with the password RDS keeps in Secrets
// Manager, after making the databases and the services' users (members of
// rds_iam, so they sign in by IAM), which on gcp the module made.
func databaseSetupManifest(db *ManagedDatabase, image string) (string, error) {
	type role struct {
		Name     string   `json:"name"`
		MemberOf []string `json:"memberOf,omitempty"`
	}
	type grant struct {
		Database string `json:"database"`
		Role     string `json:"role"`
		Regrant  bool   `json:"regrant,omitempty"`
	}
	setup := struct {
		Databases []string `json:"databases,omitempty"`
		Roles     []role   `json:"roles,omitempty"`
		Grants    []grant  `json:"grants"`
	}{Grants: []grant{
		// The kernel passes CONNECT and the schema's USAGE on to kernel
		// policy's user (migrate.GrantPolicy), as the console to the gateway's.
		{Database: "execution_kernel", Role: db.KernelUser, Regrant: db.PolicyUser != ""},
		{Database: "execution_console", Role: db.ConsoleUser, Regrant: true},
	}}
	env := `            - {name: DATABASE_IAM_AUTH, value: gcp}`
	if db.Provider == "aws" {
		setup.Databases = []string{"execution_kernel", "execution_console"}
		for _, user := range []string{db.KernelUser, db.ConsoleUser, db.GatewayUser, db.PolicyUser} {
			if user == "" {
				continue
			}
			setup.Roles = append(setup.Roles, role{Name: user, MemberOf: []string{"rds_iam"}})
		}
		env = fmt.Sprintf("            - {name: DATABASE_ADMIN_SECRET, value: %q}\n            - {name: DATABASE_IAM_REGION, value: %q}", db.AdminSecret, db.Region)
	}
	spec, err := json.Marshal(setup)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(`apiVersion: batch/v1
kind: Job
metadata:
  name: %s
  labels: {app.kubernetes.io/managed-by: vennir}
spec:
  backoffLimit: 3
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      serviceAccountName: %s
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: setup
          image: %s
          command: ["/usr/local/bin/kernel", "database-setup"]
          env:
            - {name: DATABASE_URL, value: %q}
%s
            - {name: DATABASE_SETUP, value: %q}
          volumeMounts:
            - {name: db-ca, mountPath: /etc/vennir/tls-db, readOnly: true}
          resources:
            requests: {cpu: 50m, memory: 64Mi}
            limits: {memory: 128Mi}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
      volumes:
        - name: db-ca
          secret: {secretName: %s}
`, databaseSetupJob, DatabaseAdminAccount, image,
		db.url(db.AdminUser, "postgres", false), env, string(spec), DatabaseCASecret), nil
}
