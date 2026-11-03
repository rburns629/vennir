// SPDX-License-Identifier: MIT

package gateway

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/rburns629/vertra/gateway/internal/auth"
	"github.com/rburns629/vertra/gateway/internal/caller"
	"github.com/rburns629/vertra/gateway/internal/limits"
	"github.com/rburns629/vertra/gateway/internal/store"
)

const spec = `{
  "openapi": "3.1.0",
  "info": {"title": "Orders", "version": "2.3.0"},
  "servers": [{"url": "BACKEND"}],
  "paths": {
    "/orders/{orderId}": {
      "get": {
        "parameters": [{"name": "orderId", "in": "path", "required": true, "schema": {"type": "string", "pattern": "^ord_[a-z0-9]{8}$"}}],
        "responses": {"200": {"description": "ok"}}
      }
    },
    "/orders": {
      "post": {
        "requestBody": {"required": true, "content": {"application/json": {"schema": {
          "type": "object", "required": ["amount"], "properties": {"amount": {"type": "integer"}}}}}},
        "responses": {"201": {"description": "created"}}
      }
    }
  }
}`

type callers map[string]*auth.Caller

func (c callers) Resolve(_ context.Context, authorization string) (*auth.Caller, error) {
	if who, ok := c[strings.TrimPrefix(authorization, "Bearer ")]; ok {
		return who, nil
	}
	return nil, auth.ErrUnauthenticated
}

type minter struct{}

func (minter) Authorize(_ context.Context, out *http.Request, _ []byte, _, _ string, _ map[string]map[string]string) error {
	out.Header.Set("Authorization", "Bearer backend-credential")
	return nil
}

// backend records what reached it.
type backend struct {
	*httptest.Server
	got    []*http.Request
	bodies []string
}

func newBackend(t *testing.T) *backend {
	b := &backend{}
	b.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		b.got = append(b.got, r)
		b.bodies = append(b.bodies, string(body))
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Backend", "yes")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(b.Close)
	return b
}

type fixture struct {
	gw      *Gateway
	backend *backend
	api     *store.API
	public  ed25519.PublicKey
}

func setup(t *testing.T, basePath string) *fixture {
	t.Helper()
	b := newBackend(t)
	backendURL, _ := url.Parse(b.URL + basePath)
	pub, key, _ := ed25519.GenerateKey(nil)
	api := &store.API{Team: "payments", Name: "orders", BackendURL: backendURL, ShareWith: []string{"web"},
		PerMinute: map[string]int{"default": 100}, Timeout: 5 * time.Second, MaxRequest: 1024}
	st := &store.Store{}
	st.Put(api, []byte(strings.ReplaceAll(spec, "BACKEND", b.URL+basePath)))
	if api.Problem != "" {
		t.Fatal(api.Problem)
	}
	gw := &Gateway{
		Store: st,
		Callers: callers{
			"web-person": {UserID: "u1", Email: "web@example.com", Teams: []string{"web"}},
			"outsider":   {UserID: "u2", Teams: []string{"data"}},
			"two-teams":  {UserID: "u3", Teams: []string{"data", "web"}},
		},
		Signer:   &caller.Signer{Key: key, Issuer: "https://api.example.com"},
		Limiter:  limits.New(),
		Minter:   minter{},
		Settings: Settings{BackendHosts: []string{"127.0.0.1"}, InternetTeams: []string{"payments"}, DefaultPerMinute: 600},
		Log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	return &fixture{gw: gw, backend: b, api: api, public: pub}
}

func (f *fixture) do(method, path, token, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	f.gw.ServeHTTP(w, r)
	return w
}

func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct{ Error string }
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	return body.Error
}

func TestItForwardsWhatTheSpecDescribesAsSent(t *testing.T) {
	f := setup(t, "")
	w := f.do("POST", "/payments/orders/orders?dry=1", "web-person", `{"amount": 1200}`, map[string]string{
		"Content-Type": "application/json", "Idempotency-Key": "k1", "Vertra-Caller": "forged", "Connection": "close"})
	if w.Code != http.StatusCreated || w.Header().Get(AnsweredBy) != "backend" || w.Header().Get("X-Backend") != "yes" || w.Body.String() != `{"ok":true}` {
		t.Fatalf("answer = %d %v %s", w.Code, w.Header(), w.Body)
	}
	if len(f.backend.got) != 1 {
		t.Fatalf("backend got %d requests", len(f.backend.got))
	}
	got := f.backend.got[0]
	if got.URL.Path != "/orders" || got.URL.RawQuery != "dry=1" || f.backend.bodies[0] != `{"amount": 1200}` || got.Header.Get("Idempotency-Key") != "k1" {
		t.Errorf("forwarded %s %s?%s %q %v", got.Method, got.URL.Path, got.URL.RawQuery, f.backend.bodies[0], got.Header)
	}
	if got.Header.Get("Authorization") != "Bearer backend-credential" {
		t.Errorf("the backend's credential, not the caller's: %q", got.Header.Get("Authorization"))
	}
	claims := verify(t, got.Header.Get(caller.Header), f.public)
	if claims.Subject != "user:u1" || claims.Team != "web" || claims.API != "payments/orders" || claims.Email != "web@example.com" {
		t.Errorf("Vertra-Caller = %+v", claims)
	}
}

