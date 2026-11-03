// SPDX-License-Identifier: MIT

package executor

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/rburns629/vertra/kernel/internal/domain"
)

// A task's Pod size, its defaults, and what reaches the Pod spec. (Refusing
// a malformed size at submission is kernel-api's, and stays with its
// tests.)

func sized(r *domain.TaskResources) ResolvedTask {
	return ResolvedTask{ExecutionID: "00000000-0000-0000-0000-000000000001", TaskKey: "step", Image: "hello:1",
		Action: "greet", Attempt: 1, TimeoutSeconds: 60, Team: "team-a", ServiceAccount: "default", Resources: r}
}

func list(pairs ...string) corev1.ResourceList {
	if len(pairs) == 0 {
		return nil
	}
	l := corev1.ResourceList{}
	for i := 0; i < len(pairs); i += 2 {
		l[corev1.ResourceName(pairs[i])] = resource.MustParse(pairs[i+1])
	}
	return l
}

func requirements(t *testing.T, defaults *domain.TaskResources, own *domain.TaskResources) corev1.ResourceRequirements {
	t.Helper()
	r, err := (&Kubernetes{opts: KubernetesOptions{DefaultResources: defaults}}).resources(sized(own))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func sameList(t *testing.T, what string, got, want corev1.ResourceList) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s = %v, want %v", what, got, want)
		return
	}
	for name, q := range want {
		if g, ok := got[name]; !ok || g.Cmp(q) != 0 {
			t.Errorf("%s = %v, want %v", what, got, want)
		}
	}
}

func TestRequestsComeFromTheTaskWithMemoryCappedAtItsRequest(t *testing.T) {
	r := requirements(t, nil, &domain.TaskResources{CPU: "50m", Memory: "64Mi"})
	sameList(t, "requests", r.Requests, list("cpu", "50m", "memory", "64Mi"))
	sameList(t, "limits", r.Limits, list("memory", "64Mi"))
}

func TestCPUIsNeverLimitedSoAStepCanUseSpareCPU(t *testing.T) {
	r := requirements(t, nil, &domain.TaskResources{CPU: "1"})
	sameList(t, "requests", r.Requests, list("cpu", "1"))
	sameList(t, "limits", r.Limits, nil)
}

func TestAnExplicitMemoryLimitLetsMemoryBurstAboveTheRequest(t *testing.T) {
	r := requirements(t, nil, &domain.TaskResources{Memory: "256Mi", MemoryLimit: "1Gi"})
	sameList(t, "limits", r.Limits, list("memory", "1Gi"))
}

func TestTheDeploymentDefaultFillsWhatTheTaskLeavesOut(t *testing.T) {
	r := requirements(t, &domain.TaskResources{CPU: "100m", Memory: "256Mi"}, &domain.TaskResources{CPU: "2"})
	sameList(t, "requests", r.Requests, list("cpu", "2", "memory", "256Mi"))
}

func TestWithNoSizeAnywhereThePodRequestsNothing(t *testing.T) {
	r := requirements(t, nil, nil)
	sameList(t, "requests", r.Requests, nil)
	sameList(t, "limits", r.Limits, nil)
}

func TestASizeThatIsntAQuantityRefusesTheDispatch(t *testing.T) {
	k := &Kubernetes{opts: KubernetesOptions{}}
	_, err := k.jobFor("ek-x", sized(&domain.TaskResources{Memory: "512 MiB"}))
	if err == nil {
		t.Fatal("accepted")
	}
	_, err = k.Start(t.Context(), sized(&domain.TaskResources{Memory: "lots"}))
	if _, rejected := IsDispatchRejected(err); !rejected {
		t.Fatalf("Start: %v, want a DispatchRejected", err)
	}
}
