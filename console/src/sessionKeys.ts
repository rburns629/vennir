// SPDX-License-Identifier: MIT
/**
 * The key sessions are signed with: Ed25519, derived from JWT_SECRET (so it
 * changes with it, as the sealing keys do, and every copy of the console
 * agrees on it), and its public half, published as a JWKS
 * (GET /api/auth/jwks). The gateway verifies sessions with the public key
 * alone, so it can check one but never make one.
 */
import { createHash, createPrivateKey, createPublicKey, hkdfSync, type KeyObject } from "node:crypto";
import { config } from "./config.js";

/** PKCS#8's wrapping of a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function derive(secret: string): { privateKey: KeyObject; publicKey: KeyObject } {
  const seed = Buffer.from(hkdfSync("sha256", secret, "vennir", "session signing", 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

const { privateKey, publicKey } = derive(config.jwtSecret);
const jwk = publicKey.export({ format: "jwk" });

/** Names the key in each session's header, so a verifier picks the right one. */
export const sessionKeyId = createHash("sha256").update(jwk.x ?? "").digest("hex").slice(0, 16);

export const sessionKeys = {
  private: privateKey.export({ format: "pem", type: "pkcs8" }),
  public: publicKey.export({ format: "pem", type: "spki" }),
};

/** The public key as a JSON Web Key Set. */
export function sessionJwks(): { keys: Record<string, string>[] } {
  return { keys: [{ kty: "OKP", crv: "Ed25519", x: jwk.x ?? "", kid: sessionKeyId, alg: "EdDSA", use: "sig" }] };
}
