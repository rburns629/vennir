#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Writes docs/architecture/vennir.drawio, and an SVG of each page.

Run from anywhere: python3 docs/architecture/generate.py

Six pages:
  1. System: what runs where, on GKE and around it, and how a request flows.
  2. Kernel types: every file, type and function in the kernel's Go
     (kernel/cmd, kernel/internal), read with regular expressions, grouped
     by package, with the imports between them.
  3. Console classes: the same for console/src and console/frontend/src.
  4. Submit to finished: a sequence diagram of one execution, function by function.
  5. States: the task and execution state machines.
  6. The pieces: the parts at a glance, for docs/architecture.md, as wide
     as the console's Docs page shows a figure.

Pages 2 and 3 come from the code, so rerun this after changing it rather
than editing them by hand in draw.io (a rerun overwrites the file). Pages
1, 4, 5 and 6 are laid out below. Labels are plain text, not HTML, so the
SVGs hold real text instead of a PNG fallback for every label. The SVGs
need draw.io's desktop app, whose CLI exports them; without it only the
.drawio is written.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from xml.sax.saxutils import quoteattr

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DRAWIO_FILE = HERE / "vennir.drawio"
DRAWIO_CLI = [
    "/Applications/draw.io.app/Contents/MacOS/draw.io",
    shutil.which("drawio") or "",
    shutil.which("draw.io") or "",
]

# draw.io's own default palette (fill, stroke).
BLUE = ("#dae8fc", "#6c8ebf")
GREEN = ("#d5e8d4", "#82b366")
YELLOW = ("#fff2cc", "#d6b656")
ORANGE = ("#ffe6cc", "#d79b00")
RED = ("#f8cecc", "#b85450")
PURPLE = ("#e1d5e7", "#9673a6")
GREY = ("#f5f5f5", "#666666")
WHITE = ("#ffffff", "#666666")

FONT = "html=0;fontFamily=Helvetica;fontSize=12;"
MONO = "html=0;fontFamily=Menlo;fontSize=11;"
EDGE = (
    "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=0;"
    "endArrow=block;endFill=1;fontSize=11;labelBackgroundColor=#ffffff;strokeColor=#444444;"
)
DEPENDENCY = "edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;dashed=1;endArrow=open;endSize=10;strokeColor=#555555;"
TITLE = f"text;align=left;verticalAlign=middle;{FONT}fontSize=20;fontStyle=1;"
SUBTITLE = f"text;align=left;verticalAlign=middle;{FONT}fontColor=#555555;"
NOTE = "shape=note;size=14;align=left;verticalAlign=top;spacingLeft=10;spacingTop=6;fillColor=#fffbe6;strokeColor=#d6b656;" + FONT


def lines(*parts: str) -> str:
    return "\n".join(parts)


def wrap(paragraph: str, width: int) -> str:
    return "\n".join(textwrap.wrap(paragraph, width))


def box(color: tuple[str, str], extra: str = "") -> str:
    fill, stroke = color
    return f"rounded=1;arcSize=6;fillColor={fill};strokeColor={stroke};{FONT}{extra}"


def frame(color: tuple[str, str], dashed: bool = True) -> str:
    _, stroke = color
    return (
        "rounded=1;arcSize=1;verticalAlign=top;align=left;spacingLeft=10;spacingTop=4;fontStyle=1;"
        f"fillColor=none;strokeColor={stroke};strokeWidth=2;dashed={1 if dashed else 0};{FONT}"
    )


def database(color: tuple[str, str]) -> str:
    fill, stroke = color
    return f"shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=10;fillColor={fill};strokeColor={stroke};fontStyle=1;{FONT}"


class Page:
    def __init__(self, name: str) -> None:
        self.name = name
        self.cells: list[str] = []
        self.count = 1

    def _next_id(self) -> str:
        self.count += 1
        return f"{self.name[:1]}-{self.count}"

    def vertex(self, x: float, y: float, w: float, h: float, value: str, style: str, parent: str = "1") -> str:
        cell_id = self._next_id()
        self.cells.append(
            f'<mxCell id="{cell_id}" value={quoteattr(value)} style={quoteattr(style)} vertex="1" '
            f'parent="{parent}"><mxGeometry x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h:.0f}" '
            'as="geometry"/></mxCell>'
        )
        return cell_id

    def titled(
        self, x: float, y: float, w: float, h: float, title: str, description: str, color: tuple[str, str],
        dashed: bool = False,
    ) -> str:
        """A box with a bold title and a smaller description under it; dashed for what isn't deployed there."""
        outer = self.vertex(
            x, y, w, h, title, box(color, "verticalAlign=top;spacingTop=6;fontStyle=1;" + ("dashed=1;" if dashed else ""))
        )
        self.vertex(
            0, 26, w, h - 26, description,
            f"text;strokeColor=none;fillColor=none;align=center;verticalAlign=top;{FONT}fontSize=11;",
            parent=outer,
        )
        return outer

    def edge(
        self,
        source: str | None,
        target: str | None,
        value: str = "",
        style: str = EDGE,
        points: list[tuple[float, float]] | None = None,
        source_point: tuple[float, float] | None = None,
        target_point: tuple[float, float] | None = None,
        label_offset: tuple[float, float] | None = None,
    ) -> str:
        cell_id = self._next_id()
        ends = (f' source="{source}"' if source else "") + (f' target="{target}"' if target else "")
        geometry = ""
        if source_point:
            geometry += f'<mxPoint x="{source_point[0]:.0f}" y="{source_point[1]:.0f}" as="sourcePoint"/>'
        if target_point:
            geometry += f'<mxPoint x="{target_point[0]:.0f}" y="{target_point[1]:.0f}" as="targetPoint"/>'
        if points:
            geometry += '<Array as="points">' + "".join(f'<mxPoint x="{x:.0f}" y="{y:.0f}"/>' for x, y in points) + "</Array>"
        if label_offset:
            geometry += f'<mxPoint x="{label_offset[0]:.0f}" y="{label_offset[1]:.0f}" as="offset"/>'
        self.cells.append(
            f'<mxCell id="{cell_id}" value={quoteattr(value)} style={quoteattr(style)} edge="1" '
            f'parent="1"{ends}><mxGeometry relative="1" as="geometry">{geometry}</mxGeometry></mxCell>'
        )
        return cell_id

    def xml(self, index: int) -> str:
        return (
            f'<diagram id="page-{index + 1}" name={quoteattr(self.name)}><mxGraphModel grid="1" '
            'gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" '
            'pageScale="1" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
            + "".join(self.cells)
            + "</root></mxGraphModel></diagram>"
        )


def ends(exit_x: float, exit_y: float, entry_x: float, entry_y: float) -> str:
    return f"exitX={exit_x:.3f};exitY={exit_y:.3f};entryX={entry_x:.3f};entryY={entry_y:.3f};"


# ---------------------------------------------------------------- UML boxes

