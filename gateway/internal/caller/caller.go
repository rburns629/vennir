// SPDX-License-Identifier: MIT

// Package caller makes the Vennir-Caller header a backend gets with every
// request: who called, as which team, and which API, in a short-lived JWT
// the gateway signs (EdDSA, Ed25519). A backend that cares checks it
// against the gateway's public key at /.vennir/jwks.json; one that doesn't
// can ignore it. A caller can't forge it: the gateway drops any Vennir-*
// header a request arrives with.
package caller

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"time"
)

// Header names the caller to the backend.
const Header = "Vennir-Caller"

// Lifetime is how long a Vennir-Caller token is good for: long enough for
// the request to arrive, too short to replay usefully.
const Lifetime = 60 * time.Second

// Signer signs Vennir-Caller tokens.
type Signer struct {
	Key ed25519.PrivateKey
	// Issuer is the gateway's address, the token's iss.
	Issuer string
}

// Claims are what the token says.
type Claims struct {
	Issuer string `json:"iss"`
	// Subject is the caller: user:<id>.
	Subject string `json:"sub"`
	Email   string `json:"email,omitempty"`
	Bot     bool   `json:"bot,omitempty"`
	// Team is the team it calls as; API is <team>/<name>.
	Team      string `json:"team"`
	API       string `json:"api"`
	Audience  string `json:"aud"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
	// RequestID is the gateway's id for the request, for both sides' logs.
	RequestID string `json:"jti"`
}

// KeyID names the key in the JWKS: a hash of its public half.
func (s *Signer) KeyID() string {
	sum := sha256.Sum256(s.Key.Public().(ed25519.PublicKey))
	return base64.RawURLEncoding.EncodeToString(sum[:12])
}

// Sign makes a token for these claims, issued now.
func (s *Signer) Sign(c Claims, now time.Time) (string, error) {
	c.Issuer = s.Issuer
	c.IssuedAt = now.Unix()
	c.ExpiresAt = now.Add(Lifetime).Unix()
	header, err := json.Marshal(map[string]string{"alg": "EdDSA", "typ": "JWT", "kid": s.KeyID()})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signing := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	return signing + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(s.Key, []byte(signing))), nil
}

// JWKS is the public key, as /.vennir/jwks.json serves it.
func (s *Signer) JWKS() ([]byte, error) {
	return json.Marshal(map[string]any{"keys": []map[string]string{{
		"kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "kid": s.KeyID(),
		"x": base64.RawURLEncoding.EncodeToString(s.Key.Public().(ed25519.PublicKey)),
	}}})
}
