# Starter templates

Copy these to start a team or a product; every line you must change is
marked `CHANGE`. They build, pass their tests and pass CI's security scan as
they are, and CI checks that on every PR, so a copy starts from green.

| Folder | What it is | Copy to |
|---|---|---|
| `team/` | The file that creates your team | `teams/<team>/team.yaml`, plus your line in `.github/CODEOWNERS` |
| `hello/` | The smallest product: one action, an optional secret, no cloud | `teams/<team>/products/hello/` |
| `name-maker/` | A product whose output feeds another's input | `teams/<team>/products/name-maker/` |
| `http-check/` | Calls an API with an optional token, with timeouts and retryable errors | `teams/<team>/products/http-check/` |
| `dags/` | DAGs to paste into the console's Submit page, one per step; then a template (`5-template.yaml`), how others run your products | (paste; change the team name) · `teams/<team>/dags/` |

The step-by-step walkthrough that uses them is the "Vennir: try the
team end to end" guide.
