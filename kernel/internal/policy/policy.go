// SPDX-License-Identifier: MIT

// Package policy is `kernel policy` (decision 27, docs/assessment.md): it
// writes what the catalog decides into admission policies only it may
// update, from the catalog release it verified itself, so whoever controls
// the console can't loosen them.
//
// Every PollInterval it looks at the release the console reads (the kernel
// chart's catalogPolicy.release, never the console's setting), and when
// it's new: verifies its signature against the signers the kernel chart
// trusts (Signers), refuses one older than the release applied, and
// records it in the kernel's database (Store): each product release it
// names, and each API. Then, once a release has been applied, it writes:
//
//   - the identity policy (<kernel>-catalog-identity): each released
//     digest's products, {team, repository, action, serviceAccount,
//     audiences}, as console/src/productPolicy.ts lists them, in sixteen maps
//     by the digest's first hex digit. Which releases: those the applied
//     release names, and an earlier one for ReleaseGrace after a release
//     stopped naming it, or while an unfinished task (execution_tasks) runs
//     it as that product;
//   - the gateway token policy (<kernel>-catalog-tokens), when the gateway
//     is on: each API ServiceAccount's audiences, as
//     console/src/gatewayTokenPolicy.ts computes them, in sixteen maps by the
//     key's length modulo 16, and apiAudiencesWritten true.
//
// Until a release has been applied, nothing is written: the chart seeded
// the policies from the console's on upgrade, and they stand. A pass that
// fails is logged and the next one starts again from the database.
package policy

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"google.golang.org/protobuf/encoding/protojson"

	catalogv1 "github.com/rburns629/vennir/kernel/internal/gen/vennir/catalog/v1"
	"github.com/rburns629/vennir/kernel/internal/metrics"
)

// Source is where a release comes from and how it's verified.
type Source interface {
	// Follow is the reference read now (a version tag, with newest).
	Follow(ctx context.Context) (string, error)
	// Digest is the manifest digest the reference names now.
	Digest(ctx context.Context, ref string) (string, error)
	// Fetch reads the release by its manifest.
	Fetch(ctx context.Context, ref string) (Fetched, error)
	// Verify checks a trusted signer signed repository@digest, and says
	// which of them did (Signers.IDs).
	Verify(ctx context.Context, ref string, digest string) ([]string, error)
	// Trusted are the signers Verify trusts now (Signers.IDs).
	Trusted() []string
}

// Catalog is a Source on a registry: Registry's sign-in and mirrors,
// Signers' trust.
type Catalog struct {
	Reference     string
	NewestVersion bool
	Registry      *Registry
	Signers       *Signers
}

func (c *Catalog) Follow(ctx context.Context) (string, error) {
	return c.Registry.Follow(ctx, c.Reference, c.NewestVersion)
}

func (c *Catalog) Digest(ctx context.Context, ref string) (string, error) {
	return c.Registry.Digest(ctx, ref)
}

func (c *Catalog) Fetch(ctx context.Context, ref string) (Fetched, error) {
	return c.Registry.Fetch(ctx, ref)
}

func (c *Catalog) Trusted() []string { return c.Signers.IDs() }

func (c *Catalog) Verify(ctx context.Context, ref, digest string) ([]string, error) {
	read, err := c.Registry.Reference(pinned(ref, digest))
	if err != nil {
		return nil, err
	}
	pinnedRef, ok := read.(name.Digest)
	if !ok {
		return nil, fmt.Errorf("%s isn't pinned to a digest", ref)
	}
	return c.Signers.Verify(ctx, pinnedRef, c.Registry.Options(ctx))
}

// pinned is ref's repository at digest (ref itself when digest is "").
func pinned(ref, digest string) string {
	if digest == "" {
		return ref
	}
	repository := ref
	if at := strings.LastIndex(repository, "@"); at >= 0 {
		repository = repository[:at]
	}
	if colon := strings.LastIndex(repository, ":"); colon > strings.LastIndex(repository, "/") {
		repository = repository[:colon]
	}
	return repository + "@" + digest
}

// Controller is the policy process.
type Controller struct {
	Source Source
	Store  *Store
	Writer Writer
	// IdentityPolicy and GatewayPolicy are the policies' names; GatewayPolicy
	// "": the gateway is off.
	IdentityPolicy string
	GatewayPolicy  string
	// GCPAudience is the gateway's Google pool's audience (the console
	// chart's gateway.gcp.tokenAudience), what googleIdToken APIs need.
	GCPAudience string
	Reserved    Reserved
	// ReleaseGrace is how long an earlier release stays listed after a
	// release stopped naming it (the console's RELEASE_GRACE_MINUTES).
	ReleaseGrace time.Duration
	// InUseMax bounds which unfinished executions keep an earlier release
	// listed: those submitted within it (the scheduler's approval timeout,
	// by default).
	InUseMax     time.Duration
	PollInterval time.Duration
	PassTimeout  time.Duration
	Log          *slog.Logger
}

