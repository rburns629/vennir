// SPDX-License-Identifier: MIT
/**
 * Keeps a default-deny NetworkPolicy in every team namespace (k8s.ts's
 * TEAM_NETWORK_POLICY), so one team's steps can't reach another team's
 * Pods, and, with the gateway on, one letting the gateway reach the Pods
 * the team labels as API backends (TEAM_GATEWAY_INGRESS), and, with
 * teamNamespaces.blockMetadata, one refusing the instance metadata server
 * (TEAM_NO_METADATA). The same ones go into each team's API backends'
 * namespace (k8s.ts apiNamespace), where its backends run apart from its
 * steps. (The team namespace keeps TEAM_GATEWAY_INGRESS for one release,
 * for backends not yet moved.) Written when a team is created or
 * un-retired, and again in every policy resync (policySync.ts), which puts
 * it into namespaces made before it existed and undoes any edit within one
 * interval. Only when the console manages team namespaces
 * (config.teamNamespaces); otherwise whoever makes them adds it.
 */
import { config } from "./config.js";
import { ownApiNamespaces } from "./core/apis.js";
import { listAllTeams } from "./db/queries.js";
import { writeTeamNetworkPolicy } from "./k8s.js";

function applies(): boolean {
  return config.teamNamespaces.manage && config.teamNamespaces.defaultDenyIngress;
}

/** Into the team's namespace, and its API backends' (`apis`), if it has one. */
async function write(team: string, apis: string | undefined): Promise<void> {
  const { gatewayIngress, blockMetadata } = config.teamNamespaces;
  await writeTeamNetworkPolicy(team, gatewayIngress, blockMetadata);
  if (apis) await writeTeamNetworkPolicy(apis, gatewayIngress, blockMetadata);
}

/** Writes it into one team's namespace, and its API backends' (`apis`, when
 * it has one), when the console keeps them. */
export async function ensureTeamNetworkPolicy(team: string, apis: string | null): Promise<void> {
  if (applies()) await write(team, apis ?? undefined);
}

/** Writes it into every team's namespaces that exist. Returns whether it
 * applies; throws (after trying every team) if any write failed. */
export async function syncTeamNetworkPolicies(): Promise<boolean> {
  if (!applies()) return false;
  const failed: string[] = [];
  const all = await listAllTeams();
  const apis = await ownApiNamespaces(all.map((t) => t.name));
  for (const team of all) {
    try {
      await write(team.name, apis.get(team.name));
    } catch {
      failed.push(team.name);
    }
  }
  if (failed.length > 0) throw new Error(`Couldn't write the network policy into: ${failed.join(", ")}.`);
  return true;
}
