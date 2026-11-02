// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link as RouterLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ApiError, listRunnables, previewRunnable, runRunnable, updateSchedule, type NotPreviewed, type Runnable } from "../api";
import { CloudPill, NotForThisInstall, isNotForThisInstall, notHereReason, refusedProduct, useInstall } from "../components/Clouds";
import { CodeBlock } from "../components/CodeBlock";
import { Pill } from "../components/Pill";
import { PreviewResult } from "../components/PreviewResult";
import { fieldsOf, groupsOf, initialValues, serverProblems, toParameters, withTargets, type FieldValue, type Values } from "../schemaForm";
import { useAuth } from "../auth/AuthContext";
import { FieldInput } from "./catalog/FieldInput";
import { ScheduleDialog } from "./catalog/ScheduleDialog";

/** How a runnable is named in this page's address: ?template=<team>/<name> or ?action=<product>. */
export function runLink(r: Pick<Runnable, "kind" | "team" | "name">): string {
  return r.kind === "template" ? `/catalog/run?template=${encodeURIComponent(`${r.team}/${r.name}`)}` : `/catalog/run?action=${encodeURIComponent(r.name)}`;
}

/** An earlier run to start from ("Run again with changes" on a run's page), passed as the page's state. */
export interface RunFrom {
  name: string;
  parameters: Record<string, unknown>;
  onBehalfOf: string | null;
}

/** A schedule whose inputs the form changes (its Edit → Change inputs…), passed as the page's state. */
interface ScheduleEdit {
  id: string;
  name: string;
  team: string;
}

function scheduleFromState(state: unknown): ScheduleEdit | undefined {
  if (typeof state !== "object" || state === null || !("schedule" in state)) return undefined;
  const s = state.schedule as Partial<ScheduleEdit> | null;
  return typeof s?.id === "string" && typeof s.name === "string" && typeof s.team === "string" ? { id: s.id, name: s.name, team: s.team } : undefined;
}

function runFromState(state: unknown): RunFrom | undefined {
  if (typeof state !== "object" || state === null || !("from" in state)) return undefined;
  const from = state.from as Partial<RunFrom> | null;
  if (typeof from?.name !== "string" || typeof from.parameters !== "object" || from.parameters === null) return undefined;
  return { name: from.name, parameters: from.parameters, onBehalfOf: typeof from.onBehalfOf === "string" ? from.onBehalfOf : null };
}

/**
 * The same run as a curl command against the console's API
 * (console/docs/05-calling-the-api.md), for a pipeline with a bot's token.
 */
export function apiCall(runnable: Pick<Runnable, "kind" | "team" | "name">, parameters: Record<string, unknown>, onBehalfOf: string, origin: string): string {
  const forTeam = onBehalfOf ? { onBehalfOf } : {};
  const [method, body] =
    runnable.kind === "template"
      ? ["RunTemplate", { team: runnable.team, name: runnable.name, parameters, ...forTeam }]
      : ["RunAction", { product: runnable.name, inputs: parameters, ...forTeam }];
  const json = JSON.stringify(body, null, 2).replaceAll("'", "'\\''");
  return [
    `curl -s -X POST "${origin}/api/vertra.console.v1.TemplateService/${method}" \\`,
    `  -H "Authorization: Bearer $VERTRA_TOKEN" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${json}'`,
  ].join("\n");
}

/** "gcp-platform/project.create" → its parts, for "What will run". */
function stepOf(action: string): { team: string; product: string; action: string } {
  const [team = "", rest = action] = action.includes("/") ? action.split("/", 2) : ["", action];
  const dot = rest.lastIndexOf(".");
  return { team, product: dot > 0 ? rest.slice(0, dot) : rest, action: dot > 0 ? rest.slice(dot + 1) : "" };
}

