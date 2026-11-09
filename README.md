# Vennir

**Run DAGs of container steps on Kubernetes, where each step comes from a
reviewed catalog and every team's secrets stay sealed off from the rest.**

A workflow is a directed *acyclic* graph (a DAG): it never loops back. Steps
run in order, each one building on what the steps before it produced, and
every run moves forward to an end.

> **Status: 0.x, not production-ready yet.** The engine, console, API
> gateway and isolation model work, and are tested on kind, GKE and EKS:
> single sign-on, TLS inside the cluster and in front of the console, and
> network isolation between team namespaces are all in. Still to come before
> 1.0: Azure, a proof run of the newest features on each cloud, and the gaps
> listed under "Not yet enforced" in
> [`docs/security-model.md`](docs/security-model.md#not-yet-enforced). See
> [`TODO.md`](TODO.md) for the plan.

## What it does

- **Runs a DAG of containers.** Each step is a container image. A step runs
  once the steps it depends on have finished, as a Kubernetes Job.
- **Passes outputs along.** A step's input can be another step's output:
  `{"$fromTask": "create-project", "$output": "projectId"}` is replaced with
  the real value just before the step starts.
- **Keeps teams apart.** Every team gets its own namespace and its own
  secrets. Only the team's reviewed products can mount them, a step only the
  ones it lists, so one team's credentials never reach another, or any image
  that wasn't reviewed.
- **Runs only reviewed code.** Steps come from a catalog of images that went
  through review and scanning. An admission policy in the cluster refuses
  images from anywhere else, even if the console is bypassed, and with
  Sigstore's policy-controller installed, unsigned images are refused too.
- **Shows what happened.** A web console for teams, secrets, bots and runs:
  every step's state, outputs, logs and the reason for any failure.

A step can be anything packaged as a container, from a hello-world script to
creating cloud infrastructure. Vennir doesn't need to understand what a step
does.

## A first example

Two steps, where the second uses the first step's output. Both images are the
fake products in [`examples/`](examples/), so this runs on a laptop with no
cloud account:

```json
{
  "name": "my-first-run",
  "tasks": [
    {
      "id": "create-project",
      "image": "localhost:5001/demo-project-product:local",
      "action": "create",
      "team": "team-a",
      "serviceAccount": "default",
      "inputs": { "projectName": "hello" }
    },
    {
      "id": "deploy-app",
      "image": "localhost:5001/demo-application-product:local",
      "action": "create",
      "team": "team-a",
      "serviceAccount": "default",
      "dependsOn": ["create-project"],
      "inputs": {
        "projectId": { "$fromTask": "create-project", "$output": "projectId" }
      }
    }
  ]
}
```

`create-project` outputs `{"projectId": "hello-123"}`, and `deploy-app` runs
next with `projectId` set to `"hello-123"`.

### What a step is

Any container that follows a small contract:

1. Read the request from `/platform/input/request.json`. Its `inputs` hold the
   step's inputs, with upstream outputs already filled in.
2. Do the work. The action (`create` above) arrives as the container's
   argument.
3. Write `/platform/output/result.json`:
   `{"status": "succeeded", "outputs": {...}}`, or
   `{"status": "failed", "error": {"code": "...", "message": "...", "retryable": false}}`.

Any language works. [`examples/project-product/entrypoint.py`](examples/project-product/entrypoint.py)
is a complete example in about 60 lines.

## Try it locally

You need Docker running, plus [`kind`](https://kind.sigs.k8s.io/), `kubectl`
and `helm` 4 or later (on macOS: `brew install kind kubectl helm`; for Linux
and Windows, see [Getting your computer ready](docs/clouds/computer.md)). Any
cluster you install on needs Kubernetes 1.30 or later (the charts refuse
older ones, and older Helm) and a network plugin that enforces
NetworkPolicy (Calico, Cilium, GKE Dataplane V2; kind's default does),
without which the platform's databases and kernel-api aren't fenced off
from steps. Then, from the repo
root:

```
make quickstart
```

It creates a local kind cluster and image registry, builds and installs
Vennir, sets up the team `team-a`, and leaves the console at
**http://localhost:18080**. It takes a few minutes the first time, and is safe
to run again (it rebuilds from your checkout).

Sign in as `admin@example.com` with the password `vennir-local`. That
password is set only for this local cluster; never use it anywhere else.
Then open **Runs → Submit a DAG**, paste the JSON above, and watch both
steps finish.

`make logs` follows every component's logs, `make down` stops the cluster
while keeping its data, and `make up` starts it again.

To run your own steps, publish a catalog folder to it, with no Git hosting or
CI needed: `make catalog-publish` publishes `catalog-template/` with its
`local` sample team (one product in five languages), and
`make catalog-publish CATALOG=<catalog folder>` publishes your own. Each product is
validated, built, tested and security-scanned the same way catalog CI does it,
then pushed to the local registry with a release the console applies.

## How it fits together

```
console/   the authenticated front door: sign-in, teams, bots, secrets,
           the catalog, and ordering and following runs. TypeScript
           (Fastify, React). The only way in for people and pipelines.
kernel/    the DAG engine: kernel-api accepts runs, kernel-scheduler claims
           ready steps, starts each as a Kubernetes Job, collects its result
           and releases the steps that depend on it; with a signed
           catalog, kernel policy verifies the catalog's release itself and
           writes which images run as each product. Go (Connect,
           client-go). Deliberately blind to what any step does.
gateway/   the API gateway: forwards calls to teams' API products, exactly
           as each one's OpenAPI document describes, for its own team and
           whoever its access list grants (people, bots, single sign-on
           groups). Go.
cli/       vennir, the installer: a cloud (Google Cloud or AWS) or an
           existing cluster, from one config file. Go, with OpenTofu.
helm/      the two Helm charts (execution-kernel, execution-console) and the
           admission policies that guard the cluster, plus per-environment
           settings.
catalog-template/  what a new catalog repository of products starts as.
docs/      design and reference docs, and the generated architecture diagrams.
examples/  fake products for local demos and tests.
```

`kernel/`, `console/`, `gateway/` and `cli/` are independent projects with their own
dependencies and tests; they share a repository so they deploy
together. Steps themselves live in a separate **catalog** repository, where
adding a product is a reviewed pull request; `catalog-template/` is what a
new one starts as.

## How secrets stay sealed

Each team has its own namespace and registers its own secrets. Any of the
team's registered products may mount them, each step only the ones it lists in
`secretRefs`; an image that isn't a registered product runs with none, and a
Secret the team never registered can't be mounted at all. A product may also
declare its own ServiceAccount, to bind a cloud identity to (GKE Workload
Identity, say), and its steps run as it. Secrets either get pasted into the
console or sync from a
team's own store through External Secrets Operator. GCP Secret Manager is
proven end to end; the console also recognises AWS Secrets Manager, Azure Key
Vault, HashiCorp Vault and 1Password stores. Either way a step reads them as
files at `/platform/secrets/<name>/`.

The full model, including what's enforced, by which layer, and what's out of
scope, is in [`docs/security-model.md`](docs/security-model.md).

## Learn more

- [Onboarding](console/docs/17-onboarding.md): the whole path in order, from
  getting `vennir` to a first resource deployed to Google Cloud or AWS
- [`docs/setup.md`](docs/setup.md): installing it for real with `vennir`, on
  Google Cloud, AWS or a cluster you have, start to finish
- [`docs/architecture.md`](docs/architecture.md): how it works and why
- [`docs/operations.md`](docs/operations.md): installing, upgrading, backups,
  troubleshooting
- [`docs/security-model.md`](docs/security-model.md): what's enforced, and
  where
- [`kernel/ARCHITECTURE.md`](kernel/ARCHITECTURE.md): the engine, call by call
- [`catalog-template/`](catalog-template/README.md): what a catalog of products
  starts as

## Contributing, security and license

- Contributions are welcome: see [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Found a vulnerability? Please report it privately: see
  [`SECURITY.md`](SECURITY.md).
- Vennir is released under the [MIT License](LICENSE).