LINE_HEIGHT = 15
CHAR_WIDTH = 6.8  # Menlo at 11px
MAX_LINE = 64


@dataclass
class UmlClass:
    name: str
    stereotype: str
    attributes: list[str] = field(default_factory=list)
    operations: list[str] = field(default_factory=list)
    color: tuple[str, str] = WHITE

    @property
    def width(self) -> float:
        longest = max([len(line) for line in self.attributes + self.operations] + [len(self.name) + 4, 24])
        return min(longest, MAX_LINE) * CHAR_WIDTH + 24

    @property
    def height(self) -> float:
        attributes = len(self.attributes) * LINE_HEIGHT + 8 if self.attributes else 0
        operations = len(self.operations) * LINE_HEIGHT + 8 if self.operations else 0
        separator = 8 if self.attributes and self.operations else 0
        return 40 + attributes + separator + operations + (10 if not (self.attributes or self.operations) else 0)


def clip(line: str) -> str:
    return line if len(line) <= MAX_LINE else line[: MAX_LINE - 1] + "…"


def draw_class(page: Page, x: float, y: float, w: float, uml: UmlClass) -> str:
    fill, stroke = uml.color
    container = page.vertex(
        x, y, w, uml.height, f"«{uml.stereotype}»\n{uml.name}",
        "swimlane;fontStyle=1;align=center;verticalAlign=top;childLayout=stackLayout;horizontal=1;startSize=40;"
        "horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=0;marginBottom=0;"
        f"fillColor={fill};strokeColor={stroke};swimlaneFillColor=#ffffff;{FONT}fontSize=11;",
    )
    member = (
        "text;strokeColor=none;fillColor=none;align=left;verticalAlign=top;spacingLeft=6;spacingRight=4;"
        f"overflow=hidden;rotatable=0;points=[[0,0.5],[1,0.5]];portConstraint=eastwest;{MONO}"
    )
    offset = 40.0
    if uml.attributes:
        h = len(uml.attributes) * LINE_HEIGHT + 8
        page.vertex(0, offset, w, h, lines(*map(clip, uml.attributes)), member, parent=container)
        offset += h
    if uml.attributes and uml.operations:
        page.vertex(
            0, offset, w, 8, "",
            "line;strokeWidth=1;fillColor=none;align=left;verticalAlign=middle;spacingTop=-1;spacingLeft=3;"
            f"spacingRight=3;rotatable=0;labelPosition=right;points=[];portConstraint=eastwest;strokeColor={stroke};",
            parent=container,
        )
        offset += 8
    if uml.operations:
        h = len(uml.operations) * LINE_HEIGHT + 8
        page.vertex(0, offset, w, h, lines(*map(clip, uml.operations)), member, parent=container)
    return container


@dataclass
class Package:
    name: str
    title: str
    color: tuple[str, str]
    classes: list[UmlClass] = field(default_factory=list)


def draw_packages(page: Page, title: str, subtitle: str, packages: list[Package], imports: set[tuple[str, str]]) -> None:
    """Packages left to right, each a frame of classes in columns, with one
    dashed arrow per package that imports another, routed in lanes above."""
    page.vertex(20, 10, 1400, 30, title, TITLE)
    page.vertex(20, 40, 1800, 24, subtitle, SUBTITLE)
    edges = sorted(imports)
    top = 110 + 14 * (len(edges) + 1)
    page.vertex(
        20, 76, 700, 20,
        "Dashed arrows above: «import». The package at the tail imports the package at the head.",
        f"text;align=left;verticalAlign=middle;{FONT}fontSize=11;fontColor=#555555;",
    )
    max_column = 1500
    x = 20.0
    frames: dict[str, tuple[float, float]] = {}
    for package in packages:
        columns: list[list[UmlClass]] = [[]]
        heights = [0.0]
        for uml in package.classes:
            if columns[-1] and heights[-1] + uml.height + 20 > max_column:
                columns.append([])
                heights.append(0.0)
            columns[-1].append(uml)
            heights[-1] += uml.height + 20
        widths = [max((u.width for u in column), default=200) for column in columns]
        frame_w = sum(widths) + 20 * (len(widths) + 1)
        page.vertex(x, top, frame_w, max(heights) + 50, package.title, frame(package.color))
        cx = x + 20
        for column, width in zip(columns, widths, strict=True):
            cy = top + 40
            for uml in column:
                draw_class(page, cx, cy, width, uml)
                cy += uml.height + 20
            cx += width + 20
        frames[package.name] = (x, frame_w)
        x += frame_w + 40

    # Each frame's top edge is split into slots, one per arrow end, so no
    # two arrows share a vertical segment.
    slots: dict[str, list[tuple[int, str, float]]] = {name: [] for name in frames}
    for i, (source, target) in enumerate(edges):
        slots[source].append((i, "out", frames[target][0]))
        slots[target].append((i, "in", frames[source][0]))
    at: dict[tuple[int, str], float] = {}
    for name, items in slots.items():
        fx, fw = frames[name]
        for k, (i, direction, _) in enumerate(sorted(items, key=lambda item: item[2])):
            at[(i, direction)] = fx + fw * (k + 1) / (len(items) + 1)
    for i in range(len(edges)):
        lane = top - 14 * (i + 1)
        sx, tx = at[(i, "out")], at[(i, "in")]
        page.edge(None, None, "", DEPENDENCY, points=[(sx, lane), (tx, lane)], source_point=(sx, top), target_point=(tx, top))


# ---------------------------------------------------------- kernel (Go)

KERNEL = ROOT / "kernel"
GO_MODULE = "github.com/roburns/vennir/kernel/"
KERNEL_LAYERS = [
    ("domain", "internal/domain/  (rules, no I/O)", GREEN),
    ("config", "internal/config/  (settings, checked at startup)", GREY),
    ("api", "internal/api/  (kernel-api: KernelService over Connect)", BLUE),
    ("executor", "internal/executor/  (the Executor interface; Kubernetes Jobs)", RED),
    ("scheduler", "internal/scheduler/  (kernel-scheduler: the pass and the loop)", ORANGE),
    ("migrate", "internal/migrate/  (the schema)", YELLOW),
    ("database", "internal/dbauth/, internal/dbsetup/  (signing in to a managed database; opening it to each process)", YELLOW),
    ("sleeper", "internal/sleeper/  (sleeping an idle platform, a CronJob)", ORANGE),
    ("policy", "internal/policy/  (kernel policy: the signed catalog's admission policies)", RED),
    ("observability", "internal/logging/, internal/metrics/", GREY),
    ("cmd", "cmd/kernel/  (the binary: a subcommand per process)", BLUE),
]
GO_FUNC = re.compile(r"^func (?:\((\w+) \*?(\w+)(?:\[[^\]]*\])?\) )?(\w+)(\[[^\]]*\])?\(([^)]*)\)\s*(.*?)\s*\{?$")
GO_TYPE = re.compile(r"^type (\w+)(?:\[[^\]]*\])? (struct|interface|[^{]+?)\s*\{?\s*$")


