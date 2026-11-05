// SPDX-License-Identifier: MIT

package executor

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
)

// The chart's admission policies hold the scheduler's Jobs to the shape
// this executor makes (helm/charts/execution-kernel/templates/
// dispatch-policy.yaml), and helm/tests/admission-policies.sh proves it on
// a cluster by dry-running this Job as the scheduler: hardened, pulling
// with vennir-pull, on a capacity's placement, with a Secret and a token
// for an audience. So that file is kept equal to what jobFor makes; after
// changing the Job's shape, write it again with
//
//	WRITE_STEP_JOB=1 go test ./internal/executor -run TestTheAdmissionTestsStepJobIsTheExecutors
//
// and run the admission tests.
const stepJobFile = "../../../helm/tests/step-job.json"

func TestTheAdmissionTestsStepJobIsTheExecutors(t *testing.T) {
	opts := options()
	opts.ImagePullSecret = "vennir-pull"
	opts.CapacityPlacements = map[string]Placement{"spot": {
		NodeSelector: map[string]string{"pool": "spot"},
		Tolerations:  []corev1.Toleration{{Key: "pool", Operator: corev1.TolerationOpEqual, Value: "spot", Effect: corev1.TaintEffectNoSchedule}},
	}}
	opts.StartTimeout, opts.JobTTL = 300*time.Second, time.Hour
	k := NewKubernetes(nil, opts, quietLog)
	// A product registered in the admission tests' identity policy: its
	// image (pinned to a digest they admit), action, ServiceAccount, one
	// of its team's Secrets and its audience.
	task := ResolvedTask{ExecutionID: "00000000-0000-0000-0000-000000000001", TaskKey: "db",
		Image:  "registry.example/db:1@sha256:0000000000000000000000000000000000000000000000000000000000000000",
		Action: "create", Attempt: 1, TimeoutSeconds: 300, ServiceAccount: "db-sa",
		SecretRefs: []string{"db-key"}, TokenAudiences: []string{"sts.amazonaws.com"}, Capacity: "spot"}
	job, err := k.jobFor(JobName(task.ExecutionID, task.TaskKey, task.Attempt), task)
	if err != nil {
		t.Fatal(err)
	}
	job.APIVersion, job.Kind = "batch/v1", "Job"
	got, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	if os.Getenv("WRITE_STEP_JOB") == "1" {
		if err := os.WriteFile(stepJobFile, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(stepJobFile)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("%s isn't the Job the executor makes; write it again (WRITE_STEP_JOB=1) and rerun helm/tests/admission-policies.sh:\n%s", stepJobFile, got)
	}
}
