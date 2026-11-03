// SPDX-License-Identifier: MIT
import { useId, useMemo, useState, type FormEvent } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, IconButton, Stack, TextField, Typography } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import {
  errorMessage,
  listTeamSecrets,
  registerExternalSecret,
  registerSecret,
  type SecretStoreSummary,
  type TeamSecret,
} from "../../api";
import { secretStatus } from "./SecretsTab";
import { gcpAccessFix, providerGuide } from "./providers";
import { CodeBlock } from "../../components/CodeBlock";
import { ChoiceCard, Steps } from "./shared";
import { Mono } from "../../components/Mono";

/** Pre-filled fields, e.g. when registering an ExternalSecret that was
 * created outside the console, so the team's products may mount it. */
export interface AddSecretPrefill {
  secretName?: string;
  storeName?: string;
  remoteKey?: string;
  property?: string;
  fileName?: string;
}

// Kubernetes object names: lowercase letters, digits and dashes.
const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
// A file name inside the mounted secret directory.
const FILE_PATTERN = /^[-._a-zA-Z0-9]+$/;

type Outcome = { kind: "saved"; secret: TeamSecret | null };

export function AddSecretFlow({
  teamName,
  stores,
  prefill,
  onConnect,
  onClose,
}: {
  teamName: string;
  stores: SecretStoreSummary[];
  prefill?: AddSecretPrefill;
  onConnect: () => void;
  onClose: (savedName?: string) => void;
}) {
  // 1 source, 2 details, 3 saved.
  const [step, setStep] = useState(1);
  const [source, setSource] = useState<string>(prefill?.storeName ?? "paste");
  const [secretName, setSecretName] = useState(prefill?.secretName ?? "");
  const [remoteKey, setRemoteKey] = useState(prefill?.remoteKey ?? "");
  const [property, setProperty] = useState(prefill?.property ?? "");
  const [fileName, setFileName] = useState(prefill?.fileName ?? "value");
  const [files, setFiles] = useState<{ name: string; value: string }[]>([{ name: "value", value: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const store = stores.find((s) => s.name === source);
  const guide = store ? providerGuide(store.provider) : undefined;
  const isSync = source !== "paste";

  const detailsError = useMemo(() => {
    if (!NAME_PATTERN.test(secretName)) return "Use lowercase letters, digits and dashes for the name.";
    if (isSync) {
      if (!remoteKey.trim()) return `Fill in the ${guide?.remoteKeyLabel.toLowerCase() ?? "remote secret"}.`;
      if (!FILE_PATTERN.test(fileName)) return "The file name can only use letters, digits, dots, dashes and underscores.";
      return null;
    }
    if (files.some((f) => !FILE_PATTERN.test(f.name))) return "File names can only use letters, digits, dots, dashes and underscores.";
    if (files.some((f) => f.value === "")) return "Every file needs a value.";
    if (new Set(files.map((f) => f.name)).size !== files.length) return "Each file needs a different name.";
    return null;
  }, [secretName, isSync, remoteKey, fileName, files, guide]);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (detailsError) {
      setError(detailsError);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (isSync) {
        await registerExternalSecret({
          namespace: teamName,
          secretName,
          secretStoreName: source,
          keys: [{ secretKey: fileName, remoteKey: remoteKey.trim(), ...(property.trim() ? { property: property.trim() } : {}) }],
        });
        // ESO fetches asynchronously; give it a few seconds so the next
        // screen can say whether it worked rather than "probably".
        let found: TeamSecret | null = null;
        for (let attempt = 0; attempt < 8; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          found = (await listTeamSecrets(teamName)).find((s) => s.secretName === secretName) ?? null;
          if (found?.external && found.external.status !== "syncing") break;
        }
        setOutcome({ kind: "saved", secret: found });
      } else {
        await registerSecret({
          namespace: teamName,
          secretName,
          data: Object.fromEntries(files.map((f) => [f.name, f.value])),
        });
        setOutcome({ kind: "saved", secret: null });
      }
      setStep(3);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the secret. Try again."));
    } finally {
      setSaving(false);
    }
  }

  const keys = isSync ? [fileName] : files.map((f) => f.name);

  return (
    <Box sx={{ maxWidth: 860 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 2 }}>
        <Button
          onClick={() => {
            onClose(outcome ? secretName : undefined);
          }}
        >
          ← Secrets
        </Button>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {prefill?.secretName ? `Register ${prefill.secretName}` : "Add a secret"}
        </Typography>
      </Box>
      <Steps labels={["Source", "Details"]} current={step} />

      <Card variant="outlined">
        <CardContent>
          {step === 1 && (
            <Stack spacing={1.5}>
              <Box>
                <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 600 }}>
                  Where does the value come from?
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Syncing keeps the value in your own store: change it there and Vertra picks up the change on its next
                  refresh.
                </Typography>
              </Box>
              {stores.map((s) => (
                <ChoiceCard
                  key={s.name}
                  selected={source === s.name}
                  onSelect={() => {
                    setSource(s.name);
                  }}
                  title={`Sync from ${s.providerLabel}`}
                  description={`${s.location ?? s.name}${s.ready === false ? " · can't connect right now" : ""}`}
                  badge={s.ready === false ? <Chip label="Can't connect" size="small" color="error" /> : undefined}
                />
              ))}
              <ChoiceCard
                selected={source === "paste"}
                onSelect={() => {
                  setSource("paste");
                }}
                title="Paste it here"
                description="For a value that doesn't live anywhere else. Replace it by pasting again."
              />
              <Button sx={{ alignSelf: "flex-start" }} startIcon={<AddIcon />} onClick={onConnect}>
                Connect another source
              </Button>
            </Stack>
          )}

          {step === 2 && (
            <Box component="form" onSubmit={(event: FormEvent) => void save(event)}>
              <Stack spacing={2}>
                <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 600 }}>
                  Details
                </Typography>
                <TextField
                  label="Secret name"
                  size="small"
                  value={secretName}
                  disabled={Boolean(prefill?.secretName)}
                  onChange={(event) => {
                    setSecretName(event.target.value);
                  }}
                  helperText="What your DAG lists in secretRefs. Lowercase letters, digits and dashes."
                />
                {isSync ? (
                  <>
                    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 2 }}>
                      <TextField
                        label={guide?.remoteKeyLabel ?? "Remote secret"}
                        size="small"
                        value={remoteKey}
                        onChange={(event) => {
                          setRemoteKey(event.target.value);
                        }}
                        helperText={store?.location ? `In ${store.location}.` : " "}
                      />
                      <TextField
                        label={guide?.propertyLabel ?? "Field (optional)"}
                        size="small"
                        value={property}
                        onChange={(event) => {
                          setProperty(event.target.value);
                        }}
                        helperText={guide?.propertyHint ?? "Only if you need one field of it."}
                      />
                    </Box>
                    <TextField
                      label="File name inside the container"
                      size="small"
                      value={fileName}
                      onChange={(event) => {
                        setFileName(event.target.value);
                      }}
                      sx={{ maxWidth: 320 }}
                    />
                  </>
                ) : (
                  <Stack spacing={1.5}>
                    <Typography variant="body2" color="text.secondary">
                      Each entry becomes one file in the container: a short value, or a whole file such as a key.json.
                    </Typography>
                    {files.map((file, index) => (
                      <Box key={index} sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
                        <Stack spacing={1} sx={{ flexGrow: 1 }}>
                          <TextField
                            label="File name"
                            size="small"
                            value={file.name}
                            onChange={(event) => {
                              setFiles((current) => current.map((f, i) => (i === index ? { ...f, name: event.target.value } : f)));
                            }}
                            sx={{ maxWidth: 320 }}
                          />
                          <SecretValueField
                            value={file.value}
                            onChange={(value) => {
                              setFiles((current) => current.map((f, i) => (i === index ? { ...f, value } : f)));
                            }}
                          />
                        </Stack>
                        <IconButton
                          aria-label="Remove this file"
                          disabled={files.length === 1}
                          onClick={() => {
                            setFiles((current) => current.filter((_, i) => i !== index));
                          }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Box>
                    ))}
                    <Button
                      size="small"
                      startIcon={<AddIcon />}
                      sx={{ alignSelf: "flex-start" }}
                      onClick={() => {
                        setFiles((current) => [...current, { name: "", value: "" }]);
                      }}
                    >
                      Add a file
                    </Button>
                  </Stack>
                )}
                <Box sx={{ bgcolor: "action.hover", borderRadius: 2, p: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Your action will read it at
                  </Typography>
                  {keys.map((key) => (
                    <Typography key={key} sx={{ overflowWrap: "anywhere" }}>
                      <Mono>
                        /platform/secrets/{secretName || "<name>"}/{key || "<file>"}
                      </Mono>
                    </Typography>
                  ))}
                </Box>
                {error && <Alert severity="error">{error}</Alert>}
                <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
                  <Button
                    onClick={() => {
                      setStep(1);
                    }}
                  >
                    Back
                  </Button>
                  <Button type="submit" variant="contained" disabled={saving}>
                    {saving ? (isSync ? "Saving and checking…" : "Saving…") : isSync ? "Save and check access" : "Save"}
                  </Button>
                </Box>
              </Stack>
            </Box>
          )}

          {step === 3 && outcome && (
            <SavedSummary
              teamName={teamName}
              secretName={secretName}
              keys={keys}
              synced={outcome.secret}
              store={store}
              remoteKey={remoteKey}
            />
          )}

          {step === 1 && (
            <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, mt: 3, pt: 2, borderTop: 1, borderColor: "divider" }}>
              <Button
                variant="contained"
                onClick={() => {
                  setStep(2);
                }}
              >
                Next
              </Button>
            </Box>
          )}
          {step === 3 && (
            <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 3 }}>
              <Button
                variant="contained"
                onClick={() => {
                  onClose(secretName);
                }}
              >
                Back to secrets
              </Button>
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