def kernel_package(relative: Path) -> str | None:
    parts = relative.parts
    if parts[0] == "cmd":
        return "cmd"
    # Generated code, and packages only tests use.
    if parts[0] != "internal" or parts[1] in ("gen", "dbtest", "kindtest"):
        return None
    if parts[1] in ("logging", "metrics"):
        return "observability"
    if parts[1] in ("dbauth", "dbsetup"):
        return "database"
    return parts[1]


def go_signature(name: str, params: str, returns: str) -> str:
    names = [p.strip().split(" ")[0] for p in params.split(",") if p.strip()]
    visibility = "+" if name[0].isupper() else "-"
    returns = returns.split(" {")[0].strip()  # a one-line function's body
    return f"{visibility} {name}({', '.join(names)})" + (f": {returns}" if returns else "")


def kernel_packages() -> tuple[list[Package], set[tuple[str, str]]]:
    packages = {name: Package(name, title, color) for name, title, color in KERNEL_LAYERS}
    imports: set[tuple[str, str]] = set()
    for path in sorted([*KERNEL.glob("cmd/**/*.go"), *KERNEL.glob("internal/**/*.go")]):
        relative = path.relative_to(KERNEL)
        package = kernel_package(relative)
        if package is None or path.name.endswith("_test.go"):
            continue
        source = path.read_text()
        for imported in re.findall(r'"' + re.escape(GO_MODULE) + r'(?:internal/)?([a-z]+)', source):
            target = kernel_package(Path("internal", imported))
            if target is not None and target != package:
                imports.add((package, target))
        types: dict[str, UmlClass] = {}
        functions: list[str] = []
        lines = source.splitlines()
        for i, line in enumerate(lines):
            if m := GO_TYPE.match(line):
                name, kind = m.group(1), m.group(2).strip()
                stereotype, color = {"struct": ("struct", WHITE), "interface": ("interface", ORANGE)}.get(kind, ("type", GREEN))
                attributes: list[str] = []
                if kind in ("struct", "interface"):
                    for body in lines[i + 1 :]:
                        if body.startswith("}"):
                            break
                        if f := re.match(r"^\t(\w+)(\(.*)?\s*(.*)$", body):
                            if kind == "interface" and f.group(2):
                                attributes.append(go_signature(f.group(1), f.group(2)[1 : f.group(2).index(")")], f.group(2)[f.group(2).index(")") + 1 :]))
                            elif kind == "struct" and not body.lstrip().startswith("//"):
                                field_type = f.group(3).split("`")[0].strip()
                                if field_type:
                                    attributes.append(f"{'+' if f.group(1)[0].isupper() else '-'} {f.group(1)}: {field_type}")
                else:
                    attributes.append(f"= {kind}")
                types[name] = UmlClass(f"{name}  ({path.name})", stereotype, attributes, [], color)
            elif m := GO_FUNC.match(line):
                receiver, name, params, returns = m.group(2), m.group(3), m.group(5), m.group(6)
                signature = go_signature(name, params, returns)
                if receiver and receiver in types:
                    types[receiver].operations.append(signature)
                elif receiver:
                    functions.append(f"{signature}  (on {receiver})")
                else:
                    functions.append(signature)
        if functions:
            packages[package].classes.append(UmlClass(str(relative), "file", [], functions))
        packages[package].classes += types.values()
    return [p for p in packages.values() if p.classes], imports


# --------------------------------------------------- console (TypeScript)

CONSOLE = ROOT / "console"
CONSOLE_LAYERS = [
    ("frontend", "frontend/src/  (React SPA; calls the API over Connect)", PURPLE),
    ("entry", "src/  (buildApp, config)", GREY),
    ("rpc", "src/rpc/  (Connect services, interceptors)", BLUE),
    ("core", "src/core/  (what each method does)", ORANGE),
    ("auth", "src/auth/  (sessions, bot tokens, passwords)", GREEN),
    ("integrations", "kernel-api, Kubernetes, registry, image policy", RED),
    ("db", "src/db/  (Drizzle schema and queries)", YELLOW),
]


def console_package(relative: str) -> str | None:
    if relative.startswith("frontend/src/"):
        return "frontend"
    if relative.startswith("src/rpc/"):
        return "rpc"
    if relative.startswith("src/core/"):
        return "core"
    if relative.startswith("src/auth/"):
        return "auth"
    if relative.startswith("src/db/"):
        return "db"
    if relative in ("src/k8s.ts", "src/kernel/client.ts", "src/registry.ts", "src/imagePolicy.ts", "src/productPolicy.ts", "src/gatewayTokenPolicy.ts"):
        return "integrations"
    if relative.startswith("src/"):
        return "entry"
    return None


def matching(source: str, start: int) -> int:
    """Index just past the bracket that closes the one at `start`."""
    depth = 0
    for i in range(start, len(source)):
        if source[i] in "([{":
            depth += 1
        elif source[i] in ")]}":
            depth -= 1
            if depth == 0:
                return i + 1
    return len(source)


def split_top_level(params: str) -> list[str]:
    parts, depth, current = [], 0, ""
    for ch in params:
        if ch in "([{<":
            depth += 1
        elif ch in ")]}>":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    if current.strip():
        parts.append(current)
    return parts


def ts_param_name(param: str) -> str:
    param = param.strip()
    if param.startswith("{"):
        return "{…}"
    match = re.match(r"(\.\.\.)?\s*(\w+)", param)
    return (match.group(1) or "") + match.group(2) if match else "?"


def ts_functions(source: str) -> list[str]:
    found = []
    for match in re.finditer(r"^(export )?(async )?function (\w+)\s*(<[^(]*>)?\(", source, re.M):
        open_paren = match.end() - 1
        close = matching(source, open_paren)
        params = [ts_param_name(p) for p in split_top_level(source[open_paren + 1 : close - 1])]
        returns = re.match(r"\s*:\s*([^{]+?)\s*\{", source[close : close + 200])
        ret = re.sub(r"\s+", " ", returns.group(1)) if returns else ""
        ret = ret if len(ret) <= 30 else ret[:29] + "…"
        visibility = "+" if match.group(1) else "-"
        found.append(f"{visibility} {match.group(2) or ''}{match.group(3)}({', '.join(params)})" + (f": {ret}" if ret else ""))
    return found


def ts_routes(source: str, prefix: str) -> list[str]:
    pattern = r"\b(?:app|api)\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*\"([^\"]+)\""
    return [f"{verb.upper()} {prefix}{path}" for verb, path in re.findall(pattern, source)]


