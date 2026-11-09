// SPDX-License-Identifier: MIT

package executor_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/roburns/vennir/kernel/internal/executor"
	"github.com/roburns/vennir/kernel/internal/kindtest"
	"github.com/roburns/vennir/kernel/internal/logging"
)

// The executor against a real cluster (kind), with a minimal fixture image
// (internal/kindtest/fixture) that exercises its own mechanics: ConfigMap
// input, termination-message output, cancellation, release.

func kindOptions() executor.KubernetesOptions {
	return executor.KubernetesOptions{JobTTL: time.Hour, ImagePullGrace: 120 * time.Second, JobDeadlineGrace: 600 * time.Second,
		RequestTimeout: 30 * time.Second, WatchResync: 30 * time.Second, LogMaxLines: 5000, LogMaxBytes: 1 << 20}
}

func kindExecutor(t *testing.T, change ...func(*executor.KubernetesOptions)) (*executor.Kubernetes, kubernetes.Interface) {
	t.Helper()
	client := kindtest.Cluster(t)
	opts := kindOptions()
	for _, c := range change {
		c(&opts)
	}
	return executor.NewKubernetes(client, opts, logging.NewTo(io.Discard, "kernel-scheduler-test", "kind")), client
}

// fixtureTask has an execution id of its own: tests sharing one would share
// Job names, and a Job from an earlier test may still be terminating.
func fixtureTask(_ *testing.T, action string, inputs map[string]any, image string) executor.ResolvedTask {
	return executor.ResolvedTask{ExecutionID: fmt.Sprintf("exec-%d", time.Now().UnixNano()),
		TaskKey: "task-" + action, Image: image, Action: action, Attempt: 1, ResolvedInputs: inputs,
		TimeoutSeconds: 60, Team: kindtest.Namespace, ServiceAccount: "default"}
}

func start(t *testing.T, k *executor.Kubernetes, task executor.ResolvedTask) executor.Handle {
	t.Helper()
	handle, err := k.Start(context.Background(), task)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = k.Cancel(context.Background(), handle)
		_ = k.Release(context.Background(), handle)
	})
	return handle
}

