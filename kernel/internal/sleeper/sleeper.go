// SPDX-License-Identifier: MIT

// Package sleeper puts an idle platform to sleep: scales its Deployments to
// zero, so a quiet install costs only its databases' volumes. Waking is
// explicit (`vennir wake`): a sleeping console can't wake itself. The
// chart runs `kernel sleep` as a CronJob: one look, then exit; `kernel
// sleep --now` is a scheduled sleep, which waits for unfinished executions
// first. A failure exits non-zero; the next run starts afresh.
package sleeper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"

	"github.com/rburns629/vennir/kernel/internal/config"
)

// AwakeReplicasKey is the state ConfigMap's key holding {deployment:
// replicas} while asleep; vennir wake reads the same key.
const AwakeReplicasKey = "awakeReplicas"

// LastActivity is the latest of the moments known (nil when none is).
func LastActivity(moments ...*time.Time) *time.Time {
	var last *time.Time
	for _, m := range moments {
		if m != nil && (last == nil || m.After(*last)) {
			last = m
		}
	}
	return last
}

// ShouldSleep: only with nothing unfinished and nothing for idleAfter. With
// no activity known at all there's nothing to measure from: stay awake
// rather than guess.
func ShouldSleep(now time.Time, busy bool, last *time.Time, idleAfter time.Duration) bool {
	if busy || last == nil {
		return false
	}
	return now.Sub(*last) >= idleAfter
}

