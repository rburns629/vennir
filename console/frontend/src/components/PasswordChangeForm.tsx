// SPDX-License-Identifier: MIT
import { useState, type FormEvent } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { ApiError, errorMessage, changePassword, PASSWORD_MIN_LENGTH } from "../api";
import { useAuth } from "../auth/AuthContext";

/**
 * Changing your own password: on the account page, and on the screen a
 * password someone else set leads to. A problem is said on the field it's
 * about; the change revokes this session, so the new token is swapped in
 * before anything else makes a request.
 */
export function PasswordChangeForm({
  currentLabel,
  submitLabel,
  onChanged,
}: {
  currentLabel: string;
  submitLabel: string;
  onChanged: () => void | Promise<void>;
}) {
  const { adoptToken } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [tried, setTried] = useState(false);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tooShort = newPassword.length > 0 && newPassword.length < PASSWORD_MIN_LENGTH;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const newProblem =
    problems["newPassword"] ??
    (tried && tooShort ? `At least ${String(PASSWORD_MIN_LENGTH)} characters: this one has ${String(newPassword.length)}.` : undefined);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTried(true);
    setProblems({});
    setError(null);
    if (tooShort || mismatch) return;
    setSubmitting(true);
    try {
      adoptToken(await changePassword(currentPassword, newPassword));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTried(false);
      await onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.problems.length > 0) {
        setProblems(Object.fromEntries(err.problems.map((p) => [p.field, p.message])));
      } else {
        setError(errorMessage(err, "Something went wrong. Try again."));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Box component="form" noValidate onSubmit={(event: FormEvent) => void handleSubmit(event)}>
      <Stack spacing={2}>
        <TextField
          label={currentLabel}
          type="password"
          autoComplete="current-password"
          required
          fullWidth
          error={Boolean(problems["currentPassword"])}
          helperText={problems["currentPassword"]}
          value={currentPassword}
          onChange={(event) => { setCurrentPassword(event.target.value); }}
        />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          fullWidth
          error={Boolean(newProblem)}
          helperText={newProblem ?? `At least ${String(PASSWORD_MIN_LENGTH)} characters.`}
          value={newPassword}
          onChange={(event) => { setNewPassword(event.target.value); }}
        />
        <TextField
          label="New password, again"
          type="password"
          autoComplete="new-password"
          required
          fullWidth
          error={mismatch}
          helperText={mismatch ? "Doesn't match the new password." : " "}
          value={confirmPassword}
          onChange={(event) => { setConfirmPassword(event.target.value); }}
        />
        {error && <Alert severity="error">{error}</Alert>}
        <Button type="submit" variant="contained" size="large" disabled={submitting || confirmPassword.length === 0 || currentPassword.length === 0}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </Stack>
    </Box>
  );
}
