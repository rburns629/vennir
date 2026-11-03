// SPDX-License-Identifier: MIT
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import CartIcon from "@mui/icons-material/ShoppingCartOutlined";
import CheckIcon from "@mui/icons-material/Check";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import LockIcon from "@mui/icons-material/LockOutlined";
import { ApiError, errorMessage, listAllTeams, listProducts, listRunnables, previewOrder, submitExecution, type OrderOption, type OrderProblem, type Product, type Runnable } from "../api";
import { useAuth } from "../auth/AuthContext";
import { useCart } from "../cart";
import { CheckStrip, type Check } from "../components/CheckStrip";
import { CodeBlock } from "../components/CodeBlock";
import { NotForThisInstall, isNotForThisInstall, refusedProduct } from "../components/Clouds";
import { HelpLink } from "../components/HelpLink";
import { OrderChoice, sameInput } from "../components/OrderChoice";
import { Pill } from "../components/Pill";
import { readinessSentence } from "../components/ReadinessNote";
import { ReadinessPill } from "../components/ReadinessPill";
import { useEnvironment } from "../environment";
import { actionRef, candidates, dagOf, hasParameters, inputsOf, newStep, problems, proposeUrl, stepsFromOrder, templateYaml, type ComposeStep, type Draft, type InputSource } from "../compose";
import { when } from "../time";
import { draftOf, useComposeDrafts } from "./useComposeDrafts";

/** "value", "parameter", "unset", or "<step>/<output>", for the source select. */
const sourceKey = (s: InputSource) => (s.kind === "step" ? `${s.step}/${s.output}` : s.kind);

const productName = (p: Product | undefined, fallback: string) => p?.displayName ?? p?.name ?? fallback;

/** What a step asks for and is given, in a line: its values and what's asked when it runs (wiring is shown between the steps). */
function asksOf(step: ComposeStep): string {
  const parts: string[] = [];
  const asked = Object.entries(step.inputs).filter(([, s]) => s.kind === "parameter").map(([n]) => n);
  if (asked.length > 0) parts.push(`${asked.join(" and ")} asked when it runs`);
  for (const [name, s] of Object.entries(step.inputs)) if (s.kind === "value" && s.value !== "") parts.push(`${name} ${s.value}`);
  return parts.join(" · ");
}

/** What a step takes from earlier ones, in a line: "project from step 1 · database from step 3". */
function linksOf(step: ComposeStep, steps: ComposeStep[]): string {
  return Object.entries(step.inputs)
    .flatMap(([name, s]) => {
      if (s.kind !== "step") return [];
      const n = steps.findIndex((x) => x.id === s.step);
      return [`${name} from ${n >= 0 ? `step ${String(n + 1)}` : s.step}`];
    })
    .join(" · ");
}

