// SPDX-License-Identifier: MIT
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
)

// stats summarizes durations in milliseconds.
type stats struct {
	N    int     `json:"n"`
	P50  float64 `json:"p50Ms"`
	P95  float64 `json:"p95Ms"`
	P99  float64 `json:"p99Ms"`
	Max  float64 `json:"maxMs"`
	Mean float64 `json:"meanMs"`
}

func summarize(values []time.Duration) stats {
	if len(values) == 0 {
		return stats{}
	}
	ms := make([]float64, len(values))
	sum := 0.0
	for i, v := range values {
		ms[i] = float64(v) / float64(time.Millisecond)
		sum += ms[i]
	}
	slices.Sort(ms)
	at := func(p float64) float64 { return ms[int(math.Ceil(p*float64(len(ms))))-1] }
	return stats{N: len(ms), P50: at(0.50), P95: at(0.95), P99: at(0.99), Max: ms[len(ms)-1], Mean: sum / float64(len(ms))}
}

type report struct {
	RunID       string   `json:"runId"`
	Environment env      `json:"environment"`
	Workload    workload `json:"workload"`
	WallSeconds float64  `json:"wallSeconds"`

	Submitted    int     `json:"submitted"`
	SubmitErrors int     `json:"submitErrors"`
	SubmitPerSec float64 `json:"submitPerSecond"`
	Submit       stats   `json:"submitLatency"`

	// From the console's created time to its last step's completion.
	EndToEnd    stats   `json:"endToEnd"`
	TasksDone   int     `json:"tasksDone"`
	TasksPerSec float64 `json:"tasksPerSecond"`
	DAGsPerSec  float64 `json:"dagsPerSecond"`
	// A step's first attempt: ready (its run made, or its last dependency
	// done) to the kernel starting it.
	QueueWait stats `json:"queueWait"`
	// The kernel starting an attempt to its container's own clock starting:
	// the Job, the Pod's scheduling, the image and the container.
	ContainerStart stats `json:"containerStart"`
	// The container finishing to the kernel recording the step done.
	CompletionLag stats `json:"completionLag"`

	NodePeakCPU  float64 `json:"nodePeakCpuPercent"`
	NodeMeanCPU  float64 `json:"nodeMeanCpuPercent"`
	NodePeakMemG float64 `json:"nodePeakMemGiB"`

	// With -cancel-after: runs that ended cancelled, and those that finished
	// before the cancel reached them.
	Cancelled     int `json:"cancelled"`
	FinishedFirst int `json:"finishedFirst"`

	// With readers: how long the Runs page's list and a run's page took
	// while the run went on, and how many reads failed.
	Readers    int   `json:"readers"`
	ListRuns   stats `json:"listRuns"`
	GetRun     stats `json:"getRun"`
	ReadErrors int   `json:"readErrors"`

	Problems []string `json:"problems"`
}

