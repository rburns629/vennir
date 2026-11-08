// SPDX-License-Identifier: MIT

package main

import (
	"testing"

	"github.com/roburns/vennir/cli/internal/githost"
)

// After a take-over, the old push's run (to the other registry) and an
// earlier run by hand aren't waited on: only the new run by hand, told by
// its id (a later one than the commit had), whatever the clocks say.
func TestSinceDispatch(t *testing.T) {
	runs := []githost.Run{
		{ID: 10, Event: "push"},
		{ID: 11, Event: "workflow_dispatch"},
		{ID: 12, Event: "workflow_dispatch"},
		{ID: 13, Event: "push"},
	}
	got := sinceDispatch(runs, &dispatch{commit: "c", after: 11})
	if len(got) != 1 || got[0].ID != 12 {
		t.Errorf("waited on %v", got)
	}
	if len(sinceDispatch(runs, nil)) != 4 {
		t.Error("a push's runs were filtered")
	}
}
