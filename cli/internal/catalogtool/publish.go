// SPDX-License-Identifier: MIT

package catalogtool

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// versionTag is what CI tags with (the commit) or a laptop (the time; no
// commit need exist). Either way the registration pins the digest.
func (c *Catalog) versionTag() string {
	if sha := c.Getenv("GITHUB_SHA"); sha != "" {
		return sha
	}
	return time.Now().UTC().Format("local-20060102T150405Z")
}

// productCommit is the newest commit that changed what a product is
// published from: its folder, or what republishes every product
// (republishPaths). CI tags its image with it, so the release of any later
// commit knows which image is the product's as of that commit.
func (c *Catalog) productCommit(p *Product) (string, error) {
	out, err := c.git(append([]string{"log", "-1", "--format=%H", "--", p.Label()}, republishPaths...)...)
	commit := strings.TrimSpace(out)
	if err != nil || commit == "" {
		return "", fmt.Errorf("found no commit that changed %s (git log)", p.Label())
	}
	return commit, nil
}

// imageTag is what a product's image is tagged with: in CI, its commit
// (productCommit); from a laptop, whose tree may hold edits no commit has,
// the time.
func (c *Catalog) imageTag(p *Product) (string, error) {
	if c.Getenv("GITHUB_SHA") == "" {
		return c.versionTag(), nil
	}
	return c.productCommit(p)
}

// push pushes the checked image, tagged with imageTag, and returns the
// digest reference, which is what's signed and released. Not :latest yet:
// that waits until it's signed (tagLatest).
func (c *Catalog) push(p *Product, s Settings) (string, error) {
	repository := p.Repository(s)
	tag, err := c.imageTag(p)
	if err != nil {
		return "", err
	}
	tagged := repository + ":" + tag
	for _, args := range [][]string{{"tag", p.LocalImage(), tagged}, {"push", tagged}} {
		if _, err := c.docker(false, args...); err != nil {
			return "", err
		}
	}
	result, err := c.docker(true, "inspect", "--format", "{{json .RepoDigests}}", tagged)
	if err != nil {
		return "", err
	}
	var digests []string
	_ = json.Unmarshal([]byte(result.stdout), &digests)
	for _, reference := range digests {
		if strings.HasPrefix(reference, repository+"@sha256:") {
			c.info("  pushed %s -> %s", tagged, reference)
			return reference, nil
		}
	}
	return "", fmt.Errorf("pushed %s but found no digest for it", tagged)
}

// tagLatest moves <repository>:latest to the image (so a DAG can name
// <registry>/<team>/<product>:latest; the console pins whatever that names
// to its digest at submission), once it's signed and its SBOM attached: a
// failed sign leaves :latest where it was.
func (c *Catalog) tagLatest(p *Product, s Settings) error {
	latest := p.Repository(s) + ":latest"
	for _, args := range [][]string{{"tag", p.LocalImage(), latest}, {"push", latest}} {
		if _, err := c.docker(false, args...); err != nil {
			return err
		}
	}
	return nil
}

// sign signs by digest: a tag can move, a digest is the bytes that passed.
func (c *Catalog) sign(reference string, s Settings) error {
	if s.SigningMode == "none" {
		return nil
	}
	cosign, err := exec.LookPath("cosign")
	if err != nil {
		return errors.New("signing needs cosign installed (.github/scripts/install-scanners.sh cosign)")
	}
	result, err := c.run(0, false, cosign, append(append([]string{"sign", "--yes"}, signingArgs(s)...), reference)...)
	if err == nil && result.code != 0 {
		err = fmt.Errorf("cosign sign failed (exit %d)", result.code)
	}
	if err != nil {
		return err
	}
	c.info("  signed %s", reference)
	return nil
}

// signingArgs are cosign's flags for the catalog's signing mode (sign's and
// attest's alike). key: no public transparency log, verification uses the
// public key; keyless: CI's OIDC identity, logged publicly, on Sigstore's
// public instances as cosign's flags default to. Either way the legacy
// format, which policy-controller reads (a signing config would need the
// new bundle format).
func signingArgs(s Settings) []string {
	if s.SigningMode == "key" {
		return []string{"--key", s.SigningKey, "--use-signing-config=false", "--tlog-upload=false", "--new-bundle-format=false"}
	}
	return []string{"--use-signing-config=false", "--new-bundle-format=false"}
}

// attestSBOM attaches the image's bill of materials to it as a CycloneDX
// attestation, signed as the image is, for an install to show (Observe).
// Nothing when the catalog doesn't sign, or the scan made none.
func (c *Catalog) attestSBOM(p *Product, reference string, s Settings) error {
	if s.SigningMode == "none" || len(p.SBOM) == 0 {
		return nil
	}
	cosign, err := exec.LookPath("cosign")
	if err != nil {
		return errors.New("signing needs cosign installed (.github/scripts/install-scanners.sh cosign)")
	}
	work, cleanup, err := tempDir("vertra-sbom-")
	if err != nil {
		return err
	}
	defer cleanup()
	predicate := filepath.Join(work, "sbom.json")
	if err := os.WriteFile(predicate, sbomOf(p.SBOM, reference), 0o644); err != nil {
		return err
	}
	args := append([]string{"attest", "--yes", "--type", "cyclonedx", "--predicate", predicate}, signingArgs(s)...)
	result, err := c.run(0, false, cosign, append(args, reference)...)
	if err == nil && result.code != 0 {
		err = fmt.Errorf("cosign attest failed (exit %d)", result.code)
	}
	if err != nil {
		return err
	}
	c.info("  attached its SBOM to %s", reference)
	return nil
}

// sbomOf is a CycloneDX SBOM with its subject named after the image it's
// attached to: Trivy, reading the scan's saved archive, names it after the
// archive's temporary path. Unchanged if it isn't CycloneDX JSON.
func sbomOf(sbom []byte, reference string) []byte {
	var doc map[string]any
	if json.Unmarshal(sbom, &doc) != nil {
		return sbom
	}
	metadata, _ := doc["metadata"].(map[string]any)
	component, _ := metadata["component"].(map[string]any)
	if component == nil {
		return sbom
	}
	component["name"] = reference
	out, err := json.Marshal(doc)
	if err != nil {
		return sbom
	}
	return out
}

func text(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// Publish pushes and signs a checked product, then tags it :latest.Nothing is registered: the
// catalog's release (release.go) names it, and each console pulls that.
func (c *Catalog) Publish(p *Product, s Settings) bool {
	reference, err := c.push(p, s)
	if err == nil {
		err = c.sign(reference, s)
	}
	if err == nil {
		err = c.attestSBOM(p, reference, s)
	}
	if err == nil {
		err = c.tagLatest(p, s)
	}
	if err != nil {
		c.errorAt(p.Dir, "publishing failed: "+err.Error())
		return false
	}
	c.summary(fmt.Sprintf("- Published `%s` as `%s`", p.Label(), reference))
	return true
}
