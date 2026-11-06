# Where Vennir keeps its data

Vennir has two PostgreSQL databases, one per service, and neither service ever reads the other's:

- **The kernel's** (`execution_kernel`) holds the work itself: every execution, its tasks, their attempts, outputs, logs and events. The kernel knows nothing about people or teams beyond the namespace each task runs in.
- **The console's** (`execution_console`) holds who may do what: teams, users, bots and their tokens, registered products, which secrets each team has, and which teams can see which execution.

The two meet at one value: an execution's id. The kernel creates it; the console records it in `submitted_executions`, with the teams allowed to see it.

```mermaid
flowchart LR
  you([You or a pipeline]) -->|HTTPS + token| console[Console]
  console -->|teams, users, products, grants| cdb[(execution_console)]
  console -->|submit / read / cancel| kapi[kernel-api]
  kapi --> kdb[(execution_kernel)]
  sched[kernel-scheduler] --> kdb
  sched -->|Jobs| k8s[Kubernetes]
```

Times are all `timestamptz` (stored in UTC). Ids are UUIDs unless noted.

## The kernel database (`execution_kernel`)

```mermaid
erDiagram
  executions ||--o{ execution_tasks : "has"
  executions ||--o{ execution_events : "logs"
  execution_tasks ||--o{ task_dependencies : "depends on"
  execution_tasks ||--o{ task_attempts : "tried as"
  execution_tasks ||--o| task_outputs : "produced"
  execution_tasks ||--o| task_logs : "printed"
  execution_tasks ||--o{ execution_events : "about"
  executions {
    uuid id PK
    text external_reference
    text idempotency_key UK
    varchar state
  }
  execution_tasks {
    uuid id PK
    uuid execution_id FK
    text task_key
    varchar state
  }
  task_dependencies {
    uuid task_id PK,FK
    uuid depends_on_task_id PK,FK
  }
  task_attempts {
    uuid id PK
    uuid task_id FK
    int attempt_number
  }
  task_outputs {
    uuid task_id PK,FK
    jsonb outputs
  }
  task_logs {
    uuid task_id PK,FK
    text_array lines
  }
  execution_events {
    bigint id PK
    uuid execution_id FK
    uuid task_id FK
    text event_type
  }
```

Deleting an execution deletes everything under it (every foreign key is `ON DELETE CASCADE`). States are plain `varchar` columns with a check, not Postgres enums, so adding a state is an ordinary migration.

### executions

One row per submitted DAG.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | The execution id every API call uses. |
| `external_reference` | text | no | The DAG's `name`. The column kept its old name when the API field was renamed. |
| `idempotency_key` | text | no, unique | The DAG's `requestId`. The console prefixes it with the submitting teams (`team-a+team-b/<requestId>`) so two teams can't collide; without one, it's a random UUID. A second submission with the same key returns this execution instead of creating another. |
| `requested_by` | text | yes | Who submitted it, in the console's terms (`user:<id>`), recorded on each task's first attempt. The kernel never resolves it. |
| `state` | varchar | no | `PENDING` → `RUNNING` → `SUCCEEDED`, `FAILED` or `CANCELLED`. |
| `created_at`, `updated_at` | timestamptz | no | |

### execution_tasks

