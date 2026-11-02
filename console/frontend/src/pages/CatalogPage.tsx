// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, Navigate, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Skeleton from "@mui/material/Skeleton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import CartIcon from "@mui/icons-material/ShoppingCartOutlined";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import CloudIcon from "@mui/icons-material/CloudOutlined";
import { CheckStrip } from "../components/CheckStrip";
import { CloudPill, notHereReason, useInstall } from "../components/Clouds";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { ReadinessNote } from "../components/ReadinessNote";
import { ReadinessPill } from "../components/ReadinessPill";
import { ApiError, listRunnables, type OrderOption, type Runnable } from "../api";
import { useAuth } from "../auth/AuthContext";
import { useEnvironment } from "../environment";
import { when } from "../time";
import { runLink } from "./RunFormPage";
import { cart, planChecks, useCart, useOrderPlan } from "../cart";

/** How a runnable is named in links: ?template=<team>/<name> or ?action=<product>. */
function linkKey(r: Runnable): string {
  return r.kind === "template" ? `template:${r.team}/${r.name}` : `action:${r.name}`;
}

function matches(r: Runnable, query: string): boolean {
  return [r.displayName, r.name, r.team, r.description, ...r.actions].some((text) => text.toLowerCase().includes(query));
}

/** What it asks for: its parameters' names, from its JSON Schema. */
function inputsOf(r: Runnable): string[] {
  const properties = r.parameters["properties"];
  return properties && typeof properties === "object" ? Object.keys(properties) : [];
}

/** The catalog repository's address, from any item's link into it (github.com/<owner>/<repo>). */
function repositoryOf(runnables: Runnable[]): string | null {
  for (const r of runnables) {
    const match = r.sourceUrl ? /^https:\/\/github\.com\/[^/]+\/[^/]+/.exec(r.sourceUrl) : null;
    if (match) return match[0];
  }
  return null;
}

/** For other installs, Not shared with you, Deprecated (why, on hover), its readiness here when it has a check, or No check. */
function State({ r, why }: { r: Runnable; why: string }) {
  if (!r.runsHere) return <CloudPill clouds={r.clouds} title={why} />;
  if (!r.shared) return <Pill tone="neutral">Not shared with you</Pill>;
  if (r.deprecated) return <Pill tone="warning" title={r.deprecated}>Deprecated</Pill>;
  if (r.readiness) return <ReadinessPill readiness={r.readiness} />;
  return <Pill tone="neutral" title="Nothing in it has a readiness check">No check</Pill>;
}

/** The card's footnote: who it's for, who it acts as and when it was checked, and its definition. */
function Foot({ r }: { r: Runnable }) {
  if (!r.shared) return <>{r.shareWith.length > 0 ? `Shared with ${r.shareWith.join(", ")}.` : `Only ${r.team} runs it.`}</>;
  const parts = [
    r.onBehalfOfRequired && `For ${r.onBehalfOf.join(" or ")}`,
    r.readiness?.principal && `Acts as ${r.readiness.principal}`,
    r.readiness?.checkedAt ? `checked ${when(r.readiness.checkedAt)}` : r.readiness ? null : r.kind === "action" && "Has no check",
    r.previewable && "can preview",
  ].filter(Boolean);
  return (
    <>
      {parts.join(" · ")}
      {r.sourceUrl && (
        <>
          {parts.length > 0 && " · "}
          <Link href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
            Its definition ↗
          </Link>
        </>
      )}
    </>
  );
}

/** For other installs: why it can't run here, beneath its controls (not only on hover), and the controls off. */
function NotHere({ r, why }: { r: Runnable; why: string }) {
  const id = `not-here-${r.name}`;
  return (
    <>
      <Typography id={id} variant="caption" color="text.secondary" sx={{ flex: "1 1 120px", fontSize: 12 }}>
        {why}
      </Typography>
      <Box sx={{ display: "flex", gap: 1 }}>
        {r.kind === "action" && (
          <Button variant="outlined" startIcon={<AddIcon />} disabled aria-describedby={id}>
            Add to cart
          </Button>
        )}
        <Button variant="contained" disabled aria-describedby={id} sx={{ minWidth: 72 }}>
          Run
        </Button>
      </Box>
    </>
  );
}

