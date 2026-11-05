// SPDX-License-Identifier: MIT
/**
 * What a team's SecretStore file may hold, checked before the console
 * applies it (PUT /teams/:team/secret-store). A SecretStore decides which
 * vault, and which identity in it, a team's namespace can read, so the file
 * must not reach outside its own team. It may only hold:
 *
 *  - SecretStores (external-secrets.io), for this team's namespace (no
 *    ClusterSecretStore), whose references never name another namespace,
 *    and whose stored credential, if any, is the Secret eso-auth;
 *  - the ServiceAccounts ESO signs in as with a cloud identity: eso-gcp,
 *    eso-azure, eso-aws.
 *
 * And a store's cloud identity is the team's alone (cloudIdentities): two
 * teams' stores signing in as one Google service account, AWS role or Azure
 * identity could each read what the other's may (core/teams.ts holds it).
 *
 * The same rules as the catalog's own pull-request check (its
 * `./vennir catalog secret-stores check`): that one gives the author an early
 * answer; this one is the one that holds.
 */
import { SECRET_STORE_CREDENTIAL } from "./k8s.js";

export const ESO_SERVICE_ACCOUNTS = ["eso-gcp", "eso-azure", "eso-aws"];
const SECRET_STORE_APIS = ["external-secrets.io/v1", "external-secrets.io/v1beta1"];
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

export interface SecretStoreObject {
  kind: "SecretStore" | "ServiceAccount";
  apiVersion: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What a store's spec may name, wherever it names it: the one Secret the team
 * stored its credential in (eso-auth), any Secret selector included (a key
 * ending in secretRef, or any {name, key}: a bearer token, a client
 * certificate, a CA from a Secret), and only ESO's ServiceAccounts (a key
 * ending in serviceAccountRef, or serviceAccount). Nothing in another
 * namespace (namespace, remoteNamespace), and not the kubernetes provider,
 * which reads a cluster's Secrets. A CA from a ConfigMap names no Secret.
 */
function specProblems(node: unknown, path: string): string[] {
  if (Array.isArray(node)) return node.flatMap((value, index) => specProblems(value, `${path}[${String(index)}]`));
  if (!isRecord(node)) return [];
  const problems: string[] = [];
  const named = (value: unknown) => (isRecord(value) ? value["name"] : value);
  if (typeof node["name"] === "string" && typeof node["key"] === "string" && node["name"] !== SECRET_STORE_CREDENTIAL) {
    problems.push(`${path} must name the Secret "${SECRET_STORE_CREDENTIAL}" (the team's stored credential), not ${JSON.stringify(node["name"])}.`);
  }
  for (const [key, value] of Object.entries(node)) {
    const child = `${path}.${key}`;
    const lower = key.toLowerCase();
    // A CA from a ConfigMap names no Secret (only a caProvider says which).
    if (key === "caProvider" && isRecord(value) && value["type"] === "ConfigMap") {
      if ("namespace" in value) problems.push(`${child}.namespace points into another namespace; leave it out.`);
      continue;
    }
    if (key === "namespace" || lower === "remotenamespace") {
      problems.push(`${child} points into another namespace; leave it out.`);
    } else if (path === "spec.provider" && key === "kubernetes") {
      problems.push(`${child}: the kubernetes provider reads a cluster's Secrets; use the team's own vault.`);
    } else if (lower.endsWith("secretref") && !(isRecord(value) && typeof value["key"] === "string")) {
      if (named(value) !== SECRET_STORE_CREDENTIAL) {
        problems.push(`${child} must name the Secret "${SECRET_STORE_CREDENTIAL}" (the team's stored credential), not ${JSON.stringify(named(value))}.`);
      }
    } else if ((lower.endsWith("serviceaccountref") || key === "serviceAccount") && isRecord(value)) {
      if (typeof value["name"] !== "string" || !ESO_SERVICE_ACCOUNTS.includes(value["name"])) {
        problems.push(`${child} must name one of ESO's ServiceAccounts (${ESO_SERVICE_ACCOUNTS.join(", ")}), not ${JSON.stringify(value["name"])}.`);
      }
    }
    problems.push(...specProblems(value, child));
  }
  return problems;
}

function stringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

