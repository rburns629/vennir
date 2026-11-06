// SPDX-License-Identifier: MIT

package credentials

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)

// minter whose TokenRequest records what it was asked for.
func minter(asked *[]string) *Minter {
	return &Minter{Now: func() time.Time { return now }, TokenRequest: func(_ context.Context, ns, sa, aud string) (string, time.Time, error) {
		*asked = append(*asked, ns+"/"+sa+"/"+aud)
		return "k8s-token-for-" + aud, now.Add(TokenLifetime), nil
	}}
}

func request(t *testing.T) *http.Request {
	t.Helper()
	r, err := http.NewRequest("POST", "https://abc.lambda-url.us-east-1.on.aws/orders", strings.NewReader(`{"amount":1}`))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestServiceAccountTokensAreMintedAndKeptMostOfTheirLife(t *testing.T) {
	var asked []string
	m := minter(&asked)
	auth := map[string]map[string]string{"serviceAccountToken": {"audience": "orders"}}
	r := request(t)
	if err := m.Authorize(context.Background(), r, nil, "payments", "orders-api", auth); err != nil || r.Header.Get("Authorization") != "Bearer k8s-token-for-orders" {
		t.Fatalf("%q %v", r.Header.Get("Authorization"), err)
	}
	now = now.Add(7 * time.Minute)
	_ = m.Authorize(context.Background(), request(t), nil, "payments", "orders-api", auth)
	now = now.Add(2 * time.Minute)
	_ = m.Authorize(context.Background(), request(t), nil, "payments", "orders-api", auth)
	if len(asked) != 2 || asked[0] != "payments/orders-api/orders" {
		t.Errorf("asked %v: once, then again past four fifths of its life", asked)
	}
	if err := m.Authorize(context.Background(), request(t), nil, "payments", "orders-api", nil); err != nil {
		t.Errorf("no backend.auth: %v", err)
	}
	if err := m.Authorize(context.Background(), request(t), nil, "payments", "orders-api", map[string]map[string]string{"secret": {}}); err != ErrUnsupported {
		t.Errorf("an unknown kind: %v", err)
	}
}

// A backend's token never carries an audience a cloud federates: it could
// be traded for the API ServiceAccount's cloud identity. The gateway's own
// exchanges still get them.
// A newly published API's mint is refused until the console has written its
// audiences into the gateway token policy: nothing failed is kept, so the
// next request asks again.
func TestARefusedMintIsAskedAgain(t *testing.T) {
	refused := true
	asks := 0
	m := &Minter{Now: func() time.Time { return now }, TokenRequest: func(_ context.Context, _, _, aud string) (string, time.Time, error) {
		asks++
		if refused {
			return "", time.Time{}, errors.New("TokenRequest for payments/orders-api answered 403")
		}
		return "k8s-token-for-" + aud, now.Add(TokenLifetime), nil
	}}
	auth := map[string]map[string]string{"serviceAccountToken": {"audience": "orders"}}
	if err := m.Authorize(context.Background(), request(t), nil, "payments", "orders-api", auth); err == nil {
		t.Fatal("a refused mint signed the request in")
	}
	refused = false
	r := request(t)
	if err := m.Authorize(context.Background(), r, nil, "payments", "orders-api", auth); err != nil || r.Header.Get("Authorization") != "Bearer k8s-token-for-orders" || asks != 2 {
		t.Fatalf("%q %v after %d asks", r.Header.Get("Authorization"), err, asks)
	}
}

func TestServiceAccountTokensRefuseCloudAudiences(t *testing.T) {
	var asked []string
	m := minter(&asked)
	m.GCPAudience, m.GCPTokenAudience = "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/k", "custom-pool-audience"
	for _, aud := range []string{"sts.amazonaws.com", "api://AzureADTokenExchange", "API://AzureADTokenExchange", "acme.svc.id.goog",
		"identitynamespace:acme.svc.id.goog:https://container.googleapis.com/v1/projects/acme/locations/l/clusters/c",
		"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/other",
		"https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/other", "custom-pool-audience"} {
		auth := map[string]map[string]string{"serviceAccountToken": {"audience": aud}}
		if err := m.Authorize(context.Background(), request(t), nil, "payments", "orders-api", auth); err != ErrReservedAudience {
			t.Errorf("%s: %v", aud, err)
		}
	}
	if len(asked) != 0 {
		t.Errorf("minted %v", asked)
	}
}

func TestGoogleIDTokensComeFromTheAPIsServiceAccountByFederation(t *testing.T) {
	var asked []string
	var exchange, mint map[string]any
	var bearer string
	google := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case r.URL.Path == "/v1/token":
			_ = json.Unmarshal(body, &exchange)
			_, _ = w.Write([]byte(`{"access_token":"federated","expires_in":3600}`))
		case strings.HasSuffix(r.URL.Path, ":generateIdToken"):
			_ = json.Unmarshal(body, &mint)
			bearer = r.Header.Get("Authorization")
			if !strings.Contains(r.URL.Path, "orders-invoker@p.iam.gserviceaccount.com") {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			_, _ = w.Write([]byte(`{"token":"google-id-token"}`))
		}
	}))
	defer google.Close()
	m := minter(&asked)
	auth := map[string]map[string]string{"googleIdToken": {"serviceAccount": "orders-invoker@p.iam.gserviceaccount.com", "audience": "https://orders.a.run.app"}}
	if err := m.Authorize(context.Background(), request(t), nil, "payments", "orders-api", auth); err != ErrNotConfigured {
		t.Fatalf("without the install's federation settings: %v", err)
	}
	m.GCPAudience, m.GCPTokenAudience = "identitynamespace:p.svc.id.goog:https://container.googleapis.com/v1/projects/p/locations/us-central1/clusters/c", "p.svc.id.goog"
	m.GoogleSTS, m.GoogleIAMCredentials = google.URL+"/v1/token", google.URL
	r := request(t)
	if err := m.Authorize(context.Background(), r, nil, "payments", "orders-api", auth); err != nil || r.Header.Get("Authorization") != "Bearer google-id-token" {
		t.Fatalf("%q %v", r.Header.Get("Authorization"), err)
	}
	if exchange["audience"] != m.GCPAudience || exchange["subjectToken"] != "k8s-token-for-p.svc.id.goog" || asked[0] != "payments/orders-api/p.svc.id.goog" {
		t.Errorf("exchanged %v, asked %v", exchange, asked)
	}
	if mint["audience"] != "https://orders.a.run.app" || bearer != "Bearer federated" {
		t.Errorf("minted with %v, as %q", mint, bearer)
	}
	_ = m.Authorize(context.Background(), request(t), nil, "payments", "orders-api", auth)
	if len(asked) != 1 {
		t.Errorf("an ID token is kept: asked %v", asked)
	}
}