/** The steps, in order: each a card to select, what it takes from earlier ones between them. */
function StepList({
  draft,
  products,
  selected,
  added,
  onSelect,
}: {
  draft: Draft;
  products: Map<string, Product>;
  selected: number | null;
  added: Set<string>;
  onSelect: (i: number) => void;
}) {
  if (draft.steps.length === 0) {
    return (
      <Card sx={{ p: 3 }}>
        <Typography variant="body2" color="text.secondary">
          No steps yet. Add one from Add a step, or build them from a cart above.
        </Typography>
      </Card>
    );
  }
  return (
    <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column" }}>
      {draft.steps.map((step, i) => {
        const product = products.get(step.product);
        const link = linksOf(step, draft.steps);
        const on = selected === i;
        return (
          <Box component="li" key={`${step.id}-${String(i)}`} sx={{ display: "flex", flexDirection: "column" }}>
            {link && (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, py: 0.75, pl: 2.75, fontSize: 12, color: "text.secondary" }}>
                <Box aria-hidden="true" sx={{ width: 2, height: 22, bgcolor: "tint.field" }} />
                <span>{link}</span>
              </Box>
            )}
            {!link && i > 0 && <Box sx={{ height: 12 }} />}
            <Box
              component="button"
              type="button"
              aria-pressed={on}
              onClick={() => { onSelect(i); }}
              sx={{
                all: "unset",
                boxSizing: "border-box",
                cursor: "pointer",
                display: "flex",
                gap: 1.75,
                alignItems: "flex-start",
                bgcolor: "background.paper",
                borderRadius: "10px",
                px: 2,
                py: 1.75,
                border: 1,
                borderColor: on ? "primary.main" : "divider",
                boxShadow: on ? (t) => `0 0 0 3px ${t.palette.info.light}` : "none",
                "&:hover": { borderColor: on ? "primary.main" : "tint.infoBorder" },
                "&:focus-visible": { outline: (t) => `2px solid ${t.palette.primary.main}`, outlineOffset: 2 },
              }}
            >
              <Box
                sx={{ flex: "0 0 28px", height: 28, borderRadius: "50%", bgcolor: on ? "primary.main" : "info.light", color: on ? "primary.contrastText" : "info.main", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                {i + 1}
              </Box>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375, minWidth: 0, flex: "1 1 auto" }}>
                <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{productName(product, step.product)}</Typography>
                <Typography sx={{ fontFamily: "fontFamilyMono", fontSize: 12, color: "text.secondary", overflowWrap: "anywhere" }}>
                  {step.id}
                  {product && ` · ${actionRef(product, draft.team)}`}
                </Typography>
                {asksOf(step) && <Typography sx={{ fontSize: 12, overflowWrap: "anywhere" }}>{asksOf(step)}</Typography>}
              </Box>
              <Box sx={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0.75 }}>
                {product?.deprecated ? <Pill tone="warning" title={product.deprecated}>Deprecated</Pill> : product?.readiness ? <ReadinessPill readiness={product.readiness} /> : null}
                {added.has(step.id) && <Typography sx={{ fontSize: 11, color: "info.main" }}>added by wiring</Typography>}
              </Box>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** The selected step: its id, each input's source, and what its team set (identity, secrets, readiness here). */
function StepInspector({
  index,
  draft,
  products,
  install,
  onChange,
  onRemove,
}: {
  index: number;
  draft: Draft;
  products: Map<string, Product>;
  install: string;
  onChange: (step: ComposeStep) => void;
  onRemove: () => void;
}) {
  const step = draft.steps[index];
  if (!step) return null;
  const product = products.get(step.product);
  const set = (name: string, source: InputSource) => { onChange({ ...step, inputs: { ...step.inputs, [name]: source } }); };
  const readiness = readinessSentence(product?.readiness ?? null, install);
  return (
    <Card component="section" aria-label={`Step ${String(index + 1)}`} sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 2, borderColor: "tint.infoBorder" }}>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 12 }}>
          Step {index + 1}
          {product && ` · ${product.teamName ?? ""} · ${product.action}`}
        </Typography>
        <Typography variant="h6" component="h2" sx={{ fontSize: 17 }}>
          {productName(product, step.product)}
        </Typography>
      </Box>
      <TextField size="small" label="Step id" value={step.id} onChange={(e) => { onChange({ ...step, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }); }} slotProps={{ htmlInput: { sx: { fontFamily: "fontFamilyMono", fontSize: 13 } } }} />
      {product &&
        inputsOf(product).map((input) => {
          const source = step.inputs[input.name] ?? { kind: "unset" };
          const options = candidates(draft, products, index, input);
          const wired = source.kind === "step";
          return (
            <Box key={input.name} sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
              <TextField
                select
                size="small"
                label={`${input.name} · ${input.wiring ?? input.type}${input.required ? " · required" : ""}`}
                value={sourceKey(source)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "value") set(input.name, { kind: "value", value: "" });
                  else if (v === "parameter" || v === "unset") set(input.name, { kind: v });
                  else {
                    const [from = "", output = ""] = v.split("/");
                    set(input.name, { kind: "step", step: from, output });
                  }
                }}
                helperText={source.kind === "parameter" && source.name ? `Asked once, as ${source.name}, for every input of that type.` : source.kind !== "value" ? input.description || undefined : undefined}
                sx={wired ? { "& .MuiInputBase-root": { bgcolor: "tint.infoSurface" }, "& fieldset": { borderColor: "primary.main" } } : undefined}
              >
                <MenuItem value="unset">Not given</MenuItem>
                <MenuItem value="value">A value</MenuItem>
                <MenuItem value="parameter">Asked when it runs</MenuItem>
                {options.map((c) => (
                  <MenuItem key={`${c.step}/${c.output}`} value={`${c.step}/${c.output}`}>
                    From {c.step} → {c.output}
                    {c.match === "type" && " ✓ same type"}
                  </MenuItem>
                ))}
              </TextField>
              {source.kind === "value" && (
                <TextField size="small" label={`${input.name}'s value`} value={source.value} onChange={(e) => { set(input.name, { kind: "value", value: e.target.value }); }} helperText={input.description || undefined} />
              )}
            </Box>
          );
        })}
      {product && (
        <Box sx={{ borderTop: 1, borderColor: "tint.rule", pt: 1.75, display: "flex", flexDirection: "column", gap: 0.75, fontSize: 13 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 13 }}>Set by {product.teamName ?? "the platform"}</Typography>
          <Typography variant="body2" sx={{ fontSize: 13 }}>
            Runs as{" "}
            <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>
              {product.serviceAccount ?? "default"}
            </Box>
            , in {product.teamName ?? "its team"}&apos;s namespace
          </Typography>
          {product.secretRefs.length > 0 && (
            <Typography variant="body2" sx={{ fontSize: 13 }}>
              Secrets:{" "}
              <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>
                {product.secretRefs.join(", ")}
              </Box>{" "}
              (values hidden)
            </Typography>
          )}
          {readiness && (
            <Typography variant="body2" sx={{ fontSize: 13, color: product.readiness?.state === "not_ready" ? "error.dark" : "warning.main" }}>
              {readiness}
            </Typography>
          )}
          {product.deprecated && (
            <Typography variant="body2" sx={{ fontSize: 13, color: "warning.main" }}>
              Deprecated: {product.deprecated}
            </Typography>
          )}
        </Box>
      )}
      <Button variant="outlined" color="error" size="small" startIcon={<DeleteIcon />} onClick={onRemove} sx={{ alignSelf: "flex-start", minHeight: 36 }}>
        Remove the step
      </Button>
    </Card>
  );
}