func waitForTerminal(t *testing.T, k *executor.Kubernetes, handle executor.Handle, timeout time.Duration) executor.Status {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s, err := k.Status(context.Background(), handle)
		if err != nil {
			t.Fatal(err)
		}
		if s.State != executor.Running {
			return s
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("not finished within %s", timeout)
	return executor.Status{}
}

func job(t *testing.T, client kubernetes.Interface, handle executor.Handle) *corev1.PodSpec {
	t.Helper()
	j, err := client.BatchV1().Jobs(handle["namespace"].(string)).Get(context.Background(), handle["jobName"].(string), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return &j.Spec.Template.Spec
}

func TestKindASuccessfulTaskReturnsItsOutputs(t *testing.T) {
	k, _ := kindExecutor(t)
	image := kindtest.Image(t, kindtest.FixtureImage)
	s := waitForTerminal(t, k, start(t, k, fixtureTask(t, "greet", map[string]any{"name": "world"}, image)), 60*time.Second)
	if s.State != executor.Succeeded {
		t.Fatalf("status = %+v", s)
	}
	if got := s.Outputs["echoedAction"]; got != "greet" {
		t.Errorf("outputs = %v", s.Outputs)
	}
	if got, _ := s.Outputs["receivedInputs"].(map[string]any); got["name"] != "world" {
		t.Errorf("outputs = %v", s.Outputs)
	}
}

func TestKindAProductDeclaredFailureIsRelayedAsIs(t *testing.T) {
	k, _ := kindExecutor(t)
	image := kindtest.Image(t, kindtest.FixtureImage)
	s := waitForTerminal(t, k, start(t, k, fixtureTask(t, "create", map[string]any{"shouldFail": true}, image)), 60*time.Second)
	if s.State != executor.Failed || s.Error.Code != "TEST_FAILURE" || s.Error.Retryable {
		t.Fatalf("status = %+v %+v", s, s.Error)
	}
}

func TestKindACrashWithoutAResultIsARetryableFailure(t *testing.T) {
	k, _ := kindExecutor(t)
	image := kindtest.Image(t, kindtest.FixtureImage)
	s := waitForTerminal(t, k, start(t, k, fixtureTask(t, "crash", nil, image)), 60*time.Second)
	if s.State != executor.Failed || s.Error.Code != "PRODUCT_RESULT_MISSING" || !s.Error.Retryable {
		t.Fatalf("status = %+v %+v", s, s.Error)
	}
}

func TestKindARunningTaskIsRunningAndCancelStopsIt(t *testing.T) {
	k, client := kindExecutor(t)
	image := kindtest.Image(t, kindtest.FixtureImage)
	handle := start(t, k, fixtureTask(t, "sleep", map[string]any{"seconds": 60}, image))
	time.Sleep(3 * time.Second)
	if s, err := k.Status(context.Background(), handle); err != nil || s.State != executor.Running {
		t.Fatalf("status = %+v, %v", s, err)
	}
	for range 2 { // idempotent
		if err := k.Cancel(context.Background(), handle); err != nil {
			t.Fatal(err)
		}
	}
	_, err := client.BatchV1().Jobs(kindtest.Namespace).Get(context.Background(), handle["jobName"].(string), metav1.GetOptions{})
	if !apierrors.IsNotFound(err) {
		t.Fatalf("the Job is still there: %v", err)
	}
	// Gone: a status read says so, as a failure, rather than erring.
	if s := waitForTerminal(t, k, handle, 30*time.Second); s.State != executor.Failed {
		t.Errorf("status = %+v", s)
	}
}

func TestKindExtraEnvironmentReachesEveryPodAndNothingElse(t *testing.T) {
	image := kindtest.Image(t, kindtest.FixtureImage)
	k, client := kindExecutor(t, func(o *executor.KubernetesOptions) {
		o.ExtraEnvironment = map[string]string{"EXAMPLE_SETTING": "example-value"}
	})
	env := job(t, client, start(t, k, fixtureTask(t, "sleep", map[string]any{"seconds": 30}, image))).Containers[0].Env
	if len(env) != 1 || env[0].Name != "EXAMPLE_SETTING" || env[0].Value != "example-value" {
		t.Errorf("env = %v", env)
	}
	plain, client := kindExecutor(t)
	if env := job(t, client, start(t, plain, fixtureTask(t, "crash", nil, image))).Containers[0].Env; len(env) != 0 {
		t.Errorf("env = %v", env)
	}
}

func TestKindThePodIsLabelledWithItsExecutionAndTask(t *testing.T) {
	k, client := kindExecutor(t)
	task := fixtureTask(t, "sleep", map[string]any{"seconds": 30}, kindtest.Image(t, kindtest.FixtureImage))
	handle := start(t, k, task)
	var pods []corev1.Pod
	for range 30 { // the Job controller makes the Pod a moment later
		list, err := client.CoreV1().Pods(kindtest.Namespace).List(context.Background(), metav1.ListOptions{LabelSelector: "job-name=" + handle["jobName"].(string)})
		if err != nil {
			t.Fatal(err)
		}
		if pods = list.Items; len(pods) > 0 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if len(pods) != 1 {
		t.Fatalf("pods = %d", len(pods))
	}
	p := pods[0]
	if p.Labels["vennir.dev/execution-id"] != task.ExecutionID || p.Labels["vennir.dev/attempt"] != "1" || p.Annotations["vennir.dev/task"] != task.TaskKey {
		t.Errorf("labels = %v, annotations = %v", p.Labels, p.Annotations)
	}
	attempts, err := k.ListAttempts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, a := range attempts {
		found = found || (a.ExecutionID == task.ExecutionID && a.TaskKey == task.TaskKey && a.Attempt == 1)
	}
	if !found {
		t.Error("ListAttempts doesn't list it")
	}
}

// Reading the result leaves the Job; Release removes it and its ConfigMap;
// the result and logs are still served afterwards.
func TestKindAFinishedTaskIsReleasedAndItsResultKept(t *testing.T) {
	k, client := kindExecutor(t)
	handle := start(t, k, fixtureTask(t, "greet", nil, kindtest.Image(t, kindtest.FixtureImage)))
	first := waitForTerminal(t, k, handle, 60*time.Second)
	ctx, ns, name := context.Background(), kindtest.Namespace, handle["jobName"].(string)
	if _, err := client.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{}); err != nil {
		t.Fatalf("reading the result removed the Job: %v", err)
	}
	if err := k.Release(ctx, handle); err != nil {
		t.Fatal(err)
	}
	if _, err := client.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Errorf("Job: %v", err)
	}
	if _, err := client.CoreV1().ConfigMaps(ns).Get(ctx, name, metav1.GetOptions{}); !apierrors.IsNotFound(err) {
		t.Errorf("ConfigMap: %v", err)
	}
	second, _ := k.Status(ctx, handle)
	if second.State != first.State {
		t.Errorf("status after release = %+v, before %+v", second, first)
	}
	logs, _ := k.Logs(ctx, handle)
	if !strings.Contains(strings.Join(logs, "\n"), "running action=greet") {
		t.Errorf("logs = %v", logs)
	}
}

// secondTeam is a namespace standing in for another team's, removed after.
func secondTeam(t *testing.T, client kubernetes.Interface) string {
	t.Helper()
	ctx, name := context.Background(), "gcp-team-test"
	for range 60 { // an earlier run's may still be terminating
		_, err := client.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}, metav1.CreateOptions{})
		if err == nil {
			break
		}
		if !apierrors.IsAlreadyExists(err) {
			t.Fatal(err)
		}
		time.Sleep(time.Second)
	}
	t.Cleanup(func() { _ = client.CoreV1().Namespaces().Delete(ctx, name, metav1.DeleteOptions{}) })
	return name
}

