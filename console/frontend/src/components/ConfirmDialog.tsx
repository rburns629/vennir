// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";

/**
 * Nothing in this app confirmed a destructive action before now -- revoking
 * an admin, revoking a token, all fired immediately on click. This is the
 * one shared confirm step every such action should go through from here on.
 *
 * `confirmText`, for irreversible actions: the confirm button stays
 * disabled until that exact text is typed.
 *
 * `input`, for an action that takes a word from the person (a reason, a
 * rate): its field, handed to `onConfirm`; when required, the confirm
 * button waits for it.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  confirmText,
  destructive = false,
  busy = false,
  input,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  confirmText?: string;
  destructive?: boolean;
  busy?: boolean;
  input?: { label: string; required?: boolean; helperText?: string; type?: "text" | "number"; initial?: string; maxLength?: number };
  /** Why the action failed, shown in the dialog so it can be tried again. */
  error?: string | null;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [value, setValue] = useState("");
  const initial = input?.initial ?? "";
  useEffect(() => {
    if (open) {
      setTyped("");
      setValue(initial);
    }
  }, [open, initial]);
  const confirmed = (confirmText === undefined || typed === confirmText) && (!input?.required || value.trim() !== "");

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 600 }}>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{description}</DialogContentText>
        {input && (
          <TextField
            autoFocus
            fullWidth
            size="small"
            margin="normal"
            label={input.label}
            type={input.type ?? "text"}
            multiline={input.type !== "number"}
            minRows={input.type !== "number" ? 2 : undefined}
            required={input.required}
            helperText={input.helperText}
            value={value}
            disabled={busy}
            onChange={(event) => {
              setValue(event.target.value);
            }}
            slotProps={{ htmlInput: { maxLength: input.maxLength, min: input.type === "number" ? 0 : undefined } }}
          />
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
        {confirmText !== undefined && (
          <TextField
            autoFocus
            fullWidth
            size="small"
            margin="normal"
            label={`Type "${confirmText}" to confirm`}
            value={typed}
            disabled={busy}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            onConfirm(value);
          }}
          color={destructive ? "error" : "primary"}
          variant="contained"
          disabled={busy || !confirmed}
        >
          {busy ? "Working…" : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
