// SPDX-License-Identifier: MIT

package config

import (
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
	if s.LeaseDuration != time.Minute || s.ClaimLimit != 50 || s.ExecutorConcurrency != 16 || !s.TaskPodHardening ||
		s.JobDeadlineGrace != 600*time.Second || s.TaskLogMaxLines != 5000 || s.MetricsPort != 9090 || s.MaxRunning != 0 ||
		s.KubernetesQPS != 50 || s.KubernetesBurst != 100 || s.DatabaseMaxConnections != 10 ||
		s.DatabaseConnectTimeout != 10*time.Second {
		t.Errorf("defaults = %+v", s)
	}
}

func TestTheDriverNameIsDroppedFromThePythonURL(t *testing.T) {
	s, _ := load(t, map[string]string{"DATABASE_URL": "postgresql+asyncpg://kernel@db/execution_kernel"})
	if s.DatabaseURL != "postgresql://kernel@db/execution_kernel" {
		t.Error(s.DatabaseURL)
	}
}

// Ported from test_task_placement.py.
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
		"not a boolean":       {"TASK_POD_HARDENING": "maybe"},
		"unknown auth":        {"API_AUTH": "none"},
		"callers not a list":  {"API_ALLOWED_CALLERS": "system:serviceaccount:a:b"},
		"kernel's label":      {"TASK_POD_LABELS": `{"vertra.dev/execution-id": "x"}`},
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
		"API_ALLOWED_CALLERS":          `["system:serviceaccount:vertra-system:console"]`,
		"SLEEPER_DEPLOYMENTS":          `["kernel-api", "console"]`,
		"SLEEPER_DATABASE_DEPLOYMENTS": `["kernel-postgres"]`,
		"SLEEPER_IDLE_AFTER_SECONDS":   "600",
	})
	if err != nil {
		t.Fatal(err)
	}
	if s.APIAuth != "tokenreview" || s.APITokenAudience != "vertra-kernel-api" || s.APIPort != 8000 || s.MaxTasksPerExecution != 500 ||
		!reflect.DeepEqual(s.APIAllowedCallers, []string{"system:serviceaccount:vertra-system:console"}) ||
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
