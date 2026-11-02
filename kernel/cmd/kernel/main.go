// SPDX-License-Identifier: MIT

// kernel is the execution kernel: one binary, one image, a process per
// subcommand, which share nothing but the database (and the ConfigMap's
// settings, internal/config).
//
//	kernel api                      kernel-api: KernelService over Connect, for the console
//	kernel scheduler                kernel-scheduler: claim, dispatch, poll, settle, forever
//	kernel migrate                  apply the database migrations it doesn't have yet
//	kernel sleep [--now]            the sleeper: put an idle platform to sleep (a CronJob)
//	kernel wait-for-postgres ADDR   exit once ADDR (host:port) accepts connections
//	kernel check-heartbeat SECONDS  exit 0 if the scheduler's loop came round that recently
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/rburns629/vertra/kernel/internal/api"
	"github.com/rburns629/vertra/kernel/internal/config"
	"github.com/rburns629/vertra/kernel/internal/dbauth"
	"github.com/rburns629/vertra/kernel/internal/dbsetup"
	"github.com/rburns629/vertra/kernel/internal/executor"
	"github.com/rburns629/vertra/kernel/internal/logging"
	"github.com/rburns629/vertra/kernel/internal/metrics"
	"github.com/rburns629/vertra/kernel/internal/migrate"
	"github.com/rburns629/vertra/kernel/internal/scheduler"
	"github.com/rburns629/vertra/kernel/internal/sleeper"
)

const usage = `usage: kernel api | scheduler | migrate | database-setup | database-token FILE | sleep [--now] | wake | wait-for-postgres HOST:PORT | check-heartbeat SECONDS`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	command, args := os.Args[1], os.Args[2:]
	switch command {
	case "wait-for-postgres":
		if len(args) != 1 {
			fail(usage)
		}
		waitFor(args[0])
		return
	case "check-heartbeat":
		os.Exit(checkHeartbeat(args))
	}
	// The service and logger names the Python kernel logged under.
	names, ok := map[string][2]string{
		"api":       {"kernel-api", "app.api"},
		"scheduler": {"kernel-scheduler", "app.scheduler"},
		"migrate":   {"kernel-migrate", "app.migrate"},
		// A managed server's databases opened to their services (dbsetup).
		"database-setup": {"kernel-database-setup", "app.database_setup"},
		// Its sign-in for pg_dump and pg_restore (moving into a managed server).
		"database-token": {"kernel-database-token", "app.database_token"},
		"sleep":          {"kernel-sleeper", "app.sleeper"},
		"wake":           {"kernel-sleeper", "app.sleeper"},
	}[command]
	if !ok {
		fail(usage)
	}
	service := names[0]
	log := logging.New(service, names[1])
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	settings, err := config.FromEnv()
	if err == nil {
		switch command {
		case "api":
			err = runAPI(ctx, settings, log)
		case "scheduler":
			err = runScheduler(ctx, settings, log)
		case "migrate":
			err = runMigrate(ctx, settings, log)
		case "database-setup":
			err = runDatabaseSetup(ctx, settings, log)
		case "database-token":
			if len(args) != 1 {
				fail(usage)
			}
			err = runDatabaseToken(ctx, settings, args[0])
		case "sleep":
			err = runSleep(ctx, settings, len(args) == 1 && args[0] == "--now", log)
		case "wake":
			err = runWake(ctx, settings, log)
		}
	}
	if err != nil {
		log.Error(service+" failed", "error", err.Error())
		os.Exit(1)
	}
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(2)
}

// waitFor returns once addr accepts a TCP connection: the init container
// that holds a Pod until the release's own Postgres is up.
func waitFor(addr string) {
	for {
		conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(2 * time.Second)
	}
}

// checkHeartbeat is the scheduler's liveness probe: a pass that hangs stops
// the heartbeat, and the probe restarts the Pod.
func checkHeartbeat(args []string) int {
	seconds, err := strconv.Atoi(firstOr(args, ""))
	if err != nil || seconds <= 0 {
		fail(usage)
	}
	settings, err := config.FromEnv()
	if err != nil {
		return 1
	}
	info, err := os.Stat(settings.HeartbeatFile)
	if err != nil || time.Since(info.ModTime()) >= time.Duration(seconds)*time.Second {
		return 1
	}
	return 0
}

func firstOr(args []string, fallback string) string {
	if len(args) > 0 {
		return args[0]
	}
	return fallback
}

