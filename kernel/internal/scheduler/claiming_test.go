// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/roburns/vennir/kernel/internal/domain"
	"github.com/roburns/vennir/kernel/internal/executor"
)

func newPass(db DB, owner string, lease time.Duration, now time.Time, set ...func(*Options)) *pass {
	opts := DefaultOptions(owner)
	opts.LeaseDuration = lease
	opts.ClaimLimit = 10
	for _, f := range set {
		f(&opts)
	}
	return &pass{ctx: context.Background(), db: db, opts: opts, now: now, log: quietLog}
}

func claim(t *testing.T, db DB, owner string, lease time.Duration, now time.Time, set ...func(*Options)) []*Task {
	t.Helper()
	claimed, err := newPass(db, owner, lease, now, set...).claimReadyTasks()
	if err != nil {
		t.Fatal(err)
	}
	return claimed
}

func limit(n int) func(*Options) { return func(o *Options) { o.ClaimLimit = n } }

func numbered(n int, teams ...string) []TaskDef {
	var tasks []TaskDef
	for i := range n {
		d := task(fmt.Sprintf("task-%d", i), func(d *TaskDef) { d.Image = "x:local" })
		if len(teams) > 0 {
			d.Team = teams[i]
		}
		tasks = append(tasks, d)
	}
	return tasks
}

func TestClaimsReadyTaskAndSetsLeaseAndAttempt(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-claim-basic", numbered(1)...)
	now := time.Now().UTC().Truncate(time.Microsecond)
	claimed := claim(t, tx, "scheduler-1", 60*time.Second, now)
	if len(claimed) != 1 {
		t.Fatalf("claimed %d", len(claimed))
	}
	c := claimed[0]
	equal(t, "state", c.State, domain.TaskClaimed)
	equal(t, "owner", *c.LeaseOwner, "scheduler-1")
	equal(t, "lease", c.LeaseExpiresAt.Equal(now.Add(60*time.Second)), true)
	equal(t, "attempts", c.AttemptCount, 1)
	equal(t, "execution", c.ExecutionID, id)
	attempts := attemptsOf(t, tx, c.ID)
	if len(attempts) != 1 || attempts[0].Number != 1 {
		t.Errorf("attempts = %+v", attempts)
	}
}

func TestBlockedTasksAreNeverClaimed(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-claim-blocked", task("create-project"), task("deploy-application", dependsOn("create-project")))
	claimed := claim(t, tx, "scheduler-1", time.Minute, time.Now())
	if len(claimed) != 1 || claimed[0].TaskKey != "create-project" {
		t.Errorf("claimed = %v", claimed)
	}
}

func TestAlreadyClaimedTaskIsNotReclaimed(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-claim-twice", numbered(1)...)
	now := time.Now()
	equal(t, "first", len(claim(t, tx, "scheduler-1", time.Minute, now)), 1)
	equal(t, "second", len(claim(t, tx, "scheduler-2", time.Minute, now)), 0)
}

func TestRespectsLimit(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-claim-limit", numbered(3)...)
	equal(t, "claimed", len(claim(t, tx, "scheduler-1", time.Minute, time.Now(), limit(2))), 2)
}

