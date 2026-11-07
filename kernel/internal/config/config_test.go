// SPDX-License-Identifier: MIT

package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func load(t *testing.T, env map[string]string) (Settings, error) {
	t.Helper()
	return Load(func(name string) string { return env[name] })
}

func TestTheDefaultsAreThePythonKernels(t *testing.T) {
	s, err := load(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.LeaseDuration != time.Minute || s.ClaimLimit != 50 || s.ExecutorConcurrency != 16 ||
		s.JobDeadlineGrace != 600*time.Second || s.TaskLogMaxLines != 5000 || s.MetricsPort != 9090 || s.MaxRunning != 0 ||
		s.KubernetesQPS != 50 || s.KubernetesBurst != 100 || s.DatabaseMaxConnections != 10 ||
		s.DatabaseConnectTimeout != 10*time.Second {
		t.Errorf("defaults = %+v", s)
	}
}

// TASK_POD_HARDENING was removed (step Pods are always hardened); an older
// chart's ConfigMap that still sets it, even to false, starts as any other.
func TestARemovedSettingIsIgnored(t *testing.T) {
	for _, v := range []string{"false", "true", "maybe"} {
		if _, err := load(t, map[string]string{"TASK_POD_HARDENING": v}); err != nil {
			t.Errorf("TASK_POD_HARDENING=%s: %v", v, err)
		}
	}
}

func TestTheDriverNameIsDroppedFromThePythonURL(t *testing.T) {
	s, _ := load(t, map[string]string{"DATABASE_URL": "postgresql+asyncpg://kernel@db/execution_kernel"})
	if s.DatabaseURL != "postgresql://kernel@db/execution_kernel" {
		t.Error(s.DatabaseURL)
	}
}

func TestSettingsReadPlacementFromJSON(t *testing.T) {
	s, err := load(t, map[string]string{
		"TASK_NODE_SELECTOR": `{"cloud.google.com/gke-spot": "true"}`,
		"TASK_TOLERATIONS":   `[{"key": "spot", "operator": "Exists", "effect": "NoSchedule", "tolerationSeconds": 30}]`,
		"TASK_AFFINITY":      "null",
	})
	if err != nil {
		t.Fatal(err)
	}
	thirty := int64(30)
	if !reflect.DeepEqual(s.TaskNodeSelector, map[string]string{"cloud.google.com/gke-spot": "true"}) ||
		!reflect.DeepEqual(s.TaskTolerations, []Toleration{{Key: "spot", Operator: "Exists", Effect: "NoSchedule", TolerationSeconds: &thirty}}) ||
		s.TaskAffinity != nil {
		t.Errorf("placement = %v %v %v", s.TaskNodeSelector, s.TaskTolerations, s.TaskAffinity)
	}
}

func TestSettingsReadStepPodLabels(t *testing.T) {
	s, err := load(t, map[string]string{"TASK_POD_LABELS": `{"azure.workload.identity/use": "true"}`})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(s.TaskPodLabels, map[string]string{"azure.workload.identity/use": "true"}) {
		t.Errorf("labels = %v", s.TaskPodLabels)
	}
}

func TestAMisconfigurationStopsTheSchedulerAtStartup(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"misspelt toleration": {"TASK_TOLERATIONS": `[{"key": "spot", "efect": "NoSchedule"}]`},
		"not JSON":            {"TASK_NODE_SELECTOR": "{"},
		"bad size":            {"TASK_DEFAULT_RESOURCES": `{"memory": "lots"}`},
		"unknown size field":  {"TASK_DEFAULT_RESOURCES": `{"ram": "1Gi"}`},
		"not a number":        {"LEASE_DURATION_SECONDS": "a minute"},
		"zero":                {"SCHEDULER_CLAIM_LIMIT": "0"},
		"negative":            {"SCHEDULER_MAX_RUNNING_TASKS": "-1"},
		"fraction":            {"SCHEDULER_CLAIM_LIMIT": "1.5"},
		"unknown auth":        {"API_AUTH": "none"},
		"callers not a list":  {"API_ALLOWED_CALLERS": "system:serviceaccount:a:b"},
		"kernel's label":      {"TASK_POD_LABELS": `{"vennir.dev/execution-id": "x"}`},
		"app label":           {"TASK_POD_LABELS": `{"app": "other"}`},
		"bad label key":       {"TASK_POD_LABELS": `{"has space": "true"}`},
		"bad label value":     {"TASK_POD_LABELS": `{"team": "not/valid"}`},
		"unknown capacity":    {"TASK_CAPACITY_PLACEMENTS": `{"preemptible": {"nodeSelector": {"a": "b"}}}`},
		"profiler for all":    {"PROFILING_ADDRESS": ":6060"},
		"profiler outward":    {"PROFILING_ADDRESS": "0.0.0.0:6060"},
		"profiler no port":    {"PROFILING_ADDRESS": "127.0.0.1"},
		"no Job TTL":          {"KUBERNETES_JOB_TTL_SECONDS": "0"},
		"polls past a lease":  {"SCHEDULER_POLL_INTERVAL_SECONDS": "60", "LEASE_DURATION_SECONDS": "60"},
	} {
		_, err := load(t, env)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		for key := range env {
			if !strings.Contains(err.Error(), key) {
				t.Errorf("%s: %v doesn't name %s", name, err, key)
			}
		}
	}
}

