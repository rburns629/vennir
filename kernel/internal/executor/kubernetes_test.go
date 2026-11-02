// SPDX-License-Identifier: MIT

package executor

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// Ported from the Python kernel's tests/unit/test_kubernetes_{executor_errors,image_pull,
// release,executor_credentials,watch}.py and test_task_placement.py. No
// cluster: client-go's fake clientset stands in, with reactors for the
// API's refusals. The real thing is proven on kind.

const jobUID = "6b1f3d0e-0000-0000-0000-000000000001"

var quietLog = slog.New(slog.NewTextHandler(io.Discard, nil))

func stepTask() ResolvedTask {
	return ResolvedTask{ExecutionID: "00000000-0000-0000-0000-000000000001", TaskKey: "env",
		Image: "test-environment-product:local", Action: "create", Attempt: 1, TimeoutSeconds: 60,
		Team: "vertra-system", ServiceAccount: "default"}
}

func options() KubernetesOptions {
	return KubernetesOptions{RequestTimeout: 5 * time.Second, ImagePullGrace: 120 * time.Second,
		JobDeadlineGrace: 600 * time.Second, WatchResync: 30 * time.Second, PodHardening: true,
		LogMaxLines: 1000, LogMaxBytes: 1 << 20}
}

type cluster struct {
	*fake.Clientset
	k *Kubernetes
}

func newCluster(opts KubernetesOptions, objects ...runtime.Object) *cluster {
	client := fake.NewClientset(objects...)
	// The API server gives every new Job a UID; the tracker doesn't.
	client.PrependReactor("create", "jobs", func(a k8stesting.Action) (bool, runtime.Object, error) {
		job := a.(k8stesting.CreateAction).GetObject().(*batchv1.Job)
		if job.UID == "" {
			job.UID = jobUID
		}
		return false, nil, nil
	})
	return &cluster{Clientset: client, k: NewKubernetes(client, opts, quietLog)}
}

// refuse makes every verb on resource fail with err.
func (c *cluster) refuse(verb, resource string, err error) {
	c.PrependReactor(verb, resource, func(k8stesting.Action) (bool, runtime.Object, error) { return true, nil, err })
}

func (c *cluster) deleted(resource string) []string {
	var names []string
	for _, a := range c.Actions() {
		if a.GetVerb() == "delete" && a.GetResource().Resource == resource {
			names = append(names, a.(k8stesting.DeleteAction).GetName())
		}
	}
	return names
}

func (c *cluster) created(resource string) int {
	n := 0
	for _, a := range c.Actions() {
		if a.GetVerb() == "create" && a.GetResource().Resource == resource {
			n++
		}
	}
	return n
}

func (c *cluster) job(t *testing.T) *batchv1.Job {
	t.Helper()
	task := stepTask()
	job, err := c.BatchV1().Jobs(task.Team).Get(context.Background(), JobName(task.ExecutionID, task.TaskKey, task.Attempt), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func status(code int32, reason metav1.StatusReason, message string) error {
	return &apierrors.StatusError{ErrStatus: metav1.Status{Status: metav1.StatusFailure, Code: code, Reason: reason, Message: message}}
}

const policyMessage = `jobs.batch "ek-env-1" is forbidden: ValidatingAdmissionPolicy ` +
	`'kernel-execution-kernel-dispatch' denied request: namespace vertra-system is not a Vertra team namespace`

func check(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s = %#v, want %#v", what, got, want)
	}
}

func rejected(t *testing.T, err error) *DispatchRejected {
	t.Helper()
	r, ok := IsDispatchRejected(err)
	if !ok {
		t.Fatalf("err = %v, want a DispatchRejected", err)
	}
	return r
}

// --- job names ---

// The same as the Python kernel's job_name_for, so either adopts the
// other's Jobs (values computed with it).
func TestJobNamesMatchThePythonKernels(t *testing.T) {
	for _, c := range []struct {
		execution, task string
		attempt         int
		want            string
	}{
		{"00000000-0000-0000-0000-000000000001", "env", 1, "ek-env-f0cb97e5485a8f0d"},
		{"e-1", "Create_Project!!", 3, "ek-create-project-e9ec1c53b7f94331"},
		{"e-1", strings.Repeat("a", 80), 12, "ek-aaaaaaaaaaaaaaaaaaaa-abf1e67972fdde3d"},
		{"e-1", "---", 1, "ek-d6517c0a55b5971a"},
		{"11111111-2222-3333-4444-555555555555", "deploy.application/v2", 2, "ek-deploy-application-v-f16c270a0544ced3"},
		{"e-1", "Déploy-ÉTAPE-numéro-un", 1, "ek-d-ploy--tape-num-ro--c945845950e3b10a"},
		{"e-1", "abcdefghijklmnopqrs-tuv", 1, "ek-abcdefghijklmnopqrs--0e00183324a3e39d"},
	} {
		check(t, c.task, JobName(c.execution, c.task, c.attempt), c.want)
	}
}

// --- creating the Job and its ConfigMap ---

// So Kubernetes deletes it along with a Job the scheduler never finalizes.
func TestTheConfigMapIsOwnedByItsJob(t *testing.T) {
	c := newCluster(options())
	handle, err := c.k.Start(context.Background(), stepTask())
	if err != nil {
		t.Fatal(err)
	}
	check(t, "handle", handle, Handle{"namespace": "vertra-system", "jobName": JobName(stepTask().ExecutionID, "env", 1)})
	cm, err := c.CoreV1().ConfigMaps("vertra-system").Get(context.Background(), handle["jobName"].(string), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	owner := cm.OwnerReferences[0]
	check(t, "owner", []string{owner.Kind, owner.Name, string(owner.UID)}, []string{"Job", cm.Name, jobUID})
	var request map[string]any
	_ = json.Unmarshal([]byte(cm.Data["request.json"]), &request)
	check(t, "request", request, map[string]any{"executionId": stepTask().ExecutionID, "taskId": "env", "action": "create", "attempt": 1.0, "inputs": map[string]any{}})
}

// A pass that created the Job and then rolled back retries the same
// attempt, so the same name: that Job is the one to keep polling.
func TestAnExistingJobForThisAttemptIsAdopted(t *testing.T) {
	task := stepTask()
	name := JobName(task.ExecutionID, task.TaskKey, task.Attempt)
	c := newCluster(options(), &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: task.Team, UID: "uid-of-the-earlier-job"}})
	if _, err := c.k.Start(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	cm, _ := c.CoreV1().ConfigMaps(task.Team).Get(context.Background(), name, metav1.GetOptions{})
	check(t, "owner", string(cm.OwnerReferences[0].UID), "uid-of-the-earlier-job")
}

func TestAnExistingConfigMapIsLeftAsItIs(t *testing.T) {
	c := newCluster(options())
	c.refuse("create", "configmaps", apierrors.NewAlreadyExists(corev1.Resource("configmaps"), "x"))
	if _, err := c.k.Start(context.Background(), stepTask()); err != nil {
		t.Fatal(err)
	}
}

func TestAJobBeingDeletedIsntAdopted(t *testing.T) {
	task := stepTask()
	now := metav1.Now()
	c := newCluster(options(), &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: JobName(task.ExecutionID, task.TaskKey, task.Attempt),
		Namespace: task.Team, UID: "old", DeletionTimestamp: &now, Finalizers: []string{"x"}}})
	_, err := c.k.Start(context.Background(), task)
	if err == nil {
		t.Fatal("adopted")
	}
	if _, ok := IsDispatchRejected(err); ok {
		t.Fatal("a Job being deleted is retried, not refused")
	}
}

