// SPDX-License-Identifier: MIT

package catalogtool

import (
	"encoding/json"
	"testing"
)

// The attached SBOM names the image, not the scan's temporary archive.
func TestTheSBOMNamesTheImage(t *testing.T) {
	ref := "us-central1-docker.pkg.dev/p/catalog-products/gcp-app-hosting@sha256:f75f"
	trivy := `{"bomFormat": "CycloneDX", "metadata": {"component": {"bom-ref": "x", "type": "container", "name": "/tmp/vennir-scan-123/image.tar"}}, "components": [{"name": "openssl"}]}`
	var got struct {
		Metadata struct {
			Component struct{ Name, Type string } `json:"component"`
		} `json:"metadata"`
		Components []struct{ Name string } `json:"components"`
	}
	if err := json.Unmarshal(sbomOf([]byte(trivy), ref), &got); err != nil {
		t.Fatal(err)
	}
	if got.Metadata.Component.Name != ref || got.Metadata.Component.Type != "container" || len(got.Components) != 1 {
		t.Errorf("got %+v", got)
	}
	if string(sbomOf([]byte("not json"), ref)) != "not json" {
		t.Error("something not JSON should be left as it is")
	}
}