func TestTheAPIAndSleeperSettings(t *testing.T) {
	s, err := load(t, map[string]string{
		"API_ALLOWED_CALLERS":          `["system:serviceaccount:vennir-system:console"]`,
		"SLEEPER_DEPLOYMENTS":          `["kernel-api", "console"]`,
		"SLEEPER_DATABASE_DEPLOYMENTS": `["kernel-postgres"]`,
		"SLEEPER_IDLE_AFTER_SECONDS":   "600",
	})
	if err != nil {
		t.Fatal(err)
	}
	if s.APIAuth != "tokenreview" || s.APITokenAudience != "vennir-kernel-api" || s.APIPort != 8000 || s.MaxTasksPerExecution != 500 ||
		!reflect.DeepEqual(s.APIAllowedCallers, []string{"system:serviceaccount:vennir-system:console"}) ||
		!reflect.DeepEqual(s.SleeperDeployments, []string{"kernel-api", "console"}) ||
		!reflect.DeepEqual(s.SleeperDatabases, []string{"kernel-postgres"}) ||
		s.SleeperIdleAfter != 10*time.Minute || s.SleeperScheduledWait != 6*time.Hour {
		t.Errorf("settings = %+v", s)
	}
}

func TestTheProfilerListensOnLoopbackOnly(t *testing.T) {
	for _, address := range []string{"127.0.0.1:6060", "[::1]:6060", "localhost:6060"} {
		s, err := load(t, map[string]string{"PROFILING_ADDRESS": address})
		if err != nil || s.ProfilingAddress != address {
			t.Errorf("%s: %v", address, err)
		}
	}
	if s, err := load(t, nil); err != nil || s.ProfilingAddress != "" {
		t.Errorf("off by default: %q, %v", s.ProfilingAddress, err)
	}
}

// A cloud sign-in token, or the administrator's password, is sent only over
// TLS that checks the server: verify-full, or verify-ca against its own CA,
// or to a proxy beside the process (loopback, a Unix socket).
func TestACloudSignInNeedsAVerifiedConnection(t *testing.T) {
	const host = "postgresql://vennir-kernel%40p.iam@10.40.0.3:5432/execution_kernel"
	ca := "&sslrootcert=" + caFile(t)
	for _, url := range []string{
		host + "?sslmode=verify-full",
		host + "?sslmode=verify-full" + ca,
		host + "?sslrootcert=system",
		host + "?sslmode=verify-ca" + ca,
		host + "?sslmode=require" + ca, // libpq's verify-ca, with a root certificate
		"host=10.40.0.3 sslmode=verify-full",
		"postgresql://vennir-kernel%40p.iam@127.0.0.1:5432/execution_kernel?sslmode=disable",
		"postgresql://vennir-kernel%40p.iam@[::1]:5432/execution_kernel",
		"postgresql://vennir-kernel%40p.iam@localhost/execution_kernel",
		"postgresql:///execution_kernel?host=/cloudsql/p:r:i",
	} {
		for _, env := range []map[string]string{
			{"DATABASE_IAM_AUTH": "gcp"},
			{"DATABASE_IAM_AUTH": "aws", "DATABASE_IAM_REGION": "us-east-2"},
			{"DATABASE_ADMIN_SECRET": "arn:aws:secretsmanager:us-east-2:1:secret:x", "DATABASE_IAM_REGION": "us-east-2"},
		} {
			env["DATABASE_URL"] = url
			if _, err := load(t, env); err != nil {
				t.Errorf("%s: %v", url, err)
			}
		}
	}
	for _, url := range []string{
		host,
		host + "?sslmode=disable",
		host + "?sslmode=prefer",
		host + "?sslmode=require",
		host + "?sslmode=verify-ca",
		host + "?sslmode=verify-full&host=10.40.0.4&sslmode=disable",
		host + "?sslmode=verify-ca&sslrootcert=/nowhere/ca.crt",
		"postgresql://u@127.0.0.1/db?host=10.40.0.3",
		"postgresql://u@127.0.0.1,10.40.0.3/db?sslmode=prefer",
		"host=10.40.0.3 sslmode=require",
		"not a URL at all ::",
	} {
		for _, env := range []map[string]string{
			{"DATABASE_IAM_AUTH": "gcp"},
			{"DATABASE_ADMIN_SECRET": "arn:aws:secretsmanager:us-east-2:1:secret:x", "DATABASE_IAM_REGION": "us-east-2"},
		} {
			env["DATABASE_URL"] = url
			if _, err := load(t, env); err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
				t.Errorf("%s: accepted (%v)", url, err)
			}
		}
	}
	// A password of the URL's own is the operator's choice, as before.
	if _, err := load(t, map[string]string{"DATABASE_URL": host + "?sslmode=disable"}); err != nil {
		t.Error(err)
	}
	// What's refused never quotes the URL (it may hold a password).
	_, err := load(t, map[string]string{"DATABASE_IAM_AUTH": "gcp", "DATABASE_URL": "postgresql://u:hunter2@10.40.0.3/db?sslmode=bogus"})
	if err == nil || strings.Contains(err.Error(), "hunter2") {
		t.Errorf("refusal: %v", err)
	}
}

