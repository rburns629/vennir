// SPDX-License-Identifier: MIT
/**
 * Kubernetes RBAC/Secret provisioning — the one thing this service does
 * that actually needs real, careful correctness: every write here is
 * security-sensitive.
 *
 * A team's secrets are its own Secrets in its namespace; which step may
 * mount which is the kernel chart's identity policy, not RBAC (the console
 * creates none: docs/security-model.md).
 *
 * Every operation here is idempotent (read, then create-or-patch) since
 * this endpoint is the same path used for both first registration and
 * later rotation.
 */
import * as k8s from "@kubernetes/client-node";

// Constructed lazily, on first actual use inside a request handler --
// never at module load. A cluster config that's missing or invalid must
// never crash the whole process (which would take /health/live down with
// it) the way it did during development here: constructing this eagerly
// at import time meant deleting the local kind cluster mid-session made
// the *entire server* unable to start, for an endpoint that has nothing
// to do with Kubernetes. Same principle as kernel-api's
// /health/live never touching the database -- a dependency being down
// shouldn't take down things that don't need it.
let apis:
  | {
      core: k8s.CoreV1Api;
      apps: k8s.AppsV1Api;
      batch: k8s.BatchV1Api;
      rbac: k8s.RbacAuthorizationV1Api;
      custom: k8s.CustomObjectsApi;
      admission: k8s.AdmissionregistrationV1Api;
      networking: k8s.NetworkingV1Api;
    }
  | undefined;

function getApis(): {
  core: k8s.CoreV1Api;
  apps: k8s.AppsV1Api;
  batch: k8s.BatchV1Api;
  rbac: k8s.RbacAuthorizationV1Api;
  custom: k8s.CustomObjectsApi;
  admission: k8s.AdmissionregistrationV1Api;
  networking: k8s.NetworkingV1Api;
} {
  if (apis) return apis;

  const kubeConfig = new k8s.KubeConfig();
  // In-cluster config in a Pod, the local kubeconfig otherwise (kind), as
  // the kernel's load_kube_config does. Decided by the variable Kubernetes
  // sets in every Pod, not by catching an error: client-node's
  // loadFromCluster() doesn't throw outside a cluster, it "succeeds" with
  // the server URL "https://undefined:undefined" (seen in v1.0.0).
  if (process.env["KUBERNETES_SERVICE_HOST"]) {
    kubeConfig.loadFromCluster();
  } else {
    kubeConfig.loadFromDefault();
  }

  apis = {
    core: kubeConfig.makeApiClient(k8s.CoreV1Api),
    // The image scanner's scale (idling it), in the platform's own namespace.
    apps: kubeConfig.makeApiClient(k8s.AppsV1Api),
    // Image scan Jobs (scanning.ts), in the platform's own namespace.
    batch: kubeConfig.makeApiClient(k8s.BatchV1Api),
    rbac: kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api),
    // External Secrets Operator's CRDs (SecretStore, ExternalSecret) have
    // no typed client in @kubernetes/client-node -- CustomObjectsApi talks
    // to any CRD generically via its group/version/plural, the same way
    // `kubectl get externalsecrets` does under the hood.
    custom: kubeConfig.makeApiClient(k8s.CustomObjectsApi),
    // The kernel's image and identity policies (their lists, by name).
    admission: kubeConfig.makeApiClient(k8s.AdmissionregistrationV1Api),
    // Each team namespace's default-deny NetworkPolicy (teamNetwork.ts).
    networking: kubeConfig.makeApiClient(k8s.NetworkingV1Api),
  };
  return apis;
}

const ESO_GROUP = "external-secrets.io";
const ESO_VERSION = "v1";

/**
 * On everything the console creates in a team namespace, so it can tell its
 * own objects from anyone else's: it replaces an existing Secret only when
 * it carries this (or the team already has a grant for it, from before the
 * label existed), and finds its own RoleBindings by it.
 */
const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_BY = "vertra-console";
const MANAGED_LABELS = { [MANAGED_BY_LABEL]: MANAGED_BY };

function isManaged(metadata: k8s.V1ObjectMeta | undefined): boolean {
  return metadata?.labels?.[MANAGED_BY_LABEL] === MANAGED_BY;
}

export interface SecretGrant {
  namespace: string;
  secretName: string;
  /** Plain string values, keyed by filename — base64-encoded by the client, never by us. */
  data: Record<string, string>;
  /** The team already has a grant for this secret, so the console created it
   * (possibly before its Secrets were labelled) and may replace it. */
  alreadyGranted: boolean;
}

/** A caller mistake, not a server failure — distinguished so routes can
 * respond with a 4xx instead of Fastify's default 500 for anything thrown. */
export class NamespaceNotFoundError extends Error {}

/** External Secrets Operator doesn't serve the kind: a create of one
 * answers 404 when the namespace exists. Not installed, mostly; or a file
 * names an apiVersion the installed one no longer serves. */
export class ExternalSecretsMissingError extends Error {
  constructor(apiVersion: string) {
    super(
      `External Secrets Operator isn't installed on this cluster, or doesn't serve ${apiVersion}, so this can't be made. ` +
        "With vertra: `vertra config set -e <env> externalSecrets true`, then `vertra apply <env>`; " +
        "if it's installed, the file's apiVersion is one it doesn't serve (external-secrets.io/v1 is current).",
    );
  }
}

/** Creates one of ESO's objects; a 404 means ESO doesn't serve its kind. */
async function createEsoObject(request: k8s.CustomObjectsApiCreateNamespacedCustomObjectRequest): Promise<void> {
  try {
    await getApis().custom.createNamespacedCustomObject(request);
  } catch (error) {
    if (isNotFound(error)) throw new ExternalSecretsMissingError(`${request.group}/${request.version}`);
    throw error;
  }
}

/** A Secret of that name exists in the namespace but isn't the team's
 * registered secret (a SecretStore's credentials, something applied by
 * hand): it won't be overwritten, or registered for tasks to mount. */
export class SecretNotManagedError extends Error {}

/** The Role the console used to create per secret, granting one
 * ServiceAccount API read of it. No longer created: a mount never consults
 * RBAC, and who may mount what is the identity policy's job. */
function legacyRoleNameFor(secretName: string): string {
  return `read-secret-${secretName}`;
}

async function ensureNamespaceExists(namespace: string): Promise<void> {
  const { core } = getApis();
  try {
    await core.readNamespace({ name: namespace });
  } catch (error) {
    if (isNotFound(error)) {
      throw new NamespaceNotFoundError(
        `Namespace "${namespace}" does not exist. This service provisions ` +
          `Secrets and ServiceAccounts within an existing namespace; it does not create ` +
          `namespaces — that's a cluster-provisioning concern (Helm), not a ` +
          `runtime one.`,
      );
    }
    throw error;
  }
}

/**
 * Creates a product's ServiceAccount in a team namespace if it isn't there.
 * Never modifies one that is: binding it to a cloud identity (an
 * iam.gke.io/gcp-service-account or eks.amazonaws.com/role-arn annotation)
 * is the platform team's, and must survive every registration. No RBAC: a
 * step needs none to read its mounted secrets.
 */
export async function ensureServiceAccount(namespace: string, name: string): Promise<void> {
  const { core } = getApis();
  await ensureNamespaceExists(namespace);
  try {
    await core.readNamespacedServiceAccount({ name, namespace });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    try {
      await core.createNamespacedServiceAccount({
        namespace,
        body: { metadata: { name, namespace, labels: MANAGED_LABELS } },
      });
    } catch (createError) {
      // Created by a concurrent request in between: that's the outcome wanted.
      const exists = typeof createError === "object" && createError !== null && "code" in createError && createError.code === 409;
      if (!exists) throw createError;
    }
  }
}

