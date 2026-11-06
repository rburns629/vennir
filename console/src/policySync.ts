// SPDX-License-Identifier: MIT
/**
 * Keeps the cluster's copies of the console's lists from drifting: the
 * identity policy (products and team secrets, productPolicy.ts), the scan
 * policy (admitted digests, scanning.ts), the gateway token policy (each
 * API ServiceAccount's audiences, gatewayTokenPolicy.ts) and each team's copy of the pull
 * Secret (pullSecret.ts). Each is rewritten whenever its data changes; this
 * also rewrites them every few minutes, so a write that
 * failed, or a hand edit to a policy, is put right without waiting for the
 * next change. The last outcome of each is kept for admins (GET
 * /policy-sync) and a failure is logged at error level.
 */
import type { FastifyBaseLogger } from "fastify";
import { syncApiNamespaces } from "./core/teams.js";
import { syncGatewayTokenPolicy } from "./gatewayTokenPolicy.js";
import { syncIdentityPolicy } from "./productPolicy.js";
import { syncPullSecrets } from "./pullSecret.js";
import { syncScanPolicy } from "./scanning.js";
import { syncSchedulerLogsBindings } from "./schedulerLogs.js";
import { syncTeamNetworkPolicies } from "./teamNetwork.js";
import { syncTeamQuotas } from "./teamQuota.js";

export interface SyncOutcome {
  /** False: there's nothing to write to (not configured, or not installed). */
  applies: boolean;
  ok: boolean;
  at: string;
  error?: string;
  /** Since when it's been failing, pass after pass (notifier.ts tells admins). */
  failingSince?: string;
}

const outcomes = new Map<string, SyncOutcome>();
const SYNCS: Record<string, () => Promise<boolean>> = {
  identityPolicy: syncIdentityPolicy,
  scanPolicy: syncScanPolicy,
  gatewayTokenPolicy: syncGatewayTokenPolicy,
  pullSecrets: syncPullSecrets,
  apiNamespaces: syncApiNamespaces,
  teamNetworkPolicies: syncTeamNetworkPolicies,
  schedulerLogs: syncSchedulerLogsBindings,
  teamQuotas: syncTeamQuotas,
};

export function policySyncOutcomes(): Record<string, SyncOutcome | null> {
  return Object.fromEntries(Object.keys(SYNCS).map((name) => [name, outcomes.get(name) ?? null]));
}

export async function syncPolicies(log: FastifyBaseLogger): Promise<void> {
  for (const [name, sync] of Object.entries(SYNCS)) {
    const at = new Date().toISOString();
    try {
      outcomes.set(name, { applies: await sync(), ok: true, at });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failingSince = outcomes.get(name)?.failingSince ?? at;
      outcomes.set(name, { applies: true, ok: false, at, error: message, failingSince });
      log.error({ err: error, event: "policy_sync_failed", policy: name }, `couldn't sync the ${name}`);
    }
  }
}

/** Resyncs every `intervalMs` from now on, and once right away. */
export function startPolicySync(log: FastifyBaseLogger, intervalMs: number): void {
  void syncPolicies(log);
  setInterval(() => void syncPolicies(log), intervalMs).unref();
}
