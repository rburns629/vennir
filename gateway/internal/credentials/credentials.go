// SPDX-License-Identifier: MIT

// Package credentials signs a forwarded request in to its backend, per the
// API's backend.auth, with credentials minted from the API's own
// ServiceAccount and kept until shortly before they expire. Nothing is
// stored that outlives them, and the gateway reads no Secrets:
//
//   - serviceAccountToken: that ServiceAccount's Kubernetes token, for the
//     API's audience (TokenRequest);
//   - googleIdToken: its token exchanged at Google's STS (Workload Identity
//     Federation), then a Google ID token for the backend, as the service
//     account the API names (IAM Credentials generateIdToken);
//   - awsSigV4: its token traded for the API's role (STS
//     AssumeRoleWithWebIdentity), then the request signed with SigV4;
//   - entraToken: its token as the federated credential of the Entra
//     identity the API names (the client credentials grant), for an access
//     token for the backend's scope.
package credentials

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// ErrUnsupported is a backend.auth this gateway can't mint.
var ErrUnsupported = errors.New("this kind of backend credential isn't supported by this gateway")

// ErrNotConfigured is a cloud credential this install hasn't set up (its
// federation settings).
var ErrNotConfigured = errors.New("this install's gateway isn't set up to mint this cloud's credentials")

// ErrReservedAudience is a serviceAccountToken audience a cloud takes for
// federation (or the gateway's own for it): a backend given that token
// could trade it for the API ServiceAccount's cloud identity.
var ErrReservedAudience = errors.New("this audience is a cloud's federation audience: a backend's token may never carry it")

// TokenLifetime is how long a minted ServiceAccount token lasts.
const TokenLifetime = 10 * time.Minute

// AWSAudience is the audience a token AWS STS accepts carries.
const AWSAudience = "sts.amazonaws.com"

// AzureAudience is the audience Entra's workload identity federation takes.
const AzureAudience = "api://AzureADTokenExchange"

// CloudAudience says whether a ServiceAccount token for audience could be
// exchanged for a cloud identity: AWS's and Azure's federation audiences, a
// GKE Workload Identity pool (<project>.svc.id.goog) or its STS audience
// (identitynamespace:...), and a GCP workload identity provider. As the
// console's apiTokenAudienceProblem (console/src/tokenAudiences.ts) and the
// catalog tool's (cli/internal/catalogtool/apis.go), kept in step.
func CloudAudience(audience string) bool {
	a := strings.ToLower(audience)
	return a == AWSAudience || a == strings.ToLower(AzureAudience) ||
		strings.HasSuffix(a, ".svc.id.goog") || strings.HasPrefix(a, "identitynamespace:") ||
		strings.HasPrefix(a, "//iam.googleapis.com/") || strings.HasPrefix(a, "https://iam.googleapis.com/")
}

// Minter mints and keeps backend credentials.
type Minter struct {
	// TokenRequest asks Kubernetes for a ServiceAccount token.
	TokenRequest func(ctx context.Context, namespace, serviceAccount, audience string) (string, time.Time, error)
	// GCP: the STS audience the API ServiceAccounts' tokens are exchanged
	// for (the cluster's Workload Identity pool, or a provider trusting its
	// issuer), and the audience those tokens carry.
	GCPAudience, GCPTokenAudience string
	// Endpoints, replaced in tests.
	GoogleSTS, GoogleIAMCredentials, AWSSTS, EntraLogin string
	HTTP                                                *http.Client
	Now                                                 func() time.Time

	mu    sync.Mutex
	cache map[string]cached
}

type cached struct {
	value   string
	aws     *aws.Credentials
	refresh time.Time
}

func (m *Minter) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

func (m *Minter) client() *http.Client {
	if m.HTTP != nil {
		return m.HTTP
	}
	return &http.Client{Timeout: 10 * time.Second}
}

// remember keeps a credential until four fifths of its life are gone.
func (m *Minter) remember(key string, c cached, expires time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cache == nil {
		m.cache = map[string]cached{}
	}
	c.refresh = m.now().Add(expires.Sub(m.now()) * 4 / 5)
	m.cache[key] = c
}

func (m *Minter) recall(key string) (cached, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.cache[key]
	return c, ok && m.now().Before(c.refresh)
}

