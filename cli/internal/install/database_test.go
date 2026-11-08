// SPDX-License-Identifier: MIT

package install

import (
	"fmt"
	"strings"
	"testing"
)

func managedCloud() *Cloud {
	return &Cloud{Provider: "gcp", TaskRegistry: "us-central1-docker.pkg.dev/p/vennir-products", Database: &ManagedDatabase{
		Provider: "gcp", Instance: "vennir-ab12", Host: "10.40.0.3", CACert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
		KernelUser: "vennir-kernel@p.iam", ConsoleUser: "vennir-console@p.iam", GatewayUser: "vennir-gateway@p.iam", AdminUser: "vennir-db-admin@p.iam",
		KernelServiceAccount: "vennir-kernel@p.iam.gserviceaccount.com", GatewayServiceAccount: "vennir-gateway@p.iam.gserviceaccount.com",
		AdminServiceAccount: "vennir-db-admin@p.iam.gserviceaccount.com",
	}}
}

// Each service's URL names its own user and no password, and checks the
// server against its CA; only node-postgres is told libpq's meaning.
func TestManagedDatabaseURLs(t *testing.T) {
	gcp := &ManagedDatabase{Provider: "gcp", Host: "10.40.0.3"}
	aws := &ManagedDatabase{Provider: "aws", Host: "vennir.abc.us-east-2.rds.amazonaws.com"}
	for _, c := range []struct {
		db   *ManagedDatabase
		node bool
		want string
	}{
		{gcp, false, "postgresql://vennir-kernel%40p.iam@10.40.0.3:5432/execution_kernel?sslmode=verify-ca&sslrootcert=/etc/vennir/tls-db/ca.crt"},
		{gcp, true, "postgresql://vennir-kernel%40p.iam@10.40.0.3:5432/execution_kernel?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=/etc/vennir/tls-db/ca.crt"},
		// RDS's certificate names its host: checked in full, by both drivers.
		{aws, true, "postgresql://vennir-kernel%40p.iam@vennir.abc.us-east-2.rds.amazonaws.com:5432/execution_kernel?sslmode=verify-full&sslrootcert=/etc/vennir/tls-db/ca.crt"},
	} {
		if got := c.db.url("vennir-kernel@p.iam", "execution_kernel", c.node); got != c.want {
			t.Errorf("%s node=%v: %s, want %s", c.db.Provider, c.node, got, c.want)
		}
	}
}

func TestAManagedDatabaseReplacesTheInClusterOne(t *testing.T) {
	c := kindConfig()
	c.Gateway.Enabled = true
	cloud := managedCloud()

	kernel := KernelValues(c, Images{}, "", cloud)
	for key, want := range map[string]string{
		"postgres":            "map[enabled:false]",
		"backup":              "map[enabled:false]",
		"database":            "map[caSecret:vennir-db-ca iamAuth:gcp]",
		"serviceAccount":      "map[annotations:map[iam.gke.io/gcp-service-account:vennir-kernel@p.iam.gserviceaccount.com]]",
		"externalDatabaseUrl": "postgresql://vennir-kernel%40p.iam@10.40.0.3:5432/execution_kernel?sslmode=verify-ca&sslrootcert=/etc/vennir/tls-db/ca.crt",
	} {
		if got := fmt.Sprint(kernel[key]); got != want {
			t.Errorf("kernel %s: %s, want %s", key, got, want)
		}
	}

	console := ConsoleValues(c, "dev", Images{}, cloud)
	if console["existingSecret"] != ConsoleDatabaseSecret || fmt.Sprint(console["database"]) != "map[caSecret:vennir-db-ca iamAuth:gcp]" {
		t.Errorf("console: %v, %v", console["existingSecret"], console["database"])
	}
	gateway := console["gateway"].(map[string]any)
	if fmt.Sprint(gateway["database"]) != "map[existingSecret:vennir-gateway-db role:vennir-gateway@p.iam]" ||
		fmt.Sprint(gateway["serviceAccountAnnotations"]) != "map[iam.gke.io/gcp-service-account:vennir-gateway@p.iam.gserviceaccount.com]" {
		t.Errorf("gateway: %v, %v", gateway["database"], gateway["serviceAccountAnnotations"])
	}
}

func TestDatabaseSetupRunsAsTheAdministratorAndOpensEachDatabaseToItsService(t *testing.T) {
	m, err := databaseSetupManifest(managedCloud().Database, "ghcr.io/roburns/vennir/execution-kernel:0.6.0")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"serviceAccountName: vennir-db-admin",
		`command: ["/usr/local/bin/kernel", "database-setup"]`,
		`"postgresql://vennir-db-admin%40p.iam@10.40.0.3:5432/postgres?sslmode=verify-ca&sslrootcert=/etc/vennir/tls-db/ca.crt"`,
		`{\"grants\":[{\"database\":\"execution_kernel\",\"role\":\"vennir-kernel@p.iam\"},{\"database\":\"execution_console\",\"role\":\"vennir-console@p.iam\",\"regrant\":true}]}`,
		"{name: DATABASE_IAM_AUTH, value: gcp}",
		"runAsNonRoot: true",
	} {
		if !strings.Contains(m, want) {
			t.Errorf("missing %s in:\n%s", want, m)
		}
	}
}

