// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { errorMessage, getChatConfig, resetChatConfig, setChatConfig, testChatConfig, type ChatConfig, type ChatConfigInput, type ChatTestResult } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { useAdminChanged } from "./summary";
import { AdminCard } from "./parts";

const PROVIDERS: { id: string; name: string; note: string; label: string; model: string }[] = [
  { id: "vertex", name: "Gemini on Vertex AI", note: "Google Cloud. No key: the console signs in as itself", label: "Gemini on Vertex AI (Google Cloud)", model: "google/gemini-3.5-flash" },
  { id: "bedrock", name: "Claude in Amazon Bedrock", note: "AWS. No key: signed as the console's AWS identity", label: "Claude in Amazon Bedrock (AWS)", model: "anthropic.claude-sonnet-5" },
  { id: "anthropic", name: "Claude through Anthropic's API", note: "An API key, kept encrypted", label: "Claude through Anthropic's API", model: "claude-haiku-5-5" },
  { id: "openai-compatible", name: "An OpenAI-compatible server", note: "LM Studio, Ollama… at an address you give", label: "An OpenAI-compatible server (LM Studio, Ollama…)", model: "qwen3-14b" },
];
const nameOf = (provider: string) => PROVIDERS.find((p) => p.id === provider)?.label ?? provider;

/** The providers as cards to choose from: a radio group, each with what it needs. */
function ProviderChoice({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <Box component="fieldset" sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}>
      <Typography component="legend" variant="body2" sx={{ fontWeight: 500, mb: 1 }}>
        Provider
      </Typography>
      <RadioGroup value={value} onChange={(e) => { onChange(e.target.value); }} sx={{ display: "grid", gap: 1.5, gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {PROVIDERS.map((p) => {
          const on = p.id === value;
          return (
            <FormControlLabel
              key={p.id}
              value={p.id}
              control={<Radio size="small" sx={{ mt: -0.5 }} />}
              label={
                <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {p.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {p.note}
                  </Typography>
                </Box>
              }
              sx={{ m: 0, alignItems: "flex-start", p: 1.5, border: 1, borderRadius: 2, borderColor: on ? "primary.main" : "divider", bgcolor: on ? "info.light" : "background.paper", boxShadow: on ? (t) => `inset 0 0 0 1px ${t.palette.primary.main}` : "none" }}
            />
          );
        })}
      </RadioGroup>
    </Box>
  );
}

/** What's sent: Vertex's and Bedrock's address is built from the project or region, so none (one typed for another provider stays hidden in the form). */
const sent = (form: ChatConfigInput): ChatConfigInput =>
  form.provider === "vertex" || form.provider === "bedrock" ? { ...form, endpoint: "" } : form;

/** The form's values from settings as they're set: a key is never among them. */
function formOf(c: ChatConfig): ChatConfigInput {
  return {
    enabled: c.enabled,
    provider: c.provider || "vertex",
    model: c.model,
    endpoint: c.endpoint,
    vertexProject: c.vertexProject,
    vertexLocation: c.vertexLocation || "global",
    bedrockRegion: c.bedrockRegion,
    effort: c.effort,
    // Left blank, the default; shown only when an admin set one.
    maxSteps: c.source === "admins" ? c.maxSteps : 0,
    contextTokens: c.source === "admins" ? c.contextTokens : 0,
    maxTokens: c.source === "admins" ? c.maxTokens : 0,
    apiKey: "",
  };
}

const whole = (value: string) => (/^\d+$/.test(value) ? Number(value) : 0);

function Field({ children, columns = 3 }: { children: ReactNode; columns?: number }) {
  return <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: `repeat(${String(columns)}, minmax(0, 1fr))` } }}>{children}</Box>;
}

/**
 * The chat agent's model (decision 24): what answers in Ask, set here in
 * place of the install's, or the install's. A key is typed once and kept
 * encrypted; Vertex and Bedrock need none (they sign in as the console). Test tries the
 * form as it is, before saving it.
 */
