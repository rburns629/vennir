// SPDX-License-Identifier: MIT

// Package config is the kernel's settings, read once from the environment
// (the chart's ConfigMap) and checked at startup, so a misconfiguration
// fails at once and legibly. One Settings for every process (kernel-api,
// kernel-scheduler, the sleeper): each reads what it needs; they share the
// ConfigMap.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/rburns629/vennir/kernel/internal/domain"
)

// Toleration is one Pod toleration, as the Pod spec spells it.
// Placement is a node selector and tolerations, in the Pod spec's shape.
type Placement struct {
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`
	Tolerations  []Toleration      `json:"tolerations,omitempty"`
}

type Toleration struct {
	Key               string `json:"key,omitempty"`
	Operator          string `json:"operator,omitempty"`
	Value             string `json:"value,omitempty"`
	Effect            string `json:"effect,omitempty"`
	TolerationSeconds *int64 `json:"tolerationSeconds,omitempty"`
}

// DatabaseSetup is dbsetup.Setup, as DATABASE_SETUP gives it.
type DatabaseSetup struct {
	Databases []string        `json:"databases,omitempty"`
	Roles     []DatabaseRole  `json:"roles,omitempty"`
	Grants    []DatabaseGrant `json:"grants"`
}

// DatabaseRole is a login role to make when missing (dbsetup.Role).
type DatabaseRole struct {
	Name     string   `json:"name"`
	MemberOf []string `json:"memberOf,omitempty"`
}

// DatabaseGrant opens one database to the role it's for (dbsetup.Grant).
type DatabaseGrant struct {
	Database string `json:"database"`
	Role     string `json:"role"`
	Regrant  bool   `json:"regrant,omitempty"`
}

// Settings is every process's settings.
type Settings struct {
	DatabaseURL string
	// Longest any one statement may run before it fails.
	DatabaseCommandTimeout time.Duration
	// Longest a new connection may take to open. Without it, one opened as
	// Postgres moves (its Pod replaced) waits out the kernel's TCP retries,
	// about two minutes, and every pass waits with it.
	DatabaseConnectTimeout time.Duration
	// Most connections this process holds (each request kernel-api serves
	// takes one); the size keeps every process's sum under Postgres's
	// max_connections.
	DatabaseMaxConnections int
	// DatabaseIAMAuth signs in with the workload's own cloud identity
	// instead of a password: "gcp" (Cloud SQL's IAM database
	// authentication), "aws" (Amazon RDS's, in DatabaseIAMRegion), or ""
	// (the URL's password, if any).
	DatabaseIAMAuth   string
	DatabaseIAMRegion string
	// DatabaseSetup is what `kernel database-setup` does, as a managed
	// server's administrator (DATABASE_URL names its maintenance database);
	// on RDS signing in with the password in DatabaseAdminSecret, a Secrets
	// Manager secret's ARN (RDS keeps it there; nothing else of Vennir's).
	DatabaseSetup       DatabaseSetup
	DatabaseAdminSecret string

	// kernel-api. Who may call it: each request carries a Kubernetes
	// ServiceAccount token issued for APITokenAudience; a TokenReview checks
	// it, and its username must be in APIAllowedCallers
	// ("system:serviceaccount:<namespace>:<name>": the console's). An empty
	// list refuses everyone. APIAuth "disabled" skips the check, for running
	// kernel-api outside a cluster in development only.
	APIAuth           string
	APITokenAudience  string
	APIAllowedCallers []string
	APIPort           int
	// kernel-api serves HTTPS with this certificate and key (the chart's
	// tls, signed by its own CA); both empty: plain HTTP, for development.
	APITLSCertFile       string
	APITLSKeyFile        string
	MaxTasksPerExecution int

	// The sleeper (`kernel sleep`, the chart's scaleDown CronJob): scales
	// the platform's Deployments to zero once nothing has happened for
	// SleeperIdleAfter: no execution unfinished, none finished, nobody using
	// the console (its activity ConfigMap), kernel-api not restarted (woken
	// or upgraded). The databases go last.
	SleeperNamespace   string
	SleeperIdleAfter   time.Duration
	SleeperDeployments []string
	SleeperDatabases   []string
	// Where each Deployment's copies are kept while asleep, for waking.
	SleeperStateConfigMap string
	// The console's activity ConfigMap; empty: not consulted.
	SleeperConsoleActivityConfigMap string
	// kernel-api's Pods: the newest one's start counts as activity.
	SleeperAPIPodSelector string
	// The sleeper's own CronJob: suspended while asleep, so it doesn't start
	// a Pod (on EKS Auto Mode, a node) every few minutes to find nothing to
	// do. Waking resumes it (vennir wake). Empty: never suspended.
	SleeperCronJob string
	// A scheduled sleep (--now) waits this long for unfinished executions.
	SleeperScheduledWait time.Duration
	// The CronJob that wakes a sleeping install for its next schedule (the
	// console's, which it writes to its activity ConfigMap): set to fire
	// SleeperWakeLead before it, once. Empty: schedules don't wake it.
	SleeperWakeCronJob string
	SleeperWakeLead    time.Duration

	// `kernel policy` (internal/policy, the chart's catalogPolicy): the
	// catalog release it reads (CatalogPolicyRelease; following its newest
	// version with CatalogPolicyNewestVersion), every CatalogPolicyPoll, the
	// signers it trusts (keys and/or a keyless identity, never the
	// console's), and the policies it writes. Empty release: it doesn't run.
	CatalogPolicyRelease          string
	CatalogPolicyNewestVersion    bool
	CatalogPolicyPoll             time.Duration
	CatalogPolicyPublicKeys       []string
	CatalogPolicyKeylessIssuer    string
	CatalogPolicyKeylessSubject   string
	CatalogPolicyTUFCache         string
	CatalogPolicyIdentityPolicy   string
	CatalogPolicyGatewayPolicy    string
	CatalogPolicyGatewayAudience  string
	CatalogPolicyReleaseGrace     time.Duration
	CatalogPolicyInUseMax         time.Duration
	CatalogPolicyRegistryMirrors  map[string]string
	CatalogPolicyRegistryGCPToken bool
	CatalogPolicyRegistryECRToken bool

	// kernel-scheduler, below.

	// The longest the scheduler waits between passes when nothing has
	// happened. A watched change (a step finishing) wakes it sooner, and a
	// pass that made progress is followed by the next one at once.
	PollInterval  time.Duration
	LeaseDuration time.Duration
	// How many READY tasks one pass claims, and how many executor calls
	// (Job starts, status reads) it has in flight at once.
	ClaimLimit          int
	ExecutorConcurrency int
	// The most tasks claimed or running at once, across the platform and
	// per team (0: no limit), so a burst can't run up the bill or crowd out
	// other teams. Tasks over a limit wait, READY, for a later pass. Exact
	// with one scheduler; see claimReadyTasks for several.
	MaxRunning        int
	MaxRunningPerTeam int
	// Between a failed task's attempts: Base after the first failure,
	// doubling after each, at most Max.
	RetryBackoff domain.RetryBackoff
	// How many times in a row the scheduler retries starting the same
	// attempt after the start erred (each retry adopts the Job that start
	// may have made), before failing the attempt.
	MaxDispatchFailures int
	// A running step whose Job and Pod haven't changed (per the watch) isn't
	// re-read from the API, except once this often, in case an event was
	// missed.
	WatchResync time.Duration
	// The Kubernetes client's own rate limit: requests a second, and how
	// many may go at once above it. 50 and 100, not client-go's 5 and 10,
	// which held the scheduler to about a step a second (perf/README.md).
	KubernetesQPS   float64
	KubernetesBurst int

	// Env vars set on every step container, whatever its image: knobs every
	// Pod needs the same value for (on kind, GOOGLE_APPLICATION_CREDENTIALS
	// pointing at a mounted key). One that varies per team belongs in a team
	// secret, and per task in its inputs.
	TaskExtraEnvironment map[string]string
	// The Pod size for any part a task doesn't set itself. Unset, a task
	// with no size of its own requests nothing and the cluster's defaults
	// apply (on GKE Autopilot, 0.5 vCPU and 2 GiB).
	TaskDefaultResources *domain.TaskResources
	// Where step Pods may run, each in the Pod spec's own shape: how a
	// deployment sends steps to cheaper (Spot) capacity; see the per-cloud
	// examples in the execution-kernel chart's values.yaml.
	TaskNodeSelector map[string]string
	TaskTolerations  []Toleration
	TaskAffinity     map[string]any
	// Where a step whose product asks for a kind of capacity (spot,
	// onDemand) runs instead: each a node selector and tolerations. A kind
	// with none here runs where any step does.
	TaskCapacityPlacements map[string]Placement
	// Labels added to every step Pod, for webhooks that act on a label
	// (AKS Workload Identity's azure.workload.identity/use). Never the
	// kernel's own: app and vennir.dev/* are refused.
	TaskPodLabels map[string]string
	// The imagePullSecret every step Pod names, for private registries: the
	// console copies the platform's pull Secret into each team namespace
	// under this name. Empty: none.
	TaskImagePullSecret string

	// How long Kubernetes keeps a finished Job the scheduler hasn't
	// released (more than 0: at 0 it may delete one before its result is
	// read, which fails as JOB_NOT_FOUND).
	JobTTL time.Duration
	// How long a finished step's Job (and Pod) is kept once its result is
	// committed, so a log collector can still read its output.
	ReleaseFinishedAfter time.Duration
	// How long an image may keep failing to pull for a reason other than
	// "it doesn't exist" (registry auth, network) before the task fails as
	// IMAGE_PULL_FAILED. A missing image fails at once.
	ImagePullGrace time.Duration
	// Longest any one Kubernetes API call may take before it fails.
	KubernetesTimeout time.Duration
	// A Job's activeDeadlineSeconds is its task's timeout, plus
	// TaskStartTimeout, plus this: a backstop for a Job the scheduler lost
	// track of. The scheduler relies
	// on it too: a timed-out task whose Job it can't stop is failed (and
	// maybe retried) only once this deadline has passed.
	JobDeadlineGrace time.Duration
	// How long a task may wait to start (a node being added, a quota)
	// before it fails as TASK_NOT_STARTED; its timeout counts from its
	// container's start.
	TaskStartTimeout time.Duration
	// A task awaiting approval fails with APPROVAL_EXPIRED after this; 0,
	// never.
	ApprovalTimeout time.Duration

	// A step's stored output: its last TaskLogMaxLines lines, at most
	// TaskLogMaxBytes, refreshed this often while it runs and once more
	// when it ends.
	TaskLogMaxLines int
	TaskLogMaxBytes int
	TaskLogRefresh  time.Duration

	// Finished executions (tasks, outputs, logs, events) are deleted this
	// many days after their last event; 0 keeps them forever.
	ExecutionRetentionDays int
	// Touched each time the loop comes round (and while it waits for
	// migrations); the liveness probe restarts the Pod if it goes stale.
	HeartbeatFile string
	// The port /metrics is served on (the scheduler has no other server).
	MetricsPort int
	// Where Go's profiler (net/http/pprof) listens, empty for nowhere: a
	// loopback address only (127.0.0.1:6060), reached with kubectl
	// port-forward, never a Service.
	ProfilingAddress string
}

type reader struct {
	getenv   func(string) string
	problems []string
}

func (r *reader) raw(name string) (string, bool) {
	v := strings.TrimSpace(r.getenv(name))
	return v, v != ""
}

func (r *reader) str(name, fallback string) string {
	if v, ok := r.raw(name); ok {
		return v
	}
	return fallback
}

func (r *reader) number(name string, fallback float64, positive bool) float64 {
	v, ok := r.raw(name)
	if !ok {
		return fallback
	}
	n, err := strconv.ParseFloat(v, 64)
	switch {
	case err != nil:
		r.problems = append(r.problems, fmt.Sprintf("%s: not a number: %q", name, v))
	case positive && n <= 0:
		r.problems = append(r.problems, fmt.Sprintf("%s: must be greater than 0, got %s", name, v))
	case n < 0:
		r.problems = append(r.problems, fmt.Sprintf("%s: must not be negative, got %s", name, v))
	}
	return n
}

func (r *reader) integer(name string, fallback int, positive bool) int {
	n := r.number(name, float64(fallback), positive)
	if n != float64(int(n)) {
		r.problems = append(r.problems, fmt.Sprintf("%s: must be a whole number", name))
	}
	return int(n)
}

// boolean is true or false, or fallback when unset.
func (r *reader) boolean(name string, fallback bool) bool {
	v, ok := r.raw(name)
	if !ok {
		return fallback
	}
	if v != "true" && v != "false" {
		r.problems = append(r.problems, fmt.Sprintf("%s: true or false, got %q", name, v))
	}
	return v == "true"
}

func (r *reader) seconds(name string, fallback float64, positive bool) time.Duration {
	return time.Duration(r.number(name, fallback, positive) * float64(time.Second))
}

// jsonValue decodes a JSON setting; empty or "null" leaves into as it is.
// An unknown field is refused: a misspelt toleration would otherwise be
// dropped without a word.
func (r *reader) jsonValue(name string, into any) {
	v, ok := r.raw(name)
	if !ok || v == "null" {
		return
	}
	decoder := json.NewDecoder(strings.NewReader(v))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(into); err != nil {
		r.problems = append(r.problems, fmt.Sprintf("%s: not valid JSON of the right shape: %v", name, err))
	}
}

// Load reads the settings from getenv (os.Getenv).
func Load(getenv func(string) string) (Settings, error) {
	r := &reader{getenv: getenv}
	s := Settings{
		DatabaseURL:                     r.str("DATABASE_URL", "postgresql://localhost/execution_kernel"),
		DatabaseCommandTimeout:          r.seconds("DATABASE_COMMAND_TIMEOUT_SECONDS", 60, true),
		DatabaseConnectTimeout:          r.seconds("DATABASE_CONNECT_TIMEOUT_SECONDS", 10, true),
		DatabaseMaxConnections:          r.integer("DATABASE_MAX_CONNECTIONS", 10, true),
		DatabaseIAMAuth:                 r.str("DATABASE_IAM_AUTH", ""),
		DatabaseIAMRegion:               r.str("DATABASE_IAM_REGION", ""),
		DatabaseAdminSecret:             r.str("DATABASE_ADMIN_SECRET", ""),
		APIAuth:                         r.str("API_AUTH", "tokenreview"),
		APITokenAudience:                r.str("API_TOKEN_AUDIENCE", "vennir-kernel-api"),
		APIPort:                         r.integer("API_PORT", 8000, true),
		APITLSCertFile:                  r.str("API_TLS_CERT_FILE", ""),
		APITLSKeyFile:                   r.str("API_TLS_KEY_FILE", ""),
		MaxTasksPerExecution:            r.integer("MAX_TASKS_PER_EXECUTION", 500, true),
		SleeperNamespace:                r.str("SLEEPER_NAMESPACE", ""),
		SleeperIdleAfter:                r.seconds("SLEEPER_IDLE_AFTER_SECONDS", 7200, true),
		SleeperStateConfigMap:           r.str("SLEEPER_STATE_CONFIGMAP", ""),
		SleeperConsoleActivityConfigMap: r.str("SLEEPER_CONSOLE_ACTIVITY_CONFIGMAP", ""),
		SleeperAPIPodSelector:           r.str("SLEEPER_API_POD_SELECTOR", ""),
		SleeperCronJob:                  r.str("SLEEPER_CRONJOB", ""),
		SleeperScheduledWait:            r.seconds("SLEEPER_SCHEDULED_WAIT_SECONDS", 6*3600, true),
		SleeperWakeCronJob:              r.str("SLEEPER_WAKE_CRONJOB", ""),
		SleeperWakeLead:                 r.seconds("SLEEPER_WAKE_LEAD_SECONDS", 300, true),
		CatalogPolicyRelease:            r.str("CATALOG_POLICY_RELEASE", ""),
		CatalogPolicyNewestVersion:      r.boolean("CATALOG_POLICY_NEWEST_VERSION", false),
		CatalogPolicyPoll:               r.seconds("CATALOG_POLICY_POLL_SECONDS", 60, true),
		CatalogPolicyKeylessIssuer:      r.str("CATALOG_POLICY_KEYLESS_ISSUER", ""),
		CatalogPolicyKeylessSubject:     r.str("CATALOG_POLICY_KEYLESS_SUBJECT_REGEXP", ""),
		CatalogPolicyTUFCache:           r.str("CATALOG_POLICY_TUF_CACHE", "/tmp/sigstore-tuf"),
		CatalogPolicyIdentityPolicy:     r.str("CATALOG_POLICY_IDENTITY_POLICY", ""),
		CatalogPolicyGatewayPolicy:      r.str("CATALOG_POLICY_GATEWAY_POLICY", ""),
		CatalogPolicyGatewayAudience:    r.str("CATALOG_POLICY_GATEWAY_GCP_AUDIENCE", ""),
		CatalogPolicyReleaseGrace:       r.seconds("CATALOG_POLICY_RELEASE_GRACE_SECONDS", 3600, true),
		CatalogPolicyInUseMax:           r.seconds("CATALOG_POLICY_IN_USE_MAX_SECONDS", 259200, true),
		CatalogPolicyRegistryGCPToken:   r.boolean("CATALOG_POLICY_REGISTRY_GCP_METADATA_TOKEN", false),
		CatalogPolicyRegistryECRToken:   r.boolean("CATALOG_POLICY_REGISTRY_ECR_TOKEN", false),
		PollInterval:                    r.seconds("SCHEDULER_POLL_INTERVAL_SECONDS", 1, true),
		LeaseDuration:                   r.seconds("LEASE_DURATION_SECONDS", 60, true),
		ClaimLimit:                      r.integer("SCHEDULER_CLAIM_LIMIT", 50, true),
		ExecutorConcurrency:             r.integer("SCHEDULER_EXECUTOR_CONCURRENCY", 16, true),
		MaxRunning:                      r.integer("SCHEDULER_MAX_RUNNING_TASKS", 0, false),
		MaxRunningPerTeam:               r.integer("SCHEDULER_MAX_RUNNING_TASKS_PER_TEAM", 0, false),
		RetryBackoff: domain.RetryBackoff{
			Base: r.seconds("SCHEDULER_RETRY_BACKOFF_SECONDS", 5, false),
			Max:  r.seconds("SCHEDULER_RETRY_BACKOFF_MAX_SECONDS", 300, false),
		},
		MaxDispatchFailures:    r.integer("SCHEDULER_MAX_DISPATCH_FAILURES", 5, true),
		WatchResync:            r.seconds("KUBERNETES_WATCH_RESYNC_SECONDS", 30, true),
		KubernetesQPS:          r.number("KUBERNETES_CLIENT_QPS", 50, true),
		KubernetesBurst:        r.integer("KUBERNETES_CLIENT_BURST", 100, true),
		TaskImagePullSecret:    r.str("TASK_IMAGE_PULL_SECRET", ""),
		JobTTL:                 r.seconds("KUBERNETES_JOB_TTL_SECONDS", 3600, true),
		ReleaseFinishedAfter:   r.seconds("RELEASE_FINISHED_AFTER_SECONDS", 30, false),
		ImagePullGrace:         r.seconds("IMAGE_PULL_GRACE_SECONDS", 120, true),
		KubernetesTimeout:      r.seconds("KUBERNETES_REQUEST_TIMEOUT_SECONDS", 30, true),
		JobDeadlineGrace:       r.seconds("KUBERNETES_JOB_DEADLINE_GRACE_SECONDS", 600, false),
		TaskStartTimeout:       r.seconds("TASK_START_TIMEOUT_SECONDS", 600, true),
		ApprovalTimeout:        r.seconds("SCHEDULER_APPROVAL_TIMEOUT_SECONDS", 259200, false),
		TaskLogMaxLines:        r.integer("TASK_LOG_MAX_LINES", 5000, true),
		TaskLogMaxBytes:        r.integer("TASK_LOG_MAX_BYTES", 1_048_576, true),
		TaskLogRefresh:         r.seconds("TASK_LOG_REFRESH_SECONDS", 60, true),
		ExecutionRetentionDays: r.integer("EXECUTION_RETENTION_DAYS", 90, false),
		HeartbeatFile:          r.str("SCHEDULER_HEARTBEAT_FILE", "/tmp/vennir-scheduler-heartbeat"),
		MetricsPort:            r.integer("METRICS_PORT", 9090, true),
		ProfilingAddress:       r.str("PROFILING_ADDRESS", ""),
	}
	// Each is checked alone above; these, against each other.
	if s.PollInterval >= s.LeaseDuration && s.LeaseDuration > 0 {
		// An idle replica's leases would lapse between its passes, and the
		// others adopt its tasks.
		r.problems = append(r.problems, fmt.Sprintf("SCHEDULER_POLL_INTERVAL_SECONDS: must be less than LEASE_DURATION_SECONDS (%s), got %s", s.LeaseDuration, s.PollInterval))
	}
	if s.ProfilingAddress != "" && !loopback(s.ProfilingAddress) {
		r.problems = append(r.problems, fmt.Sprintf("PROFILING_ADDRESS: a loopback address and port (127.0.0.1:6060), got %q", s.ProfilingAddress))
	}
	if (s.APITLSCertFile == "") != (s.APITLSKeyFile == "") {
		r.problems = append(r.problems, "API_TLS_CERT_FILE and API_TLS_KEY_FILE: both, or neither")
	}
	if s.APIAuth != "tokenreview" && s.APIAuth != "disabled" {
		r.problems = append(r.problems, fmt.Sprintf("API_AUTH: tokenreview or disabled, got %q", s.APIAuth))
	}
	r.jsonValue("API_ALLOWED_CALLERS", &s.APIAllowedCallers)
	r.jsonValue("DATABASE_SETUP", &s.DatabaseSetup)
	switch s.DatabaseIAMAuth {
	case "", "gcp":
	case "aws":
		if s.DatabaseIAMRegion == "" {
			r.problems = append(r.problems, "DATABASE_IAM_REGION: needed with DATABASE_IAM_AUTH=aws")
		}
	default:
		r.problems = append(r.problems, fmt.Sprintf("DATABASE_IAM_AUTH: gcp, aws, or empty for a password, got %q", s.DatabaseIAMAuth))
	}
	if s.DatabaseAdminSecret != "" && s.DatabaseIAMRegion == "" {
		r.problems = append(r.problems, "DATABASE_IAM_REGION: needed with DATABASE_ADMIN_SECRET (the secret's region)")
	}
	r.jsonValue("CATALOG_POLICY_PUBLIC_KEYS", &s.CatalogPolicyPublicKeys)
	r.jsonValue("CATALOG_POLICY_REGISTRY_MIRRORS", &s.CatalogPolicyRegistryMirrors)
	if s.CatalogPolicyRelease != "" {
		if s.CatalogPolicyIdentityPolicy == "" {
			r.problems = append(r.problems, "CATALOG_POLICY_IDENTITY_POLICY: needed with CATALOG_POLICY_RELEASE (the policy it writes)")
		}
		if (s.CatalogPolicyKeylessIssuer == "") != (s.CatalogPolicyKeylessSubject == "") {
			r.problems = append(r.problems, "CATALOG_POLICY_KEYLESS_ISSUER and CATALOG_POLICY_KEYLESS_SUBJECT_REGEXP: both, or neither")
		}
		if len(s.CatalogPolicyPublicKeys) == 0 && s.CatalogPolicyKeylessIssuer == "" {
			// Without a signer, nothing is verified: the console writes them.
			r.problems = append(r.problems, "CATALOG_POLICY_PUBLIC_KEYS or CATALOG_POLICY_KEYLESS_ISSUER: a signer to trust is needed with CATALOG_POLICY_RELEASE")
		}
		// A step awaiting its approval keeps its execution's releases
		// listed only this long: an approval given later would be refused.
		if s.ApprovalTimeout > 0 && s.CatalogPolicyInUseMax < s.ApprovalTimeout {
			r.problems = append(r.problems, fmt.Sprintf("CATALOG_POLICY_IN_USE_MAX_SECONDS: must be at least SCHEDULER_APPROVAL_TIMEOUT_SECONDS (%s), got %s",
				s.ApprovalTimeout, s.CatalogPolicyInUseMax))
		}
	}
	r.jsonValue("SLEEPER_DEPLOYMENTS", &s.SleeperDeployments)
	r.jsonValue("SLEEPER_DATABASE_DEPLOYMENTS", &s.SleeperDatabases)
	r.jsonValue("TASK_EXTRA_ENVIRONMENT", &s.TaskExtraEnvironment)
	r.jsonValue("TASK_NODE_SELECTOR", &s.TaskNodeSelector)
	r.jsonValue("TASK_TOLERATIONS", &s.TaskTolerations)
	r.jsonValue("TASK_AFFINITY", &s.TaskAffinity)
	r.jsonValue("TASK_CAPACITY_PLACEMENTS", &s.TaskCapacityPlacements)
	for kind := range s.TaskCapacityPlacements {
		if !slices.Contains(domain.Capacities, kind) {
			r.problems = append(r.problems, fmt.Sprintf("TASK_CAPACITY_PLACEMENTS: %q isn't a kind of capacity (%s)", kind, strings.Join(domain.Capacities, ", ")))
		}
	}
	r.jsonValue("TASK_POD_LABELS", &s.TaskPodLabels)
	for key, value := range s.TaskPodLabels {
		if problem := podLabelProblem(key, value); problem != "" {
			r.problems = append(r.problems, "TASK_POD_LABELS: "+problem)
		}
	}
	var resources domain.TaskResources
	r.jsonValue("TASK_DEFAULT_RESOURCES", &resources)
	if err := resources.Check(); err != nil {
		r.problems = append(r.problems, "TASK_DEFAULT_RESOURCES: "+err.Error())
	}
	if resources != (domain.TaskResources{}) {
		s.TaskDefaultResources = &resources
	}
	// The Python kernel's URL names its driver (postgresql+asyncpg://).
	s.DatabaseURL = strings.Replace(s.DatabaseURL, "postgresql+asyncpg://", "postgresql://", 1)
	if s.DatabaseIAMAuth != "" || s.DatabaseAdminSecret != "" {
		if problem := verifiedTLSProblem(s.DatabaseURL); problem != "" {
			r.problems = append(r.problems, "DATABASE_URL: "+problem)
		}
	}
	if len(r.problems) > 0 {
		return Settings{}, errors.New("invalid settings:\n  " + strings.Join(r.problems, "\n  "))
	}
	return s, nil
}

// verifiedTLSProblem is why a database URL mustn't be sent a cloud
// sign-in token (DATABASE_IAM_AUTH's, valid for every database the
// identity may use) or the administrator's password (DATABASE_ADMIN_SECRET):
// they go as the password, in the clear to whoever answers unless the
// connection is TLS with the server's certificate checked. So the URL must
// say sslmode=verify-full, or verify-ca with sslrootcert, the server's own
// CA (Cloud SQL's certificate names its instance, not the address
// connected to, so only the CA can be checked: an instance's CA is its
// own). A loopback host or a Unix socket (a Cloud SQL Auth Proxy beside
// the process, which encrypts and checks on its own) needs neither. Read
// as pgx reads it (every host it may try, each with its own TLS), so what's
// checked is what connects.
func verifiedTLSProblem(databaseURL string) string {
	const need = "with a sign-in token or password from the cloud, sslmode=verify-full, or verify-ca with sslrootcert (the server's own CA), so it's only sent to the server"
	c, err := pgconn.ParseConfig(databaseURL)
	if err != nil {
		// Its own error quotes the URL, which may hold a password.
		if inner := errors.Unwrap(err); inner != nil {
			return "unreadable: " + inner.Error()
		}
		return "unreadable as a Postgres URL"
	}
	tries := []*pgconn.FallbackConfig{{Host: c.Host, Port: c.Port, TLSConfig: c.TLSConfig}}
	tries = append(tries, c.Fallbacks...)
	for _, try := range tries {
		if localDatabaseHost(try.Host) {
			continue
		}
		tlsConfig := try.TLSConfig
		switch {
		case tlsConfig == nil:
			return need + fmt.Sprintf("; %s would be tried without TLS", try.Host)
		case !tlsConfig.InsecureSkipVerify:
			// verify-full: the chain and the host name.
		case tlsConfig.VerifyPeerCertificate != nil && tlsConfig.RootCAs != nil:
			// verify-ca (or require with a root certificate): the chain, to sslrootcert's CA.
		default:
			return need + fmt.Sprintf("; %s's certificate wouldn't be checked against its own CA", try.Host)
		}
	}
	return ""
}

// localDatabaseHost is a host that never leaves the Pod: a Unix socket's
// directory, localhost, or a loopback address.
func localDatabaseHost(host string) bool {
	if strings.HasPrefix(host, "/") || host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// podLabelProblem is why a TASK_POD_LABELS entry can't be used: not a
// valid label, or one of the kernel's own, which the executor and console
// read back and a setting mustn't be able to forge.
func podLabelProblem(key, value string) string {
	if errs := validation.IsQualifiedName(key); len(errs) > 0 {
		return fmt.Sprintf("%q isn't a label key: %s", key, strings.Join(errs, "; "))
	}
	if errs := validation.IsValidLabelValue(value); len(errs) > 0 {
		return fmt.Sprintf("%q's value %q isn't a label value: %s", key, value, strings.Join(errs, "; "))
	}
	if key == "app" || strings.HasPrefix(key, "vennir.dev/") {
		return fmt.Sprintf("%q is the kernel's own label", key)
	}
	return ""
}

// FromEnv is Load(os.Getenv).
func FromEnv() (Settings, error) { return Load(os.Getenv) }

// loopback says an address listens on this machine alone (127.0.0.1:6060,
// [::1]:6060, localhost:6060).
func loopback(address string) bool {
	host, port, err := net.SplitHostPort(address)
	if err != nil || port == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
