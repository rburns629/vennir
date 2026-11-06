// SPDX-License-Identifier: MIT

package policy

import (
	"context"
	"crypto"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/sigstore/cosign/v3/pkg/cosign"
	ociremote "github.com/sigstore/cosign/v3/pkg/oci/remote"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/tuf"
	"github.com/sigstore/sigstore/pkg/cryptoutils"
	"github.com/sigstore/sigstore/pkg/signature"
)

// Signers are who may sign a catalog release, as the kernel chart trusts
// them (never the console): any of PublicKeys (PEM; catalog CI's key or
// KMS signing, which writes to no transparency log), or a keyless identity
// (Sigstore's Fulcio certificate for an OIDC issuer and a subject matching
// SubjectRegExp, logged in Rekor). As console/src/catalogSync.ts's
// verifications: each key tried in turn, then keyless.
type Signers struct {
	PublicKeys           []string
	KeylessIssuer        string
	KeylessSubjectRegExp string
	// TrustedRoot is Sigstore's trusted root for keyless signatures; nil:
	// the public-good instance's, from its TUF repository (TUFCache).
	TrustedRoot root.TrustedMaterial
	TUFCache    string

	once     sync.Once
	verifier []signature.Verifier
	loadErr  error
	tufRoot  root.TrustedMaterial
	tufErr   error
	tufMu    sync.Mutex
}

func (s *Signers) keyless() bool { return s.KeylessIssuer != "" && s.KeylessSubjectRegExp != "" }

// Fingerprint names who's trusted (the keys, in any order, and the keyless
// identity): a release applied under other signers is verified again
// before it's trusted.
func (s *Signers) Fingerprint() string {
	keys := make([]string, 0, len(s.PublicKeys))
	for _, k := range s.PublicKeys {
		keys = append(keys, strings.TrimSpace(k))
	}
	sort.Strings(keys)
	data, _ := json.Marshal([]any{keys, s.KeylessIssuer, s.KeylessSubjectRegExp})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// Check is what's wrong with the signers as configured: a key that isn't a
// public key, a keyless identity with only one half.
func (s *Signers) Check() error {
	if (s.KeylessIssuer == "") != (s.KeylessSubjectRegExp == "") {
		return errors.New("a keyless signer needs both its issuer and its subject's regular expression")
	}
	_, err := s.verifiers()
	return err
}

func (s *Signers) verifiers() ([]signature.Verifier, error) {
	s.once.Do(func() {
		for i, pem := range s.PublicKeys {
			key, err := cryptoutils.UnmarshalPEMToPublicKey([]byte(strings.TrimSpace(pem)))
			if err != nil {
				s.loadErr = fmt.Errorf("public key %d: %w", i+1, err)
				return
			}
			verifier, err := signature.LoadVerifier(key, crypto.SHA256)
			if err != nil {
				s.loadErr = fmt.Errorf("public key %d: %w", i+1, err)
				return
			}
			s.verifier = append(s.verifier, verifier)
		}
	})
	return s.verifier, s.loadErr
}

// trustedRoot is Sigstore's, read once from its TUF repository and kept
// fresh by sigstore-go (a failed read is tried again next time).
func (s *Signers) trustedRoot() (root.TrustedMaterial, error) {
	if s.TrustedRoot != nil {
		return s.TrustedRoot, nil
	}
	s.tufMu.Lock()
	defer s.tufMu.Unlock()
	if s.tufRoot != nil {
		return s.tufRoot, nil
	}
	opts := tuf.DefaultOptions()
	if s.TUFCache != "" {
		opts.CachePath = s.TUFCache
	}
	trusted, err := root.NewLiveTrustedRoot(opts)
	if err != nil {
		return nil, fmt.Errorf("Sigstore's trusted root: %w", err)
	}
	s.tufRoot = trusted
	return trusted, nil
}

// Verify checks that a trusted signer signed the release at ref (pinned by
// digest), in cosign's signature format (a .sig tag beside it), which
// catalog CI signs in (`--new-bundle-format=false`). Nil when one did; an
// error saying why none did otherwise.
func (s *Signers) Verify(ctx context.Context, ref name.Digest, opts []remote.Option) error {
	verifiers, err := s.verifiers()
	if err != nil {
		return err
	}
	registry := []ociremote.Option{ociremote.WithRemoteOptions(opts...)}
	var tries []*cosign.CheckOpts
	for _, verifier := range verifiers {
		tries = append(tries, &cosign.CheckOpts{
			RegistryClientOpts: registry, SigVerifier: verifier, ClaimVerifier: cosign.SimpleClaimVerifier,
			// Catalog CI's key signatures go to no public log
			// (`cosign sign --tlog-upload=false`), as the console's
			// --insecure-ignore-tlog.
			IgnoreTlog: true, IgnoreSCT: true,
		})
	}
	var failures []string
	if s.keyless() {
		trusted, err := s.trustedRoot()
		if err != nil {
			failures = append(failures, "keyless: "+err.Error())
		} else {
			tries = append(tries, &cosign.CheckOpts{
				RegistryClientOpts: registry, TrustedMaterial: trusted, ClaimVerifier: cosign.SimpleClaimVerifier,
				Identities: []cosign.Identity{{Issuer: s.KeylessIssuer, SubjectRegExp: s.KeylessSubjectRegExp}},
				// The Rekor entry the signature carries, checked offline: no
				// look-up in the log.
				Offline: true,
			})
		}
	}
	for _, try := range tries {
		_, _, err := cosign.VerifyImageSignatures(ctx, ref, try)
		if err == nil {
			return nil
		}
		failures = append(failures, err.Error())
	}
	if len(tries) == 0 && len(failures) == 0 {
		return errors.New("no signer is trusted")
	}
	return fmt.Errorf("no trusted signer signed %s: %s", ref.DigestStr(), strings.Join(failures, "; "))
}
