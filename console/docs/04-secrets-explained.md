# Secrets, explained from scratch

This walks through the whole secrets story in the order you'd actually
run into it — what a secret is here, how you register one, where it
*actually* lives once you have, how it's kept away from other teams,
whether it's genuinely secure, what happens if it's ever deleted, and
what ESO is and why it's a different thing from what came before it.
No prior Kubernetes knowledge assumed. If you already know this system
well, `docs/security-model.md` in the Vennir repository has the precise
version: what each layer enforces, and what it doesn't yet.

---

## What a "secret" is here

Any string value a task's container needs at runtime that shouldn't be
sitting in plain sight — an API key, a database password, a signing
key, a downloaded credential file's contents. This system doesn't care
what the value *is* or what it's for; it only cares about two things:
who's allowed to register one, and which task is allowed to read it
back.

## Step 1 — registering one

The simple, common path: open the console's Secrets tab (or call
`SecretService/PutSecret` directly), and paste in a name and a value. That's it —
no approval, no PR, no waiting. The only requirement is that you're a
maintainer of the team you're registering it for (or a platform admin).
A member who isn't a maintainer sees the team's secrets' names, but can't
add or change them. The value is hidden as you paste it (**Show** reveals
it; Firefox can't hide it, and the field says so), and the browser never
spell-checks, corrects or remembers it.

## Step 2 — where it actually goes (not hand-waved)

This is the part that's usually left vague, so here it is concretely.
The moment you register a secret, two real things happen:

1. **A real Kubernetes `Secret` object gets created**, in your team's
   own namespace. This is the *only* place the actual value ever lives.
   Not a database, not a cache, not anywhere in `console/`'s own storage.
2. **A row gets written to the console's own database** — but only the
   secret's *name* and the *names of its keys* (e.g. `value`, or
   `clientId`/`clientSecret`), never the value itself. This row exists
   purely so the console can show you "here's what's registered" without
   ever needing to read the real value back out.

So if someone asks "is my password sitting in some app database
somewhere" — no. It's a native Kubernetes object, the same kind of
object Kubernetes itself uses to hold credentials for its own internal
components. The console is a thin, one-way door that creates it; after
that, the console doesn't hold a copy.

## Step 3 — how a task actually reads it

When you submit a DAG, a task can list secret names it needs
(`secretRefs`). At the moment that task actually runs, Kubernetes mounts
that Secret as a file inside the task's own container — at
`/platform/secrets/<secret-name>/<key>`. The task's code just opens that
file and reads it, like any other file on disk. Nothing exotic: no SDK
call, no network round-trip to fetch it, just a file that's already
sitting there when the container starts, and gone the moment the
container's done.

## How isolation actually works — the concrete mechanism

A secret belongs to a team. Three rules decide which step can read it, and
the cluster enforces all three, not just this project's code:

1. **A team's secrets stay in its namespace.** A Pod can only mount
   Secrets from its own namespace, and a step runs in its team's namespace
   (the kernel chart's `dispatch-policy.yaml` refuses any other). So Team
   A's steps can't mount Team B's secrets: Kubernetes itself can't express
   it.
2. **Only the team's reviewed products may mount one.** An image that
   isn't a product registered for the team (through the catalog's review)
   runs as `default` with no secrets at all. So a secret can't be handed to
   arbitrary code, even by the team that owns it.
3. **Only secrets the team registered can be mounted, and each step gets
   only the ones it lists** (`secretRefs`). A Secret nobody registered in
   the console, such as the credentials a SecretStore signs in with, can't
   be mounted by any step.

The console checks all three when a DAG is submitted, and the cluster
checks them again when the step's Job is created (the kernel chart's
`identity-policy.yaml`, which the console keeps current with every team's
products and secret names). So they hold even for a Job the console never
saw. This is proven on a real cluster, not just asserted: the same image
under an unregistered name, or a product naming an unregistered Secret, is
refused with `IDENTITY_NOT_ALLOWED`.

Within a team, secrets are deliberately shared: the team decides which of
its products' steps gets which secret. What stays per product is its
*identity*: a product may declare its own ServiceAccount, which a cloud
identity can be bound to (GKE Workload Identity, say), and no other image
can run as it.

One boundary worth being precise about: isolation is per-*step*, not
per-line-of-code. Once a Secret is mounted into a container, anything
running inside that same container can read that file — the isolation is
"which Pod gets this mounted at all," not "which function inside the Pod."
That's the same granularity Kubernetes secrets always have; nothing about
this project narrows it further.

## Is it actually secure?

Being direct about what's true and what isn't, rather than a blanket
"yes":

- **Never in transit through this project's own layers as anything but
  necessary.** The console writes it once, directly into Kubernetes, and
  never stores or logs the value again.
