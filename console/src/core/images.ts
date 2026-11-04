// SPDX-License-Identifier: MIT
/**
 * Where task images may come from (imagePolicy.ts) and their scan verdicts
 * (scanning.ts): the logic behind ImageService.
 *
 * The allowed sources are readable by anyone signed in, so the submit page
 * can say what's allowed, and editable by admins only: it's the list the
 * cluster enforces for every team. Scan verdicts are admins' to read,
 * accept (with a reason, the platform's counterpart of a product's
 * .trivyignore) and rescan.
 */
import { and, desc, eq } from "drizzle-orm";
import { Type } from "@sinclair/typebox";
import type { FastifyBaseLogger } from "fastify";
import { ApiError, forbiddenUnlessAdmin } from "../apiError.js";
import type { AuthUser } from "../auth/plugin.js";
import { db } from "../db/client.js";
import { findUserById } from "../db/queries.js";
import { auditLog, imageScans, users } from "../db/schema.js";
import {
  allowedPrefixes,
  invalidSourceReason,
  isBroadSource,
  normalizeSource,
  readImagePolicy,
  writeImagePolicy,
} from "../imagePolicy.js";
import { ImagePolicyConflictError } from "../k8s.js";
import { requestScan, syncScanPolicy } from "../scanning.js";
import { platformAlert } from "../notifier.js";

const REQUIRES_ADMIN = "Requires admin access.";

export const Digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
export const AcceptReason = Type.String({ minLength: 10, maxLength: 2000 });

/** Who last saved the image sources here, and when: the audit log's last SetImagePolicy that succeeded. */
export async function lastImagePolicySave(): Promise<{ by: string; at: Date } | null> {
  const [row] = await db
    .select({ email: users.email, at: auditLog.at })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(eq(auditLog.route, "vennir.console.v1.ImageService/SetImagePolicy"), eq(auditLog.status, 200)))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return row ? { by: row.email ?? "a deleted account", at: row.at } : null;
}

/** The allowed sources; for an admin, who last saved them and when (null otherwise, or never). */
export async function imagePolicy(caller?: AuthUser) {
  const policy = await readImagePolicy();
  const lastSaved = caller?.isAdmin ? await lastImagePolicySave() : null;
  return { ...policy, allowed: allowedPrefixes(policy), lastSaved };
}

/** Changes the allowed sources; `version` must be the one read (no lost updates). */
export async function setImagePolicy(
  caller: AuthUser | undefined,
  input: { source: string; additional: string[]; version: string },
  log: FastifyBaseLogger,
) {
  forbiddenUnlessAdmin(caller, "Only admins can change the allowed image sources.");
  const { source, additional, version } = input;
  const entries = [
    { label: "Source registry", value: source },
    ...additional.map((value, i) => ({ label: `Additional source ${String(i + 1)}`, value })),
  ];
  for (const { label, value } of entries) {
    const reason = invalidSourceReason(value);
    if (reason) throw new ApiError(400, "BAD_REQUEST", `${label} "${value}" ${reason}.`);
  }

  const before = await readImagePolicy();
  if (!before.exists) {
    throw new ApiError(
      409,
      "IMAGE_POLICY_MISSING",
      "The cluster's image policy doesn't exist. Installing or upgrading the execution-kernel release creates it.",
    );
  }
  const cleanAdditional = [...new Set(additional.map(normalizeSource))];
  let newVersion: string;
  try {
    newVersion = await writeImagePolicy(source, cleanAdditional, version);
  } catch (error) {
    if (error instanceof ImagePolicyConflictError) {
      throw new ApiError(
        409,
        "CONFLICT",
        "The image sources were changed by someone else since you loaded them. Reload and try again.",
      );
    }
    throw error;
  }
  const after = { source: normalizeSource(source), additional: cleanAdditional };
  log.warn(
    {
      event: "image_policy_changed",
      by: caller?.id,
      before: { source: before.source, additional: before.additional },
      after,
      broadSources: [after.source, ...after.additional].filter(isBroadSource),
    },
    "allowed image sources changed",
  );
  const listed = (p: { source: string; additional: string[] }) => [p.source, ...p.additional].filter(Boolean).join(", ") || "none";
  await platformAlert(
    `image-policy:${newVersion}`,
    "The allowed image sources changed",
    `Now: ${listed(after)}. Before: ${listed(before)}.`,
    caller?.id,
  );
  const policy = { ...after, exists: true, version: newVersion };
  // Saved by this admin, now: the audit entry is written once this returns.
  const by = caller ? ((await findUserById(caller.id))?.email ?? "") : "";
  return { ...policy, allowed: allowedPrefixes(policy), lastSaved: { by, at: new Date() } };
}

export async function listScans(caller: AuthUser | undefined) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  return db.select().from(imageScans).orderBy(desc(imageScans.lastUsedAt)).limit(500);
}

/**
 * Accepts a failed verdict, with a reason: the image may be registered and
 * run again, until a rescan finds something the admin didn't see.
 */
export async function acceptScan(
  caller: AuthUser | undefined,
  digest: string,
  reason: string,
  log: FastifyBaseLogger,
) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const [row] = await db
    .update(imageScans)
    .set({ acceptedAt: new Date(), acceptedBy: caller?.id ?? null, acceptedReason: reason })
    .where(eq(imageScans.digest, digest))
    .returning();
  if (!row) throw new ApiError(404, "NOT_FOUND", "No scan for that digest.");
  await syncScanPolicy();
  log.info(
    { event: "image_scan_accepted", digest: row.digest, image: row.image, by: caller?.id, reason },
    "image scan verdict accepted",
  );
  return row;
}

/** Scans an image again now; null when scanning is off. */
export async function rescan(caller: AuthUser | undefined, digest: string) {
  forbiddenUnlessAdmin(caller, REQUIRES_ADMIN);
  const [row] = await db.select().from(imageScans).where(eq(imageScans.digest, digest));
  if (!row) throw new ApiError(404, "NOT_FOUND", "No scan for that digest.");
  // Stale from now on, so a rescan that can't start yet is still due; started now if it can.
  await db.update(imageScans).set({ scannedAt: new Date(0) }).where(eq(imageScans.digest, row.digest));
  return requestScan(`${row.image.split("@")[0] ?? row.image}@${row.digest}`, { force: true });
}
