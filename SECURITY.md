# Security policy

Vennir runs other people's code and holds other people's secrets, so security
reports are taken seriously and handled privately.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
open the repository's **Security** tab and choose **Report a vulnerability**.
Include what you found, how to reproduce it, and what an attacker could do
with it.

What to expect:

- An acknowledgement within 5 working days.
- An assessment, and a fix or mitigation plan, as soon as the impact is
  understood.
- Coordinated disclosure: a fix is released before details are published,
  within 90 days of the report unless we agree on a different date with you.
- Credit in the advisory, if you'd like it.

## Supported versions

Vennir is in 0.x. Only the latest release receives security fixes.

## Scope

In scope: the kernel (`kernel/`), the console (`console/`), the API gateway
(`gateway/`), the installer CLI (`cli/`), the Helm charts and the admission
policies they install (`helm/charts/`).

Not in scope:

- Gaps already documented as not yet enforced in
  [`docs/security-model.md`](docs/security-model.md#not-yet-enforced) (for
  example, reads of a run's outputs and logs aren't audited). They're tracked in
  [`TODO.md`](TODO.md); reports that show a new way to exploit them are still
  welcome.
- The fixed admin password in the local `kind` settings
  (`helm/values/kind/`), which exists only for local development.
- Products in a catalog repository, and third-party charts such as External
  Secrets Operator.