// Authorize signs out in, for an API of team whose ServiceAccount is
// serviceAccount; body is the request's body (SigV4 signs its hash).
func (m *Minter) Authorize(ctx context.Context, out *http.Request, body []byte, team, serviceAccount string, auth map[string]map[string]string) error {
	switch {
	case len(auth) == 0:
		return nil
	case auth["serviceAccountToken"] != nil:
		// The cloud audiences are for the gateway's own exchanges below,
		// never a token handed to a backend.
		audience := auth["serviceAccountToken"]["audience"]
		if CloudAudience(audience) || audience == m.GCPAudience || audience == m.GCPTokenAudience {
			return ErrReservedAudience
		}
		token, err := m.serviceAccountToken(ctx, team, serviceAccount, audience)
		if err != nil {
			return err
		}
		out.Header.Set("Authorization", "Bearer "+token)
		return nil
	case auth["googleIdToken"] != nil:
		a := auth["googleIdToken"]
		token, err := m.googleIDToken(ctx, team, serviceAccount, a["serviceAccount"], a["audience"])
		if err != nil {
			return err
		}
		out.Header.Set("Authorization", "Bearer "+token)
		return nil
	case auth["awsSigV4"] != nil:
		a := auth["awsSigV4"]
		creds, err := m.awsCredentials(ctx, team, serviceAccount, a["roleArn"], a["region"])
		if err != nil {
			return err
		}
		sum := sha256.Sum256(body)
		out.Header.Set("X-Amz-Content-Sha256", hex.EncodeToString(sum[:]))
		// Sent, but not signed: AWS's front end adds to X-Forwarded-For
		// before it checks the signature, which then never matches
		// (proven against a Lambda function URL, 2026-11-07).
		forwarded, had := out.Header["X-Forwarded-For"]
		out.Header.Del("X-Forwarded-For")
		err = v4.NewSigner().SignHTTP(ctx, *creds, out, hex.EncodeToString(sum[:]), a["service"], a["region"], m.now())
		if had {
			out.Header["X-Forwarded-For"] = forwarded
		}
		return err
	case auth["entraToken"] != nil:
		a := auth["entraToken"]
		token, err := m.entraToken(ctx, team, serviceAccount, a["tenantId"], a["clientId"], a["scope"])
		if err != nil {
			return err
		}
		out.Header.Set("Authorization", "Bearer "+token)
		return nil
	}
	return ErrUnsupported
}

func (m *Minter) serviceAccountToken(ctx context.Context, namespace, serviceAccount, audience string) (string, error) {
	key := "k8s/" + namespace + "/" + serviceAccount + "/" + audience
	if c, ok := m.recall(key); ok {
		return c.value, nil
	}
	token, expires, err := m.TokenRequest(ctx, namespace, serviceAccount, audience)
	if err != nil {
		return "", err
	}
	m.remember(key, cached{value: token}, expires)
	return token, nil
}

func (m *Minter) googleIDToken(ctx context.Context, namespace, serviceAccount, googleAccount, audience string) (string, error) {
	if m.GCPAudience == "" || m.GCPTokenAudience == "" {
		return "", ErrNotConfigured
	}
	key := "gcp/" + namespace + "/" + serviceAccount + "/" + googleAccount + "/" + audience
	if c, ok := m.recall(key); ok {
		return c.value, nil
	}
	subject, err := m.serviceAccountToken(ctx, namespace, serviceAccount, m.GCPTokenAudience)
	if err != nil {
		return "", err
	}
	var exchanged struct {
		AccessToken string `json:"access_token"`
	}
	if err := m.postJSON(ctx, or(m.GoogleSTS, "https://sts.googleapis.com/v1/token"), "", map[string]any{
		"grantType":          "urn:ietf:params:oauth:grant-type:token-exchange",
		"audience":           m.GCPAudience,
		"scope":              "https://www.googleapis.com/auth/cloud-platform",
		"requestedTokenType": "urn:ietf:params:oauth:token-type:access_token",
		"subjectTokenType":   "urn:ietf:params:oauth:token-type:jwt",
		"subjectToken":       subject,
	}, &exchanged); err != nil {
		return "", fmt.Errorf("exchanging %s/%s's token at Google: %w", namespace, serviceAccount, err)
	}
	var minted struct {
		Token string `json:"token"`
	}
	endpoint := or(m.GoogleIAMCredentials, "https://iamcredentials.googleapis.com") +
		"/v1/projects/-/serviceAccounts/" + url.PathEscape(googleAccount) + ":generateIdToken"
	if err := m.postJSON(ctx, endpoint, exchanged.AccessToken, map[string]any{"audience": audience, "includeEmail": true}, &minted); err != nil {
		return "", fmt.Errorf("an ID token as %s: %w", googleAccount, err)
	}
	// An ID token lasts an hour.
	m.remember(key, cached{value: minted.Token}, m.now().Add(time.Hour))
	return minted.Token, nil
}

func (m *Minter) awsCredentials(ctx context.Context, namespace, serviceAccount, roleArn, region string) (*aws.Credentials, error) {
	key := "aws/" + namespace + "/" + serviceAccount + "/" + roleArn
	if c, ok := m.recall(key); ok {
		return c.aws, nil
	}
	token, err := m.serviceAccountToken(ctx, namespace, serviceAccount, AWSAudience)
	if err != nil {
		return nil, err
	}
	opts := sts.Options{Region: region, Credentials: aws.AnonymousCredentials{}, HTTPClient: m.client()}
	if m.AWSSTS != "" {
		opts.BaseEndpoint = aws.String(m.AWSSTS)
	}
	out, err := sts.New(opts).AssumeRoleWithWebIdentity(ctx, &sts.AssumeRoleWithWebIdentityInput{
		RoleArn:          aws.String(roleArn),
		RoleSessionName:  aws.String(sessionName(namespace, serviceAccount)),
		WebIdentityToken: aws.String(token),
	})
	if err != nil {
		return nil, fmt.Errorf("assuming %s as %s/%s: %w", roleArn, namespace, serviceAccount, err)
	}
	c := out.Credentials
	creds := &aws.Credentials{AccessKeyID: aws.ToString(c.AccessKeyId), SecretAccessKey: aws.ToString(c.SecretAccessKey),
		SessionToken: aws.ToString(c.SessionToken), Source: "vennir-gateway", CanExpire: true, Expires: aws.ToTime(c.Expiration)}
	m.remember(key, cached{aws: creds}, creds.Expires)
	return creds, nil
}