function CatalogCard({ r, inCart }: { r: Runnable; inCart: boolean }) {
  const { install, cloud } = useInstall();
  const why = r.runsHere ? "" : notHereReason(r.clouds, install, cloud);
  const inputs = inputsOf(r);
  const steps = r.actions.length;
  return (
    <Card component="article" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5, minHeight: 250, opacity: r.shared ? 1 : 0.8 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 1.5 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" component="h2" sx={{ fontSize: 17, lineHeight: 1.3, overflowWrap: "anywhere" }}>
            {r.displayName}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            {r.team} · {r.kind === "template" ? `template · ${String(steps)} step${steps === 1 ? "" : "s"}` : "action"}
          </Typography>
        </Box>
        <State r={r} why={why} />
      </Box>
      {r.description && (
        <Typography variant="body2" sx={{ lineHeight: 1.5 }}>
          {r.description}
        </Typography>
      )}
      {inputs.length > 0 && (
        <Typography variant="body2" sx={{ fontFamily: "fontFamilyMono", fontSize: 12, overflowWrap: "anywhere" }}>
          <Box component="span" sx={{ color: "text.secondary" }}>
            in{" "}
          </Box>
          {inputs.join(", ")}
        </Typography>
      )}
      {r.shared && r.runsHere && <ReadinessNote readiness={r.readiness} deprecated={r.deprecated} />}
      <Box sx={{ mt: "auto", pt: 1.5, borderTop: 1, borderColor: "tint.rule", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1.25, flexWrap: "wrap" }}>
        {!r.runsHere ? (
          <NotHere r={r} why={why} />
        ) : (
          <Typography variant="caption" color="text.secondary" sx={{ flex: "1 1 120px", fontSize: 12 }}>
            <Foot r={r} />
          </Typography>
        )}
        {!r.runsHere ? null : r.shared ? (
          <Box sx={{ display: "flex", gap: 1 }}>
            {r.kind === "action" &&
              (inCart ? (
                <Button variant="outlined" color="success" startIcon={<CheckIcon />} component={RouterLink} to="/catalog/cart" sx={{ bgcolor: "success.light" }}>
                  In your cart
                </Button>
              ) : (
                <Button variant="outlined" startIcon={<AddIcon />} onClick={() => { cart.add(r.name); }} title="Order it with others, wired together, as one run">
                  Add to cart
                </Button>
              ))}
            <Button variant="contained" component={RouterLink} to={runLink(r)} sx={{ minWidth: 72 }}>
              Run
            </Button>
          </Box>
        ) : r.askForAccessUrl ? (
          <Button
            variant="outlined"
            href={r.askForAccessUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`Opens an issue on the catalog repository asking ${r.team} to share it with your team.`}
          >
            Ask for access ↗
          </Button>
        ) : null}
      </Box>
    </Card>
  );
}

const NO_CHOICES: OrderOption[] = [];

/** The cart beside the catalog: for which team, what's in it, and how it plans, before you open it to order. */
function CartAside({ runnables }: { runnables: Runnable[] }) {
  const { user } = useAuth();
  const install = useEnvironment()?.label || "this install";
  const { team: chosenTeam, actions } = useCart();
  const teams = user?.teamNames ?? [];
  const team = chosenTeam && teams.includes(chosenTeam) ? chosenTeam : (teams[0] ?? null);
  const { plan } = useOrderPlan(team, actions, NO_CHOICES);
  const action = (name: string) => runnables.find((r) => r.kind === "action" && r.name === name);
  return (
    <Box component="aside" aria-label="Your cart" sx={{ display: "flex", flexDirection: "column", gap: 2, position: { lg: "sticky" }, top: { lg: 24 } }}>
      <Card component="section" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.75, borderColor: "tint.infoBorder" }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
          <Typography variant="h6" component="h2" sx={{ display: "flex", alignItems: "center", gap: 1, "& svg": { fontSize: 18, color: "primary.main" } }}>
            <CartIcon />
            Your cart
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            {actions.length} {actions.length === 1 ? "action" : "actions"}
          </Typography>
        </Box>
        {teams.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            An order is placed for one of your teams, and you&apos;re in none yet.
          </Typography>
        ) : (
          <TextField select size="small" label="For team" value={team ?? ""} onChange={(e) => { cart.setTeam(e.target.value); }}>
            {teams.map((t) => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </TextField>
        )}
        {actions.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
            Nothing in it yet. Add to cart on an action collects it here, to order with others, wired together.
          </Typography>
        ) : (
          <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.75 }}>
            {actions.map((name, i) => {
              const label = action(name)?.displayName || name;
              return (
                <Box
                  component="li"
                  key={`${name}-${String(i)}`}
                  sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, pl: 1.25, pr: 0.5, py: 0.5, border: 1, borderColor: "tint.rule", borderRadius: 2, fontSize: 13 }}
                >
                  <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 500, fontSize: 13 }}>{label}</Typography>
                    <Typography sx={{ fontFamily: "fontFamilyMono", fontSize: 11, color: "text.secondary", overflowWrap: "anywhere" }}>{name}</Typography>
                  </Box>
                  <IconButton aria-label={`Remove ${label}`} title="Remove" onClick={() => { cart.removeAt(i); }} sx={{ width: 36, height: 36 }}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Box>
              );
            })}
          </Box>
        )}
        {plan && (
          <Box sx={{ borderTop: 1, borderColor: "tint.rule", pt: 1.5 }}>
            <CheckStrip compact checks={planChecks(plan, [], action, install)} />
          </Box>
        )}
        <Button variant="contained" size="large" component={RouterLink} to="/catalog/cart" disabled={actions.length === 0}>
          Plan and order
        </Button>
        {actions.length > 0 && (
          <Link component={RouterLink} to="/catalog/compose?cart=1" variant="body2" sx={{ textAlign: "center", fontSize: 13 }}>
            Or build a template from it in Compose
          </Link>
        )}
      </Card>
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.5 }}>
        The cart is kept in this browser until you order it. An order runs as one run for the team you pick, each step as its own product&apos;s identity.
      </Typography>
    </Box>
  );
}