/*
 * The console never reads a Secret (its role has no `get` on them), so a
 * compromised console can't read a team's secrets through the API. Whether a
 * Secret is the console's to replace comes from its own records instead: a
 * secret the team registered (`alreadyGranted`). Writing creates it; only a
 * registered one is ever replaced, unconditionally (an update without a
 * resourceVersion), so nothing is read first.
 */

function isConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 409;
}

/** Creates the Secret; if one of that name exists, replaces it when the
 * caller may (it's registered), and refuses otherwise. */
async function createOrReplaceSecret(namespace: string, body: k8s.V1Secret, mayReplace: boolean): Promise<void> {
  const { core } = getApis();
  const name = body.metadata?.name ?? "";
  try {
    await core.createNamespacedSecret({ namespace, body });
  } catch (error) {
    if (!isConflict(error)) throw error;
    if (!mayReplace) throw notManaged(namespace, name);
    await core.replaceNamespacedSecret({ name, namespace, body });
  }
}

/** Whether a Secret of this name exists, without reading it: a dry-run create. */
async function secretExists(namespace: string, name: string): Promise<boolean> {
  const { core } = getApis();
  try {
    await core.createNamespacedSecret({ namespace, body: { metadata: { name, namespace } }, dryRun: "All" });
    return false;
  } catch (error) {
    if (isConflict(error)) return true;
    throw error;
  }
}

function notManaged(namespace: string, name: string): SecretNotManagedError {
  return new SecretNotManagedError(
    `A Secret named "${name}" already exists in "${namespace}" and wasn't created by the console, ` +
      "so it can't be replaced or granted here. Choose another name.",
  );
}

/**
 * Deletes the Role the console used to create for a secret, and every
 * binding of it (see legacyRoleNameFor). Run whenever a secret is written or
 * revoked, and for every registered secret at startup, so installs from
 * before secrets were per team lose those grants.
 */
