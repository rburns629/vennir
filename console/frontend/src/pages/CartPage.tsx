// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ArrowIcon from "@mui/icons-material/ArrowForward";
import { ApiError, errorMessage, cloudList, listRunnables, placeOrder, type OrderOption, type Runnable } from "../api";
import { useAuth } from "../auth/AuthContext";
import { cart, planChecks, useCart, useOrderPlan } from "../cart";
import type { BuiltStep } from "../compose";
import { CheckStrip } from "../components/CheckStrip";
import { CloudPill, NotForThisInstall, cloudsSource, isNotForThisInstall, refusedProduct, useInstall } from "../components/Clouds";
import { EmptyState } from "../components/EmptyState";
import { OrderChoice, optionKey, sameInput } from "../components/OrderChoice";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { ReadinessNote } from "../components/ReadinessNote";
import { ReadinessPill } from "../components/ReadinessPill";
import { fieldsOf, initialValues, toParameters, type Field, type FieldValue, type Values } from "../schemaForm";
import { FieldInput } from "./catalog/FieldInput";

/** A wired input: from a step's output, something you have, or asked once for the order. */
function Wire({ children }: { children: ReactNode }) {
  return (
    <Box
      component="span"
      sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, px: 1, py: 0.25, borderRadius: "6px", bgcolor: "tint.infoSurface", color: "info.main", fontSize: 12, overflowWrap: "anywhere", "& svg": { fontSize: 12 } }}
    >
      <ArrowIcon aria-hidden="true" />
      {children}
    </Box>
  );
}

/** How a wired input is filled, in a line. */
function Wired({ input, choice, name }: { input: BuiltStep["inputs"][string]; choice: OrderOption | undefined; name: (step: string) => string }) {
  if (input.kind === "step") return <Wire>From {name(input.step ?? "")}&apos;s {input.output ?? ""}</Wire>;
  if (input.kind === "resource") return <Wire>Uses {choice?.label ?? input.value ?? ""}</Wire>;
  if (input.kind === "parameter")
    return (
      <span>
        Asked once for the order:{" "}
        <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>
          {input.parameter ?? ""}
        </Box>
      </span>
    );
  return null;
}

/** The step's state here: for other installs, deprecated, its readiness, or nothing when it has no check. */
function StepState({ action }: { action: Runnable | undefined }) {
  if (action && !action.runsHere) return <CloudPill clouds={action.clouds} />;
  if (action?.deprecated) return <Pill tone="warning" title={action.deprecated}>Deprecated</Pill>;
  if (action?.readiness) return <ReadinessPill readiness={action.readiness} />;
  return null;
}

/**
 * The cart (/catalog/cart, decision 25): the actions collected in the
 * Catalog, planned together for one of your teams (PreviewOrder): what each
 * needs added, what you already have that it could use, what's suggested,
 * and what you fill in. Place order runs it as one run for the team
 * (PlaceOrder). Choices aren't kept: they're made here, for this order,
 * starting from what a chat answer filled in, if one did.
 */
