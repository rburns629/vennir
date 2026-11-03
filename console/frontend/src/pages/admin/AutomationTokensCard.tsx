// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { when } from "../../time";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { DEFAULT_TOKEN_DAYS, expiryText, TokenLifetime } from "../../components/TokenLifetime";
import { AdminCard, Aside } from "./parts";
import { useAdminChanged, workingTokens } from "./summary";
import { AUTOMATION_SCOPES, errorMessage, createAutomationToken, listAutomationTokens, revokeToken, type AutomationToken } from "../../api";

/** Platform-wide tokens for automation: each holds
 * specific permissions instead of team membership, so it can't read
 * secrets, submit tasks, or mint other tokens. Team-scoped bots still live
 * on each team's page. */
export function AutomationTokensCard() {
  const [tokens, setTokens] = useState<AutomationToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(
    AUTOMATION_SCOPES.filter((s) => s.defaultOn).map((s) => s.scope),
  );
  const [days, setDays] = useState(DEFAULT_TOKEN_DAYS);
  const [submitting, setSubmitting] = useState(false);
  const [justIssued, setJustIssued] = useState<{ label: string; token: string } | null>(null);
  const [revoking, setRevoking] = useState<AutomationToken | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  function reload(): void {
    listAutomationTokens()
      .then(setTokens)
      .catch((err: unknown) => {
        setError(errorMessage(err, "Failed to load automation tokens."));
      });
  }

  useEffect(reload, []);

  const changed = useAdminChanged();
  async function handleCreate(): Promise<void> {
    setError(null);
    setJustIssued(null);
    setSubmitting(true);
    try {
      const result = await createAutomationToken(label, scopes, days);
      setJustIssued({ label: result.label, token: result.token });
      setLabel("");
      reload();
      changed();
    } catch (err) {
      setError(errorMessage(err, "Something went wrong. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(): Promise<void> {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await revokeToken(revoking.id);
      reload();
      changed();
    } catch (err) {
      setError(errorMessage(err, "Revoke failed."));
    } finally {
      setRevokeBusy(false);
      setRevoking(null);
    }
  }

  const columns: DataTableColumn<AutomationToken>[] = [
    { key: "label", header: "Label", render: (t) => <Box sx={{ fontWeight: 600 }}>{t.label}</Box> },
    {
      key: "scopes",
      header: "Can",
      render: (t) => (
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
          {t.scopes.map((scope) => (
            <Chip key={scope} label={scope} size="small" variant="outlined" />
          ))}
        </Box>
      ),
    },
    { key: "created", header: "Created", render: (t) => when(t.createdAt), hideBelow: "sm" },
    { key: "expires", header: "Expiry", render: (t) => expiryText(t.expiresAt) },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (t) => (
        <Button size="small" color="error" onClick={() => { setRevoking(t); }}>
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <>
    <AdminCard title="Tokens" status={tokens && <Aside>{workingTokens(tokens).length} active</Aside>}>
        <Typography variant="body2" color="text.secondary">
          For platform automation of your own. A token can do only what's ticked below. It
          belongs to no team, so it can't read secrets, submit tasks, or create other tokens.
          The catalog needs none: this console reads the catalog's release itself (Admin,
          Catalog).
        </Typography>

        {justIssued && (
          <Alert severity="success">
            Token for "{justIssued.label}": <code style={{ wordBreak: "break-all" }}>{justIssued.token}</code>
            <br />
            Copy it now; it won't be shown again. Store it as a secret wherever the automation
            runs.
          </Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}

        <DataTable columns={columns} rows={tokens} getRowKey={(t) => t.id} emptyMessage="No automation tokens yet." />
      </AdminCard>

      <AdminCard title="Issue a token">
        <Stack spacing={1} sx={{ maxWidth: 560 }}>
          <TextField
            size="small"
            label="Label"
            placeholder="e.g. nightly report job"
            value={label}
            onChange={(event) => { setLabel(event.target.value); }}
          />
          {AUTOMATION_SCOPES.map(({ scope, description }) => (
            <FormControlLabel
              key={scope}
              control={
                <Checkbox
                  size="small"
                  checked={scopes.includes(scope)}
                  onChange={(event) => {
                    setScopes((current) =>
                      event.target.checked ? [...current, scope] : current.filter((s) => s !== scope),
                    );
                  }}
                />
              }
              label={
                <Typography variant="body2">
                  <code>{scope}</code> — {description}
                </Typography>
              }
            />
          ))}
          <TokenLifetime days={days} onChange={setDays} />
          <Box>
            <Button
              variant="contained"
              disabled={submitting || !label.trim() || scopes.length === 0}
              onClick={() => void handleCreate()}
              sx={{ minHeight: 44 }}
            >
              {submitting ? "Creating…" : "Create token"}
            </Button>
          </Box>
        </Stack>
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this token?"
        description={`"${revoking?.label ?? ""}" will stop working immediately. Any pipeline still using it will start failing to authenticate.`}
        confirmLabel="Revoke token"
        destructive
        busy={revokeBusy}
        onConfirm={() => void handleRevoke()}
        onCancel={() => { setRevoking(null); }}
      />
    </AdminCard>
    </>
  );
}
