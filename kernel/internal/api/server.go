// SPDX-License-Identifier: MIT

package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/rburns629/vennir/kernel/internal/gen/vennir/kernel/v1/kernelv1connect"
	"github.com/rburns629/vennir/kernel/internal/metrics"
	"github.com/rburns629/vennir/kernel/internal/migrate"
)

// Handler is kernel-api: KernelService (behind the caller check, unless
// callers is nil: development only), /health/live, /health/ready and
// /metrics, every request logged and measured.
func Handler(service *Service, callers *Callers, pool *pgxpool.Pool, log *slog.Logger) http.Handler {
	options := []connect.HandlerOption{connect.WithReadMaxBytes(MaxRequestBytes)}
	if callers != nil {
		options = append(options, connect.WithInterceptors(callers.Interceptor()))
	}
	mux := http.NewServeMux()
	path, handler := kernelv1connect.NewKernelServiceHandler(service, options...)
	mux.Handle(path, handler)
	// Liveness never touches the database: a slow database shouldn't get
	// the process restarted.
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) { status(w, http.StatusOK, "ok") })
	// Ready once the database answers and is at this code's schema.
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if migrate.Current(ctx, pool) != migrate.Latest() {
			status(w, http.StatusServiceUnavailable, "Database unavailable, or not yet migrated.")
			return
		}
		status(w, http.StatusOK, "ok")
	})
	mux.Handle("GET /metrics", metrics.Handler())
	return access(mux, path, log)
}

func status(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	key := "status"
	if code != http.StatusOK {
		key = "detail"
	}
	_ = json.NewEncoder(w).Encode(map[string]string{key: message})
}

type recorder struct {
	http.ResponseWriter
	status int
}

func (r *recorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// access logs and measures each request, labelled by its route, never its
// literal path, so the metrics' cardinality stays bounded.
func access(next http.Handler, servicePath string, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get("X-Request-ID")
		if requestID == "" {
			requestID = uuid.NewString()
		}
		w.Header().Set("X-Request-ID", requestID)
		started := time.Now()
		rec := &recorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		elapsed := time.Since(started)
		route := r.URL.Path
		switch {
		case strings.HasPrefix(route, servicePath), route == "/health/live", route == "/health/ready", route == "/metrics":
		default:
			route = "other"
		}
		metrics.HTTPRequests.WithLabelValues(r.Method, route, strconv.Itoa(rec.status)).Inc()
		metrics.HTTPDuration.WithLabelValues(r.Method, route).Observe(elapsed.Seconds())
		if route == "/health/live" || route == "/health/ready" || route == "/metrics" {
			return // probes and scrapes: counted, not logged
		}
		log.Info("request handled", "requestId", requestID, "httpMethod", r.Method, "httpPath", route,
			"httpStatus", rec.status, "durationMs", float64(elapsed.Microseconds())/1000)
	})
}