One row per task in a DAG, and the scheduler's work queue: it claims rows from here.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | Internal id. |
| `execution_id` | uuid | no | The execution it belongs to. |
| `task_key` | text | no | The task's `id` in the DAG; unique within its execution. |
| `image`, `action` | text | no | What runs: the container image, and the action passed as its argument. |
| `team` | text | no | The namespace the task's Job runs in. |
| `service_account` | text | no | The Pod's identity in that namespace. |
| `secret_refs` | text[] | no | Kubernetes Secrets to mount at `/platform/secrets/<name>`. |
| `token_audiences` | text[] | no | Audiences its Pod gets a projected ServiceAccount token for, at `/platform/tokens/<audience>`: its product's `tokenAudiences`, set by the console. |
| `input_schema` | jsonb | yes | Its product's input schema, as the console attached it: its resolved inputs are checked against it before it starts, failing with `INPUT_INVALID`. Empty: not checked. |
| `output_schema` | jsonb | yes | Its product's output schema: its outputs are checked against it when it finishes, failing with `OUTPUT_INVALID`. Empty: not checked. |
| `concurrency_scope` | text | yes | Whose concurrency key it has (its product); null: it never waits for another task. |
| `concurrency_inputs` | text[] | no | The inputs naming what it changes (product.yaml's `concurrencyKey`). |
| `concurrency_key` | text | yes | Its key, worked out from its resolved inputs when it's claimed: while a task with this key is claimed or running, another with it waits, READY. |
| `cap_scope` | text | yes | Its product's cap (product.yaml's `maxRunning`): the product, whose tasks share it; null: no cap. |
| `cap_limit` | integer | no | How many of the product's tasks may be claimed or running at once; the rest wait, READY. 0 with no cap. |
| `capacity` | text | yes | The capacity its product asks for (product.yaml's `capacity`): `spot` or `onDemand`, each a placement the install sets; null, the install's own. |
| `for_team` | text | yes | The team it runs for, which may not be the one it runs in (`team`): as the console sends it: a run's `onBehalfOf`; a cleanup's, the team each resource was made for (its owner team, or its product's for one made for a person alone); a person's run for no team, the task's team when they're in it, else null; a team's own DAG, its team. Its `request.json`'s `forTeam`, so a product marks what it makes as that team's and cleans up only that team's. Null: none. |
| `next_attempt_requested_by` | text | yes | Who retried it, for its next attempt; cleared when that attempt is claimed. |
| `approval_required` | boolean | no | It waits in `AWAITING_APPROVAL`, instead of becoming `READY`, until a maintainer of its team approves it. The console sets it from product.yaml's `approval` and the owning team's `allowedTargets`. |
| `approved_by`, `approved_at` | text, timestamptz | yes | Who approved it (`user:<id>`) and when. Kept across retries, so an approved step isn't asked about again. |
| `resources` | jsonb | yes | The task's own Pod size: `cpu`, `memory` and `memoryLimit`, as Kubernetes quantities. Null, or a part left out, means the deployment's default (`TASK_DEFAULT_RESOURCES`). |
| `state` | varchar | no | `BLOCKED` (waiting on dependencies), `AWAITING_APPROVAL` (waiting for a person to approve it), `READY`, `CLAIMED` (a scheduler took it), `RUNNING` (its Job exists), then `SUCCEEDED`, `FAILED` or `CANCELLED`. |
| `original_inputs` | jsonb | no | The inputs as submitted, `$fromTask` references included. |
| `resolved_inputs` | jsonb | yes | The inputs actually sent, with references replaced by upstream outputs. Set at dispatch. |
| `timeout_seconds` | integer | no | How long one attempt may run. |
| `max_attempts` | integer | no | Attempts allowed for a retryable failure. |
| `attempt_count` | integer | no | Attempts started so far. |
| `dispatch_failures` | integer | no | Starts of the current attempt that raised in a row (an API timeout, say). Each retries the same attempt, so its Job name, adopting what the failed start left; past the scheduler's limit the attempt fails. Back to 0 once a start succeeds. |
| `lease_owner` | text | yes | Which scheduler holds the task while `CLAIMED`/`RUNNING`. |
| `lease_expires_at` | timestamptz | yes | If this passes (the scheduler died or was replaced), another scheduler takes the task over: it keeps watching a running task's Job, and a task that hadn't started yet goes back to `READY`. |
| `available_at` | timestamptz | no | When the task may be claimed: when it became `READY`, or later for an automatic retry (the backoff). Schedulers claim the oldest first. While `AWAITING_APPROVAL`, since when it has waited: it fails with `APPROVAL_EXPIRED` after the scheduler's approval timeout. |
| `executor_handle` | jsonb | yes | Where the current attempt runs: `{"namespace", "jobName"}`. |
| `failure` | jsonb | yes | Why it failed: `{"code", "message", "retryable"}`. |
| `created_at`, `updated_at` | timestamptz | no | |

Indexed on `(state, available_at)`, which is exactly the scheduler's "next READY task" query.

### task_dependencies

The DAG's edges: `task_id` waits for `depends_on_task_id`. A table rather than a JSON list, so "have all of this task's dependencies succeeded?" is a join.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `task_id` | uuid | no | The waiting task. |
| `depends_on_task_id` | uuid | no | The task it waits for. Indexed, to find a finished task's dependents. |

### task_attempts

The retry history: one row per attempt. `execution_tasks.attempt_count` is the live counter.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `task_id` | uuid | no | |
| `attempt_number` | integer | no | 1, 2, …; unique per task. |
| `executor_handle` | jsonb | yes | That attempt's Job. |
| `started_at`, `completed_at` | timestamptz | yes | |
| `failure` | jsonb | yes | That attempt's failure, if it failed. |
| `requested_by` | text | yes | Who asked for this attempt: the submitter for a first attempt, whoever retried it, or null for an automatic retry. |
| `trigger` | text | yes | `submitted`, `retried` or `automatic_retry`. |
| `acted_as` | text | yes | The identity it ran as: `<team>/<serviceAccount>`. |
| `image` | text | yes | The image it ran, pinned to its digest. |

### task_outputs

A task's outputs (from its `result.json`), which downstream `$fromTask` inputs read. One row per task; a retry overwrites it.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `task_id` | uuid | no | |
| `outputs` | jsonb | no | The `outputs` object the container wrote. |
| `created_at` | timestamptz | no | |

### task_logs

What the task's container printed, refreshed while it runs. Kept here because the kernel deletes a task's Job and Pod once its result is committed. One row per task, overwritten by each attempt.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `task_id` | uuid | no | |
| `lines` | text[] | no | stdout and stderr, combined, one line per element. |
| `created_at` | timestamptz | no | |

### execution_events

An append-only log of everything that happened to an execution, in order. It's what the console's event timeline shows.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | bigint | no | Increasing, so it orders events exactly. |
| `execution_id` | uuid | no | |
| `task_id` | uuid | yes | Set for task events. |
| `event_type` | text | no | `EXECUTION_CREATED`, `EXECUTION_STARTED`, `EXECUTION_SUCCEEDED`, `EXECUTION_FAILED`, `EXECUTION_CANCELLED`, `EXECUTION_RESUMED`, `TASK_CLAIMED`, `TASK_STARTED`, `TASK_SUCCEEDED`, `TASK_FAILED`, `TASK_CANCELLED`, `TASK_RETRIED`. |
| `payload` | jsonb | no | Details for that event, such as a failure. |
| `created_at` | timestamptz | no | |

`schema_migrations` also exists: which of `kernel/internal/migrate/sql/` the database has (`kernel migrate`).

## The console database (`execution_console`)

```mermaid
erDiagram
  users ||--o{ team_memberships : "belongs to"
  teams ||--o{ team_memberships : "has"
  users ||--o{ api_tokens : "holds"
  teams ||--o{ products : "owns"
  wiring_types {
    text name PK
    text json_type
    bool shared
  }
  products ||--o{ product_releases : "released as"
  teams ||--o{ image_repositories : "owns"
  teams ||--o{ secret_grants : "has"
  teams ||--o{ templates : "owns"
  teams ||--o{ apis : "publishes"
  apis ||--o{ api_traffic : "counted in"
  apis ||--o| api_problems : "can't be served for"
  apis ||--o{ api_grants : "may be called by"
  apis ||--o{ api_access_requests : "asked for in"
  users ||--o{ user_groups : "is in"
  users ||--o{ submitted_executions : "submitted"
  teams {
    uuid id PK
    text name UK
    timestamptz retired_at
    timestamptz deleted_at
  }
  users {
    uuid id PK
    text email UK
    bool is_admin
    bool is_bot
    text oidc_subject UK
  }
  team_memberships {
    uuid user_id PK,FK
    uuid team_id PK,FK
    text role
  }
  api_tokens {
    uuid id PK
    uuid user_id FK
    text token_hash UK
  }
  products {
    uuid id PK
    text name UK
    uuid team_id FK
  }
  product_releases {
    uuid id PK
    uuid product_id FK
    text image
    timestamptz last_used_at
  }
  image_repositories {
    text repository PK
    uuid team_id FK
  }
  image_scans {
    text digest PK
    text status
  }
  audit_log {
    bigserial id PK
    uuid actor_id
    text route
    text hash
  }
  audit_export {
    int id PK
    bigint last_id
  }
  audit_reads {
    bigserial id PK
    uuid actor_id
    uuid_array execution_ids
    text_array teams
  }
  secret_grants {
    uuid id PK
    uuid team_id FK
    text secret_name
  }
  submitted_executions {
    uuid execution_id PK
    text_array teams
    uuid submitted_by FK
  }
  submitted_executions ||--o{ resources : "made"
  resources {
    uuid id PK
    text product_team UK
    text type UK
    text external_id UK
  }
  resources ||--o{ resource_links : "depends on"
  resource_links {
    uuid resource_id PK
    uuid depends_on_id PK
    text input PK
  }
```

A team's name is also its Kubernetes namespace; there is no separate column for it. `submitted_executions.teams` holds team *names*, which is why a purged team's row is kept: a new team reusing the name would otherwise see the old team's executions.

### teams

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `name` | text | no, unique | The team, and its namespace. |
| `created_at` | timestamptz | no | |
| `retired_at` | timestamptz | yes | Set when the team is retired: read-only, products unregistered. Clearing it brings the team back. |
| `retired_by` | text | yes | Who retired it, as it was then: their email, or `the catalog` for a release that dropped it. Null while it isn't retired. Only a team `the catalog` retired comes back when a release names it again; any other stays retired until an admin un-retires it. |
| `deleted_at` | timestamptz | yes | Set when a retired team is purged: memberships, grants and products are gone and the team is hidden, but the row stays so the name stays reserved. |
| `from_catalog` | boolean | no | Made by a catalog release: retired when a release no longer names it. A team an admin made isn't touched. |
| `require_sso` | boolean | no | Its members sign in with single sign-on only: their passwords, and sessions a password made, are refused (admins' aren't). No effect while single sign-on is off. |
| `quota` | jsonb | yes | Its own resource limits, set by an admin: `cpu`, `memory` (all its steps' requests together), `pods`, `stepMemory` (one step's most), Kubernetes quantities, `""` for none. Null: the install's (`teamNamespaces.quota`). Kept in its namespace as a ResourceQuota and LimitRange. |
| `allowed_targets` | jsonb | no | team.yaml's `allowedTargets` from the release: `[{ teams, targets: { "gcp.project": [values or patterns], ... }, approval? }]`, where other teams may aim this team's products; a rule with `approval: true` lets its targets through only with a maintainer's approval. Empty: nowhere. |
| `contact`, `help_chat`, `help_url` | text | yes | team.yaml's `contact` and `help` (`chat`, `url`), from the release: whom to ask when one of its steps fails. |
| `owner` | text | yes | team.yaml's `owner` in the catalog (a GitHub user or team), from the release: shown on the Team page, never a grant (membership is the console's). |
| `description` | text | yes | team.yaml's `description` in the catalog, from the release: shown on the Teams page and the team's page. Null for a team made here. |

### users

People and bots alike.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `email` | text | no, unique | Kept lowercase however it was typed. A bot's is made up, such as `team-a-release-pipeline@bots.vennir.local`. |
| `password_hash` | text | yes | An argon2 hash. Empty for bots, which use tokens, and for people who sign in only through single sign-on. |
| `is_admin` | boolean | no | A platform admin: may act on every team and use the Admin page. |
| `is_bot` | boolean | no | A machine identity, which signs in only with an API token. |
| `order_templates` | text[] | yes | An ordering bot's templates (decision 23, `<team>/<name>`): the only ones it may run, and nothing else. Empty: not an ordering bot. |
| `password_changed_at` | timestamptz | yes | Sessions issued before this are rejected, so changing a password signs out every other session. |
| `must_change_password` | boolean | no | Its password was set by someone else (an admin's new account or reset, `vennir admin reset-password`): a session it signs in may only change it. |
| `oidc_subject` | text, unique | yes | The single sign-on account bound at the first sign-in through it (`<issuer> <sub>`): from then on only that account signs in as this person. |
| `last_signed_in_at` | timestamptz | yes | Its last sign-in, with a password or single sign-on; empty if it never has. Shown on the Admin page's list of people. |
| `sso_groups` | text[] | yes | Every single sign-on group the person's last sign-in read (a groups claim's values, or of Google Workspace groups the ones asked about), lowercased, at most 1000; null without a group source, or once the sources change. The console's alone: the gateway's role can't read it. A request for access copies it (`api_access_requests.requester_groups`). |
| `sso_groups_read_at` | timestamptz | yes | When `sso_groups` was read. |
| `self_registered` | boolean | no | Made by its own sign-up (self-registration), which checks nothing about the email. Until single sign-on binds it (`oidc_subject`), nobody has verified the address is theirs, so a maintainer adding it to a team by email is refused, saying so (an admin may add it). Set, for accounts made before the column, from the audit log's successful registrations (as far back as it goes, and only since registrations were audited), unless that email's account was deleted or made by an admin after. |
| `email_kinds` | text[] | no | Which of their notifications are emailed to them too, when the install sends email: `run_failed`, `approval_waiting`, `product_not_ready`, `catalog_failing`, `step_refused` and `platform_alert` by default. |
| `created_at` | timestamptz | no | |

### team_memberships

Who is in which team, and as what. Any member sees the team's executions, logs and Pods, and runs its actions; a maintainer also manages its members, secrets and bots and submits raw DAGs for it.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `user_id` | uuid | no | |
| `team_id` | uuid | no | |
| `role` | text | no | `maintainer` or `member`. Memberships from before roles are maintainers. |
| `created_at` | timestamptz | no | |
| `via_groups` | text[] | yes | The single sign-on groups that give the role, as the person's last sign-in (or the hourly Google groups read) found them; null when added by hand. Empty (`{}`) for a single sign-on member of a team that was mapped after they joined it (or before 0067): it follows their groups from their next sign-in. |
| `from_groups` | boolean | no | Generated: `via_groups is not null`. Whether groups gave it, without which ones: what the gateway may read. |

### api_tokens

Tokens for bots: a team's bots (Team page → Automation) and the catalog's automation token.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `user_id` | uuid | no | The bot it signs in as. |
| `token_hash` | text | no, unique | SHA-256 of the token. The token itself is shown once and never stored. |
| `label` | text | no | What uses it, for people reading the Team page. |
| `scopes` | text[] | no | For an automation token only, its platform-wide permissions, such as `teams:create` or `products:register`. Empty for a team's bot, whose access comes from its team. |
| `created_by` | uuid | yes | Who made it. A run its bot submits isn't approved by them, so two people agree (`core/approvals.ts`). Empty when not known, such as for a token from before this was recorded whose maker the audit log doesn't name. |
| `created_at` | timestamptz | no | |
| `revoked_at` | timestamptz | yes | Set when revoked; the token stops working at once. |
| `last_used_at` | timestamptz | yes | When it last signed a request in (updated at most every few minutes). |
| `expires_at` | timestamptz | yes | After this it signs nothing in. New tokens last 90 days unless their maker chose otherwise; empty: until revoked (tokens from before expiry, and those made to last). |

### revoked_sessions

Sessions signed out before they expired (`AuthService/SignOut`): the console and the gateway refuse a session whose id is here. Deleted once the session would have expired anyway.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `sid` | text | no, key | The session's id (its token's `sid`). |
| `expires_at` | timestamptz | no | When the session would have expired. |

