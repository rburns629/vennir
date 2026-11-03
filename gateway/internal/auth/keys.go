// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Keys are the public keys sessions are signed with, by key id.
type Keys interface {
	Key(ctx context.Context, kid string) (ed25519.PublicKey, error)
}

// refetchAfter is how soon an unknown key id may fetch the set again: a
// JWT_SECRET just rotated is picked up at once, but a stream of made-up ids
// can't make the gateway hammer the console.
const refetchAfter = 30 * time.Second

// keysFor is how long a fetched set is used before it's fetched again, so a
// key the console stopped publishing (JWT_SECRET rotated to end every
// session) stops working here within it, even where no new session comes.
const keysFor = time.Minute

// keptFor is how long the last set fetched is still used while the console
// can't be read (a restart), rather than refusing every session.
const keptFor = 10 * time.Minute

// ConsoleKeys reads the console's session keys from its JWKS
// (GET /api/auth/jwks, console/src/sessionKeys.ts), fetching them again
// every keysFor, and at once (at most every refetchAfter) when a session
// names one it doesn't know. One is shared by every listener.
type ConsoleKeys struct {
	URL    string
	Client *http.Client

	mu      sync.Mutex
	keys    map[string]ed25519.PublicKey
	fetched time.Time // the last attempt
	good    time.Time // the last fetch that worked
}

// Key is the public key with this id.
func (k *ConsoleKeys) Key(ctx context.Context, kid string) (ed25519.PublicKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	key, known := k.keys[kid]
	if known && time.Since(k.fetched) < keysFor {
		return key, nil
	}
	if !known && time.Since(k.fetched) < refetchAfter {
		return nil, ErrUnauthenticated
	}
	k.fetched = time.Now()
	keys, err := k.fetch(ctx)
	if err != nil {
		if known && time.Since(k.good) < keptFor {
			return key, nil
		}
		return nil, err
	}
	k.keys, k.good = keys, k.fetched
	if key, ok := k.keys[kid]; ok {
		return key, nil
	}
	return nil, ErrUnauthenticated
}

func (k *ConsoleKeys) fetch(ctx context.Context) (map[string]ed25519.PublicKey, error) {
	client := k.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.URL, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the console's session keys: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the console's session keys: %s", res.Status)
	}
	var set struct {
		Keys []struct {
			Kty, Crv, X, Kid, Alg string
		} `json:"keys"`
	}
	if err := json.NewDecoder(res.Body).Decode(&set); err != nil {
		return nil, fmt.Errorf("the console's session keys: %w", err)
	}
	keys := map[string]ed25519.PublicKey{}
	for _, key := range set.Keys {
		if key.Kty != "OKP" || key.Crv != "Ed25519" || key.Kid == "" {
			continue
		}
		raw, err := base64.RawURLEncoding.DecodeString(key.X)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			continue
		}
		keys[key.Kid] = ed25519.PublicKey(raw)
	}
	if len(keys) == 0 {
		return nil, errors.New("the console's session keys: none usable")
	}
	return keys, nil
}