export function CartPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { install, cloud } = useInstall();
  const { team: chosenTeam, actions, choices: proposedChoices, values: proposedValues } = useCart();
  const teams = user?.teamNames ?? [];
  const team = chosenTeam && teams.includes(chosenTeam) ? chosenTeam : (teams[0] ?? null);
  const [runnables, setRunnables] = useState<Runnable[]>([]);
  const [choices, setChoices] = useState<OrderOption[]>(proposedChoices);
  const { plan, error: planError } = useOrderPlan(team, actions, choices);
  const [values, setValues] = useState<Record<string, Values>>({});
  const [shared, setShared] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ApiError | null>(null);
  const [placing, setPlacing] = useState(false);
  // One per visit: placing it again after a timeout is the same order.
  const [requestId] = useState(() => crypto.randomUUID());

  // A chat answer's cart opened here: start again from what it filled in.
  useEffect(() => {
    setChoices(proposedChoices);
    setValues({});
  }, [proposedChoices, proposedValues]);

  useEffect(() => {
    listRunnables()
      .then(setRunnables)
      .catch(() => { setRunnables([]); });
  }, []);

  const actionsByName = useMemo(() => new Map(runnables.filter((r) => r.kind === "action").map((r) => [r.name, r])), [runnables]);
  const action = (name: string) => actionsByName.get(name);
  // A step's name, with its number when another step has the same name (an action in the cart twice).
  const nameOf = (id: string) => {
    const product = plan?.steps.find((s) => s.id === id)?.product ?? id;
    return action(product)?.displayName || id;
  };
  const stepName = (id: string) => {
    const name = nameOf(id);
    const steps = plan?.steps ?? [];
    return steps.filter((s) => nameOf(s.id) === name).length > 1 ? `${name} (step ${String(steps.findIndex((s) => s.id === id) + 1)})` : name;
  };
  // Each step's inputs left for you, as form fields.
  const fields = useMemo(() => {
    const out: Record<string, Field[]> = {};
    for (const step of plan?.steps ?? []) {
      const all = fieldsOf(actionsByName.get(step.product)?.parameters ?? {}) ?? [];
      out[step.id] = all.filter((f) => step.inputs[f.name]?.kind === "unset");
    }
    return out;
  }, [plan, actionsByName]);
  const parameters = useMemo(() => [...new Set((plan?.steps ?? []).flatMap((s) => Object.values(s.inputs).filter((i) => i.kind === "parameter").map((i) => i.parameter ?? "")))], [plan]);

  const choose = (o: OrderOption) => { setChoices((list) => [...list.filter((c) => !sameInput(c, o)), o]); };
  const valuesOf = (step: string): Values =>
    values[step] ?? initialValues(action(plan?.steps.find((s) => s.id === step)?.product ?? "")?.parameters ?? {}, fields[step] ?? [], proposedValues[step]);
  const set = (step: string) => (name: string, value: FieldValue) => {
    setValues((all) => ({ ...all, [step]: { ...valuesOf(step), [name]: value } }));
  };
  // Choices still to make: the options problems, not a value you'll type.
  const unchosen = (plan?.problems ?? []).filter((p) => p.options.length > 0 && !choices.some((c) => sameInput(c, p)));
  const cycle = (plan?.problems ?? []).find((p) => p.code === "CYCLE");
  // Steps for installs on other clouds: the order can't run here until they're removed.
  const notHere = (plan?.steps ?? []).filter((s) => action(s.product)?.runsHere === false);
  const notHereNames = [...new Set(notHere.map((s) => action(s.product)?.displayName || s.product))];
  const notHereClouds = [...new Set(notHere.flatMap((s) => action(s.product)?.clouds ?? []))].sort();
  const onCloud = cloud ? `${install} is on ${cloud}` : `${install} is on another cloud`;
  // Which steps use each parameter asked once.
  const usedBy = (parameter: string) => (plan?.steps ?? []).filter((s) => Object.values(s.inputs).some((i) => i.kind === "parameter" && i.parameter === parameter)).map((s) => stepName(s.id));

  async function place(): Promise<void> {
    if (!team || !plan) return;
    const typed: Record<string, Record<string, unknown>> = {};
    const errors: Record<string, string> = {};
    for (const step of plan.steps) {
      const result = toParameters(fields[step.id] ?? [], valuesOf(step.id));
      typed[step.id] = result.parameters;
      for (const [name, message] of Object.entries(result.errors)) errors[`${step.id}.${name}`] = message;
    }
    for (const name of parameters) if (!shared[name]?.trim()) errors[`parameter.${name}`] = "Required.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setPlacing(true);
    setError(null);
    setRefusal(null);
    try {
      const id = await placeOrder({ team, actions, choices, values: typed, parameters: shared, requestId });
      cart.clear();
      navigate(`/runs/${id}`);
    } catch (err) {
      if (isNotForThisInstall(err)) setRefusal(err);
      else setError(errorMessage(err, "Couldn't place the order."));
      setPlacing(false);
    }
  }

  const header = (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
        <Link component={RouterLink} to="/catalog">
          Catalog
        </Link>{" "}
        / Cart
      </Typography>
      <PageHeader
        title="Cart"
        help={{ guide: "10-ordering-and-the-cart", section: "how-do-i-order-several-actions-together-with-the-cart", label: "Ordering with the cart" }}
        subtitle="What you've added from the Catalog, planned as one run for one of your teams: each input wired to what provides its type, what's missing added, and what you already have offered. You fill in the rest."
        action={
          <Button component={RouterLink} to="/catalog" variant="outlined" size="large">
            Back to the catalog
          </Button>
        }
      />
    </>
  );

  if (teams.length === 0 || actions.length === 0) {
    return (
      <Box sx={{ maxWidth: 1280, mx: "auto" }}>
        {header}
        {teams.length === 0 ? (
          <Alert severity="info">You&apos;re in no team yet: an order is placed for one of yours.</Alert>
        ) : (
          <Card>
            <EmptyState
              message="Your cart is empty: add actions from the Catalog."
              action={
                <Button component={RouterLink} to="/catalog" variant="contained">
                  Open the catalog
                </Button>
              }
            />
          </Card>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 1280, mx: "auto" }}>
      {header}
      <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 1fr) 340px" }, alignItems: "start" }}>
        <Box component="section" aria-label="The plan" sx={{ display: "flex", flexDirection: "column", gap: 1.75, minWidth: 0 }}>
          {[...new Set(notHere.map((s) => s.product))].map((product) => {
            const a = action(product);
            const name = a?.displayName || product;
            const index = actions.indexOf(product);
            return (
              <Alert
                key={product}
                severity="error"
                action={
                  index >= 0 && (
                    <Button size="small" variant="outlined" color="inherit" onClick={() => { cart.removeAt(index); }} sx={{ bgcolor: "background.paper", whiteSpace: "nowrap" }}>
                      Remove {name}
                    </Button>
                  )
                }
              >
                <strong>
                  {name} is for {cloudList(a?.clouds ?? [])} installs, so this order can&apos;t run here.
                </strong>{" "}
                {onCloud}. Remove it to order the rest.
              </Alert>
            );
          })}
          {refusal && (
            <NotForThisInstall
              error={refusal}
              what="order"
              product={(() => {
                const a = action(refusedProduct(refusal) ?? "");
                return a ? { name: a.displayName || a.name, team: a.team, clouds: a.clouds, cloudsFrom: a.cloudsFrom } : null;
              })()}
            />
          )}
          {(error ?? planError) && <Alert severity="error">{error ?? planError}</Alert>}
          {plan && <CheckStrip label="The plan" checks={planChecks(plan, choices, action, install)} />}

          {plan?.steps.map((step, index) => {
            const a = action(step.product);
            const suggestions = plan.suggestions.filter((s) => s.step === step.id);
            const wired = Object.entries(step.inputs).filter(([name, input]) => input.kind !== "unset" && !plan.problems.some((p) => p.options.length > 0 && sameInput(p, { step: step.id, input: name })));
            const asked = plan.problems.filter((p) => p.options.length > 0 && p.step === step.id);
            const stepFields = fields[step.id] ?? [];
            return (
              <Card component="article" key={step.id} sx={{ px: { xs: 2, sm: 2.75 }, py: 2.5, display: "flex", flexDirection: "column", gap: 1.75, ...(step.added && { borderColor: "tint.infoBorder" }) }}>
                <Box sx={{ display: "flex", gap: 1.75, alignItems: "flex-start" }}>
                  <Box sx={{ flex: "0 0 28px", height: 28, borderRadius: "50%", bgcolor: "info.light", color: "info.main", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {index + 1}
                  </Box>
                  <Box sx={{ display: "flex", flexDirection: "column", gap: 0.375, minWidth: 0, flex: "1 1 auto" }}>
                    <Typography variant="h6" component="h2" sx={{ fontSize: 17, display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center" }}>
                      {a?.displayName || step.product}
                      {step.added && <Pill tone="info">Added: something in your cart needs it</Pill>}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 12, overflowWrap: "anywhere" }}>
                      {a ? `${a.actions[0] ?? a.team} · ` : ""}
                      <Box component="span" sx={{ fontFamily: "fontFamilyMono" }}>
                        {step.id}
                      </Box>
                    </Typography>
                  </Box>
                  <StepState action={a} />
                </Box>
                {a && !a.runsHere && (
                  <Typography variant="body2" color="text.secondary" sx={{ fontSize: 13 }}>
                    Not run on {install}
                    {cloud && `, which is on ${cloud}`}. {cloudsSource(a.team, a.cloudsFrom)} says it&apos;s for {cloudList(a.clouds)} installs.{" "}
                    <Link component={RouterLink} to="/products">
                      About it
                    </Link>
                  </Typography>
                )}
                <ReadinessNote readiness={a?.readiness} deprecated={a?.deprecated}>
                  {a?.readiness?.state === "not_ready" && (
                    <>
                      You can still order it; it may fail at this step.{" "}
                      <Link component={RouterLink} to="/products">
                        Its check
                      </Link>
                    </>
                  )}
                </ReadinessNote>
                {wired.length > 0 && (
                  <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "150px minmax(0, 1fr)" }, gap: "4px 14px", alignItems: "baseline", fontSize: 13 }}>
                    {wired.map(([name, input]) => (
                      <Box key={name} sx={{ display: "contents" }}>
                        <Box component="dt" sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>
                          {name}
                        </Box>
                        <Box component="dd" sx={{ m: 0, mb: { xs: 0.75, sm: 0 } }}>
                          <Wired input={input} choice={choices.find((c) => sameInput(c, { step: step.id, input: name }))} name={stepName} />
                        </Box>
                      </Box>
                    ))}
                  </Box>
                )}
                {asked.map((problem) => (
                  <Box key={problem.input} sx={{ borderTop: 1, borderColor: "tint.rule", pt: 1.75 }}>
                    <OrderChoice problem={problem} chosen={choices.find((c) => sameInput(c, problem))} onChoose={choose} />
                  </Box>
                ))}
                {stepFields.length > 0 && (
                  // A step that can't run here can't be filled in either.
                  <Box component="fieldset" disabled={a?.runsHere === false} sx={{ border: 0, m: 0, p: 0, minWidth: 0, display: "grid", gap: 1.75, gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "repeat(2, minmax(0, 1fr))" } }}>
                    {stepFields.map((field) => (
                      <FieldInput key={field.name} field={field} value={valuesOf(step.id)[field.name]} error={fieldErrors[`${step.id}.${field.name}`]} onChange={set(step.id)} />
                    ))}
                  </Box>
                )}
                {a && !a.runsHere && actions.includes(step.product) && (
                  <Button size="small" onClick={() => { cart.removeAt(actions.indexOf(step.product)); }} sx={{ alignSelf: "flex-start", minHeight: 36 }}>
                    Remove from the cart
                  </Button>
                )}
                {suggestions.map((s) => (
                  <Box
                    key={s.input}
                    sx={{ display: "flex", flexWrap: "wrap", gap: "8px 12px", alignItems: "center", px: 1.5, py: 1.25, borderRadius: 2, bgcolor: "tint.infoSurface", border: 1, borderColor: "tint.infoBorder", fontSize: 13 }}
                  >
                    <Typography component="span" sx={{ fontSize: 13, color: "info.main" }}>
                      Optional:{" "}
                      <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>
                        {s.input}
                      </Box>{" "}
                      ({s.wiringType}). Nothing fills it.
                    </Typography>
                    {s.provider && (
                      <Button size="small" variant="outlined" onClick={() => { if (s.provider) cart.add(s.provider); }} sx={{ minHeight: 36, bgcolor: "background.paper" }}>
                        Add {action(s.provider)?.displayName || s.provider}
                      </Button>
                    )}
                    {s.existing.map((o) => (
                      <Button key={optionKey(o)} size="small" onClick={() => { choose(o); }} sx={{ minHeight: 36 }}>
                        Use {o.label}
                      </Button>
                    ))}
                  </Box>
                ))}
              </Card>
            );
          })}
        </Box>

        <Box component="aside" aria-label="Your order" sx={{ display: "flex", flexDirection: "column", gap: 2, position: { lg: "sticky" }, top: { lg: 24 } }}>
          <Card component="section" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 2 }}>
            <Typography variant="h6" component="h2">
              Your order
            </Typography>
            <TextField
              select
              size="small"
              label="For team"
              value={team ?? ""}
              onChange={(e) => { cart.setTeam(e.target.value); setChoices([]); }}
              helperText="The run is the team's. Changing it plans again."
            >
              {teams.map((t) => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </TextField>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
              <Typography sx={{ fontSize: 13, fontWeight: 500 }}>In your cart</Typography>
              {actions.map((name, i) => (
                <Box key={`${name}-${String(i)}`} sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
                  <Typography variant="body2" sx={{ fontSize: 13, overflowWrap: "anywhere" }}>
                    {action(name)?.displayName || name}
                  </Typography>
                  <Button size="small" onClick={() => { cart.removeAt(i); }} sx={{ minHeight: 36 }}>
                    Remove
                  </Button>
                </Box>
              ))}
            </Box>
            {parameters.length > 0 && (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 1.75, borderTop: 1, borderColor: "tint.rule", pt: 1.75 }}>
                {parameters.map((name) => {
                  const users = usedBy(name);
                  return (
                    <TextField
                      key={name}
                      size="small"
                      label={name}
                      required
                      value={shared[name] ?? ""}
                      error={Boolean(fieldErrors[`parameter.${name}`])}
                      helperText={fieldErrors[`parameter.${name}`] ?? `Asked once for the order${users.length > 0 ? `: ${users.join(" and ")} use it` : ""}.`}
                      onChange={(e) => { setShared((all) => ({ ...all, [name]: e.target.value })); }}
                    />
                  );
                })}
              </Box>
            )}
            <Button
              variant="contained"
              size="large"
              fullWidth
              disabled={!plan || placing || unchosen.length > 0 || Boolean(cycle) || notHere.length > 0}
              onClick={() => void place()}
              aria-describedby={notHere.length > 0 ? "not-here-why" : undefined}
            >
              {placing ? "Placing…" : "Place order"}
            </Button>
            {notHere.length > 0 ? (
              <Typography id="not-here-why" variant="body2" color="error.dark" sx={{ fontSize: 13 }}>
                Remove {notHereNames.join(" and ")} first: {notHereNames.length === 1 ? "it's" : "they're"} for {cloudList(notHereClouds)} installs, and {onCloud}.
              </Typography>
            ) : unchosen.length > 0 ? (
              <Typography variant="body2" color="warning.main" sx={{ fontSize: 13 }}>
                Choose what fills {unchosen.map((p) => `${stepName(p.step)}'s ${p.input}`).join(", ")} first.
              </Typography>
            ) : (
              <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.5 }}>
                One run for {team}, an order: each step runs as its own product&apos;s identity, checked against its schema. Placing it again after a timeout is the same order.
              </Typography>
            )}
          </Card>
          <Card component="section" sx={{ px: 2.5, py: 2, display: "flex", flexDirection: "column", gap: 1, fontSize: 13 }}>
            <Typography component="h2" sx={{ fontWeight: 600, fontSize: 13 }}>
              Want to keep it?
            </Typography>
            <Typography variant="body2" sx={{ fontSize: 13, lineHeight: 1.45 }}>
              Open the plan in Compose to change it, save it as a draft, or propose it as a template.
            </Typography>
            <Button variant="outlined" size="small" component={RouterLink} to="/catalog/compose?cart=1" sx={{ alignSelf: "flex-start", minHeight: 36 }}>
              Open in Compose
            </Button>
          </Card>
        </Box>
      </Box>
    </Box>
  );
}