func verify(t *testing.T, token string, pub ed25519.PublicKey) caller.Claims {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("Vertra-Caller isn't a JWT: %q", token)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if !ed25519.Verify(pub, []byte(parts[0]+"."+parts[1]), sig) {
		t.Fatal("Vertra-Caller's signature doesn't verify")
	}
	payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var c caller.Claims
	_ = json.Unmarshal(payload, &c)
	return c
}

func TestWhatTheSpecDoesntDescribeIsBlockedAndNeverForwarded(t *testing.T) {
	f := setup(t, "")
	for name, tc := range map[string]struct {
		method, path, body, code string
		status                   int
	}{
		"a path not in it":      {"GET", "/payments/orders/admin/users", "", "NOT_IN_SPEC", 404},
		"a method not in it":    {"DELETE", "/payments/orders/orders/ord_abcdefgh", "", "NOT_IN_SPEC", 404},
		"a parameter unfit":     {"GET", "/payments/orders/orders/42", "", "INVALID_REQUEST", 400},
		"a body unfit":          {"POST", "/payments/orders/orders", `{"amount": "lots"}`, "INVALID_REQUEST", 400},
		"a dot segment":         {"GET", "/payments/orders/orders/../admin", "", "NOT_FOUND", 404},
		"an encoded slash":      {"GET", "/payments/orders/orders%2Fx", "", "NOT_FOUND", 404},
		"no such API":           {"GET", "/payments/ledger/orders", "", "NOT_FOUND", 404},
		"a body over the limit": {"POST", "/payments/orders/orders", `{"amount": 1}` + strings.Repeat(" ", 2000), "TOO_LARGE", 413},
	} {
		w := f.do(tc.method, tc.path, "web-person", tc.body, map[string]string{"Content-Type": "application/json"})
		if w.Code != tc.status || errorCode(t, w) != tc.code || w.Header().Get(AnsweredBy) != "gateway" {
			t.Errorf("%s: %d %s %s", name, w.Code, errorCode(t, w), w.Body)
		}
	}
	if len(f.backend.got) != 0 {
		t.Errorf("forwarded %d requests that should have been stopped", len(f.backend.got))
	}
}

func TestWhoMayCall(t *testing.T) {
	f := setup(t, "")
	path := "/payments/orders/orders/ord_abcdefgh"
	if w := f.do("GET", path, "", "", nil); w.Code != 401 || w.Header().Get("WWW-Authenticate") == "" {
		t.Errorf("no credential: %d", w.Code)
	}
	if w := f.do("GET", path, "forged", "", nil); w.Code != 401 {
		t.Errorf("a bad credential: %d", w.Code)
	}
	if w := f.do("GET", path, "outsider", "", nil); w.Code != 403 || errorCode(t, w) != "NOT_SHARED" {
		t.Errorf("not shared: %d", w.Code)
	}
	if w := f.do("GET", path, "two-teams", "", nil); w.Code != 201 {
		t.Errorf("a team it's shared with, among theirs: %d", w.Code)
	}
	if w := f.do("GET", path, "two-teams", "", map[string]string{TeamHeader: "data"}); w.Code != 403 {
		t.Errorf("calling as a team it isn't shared with: %d", w.Code)
	}
	if len(f.backend.got) != 1 {
		t.Errorf("forwarded %d", len(f.backend.got))
	}
}

func TestPausedHeldAndClosedForwardNothing(t *testing.T) {
	f := setup(t, "")
	path := "/payments/orders/orders/ord_abcdefgh"
	msg := "Incident 42: back by 14:00"
	f.api.PausedMessage = &msg
	if w := f.do("GET", path, "web-person", "", nil); w.Code != 503 || !strings.Contains(w.Body.String(), msg) {
		t.Errorf("paused: %d %s", w.Code, w.Body)
	}
	f.api.PausedMessage = nil
	f.gw.Settings.BackendHosts = []string{"*.run.app"}
	if w := f.do("GET", path, "web-person", "", nil); w.Code != 503 || errorCode(t, w) != "API_HELD" {
		t.Errorf("held: %d %s", w.Code, w.Body)
	}
	// Another team's in-cluster backend, though its host is allowed: held.
	own := f.api.BackendURL
	other, _ := url.Parse("http://orders.web.svc.cluster.local:8080")
	f.api.BackendURL = other
	f.gw.Settings.BackendHosts = []string{"*.svc.cluster.local"}
	if w := f.do("GET", path, "web-person", "", nil); w.Code != 503 || errorCode(t, w) != "API_HELD" || !strings.Contains(w.Body.String(), "another team's") {
		t.Errorf("another team's backend: %d %s", w.Code, w.Body)
	}
	f.api.BackendURL = own
	f.gw.Settings.BackendHosts = []string{"127.0.0.1"}
	f.gw.Settings.Closed = true
	if w := f.do("GET", path, "web-person", "", nil); w.Code != 503 || errorCode(t, w) != "GATEWAY_CLOSED" {
		t.Errorf("closed: %d %s", w.Code, w.Body)
	}
	if len(f.backend.got) != 0 {
		t.Errorf("forwarded %d", len(f.backend.got))
	}
}

