# Contributing to Vennir

Thanks for helping. This page covers setting up, testing, and what a pull
request needs. For security issues, see [`SECURITY.md`](SECURITY.md) instead.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on
  the approach.
- Read [`AGENTS.md`](AGENTS.md). It's written for AI coding assistants but is
  the quickest orientation for people too: the layout, the contracts between
  components, and the engineering principles the code follows.
- [`docs/architecture.md`](docs/architecture.md) explains how it works,
  [`docs/operations.md`](docs/operations.md) how to run it.

## Setting up

The repository holds four independent projects. Build and test each one from
inside its own directory.

**Kernel**, **gateway** and **CLI** (Go 1.26 or later; `cd kernel`,
`cd gateway` or `cd cli`):

```
go vet ./... && gofmt -l .
go test ./...
```

CI runs them in the pinned `golang:1.27-alpine` image, as `make test` does
for the kernel.

**Console** (Node 26, `cd console`, and separately `cd console/frontend`):

```
npm ci
npm run typecheck && npm run lint
cd frontend && npm ci && npm run build && npm run lint && npm test
```

**Tests** (from the repository root, needs Docker):

```
make test             # starts a test Postgres, migrates it, runs the kernel's, console's and frontend's tests
make test-db          # just the databases, migrated; then run a suite yourself
make test-db-down     # removes it
```

Integration tests use a real Postgres, not mocks. `make test-db` runs it as a
throwaway container (`vennir-test-db`) on `127.0.0.1:55432`, apart from any
Postgres you already run and from any Vennir install. To run a suite by hand
against it, set `TEST_DATABASE_URL`:

```
cd kernel && TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/execution_kernel_test go test ./...
cd console && TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/execution_console_test npm test
cd gateway && TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/execution_console_test go test ./...
```

The gateway's tests read the console's migrated test database.

The charts' admission policies have their own check, against a real
cluster (it adds a few objects of its own under a "policytest" name, and removes them after):
`bash helm/tests/admission-policies.sh`. CI runs it on kind, with the
kernel's Kubernetes tests.

The kernel's Kubernetes tests (`TestKind*`) skip themselves unless the
current `kubectl` context is a reachable `kind` cluster with an
`execution-kernel` namespace; run them from your machine, not the Go
container. To run the whole
platform locally, see the README's "Try it locally".

## Pull requests

- **Keep it focused.** One change per pull request, with a description of
  what changed and why.
- **Add tests.** A bug fix gets a test that fails without it. A new
  authorization rule gets a test in `console/test/`.
- **Say what else it affects.** Run `make impact` before opening the pull
  request: it lists what imports each changed file, and every file that
  implements the same thing elsewhere ([`.github/impact.toml`](.github/impact.toml))
  that you left unchanged. CI fails on those until you change them or add a
  commit trailer saying why they need no change
  (`Impact-checked: <rule id>: <why>`). Fill in the pull request's Affects
  table from it.
- **Keep the docs in step**:
  - adding, moving or removing a file means updating
    [`docs/repository-map.md`](docs/repository-map.md)
  - a code change that affects the diagrams means rerunning
    `docs/architecture/generate.py` (don't hand-edit the `.drawio`)
  - a database schema change means updating
    `console/docs/06-database-schemas.md`
  - a change to a platform doc (`docs/*.md`, `docs/clouds/`) means
    `make console-docs`, which copies it into the console's Docs page
  - a change to the console's API means `make proto`
- **CI must pass**: tests, linters, type checks, Helm rendering and the
  alert rules' tests, and the
  security scans (Trivy, OSV, Semgrep, gitleaks).
- **Never commit a secret**, not even a placeholder value that looks real.

## Contributor License Agreement

Before your first pull request can be merged, you accept the
[Contributor License Agreement](CLA.md), once. A bot asks you to on that
pull request: comment `I have read the CLA and I accept it`, and it covers
everything you contribute after. You keep the copyright in your work; the
agreement lets the project use and distribute it. If your employer has rights
to what you write, check that it allows you to contribute first.

## License

Vennir is released under the [MIT License](LICENSE); your contributions are
covered by the [CLA](CLA.md). New source files start with the license identifier:

```
# SPDX-License-Identifier: MIT
```

(`// SPDX-License-Identifier: MIT` in Go and TypeScript.)

## Conduct

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
