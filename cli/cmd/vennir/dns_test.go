// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"testing"
)

// A record is found when the name already leads to its target, and not
// otherwise.
func TestResolvesTo(t *testing.T) {
	ctx := context.Background()
	if !resolvesTo(ctx, "localhost", "A", "127.0.0.1") {
		t.Error("localhost should resolve to 127.0.0.1")
	}
	if resolvesTo(ctx, "localhost", "A", "192.0.2.1") {
		t.Error("localhost doesn't resolve to 192.0.2.1")
	}
	if resolvesTo(ctx, "no-such-name.invalid", "A", "192.0.2.1") {
		t.Error(".invalid never resolves")
	}
}
