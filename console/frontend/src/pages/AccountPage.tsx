// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { PasswordChangeForm } from "../components/PasswordChangeForm";
import { Pill } from "../components/Pill";
import { useEnvironment } from "../environment";
import { EmailSection } from "./account/EmailSection";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="h6" component="h2">
        {title}
      </Typography>
      {children}
    </Card>
  );
}

/** Yours alone: who you are here, how you sign in, and your teams. */
export function AccountPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const sso = useEnvironment()?.ssoLabel || "single sign-on";
  const [changed, setChanged] = useState(false);
  if (!user) return null;

  return (
    <Box>
      <PageHeader
        title="Preferences"
        subtitle="Yours alone."
        action={
          <Button
            variant="outlined"
            color="error"
            onClick={() => {
              logout();
              navigate("/login");
            }}
          >
            Sign out
          </Button>
        }
      />
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" }, alignItems: "start" }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Section title="Profile">
            <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
              <Avatar sx={{ width: 48, height: 48, bgcolor: "primary.main", fontWeight: 600 }} aria-hidden="true">
                {user.email.slice(0, 2).toUpperCase()}
              </Avatar>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>{user.email}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {user.isAdmin ? "An admin of this install" : "Set by your admin"}
                </Typography>
              </Box>
            </Box>
          </Section>

          <Section title="Your teams">
            {user.teamNames.length === 0 && <Typography color="text.secondary">You&apos;re not in a team yet.</Typography>}
            {user.teamNames.map((t) => (
              <Box key={t} sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1 }}>
                <Link component={RouterLink} to={`/teams/${encodeURIComponent(t)}`}>
                  {t}
                </Link>
                <Pill tone={user.maintainerOf.includes(t) ? "info" : "neutral"}>{user.maintainerOf.includes(t) ? "Maintainer" : "Member"}</Pill>
              </Box>
            ))}
            <Typography variant="body2" color="text.secondary">
              Each team&apos;s maintainers set roles, on its Members tab.
            </Typography>
          </Section>

          <EmailSection />
        </Box>

        <Section title="Signing in">
          {user.usesSso && (
            <Typography>
              You sign in with {sso}, as {user.email}.
              {!user.hasPassword && " Your password, security keys and two-step verification are your provider's: there's no Vennir password to change."}
            </Typography>
          )}
          {user.hasPassword && (
            <>
              <Typography variant="body2" color="text.secondary">
                {user.usesSso ? "You also have a password. " : ""}Changing it signs out every other session on this account; this one
                stays signed in.
              </Typography>
              {changed && <Alert severity="success">Password changed. Other sessions have been signed out.</Alert>}
              <PasswordChangeForm currentLabel="Current password" submitLabel="Change password" onChanged={() => { setChanged(true); }} />
            </>
          )}
        </Section>
      </Box>
    </Box>
  );
}