def drizzle_tables(source: str) -> list[UmlClass]:
    tables = []
    starts = [m for m in re.finditer(r'export const (\w+) = pgTable\(\s*"(\w+)"', source)]
    for k, match in enumerate(starts):
        end = starts[k + 1].start() if k + 1 < len(starts) else len(source)
        body = source[match.end() : end]
        columns = [f"{column}: {kind}" for kind, column in re.findall(r"\b(uuid|text|timestamp|boolean|jsonb)\(\"(\w+)\"", body)]
        tables.append(UmlClass(f"{match.group(2)}  ({match.group(1)})", "table", columns, [], YELLOW))
    return tables


def console_packages() -> tuple[list[Package], set[tuple[str, str]]]:
    packages = {name: Package(name, title, color) for name, title, color in CONSOLE_LAYERS}
    imports: set[tuple[str, str]] = {("frontend", "rpc")}  # over Connect, from frontend/src/api.ts
    frontend = CONSOLE / "frontend" / "src"
    for path in sorted([*(CONSOLE / "src").rglob("*.ts"), *frontend.rglob("*.ts"), *frontend.rglob("*.tsx")]):
        relative = path.relative_to(CONSOLE).as_posix()
        package = console_package(relative)
        # gen/: generated from proto/ (`make proto`), not the console's own code.
        if package is None or relative.endswith(".d.ts") or "/gen/" in relative:
            continue
        source = path.read_text()
        for spec in re.findall(r'from "(\.{1,2}/[^"]+)"', source):
            target = console_package((path.parent / spec).resolve().relative_to(CONSOLE).as_posix().replace(".js", ".ts"))
            if target and target != package:
                imports.add((package, target))
        if relative == "src/db/schema.ts":
            packages["db"].classes += drizzle_tables(source)
            continue
        name = relative.removeprefix("src/").removeprefix("frontend/src/")
        operations = ts_functions(source)
        attributes = [f"+ {n}" for n in re.findall(r"^export const (\w+)", source, re.M)]
        if relative.startswith("src/rpc/services/"):
            # A service's methods: the object's `async name(` / `async *name(` members.
            operations = [f"«rpc» {m}" for m in re.findall(r"^ {4}async \*?(\w+)\(", source, re.M)] + operations
        if relative == "src/index.ts":
            operations = [f"«route» {r}" for r in ts_routes(source, "")] + operations
        component = relative.endswith(".tsx") and re.search(r"^export function [A-Z]", source, re.M)
        if not operations and not attributes:
            continue
        packages[package].classes.append(
            UmlClass(name, "component" if component else "module", attributes, operations, PURPLE if component else WHITE)
        )
    return [p for p in packages.values() if p.classes], imports


# ------------------------------------------------------------ page 1: system


