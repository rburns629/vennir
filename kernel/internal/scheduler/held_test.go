// SPDX-License-Identifier: MIT

package scheduler

import (
	"testing"
	"time"

	"github.com/rburns629/vennir/kernel/internal/executor"
)

// A finished Job is held until its time, so a log collector can read its
// Pod; stopping releases every one still held.
func TestFinishedJobsAreHeldUntilDue(t *testing.T) {
	var held heldJobs
	start := time.Now()
	a, b := executor.Handle{"jobName": "a"}, executor.Handle{"jobName": "b"}
	held.hold([]executor.Handle{a}, start.Add(30*time.Second))
	held.hold([]executor.Handle{b}, start.Add(60*time.Second))

	equal(t, "nothing due yet", len(held.take(start.Add(10*time.Second))), 0)
	due := held.take(start.Add(30 * time.Second))
	equal(t, "a is due", len(due), 1)
	equal(t, "and it's a", due[0]["jobName"], "a")
	equal(t, "b still held", len(held), 1)
	equal(t, "stopping releases b", held.take(time.Time{})[0]["jobName"], "b")
	equal(t, "none left", len(held), 0)
}
