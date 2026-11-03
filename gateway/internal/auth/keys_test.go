// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConsoleKeysFollowTheConsolesJWKS(t *testing.T) {
	current := atomic.Value{}
	current.Store("one")
	var fetches atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches.Add(1)
		kid := current.Load().(string)
		x := base64.RawURLEncoding.EncodeToString(secret.Public().(ed25519.PublicKey))
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{
			{"kty": "OKP", "crv": "Ed25519", "x": x, "kid": kid, "alg": "EdDSA"},
			{"kty": "RSA", "kid": "ignored"},
		}})
	}))
	defer server.Close()
	k := &ConsoleKeys{URL: server.URL}
	ctx := context.Background()

	if _, err := k.Key(ctx, "one"); err != nil {
		t.Fatalf("the published key: %v", err)
	}
	if _, err := k.Key(ctx, "one"); err != nil || fetches.Load() != 1 {
		t.Fatalf("a known key is kept, not fetched again: %v, %d fetches", err, fetches.Load())
	}
	// An unknown id right after a fetch is refused without asking again, so
	// made-up ids can't make the gateway hammer the console.
	if _, err := k.Key(ctx, "made-up"); err != ErrUnauthenticated || fetches.Load() != 1 {
		t.Fatalf("an unknown id, just after a fetch: %v, %d fetches", err, fetches.Load())
	}
	// A rotated JWT_SECRET: the new id is fetched once the pause has passed.
	current.Store("two")
	k.fetched = time.Now().Add(-refetchAfter)
	if _, err := k.Key(ctx, "two"); err != nil || fetches.Load() != 2 {
		t.Fatalf("the rotated key: %v, %d fetches", err, fetches.Load())
	}
}

func TestConsoleKeysSayWhenTheConsoleCantBeRead(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	k := &ConsoleKeys{URL: server.URL}
	_, err := k.Key(context.Background(), "one")
	if err == nil || err == ErrUnauthenticated {
		t.Fatalf("an unreadable console is the gateway's problem, not the caller's: %v", err)
	}
	// Nor is it for the requests after, before the set may be read again,
	// or while another request is reading it: they can't say who's signed in.
	if _, err := k.Key(context.Background(), "one"); err != errUnread {
		t.Fatalf("just after a failed read: %v", err)
	}
	k.fetched, k.refreshing = time.Time{}, true
	if _, err := k.Key(context.Background(), "one"); err != errUnread {
		t.Fatalf("while another request reads the set: %v", err)
	}
}

func TestConsoleKeysDropAKeyTheConsoleNoLongerPublishes(t *testing.T) {
	current := atomic.Value{}
	current.Store("one")
	var down atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if down.Load() {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		x := base64.RawURLEncoding.EncodeToString(secret.Public().(ed25519.PublicKey))
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{
			{"kty": "OKP", "crv": "Ed25519", "x": x, "kid": current.Load().(string), "alg": "EdDSA"},
		}})
	}))
	defer server.Close()
	k := &ConsoleKeys{URL: server.URL}
	ctx := context.Background()
	if _, err := k.Key(ctx, "one"); err != nil {
		t.Fatal(err)
	}
	// The console restarting: the last set is still used for a while.
	down.Store(true)
	k.good = time.Now().Add(-keysFor)
	k.fetched = k.good
	if _, err := k.Key(ctx, "one"); err != nil {
		t.Fatalf("while the console can't be read: %v", err)
	}
	// Too old: refused, and still refused by the next request (the failed
	// read doesn't make the set fresh again).
	k.good, k.fetched = time.Now().Add(-keptFor), time.Now().Add(-keptFor)
	if _, err := k.Key(ctx, "one"); err == nil || err == ErrUnauthenticated {
		t.Fatalf("once the last set is too old: %v", err)
	}
	if _, err := k.Key(ctx, "one"); err == nil || err == ErrUnauthenticated {
		t.Fatalf("the request after: %v", err)
	}
	// A caller that gives up doesn't spoil the read for everyone.
	down.Store(false)
	current.Store("two")
	k.fetched = time.Now().Add(-refetchAfter)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := k.Key(canceled, "made-up"); err != ErrUnauthenticated || time.Since(k.good) > time.Second {
		t.Fatalf("a canceled caller's read: %v, read %v ago", err, time.Since(k.good))
	}
	// JWT_SECRET rotated: with no new session to ask about, the old key
	// stops working once the set is read again.
	if _, err := k.Key(ctx, "one"); err != ErrUnauthenticated {
		t.Fatalf("the rotated-out key: %v", err)
	}
	if _, err := k.Key(ctx, "two"); err != nil {
		t.Fatalf("the new key: %v", err)
	}
}

// Many requests at once while a slow read fails: each is told the keys
// can't be checked (never "sign in"), and none races the read (-race).
func TestConsoleKeysUnderConcurrentRequests(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(50 * time.Millisecond)
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer server.Close()
	k := &ConsoleKeys{URL: server.URL}
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := k.Key(context.Background(), "one")
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err == nil || err == ErrUnauthenticated {
			t.Errorf("while the console can't be read: %v", err)
		}
	}
}
