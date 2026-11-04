# Architecture diagrams

[`vennir.drawio`](vennir.drawio) opens in draw.io (desktop, diagrams.net, or the VS Code extension). It has six pages, each also exported as an SVG here:

| Page | What it shows |
| --- | --- |
| [1 · System](1-system.svg) | What runs where on GKE and in the GCP project around it, the catalog's GitHub workflows, and how one execution flows through them (① to ⑤). |
| [2 · Kernel types](2-kernel-types.svg) | UML of the kernel's Go (`kernel/cmd`, `kernel/internal`): every file, type (struct fields, interface methods) and function, grouped by package, with the imports between them. |
| [3 · Console classes](3-console-classes.svg) | The same for `console/src` and `console/frontend/src`, including every HTTP route each module registers and the Drizzle tables. |
| [4 · Submit to finished](4-submit-to-finished.svg) | A UML sequence diagram of one execution, call by call, from `ExecutionService/SubmitExecution` through kernel-api, claiming, dispatch, polling and finalizing. |
| [5 · States](5-states.svg) | The task and execution state machines, with the function that makes each transition. |
| [6 · The pieces](6-the-pieces.svg) | The parts at a glance, the figure in [`architecture.md`](../architecture.md): as wide as the console's Docs page shows a figure, so it's shown at full size there. |

The database tables are drawn in the console's guide, [`console/docs/06-database-schemas.md`](../../console/docs/06-database-schemas.md) (Docs → *Where Vennir keeps its data*).

## Keeping them current

All six pages are written by [`generate.py`](generate.py). Pages 2 and 3 are read from the source code, so they're only right if someone reruns the script after the code changes:

```console
$ python3 docs/architecture/generate.py
```

It rewrites `vennir.drawio` and, when draw.io's desktop app is installed, the SVGs. Then `make console-docs`, which copies the SVGs into the console for its Docs page. A rerun overwrites the file, so change a layout in `generate.py` rather than by dragging boxes in draw.io. Pages 1, 4, 5 and 6 are laid out by hand in the script: update them when the deployment, the call path or the state rules change.
