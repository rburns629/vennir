// SPDX-License-Identifier: MIT
import { useState } from "react";
import { Alert, Box, Button, MenuItem, Stack, TextField, Typography } from "@mui/material";
import LinkIcon from "@mui/icons-material/LinkOutlined";
import { errorMessage, addBotIdentity, removeBotIdentity, type BotIdentity } from "../../api";
import { CodeBlock } from "../../components/CodeBlock";
import { Mono } from "../../components/Mono";
import { BotPart, relativeTime } from "./shared";

const GITHUB = "https://token.actions.githubusercontent.com";
const GITLAB = "https://gitlab.com";

/** What each CI calls the repository its job runs in, and how its job gets an ID token. */
export const CI: Record<string, { name: string; repo: string; repoLabel: string; snippet: (audience: string, consoleUrl: string) => string }> = {
  [GITHUB]: {
    name: "GitHub Actions",
    repo: "repository",
    repoLabel: "Repository (owner/name)",
    snippet: (audience, consoleUrl) =>
      [
        "permissions:",
        "  id-token: write   # the job's own identity, instead of a stored token",
        "steps:",
        "  - name: Sign in to Vertra",
        "    run: |",
        `      ID=$(curl -sH "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${audience}" | jq -r .value)`,
        `      TOKEN=$(jq -n --arg t "$ID" '{idToken: $t}' | curl -s -X POST ${consoleUrl}/api/vertra.console.v1.AuthService/ExchangeToken -H 'Content-Type: application/json' -d @- | jq -r .token)`,
        '      echo "::add-mask::$TOKEN"; echo "VERTRA_TOKEN=$TOKEN" >> "$GITHUB_ENV"',
      ].join("\n"),
  },
  [GITLAB]: {
    name: "GitLab CI",
    repo: "project_path",
    repoLabel: "Project (group/name)",
    snippet: (audience, consoleUrl) =>
      [
        "deploy:",
        "  id_tokens:",
        "    VERTRA_ID_TOKEN:",
        `      aud: ${audience}`,
        "  script:",
        `    - export VERTRA_TOKEN=$(jq -n --arg t "$VERTRA_ID_TOKEN" '{idToken: $t}' | curl -s -X POST ${consoleUrl}/api/vertra.console.v1.AuthService/ExchangeToken -H 'Content-Type: application/json' -d @- | jq -r .token)`,
      ].join("\n"),
  },
};

/** An identity's claims as one line: "repository acme/infra · ref refs/heads/main". */
export const claimsText = (claims: Record<string, string>) =>
  Object.entries(claims)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");

/**
 * A bot signing in from CI with no stored token: its identities (which
 * repository's jobs, perhaps which branch), adding and removing them
 * (maintainers), and the job's snippet.
 */
export function KeylessSection({
  teamName,
  botId,
  identities,
  issuers,
  audience,
  readOnly,
  onChanged,
}: {
  teamName: string;
  botId: string;
  identities: BotIdentity[];
  issuers: string[];
  audience: string;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const known = issuers.filter((i) => i in CI);
  const [issuer, setIssuer] = useState(known[0] ?? "");
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const ci = CI[issuer];
  if (known.length === 0) return null;

  async function add(): Promise<void> {
    if (!ci) return;
    setError(null);
    try {
      await addBotIdentity(teamName, botId, issuer, { [ci.repo]: repo.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) });
      setRepo("");
      setRef("");
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Couldn't add it."));
    }
  }

  return (
    <BotPart
      title="Signs in from CI, with no token"
      action={
        !readOnly && !adding ? (
          <Button size="small" variant="outlined" color="inherit" onClick={() => { setError(null); setAdding(true); }}>
            Sign in from CI…
          </Button>
        ) : undefined
      }
    >
      {identities.length === 0 && !adding && (
        <Typography variant="body2" color="text.secondary">
          None yet: a job can sign in as this bot with its own identity instead of a stored token.
        </Typography>
      )}
      {identities.map((i) => (
        <Box
          key={i.id}
          sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1.5, p: 1.5, borderRadius: 2, bgcolor: "background.default", flexWrap: "wrap" }}
        >
          <Box sx={{ display: "flex", gap: 1.5, alignItems: "center", minWidth: 0 }}>
            <LinkIcon fontSize="small" sx={{ color: "text.secondary" }} aria-hidden="true" />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {CI[i.issuer]?.name ?? i.issuer}
              </Typography>
              <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
                <Mono>{claimsText(i.claims)}</Mono>
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {i.createdAt && `added ${relativeTime(i.createdAt)} · `}last used {relativeTime(i.lastUsedAt)}
              </Typography>
            </Box>
          </Box>
          {!readOnly && (
            <Button size="small" color="error" onClick={() => void removeBotIdentity(i.id).then(onChanged, (err: unknown) => { setError(errorMessage(err, "Couldn't remove it.")); })}>
              Remove
            </Button>
          )}
        </Box>
      ))}
      {adding && ci && (
        <Stack spacing={1.5} sx={{ p: 1.5, bgcolor: "background.default", borderRadius: 2 }}>
          <TextField select size="small" label="CI" value={issuer} onChange={(e) => { setIssuer(e.target.value); }}>
            {known.map((i) => (
              <MenuItem key={i} value={i}>
                {CI[i]?.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField size="small" label={ci.repoLabel} value={repo} onChange={(e) => { setRepo(e.target.value); }} placeholder="acme/release-pipeline" />
          <TextField size="small" label="Only from this branch (optional)" value={ref} onChange={(e) => { setRef(e.target.value); }} placeholder="refs/heads/main" />
          {error && <Alert severity="error">{error}</Alert>}
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button size="small" variant="contained" disabled={!repo.trim()} onClick={() => void add()}>
              Add
            </Button>
            <Button size="small" onClick={() => { setError(null); setAdding(false); }}>
              Cancel
            </Button>
          </Box>
          <Typography variant="caption" color="text.secondary">
            In the job, instead of a stored token:
          </Typography>
          <CodeBlock code={ci.snippet(audience, window.location.origin)} />
        </Stack>
      )}
      {!adding && error && <Alert severity="error">{error}</Alert>}
    </BotPart>
  );
}
