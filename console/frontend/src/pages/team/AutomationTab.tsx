// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, Card, Checkbox, FormControl, FormControlLabel, FormLabel, Link, MenuItem, Radio, RadioGroup, Stack, TextField, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import BotIcon from "@mui/icons-material/SmartToyOutlined";
import CartIcon from "@mui/icons-material/ShoppingCartOutlined";
import KeyIcon from "@mui/icons-material/VpnKeyOutlined";
import LinkIcon from "@mui/icons-material/LinkOutlined";
import { errorMessage, createBot, createKeylessBot, listBotIdentities, listBots, revokeToken, setBotCallback, setBotOrders, type Bot, type BotIdentity } from "../../api";
import { CI, KeylessSection } from "./KeylessSection";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CodeBlock } from "../../components/CodeBlock";
import { HelpLink } from "../../components/HelpLink";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { SignedCallback } from "../../components/SignedCallback";
import { DEFAULT_TOKEN_DAYS, expiryText, TokenLifetime } from "../../components/TokenLifetime";
import { BotPart, CardTitle, SectionLabel, relativeTime } from "./shared";

/** Templates as typed: <team>/<name>, one per line or comma-separated. */
function templateList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean))];
}

/** A small tinted square holding an icon, as the boards draw them. */
function IconTile({ children }: { children: ReactNode }) {
  return (
    <Box
      aria-hidden="true"
      sx={{
        width: 36,
        height: 36,
        borderRadius: 2,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "primary.main",
        bgcolor: (theme) => alpha(theme.palette.primary.main, 0.08),
      }}
    >
      {children}
    </Box>
  );
}

