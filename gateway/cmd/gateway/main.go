// SPDX-License-Identifier: MIT

// The gateway (decision 20): one front door for every team's API products,
// forwarding to each API's backend exactly what its OpenAPI document
// describes (internal/gateway). It reads the console's database and never
// writes it; it holds no state of its own beyond rate counters.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/rburns629/vertra/gateway/internal/auth"
	"github.com/rburns629/vertra/gateway/internal/caller"
	"github.com/rburns629/vertra/gateway/internal/config"
	"github.com/rburns629/vertra/gateway/internal/credentials"
	"github.com/rburns629/vertra/gateway/internal/dbauth"
	"github.com/rburns629/vertra/gateway/internal/gateway"
	"github.com/rburns629/vertra/gateway/internal/limits"
	"github.com/rburns629/vertra/gateway/internal/store"
	"github.com/rburns629/vertra/gateway/internal/traffic"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "gateway")
	if err := run(log); err != nil {
		log.Error("gateway stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	s, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	poolConfig, err := pgxpool.ParseConfig(s.DatabaseURL)
	if err != nil {
		return fmt.Errorf("DATABASE_URL: %w", err)
	}
	// Not pgx's default (the node's CPUs, at least 4), which would queue a
	// burst of calls on a small node.
	poolConfig.MaxConns = int32(max(s.DatabaseMaxConnections, 1))
	poolConfig.ConnConfig.ConnectTimeout = s.DatabaseConnectTimeout
	if s.DatabaseIAMAuth == "aws" {
		// Its role's token for Amazon RDS, signed locally with its Pod
		// Identity's credentials (the agent's address, which its
		// NetworkPolicy leaves open; the instance metadata service's isn't).
		tokens, err := dbauth.AWS(ctx, s.DatabaseIAMRegion)
		if err != nil {
			return err
		}
		poolConfig.BeforeConnect = func(ctx context.Context, c *pgx.ConnConfig) error {
			p, err := tokens.Password(ctx, c.Host, c.Port, c.User)
			c.Password = p
			return err
		}
	}
	if s.DatabaseIAMAuth == "gcp" {
		// Its Workload Identity's token, short-lived, as each connection's
		// password (Cloud SQL's IAM database authentication): federated from
		// its own ServiceAccount token, since its NetworkPolicy keeps it from
		// the metadata server.
		password := dbauth.GCP().Password
		if s.DatabaseIAMAccount != "" {
			password = (&dbauth.Federated{
				TokenFile: s.DatabaseIAMTokenFile, STSAudience: s.GCPAudience, Account: s.DatabaseIAMAccount,
				STS: "https://sts.googleapis.com/v1/token", IAMCredentials: "https://iamcredentials.googleapis.com",
				Client: &http.Client{Timeout: 10 * time.Second}, Now: time.Now,
			}).Password
		}
		poolConfig.BeforeConnect = func(ctx context.Context, c *pgx.ConnConfig) error {
			p, err := password(ctx)
			c.Password = p
			return err
		}
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return err
	}
	defer pool.Close()
	apis := &store.Store{DB: pool, Log: log}
	// The database may not let it in yet: on a fresh install the console's
	// migration makes its role (console/src/db/gatewayAccess.ts) after the
	// gateway has started. It waits, rather than crash-looping meanwhile.
	for wait := time.Now().Add(10 * time.Minute); ; {
		err := apis.Refresh(ctx)
		if err == nil {
			break
		}
		if time.Now().After(wait) || ctx.Err() != nil {
			return err
		}
		log.Warn("the console's database isn't ready for the gateway yet; trying again", "error", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
	go apis.Run(ctx, s.Refresh)
	tokenRequest, err := credentials.InCluster()
	if err != nil {
		return err
	}
	recorder := &traffic.Recorder{DB: pool, Log: log}
	go recorder.Run(ctx, 30*time.Second)
	registry := prometheus.NewRegistry()
	metrics := gateway.NewMetrics(registry)
	// One set of the console's keys, so both listeners drop a rotated one alike.
	consoleKeys := &auth.ConsoleKeys{URL: s.ConsoleURL + "/api/auth/jwks"}
	newGateway := func(public bool) *gateway.Gateway {
		return &gateway.Gateway{
			Store:   apis,
			Callers: &auth.Resolver{DB: pool, Keys: consoleKeys, SSO: s.SSO},
			Signer:  &caller.Signer{Key: s.SigningKey, Issuer: s.Issuer},
			Limiter: limits.New(),
			Minter:  &credentials.Minter{TokenRequest: tokenRequest, GCPAudience: s.GCPAudience, GCPTokenAudience: s.GCPTokenAudience},
			Settings: gateway.Settings{BackendHosts: s.BackendHosts, InternetTeams: s.InternetTeams,
				DefaultPerMinute: s.DefaultPerMinute, Closed: s.Closed},
			Log: log, Metrics: metrics, Traffic: recorder, Public: public,
		}
	}
	servers := []*http.Server{
		server(s.Listen, newGateway(false)),
		server(s.MetricsListen, promhttp.HandlerFor(registry, promhttp.HandlerOpts{})),
	}
	if s.PublicListen != "" {
		servers = append(servers, server(s.PublicListen, newGateway(true)))
	}
	failed := make(chan error, len(servers))
	for _, srv := range servers {
		go func() {
			if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				failed <- err
			}
		}()
	}
	log.Info("gateway listening", "listen", s.Listen, "public", s.PublicListen, "apis", apis.Len())
	select {
	case <-ctx.Done():
	case err := <-failed:
		return err
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, srv := range servers {
		_ = srv.Shutdown(shutdown)
	}
	return nil
}

func server(addr string, h http.Handler) *http.Server {
	// No write timeout: answers stream for as long as the backend sends.
	return &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
}
