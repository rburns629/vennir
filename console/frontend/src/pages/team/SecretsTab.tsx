// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, Box, Button, ButtonBase, Card, CardContent, Chip, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import AddIcon from "@mui/icons-material/Add";
import {
  errorMessage,
  listSecretStores,
  listTeamSecrets,
  revokeSecret,
  type SecretStoreSummary,
  type TeamSecret,
} from "../../api";
import { AddSecretFlow, type AddSecretPrefill } from "./AddSecretFlow";
import { ConnectSource } from "./ConnectSource";
import { StoredCredential } from "./StoredCredential";
import { gcpAccessFix } from "./providers";
import { CodeBlock } from "../../components/CodeBlock";
import { Facts, SectionHeader, TabIntro, relativeTime, shortDuration } from "./shared";
import { Mono } from "../../components/Mono";

type View = { kind: "overview" } | { kind: "add"; prefill?: AddSecretPrefill } | { kind: "connect" };

/** What a store's `location` is, per provider. */
const LOCATION_LABEL: Record<string, string> = {
  gcpsm: "Project",
  azurekv: "Vault",
  aws: "Region",
  onepasswordSDK: "Vault",
  onepassword: "Connect server",
  vault: "Server",
};

export function SecretsTab({ teamName, readOnly }: { teamName: string; readOnly: boolean }) {
  const [view, setView] = useState<View>({ kind: "overview" });
  const [secrets, setSecrets] = useState<TeamSecret[] | null>(null);
  const [stores, setStores] = useState<SecretStoreSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoadError(null);
    Promise.all([listTeamSecrets(teamName), listSecretStores(teamName)])
      .then(([nextSecrets, nextStores]) => {
        setSecrets(nextSecrets);
        setStores(nextStores);
      })
      .catch((err: unknown) => {
        setLoadError(errorMessage(err, "Couldn't load this team's secrets."));
      });
  }, [teamName]);

  useEffect(reload, [reload]);

  if (view.kind === "add") {
    return (
      <AddSecretFlow
        teamName={teamName}
        stores={stores ?? []}
        prefill={view.prefill}
        onConnect={() => {
          setView({ kind: "connect" });
        }}
        onClose={(savedName) => {
          if (savedName) setSelected(savedName);
          setView({ kind: "overview" });
          reload();
        }}
      />
    );
  }
  if (view.kind === "connect") {
    return (
      <ConnectSource
        teamName={teamName}
        hasExistingStores={(stores ?? []).length > 0}
        onClose={() => {
          setView({ kind: "overview" });
          reload();
        }}
      />
    );
  }

  const current = secrets?.find((s) => s.secretName === selected) ?? secrets?.[0] ?? null;

  return (
    <Box>
      <TabIntro>
        Secrets your products read while they run. Any of your team's registered products may mount one, when a step lists
        it in secretRefs; nothing else can. Values never appear here: only their names and where they come from.
      </TabIntro>
      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}

      <SectionHeader
        title="Where secrets come from"
        aside={
          <Typography variant="body2" color="text.secondary">
            One connection covers every product in this platform.
          </Typography>
        }
      />
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(3, minmax(0, 1fr))" },
          gap: 2,
          mb: 4,
        }}
      >
        <Card variant="outlined">
          <CardContent>
            <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, mb: 1 }}>
              <Typography sx={{ fontWeight: 600 }}>Pasted in the console</Typography>
              <Chip label="Always on" size="small" color="success" variant="outlined" />
            </Box>
            <Typography variant="body2" color="text.secondary">
              Type or paste a value once. It's stored in this team's namespace, never in git or in the console's
              database.
            </Typography>
          </CardContent>
        </Card>
        {(stores ?? []).map((store) => (
          <StoreCard
            key={store.name}
            store={store}
            onReconnect={
              readOnly
                ? undefined
                : () => {
                    setView({ kind: "connect" });
                  }
            }
          />
        ))}
        {!readOnly && (
          <ButtonBase
            onClick={() => {
              setView({ kind: "connect" });
            }}
            sx={{
              borderRadius: 2,
              border: "2px dashed",
              borderColor: "divider",
              p: 2.5,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              justifyContent: "center",
              textAlign: "left",
              gap: 0.5,
              "&:hover": { borderColor: "primary.main" },
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "primary.main", fontWeight: 600 }}>
              <AddIcon fontSize="small" /> Connect a source
            </Box>
            <Typography variant="body2" color="text.secondary">
              GCP Secret Manager, AWS Secrets Manager or 1Password.
            </Typography>
          </ButtonBase>
        )}
      </Box>
      {!readOnly && <StoredCredential teamName={teamName} />}

      <SectionHeader
        title="Secrets"
        aside={
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={reload}>
              Refresh
            </Button>
            {!readOnly && (
              <Button
                variant="contained"
                onClick={() => {
                  setView({ kind: "add" });
                }}
              >
                Add a secret
              </Button>
            )}
          </Stack>
        }
      />
      {secrets && secrets.length === 0 ? (
        <Card variant="outlined">
          <CardContent>
            <Typography color="text.secondary">
              No secrets yet. Add one, and your products' steps can read it at run time.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1.5fr) minmax(0, 1fr)" },
            gap: 2,
            alignItems: "start",
          }}
        >
          <Card variant="outlined" sx={{ overflow: "hidden" }}>
            <SecretRowHeader />
            {(secrets ?? []).map((secret) => (
              <SecretRow
                key={secret.id}
                secret={secret}
                stores={stores ?? []}
                selected={current?.id === secret.id}
                onSelect={() => {
                  setSelected(secret.secretName);
                }}
              />
            ))}
          </Card>
          {current && (
            <SecretDetail
              teamName={teamName}
              secret={current}
              stores={stores ?? []}
              readOnly={readOnly}
              onRegister={(prefill) => {
                setView({ kind: "add", prefill });
              }}
              onRevoked={() => {
                setSelected(null);
                reload();
              }}
            />
          )}
        </Box>
      )}
    </Box>
  );
}