// The scheduler retries this same attempt, whose start adopts the Job and
// creates the ConfigMap; deleting it here would only race that retry.
func TestAConfigMapThatFailsForNowLeavesTheJobForRetry(t *testing.T) {
	for name, cause := range map[string]error{
		"server error": status(500, metav1.StatusReasonInternalError, "boom"),
		"timeout":      context.DeadlineExceeded,
	} {
		c := newCluster(options())
		c.refuse("create", "configmaps", cause)
		_, err := c.k.Start(context.Background(), stepTask())
		if err == nil {
			t.Fatalf("%s: started", name)
		}
		if _, ok := IsDispatchRejected(err); ok {
			t.Errorf("%s: refused for good", name)
		}
		check(t, name+": deleted", c.deleted("jobs"), []string(nil))
	}
}

// Refused for good, so its Pod would wait for request.json forever.
func TestARefusedConfigMapTakesItsJobWithIt(t *testing.T) {
	c := newCluster(options())
	c.refuse("create", "configmaps", status(403, metav1.StatusReasonForbidden, policyMessage))
	rejected(t, func() error { _, err := c.k.Start(context.Background(), stepTask()); return err }())
	check(t, "deleted", len(c.deleted("jobs")), 1)
}

// A backstop for a Job the scheduler loses track of, allowing for the wait
// to start (it counts from the Job's creation).
func TestEveryJobHasADeadlinePastItsTasksTimeout(t *testing.T) {
	opts := options()
	opts.StartTimeout = 300 * time.Second
	c := newCluster(opts)
	_, _ = c.k.Start(context.Background(), stepTask())
	check(t, "deadline", *c.job(t).Spec.ActiveDeadlineSeconds, int64(60+300+600))
	check(t, "backoff", *c.job(t).Spec.BackoffLimit, int32(0))
}

// A step whose product asks for a kind of capacity runs where the install
// put it; one asking for a kind the install has no placement for, or for
// none, where any step does.
func TestAStepRunsOnTheCapacityItsProductAsksFor(t *testing.T) {
	opts := options()
	opts.NodeSelector = map[string]string{"cloud.google.com/gke-spot": "true"}
	opts.CapacityPlacements = map[string]Placement{"onDemand": {NodeSelector: map[string]string{}}}
	for capacity, want := range map[string]map[string]string{
		"onDemand": {},
		"spot":     {"cloud.google.com/gke-spot": "true"},
		"":         {"cloud.google.com/gke-spot": "true"},
	} {
		c := newCluster(opts)
		task := stepTask()
		task.Capacity = capacity
		if _, err := c.k.Start(context.Background(), task); err != nil {
			t.Fatal(err)
		}
		if got := c.job(t).Spec.Template.Spec.NodeSelector; len(got) != len(want) || got["cloud.google.com/gke-spot"] != want["cloud.google.com/gke-spot"] {
			t.Errorf("%q: node selector = %v, want %v", capacity, got, want)
		}
	}
}

func TestAStepPodMeetsPodSecurityRestricted(t *testing.T) {
	c := newCluster(options())
	_, _ = c.k.Start(context.Background(), stepTask())
	pod := c.job(t).Spec.Template.Spec
	container := pod.Containers[0]
	check(t, "automount", *pod.AutomountServiceAccountToken, false)
	check(t, "non-root", *pod.SecurityContext.RunAsNonRoot, true)
	check(t, "seccomp", pod.SecurityContext.SeccompProfile.Type, corev1.SeccompProfileTypeRuntimeDefault)
	check(t, "read-only root", *container.SecurityContext.ReadOnlyRootFilesystem, true)
	check(t, "escalation", *container.SecurityContext.AllowPrivilegeEscalation, false)
	check(t, "capabilities", container.SecurityContext.Capabilities.Drop, []corev1.Capability{"ALL"})
	var mounts []string
	for _, m := range container.VolumeMounts {
		mounts = append(mounts, m.MountPath)
	}
	check(t, "mounts", mounts, []string{"/platform/input", "/platform/output", "/tmp"})
	check(t, "args", container.Args, []string{"create"})
	check(t, "termination message", container.TerminationMessagePath, "/platform/output/result.json")
}