// caFile is a CA certificate's PEM file, for sslrootcert.
func caFile(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"},
		NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "ca.crt")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// kernel policy's settings: a release needs the policy it writes and a
// signer to trust (without one, the console writes them: it doesn't run).
func TestTheCatalogPolicyNeedsASignerAndItsPolicy(t *testing.T) {
	with := func(extra map[string]string) map[string]string {
		env := map[string]string{"CATALOG_POLICY_RELEASE": "r.example/catalog-release:latest",
			"CATALOG_POLICY_IDENTITY_POLICY": "kernel-execution-kernel-catalog-identity"}
		for k, v := range extra {
			env[k] = v
		}
		return env
	}
	s, err := load(t, with(map[string]string{"CATALOG_POLICY_PUBLIC_KEYS": `["-----BEGIN PUBLIC KEY-----"]`,
		"CATALOG_POLICY_REGISTRY_MIRRORS": `{"localhost:5001": "http://kind-registry:5000"}`, "CATALOG_POLICY_NEWEST_VERSION": "true"}))
	if err != nil || len(s.CatalogPolicyPublicKeys) != 1 || s.CatalogPolicyRegistryMirrors["localhost:5001"] != "http://kind-registry:5000" ||
		!s.CatalogPolicyNewestVersion || s.CatalogPolicyPoll != time.Minute || s.CatalogPolicyReleaseGrace != time.Hour {
		t.Fatalf("%+v, %v", s, err)
	}
	for name, env := range map[string]map[string]string{
		"no signer":                   with(nil),
		"keyless without its subject": with(map[string]string{"CATALOG_POLICY_KEYLESS_ISSUER": "https://token.actions.githubusercontent.com"}),
		"no policy":                   {"CATALOG_POLICY_RELEASE": "r", "CATALOG_POLICY_PUBLIC_KEYS": `["k"]`},
		"a flag that isn't one":       with(map[string]string{"CATALOG_POLICY_PUBLIC_KEYS": `["k"]`, "CATALOG_POLICY_REGISTRY_ECR_TOKEN": "yes"}),
		"in use under the approval timeout": with(map[string]string{"CATALOG_POLICY_PUBLIC_KEYS": `["k"]`,
			"SCHEDULER_APPROVAL_TIMEOUT_SECONDS": "604800", "CATALOG_POLICY_IN_USE_MAX_SECONDS": "259200"}),
		"a limit under in use": with(map[string]string{"CATALOG_POLICY_PUBLIC_KEYS": `["k"]`,
			"CATALOG_POLICY_IN_USE_MAX_SECONDS": "604800", "CATALOG_POLICY_IN_USE_LIMIT_SECONDS": "259200"}),
	} {
		if _, err := load(t, env); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// Without a release, none of it is needed (it doesn't run).
	if _, err := load(t, nil); err != nil {
		t.Error(err)
	}
}

// Federation names one other side, its hosts and the projected token.
func TestTheCatalogPolicysFederation(t *testing.T) {
	gcp := map[string]string{"CATALOG_POLICY_FEDERATION_GCP_PROVIDER": "projects/1/locations/global/workloadIdentityPools/p/providers/q",
		"CATALOG_POLICY_FEDERATION_GCP_SERVICE_ACCOUNT": "reader@owner.iam.gserviceaccount.com",
		"CATALOG_POLICY_FEDERATION_HOSTS":               `["us-central1-docker.pkg.dev"]`, "CATALOG_POLICY_FEDERATION_TOKEN_FILE": "/var/run/federation/token"}
	s, err := load(t, gcp)
	if err != nil || s.CatalogPolicyFederationHosts[0] != "us-central1-docker.pkg.dev" || s.CatalogPolicyFederationGCPServiceAccount == "" {
		t.Fatalf("%+v, %v", s, err)
	}
	with := func(change map[string]string) map[string]string {
		env := map[string]string{}
		for k, v := range gcp {
			env[k] = v
		}
		for k, v := range change {
			if v == "" {
				delete(env, k)
			} else {
				env[k] = v
			}
		}
		return env
	}
	for name, env := range map[string]map[string]string{
		"both sides":          with(map[string]string{"CATALOG_POLICY_FEDERATION_AWS_ROLE_ARN": "arn:aws:iam::111111111111:role/r"}),
		"no hosts":            with(map[string]string{"CATALOG_POLICY_FEDERATION_HOSTS": ""}),
		"no token":            with(map[string]string{"CATALOG_POLICY_FEDERATION_TOKEN_FILE": ""}),
		"an account, no pool": {"CATALOG_POLICY_FEDERATION_GCP_SERVICE_ACCOUNT": "reader@owner.iam.gserviceaccount.com"},
	} {
		if _, err := load(t, env); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