func analyze(w workload, runID string, runs []*submitted, started, finished time.Time, samples []sample) report {
	r := report{RunID: runID, Workload: w, WallSeconds: finished.Sub(started).Seconds(), Problems: []string{}}
	var submit, e2e, queue, start, lag []time.Duration
	var first, last time.Time
	wantState := "EXECUTION_STATE_SUCCEEDED"
	if w.Fail == "always" {
		wantState = "EXECUTION_STATE_FAILED"
	}
	// Cancelled as its steps finish, a run may end either way, but never
	// anything else, and never with a step still going.
	cancelling := w.CancelAfterMs > 0
	problem := func(format string, a ...any) {
		if len(r.Problems) < 50 {
			r.Problems = append(r.Problems, fmt.Sprintf(format, a...))
		}
	}
	for i, s := range runs {
		if s == nil {
			problem("DAG %d: never submitted", i)
			continue
		}
		r.Submitted++
		submit = append(submit, s.Latency)
		if s.Error != "" {
			r.SubmitErrors++
			problem("DAG %d: submit refused: %s", i, s.Error)
			continue
		}
		e := s.Final
		if e == nil {
			problem("DAG %d (%s): never finished", i, s.ExecutionID)
			continue
		}
		switch {
		case cancelling && e.State == "EXECUTION_STATE_CANCELLED":
			r.Cancelled++
			for _, t := range e.Tasks {
				switch t.State {
				case "TASK_STATE_SUCCEEDED", "TASK_STATE_FAILED", "TASK_STATE_CANCELLED":
				default:
					problem("DAG %d (%s) cancelled with step %s %s", i, s.ExecutionID, t.TaskID, t.State)
				}
			}
		case cancelling && e.State == wantState:
			r.FinishedFirst++
		case e.State != wantState:
			problem("DAG %d (%s): %s, expected %s", i, s.ExecutionID, e.State, wantState)
		}
		if s.CancelError != "" {
			problem("DAG %d (%s): cancel refused: %s", i, s.ExecutionID, s.CancelError)
		}
		if first.IsZero() || e.CreatedAt.Before(first) {
			first = e.CreatedAt
		}
		done := map[string]taskStatus{}
		for _, t := range e.Tasks {
			done[t.TaskID] = t
		}
		var end time.Time
		for _, t := range e.Tasks {
			if t.State != "TASK_STATE_SUCCEEDED" {
				continue
			}
			r.TasksDone++
			if t.CompletedAt != nil && t.CompletedAt.After(end) {
				end = *t.CompletedAt
			}
			wantAttempts := 1
			if w.Fail == "first-attempt" {
				wantAttempts = 2
			}
			if t.AttemptCount != wantAttempts {
				problem("DAG %d step %s: %d attempt(s), expected %d", i, t.TaskID, t.AttemptCount, wantAttempts)
			}
			if label, _ := t.Outputs["label"].(string); label != fmt.Sprintf("%s/%d/%s", r.RunID, i, strings.TrimPrefix(t.TaskID, "s")) {
				problem("DAG %d step %s: ran with another step's inputs (label %q)", i, t.TaskID, label)
			}
			began, ended := millis(t.Outputs["startedAtMs"]), millis(t.Outputs["finishedAtMs"])
			// Ready: its run made, or its last dependency done.
			ready := e.CreatedAt
			for _, d := range t.DependsOn {
				dep := done[d]
				if dep.CompletedAt != nil && dep.CompletedAt.After(ready) {
					ready = *dep.CompletedAt
				}
				if depEnd := millis(dep.Outputs["finishedAtMs"]); !began.IsZero() && !depEnd.IsZero() && began.Before(depEnd) {
					problem("DAG %d step %s started before %s finished", i, t.TaskID, d)
				}
			}
			if len(t.Attempts) > 0 && t.Attempts[0].StartedAt != nil {
				queue = append(queue, t.Attempts[0].StartedAt.Sub(ready))
			}
			if n := len(t.Attempts); n > 0 && t.Attempts[n-1].StartedAt != nil && !began.IsZero() {
				start = append(start, began.Sub(*t.Attempts[n-1].StartedAt))
			}
			if t.CompletedAt != nil && !ended.IsZero() {
				lag = append(lag, t.CompletedAt.Sub(ended))
			}
		}
		if !end.IsZero() {
			e2e = append(e2e, end.Sub(e.CreatedAt))
			if end.After(last) {
				last = end
			}
		}
	}
	r.Submit, r.EndToEnd, r.QueueWait, r.ContainerStart, r.CompletionLag = summarize(submit), summarize(e2e), summarize(queue), summarize(start), summarize(lag)
	lastSubmit := started
	for _, s := range runs {
		if s != nil && s.SubmittedAt.Add(s.Latency).After(lastSubmit) {
			lastSubmit = s.SubmittedAt.Add(s.Latency)
		}
	}
	if span := lastSubmit.Sub(started).Seconds(); span > 0 {
		r.SubmitPerSec = float64(r.Submitted) / span
	}
	if span := last.Sub(first).Seconds(); span > 0 {
		r.TasksPerSec = float64(r.TasksDone) / span
		r.DAGsPerSec = float64(len(e2e)) / span
	}
	for _, s := range samples {
		r.NodePeakCPU = max(r.NodePeakCPU, s.CPU)
		r.NodeMeanCPU += s.CPU / float64(len(samples))
		r.NodePeakMemG = max(r.NodePeakMemG, s.MemBytes/(1<<30))
	}
	return r
}

func millis(v any) time.Time {
	if n, ok := v.(float64); ok && n > 0 {
		return time.UnixMilli(int64(n))
	}
	return time.Time{}
}

func percent(s string) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(s), "%"), 64)
	return f
}

// bytesOf reads docker stats' sizes: 1.2GiB, 512MiB, 900kB.
func bytesOf(s string) float64 {
	for _, u := range []struct {
		suffix string
		scale  float64
	}{{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3}, {"B", 1}} {
		if strings.HasSuffix(s, u.suffix) {
			f, _ := strconv.ParseFloat(strings.TrimSuffix(s, u.suffix), 64)
			return f * u.scale
		}
	}
	return 0
}

// env is what a result was measured on, so results compare like with like.
type env struct {
	GitCommit  string            `json:"gitCommit"`
	GitDirty   bool              `json:"gitDirty"`
	Host       string            `json:"host"`
	HostCPUs   int               `json:"hostCpus"`
	DockerCPUs string            `json:"dockerCpus"`
	DockerMem  string            `json:"dockerMemBytes"`
	Kubernetes string            `json:"kubernetes"`
	Nodes      int               `json:"nodes"`
	GoVersion  string            `json:"driverGoVersion"`
	Kernel     map[string]string `json:"kernelSettings"`
	Replicas   map[string]string `json:"replicas"`
}

func output(name string, args ...string) string {
	out, _ := exec.Command(name, args...).Output()
	return strings.TrimSpace(string(out))
}

