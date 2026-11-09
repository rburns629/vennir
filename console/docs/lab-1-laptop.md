# Lab 1: Vennir on your laptop

**Goal:** install Vennir on kind, run a DAG, publish the sample products, run a template and a cart, and delete what a run made. **Time:** about 45 minutes. **Cost:** nothing. **You need:** [your computer ready](clouds-computer.md) (Docker running with about 4 GB free, kind, kubectl, helm 4, curl, jq) and a clone of the repository.

Labs build on each other: this one is the base for [Lab 2](lab-2-first-product.md).

## 1. Install

```bash
git clone https://github.com/roburns/vennir && cd vennir
make quickstart          # safe to run again; about ten minutes the first time
```

It makes the kind cluster `vennir-local`, a local registry at `localhost:5001`, installs the kernel and the console into `vennir-system`, creates the team `team-a`, and port-forwards the console.

**Check:** open <http://localhost:18080> and sign in as `admin@example.com` with the password `vennir-local` (set only in the kind values, for a cluster nobody else can reach: never use it anywhere else). `kubectl get pods -n vennir-system` shows every Pod `Running`.

## 2. Run a DAG with no catalog

**Runs → Submit a DAG**, paste this, and submit:

```json
{
  "name": "my-first-run",
  "tasks": [
    {"id": "create-project", "image": "localhost:5001/demo-project-product:local", "action": "create",
     "team": "team-a", "serviceAccount": "default", "inputs": {"projectName": "hello"}},
    {"id": "deploy-app", "image": "localhost:5001/demo-application-product:local", "action": "create",
     "team": "team-a", "serviceAccount": "default", "dependsOn": ["create-project"],
     "inputs": {"projectId": {"$fromTask": "create-project", "$output": "projectId"}}}
  ]
}
```

**Check:** the run's page shows `create-project` succeed with `projectId: hello-123`, then `deploy-app` start with that value filled in. That's the one idea everything builds on: a step's output becomes the next step's input when it starts.

## 3. Publish the sample products

```bash
make catalog-publish     # the local sample team: one product in five languages, and ticket
```

Each product is validated, built, tested with no network and scanned, as catalog CI would, then pushed to the local registry; the release is pushed and the console applies it.

**Check:** **Catalog** lists the `local` team's products (`title-case`, `reverse`, `slug`, `upper-case`, `rot13`, `ticket`) and its template `shout-backwards`.

## 4. Run a template

Runs are made for a team you belong to. **Teams → local → Members → Add**, and add yourself as a maintainer.

**Catalog → shout-backwards → Run**, for `local`, with the text `never odd or even`.

**Check:** two steps, `shout` then `backwards`, each in its own product's container; the run's output is the text upper-cased and reversed. **Show as an API call** on the form gives the same run as a `TemplateService/RunTemplate` call, for a script or a bot.

## 5. Order with the cart

1. In **Catalog**, **Add to cart** on `ticket.watch` only.
2. Open **Cart** and choose `local`. Nothing in the cart provides a ticket, so the console offers to add `ticket.open` before it (its type's default provider). Accept it.
3. Fill in what's asked (the ticket's title, and a watcher), and **Place order**.

**Check:** one run, two steps: `open` makes a ticket and `watch` watches it, wired from `open`'s output. A cart never does more than you could step by step: each step is checked as if you'd run it alone.

## 6. See what the run made, and delete it

**Runs → What runs made** lists the ticket and the watch, with what depends on what. **Delete** the ticket.

**Check:** while the watch still uses the ticket, the ticket's delete waits for an admin (**Ask an admin**). Delete the watch first (it runs `unwatch`); once it's **Deleted**, the ticket's delete runs `close`.

## 7. Look around

- **Observe → Logs**: each step's lines, as a member of `local` sees them. Credentials are redacted before anything is kept.
- **Observe → Security checks**: what this install enforces, read from its settings.
- **Admin**: the catalog release applied, and the image sources allowed.

## Clean up

```bash
make down                # stops the node, keeping everything; make up starts it again
```

`kind delete cluster --name vennir-local` deletes it all.

## What you proved

A real install with the same admission policies a cloud install has: steps passing values, products published through the same checks as catalog CI, templates, the cart's wiring, and cleanup that respects what depends on what.

**Next:** [Lab 2: your first product](lab-2-first-product.md).
