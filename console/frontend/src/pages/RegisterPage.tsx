// SPDX-License-Identifier: MIT
import { useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Alert, Box, Button, Link, Stack, TextField, Typography } from "@mui/material";
import { errorMessage, PASSWORD_MIN_LENGTH, register } from "../api";
import { SignInLayout } from "../layout/SignInLayout";

export function RegisterPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register(email, password);
      // Registering doesn't log you in (see ../../src/rpc/services/auth.ts) --
      // it deliberately grants no access by itself, so the next real step
      // is a normal login.
      navigate("/login");
    } catch (err) {
      setError(errorMessage(err, "Something went wrong. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SignInLayout>
      <Typography component="h2" sx={{ fontSize: 22, fontWeight: 600, mb: 3 }}>
        Create an account
      </Typography>
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
            autoComplete="new-password"
            required
            fullWidth
            helperText={`At least ${String(PASSWORD_MIN_LENGTH)} characters.`}
            slotProps={{ htmlInput: { minLength: PASSWORD_MIN_LENGTH } }}
            value={password}
            onChange={(event) => { setPassword(event.target.value); }}
          />
          {error && <Alert severity="error">{error}</Alert>}
          <Button type="submit" variant="contained" size="large" disabled={submitting}>
            {submitting ? "Creating account…" : "Create account"}
          </Button>
          <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
            Already have an account? <Link component={RouterLink} to="/login">Sign in</Link>
          </Typography>
        </Stack>
      </Box>
    </SignInLayout>
  );
}
