// SPDX-License-Identifier: MIT

package policy

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Annotations this process sets on the policies it writes, for the
// console's Admin page: the release they're from, and why the newest one
// was refused.
const (
	ReleaseAnnotation = "vennir.dev/catalog-release"
	CommitAnnotation  = "vennir.dev/catalog-commit"
	// RefusedAnnotation is why the newest release the catalog names was
	// refused, "" when it wasn't (ErrRefused).
	RefusedAnnotation = "vennir.dev/catalog-refused"
)

// Writer rewrites named variables of an admission policy (their literals),
// and its annotations; false when the policy doesn't exist.
type Writer interface {
	Write(ctx context.Context, policy string, variables, annotations map[string]string) (changed bool, err error)
}

// Kubernetes writes the cluster's ValidatingAdmissionPolicies (the kernel
// chart's catalog policies; its RBAC allows only those, by name).
type Kubernetes struct {
	Client kubernetes.Interface
}

// ErrNoPolicy is a policy that isn't installed.
type ErrNoPolicy struct{ Name string }

func (e ErrNoPolicy) Error() string {
	return fmt.Sprintf("admission policy %s isn't installed (catalogPolicy in the kernel chart)", e.Name)
}

// Write replaces the variables' expressions with these literals, only if
// any changed, conditionally on the version it read (a conflict reads and
// writes again). A variable the policy doesn't have is an error: an older
// chart.
func (k *Kubernetes) Write(ctx context.Context, policy string, variables, annotations map[string]string) (bool, error) {
	policies := k.Client.AdmissionregistrationV1().ValidatingAdmissionPolicies()
	for attempt := 1; ; attempt++ {
		current, err := policies.Get(ctx, policy, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return false, ErrNoPolicy{Name: policy}
		}
		if err != nil {
			return false, err
		}
		found := map[string]bool{}
		changed := false
		for i := range current.Spec.Variables {
			v := &current.Spec.Variables[i]
			literal, ok := variables[v.Name]
			if !ok {
				continue
			}
			found[v.Name] = true
			if v.Expression != literal {
				v.Expression = literal
				changed = true
			}
		}
		for variable := range variables {
			if !found[variable] {
				return false, fmt.Errorf("admission policy %s has no variable %s: upgrade the kernel chart", policy, variable)
			}
		}
		if current.Annotations == nil {
			current.Annotations = map[string]string{}
		}
		for key, value := range annotations {
			if current.Annotations[key] != value {
				current.Annotations[key] = value
				changed = true
			}
		}
		if !changed {
			return false, nil
		}
		_, err = policies.Update(ctx, current, metav1.UpdateOptions{FieldManager: "kernel-policy"})
		if apierrors.IsConflict(err) && attempt < 5 {
			continue
		}
		return err == nil, err
	}
}
