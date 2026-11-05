// SPDX-License-Identifier: MIT

// Package limits holds each calling team to an API's rate: a token bucket
// per API and team, refilled continuously at the per-minute rate, holding at
// most a minute's worth. Kept in this replica's memory: with N replicas a
// team may get up to N times its rate, which the limits allow for (they're
// to protect backends from a runaway caller, not to meter). The same
// buckets, keyed by a client's address, hold callers who don't sign in to
// a rate before the gateway does any work for them.
package limits

import (
	"sync"
	"time"
)

// SweepAt is how many buckets a limiter holds before it drops the full
// ones (as good as none), at most once a minute: keys made up by callers
// (their addresses) can't grow it without bound.
const SweepAt = 10000

// Limiter is every bucket.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	swept   time.Time
}

type bucket struct {
	tokens    float64
	perMinute int
	at        time.Time
}

// New is an empty limiter.
func New() *Limiter { return &Limiter{buckets: map[string]*bucket{}} }

// refilled is key's bucket at perMinute, as of now. l.mu is held.
func (l *Limiter) refilled(key string, perMinute int, now time.Time) *bucket {
	capacity := float64(perMinute)
	b, ok := l.buckets[key]
	if !ok {
		l.sweep(now)
		b = &bucket{tokens: capacity, at: now}
		l.buckets[key] = b
	}
	b.tokens = min(capacity, b.tokens+now.Sub(b.at).Minutes()*capacity)
	b.perMinute, b.at = perMinute, now
	return b
}

// sweep drops the buckets that have refilled, once there are SweepAt of
// them, at most once a minute. l.mu is held.
func (l *Limiter) sweep(now time.Time) {
	if len(l.buckets) < SweepAt || now.Sub(l.swept) < time.Minute {
		return
	}
	l.swept = now
	for key, b := range l.buckets {
		if b.tokens+now.Sub(b.at).Minutes()*float64(b.perMinute) >= float64(b.perMinute) {
			delete(l.buckets, key)
		}
	}
}

func wait(b *bucket) time.Duration {
	w := time.Duration((1 - b.tokens) / float64(b.perMinute) * float64(time.Minute))
	return max(w, time.Second)
}

// Allow takes one request from key's bucket at perMinute, or says how long
// until one is free.
func (l *Limiter) Allow(key string, perMinute int, now time.Time) (bool, time.Duration) {
	if perMinute <= 0 {
		return false, time.Minute
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.refilled(key, perMinute, now)
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	return false, wait(b)
}

// Spent says whether key's bucket at perMinute is empty, and how long until
// it isn't, taking nothing: for a limit charged only for what turns out to
// count (a failed sign-in), checked before the work.
func (l *Limiter) Spent(key string, perMinute int, now time.Time) (bool, time.Duration) {
	if perMinute <= 0 {
		return true, time.Minute
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok {
		return false, 0
	}
	b = l.refilled(key, perMinute, now)
	if b.tokens >= 1 {
		return false, 0
	}
	return true, wait(b)
}

// Len is how many buckets it holds.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