// Run passes every PollInterval until ctx ends; a failed pass is logged.
func (c *Controller) Run(ctx context.Context) error {
	c.Log.Info("kernel policy running", "identityPolicy", c.IdentityPolicy, "gatewayPolicy", c.GatewayPolicy,
		"pollIntervalSeconds", c.PollInterval.Seconds())
	for {
		pass, cancel := context.WithTimeout(ctx, c.PassTimeout)
		err := c.Pass(pass)
		cancel()
		outcome := "ok"
		if err != nil {
			outcome = "failed"
			if ctx.Err() == nil {
				c.Log.Error("catalog policy pass failed", "error", err.Error())
			}
		}
		metrics.CatalogPolicyPasses.WithLabelValues(outcome).Inc()
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(c.PollInterval):
		}
	}
}

// Pass looks at the catalog (applying a new release), then writes the
// policies from what's applied. Both are tried; their errors joined.
func (c *Controller) Pass(ctx context.Context) error {
	lookErr := c.look(ctx)
	return errors.Join(lookErr, c.write(ctx))
}

// look applies the release the catalog names now, if it's new, signed by a
// trusted signer, and not older than the one applied. First, the release
// applied under other signers than the chart trusts now (a key removed, a
// keyless identity changed: none of the signers that verified it is
// trusted now) is verified again; until one of them verifies a release, the
// policies list nothing (write).
func (c *Controller) look(ctx context.Context) error {
	current, err := c.Store.State(ctx)
	if err != nil {
		return err
	}
	var reverifyErr error
	if current != nil && !TrustedBy(current.Signers, c.Source.Trusted()) {
		if signers, err := c.Source.Verify(ctx, current.Reference, current.Digest); err != nil {
			reverifyErr = fmt.Errorf("the catalog release applied (%s) doesn't verify against the signers trusted now, "+
				"so no product is listed until one that does is applied: %w", pinned(current.Reference, current.Digest), err)
		} else {
			if err := c.Store.Reverified(ctx, current.Digest, signers); err != nil {
				return err
			}
			current.Signers = signers
			c.Log.Info("catalog release applied verified against the signers trusted now", "digest", current.Digest)
		}
	}
	ref, err := c.Source.Follow(ctx)
	if err != nil {
		return errors.Join(reverifyErr, err)
	}
	digest, err := c.Source.Digest(ctx, ref)
	if err != nil {
		return errors.Join(reverifyErr, err)
	}
	if current != nil && current.Digest == digest {
		return reverifyErr
	}
	if err := c.apply(ctx, ref, digest, current); err != nil {
		return errors.Join(reverifyErr, err)
	}
	return nil
}

// FutureSkew is how far in the future a release may say it was made (the
// clocks of catalog CI and this cluster): one dated later is refused, so a
// release can't lock out the ones after it.
const FutureSkew = 10 * time.Minute

// apply verifies the release at ref@digest, reads it by that digest, and
// records it as the one applied.
func (c *Controller) apply(ctx context.Context, ref, digest string, current *State) error {
	// Verified by the digest read, and then the release read by it: the
	// bytes applied are exactly the ones signed.
	signers, err := c.Source.Verify(ctx, ref, digest)
	if err != nil {
		return fmt.Errorf("catalog release %s: %w; nothing was applied", ref, err)
	}
	fetched, err := c.Source.Fetch(ctx, pinned(ref, digest))
	if err != nil {
		return err
	}
	if fetched.Digest != digest {
		return fmt.Errorf("catalog release %s changed while it was read; nothing was applied", ref)
	}
	release := &catalogv1.Release{}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(fetched.JSON, release); err != nil {
		return fmt.Errorf("catalog release %s@%s isn't a release: %w", ref, digest, err)
	}
	// Never an older release than the one applied, though it was signed
	// too: its createdAt is part of what's signed. Going back is releasing
	// the older commit again. Unless the one applied isn't trusted now (its
	// signers aren't these): its date doesn't hold a trusted one back.
	if release.GetCreatedAt() == nil {
		return fmt.Errorf("catalog release %s@%s says when it was made nowhere; nothing was applied", ref, digest)
	}
	releasedAt := release.GetCreatedAt().AsTime()
	trusted := current != nil && TrustedBy(current.Signers, c.Source.Trusted())
	if trusted && releasedAt.Before(current.ReleasedAt) {
		return fmt.Errorf("catalog release %s@%s: %w; nothing was applied", ref, digest, ErrOlder{Release: releasedAt, Applied: current.ReleasedAt})
	}
	if releasedAt.After(time.Now().Add(FutureSkew)) {
		return fmt.Errorf("catalog release %s@%s says it was made %s, in the future; nothing was applied",
			ref, digest, releasedAt.Format(time.RFC3339))
	}
	releases, problems := Releases(release, c.Reserved)
	apis, apiProblems := APIs(release)
	for _, p := range append(problems, apiProblems...) {
		c.Log.Warn("catalog release: not listed", "item", p.Item, "problem", p.Message, "digest", digest)
	}
	// What it lists by itself must fit the policies, or it isn't applied:
	// applied, it couldn't be written, and what's written now would stand.
	if _, err := IdentityVariables(Listed(releases, nil, time.Now(), 0)); err != nil {
		return fmt.Errorf("catalog release %s@%s: %w; nothing was applied", ref, digest, err)
	}
	if _, err := AudienceVariables(Audiences(apis, c.GCPAudience, c.Reserved)); err != nil {
		return fmt.Errorf("catalog release %s@%s: %w; nothing was applied", ref, digest, err)
	}
	applied, err := c.Store.Apply(ctx, State{Reference: ref, Digest: digest, ReleasedAt: releasedAt, Commit: release.GetCommit(),
		Signers: signers, APIs: apis}, releases, c.Source.Trusted())
	if err != nil {
		return fmt.Errorf("catalog release %s@%s: %w; nothing was applied", ref, digest, err)
	}
	if !applied {
		return errors.New("another kernel policy is applying a release")
	}
	c.Log.Info("catalog release applied", "reference", ref, "digest", digest, "commit", release.GetCommit(),
		"products", len(releases), "apis", len(apis), "notListed", len(problems)+len(apiProblems))
	return nil
}