func TestTaskNotYetAvailableIsNotClaimed(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-claim-future", numbered(1)...)
	if _, err := tx.Exec(context.Background(), `UPDATE execution_tasks SET available_at = $2 WHERE execution_id = $1`, id, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	equal(t, "claimed", len(claim(t, tx, "scheduler-1", time.Minute, time.Now())), 0)
}

func TestExpiredClaimedTaskIsResetToReady(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-recover-basic", numbered(1)...)
	at := time.Now()
	claim(t, tx, "scheduler-1", 30*time.Second, at)
	n, err := newPass(tx, "scheduler-2", 30*time.Second, at.Add(31*time.Second)).recoverExpiredLeases()
	if err != nil {
		t.Fatal(err)
	}
	equal(t, "recovered", n, 1)
}

func TestRecoveredTaskIsReclaimableAndGetsANewAttempt(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-recover-reclaim", numbered(1)...)
	at := time.Now()
	equal(t, "first attempt", claim(t, tx, "scheduler-1", 30*time.Second, at)[0].AttemptCount, 1)
	second := claim(t, tx, "scheduler-2", 30*time.Second, at.Add(31*time.Second))
	if len(second) != 1 {
		t.Fatalf("second = %v", second)
	}
	equal(t, "owner", *second[0].LeaseOwner, "scheduler-2")
	equal(t, "attempts", second[0].AttemptCount, 2)
	equal(t, "same task", tasksByKey(t, tx, id)["task-0"].ID, second[0].ID)
}

func TestUnexpiredClaimedTaskIsLeftAlone(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-recover-unexpired", numbered(1)...)
	at := time.Now()
	claim(t, tx, "scheduler-1", 300*time.Second, at)
	n, err := newPass(tx, "scheduler-2", 30*time.Second, at.Add(30*time.Second)).recoverExpiredLeases()
	if err != nil {
		t.Fatal(err)
	}
	equal(t, "recovered", n, 0)
}

func runningWithHandle(t *testing.T, db DB, tk *Task, handle executor.Handle) {
	t.Helper()
	tk.State = domain.TaskRunning
	tk.ExecutorHandle = handle
	if err := saveTask(context.Background(), db, tk); err != nil {
		t.Fatal(err)
	}
}

// A rollout gives the scheduler a new name, so the old Pod's leases expire.
// Its RUNNING tasks already have Jobs; the new owner keeps polling those
// rather than starting each task a second time.
func TestExpiredRunningTaskIsAdoptedNotRestarted(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-recover-adopt", numbered(1)...)
	at := time.Now().UTC().Truncate(time.Microsecond)
	tk := claim(t, tx, "scheduler-1", 30*time.Second, at)[0]
	handle := executor.Handle{"namespace": "test-team", "jobName": "ek-task-0-abc"}
	runningWithHandle(t, tx, tk, handle)
	later := at.Add(31 * time.Second)
	equal(t, "reclaimed", len(claim(t, tx, "scheduler-2", 30*time.Second, later)), 0)
	adopted := tasksByKey(t, tx, id)["task-0"]
	equal(t, "state", adopted.State, domain.TaskRunning)
	equal(t, "owner", *adopted.LeaseOwner, "scheduler-2")
	equal(t, "lease", adopted.LeaseExpiresAt.Equal(later.Add(30*time.Second)), true)
	equal(t, "handle", adopted.ExecutorHandle, handle)
	equal(t, "attempts", adopted.AttemptCount, 1)
}

// A scheduler shutting down releases its leases, so the next one adopts its
// RUNNING tasks on its next pass, long before the lease would expire.
func TestReleasedRunningTaskIsAdoptedAtOnce(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-release-adopt", numbered(1)...)
	at := time.Now()
	tk := claim(t, tx, "scheduler-1", time.Minute, at)[0]
	handle := executor.Handle{"namespace": "test-team", "jobName": "ek-task-0-abc"}
	runningWithHandle(t, tx, tk, handle)
	stop := at.Add(5 * time.Second)
	released, err := ReleaseLeases(context.Background(), tx, "scheduler-1", stop)
	if err != nil {
		t.Fatal(err)
	}
	equal(t, "released", released, 1)
	equal(t, "reclaimed", len(claim(t, tx, "scheduler-2", time.Minute, stop.Add(time.Second))), 0)
	adopted := tasksByKey(t, tx, id)["task-0"]
	equal(t, "state", adopted.State, domain.TaskRunning)
	equal(t, "owner", *adopted.LeaseOwner, "scheduler-2")
	equal(t, "handle", adopted.ExecutorHandle, handle)
	equal(t, "attempts", adopted.AttemptCount, 1)
}

func TestOnlyTheStoppingOwnersLeasesAreReleased(t *testing.T) {
	tx := txFor(t)
	id := submit(t, tx, "idem-release-own", numbered(2)...)
	at := time.Now().UTC().Truncate(time.Microsecond)
	claim(t, tx, "scheduler-1", time.Minute, at, limit(1))
	claim(t, tx, "scheduler-2", time.Minute, at, limit(1))
	released, err := ReleaseLeases(context.Background(), tx, "scheduler-1", at.Add(5*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	equal(t, "released", released, 1)
	for _, tk := range tasksByKey(t, tx, id) {
		want := at.Add(time.Minute)
		if *tk.LeaseOwner == "scheduler-1" {
			want = at.Add(5 * time.Second)
		}
		if !tk.LeaseExpiresAt.Equal(want) {
			t.Errorf("%s's lease = %v, want %v", *tk.LeaseOwner, tk.LeaseExpiresAt, want)
		}
	}
}

// SKIP LOCKED under real concurrency: exactly one of two racing claimers
// gets the single available task. Committed rows, on two connections.
func TestTwoSchedulersRacingNeverDoubleClaim(t *testing.T) {
	ctx := context.Background()
	var id string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		id = submit(t, tx, "idem-claim-race-go", numbered(1)...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = $1`, id) })

	counts := make([]int, 2)
	var wg sync.WaitGroup
	for i, owner := range []string{"scheduler-a", "scheduler-b"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
				claimed, err := newPass(tx, owner, time.Minute, time.Now()).claimReadyTasks()
				counts[i] = len(claimed)
				return err
			})
		}()
	}
	wg.Wait()
	sort.Ints(counts)
	equal(t, "claims", counts, []int{0, 1})
}

func TestThePlatformCapLimitsWhatIsClaimedOrRunning(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-cap-all", numbered(5, "a", "a", "a", "a", "a")...)
	capped := func(o *Options) { o.MaxRunning = 2 }
	equal(t, "first", len(claim(t, tx, "scheduler-1", time.Minute, time.Now(), capped)), 2)
	equal(t, "second", len(claim(t, tx, "scheduler-1", time.Minute, time.Now(), capped)), 0)
}

func teamsOf(tasks []*Task) []string {
	var teams []string
	for _, tk := range tasks {
		teams = append(teams, tk.Team)
	}
	sort.Strings(teams)
	return teams
}

func TestThePerTeamCapLimitsEachTeam(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-cap-team", numbered(6, "a", "a", "a", "b", "b", "b")...)
	claimed := claim(t, tx, "scheduler-1", time.Minute, time.Now(), func(o *Options) { o.MaxRunningPerTeam = 1 })
	equal(t, "teams", teamsOf(claimed), []string{"a", "b"})
}

func TestATeamAtItsCapDoesntStarveTheOthers(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-cap-starve", numbered(6, "a", "a", "a", "a", "a", "b")...)
	claimed := claim(t, tx, "scheduler-1", time.Minute, time.Now(), limit(2), func(o *Options) { o.MaxRunningPerTeam = 1 })
	equal(t, "teams", teamsOf(claimed), []string{"a", "b"})
}

// A shared product runs in its own team's namespace for another team: its
// run counts against both teams' caps (so a team can't run past its own
// by running others' products), and once against the platform's.
func TestASharedProductsRunCountsAgainstBothTeams(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-cap-shared", task("shared", team("a"), forTeam("b")))
	perTeam := func(o *Options) { o.MaxRunningPerTeam = 1 }
	equal(t, "the shared run", len(claim(t, tx, "scheduler-1", time.Minute, time.Now(), perTeam)), 1)

	submit(t, tx, "idem-cap-shared-after", numbered(3, "a", "b", "c")...)
	claimed := claim(t, tx, "scheduler-1", time.Minute, time.Now(), perTeam)
	equal(t, "teams", teamsOf(claimed), []string{"c"})

	// The platform's cap counts the shared run once (and team c's).
	all := func(o *Options) { o.MaxRunning = 3 }
	equal(t, "under the platform's cap", len(claim(t, tx, "scheduler-1", time.Minute, time.Now(), all, limit(1))), 1)
}

// A product's cap counts its every run, whichever team each is for.
func TestAProductsCapCountsItsRunsForEveryTeam(t *testing.T) {
	tx := txFor(t)
	product := capped("teams/a/products/shared", 1)
	submit(t, tx, "idem-cap-product-b", task("for-b", team("a"), forTeam("b"), product))
	submit(t, tx, "idem-cap-product-c", task("for-c", team("a"), forTeam("c"), product))
	equal(t, "claimed", len(claim(t, tx, "scheduler-1", time.Minute, time.Now())), 1)
	equal(t, "then", len(claim(t, tx, "scheduler-1", time.Minute, time.Now())), 0)
}

// keyed is a task that changes project p, keyed on it under scope.
func keyed(id, scope, p string) TaskDef {
	return task(id, inputs(map[string]any{"projectId": p}), concurrency(scope, "projectId"))
}

func TestASecondTaskWithTheSameKeyWaitsUntilTheFirstIsDone(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-key-1", keyed("first", "acme-project", "web-1"))
	later := submit(t, tx, "idem-key-2", keyed("second", "acme-project", "web-1"))
	// Ready after the first (one transaction gives both the same instant).
	if _, err := tx.Exec(context.Background(), `UPDATE execution_tasks SET available_at = available_at + interval '1 millisecond' WHERE execution_id = $1::uuid`, later); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	first := claim(t, tx, "scheduler-1", time.Minute, now)
	equal(t, "first pass", len(first), 1)
	equal(t, "its key", *first[0].ConcurrencyKey, `["acme-project","web-1"]`)
	equal(t, "while it's claimed", len(claim(t, tx, "scheduler-1", time.Minute, now)), 0)
	var waitingOn string
	if err := tx.QueryRow(context.Background(), `SELECT concurrency_key FROM execution_tasks WHERE task_key = 'second' AND state = 'READY'`).Scan(&waitingOn); err != nil {
		t.Fatal(err)
	}
	equal(t, "what the second waits on", waitingOn, `["acme-project","web-1"]`)

	if _, err := tx.Exec(context.Background(), `UPDATE execution_tasks SET state = 'RUNNING' WHERE id = $1::uuid`, first[0].ID); err != nil {
		t.Fatal(err)
	}
	equal(t, "while it runs", len(claim(t, tx, "scheduler-1", time.Minute, now)), 0)
	if _, err := tx.Exec(context.Background(), `UPDATE execution_tasks SET state = 'SUCCEEDED' WHERE id = $1::uuid`, first[0].ID); err != nil {
		t.Fatal(err)
	}
	second := claim(t, tx, "scheduler-1", time.Minute, now)
	equal(t, "after it's done", len(second), 1)
	equal(t, "the other one", second[0].TaskKey, "second")
}

func TestTasksWithDifferentKeysOrNoneRunTogether(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-keys-apart", keyed("a", "acme-project", "web-1"), keyed("b", "acme-project", "web-2"),
		keyed("c", "acme-database", "web-1"), task("d"))
	equal(t, "claimed", len(claim(t, tx, "scheduler-1", time.Minute, time.Now())), 4)
}

func TestTwoTasksWithTheSameKeyInOnePassClaimOne(t *testing.T) {
	tx := txFor(t)
	submit(t, tx, "idem-key-pass", keyed("a", "acme-project", "web-9"), keyed("b", "acme-project", "web-9"))
	equal(t, "claimed", len(claim(t, tx, "scheduler-1", time.Minute, time.Now())), 1)
}

func TestTwoSchedulersNeverClaimTwoTasksWithTheSameKey(t *testing.T) {
	ctx := context.Background()
	var ids []string
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		ids = append(ids, submit(t, tx, "idem-key-race-1", keyed("a", "race-scope", "p-1")))
		ids = append(ids, submit(t, tx, "idem-key-race-2", keyed("b", "race-scope", "p-1")))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE id = ANY($1::uuid[])`, ids) })

	// Each scheduler holds its pass open until both have claimed, so neither
	// sees the other's committed row: only the key's lock can keep them apart.
	counts := make([]int, 2)
	var claimedBoth sync.WaitGroup
	claimedBoth.Add(2)
	var wg sync.WaitGroup
	for i, owner := range []string{"scheduler-a", "scheduler-b"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
				claimed, err := newPass(tx, owner, time.Minute, time.Now()).claimReadyTasks()
				counts[i] = len(claimed)
				claimedBoth.Done()
				claimedBoth.Wait()
				return err
			})
		}()
	}
	wg.Wait()
	sort.Ints(counts)
	equal(t, "claims", counts, []int{0, 1})
}

