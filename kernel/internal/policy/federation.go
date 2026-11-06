// SPDX-License-Identifier: MIT

package policy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/ecr"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/google/go-containerregistry/pkg/authn"
)

// Federation is how kernel policy reads another install's catalog on
// another cloud, or in another AWS account, with no stored key: its own
// ServiceAccount's token, projected for the other side (TokenFile), is
// exchanged there for a short-lived credential, as the console's
// registryFederation.ts does for itself (never borrowing the console's):
//   - Google Artifact Registry (GCPProvider): at Google's STS for an access
//     token (Workload Identity Federation), used as is or to impersonate
//     GCPServiceAccount;
//   - Amazon ECR (AWSRoleArn): AssumeRoleWithWebIdentity for the owner's
//     role, whose credentials ask ECR for its registry token.
//
// The owner's `vennir catalog grant` trusts this ServiceAccount beside the
// console's. Only Hosts are signed in to so.
type Federation struct {
	GCPProvider, GCPServiceAccount string
	AWSRoleArn                     string
	Hosts                          []string
	TokenFile                      string
}

// Endpoints Google's exchange uses; tests point them elsewhere.
var (
	gcpSTSURL         = "https://sts.googleapis.com/v1/token"
	gcpCredentialsURL = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/%s:generateAccessToken"
)

const gcpScope = "https://www.googleapis.com/auth/cloud-platform"

// refreshBefore is how long before a credential expires it's replaced.
const refreshBefore = 15 * time.Minute

// federatedKeychain signs in to Federation.Hosts by federation, and to
// nothing else (anonymous: the next keychain's).
type federatedKeychain struct {
	f       Federation
	timeout time.Duration
	// assume is AWS's web identity exchange, the SDK's; tests replace it.
	assume func(ctx context.Context, region string) (aws.CredentialsProvider, error)

	mu      sync.Mutex
	gcp     ecrCredential
	ecr     map[string]ecrCredential
	ecrRole map[string]aws.CredentialsProvider
}

func newFederatedKeychain(f Federation, timeout time.Duration) *federatedKeychain {
	k := &federatedKeychain{f: f, timeout: timeout, ecr: map[string]ecrCredential{}, ecrRole: map[string]aws.CredentialsProvider{}}
	k.assume = k.webIdentity
	return k
}

func (k *federatedKeychain) Resolve(resource authn.Resource) (authn.Authenticator, error) {
	host := resource.RegistryStr()
	if !slices.Contains(k.f.Hosts, host) {
		return authn.Anonymous, nil
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	if k.f.AWSRoleArn != "" {
		c, err := k.ecrCredential(ctx, host)
		if err != nil {
			return nil, err
		}
		return &authn.Basic{Username: c.username, Password: c.password}, nil
	}
	if k.gcp.password == "" || time.Until(k.gcp.expires) < refreshBefore {
		token, expires, err := k.gcpToken(ctx)
		if err != nil {
			return nil, err
		}
		k.gcp = ecrCredential{username: "oauth2accesstoken", password: token, expires: expires}
	}
	return &authn.Basic{Username: k.gcp.username, Password: k.gcp.password}, nil
}

// projectedToken is this Pod's ServiceAccount token for the other side's
// audience, as the kubelet keeps it fresh in TokenFile.
func (k *federatedKeychain) projectedToken() (string, error) {
	raw, err := os.ReadFile(k.f.TokenFile)
	if err != nil {
		return "", fmt.Errorf("the projected token for federation: %w", err)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", errors.New("the projected token for federation is empty")
	}
	return token, nil
}

// gcpToken exchanges the projected token at Google's STS, then, with
// GCPServiceAccount, impersonates it.
func (k *federatedKeychain) gcpToken(ctx context.Context) (string, time.Time, error) {
	subject, err := k.projectedToken()
	if err != nil {
		return "", time.Time{}, err
	}
	var exchanged struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := postJSON(ctx, gcpSTSURL, "", map[string]any{
		"grantType":          "urn:ietf:params:oauth:grant-type:token-exchange",
		"audience":           "//iam.googleapis.com/" + k.f.GCPProvider,
		"scope":              gcpScope,
		"requestedTokenType": "urn:ietf:params:oauth:token-type:access_token",
		"subjectTokenType":   "urn:ietf:params:oauth:token-type:jwt",
		"subjectToken":       subject,
	}, &exchanged); err != nil {
		return "", time.Time{}, err
	}
	if exchanged.AccessToken == "" {
		return "", time.Time{}, errors.New("google's STS returned no access token")
	}
	if k.f.GCPServiceAccount == "" {
		lifetime := time.Duration(exchanged.ExpiresIn) * time.Second
		if lifetime <= 0 {
			lifetime = time.Hour
		}
		return exchanged.AccessToken, time.Now().Add(lifetime), nil
	}
	var impersonated struct {
		AccessToken string `json:"accessToken"`
		ExpireTime  string `json:"expireTime"`
	}
	if err := postJSON(ctx, fmt.Sprintf(gcpCredentialsURL, url.PathEscape(k.f.GCPServiceAccount)), exchanged.AccessToken,
		map[string]any{"scope": []string{gcpScope}, "lifetime": "3600s"}, &impersonated); err != nil {
		return "", time.Time{}, err
	}
	if impersonated.AccessToken == "" {
		return "", time.Time{}, errors.New("IAM Credentials returned no access token")
	}
	expires, err := time.Parse(time.RFC3339, impersonated.ExpireTime)
	if err != nil {
		expires = time.Now().Add(time.Hour)
	}
	return impersonated.AccessToken, expires, nil
}

// postJSON posts body to endpoint (with bearer, when set) and reads its
// JSON answer into out. A refusal's body says why (an audience, a binding)
// and never echoes the token sent.
func postJSON(ctx context.Context, endpoint, bearer string, body, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	host := request.URL.Host
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return fmt.Errorf("%s: %w", host, err)
	}
	defer func() { _ = response.Body.Close() }()
	answer, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("%s: %w", host, err)
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %d: %.300s", host, response.StatusCode, answer)
	}
	if err := json.Unmarshal(answer, out); err != nil {
		return fmt.Errorf("%s's answer isn't JSON", host)
	}
	return nil
}

