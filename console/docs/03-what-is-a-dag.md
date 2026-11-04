# What's a DAG, and why does this whole system revolve around one?

If you've used Terraform, GitHub Actions, or Airflow, you already have
the mental model for this — you just haven't necessarily called it a
"DAG" before. This walks through the concept from scratch, then maps it
directly onto tools you probably already know, then covers where this
system's DAG model genuinely differs from Terraform's, since that
difference trips people up if it's left unsaid.

---

## The concept, with no jargon first

Say you need to do three things: create a cloud project, then build a
container image *and* provision a database (either order, doesn't
matter, neither needs the other), then deploy a service that needs both
the image and the database to exist first.

You could just list those steps in some order and run them one at a
time. But that throws away two things you actually care about:

- **Which steps genuinely have to wait for which others** — deploying
  the service before the database exists would just fail; running
  everything strictly in a line when two of the steps don't depend on
  each other at all just wastes time.
- **A record of *why* each step ran when it did** — "the database step
  ran because the project step had already succeeded," not just "step 2
  happened to run after step 1 in whatever order I typed them."

A **DAG** — Directed Acyclic Graph — is just the structure that captures
this precisely: each step is a *node*; an arrow from one step to another
means "the second one can't start until the first one succeeds"
(*directed* — the arrow only goes one way); and there's no way to loop
back on yourself (*acyclic* — step A can never depend, even indirectly,
on step C if step C already depends on step A). That's the whole idea.
Once your steps are expressed this way, a program can figure out on its
own what's safe to run in parallel and what has to wait, instead of you
manually sequencing it by hand.

## Why this project is built around that idea specifically

Two real, concrete benefits, not abstract ones:

1. **Genuine parallelism, for free.** In the example above, building the
   image and provisioning the database have no relationship to each
   other — the DAG structure makes that fact visible to the scheduler,
   which dispatches both the moment the project step succeeds, instead
   of running them one after another just because they happened to be
   written in that order.
2. **A DAG this system actually runs is a record of a real decision.**
   Every dependency edge is a deliberate, persisted fact — task B moved
   to `READY` specifically because task A reached `SUCCEEDED`, not
   because of timing or coincidence. That's what makes "why did this
   step run when it did" always have a real, inspectable answer instead
   of "it was next in the script."

## The direct comparison: Terraform

If you've written Terraform, you've already built a DAG — you just
described it differently. When one resource block references another
(a `google_cloud_run_service` referencing a `google_sql_database_instance`
it needs), Terraform doesn't run your resources in file order. It reads
every reference, builds a dependency graph from them, and `terraform
apply` walks that graph — provisioning independent resources in
parallel, waiting on dependent ones. That graph-walking engine is doing
exactly what this project's scheduler does with a submitted DAG: resolve
what's actually ready, dispatch it, wait, repeat.

The direct mapping:

| Terraform | This system |
|---|---|
| A `resource` block | A `task` |
| An interpolation reference (`google_sql_database_instance.x.connection_name`) | `$fromTask`/`$output` |
| Implicit or explicit `depends_on` | `dependsOn` |
| `terraform plan`'s dependency graph | The persisted dependency edges (`task_dependencies`) |
| `terraform apply` walking the graph | `kernel-scheduler`'s poll loop, claiming whatever's `READY` |

**Where it genuinely differs — worth being precise about, not papering
over**: Terraform is fundamentally about *continuously declaring and
reconciling a desired state* — its `.tfstate` file is the durable record
of what *should* exist, `plan` shows you the diff between that and
reality, and re-running `apply` after nothing changed is a deliberate
no-op check. This system doesn't do that. A DAG submission here runs a
*specific sequence of steps, once* (resubmitting it with the same
`requestId` returns the run already started, rather than running it
again) — there's no ongoing reconciliation loop checking "does this
Cloud SQL instance still match what was asked for six months ago." The
nearest thing to `terraform destroy` is per resource, not per DAG: a step
can report what it made, the console keeps a record of it (**Runs → What
runs made**), and deleting one runs its product's `cleanup` action as a
run of its own. Idempotency here
means "resubmitting the same task never double-creates the same
resource," not "this system will notice and fix drift on its own." If
someone's expecting Terraform's continuous-reconciliation behavior from
this, that's the one place to correct the mental model explicitly, not
let it go unsaid.

## Other tools that use the same idea, if they're more familiar

- **GitHub Actions** — a job's `needs:` list is the exact same
  dependency-edge idea, just expressed in YAML instead of JSON; `ci.yml`
  in `vennir-catalog` is itself
  a real, live example of this same DAG concept, one level up from the
  DAGs it helps provision.
- **Apache Airflow** — probably the tool the term "DAG" is most
  associated with by name; Airflow's DAGs are long-lived, scheduled,
  Python-defined pipelines, closer to a cron-with-dependencies tool than
  to what this system does (one-shot, API-submitted, per-request
  executions) — a useful name-recognition anchor, not a close structural
  match.

## Seeing it, not just reading about it

The console's own Execution Detail page renders a submitted DAG's real
dependency graph live — a task sitting `BLOCKED` visibly flips to
`READY` the instant its dependency reaches `SUCCEEDED`. Watching that
happen against a real submission makes the concept click faster than
any diagram; the `local` sample team's README in `catalog-template/` has
a ready-to-run five-task chain to watch it live.

---

## Where to go deeper

- `docs/architecture.md` in the Vennir repository — the end-to-end
  request flow, including how the scheduler claims, starts and releases
  tasks, and the definitions (`Task`, `Execution`, their states).
- `01-getting-started.md` — the whole path from a new team to a
  running DAG, with real payloads to submit.
- `09-runs-explained.md` — a run's states, what a failed step does to the
  rest of the DAG, retrying, cancelling, and every failure code.