func TestPodHardeningCanBeTurnedOffForImagesThatNeedIt(t *testing.T) {
	opts := options()
	opts.PodHardening = false
	c := newCluster(opts)
	_, _ = c.k.Start(context.Background(), stepTask())
	pod := c.job(t).Spec.Template.Spec
	check(t, "pod security", pod.SecurityContext, (*corev1.PodSecurityContext)(nil))
	check(t, "escalation", *pod.Containers[0].SecurityContext.AllowPrivilegeEscalation, false)
}

func TestSecretsAreMountedEachUnderItsName(t *testing.T) {
	c := newCluster(options())
	task := stepTask()
	task.SecretRefs = []string{"gcp-key", "a-very-long-secret-name-that-would-not-fit-in-a-volume-name-at-all"}
	if _, err := c.k.Start(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	pod := c.job(t).Spec.Template.Spec
	mounts := map[string]string{}
	for _, m := range pod.Containers[0].VolumeMounts {
		mounts[m.Name] = m.MountPath
	}
	check(t, "first", mounts["secret-0"], "/platform/secrets/gcp-key")
	check(t, "second", mounts["secret-1"], "/platform/secrets/"+task.SecretRefs[1])
}

// A product's declared audiences each get a short-lived token, in one
// projected volume at /platform/tokens/, and still no Kubernetes API token.
func TestTokenAudiencesAreProjectedEachInItsOwnFile(t *testing.T) {
	c := newCluster(options())
	task := stepTask()
	task.TokenAudiences = []string{"sts.amazonaws.com", "api://AzureADTokenExchange"}
	if _, err := c.k.Start(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	pod := c.job(t).Spec.Template.Spec
	check(t, "automount", *pod.AutomountServiceAccountToken, false)
	var projected *corev1.ProjectedVolumeSource
	for _, v := range pod.Volumes {
		if v.Name == "tokens" {
			projected = v.Projected
		}
	}
	if projected == nil {
		t.Fatalf("no tokens volume: %+v", pod.Volumes)
	}
	var got [][3]any
	for _, s := range projected.Sources {
		got = append(got, [3]any{s.ServiceAccountToken.Audience, s.ServiceAccountToken.Path, *s.ServiceAccountToken.ExpirationSeconds})
	}
	check(t, "tokens", got, [][3]any{
		{"sts.amazonaws.com", "sts.amazonaws.com", int64(3600)},
		{"api://AzureADTokenExchange", "api___AzureADTokenExchange", int64(3600)},
	})
	mounted := false
	for _, m := range pod.Containers[0].VolumeMounts {
		mounted = mounted || (m.Name == "tokens" && m.MountPath == "/platform/tokens" && m.ReadOnly)
	}
	check(t, "mounted read-only at /platform/tokens", mounted, true)
}

func TestStepPodsNameThePullSecretWhenOneIsSet(t *testing.T) {
	var names [][]string
	for _, secret := range []string{"vertra-pull", ""} {
		opts := options()
		opts.ImagePullSecret = secret
		c := newCluster(opts)
		_, _ = c.k.Start(context.Background(), stepTask())
		var refs []string
		for _, r := range c.job(t).Spec.Template.Spec.ImagePullSecrets {
			refs = append(refs, r.Name)
		}
		names = append(names, refs)
	}
	check(t, "pull secrets", names, [][]string{{"vertra-pull"}, nil})
}

func TestDeploymentPodLabelsGoOnTheStepPodAlone(t *testing.T) {
	opts := options()
	opts.PodLabels = map[string]string{"azure.workload.identity/use": "true"}
	c := newCluster(opts)
	_, _ = c.k.Start(context.Background(), stepTask())
	job := c.job(t)
	check(t, "on the Pod", job.Spec.Template.Labels["azure.workload.identity/use"], "true")
	check(t, "the kernel's still there", job.Spec.Template.Labels["app"], "execution-kernel")
	_, onJob := job.Labels["azure.workload.identity/use"]
	check(t, "on the Job", onJob, false)
}

func TestDiscardRemovesTheAttemptsJobAndConfigMap(t *testing.T) {
	c := newCluster(options())
	if err := c.k.Discard(context.Background(), stepTask()); err != nil {
		t.Fatal(err) // nothing there: not found is fine
	}
	name := JobName(stepTask().ExecutionID, "env", 1)
	check(t, "jobs", c.deleted("jobs"), []string{name})
	check(t, "configmaps", c.deleted("configmaps"), []string{name})
}

// --- refusals ---

func jobRefused(t *testing.T, err error) (*cluster, error) {
	t.Helper()
	c := newCluster(options())
	c.refuse("create", "jobs", err)
	_, startErr := c.k.Start(context.Background(), stepTask())
	return c, startErr
}

func TestAForbiddenCreateIsADispatchRejectionWithTheAPIServersMessage(t *testing.T) {
	_, err := jobRefused(t, status(403, metav1.StatusReasonForbidden, policyMessage))
	r := rejected(t, err)
	check(t, "code", r.Code, "DISPATCH_REJECTED") // a namespace refusal keeps the generic code
	check(t, "message", r.Message, policyMessage)
}

func TestAForbiddenCreateWithoutAMessageStillSaysWhatHappened(t *testing.T) {
	_, err := jobRefused(t, status(403, metav1.StatusReasonForbidden, ""))
	check(t, "message", rejected(t, err).Message, "403 Forbidden")
}

func TestOtherAPIErrorsArentPolicyRejections(t *testing.T) {
	for _, cause := range []error{status(500, metav1.StatusReasonInternalError, "boom"), status(400, metav1.StatusReasonBadRequest, "Job.batch is invalid")} {
		if _, err := jobRefused(t, cause); err == nil {
			t.Fatal("started")
		} else if _, ok := IsDispatchRejected(err); ok {
			t.Errorf("%v was taken for a refusal", cause)
		}
	}
}

func TestAnImagePolicyRefusalGetsItsOwnCodeAndJustThePolicysExplanation(t *testing.T) {
	c, err := jobRefused(t, status(403, metav1.StatusReasonForbidden, `jobs.batch "ek-env-1" is forbidden: ValidatingAdmissionPolicy `+
		`'kernel-execution-kernel-image' with binding 'kernel-execution-kernel-image' denied request: IMAGE_NOT_ALLOWED: `+
		`docker.io/evil/app is not from an allowed image source. Allowed: localhost:5001/. An admin can allow more on the console's Admin page.`))
	r := rejected(t, err)
	check(t, "code", r.Code, "IMAGE_NOT_ALLOWED")
	check(t, "message", strings.HasPrefix(r.Message, "docker.io/evil/app is not from an allowed image source."), true)
	check(t, "no configmap", c.created("configmaps"), 0)
}

func TestAnIdentityPolicyRefusalGetsItsOwnCode(t *testing.T) {
	_, err := jobRefused(t, status(403, metav1.StatusReasonForbidden, `jobs.batch "ek-env-1" is forbidden: ValidatingAdmissionPolicy `+
		`'kernel-execution-kernel-identity' with binding 'kernel-execution-kernel-identity' denied request: IDENTITY_NOT_ALLOWED: `+
		`localhost:5001/app (action "create") may not run as ServiceAccount "billing-sa" in team-a.`))
	r := rejected(t, err)
	check(t, "code", r.Code, "IDENTITY_NOT_ALLOWED")
	check(t, "message", strings.HasPrefix(r.Message, `localhost:5001/app (action "create") may not run as`), true)
}

// The dispatch policy's refusal for a namespace labelled retired.
func TestARetiredTeamsRefusalSaysSo(t *testing.T) {
	_, err := jobRefused(t, status(403, metav1.StatusReasonForbidden, `jobs.batch "ek-b-1" is forbidden: ValidatingAdmissionPolicy `+
		`'kernel-execution-kernel-dispatch' with binding 'kernel-execution-kernel-dispatch' denied request: TEAM_RETIRED: `+
		`team rt-a is retired, so nothing new runs in its namespace; an admin can un-retire it`))
	r := rejected(t, err)
	check(t, "code", r.Code, "TEAM_RETIRED")
	check(t, "message", r.Message, "team rt-a is retired, so nothing new runs in its namespace; an admin can un-retire it")
}

// Sigstore policy-controller's refusal, as kind returned it: a 400, not a 403.
func TestAnUnsignedImageIsANonRetryableSignatureRefusal(t *testing.T) {
	c, err := jobRefused(t, status(400, metav1.StatusReasonBadRequest, `admission webhook "policy.sigstore.dev" denied the request: validation failed: `+
		"failed policy: kernel-execution-kernel-signed-images: spec.template.spec.containers[0].image\n"+
		"us-central1-docker.pkg.dev/p/catalog-products/app@sha256:f75f no signatures found"))
	r := rejected(t, err)
	check(t, "code", r.Code, "IMAGE_NOT_SIGNED")
	check(t, "message", strings.HasPrefix(r.Message, "us-central1-docker.pkg.dev/p/catalog-products/app@sha256:f75f no signatures found."), true)
	check(t, "no configmap", c.created("configmaps"), 0)
}

// --- reading a finished Job, and releasing it ---

func finishedJob(t *testing.T, result string, opts KubernetesOptions) (*cluster, Handle) {
	t.Helper()
	ns, name := "demo-3", "ek-greet-1"
	one := int32(1)
	c := newCluster(opts,
		&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, Status: batchv1.JobStatus{Succeeded: 1, Ready: &one}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name + "-abcde", Namespace: ns, Labels: map[string]string{"job-name": name}},
			Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "product",
				State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Message: result}}}}}})
	return c, Handle{"namespace": ns, "jobName": name}
}

