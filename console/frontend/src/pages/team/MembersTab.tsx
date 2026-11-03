// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  Link,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import {
  errorMessage,
  addTeamMember,
  listSsoGroupMappings,
  listTeamMembers,
  removeTeamMember,
  setTeamMemberRole,
  type Role,
  type SsoGroupMapping,
  type TeamMember,
} from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { useEnvironment } from "../../environment";
import { CardTitle, ChoiceCard, TabIntro, relativeTime, visuallyHidden } from "./shared";

const ROLE_LABELS: Record<Role, string> = { maintainer: "Maintainer", member: "Member" };
const ROLE_HELP: Record<Role, string> = {
  member: "Sees the team's work and runs its actions; manages nothing.",
  maintainer: "Also manages people, secrets, bots and raw DAGs.",
};

/** Columns a phone does without: the row still has the person, role and Remove. */
const WIDE = { display: { xs: "none", sm: "table-cell" } } as const;

/** How someone signs in, as the column says it; a password alone is flagged. */
function SignsInWith({ member, sso }: { member: TeamMember; sso: string }) {
  if (member.usesSso && member.hasPassword) return <>{sso || "Single sign-on"} or a password</>;
  if (member.usesSso) return <Box component="span" sx={{ color: "success.main" }}>{sso || "Single sign-on"}</Box>;
  if (member.hasPassword) return <Box component="span" sx={{ color: sso ? "warning.main" : "text.primary" }}>{sso ? "Password only" : "Password"}</Box>;
  return <Box component="span" sx={{ color: "text.secondary" }}>Not yet</Box>;
}