- **Encrypted at rest is a cluster-level setting, not something this
  project's code controls.** Kubernetes Secrets are stored in the
  cluster's own backing datastore (`etcd`); whether that store encrypts
  its data at rest depends on how the cluster itself is configured
  (GKE offers this as an optional feature). This project doesn't
  override or assume that setting either way — if the exact answer for
  this specific demo cluster matters, it's a `gcloud container clusters
  describe` question, not a code question.
- **Anyone with cluster-admin-level `kubectl` access can read any
  Secret, period.** The rules above are what stop one *team's step* from
  reading another team's secret — they were never meant to, and don't,
  stop someone holding real cluster-admin credentials from reading
  anything. That's a much smaller, much more privileged group than
  "anyone using the console," and its own access is governed separately
  (who has `kubectl` access to the real cluster at all).
- **A product's own code is trusted not to leak it back out.** The one
  rule every product author is held to: never echo a secret's raw value
  into a task's `outputs` or logs, which anyone who can see the run can
  read. The platform catches the common mistakes: a step whose outputs
  contain something shaped like a credential (a private key, a cloud
  access key, a GitHub token, a JWT) fails with
  `OUTPUT_CONTAINS_CREDENTIAL` and its outputs aren't stored, and the same
  shapes are blanked out of its logs. But it can only recognize shapes,
  never your actual value, so a plain password a product prints or returns
  *is* stored. Worth knowing, not something to overstate as airtight.

## If a secret gets wiped, can it come back?

Depends entirely on which of the two registration paths it came from —
and this is the sharpest, most concrete difference between them.

**Direct-paste**: no. If the Kubernetes Secret is deleted, that's the
only copy that ever existed inside this system. The console's own
database never held the value, so there's nothing to restore it from.
Recovery means going back to wherever the value originally came from —
your password manager, the vendor's own dashboard — and pasting it in
again. You are, in effect, the backup.

**Synced from an external vault (ESO)**: yes, usually automatically,
with no action needed. Covered next.

## What ESO is, and why it's a genuinely different thing

ESO is **External Secrets Operator** — a piece of software running on
the cluster whose only job is keeping a Kubernetes Secret in sync with a
value that actually lives somewhere else (1Password, GCP Secret
Manager, HashiCorp Vault). The Kubernetes Secret it produces is a real,
ordinary Kubernetes Secret, mounted into tasks exactly the same way a
direct-paste one is — a task's own code can't tell the difference.

The difference is entirely about **where the value's source of truth
lives**:

|  | Direct-paste | ESO-synced |
|---|---|---|
| Source of truth | Whatever you pasted in, once | The external vault, continuously |
| If the Kubernetes Secret is deleted | Gone for good — re-paste it yourself | ESO notices and recreates it from the vault automatically, no PR, no action |
| If the value needs to rotate | Someone re-pastes the new value through the console | Update it once in the vault — ESO picks up the change on its own refresh cycle |
| What this repo's Git history ever sees | Nothing — never touches the catalog repo at all | A scope reference only (*which* vault, *which* identity may read it) — never the value |

A secret stays the kind it was registered as: to turn a pasted one into a
synced one (or back), revoke it first, then add it again the other way.

Setting up the ESO path needs one extra, one-time step a direct-paste
secret doesn't: a `SecretStore` — a privileged object naming which
external vault a team's namespace may read from, and with what
identity. Because that's a real scope grant (not just a value), it goes
through a reviewed PR in `vennir-catalog`, the same review
discipline a new product gets. Once that's approved and merged,
registering the *individual* secrets that come from it is self-service
again, same as direct-paste — no further PR per secret.

**Put plainly**: direct-paste is simpler to start with and needs zero
setup, but you're the one responsible for remembering and re-entering
the value if anything ever goes wrong. ESO needs one upfront, reviewed
step, but after that, the vault becomes the durable, self-healing source
of truth — rotations and even accidental deletions fix themselves.

---

## And values a build needs?

Everything above is for values a step uses while it **runs**. A value a team's image needs while it's **built** (a private package registry's token, say) never reaches the console or a step: it lives in the team's own GitHub Environment in the catalog repository, `team-<team>`, which only `main` may use, and catalog CI hands it to that team's `docker build` without putting it in the image. The catalog guide's [Values your builds need](catalog-guide.md#publishing) says which values go where, and how a catalog admin sets it up.

## Where to go deeper

- `docs/security-model.md` in the Vennir repository — the same model,
  precisely: who can read a secret, what the cluster enforces, and vault
  sync with each supported vault.
- `01-getting-started.md` and `02-sync-secrets-gcp.md` — registering a
  secret either way, step by step.
- `docs/operations.md` in the Vennir repository, "Troubleshooting" —
  a secret a task doesn't get, with the `kubectl` checks.