/** The file's objects when every one is allowed; otherwise every problem. */
export function checkSecretStoreObjects(
  team: string,
  documents: unknown[],
): { objects: SecretStoreObject[]; problems: [] } | { objects: []; problems: string[] } {
  const problems: string[] = [];
  const objects: SecretStoreObject[] = [];
  documents.forEach((doc, index) => {
    let where = `document ${String(index + 1)}`;
    if (!isRecord(doc)) {
      problems.push(`${where}: isn't a Kubernetes object.`);
      return;
    }
    const { kind, apiVersion } = doc;
    const metadata = isRecord(doc["metadata"]) ? doc["metadata"] : {};
    const name = metadata["name"];
    where = `${typeof kind === "string" ? kind : "?"} ${typeof name === "string" ? name : "?"} (${where})`;
    if (typeof name !== "string" || !NAME.test(name)) {
      problems.push(`${where}: metadata.name must be a Kubernetes name.`);
      return;
    }
    const namespace = metadata["namespace"];
    if (namespace !== undefined && namespace !== team) {
      problems.push(`${where}: namespace must be "${team}" (or left out), not ${JSON.stringify(namespace)}.`);
    }
    const annotations = metadata["annotations"];
    if (annotations !== undefined && !stringMap(annotations)) {
      problems.push(`${where}: metadata.annotations must map names to strings.`);
    }
    if (kind === "ServiceAccount" && apiVersion === "v1") {
      if (!ESO_SERVICE_ACCOUNTS.includes(name)) {
        problems.push(
          `${where}: the only ServiceAccounts allowed here are the ones ESO signs in as: ${ESO_SERVICE_ACCOUNTS.join(", ")}.`,
        );
      }
      objects.push({ kind, apiVersion, metadata: { name, ...(stringMap(annotations) ? { annotations } : {}) } });
    } else if (kind === "SecretStore" && typeof apiVersion === "string" && SECRET_STORE_APIS.includes(apiVersion)) {
      const spec = doc["spec"];
      for (const problem of specProblems(spec, "spec")) problems.push(`${where}: ${problem}`);
      objects.push({ kind, apiVersion, metadata: { name }, spec });
    } else {
      problems.push(
        `${where}: only SecretStore (${SECRET_STORE_APIS.join(" or ")}) and ServiceAccount (v1) are allowed here.`,
      );
    }
  });
  if (!objects.some((o) => o.kind === "SecretStore")) problems.push("No SecretStore in the file.");
  return problems.length > 0 ? { objects: [], problems } : { objects, problems: [] };
}

/** The annotations that bind an ESO ServiceAccount to a cloud identity. */
const IDENTITY_ANNOTATIONS: Record<string, string> = {
  "iam.gke.io/gcp-service-account": "gcp",
  "eks.amazonaws.com/role-arn": "aws",
  "azure.workload.identity/client-id": "azure",
};

/**
 * The cloud identities a team's stores sign in as: its ESO ServiceAccounts'
 * bindings, and the role or identity a store names itself (AWS's `role`,
 * which ESO assumes; Azure's `identityId`). As `<cloud>:<id>`, lowercased
 * (none of them tells case apart). A binding made only on the cloud's side
 * (EKS Pod Identity, a Workload Identity principal for the namespace) isn't
 * here: that one is the cloud administrator's to keep per team.
 */
export function cloudIdentities(objects: SecretStoreObject[]): string[] {
  const found = new Set<string>();
  for (const o of objects) {
    for (const [key, value] of Object.entries(o.metadata.annotations ?? {})) {
      const cloud = IDENTITY_ANNOTATIONS[key];
      if (cloud && value.trim()) found.add(`${cloud}:${value.trim().toLowerCase()}`);
    }
    const provider = isRecord(o.spec) && isRecord(o.spec["provider"]) ? o.spec["provider"] : {};
    const aws = isRecord(provider["aws"]) ? provider["aws"]["role"] : undefined;
    if (typeof aws === "string" && aws.trim()) found.add(`aws:${aws.trim().toLowerCase()}`);
    const azure = isRecord(provider["azurekv"]) ? provider["azurekv"]["identityId"] : undefined;
    if (typeof azure === "string" && azure.trim()) found.add(`azure:${azure.trim().toLowerCase()}`);
  }
  return [...found].sort();
}
