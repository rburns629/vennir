// SPDX-License-Identifier: MIT

package policy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ecr"
	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

// Media types of a catalog release (`vennir catalog release`;
// console/src/registry.ts).
const (
	ReleaseMediaType       = "application/vnd.vennir.catalog.release.v1+json"
	ReleaseConfigMediaType = "application/vnd.vennir.catalog.release.config.v1+json"
	// MaxReleaseBytes is the most a release (or its manifest) may be.
	MaxReleaseBytes = 10 << 20
)

var (
	googleRegistry = regexp.MustCompile(`^([a-z0-9-]+-docker\.pkg\.dev|([a-z]+\.)?gcr\.io)$`)
	ecrRegistry    = regexp.MustCompile(`^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$`)
	version        = regexp.MustCompile(`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)
	sha256Pattern  = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

// Registry is how this process reads the registry the release is in: a
// Docker config (DOCKER_CONFIG, a mounted Secret's), its own cloud identity
// for Artifact Registry and GCR (the GKE metadata server's token) or ECR
// (EKS Pod Identity), anonymously otherwise; and mirrors, a host to the
// URL it's read from instead (kind's localhost:5001 is
// http://kind-registry:5000 inside the cluster), as the console's
// registryCheck.mirrors. Never the console's credentials.
type Registry struct {
	Mirrors          map[string]string
	GCPMetadataToken bool
	ECRToken         bool
	Timeout          time.Duration

	once     sync.Once
	keychain authn.Keychain
}

// Reference is ref as it's read: its registry host swapped for its
// mirror's, when it has one.
func (r *Registry) Reference(ref string) (name.Reference, error) {
	parsed, err := name.ParseReference(ref, name.StrictValidation)
	if err != nil {
		return nil, fmt.Errorf("catalog release %s: %w", ref, err)
	}
	host := parsed.Context().RegistryStr()
	mirror, ok := r.Mirrors[host]
	if !ok {
		return parsed, nil
	}
	scheme, mirrorHost, ok := strings.Cut(mirror, "://")
	if !ok || (scheme != "http" && scheme != "https") || mirrorHost == "" || strings.Contains(mirrorHost, "/") {
		return nil, fmt.Errorf("registry mirror for %s: %q isn't http(s)://host[:port]", host, mirror)
	}
	var opts []name.Option
	if scheme == "http" {
		opts = append(opts, name.Insecure)
	}
	rest := strings.TrimPrefix(parsed.Name(), host)
	return name.ParseReference(mirrorHost+rest, opts...)
}

// Options are the registry client's options: its sign-in, and ctx.
func (r *Registry) Options(ctx context.Context) []remote.Option {
	r.once.Do(func() {
		origins := map[string]string{}
		for host, mirror := range r.Mirrors {
			_, mirrorHost, _ := strings.Cut(mirror, "://")
			origins[mirrorHost] = host
		}
		chain := []authn.Keychain{authn.DefaultKeychain}
		if r.GCPMetadataToken {
			chain = append(chain, &gcpMetadataKeychain{timeout: r.timeout()})
		}
		if r.ECRToken {
			chain = append(chain, &ecrKeychain{timeout: r.timeout(), tokens: map[string]ecrCredential{}})
		}
		r.keychain = &mirroredKeychain{origins: origins, inner: authn.NewMultiKeychain(chain...)}
	})
	return []remote.Option{remote.WithContext(ctx), remote.WithAuthFromKeychain(r.keychain)}
}

func (r *Registry) timeout() time.Duration {
	if r.Timeout <= 0 {
		return 30 * time.Second
	}
	return r.Timeout
}

// Follow is the reference the release is read at now: ref itself, or with
// newest, its repository's newest version (a vX.Y.Z tag, as `vennir catalog
// promote` makes), as console/src/catalogSync.ts follows it.
func (r *Registry) Follow(ctx context.Context, ref string, newest bool) (string, error) {
	if !newest {
		return ref, nil
	}
	parsed, err := name.ParseReference(ref, name.StrictValidation)
	if err != nil {
		return "", fmt.Errorf("catalog release %s: %w", ref, err)
	}
	read, err := r.Reference(parsed.Context().Name() + ":latest")
	if err != nil {
		return "", err
	}
	tags, err := remote.List(read.Context(), r.Options(ctx)...)
	if err != nil {
		return "", fmt.Errorf("the release's tags: %w", err)
	}
	newestTag := NewestVersion(tags)
	if newestTag == "" {
		return "", fmt.Errorf("%s has no version yet (a vX.Y.Z tag in the catalog repository makes one)", parsed.Context().Name())
	}
	return parsed.Context().Name() + ":" + newestTag, nil
}

// NewestVersion is the newest of tags that's a version, "" when none is.
func NewestVersion(tags []string) string {
	newest := ""
	var best [3]int
	for _, tag := range tags {
		m := version.FindStringSubmatch(tag)
		if m == nil {
			continue
		}
		var parts [3]int
		for i := range parts {
			parts[i], _ = strconv.Atoi(m[i+1])
		}
		if newest == "" || parts[0] > best[0] || (parts[0] == best[0] && (parts[1] > best[1] || (parts[1] == best[1] && parts[2] > best[2]))) {
			newest, best = tag, parts
		}
	}
	return newest
}

// Fetched is a release as read: its manifest's digest (what's signed), and
// its one layer, the release as JSON. Every byte read is checked against
// the digest that names it.
type Fetched struct {
	Digest string
	JSON   []byte
}

// Digest is the manifest digest ref names now, read without the release
// itself (a look that finds nothing new reads only this).
func (r *Registry) Digest(ctx context.Context, ref string) (string, error) {
	read, err := r.Reference(ref)
	if err != nil {
		return "", err
	}
	_, digest, err := r.manifest(ctx, read)
	return digest, err
}

func (r *Registry) manifest(ctx context.Context, read name.Reference) ([]byte, string, error) {
	descriptor, err := remote.Get(read, r.Options(ctx)...)
	if err != nil {
		return nil, "", fmt.Errorf("the release's manifest: %w", err)
	}
	if len(descriptor.Manifest) > MaxReleaseBytes {
		return nil, "", fmt.Errorf("the release's manifest: larger than %d bytes", MaxReleaseBytes)
	}
	digest := sha256Digest(descriptor.Manifest)
	if pinned, ok := read.(name.Digest); ok && pinned.DigestStr() != digest {
		return nil, "", fmt.Errorf("the release's manifest isn't %s", pinned.DigestStr())
	}
	return descriptor.Manifest, digest, nil
}

// Fetch reads the release ref names, by the digest its manifest has.
func (r *Registry) Fetch(ctx context.Context, ref string) (Fetched, error) {
	read, err := r.Reference(ref)
	if err != nil {
		return Fetched{}, err
	}
	raw, digest, err := r.manifest(ctx, read)
	if err != nil {
		return Fetched{}, err
	}
	var manifest struct {
		Config struct {
			MediaType string `json:"mediaType"`
		} `json:"config"`
		Layers []struct {
			MediaType string `json:"mediaType"`
			Digest    string `json:"digest"`
		} `json:"layers"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return Fetched{}, fmt.Errorf("%s: the manifest isn't JSON", ref)
	}
	if manifest.Config.MediaType != ReleaseConfigMediaType {
		return Fetched{}, fmt.Errorf("%s isn't a catalog release (its config is %q)", ref, manifest.Config.MediaType)
	}
	layer := ""
	for _, l := range manifest.Layers {
		if l.MediaType == ReleaseMediaType {
			layer = l.Digest
			break
		}
	}
	if !sha256Pattern.MatchString(layer) {
		return Fetched{}, fmt.Errorf("%s has no release layer", ref)
	}
	blob, err := remote.Layer(read.Context().Digest(layer), r.Options(ctx)...)
	if err != nil {
		return Fetched{}, fmt.Errorf("the release: %w", err)
	}
	body, err := blob.Compressed()
	if err != nil {
		return Fetched{}, fmt.Errorf("the release: %w", err)
	}
	defer func() { _ = body.Close() }()
	data, err := io.ReadAll(io.LimitReader(body, MaxReleaseBytes+1))
	if err != nil {
		return Fetched{}, fmt.Errorf("the release: %w", err)
	}
	if len(data) > MaxReleaseBytes {
		return Fetched{}, fmt.Errorf("the release: larger than %d bytes", MaxReleaseBytes)
	}
	if sha256Digest(data) != layer {
		return Fetched{}, errors.New("the release's content doesn't match its digest")
	}
	return Fetched{Digest: digest, JSON: data}, nil
}

func sha256Digest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// mirroredKeychain signs in to a mirror as to the registry it mirrors.
type mirroredKeychain struct {
	origins map[string]string
	inner   authn.Keychain
}

type registryHost string

func (h registryHost) String() string      { return string(h) }
func (h registryHost) RegistryStr() string { return string(h) }

func (k *mirroredKeychain) Resolve(resource authn.Resource) (authn.Authenticator, error) {
	if origin, ok := k.origins[resource.RegistryStr()]; ok {
		return k.inner.Resolve(registryHost(origin))
	}
	return k.inner.Resolve(resource)
}

// gcpMetadataKeychain signs in to Artifact Registry and GCR with the GKE
// metadata server's access token: this Pod's ServiceAccount's Workload
// Identity.
type gcpMetadataKeychain struct {
	timeout time.Duration
	mu      sync.Mutex
	token   string
	expires time.Time
}

const gcpMetadataTokenURL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

func (k *gcpMetadataKeychain) Resolve(resource authn.Resource) (authn.Authenticator, error) {
	if !googleRegistry.MatchString(resource.RegistryStr()) {
		return authn.Anonymous, nil
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.token == "" || time.Until(k.expires) < 5*time.Minute {
		ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
		defer cancel()
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, gcpMetadataTokenURL, nil)
		request.Header.Set("Metadata-Flavor", "Google")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return nil, fmt.Errorf("the GKE metadata server's token: %w", err)
		}
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("the GKE metadata server's token: it answered %d", response.StatusCode)
		}
		var body struct {
			AccessToken string `json:"access_token"`
			ExpiresIn   int    `json:"expires_in"`
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&body); err != nil || body.AccessToken == "" {
			return nil, errors.New("the GKE metadata server's token: no access_token")
		}
		k.token, k.expires = body.AccessToken, time.Now().Add(time.Duration(body.ExpiresIn)*time.Second)
	}
	return &authn.Basic{Username: "oauth2accesstoken", Password: k.token}, nil
}

// ecrKeychain signs in to ECR with its registry token, from this Pod's AWS
// identity (EKS Pod Identity; the SDK finds it).
type ecrKeychain struct {
	timeout time.Duration
	mu      sync.Mutex
	tokens  map[string]ecrCredential
}

type ecrCredential struct {
	username, password string
	expires            time.Time
}

func (k *ecrKeychain) Resolve(resource authn.Resource) (authn.Authenticator, error) {
	m := ecrRegistry.FindStringSubmatch(resource.RegistryStr())
	if m == nil {
		return authn.Anonymous, nil
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	key := m[1] + "/" + m[2]
	if c, ok := k.tokens[key]; ok && time.Until(c.expires) > 10*time.Minute {
		return &authn.Basic{Username: c.username, Password: c.password}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(m[2]))
	if err != nil {
		return nil, fmt.Errorf("ECR's token: %w", err)
	}
	out, err := ecr.NewFromConfig(cfg).GetAuthorizationToken(ctx, &ecr.GetAuthorizationTokenInput{})
	if err != nil {
		return nil, fmt.Errorf("ECR's token: %w", err)
	}
	if len(out.AuthorizationData) == 0 || out.AuthorizationData[0].AuthorizationToken == nil {
		return nil, errors.New("ECR returned no authorization token")
	}
	decoded, err := base64.StdEncoding.DecodeString(aws.ToString(out.AuthorizationData[0].AuthorizationToken))
	if err != nil {
		return nil, errors.New("ECR's token isn't base64")
	}
	username, password, _ := bytes.Cut(decoded, []byte(":"))
	expires := time.Now().Add(time.Hour)
	if out.AuthorizationData[0].ExpiresAt != nil {
		expires = *out.AuthorizationData[0].ExpiresAt
	}
	k.tokens[key] = ecrCredential{username: string(username), password: string(password), expires: expires}
	return &authn.Basic{Username: string(username), Password: string(password)}, nil
}