/** Add a step: the actions shared with you, by team, and the ones that aren't (to ask for). */
function Palette({ choices, locked, onAdd }: { choices: Product[]; locked: Runnable[]; onAdd: (p: Product) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const byTeam = new Map<string, { add: Product[]; ask: Runnable[] }>();
    const group = (team: string) => byTeam.get(team) ?? byTeam.set(team, { add: [], ask: [] }).get(team) ?? { add: [], ask: [] };
    for (const p of choices) if (!q || `${productName(p, "")} ${p.name} ${p.action}`.toLowerCase().includes(q)) group(p.teamName ?? "").add.push(p);
    for (const r of locked) if (!q || `${r.displayName} ${r.name}`.toLowerCase().includes(q)) group(r.team).ask.push(r);
    return [...byTeam.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [choices, locked, q]);
  const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1.25, px: 1.25, py: 1, borderRadius: 2, border: 1, borderColor: "tint.rule" };
  return (
    <Card component="section" aria-label="Add a step" sx={{ p: 2.25, display: "flex", flexDirection: "column", gap: 1.5, minWidth: 0 }}>
      <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>
        Add a step
      </Typography>
      <TextField size="small" type="search" placeholder="Find an action" value={query} onChange={(e) => { setQuery(e.target.value); }} slotProps={{ htmlInput: { "aria-label": "Find an action" } }} />
      {groups.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
          {choices.length === 0 && locked.length === 0 ? "No actions are shared with you yet." : "Nothing matches."}
        </Typography>
      )}
      {groups.map(([team, { add, ask }]) => (
        <Box key={team} sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography sx={{ pt: 0.75, fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: "uppercase", color: "text.secondary" }}>{team || "Platform"}</Typography>
          {add.map((p) => (
            <Box key={p.name} sx={row}>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
                <Typography sx={{ fontSize: 13, fontWeight: 500, overflowWrap: "anywhere" }}>{productName(p, p.name)}</Typography>
                <Typography sx={{ fontSize: 11, color: "text.secondary" }}>{p.action}</Typography>
              </Box>
              <IconButton
                aria-label={`Add ${productName(p, p.name)} (${p.action})`}
                onClick={() => { onAdd(p); }}
                sx={{ flex: "0 0 36px", width: 36, height: 36, border: 1, borderColor: "tint.infoBorder", bgcolor: "tint.infoSurface", color: "info.main", borderRadius: "6px" }}
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
          {ask.map((r) => (
            <Box key={r.name} sx={{ ...row, bgcolor: "background.default" }}>
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25, minWidth: 0 }}>
                <Typography sx={{ fontSize: 13, fontWeight: 500, overflowWrap: "anywhere" }}>{r.displayName || r.name}</Typography>
                <Typography sx={{ fontSize: 11, color: "text.secondary" }}>not shared with you</Typography>
              </Box>
              {r.askForAccessUrl ? (
                <IconButton component="a" href={r.askForAccessUrl} target="_blank" rel="noopener noreferrer" aria-label={`Not shared with you: ask ${r.team} for ${r.displayName || r.name}`} title={`Not shared with you: ask ${r.team}`} sx={{ width: 36, height: 36 }}>
                  <LockIcon fontSize="small" />
                </IconButton>
              ) : (
                <LockIcon fontSize="small" aria-hidden="true" sx={{ color: "text.secondary", mx: 1 }} />
              )}
            </Box>
          ))}
        </Box>
      ))}
    </Card>
  );
}

