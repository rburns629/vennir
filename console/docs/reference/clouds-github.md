# Getting GitHub ready for the catalog

`vennir catalog create` creates the catalog repository with `gh`, as you.

## Sign in

```
gh auth login --scopes repo,workflow
```

With several accounts signed in (`gh auth status` lists them), `init` asks
which creates the catalog and switches to it (`gh auth switch`).

## An organization's single sign-on

If the owner is an organization that enforces SAML single sign-on, GitHub
refuses a token until you authorize it for that organization. vennir
shows the authorization link GitHub sends; open it, authorize, and run the
command again.

## What a free plan skips

A **private** repository on GitHub Free has no Environments or branch
rules. The catalog still publishes from `main` only (its cloud federation
refuses other branches), and holds no console or cluster credential either
way: each install pulls its signed release. What's missing:

- **Branch rules**, so a failing check or a missing code-owner review
  doesn't stop a merge.
- **The `catalog-publish` Environment**, so a secret CI needs (a generated
  signing key, a registry password) would sit at repository level, where
  every pull request's workflows can read it: use OIDC for the registry and
  keyless or KMS signing instead, which need none.
- **The reviewed `purge` workflow** for deleting a removed team's images.
- **Teams' own build Environments** (`buildEnvironments`): a team whose
  builds need values of its own keeps a catalog repository of its own.

A public repository, or a paid plan, gets all of it.

## Next

[Setting up Vennir](../setup.md): `vennir init`, what each question decides, and what to expect from `vennir apply`.
The whole path, install to a first deploy: [Onboarding](../../console/docs/17-onboarding.md).