func (m *Minter) entraToken(ctx context.Context, namespace, serviceAccount, tenant, clientID, scope string) (string, error) {
	key := "azure/" + namespace + "/" + serviceAccount + "/" + tenant + "/" + clientID + "/" + scope
	if c, ok := m.recall(key); ok {
		return c.value, nil
	}
	assertion, err := m.serviceAccountToken(ctx, namespace, serviceAccount, AzureAudience)
	if err != nil {
		return "", err
	}
	var minted struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	endpoint := or(m.EntraLogin, "https://login.microsoftonline.com") + "/" + url.PathEscape(tenant) + "/oauth2/v2.0/token"
	if err := m.postForm(ctx, endpoint, url.Values{
		"grant_type":            {"client_credentials"},
		"client_id":             {clientID},
		"scope":                 {scope},
		"client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"},
		"client_assertion":      {assertion},
	}, &minted); err != nil {
		return "", fmt.Errorf("an Entra token as %s for %s/%s: %w", clientID, namespace, serviceAccount, err)
	}
	if minted.AccessToken == "" || minted.ExpiresIn <= 0 {
		return "", errors.New("Entra returned no access token")
	}
	m.remember(key, cached{value: minted.AccessToken}, m.now().Add(time.Duration(minted.ExpiresIn)*time.Second))
	return minted.AccessToken, nil
}

// sessionName says which API's ServiceAccount assumed the role, within
// AWS's 64 characters of [\w+=,.@-].
func sessionName(namespace, serviceAccount string) string {
	name := "vennir." + namespace + "." + serviceAccount
	if len(name) > 64 {
		name = name[:64]
	}
	return name
}

func (m *Minter) postJSON(ctx context.Context, endpoint, bearer string, body any, into any) error {
	data, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	return m.do(req, into)
}

// postForm posts an OAuth 2.0 token request (Entra's token endpoint).
func (m *Minter) postForm(ctx context.Context, endpoint string, form url.Values, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return m.do(req, into)
}

func (m *Minter) do(req *http.Request, into any) error {
	res, err := m.client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	answer, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		// Google's and Entra's error bodies name what's wrong (an
		// audience, a binding, a federated credential); they never echo
		// the token sent.
		return fmt.Errorf("%s answered %d: %.300s", req.URL.Host, res.StatusCode, strings.TrimSpace(string(answer)))
	}
	return json.Unmarshal(answer, into)
}

func or(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

// InCluster is a TokenRequest through the Kubernetes API, as the gateway's
// own ServiceAccount (its RBAC and admission policy allow tokens for API
// ServiceAccounts, *-api in team namespaces, and nothing else).
func InCluster() (func(ctx context.Context, namespace, serviceAccount, audience string) (string, time.Time, error), error) {
	const dir = "/var/run/secrets/kubernetes.io/serviceaccount/"
	ca, err := os.ReadFile(dir + "ca.crt")
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("the cluster's CA certificate can't be read")
	}
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	return func(ctx context.Context, namespace, serviceAccount, audience string) (string, time.Time, error) {
		// The kubelet rotates the gateway's own token; read it each time.
		own, err := os.ReadFile(dir + "token")
		if err != nil {
			return "", time.Time{}, err
		}
		body, _ := json.Marshal(map[string]any{"apiVersion": "authentication.k8s.io/v1", "kind": "TokenRequest",
			"spec": map[string]any{"audiences": []string{audience}, "expirationSeconds": int(TokenLifetime.Seconds())}})
		endpoint := fmt.Sprintf("https://%s:%s/api/v1/namespaces/%s/serviceaccounts/%s/token", host, port, namespace, serviceAccount)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return "", time.Time{}, err
		}
		req.Header.Set("Authorization", "Bearer "+string(bytes.TrimSpace(own)))
		req.Header.Set("Content-Type", "application/json")
		res, err := client.Do(req)
		if err != nil {
			return "", time.Time{}, err
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		if res.StatusCode != http.StatusCreated && res.StatusCode != http.StatusOK {
			return "", time.Time{}, fmt.Errorf("TokenRequest for %s/%s answered %d: %.200s", namespace, serviceAccount, res.StatusCode, data)
		}
		var out struct {
			Status struct {
				Token               string    `json:"token"`
				ExpirationTimestamp time.Time `json:"expirationTimestamp"`
			} `json:"status"`
		}
		if err := json.Unmarshal(data, &out); err != nil || out.Status.Token == "" {
			return "", time.Time{}, errors.New("TokenRequest returned no token")
		}
		return out.Status.Token, out.Status.ExpirationTimestamp, nil
	}, nil
}
