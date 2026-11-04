// SPDX-License-Identifier: MIT

package catalogtool

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/remote/transport"
)

// versionPattern is a catalog version: a Git tag vX.Y.Z, nothing after it,
// so the newest is never in doubt (the console reads the same pattern).
var versionPattern = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

// errNoRelease: nothing published a release under that tag.
var errNoRelease = errors.New("no release")

// promoteRelease tags the release published as <release>:from with
// version, and returns its digest reference and whether the tag is new. It
// pushes nothing else: the release is the bytes main published, with the
// signature that covers their digest. A version never moves: one already
// naming another release is refused.
func promoteRelease(ctx context.Context, s Settings, version, from string) (string, bool, error) {
	if !versionPattern.MatchString(version) {
		return "", false, fmt.Errorf("version %s: vX.Y.Z, such as v1.4.0", quote(version))
	}
	options := []remote.Option{remote.WithContext(ctx), remote.WithAuthFromKeychain(authn.DefaultKeychain)}
	source, err := name.NewTag(s.ReleaseRepository() + ":" + from)
	if err != nil {
		return "", false, err
	}
	release, err := remote.Get(source, options...)
	if notFound(err) {
		return "", false, fmt.Errorf("%w for %s: only a commit main published has one (%s)", errNoRelease, from, source)
	}
	if err != nil {
		return "", false, fmt.Errorf("reading %s: %w", source, err)
	}
	reference := s.ReleaseRepository() + "@" + release.Digest.String()
	target, err := name.NewTag(s.ReleaseRepository() + ":" + version)
	if err != nil {
		return "", false, err
	}
	existing, err := remote.Head(target, options...)
	switch {
	case err == nil && existing.Digest == release.Digest:
		return reference, false, nil
	case err == nil:
		return "", false, fmt.Errorf("%s is already %s@%s: a version never moves; tag a new one", version, s.ReleaseRepository(), existing.Digest)
	case !notFound(err):
		return "", false, fmt.Errorf("reading %s: %w", target, err)
	}
	if err := remote.Tag(target, release, options...); err != nil {
		return "", false, fmt.Errorf("tagging %s: %w", target, err)
	}
	return reference, true, nil
}

// notFound says whether a registry answered that a tag doesn't exist.
func notFound(err error) bool {
	var t *transport.Error
	return errors.As(err, &t) && (t.StatusCode == http.StatusNotFound || hasCode(t, transport.ManifestUnknownErrorCode))
}

func hasCode(t *transport.Error, code transport.ErrorCode) bool {
	for _, d := range t.Errors {
		if d.Code == code {
			return true
		}
	}
	return false
}

// Promote makes version name the release main published for a commit (by
// default HEAD's): what an install following that version, or the newest,
// then applies. Catalog CI runs it on main when a vX.Y.Z tag is pushed.
// With wait, a release not published yet is waited for that long (a tag
// pushed just after its merge, while main is still publishing).
func (c *Catalog) Promote(ctx context.Context, version, from string, wait time.Duration) (bool, error) {
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
	if from == "" {
		from = "HEAD"
	}
	// A commit (or a tag of one) names its release by its full hash; any
	// other name (local mode's local-… tags) is the release's own tag.
	if out, err := c.git("rev-parse", "--verify", "--quiet", from+"^{commit}"); err == nil {
		from = strings.TrimSpace(out)
	}
	reference, made, err := promoteRelease(ctx, s, version, from)
	for deadline := time.Now().Add(wait); errors.Is(err, errNoRelease) && time.Now().Before(deadline); {
		c.info("No release for %s yet; waiting for main to publish it", from)
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(30 * time.Second):
		}
		reference, made, err = promoteRelease(ctx, s, version, from)
	}
	if err != nil {
		c.errorAt(c.path("vennir.yaml"), "promoting failed: "+err.Error())
		return false, nil
	}
	if !made {
		c.info("%s was already %s", version, reference)
		return true, nil
	}
	c.info("Released %s as %s (the release of %s)", version, reference, from)
	c.summary(fmt.Sprintf("- Released catalog version `%s`: `%s` (the release of `%s`)", version, reference, from))
	return true, nil
}