func poolFor(ctx context.Context, s config.Settings) (*pgxpool.Pool, error) {
	poolConfig, err := pgxpool.ParseConfig(s.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	// Longest any one statement may run before it fails.
	poolConfig.ConnConfig.RuntimeParams["statement_timeout"] = fmt.Sprint(s.DatabaseCommandTimeout.Milliseconds())
	poolConfig.ConnConfig.ConnectTimeout = s.DatabaseConnectTimeout
	// Not pgx's default (the node's CPUs, at least 4): a 2-CPU node's 4
	// would queue a burst of requests while Postgres sits idle.
	poolConfig.MaxConns = int32(s.DatabaseMaxConnections)
	password, err := passwordFor(ctx, s)
	if err != nil {
		return nil, err
	}
	if password != nil {
		poolConfig.BeforeConnect = func(ctx context.Context, c *pgx.ConnConfig) error {
			p, err := password(ctx, c)
			c.Password = p
			return err
		}
	}
	return pgxpool.NewWithConfig(ctx, poolConfig)
}

// passwordFor is how each new connection gets its password with
// DATABASE_IAM_AUTH (the workload's token, short-lived), or with
// DATABASE_ADMIN_SECRET (database-setup on RDS: the administrator's, from
// Secrets Manager); nil with neither.
func passwordFor(ctx context.Context, s config.Settings) (func(context.Context, *pgx.ConnConfig) (string, error), error) {
	switch {
	case s.DatabaseAdminSecret != "":
		password, err := dbauth.SecretPassword(ctx, s.DatabaseIAMRegion, s.DatabaseAdminSecret)
		if err != nil {
			return nil, err
		}
		return func(context.Context, *pgx.ConnConfig) (string, error) { return password, nil }, nil
	case s.DatabaseIAMAuth == "gcp":
		tokens := dbauth.GCP()
		return func(ctx context.Context, _ *pgx.ConnConfig) (string, error) { return tokens.Password(ctx) }, nil
	case s.DatabaseIAMAuth == "aws":
		tokens, err := dbauth.AWS(ctx, s.DatabaseIAMRegion)
		if err != nil {
			return nil, err
		}
		return func(ctx context.Context, c *pgx.ConnConfig) (string, error) {
			return tokens.Password(ctx, c.Host, c.Port, c.User)
		}, nil
	}
	return nil, nil
}

// connect is one connection (migrations, setup), signed in as poolFor's are.
func connect(ctx context.Context, s config.Settings, database string) (*pgx.Conn, error) {
	c, err := pgx.ParseConfig(s.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("DATABASE_URL: %w", err)
	}
	// No statement_timeout: a migration may build an index for longer.
	c.ConnectTimeout = s.DatabaseConnectTimeout
	if database != "" {
		c.Database = database
	}
	password, err := passwordFor(ctx, s)
	if err != nil {
		return nil, err
	}
	if password != nil {
		if c.Password, err = password(ctx, c); err != nil {
			return nil, err
		}
	}
	return pgx.ConnectConfig(ctx, c)
}

// runDatabaseSetup opens each DATABASE_SETUP database to its service, as
// the managed server's administrator (dbsetup).
func runDatabaseSetup(ctx context.Context, s config.Settings, log *slog.Logger) error {
	if len(s.DatabaseSetup.Grants) == 0 {
		return fmt.Errorf("DATABASE_SETUP: nothing to set up")
	}
	c, err := pgx.ParseConfig(s.DatabaseURL)
	if err != nil {
		return fmt.Errorf("DATABASE_URL: %w", err)
	}
	setup := dbsetup.Setup{Databases: s.DatabaseSetup.Databases}
	for _, r := range s.DatabaseSetup.Roles {
		setup.Roles = append(setup.Roles, dbsetup.Role{Name: r.Name, MemberOf: r.MemberOf})
	}
	for _, g := range s.DatabaseSetup.Grants {
		setup.Grants = append(setup.Grants, dbsetup.Grant{Database: g.Database, Role: g.Role, Regrant: g.Regrant})
	}
	open := func(ctx context.Context, database string) (*pgx.Conn, error) { return connect(ctx, s, database) }
	if err := dbsetup.Run(ctx, open, c.Database, setup); err != nil {
		return err
	}
	log.Info("databases set up", "databases", len(setup.Grants))
	return nil
}

// runDatabaseToken writes the password this workload signs in to
// DATABASE_URL with now (its IAM token, or RDS's administrator password)
// to path, readable only by it: for libpq's tools (pg_dump, pg_restore)
// in the same Pod, which can't fetch one. Never to its output, which is
// logged. A token lasts minutes: it's for connecting, not for keeping.
func runDatabaseToken(ctx context.Context, s config.Settings, path string) error {
	c, err := pgx.ParseConfig(s.DatabaseURL)
	if err != nil {
		return fmt.Errorf("DATABASE_URL: %w", err)
	}
	password, err := passwordFor(ctx, s)
	if err != nil {
		return err
	}
	if password == nil {
		return fmt.Errorf("database-token: neither DATABASE_IAM_AUTH nor DATABASE_ADMIN_SECRET is set")
	}
	token, err := password(ctx, c)
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(token), 0o600)
}

