// SPDX-License-Identifier: MIT
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import { ApiError } from "../api";

/** Why a load failed, as LoadFailed says it: the console's own message, or that it didn't answer. */
export const loadFailure = (err: unknown): string => (err instanceof ApiError ? err.message : "the console didn't answer.");

/**
 * A load that failed, said as one, never as an empty list: "Couldn't load
 * <what>: <why>", and Try again. `note` adds what it doesn't mean ("Nothing
 * is wrong with the runs themselves.").
 */
export function LoadFailed({ what, reason, note, onRetry }: { what: string; reason: string; note?: string; onRetry: () => void }) {
  return (
    <Alert
      severity="error"
      action={
        <Button color="inherit" variant="outlined" size="small" onClick={onRetry}>
          Try again
        </Button>
      }
      sx={{ alignItems: "center" }}
    >
      Couldn&apos;t load {what}: {reason}
      {note ? ` ${note}` : ""}
    </Alert>
  );
}
