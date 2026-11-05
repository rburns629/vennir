// SPDX-License-Identifier: MIT

package gateway

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/rburns629/vennir/gateway/internal/auth"
	"github.com/rburns629/vennir/gateway/internal/caller"
	"github.com/rburns629/vennir/gateway/internal/limits"
	"github.com/rburns629/vennir/gateway/internal/store"
)

const spec = `{
  "openapi": "3.1.0",
  "info": {"title": "Orders", "version": "2.3.0"},
  "servers": [{"url": "BACKEND"}],
  "paths": {
    "/orders/{orderId}": {
      "get": {
        "parameters": [{"name": "orderId", "in": "path", "required": true, "schema": {"type": "string", "pattern": "^ord_[a-z0-9]{8}$"}},
          {"name": "expand", "in": "query", "schema": {"type": "string", "enum": ["items"]}},
          {"name": "filter", "in": "query", "style": "deepObject", "schema": {"type": "object", "properties": {"status": {"type": "string"}}}},
          {"name": "page", "in": "query", "schema": {"type": "object", "properties": {"num": {"type": "integer"}, "size": {"type": "integer"}}}}],
        "responses": {"200": {"description": "ok"}}
      }
    },
    "/orders": {
      "post": {
        "parameters": [{"name": "dry", "in": "query", "schema": {"type": "boolean"}}],
        "requestBody": {"required": true, "content": {"application/json": {"schema": {
          "type": "object", "required": ["amount"], "properties": {"amount": {"type": "integer"}}}}}},
        "responses": {"201": {"description": "created"}}
      }
    },
    "/batch": {
      "post": {
        "requestBody": {"content": {"application/json": {"schema": {"type": "array", "items": {"type": "object", "properties": {"a": {"type": "integer"}}}}}}},
        "responses": {"201": {"description": "created"}}
      }
    },
    "/upload": {
      "post": {
        "requestBody": {"content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}},
        "responses": {"201": {"description": "created"}}
      }
    },
    "/notes": {
      "post": {
        "requestBody": {"content": {"application/vnd.example.notes": {"schema": {"type": "object"}}}},
        "responses": {"201": {"description": "created"}}
      }
    },
    "/refunds": {
      "post": {
        "parameters": [{"name": "X-Tenant", "in": "header", "required": true, "schema": {"type": "string", "enum": ["acme"]}}],
        "requestBody": {"content": {"application/x-www-form-urlencoded": {"schema": {"type": "object", "properties": {"amount": {"type": "integer"}}}}}},
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
	// pause: it sends half its answer, waits this long, then the rest.
	pause time.Duration
}

func newBackend(t *testing.T) *backend {
	b := &backend{}
	b.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		b.got = append(b.got, r)
		b.bodies = append(b.bodies, string(body))
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Backend", "yes")
		w.Header().Add("Set-Cookie", "sid=1; Path=/; Domain=example.com; HttpOnly")
		w.Header().Add("Set-Cookie", "pref=dark")
		// Its own copies of the gateway's headers, which callers never get.
		w.Header().Set(RequestIDHeader, "from-the-backend")
		w.Header().Set(AnsweredBy, "gateway")
		w.Header().Set("Vennir-Caller", "from-the-backend")
		w.WriteHeader(http.StatusCreated)
		if b.pause > 0 {
			_, _ = w.Write([]byte(`{"ok":`))
			w.(http.Flusher).Flush()
			time.Sleep(b.pause)
		}
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
			"web-person":      {UserID: "u1", Email: "web@example.com", Teams: []string{"web"}},
			"outsider":        {UserID: "u2", Teams: []string{"data"}},
			"two-teams":       {UserID: "u3", Teams: []string{"data", "web"}},
			"admin":           {UserID: "u4", IsAdmin: true, Teams: []string{"data"}},
			"payments-person": {UserID: "u5", Teams: []string{"payments"}},
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
	w := f.do("POST", "/payments/orders/orders?dry=true", "web-person", `{"amount": 1200}`, map[string]string{
		"Content-Type": "application/json", "Idempotency-Key": "k1", "Vennir-Caller": "forged", "Connection": "close, X-Hop",
		"X-Hop": "for the next hop only", "Proxy-Authorization": "Basic cHJveHk=", "X-Forwarded-For": "10.0.0.66", "X-Forwarded-Host": "evil.example",
		"Forwarded": "for=10.0.0.66", "X-Real-Ip": "10.0.0.66", "X-HTTP-Method-Override": "DELETE", "X-Original-URL": "/admin",
		"X-Amz-Target": "DynamoDB_20120810.DeleteTable"})
	if w.Code != http.StatusCreated || w.Header().Get(AnsweredBy) != "backend" || w.Header().Get("X-Backend") != "yes" || w.Body.String() != `{"ok":true}` {
		t.Fatalf("answer = %d %v %s", w.Code, w.Header(), w.Body)
	}
	// Vennir-* on an answer are the gateway's alone: one of each, its own.
	if ids := w.Header().Values(RequestIDHeader); len(ids) != 1 || ids[0] == "from-the-backend" ||
		len(w.Header().Values(AnsweredBy)) != 1 || w.Header().Get("Vennir-Caller") != "" {
		t.Errorf("Vennir-* on the answer: %v", w.Header())
	}
	if len(f.backend.got) != 1 {
		t.Fatalf("backend got %d requests", len(f.backend.got))
	}
	got := f.backend.got[0]
	if got.URL.Path != "/orders" || got.URL.RawQuery != "dry=true" || f.backend.bodies[0] != `{"amount": 1200}` || got.Header.Get("Idempotency-Key") != "k1" {
		t.Errorf("forwarded %s %s?%s %q %v", got.Method, got.URL.Path, got.URL.RawQuery, f.backend.bodies[0], got.Header)
	}
	if got.Header.Get("Authorization") != "Bearer backend-credential" {
		t.Errorf("the backend's credential, not the caller's: %q", got.Header.Get("Authorization"))
	}
	// Nothing for one hop only, and nothing the caller says about where
	// it's from: X-Forwarded-For is the gateway's peer (httptest's).
	// Nor anything a backend's framework would read as another method or
	// path than the one checked.
	for _, h := range []string{"X-Hop", "Proxy-Authorization", "X-Forwarded-Host", "Forwarded", "X-Real-Ip", "X-Http-Method-Override", "X-Original-Url"} {
		if v := got.Header.Get(h); v != "" {
			t.Errorf("%s reached the backend: %q", h, v)
		}
	}
	if got.Header.Get("X-Amz-Target") == "" {
		t.Error("X-Amz-* is kept for a backend not signed with SigV4")
	}
	if v := got.Header.Values("X-Forwarded-For"); len(v) != 1 || v[0] != "192.0.2.1" {
		t.Errorf("X-Forwarded-For = %q", v)
	}
	// Every API shares the gateway's origin: a cookie its backend sets is
	// kept to the API's path, and to the gateway's host.
	if cookies := w.Header().Values("Set-Cookie"); len(cookies) != 2 || cookies[0] != "sid=1; Path=/payments/orders/; HttpOnly" || cookies[1] != "pref=dark; Path=/payments/orders/" {
		t.Errorf("Set-Cookie = %q", cookies)
	}
	claims := verify(t, got.Header.Get(caller.Header), f.public)
	if claims.Subject != "user:u1" || claims.Team != "web" || claims.API != "payments/orders" || claims.Email != "web@example.com" {
		t.Errorf("Vennir-Caller = %+v", claims)
	}
}

func verify(t *testing.T, token string, pub ed25519.PublicKey) caller.Claims {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("Vennir-Caller isn't a JWT: %q", token)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if !ed25519.Verify(pub, []byte(parts[0]+"."+parts[1]), sig) {
		t.Fatal("Vennir-Caller's signature doesn't verify")
	}
	payload, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var c caller.Claims
	_ = json.Unmarshal(payload, &c)
	return c
}

// What's validated is what the backend gets.
func TestTheBackendGetsTheRequestThatWasChecked(t *testing.T) {
	f := setup(t, "")
	form := map[string]string{"Content-Type": "application/x-www-form-urlencoded", "X-Tenant": "acme"}
	if w := f.do("POST", "/payments/orders/refunds", "web-person", "amount=5", form); w.Code != http.StatusCreated {
		t.Fatalf("a form as described: %d %s", w.Code, w.Body)
	}
	with := func(extra map[string]string) map[string]string {
		h := map[string]string{}
		for k, v := range form {
			h[k] = v
		}
		for k, v := range extra {
			h[k] = v
		}
		return h
	}
	for name, tc := range map[string]struct {
		path, body string
		headers    map[string]string
	}{
		// Connection drops X-Tenant on the way: it's checked as missing.
		"a header Connection names": {"/payments/orders/refunds", "amount=5", with(map[string]string{"Connection": "X-Tenant"})},
		"_method in a form":         {"/payments/orders/refunds", "amount=5&_method=DELETE", form},
		"_method in the query":      {"/payments/orders/refunds?_method=DELETE", "amount=5", form},
		"a multipart _method": {"/payments/orders/refunds", "--b\r\nContent-Disposition: form-data; name=\"_method\"\r\n\r\nDELETE\r\n--b--\r\n",
			with(map[string]string{"Content-Type": "multipart/form-data; boundary=b"})},
	} {
		if w := f.do("POST", tc.path, "web-person", tc.body, tc.headers); w.Code != http.StatusBadRequest || errorCode(t, w) != "INVALID_REQUEST" {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	// Two Content-Types: the validator reads the first, a backend may read the last.
	r := httptest.NewRequest("POST", "/payments/orders/orders", strings.NewReader(`{"amount": 1}`))
	r.Header.Set("Authorization", "Bearer web-person")
	r.Header["Content-Type"] = []string{"application/json", "application/x-www-form-urlencoded"}
	w := httptest.NewRecorder()
	f.gw.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest || errorCode(t, w) != "INVALID_REQUEST" {
		t.Errorf("two Content-Types: %d %s", w.Code, w.Body)
	}
	if len(f.backend.got) != 1 {
		t.Errorf("the backend got %d requests, want only the first", len(f.backend.got))
	}
}

func TestASigV4BackendGetsNoCallersAmzHeaders(t *testing.T) {
	out := forwardHeaders(http.Header{"X-Amz-Target": {"DynamoDB_20120810.DeleteTable"}, "X-Amz-Security-Token": {"t"}, "Idempotency-Key": {"k"}}, "", true)
	if out.Get("X-Amz-Target") != "" || out.Get("X-Amz-Security-Token") != "" || out.Get("Idempotency-Key") != "k" {
		t.Errorf("forwarded %v", out)
	}
}

func TestWhatTheSpecDoesntDescribeIsBlockedAndNeverForwarded(t *testing.T) {
	f := setup(t, "")
	for name, tc := range map[string]struct {
		method, path, body, code string
		status                   int
	}{
		"a path not in it":              {"GET", "/payments/orders/admin/users", "", "NOT_IN_SPEC", 404},
		"a method not in it":            {"DELETE", "/payments/orders/orders/ord_abcdefgh", "", "NOT_IN_SPEC", 404},
		"a parameter unfit":             {"GET", "/payments/orders/orders/42", "", "INVALID_REQUEST", 400},
		"a body unfit":                  {"POST", "/payments/orders/orders", `{"amount": "lots"}`, "INVALID_REQUEST", 400},
		"a dot segment":                 {"GET", "/payments/orders/orders/../admin", "", "NOT_FOUND", 404},
		"an encoded slash":              {"GET", "/payments/orders/orders%2Fx", "", "NOT_FOUND", 404},
		"a dot segment with a ;":        {"GET", "/payments/orders/orders/..;/admin", "", "NOT_FOUND", 404},
		"a dot with a ;":                {"GET", "/payments/orders/orders/.;x/ord_abcdefgh", "", "NOT_FOUND", 404},
		"an encoded backslash":          {"GET", "/payments/orders/orders/x%5c..%5cadmin", "", "NOT_FOUND", 404},
		"no such API":                   {"GET", "/payments/ledger/orders", "", "NOT_FOUND", 404},
		"a body over the limit":         {"POST", "/payments/orders/orders", `{"amount": 1}` + strings.Repeat(" ", 2000), "TOO_LARGE", 413},
		"a body it declares none for":   {"GET", "/payments/orders/orders/ord_abcdefgh", `{"admin": true}`, "INVALID_REQUEST", 400},
		"an undeclared query parameter": {"GET", "/payments/orders/orders/ord_abcdefgh?debug=1", "", "INVALID_REQUEST", 400},
		"a declared one, unfit":         {"GET", "/payments/orders/orders/ord_abcdefgh?expand=everything", "", "INVALID_REQUEST", 400},
		// What Go's query parsing leaves out, the validator never sees.
		"a query pair with a ;":     {"GET", "/payments/orders/orders/ord_abcdefgh?debug=1;x", "", "INVALID_REQUEST", 400},
		"a query badly escaped":     {"GET", "/payments/orders/orders/ord_abcdefgh?debug=%zz", "", "INVALID_REQUEST", 400},
		"too many query parameters": {"GET", "/payments/orders/orders/ord_abcdefgh?debug=1" + strings.Repeat("&", 10000), "", "INVALID_REQUEST", 400},
	} {
		w := f.do(tc.method, tc.path, "web-person", tc.body, map[string]string{"Content-Type": "application/json"})
		if w.Code != tc.status || errorCode(t, w) != tc.code || w.Header().Get(AnsweredBy) != "gateway" {
			t.Errorf("%s: %d %s %s", name, w.Code, errorCode(t, w), w.Body)
		}
	}
	// A body with no Content-Type, and one of a media type the document
	// has a schema for but the gateway can't check.
	if w := f.do("POST", "/payments/orders/orders", "web-person", `{"amount": "lots"}`, nil); w.Code != 400 || errorCode(t, w) != "INVALID_REQUEST" {
		t.Errorf("no Content-Type: %d %s", w.Code, w.Body)
	}
	if w := f.do("POST", "/payments/orders/notes", "web-person", "--x--", map[string]string{"Content-Type": "application/vnd.example.notes"}); w.Code != 400 || errorCode(t, w) != "INVALID_REQUEST" {
		t.Errorf("a body it can't check: %d %s", w.Code, w.Body)
	}
	if len(f.backend.got) != 0 {
		t.Errorf("forwarded %d requests that should have been stopped", len(f.backend.got))
	}
	w := f.do("GET", "/payments/orders/orders/ord_abcdefgh?debug=1", "web-person", "", nil)
	if !strings.Contains(w.Body.String(), "debug: not a query parameter its OpenAPI document takes") {
		t.Errorf("an undeclared query parameter, described: %s", w.Body)
	}
	// What it does describe still goes through: a declared query parameter,
	// headers it doesn't mention, a body's extra properties its schema allows.
	if w := f.do("GET", "/payments/orders/orders/ord_abcdefgh?expand=items", "web-person", "", map[string]string{"X-Trace": "1"}); w.Code != 201 {
		t.Errorf("a declared query parameter: %d %s", w.Code, w.Body)
	}
	if w := f.do("POST", "/payments/orders/orders", "web-person", `{"amount": 1, "note": "hi"}`, map[string]string{"Content-Type": "application/json"}); w.Code != 201 {
		t.Errorf("an extra property its schema allows: %d %s", w.Code, w.Body)
	}
	for name, tc := range map[string]struct {
		method, path, body string
		headers            map[string]string
	}{
		"a header with a dot":        {"GET", "/payments/orders/orders/ord_abcdefgh", "", map[string]string{"X.Foo": "1"}},
		"a browser's cookies":        {"GET", "/payments/orders/orders/ord_abcdefgh", "", map[string]string{"Cookie": ".AspNetCore.Cookies=x; next-auth.session-token=y"}},
		"a property with a dot":      {"POST", "/payments/orders/orders", `{"amount": 1, "b.c": 2}`, map[string]string{"Content-Type": "application/json"}},
		"extras in an array's items": {"POST", "/payments/orders/batch", `[{"a": 1, "b": 2}]`, map[string]string{"Content-Type": "application/json"}},
		"a deepObject parameter":     {"GET", "/payments/orders/orders/ord_abcdefgh?filter[status]=open", "", nil},
		"an exploded object":         {"GET", "/payments/orders/orders/ord_abcdefgh?num=1&size=2", "", nil},
		"a binary upload":            {"POST", "/payments/orders/upload", "\x00\x01raw", map[string]string{"Content-Type": "application/octet-stream"}},
	} {
		if w := f.do(tc.method, tc.path, "web-person", tc.body, tc.headers); w.Code != 201 {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	// A deepObject's key on an operation that has none is still refused.
	if w := f.do("GET", "/payments/orders/orders/ord_abcdefgh?other[x]=1", "web-person", "", nil); w.Code != 400 {
		t.Errorf("an undeclared styled key: %d %s", w.Code, w.Body)
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
	if w := f.do("GET", path, "web-person", "", map[string]string{TeamHeader: "payments"}); w.Code != 403 || errorCode(t, w) != "NOT_SHARED" {
		t.Errorf("calling as a team the caller isn't in: %d", w.Code)
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
	// So is one in a namespace named for the team's API backends that a
	// team of that name has (named before such names were refused).
	own := f.api.BackendURL
	f.gw.Settings.BackendHosts = []string{"*.svc.cluster.local"}
	for _, c := range []struct {
		backend string
		taken   bool
	}{
		{"http://orders.web.svc.cluster.local:8080", false},
		{"http://orders.web-apis.svc.cluster.local:8080", false},
		{"http://orders.payments-apis.svc.cluster.local:8080", true},
	} {
		f.api.BackendURL, _ = url.Parse(c.backend)
		f.api.APINamespaceTaken = c.taken
		if w := f.do("GET", path, "web-person", "", nil); w.Code != 503 || errorCode(t, w) != "API_HELD" || !strings.Contains(w.Body.String(), "API backends' namespace") {
			t.Errorf("%s: %d %s", c.backend, w.Code, w.Body)
		}
	}
	f.api.BackendURL, f.api.APINamespaceTaken = own, false
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
	if w := f.do("GET", "/.vennir/health", "", "", nil); w.Code != 200 {
		t.Errorf("health: %d", w.Code)
	}
	w := f.do("GET", "/.vennir/jwks.json", "", "", nil)
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

// Before sign-in, a hidden or paused API is as one that isn't there; once
// signed in, a hidden one is only for its team, those it's shared with and
// admins (the console's sees()), and only they hear its state.
func TestWhatsToldBeforeSignIn(t *testing.T) {
	f := setup(t, "")
	path := "/payments/orders/orders/ord_abcdefgh"
	missing := f.do("GET", "/payments/ledger/orders", "", "", nil)
	msg := "Incident 42: back by 14:00"
	f.api.PausedMessage = &msg
	paused := f.do("GET", path, "", "", nil)
	if paused.Code != 404 || paused.Body.String() != missing.Body.String() || paused.Header().Get("WWW-Authenticate") != "" {
		t.Errorf("paused, before sign-in: %d %s", paused.Code, paused.Body)
	}
	if w := f.do("GET", path, "outsider", "", nil); w.Code != 503 || !strings.Contains(w.Body.String(), msg) {
		t.Errorf("paused, signed in: %d %s", w.Code, w.Body)
	}
	f.api.PausedMessage = nil
	f.api.Hidden = true
	if w := f.do("GET", path, "", "", nil); w.Code != 404 || w.Body.String() != missing.Body.String() {
		t.Errorf("hidden, before sign-in: %d %s", w.Code, w.Body)
	}
	if w := f.do("GET", path, "outsider", "", nil); w.Code != 404 || w.Body.String() != missing.Body.String() {
		t.Errorf("hidden, from a team it isn't shared with: %d %s", w.Code, w.Body)
	}
	if w := f.do("GET", path, "admin", "", nil); w.Code != 403 || errorCode(t, w) != "NOT_SHARED" {
		t.Errorf("hidden, an admin: %d %s", w.Code, w.Body)
	}
	if w := f.do("GET", path, "web-person", "", nil); w.Code != 404 || w.Body.String() != missing.Body.String() {
		t.Errorf("hidden, from a team it's shared with (as the console, only its own team's): %d %s", w.Code, w.Body)
	}
	if w := f.do("GET", path, "payments-person", "", nil); w.Code != 201 {
		t.Errorf("hidden, from its own team: %d %s", w.Code, w.Body)
	}
	// A live one says only "sign in", whatever its state.
	f.api.Hidden = false
	f.gw.Settings.Closed = true
	if w := f.do("GET", path, "", "", nil); w.Code != 401 {
		t.Errorf("closed, before sign-in: %d %s", w.Code, w.Body)
	}
}

func TestABackendsCookiesAreKeptToItsAPI(t *testing.T) {
	for name, tc := range map[string]struct{ setCookie, backendPath, want string }{
		"no path":                    {"a=1", "", "a=1; Path=/payments/orders/"},
		"a path":                     {"a=1; Path=/orders", "", "a=1; Path=/payments/orders/orders"},
		"a domain":                   {"a=1; Path=/; Domain=example.com", "", "a=1; Path=/payments/orders/"},
		"under the backend's base":   {"a=1; Path=/v1/orders", "/v1", "a=1; Path=/payments/orders/orders"},
		"the backend's base itself":  {"a=1; Path=/v1", "/v1/", "a=1; Path=/payments/orders/"},
		"outside the backend's base": {"a=1; Path=/other", "/v1", "a=1; Path=/payments/orders/"},
		"not quite the base":         {"a=1; Path=/v10/x", "/v1", "a=1; Path=/payments/orders/"},
		"attributes it knows":        {"a=1; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=60", "", "a=1; Path=/payments/orders/; Max-Age=60; HttpOnly; Secure; SameSite=Strict"},
		"attributes it doesn't":      {"a=1; Path=/; Priority=High", "", "a=1; Path=/payments/orders/; Priority=High"},
		"a __Host- cookie":           {"__Host-sid=1; Path=/; Secure", "", ""},
		"not a cookie":               {"=", "", ""},
	} {
		if got := scopeCookie(tc.setCookie, "/payments/orders", tc.backendPath); got != tc.want {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}
}

// Behind a trusted proxy, the caller is the last address it saw, never what
// the caller wrote before it; from anyone else, the peer.
func TestTheCallersAddressIsTakenOnlyFromTrustedProxies(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.244.0.0/16"), netip.MustParsePrefix("34.120.1.2/32")}
	for what, c := range map[string]struct {
		peer, forwarded, want string
	}{
		"an untrusted peer":            {"203.0.113.9:4000", "198.51.100.1", "203.0.113.9"},
		"no proxies trusted":           {"10.244.1.5:4000", "198.51.100.1", "10.244.1.5"},
		"a trusted ingress":            {"10.244.1.5:4000", "198.51.100.1", "198.51.100.1"},
		"what the caller wrote before": {"10.244.1.5:4000", "6.6.6.6, 198.51.100.1", "198.51.100.1"},
		"two trusted hops":             {"10.244.1.5:4000", "6.6.6.6, 198.51.100.1, 34.120.1.2", "198.51.100.1"},
		"several header lines":         {"10.244.1.5:4000", "6.6.6.6\n198.51.100.1", "198.51.100.1"},
		"an entry with a port":         {"10.244.1.5:4000", "198.51.100.1:5555", "198.51.100.1"},
		"no X-Forwarded-For":           {"10.244.1.5:4000", "", "10.244.1.5"},
		"garbage after the client":     {"10.244.1.5:4000", "198.51.100.1, not-an-address", "10.244.1.5"},
		"every hop trusted":            {"10.244.1.5:4000", "10.244.9.9, 34.120.1.2", "10.244.9.9"},
		"an IPv4-mapped peer":          {"[::ffff:10.244.1.5]:4000", "198.51.100.1", "198.51.100.1"},
		"an IPv6 client":               {"10.244.1.5:4000", "2001:db8::7", "2001:db8::7"},
	} {
		h := http.Header{}
		for _, line := range strings.Split(c.forwarded, "\n") {
			if line != "" {
				h.Add("X-Forwarded-For", line)
			}
		}
		list := trusted
		if what == "no proxies trusted" {
			list = nil
		}
		if got := clientAddress(h, c.peer, list); got != c.want {
			t.Errorf("%s: %q, want %q", what, got, c.want)
		}
	}
}

// The trusted list applies on the public listener, behind its ingress; on
// the in-cluster one, any Pod could write X-Forwarded-For, so the peer is
// the caller there whatever's trusted.
func TestABackendSeesTheCallersAddressOnlyThroughTheTrustedPublicListener(t *testing.T) {
	for _, public := range []bool{true, false} {
		f := setup(t, "")
		f.api.Internet = true
		f.gw.Public = public
		f.gw.Settings.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")} // httptest's peer
		w := f.do("POST", "/payments/orders/orders", "web-person", `{"amount": 1}`, map[string]string{
			"Content-Type": "application/json", "X-Forwarded-For": "6.6.6.6, 198.51.100.1"})
		if w.Code != http.StatusCreated {
			t.Fatalf("public %v: %d %s", public, w.Code, w.Body)
		}
		want := map[bool]string{true: "198.51.100.1", false: "192.0.2.1"}[public]
		if v := f.backend.got[0].Header.Values("X-Forwarded-For"); len(v) != 1 || v[0] != want {
			t.Errorf("public %v: X-Forwarded-For = %q, want %q", public, v, want)
		}
	}
}

// countingCallers counts sign-ins, each a database lookup in the real one.
type countingCallers struct {
	callers
	n int
}

func (c *countingCallers) Resolve(ctx context.Context, authorization string) (*auth.Caller, error) {
	c.n++
	return c.callers.Resolve(ctx, authorization)
}

// An address that keeps failing to sign in is refused before sign-in, so
// before any database work, whichever API it asks for; signing in costs
// nothing of it, and another address has its own.
func TestAddressesThatFailToSignInAreLimitedBeforeSignIn(t *testing.T) {
	f := setup(t, "")
	counting := &countingCallers{callers: f.gw.Callers.(callers)}
	f.gw.Callers = counting
	f.gw.Peers = limits.New()
	f.gw.Settings.UnauthenticatedPerMinute = 3
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	f.gw.Now = func() time.Time { return now }
	from := func(peer, path, token string, headers map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.RemoteAddr = peer
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
	path := "/payments/orders/orders/ord_abcdefgh"
	for i := range 10 {
		if w := from("203.0.113.5:4000", path, "web-person", nil); w.Code != 201 {
			t.Fatalf("signed in, %d: %d", i, w.Code)
		}
	}
	for i := range 3 {
		if w := from("203.0.113.5:4000", path, "wrong", nil); w.Code != 401 {
			t.Fatalf("failed sign-in %d: %d", i, w.Code)
		}
	}
	signIns := counting.n
	for _, p := range []string{path, "/payments/ledger/x", "/made-up/api/x"} {
		if w := from("203.0.113.5:4001", p, "web-person", nil); w.Code != 429 || errorCode(t, w) != "RATE_LIMITED" || w.Header().Get("Retry-After") == "" {
			t.Errorf("%s, past the limit: %d %v %s", p, w.Code, w.Header(), w.Body)
		}
	}
	if counting.n != signIns {
		t.Errorf("signed in %d more times past the limit", counting.n-signIns)
	}
	if w := from("203.0.113.6:4000", path, "web-person", nil); w.Code != 201 {
		t.Errorf("another address: %d", w.Code)
	}
	// An IPv6 host may hold its whole /64: counted as one.
	for range 3 {
		from("[2001:db8:1:2::1]:4000", path, "", nil)
	}
	if w := from("[2001:db8:1:2::ffff]:4000", path, "web-person", nil); w.Code != 429 {
		t.Errorf("the same /64: %d", w.Code)
	}
	now = now.Add(time.Minute)
	if w := from("203.0.113.5:4000", path, "web-person", nil); w.Code != 201 {
		t.Errorf("a minute later: %d", w.Code)
	}

	// Behind trusted proxies on the public listener, it's the address they
	// saw, not the proxy's, that's counted.
	f.api.Internet = true
	f.gw.Public = true
	f.gw.Settings.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	for range 3 {
		from("10.0.0.2:4000", path, "", map[string]string{"X-Forwarded-For": "198.51.100.7"})
	}
	if w := from("10.0.0.2:4000", path, "web-person", map[string]string{"X-Forwarded-For": "198.51.100.7"}); w.Code != 429 {
		t.Errorf("the same client, behind the proxy: %d", w.Code)
	}
	if w := from("10.0.0.2:4000", path, "web-person", map[string]string{"X-Forwarded-For": "198.51.100.8"}); w.Code != 201 {
		t.Errorf("another client, behind the same proxy: %d", w.Code)
	}
}

// A body that doesn't arrive in time is refused, and the connection with
// it; one that does is forwarded, and the answer streams for as long as the
// backend takes, past the body's deadline.
func TestABodyHasADeadlineAndTheAnswerDoesnt(t *testing.T) {
	f := setup(t, "")
	f.gw.Settings.BodyReadTimeout = 300 * time.Millisecond
	f.backend.pause = 600 * time.Millisecond
	srv := httptest.NewServer(f.gw)
	t.Cleanup(srv.Close)

	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "POST /payments/orders/orders HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer web-person\r\n"+
		"Content-Type: application/json\r\nContent-Length: 20\r\n\r\n{\"amount\"")
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	started := time.Now()
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusRequestTimeout || time.Since(started) > 3*time.Second {
		t.Errorf("a body that stalled: %d after %v", res.StatusCode, time.Since(started))
	}
	if len(f.backend.got) != 0 {
		t.Error("forwarded")
	}

	req, _ := http.NewRequest("POST", srv.URL+"/payments/orders/orders", strings.NewReader(`{"amount": 1}`))
	req.Header.Set("Authorization", "Bearer web-person")
	req.Header.Set("Content-Type", "application/json")
	res, err = srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if err != nil || res.StatusCode != http.StatusCreated || string(body) != `{"ok":{"ok":true}` {
		t.Errorf("a slow answer: %d %q %v", res.StatusCode, body, err)
	}
}

type record struct{ team, endpoint, outcome string }

type recorder []record

func (r *recorder) Record(_, team, endpoint, outcome string, _ time.Time, _ time.Duration) {
	*r = append(*r, record{team, endpoint, outcome})
}

// Traffic names an endpoint only once it's the spec's, or the caller has
// signed in: before that, a made-up path is counted, but not as itself.
func TestTrafficNamesAnEndpointOnlyOnceMatchedOrSignedIn(t *testing.T) {
	f := setup(t, "")
	f.api.ID = "api-1"
	var got recorder
	f.gw.Traffic = &got
	f.do("GET", "/payments/orders/made-up-1", "", "", nil)
	f.do("GET", "/payments/orders/made-up-2", "wrong", "", nil)
	f.do("GET", "/payments/orders/orders/ord_abcdefgh", "", "", nil)
	f.do("DELETE", "/payments/orders/orders", "web-person", "", nil)
	f.do("GET", "/payments/orders/orders/ord_abcdefgh", "web-person", "", nil)
	f.do("GET", "/made-up/api/x", "", "", nil)
	want := recorder{
		{"", "", "unauthenticated"},
		{"", "", "unauthenticated"},
		{"", "GET /orders/{orderId}", "unauthenticated"},
		{"web", "DELETE /orders", "blocked"},
		{"web", "GET /orders/{orderId}", "forwarded_2xx"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("recorded %v, want %v", got, want)
	}
}