### rate_limit_windows

The fixed-window limits on signing in, registering, changing a password and adding members (`src/rpc/rateLimit.ts`), kept here so every copy of the console counts the same attempts. Deleted once their window ends.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `key` | text | no, key | The limit and who it counts, such as `login:<address>:<email>`. |
| `count` | integer | no | Attempts this window. |
| `resets_at` | timestamptz | no | When the window ends and the count starts again. |

### sign_in_failures

Each email's failed sign-ins, from any address (`src/auth/loginThrottle.ts`): past 10 in an hour, attempts are spaced out. Cleared by a successful sign-in; deleted an hour after the window started.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `email` | text | no, key | The email tried, lowercased, whether or not it has an account. |
| `failures` | integer | no | Failures this window. |
| `window_start` | timestamptz | no | When the window's first failure was. |
| `next_at` | timestamptz | yes | No attempt is checked before this. |

### products

What a DAG step can run: one row per image and action.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `name` | text | no, unique | |
| `image` | text | no | The current image, the one CI registered last. |
| `action` | text | no | Unique together with `image`. |
| `team_id` | uuid | yes | The owning team. Empty for a platform-provided product. |
| `input_schema` | jsonb | no | The inputs the action takes, as JSON Schema: what its order form is built from. |
| `display_name` | text | yes | The product's name for people, such as *GCP Cloud SQL*. |
| `description` | text | yes | What it does. |
| `output_schema` | jsonb | no | What the action outputs, as JSON Schema, including which wiring types it provides. |
| `service_account` | text | yes | The ServiceAccount its tasks run as, in the owning team's namespace. |
| `required_secrets` | text[] | no | The team secrets it uses: the action's `secretRefs` in `product.yaml`, its bindings. (The column keeps its name from before catalog format v2.) |
| `token_audiences` | text[] | no | Audiences its tasks get a projected ServiceAccount token for, to sign in to another cloud: `tokenAudiences` in `product.yaml`. |
| `resources` | jsonb | yes | The Pod size its tasks get when a task doesn't set its own: `cpu`, `memory`, `memoryLimit` as Kubernetes quantities. Null: the deployment's default. |
| `share_with` | text[] | no | The other teams that may run it or include it in their templates, or `*` for every team; empty, only its own team. Teams it isn't shared with still see it, and can ask for access. |
| `hidden` | boolean | no | `visibility: hidden` in product.yaml: only its own team (and admins) see it; it then has no `share_with`. |
| `source_path` | text | yes | Its product.yaml in the catalog repository, for "Ask for access" links; null when it wasn't registered from a release. |
| `idempotent` | boolean | no | product.yaml's `idempotent`: running it again with the same inputs does no harm. Needed for more than one attempt. |
| `max_attempts` | integer | no | product.yaml's `maxAttempts`: how many times a step of it may run in all. A step gets this, or fewer if its template or DAG asks; one if the product isn't idempotent. |
| `concurrency_key` | text[] | no | product.yaml's `concurrencyKey`: the inputs naming what a step of it changes. The kernel runs one step per set of their values at a time. |
| `max_running` | integer | no | product.yaml's `maxRunning`: at most this many of the product's steps (all its actions, sharing its catalog folder) claimed or running at once; 0, no cap of its own. |
| `clouds` | text[] | no | The clouds of the installs it's for (product.yaml's `clouds`, else its team.yaml's); empty, every install. On an install on another cloud it's listed, not checked, and refused at submit (`NOT_FOR_THIS_INSTALL`). |
| `clouds_from` | text | no | Which file set `clouds`: `product`, `team`, or empty when neither did. |
| `capacity` | text | yes | product.yaml's `capacity`: `spot` or `onDemand`, where the install offers a choice; null, the install's own placement. |
| `examples` | jsonb | no | Examples of running it, from its passing contract tests: `[{ name, inputs, outputs }]`, up to ten. The run form offers them. |
| `check` | text | yes | product.yaml's `check` (the product's): the action that says whether it's ready on this install. Null: none. |
| `plan` | text | yes | product.yaml's `plan`: the action of the same product that says what a step of this one would do. **Preview** runs it. Null: none. |
| `cleanup` | jsonb | yes | product.yaml's `cleanup`: `{ action, inputs }`, the action of the same product that removes a resource its steps report, and its inputs (null: `{"resource": ...}`). Null: nothing removes them. |
| `approval` | text | yes | product.yaml's `approval`: `always`, or `otherTeams` (only when another team runs it). A step of it then waits for a maintainer of its team to approve it. Null: never, unless an `allowedTargets` rule asks, or `approval_teams` names the run's team. |
| `approval_teams` | text[] | no | product.yaml's `approval` as a list of teams: a step of it waits for an approval when its run is for one of them (never its own team's). Empty: by `approval` alone. |
| `error_help` | jsonb | no | product.yaml's `errors`: `{ CODE: { means, do } }`, shown when a step fails with that code. |
| `deprecated` | text | yes | Why it's deprecated and what to use instead; null when it isn't. |
| `from_catalog` | boolean | no | Registered from a catalog release: unregistered when a release no longer has it. One an admin registered by hand isn't. |
| `created_at` | timestamptz | no | |