def system_page() -> Page:
    p = Page("1 · System")
    p.vertex(20, 10, 1200, 30, "Vennir on GKE: what runs where", TITLE)
    p.vertex(
        20, 40, 1500, 24,
        "As deployed on vennir-gke. On kind the same pieces run in vennir-system, without GCP, image signing or ESO's cloud stores.",
        SUBTITLE,
    )
    actor = "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;outlineConnect=0;" + FONT
    engineer = p.vertex(50, 170, 30, 60, "Platform engineer\n(browser)", actor)
    pipeline = p.vertex(50, 370, 30, 60, "Team pipeline\n(bot token)", actor)

    p.vertex(20, 560, 290, 560, "GitHub · vennir-catalog", frame(GREY, dashed=False))
    workflows = {}
    for i, (name, what) in enumerate(
        [
            ("ci.yml", "build → scan → push → sign each\nproduct; then the catalog release"),
            ("check-secret-stores.yml", "a team's SecretStore files,\nchecked on pull requests"),
            ("delete-team-images.yml", "a removed team's images\n(by hand, reviewed)"),
            ("security.yml", "scheduled scans of\npublished images"),
        ]
    ):
        workflows[name] = p.titled(35, 600 + i * 84, 260, 70, name, what, GREY)

    p.vertex(340, 80, 1600, 1180, "GCP project · my-gcp-project", frame(BLUE, dashed=False))
    p.vertex(360, 120, 1150, 1120, "GKE Autopilot · vennir-gke (us-central1)", frame(BLUE))
    lb = p.titled(380, 230, 150, 80, "Service console", "LoadBalancer, public IP\nplain HTTP :80", BLUE)

    p.vertex(560, 160, 500, 630, "namespace vennir-system  (the platform)", frame(ORANGE))
    console = p.titled(590, 210, 200, 90, "execution-console", "Fastify /api + React SPA\nconsole/", ORANGE)
    console_db = p.vertex(610, 360, 160, 90, "Postgres\nexecution_console", database(YELLOW))
    kernel_api = p.titled(830, 210, 200, 90, "kernel-api", "Go, Connect, ClusterIP only\naccepts only the console's token", ORANGE)
    kernel_db = p.vertex(850, 360, 160, 90, "Postgres\nexecution_kernel", database(YELLOW))
    scheduler = p.titled(830, 500, 200, 90, "kernel-scheduler", "poll, then claim → dispatch\nevery second", ORANGE)
    p.titled(590, 500, 200, 90, "pg-backup CronJobs", "daily pg_dump of both\ndatabases → Cloud Storage", GREY)
    gateway = p.titled(
        590, 640, 200, 90, "execution-gateway", "API products: forwards what an\nAPI's OpenAPI document allows\noff on vennir-gke (gateway.enabled)",
        ORANGE, dashed=True,
    )

    p.vertex(1090, 160, 400, 630, "namespace <team>  (label vennir/team=true)", frame(GREEN))
    config_map = p.titled(1110, 200, 170, 80, "ConfigMap ek-…", "request.json\n→ /platform/input", GREEN)
    service_account = p.titled(1300, 200, 170, 80, "ServiceAccount", "one per product", GREEN)
    job = p.titled(
        1110, 320, 360, 110, "Job / Pod  ek-<execution>-<task>-<attempt>",
        "the product container, args = [action]\nreads /platform/input/request.json\nwrites /platform/output/result.json",
        GREEN,
    )
    secret = p.titled(1110, 480, 170, 100, "Secret", "the team's: mounted only by\nits registered products,\nwhen a step lists it", GREEN)
    eso_objects = p.titled(1300, 480, 170, 100, "SecretStore +\nExternalSecret", "\nwhich cloud secret\n→ which Secret (ESO)", GREEN)
    backend = p.titled(1110, 645, 170, 80, "Service <api>", "an API product's\nbackend (none here)", GREEN, dashed=True)

    api_server = p.titled(380, 830, 1110, 60, "Kubernetes API server", "every write below passes the admission policies", BLUE)
    for i, (name, what) in enumerate(
        [
            ("dispatch-policy", "scheduler may create Jobs only\nin vennir/team=true namespaces"),
            ("image-policy", "task images only from allowed\nsources (the Admin page edits it)"),
            ("identity-policy", "a product release runs as its\nServiceAccount; else default"),
            ("image-signature", "GKE: catalog images must be\nsigned (ClusterImagePolicy)"),
            ("purge-policy", "only the purge identity may\ndelete a team's namespace"),
        ]
    ):
        p.titled(380 + i * 224, 920, 214, 80, name, what, RED)
    p.vertex(
        560, 1050, 280, 80, "Admission policies are cluster-wide\nValidatingAdmissionPolicies,\ninstalled by the kernel chart.",
        f"text;align=left;verticalAlign=middle;{FONT}fontSize=11;fontColor=#555555;",
    )
    eso = p.titled(870, 1050, 280, 80, "External Secrets Operator", "namespace external-secrets", PURPLE)
    policy_controller = p.titled(1180, 1050, 280, 80, "Sigstore policy-controller", "namespace cosign-system", PURPLE)

    cloud_build = p.titled(1600, 160, 320, 70, "Cloud Build", "make gke-deploy builds platform images", BLUE)
    registry = p.titled(1600, 290, 320, 110, "Artifact Registry", "catalog-products: signed product images\nand catalog-release\nplatform-images: console, kernel", BLUE)
    kms = p.titled(1600, 450, 320, 70, "Cloud KMS", "the cosign signing key", BLUE)
    secret_manager = p.titled(1600, 560, 320, 70, "Secret Manager", "teams' secrets, synced by ESO", BLUE)
    p.titled(1600, 670, 320, 70, "Cloud Storage", "Postgres backups", BLUE)
    p.titled(
        1600, 790, 320, 110, "IAM + Workload Identity",
        "GitHub OIDC → catalog CI's service accounts\nKubernetes SAs → GCP SAs (console,\nESO, backups). No stored keys.",
        BLUE,
    )

    def x_on(x: float, left: float, width: float) -> float:
        return (x - left) / width

    p.edge(engineer, lb, "① sign in, view, submit")
    p.edge(pipeline, lb, "① SubmitExecution (Connect)")
    p.edge(lb, console, "", EDGE + ends(1, 0.5, 0, 0.5))
    p.edge(console, console_db, "teams, users,\nsecrets, products")
    p.edge(console, kernel_api, "② /v1/executions")
    p.edge(kernel_api, kernel_db, "")
    p.edge(scheduler, kernel_db, "③ claim READY tasks\n(SKIP LOCKED, leases)")
    p.edge(scheduler, api_server, "④ ConfigMap + Job", EDGE + ends(0.5, 1, x_on(930, 380, 1110), 0), label_offset=(0, -90))
    p.edge(api_server, job, "⑤ admitted:\nPod runs", EDGE + ends(x_on(1290, 380, 1110), 0, x_on(1290, 1110, 360), 1), label_offset=(0, 180))
    p.edge(config_map, job, "mounted", EDGE + ends(0.5, 1, x_on(1195, 1110, 360), 0))
    p.edge(service_account, job, "runs as", EDGE + ends(0.5, 1, x_on(1385, 1110, 360), 0))
    p.edge(secret, job, "mounted", EDGE + ends(0.5, 0, x_on(1195, 1110, 360), 1))
    p.edge(eso_objects, secret, "defines", EDGE + ends(0, 0.5, 1, 0.5) + "dashed=1;")
    p.edge(
        console, api_server, "namespaces, Secrets,\nServiceAccounts, ExternalSecrets,\nSecretStores, policies (k8s.ts)",
        EDGE + ends(0, 0.5, x_on(545, 380, 1110), 0), points=[(545, 255)], label_offset=(-50, 0),
    )
    p.edge(
        console, registry, "image exists? catalog release\n(registry.ts, catalogSync.ts)", EDGE + ends(0.5, 0, 0, 0.27),
        points=[(690, 145), (1580, 145), (1580, 320)],
    )
    p.edge(
        gateway, console_db, "reads, as\nvennir_gateway", EDGE + ends(0, 0.5, 0, 0.5),
        points=[(575, 685), (575, 405)], label_offset=(10, 70),
    )
    p.edge(gateway, backend, "forwards checked\nrequests", EDGE + ends(1, 0.5, 0, 0.5) + "dashed=1;", label_offset=(-90, 0))
    p.edge(
        pipeline, gateway, "API calls\n(not exposed here)", EDGE + ends(1, 0.9, 0.5, 1) + "dashed=1;",
        points=[(345, 424), (345, 775), (690, 775)], label_offset=(125, 105),
    )
    p.edge(job, registry, "pull image", EDGE + ends(1, (365 - 320) / 110, 0, (365 - 290) / 110))
    p.edge(cloud_build, registry, "push", EDGE + ends(0.5, 1, 0.5, 0))
    p.edge(
        workflows["ci.yml"], registry, "push + sign (KMS)", EDGE + ends(0.5, 0, 1, 0.5),
        points=[(165, 60), (1960, 60), (1960, 345)],
    )
    p.edge(eso, api_server, "writes Secrets", EDGE + ends(x_on(1025, 870, 280), 0, x_on(1025, 380, 1110), 1), label_offset=(0, 55))
    p.edge(api_server, policy_controller, "signature webhook", EDGE + ends(x_on(1260, 380, 1110), 1, x_on(1260, 1180, 280), 0), label_offset=(0, 55))
    p.edge(policy_controller, kms, "verify signature", EDGE + ends(1, 0.5, 0, 0.5), points=[(1560, 1090), (1560, 485)])
    p.edge(
        eso, secret_manager, "read (Workload Identity)", EDGE + ends(0.5, 1, 0, 0.5),
        points=[(1010, 1190), (1575, 1190), (1575, 595)],
    )

    p.vertex(
        20, 1280, 1920, 76,
        wrap(
            "One execution, in order: ① A person or pipeline calls the console, which checks team membership, identity, team secrets "
            "and images. ② The console forwards the DAG to kernel-api, which validates it and stores it (PENDING). ③ kernel-scheduler "
            "claims READY tasks from Postgres. ④ For each, it creates a ConfigMap holding request.json, and a Job, through the API server, "
            "whose admission policies can refuse them (DISPATCH_REJECTED, IMAGE_NOT_ALLOWED, IMAGE_NOT_SIGNED, IDENTITY_NOT_ALLOWED). ⑤ The Pod "
            "runs as its product's ServiceAccount with the team Secrets its step lists and writes result.json; the scheduler reads it, stores outputs and logs, "
            "releases the tasks that waited on it, and once that's committed deletes the Job. kernel-api and kernel-scheduler never call each other: "
            "Postgres rows are their only channel. Where the gateway is on (the kind values; not vennir-gke, so it's dashed), an API product is called "
            "through execution-gateway instead, which forwards only what its reviewed OpenAPI document describes, to its backend.",
            260,
        ),
        NOTE,
    )
    return p


# ------------------------------------------------------ page 6: the pieces


