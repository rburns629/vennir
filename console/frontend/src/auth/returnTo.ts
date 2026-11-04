// SPDX-License-Identifier: MIT
/**
 * Where to go once signed in: the page that sent the browser to sign in
 * (a run's link in Slack, a bookmark), kept in the redirect's state, or
 * across single sign-on's round trip in this tab's sessionStorage. Only
 * one of this console's own pages is taken; anything else is Home.
 */
const SSO_RETURN_KEY = "vennir_sso_return";

/** A path of this console's (not another site's, not the sign-in pages), or Home. */
function ownPath(path: unknown): string {
  // Taken as the browser would take it (which drops tabs and newlines, and
  // reads \ as /), so "/\t/elsewhere" can't pass for one of ours.
  if (typeof path !== "string" || !path.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(path, window.location.origin);
  } catch {
    return "/";
  }
  if (url.origin !== window.location.origin) return "/";
  if (/^\/(login|choose-password)(?=\/|$)/.test(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The redirect state of a page that needs a session: where it was. */
export const returnState = (location: { pathname: string; search: string; hash: string }) => ({ from: `${location.pathname}${location.search}${location.hash}` });

/** Where a redirect's state says to go back to. */
export function returnPath(state: unknown): string {
  return ownPath(typeof state === "object" && state !== null ? (state as { from?: unknown }).from : undefined);
}

/** Keeps where to go back to across single sign-on, which leaves the page. */
export function keepForSso(path: string): void {
  try {
    sessionStorage.setItem(SSO_RETURN_KEY, path);
  } catch {
    // Storage blocked: back from single sign-on lands on Home.
  }
}

/** Where to go back to after single sign-on; used once. */
export function takeAfterSso(): string {
  try {
    const path = sessionStorage.getItem(SSO_RETURN_KEY);
    sessionStorage.removeItem(SSO_RETURN_KEY);
    return ownPath(path);
  } catch {
    return "/";
  }
}