function StoreCard({ store, onReconnect }: { store: SecretStoreSummary; onReconnect?: () => void }) {
  const status =
    store.ready === null
      ? { label: "Checking", color: "warning" as const }
      : store.ready
        ? { label: "Connected", color: "success" as const }
        : { label: "Can't connect", color: "error" as const };
  const rows: [string, ReactNode][] = [];
  if (store.location) rows.push([LOCATION_LABEL[store.provider] ?? "Location", <Mono key="l">{store.location}</Mono>]);
  rows.push([
    "Signs in as",
    store.identity ? <Mono key="i">{store.identity}</Mono> : store.usesStoredCredential ? "a stored token" : "unknown",
  ]);
  rows.push(["Name", <Mono key="n">{store.name}</Mono>]);
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.25}>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1 }}>
            <Typography sx={{ fontWeight: 600 }}>{store.providerLabel}</Typography>
            <Chip label={status.label} size="small" color={status.color} />
          </Box>
          <Facts rows={rows} />
          {store.ready === false && store.message && (
            <Alert severity="error" sx={{ py: 0 }}>
              {store.message}
            </Alert>
          )}
          {store.sharedWithCount > 0 && (
            <Alert severity="warning" sx={{ alignItems: "flex-start" }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {store.sharedWith?.length
                  ? `Shared with ${store.sharedWith.join(", ")}.`
                  : `Shared with ${String(store.sharedWithCount)} other team${store.sharedWithCount === 1 ? "" : "s"}.`}
              </Typography>
              <Typography variant="body2">
                Either team can sync anything this identity can read. Give this team its own identity.
              </Typography>
              {onReconnect && (
                <Button size="small" variant="outlined" color="inherit" sx={{ mt: 1 }} onClick={onReconnect}>
                  Reconnect with its own identity
                </Button>
              )}
            </Alert>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

const ROW_COLUMNS = { xs: "minmax(0, 1fr)", sm: "minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 0.9fr)" };

function SecretRowHeader() {
  return (
    <Box
      sx={{
        display: { xs: "none", sm: "grid" },
        gridTemplateColumns: ROW_COLUMNS,
        gap: 2,
        px: 2,
        py: 1.25,
        bgcolor: "action.hover",
        fontSize: 12,
        fontWeight: 600,
        color: "text.secondary",
        textTransform: "uppercase",
        letterSpacing: 0.4,
      }}
    >
      <span>Name</span>
      <span>Comes from</span>
      <span>Mountable</span>
      <span>Status</span>
    </Box>
  );
}

export function secretStatus(secret: TeamSecret): { label: string; color: "success" | "warning" | "error" | "default" } {
  if (secret.source === "literal") return { label: "Ready", color: "success" };
  if (!secret.external) return { label: "Missing", color: "error" };
  if (secret.external.status === "synced") return { label: "Synced", color: "success" };
  if (secret.external.status === "syncing") return { label: "Syncing", color: "warning" };
  return { label: "Sync error", color: "error" };
}

function sourceSummary(secret: TeamSecret, stores: SecretStoreSummary[]): { title: string; detail: string } {
  if (secret.source === "literal") return { title: "Pasted", detail: `updated ${relativeTime(secret.updatedAt)}` };
  const store = stores.find((s) => s.name === secret.external?.storeName);
  const entry = secret.external?.entries[0];
  const detail = entry ? `${entry.remoteKey}${entry.property ? ` · ${entry.property}` : ""}` : "";
  return { title: store?.providerLabel ?? secret.external?.storeName ?? "External store", detail };
}

function SecretRow({
  secret,
  stores,
  selected,
  onSelect,
}: {
  secret: TeamSecret;
  stores: SecretStoreSummary[];
  selected: boolean;
  onSelect: () => void;
}) {
  const source = sourceSummary(secret, stores);
  const status = secretStatus(secret);
  return (
    <ButtonBase
      onClick={onSelect}
      aria-pressed={selected}
      sx={{
        width: "100%",
        display: "grid",
        gridTemplateColumns: ROW_COLUMNS,
        gap: 2,
        alignItems: "center",
        px: 2,
        py: 1.5,
        textAlign: "left",
        borderTop: 1,
        borderColor: "divider",
        bgcolor: selected ? (theme) => alpha(theme.palette.primary.main, 0.06) : "transparent",
        boxShadow: selected ? (theme) => `inset 0 0 0 2px ${theme.palette.primary.main}` : "none",
        "&:hover": { bgcolor: selected ? (theme) => alpha(theme.palette.primary.main, 0.08) : "action.hover" },
      }}
    >
      <Typography sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
        <Mono>{secret.secretName}</Mono>
      </Typography>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2">{source.title}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
          <Mono>{source.detail}</Mono>
        </Typography>
      </Box>
      <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
        {secret.managed ? "By your products" : "Not yet: register it"}
      </Typography>
      <Box>
        <Chip label={status.label} size="small" color={status.color} />
      </Box>
    </ButtonBase>
  );
}

function SecretDetail({
  teamName,
  secret,
  stores,
  readOnly,
  onRegister,
  onRevoked,
}: {
  teamName: string;
  secret: TeamSecret;
  stores: SecretStoreSummary[];
  readOnly: boolean;
  onRegister: (prefill: AddSecretPrefill) => void;
  onRevoked: () => void;
}) {
  const status = secretStatus(secret);
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function revoke(): Promise<void> {
    setRevoking(true);
    setRevokeError(null);
    try {
      await revokeSecret(teamName, secret.secretName);
      onRevoked();
    } catch (err) {
      setRevokeError(errorMessage(err, "Couldn't revoke it."));
      setRevoking(false);
    }
  }
  const external = secret.external;
  const store = stores.find((s) => s.name === external?.storeName);
  const entry = external?.entries[0];

  const sourceText =
    secret.source === "literal"
      ? "Pasted in the console."
      : external
        ? `${store?.providerLabel ?? external.storeName ?? "External store"} → ${external.entries
            .map((e) => `${e.remoteKey}${e.property ? ` (field "${e.property}")` : ""}`)
            .join(", ")}${external.refreshInterval ? `. Refreshes every ${shortDuration(external.refreshInterval)}.` : "."}`
        : "An external store, but its sync definition is missing.";

  const fix =
    external?.status === "error" && store && entry
      ? gcpAccessFix(store.provider, store.location, store.identity, entry.remoteKey, external.message)
      : null;

  const dagSnippet = [
    `"team": "${teamName}",`,
    `"secretRefs": ["${secret.secretName}"]`,
  ].join("\n");
  const paths = secret.keys.map((key) => `/platform/secrets/${secret.secretName}/${key}`).join("\n");

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            <Typography sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
              <Mono>{secret.secretName}</Mono>
            </Typography>
            <Chip label={status.label} size="small" color={status.color} />
          </Box>
          <Facts
            rows={[
              ["Comes from", sourceText],
              [
                "Mountable",
                secret.managed
                  ? "By any of your team's registered products, when a step lists it in secretRefs"
                  : "Not until it's registered",
              ],
              [
                secret.source === "literal" ? "Updated" : "Last synced",
                relativeTime(secret.source === "literal" ? secret.updatedAt : (external?.lastSyncedAt ?? null)),
              ],
            ]}
          />

          {external?.status === "error" && (
            <Alert severity="error">
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Can't read it from {store?.providerLabel ?? "the store"}
              </Typography>
              <Typography variant="body2" sx={{ mb: fix ? 1 : 0 }}>
                {external.message ?? "No reason given yet."}
              </Typography>
              {fix && (
                <>
                  <Typography variant="body2" sx={{ mb: 1 }}>
                    Someone who owns that secret can let Vertra read it:
                  </Typography>
                  <CodeBlock code={fix} />
                </>
              )}
            </Alert>
          )}

          {!secret.managed && (
            <Alert severity="info">
              Created outside the console, so no step can mount it until it's registered.
              {!readOnly && external && (
                <Box sx={{ mt: 1 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => {
                      onRegister({
                        secretName: secret.secretName,
                        storeName: external.storeName ?? undefined,
                        remoteKey: entry?.remoteKey,
                        property: entry?.property ?? undefined,
                        fileName: entry?.secretKey,
                      });
                    }}
                  >
                    Register it
                  </Button>
                </Box>
              )}
            </Alert>
          )}

          {secret.managed && (
            <>
              <Typography variant="subtitle2">Use it in a DAG task</Typography>
              <CodeBlock code={dagSnippet} />
              <Typography variant="subtitle2">Read it in your action</Typography>
              <CodeBlock code={paths} />
              {!readOnly && !confirming && (
                <Box>
                  <Button
                    size="small"
                    color="error"
                    variant="outlined"
                    onClick={() => {
                      setConfirming(true);
                    }}
                  >
                    Revoke
                  </Button>
                </Box>
              )}
              {confirming && (
                <Alert
                  severity="warning"
                  action={
                    <Stack direction="row" spacing={1}>
                      <Button
                        size="small"
                        onClick={() => {
                          setConfirming(false);
                        }}
                        disabled={revoking}
                      >
                        Keep
                      </Button>
                      <Button size="small" color="error" variant="contained" onClick={() => void revoke()} disabled={revoking}>
                        Revoke
                      </Button>
                    </Stack>
                  }
                >
                  Tasks will no longer be able to use <Mono>{secret.secretName}</Mono>, and its value is deleted
                  {secret.source === "external" ? " here (it stays in the external store)" : ""}. Tasks already
                  running keep what they mounted.
                </Alert>
              )}
              {revokeError && <Alert severity="error">{revokeError}</Alert>}
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