/** The form for one runnable, once it's found. */
function RunForm({
  runnable,
  from,
  schedule,
  actionNamed,
}: {
  runnable: Runnable;
  from: RunFrom | undefined;
  schedule: ScheduleEdit | undefined;
  /** An action in the catalog, by its product's registered name: to say which step a refusal names. */
  actionNamed: (name: string) => Runnable | undefined;
}) {
  const navigate = useNavigate();
  const fields = useMemo(() => withTargets(fieldsOf(runnable.parameters), runnable.targets), [runnable]);
  const [values, setValues] = useState<Values>(() => (fields ? initialValues(runnable.parameters, fields, from?.parameters) : {}));
  const [json, setJson] = useState(() => JSON.stringify(from?.parameters ?? {}, null, 2));
  const [team, setTeam] = useState(
    from?.onBehalfOf && runnable.onBehalfOf.includes(from.onBehalfOf)
      ? from.onBehalfOf
      : runnable.onBehalfOfRequired && runnable.onBehalfOf.length === 1
        ? (runnable.onBehalfOf[0] ?? "")
        : "",
  );
  const [showCall, setShowCall] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const { user } = useAuth();
  // The teams it can be scheduled for: theirs to maintain, which it may run for.
  const scheduleTeams = (user?.maintainerOf ?? []).filter((t) => !runnable.onBehalfOfRequired || runnable.onBehalfOf.includes(t));
  const [previewed, setPreviewed] = useState<{ executionId: string; notPreviewed: NotPreviewed[] } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  // Refused because a step is for installs on another cloud: it's refused the same way until the catalog changes.
  const [refusal, setRefusal] = useState<ApiError | null>(null);
  const { install, cloud } = useInstall();
  const [running, setRunning] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

  /** Enter: runs it, or, editing a schedule, saves its inputs. */
  async function submit(event: FormEvent): Promise<void> {
    if (!schedule) return run(event);
    event.preventDefault();
    return saveToSchedule();
  }

  /** Saves the form's inputs to the schedule being edited, then back to its team's schedules. */
  async function saveToSchedule(): Promise<void> {
    if (!schedule) return;
    const parameters = checkedParameters(false);
    if (!parameters) return;
    setSavingSchedule(true);
    try {
      await updateSchedule(schedule.id, { parameters });
      navigate(`/teams/${encodeURIComponent(schedule.team)}?tab=schedules`);
    } catch (err) {
      refused(err);
      setSavingSchedule(false);
    }
  }

  /** The inputs as they'd be sent, or null (saying why, on the form) when they can't be. */
  function checkedParameters(needTeam = true): Record<string, unknown> | null {
    setErrors([]);
    let parameters: Record<string, unknown>;
    if (fields) {
      const typed = toParameters(fields, values);
      setFieldErrors(typed.errors);
      if (Object.keys(typed.errors).length > 0) return null;
      parameters = typed.parameters;
    } else {
      try {
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
        parameters = parsed as Record<string, unknown>;
      } catch {
        setErrors(["The inputs must be a JSON object."]);
        return null;
      }
    }
    if (needTeam && runnable.onBehalfOfRequired && !team) {
      setErrors(["Choose which of your teams it runs for."]);
      return null;
    }
    return parameters;
  }

  /** A refusal, on its fields where it names them. */
  function refused(err: unknown): void {
    if (isNotForThisInstall(err)) {
      setRefusal(err);
      setErrors([]);
    } else if (err instanceof ApiError && err.code === "INVALID_PARAMETERS") {
      const problems = serverProblems(err.problems);
      setFieldErrors(problems.fields);
      setErrors(problems.general.length > 0 || !fields ? [err.message] : []);
    } else {
      setErrors([err instanceof ApiError ? err.message : "Something went wrong. Try again."]);
    }
  }

  async function run(event: FormEvent): Promise<void> {
    event.preventDefault();
    const parameters = checkedParameters();
    if (!parameters) return;
    setRunning(true);
    try {
      navigate(`/runs/${encodeURIComponent(await runRunnable(runnable, parameters, team || undefined))}`);
    } catch (err) {
      refused(err);
      setRunning(false);
    }
  }

  async function preview(): Promise<void> {
    const parameters = checkedParameters();
    if (!parameters) return;
    setPreviewing(true);
    try {
      setPreviewed(await previewRunnable(runnable, parameters, team || undefined));
    } catch (err) {
      refused(err);
    } finally {
      setPreviewing(false);
    }
  }

  /** Fills the form with an example's inputs. */
  function fillWith(inputs: Record<string, unknown>): void {
    if (fields) setValues(initialValues(runnable.parameters, fields, inputs));
    setJson(JSON.stringify(inputs, null, 2));
    setFieldErrors({});
    setErrors([]);
  }

  const set = (name: string, value: FieldValue) => {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldErrors(({ [name]: _cleared, ...rest }) => rest);
  };

  /** What the form would send now, for the API call; null while something can't be read. */
  function current(): Record<string, unknown> | null {
    if (fields) {
      const typed = toParameters(fields, values);
      return Object.keys(typed.errors).length > 0 ? null : typed.parameters;
    }
    try {
      const parsed: unknown = JSON.parse(json);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  const parameters = showCall ? current() : null;

  const steps = runnable.actions.map(stepOf);
  const refusedAction = refusal ? actionNamed(refusedProduct(refusal) ?? "") : undefined;
  // Why Run is off, said beside it.
  const runWhy = !runnable.runsHere ? notHereReason(runnable.clouds, install, cloud) : refusal ? "Refused for this install: see why above." : null;
  return (
    <>
      {refusal && (
        <Box sx={{ mb: 2 }}>
          <NotForThisInstall
            error={refusal}
            what={runnable.kind === "template" ? { template: runnable.team } : "action"}
            product={refusedAction ? { name: refusedAction.displayName || refusedAction.name, team: refusedAction.team, clouds: refusedAction.clouds, cloudsFrom: refusedAction.cloudsFrom } : null}
          />
        </Box>
      )}
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "minmax(0, 3fr) minmax(0, 2fr)" }, alignItems: "start" }}>
        <Card component="form" noValidate onSubmit={(event: FormEvent) => void submit(event)} sx={{ p: 3, display: "flex", flexDirection: "column", gap: 2.5 }}>
          <Typography variant="h6" component="h2">
            Inputs
          </Typography>
          {from && !schedule && <Alert severity="info">Filled in from {from.name}. Change what you need, then run it.</Alert>}
          {fields ? (
            groupsOf(fields).map(({ group, fields: shown }) => (
              <Box key={group ?? "-"} component={group ? "fieldset" : "div"} sx={{ border: 0, m: 0, p: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 2.5 }}>
                {group && (
                  <Typography component="legend" variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: "uppercase", letterSpacing: 0.6, fontSize: 12 }}>
                    {group}
                  </Typography>
                )}
                {shown.map((field) => (
                  <FieldInput key={field.name} field={field} value={values[field.name]} error={fieldErrors[field.name]} onChange={set} />
                ))}
              </Box>
            ))
          ) : (
            <TextField
              label="Inputs (JSON)"
              value={json}
              onChange={(e) => { setJson(e.target.value); }}
              multiline
              minRows={4}
              slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: "monospace" } } }}
              helperText="A JSON object: its schema names no fields."
            />
          )}
          {(runnable.onBehalfOfRequired || runnable.onBehalfOf.length > 0) && (
            <TextField
              select
              label="Run for"
              value={team}
              onChange={(e) => { setTeam(e.target.value); }}
              required={runnable.onBehalfOfRequired}
              helperText={runnable.onBehalfOfRequired ? "It's shared with specific teams: which of yours is this run for?" : "Optional: which of your teams this run is for."}
            >
              {!runnable.onBehalfOfRequired && <MenuItem value="">Just me</MenuItem>}
              {runnable.onBehalfOf.map((name) => (
                <MenuItem key={name} value={name}>
                  {name}
                </MenuItem>
              ))}
            </TextField>
          )}
          {errors.map((message) => (
            <Alert key={message} severity="error">
              {message}
            </Alert>
          ))}
          {schedule ? (
            <Box sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
              <Button variant="contained" size="large" disabled={savingSchedule} onClick={() => void saveToSchedule()}>
                {savingSchedule ? "Saving…" : "Save to schedule"}
              </Button>
              <Button size="large" component={RouterLink} to={`/teams/${encodeURIComponent(schedule.team)}?tab=schedules`}>
                Cancel
              </Button>
              <Typography variant="body2" color="text.secondary">
                Checked against its schema; nothing runs until the schedule next starts it.
              </Typography>
            </Box>
          ) : (
            <Box sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
              <Button type="submit" variant="contained" size="large" disabled={running || runWhy !== null} aria-describedby={runWhy ? "run-why" : undefined}>
                {running ? "Starting…" : "Run"}
              </Button>
              {runnable.previewable && (
                <Button variant="outlined" size="large" disabled={previewing || running || !runnable.runsHere} onClick={() => void preview()}>
                  {previewing ? "Asking…" : "Preview"}
                </Button>
              )}
              {scheduleTeams.length > 0 && (
                <Button size="large" onClick={() => { setScheduling(true); }}>
                  Schedule…
                </Button>
              )}
              <Typography id="run-why" variant="body2" color="text.secondary">
                {runWhy ?? <>Checked against its schema, and this install, before anything runs.{runnable.previewable && " Preview says what it would change, first."}</>}
              </Typography>
            </Box>
          )}
          {scheduling && (
            <ScheduleDialog open onClose={() => { setScheduling(false); }} runnable={runnable} teams={scheduleTeams} parameters={() => checkedParameters(false)} />
          )}
          {previewed && (
            <Box sx={{ borderTop: 1, borderColor: "divider", pt: 2 }}>
              <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600, mb: 1 }}>
                What it would do
              </Typography>
              <PreviewResult key={previewed.executionId} executionId={previewed.executionId} notPreviewed={previewed.notPreviewed} />
            </Box>
          )}
        </Card>

        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
            <Typography variant="h6" component="h2">
              What will run
            </Typography>
            <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 1.25 }}>
              {steps.map((step, i) => {
                const notHere = refusedAction !== undefined && refusedAction.actions[0] === runnable.actions[i];
                return (
                  <Box component="li" key={`${String(i)}-${step.product}`} sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
                    <Box sx={{ flex: "0 0 26px", height: 26, borderRadius: "50%", bgcolor: "info.light", color: "info.main", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {i + 1}
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {step.product}
                        {step.action && ` · ${step.action}`}
                      </Typography>
                      <Typography variant="caption" color={notHere ? "error.dark" : "text.secondary"}>
                        {notHere ? "Refused: not for this install" : <>{step.team || runnable.team}&apos;s product, as its own identity</>}
                      </Typography>
                    </Box>
                    {notHere && (
                      <Box sx={{ ml: "auto", flexShrink: 0 }}>
                        <CloudPill clouds={refusedAction.clouds} />
                      </Box>
                    )}
                  </Box>
                );
              })}
            </Box>
            {refusal && (
              <Typography variant="caption" color="text.secondary">
                A bot, a schedule or the API gets the same answer: the same code and message, and no run.
              </Typography>
            )}
          </Card>
          {runnable.examples.length > 0 && (
            <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
              <Typography variant="h6" component="h2">
                Examples
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {runnable.kind === "template"
                  ? <>From {runnable.team}: ways it&apos;s meant to be run.</>
                  : <>From {runnable.team}&apos;s tests: inputs it&apos;s known to work with, and what it gave.</>}
              </Typography>
              {runnable.examples.map((example) => (
                <Box key={example.name} sx={{ display: "flex", flexDirection: "column", gap: 0.5, borderTop: 1, borderColor: "divider", pt: 1.25 }}>
                  <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {example.name}
                    </Typography>
                    <Button size="small" onClick={() => { fillWith(example.inputs); }}>
                      Use this
                    </Button>
                  </Box>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "fontFamilyMono", overflowWrap: "anywhere" }}>
                    {JSON.stringify(example.inputs)}
                    {runnable.kind === "action" && <> → {JSON.stringify(example.outputs)}</>}
                  </Typography>
                </Box>
              ))}
            </Card>
          )}
          <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1 }}>
            <Typography variant="h6" component="h2">
              Good to know
            </Typography>
            <Typography variant="body2">
              {runnable.team} sets which identity and secrets each step uses. You can&apos;t change them, and you never see their values.
            </Typography>
            {runnable.sourceUrl && (
              <Link href={runnable.sourceUrl} target="_blank" rel="noopener noreferrer" variant="body2">
                Its definition in the catalog ↗
              </Link>
            )}
          </Card>
          <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5, alignItems: "flex-start" }}>
            <Typography variant="h6" component="h2">
              From a pipeline
            </Typography>
            <Typography variant="body2" color="text.secondary">
              The same run with these inputs, as a call to the console&apos;s API with a bot&apos;s token (your team&apos;s Automation tab).
            </Typography>
            {!showCall ? (
              <Button variant="outlined" size="small" onClick={() => { setShowCall(true); }}>
                Show as an API call
              </Button>
            ) : parameters ? (
              <CodeBlock code={apiCall(runnable, parameters, team, window.location.origin)} copyLabel="Copy the call" />
            ) : (
              <Typography variant="body2" color="error">
                Fix the inputs to see the call.
              </Typography>
            )}
          </Card>
        </Box>
      </Box>
    </>
  );
}

