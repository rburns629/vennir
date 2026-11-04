// SPDX-License-Identifier: MIT

package sleeper

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"testing"
	"time"

	autoscalingv1 "k8s.io/api/autoscaling/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/rburns629/vennir/kernel/internal/config"
)

// KernelActivity is tested against the real database in activity_test.go.

const twoHours = 2 * time.Hour

func at(d time.Duration) *time.Time { t := time.Now().Add(d); return &t }

func TestLastActivityIsTheLatestKnownMoment(t *testing.T) {
	now := time.Now()
	if got := LastActivity(nil, at(-twoHours), &now, nil); !got.Equal(now) {
		t.Errorf("got %v", got)
	}
	if LastActivity(nil, nil) != nil {
		t.Error("nothing known should be nil")
	}
}

func TestShouldSleep(t *testing.T) {
	now := time.Now()
	ago := func(d time.Duration) *time.Time { at := now.Add(-d); return &at }
	for name, c := range map[string]struct {
		busy bool
		last *time.Time
		want bool
	}{
		"idle long enough":        {false, ago(twoHours), true},
		"not yet":                 {false, ago(twoHours - time.Minute), false},
		"busy":                    {true, ago(10 * twoHours), false},
		"nothing to measure from": {false, nil, false},
	} {
		if got := ShouldSleep(now, c.busy, c.last, twoHours); got != c.want {
			t.Errorf("%s: %v", name, got)
		}
	}
}

var settings = config.Settings{
	SleeperNamespace: "vennir-system", SleeperDeployments: []string{"api", "console", "trivy"},
	SleeperDatabases: []string{"postgres"}, SleeperStateConfigMap: "kernel-sleep",
	SleeperConsoleActivityConfigMap: "console-activity", SleeperAPIPodSelector: "component=api",
	SleeperIdleAfter: twoHours, SleeperCronJob: "kernel-sleeper", SleeperScheduledWait: time.Hour,
}

type platform struct {
	*Platform
	client  *fake.Clientset
	scaled  []string
	patched map[string]string // the state ConfigMap's awakeReplicas
	suspend []string
}

// newPlatform has these Deployments at these replicas, the console last
// used at console (nil: never), and kernel-api started six hours ago.
func newPlatform(replicas map[string]int32, console *time.Time) *platform {
	objects := []runtime.Object{
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-1", Namespace: "vennir-system", Labels: map[string]string{"component": "api"}},
			Status: corev1.PodStatus{StartTime: &metav1.Time{Time: time.Now().Add(-3 * twoHours)}}},
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "kernel-sleep", Namespace: "vennir-system"}},
	}
	if console != nil {
		objects = append(objects, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "console-activity", Namespace: "vennir-system"},
			Data: map[string]string{"lastActivityAt": console.UTC().Format("2006-01-02T15:04:05.000Z07:00")}})
	}
	client := fake.NewClientset(objects...)
	p := &platform{client: client, patched: map[string]string{}}
	deployments := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
	client.PrependReactor("get", "deployments", func(a k8stesting.Action) (bool, runtime.Object, error) {
		get := a.(k8stesting.GetAction)
		n, ok := replicas[get.GetName()]
		if a.GetSubresource() != "scale" || !ok {
			return true, nil, newNotFound(deployments, get.GetName())
		}
		return true, &autoscalingv1.Scale{ObjectMeta: metav1.ObjectMeta{Name: get.GetName()}, Spec: autoscalingv1.ScaleSpec{Replicas: n}}, nil
	})
	client.PrependReactor("update", "deployments", func(a k8stesting.Action) (bool, runtime.Object, error) {
		scale := a.(k8stesting.UpdateAction).GetObject().(*autoscalingv1.Scale)
		if a.GetSubresource() != "scale" || scale.Spec.Replicas != 0 {
			return true, nil, newNotFound(deployments, "only scales to zero")
		}
		p.scaled = append(p.scaled, scale.Name)
		return true, scale, nil
	})
	client.PrependReactor("patch", "cronjobs", func(a k8stesting.Action) (bool, runtime.Object, error) {
		p.suspend = append(p.suspend, a.(k8stesting.PatchAction).GetName())
		return true, nil, nil
	})
	client.PrependReactor("patch", "configmaps", func(a k8stesting.Action) (bool, runtime.Object, error) {
		var body struct{ Data map[string]string }
		_ = json.Unmarshal(a.(k8stesting.PatchAction).GetPatch(), &body)
		p.patched = body.Data
		return true, &corev1.ConfigMap{}, nil
	})
	p.Platform = &Platform{Client: client, Namespace: "vennir-system", Timeout: 5 * time.Second}
	return p
}