export function MembersTab({
  teamName,
  readOnly,
  currentUserId,
  requireSso,
  onShowAutomation,
  onShowSettings,
}: {
  teamName: string;
  readOnly: boolean;
  currentUserId: string | undefined;
  /** The team requires single sign-on: people with only a password are called out. */
  requireSso: boolean;
  /** Absent for someone who can't see the team's bots. */
  onShowAutomation?: () => void;
  onShowSettings: () => void;
}) {
  const sso = useEnvironment()?.ssoLabel ?? "";
  const isAdmin = useAuth().user?.isAdmin ?? false;
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [mappings, setMappings] = useState<SsoGroupMapping[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [roleBusy, setRoleBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    listTeamMembers(teamName)
      .then(setMembers)
      .catch((err: unknown) => {
        setLoadError(errorMessage(err, "Couldn't load members."));
      });
  }, [teamName]);

  useEffect(reload, [reload]);
  useEffect(() => {
    // Admins only (the mappings are the install's); display only.
    if (!isAdmin || !sso) return;
    listSsoGroupMappings()
      .then((all) => { setMappings(all.filter((m) => m.team === teamName)); })
      .catch(() => undefined);
  }, [isAdmin, sso, teamName]);

  async function remove(): Promise<void> {
    if (!removing) return;
    setRemoveBusy(true);
    setLoadError(null);
    try {
      await removeTeamMember(teamName, removing.id);
      reload();
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't remove them. Try again."));
    } finally {
      setRemoveBusy(false);
      setRemoving(null);
    }
  }

  async function changeRole(member: TeamMember, role: Role): Promise<void> {
    setRoleBusy(member.id);
    setLoadError(null);
    try {
      await setTeamMemberRole(teamName, member.id, role);
      reload();
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't change their role. Try again."));
    } finally {
      setRoleBusy(null);
    }
  }

  const people = (members ?? []).filter((m) => !m.isBot);
  const botCount = (members ?? []).length - people.length;
  const maintainers = people.filter((m) => m.role === "maintainer").length;
  const passwordOnly = people.filter((m) => !m.isAdmin && m.hasPassword && !m.usesSso);

  return (
    <Box>
      <TabIntro>
        People in {teamName}. Every member sees the team's runs, logs and secrets' names, and runs its actions.
        Maintainers also manage it: people and their roles, secrets, bots, schedules and raw DAGs. Nobody here acts for
        another team.
      </TabIntro>
      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1.9fr) minmax(0, 1fr)" },
          gap: 2,
          alignItems: "start",
        }}
      >
        <Card component="section" aria-labelledby="people" sx={{ overflow: "hidden" }}>
          <Box sx={{ px: 2.5, pt: 2.5, pb: 1.5, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
            <Typography variant="h6" component="h2" id="people" sx={{ fontSize: 17 }}>
              {members ? `${String(people.length)} ${people.length === 1 ? "person" : "people"}` : "People"}
            </Typography>
            {members && (
              <Typography variant="body2" color="text.secondary">
                {maintainers} {maintainers === 1 ? "maintainer" : "maintainers"}
                {mappings && mappings.length > 0 && ` · joined by ${String(mappings.length)} ${mappings.length === 1 ? "group" : "groups"}`}
              </Typography>
            )}
          </Box>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Person</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell sx={WIDE}>Signs in with</TableCell>
                  <TableCell sx={WIDE}>Added</TableCell>
                  <TableCell align="right" sx={{ position: "relative" }}>
                    <Box component="span" sx={visuallyHidden}>
                      Actions
                    </Box>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {members && people.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <Typography color="text.secondary" sx={{ py: 1 }}>
                        Nobody yet. An admin adds the first person.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {people.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell sx={{ py: 1.5 }}>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minWidth: 0 }}>
                        <Box
                          aria-hidden="true"
                          sx={{
                            width: 36,
                            height: 36,
                            display: { xs: "none", sm: "flex" },
                            borderRadius: "50%",
                            flexShrink: 0,
                            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
                            color: "primary.dark",
                            alignItems: "center",
                            justifyContent: "center",
                            fontWeight: 600,
                            fontSize: 13,
                          }}
                        >
                          {m.email.slice(0, 2).toUpperCase()}
                        </Box>
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
                            {m.email}
                          </Typography>
                          {(m.id === currentUserId || m.isAdmin) && (
                            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.25, flexWrap: "wrap" }}>
                              {m.id === currentUserId && (
                                <Typography variant="caption" color="text.secondary">
                                  You
                                </Typography>
                              )}
                              {m.isAdmin && <Pill tone="warning">Vertra admin</Pill>}
                            </Box>
                          )}
                        </Box>
                      </Box>
                    </TableCell>
                    <TableCell>
                      {readOnly || m.followsGroups ? (
                        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0.25 }}>
                          <Pill tone={m.role === "maintainer" ? "info" : "neutral"}>{ROLE_LABELS[m.role]}</Pill>
                          {m.followsGroups && (
                            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                              {m.viaGroups.length > 0
                                ? `Set by their group${m.viaGroups.length === 1 ? "" : "s"} ${m.viaGroups.join(", ")}`
                                : "Set by their groups"}
                            </Typography>
                          )}
                        </Box>
                      ) : (
                        <TextField
                          select
                          size="small"
                          value={m.role}
                          disabled={roleBusy === m.id}
                          onChange={(event) => void changeRole(m, event.target.value as Role)}
                          slotProps={{ htmlInput: { "aria-label": `${m.email}'s role` } }}
                          sx={{ minWidth: { xs: 116, sm: 132 } }}
                        >
                          <MenuItem value="maintainer">Maintainer</MenuItem>
                          <MenuItem value="member">Member</MenuItem>
                        </TextField>
                      )}
                    </TableCell>
                    <TableCell sx={WIDE}>
                      <SignsInWith member={m} sso={sso} />
                    </TableCell>
                    <TableCell sx={{ ...WIDE, color: "text.secondary", whiteSpace: "nowrap" }}>{relativeTime(m.addedAt)}</TableCell>
                    <TableCell align="right">
                      {!readOnly && !m.followsGroups && (
                        <Button
                          size="small"
                          color="error"
                          sx={{ minHeight: 36 }}
                          onClick={() => {
                            setRemoving(m);
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {(onShowAutomation || (requireSso && passwordOnly.length > 0)) && (
            <Stack spacing={0.75} sx={{ px: 2.5, py: 1.75, bgcolor: "background.default", borderTop: 1, borderColor: "divider" }}>
              {onShowAutomation && (
                <Typography variant="body2" color="text.secondary">
                  {botCount > 0
                    ? `${String(botCount)} ${botCount === 1 ? "bot acts" : "bots act"} for ${teamName} from pipelines and other systems: `
                    : "Bots for your pipelines are on "}
                  <Link component="button" onClick={onShowAutomation} sx={{ verticalAlign: "baseline" }}>
                    Automation
                  </Link>
                  .
                </Typography>
              )}
              {requireSso && passwordOnly.length > 0 && (
                <Typography variant="body2" sx={{ color: "warning.main" }}>
                  {passwordOnly.length === 1 ? "1 signs" : `${String(passwordOnly.length)} sign`} in with a password only, while {teamName} requires {sso}:{" "}
                  <Link component="button" onClick={onShowSettings} sx={{ verticalAlign: "baseline", color: "inherit" }}>
                    Settings
                  </Link>
                </Typography>
              )}
            </Stack>
          )}
        </Card>

        <Stack spacing={2}>
          {!readOnly && <AddPerson teamName={teamName} sso={sso} onAdded={reload} />}
          {mappings && (
            <Card component="section" aria-labelledby="groups" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
              <CardTitle id="groups" title="Who joins by group">
                At each sign-in, and hourly for Google groups, people in these groups are added with the best role their groups
                give, and removed when they leave.
              </CardTitle>
              {mappings.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No group puts people in {teamName}.
                </Typography>
              ) : (
                mappings.map((m) => (
                  <Box
                    key={m.id}
                    sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, p: 1.25, borderRadius: 2, bgcolor: "background.default" }}
                  >
                    <Mono sx={{ overflowWrap: "anywhere", fontSize: 13 }}>{m.group}</Mono>
                    <Pill tone={m.role === "maintainer" ? "info" : "neutral"}>{ROLE_LABELS[m.role]}</Pill>
                  </Box>
                ))
              )}
              <Typography variant="body2" color="text.secondary">
                A group member&apos;s role is the group&apos;s: change it in the group, or in{" "}
                <Link component={RouterLink} to="/admin/sign-in">
                  Admin → Single sign-on and groups
                </Link>
                . People added here by hand stay until removed.
              </Typography>
            </Card>
          )}
        </Stack>
      </Box>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.email ?? ""} from ${teamName}?`}
        description={
          removing?.id === currentUserId
            ? "You'll lose access to this team straight away. A maintainer or an admin can add you back."
            : "They lose access to this team straight away: its secrets, runs and settings. A maintainer can add them back."
        }
        confirmLabel="Remove"
        destructive
        busy={removeBusy}
        onConfirm={() => void remove()}
        onCancel={() => {
          setRemoving(null);
        }}
      />
    </Box>
  );
}

function AddPerson({ teamName, sso, onAdded }: { teamName: string; sso: string; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setAdded(null);
    setSubmitting(true);
    try {
      await addTeamMember(teamName, email.trim(), role);
      setAdded(email.trim());
      setEmail("");
      onAdded();
    } catch (err) {
      setError(errorMessage(err, "Couldn't add them. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card component="section" aria-labelledby="addh" sx={{ p: 2.5 }}>
      <Box component="form" onSubmit={(event: FormEvent) => void submit(event)}>
        <Stack spacing={2}>
          <CardTitle id="addh" title="Add a person" />
          <TextField
            label="Their console email"
            type="email"
            size="small"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            helperText={
              sso
                ? `They need a console account first; with ${sso} sign-in, they have one once they've signed in. No account yet? A Vertra admin can create one.`
                : "They need a console account first. No account yet? Ask a Vertra admin to create one; it can join this team straight away."
            }
          />
          <Box component="fieldset" sx={{ border: 0, p: 0, m: 0, display: "flex", flexDirection: "column", gap: 1 }}>
            <Typography component="legend" variant="body2" sx={{ fontWeight: 500, mb: 1 }}>
              Role
            </Typography>
            {(["member", "maintainer"] as const).map((r) => (
              <ChoiceCard key={r} selected={role === r} onSelect={() => { setRole(r); }} title={ROLE_LABELS[r]} description={ROLE_HELP[r]} />
            ))}
          </Box>
          <Button type="submit" variant="contained" disabled={submitting} sx={{ alignSelf: "flex-start" }}>
            {submitting ? "Adding…" : `Add to ${teamName}`}
          </Button>
          {error && <Alert severity="error">{error}</Alert>}
          {added && (
            <Alert severity="success">
              {added} added. They'll see {teamName} the next time they open the console.
            </Alert>
          )}
        </Stack>
      </Box>
    </Card>
  );
}