func TestReadingAFinishedJobsResultLeavesTheJob(t *testing.T) {
	c, handle := finishedJob(t, `{"status": "succeeded", "outputs": {"greeting": "hello"}}`, options())
	s, err := c.k.Status(context.Background(), handle)
	if err != nil {
		t.Fatal(err)
	}
	check(t, "state", s.State, Succeeded)
	check(t, "outputs", s.Outputs, map[string]any{"greeting": "hello"})
	check(t, "deleted", c.deleted("jobs"), []string(nil))
	check(t, "deleted", c.deleted("configmaps"), []string(nil))
}

// The Job controller marks a Job complete seconds after its container
// exits: the container's own end is read first.
func TestAStepIsDoneWhenItsContainerIsNotWhenItsJobIsMarked(t *testing.T) {
	ns, name := "demo-3", "ek-greet-1"
	c := newCluster(options(),
		&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}, // not yet marked
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name + "-abcde", Namespace: ns, Labels: map[string]string{"job-name": name}},
			Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "product",
				State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Message: `{"status": "succeeded", "outputs": {"greeting": "hello"}}`}}}}}})
	s, err := c.k.Status(context.Background(), Handle{"namespace": ns, "jobName": name})
	if err != nil {
		t.Fatal(err)
	}
	check(t, "state", s.State, Succeeded)
	check(t, "outputs", s.Outputs, map[string]any{"greeting": "hello"})
}

func TestReleaseRemovesTheJobAndConfigMapAndKeepsTheResult(t *testing.T) {
	c, handle := finishedJob(t, `{"status": "succeeded", "outputs": {"greeting": "hello"}}`, options())
	first, _ := c.k.Status(context.Background(), handle)
	for range 2 { // idempotent
		if err := c.k.Release(context.Background(), handle); err != nil {
			t.Fatal(err)
		}
	}
	check(t, "jobs", c.deleted("jobs"), []string{"ek-greet-1", "ek-greet-1"})
	check(t, "configmaps", c.deleted("configmaps"), []string{"ek-greet-1", "ek-greet-1"})
	again, err := c.k.Status(context.Background(), handle)
	if err != nil {
		t.Fatal(err)
	}
	check(t, "cached", again, first)
}

