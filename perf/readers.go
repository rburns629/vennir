// SPDX-License-Identifier: MIT
package main

import (
	"context"
	"math/rand/v2" // nosemgrep: go.lang.security.audit.crypto.math_random.math-random-used -- picks which run to read, nothing secret
	"sync"
	"time"
)

// reads are what the readers measured: how long each kind of read took
// while the run went on, and how many failed.
type reads struct {
	List, Get       []time.Duration
	ListErr, GetErr int
}

// startReaders runs n readers until the returned function is called, each
// doing what someone watching does: the Runs page (ListExecutions, 50 at a
// time) and a run's page (GetExecution of one of this run's), in turn.
func startReaders(ctx context.Context, c *console, n int, runs func() []string) func() reads {
	if n <= 0 {
		return func() reads { return reads{} }
	}
	ctx, stop := context.WithCancel(ctx)
	var mu sync.Mutex
	var got reads
	var wg sync.WaitGroup
	for range n {
		wg.Go(func() {
			for ctx.Err() == nil {
				at := time.Now()
				var out struct{}
				err := c.call(ctx, "ExecutionService/ListExecutions", map[string]any{"limit": 50}, &out)
				took := time.Since(at)
				ids := runs()
				var getTook time.Duration
				var getErr error
				if len(ids) > 0 {
					at = time.Now()
					_, getErr = c.get(ctx, ids[rand.IntN(len(ids))])
					getTook = time.Since(at)
				}
				if ctx.Err() != nil {
					return
				}
				mu.Lock()
				if err != nil {
					got.ListErr++
				} else {
					got.List = append(got.List, took)
				}
				if len(ids) > 0 {
					if getErr != nil {
						got.GetErr++
					} else {
						got.Get = append(got.Get, getTook)
					}
				}
				mu.Unlock()
			}
		})
	}
	return func() reads {
		stop()
		wg.Wait()
		mu.Lock()
		defer mu.Unlock()
		return got
	}
}
