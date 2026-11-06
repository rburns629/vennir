// SPDX-License-Identifier: MIT

package policy

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/static"
	"github.com/google/go-containerregistry/pkg/v1/types"
	"github.com/sigstore/cosign/v3/pkg/oci/mutate"
	ociremote "github.com/sigstore/cosign/v3/pkg/oci/remote"
	ocistatic "github.com/sigstore/cosign/v3/pkg/oci/static"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore/pkg/cryptoutils"
	"github.com/sigstore/sigstore/pkg/signature"
	sigpayload "github.com/sigstore/sigstore/pkg/signature/payload"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	catalogv1 "github.com/rburns629/vennir/kernel/internal/gen/vennir/catalog/v1"
)

// testRegistry is an in-memory registry, read as catalog.example (a
// mirror, as kind's localhost:5001 is read).
func testRegistry(t *testing.T) *Registry {
	t.Helper()
	server := httptest.NewServer(registry.New())
	t.Cleanup(server.Close)
	return &Registry{Mirrors: map[string]string{"catalog.example": server.URL}}
}

type rawManifest struct {
	data      []byte
	mediaType types.MediaType
}

func (m rawManifest) RawManifest() ([]byte, error) { return m.data, nil }
func (m rawManifest) MediaType() (types.MediaType, error) {
	return m.mediaType, nil
}

// pushRelease pushes a catalog release as `vennir catalog release` does (an
// OCI artifact: a config and one JSON layer) at ref, and returns its digest.
func pushRelease(t *testing.T, r *Registry, ref string, release *catalogv1.Release) string {
	t.Helper()
	ctx := context.Background()
	read, err := r.Reference(ref)
	if err != nil {
		t.Fatal(err)
	}
	body, err := protojson.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	config := static.NewLayer([]byte(`{}`), ReleaseConfigMediaType)
	layer := static.NewLayer(body, ReleaseMediaType)
	if err := remote.WriteLayer(read.Context(), config, r.Options(ctx)...); err != nil {
		t.Fatal(err)
	}
	if err := remote.WriteLayer(read.Context(), layer, r.Options(ctx)...); err != nil {
		t.Fatal(err)
	}
	configDigest, _ := config.Digest()
	layerDigest, _ := layer.Digest()
	manifest, _ := json.Marshal(map[string]any{
		"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
		"config": map[string]any{"mediaType": ReleaseConfigMediaType, "digest": configDigest.String(), "size": 2},
		"layers": []any{map[string]any{"mediaType": ReleaseMediaType, "digest": layerDigest.String(), "size": len(body)}},
	})
	if err := remote.Put(read, rawManifest{data: manifest, mediaType: types.OCIManifestSchema1}, r.Options(ctx)...); err != nil {
		t.Fatal(err)
	}
	return sha256Digest(manifest)
}

// testKey is a signing key as `cosign generate-key-pair` makes one, and its
// public half as the chart's signature.publicKeys take it.
func testKey(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, err := cryptoutils.MarshalPublicKeyToPEM(key.Public())
	if err != nil {
		t.Fatal(err)
	}
	return key, string(public)
}

