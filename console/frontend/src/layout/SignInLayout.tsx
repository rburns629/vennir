// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/material/styles";
import { useEnvironment } from "../environment";

// A run, over and over, a different one each time on the same 6 s clock:
// either top step may go first, the bottom one may feed both, or the run
// may pass through it either way. A step starts running as its first line
// sets out or a line reaches it, whichever comes first, and every step
// runs until the lines fade. Times in seconds of the cycle.
const CYCLE = 6;
const pct = (seconds: number) => `${String(Math.round((seconds / CYCLE) * 1000) / 10)}%`;
const FADE = { from: 4.8, to: 5.4 };
const STOP = (FADE.from + FADE.to) / 2;
const DRAW = 1.2;

/** A line drawn from `from` to `to`, held, then faded with the others. */
const drawn = (from: number, to: number) => keyframes`
  0%, ${pct(from)} { stroke-dashoffset: 1; opacity: 1; }
  ${pct(to)}, ${pct(FADE.from)} { stroke-dashoffset: 0; opacity: 1; }
  ${pct(FADE.to)}, 100% { stroke-dashoffset: 0; opacity: 0; }
`;

/** While a step runs (`from` to `to`): it grows, its ring dims to a track, and an arc spins round it. */
function running(from: number, to: number) {
  const ease = 0.15;
  const window = (rest: string, on: string) => keyframes`
    0%, ${pct(from)} { ${rest} }
    ${pct(from + ease)}, ${pct(to - ease)} { ${on} }
    ${pct(to)}, 100% { ${rest} }
  `;
  return {
    grow: window("transform: scale(1);", "transform: scale(1.25);"),
    track: window("stroke-opacity: 1;", "stroke-opacity: 0.3;"),
    arc: window("opacity: 0;", "opacity: 1;"),
  };
}

const spin = keyframes`to { transform: rotate(360deg); }`;
const rise = keyframes`from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; }`;

type Node = "left" | "right" | "bottom";
const AT: Record<Node, { x: number; y: number }> = { left: { x: 40, y: 40 }, right: { x: 200, y: 40 }, bottom: { x: 120, y: 160 } };
/** A line from one step to another, setting out at `at`. */
interface Edge {
  from: Node;
  to: Node;
  at: number;
}

/** The runs to choose between: the two lines, each one way or the other, in some order. */
const SHAPES: Edge[][] = [
  [{ from: "left", to: "bottom", at: 0.3 }, { from: "right", to: "bottom", at: 0.9 }],
  [{ from: "right", to: "bottom", at: 0.3 }, { from: "left", to: "bottom", at: 0.9 }],
  [{ from: "bottom", to: "left", at: 0.3 }, { from: "bottom", to: "right", at: 0.9 }],
  [{ from: "bottom", to: "right", at: 0.3 }, { from: "bottom", to: "left", at: 0.9 }],
  [{ from: "left", to: "bottom", at: 0.3 }, { from: "bottom", to: "right", at: 0.3 + DRAW }],
  [{ from: "right", to: "bottom", at: 0.3 }, { from: "bottom", to: "left", at: 0.3 + DRAW }],
];

/** Each shape's lines and steps, as keyframes made once. */
const RUNS = SHAPES.map((edges) => ({
  lines: edges.map((e) => ({ ...e, frames: drawn(e.at, e.at + DRAW) })),
  steps: (Object.keys(AT) as Node[]).map((node) => {
    const starts = edges.flatMap((e) => (e.from === node ? [e.at] : e.to === node ? [e.at + DRAW] : []));
    return { node, run: running(Math.min(...starts), STOP) };
  }),
}));

/** Another shape than the last. */
const next = (last: number) => (last + 1 + Math.floor(Math.random() * (RUNS.length - 1))) % RUNS.length;

const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };
// Once: the drawing is drawn afresh, with another run, every cycle.
const once = (frames: string) => `${frames} ${String(CYCLE)}s cubic-bezier(.4,0,.2,1) both`;

/** A step: a ring that, while it runs, grows into a spinning status wheel. */
function Step({ cx, cy, run }: { cx: number; cy: number; run: ReturnType<typeof running> }) {
  return (
    <Box component="g" sx={{ transformBox: "fill-box", transformOrigin: "center", animation: once(run.grow), ...still }}>
      <Box component="circle" cx={cx} cy={cy} r={16} fill="#232833" stroke="currentColor" strokeWidth={3} sx={{ animation: once(run.track), ...still }} />
      <Box component="g" sx={{ opacity: 0, animation: once(run.arc), ...still }}>
        <Box
          component="circle"
          cx={cx}
          cy={cy}
          r={16}
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="0.28 0.72"
          sx={{ transformBox: "fill-box", transformOrigin: "center", animation: `${spin} 0.9s linear infinite`, ...still }}
        />
      </Box>
    </Box>
  );
}

