// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { returnState } from "./returnTo";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return null;
  // Signed in, the browser comes back here (./returnTo.ts).
  if (!user) return <Navigate to="/login" replace state={returnState(location)} />;
  // A password someone else set: the server refuses everything but changing
  // it, so that's the only screen offered.
  if (user.mustChangePassword) return <Navigate to="/choose-password" replace state={returnState(location)} />;

  return children;
}
