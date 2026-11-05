// SPDX-License-Identifier: MIT

package limits

import (
	"fmt"
	"testing"
	"time"
)

// Spent looks without taking: a bucket charged only for what counts.
func TestSpentTakesNothing(t *testing.T) {
	l := New()
	now := time.Now()
	if spent, _ := l.Spent("peer", 2, now); spent || l.Len() != 0 {
		t.Fatalf("a bucket never charged: spent %v, %d held", spent, l.Len())
	}
	l.Allow("peer", 2, now)
	l.Allow("peer", 2, now)
	for range 3 {
		if spent, wait := l.Spent("peer", 2, now); !spent || wait < time.Second {
			t.Fatalf("after two of two: %v, wait %v", spent, wait)
		}
	}
	if spent, _ := l.Spent("peer", 2, now.Add(30*time.Second)); spent {
		t.Error("half a minute later, one is free again")
	}
}

// Keys a caller makes up (its addresses) don't pile up: past SweepAt, the
// buckets that have refilled are dropped.
func TestFullBucketsAreSwept(t *testing.T) {
	l := New()
	now := time.Now()
	for i := range SweepAt {
		l.Allow(fmt.Sprint(i), 60, now)
	}
	l.Allow("busy", 60, now.Add(2*time.Minute))
	l.Allow("busy", 60, now.Add(2*time.Minute))
	l.Allow("new", 60, now.Add(2*time.Minute))
	if l.Len() != 2 {
		t.Errorf("%d buckets held, want the busy one and the new one", l.Len())
	}
}

func TestABucketRefillsAtItsRate(t *testing.T) {
	l := New()
	now := time.Now()
	for i := range 60 {
		if ok, _ := l.Allow("a", 60, now); !ok {
			t.Fatalf("request %d of a minute's 60", i)
		}
	}
	ok, wait := l.Allow("a", 60, now)
	if ok || wait < time.Second {
		t.Errorf("the 61st: %v, wait %v", ok, wait)
	}
	if ok, _ := l.Allow("b", 60, now); !ok {
		t.Error("another team's bucket is its own")
	}
	if ok, _ := l.Allow("a", 60, now.Add(time.Second)); !ok {
		t.Error("a second later, one more")
	}
}