// ecrCredential is ECR's registry token for host, as the owner's role:
// kept until refreshBefore it expires.
func (k *federatedKeychain) ecrCredential(ctx context.Context, host string) (ecrCredential, error) {
	m := ecrRegistry.FindStringSubmatch(host)
	if m == nil {
		return ecrCredential{}, fmt.Errorf("%s isn't an Amazon ECR registry", host)
	}
	region := m[2]
	if c, ok := k.ecr[region]; ok && time.Until(c.expires) > refreshBefore {
		return c, nil
	}
	role, ok := k.ecrRole[region]
	if !ok {
		var err error
		if role, err = k.assume(ctx, region); err != nil {
			return ecrCredential{}, err
		}
		k.ecrRole[region] = role
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region), awsconfig.WithCredentialsProvider(role))
	if err != nil {
		return ecrCredential{}, fmt.Errorf("ECR's token: %w", err)
	}
	out, err := ecr.NewFromConfig(cfg).GetAuthorizationToken(ctx, &ecr.GetAuthorizationTokenInput{})
	if err != nil {
		return ecrCredential{}, fmt.Errorf("ECR's token, as %s: %w", k.f.AWSRoleArn, err)
	}
	if len(out.AuthorizationData) == 0 || out.AuthorizationData[0].AuthorizationToken == nil {
		return ecrCredential{}, errors.New("ECR returned no authorization token")
	}
	decoded, err := base64.StdEncoding.DecodeString(aws.ToString(out.AuthorizationData[0].AuthorizationToken))
	if err != nil {
		return ecrCredential{}, errors.New("ECR's token isn't base64")
	}
	username, password, _ := bytes.Cut(decoded, []byte(":"))
	expires := time.Now().Add(time.Hour)
	if out.AuthorizationData[0].ExpiresAt != nil {
		expires = *out.AuthorizationData[0].ExpiresAt
	}
	// Never past the role's own session.
	if session, err := role.Retrieve(ctx); err == nil && session.CanExpire && session.Expires.Before(expires) {
		expires = session.Expires
	}
	c := ecrCredential{username: string(username), password: string(password), expires: expires}
	k.ecr[region] = c
	return c, nil
}

// webIdentity is the owner's role by web identity, at the registry's
// regional STS (an unsigned call: the projected token is the proof),
// cached by the SDK until it's near expiry.
func (k *federatedKeychain) webIdentity(ctx context.Context, region string) (aws.CredentialsProvider, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("AWS STS: %w", err)
	}
	provider := stscreds.NewWebIdentityRoleProvider(sts.NewFromConfig(cfg), k.f.AWSRoleArn, stscreds.IdentityTokenFile(k.f.TokenFile),
		func(o *stscreds.WebIdentityRoleOptions) {
			o.RoleSessionName = "vennir-kernel-policy"
			o.Duration = time.Hour
		})
	return aws.NewCredentialsCache(provider), nil
}
