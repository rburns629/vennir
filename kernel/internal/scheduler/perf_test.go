// SPDX-License-Identifier: MIT

package scheduler

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/rburns629/vennir/kernel/internal/executor"
)

// The scheduler and Postgres alone (perf/README.md, phase 1): schedulers
// side by side, each with a fake executor whose steps finish the moment
// they start, passing back to back with committed transactions on the test
// database. What's measured is claiming, dispatching, recording and
// releasing, with no Kubernetes at all: the ceiling the database and the
// scheduler's own logic put on steps a second. A benchmark, so it runs only
// with VENNIR_PERF=1, and checks what a load mustn't break: every run
// succeeds, and no step is started twice.
func TestPerfSchedulerThroughput(t *testing.T) {
	if os.Getenv("VENNIR_PERF") == "" {
		t.Skip("a benchmark: VENNIR_PERF=1 go test ./internal/scheduler -run TestPerf -v (perf/README.md)")
	}
	for _, w := range []struct {
		name       string
		executions int
		steps      int
	}{
		{"single", 400, 1},
		{"chain", 40, 10},
	} {
		for _, schedulers := range []int{1, 2, 4} {
			t.Run(fmt.Sprintf("%s/%d-schedulers", w.name, schedulers), func(t *testing.T) {
				perfRun(t, w.executions, w.steps, schedulers)
			})
		}
	}
}

func perfRun(t *testing.T, executions, steps, schedulers int) {
	ctx := context.Background()
	prefix := fmt.Sprintf("perf-%d-", time.Now().UnixNano())
	defer func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM executions WHERE idempotency_key LIKE $1`, prefix+"%")
	}()
	if err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
		for i := range executions {
			var defs []TaskDef
			for n := range steps {
				if n == 0 {
					defs = append(defs, task(fmt.Sprintf("s%d", n)))
				} else {
					defs = append(defs, task(fmt.Sprintf("s%d", n), dependsOn(fmt.Sprintf("s%d", n-1))))
				}
			}
			submit(t, tx, fmt.Sprintf("%s%d", prefix, i), defs...)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	done := func() int {
		var n int
		if err := testPool.QueryRow(ctx, `SELECT count(*) FROM executions WHERE idempotency_key LIKE $1
			AND state IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`, prefix+"%").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	fakes := make([]*fakeExec, schedulers)
	ticks := make([]int, schedulers)
	var errMu sync.Mutex
	var firstErr error
	deadline := time.Now().Add(5 * time.Minute)
	started := time.Now()
	var wg sync.WaitGroup
	for s := range schedulers {
		fakes[s] = fake()
		wg.Go(func() {
			opts := DefaultOptions(fmt.Sprintf("perf-scheduler-%d", s))
			completed := 0
			for time.Now().Before(deadline) {
				err := pgx.BeginFunc(ctx, testPool, func(tx pgx.Tx) error {
					_, err := RunTick(ctx, tx, fakes[s], opts, time.Now(), quietLog)
					return err
				})
				if err != nil {
					errMu.Lock()
					firstErr = err
					errMu.Unlock()
					return
				}
				ticks[s]++
				// Whatever it started has finished, for the next pass to record.
				for ; completed < len(fakes[s].Started); completed++ {
					fakes[s].Complete(executor.Handle{"fakeId": fmt.Sprint(completed + 1)}, map[string]any{})
				}
				if ticks[s]%20 == 0 && done() == executions {
					return
				}
			}
		})
	}
	wg.Wait()
	elapsed := time.Since(started)
	if firstErr != nil {
		t.Fatal(firstErr)
	}

	// Every run succeeded; every step started once, and only once.
	var succeeded, attempts, twice int
	if err := testPool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM executions WHERE idempotency_key LIKE $1 AND state = 'SUCCEEDED'),
		(SELECT count(*) FROM task_attempts a JOIN execution_tasks k ON k.id = a.task_id JOIN executions e ON e.id = k.execution_id WHERE e.idempotency_key LIKE $1),
		(SELECT count(*) FROM execution_tasks k JOIN executions e ON e.id = k.execution_id WHERE e.idempotency_key LIKE $1 AND k.attempt_count > 1)`,
		prefix+"%").Scan(&succeeded, &attempts, &twice); err != nil {
		t.Fatal(err)
	}
	starts := 0
	for _, f := range fakes {
		starts += len(f.StartCalls)
	}
	total := executions * steps
	if succeeded != executions || attempts != total || twice != 0 || starts != total {
		t.Errorf("%d of %d runs succeeded; %d attempts, %d starts for %d steps; %d step(s) attempted twice", succeeded, executions, attempts, starts, total, twice)
	}
	allTicks := 0
	for _, n := range ticks {
		allTicks += n
	}
	t.Logf("%d steps (%d runs of %d) by %d scheduler(s): %.1fs, %.0f steps/s, %d passes (%.1f ms each on average)",
		total, executions, steps, schedulers, elapsed.Seconds(), float64(total)/elapsed.Seconds(), allTicks,
		float64(elapsed.Milliseconds())*float64(schedulers)/float64(max(allTicks, 1)))
}