func TestAJobThatsGoneIsAFailureWorthRetrying(t *testing.T) {
	c := newCluster(options())
	s, err := c.k.Status(context.Background(), Handle{"namespace": "demo-3", "jobName": "ek-gone"})
	if err != nil {
		t.Fatal(err)
	}
	check(t, "state", s.State, Failed)
	check(t, "code", s.Error.Code, "JOB_NOT_FOUND")
	check(t, "retryable", s.Error.Retryable, true)
}

func TestCachedResultsExpire(t *testing.T) {
	k := newCluster(options()).k
	k.terminal["old"] = terminalRecord{recordedAt: time.Now().Add(-terminalRetention - time.Second)}
	k.terminal["recent"] = terminalRecord{recordedAt: time.Now().Add(-time.Second)}
	k.remember("new", terminalRecord{})
	var names []string
	for name := range k.terminal {
		names = append(names, name)
	}
	check(t, "kept", len(names), 2)
	_, old := k.terminal["old"]
	check(t, "old pruned", old, false)
}

func TestAStepsLogIsCappedAndSaysSo(t *testing.T) {
	opts := options()
	opts.LogMaxLines, opts.LogMaxBytes = 3, 10_000
	k := newCluster(opts).k
	lines := k.logLines([]byte("a\nb\nc\n"))
	check(t, "note", strings.HasPrefix(lines[0], "[vertra: earlier output not kept"), true)
	check(t, "lines", lines[1:], []string{"a", "b", "c"})
	check(t, "short", k.logLines([]byte("short\n")), []string{"short"})
	check(t, "empty", k.logLines(nil), []string{})
	k = newCluster(options()).k
	check(t, "carriage returns", k.logLines([]byte("x\r\ny\rz")), []string{"x", "y", "z"})
}

// --- what a step sends back ---

const aws = "AKIA" + "ABCDEFGHIJKLMNOP" // built up so no scanner takes it for a leak

func TestOutputsHoldingACredentialFailTheTaskAndLogsAreRedacted(t *testing.T) {
	c, handle := finishedJob(t, `{"status": "succeeded", "outputs": {"accessKey": "`+aws+`"}}`, options())
	s, _ := c.k.Status(context.Background(), handle)
	check(t, "state", s.State, Failed)
	check(t, "code", s.Error.Code, "OUTPUT_CONTAINS_CREDENTIAL")
	check(t, "retryable", s.Error.Retryable, false)
	check(t, "message", strings.Contains(s.Error.Message, aws), false)
	check(t, "outputs", s.Outputs, map[string]any(nil))
	check(t, "logs", c.k.logLines([]byte("signing in as "+aws+"\ndone\n")), []string{"signing in as [redacted AWS access key]", "done"})
}

func TestAProductsOwnErrorMessageIsRedacted(t *testing.T) {
	c, handle := finishedJob(t, `{"status": "failed", "error": {"code": "AUTH_FAILED", "message": "key `+aws+` was refused", "retryable": false}}`, options())
	s, _ := c.k.Status(context.Background(), handle)
	check(t, "message", s.Error.Message, "key [redacted AWS access key] was refused")
}

func TestAMissingOrInvalidResultIsARetryableFailure(t *testing.T) {
	for result, code := range map[string]string{"": "PRODUCT_RESULT_MISSING", "{not json": "PRODUCT_RESULT_INVALID"} {
		c, handle := finishedJob(t, result, options())
		s, _ := c.k.Status(context.Background(), handle)
		check(t, "code", s.Error.Code, code)
		check(t, "retryable", s.Error.Retryable, true)
	}
}

// A container the cluster stopped says why, though the kubelet records an
// exit code for it (137, or ContainerStatusUnknown for one still waiting).
func TestAContainerTheClusterStoppedSaysWhy(t *testing.T) {
	ns, name := "demo-3", "ek-greet-1"
	failedJob := func(reason string) *batchv1.Job {
		return &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, Status: batchv1.JobStatus{Failed: 1,
			Conditions: []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, Reason: reason}}}}
	}
	killed := []corev1.ContainerStatus{{Name: "product", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 137, Reason: "ContainerStatusUnknown"}}}}
	running := []corev1.ContainerStatus{{Name: "product", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}
	pod := func(status corev1.PodStatus) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name + "-abcde", Namespace: ns, Labels: map[string]string{"job-name": name}}, Status: status}
	}
	for what, c := range map[string]struct {
		objects    []runtime.Object
		code, want string
	}{
		"evicted": {[]runtime.Object{failedJob("BackoffLimitExceeded"), pod(corev1.PodStatus{Phase: corev1.PodFailed, Reason: "Evicted",
			Message: "The node was low on resource: memory. Threshold quantity: 100Mi, available: 80Mi.", ContainerStatuses: killed})},
			"POD_TERMINATED_UNEXPECTEDLY", "Its Pod was evicted: The node was low on resource: memory. Threshold quantity: 100Mi, available: 80Mi."},
		"preempted": {[]runtime.Object{failedJob("BackoffLimitExceeded"), pod(corev1.PodStatus{Phase: corev1.PodFailed, ContainerStatuses: killed,
			Conditions: []corev1.PodCondition{{Type: corev1.DisruptionTarget, Status: corev1.ConditionTrue, Reason: "PreemptionByScheduler", Message: "Kubernetes Scheduler: preempting"}}})},
			"POD_TERMINATED_UNEXPECTEDLY", "Its Pod was stopped by the cluster (PreemptionByScheduler): Kubernetes Scheduler: preempting."},
		"past the Job's deadline": {[]runtime.Object{failedJob(batchv1.JobReasonDeadlineExceeded), pod(corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: running})},
			"POD_TERMINATED_UNEXPECTEDLY", "It ran past its Job's deadline (its timeout, start timeout and grace) with no scheduler to stop it first."},
		"gone": {[]runtime.Object{failedJob("BackoffLimitExceeded")},
			"POD_TERMINATED_UNEXPECTEDLY", "Its Pod went away before its container finished: evicted, preempted, deleted, or lost with its node."},
		// Killed with nothing to say why: its exit code and logs, as before.
		"killed": {[]runtime.Object{failedJob("BackoffLimitExceeded"), pod(corev1.PodStatus{Phase: corev1.PodFailed, ContainerStatuses: killed})},
			"PRODUCT_RESULT_MISSING", "Container exited with code 137 without writing /platform/output/result.json. Recent logs: fake logs"},
	} {
		cl := newCluster(options(), c.objects...)
		s, err := cl.k.Status(context.Background(), Handle{"namespace": ns, "jobName": name})
		if err != nil {
			t.Fatal(what, err)
		}
		check(t, what+" state", s.State, Failed)
		check(t, what+" code", s.Error.Code, c.code)
		check(t, what+" retryable", s.Error.Retryable, true)
		check(t, what+" message", s.Error.Message, c.want)
	}
}