// kubeClient is in-cluster when running as a Pod, else the local kubeconfig,
// limited to the settings' requests a second.
func kubeClient(s config.Settings) (kubernetes.Interface, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		rules := clientcmd.NewDefaultClientConfigLoadingRules()
		if config, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{}).ClientConfig(); err != nil {
			return nil, fmt.Errorf("kubernetes: %w", err)
		}
	}
	// client-go prints the API server's warnings to stderr, unstructured,
	// for every request that draws one (Autopilot's defaulting notice on
	// every Job): each distinct one is logged once instead.
	config.WarningHandler = &onceWarnings{log: logging.New("kernel", "app.kubernetes")}
	config.QPS, config.Burst = float32(s.KubernetesQPS), s.KubernetesBurst
	return kubernetes.NewForConfig(config)
}

type onceWarnings struct {
	log  *slog.Logger
	seen sync.Map
}

func (w *onceWarnings) HandleWarningHeader(code int, agent, text string) {
	if code != 299 || text == "" {
		return
	}
	if _, logged := w.seen.LoadOrStore(text, true); !logged {
		w.log.Warn("kubernetes API warning (logged once)", "warning", text)
	}
}

func runMigrate(ctx context.Context, s config.Settings, log *slog.Logger) error {
	conn, err := connect(ctx, s, "")
	if err != nil {
		return err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	applied, err := migrate.Run(ctx, conn, log)
	if err != nil {
		return err
	}
	log.Info("database is current", "version", migrate.Latest(), "applied", len(applied))
	return nil
}

func runAPI(ctx context.Context, s config.Settings, log *slog.Logger) error {
	serveProfiler(s, log)
	pool, err := poolFor(ctx, s)
	if err != nil {
		return err
	}
	defer pool.Close()
	var callers *api.Callers
	if s.APIAuth == "disabled" {
		log.Warn("kernel-api authentication is DISABLED; for local development only")
	} else {
		if len(s.APIAllowedCallers) == 0 {
			log.Error("API_ALLOWED_CALLERS is empty: kernel-api will refuse every request")
		}
		client, err := kubeClient(s)
		if err != nil {
			return err
		}
		callers = &api.Callers{Review: api.KubernetesReview(client, s.KubernetesTimeout), Audience: s.APITokenAudience,
			Allowed: s.APIAllowedCallers, Log: log}
	}
	service := &api.Service{Pool: pool, MaxTasks: s.MaxTasksPerExecution, Log: log}
	server := &http.Server{Addr: fmt.Sprintf(":%d", s.APIPort), Handler: api.Handler(service, callers, pool, logging.New("kernel-api", "app.access")),
		ReadHeaderTimeout: 10 * time.Second}
	errs := make(chan error, 1)
	if s.APITLSCertFile != "" {
		go func() { errs <- server.ListenAndServeTLS(s.APITLSCertFile, s.APITLSKeyFile) }()
	} else {
		go func() { errs <- server.ListenAndServe() }()
	}
	log.Info("kernel-api listening", "port", s.APIPort, "tls", s.APITLSCertFile != "")
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	log.Info("kernel-api stopped")
	return nil
}

func runScheduler(ctx context.Context, s config.Settings, log *slog.Logger) error {
	serveProfiler(s, log)
	// The scheduler has no other HTTP server: /metrics on its own port.
	go func() {
		server := &http.Server{Addr: fmt.Sprintf(":%d", s.MetricsPort), Handler: metrics.Handler(), ReadHeaderTimeout: 10 * time.Second}
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("metrics server failed", "error", err.Error())
		}
	}()
	log.Info("metrics server listening", "metricsPort", s.MetricsPort)
	pool, err := poolFor(ctx, s)
	if err != nil {
		return err
	}
	defer pool.Close()
	client, err := kubeClient(s)
	if err != nil {
		return err
	}
	tolerations := podTolerations(s.TaskTolerations)
	capacities := map[string]executor.Placement{}
	for kind, p := range s.TaskCapacityPlacements {
		capacities[kind] = executor.Placement{NodeSelector: p.NodeSelector, Tolerations: podTolerations(p.Tolerations)}
	}
	var affinity *corev1.Affinity
	if len(s.TaskAffinity) > 0 {
		data, _ := json.Marshal(s.TaskAffinity)
		affinity = &corev1.Affinity{}
		if err := json.Unmarshal(data, affinity); err != nil {
			return fmt.Errorf("TASK_AFFINITY: %w", err)
		}
	}
	exec := executor.NewKubernetes(client, executor.KubernetesOptions{
		JobTTL: s.JobTTL, ImagePullGrace: s.ImagePullGrace, JobDeadlineGrace: s.JobDeadlineGrace, StartTimeout: s.TaskStartTimeout,
		RequestTimeout: s.KubernetesTimeout, WatchResync: s.WatchResync,
		ExtraEnvironment: s.TaskExtraEnvironment, DefaultResources: s.TaskDefaultResources,
		NodeSelector: s.TaskNodeSelector, Tolerations: tolerations, Affinity: affinity, CapacityPlacements: capacities,
		PodLabels:    s.TaskPodLabels,
		PodHardening: s.TaskPodHardening, ImagePullSecret: s.TaskImagePullSecret,
		LogMaxLines: s.TaskLogMaxLines, LogMaxBytes: s.TaskLogMaxBytes,
	}, logging.New("kernel-scheduler", "app.executors.kubernetes"))
	exec.Watch(ctx)
	metrics.SetUnschedulable(func() float64 { return float64(exec.Unschedulable()) })
	owner, err := os.Hostname()
	if err != nil {
		return err
	}
	opts := scheduler.Options{
		Owner: owner, LeaseDuration: s.LeaseDuration, ClaimLimit: s.ClaimLimit,
		ExecutorConcurrency: s.ExecutorConcurrency, MaxRunning: s.MaxRunning,
		MaxRunningPerTeam: s.MaxRunningPerTeam, RetryBackoff: s.RetryBackoff,
		MaxDispatchFailures: s.MaxDispatchFailures, LogRefresh: s.TaskLogRefresh,
		JobDeadlineGrace: s.JobDeadlineGrace, StartTimeout: s.TaskStartTimeout, ApprovalTimeout: s.ApprovalTimeout,
	}
	loop := &scheduler.Loop{Pool: pool, Executor: exec, Options: opts, PollInterval: s.PollInterval,
		ReleaseAfter: s.ReleaseFinishedAfter, RetentionDays: s.ExecutionRetentionDays, HeartbeatFile: s.HeartbeatFile, Log: log}
	return loop.Run(ctx)
}

