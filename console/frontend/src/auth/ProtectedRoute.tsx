// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useAuth } from "./AuthContext";
import { returnState } from "./returnTo";

/** While the first check of the session hasn't settled: nothing, or why not, with Retry now. */
export function SessionChecking() {
  const { trouble, retryNow } = useAuth();
  if (!trouble) return null;
  return (
    <Box sx={{ maxWidth: 560, mx: "auto", mt: 8, px: 2 }}>
      <Alert
        severity={trouble.retrying ? "warning" : "error"}
        action={
          <Button color="inherit" size="small" onClick={retryNow}>
            Retry now
          </Button>
        }
      >
        {trouble.message}
      </Alert>
    </Box>
  );
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <SessionChecking />;
  // Signed in, the browser comes back here (./returnTo.ts).
  if (!user) return <Navigate to="/login" replace state={returnState(location)} />;
  // A password someone else set: the server refuses everything but changing
  // it, so that's the only screen offered.
  if (user.mustChangePassword) return <Navigate to="/choose-password" replace state={returnState(location)} />;

  return children;
}