// --- an image that can't be pulled ---

const image = "us-central1-docker.pkg.dev/p/catalog-products/demo-3-deploy-product:abc"

var garNotFound = `failed to pull and unpack image "` + image + `": failed to resolve reference "` + image + `": ` + image + `: not found`

const dockerHubDenied = "pull access denied, repository does not exist or may require authorization: " +
	"server message: insufficient_scope: authorization failed"

func classify(reason, message string, age time.Duration) string {
	e := ImagePullFailure(reason, message, image, age, 120*time.Second)
	if e == nil {
		return ""
	}
	if e.Retryable {
		return e.Code + "/retryable"
	}
	return e.Code
}

func TestImagePullFailures(t *testing.T) {
	s := time.Second
	check(t, "missing", classify("ErrImagePull", garNotFound, 5*s), "IMAGE_NOT_FOUND")
	check(t, "manifest unknown", classify("ImagePullBackOff", "manifest unknown", 5*s), "IMAGE_NOT_FOUND")
	check(t, "never pull", classify("ErrImageNeverPull", "image not present with pull policy of Never", 5*s), "IMAGE_NOT_FOUND")
	check(t, "malformed", classify("InvalidImageName", "couldn't parse image reference", 5*s), "IMAGE_INVALID")
	check(t, "denied, in grace", classify("ErrImagePull", dockerHubDenied, 30*s), "")
	check(t, "timeout, in grace", classify("ImagePullBackOff", "dial tcp: i/o timeout", 30*s), "")
	check(t, "past grace", classify("ImagePullBackOff", dockerHubDenied, 121*s), "IMAGE_PULL_FAILED/retryable")
	check(t, "a named user", classify("CreateContainerConfigError", "container has runAsNonRoot and image has non-numeric user (app), cannot verify user is non-root (pod: \"ek-x\", container: product)", 5*s), "IMAGE_USER_NOT_ALLOWED")
	check(t, "root", classify("CreateContainerConfigError", "container has runAsNonRoot and image will run as root (pod: \"ek-x\", container: product)", 5*s), "IMAGE_USER_NOT_ALLOWED")
	check(t, "a secret not there yet", classify("CreateContainerConfigError", "secret \"api-key\" not found", 5*s), "")
	check(t, "creating", classify("ContainerCreating", "", 999*s), "")
	check(t, "initializing", classify("PodInitializing", "", 999*s), "")
}

// The deciding phrase can sit past the part kept for the error message.
func TestTheKubeletMessageIsCarriedButBounded(t *testing.T) {
	e := ImagePullFailure("ErrImagePull", strings.Repeat("x ", 2500)+garNotFound, image, time.Second, 120*time.Second)
	check(t, "code", e.Code, "IMAGE_NOT_FOUND")
	check(t, "image", strings.Contains(e.Message, image), true)
	check(t, "bounded", len(e.Message) < 1200, true)
}

func pullingJob(reason, message string) (*cluster, Handle) {
	ns, name := "demo-3", "ek-deploy-1"
	zero := int32(0)
	return newCluster(options(),
			&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, Status: batchv1.JobStatus{Ready: &zero}},
			&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name + "-x", Namespace: ns, Labels: map[string]string{"job-name": name},
				CreationTimestamp: metav1.NewTime(time.Now().Add(-10 * time.Second))},
				Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "product", Image: image,
					State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: reason, Message: message}}}}}}),
		Handle{"namespace": ns, "jobName": name}
}

func TestStatusFailsTheTaskWhenItsImageIsMissing(t *testing.T) {
	c, handle := pullingJob("ErrImagePull", garNotFound)
	s, err := c.k.Status(context.Background(), handle)
	if err != nil {
		t.Fatal(err)
	}
	check(t, "state", s.State, Failed)
	check(t, "code", s.Error.Code, "IMAGE_NOT_FOUND")
	// The Job stays until the failure is committed and the scheduler releases it.
	check(t, "deleted", c.deleted("jobs"), []string(nil))
	_ = c.k.Release(context.Background(), handle)
	check(t, "jobs", c.deleted("jobs"), []string{"ek-deploy-1"})
	check(t, "configmaps", c.deleted("configmaps"), []string{"ek-deploy-1"})
	again, _ := c.k.Status(context.Background(), handle)
	check(t, "cached", again, s)
}

