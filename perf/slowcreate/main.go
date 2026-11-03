// SPDX-License-Identifier: MIT

// slowcreate is an admission webhook for the performance cluster only
// (perf/README.md, "A create that timed out"): it holds the first create
// of each Job it's sent for DELAY (plus up to JITTER more, at random),
// then allows it. Held longer than the kernel waits, the API server gives
// up on the create with the kernel; held to just under it, the API server
// makes the Job and its answer comes too late: a create that timed out but
// happened. A Job's second
// create (the scheduler's retry of the same attempt) passes at once, as
// AlreadyExists, for the kernel to adopt. It logs, as JSON, each hold and
// whether the API server gave up on it first.
package main

import (
	"encoding/json"
	"log/slog"
	"math/rand/v2" // nosemgrep: go.lang.security.audit.crypto.math_random.math-random-used -- jitters a test delay, nothing secret
	"net/http"
	"os"
	"sync"
	"time"
)

type review struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Request    *struct {
		UID       string `json:"uid"`
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
		Operation string `json:"operation"`
	} `json:"request"`
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	delay, err := time.ParseDuration(os.Getenv("DELAY"))
	if err != nil {
		log.Error("DELAY isn't a duration", "err", err)
		os.Exit(1)
	}
	jitter, err := time.ParseDuration(os.Getenv("JITTER"))
	if err != nil {
		jitter = 0
	}
	var mu sync.Mutex
	seen := map[string]bool{}

	http.HandleFunc("/validate", func(w http.ResponseWriter, r *http.Request) {
		var in review
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Request == nil {
			http.Error(w, "not an AdmissionReview", http.StatusBadRequest)
			return
		}
		key := in.Request.Namespace + "/" + in.Request.Name
		mu.Lock()
		first := !seen[key]
		seen[key] = true
		mu.Unlock()
		if first {
			start := time.Now()
			hold := delay
			if jitter > 0 {
				hold += rand.N(jitter)
			}
			select {
			case <-time.After(hold):
				log.Info("held a first create", "job", key, "held", time.Since(start).String())
			case <-r.Context().Done():
				log.Info("the API server gave up on a first create", "job", key, "after", time.Since(start).String())
				return
			}
		} else {
			log.Info("passed a later create", "job", key)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"apiVersion": in.APIVersion,
			"kind":       in.Kind,
			"response":   map[string]any{"uid": in.Request.UID, "allowed": true},
		})
	})
	log.Info("listening", "delay", delay.String(), "jitter", jitter.String())
	if err := http.ListenAndServeTLS(":8443", "/tls/tls.crt", "/tls/tls.key", nil); err != nil {
		log.Error("serving", "err", err)
		os.Exit(1)
	}
}
