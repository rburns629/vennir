// SPDX-License-Identifier: MIT

package catalogtool

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

// A catalog's approved base images (bases.yaml): each copied into its
// registry, <registry>/bases/<name>, by `vennir catalog bases mirror` (catalog
// CI, weekly), keeping its digest, for products to build FROM. The copies are
// the catalog's own: pinned, scanned, signed as its images are, and still
// there if the source moves or goes. A product may use them (`vennir catalog
// bases --use-mirror` points its Dockerfile at them) or not.

var basesSchema = sync.OnceValue(func() *jsonschema.Schema { return embeddedSchema("bases.schema.json") })

// Base is one approved base image.
type Base struct {
	// Name is its repository under <registry>/bases/.
	Name string
	// Image is the source, by tag, as a FROM names it.
	Image string
}

// MirrorRepository is where a base's copy lives.
func (s Settings) MirrorRepository(base Base) string { return s.Registry + "/bases/" + base.Name }

// mirrorTag is the copy's tag: the source's.
func mirrorTag(base Base) string { return base.Image[strings.LastIndex(base.Image, ":")+1:] }

// Bases are the catalog's approved bases (none without a bases.yaml), or
// what's wrong with its file.
func (c *Catalog) LoadBases() ([]Base, []string) {
	data, err := os.ReadFile(c.path("bases.yaml"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, []string{err.Error()}
	}
	doc, problem := loadYAML(data)
	if problem != "" {
		return nil, []string{problem}
	}
	if problems := schemaErrors(basesSchema(), doc); len(problems) > 0 {
		return nil, problems
	}
	spec, _ := doc.(map[string]any)
	list, _ := spec["bases"].([]any)
	var bases []Base
	seen := map[string]bool{}
	var problems []string
	for _, raw := range list {
		m, _ := raw.(map[string]any)
		b := Base{Name: text(m, "name"), Image: text(m, "image")}
		if seen[b.Name] {
			problems = append(problems, fmt.Sprintf("bases: %s is named twice", b.Name))
		}
		seen[b.Name] = true
		bases = append(bases, b)
	}
	return bases, problems
}

// ValidateBases checks bases.yaml, when there is one.
func (c *Catalog) ValidateBases() bool {
	_, problems := c.LoadBases()
	for _, p := range problems {
		c.errorAt(c.path("bases.yaml"), p)
	}
	return len(problems) == 0
}

// copyBase copies a base's source into its mirror, keeping its digest (an
// index's, with every platform), and returns the copy's digest reference.
// Registry sign-in is Docker's, as for pushing.
func copyBase(ctx context.Context, s Settings, base Base) (string, error) {
	options := []remote.Option{remote.WithContext(ctx), remote.WithAuthFromKeychain(authn.DefaultKeychain)}
	source, err := name.ParseReference(base.Image)
	if err != nil {
		return "", err
	}
	target, err := name.NewTag(s.MirrorRepository(base) + ":" + mirrorTag(base))
	if err != nil {
		return "", err
	}
	desc, err := remote.Get(source, options...)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", base.Image, err)
	}
	if desc.MediaType.IsIndex() {
		index, err := desc.ImageIndex()
		if err != nil {
			return "", err
		}
		err = remote.WriteIndex(target, index, options...)
		if err != nil {
			return "", fmt.Errorf("copying %s: %w", base.Image, err)
		}
	} else {
		image, err := desc.Image()
		if err != nil {
			return "", err
		}
		if err := remote.Write(target, image, options...); err != nil {
			return "", fmt.Errorf("copying %s: %w", base.Image, err)
		}
	}
	return s.MirrorRepository(base) + "@" + desc.Digest.String(), nil
}

// MirrorBases copies each approved base into the registry, scans the copy
// (reported, not blocking: a product patches its packages, and its own scan
// blocks), and signs it when the catalog signs. Says whether every one was
// copied.
func (c *Catalog) MirrorBases(ctx context.Context) (bool, error) {
	s, err := c.Settings()
	if err != nil {
		return false, err
	}
	if problems := s.Problems(); len(problems) > 0 {
		for _, p := range problems {
			c.errorAt(c.path("vennir.yaml"), p)
		}
		return false, nil
	}
	bases, problems := c.LoadBases()
	for _, p := range problems {
		c.errorAt(c.path("bases.yaml"), p)
	}
	if len(problems) > 0 {
		return false, nil
	}
	if len(bases) == 0 {
		c.info("No bases.yaml, or no bases in it: nothing to mirror.")
		return true, nil
	}
	ok := true
	lines := []string{"### Base images", ""}
	for _, base := range bases {
		reference, err := copyBase(ctx, s, base)
		if err == nil {
			err = c.sign(reference, s)
		}
		if err != nil {
			c.errorAt(c.path("bases.yaml"), fmt.Sprintf("%s: %v", base.Name, err))
			lines = append(lines, fmt.Sprintf("- :x: `%s`: %v", base.Image, err))
			ok = false
			continue
		}
		found := c.scanBase(reference)
		c.info("Mirrored %s as %s %s", base.Image, reference, found)
		lines = append(lines, fmt.Sprintf("- `%s` → `%s` %s", base.Image, reference, found))
	}
	c.summary(strings.Join(lines, "\n"))
	return ok, nil
}

// scanBase is what a scan of a mirrored base found, in words; a base is never
// refused for it.
func (c *Catalog) scanBase(reference string) string {
	work, cleanup, err := tempDir("vennir-base-")
	if err != nil {
		return "(not scanned)"
	}
	defer cleanup()
	cmd, err := c.scanner("trivy", trivyImage, work, []string{"image", "--quiet", "--scanners", "vuln", "--severity", "HIGH,CRITICAL",
		"--ignore-unfixed", "--format", "template", "--template", "{{- range . }}{{ len .Vulnerabilities }} {{ end }}", reference}, true)
	if err != nil {
		return "(not scanned)"
	}
	result, err := c.run(0, true, cmd[0], cmd[1:]...)
	if err != nil || result.code != 0 {
		return "(not scanned)"
	}
	fixable := 0
	for _, n := range strings.Fields(result.stdout) {
		var count int
		_, _ = fmt.Sscan(n, &count)
		fixable += count
	}
	if fixable == 0 {
		return "(no fixable high or critical vulnerabilities)"
	}
	return fmt.Sprintf("(%d fixable high or critical vulnerabilities: products built FROM it patch them, or their checks fail)", fixable)
}
