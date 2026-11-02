// SPDX-License-Identifier: MIT
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getEnvironment, type Environment } from "./api";

const EnvironmentContext = createContext<Environment | null>(null);

/**
 * This install's public settings (its label, whether registration is open,
 * single sign-on's provider, the cloud it's on), fetched once for the whole
 * app: the sidebar, the sign-in screens and the sign-in form use them, and
 * the catalog's pages say with the cloud why a product for others isn't run.
 */
export function EnvironmentProvider({ children }: { children: ReactNode }) {
  const [environment, setEnvironment] = useState<Environment | null>(null);
  useEffect(() => {
    getEnvironment()
      .then(setEnvironment)
      // Everything that uses it is cosmetic, or falls back to passwords.
      .catch(() => undefined);
  }, []);
  return <EnvironmentContext.Provider value={environment}>{children}</EnvironmentContext.Provider>;
}

/** Null until it arrives, or if it couldn't be fetched. */
export function useEnvironment(): Environment | null {
  return useContext(EnvironmentContext);
}
