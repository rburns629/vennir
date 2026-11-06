// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import {
  errorMessage,
  deleteSsoGroupMapping,
  getSsoSettings,
  listAllTeams,
  listSsoGroupMappings,
  setSsoGroupMapping,
  setSsoSettings,
  type SsoGroupMapping,
  type SsoSettings,
  type Team,
} from "../../api";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { useAdminChanged } from "./summary";
import { AdminCard, Aside, Dot, SrOnly, TABLE_SX } from "./parts";

/** Which group makes whom a member of which team: listed, added, removed; and the teams nothing maps. */
function GroupMappings({ teams }: { teams: Team[] }) {
  const [mappings, setMappings] = useState<SsoGroupMapping[] | null>(null);
  const [group, setGroup] = useState("");
  const [team, setTeam] = useState<string | null>(null);
  const [role, setRole] = useState<"member" | "maintainer">("member");
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    listSsoGroupMappings()
      .then(setMappings)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the mappings.")); });
  };
  useEffect(load, []);

  const changed = useAdminChanged();
  async function add(): Promise<void> {
    if (!team) return;
    setError(null);
    try {
      await setSsoGroupMapping(group.trim(), team, role);
      setGroup("");
      load();
      changed();
    } catch (err) {
      setError(errorMessage(err, "Couldn't map it."));
    }
  }

  // A retired team can't be mapped.
  const mappable = teams.filter((t) => !t.retiredAt && !t.deletedAt).map((t) => t.name);
  const mapped = new Set((mappings ?? []).map((m) => m.team));
  const unmapped = mappable.filter((t) => !mapped.has(t));
  return (
    <AdminCard
      title="Groups mapped to teams"
      status={mappings && mappings.length > 0 && <Aside>{mappings.length} {mappings.length === 1 ? "group" : "groups"}, {mapped.size} {mapped.size === 1 ? "team" : "teams"}</Aside>}
    >
      <Typography variant="body2" color="text.secondary">
        At each sign-in, a mapped team&apos;s membership follows the person&apos;s groups: added with the best role their groups give, or
        removed. Teams nothing maps to, bots, and people who sign in with a password are managed by hand. With a groups claim, mapping a
        team at once signs out each of its single sign-on members who signed in over an hour ago, and their password sessions no longer
        count the team.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {mappings?.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          None yet.
        </Typography>
      )}
      {mappings && mappings.length > 0 && (
        <Box sx={{ overflowX: "auto" }}>
          <Box component="table" sx={TABLE_SX}>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Team</th>
                <th scope="col">Role</th>
                <th scope="col">
                  <SrOnly>Unmap</SrOnly>
                </th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Mono sx={{ overflowWrap: "anywhere" }}>{m.group}</Mono>
                  </td>
                  <td>
                    <Link component={RouterLink} to={`/teams/${m.team}`}>
                      {m.team}
                    </Link>
                  </td>
                  <td>{m.role === "maintainer" ? <Pill tone="info">maintainer</Pill> : "member"}</td>
                  <Box component="td" sx={{ textAlign: "right", py: "4px !important" }}>
                    <IconButton
                      aria-label={`Unmap ${m.group} from ${m.team}`}
                      color="error"
                      onClick={() => {
                        deleteSsoGroupMapping(m.id)
                          .then(() => { load(); changed(); })
                          .catch((err: unknown) => { setError(errorMessage(err, "Couldn't unmap it.")); });
                      }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>
                </tr>
              ))}
            </tbody>
          </Box>
        </Box>
      )}
      <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", md: "2fr 1.4fr 1.2fr auto" }, alignItems: "start", borderTop: 1, borderColor: "divider", pt: 2 }}>
        <TextField size="small" label="Group" value={group} onChange={(e) => { setGroup(e.target.value); }} helperText="As the provider sends it, or a Google group's email" />
        <Autocomplete options={mappable} value={team} onChange={(_e, value) => { setTeam(value); }} renderInput={(params) => <TextField {...params} size="small" label="Team" />} />
        <TextField select size="small" label="Role" value={role} onChange={(e) => { setRole(e.target.value as "member" | "maintainer"); }}>
          <MenuItem value="member">member</MenuItem>
          <MenuItem value="maintainer">maintainer</MenuItem>
        </TextField>
        <Button variant="contained" disabled={!group.trim() || !team} onClick={() => void add()} sx={{ minHeight: 40 }}>
          Map
        </Button>
      </Box>
      {mappings && unmapped.length > 0 && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", fontSize: 13, color: "text.secondary" }}>
          <Dot tone="off" />
          Not mapped, so managed by hand:
          {unmapped.map((t, i) => (
            <span key={t}>
              <Link component={RouterLink} to={`/teams/${t}`}>
                {t}
              </Link>
              {i < unmapped.length - 1 ? "," : "."}
            </span>
          ))}
        </Box>
      )}
    </AdminCard>
  );
}

