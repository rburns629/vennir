# Lab 2: your first product

**Goal:** make a catalog of your own, write a product from the `hello` starter, test it the way catalog CI does, publish it to your kind install, run it, give it a secret, and explain its errors. **Time:** about 45 minutes. **Cost:** nothing. **You need:** [Lab 1](lab-1-laptop.md)'s install running (`make up`).

## 1. A catalog of your own

A catalog is a Git repository started from `catalog-template/`. On kind there's no Git hosting or CI to set up: you publish from your machine.

```bash
cp -R catalog-template ~/my-catalog && cd ~/my-catalog && git init -q
mkdir -p teams/lab && cp templates/team/team.yaml teams/lab/team.yaml
cp -R templates/hello teams/lab/products/hello
echo "/teams/lab/ @me" >> .github/CODEOWNERS
```

In `teams/lab/team.yaml`, set `name: lab`, a `displayName`, `owner` and `contact`. In `teams/lab/products/hello/product.yaml`, set `team: lab` and `owner`. Every line marked `CHANGE` is one to change.

**Check:** `./vennir catalog validate` prints nothing and exits 0. (`./vennir` downloads the release the template pins, checked against its checksum.)

## 2. Read the contract

Open `teams/lab/products/hello/`:

- `product.yaml`: the action `greet`, its input (`name`, required; `useSecret`) and output (`message`, `secretFound`) as JSON Schema, and the secret it may mount (`hello-secret`).
- `actions/greet.py`: reads `/platform/input/request.json`, writes `/platform/output/result.json` as `{"status": "succeeded", "outputs": …}` or `{"status": "failed", "error": {"code", "message", "retryable"}}`. Anything it prints is the step's log, so it never prints a secret.
- `tests/greet/<case>/`: a `request.json` and the `expected.json` the action must produce, run against the built image with no network.

## 3. Test it as CI would

```bash
./vennir catalog check teams/lab/products/hello
```

It validates, builds the image, runs each test case and the action's unit tests in it with no network, and scans it (a fixable HIGH or CRITICAL vulnerability, a secret or a malicious package fails). Nothing is published.

**Check:** every case passes. Then break one on purpose: change `"Hello, Anna!"` in `tests/greet/greets-by-name/expected.json` to `"Hi, Anna!"`, run the check again and read how it fails. Put it back.

## 4. Publish it to your install

From the Vennir checkout:

```bash
make catalog-publish CATALOG=~/my-catalog
```

**Check:** **Catalog** lists `lab/hello`, and the team `lab` exists (**Teams**), made by the console when it applied your release. Add yourself to `lab` as a maintainer.

## 5. Run it

**Catalog → hello.greet → Run**, for `lab`, with your name.

**Check:** the step succeeds with `message: Hello, <name>!`. Now run it with the name empty: the console refuses it before anything runs (`INPUT_INVALID`), because the input schema requires a name. The kernel checks it again before the step starts, and checks the output when it finishes.

## 6. Give it a secret

**Teams → lab → Secrets → Add a secret** → **Paste it here**: name `hello-secret`, key `value`, any value. Run `greet` again with `useSecret` on.

**Check:** `secretFound: true`, and the value appears nowhere: not in the outputs, not in the logs. The secret is mounted at `/platform/secrets/hello-secret/value` only because `product.yaml` lists it and this is `lab`'s reviewed image; any other image runs with no secrets at all.

## 7. Explain your errors

When `greet` fails, its error code should tell the person what to do. `greet` fails with `MISSING_SECRET` when it's asked to check a secret it wasn't given (the starter's `names-the-missing-secret` case tests exactly that). Say what that means, in `product.yaml`, at the top level:

```yaml
errors:
  MISSING_SECRET:
    means: It was asked to check hello-secret, but the step wasn't given it.
    do: List hello-secret in the step's secretRefs, or turn useSecret off.
```

Check and publish again. Then make it fail: **Runs → Submit a DAG** with one step that asks for the secret without listing it (submitting a raw DAG takes a maintainer of its team):

```yaml
name: hello-without-its-secret
tasks:
  - id: say-hello
    image: localhost:5001/lab/hello:latest
    action: greet
    team: lab
    inputs: {name: Anna, useSecret: true}
```

**Check:** the failed step shows your **Means** and **Do**, and whether a retry is safe (not here: it would fail the same way). A run from the **Catalog** can't fail like this: it gets the secrets its action lists.

## Clean up

Nothing to clean: it's all on your laptop. Keep `~/my-catalog` for the cloud labs, or delete it.

## What you proved

The product contract (files in, files out, schemas both ways), tests that run like production with no network, a catalog published through the same checks as CI, secrets that only a reviewed image gets, and failures that explain themselves.

**Next:** [Lab 3: Vennir on GKE](lab-3-gke.md), or stay local and copy a starter in your language from `samples/local/products/`.