// DB is what reading the kernel's activity needs.
type DB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// KernelActivity is what the kernel's own data says: whether an execution
// is unfinished (steps running, or waiting to), and the last event.
func KernelActivity(ctx context.Context, db DB) (busy bool, last *time.Time, err error) {
	err = db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM executions WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')),
		(SELECT max(created_at) FROM execution_events)`).Scan(&busy, &last)
	return busy, last, err
}

// Platform is the platform's Deployments as the sleeper sees and changes
// them: only through the scale subresource (which can change nothing but
// a count), and one ConfigMap of its own. The chart's Role grants nothing
// else, so a stolen sleeper token can't change what any Deployment runs.
type Platform struct {
	Client    kubernetes.Interface
	Namespace string
	Timeout   time.Duration
}

func (p *Platform) call(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, p.Timeout)
}

// Replicas is each existing Deployment's replicas (a missing one is left out).
func (p *Platform) Replicas(ctx context.Context, names []string) (map[string]int32, error) {
	found := map[string]int32{}
	for _, name := range names {
		callCtx, cancel := p.call(ctx)
		scale, err := p.Client.AppsV1().Deployments(p.Namespace).GetScale(callCtx, name, metav1.GetOptions{})
		cancel()
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		found[name] = scale.Spec.Replicas
	}
	return found, nil
}

// NewestPodStart is when the newest Pod matching selector started.
func (p *Platform) NewestPodStart(ctx context.Context, selector string) (*time.Time, error) {
	if selector == "" {
		return nil, nil
	}
	callCtx, cancel := p.call(ctx)
	defer cancel()
	pods, err := p.Client.CoreV1().Pods(p.Namespace).List(callCtx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return nil, err
	}
	var newest *time.Time
	for _, pod := range pods.Items {
		if pod.Status.StartTime != nil {
			newest = LastActivity(newest, &pod.Status.StartTime.Time)
		}
	}
	return newest, nil
}

// NextScheduleKey is the console's activity ConfigMap's key for its
// earliest enabled schedule's next run (RFC 3339), which the console keeps
// current (console/src/scheduleRunner.ts).
const NextScheduleKey = "nextScheduleAt"

// NextSchedule is when the console's next schedule runs, from its activity
// ConfigMap; nil when none is set.
func (p *Platform) NextSchedule(ctx context.Context, configMap string) (*time.Time, error) {
	return p.activityTime(ctx, configMap, NextScheduleKey)
}

// ConsoleActivity is the console's last use, from its activity ConfigMap.
func (p *Platform) ConsoleActivity(ctx context.Context, configMap string) (*time.Time, error) {
	return p.activityTime(ctx, configMap, "lastActivityAt")
}

func (p *Platform) activityTime(ctx context.Context, configMap, key string) (*time.Time, error) {
	if configMap == "" {
		return nil, nil
	}
	callCtx, cancel := p.call(ctx)
	defer cancel()
	cm, err := p.Client.CoreV1().ConfigMaps(p.Namespace).Get(callCtx, configMap, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	value := cm.Data[key]
	if value == "" {
		return nil, nil
	}
	at, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil, err
	}
	return &at, nil
}

func (p *Platform) patch(ctx context.Context, do func(context.Context) error) error {
	callCtx, cancel := p.call(ctx)
	defer cancel()
	return do(callCtx)
}

// Sleep records awake (what to wake to), then scales each Deployment in
// order to zero. Recorded first, so a sleep cut short still wakes.
func (p *Platform) Sleep(ctx context.Context, awake map[string]int32, order []string, stateConfigMap string) error {
	counts, err := json.Marshal(awake) // keys sorted
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]any{"data": map[string]string{AwakeReplicasKey: string(counts)}})
	if err := p.patch(ctx, func(c context.Context) error {
		_, err := p.Client.CoreV1().ConfigMaps(p.Namespace).Patch(c, stateConfigMap, types.MergePatchType, body, metav1.PatchOptions{})
		return err
	}); err != nil {
		return err
	}
	for _, name := range order {
		if err := p.patch(ctx, func(c context.Context) error {
			deployments := p.Client.AppsV1().Deployments(p.Namespace)
			scale, err := deployments.GetScale(c, name, metav1.GetOptions{})
			if err != nil {
				return err
			}
			scale.Spec.Replicas = 0
			_, err = deployments.UpdateScale(c, name, scale, metav1.UpdateOptions{})
			return err
		}); err != nil {
			return err
		}
	}
	return nil
}

// Suspend suspends the sleeper's own CronJob (waking resumes it).
func (p *Platform) Suspend(ctx context.Context, cronJob string) error {
	if cronJob == "" {
		return nil
	}
	return p.patch(ctx, func(c context.Context) error {
		_, err := p.Client.BatchV1().CronJobs(p.Namespace).Patch(c, cronJob, types.MergePatchType, []byte(`{"spec":{"suspend":true}}`), metav1.PatchOptions{})
		return err
	})
}

// ArmWake sets the wake CronJob to fire once, at `at` (to the minute, in
// UTC), and un-suspends it; nil suspends it instead.
func (p *Platform) ArmWake(ctx context.Context, cronJob string, at *time.Time) error {
	if cronJob == "" {
		return nil
	}
	body := []byte(`{"spec":{"suspend":true}}`)
	if at != nil {
		t := at.UTC()
		// Minute, hour, day and month: once (next year's same minute is long
		// after the next sleep re-arms it).
		schedule := fmt.Sprintf("%d %d %d %d *", t.Minute(), t.Hour(), t.Day(), int(t.Month()))
		body, _ = json.Marshal(map[string]any{"spec": map[string]any{"suspend": false, "schedule": schedule, "timeZone": "Etc/UTC"}})
	}
	return p.patch(ctx, func(c context.Context) error {
		_, err := p.Client.BatchV1().CronJobs(p.Namespace).Patch(c, cronJob, types.MergePatchType, body, metav1.PatchOptions{})
		return err
	})
}

func (p *Platform) resume(ctx context.Context, cronJob string) error {
	if cronJob == "" {
		return nil
	}
	return p.patch(ctx, func(c context.Context) error {
		_, err := p.Client.BatchV1().CronJobs(p.Namespace).Patch(c, cronJob, types.MergePatchType, []byte(`{"spec":{"suspend":false}}`), metav1.PatchOptions{})
		return err
	})
}

// Wake scales each Deployment back to what it was before sleeping (the
// databases first), resumes the sleeper's CronJob, and stands the wake
// CronJob down: what `vennir wake` does, from inside the cluster, for a
// schedule. Nothing recorded: already awake.
func Wake(ctx context.Context, s config.Settings, p *Platform, log *slog.Logger) error {
	callCtx, cancel := p.call(ctx)
	cm, err := p.Client.CoreV1().ConfigMaps(p.Namespace).Get(callCtx, s.SleeperStateConfigMap, metav1.GetOptions{})
	cancel()
	if err != nil {
		return err
	}
	awake := map[string]int32{}
	if raw := cm.Data[AwakeReplicasKey]; raw != "" {
		if err := json.Unmarshal([]byte(raw), &awake); err != nil {
			return err
		}
	}
	for _, group := range [][]string{s.SleeperDatabases, s.SleeperDeployments} {
		for _, name := range group {
			replicas, ok := awake[name]
			if !ok {
				continue
			}
			if err := p.patch(ctx, func(c context.Context) error {
				deployments := p.Client.AppsV1().Deployments(p.Namespace)
				scale, err := deployments.GetScale(c, name, metav1.GetOptions{})
				if err != nil {
					return err
				}
				if scale.Spec.Replicas >= replicas {
					return nil
				}
				scale.Spec.Replicas = replicas
				_, err = deployments.UpdateScale(c, name, scale, metav1.UpdateOptions{})
				return err
			}); err != nil {
				return err
			}
		}
	}
	if err := p.resume(ctx, s.SleeperCronJob); err != nil {
		return err
	}
	if err := p.ArmWake(ctx, s.SleeperWakeCronJob, nil); err != nil {
		return err
	}
	log.Info("woken for a schedule", "deployments", awake)
	return nil
}

// scheduledPoll is how often a scheduled sleep looks again; shorter in tests.
var scheduledPoll = time.Minute

// Activity is the kernel's: KernelActivity on its database.
type Activity func(ctx context.Context) (busy bool, last *time.Time, err error)

// Run is one look: sleep the platform if it's idle (now: once nothing is
// unfinished, waiting up to SleeperScheduledWait).
func Run(ctx context.Context, s config.Settings, platform *Platform, activity Activity, now bool, log *slog.Logger) error {
	names := append(append([]string{}, s.SleeperDeployments...), s.SleeperDatabases...)
	current, err := platform.Replicas(ctx, names)
	if err != nil {
		return err
	}
	awake := map[string]int32{}
	for name, replicas := range current {
		if replicas > 0 {
			awake[name] = replicas
		}
	}
	if len(awake) == 0 {
		// Asleep some other way (vennir sleep, by hand): stop looking.
		if err := platform.Suspend(ctx, s.SleeperCronJob); err != nil {
			return err
		}
		log.Info("already asleep")
		return nil
	}
	deadline := time.Now().Add(s.SleeperScheduledWait)
	var busy bool
	var lastKernel *time.Time
	for {
		if busy, lastKernel, err = activity(ctx); err != nil {
			return err
		}
		if !now || !busy {
			break
		}
		if !time.Now().Before(deadline) {
			log.Info("scheduled sleep skipped: executions still unfinished")
			return nil
		}
		log.Info("scheduled sleep waiting for unfinished executions")
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(scheduledPoll):
		}
	}
	if !now {
		console, err := platform.ConsoleActivity(ctx, s.SleeperConsoleActivityConfigMap)
		if err != nil {
			return err
		}
		apiStarted, err := platform.NewestPodStart(ctx, s.SleeperAPIPodSelector)
		if err != nil {
			return err
		}
		last := LastActivity(lastKernel, console, apiStarted)
		if !ShouldSleep(time.Now(), busy, last, s.SleeperIdleAfter) {
			var at any
			if last != nil {
				at = last.UTC().Format(time.RFC3339)
			}
			log.Info("awake", "busy", busy, "last_activity", at)
			return nil
		}
	}
	// The databases last, so nothing is left running against a stopped one.
	var order []string
	for _, group := range [][]string{s.SleeperDeployments, s.SleeperDatabases} {
		for _, name := range group {
			if _, ok := awake[name]; ok {
				order = append(order, name)
			}
		}
	}
	if s.SleeperStateConfigMap == "" {
		return errors.New("SLEEPER_STATE_CONFIGMAP is required to sleep")
	}
	// A schedule that runs soon keeps it awake; a later one wakes it, a
	// little before.
	var wakeAt *time.Time
	if s.SleeperWakeCronJob != "" {
		next, err := platform.NextSchedule(ctx, s.SleeperConsoleActivityConfigMap)
		if err != nil {
			return err
		}
		if next != nil {
			at := next.Add(-s.SleeperWakeLead)
			if !at.After(time.Now().Add(time.Minute)) || (!now && next.Sub(time.Now()) < s.SleeperIdleAfter) {
				log.Info("awake: a schedule runs soon", "next_schedule", next.UTC().Format(time.RFC3339))
				return nil
			}
			wakeAt = &at
		}
	}
	if err := platform.Sleep(ctx, awake, order, s.SleeperStateConfigMap); err != nil {
		return err
	}
	if err := platform.Suspend(ctx, s.SleeperCronJob); err != nil {
		return err
	}
	if err := platform.ArmWake(ctx, s.SleeperWakeCronJob, wakeAt); err != nil {
		return err
	}
	var wakes any
	if wakeAt != nil {
		wakes = wakeAt.UTC().Format(time.RFC3339)
	}
	log.Info("asleep", "deployments", order, "scheduled", now, "wakes_at", wakes)
	return nil
}
