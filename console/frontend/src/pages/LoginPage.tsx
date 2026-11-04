// SPDX-License-Identifier: MIT
import { useEffect, useState, type FormEvent } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import GlobeIcon from "@mui/icons-material/LanguageOutlined";
import { ApiError, errorMessage, SSO_START } from "../api";
import { useAuth } from "../auth/AuthContext";
import { keepForSso, returnPath, takeAfterSso } from "../auth/returnTo";
import { useEnvironment } from "../environment";
import { SignInLayout } from "../layout/SignInLayout";

/** What /login#error=<CODE> means, from a single sign-on that was refused. */
const SSO_ERRORS: Record<string, string> = {
  DOMAIN_NOT_ALLOWED: "That account isn't from a domain allowed to sign in here. Choose your work account.",
  EMAIL_NOT_VERIFIED: "Your provider hasn't verified that account's email.",
  ACCOUNT_LINKED_ELSEWHERE: "This email's Vennir account signs in with a different account. Ask an admin if that's wrong.",
  SIGN_IN_EXPIRED: "That sign-in took too long or was started elsewhere. Try again.",
  NOT_STARTED_HERE: "That sign-in link wasn't started from this window, so it wasn't used. Sign in here.",
  SIGN_IN_CANCELLED: "Sign-in was cancelled.",
  SIGN_IN_FAILED: "Sign-in didn't work. Try again, or ask an admin.",
  SSO_OFF: "Single sign-on isn't on here any more: sign in with your password, or ask an admin.",
  GROUPS_UNAVAILABLE: "Your groups couldn't be read, so your teams can't be checked. Try again shortly, or ask an admin.",
};

/** Where the sign-in page keeps the value it gives single sign-on for this tab. */
const SSO_TAB_KEY = "vennir_sso_tab";

/** Starts single sign-on from this tab: a value only it knows, which must come back with the session. */
function startSso(returnTo: string): void {
  keepForSso(returnTo);
  const tab = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    sessionStorage.setItem(SSO_TAB_KEY, tab);
  } catch {
    // Storage blocked: the session coming back is refused, and says so.
  }
  window.location.assign(`${SSO_START}?tab=${tab}`);
}

/** Whether a session came back from the sign-in this tab started; its value is used once. */
function startedHere(tab: string | null): boolean {
  let mine: string | null = null;
  try {
    mine = sessionStorage.getItem(SSO_TAB_KEY);
    sessionStorage.removeItem(SSO_TAB_KEY);
  } catch {
    return false;
  }
  return mine !== null && tab === mine;
}

export function LoginPage() {
  const { login, sessionExpired, adoptToken, refresh } = useAuth();
  const navigate = useNavigate();
  // The page that sent the browser here, to go back to once signed in.
  const returnTo = returnPath(useLocation().state);
  const environment = useEnvironment();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A team of theirs signs in with single sign-on only: said apart, since
  // the way forward is the button above, not another password.
  const [ssoRequired, setSsoRequired] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Single sign-on's provider, when it's on. Passwords still work, except
  // for teams that require single sign-on.
  const sso = environment?.ssoLabel ?? "";

  // Back from single sign-on: the session (or why not) in the fragment,
  // which never reaches a server. Taken off the address straight away.
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("token");
    const failed = fragment.get("error");
    if (!token && !failed) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (failed) {
      setError(SSO_ERRORS[failed] ?? SSO_ERRORS["SIGN_IN_FAILED"] ?? null);
      return;
    }
    if (token) {
      // A session in a link someone else made isn't taken: it would sign
      // this browser in as them (login CSRF).
      if (!startedHere(fragment.get("tab"))) {
        setError(SSO_ERRORS["NOT_STARTED_HERE"] ?? null);
        return;
      }
      adoptToken(token);
      void refresh().then(() => {
        navigate(takeAfterSso());
      });
    }
  }, [adoptToken, refresh, navigate]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSsoRequired(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(returnTo);
    } catch (err) {
      if (err instanceof ApiError && err.code === "SSO_REQUIRED") setSsoRequired(err.message);
      else setError(errorMessage(err, "Something went wrong. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SignInLayout>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, mb: 3 }}>
        <Typography component="h2" sx={{ fontSize: 22, fontWeight: 600 }}>
          Sign in
        </Typography>
        {environment?.label && (
          <Typography sx={{ fontSize: 14, color: "text.secondary" }}>to Vennir on {environment.label}</Typography>
        )}
      </Box>
      <Stack spacing={2}>
        {sessionExpired && !error && !ssoRequired && <Alert severity="info">Your session has ended. Sign in again to continue.</Alert>}
        {ssoRequired && (
          <Alert severity="error" role="alert">
            <AlertTitle>Sign in with {sso || "single sign-on"} instead</AlertTitle>
            {ssoRequired}
          </Alert>
        )}
        {sso && (
          <>
            <Button variant="outlined" size="large" onClick={() => { startSso(returnTo); }} startIcon={<GlobeIcon />} sx={{ color: "text.primary", borderColor: "divider" }}>
              Sign in with {sso}
            </Button>
            <Divider>
              <Typography variant="caption" color="text.secondary">
                or with a password
              </Typography>
            </Divider>
          </>
        )}
        <Box component="form" onSubmit={(event: FormEvent) => void handleSubmit(event)}>
          <Stack spacing={2}>
            <TextField
              label="Email"
              type="email"
              autoComplete="username"
              required
              fullWidth
              value={email}
              onChange={(event) => { setEmail(event.target.value); }}
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              fullWidth
              value={password}
              onChange={(event) => { setPassword(event.target.value); }}
            />
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained" size="large" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </Stack>
        </Box>
        <Typography sx={{ fontSize: 12, color: "text.secondary", lineHeight: 1.5 }}>
          Forgot your password? Ask a Vennir admin for a new one; you choose your own when you next sign in. Too many
          tries from one place wait a few minutes.
        </Typography>
        <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
          {environment?.selfRegistration ? (
            <>
              No account? <Link component={RouterLink} to="/register">Register</Link>
            </>
          ) : sso ? (
            `No account? Sign in with ${sso}, or ask a Vennir admin for one.`
          ) : (
            "No account? Ask a Vennir admin for one."
          )}
        </Typography>
      </Stack>
    </SignInLayout>
  );
}
