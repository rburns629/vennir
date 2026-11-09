// SPDX-License-Identifier: MIT

package main

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/consoleapi"
)

// The catalog repository's CI is told catalog-template's modes: key (with
// the install's KMS key), keyless, or none.
func TestSigningVariables(t *testing.T) {
	c := &config.Config{}
	for signing, want := range map[string][][2]string{
		"":        {{"VENNIR_SIGNING_MODE", "none"}},
		"kms":     {{"VENNIR_SIGNING_MODE", "key"}, {"VENNIR_SIGNING_KEY", "gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k"}},
		"keyless": {{"VENNIR_SIGNING_MODE", "keyless"}},
	} {
		c.Signing = signing
		if got := signingVariables(c, "gcpkms://projects/p/locations/l/keyRings/r/cryptoKeys/k"); fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%q: %v, want %v", signing, got, want)
		}
	}
}

// A repository has one owner: one publishing to another install's registry
// is refused unless taken over on purpose; a new or this install's isn't.
func TestOwnedElsewhere(t *testing.T) {
	ours := "us-central1-docker.pkg.dev/p/vennir-test-products"
	for _, current := range []string{"", ours} {
		if err := ownedElsewhere("my-org/catalog", current, ours, false); err != nil {
			t.Errorf("%q: %v", current, err)
		}
	}
	prod := "us-central1-docker.pkg.dev/p/vennir-prod-products"
	err := ownedElsewhere("my-org/catalog", prod, ours, false)
	if err == nil || !strings.Contains(err.Error(), "externalCatalog.registry "+prod) || !strings.Contains(err.Error(), "--take-over") {
		t.Errorf("another's: %v", err)
	}
	if err := ownedElsewhere("my-org/catalog", prod, ours, true); err != nil {
		t.Errorf("taken over: %v", err)
	}
}

// After a reinstall, the repository's sign-in names the deleted install's
// identity: apply names what `vennir catalog create` would set. A
// repository publishing to another install's registry isn't flagged.
func TestStaleCatalogVariables(t *testing.T) {
	setup := &catalogSetup{
		registry:  "us-central1-docker.pkg.dev/p/vennir-products",
		signing:   [][2]string{{"VENNIR_SIGNING_MODE", "keyless"}},
		variables: [][2]string{{"GCP_WORKLOAD_IDENTITY_PROVIDER", "projects/1/locations/global/workloadIdentityPools/vennir-gh-new/providers/github"}, {"PUBLISH_GCP_SERVICE_ACCOUNT", "vennir-publish@p.iam.gserviceaccount.com"}},
	}
	current := map[string]string{
		"VENNIR_REGISTRY":                setup.registry,
		"VENNIR_SIGNING_MODE":            "keyless",
		"GCP_WORKLOAD_IDENTITY_PROVIDER": setup.variables[0][1],
		"PUBLISH_GCP_SERVICE_ACCOUNT":    setup.variables[1][1],
	}
	if stale := staleCatalogVariables(current, setup); len(stale) != 0 {
		t.Errorf("this install's: %v", stale)
	}
	reinstalled := map[string]string{}
	for k, v := range current {
		reinstalled[k] = v
	}
	reinstalled["GCP_WORKLOAD_IDENTITY_PROVIDER"] = "projects/1/locations/global/workloadIdentityPools/vennir-gh-old/providers/github"
	delete(reinstalled, "VENNIR_SIGNING_MODE")
	if stale := staleCatalogVariables(reinstalled, setup); fmt.Sprint(stale) != "[VENNIR_SIGNING_MODE GCP_WORKLOAD_IDENTITY_PROVIDER]" {
		t.Errorf("reinstalled: %v", stale)
	}
	elsewhere := map[string]string{"VENNIR_REGISTRY": "us-central1-docker.pkg.dev/p/vennir-prod-products"}
	if stale := staleCatalogVariables(elsewhere, setup); len(stale) != 0 {
		t.Errorf("another install's: %v", stale)
	}
}

// The smoke test waits out the console's first scan of a new image, and
// nothing else.
func TestScanningIsWaitedOut(t *testing.T) {
	for failure, want := range map[string]bool{"IMAGE_SCAN_PENDING": true, "IMAGE_SCAN_ERROR": true, "IMAGE_SCAN_FAILED": false, "": false} {
		err := fmt.Errorf("submit: %w", &consoleapi.Refusal{Failure: failure})
		if scanning(err) != want {
			t.Errorf("%q: %v", failure, !want)
		}
	}
	if scanning(errors.New("reaching the console")) {
		t.Error("a network error isn't a scan")
	}
}

// A destroy that couldn't reach its cluster lists the disks it may have
// left, and how to delete them; it says when it couldn't look.
func TestLeftBehind(t *testing.T) {
	var b strings.Builder
	leftBehind(&b, "disk", nil, nil, "")
	if b.String() != "" {
		t.Errorf("nothing left: %q", b.String())
	}
	leftBehind(&b, "disk", []string{"us-central1-b/pvc-1"}, nil, "gcloud compute disks delete <name>")
	if !strings.Contains(b.String(), "us-central1-b/pvc-1") || !strings.Contains(b.String(), "gcloud compute disks delete") {
		t.Errorf("found: %q", b.String())
	}
	b.Reset()
	leftBehind(&b, "EBS volume", nil, errors.New("expired"), "")
	if !strings.Contains(b.String(), "Couldn't list the EBS volumes") {
		t.Errorf("error: %q", b.String())
	}
}