/**
 * A secret's value: masked as it's pasted, still multi-line
 * for a whole file such as a key.json, and never spell-checked, corrected
 * or remembered by the browser (enhanced spell check sends what it checks
 * to its vendor). Show unmasks it to check it.
 *
 * Masking is -webkit-text-security, which Chrome, Edge and Safari support
 * but Firefox doesn't: there the value shows as typed, so the field says so
 * and offers no Show (still never spell-checked or remembered).
 */
function SecretValueField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  const [canMask] = useState(() => typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-webkit-text-security", "disc"));
  const [shown, setShown] = useState(false);
  const masked = canMask && !shown;
  return (
    <Stack spacing={0.5}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Typography component="label" htmlFor={id} variant="body2" sx={{ fontWeight: 500 }}>
          Value
        </Typography>
        {canMask && (
          <Button
            size="small"
            variant="outlined"
            aria-pressed={shown}
            aria-controls={id}
            onClick={() => {
              setShown((s) => !s);
            }}
          >
            {shown ? "Hide" : "Show"}
          </Button>
        )}
      </Box>
      <TextField
        id={id}
        size="small"
        multiline
        minRows={2}
        maxRows={10}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        helperText={`${masked ? "Hidden as you paste, and never" : canMask ? "Never" : "This browser can't hide it as you paste. It's never"} spell-checked or suggested. Kept encrypted; nobody can read it back here.`}
        slotProps={{
          htmlInput: {
            spellCheck: false,
            autoComplete: "off",
            autoCorrect: "off",
            autoCapitalize: "off",
            "data-gramm": "false",
          },
        }}
        // Masked yet multi-line: a textarea can't be type="password".
        sx={masked ? { "& textarea": { WebkitTextSecurity: "disc" } } : undefined}
      />
    </Stack>
  );
}