func TestATeamIsHeldToItsRate(t *testing.T) {
	f := setup(t, "")
	f.api.PerMinute = map[string]int{"web": 2}
	path := "/payments/orders/orders/ord_abcdefgh"
	for i := range 2 {
		if w := f.do("GET", path, "web-person", "", nil); w.Code != 201 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	w := f.do("GET", path, "web-person", "", nil)
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Errorf("over the rate: %d %v", w.Code, w.Header())
	}
}

func TestTheInternetGetsOnlyWhatsAllowedThere(t *testing.T) {
	f := setup(t, "")
	f.gw.Public = true
	path := "/payments/orders/orders/ord_abcdefgh"
	if w := f.do("GET", path, "web-person", "", nil); w.Code != 404 {
		t.Errorf("not reachable from the internet: %d", w.Code)
	}
	f.api.Internet = true
	if w := f.do("GET", path, "web-person", "", nil); w.Code != 201 {
		t.Errorf("reachable and allowed: %d", w.Code)
	}
	f.gw.Settings.InternetTeams = nil
	if w := f.do("GET", path, "web-person", "", nil); w.Code != 404 {
		t.Errorf("reachable but its team isn't allowed: %d", w.Code)
	}
}

func TestABackendUnderAPath(t *testing.T) {
	f := setup(t, "/v1")
	if w := f.do("GET", "/payments/orders/orders/ord_abcdefgh", "web-person", "", nil); w.Code != 201 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if got := f.backend.got[0].URL.Path; got != "/v1/orders/ord_abcdefgh" {
		t.Errorf("forwarded to %s", got)
	}
}

func TestItsOwnPaths(t *testing.T) {
	f := setup(t, "")
	if w := f.do("GET", "/.vertra/health", "", "", nil); w.Code != 200 {
		t.Errorf("health: %d", w.Code)
	}
	w := f.do("GET", "/.vertra/jwks.json", "", "", nil)
	var jwks struct{ Keys []map[string]string }
	if err := json.Unmarshal(w.Body.Bytes(), &jwks); err != nil || len(jwks.Keys) != 1 || jwks.Keys[0]["crv"] != "Ed25519" {
		t.Errorf("jwks: %s", w.Body)
	}
	x, _ := base64.RawURLEncoding.DecodeString(jwks.Keys[0]["x"])
	if !ed25519.PublicKey(x).Equal(f.public) {
		t.Error("the JWKS key isn't the signing key's public half")
	}
}

func TestOnlyServedAPIsGetTheirOwnMetricLabel(t *testing.T) {
	f := setup(t, "")
	reg := prometheus.NewRegistry()
	f.gw.Metrics = NewMetrics(reg)
	f.do("GET", "/payments/orders/orders/ord_abcdefgh", "web-person", "", nil)
	f.do("GET", "/payments/orders/orders/ord_abcdefgh", "", "", nil) // refused, but a served API
	f.do("GET", "/made-up/api/x", "", "", nil)
	f.do("GET", "/no-api-here", "", "", nil)
	f.do("GET", "/another/one/x", "", "", nil)
	f.gw.Public = true // not served on the internet listener
	f.do("GET", "/payments/orders/orders/ord_abcdefgh", "web-person", "", nil)
	if got := testutil.ToFloat64(f.gw.Metrics.Requests.WithLabelValues("payments/orders", "forwarded")); got != 1 {
		t.Errorf("payments/orders forwarded: %v", got)
	}
	if got := testutil.ToFloat64(f.gw.Metrics.Requests.WithLabelValues("payments/orders", "unauthenticated")); got != 1 {
		t.Errorf("payments/orders unauthenticated: %v", got)
	}
	if got := testutil.ToFloat64(f.gw.Metrics.Requests.WithLabelValues("-", "not_found")); got != 4 {
		t.Errorf("not found under -: %v", got)
	}
	if n := testutil.CollectAndCount(f.gw.Metrics.Requests); n != 3 {
		t.Errorf("%d request series, want 3", n)
	}
	if n := testutil.CollectAndCount(f.gw.Metrics.Duration); n != 3 {
		t.Errorf("%d duration histograms, want 3 (payments/orders by backend and gateway, and -)", n)
	}
}
