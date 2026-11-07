// SPDX-License-Identifier: MIT

package policy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/google/go-containerregistry/pkg/authn"
)

func projected(t *testing.T, token string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func basic(t *testing.T, a authn.Authenticator) authn.AuthConfig {
	t.Helper()
	c, err := a.Authorization()
	if err != nil {
		t.Fatal(err)
	}
	return *c
}

// Google: the projected token is exchanged at STS for the provider's
// audience, then impersonates the service account; the token is kept, and
// only the federated hosts are signed in to so.
func TestFederationToGoogleExchangesThenImpersonates(t *testing.T) {
	var exchanges, impersonations int
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch {
		case r.URL.Path == "/v1/token":
			exchanges++
			if body["audience"] != "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q" ||
				body["subjectToken"] != "the-projected-token" || body["subjectTokenType"] != "urn:ietf:params:oauth:token-type:jwt" {
				http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
				return
			}
			_, _ = fmt.Fprint(w, `{"access_token":"federated","expires_in":3600}`)
		case strings.HasSuffix(r.URL.Path, "reader@owner.iam.gserviceaccount.com:generateAccessToken"):
			impersonations++
			if r.Header.Get("Authorization") != "Bearer federated" {
				http.Error(w, "{}", http.StatusUnauthorized)
				return
			}
			_, _ = fmt.Fprintf(w, `{"accessToken":"impersonated","expireTime":%q}`, time.Now().Add(time.Hour).Format(time.RFC3339))
		default:
			http.NotFound(w, r)
		}
	}))
	defer google.Close()
	sts, credentials := gcpSTSURL, gcpCredentialsURL
	gcpSTSURL, gcpCredentialsURL = google.URL+"/v1/token", google.URL+"/v1/projects/-/serviceAccounts/%s:generateAccessToken"
	defer func() { gcpSTSURL, gcpCredentialsURL = sts, credentials }()

	k := newFederatedKeychain(Federation{
		GCPProvider:       "projects/1/locations/global/workloadIdentityPools/p/providers/q",
		GCPServiceAccount: "reader@owner.iam.gserviceaccount.com",
		Hosts:             []string{"us-central1-docker.pkg.dev"},
		TokenFile:         projected(t, "the-projected-token"),
	}, 5*time.Second)
	for range 2 {
		a, err := k.Resolve(registryHost("us-central1-docker.pkg.dev"))
		if err != nil {
			t.Fatal(err)
		}
		if c := basic(t, a); c.Username != "oauth2accesstoken" || c.Password != "impersonated" {
			t.Errorf("signed in as %+v", c)
		}
	}
	if exchanges != 1 || impersonations != 1 {
		t.Errorf("exchanged %d times, impersonated %d: want once each, then kept", exchanges, impersonations)
	}
	if a, err := k.Resolve(registryHost("europe-docker.pkg.dev")); err != nil || a != authn.Anonymous {
		t.Errorf("a host it doesn't federate: %v %v", a, err)
	}
}

// Without a service account the federated token is used as is, and a
// refusal says what Google said.
func TestFederationToGoogleWithoutImpersonationAndRefused(t *testing.T) {
	refuse := false
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if refuse {
			http.Error(w, `{"error":"invalid_target","error_description":"the audience isn't a provider"}`, http.StatusBadRequest)
			return
		}
		_, _ = fmt.Fprint(w, `{"access_token":"federated","expires_in":3600}`)
	}))
	defer google.Close()
	sts := gcpSTSURL
	gcpSTSURL = google.URL
	defer func() { gcpSTSURL = sts }()
	f := Federation{GCPProvider: "projects/1/locations/global/workloadIdentityPools/p/providers/q", Hosts: []string{"gcr.io"}, TokenFile: projected(t, "t")}
	a, err := newFederatedKeychain(f, 5*time.Second).Resolve(registryHost("gcr.io"))
	if err != nil || basic(t, a).Password != "federated" {
		t.Fatalf("%v %v", a, err)
	}
	refuse = true
	if _, err := newFederatedKeychain(f, 5*time.Second).Resolve(registryHost("gcr.io")); err == nil || !strings.Contains(err.Error(), "the audience isn't a provider") {
		t.Errorf("a refusal: %v", err)
	}
	f.TokenFile = filepath.Join(t.TempDir(), "missing")
	if _, err := newFederatedKeychain(f, 5*time.Second).Resolve(registryHost("gcr.io")); err == nil || !strings.Contains(err.Error(), "projected token") {
		t.Errorf("no projected token: %v", err)
	}
}

// AWS: the owner's role's credentials (here a stand-in for the web identity
// exchange) sign ECR's GetAuthorizationToken, whose token is kept per
// region.
func TestFederationToECRSignsInAsTheOwnersRole(t *testing.T) {
	var calls int
	ecrServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if !strings.Contains(r.Header.Get("Authorization"), "Credential=ASIAOWNERROLE/") || r.Header.Get("X-Amz-Security-Token") != "session" {
			http.Error(w, `{"__type":"AccessDeniedException"}`, http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/x-amz-json-1.1")
		_, _ = fmt.Fprintf(w, `{"authorizationData":[{"authorizationToken":%q,"expiresAt":%d}]}`,
			base64.StdEncoding.EncodeToString([]byte("AWS:ecr-password")), time.Now().Add(12*time.Hour).Unix())
	}))
	defer ecrServer.Close()
	t.Setenv("AWS_ENDPOINT_URL_ECR", ecrServer.URL)
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	k := newFederatedKeychain(Federation{AWSRoleArn: "arn:aws:iam::111111111111:role/vennir-reader-r", Hosts: []string{"111111111111.dkr.ecr.us-east-2.amazonaws.com"},
		TokenFile: projected(t, "t")}, 5*time.Second)
	var assumed []string
	k.assume = func(_ context.Context, region string) (aws.CredentialsProvider, error) {
		assumed = append(assumed, region)
		return credentials.StaticCredentialsProvider{Value: aws.Credentials{AccessKeyID: "ASIAOWNERROLE", SecretAccessKey: "s", SessionToken: "session",
			CanExpire: true, Expires: time.Now().Add(time.Hour)}}, nil
	}
	for range 2 {
		a, err := k.Resolve(registryHost("111111111111.dkr.ecr.us-east-2.amazonaws.com"))
		if err != nil {
			t.Fatal(err)
		}
		if c := basic(t, a); c.Username != "AWS" || c.Password != "ecr-password" {
			t.Errorf("signed in as %+v", c)
		}
	}
	if calls != 1 || len(assumed) != 1 || assumed[0] != "us-east-2" {
		t.Errorf("ECR asked %d times, the role assumed for %v: want once, kept", calls, assumed)
	}
	// Kept no longer than the role's session (an hour), not ECR's 12.
	if c := k.ecr["us-east-2"]; time.Until(c.expires) > time.Hour+time.Minute {
		t.Errorf("kept until %v, past the role's session", c.expires)
	}
}