def pieces_page() -> Page:
    """The pieces at a glance, for docs/architecture.md: as wide as the docs' reading column, so it's shown at full size."""
    p = Page("6 · The pieces")
    p.vertex(0, 0, 300, 150, "Catalog repository · one per organization", frame(GREY, dashed=False))
    p.titled(15, 32, 270, 48, "teams/<team>/products/<product>", "product.yaml · Dockerfile · actions · tests", GREY)
    ci = p.titled(15, 90, 270, 48, "CI (./vennir)", "build → test → scan → sign → push, then release", GREY)
    registry = p.vertex(345, 30, 170, 95, "Registry\nproduct images\nsigned catalog-release", database(BLUE))
    people = p.titled(570, 40, 170, 70, "People and bots", "the console, its API,\nteams' pipelines", WHITE)

    p.vertex(0, 185, 760, 465, "Kubernetes cluster", frame(BLUE, dashed=False))
    p.vertex(20, 220, 720, 215, "vennir-system · the platform", frame(ORANGE))
    scheduler = p.titled(40, 255, 190, 72, "kernel-scheduler", "claims ready steps,\nstarts and watches them", ORANGE)
    kernel_api = p.titled(285, 255, 190, 72, "kernel-api", "validates and stores DAGs;\nanswers only the console", ORANGE)
    console = p.titled(530, 255, 190, 72, "console", "UI + API: signs people in,\nauthorizes every request", ORANGE)
    kernel_db = p.vertex(178, 350, 155, 72, "kernel\nPostgres", database(YELLOW))
    console_db = p.vertex(548, 350, 155, 72, "console\nPostgres", database(YELLOW))
    gateway = p.titled(375, 350, 150, 72, "gateway", "serves API products,\nas their OpenAPI allows", ORANGE)

    p.vertex(20, 455, 420, 180, "Team namespaces · labelled vennir/team=true", frame(GREEN))
    job = p.titled(40, 490, 380, 62, "One Job per step attempt", "its product's image · its inputs as a\nConfigMap · the secrets it lists", GREEN)
    backend = p.titled(40, 567, 380, 55, "API backends", "an API product's in-cluster Service", GREEN)
    policies = p.titled(530, 472, 210, 90, "Admission policies", "where steps may run, which\nimages (pinned, scanned,\nsigned), identity and secrets", RED)

    p.edge(ci, registry, "push", EDGE + ends(1, 0.5, 0, 0.6))
    p.edge(people, console, "sign in, order, run", EDGE + ends(0.5, 1, 0.65, 0), label_offset=(0, -38))
    p.edge(registry, console, "each console pulls the release", EDGE + ends(0.5, 1, 0.3, 0), points=[(430, 165), (587, 165)], label_offset=(-75, 0))
    p.edge(console, kernel_api, "DAGs", EDGE + ends(0, 0.5, 1, 0.5))
    p.edge(console, console_db, "", EDGE + ends(0.5, 1, 0.5, 0))
    p.edge(kernel_api, kernel_db, "", EDGE + ends(0.25, 1, 0.75, 0))
    p.edge(scheduler, kernel_db, "", EDGE + ends(0.75, 1, 0.25, 0) + "startArrow=block;startFill=1;")
    p.edge(scheduler, job, "creates Jobs", EDGE + ends(0.5, 1, x_of(135, 40, 380), 0))
    p.edge(policies, job, "check every Job", EDGE + ends(0, 0.6, 1, 0.5) + "dashed=1;")
    p.edge(gateway, console_db, "", EDGE + ends(1, 0.5, 0, 0.5))
    p.edge(
        people, gateway, "call APIs", EDGE + ends(0, 0.85, x_of(520, 375, 150), 0),
        points=[(520, 100)], label_offset=(0, 10),
    )
    p.edge(gateway, backend, "", EDGE + ends(0.5, 1, 1, 0.5), points=[(450, 595)])
    return p


def x_of(x: float, left: float, width: float) -> float:
    """Where x is across a box, 0 to 1: for an edge's end."""
    return (x - left) / width


# ---------------------------------------------------- page 4: sequence


