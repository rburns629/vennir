# Performance benchmarks

Measuring Vertra's throughput and latency, and checking it stays correct
under load, on a kind cluster of its own. Phase 1 (2026-10-28): one
end-to-end driver, the scheduler and Postgres alone, and what they found.
Numbers from kind are this machine's, not GKE's or EKS's: kind's node is a
container sharing the laptop's CPUs, memory and disk with everything else.

## What's here

- `catalog-template/samples/perf/`: the `perf` team's `noop` product. It
  sleeps `sleepMs`, succeeds, or fails (`always`, or `first-attempt`:
  retryable, so attempt 2 succeeds), pads its outputs up to `outputBytes`,
  and reports when its container started and finished. No network, no
  credentials, no cloud. It's published like any product (built, tested,
  scanned, pinned, admitted), so a benchmark pays every step a real run
  does.
- `perf/` (this folder): the driver. It submits DAGs of `noop` through the
  console's API with a token, as a pipeline would, waits for them, and
  writes `results/<run>-<scenario>.json` and `.md`: submit latency, end to
  end, and each step's time split into queue wait (ready to the kernel
  starting it), container start (the kernel starting it to the container's
  own clock starting) and completion lag (the container finishing to the
  kernel recording it); steps and DAGs a second; the node's CPU and memory;
  the commit, the machine and the kernel's settings. And correctness: every
  DAG ended as expected, every step ran its own inputs, the expected
  attempts, after what it depends on. It exits non-zero on any problem.
- `kernel/internal/scheduler/perf_test.go`: the scheduler and Postgres
  alone, with the fake executor (steps finish as they start), 1, 2 and 4
  schedulers, committed transactions on the test database; checks every run
  succeeds and no step starts twice. Only with `VERTRA_PERF=1`.
- `pgbench/run.sh <label>`: Postgres alone, as it's sized in the cluster:
  pgbench from a Pod of the kernel release (the NetworkPolicy admits only
  those), over TLS, in a scratch database it drops after, with 8 and 64
  clients at once, writes (TPC-B-like) and reads (select-only).
- Profiling: the kernel chart's `profiling.enabled` serves Go's profiler on
  127.0.0.1:6060 inside the kernel's Pods (`kubectl port-forward`, then
  `go tool pprof http://localhost:16060/debug/pprof/profile?seconds=25`).
- `kind-kernel.yaml`, `kind-console.yaml`: the perf cluster's settings on
  top of `helm/values/kind/`: at most 40 steps running at once (so a large
  scenario queues instead of starting hundreds of Pods on a laptop), and a
  catalog of its own in the registry (`localhost:5001/perf-catalog`), so
  publishing it never touches what `vertra-local` applies.

## Running it

The perf cluster is `vertra-perf`, separate from `vertra-local`. Docker
Desktop's VM is small (8 GB here), so stop the other cluster, and anything
else heavy (a local model: `lms unload --all`), while measuring:

```console
$ make down                                   # vertra-local, data kept
$ make quickstart KIND_CLUSTER=vertra-perf    # once; rerunnable
$ make kind-deploy-kernel KIND_CLUSTER=vertra-perf KIND_KERNEL_VALUES=perf/kind-kernel.yaml
$ make kind-deploy-console KIND_CLUSTER=vertra-perf KIND_CONSOLE_VALUES=perf/kind-console.yaml
$ make up KIND_CLUSTER=vertra-perf
$ make catalog-publish KIND_CLUSTER=vertra-perf SAMPLES=perf CATALOG_REGISTRY=localhost:5001/perf-catalog
```