/**
 * The order builder (decision 23): several actions at once, made into steps
 * by OrderService/PreviewOrder, each input wired to the one output of its
 * wiring type, a type's default provider added when nothing provides it,
 * and what it couldn't settle said, to fix in the steps.
 */
function BuildFromCart({
  team,
  opening,
  choices,
  initial,
  onBuilt,
}: {
  team: string;
  /** Counts drafts opened: wiring started for one draft never lands on the next. */
  opening: number;
  choices: Product[];
  /** The cart's actions, to start from (Use your cart, or ?cart=1). */
  initial: Product[] | null;
  onBuilt: (steps: ComposeStep[], problems: OrderProblem[], added: string[]) => void;
}) {
  const cartProducts = useMemo(() => initial ?? [], [initial]);
  const [selection, setSelection] = useState<Product[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What was last wired, the inputs it asked to choose for (kept, so a
  // choice can be changed), and what was chosen: each choice wires again.
  const [wired, setWired] = useState<{ actions: string[]; asked: OrderProblem[]; steps: number; added: string[]; problems: OrderProblem[] } | null>(null);
  const [picked, setPicked] = useState<OrderOption[]>([]);
  // Each wiring's number: only the latest one's answer is used, so arrowing
  // through choices, or opening another draft meanwhile, can't land an old one.
  const wiring = useRef(0);
  // A layout effect: it runs with the opening's own render, before any
  // answer still in flight can be read.
  useLayoutEffect(() => {
    wiring.current += 1;
    setWired(null);
    setPicked([]);
    setError(null);
    setBusy(false);
  }, [opening]);
  const [params] = useSearchParams();
  // ?cart=1 (the Catalog's and the cart's "build a template from it"): start from the cart.
  const fromCart = useRef(params.get("cart") === "1");
  useEffect(() => {
    if (fromCart.current && cartProducts.length > 0) {
      fromCart.current = false;
      setSelection(cartProducts);
    }
  }, [cartProducts]);

  async function wire(actions: string[], chosen: OrderOption[], asked: OrderProblem[]): Promise<void> {
    const mine = (wiring.current += 1);
    setBusy(true);
    setError(null);
    try {
      const built = await previewOrder(team, actions, chosen);
      if (mine !== wiring.current) return;
      const added = built.steps.filter((s) => s.added).map((s) => s.id);
      onBuilt(stepsFromOrder(built.steps), built.problems, added);
      const fresh = built.problems.filter((p) => p.options.length > 0 && !asked.some((a) => sameInput(a, p)));
      setWired({ actions, asked: [...asked, ...fresh], steps: built.steps.length, added: built.steps.filter((s) => s.added).map((s) => s.product), problems: built.problems.filter((p) => p.options.length === 0) });
    } catch (err) {
      if (mine === wiring.current) setError(errorMessage(err, "Couldn't wire them."));
    } finally {
      if (mine === wiring.current) setBusy(false);
    }
  }
  async function build(): Promise<void> {
    setPicked([]);
    await wire(selection.map((p) => p.name), [], []);
    setSelection([]);
  }
  function choose(o: OrderOption): void {
    if (!wired) return;
    const next = [...picked.filter((c) => !sameInput(c, o)), o];
    setPicked(next);
    void wire(wired.actions, next, wired.asked);
  }
  const nameOf = (product: string) => productName(choices.find((p) => p.name === product), product);
  return (
    <Card component="section" aria-label="Build from a cart" sx={{ px: { xs: 2, sm: 2.75 }, py: 2.5, display: "flex", flexDirection: "column", gap: 1.75 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 1.25 }}>
        <Typography variant="h6" component="h2" sx={{ display: "flex", alignItems: "center", gap: 1, "& svg": { fontSize: 18, color: "primary.main" } }}>
          <CartIcon />
          Build from a cart
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
          Replaces the steps below
        </Typography>
      </Box>
      <Typography variant="body2" sx={{ fontSize: 13, maxWidth: 820 }}>
        Choose the actions you want: they&apos;re put in the order they can run, each input wired to what provides its type, and anything else they need added.
      </Typography>
      <Autocomplete
        multiple
        options={choices}
        value={selection}
        groupBy={(p) => p.teamName ?? ""}
        getOptionLabel={(p) => `${productName(p, p.name)} · ${p.action}`}
        isOptionEqualToValue={(a, b) => a.name === b.name}
        onChange={(_e, next) => { setSelection(next); }}
        renderInput={(params) => <TextField {...params} label="Actions" placeholder="Add an action" />}
        sx={{ bgcolor: "background.paper" }}
      />
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.25, alignItems: "center" }}>
        {cartProducts.length > 0 && (
          <Button variant="outlined" size="small" onClick={() => { setSelection(cartProducts); }} sx={{ minHeight: 36 }}>
            Use your cart ({cartProducts.length})
          </Button>
        )}
        <Button variant="contained" size="small" disabled={busy || selection.length === 0 || !team} onClick={() => void build()} sx={{ minHeight: 36 }}>
          {busy ? "Wiring…" : "Wire them"}
        </Button>
        {wired && (
          <Typography variant="body2" sx={{ fontSize: 13, color: "success.dark", display: "inline-flex", alignItems: "center", gap: 0.75, "& svg": { fontSize: 16 } }}>
            <CheckIcon />
            Wired into {wired.steps} {wired.steps === 1 ? "step" : "steps"}
            {wired.added.length > 0 && `: ${wired.added.map(nameOf).join(" and ")} added`}
          </Typography>
        )}
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {wired && wired.problems.length > 0 && (
        <Alert severity="info">
          Wired, but these need you:
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {wired.problems.map((p) => (
              <li key={`${p.code}:${p.step}:${p.input}`}>{p.message}</li>
            ))}
          </Box>
        </Alert>
      )}
      {wired?.asked.map((problem) => (
        <Box key={`${problem.step}.${problem.input}`} sx={{ borderTop: 1, borderColor: "tint.rule", pt: 1.75 }}>
          <OrderChoice
            problem={problem}
            label={
              <>
                {problem.step}&apos;s{" "}
                <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontWeight: 500, fontSize: 12 }}>
                  {problem.input}
                </Box>
              </>
            }
            chosen={picked.find((c) => sameInput(c, problem))}
            onChoose={choose}
          />
        </Box>
      ))}
    </Card>
  );
}