func run(t *testing.T, p *platform, busy bool, last *time.Time, now bool) {
	t.Helper()
	activity := func(context.Context) (bool, *time.Time, error) { return busy, last, nil }
	if err := Run(context.Background(), settings, p.Platform, activity, now, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
}

func TestSleepsAnIdlePlatformDatabaseLast(t *testing.T) {
	p := newPlatform(map[string]int32{"api": 2, "console": 1, "trivy": 0, "postgres": 1}, nil)
	run(t, p, false, at(-3*twoHours), false)
	// An idled scanner isn't woken later.
	if p.patched[AwakeReplicasKey] != `{"api":2,"console":1,"postgres":1}` {
		t.Errorf("recorded %v", p.patched)
	}
	if !reflect.DeepEqual(p.scaled, []string{"api", "console", "postgres"}) {
		t.Errorf("scaled %v", p.scaled)
	}
	// No Pod every few minutes while asleep.
	if !reflect.DeepEqual(p.suspend, []string{"kernel-sleeper"}) {
		t.Errorf("suspended %v", p.suspend)
	}
}

func TestStaysUpWhileTheConsoleIsUsed(t *testing.T) {
	p := newPlatform(map[string]int32{"api": 1, "postgres": 1}, at(-5*time.Minute))
	run(t, p, false, nil, false)
	if p.scaled != nil {
		t.Errorf("scaled %v", p.scaled)
	}
}

func TestStaysUpWhileAnExecutionIsUnfinished(t *testing.T) {
	p := newPlatform(map[string]int32{"api": 1, "postgres": 1}, nil)
	run(t, p, true, at(-3*twoHours), false)
	if p.scaled != nil || p.suspend != nil {
		t.Errorf("scaled %v, suspended %v", p.scaled, p.suspend)
	}
}

// kernel-api starting (woken, upgraded) counts as activity.
func TestARecentKernelAPIStartKeepsItUp(t *testing.T) {
	p := newPlatform(map[string]int32{"api": 1, "postgres": 1}, nil)
	pod, _ := p.client.CoreV1().Pods("vennir-system").Get(context.Background(), "api-1", metav1.GetOptions{})
	pod.Status.StartTime = &metav1.Time{Time: time.Now().Add(-time.Minute)}
	_, _ = p.client.CoreV1().Pods("vennir-system").UpdateStatus(context.Background(), pod, metav1.UpdateOptions{})
	run(t, p, false, at(-3*twoHours), false)
	if p.scaled != nil {
		t.Errorf("scaled %v", p.scaled)
	}
}

func TestDoesNothingWhenAlreadyAsleep(t *testing.T) {
	p := newPlatform(map[string]int32{"api": 0, "postgres": 0}, nil)
	run(t, p, false, nil, false)
	if p.scaled != nil || !reflect.DeepEqual(p.suspend, []string{"kernel-sleeper"}) {
		t.Errorf("scaled %v, suspended %v", p.scaled, p.suspend)
	}
}

func TestAScheduledSleepIgnoresRecentActivity(t *testing.T) {
	now := time.Now()
	p := newPlatform(map[string]int32{"api": 1, "postgres": 1}, &now)
	run(t, p, false, &now, true)
	if p.scaled == nil {
		t.Error("didn't sleep")
	}
}

func TestAScheduledSleepWaitsForUnfinishedExecutions(t *testing.T) {
	defer func(d time.Duration) { scheduledPoll = d }(scheduledPoll)
	scheduledPoll = 10 * time.Millisecond
	p := newPlatform(map[string]int32{"api": 1, "postgres": 1}, nil)
	looks := 0
	activity := func(context.Context) (bool, *time.Time, error) { looks++; return looks < 3, nil, nil }
	if err := Run(context.Background(), settings, p.Platform, activity, true, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	if looks != 3 || p.scaled == nil {
		t.Errorf("looked %d times, scaled %v", looks, p.scaled)
	}
}

func newNotFound(gvr schema.GroupVersionResource, name string) error {
	return apierrors.NewNotFound(gvr.GroupResource(), name)
}

// withNextSchedule has the console's activity ConfigMap say its next
// schedule runs at next, and records what the wake CronJob is patched with.
func withNextSchedule(t *testing.T, p *platform, next time.Time) map[string]string {
	t.Helper()
	cm, err := p.client.CoreV1().ConfigMaps("vennir-system").Get(context.Background(), "console-activity", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	cm.Data[NextScheduleKey] = next.UTC().Format(time.RFC3339)
	if _, err := p.client.CoreV1().ConfigMaps("vennir-system").Update(context.Background(), cm, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	patches := map[string]string{}
	p.client.PrependReactor("patch", "cronjobs", func(a k8stesting.Action) (bool, runtime.Object, error) {
		patches[a.(k8stesting.PatchAction).GetName()] = string(a.(k8stesting.PatchAction).GetPatch())
		return false, nil, nil
	})
	return patches
}

func waking() config.Settings {
	s := settings
	s.SleeperWakeCronJob = "kernel-wake"
	s.SleeperWakeLead = 5 * time.Minute
	return s
}

func TestASleepArmsTheWakeForTheNextSchedule(t *testing.T) {
	p := newPlatform(map[string]int32{"api": 1, "postgres": 1}, at(-3*twoHours))
	next := time.Now().Add(5 * time.Hour).Truncate(time.Minute)
	patches := withNextSchedule(t, p, next)
	activity := func(context.Context) (bool, *time.Time, error) { return false, at(-3 * twoHours), nil }
	if err := Run(context.Background(), waking(), p.Platform, activity, false, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(p.scaled, []string{"api", "postgres"}) {
		t.Fatalf("scaled %v", p.scaled)
	}
	wake := next.Add(-5 * time.Minute).UTC()
	want := fmt.Sprintf(`{"spec":{"schedule":"%d %d %d %d *","suspend":false,"timeZone":"Etc/UTC"}}`, wake.Minute(), wake.Hour(), wake.Day(), int(wake.Month()))
	if patches["kernel-wake"] != want {
		t.Errorf("wake patched with %s, want %s", patches["kernel-wake"], want)
	}
}

func TestAScheduleSoonKeepsItAwake(t *testing.T) {
	p := newPlatform(map[string]int32{"api": 1, "postgres": 1}, at(-3*twoHours))
	withNextSchedule(t, p, time.Now().Add(30*time.Minute))
	activity := func(context.Context) (bool, *time.Time, error) { return false, at(-3 * twoHours), nil }
	if err := Run(context.Background(), waking(), p.Platform, activity, false, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	if p.scaled != nil {
		t.Errorf("slept with a schedule due in 30 minutes: %v", p.scaled)
	}
}

func TestWakeRestoresWhatWasAsleepDatabasesFirst(t *testing.T) {
	p := newPlatform(map[string]int32{"api": 0, "console": 0, "postgres": 0}, nil)
	cm, _ := p.client.CoreV1().ConfigMaps("vennir-system").Get(context.Background(), "kernel-sleep", metav1.GetOptions{})
	cm.Data = map[string]string{AwakeReplicasKey: `{"api":2,"console":1,"postgres":1}`}
	if _, err := p.client.CoreV1().ConfigMaps("vennir-system").Update(context.Background(), cm, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	var woke []string
	p.client.PrependReactor("update", "deployments", func(a k8stesting.Action) (bool, runtime.Object, error) {
		scale := a.(k8stesting.UpdateAction).GetObject().(*autoscalingv1.Scale)
		woke = append(woke, fmt.Sprintf("%s=%d", scale.Name, scale.Spec.Replicas))
		return true, scale, nil
	})
	patches := map[string]string{}
	p.client.PrependReactor("patch", "cronjobs", func(a k8stesting.Action) (bool, runtime.Object, error) {
		patches[a.(k8stesting.PatchAction).GetName()] = string(a.(k8stesting.PatchAction).GetPatch())
		return true, nil, nil
	})
	if err := Wake(context.Background(), waking(), p.Platform, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(woke, []string{"postgres=1", "api=2", "console=1"}) {
		t.Errorf("woke %v", woke)
	}
	if patches["kernel-sleeper"] != `{"spec":{"suspend":false}}` || patches["kernel-wake"] != `{"spec":{"suspend":true}}` {
		t.Errorf("cron jobs patched with %v", patches)
	}
}
