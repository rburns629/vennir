// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import MoreIcon from "@mui/icons-material/MoreHoriz";
import {
  errorMessage,
  createAccount,
  deleteAccount,
  grantAdmin,
  listAllTeams,
  listUsers,
  PASSWORD_MIN_LENGTH,
  resetUserPassword,
  revokeAdmin,
  type Team,
  type UserAccount,
} from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Pill } from "../../components/Pill";
import { useEnvironment } from "../../environment";
import { when } from "../../time";
import { useAdminChanged } from "./summary";
import { AdminCard, KeyValues } from "./parts";

const mono = { fontFamily: "fontFamilyMono", fontSize: 13 } as const;

function signsInWith(u: UserAccount, sso: string): string {
  if (u.usesSso && u.hasPassword) return `${sso || "Single sign-on"} and a password`;
  if (u.usesSso) return sso || "Single sign-on";
  if (u.hasPassword) return "Password";
  return "—";
}

/** How people sign in here: set by the provider and each team, so this only says how. */
function SigningIn({ teams }: { teams: Team[] }) {
  const sso = useEnvironment()?.ssoLabel ?? "";
  const live = teams.filter((t) => !t.retiredAt && !t.deletedAt);
  const requiring = live.filter((t) => t.requireSso).map((t) => t.name);
  return (
    <AdminCard title="Signing in" status={sso ? <Pill tone="success" dot="success.main">{sso} and passwords</Pill> : <Pill tone="neutral">Passwords only</Pill>}>
      <KeyValues
        nameWidth={120}
        rows={
          sso
            ? [
                ["Single sign-on", `${sso}. Someone signing in for the first time gets an account in no team.`],
                ["Passwords", `Allowed, except for members of a team that requires single sign-on. Admins can always use theirs, in case ${sso} can't be reached.`],
                [
                  "Requiring it",
                  requiring.length === 0 ? (
                    "No team. Each team's Settings tab sets it."
                  ) : (
                    <>
                      {requiring.map((t, i) => (
                        <span key={t}>
                          {i > 0 && ", "}
                          <Link component={RouterLink} to={`/teams/${t}?tab=settings`}>
                            {t}
                          </Link>
                        </span>
                      ))}
                      : {requiring.length} of {live.length} teams, each on its Settings tab.
                    </>
                  ),
                ],
              ]
            : [
                ["Single sign-on", "Off."],
                ["Passwords", "Everyone signs in with one: an admin adds them here."],
              ]
        }
      />
      <Typography variant="body2" color="text.secondary">
        The provider and its group mappings are in{" "}
        <Link component={RouterLink} to="/admin/sign-in">
          Single sign-on and groups →
        </Link>
        , unless the install sets the provider (<Box component="span" sx={mono}>vennir sso google</Box>, or{" "}
        <Box component="span" sx={mono}>vennir sso off</Box> to stop).
      </Typography>
    </AdminCard>
  );
}

