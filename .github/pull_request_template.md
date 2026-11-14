## What and why

<!-- What this changes, and the problem it solves. Link the issue: "Fixes #123". -->

## Affects

<!-- What else reads or depends on what you changed, and what happens to it.
     `make impact` lists what imports each changed file and every coupled file
     (.github/impact.toml) you left unchanged; CI fails on the latter until you
     change it or add a commit trailer: Impact-checked: <rule id>: <why>. -->

| Where | Checked | Effect |
| --- | --- | --- |
|  |  |  |

## How it was tested

<!-- Tests added or changed. For anything touching isolation, RBAC or admission
     policies: was it also proven on a real (kind) cluster? -->

## Checklist

- [ ] Tests cover the change (a fix has a test that fails without it)
- [ ] Docs updated where needed (`docs/repository-map.md` for added or moved files, `generate.py` rerun for diagram changes, the schema doc for database changes)
- [ ] No secrets, tokens or real credentials anywhere in the diff
- [ ] You've accepted the [CLA](../CLA.md) (the bot asks on your first pull request)
