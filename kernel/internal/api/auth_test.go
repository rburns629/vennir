// SPDX-License-Identifier: MIT

package api

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"
)

const console = "system:serviceaccount:vennir-system:execution-console"

type reviews struct {
	asked int
	users map[string]string
	err   error
}

func (r *reviews) review(_ context.Context, token, audience string) (string, error) {
	r.asked++
	if audience != "vennir-kernel-api" {
		return "", nil
	}
	return r.users[token], r.err
}

func callers(r *reviews, allowed ...string) (*Callers, *time.Time) {
	now := time.Now()
	c := &Callers{Review: r.review, Audience: "vennir-kernel-api", Allowed: allowed, Log: quiet}
	c.now = func() time.Time { return now }
	return c, &now
}

func refusedWith(t *testing.T, err error, want connect.Code) {
	t.Helper()
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != want {
		t.Fatalf("err = %v, want %s", err, want)
	}
}

func TestTheAllowedCallerGetsIn(t *testing.T) {
	c, _ := callers(&reviews{users: map[string]string{"t": console}}, console)
	if user, err := c.Caller(context.Background(), "Bearer t"); err != nil || user != console {
		t.Fatalf("%q %v", user, err)
	}
}

func TestNoBearerTokenIsUnauthenticated(t *testing.T) {
	c, _ := callers(&reviews{}, console)
	for _, header := range []string{"", "Basic dXNlcjpwYXNz", "Bearer ", "Bearer"} {
		_, err := c.Caller(context.Background(), header)
		refusedWith(t, err, connect.CodeUnauthenticated)
	}
}

func TestATokenTheAPIServerRejectsIsUnauthenticated(t *testing.T) {
	c, _ := callers(&reviews{}, console)
	_, err := c.Caller(context.Background(), "Bearer forged")
	refusedWith(t, err, connect.CodeUnauthenticated)
}

// A task Pod's own token is valid, but it isn't the console.
func TestAValidTokenFromAnyoneElseIsPermissionDenied(t *testing.T) {
	c, _ := callers(&reviews{users: map[string]string{"t": "system:serviceaccount:team-a:default"}}, console)
	_, err := c.Caller(context.Background(), "Bearer t")
	refusedWith(t, err, connect.CodePermissionDenied)
}

func TestAnEmptyAllowlistRefusesEveryone(t *testing.T) {
	c, _ := callers(&reviews{users: map[string]string{"t": console}})
	_, err := c.Caller(context.Background(), "Bearer t")
	refusedWith(t, err, connect.CodePermissionDenied)
}

func TestAReviewIsReusedUntilItExpires(t *testing.T) {
	r := &reviews{users: map[string]string{"t": console}}
	c, now := callers(r, console)
	for range 3 {
		if _, err := c.Caller(context.Background(), "Bearer t"); err != nil {
			t.Fatal(err)
		}
	}
	if r.asked != 1 {
		t.Errorf("asked %d times", r.asked)
	}
	*now = now.Add(cacheFor + time.Second)
	_, _ = c.Caller(context.Background(), "Bearer t")
	if r.asked != 2 {
		t.Errorf("asked %d times after expiry", r.asked)
	}
}

func TestARefusalIsNeverReused(t *testing.T) {
	r := &reviews{users: map[string]string{"t": "someone-else"}}
	c, _ := callers(r, console)
	for range 2 {
		_, _ = c.Caller(context.Background(), "Bearer t")
	}
	if r.asked != 2 {
		t.Errorf("asked %d times", r.asked)
	}
}

func TestTheCacheStaysBounded(t *testing.T) {
	users := map[string]string{}
	for i := range cacheEntries + 10 {
		users[fmt.Sprint(i)] = console
	}
	c, _ := callers(&reviews{users: users}, console)
	for i := range cacheEntries + 10 {
		if _, err := c.Caller(context.Background(), fmt.Sprintf("Bearer %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if len(c.cache) != cacheEntries || len(c.order) != cacheEntries {
		t.Errorf("cache %d, order %d", len(c.cache), len(c.order))
	}
}

// No fallback: if the API server can't be asked, nobody gets in.
func TestAFailingReviewFailsTheRequest(t *testing.T) {
	c, _ := callers(&reviews{err: errors.New("connection refused")}, console)
	if _, err := c.Caller(context.Background(), "Bearer t"); err == nil {
		t.Fatal("let in")
	}
}