function AddPerson({ teams, onAdded }: { teams: Team[]; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [admin, setAdmin] = useState(false);
  const [created, setCreated] = useState<{ email: string; temporaryPassword: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only teams someone can still join.
  const joinable = teams.filter((t) => !t.retiredAt && !t.deletedAt).map((t) => t.name);

  const changed = useAdminChanged();
  async function add(): Promise<void> {
    setError(null);
    setCreated(null);
    setBusy(true);
    try {
      setCreated(await createAccount(email.trim(), chosen, admin));
      setEmail("");
      setChosen([]);
      setAdmin(false);
      onAdded();
      changed();
    } catch (err) {
      setError(errorMessage(err, "Couldn't add them."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminCard title="Add a person">
      <TextField size="small" type="email" label="Email" placeholder="name@example.com" value={email} onChange={(e) => { setEmail(e.target.value); }} />
      <Autocomplete
        multiple
        size="small"
        options={joinable}
        value={chosen}
        onChange={(_e, value) => { setChosen(value); }}
        renderInput={(params) => <TextField {...params} label="Teams" placeholder="The teams they work on" helperText="They join each one as a maintainer. Retired teams can't be chosen." />}
      />
      <FormControlLabel control={<Checkbox checked={admin} onChange={(e) => { setAdmin(e.target.checked); }} />} label="Admin of this install" />
      <Typography variant="body2" color="text.secondary">
        With single sign-on on, they sign in with it as this email. Otherwise (and always for an admin) they get a temporary
        password, shown once, which they replace when they first sign in.
      </Typography>
      <Box>
        <Button variant="contained" disabled={busy || !email.trim()} onClick={() => void add()} sx={{ minHeight: 44 }}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </Box>
      {created?.temporaryPassword === "" && (
        <Alert severity="success">
          Added <strong>{created.email}</strong>. They sign in with single sign-on as that email.
        </Alert>
      )}
      {created && created.temporaryPassword !== "" && (
        <Alert severity="success">
          Added <strong>{created.email}</strong>. Temporary password: <Box component="code" sx={mono}>{created.temporaryPassword}</Box>
          <br />
          Copy it now; it isn&apos;t shown again. Send it to them privately: they choose their own when they first sign in.
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </AdminCard>
  );
}

/** A new password an admin sets for someone, who must replace it when they next sign in. */
function ResetPasswordDialog({ email, onClose }: { email: string; onClose: (done: string | null) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reset(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await resetUserPassword(email, password);
      onClose(`${email}'s password is reset and their sessions signed out. They choose their own when they next sign in.`);
    } catch (err) {
      setError(errorMessage(err, "Couldn't reset it."));
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={() => { onClose(null); }} maxWidth="xs" fullWidth>
      <DialogTitle>Reset {email}&apos;s password</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Signs them out everywhere. Send them the temporary password privately; they replace it when they next sign in.
        </Typography>
        <TextField
          type="password"
          autoComplete="new-password"
          label="Temporary password"
          helperText={`At least ${String(PASSWORD_MIN_LENGTH)} characters.`}
          value={password}
          onChange={(e) => { setPassword(e.target.value); }}
        />
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { onClose(null); }}>Cancel</Button>
        <Button variant="contained" color="warning" disabled={busy || password.length < PASSWORD_MIN_LENGTH} onClick={() => void reset()}>
          Reset password
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Who the list shows: everyone, admins, or people who haven't chosen a password yet. */
type Kind = "all" | "admins" | "unfinished";
const KINDS: Record<Kind, { label: string; test: (p: UserAccount) => boolean }> = {
  all: { label: "All", test: () => true },
  admins: { label: "Admins", test: (p) => p.isAdmin },
  unfinished: { label: "To finish", test: (p) => p.mustChangePassword },
};

type Pending = { kind: "delete" | "revoke"; email: string } | { kind: "reset"; email: string };

/**
 * Who can sign in, and how: how sign-in works here, adding a person, and
 * everyone with their teams, how they sign in and when they last did. What
 * each may do comes from their teams; each team's maintainers set roles.
 */
export function PeopleTab() {
  const { user } = useAuth();
  const sso = useEnvironment()?.ssoLabel ?? "";
  const [people, setPeople] = useState<UserAccount[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; person: UserAccount } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    listUsers()
      .then(setPeople)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the people.")); });
  }, []);

  useEffect(() => {
    load();
    listAllTeams().then(setTeams).catch(() => undefined);
  }, [load]);

  const changed = useAdminChanged();
  async function act(action: () => Promise<void>, done: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      setNotice(done);
      load();
      changed();
    } catch (err) {
      setError(errorMessage(err, "That didn't work."));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const query = search.trim().toLowerCase();
  const shown = useMemo(
    () => people?.filter((p) => KINDS[kind].test(p) && (!query || [p.email, ...p.teamNames].some((s) => s.toLowerCase().includes(query)))) ?? null,
    [people, query, kind],
  );

  const columns: DataTableColumn<UserAccount>[] = [
    {
      key: "person",
      header: "Person",
      render: (p) => (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, alignItems: "flex-start" }}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {p.email}
            {p.email === user?.email && " (you)"}
          </Typography>
          {p.mustChangePassword && <Pill tone="warning">Hasn&apos;t chosen a password yet</Pill>}
          {p.teamNames.length === 0 && !p.isAdmin && <Pill tone="info">No team yet</Pill>}
        </Box>
      ),
    },
    { key: "signin", header: "Signs in with", render: (p) => signsInWith(p, sso), hideBelow: "sm" },
    { key: "teams", header: "Teams", render: (p) => p.teamNames.join(", ") || "—", hideBelow: "sm" },
    { key: "admin", header: "Admin", render: (p) => (p.isAdmin ? <Pill tone="info">Admin</Pill> : null) },
    { key: "last", header: "Last signed in", render: (p) => (p.lastSignedInAt ? when(p.lastSignedInAt) : "Never"), hideBelow: "md" },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (p) => (
        <IconButton aria-label={`Actions for ${p.email}`} onClick={(e) => { e.stopPropagation(); setMenu({ anchor: e.currentTarget, person: p }); }}>
          <MoreIcon />
        </IconButton>
      ),
    },
  ];

  const person = menu?.person;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, alignItems: "start" }}>
        <SigningIn teams={teams} />
        <AddPerson teams={teams} onAdded={load} />
      </Box>

      <AdminCard
        label="Everyone"
        title={people ? `Everyone: ${String(people.length)} ${people.length === 1 ? "person" : "people"}` : "Everyone"}
        status={
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            <Box role="group" aria-label="Show" sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
              {(Object.keys(KINDS) as Kind[]).map((k) => (
                <Chip
                  key={k}
                  label={`${KINDS[k].label} ${people ? String(people.filter(KINDS[k].test).length) : ""}`}
                  clickable
                  aria-pressed={kind === k}
                  color={kind === k ? "primary" : "default"}
                  variant={kind === k ? "filled" : "outlined"}
                  onClick={() => { setKind(k); }}
                  sx={{ height: 36 }}
                />
              ))}
            </Box>
            <TextField
              size="small"
              placeholder="Find a person or team"
              value={search}
              onChange={(e) => { setSearch(e.target.value); }}
              slotProps={{ htmlInput: { "aria-label": "Find a person or team" } }}
              sx={{ width: { xs: "100%", sm: 240 } }}
            />
          </Box>
        }
      >
        {notice && (
          <Alert severity="success" onClose={() => { setNotice(null); }}>
            {notice}
          </Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        <DataTable columns={columns} rows={shown} getRowKey={(p) => p.email} emptyMessage={query || kind !== "all" ? "Nobody matches." : "No accounts yet."} />
      </AdminCard>

      <Card sx={{ px: 3, py: 2 }}>
        <Typography variant="body2" color="text.secondary">
          If no admin can sign in: from a machine that can reach the cluster, <Box component="span" sx={mono}>vennir admin reset-password &lt;env&gt;</Box>. It
          gives the install&apos;s first admin (or <Box component="span" sx={mono}>--email</Box>&apos;s) a new password, shown once.
        </Typography>
      </Card>

      <Menu anchorEl={menu?.anchor} open={menu !== null} onClose={() => { setMenu(null); }}>
        {person && (
          <MenuItem
            onClick={() => {
              setMenu(null);
              if (person.isAdmin) setPending({ kind: "revoke", email: person.email });
              else void act(() => grantAdmin(person.email), `${person.email} is now an admin.`);
            }}
          >
            {person.isAdmin ? "Remove admin…" : "Make admin"}
          </MenuItem>
        )}
        {person?.hasPassword && (
          <MenuItem onClick={() => { setMenu(null); setPending({ kind: "reset", email: person.email }); }}>Reset password…</MenuItem>
        )}
        {person?.teamNames.map((t) => (
          <MenuItem key={t} component={RouterLink} to={`/teams/${t}`} onClick={() => { setMenu(null); }}>
            Open {t}&apos;s members
          </MenuItem>
        ))}
        {person && person.email !== user?.email && (
          <MenuItem sx={{ color: "error.main" }} onClick={() => { setMenu(null); setPending({ kind: "delete", email: person.email }); }}>
            Delete…
          </MenuItem>
        )}
      </Menu>

      <ConfirmDialog
        open={pending?.kind === "revoke"}
        title={`Remove ${pending?.email ?? ""} as an admin?`}
        description="They lose admin access at once; their teams stay. The last admin can't be removed."
        confirmLabel="Remove admin"
        destructive
        busy={busy}
        onConfirm={() => { if (pending) void act(() => revokeAdmin(pending.email), `${pending.email} is no longer an admin.`); }}
        onCancel={() => { setPending(null); }}
      />
      <ConfirmDialog
        open={pending?.kind === "delete"}
        title={`Delete ${pending?.email ?? ""}?`}
        description="They lose access at once: their team memberships and tokens are removed. Runs they started stay in the history, shown as from a deleted account. This can't be undone."
        confirmLabel="Delete account"
        confirmText={pending?.kind === "delete" ? pending.email : undefined}
        destructive
        busy={busy}
        onConfirm={() => { if (pending) void act(() => deleteAccount(pending.email), `${pending.email} is deleted.`); }}
        onCancel={() => { setPending(null); }}
      />
      {pending?.kind === "reset" && (
        <ResetPasswordDialog
          email={pending.email}
          onClose={(done) => {
            setPending(null);
            if (done) {
              setNotice(done);
              load();
            }
          }}
        />
      )}
    </Box>
  );
}