/** Two lines joining three steps, run over and over as a DAG runs, a different way each time. Still for reduced motion. */
function Dag() {
  const [shape, setShape] = useState(() => Math.floor(Math.random() * RUNS.length));
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setShape(next(shape));
      setCycle(cycle + 1);
    }, CYCLE * 1000);
    return () => { clearTimeout(timer); };
  }, [shape, cycle]);

  const { lines, steps } = RUNS[shape] ?? RUNS[0]!;
  const edge = (frames: string) => ({
    strokeDasharray: 1,
    strokeDashoffset: 1,
    animation: once(frames),
    "@media (prefers-reduced-motion: reduce)": { strokeDashoffset: 0, animation: "none" },
  });
  return (
    // Keyed by the cycle, so every animation in it starts over.
    <Box key={cycle} component="svg" viewBox="0 0 240 200" sx={{ width: 200, height: "auto", color: "sidebar.accent", overflow: "visible" }} aria-hidden="true">
      {lines.map((l) => (
        <Box
          key={`${l.from}-${l.to}`}
          component="path"
          pathLength={1}
          d={`M${String(AT[l.from].x)} ${String(AT[l.from].y)} L${String(AT[l.to].x)} ${String(AT[l.to].y)}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          sx={edge(l.frames)}
        />
      ))}
      {steps.map((s) => (
        <Step key={s.node} cx={AT[s.node].x} cy={AT[s.node].y} run={s.run} />
      ))}
    </Box>
  );
}

/**
 * The screens before the console proper (signing in, registering, choosing
 * your own password): what Vennir is on one side, the form on the other.
 * On a phone the panel shrinks to a strip above the form.
 */
export function SignInLayout({ children }: { children: ReactNode }) {
  const environment = useEnvironment();
  const appear = { animation: `${rise} .55s cubic-bezier(.2,.7,.2,1) both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } };
  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: { xs: "column", md: "row" }, bgcolor: "background.default" }}>
      <Box
        component="section"
        aria-label="Vennir"
        sx={{
          flex: { md: "1 1 420px" },
          bgcolor: "sidebar.background",
          color: "sidebar.text",
          px: { xs: 2, md: 6 },
          py: { xs: 1.75, md: 6 },
          display: "flex",
          flexDirection: { xs: "row", md: "column" },
          alignItems: { xs: "center", md: "stretch" },
          justifyContent: "space-between",
          gap: { xs: 2, md: 4 },
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, color: "sidebar.textStrong", fontWeight: 600, fontSize: 18 }}>
          <Box component="svg" viewBox="0 0 24 24" sx={{ width: 22, height: 22, color: "sidebar.accent" }} aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="5" cy="6" r="2.5" />
              <circle cx="19" cy="6" r="2.5" />
              <circle cx="12" cy="18" r="2.5" />
              <path d="M7 7.5l3.5 8.5M17 7.5l-3.5 8.5" />
            </g>
          </Box>
          Vennir
        </Box>
        <Box sx={{ display: { xs: "none", md: "flex" }, flexDirection: "column", gap: 3, maxWidth: 460, my: "auto" }}>
          <Dag />
          <Typography component="h1" sx={{ fontSize: 32, lineHeight: 1.2, fontWeight: 600, color: "sidebar.textStrong", ...appear }}>
            Run what your platform teams publish, safely.
          </Typography>
          <Typography sx={{ fontSize: 15, lineHeight: 1.6, color: "sidebar.textMuted", ...appear, animationDelay: "120ms" }}>
            Every step runs as its own team&apos;s reviewed product, with its own identity and secrets. You bring the inputs.
          </Typography>
        </Box>
        <Typography sx={{ fontSize: 12, color: "sidebar.textMuted", fontFamily: "fontFamilyMono", minHeight: "1em", overflowWrap: "anywhere" }}>
          {environment?.label}
        </Typography>
      </Box>
      <Box component="main" sx={{ flex: "1 1 420px", display: "flex", alignItems: "center", justifyContent: "center", px: 3, py: { xs: 4, md: 6 } }}>
        <Box
          sx={{
            width: "100%",
            maxWidth: 400,
            bgcolor: "background.paper",
            border: 1,
            borderColor: "divider",
            borderRadius: 2.5,
            p: 4,
            boxSizing: "border-box",
            ...appear,
            animationDelay: "80ms",
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
}