function SavedSummary({
  teamName,
  secretName,
  keys,
  synced,
  store,
  remoteKey,
}: {
  teamName: string;
  secretName: string;
  keys: string[];
  synced: TeamSecret | null;
  store: SecretStoreSummary | undefined;
  remoteKey: string;
}) {
  const status = synced ? secretStatus(synced) : { label: "Ready", color: "success" as const };
  const failed = synced?.external?.status === "error";
  const fix =
    failed && store
      ? gcpAccessFix(store.provider, store.location, store.identity, remoteKey, synced.external?.message ?? null)
      : null;
  return (
    <Stack spacing={2}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Chip label={status.label} color={status.color} size="small" />
        <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 600 }}>
          {failed ? `${secretName} is saved, but can't be read yet` : `${secretName} is ready for ${teamName}'s products`}
        </Typography>
      </Box>
      {failed && (
        <Alert severity="error">
          <Typography variant="body2" sx={{ mb: fix ? 1 : 0 }}>
            {synced.external?.message}
          </Typography>
          {fix && <CodeBlock code={fix} />}
          <Typography variant="body2" sx={{ mt: 1 }}>
            Once that's fixed it syncs on its own; the Secrets list shows when.
          </Typography>
        </Alert>
      )}
      {synced?.external?.status === "syncing" && (
        <Alert severity="info">Still syncing. The Secrets list shows when it's done.</Alert>
      )}
      <Typography variant="body2" color="text.secondary">
        Any of the team's registered products may mount it: list it in the step's secretRefs. Nothing else can.
      </Typography>
      <Typography variant="subtitle2">Add this to the step in your DAG</Typography>
      <CodeBlock
        code={[
          "{",
          '  "id": "...",',
          '  "image": "...",',
          `  "team": "${teamName}",`,
          `  "secretRefs": ["${secretName}"]`,
          "}",
        ].join("\n")}
      />
      <Typography variant="subtitle2">Read it in your action</Typography>
      <CodeBlock
        code={keys
          .map((key) => `with open("/platform/secrets/${secretName}/${key}") as f:\n    ${key.replace(/\W/g, "_")} = f.read()`)
          .join("\n\n")}
      />
    </Stack>
  );
}
