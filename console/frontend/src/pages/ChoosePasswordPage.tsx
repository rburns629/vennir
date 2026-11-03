// SPDX-License-Identifier: MIT
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useAuth } from "../auth/AuthContext";
import { returnPath } from "../auth/returnTo";
import { PasswordChangeForm } from "../components/PasswordChangeForm";
import { SignInLayout } from "../layout/SignInLayout";

/**
 * Where someone signed in with a password someone else set (a new
 * account's, an admin's reset, the first admin's generated one) is held
 * until they choose their own: the server refuses everything else
 * (PASSWORD_CHANGE_REQUIRED), so nothing else is offered.
 */
export function ChoosePasswordPage() {
  const { user, loading, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const { state } = useLocation();

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace state={state} />;
  if (!user.mustChangePassword) return <Navigate to={returnPath(state)} replace />;

  return (
    <SignInLayout>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, mb: 3 }}>
        <Typography component="h2" sx={{ fontSize: 22, fontWeight: 600 }}>
          Choose your own password
        </Typography>
        <Typography sx={{ fontSize: 14, color: "text.secondary", lineHeight: 1.5 }}>
          {user.email} signed in with a temporary password from an admin. Choose one only you know before going on;
          nothing else opens until you do.
        </Typography>
      </Box>
      <PasswordChangeForm
        currentLabel="Temporary password"
        submitLabel="Save and continue"
        onChanged={async () => {
          await refresh();
          navigate(returnPath(state), { replace: true });
        }}
      />
      <Box sx={{ display: "flex", justifyContent: "center", mt: 1.5 }}>
        <Button
          onClick={() => {
            logout();
            navigate("/login", { replace: true });
          }}
        >
          Sign out
        </Button>
      </Box>
    </SignInLayout>
  );
}