/** What an ordering bot may order, editable by the team's maintainers. */
function OrderTemplates({ teamName, bot, readOnly, onSaved }: { teamName: string; bot: Bot; readOnly: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(bot.orderTemplates.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = templateList(text).join("\n") !== bot.orderTemplates.join("\n");
  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await setBotOrders(teamName, bot.email, templateList(text));
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save its templates. Try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <BotPart
      title="Templates it may order"
      action={
        !readOnly && !editing ? (
          <Button size="small" variant="outlined" color="inherit" onClick={() => { setText(bot.orderTemplates.join("\n")); setEditing(true); }}>
            Edit
          </Button>
        ) : undefined
      }
    >
      {editing ? (
        <>
          <TextField
            label="Templates it may order"
            size="small"
            multiline
            minRows={2}
            value={text}
            onChange={(e) => { setText(e.target.value); }}
            helperText="<team>/<name>, one per line, as the Catalog shows them."
          />
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button size="small" variant="contained" disabled={busy || !changed} onClick={() => void save()}>
              Save
            </Button>
            <Button size="small" onClick={() => { setEditing(false); }}>
              Cancel
            </Button>
          </Box>
        </>
      ) : bot.orderTemplates.length > 0 ? (
        <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap" }}>
          {bot.orderTemplates.map((t) => (
            <Pill key={t} tone="neutral">
              <Mono>{t}</Mono>
            </Pill>
          ))}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">
          None yet: it can&apos;t order anything.
        </Typography>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </BotPart>
  );
}

/** A bot's own card: who it is, what it may do, how it signs in. */
function BotCard({
  teamName,
  bot,
  keyless,
  readOnly,
  onChanged,
  onRevoke,
}: {
  teamName: string;
  bot: Bot;
  keyless: { identities: BotIdentity[]; issuers: string[]; audience: string } | null;
  readOnly: boolean;
  onChanged: () => void;
  onRevoke: (token: { tokenId: string; label: string; email: string }) => void;
}) {
  const identities = keyless?.identities.filter((i) => i.botId === bot.id) ?? [];
  // Tokens that still sign in: an expired one is listed (as expired) but doesn't count.
  const working = bot.tokens.filter((t) => !t.expiresAt || new Date(t.expiresAt).getTime() > Date.now()).length;
  const keylessOnly = working === 0 && identities.length > 0;
  return (
    <Card component="article" sx={{ p: { xs: 2, sm: 2.5 }, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
        <IconTile>
          <BotIcon fontSize="small" />
        </IconTile>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" component="h3" sx={{ fontSize: 15, fontWeight: 600, overflowWrap: "anywhere" }}>
            <Mono sx={{ fontSize: 15 }}>{bot.email}</Mono>
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
            {bot.ordering
              ? `A member of ${teamName} that may order only the templates below; it can't submit raw DAGs.`
              : `Acts as a maintainer of ${teamName}: submits and reads its runs, registers secrets. Nothing outside ${teamName}.`}
          </Typography>
          <Box sx={{ display: "flex", gap: 0.75, mt: 1, flexWrap: "wrap" }}>
            {bot.ordering ? <Pill tone="warning">Ordering</Pill> : <Pill tone="info">Pipeline</Pill>}
            {working > 0 ? (
              <Pill tone="success">Active</Pill>
            ) : keylessOnly ? (
              <Pill tone="success">Keyless</Pill>
            ) : (
              <Pill tone="neutral">No token</Pill>
            )}
          </Box>
        </Box>
      </Box>
      {working === 0 && !keylessOnly && (
        <Typography variant="body2" color="text.secondary">
          No working token. Anything still using an old one fails to sign in.
        </Typography>
      )}
      {keyless && (
        <KeylessSection
          teamName={teamName}
          botId={bot.id}
          identities={identities}
          issuers={keyless.issuers}
          audience={keyless.audience}
          readOnly={readOnly}
          onChanged={onChanged}
        />
      )}
      {bot.ordering && <OrderTemplates teamName={teamName} bot={bot} readOnly={readOnly} onSaved={onChanged} />}
      {bot.ordering && (
        <BotPart title="Tells the system that ordered how it went">
          <SignedCallback
            current={bot.callback ? { ...bot.callback, lastError: bot.callback.lastError || null } : null}
            editable={!readOnly}
            none="No callback: whatever placed an order asks how it went."
            save={async (url, rotate) => (await setBotCallback(teamName, bot.email, url, rotate)).signingSecret}
            onSaved={onChanged}
          />
        </BotPart>
      )}
      {bot.tokens.length > 0 && (
        <BotPart title="Tokens">
          {bot.tokens.map((token) => (
            <Box
              key={token.id}
              sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1.5, p: 1.5, bgcolor: "background.default", borderRadius: 2, flexWrap: "wrap" }}
            >
              <Box sx={{ display: "flex", gap: 1.5, alignItems: "center", minWidth: 0 }}>
                <KeyIcon fontSize="small" sx={{ color: "text.secondary" }} aria-hidden="true" />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
                    {token.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    created {relativeTime(token.createdAt)} · last used {relativeTime(token.lastUsedAt)} · {expiryText(token.expiresAt)}
                  </Typography>
                </Box>
              </Box>
              {!readOnly && (
                <Button size="small" color="error" onClick={() => { onRevoke({ tokenId: token.id, label: token.label, email: bot.email }); }}>
                  Revoke
                </Button>
              )}
            </Box>
          ))}
        </BotPart>
      )}
    </Card>
  );
}

/** A bot's email is just its identity here, never mailed: derived from
 * what will use it, so the person creating one only has to say that. */
function botEmail(teamName: string, purpose: string): string {
  const slug = purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${teamName}-${slug || "bot"}@bots.vennir.local`;
}

/** The three kinds of bot, side by side above the list. */
const KINDS: [ReactNode, string, (team: string) => string][] = [
  [<BotIcon key="b" fontSize="small" />, "Pipeline bot", (team) => `Submits and reads ${team}'s runs, as a maintainer.`],
  [<LinkIcon key="k" fontSize="small" />, "Keyless", () => "A GitHub or GitLab job signs in as a bot with its own ID token."],
  [<CartIcon key="o" fontSize="small" />, "Ordering bot", () => "Runs only listed templates, and gets a signed callback."],
];

export function AutomationTab({
  teamName,
  readOnly,
  schedules,
  onShowSchedules,
  onShowSettings,
}: {
  teamName: string;
  readOnly: boolean;
  /** How many schedules the team has, when known. */
  schedules: number | undefined;
  onShowSchedules: () => void;
  onShowSettings: () => void;
}) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ tokenId: string; label: string; email: string } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [issued, setIssued] = useState<{ email: string; token: string; ordering: boolean } | null>(null);
  const [keyless, setKeyless] = useState<{ identities: BotIdentity[]; issuers: string[]; audience: string } | null>(null);

  const reload = useCallback(() => {
    listBots(teamName)
      .then(setBots)
      .catch((err: unknown) => {
        setLoadError(errorMessage(err, "Couldn't load this team's bots."));
      });
    // Display only: without it, bots just don't offer keyless sign-in.
    listBotIdentities(teamName).then(setKeyless).catch(() => undefined);
  }, [teamName]);

  useEffect(reload, [reload]);

  async function revoke(): Promise<void> {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await revokeToken(revoking.tokenId);
      reload();
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't revoke it. Try again."));
    } finally {
      setRevokeBusy(false);
      setRevoking(null);
    }
  }

  const consoleUrl = window.location.origin;
  // The job's lines for the first bot that signs in from CI, beside the list.
  // The keyless bot just added, else the first: its job's snippet.
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const shownIdentity = keyless?.identities.find((i) => i.id === justAdded) ?? keyless?.identities.find((i) => i.issuer in CI);
  const shownCi = shownIdentity ? CI[shownIdentity.issuer] : undefined;

  return (
    <Box>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 2, flexWrap: "wrap", mb: 2.5 }}>
        <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 820, flex: "1 1 420px" }}>
          Bots let {teamName} work without a person at the console: a pipeline that submits DAGs, a CI job that signs in
          with its own identity instead of a stored token, or a system that places orders and hears back. Only maintainers
          see them. Give each place its own bot, so revoking one doesn&apos;t stop the rest. You don&apos;t need one to
          publish products: the catalog&apos;s own CI does that.
        </Typography>
        <HelpLink guide="14-bots-and-automation" label="Bots and automation" />
      </Box>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "repeat(3, minmax(0, 1fr))" }, gap: 1.5, mb: 3 }}>
        {KINDS.map(([icon, title, what]) => (
          <Card key={title} sx={{ p: 2, display: "flex", gap: 1.5, alignItems: "flex-start" }}>
            <IconTile>{icon}</IconTile>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {what(teamName)}
              </Typography>
            </Box>
          </Card>
        ))}
      </Box>

      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1.65fr) minmax(0, 1fr)" },
          gap: 2,
          alignItems: "start",
        }}
      >
        <Box component="section" aria-labelledby="bots">
          <SectionLabel id="bots">{bots ? `${String(bots.length)} ${bots.length === 1 ? "bot" : "bots"}` : "Bots"}</SectionLabel>
          <Stack spacing={2}>
            {bots && bots.length === 0 && (
              <Card sx={{ p: 2.5 }}>
                <Typography color="text.secondary">No bots yet. Add one for each pipeline or system that acts for {teamName}.</Typography>
              </Card>
            )}
            {(bots ?? []).map((bot) => (
              <BotCard key={bot.id} teamName={teamName} bot={bot} keyless={keyless} readOnly={readOnly} onChanged={reload} onRevoke={setRevoking} />
            ))}
          </Stack>
        </Box>

        <Stack spacing={2}>
          {!readOnly &&
            (issued ? (
              <Card sx={{ p: 2.5 }}>
                <Stack spacing={1.5}>
                  <CardTitle title={`Token for ${issued.email}`} />
                  <Alert severity="warning">
                    <strong>Copy it now.</strong> This is the only time it's shown.
                  </Alert>
                  <CodeBlock code={issued.token} copyLabel="Copy token" />
                  <Typography variant="subtitle2">1. Store it in your pipeline</Typography>
                  <CodeBlock code={"gh secret set VENNIR_TOKEN \\\n  --repo <your-org>/<your-repo>"} />
                  <Typography variant="subtitle2">{issued.ordering ? "2. Place an order from it" : "2. Submit a DAG from it"}</Typography>
                  <CodeBlock
                    code={
                      issued.ordering
                        ? [
                            `curl -X POST ${consoleUrl}/api/vennir.console.v1.TemplateService/RunTemplate \\`,
                            '  -H "Authorization: Bearer $VENNIR_TOKEN" \\',
                            '  -H "Content-Type: application/json" \\',
                            `  -d '{"team": "<team>", "name": "<template>", "onBehalfOf": "${teamName}", "requestId": "<order id>", "parameters": {}}'`,
                          ].join("\n")
                        : [
                            `jq '{dag: .}' dag.json | curl -X POST ${consoleUrl}/api/vennir.console.v1.ExecutionService/SubmitExecution \\`,
                            '  -H "Authorization: Bearer $VENNIR_TOKEN" \\',
                            '  -H "Content-Type: application/json" \\',
                            "  -d @-",
                          ].join("\n")
                    }
                  />
                  <Button
                    variant="contained"
                    sx={{ alignSelf: "flex-start" }}
                    onClick={() => {
                      setIssued(null);
                    }}
                  >
                    Done
                  </Button>
                </Stack>
              </Card>
            ) : (
              <AddBot
                teamName={teamName}
                issuers={keyless?.issuers.filter((i) => i in CI) ?? []}
                onCreated={(email, token, ordering) => {
                  setIssued({ email, token, ordering });
                  reload();
                }}
                onKeyless={(identityId) => {
                  setJustAdded(identityId);
                  reload();
                }}
              />
            ))}

          {shownIdentity && shownCi && keyless && (
            <Card component="section" aria-labelledby="kl" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
              <CardTitle id="kl" title="Keyless sign-in, in the job">
                For <Mono>{shownIdentity.botEmail.split("@")[0]}</Mono> from <Mono>{Object.values(shownIdentity.claims).join(" on ")}</Mono>. The
                job swaps its {shownCi.name} ID token for an hour&apos;s Vennir token; any other repository{shownIdentity.claims["ref"] ? " or branch" : ""} can&apos;t.
              </CardTitle>
              <CodeBlock code={shownCi.snippet(keyless.audience, consoleUrl)} />
            </Card>
          )}

          <Card component="section" aria-labelledby="also" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
            <CardTitle id="also" title="Elsewhere for automation" />
            <Typography variant="body2">
              <Link component="button" onClick={onShowSchedules} sx={{ verticalAlign: "baseline" }}>
                Schedules
              </Link>
              {schedules ? `: ${String(schedules)} ${schedules === 1 ? "run" : "runs"} on a timetable, as one of its bots.` : ": runs on a timetable, as one of its bots."}
            </Typography>
            <Typography variant="body2">
              <Link component="button" onClick={onShowSettings} sx={{ verticalAlign: "baseline" }}>
                Settings
              </Link>
              : chat notifications, and every run&apos;s outcome posted to your own systems.
            </Typography>
            <Typography variant="body2">
              Every bot call is in the{" "}
              <Link component={RouterLink} to="/observe?tab=audit">
                audit log
              </Link>{" "}
              under the bot&apos;s name.
            </Typography>
          </Card>
        </Stack>
      </Box>

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke "${revoking?.label ?? ""}"?`}
        description={`${revoking?.email ?? "This bot"}'s token stops working immediately. Any pipeline still using it will fail to sign in.`}
        confirmLabel="Revoke token"
        destructive
        busy={revokeBusy}
        onConfirm={() => void revoke()}
        onCancel={() => {
          setRevoking(null);
        }}
      />
    </Box>
  );
}

