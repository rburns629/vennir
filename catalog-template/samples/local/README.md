# local: one product, five languages

A sample team that runs anywhere, with no cloud and no secrets. Its products
are the same small product written five times, one per language: the
starters a new team copies for the languages it uses. As a whole team
(copied to `teams/local/`), its first publish proves an install end to end.

| Product | Language | What it does to `text` | How it runs |
|---|---|---|---|
| [`title-case`](products/title-case/) | Python | `hello world` → `Hello World` | `entrypoint.sh` runs `actions/transform.py` |
| [`reverse`](products/reverse/) | TypeScript | `hello world` → `dlrow olleh` (emoji stay whole) | compiled in a build stage; `entrypoint.sh` runs `actions/transform.js` with Node |
| [`slug`](products/slug/) | Go | `Hello, World!` → `hello-world` | a static binary on distroless, the entrypoint itself |
| [`upper-case`](products/upper-case/) | PowerShell | `hello world` → `HELLO WORLD` | `entrypoint.sh` runs `actions/transform.ps1` with `pwsh` |
| [`rot13`](products/rot13/) | Rust | `Hello` → `Uryyb` | a release binary on distroless, the entrypoint itself |

Every one has the action `transform`, the input `text` (up to 1,000
characters) and the outputs `text` and `language`. They fail the same way
too: `MISSING_INPUT` without text, `TEXT_TOO_LONG` over the limit. Since
`result.json` is limited to 4 KB, they also measure the result they'd
write, and fail `TEXT_TOO_LONG` when it wouldn't fit: 1,000 characters can
be far more bytes (JSON writes a control character as six, UTF-8 some
characters as four). `slug` keeps only letters and digits, which always fit.

One more, [`ticket`](products/ticket/) (Python), shows what a run made and
deleting it later: `open` reports the ticket it opens in its outputs'
`resources`, and its `cleanup` names `close`, which the console runs when
someone deletes that ticket from **What runs made**; and its `plan` names
`plan`, which says what `open` would do, for **Preview**; and its `check`
says it's ready, as every install asks. Nothing is really
created; the ticket's id comes from its title.

Its `watch` shows wiring (`types.yaml`): `open`'s `ticket` output provides a
`local.ticket`, and `watch`'s `ticket` input needs one. Put a watch alone in
the cart and the order adds `open` for it, or offers a ticket you already
have; the watch it reports depends on that ticket, so deleting the ticket
waits for an admin unless its watches go with it (`unwatch` removes one).

## Tests

Each product's tests are contract tests in `tests/transform/<case>/`: a
`request.json` input and the `expected.json` its `result.json` must contain.
They run against the built image the way the platform runs a step (the
request mounted at `/platform/input`, no network), so they test what
actually runs. Once copied into `teams/<team>/`, from the repository root:

```bash
./vennir catalog check teams/<team>/products/slug     # validate, build, test, scan
```

## All five in one DAG

Each step takes the previous step's `text`. They need no secrets and no
ServiceAccount of their own, so this runs as soon as the team is published
(copy this folder to `teams/local/`, then `./vennir catalog publish teams/local/products/*`
and `./vennir catalog release`, or merge it for CI). `:latest` is
fine: the console pins each image to its digest when you submit. The
registry here is a local install's:

```yaml
name: five-languages
tasks:
  - id: python
    image: localhost:5001/local/title-case:latest
    action: transform
    team: local
    inputs:
      text: hello from five languages
  - id: typescript
    image: localhost:5001/local/reverse:latest
    action: transform
    team: local
    dependsOn: [python]
    inputs:
      text: {$fromTask: python, $output: text}
  - id: go
    image: localhost:5001/local/slug:latest
    action: transform
    team: local
    dependsOn: [typescript]
    inputs:
      text: {$fromTask: typescript, $output: text}
  - id: powershell
    image: localhost:5001/local/upper-case:latest
    action: transform
    team: local
    dependsOn: [go]
    inputs:
      text: {$fromTask: go, $output: text}
  - id: rust
    image: localhost:5001/local/rot13:latest
    action: transform
    team: local
    dependsOn: [powershell]
    inputs:
      text: {$fromTask: powershell, $output: text}
```

`hello from five languages` becomes `Hello From Five Languages`, then
`segaugnaL eviF morF olleH`, `segaugnal-evif-morf-olleh`,
`SEGAUGNAL-EVIF-MORF-OLLEH`, and finally `FRTNHTANY-RIVS-ZBES-BYYRU`.
