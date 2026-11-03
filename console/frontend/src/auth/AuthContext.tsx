// SPDX-License-Identifier: MIT
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, errorMessage, getMe, login as apiLogin, signOut as apiSignOut, SESSION_EXPIRED_EVENT, type Me } from "../api";
import { cart } from "../cart";
import { forgetBrowserDrafts } from "../pages/useComposeDrafts";

/** Why the first check hasn't settled: the console can't answer yet (asked
 * again, with backoff), or it answered something other than who's signed in. */
export interface SessionTrouble {
  retrying: boolean;
  message: string;
}

interface AuthState {
  user: Me | null;
  /** Undefined until the initial /me check (using any token already in
   * localStorage) has resolved -- lets consumers avoid a login-page flash
   * for a user who's actually already got a valid session. */
  loading: boolean;
  /** While loading: why the first check hasn't settled yet, if it failed. */
  trouble: SessionTrouble | null;
  /** Asks the first check again now, instead of waiting for the next try. */
  retryNow: () => void;
  /** True when the user was signed out because their session expired or
   * was revoked, not because they clicked "Sign out" -- so the login page
   * can say why they're there. Cleared by the next successful login. */
  sessionExpired: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  /** Swap in a freshly issued token, e.g. the one returned by a password
   * change (which revokes the token that made the request). */
  adoptToken: (token: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** What this browser keeps for the person signed in (the cart, drafts from
 * before the console kept them): forgotten when their session ends, so the
 * next person to sign in here doesn't get it. */
function forgetKept(): void {
  cart.forget();
  forgetBrowserDrafts();
}

/** A failure the console may get over by itself (restarting, the network),
 * not an answer about the session. Not 501: a console that doesn't have the
 * method won't grow it by being asked again. */
const passing = (error: unknown) => !(error instanceof ApiError) || (error.status >= 500 && error.status !== 501) || error.status === 429;

const UNREACHABLE = "Can't reach the console. Trying again…";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [trouble, setTrouble] = useState<SessionTrouble | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  // The first check while it's unsettled: the next try, and how to ask now.
  const first = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; wait: number; check: (() => void) | null }>({ timer: undefined, wait: 1000, check: null });

  async function loadMe(): Promise<void> {
    if (!localStorage.getItem("token")) {
      setUser(null);
      return;
    }
    try {
      setUser(await getMe());
    } catch (error) {
      // An expired/invalid token is not an error worth surfacing here --
      // it just means there's no session, same as never having logged in.
      if (error instanceof ApiError && error.status === 401) {
        localStorage.removeItem("token");
        forgetKept();
        setUser(null);
        return;
      }
      throw error;
    }
  }

  /** The first check is over (it answered, or a sign-in did): no more tries. */
  function settle(): void {
    clearTimeout(first.current.timer);
    first.current.check = null;
    setTrouble(null);
    setLoading(false);
  }

  async function refresh(): Promise<void> {
    await loadMe();
    settle();
  }

  // The first check, asked again while the console can't answer (a rolling
  // restart, the network): still loading, not signed out, since the token
  // may well be good, and saying so. Any other answer but who's signed in
  // is shown as it is, to try again by hand.
  useEffect(() => {
    let stopped = false;
    function check(): void {
      loadMe().then(
        () => {
          if (!stopped && first.current.check === check) settle();
        },
        (error: unknown) => {
          if (stopped || first.current.check !== check) return;
          if (!passing(error)) {
            setTrouble({ retrying: false, message: errorMessage(error, "The console couldn't say who's signed in.") });
            return;
          }
          setTrouble({ retrying: true, message: UNREACHABLE });
          const wait = first.current.wait;
          first.current.wait = Math.min(wait * 2, 30_000);
          // (One try waiting at a time, though Retry now may have asked meanwhile.)
          clearTimeout(first.current.timer);
          first.current.timer = setTimeout(check, wait);
        },
      );
    }
    first.current.check = check;
    check();
    return () => {
      stopped = true;
      clearTimeout(first.current.timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on mount only
  }, []);

  function retryNow(): void {
    const check = first.current.check;
    if (!check) return;
    clearTimeout(first.current.timer);
    first.current.wait = 1000;
    check();
  }

  // api.ts has already dropped the token by the time this fires; clearing
  // `user` is what makes ProtectedRoute send the browser to /login.
  useEffect(() => {
    function onSessionExpired(): void {
      forgetKept();
      setSessionExpired(true);
      setUser(null);
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    };
  }, []);

  async function login(email: string, password: string): Promise<void> {
    const token = await apiLogin(email, password);
    localStorage.setItem("token", token);
    setSessionExpired(false);
    await refresh();
  }

  function logout(): void {
    // Ended on the server first, while the token is still sent; signed out
    // here whatever it answers (a session already gone is still gone).
    void apiSignOut()
      .catch(() => undefined)
      .finally(() => {
        localStorage.removeItem("token");
      });
    forgetKept();
    setSessionExpired(false);
    setUser(null);
  }

  function adoptToken(token: string): void {
    localStorage.setItem("token", token);
  }

  return (
    <AuthContext.Provider value={{ user, loading, trouble, retryNow, sessionExpired, login, logout, refresh, adoptToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}