function AddBot({
  teamName,
  issuers,
  onCreated,
  onKeyless,
}: {
  teamName: string;
  /** The CIs this install accepts keyless sign-in from; none, only tokens. */
  issuers: string[];
  onCreated: (email: string, token: string, ordering: boolean) => void;
  onKeyless: (identityId: string) => void;
}) {
  const [purpose, setPurpose] = useState("");
  const [signIn, setSignIn] = useState<"token" | "keyless">("token");
  const [issuer, setIssuer] = useState("");
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const keyless = signIn === "keyless" && issuers.length > 0;
  const ci = CI[issuers.includes(issuer) ? issuer : (issuers[0] ?? "")];
  const [ordering, setOrdering] = useState(false);
  const [templates, setTemplates] = useState("");
  const [days, setDays] = useState(DEFAULT_TOKEN_DAYS);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (keyless && ci) {
        const claims = { [ci.repo]: repo.trim(), ...(ref.trim() ? { ref: ref.trim() } : {}) };
        const made = await createKeylessBot(teamName, botEmail(teamName, purpose), issuers.includes(issuer) ? issuer : (issuers[0] ?? ""), claims, ordering ? templateList(templates) : undefined);
        setPurpose("");
        setTemplates("");
        setRepo("");
        setRef("");
        onKeyless(made.identityId);
        return;
      }
      const result = await createBot(teamName, botEmail(teamName, purpose), purpose.trim(), ordering ? templateList(templates) : undefined, days);
      setPurpose("");
      setTemplates("");
      onCreated(result.email, result.token, ordering);
    } catch (err) {
      setError(errorMessage(err, "Couldn't create the bot. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card component="section" aria-labelledby="newbot" sx={{ p: 2.5 }}>
      <Box component="form" onSubmit={(event: FormEvent) => void submit(event)}>
        <Stack spacing={2}>
          <CardTitle id="newbot" title="Add a bot" />
          <TextField
            label="What will use it?"
            size="small"
            required
            value={purpose}
            onChange={(event) => {
              setPurpose(event.target.value);
            }}
            placeholder="release pipeline in our infra repo"
            helperText="A pipeline or repo, so you know what breaks if you revoke it. Using the same words again adds to the same bot."
          />
          {issuers.length > 0 && (
            <FormControl>
              <FormLabel id="bsign" sx={{ fontSize: 14, fontWeight: 500, color: "text.primary", "&.Mui-focused": { color: "text.primary" } }}>
                How it signs in
              </FormLabel>
              <RadioGroup aria-labelledby="bsign" value={signIn} onChange={(e) => { setSignIn(e.target.value === "keyless" ? "keyless" : "token"); }}>
                <FormControlLabel
                  value="token"
                  control={<Radio />}
                  label={<><strong>A token</strong>, shown once, for a service, a script or a CI without its own identity</>}
                  sx={{ alignItems: "flex-start", "& .MuiRadio-root": { mt: -0.75 }, "& .MuiFormControlLabel-label": { fontSize: 14 } }}
                />
                <FormControlLabel
                  value="keyless"
                  control={<Radio />}
                  label={<><strong>Keyless, from CI</strong>: a {issuers.map((i) => CI[i]?.name).join(" or ")} job signs in with its own ID token. No token is made, so none can leak</>}
                  sx={{ alignItems: "flex-start", "& .MuiRadio-root": { mt: -0.75 }, "& .MuiFormControlLabel-label": { fontSize: 14 } }}
                />
              </RadioGroup>
            </FormControl>
          )}
          {keyless && ci && (
            <>
              {issuers.length > 1 && (
                <TextField select size="small" label="CI" value={issuers.includes(issuer) ? issuer : issuers[0]} onChange={(e) => { setIssuer(e.target.value); }}>
                  {issuers.map((i) => (
                    <MenuItem key={i} value={i}>
                      {CI[i]?.name}
                    </MenuItem>
                  ))}
                </TextField>
              )}
              <TextField size="small" required label={ci.repoLabel} value={repo} onChange={(e) => { setRepo(e.target.value); }} placeholder="acme/release-pipeline" />
              <TextField
                size="small"
                label="Only from this branch (optional)"
                value={ref}
                onChange={(e) => { setRef(e.target.value); }}
                placeholder="refs/heads/main"
                helperText="Left empty, any branch of the repository, and pull requests from it, can sign in as the bot."
              />
            </>
          )}
          <FormControlLabel
            control={<Checkbox checked={ordering} onChange={(e) => { setOrdering(e.target.checked); }} />}
            label="It places orders (a storefront, or another system): only the templates listed, nothing else"
            sx={{ alignItems: "flex-start", "& .MuiCheckbox-root": { mt: -0.75 }, "& .MuiFormControlLabel-label": { fontSize: 14 } }}
          />
          {ordering && (
            <TextField
              label="Templates it may order"
              size="small"
              multiline
              minRows={2}
              value={templates}
              onChange={(e) => { setTemplates(e.target.value); }}
              helperText="<team>/<name>, one per line. A member of this team, not a maintainer: it can't submit raw DAGs."
            />
          )}
          {!keyless && <TokenLifetime days={days} onChange={setDays} />}
          <Button type="submit" variant="contained" disabled={submitting || !purpose.trim() || (keyless && !repo.trim())} sx={{ alignSelf: "flex-start" }}>
            {submitting ? "Creating…" : keyless ? "Create bot" : "Create bot and token"}
          </Button>
          {keyless && (
            <Typography variant="caption" color="text.secondary">
              Then the job&apos;s sign-in step, shown below. A token can still be added later, if something else needs one.
            </Typography>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </Box>
    </Card>
  );
}