func TestStatusKeepsRunningWhileATransientPullErrorIsWithinGrace(t *testing.T) {
	c, handle := pullingJob("ImagePullBackOff", "dial tcp: i/o timeout")
	s, _ := c.k.Status(context.Background(), handle)
	check(t, "state", s.State, Running)
	check(t, "deleted", c.deleted("jobs"), []string(nil))
}

// --- listing what was launched ---

func TestListAttemptsReadsEachJobsIdentityFromItsLabels(t *testing.T) {
	created := metav1.NewTime(time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC))
	job := func(name string, labels, annotations map[string]string) *batchv1.Job {
		labels["app"] = "execution-kernel"
		return &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "demo-3", Labels: labels, Annotations: annotations, CreationTimestamp: created}}
	}
	c := newCluster(options(),
		job("ek-greet-1", map[string]string{"vertra.dev/execution-id": "e-1", "vertra.dev/attempt": "2"}, map[string]string{"vertra.dev/task": "greet"}),
		job("ek-hand-made", map[string]string{}, nil), // not made the way the kernel makes Jobs
		&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "someone-elses", Namespace: "demo-3"}})
	attempts, err := c.k.ListAttempts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	check(t, "attempts", attempts, []LaunchedAttempt{{Handle: Handle{"namespace": "demo-3", "jobName": "ek-greet-1"},
		ExecutionID: "e-1", TaskKey: "greet", Attempt: 2, CreatedAt: created.Time}})
}

// --- when a running step's Job needn't be read again ---

func runningJob(ready int32, watch *jobWatch) (*cluster, Handle, func() int) {
	ns, name := "team-a", "ek-step-1"
	c := newCluster(options(), &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, Status: batchv1.JobStatus{Ready: &ready}})
	c.k.watch = watch
	reads := func() int {
		n := 0
		for _, a := range c.Actions() {
			if a.GetVerb() == "get" && a.GetResource().Resource == "jobs" {
				n++
			}
		}
		return n
	}
	return c, Handle{"namespace": ns, "jobName": name}, reads
}

func healthyWatch() *jobWatch {
	w := newJobWatch()
	w.setUp("jobs", true)
	w.setUp("pods", true)
	return w
}

func twice(t *testing.T, c *cluster, handle Handle) {
	t.Helper()
	for range 2 {
		s, err := c.k.Status(context.Background(), handle)
		if err != nil || s.State != Running {
			t.Fatalf("status = %v, %v", s, err)
		}
	}
}

// A running step says when its container started (its timeout counts from
// then), read from its Pod once.
func TestARunningStepSaysWhenItStarted(t *testing.T) {
	ns, name := "team-a", "ek-step-1"
	one := int32(1)
	started := metav1.NewTime(time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC))
	c := newCluster(options(),
		&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, Status: batchv1.JobStatus{Ready: &one}},
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name + "-x", Namespace: ns, Labels: map[string]string{"job-name": name}},
			Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{Name: "product", State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{StartedAt: started}}}}}})
	handle := Handle{"namespace": ns, "jobName": name}
	podLists := func() int {
		n := 0
		for _, a := range c.Actions() {
			if a.GetVerb() == "list" && a.GetResource().Resource == "pods" {
				n++
			}
		}
		return n
	}
	for range 2 {
		s, err := c.k.Status(context.Background(), handle)
		if err != nil || s.StartedAt == nil || !s.StartedAt.Equal(started.Time) {
			t.Fatalf("status = %+v, %v", s, err)
		}
	}
	check(t, "pods listed", podLists(), 1)
}

func TestAnUnchangedRunningStepIsntReadAgain(t *testing.T) {
	c, handle, reads := runningJob(1, healthyWatch())
	twice(t, c, handle)
	check(t, "reads", reads(), 1)
}

func TestAWatchedChangeForcesARead(t *testing.T) {
	w := healthyWatch()
	c, handle, reads := runningJob(1, w)
	_, _ = c.k.Status(context.Background(), handle)
	w.markChanged("jobs", "ek-step-1")
	_, _ = c.k.Status(context.Background(), handle)
	check(t, "reads", reads(), 2)
}

func TestWithoutAHealthyWatchEveryStatusIsRead(t *testing.T) {
	for name, w := range map[string]*jobWatch{"unhealthy": newJobWatch(), "none": nil} {
		c, handle, reads := runningJob(1, w)
		twice(t, c, handle)
		check(t, name, reads(), 2)
	}
}

func TestTheResyncIntervalForcesARead(t *testing.T) {
	c, handle, reads := runningJob(1, healthyWatch())
	_, _ = c.k.Status(context.Background(), handle)
	c.k.quietSince["ek-step-1"] = c.k.quietSince["ek-step-1"].Add(-31 * time.Second)
	_, _ = c.k.Status(context.Background(), handle)
	check(t, "reads", reads(), 2)
}

// It may be stuck pulling its image, which the grace period catches by
// reading, not by an event.
func TestAStepWhosePodIsntReadyIsAlwaysRead(t *testing.T) {
	c, handle, reads := runningJob(0, healthyWatch())
	twice(t, c, handle)
	check(t, "reads", reads(), 2)
}

func TestTheWatchWakesAWaitingScheduler(t *testing.T) {
	w := newJobWatch()
	woke := make(chan struct{})
	go func() { w.wait(context.Background(), 5*time.Second); close(woke) }()
	time.Sleep(10 * time.Millisecond)
	w.markChanged("pods", "ek-step-1")
	select {
	case <-woke:
	case <-time.After(time.Second):
		t.Fatal("not woken")
	}
	check(t, "changed", w.takeChanged("ek-step-1"), true)
	check(t, "taken", w.takeChanged("ek-step-1"), false)
}

