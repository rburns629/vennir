// SPDX-License-Identifier: MIT
/**
 * A stand-in OpenID provider for single sign-on tests: its own key,
 * discovery document and token endpoint, which checks the PKCE verifier and
 * the client's secret as a real one does; and a whole browser sign-in
 * against the console (auth/oidc.ts).
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const CLIENT_ID = "the-client";
export const CLIENT_SECRET = "the-secret";

export async function startProvider() {
  const pair = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  let claims: Record<string, unknown> = {};
  let challenge = "";
  let issuer = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === "/jwks") return json({ keys: [publicJwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("client_secret") !== CLIENT_SECRET || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== challenge) {
          return json({ error: "invalid_grant" }, 400);
        }
        void new SignJWT(claims)
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(issuer)
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(pair.privateKey)
          .then((idToken) => json({ id_token: idToken, token_type: "Bearer" }));
      });
      return;
    }
    res.writeHead(404).end();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  issuer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  /** A whole sign-in as a browser does it: the session, or /login's error code. */
  async function signIn(app: FastifyInstance, idClaims: Record<string, unknown>): Promise<{ token: string; error: string }> {
    const start = await app.inject({ method: "GET", url: "/api/auth/oidc/start?tab=0123456789abcdef0123456789abcdef" });
    const location = String(start.headers.location ?? "");
    if (location.startsWith("/login")) return { token: "", error: new URLSearchParams(location.split("#")[1]).get("error") ?? "" };
    const authorize = new URL(location);
    challenge = authorize.searchParams.get("code_challenge") ?? "";
    claims = { nonce: authorize.searchParams.get("nonce"), ...idClaims };
    const cookie = String(start.headers["set-cookie"]).split(";")[0] ?? "";
    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?state=${String(authorize.searchParams.get("state"))}&code=c`,
      headers: { cookie },
    });
    const fragment = new URLSearchParams(String(callback.headers.location ?? "").split("#")[1]);
    return { token: fragment.get("token") ?? "", error: fragment.get("error") ?? "" };
  }

  return { issuer, signIn, close: () => server.close() };
}