export async function deleteLegacySecretRole(namespace: string, secretName: string): Promise<void> {
  const { rbac } = getApis();
  const roleName = legacyRoleNameFor(secretName);
  try {
    await deleteRoleBindings(namespace, roleName);
    await rbac.deleteNamespacedRole({ name: roleName, namespace });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** Every binding of `roleName` the console made. Bindings made before the
 * console labelled its objects are found by the name the console gave them. */
async function deleteRoleBindings(namespace: string, roleName: string): Promise<void> {
  const { rbac } = getApis();
  const bindings = await rbac.listNamespacedRoleBinding({ namespace });
  for (const binding of bindings.items) {
    const name = binding.metadata?.name;
    const ours = isManaged(binding.metadata) || name?.startsWith(`${roleName}-to-`);
    if (!name || binding.roleRef.name !== roleName || !ours) continue;
    try {
      await rbac.deleteNamespacedRoleBinding({ name, namespace });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 404;
}

export async function upsertSecretGrant(grant: SecretGrant): Promise<void> {
  await ensureNamespaceExists(grant.namespace);
  const { namespace, secretName: name } = grant;
  // client-node base64-encodes stringData for us on the wire.
  const body = { metadata: { name, namespace, labels: MANAGED_LABELS }, stringData: grant.data, type: "Opaque" };
  await createOrReplaceSecret(namespace, body, grant.alreadyGranted);
  await deleteLegacySecretRole(namespace, name);
}

/**
 * Removes a registered secret from the cluster, as the console created it:
 * a synced one's ExternalSecret (which takes its Secret with it), or a
 * pasted one's Secret. Any legacy Role for it too.
 */
export async function deleteSecretGrant(
  namespace: string,
  secretName: string,
  source: "literal" | "external",
): Promise<void> {
  const { core, custom } = getApis();
  await deleteLegacySecretRole(namespace, secretName);
  const ignoreNotFound = (error: unknown) => {
    if (!isNotFound(error)) throw error;
  };
  if (source === "external") {
    await custom
      .deleteNamespacedCustomObject({ group: ESO_GROUP, version: ESO_VERSION, namespace, plural: "externalsecrets", name: secretName })
      .catch(ignoreNotFound);
  } else {
    await core.deleteNamespacedSecret({ name: secretName, namespace }).catch(ignoreNotFound);
  }
}

/**
 * Syncing from a vault (docs/security-model.md): instead of a literal
 * value, a team names a key already available through one of its
 * namespace's `SecretStore`s (scope grants this function never creates:
 * they come from the catalog's reviewed SecretStore files, applied by
 * applySecretStoreObjects). This function only ever creates the
 * `ExternalSecret` *reference* -- no secret value is ever read, held, or
 * transmitted by this process; External Secrets Operator's own
 * controller does the actual fetch, directly against the backing store.
 */
export interface ExternalSecretGrant {
  namespace: string;
  secretName: string;
  secretStoreName: string;
  /** As SecretGrant's. */
  alreadyGranted: boolean;
  /** Local key name (what a mounted task sees) -> remote key/path in the
   * external store, and optionally one field of it (ESO's `property`: a
   * field of a 1Password item, a key inside a JSON-valued secret). */
  keys: { secretKey: string; remoteKey: string; property?: string }[];
}

async function upsertExternalSecret(grant: ExternalSecretGrant): Promise<void> {
  const { custom } = getApis();
  const plural = "externalsecrets";
  const body = {
    apiVersion: `${ESO_GROUP}/${ESO_VERSION}`,
    kind: "ExternalSecret",
    metadata: { name: grant.secretName, namespace: grant.namespace, labels: MANAGED_LABELS },
    spec: {
      secretStoreRef: { name: grant.secretStoreName, kind: "SecretStore" },
      target: { name: grant.secretName, template: { metadata: { labels: MANAGED_LABELS } } },
      data: grant.keys.map(({ secretKey, remoteKey, property }) => ({
        secretKey,
        remoteRef: property ? { key: remoteKey, property } : { key: remoteKey },
      })),
    },
  };
  try {
    await custom.getNamespacedCustomObject({
      group: ESO_GROUP,
      version: ESO_VERSION,
      namespace: grant.namespace,
      plural,
      name: grant.secretName,
    });
    await custom.replaceNamespacedCustomObject({
      group: ESO_GROUP,
      version: ESO_VERSION,
      namespace: grant.namespace,
      plural,
      name: grant.secretName,
      body,
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await createEsoObject({
      group: ESO_GROUP,
      version: ESO_VERSION,
      namespace: grant.namespace,
      plural,
      body,
    });
  }
}

async function externalSecretExists(namespace: string, name: string): Promise<boolean> {
  const { custom } = getApis();
  try {
    await custom.getNamespacedCustomObject({ group: ESO_GROUP, version: ESO_VERSION, namespace, plural: "externalsecrets", name });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function upsertExternalSecretGrant(grant: ExternalSecretGrant): Promise<void> {
  await ensureNamespaceExists(grant.namespace);
  // An existing Secret of that name may be registered only when it's
  // already the team's, or an ExternalSecret of that name syncs it (ESO's,
  // made by the console or elsewhere); anything else is someone else's.
  if (!grant.alreadyGranted && (await secretExists(grant.namespace, grant.secretName))) {
    if (!(await externalSecretExists(grant.namespace, grant.secretName))) {
      throw notManaged(grant.namespace, grant.secretName);
    }
  }
  // ESO's controller, not this process, creates the Secret asynchronously
  // once the ExternalSecret reconciles.
  await upsertExternalSecret(grant);
  await deleteLegacySecretRole(grant.namespace, grant.secretName);
}

/** A namespace a team may never have: kube-*, the platform's own, or one
 * the operator protected. */
export class ProtectedNamespaceError extends Error {}

/** A namespace of that name exists and isn't a team's (no team label, not
 * created by the console): it isn't adopted. */
export class NamespaceNotTeamsError extends Error {}

export type TeamNamespaceState = "true" | "retired";

function refuseProtected(name: string, protectedNamespaces: string[]): void {
  if (name.startsWith("kube-") || protectedNamespaces.includes(name)) {
    throw new ProtectedNamespaceError(`"${name}" is a protected namespace; no team can use it.`);
  }
}

async function readNamespace(name: string): Promise<k8s.V1Namespace | undefined> {
  const { core } = getApis();
  try {
    return await core.readNamespace({ name });
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Gives a team its namespace, labelled `<label>=<state>`: creates it if
 * missing, otherwise sets that one label. An existing namespace is only
 * relabelled if it's already a team's (it has the label, or the console
 * created it), never adopted. The console chart's namespace policy enforces
 * the same limits in the cluster. Returns false when there's no namespace
 * to relabel and `createIfMissing` is false (retiring a team that never
 * had one).
 */
export async function setTeamNamespace(
  name: string,
  state: TeamNamespaceState,
  options: { label: string; protected: string[]; createIfMissing: boolean; podSecurity?: string },
): Promise<boolean> {
  const { core } = getApis();
  refuseProtected(name, options.protected);
  const existing = await readNamespace(name);
  if (!existing) {
    if (!options.createIfMissing) return false;
    try {
      // A new namespace enforces Pod Security too, so nothing running there
      // can be less restricted than the kernel's own step Pods.
      const podSecurity = options.podSecurity ? { "pod-security.kubernetes.io/enforce": options.podSecurity } : {};
      await core.createNamespace({
        body: { metadata: { name, labels: { ...MANAGED_LABELS, ...podSecurity, [options.label]: state } } },
      });
      return true;
    } catch (error) {
      // Created in between by a concurrent call: relabel it below.
      const exists = typeof error === "object" && error !== null && "code" in error && error.code === 409;
      if (!exists) throw error;
      return setTeamNamespace(name, state, options);
    }
  }
  const labels = existing.metadata?.labels ?? {};
  if (!(options.label in labels) && !isManaged(existing.metadata)) {
    throw new NamespaceNotTeamsError(
      `A namespace named "${name}" already exists and isn't a team's. Rename the team, or label the namespace ` +
        `${options.label}=true yourself to hand it over.`,
    );
  }
  if (labels[options.label] === state) return true;
  existing.metadata ??= {};
  existing.metadata.labels = { ...labels, [options.label]: state };
  await core.replaceNamespace({ name, body: existing });
  return true;
}

/**
 * Deletes a purged team's namespace and everything in it. The kernel
 * chart's purge policy lets the console delete only a namespace labelled
 * retired that isn't protected. Doesn't wait for the deletion to finish.
 */
export async function deleteTeamNamespace(name: string, protectedNamespaces: string[]): Promise<void> {
  const { core } = getApis();
  refuseProtected(name, protectedNamespaces);
  try {
    await core.deleteNamespace({ name });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** The platform's registry pull Secret, as copied into every team namespace
 * (pullSecret.ts) and named by every step Pod (the kernel's
 * task_image_pull_secret). Never registered as a team secret, so never
 * mountable: only the kubelet uses it. */
export const TEAM_PULL_SECRET = "vertra-pull";

/** Writes the pull Secret into a team namespace, replacing the copy there.
 * Returns false when the namespace doesn't exist (yet). */
export async function writeTeamPullSecret(namespace: string, dockerConfigJson: string): Promise<boolean> {
  const body = {
    metadata: { name: TEAM_PULL_SECRET, namespace, labels: MANAGED_LABELS },
    stringData: { ".dockerconfigjson": dockerConfigJson },
    type: "kubernetes.io/dockerconfigjson",
  };
  try {
    // A reserved name: always the console's to write.
    await createOrReplaceSecret(namespace, body, true);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * Writes the federated registry token's Docker config into the platform's
 * namespace (registryFederation.ts), for the verify and scan Jobs to sign in
 * with. The write fence lets the console write this one Secret there, and
 * nothing else.
 */
export async function writeRegistryTokenSecret(namespace: string, name: string, dockerConfigJson: string): Promise<void> {
  await createOrReplaceSecret(
    namespace,
    {
      metadata: { name, namespace, labels: MANAGED_LABELS },
      stringData: { ".dockerconfigjson": dockerConfigJson },
      type: "kubernetes.io/dockerconfigjson",
    },
    true,
  );
}

/** The NetworkPolicy every team namespace holds (teamNetwork.ts). The
 * console's write fence accepts no other name but TEAM_GATEWAY_INGRESS,
 * and only these shapes. */
export const TEAM_NETWORK_POLICY = "vertra-default-deny";

/** With the gateway on, a second one: the gateway's Pods may reach the Pods
 * a team labels as API backends (API_BACKEND_LABEL: "true"), and nothing
 * else of the team's. */
export const TEAM_GATEWAY_INGRESS = "vertra-gateway-ingress";

/** With teamNamespaces.blockMetadata (EKS), a third: no Pod in the namespace
 * may connect to the cloud's instance metadata server, so a step can't take
 * the node's credentials; everything else outward stays open. */
export const TEAM_NO_METADATA = "vertra-no-metadata";

/** The instance metadata server's address (EC2's). IPv4 only: the AWS VPC
 * CNI's policy agent on an IPv4 cluster can't hold an IPv6 block, and on
 * failing to it enforced none of the namespace's policies (proven on
 * standard-mode EKS, 2026-10-29); vertra's clusters are IPv4. */
const METADATA_ADDRESS = "169.254.169.254/32";

export function noMetadataPolicy(namespace: string): k8s.V1NetworkPolicy {
  return {
    metadata: { name: TEAM_NO_METADATA, namespace, labels: MANAGED_LABELS },
    spec: {
      podSelector: {},
      policyTypes: ["Egress"],
      egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: [METADATA_ADDRESS] } }] }],
    },
  };
}
export const API_BACKEND_LABEL = "vertra/api-backend";

/** The gateway-ingress policy for a team namespace. */
export interface GatewayPods {
  namespace: string;
  labels: Record<string, string>;
}

export function gatewayIngressPolicy(namespace: string, gateway: GatewayPods): k8s.V1NetworkPolicy {
  return {
    metadata: { name: TEAM_GATEWAY_INGRESS, namespace, labels: MANAGED_LABELS },
    spec: {
      podSelector: { matchLabels: { [API_BACKEND_LABEL]: "true" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          _from: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": gateway.namespace } },
              podSelector: { matchLabels: gateway.labels },
            },
          ],
        },
      ],
    },
  };
}

/**
 * Writes a team namespace's default-deny NetworkPolicy, replacing the copy
 * there: every Pod in it accepts connections only from Pods in the same
 * namespace, so another team's steps can't reach it. Outgoing traffic is
 * left alone (steps call their clouds); the platform's own Pods refuse
 * steps with policies of their own. With `gateway`, also
 * TEAM_GATEWAY_INGRESS; with `blockMetadata`, also TEAM_NO_METADATA.
 * Returns false when the namespace doesn't exist (yet).
 */
export async function writeTeamNetworkPolicy(namespace: string, gateway: GatewayPods | null, blockMetadata: boolean): Promise<boolean> {
  const body: k8s.V1NetworkPolicy = {
    metadata: { name: TEAM_NETWORK_POLICY, namespace, labels: MANAGED_LABELS },
    // The client's model calls `from` `_from`, and sends it as `from`.
    spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [{ _from: [{ podSelector: {} }] }] },
  };
  if (!(await writeNetworkPolicy(namespace, body))) return false;
  if (gateway) await writeNetworkPolicy(namespace, gatewayIngressPolicy(namespace, gateway));
  if (blockMetadata) await writeNetworkPolicy(namespace, noMetadataPolicy(namespace));
  return true;
}

/** Creates or replaces one of the console's NetworkPolicies (reserved
 * names: always its own). False when the namespace doesn't exist. */
async function writeNetworkPolicy(namespace: string, body: k8s.V1NetworkPolicy): Promise<boolean> {
  const { networking } = getApis();
  try {
    await networking.createNamespacedNetworkPolicy({ namespace, body });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    if (!isConflict(error)) throw error;
  }
  await networking.replaceNamespacedNetworkPolicy({ name: body.metadata?.name ?? "", namespace, body });
  return true;
}

/** The RoleBinding in each team namespace letting the kernel's scheduler
 * read its steps' logs (schedulerLogs.ts): the console's only RBAC write,
 * held to exactly this by its write fence. */
export const SCHEDULER_LOGS_BINDING = "vertra-scheduler-logs";

/** Creates or replaces a team namespace's scheduler-logs RoleBinding. False
 * when the namespace doesn't exist. */
export async function writeSchedulerLogsBinding(
  namespace: string,
  clusterRole: string,
  scheduler: { namespace: string; name: string },
): Promise<boolean> {
  const { rbac } = getApis();
  const body: k8s.V1RoleBinding = {
    metadata: { name: SCHEDULER_LOGS_BINDING, namespace, labels: MANAGED_LABELS },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: clusterRole },
    subjects: [{ kind: "ServiceAccount", name: scheduler.name, namespace: scheduler.namespace }],
  };
  try {
    await rbac.createNamespacedRoleBinding({ namespace, body });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    if (!isConflict(error)) throw error;
  }
  await rbac.replaceNamespacedRoleBinding({ name: SCHEDULER_LOGS_BINDING, namespace, body });
  return true;
}

/** The ResourceQuota and LimitRange every team namespace holds when limits
 * are set (teamQuota.ts). The console's write fence accepts no other names. */
export const TEAM_QUOTA = "vertra-team-quota";
export const TEAM_LIMITS = "vertra-team-limits";

export interface TeamQuota {
  /** What all its steps may request together: CPU, memory, and Pods at once. */
  cpu: string;
  memory: string;
  pods: string;
  /** The most memory one step may ask for. */
  stepMemory: string;
}

/** What a Pod that asks for nothing is given, so a quota doesn't refuse it. */
const DEFAULT_REQUEST = { cpu: "100m", memory: "128Mi" };

/**
 * Writes a team namespace's ResourceQuota and LimitRange, replacing the
 * copies there, or deletes them when the team has no limits. A step over
 * them is refused by the cluster itself (the kernel fails one that can
 * never fit: RESOURCES_NOT_ALLOWED). CPU is never capped per step, only
 * in total, so a step may use spare CPU. Returns false when the namespace
 * doesn't exist (yet).
 */
export async function writeTeamQuota(namespace: string, quota: TeamQuota): Promise<boolean> {
  const { core } = getApis();
  const hard: Record<string, string> = {};
  if (quota.cpu) hard["requests.cpu"] = quota.cpu;
  if (quota.memory) hard["requests.memory"] = quota.memory;
  if (quota.pods) hard["pods"] = quota.pods;
  const limits: k8s.V1LimitRangeItem = { type: "Container" };
  if (quota.cpu || quota.memory) limits.defaultRequest = { ...(quota.cpu ? { cpu: DEFAULT_REQUEST.cpu } : {}), ...(quota.memory ? { memory: DEFAULT_REQUEST.memory } : {}) };
  if (quota.stepMemory) limits.max = { memory: quota.stepMemory };
  try {
    await apply(
      Object.keys(hard).length > 0,
      () => core.createNamespacedResourceQuota({ namespace, body: { metadata: { name: TEAM_QUOTA, namespace, labels: MANAGED_LABELS }, spec: { hard } } }),
      () => core.replaceNamespacedResourceQuota({ name: TEAM_QUOTA, namespace, body: { metadata: { name: TEAM_QUOTA, namespace, labels: MANAGED_LABELS }, spec: { hard } } }),
      () => core.deleteNamespacedResourceQuota({ name: TEAM_QUOTA, namespace }),
    );
    await apply(
      limits.defaultRequest !== undefined || limits.max !== undefined,
      () => core.createNamespacedLimitRange({ namespace, body: { metadata: { name: TEAM_LIMITS, namespace, labels: MANAGED_LABELS }, spec: { limits: [limits] } } }),
      () => core.replaceNamespacedLimitRange({ name: TEAM_LIMITS, namespace, body: { metadata: { name: TEAM_LIMITS, namespace, labels: MANAGED_LABELS }, spec: { limits: [limits] } } }),
      () => core.deleteNamespacedLimitRange({ name: TEAM_LIMITS, namespace }),
    );
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Creates, else replaces (a reserved name: always the console's), or deletes when not wanted. */
async function apply(wanted: boolean, create: () => Promise<unknown>, replace: () => Promise<unknown>, remove: () => Promise<unknown>): Promise<void> {
  if (!wanted) {
    try {
      await remove();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return;
  }
  try {
    await create();
  } catch (error) {
    if (!isConflict(error)) throw error;
    await replace();
  }
}

/** The one Secret a team's SecretStore may take a stored credential from
 * (secretStores.ts). Never registered as a team secret, so never mountable. */
export const SECRET_STORE_CREDENTIAL = "eso-auth";

/**
 * Applies a team's reviewed SecretStore objects (already checked by
 * secretStores.ts): the ServiceAccounts ESO signs in as (their cloud
 * identity annotations included) and the SecretStores, each created or
 * replaced, in the team's namespace whatever the objects say. With a
 * credential, also writes it to the Secret eso-auth (key `token`), which
 * isn't labelled as the console's, so it can never be registered as a
 * team secret and mounted.
 */
export async function applySecretStoreObjects(
  namespace: string,
  objects: { kind: string; apiVersion: string; metadata: { name: string; annotations?: Record<string, string> }; spec?: unknown }[],
  credential: string | undefined,
): Promise<void> {
  const { core } = getApis();
  await ensureNamespaceExists(namespace);
  // The cluster checks the stores first, so one it refuses (ESO missing,
  // a spec its CRD doesn't take) leaves nothing of the file written.
  await writeSecretStores(namespace, objects, true);
  if (credential !== undefined) {
    const body = {
      metadata: { name: SECRET_STORE_CREDENTIAL, namespace, labels: { "app.kubernetes.io/component": "secret-store-credential" } },
      stringData: { token: credential },
      type: "Opaque",
    };
    // The store's credential by definition: always the console's to write.
    await createOrReplaceSecret(namespace, body, true);
  }
  for (const object of objects.filter((o) => o.kind === "ServiceAccount")) {
    const { name, annotations } = object.metadata;
    const body = { metadata: { name, namespace, labels: MANAGED_LABELS, ...(annotations ? { annotations } : {}) } };
    try {
      const existing = await core.readNamespacedServiceAccount({ name, namespace });
      // The file's annotations are the whole set: an identity removed there
      // is removed here.
      existing.metadata ??= {};
      existing.metadata.labels = { ...existing.metadata.labels, ...MANAGED_LABELS };
      existing.metadata.annotations = annotations ?? {};
      await core.replaceNamespacedServiceAccount({ name, namespace, body: existing });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await core.createNamespacedServiceAccount({ namespace, body });
    }
  }
  // Last, once what they sign in with is there.
  await writeSecretStores(namespace, objects, false);
}

/** Each SecretStore created or replaced; with dryRun, only checked by the cluster (ESO's CRD, admission), nothing written. */
async function writeSecretStores(namespace: string, objects: { kind: string; apiVersion: string; metadata: { name: string }; spec?: unknown }[], dryRun: boolean): Promise<void> {
  const { custom } = getApis();
  const dry = dryRun ? { dryRun: "All" } : {};
  for (const object of objects.filter((o) => o.kind === "SecretStore")) {
    const [group, version] = object.apiVersion.split("/");
    const name = object.metadata.name;
    const target = { group: group ?? ESO_GROUP, version: version ?? ESO_VERSION, namespace, plural: "secretstores" };
    const body = {
      apiVersion: object.apiVersion,
      kind: "SecretStore",
      metadata: { name, namespace, labels: MANAGED_LABELS },
      spec: object.spec,
    };
    try {
      const existing = (await custom.getNamespacedCustomObject({ ...target, name })) as { metadata?: { resourceVersion?: string } };
      await custom.replaceNamespacedCustomObject({
        ...target,
        name,
        body: { ...body, metadata: { ...body.metadata, resourceVersion: existing.metadata?.resourceVersion } },
        ...dry,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await createEsoObject({ ...target, body, ...dry });
    }
  }
}

// ESO's `spec.provider` is a union encoded as "whichever single key is
// present". An id not listed here still renders, as its raw id.
const PROVIDER_LABELS: Record<string, string> = {
  gcpsm: "GCP Secret Manager",
  aws: "AWS Secrets Manager",
  azurekv: "Azure Key Vault",
  vault: "HashiCorp Vault",
  onepassword: "1Password Connect",
  onepasswordSDK: "1Password",
  fake: "Test store",
};

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

/** A Ready condition read the way `kubectl get` shows it: none yet means
 * ESO hasn't finished its first reconcile (normal right after creation). */
function readiness(conditions: Condition[] | undefined): { ready: boolean | null; message: string | null } {
  const ready = conditions?.find((c) => c.type === "Ready");
  if (!ready) return { ready: null, message: null };
  return { ready: ready.status === "True", message: ready.message ?? null };
}

type Json = Record<string, unknown>;

function field(object: unknown, ...path: string[]): unknown {
  let current: unknown = object;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Json)[key];
  }
  return current;
}

function stringField(object: unknown, ...path: string[]): string | null {
  const value = field(object, ...path);
  return typeof value === "string" && value !== "" ? value : null;
}

/** ESO objects in one namespace (or all of them). Empty, not an error,
 * when ESO isn't installed: a cluster without it simply has no sources. */
async function listEsoObjects(plural: string, namespace?: string): Promise<unknown[]> {
  const { custom } = getApis();
  try {
    const result = (
      namespace
        ? await custom.listNamespacedCustomObject({ group: ESO_GROUP, version: ESO_VERSION, namespace, plural })
        : await custom.listClusterCustomObject({ group: ESO_GROUP, version: ESO_VERSION, plural })
    ) as { items?: unknown[] };
    return result.items ?? [];
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

export interface SecretStoreSummary {
  name: string;
  /** ESO's provider id (gcpsm, aws, azurekv, onepasswordSDK, ...). */
  provider: string;
  providerLabel: string;
  /** Where secrets come from: a GCP project, a vault URL, an AWS region,
   * a 1Password vault. */
  location: string | null;
  /** Who ESO signs in as: a GCP service account, an Azure client id, an
   * AWS role, or null when it uses a stored credential. */
  identity: string | null;
  /** True when it signs in with a credential stored in the cluster (a key
   * or token) rather than a federated identity. */
  usesStoredCredential: boolean;
  ready: boolean | null;
  message: string | null;
}

const WORKLOAD_IDENTITY_ANNOTATIONS: Record<string, string> = {
  gcpsm: "iam.gke.io/gcp-service-account",
  azurekv: "azure.workload.identity/client-id",
  aws: "eks.amazonaws.com/role-arn",
};

async function serviceAccountAnnotation(
  namespace: string,
  name: string,
  annotation: string,
): Promise<string | null> {
  const { core } = getApis();
  try {
    const account = await core.readNamespacedServiceAccount({ name, namespace });
    return account.metadata?.annotations?.[annotation] ?? null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function summarizeSecretStore(namespace: string, store: unknown): Promise<SecretStoreSummary> {
  const provider = (field(store, "spec", "provider") ?? {}) as Json;
  const providerId = Object.keys(provider)[0] ?? "unknown";
  const config = provider[providerId];
  const location =
    stringField(config, "projectID") ??
    stringField(config, "vaultUrl") ??
    stringField(config, "region") ??
    stringField(config, "vault") ??
    stringField(config, "connectHost") ??
    stringField(config, "server");
  // A federated identity is a ServiceAccount whose annotation names the
  // cloud identity; anything else signs in with a stored key or token.
  const serviceAccountName =
    stringField(config, "auth", "workloadIdentity", "serviceAccountRef", "name") ??
    stringField(config, "serviceAccountRef", "name") ??
    stringField(config, "auth", "jwt", "serviceAccountRef", "name");
  const annotation = WORKLOAD_IDENTITY_ANNOTATIONS[providerId];
  let identity: string | null = null;
  if (serviceAccountName && annotation) {
    identity = await serviceAccountAnnotation(namespace, serviceAccountName, annotation);
  }
  if (providerId === "aws") identity = stringField(config, "role") ?? identity;
  return {
    name: stringField(store, "metadata", "name") ?? "unknown",
    provider: providerId,
    providerLabel: PROVIDER_LABELS[providerId] ?? providerId,
    location,
    identity,
    usesStoredCredential: serviceAccountName === null,
    ...readiness(field(store, "status", "conditions") as Condition[] | undefined),
  };
}

/** Every SecretStore in one team's namespace, with who it signs in as and
 * whether ESO can currently connect. */
export async function listSecretStores(namespace: string): Promise<SecretStoreSummary[]> {
  const result = await listEsoObjects("secretstores", namespace);
  return Promise.all(result.map((item) => summarizeSecretStore(namespace, item)));
}

/** Every SecretStore in the cluster, by namespace: so a team can be told
 * its store's identity is also another team's (either can then sync what
 * the other can). */
export async function listAllSecretStores(): Promise<{ namespace: string; store: SecretStoreSummary }[]> {
  const result = await listEsoObjects("secretstores");
  return Promise.all(
    result.map(async (item) => {
      const namespace = stringField(item, "metadata", "namespace") ?? "";
      return { namespace, store: await summarizeSecretStore(namespace, item) };
    }),
  );
}

export interface ExternalSecretSummary {
  name: string;
  storeName: string | null;
  entries: { secretKey: string; remoteKey: string; property: string | null }[];
  refreshInterval: string | null;
  /** When ESO last fetched it successfully. */
  lastSyncedAt: string | null;
  status: "synced" | "syncing" | "error";
  message: string | null;
}

/** Every ExternalSecret in one team's namespace, live, never cached: the
 * point is "is the sync working right now". One list call, so it also
 * finds ExternalSecrets created outside the console. */
export async function listExternalSecrets(namespace: string): Promise<ExternalSecretSummary[]> {
  const result = await listEsoObjects("externalsecrets", namespace);
  return result.map((item) => {
    const { ready, message } = readiness(field(item, "status", "conditions") as Condition[] | undefined);
    const data = (field(item, "spec", "data") ?? []) as unknown[];
    return {
      name: stringField(item, "metadata", "name") ?? "unknown",
      storeName: stringField(item, "spec", "secretStoreRef", "name"),
      entries: data.map((entry) => ({
        secretKey: stringField(entry, "secretKey") ?? "",
        remoteKey: stringField(entry, "remoteRef", "key") ?? "",
        property: stringField(entry, "remoteRef", "property"),
      })),
      refreshInterval: stringField(item, "spec", "refreshInterval"),
      lastSyncedAt: stringField(item, "status", "refreshTime"),
      status: ready === null ? "syncing" : ready ? "synced" : "error",
      message,
    };
  });
}

/** One task attempt as the Team page shows it: read-only, no secret data,
 * always one team's own namespace. Pods the kernel didn't create (no
 * execution label) are still listed, without the task fields. */
export interface TaskPodSummary {
  podName: string;
  executionId: string | null;
  taskKey: string | null;
  attempt: number | null;
  image: string | null;
  serviceAccount: string | null;
  state: "starting" | "running" | "cant-start" | "finished" | "failed";
  /** Plain-words reason for cant-start/failed, with Kubernetes' own detail. */
  problem: { title: string; detail: string } | null;
  restarts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

const IMAGE_PULL_REASONS = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName"]);

function taskState(pod: k8s.V1Pod): Pick<TaskPodSummary, "state" | "problem"> {
  const status = pod.status;
  const container = status?.containerStatuses?.[0];
  const waiting = container?.state?.waiting;
  const terminated = container?.state?.terminated;
  if (waiting?.reason && IMAGE_PULL_REASONS.has(waiting.reason)) {
    return {
      state: "cant-start",
      problem: { title: "The image can't be pulled", detail: waiting.message ?? waiting.reason },
    };
  }
  if (waiting?.reason === "CreateContainerConfigError" || waiting?.reason === "CreateContainerError") {
    return {
      state: "cant-start",
      problem: {
        title: "Something it needs to start is missing",
        detail: waiting.message ?? waiting.reason,
      },
    };
  }
  const unschedulable = status?.conditions?.find(
    (c) => c.type === "PodScheduled" && c.status === "False" && c.reason === "Unschedulable",
  );
  if (unschedulable) {
    return {
      state: "cant-start",
      problem: { title: "Waiting for room on the cluster", detail: unschedulable.message ?? "" },
    };
  }
  if (status?.phase === "Succeeded") return { state: "finished", problem: null };
  if (status?.phase === "Failed") {
    const detail = terminated?.reason === "OOMKilled"
      ? "It ran out of memory."
      : terminated
        ? `Exited with code ${String(terminated.exitCode)}${terminated.reason ? ` (${terminated.reason})` : ""}.`
        : (status.message ?? "");
    return { state: "failed", problem: { title: "It failed", detail } };
  }
  if (status?.phase === "Running") return { state: "running", problem: null };
  return { state: "starting", problem: null };
}

export async function listTaskPods(namespace: string): Promise<TaskPodSummary[]> {
  const { core } = getApis();
  const result = await core.listNamespacedPod({ namespace });
  return result.items.map((pod) => {
    const labels = pod.metadata?.labels ?? {};
    const container = pod.status?.containerStatuses?.[0];
    const attempt = labels["vertra.dev/attempt"];
    return {
      podName: pod.metadata?.name ?? "unknown",
      executionId: labels["vertra.dev/execution-id"] ?? null,
      taskKey: pod.metadata?.annotations?.["vertra.dev/task"] ?? null,
      attempt: attempt ? Number(attempt) : null,
      image: pod.spec?.containers[0]?.image ?? null,
      serviceAccount: pod.spec?.serviceAccountName ?? null,
      ...taskState(pod),
      restarts: (pod.status?.containerStatuses ?? []).reduce((sum, c) => sum + c.restartCount, 0),
      startedAt: pod.status?.startTime ? new Date(pod.status.startTime).toISOString() : null,
      finishedAt: container?.state?.terminated?.finishedAt
        ? new Date(container.state.terminated.finishedAt).toISOString()
        : null,
    };
  });
}

/** How many Pods in each namespace aren't finished (starting, running or
 * unable to start): one list across the cluster, for an admin's list of
 * teams, rather than one a team. */
export async function unfinishedPodsByNamespace(): Promise<Map<string, number>> {
  const { core } = getApis();
  return countUnfinishedPods((await core.listPodForAllNamespaces({})).items);
}

/** unfinishedPodsByNamespace's count, of Pods already listed. */
export function countUnfinishedPods(pods: k8s.V1Pod[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pod of pods) {
    const { state } = taskState(pod);
    const namespace = pod.metadata?.namespace;
    if (!namespace || state === "finished" || state === "failed") continue;
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }
  return counts;
}

/** Whether policy-controller's ClusterImagePolicy `name` exists: the kernel
 * chart makes it (image-signature.yaml) exactly when catalog images must be
 * signed. No such object, or no such kind (policy-controller isn't
 * installed, as on kind), is false. Read only, by that name alone
 * (rbac.yaml). */
export async function clusterImagePolicyExists(name: string): Promise<boolean> {
  const { custom } = getApis();
  try {
    await custom.getClusterCustomObject({ group: "policy.sigstore.dev", version: "v1beta1", plural: "clusterimagepolicies", name });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** The image policy's allowed sources, as the two CEL literals the
 * execution-kernel chart's image-policy.yaml keeps them in (`source`, a
 * string; `additional`, a list of strings), with the policy's
 * resourceVersion. `null` when the policy doesn't exist (the kernel chart
 * isn't installed, or imagePolicy is disabled). */
export async function readImagePolicyData(
  name: string,
): Promise<{ source: string; additional: string[]; version: string } | null> {
  const { admission } = getApis();
  let policy: k8s.V1ValidatingAdmissionPolicy;
  try {
    policy = await admission.readValidatingAdmissionPolicy({ name });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const variables = policy.spec?.variables ?? [];
  const expression = (variable: string): unknown => {
    const found = variables.find((v) => v.name === variable);
    if (!found) throw new Error(`Image policy "${name}" has no "${variable}" variable.`);
    // Written by the chart and this console as JSON, which is also a CEL literal.
    return JSON.parse(found.expression) as unknown;
  };
  const source = expression("source");
  const additional = expression("additional");
  if (typeof source !== "string" || !Array.isArray(additional) || !additional.every((a) => typeof a === "string")) {
    throw new Error(`Image policy "${name}" doesn't hold a plain source list.`);
  }
  return { source, additional, version: policy.metadata?.resourceVersion ?? "" };
}

/** Thrown when the policy changed since the caller read it. */
export class ImagePolicyConflictError extends Error {}

/**
 * Rewrites the identity policy's `products` and `teamSecrets` literals (the
 * execution-kernel chart's identity-policy.yaml) with what `build` returns,
 * JSON for each. `build` runs after the policy is read and the write is
 * conditional on that read's resourceVersion; on a conflict both happen
 * again. So when two syncs race, the later write always comes from a
 * database read made after the earlier write: the policy can't end up older
 * than the database. Returns false when the policy doesn't exist
 * (identityPolicy disabled).
 */
export async function updateIdentityPolicy(
  name: string,
  build: () => Promise<{ products: string; teamSecrets: string }>,
): Promise<boolean> {
  const { admission } = getApis();
  for (let attempt = 1; ; attempt++) {
    let policy: k8s.V1ValidatingAdmissionPolicy;
    try {
      policy = await admission.readValidatingAdmissionPolicy({ name });
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    const variables = policy.spec?.variables ?? [];
    const products = variables.find((v) => v.name === "products");
    const teamSecrets = variables.find((v) => v.name === "teamSecrets");
    if (!products || !teamSecrets) {
      // An older kernel chart, whose policy checks per-product secret lists
      // this console no longer writes.
      throw new Error(`Identity policy "${name}" has no "products" or "teamSecrets" variable: upgrade the kernel chart.`);
    }
    const literals = await build();
    if (products.expression === literals.products && teamSecrets.expression === literals.teamSecrets) return true;
    products.expression = literals.products;
    teamSecrets.expression = literals.teamSecrets;
    try {
      await admission.replaceValidatingAdmissionPolicy({ name, body: policy });
      return true;
    } catch (error) {
      const conflict = typeof error === "object" && error !== null && "code" in error && error.code === 409;
      if (!conflict || attempt >= 5) throw error;
    }
  }
}

/** Rewrites only the policy's `source` and `additional` literals, and only
 * if it's still at `version` (the one the admin was looking at): the API
 * server refuses a stale resourceVersion with 409, so two admins saving at
 * once can't silently overwrite each other. Everything else in the policy
 * is sent back exactly as read. The caller has already checked every entry
 * is a plain registry path, so the JSON written is always a plain literal. */
export async function writeImagePolicyData(
  name: string,
  sources: { source: string; additional: string[] },
  version: string,
): Promise<string> {
  const { admission } = getApis();
  const policy = await admission.readValidatingAdmissionPolicy({ name });
  for (const variable of policy.spec?.variables ?? []) {
    if (variable.name === "source") variable.expression = JSON.stringify(sources.source);
    if (variable.name === "additional") variable.expression = JSON.stringify(sources.additional);
  }
  if (policy.metadata) policy.metadata.resourceVersion = version;
  try {
    const updated = await admission.replaceValidatingAdmissionPolicy({ name, body: policy });
    return updated.metadata?.resourceVersion ?? "";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 409) {
      throw new ImagePolicyConflictError("The image sources were changed by someone else.");
    }
    throw error;
  }
}

// --- Image scans (scanning.ts) ----------------------------------------------

export interface ScanJobSpec {
  namespace: string;
  name: string;
  /** The Trivy image the Job runs. */
  scannerImage: string;
  serverUrl: string;
  serviceAccount: string;
  /** A kubernetes.io/dockerconfigjson Secret for private registries. */
  pullSecretName: string;
  /** What to scan, pinned by digest (through a registry mirror, if any). */
  target: string;
  /** The target's registry speaks plain http (a mirror like kind's). */
  insecure: boolean;
  /** Which image of a multi-platform index to scan, e.g. linux/arm64. */
  platform: string;
  /** Trivy's --format template: one line per finding (scanning.ts parses it). */
  template: string;
}

/**
 * Starts a Trivy client Job scanning one image against the Trivy server.
 * Created if missing: one with this name already running is the same scan.
 * Hardened like nothing else needs to run here: no Kubernetes token, non-
 * root, read-only root filesystem, no privileges, a deadline.
 */
export async function createScanJob(spec: ScanJobSpec): Promise<void> {
  const { batch } = getApis();
  const args = [
    "image",
    "--server", spec.serverUrl,
    "--scanners", "vuln,secret",
    "--quiet",
    "--timeout", "10m",
    "--cache-dir", "/tmp/trivy",
    "--format", "template",
    "--template", spec.template,
    "--platform", spec.platform,
    ...(spec.insecure ? ["--insecure"] : []),
    spec.target,
  ];
  const body: k8s.V1Job = {
    metadata: { name: spec.name, namespace: spec.namespace, labels: { ...MANAGED_LABELS, "app.kubernetes.io/component": "image-scan" } },
    spec: {
      backoffLimit: 1,
      activeDeadlineSeconds: 900,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { ...MANAGED_LABELS, "app.kubernetes.io/component": "image-scan" } },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: spec.serviceAccount,
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "trivy",
              image: spec.scannerImage,
              args,
              env: [
                { name: "HOME", value: "/tmp" },
                ...(spec.pullSecretName ? [{ name: "DOCKER_CONFIG", value: "/etc/docker-config" }] : []),
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "2Gi" } },
              volumeMounts: [
                { name: "tmp", mountPath: "/tmp" },
                ...(spec.pullSecretName ? [{ name: "docker-config", mountPath: "/etc/docker-config", readOnly: true }] : []),
              ],
            },
          ],
          volumes: [
            { name: "tmp", emptyDir: { sizeLimit: "4Gi" } },
            ...(spec.pullSecretName
              ? [{ name: "docker-config", secret: { secretName: spec.pullSecretName, items: [{ key: ".dockerconfigjson", path: "config.json" }] } }]
              : []),
          ],
        },
      },
    },
  };
  try {
    await batch.createNamespacedJob({ namespace: spec.namespace, body });
  } catch (error) {
    const exists = typeof error === "object" && error !== null && "code" in error && error.code === 409;
    if (!exists) throw error;
  }
}

export interface VerifyJobSpec {
  namespace: string;
  name: string;
  /** cosign's image, pinned. */
  image: string;
  /** The scanning identity, which reads the registry. */
  serviceAccount: string;
  pullSecretName: string;
  /** cosign verify's own arguments: the trust, then the reference. */
  args: string[];
  /** A public key, for args' `--key env://COSIGN_PUBLIC_KEY`. */
  publicKey?: string;
}

/**
 * Starts a Job running `cosign verify` on a catalog release, as the
 * scanning identity (it reads the same registry), hardened as the scan Job
 * is. Its exit says whether the signature is good.
 */
export async function createVerifyJob(spec: VerifyJobSpec): Promise<void> {
  const { batch } = getApis();
  const labels = { ...MANAGED_LABELS, "app.kubernetes.io/component": "catalog-verify" };
  const body: k8s.V1Job = {
    metadata: { name: spec.name, namespace: spec.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 300,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: spec.serviceAccount,
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "cosign",
              image: spec.image,
              args: ["verify", ...spec.args],
              env: [
                { name: "HOME", value: "/tmp" },
                ...(spec.publicKey ? [{ name: "COSIGN_PUBLIC_KEY", value: spec.publicKey }] : []),
                ...(spec.pullSecretName ? [{ name: "DOCKER_CONFIG", value: "/etc/docker-config" }] : []),
              ],
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
              resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "256Mi" } },
              volumeMounts: [
                { name: "tmp", mountPath: "/tmp" },
                ...(spec.pullSecretName ? [{ name: "docker-config", mountPath: "/etc/docker-config", readOnly: true }] : []),
              ],
            },
          ],
          volumes: [
            { name: "tmp", emptyDir: { sizeLimit: "64Mi" } },
            ...(spec.pullSecretName
              ? [{ name: "docker-config", secret: { secretName: spec.pullSecretName, items: [{ key: ".dockerconfigjson", path: "config.json" }] } }]
              : []),
          ],
        },
      },
    },
  };
  await batch.createNamespacedJob({ namespace: spec.namespace, body });
}

export type ScanJobState =
  | { state: "running" }
  | { state: "missing" }
  | { state: "succeeded"; output: string; unread?: string }
  | { state: "failed"; output: string };

/** Where a scan (or verification) Job is, with its Pod's output once it has finished. */
export async function readScanJob(
  namespace: string,
  name: string,
  container = "trivy",
  /** Its finished Pod always prints something (a scan's END): until that can be read, it's still running (a while at most). */
  expectOutput = false,
): Promise<ScanJobState> {
  const { batch, core } = getApis();
  let job: k8s.V1Job;
  try {
    job = await batch.readNamespacedJob({ name, namespace });
  } catch (error) {
    if (isNotFound(error)) return { state: "missing" };
    throw error;
  }
  const succeeded = (job.status?.succeeded ?? 0) > 0;
  const failed = job.status?.conditions?.some((c) => c.type === "Failed" && c.status === "True") ?? false;
  if (!succeeded && !failed) return { state: "running" };
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` });
  const pod = pods.items
    .filter((p) => (succeeded ? p.status?.phase === "Succeeded" : true))
    .sort((a, b) => String(b.metadata?.creationTimestamp).localeCompare(String(a.metadata?.creationTimestamp)))[0];
  let output = "";
  if (pod?.metadata?.name) {
    try {
      output = await core.readNamespacedPodLog({ name: pod.metadata.name, namespace, container });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  if (succeeded && expectOutput && output.trim() === "") {
    // A Job can say it succeeded a moment before its Pod does, or before
    // its log can be read: read it again next time, rather than calling an
    // empty output the result, for a few minutes after it finished.
    const finished = job.status?.completionTime ? new Date(job.status.completionTime).getTime() : Date.now();
    if (Date.now() - finished < OUTPUT_GRACE_MS) return { state: "running" };
    return { state: "succeeded", output, unread: (pods.items.map((p) => `${p.metadata?.name ?? "?"}: ${p.status?.phase ?? "?"}`).join(", ") || "no Pod") };
  }
  return succeeded ? { state: "succeeded", output } : { state: "failed", output };
}

/** How long a finished Job's output may take to be readable. */
const OUTPUT_GRACE_MS = 5 * 60_000;

export async function deleteScanJob(namespace: string, name: string): Promise<void> {
  const { batch } = getApis();
  try {
    await batch.deleteNamespacedJob({ name, namespace, propagationPolicy: "Background" });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * Rewrites the kernel chart's scan policy's `blockedDigests` literal (a JSON
 * list) with what `build` returns, the same way as updateIdentityPolicy.
 * Returns false when the policy doesn't exist.
 */
export async function updateScanPolicy(name: string, build: () => Promise<string>): Promise<boolean> {
  const { admission } = getApis();
  for (let attempt = 1; ; attempt++) {
    let policy: k8s.V1ValidatingAdmissionPolicy;
    try {
      policy = await admission.readValidatingAdmissionPolicy({ name });
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    const variable = (policy.spec?.variables ?? []).find((v) => v.name === "blockedDigests");
    if (!variable) throw new Error(`Scan policy "${name}" has no "blockedDigests" variable.`);
    const literal = await build();
    if (variable.expression === literal) return true;
    variable.expression = literal;
    try {
      await admission.replaceValidatingAdmissionPolicy({ name, body: policy });
      return true;
    } catch (error) {
      const conflict = typeof error === "object" && error !== null && "code" in error && error.code === 409;
      if (!conflict || attempt >= 5) throw error;
    }
  }
}

/** The image scanner's Deployment: the copies asked for, and how many are ready. */
export async function readScanner(namespace: string, name: string): Promise<{ replicas: number; ready: number }> {
  const { apps } = getApis();
  const deployment = await apps.readNamespacedDeployment({ name, namespace });
  return { replicas: deployment.spec?.replicas ?? 0, ready: deployment.status?.readyReplicas ?? 0 };
}

/**
 * Scales the image scanner's Deployment (only it: the chart's Role names it).
 * Through the scale subresource, which can change nothing but the count.
 */
export async function scaleScanner(namespace: string, name: string, replicas: number): Promise<void> {
  const { apps } = getApis();
  const scale = await apps.readNamespacedDeploymentScale({ name, namespace });
  if (scale.spec?.replicas === replicas) return;
  scale.spec = { replicas };
  await apps.replaceNamespacedDeploymentScale({ name, namespace, body: scale });
}

/**
 * Records when the console was last used, in the chart's activity ConfigMap
 * (the only one its Role may update), for the kernel's sleeper. Another
 * copy's write landing first (a conflict) is as good as this one.
 */
/**
 * When the console's next schedule runs (null: none), in the same
 * ConfigMap: a sleeping install's sleeper sets its wake for it
 * (kernel/internal/sleeper).
 */
export async function recordNextSchedule(namespace: string, name: string, at: Date | null): Promise<void> {
  const { core } = getApis();
  const configMap = await core.readNamespacedConfigMap({ name, namespace });
  const data = { ...configMap.data };
  if (at) data["nextScheduleAt"] = at.toISOString();
  else delete data["nextScheduleAt"];
  configMap.data = data;
  await core.replaceNamespacedConfigMap({ name, namespace, body: configMap });
}

export async function recordActivity(namespace: string, name: string, at: Date): Promise<void> {
  const { core } = getApis();
  const configMap = await core.readNamespacedConfigMap({ name, namespace });
  configMap.data = { ...configMap.data, lastActivityAt: at.toISOString() };
  try {
    await core.replaceNamespacedConfigMap({ name, namespace, body: configMap });
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
}

/**
 * Why the write fence (the console chart's write-fence-policy.yaml, which
 * confines every Secret, ServiceAccount and RBAC write of this console to
 * team namespaces) isn't in force, or null when it is: the policy exists,
 * fails closed and checks something, and its binding denies. Without it,
 * the console's cluster-wide rights would reach every namespace, so it
 * refuses to start (index.ts). It can read these two, never change them.
 */
export async function writeFenceProblem(name: string): Promise<string | null> {
  const { admission } = getApis();
  let policy: k8s.V1ValidatingAdmissionPolicy;
  let binding: k8s.V1ValidatingAdmissionPolicyBinding;
  try {
    policy = await admission.readValidatingAdmissionPolicy({ name });
    binding = await admission.readValidatingAdmissionPolicyBinding({ name });
  } catch (error) {
    if (isNotFound(error)) return `the admission policy or binding "${name}" doesn't exist`;
    throw error;
  }
  return fenceProblem(name, policy, binding);
}

/** The check itself, on what the API server returned. */
export function fenceProblem(
  name: string,
  policy: k8s.V1ValidatingAdmissionPolicy,
  binding: k8s.V1ValidatingAdmissionPolicyBinding,
): string | null {
  if (policy.spec?.failurePolicy !== "Fail") return `"${name}" doesn't fail closed (failurePolicy isn't Fail)`;
  if ((policy.spec.validations ?? []).length === 0) return `"${name}" checks nothing`;
  if (binding.spec.policyName !== name) return `the binding "${name}" binds another policy`;
  if (!binding.spec.validationActions.includes("Deny")) return `the binding "${name}" doesn't deny`;
  return null;
}