Catalog CI registers all of these from the product's `product.yaml` (the catalog's `tools/product.schema.json` describes it). A registration that leaves one out keeps what's stored. Nothing that runs a task reads them: they're for browsing products, building forms and generating DAGs.

### product_releases

Every image a product has been registered with, so the Products page can list its releases. A product's identity is tied to these: a step runs as the product's ServiceAccount, with its team's Secrets, only when its image is one of them by repository and digest, and only the current one or an earlier one still in use (run by an execution not yet finished, or registered or run in the last hour). The kernel chart's identity policy holds the same list.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `product_id` | uuid | no | |
| `image` | text | no | Unique per product: registering the same image again isn't a new release. Pinned (`…@sha256:…`), unless it was registered by tag with image pinning off, when it never gives a step the product's identity. |
| `registered_at` | timestamptz | no | |
| `last_used_at` | timestamptz | no | When it was last registered or run as its product: an earlier release keeps the product's identity for an hour after. |

### image_repositories

Which team owns each image repository: the first team to register a product from it. Only that team's products may use it, so no team can register another team's code as its own product and run it with its own ServiceAccount and Secrets. A row stays when its products are deleted, so the repository can't be taken over afterwards; an admin releases it (`ProductService/ReleaseImageRepository`) once no product uses it. Products registered before this table existed get their rows when the console starts, the oldest product of a repository deciding.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `repository` | text | no | An image without its tag or digest, normalized the way the kubelet reads it (`node` is `docker.io/library/node`). |
| `team_id` | uuid | yes | The owning team; null for the platform (products with no team). |
| `created_at` | timestamptz | no | When it was claimed. |

### audit_log

Who changed what (`src/audit.ts`): one row per call that tried to change something (any method not marked as only reading), allowed or refused, recorded once it's answered, signing in and changing a password included (not a call with no one signed in to a method that needs someone: that is only logged). Admins read it with `AdminService/ListAuditEntries`; each entry is also logged (`event: "audit"`).

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | bigserial | no | Increasing; pages go by it. |
| `at` | timestamptz | no | |
| `actor_id` | uuid | yes | The caller (a user or a bot), or for a sign-in, who it signed in; null when unauthenticated. |
| `method` | text | no | `RPC` (older rows: POST, PUT, PATCH or DELETE). |
| `route` | text | no | The method, such as `vennir.console.v1.SecretService/PutSecret` (older rows: a REST route pattern, such as `/api/teams/:teamName/secrets/:secretName`). |
| `target` | jsonb | no | The identifying fields of the request (names, teams, images, emails, scopes, reasons) and the client's address (`clientIp`); never a secret value, password or token. |
| `status` | integer | no | The answer's status, as HTTP would say it (200, 403, 409, ...): a refusal is recorded too. |
| `request_id` | text | yes | The request's id, as in the logs. |
| `hash` | text | yes | sha256 of the previous entry's hash and this entry's fields, so changing, removing or adding an entry breaks every later hash. Null on entries from before the chain. |

### audit_reads