func TestAWSRequestsAreSignedAsTheAPIsRole(t *testing.T) {
	var asked []string
	var form url.Values
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		form, _ = url.ParseQuery(string(body))
		w.Header().Set("Content-Type", "text/xml")
		_, _ = w.Write([]byte(`<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult><Credentials>
    <AccessKeyId>ASIAEXAMPLE</AccessKeyId><SecretAccessKey>secret</SecretAccessKey>
    <SessionToken>session</SessionToken><Expiration>` + now.Add(time.Hour).Format(time.RFC3339) + `</Expiration>
  </Credentials></AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`))
	}))
	defer sts.Close()
	m := minter(&asked)
	m.AWSSTS = sts.URL
	auth := map[string]map[string]string{"awsSigV4": {"roleArn": "arn:aws:iam::123456789012:role/orders-gateway", "region": "us-east-1", "service": "lambda"}}
	body := []byte(`{"amount":1}`)
	r := request(t)
	if err := m.Authorize(context.Background(), r, body, "payments", "orders-api", auth); err != nil {
		t.Fatal(err)
	}
	if form.Get("Action") != "AssumeRoleWithWebIdentity" || form.Get("RoleArn") != "arn:aws:iam::123456789012:role/orders-gateway" ||
		form.Get("WebIdentityToken") != "k8s-token-for-"+AWSAudience || form.Get("RoleSessionName") != "vennir.payments.orders-api" {
		t.Errorf("assumed with %v", form)
	}
	sum := sha256.Sum256(body)
	if got := r.Header.Get("Authorization"); !strings.HasPrefix(got, "AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE/20261022/us-east-1/lambda/aws4_request") {
		t.Errorf("Authorization = %q", got)
	}
	if r.Header.Get("X-Amz-Security-Token") != "session" || r.Header.Get("X-Amz-Content-Sha256") != hex.EncodeToString(sum[:]) {
		t.Errorf("headers = %v", r.Header)
	}
	_ = m.Authorize(context.Background(), request(t), body, "payments", "orders-api", auth)
	if len(asked) != 1 {
		t.Errorf("the role's credentials are kept: asked %v", asked)
	}
}
