// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { errorMessage, listTeamMembers, setTeamSignIn, type Team, type TeamMember, type TeamProfile } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Mono";
import { useAuth } from "../../auth/AuthContext";
import { useEnvironment } from "../../environment";
import { QuotaSection } from "./QuotaSection";
import { OutcomeWebhookSection } from "./OutcomeWebhookSection";
import { WebhookSection } from "./WebhookSection";
import { SectionLabel, SettingsCard } from "./shared";

/** A label and its value, in the "Where it comes from" list. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Typography component="dt" variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography component="dd" variant="body2" sx={{ m: 0, overflowWrap: "anywhere" }}>
        {children}
      </Typography>
    </>
  );
}

/**
 * How a team signs in, its limits and notifications, where it comes from, and (for an admin) retiring,
 * restoring and purging it. Members see the same, without the controls.
 */
export function SettingsTab({
  team,
  profile,
  isAdmin,
  onChanged,
  onShowMembers,
  onRetire,
  onRestore,
  onPurge,
  busy,
}: {
  team: Team;
  /** Its owner and contact in the catalog, when loaded. */
  profile: TeamProfile | null;
  isAdmin: boolean;
  /** The team changed (its sign-in): reload it. */
  onChanged: () => void;
  onShowMembers: () => void;
  onRetire: () => Promise<void>;
  onRestore: () => Promise<void>;
  onPurge: () => Promise<void>;
  busy: boolean;
}) {
  const sso = useEnvironment()?.ssoLabel ?? "";
  const { user } = useAuth();
  const canManage = isAdmin || (user?.maintainerOf.includes(team.name) ?? false);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<"retire" | "purge" | null>(null);
  const retired = Boolean(team.retiredAt);

  useEffect(() => {
    // Display only: without it, the warning below just isn't shown.
    listTeamMembers(team.name).then(setMembers).catch(() => undefined);
  }, [team.name]);

  // People (not bots) who only have a password: requiring single sign-on
  // stops them signing in until they use it. Admins keep their password.
  const passwordOnly = (members ?? []).filter((m) => !m.isBot && !m.isAdmin && m.hasPassword && !m.usesSso);

  async function changeSignIn(requireSso: boolean): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      await setTeamSignIn(team.name, requireSso);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Couldn't change how it signs in."));
    } finally {
      setSaving(false);
    }
  }

  const contact = [profile?.helpChat, profile?.contact].filter((c): c is string => Boolean(c));

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }, gap: 2, alignItems: "start" }}>
        <Stack spacing={2}>
          <SettingsCard title="Signing in">
            {sso ? (
              <>
                <FormControlLabel
                  control={<Switch checked={team.requireSso} disabled={!isAdmin || saving || retired} onChange={(event) => void changeSignIn(event.target.checked)} />}
                  label={`Require ${sso} sign-in for its members`}
                  sx={{ justifyContent: "space-between", ml: 0, gap: 2, "& .MuiFormControlLabel-label": { fontWeight: 500 } }}
                  labelPlacement="start"
                />
                <Typography variant="body2" color="text.secondary">
                  Its members can&apos;t use a password, here or with the gateway, and a password session they have stops
                  working. Admins can always use theirs, in case {sso} can&apos;t be reached.
                  {!isAdmin && " Only admins change this."}
                </Typography>
                {passwordOnly.length > 0 && (
                  <Alert severity="warning" icon={false}>
                    {passwordOnly.length === 1 ? "1 member signs" : `${String(passwordOnly.length)} members sign`} in with a password only:{" "}
                    {passwordOnly.map((m) => m.email).join(", ")}.{" "}
                    {team.requireSso ? "They can't sign in until they use " : "Requiring it would stop them until they use "}
                    {sso}.{" "}
                    <Link component="button" onClick={onShowMembers} sx={{ verticalAlign: "baseline", color: "inherit" }}>
                      See members
                    </Link>
                  </Alert>
                )}
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Everyone signs in with a password: single sign-on isn&apos;t set up on this install.
                {isAdmin && (
                  <>
                    {" "}
                    To set it up: Admin, Single sign-on and groups (or <Mono>vennir sso google</Mono>).
                  </>
                )}
              </Typography>
            )}
          </SettingsCard>

          <WebhookSection team={team.name} canManage={canManage} retired={retired} />
        </Stack>

        <Stack spacing={2}>
          <QuotaSection team={team} isAdmin={isAdmin} onChanged={onChanged} />

          <OutcomeWebhookSection team={team.name} canManage={canManage} retired={retired} />

          <SettingsCard title="Where it comes from">
            <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: 3, rowGap: 0.75 }}>
              <Fact label="Made by">
                {team.fromCatalog ? (
                  <>
                    The catalog: <Mono>teams/{team.name}/</Mono>
                  </>
                ) : (
                  "Made here: the catalog leaves it alone until an admin adopts it."
                )}
              </Fact>
              {profile?.owner && (
                <Fact label="Owner">
                  <Mono>{profile.owner}</Mono>
                </Fact>
              )}
              {(contact.length > 0 || profile?.helpUrl) && (
                <Fact label="Contact">
                  {contact.join(" · ")}
                  {profile?.helpUrl && (
                    <>
                      {contact.length > 0 && " · "}
                      <Link href={profile.helpUrl} target="_blank" rel="noopener noreferrer">
                        its help page
                      </Link>
                    </>
                  )}
                </Fact>
              )}
              <Fact label="Namespace">
                <Mono>{team.name}</Mono>, labelled as a team&apos;s
              </Fact>
              <Fact label="Created">{new Date(team.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</Fact>
            </Box>
            <Typography variant="body2" color="text.secondary">
              {team.fromCatalog
                ? "Its name, owner, contact and products change in the catalog. Members, secrets, bots and these settings change here."
                : "Its members, secrets, bots, products and these settings all change here."}
            </Typography>
          </SettingsCard>
        </Stack>
      </Box>

      {isAdmin && (
        <Box component="section" aria-labelledby="dz" sx={{ mt: 4 }}>
          <SectionLabel id="dz" tone="danger">
            Admins only: ending a team
          </SectionLabel>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }, gap: 2, alignItems: "stretch" }}>
            <SettingsCard title={retired ? `Restore ${team.name}` : `Retire ${team.name}`} tone="danger">
              <Typography variant="body2">
                {retired
                  ? "It's retired: read-only, its products unregistered, nothing new starting in its namespace. Restoring it makes it a working team again; its products return with the catalog's next release."
                  : "For a team that's going away. It becomes read-only, its products are unregistered, and nothing new starts in its namespace; what's running finishes. You can undo it."}
                {team.fromCatalog && !retired && " A catalog release without its folder retires it too."}
              </Typography>
              <Box>
                {retired ? (
                  <Button variant="outlined" color="inherit" disabled={busy} onClick={() => void onRestore()}>
                    Restore {team.name}
                  </Button>
                ) : (
                  <Button variant="outlined" color="error" disabled={busy} onClick={() => { setConfirm("retire"); }}>
                    Retire {team.name}…
                  </Button>
                )}
              </Box>
            </SettingsCard>

            <SettingsCard title={`Purge ${team.name}`} tone="danger">
              <Typography variant="body2">
                Can&apos;t be undone. Only for a retired team with no unfinished runs. Removes its members, secrets&apos; grants,
                products and the bots it leaves with no team. Its run history stays, and its name stays taken. Its namespace
                stays too, labelled retired, for a cluster administrator to delete.
              </Typography>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
                <Button variant="contained" color="error" disabled={busy || !retired} onClick={() => { setConfirm("purge"); }}>
                  Purge {team.name}…
                </Button>
                <Typography variant="body2" color="text.secondary">
                  {retired ? "You'll type its name to confirm." : "Retire it first."}
                </Typography>
              </Box>
            </SettingsCard>
          </Box>
        </Box>
      )}

      <ConfirmDialog
        open={confirm === "retire"}
        title={`Retire ${team.name}?`}
        description="It becomes read-only and its products are unregistered; nothing new starts in its namespace. You can restore it."
        confirmLabel="Retire"
        destructive
        busy={busy}
        onConfirm={() => void onRetire().finally(() => { setConfirm(null); })}
        onCancel={() => { setConfirm(null); }}
      />
      <ConfirmDialog
        open={confirm === "purge"}
        title={`Purge ${team.name}?`}
        description="This can't be undone. Members, secret grants and bot tokens are removed, and the name stays reserved; run history is kept. Its namespace stays, labelled retired, for a cluster administrator to delete."
        confirmLabel="Purge"
        confirmText={team.name}
        destructive
        busy={busy}
        onConfirm={() => void onPurge().finally(() => { setConfirm(null); })}
        onCancel={() => { setConfirm(null); }}
      />
    </Box>
  );
}