/**
 * Compose (/catalog/compose): a template built from the actions shared with
 * you, each input given a value, asked for when it runs, or wired from an
 * earlier step's output (matched by its wiring type). It's proposed to the
 * catalog as a file (GitHub's new-file page, in your browser, for review),
 * or run now when every step is your team's and nothing's asked. Drafts
 * are kept by the console for their team (useComposeDrafts); ?draft=<team>/<name>
 * opens one, and ?cart=1 starts Build from a cart from your cart.
 */
export function ComposePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const install = useEnvironment()?.label || "this install";
  const { actions: cartActions, team: cartTeam } = useCart();
  const [params] = useSearchParams();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [runnables, setRunnables] = useState<Runnable[]>([]);
  const [usable, setUsable] = useState<Set<string>>(new Set());
  const [repository, setRepository] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blank = (name: string): Draft => ({ name, displayName: "", description: "", team: user?.teamNames[0] ?? "", steps: [] });
  // From the cart (?cart=1), it's for the cart's team, as the cart was planned.
  const [draft, setDraft] = useState<Draft>(() => {
    const first = blank("my-template");
    return params.get("cart") === "1" && cartTeam && user?.teamNames.includes(cartTeam) ? { ...first, team: cartTeam } : first;
  });
  const stored = useComposeDrafts(draft);
  const [moved, setMoved] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Run now refused: a step is for installs on another cloud.
  const [refusal, setRefusal] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  // The teams it can be for: yours, or any for an admin.
  const [teams, setTeams] = useState<string[]>(user?.teamNames ?? []);

  useEffect(() => {
    Promise.all([listProducts(), listRunnables()])
      .then(([all, list]) => {
        setProducts(all);
        setRunnables(list);
        setUsable(new Set(list.filter((r) => r.kind === "action" && r.shared).map((r) => r.name)));
        const source = list.find((r) => r.sourceUrl)?.sourceUrl ?? null;
        setRepository(source ? (source.split("/blob/")[0] ?? null) : null);
      })
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the catalog.")); });
    if (user?.isAdmin) {
      listAllTeams()
        .then((all) => { setTeams(all.map((t) => t.name)); })
        .catch(() => undefined);
    }
  }, [user?.isAdmin]);

  const byName = useMemo(() => new Map((products ?? []).map((p) => [p.name, p])), [products]);
  const choices = useMemo(() => (products ?? []).filter((p) => usable.has(p.name) && !p.deprecated), [products, usable]);
  const locked = useMemo(() => runnables.filter((r) => r.kind === "action" && !r.shared), [runnables]);
  const fromCart = useMemo(() => (products ? cartActions.flatMap((a) => choices.filter((p) => p.name === a)) : null), [products, cartActions, choices]);
  const found = problems(draft, byName);
  const yaml = templateYaml(draft, byName);
  const dag = dagOf(draft, byName);
  const runnable = dag !== null && found.length === 0 && draft.steps.every((s) => user?.maintainerOf.includes(byName.get(s.product)?.teamName ?? "") ?? false);
  const propose = proposeUrl(repository, draft, yaml);
  const asked = [...new Set(draft.steps.flatMap((s) => Object.entries(s.inputs).filter(([, i]) => i.kind === "parameter").map(([n, i]) => (i.kind === "parameter" && i.name) || n)))];

  const update = (next: Draft) => {
    stored.edited();
    setDraft(next);
  };
  // Drafts opened so far: Build from a cart drops what it was wiring for the last one.
  const [opening, setOpening] = useState(0);
  const open = (next: Draft | null) => {
    setOpening((n) => n + 1);
    stored.opened(next);
    setDraft(next ?? blank(`draft-${String((stored.drafts?.length ?? 0) + 1)}`));
    setSelected(next && next.steps.length > 0 ? 0 : null);
    setAdded(new Set());
  };
  async function loadTheirs(): Promise<void> {
    const theirs = (await stored.reload()).find((d) => d.team === draft.team && d.name === draft.name);
    open(theirs ? draftOf(theirs) : null);
  }

  // ?draft=<team>/<name> (Home's "Pick up where you left off"): open it, once the drafts are in.
  const wanted = useRef(params.get("draft"));
  useEffect(() => {
    if (!wanted.current || !stored.drafts) return;
    const d = stored.drafts.find((x) => `${x.team}/${x.name}` === wanted.current);
    wanted.current = null;
    if (d) open(draftOf(d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored.drafts]);

  async function run(): Promise<void> {
    if (!dag) return;
    setRunning(true);
    setError(null);
    setRefusal(null);
    try {
      navigate(`/runs/${(await submitExecution(dag)).executionId}`);
    } catch (err) {
      if (isNotForThisInstall(err)) setRefusal(err);
      else setError(errorMessage(err, "Couldn't run it."));
      setRunning(false);
    }
  }

  // The checks, in a line: what's wrong first, then what's settled, then what to know.
  const checks: Check[] = [
    ...found.map((text): Check => ({ tone: "warning", text })),
    ...(found.length === 0 ? [{ tone: "success", text: "Every required input given, wired or asked" } satisfies Check] : []),
  ];
  const unready = draft.steps.filter((s) => byName.get(s.product)?.readiness?.state === "not_ready").length;
  if (unready > 0) checks.push({ tone: "warning", text: `${String(unready)} ${unready === 1 ? "step" : "steps"} not ready on ${install}` });
  const deprecated = draft.steps.filter((s) => byName.get(s.product)?.deprecated).length;
  if (deprecated > 0) checks.push({ tone: "warning", text: `${String(deprecated)} ${deprecated === 1 ? "step" : "steps"} deprecated` });
  if (asked.length > 0) checks.push({ tone: "info", text: `Asks ${asked.join(", ")} when it runs` });

  // Why Run now is off, said beside it (a tooltip reaches neither a keyboard nor a touch).
  const runWhy = runnable
    ? undefined
    : draft.steps.length === 0
      ? "Add a step to run it."
      : hasParameters(draft)
        ? `It asks for ${asked.join(", ")} when it runs, so propose it as a template.`
        : found.length > 0
          ? `Not until its checks pass: ${String(found.length)} ${found.length === 1 ? "thing" : "things"} to fix, under Checks.`
          : "Every step must be a product of a team you maintain to run it from here.";
  const status = stored.status === "saving" ? "saving…" : stored.status === "saved" ? "saved for the team" : null;
  const openDraft = stored.drafts?.find((d) => d.team === draft.team && d.name === draft.name);

  return (
    <Box sx={{ maxWidth: 1280, mx: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
      <Box component="header" sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-end", gap: 2 }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0, flex: "1 1 360px" }}>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            <Link component={RouterLink} to="/catalog">
              Catalog
            </Link>{" "}
            / Compose{draft.team && ` · draft for ${draft.team}`}
            {status ? ` · ${status}` : openDraft?.updatedAt ? ` · saved ${when(openDraft.updatedAt)}` : ""}
          </Typography>
          <Typography variant="h4" component="h1" sx={{ fontSize: { xs: 24, sm: 28 }, overflowWrap: "anywhere" }}>
            {draft.displayName || "Compose"}
          </Typography>
          <Typography sx={{ fontSize: 14, maxWidth: 720, lineHeight: 1.5 }}>
            Build a template from the actions shared with you: each step&apos;s inputs a value, asked when it runs, or an earlier step&apos;s output. Propose it to the catalog for review, or run it now
            when every step is your team&apos;s and nothing is asked.
          </Typography>
          <Box>
            <HelpLink guide="10-ordering-and-the-cart" section="how-do-i-compose-a-template-by-hand" label="Composing by hand" />
          </Box>
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.25 }}>
          <Button variant="outlined" size="large" onClick={() => { open(null); }}>
            New
          </Button>
          <Button component="a" variant="outlined" size="large" disabled={found.length > 0 || !propose} href={propose ?? undefined} target="_blank" rel="noopener noreferrer" title="Opens the catalog repository's new-file page with it filled in">
            Propose as a template ↗
          </Button>
          <Button variant="contained" size="large" disabled={!runnable || running} onClick={() => void run()} aria-describedby={runWhy ? "run-why" : undefined}>
            {running ? "Starting…" : "Run now"}
          </Button>
        </Box>
        {runWhy && (
          <Typography id="run-why" variant="caption" color="text.secondary" sx={{ flexBasis: "100%", textAlign: { sm: "right" } }}>
            {runWhy}
          </Typography>
        )}
      </Box>

      {error && <Alert severity="error">{error}</Alert>}
      {refusal && (
        <NotForThisInstall
          error={refusal}
          what="order"
          product={(() => {
            const p = byName.get(refusedProduct(refusal) ?? "");
            return p ? { name: p.displayName || p.name, team: p.teamName, clouds: p.clouds, cloudsFrom: p.cloudsFrom } : null;
          })()}
        />
      )}

      <BuildFromCart
        team={draft.team}
        opening={opening}
        choices={choices}
        initial={fromCart}
        onBuilt={(steps, _found, addedIds) => {
          // Only the steps change, on the draft as it is now.
          stored.edited();
          setDraft((d) => ({ ...d, steps }));
          setAdded(new Set(addedIds));
          setSelected(steps.length > 0 ? 0 : null);
        }}
      />

      <CheckStrip label="Checks" checks={checks} />

      <Box sx={{ display: "grid", gap: 2.5, alignItems: "start", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))", lg: "250px minmax(0, 1fr) 360px" } }}>
        <Box sx={{ gridColumn: { md: "1 / -1", lg: "auto" }, minWidth: 0 }}>
          <Palette
            choices={choices}
            locked={locked}
            onAdd={(product) => {
              update({ ...draft, steps: [...draft.steps, newStep(draft, byName, product)] });
              setSelected(draft.steps.length);
            }}
          />
        </Box>
        <Box component="section" aria-label="Steps" sx={{ minWidth: 0 }}>
          <StepList draft={draft} products={byName} selected={selected} added={added} onSelect={setSelected} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          {selected !== null && draft.steps[selected] ? (
            <StepInspector
              index={selected}
              draft={draft}
              products={byName}
              install={install}
              onChange={(next) => { update({ ...draft, steps: draft.steps.map((s, j) => (j === selected ? next : s)) }); }}
              onRemove={() => {
                update({ ...draft, steps: draft.steps.filter((_, j) => j !== selected) });
                setSelected(draft.steps.length > 1 ? Math.max(0, selected - 1) : null);
              }}
            />
          ) : (
            <Card sx={{ p: 2.5 }}>
              <Typography variant="body2" color="text.secondary">
                Choose a step to set its inputs.
              </Typography>
            </Card>
          )}
        </Box>
      </Box>

      <Box sx={{ display: "grid", gap: 2.5, alignItems: "start", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 1fr) 340px" } }}>
        <Card component="section" aria-label="The template" sx={{ px: { xs: 2, sm: 2.75 }, py: 2.5, display: "flex", flexDirection: "column", gap: 1.75, minWidth: 0 }}>
          <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 1.25 }}>
            <Typography variant="h6" component="h2">
              The template
            </Typography>
            <Typography sx={{ fontFamily: "fontFamilyMono", fontSize: 12, color: "text.secondary", overflowWrap: "anywhere" }}>
              teams/{draft.team || "<team>"}/dags/{draft.name}.yaml
            </Typography>
          </Box>
          <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "repeat(2, minmax(0, 1fr))" } }}>
            <TextField size="small" label="Name" value={draft.name} onChange={(e) => { update({ ...draft, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }); }} helperText="Its file name" />
            <TextField select size="small" label="For team" value={draft.team} onChange={(e) => { update({ ...draft, team: e.target.value }); }} helperText="Its catalog folder, and who owns it">
              {teams.map((t) => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </TextField>
            <TextField size="small" label="Display name" value={draft.displayName} onChange={(e) => { update({ ...draft, displayName: e.target.value }); }} />
            <TextField size="small" label="Description" value={draft.description} onChange={(e) => { update({ ...draft, description: e.target.value }); }} />
          </Box>
          <CodeBlock code={yaml} copyLabel="Copy the file" />
          <Box sx={{ display: "flex", gap: 1.25, flexWrap: "wrap", alignItems: "center" }}>
            <Button component="a" variant="contained" size="small" disabled={found.length > 0 || !propose} href={propose ?? undefined} target="_blank" rel="noopener noreferrer" sx={{ minHeight: 36 }}>
              Propose as a template ↗
            </Button>
            <Typography variant="caption" color="text.secondary" sx={{ flex: "1 1 240px" }}>
              {propose
                ? `Opens the catalog repository's new-file page with it filled in: open a pull request for ${draft.team || "its team"} to review.`
                : "The catalog repository isn't known here: copy the file into teams/<team>/dags/ yourself."}
            </Typography>
          </Box>
        </Card>

        <Card component="aside" aria-label="Drafts" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
            <Typography variant="h6" component="h2">
              Drafts
            </Typography>
            <Button size="small" onClick={() => { open(null); }} sx={{ minHeight: 36 }}>
              New
            </Button>
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13, lineHeight: 1.45 }}>
            Kept for their team as you go: its members see and change them, from any device. {stored.status === "saving" ? "Saving…" : stored.status === "saved" ? "Saved." : ""}
          </Typography>
          {stored.status === "conflict" && (
            <Alert
              severity="warning"
              action={
                <Box sx={{ display: "flex", flexDirection: "column" }}>
                  <Button size="small" color="inherit" onClick={() => void loadTheirs()}>
                    Load theirs
                  </Button>
                  <Button size="small" color="inherit" onClick={stored.keepMine}>
                    Keep mine
                  </Button>
                </Box>
              }
            >
              {stored.problem}
            </Alert>
          )}
          {stored.status !== "conflict" && stored.problem && <Alert severity="error">{stored.problem}</Alert>}
          {stored.drafts?.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
              None yet: give this one a name and it&apos;s kept.
            </Typography>
          )}
          {stored.drafts?.map((d) => {
            const isOpen = d.team === draft.team && d.name === draft.name;
            const steps = draftOf(d).steps.length;
            return (
              <Box
                key={`${d.team}/${d.name}`}
                sx={{ display: "flex", alignItems: "center", gap: 1, pl: 0.5, pr: 0.5, borderRadius: 2, border: 1, borderColor: isOpen ? "primary.main" : "tint.rule", bgcolor: isOpen ? "tint.infoSurface" : "transparent" }}
              >
                <Box
                  component="button"
                  type="button"
                  aria-current={isOpen ? "true" : undefined}
                  onClick={() => { open(draftOf(d)); }}
                  sx={{ all: "unset", boxSizing: "border-box", cursor: "pointer", flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.25, px: 1, py: 1.25, fontSize: 13, "&:focus-visible": { outline: (t) => `2px solid ${t.palette.primary.main}`, outlineOffset: 2, borderRadius: 1 } }}
                >
                  <Box component="span" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
                    {d.name}
                  </Box>
                  <Box component="span" sx={{ color: "text.secondary" }}>
                    {d.team} · {steps} {steps === 1 ? "step" : "steps"}
                    {d.updatedBy && ` · ${d.updatedBy}`}
                    {d.updatedAt && `, ${when(d.updatedAt)}`}
                  </Box>
                </Box>
                <IconButton
                  aria-label={`Delete draft ${d.team}/${d.name}`}
                  title="Delete"
                  onClick={() => {
                    stored.remove(d).catch((err: unknown) => { setError(errorMessage(err, "Couldn't delete it.")); });
                  }}
                  sx={{ width: 36, height: 36 }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            );
          })}
          {stored.inBrowser.length > 0 && (
            <Alert
              severity="info"
              action={
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => {
                    stored
                      .moveFromBrowser(teams)
                      .then((n) => { setMoved(`${String(n)} moved.`); })
                      .catch(() => { setMoved("Couldn't move them."); });
                  }}
                >
                  Move them
                </Button>
              }
            >
              {stored.inBrowser.length} {stored.inBrowser.length === 1 ? "draft is" : "drafts are"} kept only in this browser. {moved}
            </Alert>
          )}
        </Card>
      </Box>
    </Box>
  );
}