func TestAPodEventIsTracedToItsJob(t *testing.T) {
	pod := func(labels map[string]string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "p", Labels: labels}}
	}
	name := func(obj any) string { _, n := jobNameOf(obj); return n }
	check(t, "job", name(&batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "ek-a"}}), "ek-a")
	check(t, "pod", name(pod(map[string]string{"job-name": "ek-a"})), "ek-a")
	check(t, "pod, new label", name(pod(map[string]string{"batch.kubernetes.io/job-name": "ek-b"})), "ek-b")
	check(t, "pod, no labels", name(pod(nil)), "")
}

// A real watch against the fake API: a new kernel Job wakes the waiter.
func TestTheInformersReportAJobChanging(t *testing.T) {
	c := newCluster(options())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.k.Watch(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for !c.k.watch.healthy() {
		if time.Now().After(deadline) {
			t.Fatal("the watch never came up")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := c.k.Start(ctx, stepTask()); err != nil {
		t.Fatal(err)
	}
	name := JobName(stepTask().ExecutionID, "env", 1)
	for !c.k.watch.takeChanged(name) {
		if time.Now().After(deadline) {
			t.Fatal("no change seen")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// --- placement ---

func TestPlacementReachesEveryStepPodAsWritten(t *testing.T) {
	opts := options()
	opts.NodeSelector = map[string]string{"karpenter.sh/capacity-type": "spot"}
	opts.Tolerations = []corev1.Toleration{{Key: "kubernetes.azure.com/scalesetpriority", Operator: "Equal", Value: "spot", Effect: "NoSchedule"}}
	opts.Affinity = &corev1.Affinity{NodeAffinity: &corev1.NodeAffinity{PreferredDuringSchedulingIgnoredDuringExecution: []corev1.PreferredSchedulingTerm{{
		Weight: 100, Preference: corev1.NodeSelectorTerm{MatchExpressions: []corev1.NodeSelectorRequirement{{Key: "cloud.google.com/gke-spot", Operator: "In", Values: []string{"true"}}}}}}}}
	c := newCluster(opts)
	_, _ = c.k.Start(context.Background(), stepTask())
	pod := c.job(t).Spec.Template.Spec
	check(t, "node selector", pod.NodeSelector, opts.NodeSelector)
	check(t, "tolerations", pod.Tolerations, opts.Tolerations)
	check(t, "affinity", pod.Affinity, opts.Affinity)
}

func TestWithoutPlacementThePodSpecSaysNothingAboutIt(t *testing.T) {
	c := newCluster(options())
	_, _ = c.k.Start(context.Background(), stepTask())
	data, _ := json.Marshal(c.job(t).Spec.Template.Spec)
	for _, field := range []string{"nodeSelector", "tolerations", "affinity"} {
		if strings.Contains(string(data), `"`+field+`"`) {
			t.Errorf("%s is set", field)
		}
	}
}

// The Job controller's messages when a team's limits refuse a step's Pod.
func TestAStepThatCanNeverFitItsTeamFailsAndOneWaitingForRoomDoesnt(t *testing.T) {
	const prefix = `pods "ek-big-1-abcde" is forbidden: `
	never := map[string]string{
		"over the LimitRange":  prefix + "maximum memory usage per Container is 4Gi, but limit is 8Gi",
		"over the whole quota": prefix + "exceeded quota: vertra-team-quota, requested: requests.cpu=8,requests.memory=1Gi, used: requests.cpu=0,requests.memory=0, limited: requests.cpu=4,requests.memory=16Gi",
	}
	for what, message := range never {
		if NeverFits(message) == "" {
			t.Errorf("%s: should never fit", what)
		}
	}
	waits := prefix + "exceeded quota: vertra-team-quota, requested: requests.cpu=1, used: requests.cpu=4, limited: requests.cpu=4"
	check(t, "quota in use", NeverFits(waits), "")
	check(t, "another refusal", NeverFits(prefix+"error looking up service account"), "")

	ns, name := "demo-3", "ek-big-1"
	job := &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}}
	event := func(message string) *corev1.Event {
		return &corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: name + ".1", Namespace: ns}, Reason: "FailedCreate", Message: message,
			InvolvedObject: corev1.ObjectReference{Kind: "Job", Name: name, Namespace: ns}}
	}
	c := newCluster(options(), job, event(waits))
	s, err := c.k.Status(context.Background(), Handle{"namespace": ns, "jobName": name})
	if err != nil {
		t.Fatal(err)
	}
	check(t, "waiting for room", s.State, Running)

	c = newCluster(options(), job, event(never["over the LimitRange"]))
	s, err = c.k.Status(context.Background(), Handle{"namespace": ns, "jobName": name})
	if err != nil {
		t.Fatal(err)
	}
	check(t, "too big", s.State, Failed)
	check(t, "code", s.Error.Code, "RESOURCES_NOT_ALLOWED")
	check(t, "retryable", s.Error.Retryable, false)
}

// --- Pods no node has room for ---

func TestCountUnschedulableCountsPendingPodsWithNoNode(t *testing.T) {
	pod := func(phase corev1.PodPhase, status corev1.ConditionStatus, reason string) *corev1.Pod {
		return &corev1.Pod{Status: corev1.PodStatus{Phase: phase, Conditions: []corev1.PodCondition{{Type: corev1.PodScheduled, Status: status, Reason: reason}}}}
	}
	check(t, "none", CountUnschedulable(nil), 0)
	check(t, "two", CountUnschedulable([]*corev1.Pod{
		pod(corev1.PodPending, corev1.ConditionFalse, corev1.PodReasonUnschedulable),
		pod(corev1.PodPending, corev1.ConditionFalse, corev1.PodReasonUnschedulable),
		// Scheduled, or gated, or finished: not waiting for room.
		pod(corev1.PodRunning, corev1.ConditionTrue, ""),
		pod(corev1.PodPending, corev1.ConditionFalse, corev1.PodReasonSchedulingGated),
		pod(corev1.PodFailed, corev1.ConditionFalse, corev1.PodReasonUnschedulable),
	}), 2)
}