// environment describes the cluster behind context, and this machine's
// Docker when the cluster is kind's.
func environment(context string, kind bool) env {
	e := env{
		GitCommit: output("git", "rev-parse", "HEAD"),
		GitDirty:  output("git", "status", "--porcelain") != "",
		Host:      output("sysctl", "-n", "machdep.cpu.brand_string") + ", " + output("sysctl", "-n", "hw.memsize") + " bytes",
		HostCPUs:  runtime.NumCPU(),
		GoVersion: runtime.Version(),
		Kernel:    map[string]string{},
		Replicas:  map[string]string{},
	}
	if kind {
		e.DockerCPUs = output("docker", "info", "--format", "{{.NCPU}}")
		e.DockerMem = output("docker", "info", "--format", "{{.MemTotal}}")
	}
	var version struct {
		Server struct{ GitVersion string } `json:"serverVersion"`
	}
	if json.Unmarshal([]byte(output("kubectl", "--context", context, "version", "-o", "json")), &version) == nil {
		e.Kubernetes = version.Server.GitVersion
	}
	e.Nodes = len(strings.Fields(output("kubectl", "--context", context, "get", "nodes", "-o", "name")))
	var cm struct{ Data map[string]string }
	if json.Unmarshal([]byte(output("kubectl", "--context", context, "-n", "vennir-system", "get", "configmap", "kernel-execution-kernel-config", "-o", "json")), &cm) == nil {
		for k, v := range cm.Data {
			if strings.HasPrefix(k, "SCHEDULER_") || strings.Contains(k, "POOL") || strings.Contains(k, "POLL") {
				e.Kernel[k] = v
			}
		}
	}
	for _, d := range []string{"kernel-execution-kernel-scheduler", "kernel-execution-kernel-api", "console-execution-console"} {
		e.Replicas[d] = output("kubectl", "--context", context, "-n", "vennir-system", "get", "deployment", d, "-o", "jsonpath={.spec.replicas}")
	}
	return e
}

func markdown(r report) string {
	var b strings.Builder
	w := r.Workload
	fmt.Fprintf(&b, "# perf %s: %s\n\n", r.RunID, w.Scenario)
	fmt.Fprintf(&b, "%d %s DAGs of %d step(s), %d ms each, fail=%s; %d submitter(s)", w.DAGs, w.Shape, w.Steps, w.SleepMs, w.Fail, w.Concurrency)
	if w.Rate > 0 {
		fmt.Fprintf(&b, " at %.1f/s", w.Rate)
	}
	fmt.Fprintf(&b, ". Commit %.12s%s, Kubernetes %s, %d node(s), Docker %s CPUs / %s bytes, kernel %v, replicas %v.\n\n",
		r.Environment.GitCommit, map[bool]string{true: " (with local changes)"}[r.Environment.GitDirty], r.Environment.Kubernetes, r.Environment.Nodes,
		r.Environment.DockerCPUs, r.Environment.DockerMem, r.Environment.Kernel, r.Environment.Replicas)
	fmt.Fprintf(&b, "Wall %.1f s. %d steps done: %.2f steps/s, %.2f DAGs/s. Submitted %d (%d refused) at %.1f/s.\n\n",
		r.WallSeconds, r.TasksDone, r.TasksPerSec, r.DAGsPerSec, r.Submitted, r.SubmitErrors, r.SubmitPerSec)
	b.WriteString("| ms | n | p50 | p95 | p99 | max | mean |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n")
	for _, row := range []struct {
		name string
		s    stats
	}{{"Submit (API)", r.Submit}, {"End to end (DAG)", r.EndToEnd}, {"Queue wait (ready to started)", r.QueueWait}, {"Container start (started to running)", r.ContainerStart}, {"Completion lag (exited to recorded)", r.CompletionLag}, {"List runs (API, readers)", r.ListRuns}, {"Get a run (API, readers)", r.GetRun}} {
		if row.s.N == 0 && r.Readers == 0 && strings.HasSuffix(row.name, "readers)") {
			continue
		}
		fmt.Fprintf(&b, "| %s | %d | %.0f | %.0f | %.0f | %.0f | %.0f |\n", row.name, row.s.N, row.s.P50, row.s.P95, row.s.P99, row.s.Max, row.s.Mean)
	}
	if w.CancelAfterMs > 0 {
		fmt.Fprintf(&b, "\nEach run cancelled %d ms after submitting it: %d ended cancelled, %d finished first.\n", w.CancelAfterMs, r.Cancelled, r.FinishedFirst)
	}
	if r.Readers > 0 {
		fmt.Fprintf(&b, "\n%d reader(s); %d read(s) failed.\n", r.Readers, r.ReadErrors)
	}
	if r.Environment.DockerCPUs != "" {
		fmt.Fprintf(&b, "\nNode: CPU peak %.0f%%, mean %.0f%% (of %s CPUs); memory peak %.2f GiB.\n", r.NodePeakCPU, r.NodeMeanCPU, r.Environment.DockerCPUs, r.NodePeakMemG)
	}
	b.WriteString("\n")
	if len(r.Problems) == 0 {
		b.WriteString("Correctness: every DAG ended as expected, every step ran its own inputs, the expected attempts, after what it depends on.\n")
	} else {
		fmt.Fprintf(&b, "Correctness: %d problem(s):\n\n", len(r.Problems))
		for _, p := range r.Problems {
			fmt.Fprintf(&b, "- %s\n", p)
		}
	}
	return b.String()
}