// runWake wakes a sleeping install for its next schedule (the wake CronJob).
func runWake(ctx context.Context, s config.Settings, log *slog.Logger) error {
	client, err := kubeClient(s)
	if err != nil {
		return err
	}
	return sleeper.Wake(ctx, s, &sleeper.Platform{Client: client, Namespace: s.SleeperNamespace, Timeout: s.KubernetesTimeout}, log)
}

func runSleep(ctx context.Context, s config.Settings, now bool, log *slog.Logger) error {
	client, err := kubeClient(s)
	if err != nil {
		return err
	}
	pool, err := poolFor(ctx, s)
	if err != nil {
		return err
	}
	defer pool.Close()
	platform := &sleeper.Platform{Client: client, Namespace: s.SleeperNamespace, Timeout: s.KubernetesTimeout}
	activity := func(ctx context.Context) (bool, *time.Time, error) { return sleeper.KernelActivity(ctx, pool) }
	return sleeper.Run(ctx, s, platform, activity, now, log)
}

// podTolerations are the settings' tolerations in the Pod spec's types.
func podTolerations(from []config.Toleration) []corev1.Toleration {
	out := make([]corev1.Toleration, 0, len(from))
	for _, t := range from {
		out = append(out, corev1.Toleration{Key: t.Key, Operator: corev1.TolerationOperator(t.Operator),
			Value: t.Value, Effect: corev1.TaintEffect(t.Effect), TolerationSeconds: t.TolerationSeconds})
	}
	return out
}

// serveProfiler serves Go's profiler on PROFILING_ADDRESS, a loopback
// address (config checks), when it's set: kubectl port-forward to the Pod,
// then go tool pprof http://localhost:6060/debug/pprof/profile.
func serveProfiler(s config.Settings, log *slog.Logger) {
	if s.ProfilingAddress == "" {
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	go func() {
		server := &http.Server{Addr: s.ProfilingAddress, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("profiler failed", "error", err.Error())
		}
	}()
	log.Info("profiler listening", "address", s.ProfilingAddress)
}
