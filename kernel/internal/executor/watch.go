// SPDX-License-Identifier: MIT

package executor

import (
	"context"
	"reflect"
	"sync"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/tools/cache"
)

// jobWatch follows the kernel's Jobs and their Pods in every namespace
// (shared informers), so the scheduler learns at once when a step changes
// (wait) and needn't re-read steps that haven't (takeChanged). While either
// watch is failing, healthy is false and every status is read from the API.
// The informers relist every resync period, which marks every Job changed:
// a periodic resync in case an event was missed.
type jobWatch struct {
	mu      sync.Mutex
	changed map[string]bool
	up      map[string]bool
	wake    chan struct{}
	// The watched Pods, for Unschedulable.
	pods cache.Store
}

func newJobWatch() *jobWatch {
	return &jobWatch{changed: map[string]bool{}, up: map[string]bool{"jobs": false, "pods": false}, wake: make(chan struct{}, 1)}
}

func (w *jobWatch) healthy() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.up["jobs"] && w.up["pods"]
}

func (w *jobWatch) setUp(kind string, up bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.up[kind] = up
}

// takeChanged says whether the Job changed since it was last asked about,
// forgetting it.
func (w *jobWatch) takeChanged(job string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.changed[job] {
		delete(w.changed, job)
		return true
	}
	return false
}

func (w *jobWatch) markChanged(kind, job string) {
	if job == "" {
		return
	}
	w.mu.Lock()
	w.changed[job] = true
	w.up[kind] = true // an event arriving means this watch works (again)
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *jobWatch) wait(ctx context.Context, timeout time.Duration) {
	select {
	case <-ctx.Done():
	case <-w.wake:
	case <-time.After(timeout):
	}
}

func jobNameOf(obj any) (kind, name string) {
	if tombstone, ok := obj.(cache.DeletedFinalStateUnknown); ok {
		obj = tombstone.Obj
	}
	switch o := obj.(type) {
	case *batchv1.Job:
		return "jobs", o.Name
	case *corev1.Pod:
		if name := o.Labels["batch.kubernetes.io/job-name"]; name != "" {
			return "pods", name
		}
		return "pods", o.Labels["job-name"]
	}
	return "", ""
}

// Watch follows the kernel's Jobs and Pods until ctx ends.
func (k *Kubernetes) Watch(ctx context.Context) {
	w := newJobWatch()
	factory := informers.NewSharedInformerFactoryWithOptions(k.client, k.opts.WatchResync*10,
		informers.WithTweakListOptions(func(o *metav1.ListOptions) { o.LabelSelector = kernelLabel }))
	notify := func(obj any) {
		kind, name := jobNameOf(obj)
		w.markChanged(kind, name)
	}
	handler := cache.ResourceEventHandlerFuncs{
		AddFunc:    notify,
		UpdateFunc: func(_, obj any) { notify(obj) },
		DeleteFunc: notify,
	}
	pods := factory.Core().V1().Pods().Informer()
	w.pods = pods.GetStore()
	for kind, informer := range map[string]cache.SharedIndexInformer{
		"jobs": factory.Batch().V1().Jobs().Informer(),
		"pods": pods,
	} {
		_ = informer.SetWatchErrorHandlerWithContext(func(_ context.Context, _ *cache.Reflector, err error) {
			k.log.Warn("watch failed; reading every status from the API until it's back", "kind", kind, "error", err.Error())
			w.setUp(kind, false)
		})
		if _, err := informer.AddEventHandler(handler); err != nil {
			k.log.Error("couldn't watch", "kind", kind, "error", err.Error())
		}
	}
	factory.Start(ctx.Done())
	go func() {
		for kind, synced := range factory.WaitForCacheSync(ctx.Done()) {
			name := "jobs"
			if kind == reflect.TypeFor[*corev1.Pod]() {
				name = "pods"
			}
			w.setUp(name, synced)
		}
	}()
	k.watch = w
}

// Unschedulable is how many step Pods no node has room for now, from the
// watch (0 without one).
func (k *Kubernetes) Unschedulable() int {
	if k.watch == nil || k.watch.pods == nil {
		return 0
	}
	var pods []*corev1.Pod
	for _, obj := range k.watch.pods.List() {
		if pod, ok := obj.(*corev1.Pod); ok {
			pods = append(pods, pod)
		}
	}
	return CountUnschedulable(pods)
}

// CountUnschedulable is how many of these Pods the scheduler found no node
// with room for (the cluster full, or unable to grow).
func CountUnschedulable(pods []*corev1.Pod) int {
	n := 0
	for _, pod := range pods {
		if pod.Status.Phase != corev1.PodPending {
			continue
		}
		for _, c := range pod.Status.Conditions {
			if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse && c.Reason == corev1.PodReasonUnschedulable {
				n++
			}
		}
	}
	return n
}

func typesUID(uid string) types.UID { return types.UID(uid) }