Then, with a token (the local admin's session, kind only):

```console
$ export VERTRA_TOKEN=$(curl -s -X POST localhost:18080/api/vertra.console.v1.AuthService/Login \
    -H 'Content-Type: application/json' -d '{"email":"admin@example.com","password":"vertra-local"}' | jq -r .token)
$ cd perf && go run . -scenario baseline
```

Scenarios (starting points, not targets):

| Scenario | DAGs | Steps | Shape |
| --- | ---: | ---: | --- |
| `baseline` | 10 | 1 | single |
| `burst` | 100 | 1 | single |
| `dependency` | 10 | 20 | chain |
| `sustained` | 100 | 10 | fan-out (one, eight at once, one joining) |
| `higher` | 500 | 10 | fan-out; needs `-allow-large` |

Or `-scenario custom -shape single|chain|wide|fanout -dags N -steps N`.
Also `-sleep-ms`, `-fail never|always|first-attempt`, `-concurrency`
(submitters), `-rate` (submissions a second), and `-readers N`: N readers
doing what people watching do, the Runs page (ListExecutions, 50 a page) and
a run's page (GetExecution of one of this run's), while it goes, each
read's time reported; and `-cancel-after D`: each run cancelled D after it
was submitted (with `-sleep-ms` near it, as its steps finish), checked to
end cancelled or succeeded with every step ended.

