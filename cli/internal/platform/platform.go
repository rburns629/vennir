// SPDX-License-Identifier: MIT

// Package platform operates a running install: its status, and putting it
// to sleep and waking it.
package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os/exec"
	"sort"
	"strconv"
	"time"

	"github.com/rburns629/vennir/cli/internal/cluster"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/install"
	"github.com/rburns629/vennir/cli/internal/run"
	"github.com/rburns629/vennir/cli/internal/tools"
)

// The kernel chart's ConfigMap holding each Deployment's replicas while the
// platform sleeps, under awakeKey: the sleeper (kernel/internal/sleeper) and
// these commands both use it.
const (
	stateConfigMap = install.KernelRelease + "-execution-kernel-sleep"
	awakeKey       = "awakeReplicas"
)

// Deployment is one of the platform's Deployments.
type Deployment struct {
	Name     string
	Release  string
	Replicas int
	Ready    int
	Awake    int // the replicas to wake to
}

// Deployments lists the platform's Deployments (both releases').
func Deployments(ctx context.Context, r *run.Runner, c *config.Config) ([]Deployment, error) {
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"get", "deployments", "-l", "app.kubernetes.io/instance in ("+install.KernelRelease+","+install.ConsoleRelease+")",
		"-o", "json")
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name        string            `json:"name"`
				Labels      map[string]string `json:"labels"`
				Annotations map[string]string `json:"annotations"`
			} `json:"metadata"`
			Spec struct {
				Replicas *int `json:"replicas"`
			} `json:"spec"`
			Status struct {
				ReadyReplicas int `json:"readyReplicas"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		return nil, err
	}
	recorded := awakeReplicas(ctx, r, c)
	var deps []Deployment
	for _, it := range list.Items {
		d := Deployment{Name: it.Metadata.Name, Release: it.Metadata.Labels["app.kubernetes.io/instance"], Ready: it.Status.ReadyReplicas, Replicas: 1}
		if it.Spec.Replicas != nil {
			d.Replicas = *it.Spec.Replicas
		}
		d.Awake = d.Replicas
		if v := recorded[d.Name]; d.Replicas == 0 && v > 0 {
			d.Awake = v
		}
		if d.Awake < 1 {
			d.Awake = 1
		}
		deps = append(deps, d)
	}
	sort.Slice(deps, func(i, j int) bool { return deps[i].Name < deps[j].Name })
	return deps, nil
}

// Asleep: installed, and every Deployment scaled to zero.
func Asleep(deps []Deployment) bool {
	if len(deps) == 0 {
		return false
	}
	for _, d := range deps {
		if d.Replicas > 0 {
			return false
		}
	}
	return true
}

// RunningSteps counts step Jobs still running, in every namespace.
func RunningSteps(ctx context.Context, r *run.Runner, c *config.Config) (int, error) {
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "get", "jobs", "--all-namespaces",
		"-l", "app=execution-kernel", "-o", "jsonpath={range .items[*]}{.status.active}{\"\\n\"}{end}")
	if err != nil {
		return 0, err
	}
	n := 0
	for _, line := range splitLines(out) {
		if v, _ := strconv.Atoi(line); v > 0 {
			n++
		}
	}
	return n, nil
}

// Sleep scales every platform Deployment to zero, the databases last,
// after recording the replicas to wake to. The database keeps its volume.
func Sleep(ctx context.Context, r *run.Runner, c *config.Config, deps []Deployment) error {
	awake := map[string]int{}
	for _, d := range deps {
		if d.Replicas > 0 {
			awake[d.Name] = d.Replicas
		}
	}
	record, err := json.Marshal(awake)
	if err != nil {
		return err
	}
	patch, err := json.Marshal(map[string]any{"data": map[string]string{awakeKey: string(record)}})
	if err != nil {
		return err
	}
	if err := r.Run(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"patch", "configmap", stateConfigMap, "--type", "merge", "--patch", string(patch)); err != nil {
		return err
	}
	ordered := append([]Deployment(nil), deps...)
	sort.SliceStable(ordered, func(i, j int) bool { return !isDatabase(ordered[i]) && isDatabase(ordered[j]) })
	for _, d := range ordered {
		if d.Replicas == 0 {
			continue
		}
		if err := r.Run(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
			"scale", "deployment", d.Name, "--replicas=0"); err != nil {
			return err
		}
	}
	return nil
}

// sleeperCronJob is the kernel chart's sleeper (when scale-down is on).
const sleeperCronJob = install.KernelRelease + "-execution-kernel-sleeper"

// SuspendSleeper stops (or resumes) the sleeper's CronJob: asleep there's
// nothing for it to look at, and on EKS Auto Mode each run would start a
// node. A missing one (scale-down off) is fine.
func SuspendSleeper(ctx context.Context, r *run.Runner, c *config.Config, suspend bool) error {
	exists := r.Succeeds(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"get", "cronjob", sleeperCronJob)
	if !exists {
		return nil
	}
	return r.Run(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"patch", "cronjob", sleeperCronJob, "--type", "merge", "--patch", fmt.Sprintf(`{"spec":{"suspend":%t}}`, suspend))
}

// awakeReplicas reads the recorded replicas to wake to (empty if none).
func awakeReplicas(ctx context.Context, r *run.Runner, c *config.Config) map[string]int {
	out, err := r.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"get", "configmap", stateConfigMap, "-o", "jsonpath={.data."+awakeKey+"}")
	recorded := map[string]int{}
	if err == nil && out != "" {
		_ = json.Unmarshal([]byte(out), &recorded)
	}
	return recorded
}

// Wake scales every platform Deployment back up, the database first, and
// waits until each is ready.
func Wake(ctx context.Context, r *run.Runner, c *config.Config, deps []Deployment) error {
	sort.SliceStable(deps, func(i, j int) bool { return isDatabase(deps[i]) && !isDatabase(deps[j]) })
	for _, d := range deps {
		if d.Replicas >= d.Awake {
			continue
		}
		if err := r.Run(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
			"scale", "deployment", d.Name, fmt.Sprintf("--replicas=%d", d.Awake)); err != nil {
			return err
		}
		if isDatabase(d) {
			if err := rollout(ctx, r, c, d.Name); err != nil {
				return err
			}
		}
	}
	for _, d := range deps {
		if !isDatabase(d) {
			if err := rollout(ctx, r, c, d.Name); err != nil {
				return err
			}
		}
	}
	return nil
}

func rollout(ctx context.Context, r *run.Runner, c *config.Config, name string) error {
	return r.Run(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"rollout", "status", "deployment", name, "--timeout", (5 * time.Minute).String())
}

func isDatabase(d Deployment) bool {
	return len(d.Name) > len("-postgres") && d.Name[len(d.Name)-len("-postgres"):] == "-postgres"
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

// ConsoleAccess is how to reach the console from this machine.
func ConsoleAccess(c *config.Config, env string) string {
	return fmt.Sprintf("`vennir console %s`, then http://localhost:18080", env)
}

// PortForward forwards localhost:port to the console until interrupted.
func PortForward(ctx context.Context, r *run.Runner, c *config.Config, port int) error {
	return r.Run(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
		"port-forward", "svc/"+install.ConsoleRelease+"-execution-console", fmt.Sprintf("%d:8080", port))
}

// Forward is a running port-forward to the console.
type Forward struct {
	URL  string
	stop func()
}

// Stop ends the port-forward.
func (f *Forward) Stop() { f.stop() }

// ForwardConsole port-forwards a free local port to the console in the
// background, and returns once it answers. kubectl's port-forward ends when
// its stream drops (minutes, on some clouds): it's started again on the same
// port, saying so on out, until Stop.
func ForwardConsole(ctx context.Context, c *config.Config, out io.Writer) (*Forward, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	args := []string{"--context", cluster.Context(c), "--namespace", c.Namespace,
		"port-forward", "svc/" + install.ConsoleRelease + "-execution-console", fmt.Sprintf("%d:8080", port)}
	return supervise(ctx, out, port, func(ctx context.Context) *exec.Cmd {
		return exec.CommandContext(ctx, tools.Path("kubectl"), args...)
	})
}

// supervise runs command (a forward to port) again whenever it ends, until
// Stop, and returns once port answers.
func supervise(ctx context.Context, out io.Writer, port int, command func(context.Context) *exec.Cmd) (*Forward, error) {
	fctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			began := time.Now()
			err := command(fctx).Run()
			if fctx.Err() != nil {
				return
			}
			fmt.Fprintf(out, "The console's port-forward ended (%v): starting it again.\n", err)
			// One that ends at once (the cluster unreachable) isn't
			// restarted in a tight loop.
			wait := time.Second
			if time.Since(began) < 5*time.Second {
				wait = 5 * time.Second
			}
			select {
			case <-fctx.Done():
				return
			case <-time.After(wait):
			}
		}
	}()
	f := &Forward{URL: fmt.Sprintf("http://127.0.0.1:%d", port), stop: func() { cancel(); <-done }}
	for i := 0; i < 60; i++ {
		if conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second); err == nil {
			conn.Close()
			return f, nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	f.Stop()
	return nil, fmt.Errorf("couldn't reach the console through a port-forward (is it awake? `vennir status`)")
}
