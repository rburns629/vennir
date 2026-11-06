// SPDX-License-Identifier: MIT

package policy

import (
	"context"
	"crypto"
	"crypto/sha256"
	"crypto/x509"
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

// KeyID and KeylessID name one signer: a public key (by its DER, PKIX,
// so the same key however its PEM is written), the keyless identity (by
// its issuer and subject). Each release records which of them verified
// it; it's trusted while any of those still is.
func KeyID(pem string) string {
	data := []byte(strings.TrimSpace(pem))
	// One that doesn't parse verifies nothing (verifiers refuses it).
	if key, err := cryptoutils.UnmarshalPEMToPublicKey(data); err == nil {
		if der, err := x509.MarshalPKIXPublicKey(key); err == nil {
			data = der
		}
	}
	sum := sha256.Sum256(data)
	return "key:" + hex.EncodeToString(sum[:])
}

// ErrNotSigned is Verify's answer when every trusted signer was asked and
// none signed the release: definite, unlike a registry or Sigstore's TUF
// repository out of reach (an error without it), which says nothing about
// who signed it.
var ErrNotSigned = errors.New("no trusted signer signed it")

// definite: a verification that failed because of the signatures found
// (none, or none matching), not because they couldn't be read.
func definite(err error) bool {
	var noMatch *cosign.ErrNoMatchingSignatures
	var none *cosign.ErrNoSignaturesFound
	var noCert *cosign.ErrNoCertificateFoundOnSignature
	return errors.As(err, &noMatch) || errors.As(err, &none) || errors.As(err, &noCert)
}

func KeylessID(issuer, subject string) string {
	data, _ := json.Marshal([]string{issuer, subject})
	sum := sha256.Sum256(data)
	return "keyless:" + hex.EncodeToString(sum[:])
}

// IDs are the signers trusted now, each by KeyID or KeylessID, sorted.
func (s *Signers) IDs() []string {
	var ids []string
	for _, k := range s.PublicKeys {
		ids = append(ids, KeyID(k))
	}
	if s.keyless() {
		ids = append(ids, KeylessID(s.KeylessIssuer, s.KeylessSubjectRegExp))
	}
	sort.Strings(ids)
	return ids
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
func (s *Signers) Verify(ctx context.Context, ref name.Digest, opts []remote.Option) ([]string, error) {
	verifiers, err := s.verifiers()
	if err != nil {
		return nil, err
	}
	registry := []ociremote.Option{ociremote.WithRemoteOptions(opts...)}
	type try struct {
		id   string
		opts *cosign.CheckOpts
	}
	var tries []try
	for i, verifier := range verifiers {
		tries = append(tries, try{id: KeyID(s.PublicKeys[i]), opts: &cosign.CheckOpts{
			RegistryClientOpts: registry, SigVerifier: verifier, ClaimVerifier: cosign.SimpleClaimVerifier,
			// Catalog CI's key signatures go to no public log
			// (`cosign sign --tlog-upload=false`), as the console's
			// --insecure-ignore-tlog.
			IgnoreTlog: true, IgnoreSCT: true,
		}})
	}
	var failures []string
	// Whether every failure says who signed it (none of these): when one
	// couldn't be checked at all, the answer isn't ErrNotSigned.
	allDefinite := true
	if s.keyless() {
		trusted, err := s.trustedRoot()
		if err != nil {
			allDefinite = false
			failures = append(failures, "keyless: "+err.Error())
		} else {
			tries = append(tries, try{id: KeylessID(s.KeylessIssuer, s.KeylessSubjectRegExp), opts: &cosign.CheckOpts{
				RegistryClientOpts: registry, TrustedMaterial: trusted, ClaimVerifier: cosign.SimpleClaimVerifier,
				Identities: []cosign.Identity{{Issuer: s.KeylessIssuer, SubjectRegExp: s.KeylessSubjectRegExp}},
				// The Rekor entry the signature carries, checked offline: no
				// look-up in the log.
				Offline: true,
			}})
		}
	}
	// Every one is tried: which signers verified it is what keeps it trusted
	// when the chart stops trusting some (a key rotation).
	var verified []string
	for _, t := range tries {
		if _, _, err := cosign.VerifyImageSignatures(ctx, ref, t.opts); err != nil {
			allDefinite = allDefinite && definite(err)
			failures = append(failures, err.Error())
			continue
		}
		verified = append(verified, t.id)
	}
	if len(verified) > 0 {
		sort.Strings(verified)
		return verified, nil
	}
	if len(tries) == 0 && len(failures) == 0 {
		return nil, fmt.Errorf("no signer is trusted: %w", ErrNotSigned)
	}
	if allDefinite {
		return nil, fmt.Errorf("%s: %w: %s", ref.DigestStr(), ErrNotSigned, strings.Join(failures, "; "))
	}
	return nil, fmt.Errorf("%s couldn't be verified (tried again next pass): %s", ref.DigestStr(), strings.Join(failures, "; "))
}