// keySign signs repository@digest as `cosign sign --key --tlog-upload=false
// --new-bundle-format=false` does: a simple-signing payload for the digest,
// in a .sig image beside it.
func keySign(t *testing.T, r *Registry, repository, digest string, key *ecdsa.PrivateKey) {
	t.Helper()
	ctx := context.Background()
	read, err := r.Reference(repository + "@" + digest)
	if err != nil {
		t.Fatal(err)
	}
	pinnedRef := read.(name.Digest)
	payload, err := sigpayload.Cosign{Image: pinnedRef}.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	signer, err := signature.LoadECDSASignerVerifier(key, crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := signer.SignMessage(strings.NewReader(string(payload)))
	if err != nil {
		t.Fatal(err)
	}
	ociSig, err := ocistatic.NewSignature(payload, base64.StdEncoding.EncodeToString(sig))
	if err != nil {
		t.Fatal(err)
	}
	opts := []ociremote.Option{ociremote.WithRemoteOptions(r.Options(ctx)...)}
	entity, err := ociremote.SignedEntity(pinnedRef, opts...)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := mutate.AttachSignatureToEntity(entity, ociSig)
	if err != nil {
		t.Fatal(err)
	}
	if err := ociremote.WriteSignatures(pinnedRef.Context(), signed, opts...); err != nil {
		t.Fatal(err)
	}
}

func verifyAt(t *testing.T, r *Registry, signers *Signers, repository, digest string) error {
	t.Helper()
	read, err := r.Reference(repository + "@" + digest)
	if err != nil {
		t.Fatal(err)
	}
	return signers.Verify(context.Background(), read.(name.Digest), r.Options(context.Background()))
}

func testRelease(products ...*catalogv1.ProductAction) *catalogv1.Release {
	return &catalogv1.Release{Commit: "abc", CreatedAt: timestamppb.New(time.Now()),
		Teams: []*catalogv1.Team{{Name: "a"}, {Name: "b"}}, Products: products}
}

func TestAReleaseSignedWithATrustedKeyIsVerified(t *testing.T) {
	r := testRegistry(t)
	key, public := testKey(t)
	digest := pushRelease(t, r, "catalog.example/catalog-release:latest", testRelease())
	keySign(t, r, "catalog.example/catalog-release", digest, key)
	if err := verifyAt(t, r, &Signers{PublicKeys: []string{public}}, "catalog.example/catalog-release", digest); err != nil {
		t.Fatalf("a release its trusted key signed: %v", err)
	}
	// Any one of the keys trusted will do.
	_, other := testKey(t)
	if err := verifyAt(t, r, &Signers{PublicKeys: []string{other, public}}, "catalog.example/catalog-release", digest); err != nil {
		t.Fatalf("with another key trusted first: %v", err)
	}
}

func TestAReleaseNoTrustedSignerSignedIsRefused(t *testing.T) {
	r := testRegistry(t)
	key, _ := testKey(t)
	_, trusted := testKey(t)
	unsigned := pushRelease(t, r, "catalog.example/catalog-release:unsigned", testRelease())
	if err := verifyAt(t, r, &Signers{PublicKeys: []string{trusted}}, "catalog.example/catalog-release", unsigned); err == nil {
		t.Fatal("an unsigned release was verified")
	}
	// Signed, by a key the chart doesn't trust.
	other := pushRelease(t, r, "catalog.example/catalog-release:other", testRelease(&catalogv1.ProductAction{Name: "x"}))
	keySign(t, r, "catalog.example/catalog-release", other, key)
	if err := verifyAt(t, r, &Signers{PublicKeys: []string{trusted}}, "catalog.example/catalog-release", other); err == nil {
		t.Fatal("a release an untrusted key signed was verified")
	}
	// A trusted key's signature of another digest, copied beside this one.
	signedDigest := pushRelease(t, r, "catalog.example/catalog-release:signed", testRelease(&catalogv1.ProductAction{Name: "y"}))
	trustedKey, trustedPublic := testKey(t)
	keySign(t, r, "catalog.example/catalog-release", signedDigest, trustedKey)
	tampered := pushRelease(t, r, "catalog.example/catalog-release:tampered", testRelease(&catalogv1.ProductAction{Name: "z"}))
	ctx := context.Background()
	from, _ := r.Reference("catalog.example/catalog-release:sha256-" + signedDigest[7:] + ".sig")
	to, _ := r.Reference("catalog.example/catalog-release:sha256-" + tampered[7:] + ".sig")
	descriptor, err := remote.Get(from, r.Options(ctx)...)
	if err != nil {
		t.Fatal(err)
	}
	if err := remote.Put(to, rawManifest{data: descriptor.Manifest, mediaType: descriptor.MediaType}, r.Options(ctx)...); err != nil {
		t.Fatal(err)
	}
	if err := verifyAt(t, r, &Signers{PublicKeys: []string{trustedPublic}}, "catalog.example/catalog-release", tampered); err == nil {
		t.Fatal("another digest's signature verified this one")
	}
}

// The keyless fixture (testdata/keyless) is a real one: the .sig image of
// cosign v2.5.3's release image (ghcr.io/sigstore/cosign/cosign@sha256:f194…),
// signed keyless by Sigstore's release identity (a Fulcio certificate, its
// Rekor entry in the signature's bundle annotation), and the public-good
// instance's trusted root as Sigstore's TUF repository served it. Checked
// offline, as `kernel policy` checks one (the Rekor entry carried, not
// looked up).
const keylessDigest = "sha256:f1946d0f30fc8e3777b02f2201e02efdba9fe38f4918162f937052fac98e083f"

func pushKeylessFixture(t *testing.T, r *Registry) {
	t.Helper()
	ctx := context.Background()
	dir := filepath.Join("testdata", "keyless")
	repo, _ := r.Reference("catalog.example/cosign:latest")
	files, err := filepath.Glob(filepath.Join(dir, "*-*"))
	if err != nil || len(files) == 0 {
		t.Fatalf("the keyless fixture: %v", err)
	}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if err := remote.WriteLayer(repo.Context(), static.NewLayer(data, types.OCIUncompressedLayer), r.Options(ctx)...); err != nil {
			t.Fatal(err)
		}
	}
	manifest, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var mediaType struct {
		MediaType types.MediaType `json:"mediaType"`
	}
	_ = json.Unmarshal(manifest, &mediaType)
	tag, _ := r.Reference("catalog.example/cosign:sha256-" + keylessDigest[7:] + ".sig")
	if err := remote.Put(tag, rawManifest{data: manifest, mediaType: mediaType.MediaType}, r.Options(ctx)...); err != nil {
		t.Fatal(err)
	}
}

func fixtureRoot(t *testing.T) root.TrustedMaterial {
	t.Helper()
	trusted, err := root.NewTrustedRootFromPath(filepath.Join("testdata", "keyless", "trusted_root.json"))
	if err != nil {
		t.Fatal(err)
	}
	return trusted
}