def sequence_page() -> Page:
    p = Page("4 · Submit to finished")
    p.vertex(20, 10, 1600, 30, "One execution, function by function", TITLE)
    p.vertex(
        20, 40, 1900, 24,
        "A one-task DAG submitted through the console, from ExecutionService/SubmitExecution to SUCCEEDED. Solid arrows are calls, dashed are returns.",
        SUBTITLE,
    )
    lifelines = [
        ("Pipeline or browser", GREY),
        ("console\ncore/executions.ts", ORANGE),
        ("console DB\ndb/queries.ts", YELLOW),
        ("kernel-api\ninternal/api/auth.go", BLUE),
        ("KernelService\ninternal/api/service.go", BLUE),
        ("kernel DB\ninternal/migrate/sql/", YELLOW),
        ("kernel-scheduler (Go)\ninternal/scheduler/tick.go", ORANGE),
        ("executor.Kubernetes\ninternal/executor", RED),
        ("Kubernetes API\n+ admission", BLUE),
        ("product container", GREEN),
    ]
    spacing, width, top, bottom = 200, 170, 90, 1460
    xs = []
    for i, (name, color) in enumerate(lifelines):
        x = 30 + i * spacing
        fill, stroke = color
        p.vertex(
            x, top, width, bottom - top, name,
            "shape=umlLifeline;perimeter=lifelinePerimeter;container=0;collapsible=0;recursiveResize=0;"
            f"outlineConnect=0;size=50;fillColor={fill};strokeColor={stroke};{FONT}fontSize=11;",
        )
        xs.append(x + width / 2)

    y = top + 80.0
    step = 0

    def message(a: int, b: int, label: str, *, reply: bool = False) -> None:
        nonlocal y, step
        step += 1
        extra_lines = label.count("\n")
        y += extra_lines * 14  # a multi-line label grows upwards from its arrow
        style = (
            "verticalAlign=bottom;align=left;spacingLeft=4;labelBackgroundColor=#ffffff;"
            + ("endArrow=open;dashed=1;endSize=8;" if reply else "endArrow=block;endFill=1;")
            + f"{FONT}fontSize=11;"
        )
        value = f"{step}. {label}"
        if a == b:
            p.edge(
                None, None, value, style + "edgeStyle=none;", points=[(xs[a] + 30, y), (xs[a] + 30, y + 16)],
                source_point=(xs[a], y), target_point=(xs[a] + 3, y + 16),
            )
            y += 46
        else:
            p.edge(None, None, value, style, source_point=(xs[a], y), target_point=(xs[b], y))
            y += 36

    def fragment(label: str, start: float, end: float, first: int, last: int, color: str) -> None:
        p.vertex(
            xs[first] - 95, start, xs[last] - xs[first] + 190, end - start, label,
            f"fillColor=none;dashed=1;strokeColor={color};align=left;verticalAlign=top;spacingLeft=6;fontStyle=1;{FONT}fontSize=11;",
        )

    message(0, 1, "POST /api/vennir.console.v1.ExecutionService/SubmitExecution {dag: {name, requestId?, tasks}}")
    message(1, 1, "resolveCaller: session JWT or bot token → caller {teamNames, isAdmin, scopes} · requireCaller, audit (interceptors)")
    message(
        1, 1,
        "withProductIdentities · authorizeTasks: a member of each task's team?\n"
        "team not retired? runs as its product's identity (identityRefusal)? each secretRef its team's? (isSecretRegistered)",
    )
    message(1, 1, "refuseBlockedImages: image policy · registry (registry.ts) · pinned: tag → digest · refuseUnscanned: scan verdicts")
    message(1, 1, 'withProductResources · scopeRequestId → requestId "team-a+team-b/<requestId>" · ensureServiceAccounts')
    message(1, 3, "kernel/client.ts submitExecution: the JSON as a request (only the names checked) → KernelService/SubmitExecution")
    message(3, 4, "Callers.Interceptor: the console's token? (TokenReview, cached 60 s) → SubmitExecution")
    message(4, 5, "SELECT by idempotency_key: seen before? return it (created false, no new rows)")
    message(
        4, 4,
        "taskDefs: each field · domain.ValidateDAG: duplicate ids, unknown dependencies, cycles, $fromTask references\n"
        "each task READY (no dependencies), AWAITING_APPROVAL (no dependencies, needs one) or BLOCKED",
    )
    message(4, 5, "a savepoint: INSERT executions, execution_tasks, task_dependencies · recordEvent EXECUTION_CREATED")
    message(4, 1, "{executionId, state: PENDING, created: true}", reply=True)
    message(1, 2, "recordOrCancel: recordSubmittedExecution(executionId, teams, submittedBy, name, payload)")
    message(1, 0, "{executionId, state: EXECUTION_STATE_PENDING}", reply=True)

    y += 10
    loop_start = y
    y += 36
    message(
        6, 5,
        "Loop.Run → pgx.BeginFunc → DispatchPass (after RecordPass commits) → claimReadyTasks:\n"
        "recoverExpiredLeases; SELECT READY … FOR UPDATE SKIP LOCKED;\n"
        "→ CLAIMED, lease_owner, attempt_count+1, task_attempts row, TASK_CLAIMED",
    )
    message(6, 5, "dispatch → resolveInputs: $fromTask → upstream task_outputs (domain.ResolveInputs)")
    message(6, 7, "Start(ResolvedTask)")
    message(7, 8, "createJob ek-…: args=[action], serviceAccount, secret volumes · createConfigMap ek-…: request.json, owned by the Job")
    message(
        8, 8,
        "admission: dispatch-policy · image-policy · identity-policy · image signature (GKE)\n"
        "refused → DispatchRejected → task FAILED, not retried",
    )
    message(8, 9, "Pod starts, reads /platform/input/request.json")
    message(7, 6, "handle {namespace, jobName}", reply=True)
    message(6, 5, "recordStart: task RUNNING · TASK_STARTED · markExecutionRunning (execution RUNNING)")
    message(9, 9, "does the work; writes /platform/output/result.json (read back as the termination message)")
    poll_start = y
    y += 30
    message(6, 6, "next pass: its RUNNING tasks → poll: execution cancelled? past timeout_seconds?")
    message(6, 7, "Status(handle)   (skipped while the watch saw no change)")
    message(7, 8, "GET the Job: still running → RUNNING (lease_expires_at extended; logs every 60 s)")
    fragment("loop  [while the Job runs: one poll per pass; a watched change wakes the loop]", poll_start - 6, y - 10, 6, 9, "#d79b00")
    y += 16
    message(7, 8, "finalize: terminatedContainer · readLogs (redacted) · buildStatus (domain.ParseTaskResult)")
    message(7, 6, "Status Succeeded + outputs   (or Failed + StructuredError)", reply=True)
    message(
        6, 5,
        "task_outputs · captureLogs → task_logs · TASK_SUCCEEDED\n"
        "releaseReadyDependents (BLOCKED → READY, or AWAITING_APPROVAL, once every dependency SUCCEEDED) · settleExecution",
    )
    message(6, 7, "once the pass has committed: ReleaseFinished → Release(handle)")
    message(7, 8, "deleteJob · deleteConfigMap")
    alt_start = y
    y += 30
    message(
        6, 5,
        "failed: handleFailure → ShouldRetry? READY again after the backoff (claimed by a later pass)\n"
        "otherwise FAILED → failExecution (execution FAILED; its READY/BLOCKED/AWAITING_APPROVAL tasks CANCELLED)",
    )
    fragment("alt  [the task failed instead]", alt_start - 6, y - 10, 5, 6, "#b85450")
    fragment("loop  [kernel-scheduler: a pass at once after progress, else on a watched change or the poll interval (1 s)]", loop_start, y + 4, 5, 9, "#555555")
    y += 40
    message(0, 1, "WatchExecution {executionId} (loadExecution: a member of any of its teams, re-checked on every read)")
    message(1, 4, "every 2 s: executionDetail → getExecution → KernelService/GetExecution")
    message(4, 1, "state, tasks [state, attempts, outputs, failure, dependsOn]", reply=True)
    message(1, 0, "the execution, each time it changes, until it finishes (a stream)", reply=True)
    return p


# ------------------------------------------------------- page 5: states


