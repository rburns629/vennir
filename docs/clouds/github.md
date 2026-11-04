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
rules: the catalog still publishes from `main` only (its cloud federation
refuses other branches), but its token is a repository secret and the
reviewed purge workflow has no token. A public repository, or a paid plan,
gets all of it.

## Next

[Setting up Vennir](../setup.md): `vennir init`, what each question decides, and what to expect from `vennir apply`.