/**
 * Running a template, or an action on its own (?template=<team>/<name> or
 * ?action=<product>, or the <team>/<product>.<action> a run records): a
 * form from its schema, filled in from an earlier run when there is one, which of your teams it runs
 * for when its sharing needs one, and what will run. Nothing else is chosen
 * here: each step's image, identity, secrets and namespace are its
 * product's (../../src/core/templates.ts). On success it opens the run.
 */
export function RunFormPage() {
  const [params] = useSearchParams();
  const state: unknown = useLocation().state;
  const from = runFromState(state);
  const schedule = scheduleFromState(state);
  const [runnables, setRunnables] = useState<Runnable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const template = params.get("template");
  const action = params.get("action");

  useEffect(() => {
    listRunnables()
      .then(setRunnables)
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load the catalog."); });
  }, []);

  const runnable = runnables?.find((r) => (template ? r.kind === "template" && `${r.team}/${r.name}` === template : r.kind === "action" && (r.name === action || r.actions[0] === action)));
  const problem =
    error ??
    (runnables && !runnable ? `Nothing called "${template ?? action ?? ""}" is in the catalog for you.` : null) ??
    (runnable && !runnable.shared ? `"${runnable.displayName}" isn't shared with you: ask ${runnable.team} for access.` : null);

  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        <Link component={RouterLink} to="/catalog">
          Catalog
        </Link>{" "}
        / {runnable?.displayName ?? template ?? action}
      </Typography>
      {runnable && (
        <>
          <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.25, mt: 0.75 }}>
            <Typography variant="h4" component="h1">
              {runnable.displayName}
            </Typography>
            {runnable.deprecated && (
              <Pill tone="warning" title={runnable.deprecated}>
                Deprecated
              </Pill>
            )}
          </Box>
          <Typography color="text.secondary" sx={{ mt: 0.5, mb: 3, maxWidth: 840 }}>
            {runnable.team} · {runnable.kind}
            {runnable.description && ` · ${runnable.description}`}
          </Typography>
          {!runnable.runsHere && (
            <Alert severity="info" icon={false} sx={{ mb: 2, display: "flex", alignItems: "center" }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                <CloudPill clouds={runnable.clouds} />
                Listed so you know it exists: it isn&apos;t checked or run on this install.
              </Box>
            </Alert>
          )}
          {runnable.deprecated && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Deprecated: {runnable.deprecated}
            </Alert>
          )}
          {(runnable.readiness?.state === "not_ready" || runnable.readiness?.state === "failed") && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {runnable.readiness.state === "not_ready" ? `${runnable.team} says it isn't ready on this install` : "Its readiness check couldn't say whether it's ready here"}
              {runnable.readiness.missing.length > 0 && `: missing ${runnable.readiness.missing.join("; ")}`}. A run may fail until {runnable.team} fixes it.
            </Alert>
          )}
        </>
      )}
      {problem && (
        <Alert severity="error" sx={{ my: 2 }}>
          {problem}
        </Alert>
      )}
      {!runnables && !error && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress size={28} aria-label="Loading" />
        </Box>
      )}
      {schedule && runnable?.shared && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Changing the inputs of the schedule <strong>{schedule.name}</strong> ({schedule.team}). Save to schedule keeps them; it runs with them from its next start.
        </Alert>
      )}
      {runnable?.shared && (
        <RunForm
          key={`${runnable.kind}:${runnable.team}/${runnable.name}`}
          runnable={runnable}
          from={from}
          schedule={schedule}
          actionNamed={(name) => runnables?.find((r) => r.kind === "action" && r.name === name)}
        />
      )}
    </Box>
  );
}
