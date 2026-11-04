// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, Link, Stack, TextField, Typography } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { errorMessage, getPlatform, type PlatformInfo } from "../../api";
import { PROVIDERS, newFileUrl, secretStoreFile, type ProviderId } from "./providers";
import { catalogFileUrl } from "../../catalogFile";
import { CodeBlock } from "../../components/CodeBlock";
import { ChoiceCard, Facts, NotYetTested, Steps } from "./shared";
import { Mono } from "../../components/Mono";

/**
 * Connecting a secret source is a privileged scope grant, so it goes
 * through a reviewed catalog PR, not a button here. This wizard does
 * everything up to that point: says what the provider must trust, gives
 * the commands to run on the provider's side, and writes the file for the
 * PR. Once merged, each install's console applies it from the catalog's next
 * release.
 */
export function ConnectSource({
  teamName,
  hasExistingStores,
  onClose,
}: {
  teamName: string;
  hasExistingStores: boolean;
  onClose: () => void;
}) {
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState(1);
  const [providerId, setProviderId] = useState<ProviderId | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    getPlatform()
      .then(setPlatform)
      .catch((err: unknown) => {
        setLoadError(errorMessage(err, "Couldn't load this cluster's details."));
      });
  }, []);

  const facts = platform?.secretSources;
  const guide = PROVIDERS.find((p) => p.id === providerId);

  useEffect(() => {
    if (!facts || providerId) return;
    const first = PROVIDERS.find((p) => !p.unavailable(facts));
    if (first) {
      setProviderId(first.id);
      setValues(first.defaults(teamName));
    }
  }, [facts, providerId, teamName]);

  const manifest = guide && facts ? guide.manifest(teamName, facts, values) : "";
  const repo = facts?.catalogRepo ?? "";

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 2 }}>
        <Button onClick={onClose}>← Secrets</Button>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Connect a source
        </Typography>
      </Box>
      <Steps labels={["Choose a source", "Set up access", "Review and approve"]} current={step} />
      {loadError && <Alert severity="error">{loadError}</Alert>}

      {facts && step === 1 && (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" }, gap: 1.5, maxWidth: 960 }}>
          {PROVIDERS.map((p) => {
            const unavailable = p.unavailable(facts);
            return (
              <ChoiceCard
                key={p.id}
                selected={providerId === p.id}
                disabled={Boolean(unavailable)}
                onSelect={() => {
                  setProviderId(p.id);
                  setValues(p.defaults(teamName));
                }}
                title={p.title}
                badge={p.tested ? <Chip label="Tested" size="small" color="success" variant="outlined" /> : <NotYetTested />}
                description={
                  <>
                    {p.description}
                    <br />
                    <strong>Stored credential:</strong> {p.credential}
                    {unavailable && (
                      <>
                        <br />
                        <em>{unavailable}</em>
                      </>
                    )}
                  </>
                }
              />
            );
          })}
        </Box>
      )}

      {facts && guide && step === 2 && (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) minmax(0, 1.3fr)" }, gap: 2, alignItems: "start" }}>
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={2}>
                <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 600 }}>
                  {guide.title}
                </Typography>
                {guide.fields.map((f) => (
                  <TextField
                    key={f.key}
                    label={f.label}
                    size="small"
                    value={values[f.key] ?? ""}
                    helperText={f.hint ?? " "}
                    onChange={(event) => {
                      setValues((current) => ({ ...current, [f.key]: event.target.value.trim() }));
                    }}
                  />
                ))}
                <Box sx={{ bgcolor: "action.hover", borderRadius: 2, p: 2 }}>
                  <Typography variant="subtitle2" sx={{ mb: 1 }}>
                    How Vennir signs in
                  </Typography>
                  <Facts rows={guide.signsInAs(teamName, facts, values).map(([k, v]) => [k, <Mono key={k}>{v}</Mono>])} />
                </Box>
              </Stack>
            </CardContent>
          </Card>
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={1.5}>
                <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 600 }}>
                  Run this on your side
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {guide.commandsIntro}
                </Typography>
                {!guide.tested && (
                  <Alert severity="info" sx={{ py: 0 }}>
                    Not yet tested on this platform. If a step doesn't work as written, tell the Vennir team.
                  </Alert>
                )}
                <CodeBlock code={guide.commands(teamName, facts, values)} />
              </Stack>
            </CardContent>
          </Card>
        </Box>
      )}

      {facts && guide && step === 3 && (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1.3fr) minmax(0, 1fr)" }, gap: 2, alignItems: "start" }}>
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={1.5}>
                <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 600 }}>
                  The connection, for review
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  This goes into the catalog repo as <Mono>teams/{teamName}/secret-stores/secretstore.yaml</Mono>. It says where
                  to connect and as whom, never a secret value.
                </Typography>
                <CodeBlock code={manifest} />
              </Stack>
            </CardContent>
          </Card>
          <Card variant="outlined">
            <CardContent>
              <Stack spacing={1.5}>
                <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 600 }}>
                  Approval
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  A Marketplace reviewer approves every new connection, the same way products are reviewed.
                </Typography>
                <Button
                  variant="contained"
                  href={newFileUrl(repo, teamName, manifest)}
                  target="_blank"
                  rel="noopener"
                  endIcon={<OpenInNewIcon />}
                  sx={{ alignSelf: "flex-start" }}
                >
                  Open the PR on GitHub
                </Button>
                <Typography variant="body2" color="text.secondary">
                  {hasExistingStores ? "This team already has a source. If " : "If "}
                  <Mono>teams/{teamName}/secret-stores/secretstore.yaml</Mono> already exists in the catalog, GitHub won't
                  create it again:{" "}
                  <Link
                    href={catalogFileUrl(repo, secretStoreFile(teamName), "edit")}
                    target="_blank"
                    rel="noopener"
                  >
                    edit that file
                  </Link>{" "}
                  instead and add the text on the left as another document, after a line with <Mono>---</Mono>.
                </Typography>
                <Typography variant="subtitle2" sx={{ pt: 1 }}>
                  What happens next
                </Typography>
                <Box component="ol" sx={{ m: 0, pl: 2.5, "& li": { mb: 0.5 } }}>
                  <li>
                    <Typography variant="body2">On GitHub, commit the file to a new branch and open the PR.</Typography>
                  </li>
                  <li>
                    <Typography variant="body2">A reviewer approves and merges it.</Typography>
                  </li>
                  <li>
                    <Typography variant="body2">
                      The catalog applies it to the cluster, and it shows up under "Where secrets come from" with whether
                      Vennir could sign in.
                    </Typography>
                  </li>
                </Box>
              </Stack>
            </CardContent>
          </Card>
        </Box>
      )}

      <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, mt: 3, pt: 2, borderTop: 1, borderColor: "divider" }}>
        {step > 1 && (
          <Button
            onClick={() => {
              setStep(step - 1);
            }}
          >
            Back
          </Button>
        )}
        {step < 3 ? (
          <Button
            variant="contained"
            disabled={!guide}
            onClick={() => {
              setStep(step + 1);
            }}
          >
            Next
          </Button>
        ) : (
          <Button onClick={onClose}>Done</Button>
        )}
      </Box>
    </Box>
  );
}
