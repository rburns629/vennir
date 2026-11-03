# Onboarding a team or product, with an AI assistant

For a team adding itself, or a new product, to this catalog with the help
of Claude or another assistant. The procedure itself is this catalog's
[README](../README.md) and the Vertra console's "Try Vertra end to end"
guide; this covers how to use an assistant for it, and what to check.

**In short:** describe what you want; the assistant writes the files, runs
the checks and opens a pull request on a branch; a person reviews and
merges. The assistant never merges. That review is the gate: merging
creates namespaces and publishes images.

## What to ask for, and what to check

1. **Files, from the templates.** A new team is
   `teams/<team>/team.yaml` plus its line in
   `.github/CODEOWNERS`. A product is a copy of `templates/hello` (or
   `name-maker`, `http-check`) under `teams/<team>/products/`, with
   a real action script, its `product.yaml`, and contract tests. If the
   action reads a secret, its `secretRefs` names it exactly as the script
   reads it (`/platform/secrets/<name>/<key>`). Every file starts with
   `apiVersion: vertra.dev/v2` and its `kind`, as the templates do.
2. **Proof it works.** Ask for the output of
   `./vertra catalog check teams/<team>/products/<product>`, which
   validates, builds, runs the tests and scans the image. "I wrote a test"
   isn't the same as "the tests passed".
3. **A pull request, not a push to `main`.** Review it as you would a
   colleague's: what the action calls, what it outputs, what it logs.

Once merged, CI publishes the product (pushes its image as the commit's tag,
signs it, then moves `:latest` to it) and the catalog's release, which each Vertra install reads
within a few minutes: it registers the product, and a new team folder gets
its console team and namespace. A name already taken by a team the catalog
didn't make waits for that install's admin to adopt it.

## What isn't automatic

- **The team's first member**: a Vertra admin adds them.
- **Cloud identity.** A product that calls a cloud API declares a
  `serviceAccount` in `product.yaml`; someone binds that ServiceAccount to
  a cloud identity (GKE Workload Identity, AKS Workload Identity, EKS Pod
  Identity) with only the permissions the action needs.
- **Secret values.** Neither the assistant nor the catalog handles them:
  values are pasted into the console, or synced from a vault through the
  team's SecretStore (`teams/<team>/secret-stores/`, approved by
  the catalog admins).
- **Cleaning up.** Real resources a test run creates (a Cloud SQL instance,
  a Cloud Run service) are yours to delete.

## Secrets: what to watch for in generated code

- A secret is any string: an API key under one key (`value`), a credential
  pair under two keys of one secret, a credential file. Prefer federation
  over a stored key wherever the cloud offers it.
- An action never prints or returns a secret's value. The kernel redacts
  recognizable credentials from logs and fails a step whose outputs contain
  one, but it can't recognize a password. To show a secret was read, output
  a fingerprint or a boolean.

## Finding the permissions an action needs

Start from the API reference for each call the action makes (most list the
permission per method). Then verify in a sandbox: run once with a broad
role and narrow it with what was actually used (GCP's IAM Recommender, AWS
IAM Access Analyzer, Azure Activity Log). An assistant can draft the first
guess or read the audit logs with you; treat its answer as a draft to
verify, not a grant.