// A task's team is where its Job goes, and its ServiceAccount the Pod's
// identity: not a shared default.
func TestKindATaskRunsInItsTeamAsItsServiceAccount(t *testing.T) {
	k, client := kindExecutor(t)
	image := kindtest.Image(t, kindtest.FixtureImage)
	team := secondTeam(t, client)
	if _, err := client.CoreV1().ServiceAccounts(team).Create(context.Background(),
		&corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: "gcp-demo-sa"}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	task := fixtureTask(t, "greet", nil, image)
	task.Team, task.ServiceAccount = team, "gcp-demo-sa"
	handle := start(t, k, task)
	if handle["namespace"] != team {
		t.Errorf("handle = %v", handle)
	}
	if sa := job(t, client, handle).ServiceAccountName; sa != "gcp-demo-sa" {
		t.Errorf("service account = %q", sa)
	}
	// What the cluster itself says the identity may do (nothing granted).
	if out, _ := exec.Command("kubectl", "auth", "can-i", "get", "secrets", "-n", team,
		"--as", "system:serviceaccount:"+team+":gcp-demo-sa").Output(); strings.TrimSpace(string(out)) != "no" {
		t.Errorf("can-i get secrets = %q", out)
	}
}

// A step reads the Secrets it names, mounted, and none of its team's others.
func TestKindATaskReadsTheSecretsItNamesAndNoOthers(t *testing.T) {
	k, client := kindExecutor(t)
	image := kindtest.Image(t, kindtest.FixtureImage)
	team := secondTeam(t, client)
	value := fmt.Sprintf("token-%d", time.Now().UnixNano())
	for name, data := range map[string]string{"e2e-token": value, "not-asked-for": "elsewhere"} {
		if _, err := client.CoreV1().Secrets(team).Create(context.Background(), &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: name}, StringData: map[string]string{"token": data}}, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	task := fixtureTask(t, "secret-digest", nil, image)
	task.Team, task.SecretRefs = team, []string{"e2e-token"}
	s := waitForTerminal(t, k, start(t, k, task), 60*time.Second)
	if s.State != executor.Succeeded {
		t.Fatalf("status = %+v", s)
	}
	sum := sha256.Sum256([]byte(value))
	want := map[string]any{"e2e-token/token": hex.EncodeToString(sum[:])}
	if got, _ := s.Outputs["digests"].(map[string]any); !reflect.DeepEqual(got, want) {
		t.Errorf("digests = %v, want %v; status: %+v", got, want, s)
	}
}

