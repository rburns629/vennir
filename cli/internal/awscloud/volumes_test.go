// SPDX-License-Identifier: MIT

package awscloud

import (
	"slices"
	"testing"
)

// A destroyed cluster's left volumes are told apart by the cluster their
// tags name: this one's are its own, another's (a sleeping install's
// database) aren't listed, and an untagged one is to be checked by hand.
func TestVolumesOf(t *testing.T) {
	out := `[
  {"id": "vol-auto", "tags": [{"Key": "eks:eks-cluster-name", "Value": "dev"}, {"Key": "kubernetes.io/created-for/pvc/namespace", "Value": "vennir-system"}]},
  {"id": "vol-csi", "tags": [{"Key": "kubernetes.io/cluster/dev", "Value": "owned"}, {"Key": "KubernetesCluster", "Value": "dev"}]},
  {"id": "vol-prod", "tags": [{"Key": "eks:eks-cluster-name", "Value": "prod"}]},
  {"id": "vol-both", "tags": [{"Key": "kubernetes.io/cluster/dev", "Value": "owned"}, {"Key": "KubernetesCluster", "Value": "prod"}]},
  {"id": "vol-untagged", "tags": [{"Key": "CSIVolumeName", "Value": "pvc-1"}]},
  {"id": "vol-none", "tags": null}
]`
	mine, unknown, err := volumesOf(out, "dev")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(mine, []string{"vol-auto", "vol-csi"}) {
		t.Errorf("this cluster's: %v", mine)
	}
	if !slices.Equal(unknown, []string{"vol-untagged", "vol-none"}) {
		t.Errorf("no cluster's: %v", unknown)
	}
	if _, _, err := volumesOf("not json", "dev"); err == nil {
		t.Error("garbage accepted")
	}
}