func TestAKeylessSignatureFromTheTrustedIdentityIsVerified(t *testing.T) {
	r := testRegistry(t)
	pushKeylessFixture(t, r)
	signers := &Signers{KeylessIssuer: "https://accounts.google.com",
		KeylessSubjectRegExp: `^keyless@projectsigstore\.iam\.gserviceaccount\.com$`, TrustedRoot: fixtureRoot(t)}
	if err := verifyAt(t, r, signers, "catalog.example/cosign", keylessDigest); err != nil {
		t.Fatalf("the keyless fixture: %v", err)
	}
}

func TestAKeylessSignatureFromAnotherIdentityIsRefused(t *testing.T) {
	r := testRegistry(t)
	pushKeylessFixture(t, r)
	for name, signers := range map[string]*Signers{
		"another subject": {KeylessIssuer: "https://accounts.google.com", KeylessSubjectRegExp: `^someone@example\.com$`, TrustedRoot: fixtureRoot(t)},
		"another issuer": {KeylessIssuer: "https://token.actions.githubusercontent.com",
			KeylessSubjectRegExp: `^keyless@projectsigstore\.iam\.gserviceaccount\.com$`, TrustedRoot: fixtureRoot(t)},
	} {
		if err := verifyAt(t, r, signers, "catalog.example/cosign", keylessDigest); err == nil {
			t.Errorf("%s: verified", name)
		}
	}
	// Signed for one digest, not another's.
	signers := &Signers{KeylessIssuer: "https://accounts.google.com",
		KeylessSubjectRegExp: `^keyless@projectsigstore\.iam\.gserviceaccount\.com$`, TrustedRoot: fixtureRoot(t)}
	ctx := context.Background()
	from, _ := r.Reference("catalog.example/cosign:sha256-" + keylessDigest[7:] + ".sig")
	other := "sha256:" + strings.Repeat("1", 64)
	to, _ := r.Reference("catalog.example/cosign:sha256-" + other[7:] + ".sig")
	descriptor, err := remote.Get(from, r.Options(ctx)...)
	if err != nil {
		t.Fatal(err)
	}
	if err := remote.Put(to, rawManifest{data: descriptor.Manifest, mediaType: descriptor.MediaType}, r.Options(ctx)...); err != nil {
		t.Fatal(err)
	}
	if err := verifyAt(t, r, signers, "catalog.example/cosign", other); err == nil {
		t.Error("another digest's keyless signature verified this one")
	}
}

func TestSignersAreCheckedAtStartup(t *testing.T) {
	_, public := testKey(t)
	for name, c := range map[string]struct {
		signers *Signers
		ok      bool
	}{
		"a key":                   {&Signers{PublicKeys: []string{public}}, true},
		"keyless":                 {&Signers{KeylessIssuer: "https://i", KeylessSubjectRegExp: "^s$"}, true},
		"not a key":               {&Signers{PublicKeys: []string{"-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----"}}, false},
		"keyless without subject": {&Signers{KeylessIssuer: "https://i"}, false},
	} {
		if err := c.signers.Check(); (err == nil) != c.ok {
			t.Errorf("%s: %v", name, err)
		}
	}
	// Who's trusted, in any order: another key, or another identity, is another fingerprint.
	_, other := testKey(t)
	a := (&Signers{PublicKeys: []string{public, other}}).Fingerprint()
	if a != (&Signers{PublicKeys: []string{other + "\n", public}}).Fingerprint() ||
		a == (&Signers{PublicKeys: []string{public}}).Fingerprint() ||
		a == (&Signers{PublicKeys: []string{public, other}, KeylessIssuer: "https://i", KeylessSubjectRegExp: "^s$"}).Fingerprint() {
		t.Error("Fingerprint")
	}
}

func TestAReleaseIsReadByItsDigestAndChecked(t *testing.T) {
	r := testRegistry(t)
	release := testRelease(&catalogv1.ProductAction{Name: "a-db-create", Team: "a"})
	digest := pushRelease(t, r, "catalog.example/catalog-release:v1.2.0", release)
	got, err := r.Digest(context.Background(), "catalog.example/catalog-release:v1.2.0")
	if err != nil || got != digest {
		t.Fatalf("digest: %s, %v", got, err)
	}
	fetched, err := r.Fetch(context.Background(), "catalog.example/catalog-release@"+digest)
	if err != nil || fetched.Digest != digest {
		t.Fatalf("fetch: %v", err)
	}
	read := &catalogv1.Release{}
	if err := protojson.Unmarshal(fetched.JSON, read); err != nil || read.GetProducts()[0].GetName() != "a-db-create" {
		t.Fatalf("the release read: %v", err)
	}
	if _, err := r.Fetch(context.Background(), "catalog.example/catalog-release@sha256:"+strings.Repeat("0", 64)); err == nil {
		t.Fatal("a digest that isn't there was read")
	}
	// The newest version among the repository's tags.
	pushRelease(t, r, "catalog.example/catalog-release:v1.10.0", testRelease())
	pushRelease(t, r, "catalog.example/catalog-release:latest", testRelease())
	followed, err := r.Follow(context.Background(), "catalog.example/catalog-release:latest", true)
	if err != nil || followed != "catalog.example/catalog-release:v1.10.0" {
		t.Fatalf("newest: %s, %v", followed, err)
	}
}
