// SPDX-License-Identifier: MIT
import { useState } from "react";
import { Alert, Box, Button, Card, CardContent, TextField, Typography } from "@mui/material";
import { errorMessage, setSecretStoreCredential } from "../../api";

/**
 * The stored credential this team's SecretStores may use, for a provider
 * that can't trust the cluster's identity (1Password): the Secret eso-auth,
 * which no step can mount. This install's own: the catalog carries the
 * stores, never their credential. Write-only: it's never shown again.
 */
export function StoredCredential({ teamName }: { teamName: string }) {
  const [credential, setCredential] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(): Promise<void> {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await setSecretStoreCredential(teamName, credential);
      setCredential("");
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the credential."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card variant="outlined" sx={{ mb: 4, maxWidth: 640 }}>
      <CardContent>
        <Typography sx={{ fontWeight: 600, mb: 0.5 }}>Stored credential</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          For a source that can't trust this cluster directly, such as 1Password: its token, which your team's
          SecretStore reads from <code>eso-auth</code>. Kept in this install only, never in git, and never shown again.
          Saving replaces the one there.
        </Typography>
        <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
          <TextField
            size="small"
            type="password"
            autoComplete="off"
            label="Token"
            fullWidth
            value={credential}
            onChange={(event) => {
              setCredential(event.target.value);
            }}
          />
          <Button variant="outlined" disabled={saving || credential.trim() === ""} onClick={() => void save()}>
            Save
          </Button>
        </Box>
        {saved && (
          <Alert severity="success" sx={{ mt: 2 }}>
            Saved. The team's SecretStores use it from their next refresh.
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
