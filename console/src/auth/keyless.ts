// SPDX-License-Identifier: MIT
/**
 * Keyless bots: a bot signs in with its CI's own OIDC identity (a GitHub
 * Actions or GitLab job's ID token) instead of a stored API token, so the
 * pipeline holds no Vennir secret at all.
 *
 * A team's maintainers give a bot identities (bot_identities): an issuer
 * the install allows (config.keyless.issuers) and the exact claims a token
 * must carry, one of them naming the repository or the subject, never a
 * pattern. ExchangeToken checks a token's signature with the issuer's
 * published keys, its issuer, audience (config.keyless.audience) and
 * expiry, then finds the one bot whose claims it carries, and gives back a
 * session for that bot: an ordinary console session, an hour long, that the
 * gateway accepts too. Two bots matching, or none, is a refusal.
 */
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { and, eq, sql } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { botIdentities, users } from "../db/schema.js";

/** The claims each issuer's tokens are identified by: an identity needs one of them. */
const IDENTIFYING: Record<string, string[]> = {
  "https://token.actions.githubusercontent.com": ["repository", "repository_id", "sub"],
  "https://gitlab.com": ["project_path", "project_id", "sub"],
};

/** Why these claims can't be a bot's identity at this issuer, or null. */
export function identityProblem(issuer: string, claims: Record<string, string>): string | null {
  if (config.keyless.noAudience) return "Keyless sign-in is off on this install: it needs keyless.audience, or the console's address, to check tokens against.";
  if (config.keyless.issuers.length === 0) return "Keyless sign-in is off on this install: keyless.issuers is empty.";
  if (!config.keyless.issuers.includes(issuer)) return `Bots may only sign in through ${config.keyless.issuers.join(", ")} (the install's keyless.issuers).`;
  const entries = Object.entries(claims);
  if (entries.length === 0 || entries.length > 8) return "Give 1 to 8 claims the token must carry.";
  for (const [name, value] of entries) {
    if (!/^[a-z_][a-z0-9_]{0,63}$/.test(name)) return `"${name}" isn't a claim name.`;
    if (typeof value !== "string" || value.length === 0 || value.length > 300) return `The claim ${name} needs a value.`;
    if (value.includes("*")) return `The claim ${name} must be exact: no patterns.`;
  }
  const identifying = IDENTIFYING[issuer] ?? ["sub"];
  if (!identifying.some((name) => name in claims)) return `Name one of ${identifying.join(", ")}: what the token is for.`;
  for (const forbidden of ["aud", "iss", "exp", "iat", "nbf"]) {
    if (forbidden in claims) return `${forbidden} is checked already: name what the token is for instead.`;
  }
  return null;
}

/** Each issuer's keys, from its discovery document, read once. */
const keysByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function keysOf(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const known = keysByIssuer.get(issuer);
  if (known) return known;
  const response = await fetch(new URL(".well-known/openid-configuration", issuer.replace(/\/?$/, "/")), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${issuer}'s discovery document: ${String(response.status)}`);
  const discovery = (await response.json()) as { issuer?: string; jwks_uri?: string };
  if (discovery.issuer !== issuer || !discovery.jwks_uri) throw new Error(`${issuer}'s discovery document doesn't name it, or its keys`);
  const keys = createRemoteJWKSet(new URL(discovery.jwks_uri));
  keysByIssuer.set(issuer, keys);
  return keys;
}

const refused = () => new ApiError(401, "KEYLESS_REFUSED", "That token doesn't sign in as any bot here.");

/**
 * The bot a CI's ID token signs in as, with what it carried; refused (401)
 * for a token that isn't valid, isn't for this install, or matches no bot
 * or more than one.
 */
export async function botForToken(idToken: string): Promise<{ botId: string; email: string; issuer: string; subject: string }> {
  let issuer: string;
  try {
    issuer = decodeJwt(idToken).iss ?? "";
  } catch {
    throw refused();
  }
  // Only an allowed issuer's keys are ever fetched.
  if (!config.keyless.issuers.includes(issuer)) throw refused();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, await keysOf(issuer), { issuer, audience: config.keyless.audience, requiredClaims: ["exp", "iat"] }));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw refused();
  }
  const identities = await db
    .select({ id: botIdentities.id, botId: botIdentities.botId, claims: botIdentities.claims, email: users.email, isBot: users.isBot })
    .from(botIdentities)
    .innerJoin(users, eq(users.id, botIdentities.botId))
    .where(eq(botIdentities.issuer, issuer));
  // A claim matches as text: GitHub's repository_id is a number in the token.
  const claim = (name: string) => {
    const v = payload[name];
    return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
  };
  const matching = identities.filter((i) => i.isBot && Object.entries(i.claims).every(([name, value]) => claim(name) === value));
  const bots = new Set(matching.map((m) => m.botId));
  const [match] = matching;
  if (!match || bots.size !== 1) throw refused();
  await db.update(botIdentities).set({ lastUsedAt: sql`now()` }).where(and(eq(botIdentities.id, match.id)));
  return { botId: match.botId, email: match.email, issuer, subject: payload.sub ?? "" };
}