// write writes both policies from what's applied, pruning the releases no
// longer listed. Nothing before a release has been applied. When the
// release applied wasn't verified by the signers trusted now, both list
// nothing, and say they're from no release.
func (c *Controller) write(ctx context.Context) error {
	state, err := c.Store.State(ctx)
	if err != nil {
		return err
	}
	if state == nil {
		c.Log.Info("no catalog release applied yet: the policies stay as the chart seeded them")
		return nil
	}
	releases, err := c.Store.Releases(ctx)
	if err != nil {
		return err
	}
	inUse, err := c.Store.InUse(ctx, c.InUseMax)
	if err != nil {
		return err
	}
	now, err := c.Store.Now(ctx)
	if err != nil {
		return err
	}
	annotations := map[string]string{ReleaseAnnotation: pinned(state.Reference, state.Digest), CommitAnnotation: state.Commit}
	// Only releases a signer trusted now verified: an earlier release only
	// a removed key signed isn't listed, in its grace or in use.
	trusted := TrustedReleases(releases, c.Source.Trusted())
	listed := Listed(trusted, inUse, now, c.ReleaseGrace)
	apis := state.APIs
	if !TrustedBy(state.Signers, c.Source.Trusted()) {
		listed, apis = map[string][]Entry{}, nil
		annotations = map[string]string{ReleaseAnnotation: "", CommitAnnotation: ""}
	}
	variables, err := IdentityVariables(listed)
	var overflow error
	if err != nil {
		// Too many earlier releases kept: only what the applied release
		// names (it fit when applied), then nothing, rather than leave what's
		// written now (revoked releases with it) standing.
		overflow = err
		current := map[string][]Entry{}
		for _, r := range trusted {
			if r.ReleasedUntil == nil && TrustedBy(state.Signers, c.Source.Trusted()) {
				current[r.Digest] = append(current[r.Digest], r.Entry)
			}
		}
		if variables, err = IdentityVariables(current); err != nil {
			variables, _ = IdentityVariables(map[string][]Entry{})
		}
		listed = current
	}
	changed, err := c.Writer.Write(ctx, c.IdentityPolicy, variables, annotations)
	if err != nil {
		return errors.Join(overflow, err)
	}
	if changed {
		c.Log.Info("identity policy written", "policy", c.IdentityPolicy, "digests", len(listed), "release", state.Digest)
	}
	pruned, err := c.Store.Prune(ctx, releases, inUse, now, c.ReleaseGrace)
	if err != nil {
		return errors.Join(overflow, err)
	}
	if pruned > 0 {
		c.Log.Info("earlier releases no longer listed", "pruned", pruned)
	}
	if c.GatewayPolicy == "" {
		return overflow
	}
	audiences := Audiences(apis, c.GCPAudience, c.Reserved)
	variables, err = AudienceVariables(audiences)
	if err != nil {
		// It fit when applied; the install's settings changed since.
		overflow = errors.Join(overflow, err)
		audiences = map[string][]string{}
		variables, _ = AudienceVariables(audiences)
	}
	variables["apiAudiencesWritten"] = "true"
	changed, err = c.Writer.Write(ctx, c.GatewayPolicy, variables, annotations)
	if err != nil {
		return errors.Join(overflow, err)
	}
	if changed {
		c.Log.Info("gateway token policy written", "policy", c.GatewayPolicy, "serviceAccounts", len(audiences), "release", state.Digest)
	}
	return overflow
}
