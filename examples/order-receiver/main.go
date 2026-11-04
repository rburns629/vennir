// SPDX-License-Identifier: MIT

// order-receiver is what a system that orders from Vennir runs to hear back:
// it takes the console's signed callbacks (order.finished, run.finished) and
// accepts only the ones that verify. A reference to copy, not a product.
//
// A callback carries Vennir-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256
// of "<t>.<body>"> with the callback's secret (shown once when it was set).
// A post verifies when its time is within five minutes (an old one replayed
// fails) and its HMAC matches, compared in constant time. Anything else is
// refused with 401 and nothing in it is trusted.
//
//	CALLBACK_SECRET_FILE  the callback's secret (never logged)
//	TLS_CERT_FILE, TLS_KEY_FILE  the console posts only to https://
//	PORT  default 8443
//
// GET /received lists what verified (their types, runs and states), for a
// check that the callbacks arrived.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// tolerance is how old (or how far ahead) a signature's time may be.
const tolerance = 5 * time.Minute

// verify checks a callback's Vennir-Signature header against its body.
func verify(secret []byte, header string, body []byte, now time.Time) error {
	var at, sig string
	for _, part := range strings.Split(header, ",") {
		key, value, _ := strings.Cut(strings.TrimSpace(part), "=")
		switch key {
		case "t":
			at = value
		case "v1":
			sig = value
		}
	}
	seconds, err := strconv.ParseInt(at, 10, 64)
	if err != nil || sig == "" {
		return errors.New("no t= and v1= in Vennir-Signature")
	}
	if age := now.Sub(time.Unix(seconds, 0)); age > tolerance || age < -tolerance {
		return errors.New("signed too long ago (or ahead): a replay")
	}
	got, err := hex.DecodeString(sig)
	if err != nil {
		return errors.New("v1 isn't hex")
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(at + "."))
	mac.Write(body)
	if !hmac.Equal(got, mac.Sum(nil)) {
		return errors.New("the signature doesn't match")
	}
	return nil
}

// received is what verified: enough to see it arrived, never the body.
type received struct {
	Type        string `json:"type"`
	ExecutionID string `json:"executionId"`
	State       string `json:"state"`
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	secret, err := os.ReadFile(os.Getenv("CALLBACK_SECRET_FILE"))
	if err != nil || len(strings.TrimSpace(string(secret))) == 0 {
		log.Error("CALLBACK_SECRET_FILE: no secret to verify with")
		os.Exit(1)
	}
	key := []byte(strings.TrimSpace(string(secret)))
	var mu sync.Mutex
	var got []received

	http.HandleFunc("POST /", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "unreadable", http.StatusBadRequest)
			return
		}
		if err := verify(key, r.Header.Get("Vennir-Signature"), body, time.Now()); err != nil {
			log.Warn("callback refused", "reason", err.Error())
			http.Error(w, "unverified", http.StatusUnauthorized)
			return
		}
		var c received
		if err := json.Unmarshal(body, &c); err != nil {
			http.Error(w, "not JSON", http.StatusBadRequest)
			return
		}
		mu.Lock()
		got = append(got, c)
		mu.Unlock()
		log.Info("callback verified", "type", c.Type, "executionId", c.ExecutionID, "state", c.State)
		w.WriteHeader(http.StatusNoContent)
	})
	http.HandleFunc("GET /received", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(got)
	})
	port := os.Getenv("PORT")
	if port == "" {
		port = "8443"
	}
	server := &http.Server{Addr: ":" + port, ReadHeaderTimeout: 10 * time.Second}
	log.Info("listening", "port", port)
	if err := server.ListenAndServeTLS(os.Getenv("TLS_CERT_FILE"), os.Getenv("TLS_KEY_FILE")); err != nil {
		log.Error("server stopped", "error", err.Error())
		os.Exit(1)
	}
}