export function ChatSettingsCard() {
  const changed = useAdminChanged();
  const [saved, setSaved] = useState<ChatConfig | null>(null);
  const [form, setForm] = useState<ChatConfigInput | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tested, setTested] = useState<ChatTestResult | null>(null);
  const [resetting, setResetting] = useState(false);

  function show(c: ChatConfig): void {
    setSaved(c);
    setForm(formOf(c));
  }

  useEffect(() => {
    getChatConfig()
      .then(show)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the chat agent's settings.")); });
  }, []);

  if (!saved || !form) {
    return <AdminCard title="The model">{error ? <Alert severity="error">{error}</Alert> : <Typography color="text.secondary">Loading…</Typography>}</AdminCard>;
  }
  const set = (patch: Partial<ChatConfigInput>) => {
    setForm({ ...form, ...patch });
    setTested(null);
  };
  const example = PROVIDERS.find((p) => p.id === form.provider)?.model ?? "";
  // A key kept is the provider's: another provider's needs its own.
  const keyKept = saved.keySet && saved.provider === form.provider;

  async function act(what: "save" | "test" | "reset", run: () => Promise<void>, failed: string): Promise<void> {
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      await run();
      if (what !== "test") changed();
    } catch (err) {
      setError(errorMessage(err, failed));
    } finally {
      setBusy(null);
    }
  }
  const save = () =>
    act(
      "save",
      async () => {
        show(await setChatConfig(sent(form)));
        setNotice(form.enabled ? "Saved: in effect within seconds." : "Saved: the chat agent is off.");
      },
      "Couldn't save them.",
    );
  const test = () => act("test", async () => { setTested(await testChatConfig({ ...sent(form), enabled: true })); }, "Couldn't try them.");
  const reset = () =>
    act(
      "reset",
      async () => {
        show(await resetChatConfig());
        setResetting(false);
        setNotice("The install's settings are in effect again.");
      },
      "Couldn't go back to the install's.",
    );

  return (
    <AdminCard
      title="The model"
      status={
        saved.enabled && !saved.problem ? (
          <Pill tone="success" dot="success.main">
            On · {saved.source === "admins" ? "set here" : "the install's"}
          </Pill>
        ) : (
          <Pill tone="neutral">Off</Pill>
        )
      }
    >
      <Typography variant="body2" color="text.secondary">
        The model that answers in Ask: questions from the docs, and carts from the catalog.{" "}
        {saved.source === "install"
          ? saved.installModel
            ? `These are the install's settings (${nameOf(saved.installProvider)}). Saving your own replaces them until you go back.`
            : "The install sets no model: choose one here."
          : `Set here${saved.updatedBy ? ` by ${saved.updatedBy}` : ""}${saved.updatedAt ? `, ${new Date(saved.updatedAt).toLocaleString()}` : ""}${saved.installModel ? `, in place of the install's (${saved.installModel})` : ""}.`}
      </Typography>
      {saved.problem && (
        <Alert severity="error">
          These settings can&apos;t be used, so the chat agent is off: {saved.problem}
        </Alert>
      )}

      <FormControlLabel control={<Switch checked={form.enabled} onChange={(e) => { set({ enabled: e.target.checked }); }} />} label="People may ask the chat agent" />
      <ProviderChoice value={form.provider} onChange={(provider) => { set({ provider, model: "" }); }} />
      <Field>
        <TextField
          size="small"
          label="Model"
          value={form.model}
          placeholder={example}
          onChange={(e) => { set({ model: e.target.value }); }}
          helperText={
            form.provider === "vertex"
              ? "Empty: Gemini 3.5 Flash, the one scored"
              : form.provider === "bedrock"
                ? "Bedrock's name; empty: Claude Sonnet 5"
                : `Its name there, such as ${example}`
          }
        />
        {form.provider === "vertex" && (
          <>
            <TextField size="small" label="Google Cloud project" value={form.vertexProject} onChange={(e) => { set({ vertexProject: e.target.value }); }} helperText="Whose Vertex AI answers" />
            <TextField size="small" label="Location" value={form.vertexLocation} onChange={(e) => { set({ vertexLocation: e.target.value }); }} helperText="global, or a region to keep requests in it" />
          </>
        )}
        {form.provider === "bedrock" && (
          <TextField size="small" label="AWS region" value={form.bedrockRegion} placeholder="us-east-2" onChange={(e) => { set({ bedrockRegion: e.target.value }); }} helperText="Whose Bedrock answers: the install's own" />
        )}
        {form.provider !== "vertex" && form.provider !== "bedrock" && (
          <>
            <TextField
              size="small"
              label={form.provider === "anthropic" ? "Address (optional)" : "Server's address"}
              value={form.endpoint}
              placeholder={form.provider === "anthropic" ? "Anthropic's own" : "http://host:1234/v1"}
              onChange={(e) => { set({ endpoint: e.target.value }); }}
              helperText={form.provider === "anthropic" ? "Empty for Anthropic's API" : "Its base URL, ending /v1"}
            />
            <TextField
              size="small"
              type="password"
              label={form.provider === "anthropic" ? "API key" : "API key (optional)"}
              value={form.apiKey}
              onChange={(e) => { set({ apiKey: e.target.value }); }}
              autoComplete="new-password"
              helperText={keyKept ? "One is kept (encrypted, never shown): type to replace it" : "Kept encrypted, never shown again"}
            />
          </>
        )}
      </Field>
      {form.provider === "vertex" && (
        <Typography variant="caption" color="text.secondary">
          No key: the console signs in as its own Google identity, which needs <Mono>roles/aiplatform.user</Mono> in this project
          (<Mono>vennir apply</Mono> grants it on GCP).
        </Typography>
      )}
      {form.provider === "bedrock" && (
        <Typography variant="caption" color="text.secondary">
          No key: each request is signed as the console's own AWS identity, which needs <Mono>bedrock-mantle:CreateInference</Mono> on
          this model in this region (<Mono>vennir apply</Mono> grants it on AWS, for the model it sets up).
        </Typography>
      )}

      <Box sx={{ borderTop: 1, borderColor: "divider", pt: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Limits: what each answer may cost
        </Typography>
          <Field columns={4}>
            <TextField select size="small" label="Thinking" value={form.effort} onChange={(e) => { set({ effort: e.target.value }); }} slotProps={{ inputLabel: { shrink: true }, select: { displayEmpty: true } }}>
              <MenuItem value="">The model&apos;s own</MenuItem>
              <MenuItem value="low">Low</MenuItem>
              <MenuItem value="medium">Medium</MenuItem>
              <MenuItem value="high">High</MenuItem>
            </TextField>
            <TextField size="small" label="Steps per answer" value={form.maxSteps || ""} placeholder="8" onChange={(e) => { set({ maxSteps: whole(e.target.value) }); }} helperText="8 by default" />
            <TextField
              size="small"
              label="Context window (tokens)"
              value={form.contextTokens || ""}
              placeholder={form.provider === "openai-compatible" ? "16000" : "64000"}
              onChange={(e) => { set({ contextTokens: whole(e.target.value) }); }}
              helperText="What one call may be sent: it bounds each answer's cost"
            />
            <TextField
              size="small"
              label="Reply length (tokens)"
              value={form.maxTokens || ""}
              placeholder={form.provider === "openai-compatible" ? "1500" : "8000"}
              onChange={(e) => { set({ maxTokens: whole(e.target.value) }); }}
              helperText="Thinking counts toward it"
            />
          </Field>
      </Box>

      {tested &&
        (tested.ok ? (
          <Alert severity="success">
            {tested.model} answered in {tested.seconds} s{tested.citations > 0 ? `, citing ${String(tested.citations)} section${tested.citations === 1 ? "" : "s"}` : ""}: &ldquo;
            {tested.answer.length > 200 ? `${tested.answer.slice(0, 200)}…` : tested.answer}&rdquo;
          </Alert>
        ) : (
          <Alert severity="error">
            {tested.model} didn&apos;t answer: {tested.problem}
          </Alert>
        ))}
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}

      <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap", alignItems: "center", borderTop: 1, borderColor: "divider", pt: 2 }}>
        <Button variant="contained" disabled={busy !== null} onClick={() => { void save(); }} sx={{ minHeight: 44 }}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
        <Button variant="outlined" disabled={busy !== null} onClick={() => { void test(); }} sx={{ minHeight: 44 }}>
          {busy === "test" ? "Asking it…" : "Test"}
        </Button>
        {saved.source === "admins" && (
          <Button disabled={busy !== null} onClick={() => { setResetting(true); }} sx={{ minHeight: 44 }}>
            Use the install&apos;s
          </Button>
        )}
      </Box>
      <Typography variant="caption" color="text.secondary">
        Test asks it one question through the agent, as you, before you save. Score another model before relying on it (
        <Mono>npm run chat-eval</Mono>).
      </Typography>

      <ConfirmDialog
        open={resetting}
        title="Go back to the install's settings?"
        description={saved.installModel ? `The install's (${saved.installModel}) answer again; these, and their key, are forgotten.` : "The install sets no model: the chat agent will be off. These, and their key, are forgotten."}
        confirmLabel="Go back"
        busy={busy === "reset"}
        onConfirm={() => { void reset(); }}
        onCancel={() => { setResetting(false); }}
      />
    </AdminCard>
  );
}
