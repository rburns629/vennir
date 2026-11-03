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
// (GET /api/auth/jwks, console/src/sessionKeys.ts). A set is used for
// keysFor after it was read; then, or when a session names a key it doesn't
// know, it's read again (at most every refetchAfter, one read at a time,
// outside the lock so other requests aren't held up). One is shared by
// every listener.
type ConsoleKeys struct {
	URL    string
	Client *http.Client

	mu         sync.Mutex
	keys       map[string]ed25519.PublicKey
	fetched    time.Time // the last attempt
	good       time.Time // the last read that worked
	refreshing bool
}

// errStale is a known key whose set is too old to trust any longer.
var errStale = errors.New("the console's session keys: not read for too long")

// errUnread is a key id the gateway can't look up yet: the set is being
// read, or the last read failed. Not the caller's fault (a 503, not "sign
// in"): right after a rotation, or the gateway's start, a valid session
// may name it.
var errUnread = errors.New("the console's session keys: being read, or couldn't be")

// Key is the public key with this id.
func (k *ConsoleKeys) Key(ctx context.Context, kid string) (ed25519.PublicKey, error) {
	k.mu.Lock()
	key, known := k.keys[kid]
	if known && time.Since(k.good) < keysFor {
		k.mu.Unlock()
		return key, nil
	}
	if k.refreshing || time.Since(k.fetched) < refetchAfter {
		// Another request is reading them, or one just did.
		usable := known && time.Since(k.good) < keptFor
		unread := k.refreshing || k.good.Before(k.fetched)
		k.mu.Unlock()
		switch {
		case usable:
			return key, nil
		case known:
			return nil, errStale
		case unread:
			return nil, errUnread
		}
		return nil, ErrUnauthenticated
	}
	k.refreshing, k.fetched = true, time.Now()
	k.mu.Unlock()

	// Not the caller's to cancel: every request relies on this read.
	keys, err := k.fetch(context.WithoutCancel(ctx))

	k.mu.Lock()
	defer k.mu.Unlock()
	k.refreshing = false
	if err != nil {
		if known && time.Since(k.good) < keptFor {
			return key, nil
		}
		return nil, err
	}
	k.keys, k.good = keys, time.Now()
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