Who read what (`src/auditReads.ts`): one row per call that returned sensitive content to its caller: a run's outputs or failure messages (`ExecutionService/GetExecution`, `WatchExecution`, `ListExecutionEvents`), what resources provided, which are steps' outputs (`ResourceService/ListResources`; `OrderService/PreviewOrder` when its plan fills an input with a resource's value), step logs (`ExecutionService/GetExecutionLogs`, `ObserveService/SearchLogs`), a team's secret or SecretStore names (`SecretService/ListSecrets`, `ListSecretStores`), the chat agent's tools that read a run, resources or an order's plan (`get_run`, `list_team_resources`, `plan_order`; recorded as the person it acted for), and reading this table (`AdminService/ListAuditReads`). Only what was returned: a step whose outputs the caller doesn't see (`src/core/runView.ts`), or one with nothing to show yet, isn't recorded, and a call that returned nothing sensitive leaves no row. Page views aren't recorded. A list is one row, its runs in `execution_ids`. The same reader, from the same address, shown the same content again (same method, runs, teams and target, and the same outputs, failure messages, log lines or provided values, compared by a hash that's never stored) within 10 minutes gets one row, by each console process: the cache (of sha256 keys) is in memory, so a restart or another replica records it again. Changed content or a new address is a new row; reading this table is never deduped. Kept apart from `audit_log`, so the write chain doesn't grow with every read, for `retention.auditReadsDays` (90 by default). Recorded after the answer, without holding it up: a row that can't be written is logged at error (`event: "audit_read_write_failed"`, with what it would have said), and the read is still answered; every read is also logged (`event: "audit_read"`), a repeat included. Admins read it with `AdminService/ListAuditReads`; the gateway's role has no grant on it.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | bigserial | no | Increasing; pages go by it. |
| `at` | timestamptz | no | When it was read. |
| `actor_id` | uuid | yes | Who read it (a user or a bot); no foreign key, so a deleted account's reads stay. |
| `route` | text | no | The method, such as `vennir.console.v1.ExecutionService/GetExecution` (the chat agent's: `ChatService/Ask`, `AskStream` or `TestChatConfig`, with the tool in `target`). |
| `execution_ids` | uuid[] | no | The runs read: one for a run's page, several for a list (resources, a log search, an order's plan's resources); empty for secrets. |
| `teams` | text[] | no | The teams whose data it was: the steps' teams, the resources' (made by and for), or the secrets'. |
| `target` | jsonb | no | What was read, by name only: `tasks` (the step keys seen in full), `runs` (a log search's steps, by run), `secrets` or `stores` (names), `resources` (ids), `lines` (a count), `tool` (the chat agent's), a filter (an admin's `ListAuditReads`). Never an output, a log line, a failure message, a provided value or a secret value. |
| `client_ip` | text | yes | The client's address, as `audit_log` records it. |
| `request_id` | text | yes | The request's id, as in the logs. |

### audit_export

The audit log's write-once copy (`src/auditExport.ts`), one row: how far the copy has gone, and how the database compares with it.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | integer | no | Always 1. |
| `last_id` | bigint | no | The last entry copied; the next copy starts after it. |
| `last_hash` | text | no | Its hash, which the next copy's chain must follow from. |
| `exported_at` | timestamptz | yes | When the last copy was written. |
| `checked_at` | timestamptz | yes | When the export last looked. |
| `error` | text | yes | Why the last look didn't copy: a broken chain (where), or the bucket. |
| `broken_at` | bigint | yes | The entry where the chain broke at the last look; empty while it holds. |
| `compared_through` | bigint | no | The last entry compared with the copy this round (each look compares a few copies, round and round). |
| `compared_at` | timestamptz | yes | When the database was last compared with the copy. |
| `differs_at` | bigint | yes | The first entry changed or gone in the database since it was copied; empty while they agree. |
| `compare_problem` | text | yes | What the last comparison found, or why it couldn't finish (the copy unreadable). |

### image_scans

One security scan verdict per image digest (`src/scanning.ts`). Every image is scanned before it's registered or run, whoever built it, and again daily while it's in use; a failed one (a HIGH or CRITICAL vulnerability with a fix, or a secret in the image) blocks new registrations and runs until a rescan finds it clean or an admin accepts it. The kernel chart's scan policy holds the digests that passed (or were accepted) and are in use, so the cluster refuses any other.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `digest` | text | no | `sha256:…`. |
| `image` | text | no | The reference it was scanned as. |
| `status` | text | no | `pending` (never scanned yet), `passed`, `failed` or `error` (the scan couldn't run). |
| `findings` | jsonb | yes | Counts (`fixable`, `unfixable`, `secrets`) and up to 25 findings, blocking ones first. |
| `job_name` | text | yes | The scan Job running now, if any. |
| `requested_at` | timestamptz | no | When the last scan was started. |
| `scanned_at` | timestamptz | yes | When the verdict was recorded. |
| `last_used_at` | timestamptz | no | When it was last registered or run; rescans stop 30 days after. |
| `accepted_by`, `accepted_reason`, `accepted_at` | uuid, text, timestamptz | yes | An admin accepted a failed verdict, and why. Cleared by a rescan that finds something new. |

### secret_grants

Which secrets each team has registered, never their values. The values live only in Kubernetes Secrets. Any of the team's registered products may mount any of them, when a step lists it in `secretRefs`; the cluster's identity policy holds the same list.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `team_id` | uuid | no | |
| `secret_name` | text | no | The Kubernetes Secret's name in the team's namespace. Unique per team. |
| `keys` | text[] | no | The keys inside the Secret. |
| `source` | text | no | `literal` (a value was pasted in) or `external` (synced by External Secrets from a cloud secret store). |
| `created_at`, `updated_at` | timestamptz | no | |

### wiring_types

The catalog's wiring vocabulary, from each team's `teams/<team>/types.yaml`: the names a product's input uses to say what it needs (`x-vennir-needs`) and an output what it provides (`x-vennir-provides`), such as `gcp.project`. The order builder wires a cart by them (decision 25). A catalog release that has any replaces the whole set; an install whose catalog has none sets it with `ProductService/ReplaceWiringTypes` (an admin).

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `name` | text | no | The type, such as `gcp.cloudsql.connection`. |
| `json_type` | text | no | The value's JSON type: `string`, `integer`, `number` or `boolean`. |
| `description` | text | no | What a value of this type is. |
| `shared` | boolean | no | When nothing in an order provides it, asked once for the whole order instead of once per product. |
| `default_provider` | text | yes | `<team>/<product>.<action>` added to an order automatically when a required input needs this type and nothing provides it. |
| `team` | text | yes | The team whose `types.yaml` defines it, which says what it means. Null: set by `ReplaceWiringTypes`. |
| `updated_at` | timestamptz | no | |

### notification_settings

Install-wide notification settings, one row: the admins' chat channel, a team whose webhook may also get admins' alerts (`platform_alert`, `catalog_failing`, and every team's `step_refused`) when it asks for those kinds. Admins choose it on the Admin page.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | integer | no | Always 1. |
| `admin_team_id` | uuid | yes | The team (`teams.id`); none when unset or the team is deleted. A retired one is skipped. |
| `updated_by` | uuid | yes | The admin who chose it (`users.id`). |
| `updated_at` | timestamptz | no | When. |

### secret_store_identities

The cloud identities each team's SecretStores sign in as: a Google service account, an AWS role or an Azure identity, from its ESO ServiceAccounts' annotations and the role a store assumes. Each is one team's alone, so another team's store can't sign in as it and read that team's secrets; applying a store that names one another team holds is refused (`IDENTITY_IN_USE`). A team keeps its own while retired or purged.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `identity` | text | no | `<cloud>:<id>`, lowercased: `gcp:eso@p.iam.gserviceaccount.com`, `aws:arn:aws:iam::…:role/…`, `azure:<client id>`. Primary key. |
| `team_id` | uuid | no | The team whose stores sign in as it (`teams.id`; deleted with the team). |
| `created_at` | timestamptz | no | When its stores first named it. |

### catalog_sync

The catalog release this console last applied (its teams, products and SecretStores), and how its last look went. One row. The console reads the release from the registry every few minutes and on **Sync now** (Admin page), verifies its signature where the install trusts one, and applies a new one.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | integer | no | Always 1. |
| `digest` | text | yes | The release applied: its artifact's digest. |
| `version` | text | yes | The version it is (`vX.Y.Z`), when the console follows versions; null for `latest`. |
| `commit` | text | yes | The catalog commit it describes. |
| `repository` | text | yes | The catalog repository, for people. |
| `applied_at` | timestamptz | yes | When it was applied. |
| `released_at` | timestamptz | yes | When it was released (its signed `createdAt`). An older release isn't applied: going back is releasing that commit again. |
| `problems` | jsonb | no | What applying it couldn't do, one item each (`item`, `message`); the rest was applied. |
| `applied` | jsonb | yes | What it held: `teams`, `products` (by image), `actions`, `templates`, `apis` and `secretStores`, counted. Null before a release was applied. |
| `checked_at` | timestamptz | yes | The last look. |
| `error` | text | yes | Why the last look failed (reading or verifying the release); nothing was applied then. |

### templates

What a consumer runs, filling in only parameters: each team's `dags/*.yaml` of kind `Template`, from the catalog's release (which removes them too). Running one builds a DAG from the products its steps name: each step runs its product's latest image, as the product's ServiceAccount, with its action's own secrets, in its team's namespace. Deleted with its team.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `team_id` | uuid | no | Its team (`teams.id`); unique with `name`. |
| `name` | text | no | Its file's name. |
| `display_name` | text | no | |
| `description` | text | no | |
| `parameters` | jsonb | no | A JSON Schema for an object: what the person running it fills in, checked before it runs. |
| `steps` | jsonb | no | Its steps: each one's `id`, `action` (`<team>/<product>.<action>`), and optionally `dependsOn`, `inputs` (values, `{"$param": ...}`, `{"$fromStep": ..., "$output": ...}`), `timeoutSeconds`, `maxAttempts`. |
| `share_with` | text[] | no | The other teams that may run it, or `*` for every team; empty, only its own. |
| `hidden` | boolean | no | Only its own team (and admins) see it; it then has no `share_with`. |
| `source_path` | text | yes | Its file in the catalog repository (`teams/<team>/dags/<name>.yaml`). |
| `deprecated` | text | yes | What to use instead; it still runs. |
| `examples` | jsonb | no | Ways to run it, from its file: each a `name` and its parameters as `inputs`. The run form offers them. |
| `updated_at` | timestamptz | no | |

### compose_drafts

Compose's drafts: a template being built, for a team, which its members (and admins) see and change from any device. Deleted with its team.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `team_id` | uuid | no | The team it's for; unique with `name`. |
| `name` | text | no | The template's name, as it would be filed. |
| `body` | jsonb | no | The Compose page's own state (at most 64 KiB), kept as it is. |
| `version` | bigint | no | Counts its saves: a save made on an older version is refused, not applied. |
| `updated_by` | uuid | yes | Who saved it last. |
| `updated_at` | timestamptz | no | |

### apis

API products (decision 20): a backend a team runs, published through the gateway, which forwards only what its OpenAPI document describes. Each team's `apis/<name>/api.yaml`, from the catalog's release (which removes them too); the gateway reads this table. Deleted with its team.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `team_id` | uuid | no | Its team (`teams.id`); unique with `name`. Callers reach it at `/<team>/<name>/` on the gateway. |
| `name` | text | no | Its folder's name. |
| `display_name` | text | no | |
| `description` | text | no | |
| `openapi` | jsonb | no | Its OpenAPI document (3.0 or 3.1, references inside it only): the allowlist the gateway enforces, and what callers are shown. |
| `backend_url` | text | no | Where the gateway forwards. Its host must be one of the gateway's `backendHosts`, or the API is held. |
| `backend_auth` | jsonb | yes | How the gateway signs in there: `{"serviceAccountToken": {audience}}`, `{"googleIdToken": {serviceAccount, audience}}` or `{"awsSigV4": {roleArn, region, service}}`, each minted per request from the API's ServiceAccount. Null: it doesn't. |
| `service_account` | text | no | The ServiceAccount, in the team's namespace, its backend credentials are minted for; the console creates it. |
| `share_with` | text[] | no | The other teams whose members and bots may call it, or `*` for every team; empty, only its own. Deprecated: `api_grants` replace it, and it goes in the next release. |
| `access_requests` | text | no | `api.yaml`'s `access.requests`: `open` (a request is granted at once, at the default limit), `approval` (the default: its team's maintainers decide) or `closed` (none are taken; grants already made stay). |
| `hidden` | boolean | no | Only its own team (and admins) see it; it then has no `share_with`. |
| `deprecated` | text | yes | What to use instead; it still answers. |
| `internet` | boolean | no | Asked to be reachable from the internet; published there only if the gateway's `internetTeams` includes its team. |
| `per_minute` | jsonb | no | Requests a minute per calling team: `default`, and teams by name. |
| `timeout_seconds` | integer | no | How long the backend has to start answering. |
| `max_request_bytes` | integer | no | The largest request body forwarded. |
| `source_path` | text | yes | Its `api.yaml` in the catalog repository. |
| `paused_message` | text | yes | Set while a maintainer has it paused: every caller gets 503 with this, and nothing is forwarded. |
| `paused_by` | uuid | yes | Who paused it (`users.id`; null if since deleted). |
| `updated_at` | timestamptz | no | |

### api_traffic

What the gateway did with each API's requests, a minute at a time; it adds to this every 30 seconds, and nothing else writes it. No caller's identity, body or header is kept. Kept a week. Deleted with its API.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `api_id` | uuid | no | The API (`apis.id`). With `minute`, `team`, `endpoint` and `outcome`, the key. |
| `minute` | timestamptz | no | The minute, in UTC. |
| `team` | text | no | The calling team; empty for a caller who wasn't signed in. |
| `endpoint` | text | no | The operation it matched (`GET /orders/{orderId}`), or for one it didn't from a caller who signed in, `METHOD /path` as sent, without the query (up to 160 characters); empty for one that matched none before sign-in. |
| `outcome` | text | no | `forwarded_2xx` to `forwarded_5xx` (the backend's answer), or what the gateway answered itself: `blocked` (not in the spec), `invalid`, `limited`, `unauthenticated`, `forbidden`, `paused`, `held`, `closed`, `unavailable`, `backend_error`. |
| `count` | integer | no | How many. |
| `duration_ms` | bigint | no | Their total time, for averages. |

### api_problems

Why the gateway can't serve an API: its OpenAPI document can't be read or used, or its backend URL can't be parsed. The gateway writes it when it builds the API (at start, and whenever the API's row changes) and deletes it once the API builds; nothing else writes it. While there's a row, every call to the API gets 503 and the console shows it as Can't serve. Deleted with its API.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `api_id` | uuid | no | The API (`apis.id`). The key. |
| `problem` | text | no | What the gateway found, such as `its OpenAPI document can't be used: …`. |
| `found_at` | timestamptz | no | When the gateway found it. |

### api_grants

Who may call an API besides its own team (decision 26): a single sign-on group (each person in it) or one user (a person or a bot). Made and changed by the API's team's maintainers, directly or by approving a request; revoked by them, an admin, the person it names (their own), or a maintainer of the bot's team (their bot's). Revoked grants stay, for the history. The gateway reads the active ones every few seconds, so a revoked one stops calls within its refresh (well under a minute). Grants are this install's own: the catalog doesn't carry them. Kept while their API is out of the catalog's release (its row gone, `api_id` null; such a grant lets nobody call anything), and linked again when an API of the same team and name is back. Deleted with its team.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `api_id` | uuid | yes | The API (`apis.id`); null while it's out of the release. Among active grants, unique with the principal. |
| `team_id` | uuid | no | The API's team (`teams.id`). |
| `api_name` | text | no | The API's name: with `team_id`, how the grant finds its API again when it's back in a release. |
| `group_name` | text | yes | A group, trimmed and lowercased as group mappings take them (a groups claim value, spaces and all, or a Google group's email), up to 256 characters. Exactly one of this and `user_id`. Among active grants, unique with `api_id`. |
| `user_id` | uuid | yes | A person or a bot (`users.id`). Among active grants, unique with `api_id`. Deleted with the user. |
| `per_minute` | integer | yes | Requests a minute: a user's, or each member's of a group. Null: the API's default limit (`per_minute`'s `default`, else the gateway's). |
| `granted_by` | uuid | yes | The maintainer who made it, or approved the request (`users.id`); null for an `open` API's request, granted at once, or if since deleted. |
| `from_request` | uuid | yes | The request it answered (`api_access_requests.id`), approved or, for an API whose requests are `open`, granted at once (then `granted_by` is null); null for one a maintainer added directly. |
| `created_at` | timestamptz | no | |
| `updated_at` | timestamptz | no | When its rate last changed. |
| `revoked_at` | timestamptz | yes | When it was revoked; null while it's active. |
| `revoked_by` | uuid | yes | Who revoked it. |

### api_access_requests

A request for access to an API: a person's for themselves, or a maintainer's for one of their team's bots, with a reason. At most one waits per API and user; after a decline, the next may be asked at once. Kept, as grants are, while its API is out of the release. Deleted with its team or its user.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `api_id` | uuid | yes | The API (`apis.id`); null while it's out of the release. |
| `team_id` | uuid | no | The API's team (`teams.id`). |
| `api_name` | text | no | The API's name, as `api_grants.api_name`. |
| `user_id` | uuid | no | Whom it's for: the person, or the bot. With `api_id`, unique while `waiting`. |
| `requested_by` | uuid | yes | Who asked: the person themselves, or the bot's team's maintainer. |
| `reason` | text | no | Why, as they said it. |
| `requester_groups` | text[] | no | A person's groups when they asked (`users.sso_groups`), one of which the API's maintainers may grant instead; shown to them only while it waits. Empty for a bot. |
| `state` | text | no | `waiting`, `granted`, `declined` or `withdrawn`. |
| `decided_by` | uuid | yes | The maintainer who granted or declined it, or who withdrew it. |
| `decision_reason` | text | yes | A decline's reason. |
| `grant_id` | uuid | yes | The grant it made (`api_grants.id`), when granted. |
| `created_at` | timestamptz | no | |
| `decided_at` | timestamptz | yes | When it was granted, declined or withdrawn. |

### user_groups

Each person's single sign-on groups that matter, for group grants: of the groups the console last read (a groups claim's, or the Google Workspace groups it asks about), only those mapped to a team or named by an active grant, every one of them. Replaced at each sign-in and by the hourly Google resync; a group newly granted is added for everyone whose last-read groups (`users.sso_groups`) include it, and for a person Google confirms while a maintainer grants their request. The gateway reads it. Groups count only while single sign-on is on and a group source is set: with a claim, for a single sign-on session signed in within the hour; with Google's alone, rows read within 90 minutes. Emptied whenever the sources change. Deleted with the user.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `user_id` | uuid | no | The person (`users.id`). With `group_name`, the key. |
| `group_name` | text | no | Lowercased. |
| `read_at` | timestamptz | no | When it was read. |

### gateway_state

The gateway as a whole: one row (`id` 1), which the gateway reads every few seconds.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | integer | no | Always 1. |
| `closed_message` | text | yes | Set while an admin has the gateway closed: every API answers 503 with this, and nothing is forwarded. |
| `closed_by` | uuid | yes | Who closed it (`users.id`; null if since deleted). |
| `closed_at` | timestamptz | yes | When. |

### submitted_executions

The console's record of every execution submitted through it, and who may see it. The kernel has no idea who submitted what.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `execution_id` | uuid | no | The kernel's execution id. |
| `teams` | text[] | no | Every team named by a task in the DAG. Members of any of them can see the execution. |
| `submitted_by` | uuid | yes | The user or bot. Emptied if that account is deleted; the record stays. |
| `not_deciders` | uuid[] | yes | Who may not approve its steps, worked out when it was submitted: its submitter and, for a bot, whoever made it a token, keyless identity or schedule (and so on through bots). Empty for a run from before, whose are worked out when asked. |
| `external_reference` | text | no | The DAG's `name`. |
| `payload` | jsonb | yes | The DAG as sent to the kernel, so **Rerun** can resubmit it. Empty for rows from before this column existed. |
| `template` | text | yes | Run from a template (`TemplateService`): `<team>/<template>`, or `<team>/<product>.<action>` for an action run alone, or `cleanup` for a run deleting resources (`ResourceService`), or `preview` for a run of plan actions (Preview), or `check` for a product's readiness check (run by the console: no `submitted_by`). Whoever ran it can see, cancel, retry and rerun it (not a cleanup's: it's asked for again from the resources); a rerun runs the template again. Empty for a DAG submitted as such. |
| `template_parameters` | jsonb | yes | The parameters it ran with. |
| `on_behalf_of` | text | yes | Which of the submitter's teams it ran for, when the template is shared with specific teams (or the submitter named one). |
| `created_at` | timestamptz | no | |
| `schedule_id` | uuid | yes | The schedule that started it, if one did. |
| `resources_recorded_at` | timestamptz | yes | When what it made, and deleted, was recorded in `resources`, once it finished. Emptied when it's retried, to be recorded again. |

Indexed on `(created_at, execution_id)` (the execution list's order and cursor), on `teams`, on `(submitted_by, created_at)` (an ordering bot's rate), and on `(created_at, execution_id)` for the rows whose `resources_recorded_at` is empty: the resource recorder's order and cursor, which goes on each pass from where the last stopped, so runs that haven't finished can't keep newer ones from being recorded.

### resources

What runs made: each resource a step reported in its outputs (`resources: [{type, id, name, link}]`), copied when its run finished with that step's resolved inputs and outputs, so it can be deleted after the run itself is gone. References only: whether it still exists is for its product's cloud to say. A later step reporting the same one updates it.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `product` | text | no | The registered product whose step reported it (`<team>-<product>-<action>`). Its current `cleanup` deletes it. |
| `product_team` | text | no | That product's team. With `type` and `external_id`, unique. |
| `type` | text | no | What it is, as the product says: such as `gcp/project`. |
| `external_id` | text | no | Its id there. |
| `name` | text | yes | A name for people. |
| `link` | text | yes | An http(s) link to it. |
| `owner_team` | text | yes | The team the run was for: a template's or action's run's `on_behalf_of` (null when it was for the person alone), a DAG's step's team. Its members may delete it. |
| `owner_user_id` | uuid | yes | Who ran it; they may delete it too. Emptied if the account is deleted. |
| `execution_id` | uuid | no | The run whose step last reported it. |
| `task_id` | text | no | That step. |
| `inputs` | jsonb | no | What that step was given, resolved. |
| `outputs` | jsonb | no | What it gave. |
| `position` | integer | no | The step's place in its run, for deleting a run's resources in reverse. |
| `first_reported_at` | timestamptz | no | |
| `reported_at` | timestamptz | no | |
| `deleting_execution_id` | uuid | yes | The last delete asked for: the cleanup run. Deleting while that run is unfinished; failed once it finished without deleting it. |
| `deleting_task_id` | text | yes | Its step for this resource. |
| `delete_requested_by` | uuid | yes | Who asked. |
| `deleted_at` | timestamptz | yes | When its cleanup step succeeded. |
| `provides` | jsonb | no | What its step provided, by wiring type: `[{type, value, output}]`, each output its product types `x-vennir-provides` with a scalar value. A later run given that value is linked to it (`resource_links`), and an order can offer it. |

### resource_links

What each resource depends on (decision 25), recorded when its run finishes: a resource its step took an input from, in the same run (the input wired from that step) or an earlier one (the input's value is what a live resource provides, of the input's wiring type). Replaced each time the resource is reported again. Deleting something others depend on waits for an admin (`resource_delete_requests`).

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `resource_id` | uuid | no | The resource that depends. With the next two, the key. Goes with it. |
| `depends_on_id` | uuid | no | What it depends on; never itself. Goes with it. |
| `input` | text | no | The input of the dependent's step it came in through. |
| `wiring_type` | text | yes | That input's wiring type (`x-vennir-needs`); null for an untyped input wired from a step. |

### resource_delete_requests

A delete refused because other resources still depended on what it would delete: the admins are alerted, and it runs only once one approves it (`ResourceService/DecideDeleteRequest`), as that admin's.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `resource_ids` | uuid[] | no | What it would delete. One waiting request per asker and set. |
| `owner_team` | text | yes | The team they were made for. |
| `requested_by` | uuid | yes | Who asked. Emptied if the account is deleted. |
| `dependent_ids` | uuid[] | no | The live resources depending on them when it was asked. |
| `created_at` | timestamptz | no | |
| `decision` | text | yes | `approved` or `denied`; `deleted` when all it would delete was deleted another way first (with what depended on it); null while it waits. |
| `decided_by` | uuid | yes | The admin who decided. |
| `decided_at` | timestamptz | yes | |
| `execution_id` | uuid | yes | The cleanup run an approval started. |

### chat_feedback

Ratings of the chat agent's answers (decision 24): thumbs up or down, each with what was asked and answered, sent by the person who rated it. The agent keeps nothing else of a conversation. Admins read them (Admin, Chat agent); kept 90 days.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `user_id` | uuid | yes | Who rated it. Emptied if the account is deleted. |
| `team` | text | yes | The team they were working for. |
| `rating` | text | no | `up` or `down`. |
| `question` | text | no | What they asked. |
| `answer` | text | no | What the agent answered. |
| `citations` | jsonb | no | The sections it cited: `[{id, title, heading, kind, link}]`. |
| `steps` | jsonb | no | The tools it used, in order. |
| `model` | text | no | The model that answered. |
| `comment` | text | yes | What they said was wrong, or right. |
| `created_at` | timestamptz | no | |

### chat_settings

The chat agent's model as an admin set it on the Admin page (Chat agent), in place of the install's (the chart's `chat` values). No row: the install's. At most one row. While it can't be used (a key that no longer unseals, a setting refused), chat is off and the Admin page says why.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | integer | no | Always 1. |
| `enabled` | boolean | no | Off: no chat agent, whatever the install says. |
| `provider` | text | no | `vertex`, `bedrock`, `anthropic` or `openai-compatible`. |
| `model` | text | no | Its name there; empty on Vertex for Gemini 3.5 Flash, on Bedrock for Claude Sonnet 5. |
| `endpoint` | text | no | An openai-compatible server's base URL (`.../v1`), or Anthropic's when not its own. |
| `vertex_project` | text | no | The project whose Vertex AI answers. |
| `vertex_location` | text | no | `global`, or a region. |
| `bedrock_region` | text | no | The AWS region whose Bedrock answers. |
| `api_key_encrypted` | text | yes | The key, sealed with the console's secret, never sent back. None on Vertex or Bedrock; none for the install's own provider means the install's. |
| `effort` | text | no | `low`, `medium` or `high`; empty for the model's own. |
| `max_steps` | integer | yes | Model and tool calls in one answer; empty for 8. |
| `context_tokens` | integer | yes | The most one model call is sent; empty for the default. |
| `max_tokens` | integer | yes | The most one reply may be; empty for the default. |
| `updated_by` | uuid | yes | The admin who set them. |
| `updated_at` | timestamptz | no | |

### chat_limits

How many questions each person may ask the chat agent, as an admin set them (`core/chatLimits.ts`). No row: 30 an hour and 200 a day. At most one row. Questions are counted in `rate_limit_windows`, keyed `chat-hour:<user id>` and `chat-day:<user id>`.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | integer | no | Always 1. |
| `per_hour` | integer | no | Questions each person may ask in an hour. |
| `per_day` | integer | no | And in a day. |
| `updated_by` | uuid | yes | The admin who set them. |
| `updated_at` | timestamptz | no | |

### bot_identities

Who a bot is when it signs in without a stored token (`auth/keyless.ts`): a CI's OIDC issuer and the exact claims its ID token must carry.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `bot_id` | uuid | no | The bot. |
| `issuer` | text | no | An issuer the install allows (`keyless.issuers`): GitHub Actions', GitLab's. With `claims`, unique. |
| `claims` | jsonb | no | Each claim the token must carry, with exactly this value: `repository` (or `project_path`, `sub`), and perhaps `ref` or `environment`. |
| `created_by` | uuid | yes | |
| `created_at` | timestamptz | no | |
| `last_used_at` | timestamptz | yes | When a token last signed in with it. |

### schedules

A team's schedules: a template or action run on a cron, with set parameters, for the team, as one of its bots (`scheduleRunner.ts`). The bot's rights are checked when it's made or changed, and on every run.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `team_id` | uuid | no | Whose. With `name`, unique. |
| `name` | text | no | |
| `kind` | text | no | `template` or `action`. |
| `runnable_team` | text | no | The template's or action's team. |
| `runnable_name` | text | no | The template's name, or the action's registered product name. |
| `parameters` | jsonb | no | What it runs with. |
| `cron` | text | no | Five fields: minute, hour, day of the month, month, day of the week. At most every five minutes. |
| `time_zone` | text | no | An IANA time zone the cron is read in. |
| `bot_id` | uuid | no | The team's bot it runs as; deleting the bot deletes the schedule. |
| `enabled` | boolean | no | False while paused. |
| `next_run_at` | timestamptz | yes | When it runs next; null while paused. A console starting it moves this on first, so only one does. |
| `last_run_at` | timestamptz | yes | |
| `last_execution_id` | uuid | yes | Its last run. |
| `last_error` | text | yes | Why its last start was refused, or why it won't run again (its cron or time zone no longer reads). |
| `claimed_run_at` | timestamptz | yes | A time a console claimed and hasn't started yet. Another console starts it once `claimed_at` is five minutes old (its request id keeps that to one run). Cleared when the schedule is paused or its timetable or time zone changes. |
| `claimed_at` | timestamptz | yes | When `claimed_run_at` was claimed. |
| `created_by` | uuid | yes | |
| `updated_by` | uuid | yes | Who last changed it. Its runs, as its bot, aren't theirs to approve. |
| `created_at` | timestamptz | no | |

### product_readiness

Whether each product is ready on this install: its check action's last answer (`readiness.ts`).

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `product` | text | no | The check action's registered name (`<team>-<product>-<check>`), for its whole product. |
| `product_team` | text | no | |
| `image` | text | no | The image checked: a new one is checked again. |
| `state` | text | no | `checking`, `ready`, `not_ready`, or `failed` (the check couldn't say). |
| `execution_id` | uuid | yes | The check run. |
| `principal` | text | yes | What it acts as here. |
| `missing` | text[] | no | What it lacks. |
| `detail` | text | yes | |
| `requested_at` | timestamptz | no | When the check was asked for. |
| `checked_at` | timestamptz | yes | When it answered. |

### notification_events

Something worth telling people: a run that failed or finished, a step waiting for an approval, the catalog not being pulled. Made once, then shown in people's inboxes and posted to teams' chat webhooks. Kept 90 days.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `key` | text | no | What makes it the same event (`run:<id>:<state>:<finished at>`, `approval:<run>:<step>:<since>`, `catalog:<last applied>`). Unique, so it's only ever made once. |
| `kind` | text | no | `run_failed`, `run_succeeded`, `approval_waiting`, `catalog_failing`, `product_not_ready`, `step_refused` (a step the cluster refused), `api_access` (a request for access to an API asked, granted, declined or withdrawn, or a grant added, changed or revoked: to whom it's for, who asked, and the API's team's maintainers) or `platform_alert` (a team purged, the allowed image sources changed, a policy not syncing, a run's image gone, the audit log's copy not copying for half an hour (or never yet), its chain broken or an entry differing from its copy). |
| `title` | text | no | |
| `body` | text | no | |
| `link` | text | yes | The console page it's about, such as `/runs/<id>`. |
| `created_at` | timestamptz | no | |

### user_notifications

A person's copy of an event: their inbox.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `event_id` | uuid | no | The event. |
| `user_id` | uuid | no | Whose. |
| `read_at` | timestamptz | yes | When they read it; empty while unread. |

### team_webhooks

A team's chat webhook (Slack, Google Chat, Teams), set by its maintainers.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `team_id` | uuid | no | |
| `url_encrypted` | text | no | The webhook URL, a credential: AES-256-GCM with a key derived from the console's `JWT_SECRET`. Never sent back by the API. |
| `host` | text | no | Its host, which is what people see. |
| `kinds` | text[] | no | What it gets: `run_failed`, `approval_waiting`, `product_not_ready`, `step_refused`. |
| `updated_by` | uuid | yes | Who set it last. |
| `updated_at` | timestamptz | no | |
| `last_sent_at` | timestamptz | yes | The last post that went. |
| `last_error` | text | yes | Why the last one didn't, if it didn't. |

### email_deliveries

An event to email to a person: tried up to five times.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `event_id` | uuid | no | |
| `user_id` | uuid | no | |
| `attempts` | integer | no | |
| `sent_at` | timestamptz | yes | When it went. |

### webhook_deliveries

An event to post to a team's webhook: tried up to five times.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `event_id` | uuid | no | |
| `team_id` | uuid | no | |
| `attempts` | integer | no | |
| `sent_at` | timestamptz | yes | When it went. |

### bot_callbacks

An ordering bot's callback (decision 23): where its orders' outcomes are posted, signed, set by its team's maintainers, only under the install's `orders.callbackHosts`.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `bot_id` | uuid | no | The ordering bot. |
| `url_encrypted` | text | no | The callback URL, sealed as `team_webhooks.url_encrypted` is. Never sent back by the API. |
| `host` | text | no | Its host, which is what people see. |
| `secret_encrypted` | text | no | The secret each post is signed with (HMAC-SHA256, the `Vennir-Signature` header), sealed the same way. Shown once, when it's made. |
| `updated_by` | uuid | yes | Who set it last. |
| `updated_at` | timestamptz | no | |
| `last_sent_at` | timestamptz | yes | The last post that went. |
| `last_error` | text | yes | Why the last one didn't, if it didn't. |

### team_callbacks

A team's outcome webhook (decision 23): where each of its runs' outcomes is posted as signed JSON, for its own systems, set by its maintainers, only under the install's `orders.callbackHosts`.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `team_id` | uuid | no | |
| `url_encrypted` | text | no | The URL, sealed as `team_webhooks.url_encrypted` is. Never sent back by the API. |
| `host` | text | no | Its host, which is what people see. |
| `secret_encrypted` | text | no | The secret each post is signed with (`Vennir-Signature`), sealed the same way. Shown once, when it's made. |
| `updated_by` | uuid | yes | Who set it last. |
| `updated_at` | timestamptz | no | |
| `last_sent_at` | timestamptz | yes | The last post that went. |
| `last_error` | text | yes | Why the last one didn't, if it didn't. |

### callback_deliveries

An outcome to post to an ordering bot's callback or a team's outcome webhook: tried up to five times, kept 90 days.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `key` | text | no | `<execution id>:<state>:<finished at>`, with `:team:<id>` for a team's, so each finish is posted once to each. |
| `bot_id` | uuid | yes | The ordering bot that placed it, for its callback. |
| `team_id` | uuid | yes | The team that owns the run, for its outcome webhook. Exactly one of the two is set. |
| `body` | text | no | The JSON posted (`order.finished` for a bot's: the run, the order's `requestId`, its template and how it ended; `run.finished` for a team's: the same with each step's state, outputs and failure code), made once so every attempt sends the same. |
| `attempts` | integer | no | |
| `sent_at` | timestamptz | yes | When it went. |
| `created_at` | timestamptz | no | |

### sso_settings

Single sign-on as admins set it up: one row (`id` 1). Its provider is used only when the install set none (the console chart's `sso`); its groups settings always. Every console reads it again every few seconds.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | integer | no | Always 1. |
| `enabled` | boolean | no | Whether people may sign in with this provider. |
| `issuer` | text | no | The OpenID Connect provider's issuer URL. |
| `client_id` | text | no | |
| `client_secret_encrypted` | text | yes | The client's secret, sealed (AES-256-GCM, a key derived from `JWT_SECRET`); never sent back. |
| `redirect_url` | text | no | `<console URL>/api/auth/oidc/callback`, as registered with the provider. |
| `allowed_domains` | text[] | no | Email domains whose accounts may sign in. |
| `label` | text | no | The sign-in button's name for the provider. |
| `groups_claim` | text | no | The ID token claim listing a person's groups; empty: none. |
| `google_groups` | boolean | no | Groups from Google Workspace too (Cloud Identity's Groups API, as the console's own Google identity). |
| `updated_by` | uuid | yes | |
| `updated_at` | timestamptz | no | |

### sso_group_mappings

A provider group that makes its members a team's: at each single sign-on, a mapped team's membership follows the person's groups (the best role among them, or none). Deleted with its team.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | |
| `group_name` | text | no | As the provider names it (a groups claim value, or a Google group's email), lowercased. With `team_id`, unique. |
| `team_id` | uuid | no | |
| `role` | text | no | `member` or `maintainer`. |
| `created_by` | uuid | yes | |
| `created_at` | timestamptz | no | |

The console's migrations are tracked in the `drizzle` schema, outside `public`.
