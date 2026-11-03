// SPDX-License-Identifier: MIT
import { useDeferredValue, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { Alert, Autocomplete, Box, Button, Card, Link, TextField, Typography } from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import { errorMessage, getImagePolicy, listProducts, submitExecution, type Product } from "../api";
import { useAuth } from "../auth/AuthContext";
import { checkDag } from "../dagCheck";

/** How many problems to list before "and N more" -- fixing the first few
 * usually clears the rest. */
const MAX_ISSUES_SHOWN = 8;

/** A DAG that passes every check for this user: one of their teams and an
 * image under the first allowed source. No requestId: without one, every
 * submission is a new run, which is what someone pasting by hand wants. The
 * image name itself is a placeholder to replace. */
function exampleFor(team: string, source: string | undefined): string {
  return dumpYaml({
    name: "my-first-execution",
    tasks: [
      {
        id: "create-project",
        image: `${source ?? "registry.example.com/products/"}your-product:latest`,
        action: "create",
        team,
        inputs: { projectName: "demo-project" },
      },
    ],
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The DAG with a step of this product added: its latest image, its action,
 * team and identity, and its required inputs left to fill in. Null when the
 * text isn't a DAG to add to. Written back as YAML.
 */
export function withStep(text: string, product: Product): string | null {
  let dag: unknown;
  try {
    dag = text.trim() === "" ? { name: "my-run", tasks: [] } : parseYaml(text);
  } catch {
    return null;
  }
  if (!isRecord(dag)) return null;
  const tasks: unknown = dag["tasks"] ?? [];
  if (!Array.isArray(tasks)) return null;
  const taken = new Set(tasks.map((t) => (isRecord(t) ? t["id"] : undefined)));
  const base = product.teamName && product.name.startsWith(`${product.teamName}-`) ? product.name.slice(product.teamName.length + 1) : product.name;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${String(n)}`;
  const properties = isRecord(product.inputSchema["properties"]) ? product.inputSchema["properties"] : {};
  const required = Array.isArray(product.inputSchema["required"]) ? product.inputSchema["required"].filter((r): r is string => typeof r === "string") : [];
  const inputs = Object.fromEntries(required.map((name) => {
    const property = properties[name];
    return [name, isRecord(property) && "default" in property ? property["default"] : ""];
  }));
  const step: Record<string, unknown> = { id, image: product.image, action: product.action, team: product.teamName ?? "" };
  if (product.serviceAccount) step["serviceAccount"] = product.serviceAccount;
  if (required.length > 0) step["inputs"] = inputs;
  return dumpYaml({ ...dag, tasks: [...tasks, step] });
}

export function SubmitExecutionPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // The page works without these (the server checks both regardless); they
  // let the editor flag a disallowed image or a team you're not in as you
  // type instead of after Submit.
  const [allowedSources, setAllowedSources] = useState<string[] | null>(null);
  useEffect(() => {
    getImagePolicy()
      .then((policy) => {
        setAllowedSources(policy.allowed);
      })
      .catch(() => undefined);
  }, []);
  // Your teams' products, for "Add a step" (admins: every team's).
  const [products, setProducts] = useState<Product[]>([]);
  useEffect(() => {
    listProducts()
      .then(setProducts)
      .catch(() => undefined);
  }, []);
  const [text, setText] = useState("");
  const [addProblem, setAddProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Checked on every edit, but deferred so typing in a long DAG never lags.
  const deferredText = useDeferredValue(text);
  // A raw DAG is a maintainer's (../../src/core/executions.ts).
  const teamNames = useMemo(() => (user?.isAdmin ? null : (user?.maintainerOf ?? [])), [user]);
  const exampleTeam = user?.maintainerOf[0] ?? user?.teamNames[0] ?? "your-team";
  const exampleSource = allowedSources?.[0];
  // Shown below the editor; generated once per team/source, not per render.
  const example = useMemo(() => exampleFor(exampleTeam, exampleSource), [exampleTeam, exampleSource]);
  const check = useMemo(
    () => checkDag(deferredText, { allowedSources, teamNames }, (value) => dumpYaml(value)),
    [deferredText, allowedSources, teamNames],
  );
  const upToDate = deferredText === text;
  const valid = check.status === "valid" && upToDate;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (check.status !== "valid" || !upToDate) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await submitExecution(check.payload);
      navigate(`/runs/${encodeURIComponent(result.executionId)}`);
    } catch (err) {
      setError(errorMessage(err, "Something went wrong. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  const yours = products.filter((p) => p.teamName !== null && (teamNames === null || teamNames.includes(p.teamName)));
  const borderColor = check.status === "valid" ? "success.main" : check.status === "invalid" ? "error.main" : undefined;

  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        <Link component={RouterLink} to="/runs">
          Runs
        </Link>{" "}
        / Submit new
      </Typography>
      <Typography variant="h4" component="h1" sx={{ mt: 0.75 }}>
        Submit a DAG
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5, mb: 3, maxWidth: 840 }}>
        For a team&apos;s maintainers: steps of your team&apos;s registered products, wired together. To run what another team
        publishes, use the{" "}
        <Link component={RouterLink} to="/catalog">
          Catalog
        </Link>
        .
      </Typography>
      {allowedSources !== null && (
        <Alert severity={allowedSources.length === 0 ? "warning" : "info"} sx={{ mb: 2 }}>
          {allowedSources.length === 0
            ? "No image source is configured yet, so nothing can run. An admin sets it on the Admin page."
            : `Task images must come from: ${allowedSources.join(", ")}`}
        </Alert>
      )}

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "minmax(0, 3fr) minmax(0, 2fr)" }, alignItems: "start" }}>
        <Card component="form" onSubmit={(event: FormEvent) => void handleSubmit(event)} sx={{ p: 3 }}>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 1.5 }}>
            <Typography variant="h6" component="h2">
              Your DAG
            </Typography>
            <Button
              size="small"
              onClick={() => {
                setError(null);
                setText(exampleFor(exampleTeam, exampleSource));
              }}
            >
              Start from an example
            </Button>
          </Box>
          {yours.length > 0 && (
            <Autocomplete
              options={yours}
              value={null}
              blurOnSelect
              groupBy={(p) => p.teamName ?? ""}
              getOptionLabel={(p) => `${p.displayName ?? p.name} · ${p.action}`}
              onChange={(_e, product) => {
                if (!product) return;
                const next = withStep(text, product);
                setAddProblem(next === null ? "Fix the DAG first: a step is added to its tasks." : null);
                if (next !== null) setText(next);
              }}
              renderInput={(params) => (
                <TextField {...params} size="small" label="Add a step" helperText={addProblem ?? "With its product's latest image, team and identity; fill in its inputs."} error={addProblem !== null} />
              )}
              sx={{ mb: 2 }}
            />
          )}
          <TextField
            label="DAG (JSON or YAML)"
            required
            fullWidth
            multiline
            minRows={16}
            value={text}
            error={check.status === "invalid"}
            color={check.status === "valid" ? "success" : "primary"}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            sx={{
              "& textarea": { fontFamily: "fontFamilyMono", fontSize: 13 },
              ...(borderColor && {
                "& .MuiOutlinedInput-notchedOutline, & .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline": {
                  borderColor,
                  borderWidth: 2,
                },
              }),
            }}
            slotProps={{
              htmlInput: {
                spellCheck: false,
                "aria-invalid": check.status === "invalid",
              },
            }}
          />

          {check.status === "valid" && (
            <Alert severity="success" icon={<CheckCircleIcon />} sx={{ mt: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Valid DAG ({check.format}): {check.taskCount} {check.taskCount === 1 ? "task" : "tasks"}
              </Typography>
              {check.stages.length > 1 && (
                <Typography variant="body2" sx={{ mt: 0.5, fontFamily: "fontFamilyMono" }}>
                  Runs in order: {check.stages.map((stage) => stage.join(" + ")).join("  →  ")}
                </Typography>
              )}
            </Alert>
          )}
          {check.status === "invalid" && (
            <Alert severity="error" icon={<ErrorOutlineIcon />} sx={{ mt: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                {check.issues.length === 1 ? "1 thing to fix" : `${String(check.issues.length)} things to fix`} before
                this can be submitted:
              </Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                {check.issues.slice(0, MAX_ISSUES_SHOWN).map((issue, i) => (
                  <li key={i}>
                    <Typography variant="body2">
                      {issue.where && (
                        <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontWeight: 600 }}>
                          {issue.where}:{" "}
                        </Box>
                      )}
                      {issue.message}
                    </Typography>
                  </li>
                ))}
              </Box>
              {check.issues.length > MAX_ISSUES_SHOWN && (
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  …and {check.issues.length - MAX_ISSUES_SHOWN} more.
                </Typography>
              )}
              {check.whitespaceFix && (
                <Button
                  size="small"
                  variant="outlined"
                  color="error"
                  sx={{ mt: 1 }}
                  onClick={() => {
                    if (check.whitespaceFix) setText(check.whitespaceFix.text);
                  }}
                >
                  Remove the whitespace
                </Button>
              )}
            </Alert>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              The server refused it: {error}
            </Alert>
          )}
          <Button type="submit" variant="contained" size="large" disabled={!valid || submitting} sx={{ mt: 2 }}>
            {submitting ? "Submitting…" : "Submit"}
          </Button>
        </Card>

        <Card sx={{ p: 3 }}>
          <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
            What a DAG looks like
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Each task needs an <code>id</code>, <code>image</code>, <code>action</code> and <code>team</code> (one you're a
            member of). Optional: <code>dependsOn</code> (task ids that must finish first), <code>inputs</code>,{" "}
            <code>secretRefs</code> (your team's secrets, for a registered product), <code>timeoutSeconds</code>,{" "}
            <code>maxAttempts</code>, and <code>serviceAccount</code> (left out, a product runs as its own).
            A task can use an earlier task's output with <code>{"{ $fromTask: <id>, $output: <name> }"}</code>, as long as
            that task is in its <code>dependsOn</code>.
          </Typography>
          <Box
            component="pre"
            tabIndex={0}
            sx={{ m: 0, p: 2, borderRadius: 2, bgcolor: "code.background", color: "code.text", fontFamily: "fontFamilyMono", fontSize: 12.5, whiteSpace: "pre-wrap", overflowX: "auto" }}
          >
            {example}
          </Box>
        </Card>
      </Box>
    </Box>
  );
}