// With kernel policy's own user, the kernel may pass CONNECT and the
// schema's USAGE on to it (kernel migrate grants it what it uses).
func TestDatabaseSetupLetsTheKernelGrantKernelPolicysUser(t *testing.T) {
	db := managedCloud().Database
	db.PolicyUser = "vennir-policy@p.iam"
	m, err := databaseSetupManifest(db, "img")
	if err != nil {
		t.Fatal(err)
	}
	want := `{\"grants\":[{\"database\":\"execution_kernel\",\"role\":\"vennir-kernel@p.iam\",\"regrant\":true},{\"database\":\"execution_console\",\"role\":\"vennir-console@p.iam\",\"regrant\":true}]}`
	if !strings.Contains(m, want) {
		t.Errorf("missing %s in:\n%s", want, m)
	}
}

// The database volume grows with the size on a cloud, never shrinks, and
// stays as it is on kind (whose volumes can't grow).
func TestTheDatabaseVolumeGrowsWithTheSize(t *testing.T) {
	persistence := func(target, size, volume string) any {
		c := kindConfig()
		c.Target, c.Size = target, size
		return KernelValues(c, Images{}, volume, nil)["postgres"].(map[string]any)["persistence"]
	}
	if got := persistence("aws", "resilient", "10Gi"); got != nil {
		t.Errorf("10Gi to resilient on aws: %v, want the size's 50Gi", got)
	}
	if got := fmt.Sprint(persistence("aws", "resilient", "200Gi")); got != "map[size:200Gi]" {
		t.Errorf("a larger volume is kept: %s", got)
	}
	if got := fmt.Sprint(persistence("kind", "resilient", "10Gi")); got != "map[size:10Gi]" {
		t.Errorf("kind's can't grow: %s", got)
	}
}

// On RDS, setup signs in with the password RDS keeps in Secrets Manager,
// and makes the databases and the services' users (members of rds_iam);
// the services' values carry the region and no Google identities.
func TestOnRDSSetupMakesTheUsersAndTheServicesSignInByRole(t *testing.T) {
	db := &ManagedDatabase{Provider: "aws", Host: "vennir.abc.us-east-2.rds.amazonaws.com", Region: "us-east-2", CACert: "PEM",
		KernelUser: "vennir_kernel", ConsoleUser: "vennir_console", GatewayUser: "vennir_gateway", PolicyUser: "vennir_kernel_policy", AdminUser: "vennir_admin",
		AdminSecret: "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-abc"}
	m, err := databaseSetupManifest(db, "img")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`{name: DATABASE_ADMIN_SECRET, value: "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!db-abc"}`,
		`{name: DATABASE_IAM_REGION, value: "us-east-2"}`,
		`"postgresql://vennir_admin@vennir.abc.us-east-2.rds.amazonaws.com:5432/postgres?sslmode=verify-full&sslrootcert=/etc/vennir/tls-db/ca.crt"`,
		`\"databases\":[\"execution_kernel\",\"execution_console\"]`,
		`{\"name\":\"vennir_gateway\",\"memberOf\":[\"rds_iam\"]}`,
		`{\"name\":\"vennir_kernel_policy\",\"memberOf\":[\"rds_iam\"]}`,
		`{\"database\":\"execution_kernel\",\"role\":\"vennir_kernel\",\"regrant\":true}`,
	} {
		if !strings.Contains(m, want) {
			t.Errorf("missing %s in:\n%s", want, m)
		}
	}
	if strings.Contains(m, "DATABASE_IAM_AUTH") {
		t.Error("setup on RDS signs in with the administrator's password, not by IAM")
	}
	c := kindConfig()
	c.Gateway.Enabled = true
	cloud := &Cloud{Provider: "aws", TaskRegistry: "123456789012.dkr.ecr.us-east-2.amazonaws.com/vennir-products", Database: db}
	kernel := KernelValues(c, Images{}, "", cloud)
	if fmt.Sprint(kernel["database"]) != "map[caSecret:vennir-db-ca iamAuth:aws region:us-east-2]" || kernel["serviceAccount"] != nil {
		t.Errorf("kernel: %v, %v", kernel["database"], kernel["serviceAccount"])
	}
	gateway := ConsoleValues(c, "dev", Images{}, cloud)["gateway"].(map[string]any)
	if gateway["serviceAccountAnnotations"] != nil {
		t.Errorf("no Google identity on aws: %v", gateway["serviceAccountAnnotations"])
	}
}
