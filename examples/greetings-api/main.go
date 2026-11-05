// SPDX-License-Identifier: MIT

// The backend of the local sample's API product (catalog-template/samples/
// local/apis/greetings): an HTTP service a team runs in its API backends'
// namespace (<team>-apis), published through the install's gateway. The
// gateway forwards only what
// the API's openapi.yaml describes, and adds a Vennir-Caller header: a JWT,
// signed by the gateway (EdDSA), naming who called and as which team. This
// checks it against the gateway's public keys before answering, so a
// request that didn't come through the gateway gets 401.
//
// A demo, not a product (examples/ is exempt from the production bar):
// standard library only, no persistence.
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// claims are the Vennir-Caller token's (gateway/internal/caller).
type claims struct {
	Issuer    string `json:"iss"`
	Subject   string `json:"sub"`
	Email     string `json:"email"`
	Bot       bool   `json:"bot"`
	Team      string `json:"team"`
	API       string `json:"api"`
	Audience  string `json:"aud"`
	ExpiresAt int64  `json:"exp"`
	RequestID string `json:"jti"`
}

// keys are the gateway's public keys by kid, fetched from its JWKS and
// fetched again for a kid not seen yet (the gateway's key changed).
type keys struct {
	url string
	mu  sync.Mutex
	by  map[string]ed25519.PublicKey
}

func (k *keys) get(kid string) (ed25519.PublicKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if key, ok := k.by[kid]; ok {
		return key, nil
	}
	client := http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(k.url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var set struct {
		Keys []struct{ Kty, Crv, Kid, X string } `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&set); err != nil {
		return nil, err
	}
	k.by = map[string]ed25519.PublicKey{}
	for _, j := range set.Keys {
		x, err := base64.RawURLEncoding.DecodeString(j.X)
		if j.Kty == "OKP" && j.Crv == "Ed25519" && err == nil && len(x) == ed25519.PublicKeySize {
			k.by[j.Kid] = x
		}
	}
	if key, ok := k.by[kid]; ok {
		return key, nil
	}
	return nil, fmt.Errorf("no key %q at %s", kid, k.url)
}

// caller checks the Vennir-Caller token: the gateway's signature, not
// expired, for this backend (aud: its origin, as the API's backend.url has
// it), and for this API (api: <team>/<name>), so another API pointed at the
// same origin can't call it under its own spec and sharing.
func (k *keys) caller(r *http.Request, audience, api string) (*claims, error) {
	parts := strings.Split(r.Header.Get("Vennir-Caller"), ".")
	if len(parts) != 3 {
		return nil, errors.New("no Vennir-Caller token: call it through the gateway")
	}
	var header struct{ Alg, Kid string }
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(raw, &header) != nil || header.Alg != "EdDSA" {
		return nil, errors.New("not an EdDSA token")
	}
	key, err := k.get(header.Kid)
	if err != nil {
		return nil, err
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return nil, errors.New("not the gateway's signature")
	}
	var c claims
	if raw, err = base64.RawURLEncoding.DecodeString(parts[1]); err != nil || json.Unmarshal(raw, &c) != nil {
		return nil, errors.New("unreadable claims")
	}
	if time.Now().Unix() >= c.ExpiresAt {
		return nil, errors.New("expired")
	}
	if c.Audience != audience {
		return nil, fmt.Errorf("for %s, not this backend", c.Audience)
	}
	if c.API != api {
		return nil, fmt.Errorf("for the API %s, not %s", c.API, api)
	}
	return &c, nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	jwks, audience, api := os.Getenv("GATEWAY_JWKS_URL"), os.Getenv("AUDIENCE"), os.Getenv("API")
	if jwks == "" || audience == "" || api == "" {
		log.Error("GATEWAY_JWKS_URL, AUDIENCE (this backend's origin, as backend.url names it) and API (<team>/<name>) are required")
		os.Exit(1)
	}
	k := &keys{url: jwks}
	mux := http.NewServeMux()
	// Not in openapi.yaml, so the gateway never forwards it: the kubelet's.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("GET /greetings/{name}", func(w http.ResponseWriter, r *http.Request) {
		c, err := k.caller(r, audience, api)
		if err != nil {
			log.Warn("refused", "reason", err.Error())
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}
		name := r.PathValue("name")
		style := r.URL.Query().Get("style")
		message := "Hello, " + name + "!"
		if style == "shout" {
			message = strings.ToUpper(message)
		}
		log.Info("greeted", "team", c.Team, "caller", c.Subject, "request", c.RequestID)
		writeJSON(w, http.StatusOK, map[string]string{"message": message, "team": c.Team})
	})
	server := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	log.Info("listening", "addr", server.Addr)
	if err := server.ListenAndServe(); err != nil {
		log.Error("stopped", "err", err.Error())
		os.Exit(1)
	}
}
