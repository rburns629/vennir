// SPDX-License-Identifier: MIT
import { useState } from "react";
import { Alert, Box, Button, Stack, TextField, Typography } from "@mui/material";
import { CodeBlock } from "./CodeBlock";
import { Mono } from "./Mono";
import { errorMessage } from "../api";
import { when } from "../time";

export interface CallbackState {
  host: string;
  lastSentAt: string | null;
  lastError: string | null;
}

/**
 * A callback for systems (an ordering bot's, a team's outcome webhook):
 * where it posts, signed, and how the last post went; for those who may
 * change it, its URL (never shown again), a new secret, or none. A secret
 * is shown once, when it's made.
 */
export function SignedCallback({
  current,
  editable,
  none,
  save,
  onSaved,
}: {
  current: CallbackState | null;
  editable: boolean;
  /** What's said when there's none. */
  none: string;
  /** Sets it (an empty url removes it); resolves to the secret when it's new, else "". */
  save: (url: string, rotateSecret: boolean) => Promise<string>;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(next: string, rotate = false): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setSecret((await save(next, rotate)) || null);
      setUrl("");
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save it. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={1}>
      {current ? (
        <Box
          role="status"
          sx={{
            p: 1.5,
            borderRadius: 2,
            bgcolor: current.lastError ? "warning.light" : "background.default",
          }}
        >
          <Typography variant="body2">
            Posts to <Mono>{current.host}</Mono>, signed{current.lastSentAt ? `; last ${when(current.lastSentAt)}` : "; nothing posted yet"}.
          </Typography>
          {current.lastError && (
            <Typography variant="body2" sx={{ color: "warning.main" }}>
              The last post didn&apos;t go: {current.lastError}
            </Typography>
          )}
        </Box>
      ) : (
        <Typography variant="body2">{none}</Typography>
      )}
      {editable && (
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "flex-start" } }}>
          <TextField
            label={current ? "A new URL" : "URL"}
            type="password"
            autoComplete="off"
            size="small"
            value={url}
            onChange={(e) => { setUrl(e.target.value); }}
            helperText="https://, under a host this install allows; never shown again"
            sx={{ flexGrow: 1 }}
          />
          <Button variant="outlined" color="inherit" disabled={busy || url.trim() === ""} onClick={() => void submit(url.trim())}>
            Save
          </Button>
          {current && (
            <>
              <Button variant="outlined" color="inherit" sx={{ whiteSpace: "nowrap" }} disabled={busy || url.trim() === ""} onClick={() => void submit(url.trim(), true)}>
                Save with a new secret
              </Button>
              <Button size="small" color="error" disabled={busy} onClick={() => void submit("")}>
                Remove
              </Button>
            </>
          )}
        </Stack>
      )}
      {secret && (
        <Alert severity="success" onClose={() => { setSecret(null); }}>
          <Stack spacing={1}>
            <Typography variant="body2">
              Its signing secret, shown only now. Each post carries <Mono>Vennir-Signature: t=…,v1=…</Mono>: the HMAC-SHA256 of{" "}
              <Mono>{"<t>.<body>"}</Mono> with this secret, in hex.
            </Typography>
            <CodeBlock code={secret} />
          </Stack>
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}