def states_page() -> Page:
    p = Page("5 · States")
    p.vertex(20, 10, 1200, 30, "Task and execution states", TITLE)
    p.vertex(
        20, 40, 1500, 24,
        "kernel/internal/domain/states.go defines them; the scheduler (internal/scheduler/claiming.go, tick.go) and kernel-api (internal/api/service.go) move them.",
        SUBTITLE,
    )
    state_style = "rounded=1;arcSize=40;fontStyle=1;" + FONT
    start_style = "ellipse;fillColor=#000000;strokeColor=none;"

    def node(x: float, y: float, name: str, color: tuple[str, str]) -> str:
        return p.vertex(x, y, 140, 50, name, state_style + f"fillColor={color[0]};strokeColor={color[1]};")

    p.vertex(40, 90, 1260, 670, "Task  (execution_tasks.state)", frame(GREY, dashed=False))
    start = p.vertex(80, 333, 24, 24, "", start_style)
    blocked = node(180, 180, "BLOCKED", GREY)
    ready = node(180, 470, "READY", BLUE)
    claimed = node(500, 470, "CLAIMED", YELLOW)
    running = node(820, 470, "RUNNING", ORANGE)
    succeeded = node(1100, 300, "SUCCEEDED", GREEN)
    failed = node(1100, 640, "FAILED", RED)
    cancelled = node(500, 180, "CANCELLED", GREY)
    awaiting = node(330, 325, "AWAITING_APPROVAL", YELLOW)
    p.edge(start, blocked, "has dependencies", EDGE + ends(0.5, 0, 0, 0.5))
    p.edge(start, ready, "no dependencies", EDGE + ends(0.5, 1, 0, 0.5))
    p.edge(blocked, ready, "", EDGE + ends(0.3, 1, 0.3, 0))
    p.vertex(
        106, 384, 112, 64, "every dependency\nSUCCEEDED (release-\nReadyDependents)",
        "text;align=right;verticalAlign=middle;" + FONT + "fontSize=11;",
    )
    p.edge(ready, claimed, "claimReadyTasks:\nlease, attempt_count+1", EDGE + ends(1, 0.5, 0, 0.5))
    p.edge(claimed, running, "dispatch:\nStart ok", EDGE + ends(1, 0.5, 0, 0.5))
    p.edge(running, succeeded, "Status Succeeded", EDGE + ends(1, 0.3, 0, 0.5), points=[(1040, 485), (1040, 325)])
    p.edge(running, failed, "failed, no retry left,\nor not retryable", EDGE + ends(0.7, 1, 0, 0.2), points=[(918, 650)])
    p.edge(
        claimed, failed, "start refused: DISPATCH_REJECTED,\nIMAGE_NOT_ALLOWED, MISSING_UPSTREAM_OUTPUT",
        EDGE + ends(0.7, 1, 0, 0.8), points=[(598, 680)],
    )
    p.edge(
        running, ready, "failed but retryable (ShouldRetry; after the backoff)",
        EDGE + ends(0.3, 1, 0.5, 1), points=[(862, 600), (250, 600)],
    )
    p.edge(claimed, ready, "lease expired", EDGE + ends(0.3, 1, 0.75, 1), points=[(542, 560), (285, 560)])
    p.edge(failed, ready, "RetryTask (AWAITING_APPROVAL instead, if not yet approved)", EDGE + ends(1, 0.5, 0.15, 1), points=[(1270, 665), (1270, 730), (201, 730)])
    p.edge(
        ready, cancelled, "execution cancelled, or another\ntask failed (failExecution)",
        EDGE + ends(0.75, 0, 0.15, 1), points=[(285, 400), (521, 400)],
    )
    p.edge(blocked, cancelled, "same reasons", EDGE + ends(1, 0.5, 0, 0.5))
    p.edge(start, awaiting, "", EDGE + ends(1, 0.5, 0, 0.4))
    p.vertex(228, 300, 100, 44, "no dependencies,\nneeds an approval", "text;align=center;verticalAlign=middle;" + FONT)
    p.edge(blocked, awaiting, "dependencies done,\nnot yet approved", EDGE + ends(0.8, 1, 0.3, 0))
    p.edge(awaiting, ready, "approved\n(DecideApproval)", EDGE + ends(0.3, 1, 0.6, 0))
    p.edge(
        awaiting, failed, "declined (APPROVAL_DECLINED), or nobody decided\nin time (APPROVAL_EXPIRED: expireApprovals)",
        EDGE + ends(1, 0.9, 0.57, 0), points=[(1180, 370)],
    )
    p.edge(awaiting, cancelled, "same reasons", EDGE + ends(0.5, 0, 0.5, 1), points=[(400, 280), (570, 280)])
    p.edge(running, cancelled, "execution cancelled\n(next poll cancels the Job)", EDGE + ends(0.5, 0, 1, 0.5))
    p.edge(
        cancelled, blocked, "a retry revives it (RetryTask)",
        EDGE + ends(0.5, 0, 0.5, 0) + "dashed=1;", points=[(570, 130), (250, 130)],
    )

    p.vertex(40, 790, 1260, 320, "Execution  (executions.state)", frame(GREY, dashed=False))
    e_start = p.vertex(80, 893, 24, 24, "", start_style)
    pending = node(180, 880, "PENDING", GREY)
    e_running = node(500, 880, "RUNNING", ORANGE)
    e_succeeded = node(860, 820, "SUCCEEDED", GREEN)
    e_failed = node(860, 960, "FAILED", RED)
    e_cancelled = node(340, 1010, "CANCELLED", GREY)
    p.edge(e_start, pending, "SubmitExecution", EDGE)
    p.edge(pending, e_running, "first task dispatched\n(markExecutionRunning)", EDGE)
    p.edge(e_running, e_succeeded, "every task SUCCEEDED\n(settleExecution)", EDGE + ends(1, 0.3, 0, 0.5))
    p.edge(e_running, e_failed, "a task FAILED\n(failExecution)", EDGE + ends(1, 0.8, 0, 0.5))
    p.edge(
        e_failed, e_running, "RetryTask (EXECUTION_RESUMED)",
        EDGE + ends(0.5, 1, 0.8, 1) + "dashed=1;", points=[(930, 1080), (612, 1080)],
    )
    p.edge(pending, e_cancelled, "CancelExecution", EDGE + ends(0.5, 1, 0, 0.5))
    p.edge(e_running, e_cancelled, "CancelExecution", EDGE + ends(0.3, 1, 1, 0.5))
    p.vertex(
        1050, 890, 230, 80, "SUCCEEDED, FAILED and CANCELLED\nare terminal, except that\nRetryTask re-opens a FAILED one.",
        NOTE + "fontSize=11;",
    )
    return p


# ------------------------------------------------------------------ main


def main() -> None:
    kernel, kernel_imports = kernel_packages()
    kernel_page = Page("2 · Kernel types")
    draw_packages(
        kernel_page,
        "Kernel (kernel/cmd, kernel/internal; Go): every file, type and function",
        "Generated from the source by docs/architecture/generate.py.  + exported, - unexported.  An interface lists its methods; a struct its fields.",
        kernel,
        kernel_imports,
    )
    console, console_imports = console_packages()
    console_page = Page("3 · Console classes")
    draw_packages(
        console_page,
        "Console (console/src, console/frontend/src): every module and function",
        "Generated from the source by docs/architecture/generate.py.  + exported, - module-private.  «route» lines are the HTTP routes a module registers.",
        console,
        console_imports,
    )
    pages = [system_page(), kernel_page, console_page, sequence_page(), states_page(), pieces_page()]
    DRAWIO_FILE.write_text(
        '<mxfile host="Electron" agent="docs/architecture/generate.py">'
        + "".join(page.xml(i) for i, page in enumerate(pages))
        + "</mxfile>\n"
    )
    print(f"wrote {DRAWIO_FILE.relative_to(ROOT)}")

    cli = next((c for c in DRAWIO_CLI if c and Path(c).exists()), None)
    if cli is None:
        print("draw.io's CLI isn't installed, so no SVGs were exported")
        return
    for i, page in enumerate(pages):
        slug = re.sub(r"[^a-z]+", "-", page.name.split("·", 1)[1].lower()).strip("-")
        out = HERE / f"{i + 1}-{slug}.svg"
        # Pages are numbered from 1 (draw.io 27+).
        subprocess.run(
            [cli, "--export", "--format", "svg", "--page-index", str(i + 1), "--theme", "light", "--output", str(out), str(DRAWIO_FILE)],
            check=True, capture_output=True,
        )
        print(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