/**
 * Single sign-on, for admins: optional (passwords keep working), with the
 * provider set here unless the install set it, where people's groups come
 * from, and which groups make whom a member of which team.
 */
export function SsoCard() {
  const changed = useAdminChanged();
  const [saved, setSaved] = useState<SsoSettings | null>(null);
  const [form, setForm] = useState<SsoSettings | null>(null);
  const [secret, setSecret] = useState("");
  const [domains, setDomains] = useState("");
  const [teams, setTeams] = useState<Team[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const show = (s: SsoSettings) => {
    setSaved(s);
    setForm(s);
    setDomains(s.allowedDomains.join(", "));
    setSecret("");
  };
  useEffect(() => {
    getSsoSettings()
      .then(show)
      .catch((err: unknown) => { setError(errorMessage(err, "Couldn't load the single sign-on settings.")); });
    listAllTeams()
      .then(setTeams)
      .catch(() => undefined);
  }, []);

  if (!form || !saved) {
    return (
      <AdminCard title="The provider">
        {error ? <Alert severity="error">{error}</Alert> : <Typography color="text.secondary">Loading…</Typography>}
      </AdminCard>
    );
  }

  const set = (change: Partial<SsoSettings>) => { setForm({ ...form, ...change }); };
  const locked = form.setByInstall;
  const turningOff = saved.enabled && !form.enabled;

  async function save(): Promise<void> {
    if (!form) return;
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const provider = locked
        ? { issuer: "", clientId: "", clientSecret: "", redirectUrl: "", allowedDomains: [], label: "" }
        : { issuer: form.issuer.trim(), clientId: form.clientId.trim(), clientSecret: secret, redirectUrl: form.redirectUrl.trim(), allowedDomains: domains.split(/[\s,]+/).filter(Boolean), label: form.label.trim() };
      show(await setSsoSettings({ ...provider, enabled: form.enabled, groupsClaim: form.groupsClaim.trim(), googleGroups: form.googleGroups }));
      setNote("Saved: every console uses it within seconds.");
      changed();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save it."));
    } finally {
      setSaving(false);
    }
  }

  function copyRedirect(): void {
    void navigator.clipboard.writeText(form?.redirectUrl ?? "").then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1500);
    });
  }

  const who = saved.updatedBy ? ` by ${saved.updatedBy}` : "";
  const at = saved.updatedAt ? ` on ${new Date(saved.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" })}` : "";
  return (
    <>
      <AdminCard
        title="The provider"
        status={saved.enabled ? <Pill tone="success" dot="success.main">On · {saved.label || "single sign-on"}</Pill> : <Pill tone="neutral">Off</Pill>}
      >
        {locked ? (
          <Alert severity="info">
            This install sets its provider ({form.label}, {form.issuer}, for {form.allowedDomains.join(", ")}): change it with <Mono>vennir sso</Mono>{" "}
            and <Mono>vennir apply</Mono>. Groups are set here.
          </Alert>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary">
              {who || at ? `Set here${who}${at}. ` : ""}Saved settings reach every copy of the console within seconds.
            </Typography>
            <FormControlLabel control={<Switch checked={form.enabled} onChange={(e) => { set({ enabled: e.target.checked }); }} />} label="People may sign in with single sign-on" />
            <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
              <TextField size="small" label="Button's name" value={form.label} onChange={(e) => { set({ label: e.target.value }); }} helperText="Such as Google or Okta" />
              <TextField size="small" label="Issuer" value={form.issuer} onChange={(e) => { set({ issuer: e.target.value }); }} helperText="Such as https://accounts.google.com. Saving checks its discovery document answers" />
              <TextField size="small" label="Client ID" value={form.clientId} onChange={(e) => { set({ clientId: e.target.value }); }} />
              <TextField
                size="small"
                type="password"
                label="Client secret"
                value={secret}
                onChange={(e) => { setSecret(e.target.value); }}
                placeholder={saved.clientSecretSet ? "One is kept: type to replace it" : undefined}
                helperText={saved.clientSecretSet ? "One is kept (encrypted, never shown): type to replace it" : "Kept encrypted, never shown again"}
                autoComplete="new-password"
              />
              <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
                <TextField size="small" fullWidth label="Redirect URL" value={form.redirectUrl} onChange={(e) => { set({ redirectUrl: e.target.value }); }} helperText="Register exactly this with the provider" />
                <Tooltip title={copied ? "Copied" : "Copy"}>
                  <span>
                    <IconButton aria-label="Copy the redirect URL" disabled={!form.redirectUrl} onClick={copyRedirect} sx={{ border: 1, borderColor: "divider", borderRadius: 2, width: 40, height: 40 }}>
                      <CopyIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
              <TextField size="small" label="Email domains allowed" value={domains} onChange={(e) => { setDomains(e.target.value); }} helperText="Comma-separated. Only these accounts may sign in" />
            </Box>
            {turningOff && (
              <Alert severity="warning">
                Turned off, people who sign in only with single sign-on (no password) can&apos;t sign in until it&apos;s back on. Teams that
                require it accept passwords again meanwhile.
              </Alert>
            )}
          </>
        )}
      </AdminCard>

      <AdminCard title="Where groups come from">
        <Typography variant="body2" color="text.secondary">
          A sign-in whose groups can&apos;t be read is refused, never treated as no groups.
        </Typography>
        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, alignItems: "start" }}>
          <TextField
            size="small"
            label="Groups claim"
            value={form.groupsClaim}
            onChange={(e) => { set({ groupsClaim: e.target.value }); }}
            placeholder="groups"
            helperText="The ID token claim listing a person's groups (Entra ID, Okta, Keycloak: usually groups). Empty: none"
          />
          <Box>
            <FormControlLabel
              control={<Checkbox checked={form.googleGroups} onChange={(e) => { set({ googleGroups: e.target.checked }); }} />}
              label="Google Workspace groups too"
            />
            {form.googleGroups && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                Read with Cloud Identity&apos;s Groups API as this console&apos;s own Google account
                {form.googleIdentity ? <>, <Mono>{form.googleIdentity}</Mono>,</> : " (it has none here: not on Google Cloud)"} which a
                Workspace admin makes a Groups Reader (admin.google.com, Admin roles; <Mono>vennir sso google-groups</Mono> says how).
              </Typography>
            )}
          </Box>
        </Box>
        {error && <Alert severity="error">{error}</Alert>}
        {note && <Alert severity="success">{note}</Alert>}
        <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap", borderTop: 1, borderColor: "divider", pt: 2 }}>
          <Button variant="contained" disabled={saving} onClick={() => void save()} sx={{ minHeight: 44 }}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button variant="outlined" disabled={saving} onClick={() => { show(saved); }} sx={{ minHeight: 44 }}>
            Discard changes
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ alignSelf: "center" }}>
            Saves the provider and where groups come from together.
          </Typography>
        </Box>
      </AdminCard>

      <GroupMappings teams={teams} />
    </>
  );
}
