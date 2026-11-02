// SPDX-License-Identifier: MIT

// Package metrics is the kernel's Prometheus metrics, the same names the
// Python kernel exposed, so dashboards and alerts keep working. Each
// process serves its own: kernel-api's events and requests, the
// scheduler's events and passes.
package metrics

import (
	"net/http"
	"sync/atomic"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// Events counts lifecycle events by type, once their transaction commits.
	Events = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "kernel_events_total",
		Help: "Execution-kernel lifecycle events, by type.",
	}, []string{"event_type"})

	TickDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name: "kernel_scheduler_tick_duration_seconds",
		Help: "Duration of one scheduler tick (claim + dispatch + poll).",
	})

	StatusReadErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "kernel_scheduler_status_read_errors_total",
		Help: "Reads of a running task's status that failed; the task stays running and is read again.",
	})

	TickErrors = promauto.NewCounter(prometheus.CounterOpts{
		Name: "kernel_scheduler_tick_errors_total",
		Help: "Scheduler ticks that raised and were skipped rather than crashing the process.",
	})

	// Tasks and OldestReady are sampled from the database by every
	// scheduler replica (take the max across them).
	Tasks = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "kernel_tasks",
		Help: "Unfinished tasks, by state (BLOCKED, READY, AWAITING_APPROVAL, CLAIMED, RUNNING).",
	}, []string{"state"})

	OldestReady = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "kernel_oldest_ready_task_age_seconds",
		Help: "How long the longest-waiting READY task has been ready; 0 when none is.",
	})

	// Unschedulable is read from the scheduler's watch of its steps' Pods
	// (SetUnschedulable); 0 in kernel-api, and before the watch runs. A
	// count, not an age: the scheduler replaces a step's Pod that hasn't
	// started (its start timeout), so no one Pod waits long.
	Unschedulable = promauto.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "kernel_unschedulable_steps",
		Help: "Dispatched steps whose Pod no node has room for now.",
	}, func() float64 {
		if f := unschedulable.Load(); f != nil {
			return (*f)()
		}
		return 0
	})

	HTTPRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "kernel_http_requests_total",
		Help: "HTTP requests handled by kernel-api.",
	}, []string{"method", "path", "status"})

	HTTPDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "kernel_http_request_duration_seconds",
		Help: "HTTP request duration in seconds.",
	}, []string{"method", "path"})
)

var unschedulable atomic.Pointer[func() float64]

// SetUnschedulable sets what OldestUnschedulable reads at each scrape.
func SetUnschedulable(f func() float64) { unschedulable.Store(&f) }

// Handler serves /metrics.
func Handler() http.Handler { return promhttp.Handler() }