/**
 * What teams publish: every template and action shared with you, and what
 * isn't yet (with Ask for access: GitHub's new-issue page on the catalog,
 * filled in, opened in your own browser; the console only reads the
 * catalog). Hidden ones never reach this page. Running one asks only for its
 * parameters; its steps' images, identities and secrets are its products'
 * (../../../src/core/templates.ts). The cart sits beside it.
 *
 * Run opens its form (RunFormPage); an old link here with ?template= or
 * ?action= goes there.
 */
export function CatalogPage() {
  const install = useEnvironment()?.label || "this install";
  const [runnables, setRunnables] = useState<Runnable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [team, setTeam] = useState<string | null>(null);
  const [runnableOnly, setRunnableOnly] = useState(false);
  const [readyOnly, setReadyOnly] = useState(false);
  const [params] = useSearchParams();
  const inCart = useCart().actions;

  useEffect(() => {
    listRunnables()
      .then(setRunnables)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Couldn't load the catalog.");
      });
  }, []);

  const teams = useMemo(() => [...new Set((runnables ?? []).map((r) => r.team))].sort(), [runnables]);
  const query = search.trim().toLowerCase();
  // What you can run first, templates before actions; the rest after.
  const shown = useMemo(
    () =>
      (runnables ?? [])
        .filter(
          (r) =>
            (!team || r.team === team) &&
            (!runnableOnly || (r.shared && r.runsHere)) &&
            (!readyOnly || r.readiness?.state === "ready") &&
            (!query || matches(r, query)),
        )
        .sort((a, b) => Number(b.shared) - Number(a.shared) || (a.kind === b.kind ? 0 : a.kind === "template" ? -1 : 1)),
    [runnables, team, runnableOnly, readyOnly, query],
  );
  const repository = runnables ? repositoryOf(runnables) : null;
  const templates = shown.filter((r) => r.kind === "template").length;
  // Those for installs on other clouds, last, in a group of their own.
  const here = shown.filter((r) => r.runsHere);
  const others = shown.filter((r) => !r.runsHere);
  const { cloud } = useInstall();

  // Links from before the run page (?template=, ?action=) open it.
  if (params.has("template") || params.has("action")) return <Navigate to={`/catalog/run?${params.toString()}`} replace />;

  return (
    <Box sx={{ maxWidth: 1280, mx: "auto" }}>
      <PageHeader
        title="Catalog"
        help={{ guide: "10-ordering-and-the-cart", label: "Finding and running things from the catalog" }}
        subtitle="What teams publish. Each one runs as its team's own identity: you only fill in the inputs. Run one now, or add actions to your cart and order them together, wired. What isn't shared with your team yet is shown too, so you can ask for it."
        action={
          <Box sx={{ display: "flex", gap: 1.25, alignItems: "center", flexWrap: "wrap" }}>
            <Button component={RouterLink} to="/products" variant="outlined" size="large">
              Every product
            </Button>
            <Button component={RouterLink} to="/catalog/compose" variant="outlined" size="large">
              Compose
            </Button>
            <Button component={RouterLink} to="/catalog/cart" variant="contained" size="large" startIcon={<CartIcon />}>
              Cart{inCart.length > 0 ? ` (${String(inCart.length)})` : ""}
            </Button>
          </Box>
        }
      />
      {repository && (
        <Box sx={{ mt: -2, mb: 3 }}>
          <Link href={repository} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ fontWeight: 500 }}>
            Definitions live in the catalog repository ↗
          </Link>
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, alignItems: "center", mb: 3 }}>
        <TextField
          size="small"
          type="search"
          placeholder="Search templates, actions, teams"
          slotProps={{ htmlInput: { "aria-label": "Search the catalog" } }}
          value={search}
          onChange={(event) => { setSearch(event.target.value); }}
          sx={{ flex: "1 1 280px", maxWidth: 420, bgcolor: "background.paper", "& .MuiInputBase-root": { minHeight: 44 } }}
        />
        <Box role="group" aria-label="Team" sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
          {[null, ...teams].map((t) => {
            const on = team === t;
            return (
              <Box
                key={t ?? "all"}
                component="button"
                type="button"
                aria-pressed={on}
                onClick={() => { setTeam(t); }}
                sx={{
                  height: 36,
                  px: 1.75,
                  borderRadius: 999,
                  font: "inherit",
                  fontSize: 13,
                  cursor: "pointer",
                  border: 1,
                  borderColor: on ? "primary.main" : "tint.field",
                  bgcolor: on ? "info.light" : "background.paper",
                  color: on ? "info.main" : "text.primary",
                  fontWeight: on ? 500 : 400,
                  "&:focus-visible": { outline: (th) => `2px solid ${th.palette.primary.main}`, outlineOffset: 2 },
                }}
              >
                {t ?? "All teams"}
              </Box>
            );
          })}
        </Box>
        <Box sx={{ display: "flex", gap: 2, ml: { md: "auto" }, flexWrap: "wrap" }}>
          <FormControlLabel control={<Checkbox checked={runnableOnly} onChange={(event) => { setRunnableOnly(event.target.checked); }} />} label="Only what I can run" />
          <FormControlLabel control={<Checkbox checked={readyOnly} onChange={(event) => { setReadyOnly(event.target.checked); }} />} label={`Ready on ${install}`} />
        </Box>
      </Box>

      <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 1fr) 300px" }, alignItems: "start" }}>
        <Box component="section" aria-label="Templates and actions" sx={{ display: "flex", flexDirection: "column", gap: 1.5, minWidth: 0 }}>
          {runnables === null && !error && (
            <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 330px), 1fr))", gap: 2 }}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} variant="rounded" height={250} />
              ))}
            </Box>
          )}
          {runnables !== null && shown.length > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
              {shown.length} shown: {templates} {templates === 1 ? "template" : "templates"}, {shown.length - templates} {shown.length - templates === 1 ? "action" : "actions"}. What you can run
              first, templates before actions{others.length > 0 && `; the ${String(others.length)} for other installs last`}.
            </Typography>
          )}
          {runnables !== null && shown.length === 0 && (
            <Card>
              <EmptyState
                title={runnables.length === 0 ? "Nothing published yet" : "Nothing matches"}
                message={
                  runnables.length === 0
                    ? "Teams publish templates and actions from their catalog repository; they show here once its next release is pulled."
                    : "Nothing matches these filters. Clear the search or a filter to see more."
                }
                help={runnables.length === 0 ? { guide: "reference-catalog-guide", label: "Publishing to the catalog" } : undefined}
              />
            </Card>
          )}
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 330px), 1fr))", gap: 2 }}>
            {here.map((r) => (
              <CatalogCard key={linkKey(r)} r={r} inCart={r.kind === "action" && inCart.includes(r.name)} />
            ))}
          </Box>
          {others.length > 0 && (
            <Box component="section" aria-labelledby="other-installs" sx={{ display: "flex", flexDirection: "column", gap: 1.5, mt: 2 }}>
              <Box>
                <Typography id="other-installs" variant="h6" component="h2" sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: 17, "& svg": { fontSize: 18, color: "text.secondary" } }}>
                  <CloudIcon aria-hidden="true" />
                  For other installs
                  <Box component="span" sx={{ fontSize: 13, fontWeight: 400, color: "text.secondary" }}>
                    {others.length}
                  </Box>
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
                  {cloud ? `${install} is on ${cloud}. ` : ""}These are for installs on other clouds: listed so you know they exist, but not checked or run here. Only what I can run hides them.
                </Typography>
              </Box>
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 330px), 1fr))", gap: 2 }}>
                {others.map((r) => (
                  <CatalogCard key={linkKey(r)} r={r} inCart={false} />
                ))}
              </Box>
            </Box>
          )}
        </Box>
        <CartAside runnables={runnables ?? []} />
      </Box>
    </Box>
  );
}