`go run . compare <before.json> <after.json>` puts two runs' measures side
by side and fails on a clear regression: a p50 or p95 time a quarter worse
(and half a second), throughput a quarter lower, or the newer run
incorrect. The `perf` workflow (by hand, or weekly) runs baseline and burst
on a runner's own `vertra-perf` and compares each with its last successful
run's; only burst's comparison can fail it, since baseline's 10 DAGs start
on one scheduler poll and are one sample (the same commit twice: 2.5 and
4.6 s at p50). Its first successful run (2026-10-31, after #55 made `make quickstart`, `make
up` and the driver's port-forward check work on Linux) took 12 minutes on
a 4-CPU runner: baseline 2.5 s end to end at p50; burst 3.2 steps a
second, 19 s end to end at p50; both correct. Every workload is capped (500
DAGs, 50 steps, 5,000 steps in all; over 1,000 needs `-allow-large`). It
refuses a cluster not named `vertra-perf*`, a console not on this machine,
and a port-forward to any other cluster's console.

On a cloud cluster (GKE or EKS, a `vertra-perf*` one only, as on kind: an
install made for benchmarks, never the Makefile's `vertra-gke` or another
team's install), name its kubectl
context exactly in place of `-cluster`, with the perf sample published to
its registry and the forward the driver looks for:

```console
$ kubectl --context <context> -n vertra-system port-forward svc/console-execution-console 18080:8080 &
$ go run . -context <context> -image <registry>/perf/noop:latest -scenario burst
```

Its nodes aren't sampled (the report leaves out the node line); the cloud's
own monitoring has them. The check is on the context's name, which kubectl
lets you rename: never name a shared or production cluster's context
`vertra-perf*`.

The scheduler and Postgres alone, on the test database (`make test-db`):

```console
$ cd kernel && VERTRA_PERF=1 TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/execution_kernel_test \
    go test ./internal/scheduler -run TestPerf -v
```

Afterwards: `make down KIND_CLUSTER=vertra-perf`, `make up` for vertra-local.
`kind delete cluster --name vertra-perf` removes it altogether.

## Phase 1 findings (2026-10-28)

Apple M1 Max, 32 GB; Docker Desktop 10 CPUs, 7.7 GB; kind, one node,
Kubernetes 1.37.0; one scheduler, one kernel-api, one console; at most 40
steps running; steps doing nothing (`sleepMs` 0). Every run below was
correct.

**1. The kernel's own Kubernetes client was the constraint.** It never set
client-go's rate limit, so it ran at the default: 5 requests a second,
bursts of 10. Each step costs about five to seven calls (its ConfigMap and
Job made; the Job read, its Pods listed, its logs read, the Job and
ConfigMap deleted), so the scheduler could start and finish about one step
a second, whatever the cap. The scheduler's own log said so ("client-side
throttling"), and its passes that finished steps took 2.5 to 10 s while the
rest took under 5 ms. With the limit made a setting (`kubernetesClient` in
the kernel chart) and raised to 50 and 100, nothing else changed (now the
default, since 2026-10-28):

| | 5/s (default) | 50/s |
| --- | --- | --- |
| baseline: end to end, p50 | 6.7 s | 3.2 s |
| baseline: queue wait, p50 | 625 ms | 30 ms |
| burst (100 × 1): wall, steps/s | 90 s, 1.15 | 33 s, 3.24 |
| burst: queue wait, p50 | 32 s | 8 s |
| dependency (10 × 20 chained): wall, steps/s | 286 s, 0.71 | 84 s, 2.44 |
| throttling logged | yes | none |

**2. The scheduler and Postgres are far from the limit.** With the fake
executor: 185, 321 and 515 steps a second with 1, 2 and 4 schedulers for
one-step runs (passes of 108, 62 and 39 ms), 162 to 237 for chains; every
run succeeded, no step started twice. That's 50 to 150 times what the
cluster sustained, so Redis, a queue or a broker would buy nothing.
Chains don't scale past two schedulers: a chain has one step ready at a
time. (The test database is a container on the host, not the cluster's.)

**3. Now Kubernetes itself.** At 50/s what's left is mostly the cluster's:
about 2.5 to 3 s from a container exiting to the Job controller marking its
Job complete (the kernel reads the Job, not the Pod), and, in a burst,
container start-up rising to 3.5 s with 40 Pods starting at once on one
node.

**4. A pass's times are its start's.** Each scheduler pass stamps what it
records with the time it began, so under a long pass a step can be recorded
done before its container finished (the burst at 5/s: a negative completion
lag at p50). Harmless to correctness; it makes the kernel's own completion
times early by up to one pass, which the driver's completion lag inherits.

## Postgres sized (2026-10-29)

Postgres ran with a 1-CPU limit and stock settings at every size, and each
process held pgx's or node-postgres's default pool (pgx's is the node's CPUs,
4 on a 2-CPU node). Now each size gives it memory with settings to match,
no CPU limit, a /dev/shm of its own, and each process a pool the size sets,
every process's together under `max_connections`. `pgbench/run.sh` on
vertra-perf, same machine, 30 s each (transactions a second, mean latency):

| | 8 clients, writes | 64 clients, writes | 8 clients, reads | 64 clients, reads |
| --- | ---: | ---: | ---: | ---: |
| before (1-CPU limit, stock settings) | 1,912, 4.2 ms | 1,494, 42.8 ms | 13,601 | 10,091 |
| `minimal` (512Mi) | 3,028, 2.6 ms | 3,725, 17.2 ms | 18,742 | 23,619 |
| `resilient` (1Gi) | 3,083, 2.6 ms | 3,580, 17.9 ms | 22,430 | 24,669 |
| `scaled` (2Gi) | 3,144, 2.5 ms | 3,709, 17.3 ms | 22,806 | 24,827 |

Before, more clients at once got less done (the CPU limit throttled it);
now 64 at once get more done than 8. Past `minimal`, kind shows little:
writes are bound by the laptop's disk flushes and shared CPU, and pgbench's
300 MB fits each size's memory. A cloud's disk, and a database bigger than
`minimal`'s memory, are where the larger sizes tell. The platform end to
end (`burst`, the `scaled` settings, one copy of each) was unchanged at 3.15
steps/s, correct: Kubernetes, not Postgres, still sets steps a second.

On EKS (standard mode, c6a.large nodes, gp3, us-east-2, 2026-10-29), the
same run, writes then reads, transactions a second:

| | 8 clients, writes | 64 clients, writes | 8 clients, reads | 64 clients, reads |
| --- | ---: | ---: | ---: | ---: |
| `minimal` | 1,534, 5.2 ms | 1,710, 37 ms | 10,936 | 5,381 |
| `resilient` | 1,530, 5.2 ms | 1,803, 35 ms | 11,416 | 12,201 |

Writes are gp3's: each commit waits for the volume, whatever the size.
Reads under load double at `resilient` (its CPU and memory): `minimal`'s
quarter vCPU, on a node it shares, is what 64 clients at once run out of.

## Phase 2 (2026-10-29)

The same machine and cluster; the kernel's client at 50/100.

**1. A step is done when its container is.** The kernel now reads a
finished Pod (a Job runs one Pod, never restarted, so its container's end
is final) instead of waiting for the Job controller to mark the Job, and
stamps what a pass records with the pass's time as it goes, not its start
(no more negative completion lags). Every run correct:

| | phase 1 (50/s) | phase 2 |
| --- | --- | --- |
| baseline: completion lag, p50 | 2.6 s | 1.2 s |
| baseline: end to end, p50 | 3.2 s | 2.8 s |
| burst: wall, steps/s | 33 s, 3.24 | 28 s, 3.82 |
| burst: completion lag, p50 | 5.3 s | 3.3 s |
| dependency (10 × 20): wall, steps/s | 84 s, 2.44 | 70.5 s, 2.93 |
| dependency: completion lag, p50 | 2.9 s | 1.2 s |

**2. The scheduler isn't the constraint.** With `profiling.enabled` (Go's
profiler on 127.0.0.1:6060 in each kernel Pod, reached with `kubectl
port-forward deploy/kernel-execution-kernel-scheduler 16060:6060`), a
25-second CPU profile in the middle of a burst: 950 ms of CPU, under 4% of
one core, nearly all of it network I/O, TLS and decoding Kubernetes
objects. What's left is the node: in a burst, containers take 6.4 s to
start (p50) with 40 starting at once on one kind node, and steps queue
behind the 40-step cap.

**3. Found on the way: a clean image's scan recorded as failed.** Under
the burst's load, the console read a finished scan Job before its Pod's
log could be, called the empty output a failed scan, and refused every run
of the image for 15 minutes; the first attempt here measured nothing. The
console now waits for a finished scan's output (up to five minutes), and a
scan that can't be read says why.

## Phase 3 (2026-10-31)

The same machine and cluster, `main` at d08a465.

**1. Steady at volume.** `sustained` (100 fan-outs of 10, 1,000 steps):
301 s, 3.34 steps/s; `higher` (500 of them, 5,000 steps): 1,508 s, 3.32
steps/s. Five times the work in five times the time: container start (7.1
s, p50) and completion lag (4.4 s) didn't move, submissions held at 35 a
second, and every run was correct. The node is still the limit.

**2. Every run finishes near the end.** Ready steps are claimed oldest first
across all runs, so the fan-outs advance together: `higher`'s median run took
1,427 s of 1,508. Fair to everyone, but on a busy install even one small run
waits behind all the others. Not changed: a choice, for later.

**3. Postgres going away stalled everything for two minutes, and crashed
the console.** The kernel's Postgres Pod deleted 25 s into `dependency` (10
chains of 20):

| | before | after |
| --- | ---: | ---: |
| wall (70 s without a failure) | 628 s | 75.5 s |
| queue wait, p99 | 121 s | 11.2 s |
| completion lag, p99 | 121 s | 11.3 s |
| console | exited (code 1) | kept running |

Every run ended correctly both times. The stall: a connection opened just
as the Pod went had no connect timeout, so it waited out TCP's SYN retries
(about 127 s), and the scheduler's pass with it. Each process now bounds it
(`databaseConnectTimeoutSeconds`, 10). The crash: the console's pool raised
an `error` for an idle connection Postgres closed, and nothing listened, so
Node ended the process; it now logs it (`database_connection_lost`) and
opens another.

**4. The API server going away costs a little more than it was away.** Its
static Pod's manifest moved off the node for 30 s (37 s down) during
`dependency`: the median run took 130 s instead of 70, every run correct,
nothing restarted. The scheduler logged each status it couldn't read and
read it again the next pass. (`kubectl port-forward` dies with the API
server, so the driver's wall time is longer than the run's.)

**5. One console serves about 115 reads a second.** `burst` with readers:

| readers | reads/s | list runs p50 / p99 | get a run p50 / p99 | submit p50 |
| ---: | ---: | --- | --- | ---: |
| 0 | | | | 236 ms |
| 20 | 117 | 146 / 481 ms | 155 / 451 ms | 609 ms |
| 60 | 112 | 518 / 979 ms | 444 / 1071 ms | 2078 ms |

No read failed, and every run was correct. Three times the readers got no
more reads through: the console's one Node process was at 100% of a core
(kernel-api 15%, Postgres a few percent each). Its CPU profile under 60
readers is flat: garbage collection 11%, building SQL (drizzle) about 12%,
JSON encoding, the kernel client, socket writes; no one hot spot. So a busy
install needs more console replicas (`replicaCount`), not a fix; a
pipeline polling many runs a second competes with people for the same core.
Not measured here with two replicas: a port-forward reaches one Pod.

**6. Per-team usage is a cheap query on the console's own runs.** For the
Teams page's per-team run counts and products used (moved here from the
redesign's gaps): on the test database with 200,000 runs in a week, 80 teams,
2 to 5 steps each, runs each team started took 48 ms; products each team
used, every team at once, 177 ms (each run's steps' images, by repository);
one team's, 25 ms. So they come from `submitted_executions` (`on_behalf_of`,
`payload`'s steps), on every install, with no Prometheus: the all-teams one
cached for a minute.

**7. Cancelling as steps finish ends cleanly.** 60 single steps of 8 s, each
run cancelled 12 s after it was submitted: all 60 ended cancelled, every
step ended, and no Pod or Job was left 10 s later. 30 chains of 3 steps of
3 s, cancelled at 9 s: all cancelled, 89 steps cancelled (those waiting
behind the running one too), none left. A run is marked cancelled first and
its steps are stopped after, within seconds (the driver waits for both). A
step that finished as the cancel landed is recorded as it ended (succeeded)
in a run that's cancelled: the record says what happened.

**8. A create that timed out but happened is adopted, and one the kernel
gave up on is usually dropped by the API server too.** A local API server
answers well within the kernel's timeout, so `perf/slowcreate/` slows it:
an admission webhook holding each Job's first create in namespace `perf`
for a while (the retry's create passes at once), with the kernel's
Kubernetes request timeout at 3 s (`slowcreate/kernel.yaml`).

- Held 8 s (`baseline`, 10 steps): every create timed out, and every time
  the API server gave up on it with the kernel (the webhook saw the request
  go at 3 s), so no Job was made. The scheduler retried the same attempt
  5 s later and created it. All correct, each step's one attempt.
- Held 2.96 to 3.0 s, across the moment the kernel gives up (`burst`, 100
  steps): 39 creates timed out. 8 of them had been made all the same: the
  retry found the Job, logged "adopting this attempt's existing Job", made
  its request ConfigMap and ran it. The other 31 were dropped and made
  fresh. All 100 runs correct, every step one attempt, no Job twice.

So the window for a create that times out but happens is the few
milliseconds between the API server saving it and its answer arriving, and
when it happens, the retry adopts it, as the unit tests say
(`internal/scheduler/dispatch_test.go`, `internal/executor/kubernetes_test.go`).

To see it again, on `vertra-perf` only:

```
make kind-deploy-kernel KIND_CLUSTER=vertra-perf KIND_KERNEL_VALUES="perf/kind-kernel.yaml perf/slowcreate/kernel.yaml"
DELAY=2.96s JITTER=40ms perf/slowcreate/run.sh up
go run . -scenario burst   # then the scheduler's "adopting" lines and the webhook's log
perf/slowcreate/run.sh down
make kind-deploy-kernel KIND_CLUSTER=vertra-perf KIND_KERNEL_VALUES=perf/kind-kernel.yaml
```

The moment the kernel gives up moves with the machine: the webhook logs how
long it held each create, and when the API server gave up on one, so aim
`DELAY` at the gap between them.

## On GKE and EKS (2026-10-31 and 2026-11-01)

The billed proof run (TODO.md, item 7): released 0.6.0, size `minimal`,
steps on Spot nodes, `-context` naming each cluster. Every run was correct.

| | GKE Autopilot | EKS standard |
| --- | ---: | ---: |
| `baseline` (10 steps), end to end p50 | 110 s | 9.0 s |
| `baseline`, container start p50 | 13.1 s | 3.0 s |
| `burst` (100), steps/s | 0.53 | 0.45 |
| `burst`, container start p50 | 5.4 s | 13.1 s |
| `burst`, completion lag p50 | 3.2 s | 0.8 s |
| client throttling lines | 0 | 0 |

**1. The per-team cap is the limit, as it should be.** `minimal` lets a team
run 5 steps at once, so `burst` ran at about half a step a second on both,
and its queue wait (100 s p50 on EKS) is that cap. The client limits (50
and 100 a second) were never approached.

**2. A cold node is most of a small run.** GKE's baseline waited about 100 s
for Autopilot to add a Spot node, before its steps' Pods were made (container
start counts from the Pod's creation to its container running); EKS's steps node was already up from
`burst`. EKS's container start under `burst` is five steps sharing one
c6a.large.

**3. Raising the cap on GKE met the project's quota first.** With 40 at once
Autopilot couldn't add nodes (`SSD_TOTAL_GB`, 500 in the project): 0.41
steps a second, container start p95 146 s, completion lag p50 11.7 s and
p95 31 s, as Pods waited to be scheduled. `vertra apply` had warned of the
quota. Nothing alerts on dispatched steps whose Pods can't be scheduled
(TODO.md), and completion lag rising with them is worth a look (it was:
below).

**4. Losing a Pod retries the step.** A step's Pod evicted through the
Eviction API (as a Spot reclaim or a drain does) failed its attempt
`POD_TERMINATED_UNEXPECTEDLY`, retryable; the second attempt succeeded.

## Steps waiting for nodes (2026-11-02)

Why completion lag rose on GKE with Pods waiting for nodes (point 3
above): every pass read each dispatched Job whose Pod wasn't ready, a Job
GET and a Pod LIST, about once a second. 35 waiting wanted about 70 calls
a second, over the client's 50, so every call waited its turn, a finished
step's reads too. A Job whose Pod waits for a node (or for its container)
now rests until the watch reports a change, as a ready one did; one
pulling its image, or with no Pod, is still read every pass.

Reproduced on `vertra-perf` at GKE's proportions: 15 steps of a temporary
product whose Spot capacity was placed on a node label nothing has (so
they waited for good), the client's limit lowered to 20 a second (15
waiting want about 30), and a light load (40 one-step DAGs of a 1 s step,
0.5 a second), so the reads, not the load's own calls, filled the budget:

| | before | after |
| --- | ---: | ---: |
| Job GETs and Pod LISTs a minute, the 15 waiting alone | 1,148 | 112 |
| completion lag, p50 / p95 | 3.7 s / 5.7 s | 0.64 s / 1.7 s |
| queue wait, p50 | 1.0 s | 0.28 s |

At the usual limit (50) with 15 waiting, `burst` didn't change (2.6 s
p50 both): about 30 reads a second fit. With the limit at 20 and `burst`,
its own calls filled the budget whatever the waiting did (6.8 s and 6.2 s
p50). Not proven on GKE itself.

## On GKE again: 0.7.0 (2026-11-02)

The r7 proof run: released 0.7.0, GKE Autopilot, size `minimal` with both
caps raised to 40 (as 0.6.0's run), `burst` (100 steps). Correct, but
completion lag barely moved: 10.4 s p50 and 45.6 s p95 (0.6.0: 11.7 s and
31 s), queue wait 91 s p50, container start 52 s p50, 0.47 steps a second.
So the reads above weren't what held it on GKE. Its scheduler said why:

- most passes were quick (410 of 472 under 0.25 s), but 6 took over 10 s,
  and 12 dispatches failed and were retried, each one
  `failed calling webhook "policy.sigstore.dev" ... context deadline
  exceeded`: policy-controller checking the step's image signature when
  the scheduler made its Job, past the webhook's 10 s;
- a pass dispatches before it records what finished, so a pass held up by
  the webhook holds every finished step's record with it;
- policy-controller ran one replica at 100m CPU (Autopilot: also its
  limit), checks each step's image twice (its Job, then its Pod), keyless
  (Fulcio and Rekor), and 11 of its checks failed outright under the load.
  kind runs no policy-controller, which is why kind never showed this.

What's left is in TODO.md.

## Next (TODO.md)

Here: nothing left; the `perf` workflow (`.github/workflows/perf.yml`)
compares each weekly run with its last. `perf/`'s own tests run in CI
(2026-10-29).