func TestKindImagePullPolicies(t *testing.T) {
	k, client := kindExecutor(t)
	team := secondTeam(t, client)
	for image, want := range map[string]corev1.PullPolicy{
		// A registry's :latest moves: pulled every time.
		"us-central1-docker.pkg.dev/my-gcp-project/catalog-products/fake-product:latest": corev1.PullAlways,
		// A bare :latest is kind-loaded, with nowhere to pull from.
		"fake-local-product:latest": corev1.PullIfNotPresent,
		// Anything else is immutable.
		kindtest.Image(t, kindtest.FixtureImage): corev1.PullIfNotPresent,
	} {
		task := fixtureTask(t, "greet", nil, image)
		task.Team, task.TaskKey = team, "pull-"+string(want)+"-"+strings.NewReplacer("/", "-", ":", "-", ".", "-").Replace(image)
		if got := job(t, client, start(t, k, task)).Containers[0].ImagePullPolicy; got != want {
			t.Errorf("%s: %s, want %s", image, got, want)
		}
	}
}

// A registry saying "no such tag" (a purged product's image) fails the task
// within seconds, not at its timeout.
func TestKindAMissingImageFailsFastAsImageNotFound(t *testing.T) {
	k, client := kindExecutor(t)
	task := fixtureTask(t, "greet", nil, "registry.k8s.io/pause:vennir-does-not-exist")
	task.Team = secondTeam(t, client)
	s := waitForTerminal(t, k, start(t, k, task), 90*time.Second)
	if s.State != executor.Failed || s.Error.Code != "IMAGE_NOT_FOUND" || s.Error.Retryable {
		t.Fatalf("status = %+v %+v", s, s.Error)
	}
}

// The demo products, run directly.
func TestKindTheDemoProducts(t *testing.T) {
	k, _ := kindExecutor(t)
	project, application := kindtest.Image(t, kindtest.ProjectImage), kindtest.Image(t, kindtest.ApplicationImage)
	runs := 0
	run := func(image, action string, inputs map[string]any) executor.Status {
		t.Helper()
		runs++
		task := fixtureTask(t, action, inputs, image)
		task.TaskKey = fmt.Sprintf("demo-%d", runs)
		return waitForTerminal(t, k, start(t, k, task), 60*time.Second)
	}
	created := run(project, "create", map[string]any{"projectName": "demo-project"})
	if created.State != executor.Succeeded || created.Outputs["projectId"] != "demo-project-123" {
		t.Errorf("project create = %+v", created)
	}
	for name, c := range map[string]struct {
		image, action string
		inputs        map[string]any
		code          string
	}{
		"project without a name":        {project, "create", map[string]any{}, "MISSING_INPUT"},
		"project, unsupported action":   {project, "explode", map[string]any{"projectName": "p"}, "UNSUPPORTED_ACTION"},
		"application without a project": {application, "create", map[string]any{}, "MISSING_INPUT"},
	} {
		s := run(c.image, c.action, c.inputs)
		if s.State != executor.Failed || s.Error.Code != c.code {
			t.Errorf("%s = %+v %+v", name, s, s.Error)
		}
	}
	// The project's output feeds the application's input.
	deployed := run(application, "create", map[string]any{"projectId": created.Outputs["projectId"]})
	if deployed.State != executor.Succeeded || deployed.Outputs["applicationUrl"] != "https://demo.example" {
		t.Errorf("application create = %+v", deployed)
	}
}

// A start retried for the same attempt (the scheduler stopped between
// creating its Job and recording it) adopts the Job it made: the API
// server's defaults never make it look like someone else's.
func TestKindARetriedStartAdoptsItsOwnJob(t *testing.T) {
	k, client := kindExecutor(t, func(o *executor.KubernetesOptions) { o.ExtraEnvironment = map[string]string{"VENNIR_TEST": "1"} })
	task := fixtureTask(t, "greet", map[string]any{"name": "again"}, kindtest.Image(t, kindtest.FixtureImage))
	task.SecretRefs = []string{"no-such-secret"}
	task.TokenAudiences = []string{"vennir-test"}
	first := start(t, k, task)
	again, err := k.Start(context.Background(), task)
	if err != nil {
		t.Fatalf("not adopted: %v", err)
	}
	if again["jobName"] != first["jobName"] {
		t.Errorf("handles differ: %v, %v", first, again)
	}
	_ = job(t, client, again)
}