func TestEachAttemptSaysWhoAskedAndWhatActed(t *testing.T) {
	tx := txFor(t)
	ctx := context.Background()
	id := submit(t, tx, "idem-who-asked", task("only", team("payments")))
	if _, err := tx.Exec(ctx, `UPDATE executions SET requested_by = 'user:ana' WHERE id = $1::uuid`, id); err != nil {
		t.Fatal(err)
	}
	type row struct {
		number                               int
		requestedBy, trigger, actedAs, image string
	}
	attempt := func(n int) row {
		t.Helper()
		var r row
		var by *string
		if err := tx.QueryRow(ctx, `SELECT a.attempt_number, a.requested_by, a.trigger, a.acted_as, a.image FROM task_attempts a
			JOIN execution_tasks t ON t.id = a.task_id WHERE t.execution_id = $1::uuid AND a.attempt_number = $2`, id, n).
			Scan(&r.number, &by, &r.trigger, &r.actedAs, &r.image); err != nil {
			t.Fatal(err)
		}
		if by != nil {
			r.requestedBy = *by
		}
		return r
	}
	again := func(by *string) {
		t.Helper()
		if _, err := tx.Exec(ctx, `UPDATE execution_tasks SET state = 'READY', next_attempt_requested_by = $2
			WHERE execution_id = $1::uuid`, id, by); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	claim(t, tx, "scheduler-1", time.Minute, now)
	equal(t, "first", attempt(1), row{1, "user:ana", "submitted", "payments/default", "demo-project-product:local"})

	sam := "user:sam"
	again(&sam)
	claimed := claim(t, tx, "scheduler-1", time.Minute, now)
	equal(t, "retried by someone", attempt(2), row{2, "user:sam", "retried", "payments/default", "demo-project-product:local"})
	equal(t, "cleared", claimed[0].NextAttemptRequestedBy == nil, true)

	again(nil)
	claim(t, tx, "scheduler-1", time.Minute, now)
	equal(t, "retried automatically", attempt(3), row{3, "", "automatic_retry", "payments/default", "demo-project-product:local"})
}
