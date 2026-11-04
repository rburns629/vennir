// SPDX-License-Identifier: MIT
/**
 * Values the console has to keep and use itself (a chat webhook's URL, the
 * single sign-on client's secret), sealed with AES-256-GCM under a key
 * derived from JWT_SECRET for each purpose, so a copy of the database alone
 * doesn't give them away. A JWT_SECRET changed since makes them unreadable:
 * unseal answers null, and they're entered again.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { config } from "./config.js";

const TAG_LENGTH = 16;
const key = (purpose: string) => Buffer.from(hkdfSync("sha256", config.jwtSecret, "vennir", purpose, 32));

export function seal(value: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv, { authTagLength: TAG_LENGTH });
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

/** The value, or null when it can't be read (JWT_SECRET changed since, or tampered with). */
export function unseal(stored: string, purpose: string): string | null {
  const [version, iv, tag, data] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !data) return null;
  const authTag = Buffer.from(tag, "base64");
  // The whole tag, always: a shorter one would be easier to forge.
  if (authTag.length !== TAG_LENGTH) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(purpose), Buffer.from(iv, "base64"), { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
