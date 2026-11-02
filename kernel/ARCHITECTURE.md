# Architecture & Code Reference

A map of the kernel: what every package is for, what its key functions do,
and the actual order operations happen in when it runs. Written as a
reference to come back to, not a one-time read.

## Table of contents

1. [What this is, in one paragraph](#what-this-is-in-one-paragraph)
2. [Repository layout](#repository-layout)
3. [How the packages depend on each other](#how-the-packages-depend-on-each-other)
4. [End-to-end order of operations](#end-to-end-order-of-operations) — the core of this doc
5. [Package-by-package reference](#package-by-package-reference)
6. [Tests](#tests)
7. [Deployment files](#deployment-files)

---

## What this is, in one paragraph

The kernel accepts an already-resolved DAG of containerized tasks (an
upstream planner decided *what* to run; the kernel only runs it), stores
it in Postgres, and runs it. It's one Go binary, `kernel`, run as separate
processes that never talk to each other directly: `kernel api`
(kernel-api: KernelService over Connect, for the console) only reads and
writes rows; `kernel scheduler` (kernel-scheduler) polls those same rows,
claims work, dispatches it as a Kubernetes Job (behind the `Executor`
interface), and writes the outcome back. `kernel migrate` owns the schema;
`kernel sleep` scales an idle platform to zero. Postgres is the only
thing they have in common: that's deliberate, not an oversight. The kernel
was Python until 2026-10-20 (decision 17 in `docs/assessment.md`).

## Repository layout

```
cmd/kernel/        The binary: a subcommand per process (api, scheduler, migrate,
                   sleep, database-setup), plus wait-for-postgres and check-heartbeat
                   for the chart, and database-token (a managed database's sign-in,
                   written to a file for pg_restore, when vertra moves data in).
internal/          Its packages (one Go module: go.mod here).
├── domain/        States, retry backoff, the result.json contract, input references,
│                  DAG validation, credential shapes. No I/O.
├── config/        Settings from the environment (the chart's ConfigMap), checked at startup.
├── api/           kernel-api: KernelService over Connect, the caller check, health, metrics.
├── executor/      The Executor interface and its one real implementation, Kubernetes.
│   └── executortest/  Fake: an in-memory Executor for the scheduler's tests.
├── scheduler/     The pass (claim → dispatch → poll → settle), the loop around it,
│                  retention, the orphan sweep.
├── migrate/       The schema: sql/NNNN_name.sql, applied in order, each once.
├── dbauth/        A managed database's sign-in: the workload's own token as the password.
├── dbsetup/       database-setup: each database opened to its own service alone.
├── sleeper/       Putting an idle platform to sleep (a CronJob).
├── logging/       JSON logs.
├── metrics/       Prometheus metrics.
├── gen/           KernelService's generated code (`make proto`, from proto/vertra/kernel/v1).
├── dbtest/        For tests: the test database, and throwaway ones.
└── kindtest/      For tests: a real (kind) cluster and test images (fixture/: one of them).

Dockerfile         The image: the binary on a distroless static base. See ../Makefile
                   and ../helm/charts/execution-kernel for how it deploys.
```

## How the packages depend on each other

Dependencies only point one direction:

```
domain  →  executor  →  scheduler  ─┐
domain  →  api  ────────────────────┼→  cmd/kernel
migrate, sleeper, config, logging, metrics ─┘
```

- **domain** depends on nothing: no database, no Kubernetes. Everything in
  it is unit-tested alone.
- **executor** depends on `domain` (the result contract, credential
  shapes) and client-go, never on the database.
- **scheduler** depends on `domain`, `executor` (the interface) and pgx. It
  never constructs an executor; `cmd/kernel` does, and its tests pass
  `executortest.Fake`.
- **api** depends on `domain`, its generated code and pgx; never on
  `scheduler` or `executor`. kernel-api and the scheduler meet only in
  the database.

## End-to-end order of operations

A literal trace of function calls for the canonical
`create-project → deploy-application` example, in the order they happen.
Read this section when you need to know "what calls what."

### 1. Submitting an execution

The console has already checked the caller's teams, identities, secrets
and images, and turned the DAG's JSON into a request
(`console/src/kernel/client.ts`, strictly, under the names it checked).

```
KernelService/SubmitExecution
  → internal/api/auth.go : Callers.Interceptor()      [the console's token, TokenReview;
                                                        else unauthenticated / permission_denied]
  → internal/api/service.go : SubmitExecution()
      → taskDefs()                                     [each field: required ones set, timeout > 0,
                                                        attempts ≥ 1, sizes are quantities; defaults]
      → inTx: one transaction
          → SELECT ... WHERE idempotency_key = request_id
              [found?] → that execution (created false) — nothing else runs
          → domain.ValidateDAG()
              [invalid?] → invalid_argument with ValidationIssues details, every issue
          → a savepoint: insert()
              → INSERT executions (PENDING), execution_tasks (READY if no
                dependencies, else BLOCKED; AWAITING_APPROVAL instead of READY
                when approval_required), task_dependencies
              [lost a race on request_id?] → roll back the savepoint, return that one
          → recordEvent(EXECUTION_CREATED)
      ← {execution_id, state: PENDING, created: true}; the event counted once committed
```

Nothing has *run* yet — only rows exist: one `executions` row (`PENDING`),
one `execution_tasks` row per task (`READY`, `AWAITING_APPROVAL` or `BLOCKED`), edges in
`task_dependencies`, one `execution_events` row.

### 2. The scheduler loop

`kernel-scheduler` (`kernel scheduler`) is a separate process polling the
same database: nothing here is triggered by the API request above; it
happens on its next pass.

```
cmd/kernel/main.go : main() → runScheduler()      [`kernel scheduler`]
  → internal/config : FromEnv()                   [typed and checked: a bad setting stops it here]
  → /metrics on METRICS_PORT
  → pgxpool (statement_timeout = DATABASE_COMMAND_TIMEOUT_SECONDS)
  → executor.NewKubernetes(...)                   [constructed directly: the only real backend]
  → (*Kubernetes).Watch(ctx)                      [informers on the kernel's Jobs and Pods, all namespaces]
  → internal/scheduler : (*Loop).Run(ctx)
      → migrate.Wait()                            [until schema_migrations is at migrate.Latest()]
      loop until SIGTERM/SIGINT:
        → (*Loop).pass() : pgx.BeginFunc → RunTick()   [one transaction per pass]
        [committed?] → count its events (metrics)
                     → ReleaseFinished(outcome.Finished)  [only now: see below]
                     → housekeeping: DeleteFinishedExecutions hourly,
                                     ReleaseOrphanedAttempts every 5 minutes
        [failed?]    → log it, count it; the next pass starts again from the rows
        [progressed?] → next pass after 50 ms
        [otherwise]   → executor.WaitForChange(SCHEDULER_POLL_INTERVAL_SECONDS)
                        [a watched Job or Pod change wakes it early]
        → touch the heartbeat file                [the liveness probe: kernel check-heartbeat]
      → ReleaseLeases(owner)                      [another scheduler adopts these tasks at once]
```

`RunTick()` (`internal/scheduler/tick.go`) is three phases, every pass.
Only the executor calls overlap (up to `SCHEDULER_EXECUTOR_CONCURRENCY` at
once, `gather`): every row read and write is in order, in the one
transaction.

**Phase A — Claim** (`claiming.go : claimReadyTasks()`)
```
→ recoverExpiredLeases()
    [any CLAIMED/RUNNING task whose lease_expires_at has passed]
    RUNNING → keep state and executor_handle, lease_owner = this scheduler
              (adopted: polled from now on, its Job not started twice)
    CLAIMED → back to READY, lease and handle cleared
→ [SCHEDULER_MAX_RUNNING_TASKS(_PER_TEAM)?] runningPerTeam() caps how many
→ SELECT ... FOR UPDATE OF t SKIP LOCKED
    WHERE state = READY AND available_at <= now
      AND execution.state IN (PENDING, RUNNING)     [a dead execution gets no more claims]
→ concurrencyHold() for a task with a concurrency scope: its key from its
    resolved inputs; it stays READY while a task with that key is CLAIMED
    or RUNNING, was claimed earlier in this pass, or another scheduler holds
    the key's pg_try_advisory_xact_lock (until its pass commits)
→ for each claimed task:
    state = CLAIMED, lease_owner = this scheduler, lease_expires_at = now + lease,
      concurrency_key = its key (if it has one)
    attempt_count += 1 → INSERT task_attempts
    recordEvent(TASK_CLAIMED)
```

**Phase B — Dispatch** (`dispatch()`: resolve each in order, start them all
concurrently, then `recordStart()` each in order)
```
→ resolveInputs()
    → SELECT task_outputs JOIN task_dependencies for this task's direct dependencies
    → domain.ResolveInputs()                       [pure]
        → walks original_inputs recursively; domain.ParseInputReference()
          recognizes exactly {"$fromTask": ..., "$output": ...}
        → replaces every marker with the upstream task's output
    [referenced output never produced?] → MissingOutputError → MISSING_UPSTREAM_OUTPUT, not retried
→ executor.ResolvedTask → exec.Start()             [Kubernetes]
    ← Handle {namespace, jobName}
    refused by the cluster (DispatchRejected: a policy's code, or DISPATCH_REJECTED)
        → exec.Discard() → handleFailure(code, retryable=false)
    any other error (a timeout, a lost response: the Job may exist anyway)
        → dispatch_failures += 1
        [below SCHEDULER_MAX_DISPATCH_FAILURES?]
            → returnUnstartedAttempt()   [delete this attempt row, attempt_count -= 1,
                                          READY: the next claim reuses the attempt number,
                                          so the Job name, and Start() adopts that Job]
            → available_at = now + RetryBackoff.Delay(dispatch_failures)
            → recordEvent(TASK_DISPATCH_RETRY)
        [at the limit] → exec.Discard() → handleFailure(EXECUTOR_START_FAILED, retryable=true)
→ dispatch_failures = 0; resolved_inputs and executor_handle saved; RUNNING
→ the attempt's started_at = now
→ markExecutionRunning()                           [PENDING → RUNNING on the first dispatch]
→ recordEvent(TASK_STARTED)
```

**Phase C — Poll** (every RUNNING task this scheduler holds: all statuses
read concurrently first, then `poll()` acts on each in order)
```
→ exec.Status(handle)                              [skipped (RUNNING) for a Job whose watch saw
                                                    no change since a read within the resync interval]
→ [execution CANCELLED?]
    → exec.Cancel() → CANCELLED → recordEvent(TASK_CANCELLED) → done
→ [the status isn't a finish, and either
     its container started (status.StartedAt) more than timeout_seconds ago, or
     it hasn't started and was dispatched more than the start timeout ago
     (TASK_START_TIMEOUT_SECONDS: waiting for a node isn't running), or
     its status couldn't be read and it was dispatched more than timeout_seconds ago?]
    → exec.Cancel()
        [failed, and the Job's own deadline (timeout + start timeout + grace) not yet passed?]
            → renew the lease, try again next pass (no retry may run beside it)
    → handleFailure(TASK_TIMEOUT, or TASK_NOT_STARTED; retryable=true)
→ the status read above:
    errored   → unknown, not failed: renew the lease, read it again next pass
                (kernel_scheduler_status_read_errors_total; the timeout above still applies)
    Running   → renew the lease; captureLogs() every TASK_LOG_REFRESH_SECONDS
    Succeeded → task_outputs row, the logs → SUCCEEDED → recordEvent(TASK_SUCCEEDED)
                → releaseReadyDependents()
                    [lock each dependent (FOR NO KEY UPDATE), then:
                     a BLOCKED task whose every dependency SUCCEEDED → READY,
                     or AWAITING_APPROVAL if it needs an approval it hasn't had]
                → settleExecution()
                    [lock the execution (FOR NO KEY UPDATE), then:
                     every task SUCCEEDED?] → SUCCEEDED → recordEvent(EXECUTION_SUCCEEDED)
                     [a task FAILED and none left that can run?] → failExecution()
                    The locks are what make concurrent schedulers safe here: two
                    passes finishing two dependencies (or an execution's last two
                    tasks) at once are serialized, so the second sees the first's
                    commit. NO KEY UPDATE, not UPDATE: rows referencing these
                    (events, outputs) take FOR KEY SHARE, which UPDATE would
                    conflict with. Lock order everywhere: tasks, then execution.
    Failed    → handleFailure(status.Error)
→ every task that finished goes into Outcome.Finished
```

`handleFailure()`:
```
→ the failure recorded on the current attempt
→ domain.ShouldRetry(attempt_count, max_attempts, retryable)
    true  → READY, lease and handle cleared,
            available_at = now + RetryBackoff.Delay(attempt)   [5 s, doubling, at most 300 s]
            (a later pass claims it: the same path as any READY task)
    false → FAILED, recordEvent(TASK_FAILED)
            → failExecution()
                → execution FAILED (compare-and-set) → recordEvent(EXECUTION_FAILED)
                → every READY/BLOCKED/AWAITING_APPROVAL sibling → CANCELLED (they will never run now)
```

Inside the executor (`internal/executor/kubernetes.go`, the one
implementation of `Executor`; the scheduler only knows the interface):

- `Start()` creates a Job whose Pod has an `emptyDir` at `/platform/output`,
  then a ConfigMap holding `request.json` (mounted read-only at
  `/platform/input`) that names the Job as its owner, so Kubernetes deletes
  it with any Job the scheduler never releases. Names come from
  (execution, task, attempt) (`JobName`, the same as the Python kernel's
  was): a Job already there under its name is this same attempt's, from a
  pass that rolled back or a start that erred after making it, and is
  adopted rather than started twice. Every Job has `activeDeadlineSeconds`
  (the task's timeout plus a grace period), so Kubernetes stops one the
  scheduler has lost track of. A 403 (or Sigstore's 400) is a
  `DispatchRejected` with the policy's own code. `Discard()` deletes an
  attempt's Job and ConfigMap by name.
- No sidecar: the container's `terminationMessagePath` is
  `/platform/output/result.json`, so Kubernetes reads that file back after
  the container exits. `Status()` parses it (`domain.ParseTaskResult`),
  redacts credentials from logs and error messages, fails outputs holding
  one (`OUTPUT_CONTAINS_CREDENTIAL`), and caches the result for 15 minutes;
  the Job and ConfigMap stay. A missing image fails at once
  (`IMAGE_NOT_FOUND`); other pull errors get `IMAGE_PULL_GRACE_SECONDS`.
- The pass hands back what finished (`Outcome.Finished`), and the loop
  calls `Release()` on it only after the pass committed, so a pass that
  rolls back can read the same result again. One missed is removed by the
  orphan sweep or the Job's TTL.

### 3. Reading status

```
KernelService/GetExecution → internal/api/service.go : GetExecution()
    [the same rows the scheduler is writing: always live, never cached]
    tasks with their outputs, failure, dependencies, and the current attempt's timing
KernelService/ListExecutionEvents → ListExecutionEvents()
    [after an event id, a page at a time; next_cursor when the page was full]
KernelService/GetExecutionLogs, GetExecutionStates → the same rows, in one query each
```

### 4. Cancelling

```
KernelService/CancelExecution → internal/api/service.go : CancelExecution()
    [already CANCELLED?] → fine, idempotent
    [already SUCCEEDED/FAILED?] → failed_precondition
    → in a savepoint, conditionally:
        UPDATE every READY/BLOCKED/AWAITING_APPROVAL task → CANCELLED (never dispatched, nothing to stop)
        UPDATE the execution → CANCELLED, only if still PENDING/RUNNING
        [it finished meanwhile?] → roll back the savepoint, answer as above
    → recordEvent(EXECUTION_CANCELLED), recordEvent(TASK_CANCELLED) for each
    [RUNNING/CLAIMED tasks are left alone here: kernel-api has no executor;
     the scheduler's next pass (Phase C above) stops them, and a task it was
     dispatching meanwhile is left RUNNING for it, not overwritten]
```

### 5. Retrying a failed task

```
KernelService/RetryTask → internal/api/service.go : RetryTask()
    → UPDATE the task → READY, lease/handle/failure cleared, WHERE it's still FAILED
        [no row?] → not_found, or failed_precondition if it exists but isn't FAILED
        (one more attempt whatever max_attempts: that only gates the
         scheduler's automatic ShouldRetry)
    → recordEvent(TASK_RETRIED)
    → the execution → RUNNING if FAILED (compare-and-set) → recordEvent(EXECUTION_RESUMED)
    → every CANCELLED sibling → READY (its dependencies all SUCCEEDED) or BLOCKED
        (without this, the execution could never reach all-SUCCEEDED again)
    [a task, retried or revived, that needs an approval it hasn't had (a
     declined one) goes to AWAITING_APPROVAL instead of READY; an approval,
     once given, lasts]
    [the scheduler's next pass claims the revived task normally]
```

### 6. Approving a task

```
KernelService/DecideApproval → internal/api/approvals.go : DecideApproval()
    (the console has already checked the caller is a maintainer of the
     task's team and didn't submit the run; decided_by is recorded as is)
    approve → UPDATE the task → READY, approved_by/approved_at set,
              WHERE it's still AWAITING_APPROVAL → recordEvent(TASK_APPROVED)
    decline → UPDATE the task → FAILED (APPROVAL_DECLINED, not retryable),
              WHERE it's still AWAITING_APPROVAL → recordEvent(TASK_FAILED)
              → its READY/BLOCKED/AWAITING_APPROVAL siblings → CANCELLED,
                the execution → FAILED → recordEvent(EXECUTION_FAILED)
        [no row?] → not_found, or failed_precondition if it isn't awaiting

kernel-scheduler, at the start of every pass : expireApprovals()
    → each task AWAITING_APPROVAL since before now − ApprovalTimeout
      (SCHEDULER_APPROVAL_TIMEOUT_SECONDS, 3 days; 0 never), FOR NO KEY UPDATE SKIP LOCKED
      → FAILED (APPROVAL_EXPIRED) → recordEvent(TASK_FAILED) → failExecution()
```

---

## Package-by-package reference

#### `cmd/kernel/main.go`
- `main()` — the subcommand: `api`, `scheduler`, `migrate`, `sleep
  [--now]`; `wait-for-postgres HOST:PORT` (the chart's init containers)
  and `check-heartbeat SECONDS` (the scheduler's liveness probe).
- `runAPI`, `runScheduler`, `runMigrate`, `runSleep` — each builds what it
  needs from the settings, constructing `executor.Kubernetes` directly:
  there's nothing to choose between. SIGTERM ends each cleanly (kernel-api
  drains its requests; the scheduler finishes its pass and releases its
  leases).

#### `internal/config/config.go`
- `Settings` — every process's settings, documented field by field; the
  names are the ones the chart's ConfigMap sets.
- `Load(getenv)` — parses and checks them all, reporting every problem at
  once; JSON settings refuse unknown fields (a misspelt toleration stops
  it rather than being dropped).

#### `internal/domain/`
- `states.go` — `TaskState`, `ExecutionState`, `ShouldRetry`, and
  `RetryBackoff.Delay` (5 s after the first failure, doubling, capped).
- `result.go` — `StructuredError`, and `ParseTaskResult`: the
  `result.json` contract, strictly (no unknown fields; a failed result has
  an error, a succeeded one doesn't).
- `task.go` — `TaskResources` (`Over`, `Check`), `ParseInputReference`,
  `ResolveInputs` and `MissingOutputError`, `ProductRequest`.
- `dag.go` — `TaskDef` and `ValidateDAG`, the whole submission-time gate:
  duplicate ids, self, unknown or repeated dependencies, cycles,
  upstream-only input references, credential-shaped inputs. Collects every
  issue before refusing, so one round trip reports everything wrong;
  checks that need a well-formed graph are skipped once it isn't one.
  `TopologicalSort` (submission order breaks ties).
- `credentials.go` — `RedactText`, `RedactLines` (a PEM key spanning lines
  becomes one marker), `FindCredential` (a step's outputs holding one fail
  it; a DAG's inputs holding one are refused).
- `events.go` — every `execution_events.event_type`.

#### `internal/executor/`
- `executor.go` — `Executor`: `Start` / `Status` / `Cancel` / `Logs` /
  `Release` (removes a finished attempt's Job once its outcome is
  committed) / `ListAttempts` (every attempt whose Job still exists, for the
  orphan sweep) / `Discard` (removes what a failed start may have left) /
  `WaitForChange`. `ResolvedTask`, `Handle` (opaque outside the executor;
  `{namespace, jobName}`), `Status`, `DispatchRejected`. An interface with
  one production implementation, earning its keep by letting the
  scheduler's logic be tested against `executortest.Fake` without a cluster.
- `kubernetes.go` — `Kubernetes`: see the bullets in the trace above.
  `JobName`, `ImagePullFailure` (a pure function of the kubelet's waiting
  state). Every API call has `KUBERNETES_REQUEST_TIMEOUT_SECONDS`.
- `watch.go` — `Watch`: shared informers on the kernel's Jobs and Pods.
  While both are healthy, a running Job's status isn't re-read until it
  changes or `KUBERNETES_WATCH_RESYNC_SECONDS` passes; a change wakes a
  waiting loop.
- `executortest/fake.go` — `Fake`, driven explicitly (`Complete`, `Fail`).

#### `internal/scheduler/`
- `tick.go` — `RunTick` and its phases: see the trace above. `Options`
  (`DefaultOptions`), `Outcome`.
- `claiming.go` — `claimReadyTasks`, `recoverExpiredLeases`,
  `returnUnstartedAttempt`, `ReleaseLeases`.
- `rows.go` — the task and attempt rows, `recordEvent` (the one place a
  pass writes `execution_events`; counted only once the pass commits), and
  `transitionExecution`, a compare-and-set: an execution's state only
  changes from the states the caller expects.
- `run.go` — `Loop.Run`, `ReleaseFinished`.
- `orphans.go` — `ReleaseOrphanedAttempts`: releases attempts older than
  `OrphanMinAge` that no task can use, neither a running task's current
  attempt nor the one a ready task will adopt (`stillNeeded`). Catches a
  Job started in a pass that rolled back for a task then cancelled, a
  release that failed, and Jobs whose execution was deleted.
- `retention.go` — `DeleteFinishedExecutions`: finished executions past
  `EXECUTION_RETENTION_DAYS`, a few hundred at a time.

#### `internal/api/`
- `service.go` — `Service`, KernelService: see the traces above. Every
  state change is conditional (`WHERE state IN ...`), never a value read
  and written back, because the scheduler changes the same rows; events
  are counted once their transaction commits.
- `auth.go` — `Callers`: the caller check, as an interceptor on every
  method. The bearer token must pass a TokenReview for
  `API_TOKEN_AUDIENCE` and belong to one of `API_ALLOWED_CALLERS` (the
  console): unauthenticated without a valid token, permission_denied for
  anyone else, and a failing review fails the request. Successful reviews
  are remembered for 60 s, in a bounded cache.
- `server.go` — `Handler`: KernelService, `/health/live` (never the
  database), `/health/ready` (the database answers and is at
  `migrate.Latest()`), `/metrics`; every request logged and measured by
  route, never by its literal path.

#### `internal/migrate/`
- `sql/NNNN_name.sql` — the schema, one file per change, embedded in the
  binary. A released file never changes.
- `Run` — under an advisory lock (two migrators wait for each other),
  applies the files the database doesn't have, each in its own
  transaction, recorded in `schema_migrations`. An install Alembic
  migrated (`alembic_version`) is taken over at the same version first.
- `Current`, `Latest`, `Wait` — what kernel-api's readiness and the
  scheduler's start check.

#### `internal/sleeper/`
- `Run` — one look: asleep already (stop looking: suspend the CronJob),
  or idle long enough (no unfinished execution; the last event, the
  console's last use and kernel-api's start all older than
  `SLEEPER_IDLE_AFTER_SECONDS`), then record the counts to wake to and
  scale to zero, the databases last. `--now` waits for unfinished
  executions instead of for idleness.
- `Platform` — the Kubernetes side, only through the scale subresource and
  the one state ConfigMap (what the chart's Role allows).
- `ShouldSleep`, `LastActivity` — the decision, pure.

#### `internal/logging/`, `internal/metrics/`
- JSON logs with `timestamp`, `severity`, `logger`, `message`, `service`;
  `kernel_events_total`, `kernel_http_requests_total`,
  `kernel_http_request_duration_seconds`,
  `kernel_scheduler_tick_duration_seconds`,
  `kernel_scheduler_status_read_errors_total`,
  `kernel_scheduler_tick_errors_total`, `kernel_tasks`,
  `kernel_oldest_ready_task_age_seconds`, and
  `kernel_unschedulable_steps` (from the scheduler's
  watch of its steps' Pods: `executor.Unschedulable`). Each process serves
  its own.


## Tests

`go test ./...` here; `make test` migrates the test database and runs
them in the pinned Go image. Everything that touches Postgres uses a real,
migrated database (`TEST_DATABASE_URL`, `internal/dbtest`); a missing one
fails rather than skips.

- **`internal/domain`, `internal/config`** — no I/O: DAG validation,
  credentials, backoff, input resolution, the result contract, settings.
- **`internal/api`** — kernel-api over HTTP through the generated client,
  on a database of its own (these commit): submitting (idempotency, a
  race on one request_id, every validation), reading, cancelling,
  retrying, health, and the caller check on every method; `Callers` with
  a fake TokenReview (refusals, the cache and its bound, a failing
  review).
- **`internal/executor`** — the Kubernetes executor against client-go's
  fake clientset, with reactors for the API's refusals: creating,
  adopting and refusing, Pod hardening, image pulls, release, the result
  cache, credentials in results, listing, the watch's read-skipping,
  placement; `JobName` against values the Python kernel computed.
- **`internal/scheduler`** — the scenarios the Python scheduler was proven
  by, with `executortest.Fake`: dispatch, chaining, retries and backoff,
  dispatch retries, cancellation (including a cancel racing a dispatch on
  two connections), timeouts, two schedulers finishing at once, claiming
  and caps, leases, orphans, logs, retention, and the loop stopping.
- **`internal/migrate`** — every file once, concurrent migrators, taking
  over an Alembic install, waiting for the schema, the schema's own
  guarantees, and that `console/docs/06-database-schemas.md` documents
  every table and column.
- **`internal/sleeper`** — the decision, a run against a fake cluster, and
  what it reads from the database.
- **`TestKind*`** — against a real kind cluster (`internal/kindtest`, which
  builds `internal/kindtest/fixture` and the `examples/` products and gets
  them to the cluster): the executor's mechanics, and whole executions
  through real passes. They skip without a kind context with an
  `execution-kernel` namespace; CI's kubernetes job requires them.

## Deployment files

- **`Dockerfile`** — a Go stage builds `/usr/local/bin/kernel` (static);
  the image is that on distroless (no shell), as user 65532. Helm's
  `command:` picks the subcommand.
- **`../helm/charts/execution-kernel/`** — the Kubernetes deployment (at
  the project root, beside `../helm/charts/execution-console`).
  `values.yaml` documents every option inline; `templates/` has one file
  per resource: kernel-api, kernel-scheduler, the migration hook Job
  (`kernel migrate`), the sleeper's CronJobs (`kernel sleep`).
- **`../proto/vertra/kernel/v1/kernel.proto`** — KernelService; `make
  proto` writes `internal/gen` and the console's client.
- **`../examples/project-product/`**, **`../examples/application-product/`**
  — the two fake product containers the kind tests run; each standalone,
  sharing no code.
