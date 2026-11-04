// SPDX-License-Identifier: MIT
import type { PlatformInfo } from "../../api";
import { catalogFileUrl } from "../../catalogFile";

/**
 * What the "Connect a source" wizard knows about each secret provider:
 * what to ask the platform owner, who Vennir will sign in as, the
 * commands to run on the provider's side, and the SecretStore (plus the
 * ServiceAccount ESO signs in as) that goes into the catalog repo for
 * review. Everything here is display: the catalog PR's review is what
 * actually grants anything.
 *
 * Only GCP Secret Manager has been proven end to end on this platform;
 * the others are marked "not yet tested" in the UI.
 */
export type ProviderId = "gcpsm" | "azurekv" | "aws" | "onepasswordSDK";

type Facts = PlatformInfo["secretSources"];
type Values = Record<string, string>;

export interface ProviderField {
  key: string;
  label: string;
  hint?: string;
}

export interface ProviderGuide {
  id: ProviderId;
  title: string;
  description: string;
  /** What gets stored, if anything, in plain words. */
  credential: string;
  tested: boolean;
  /** Why this provider can't be used on this cluster, or null. */
  unavailable: (facts: Facts) => string | null;
  fields: ProviderField[];
  defaults: (team: string) => Values;
  signsInAs: (team: string, facts: Facts, values: Values) => [string, string][];
  commandsIntro: string;
  commands: (team: string, facts: Facts, values: Values) => string;
  manifest: (team: string, facts: Facts, values: Values) => string;
  /** How the add-a-secret form labels the remote reference for this
   * provider's stores. */
  remoteKeyLabel: string;
  propertyLabel: string;
  propertyHint: string;
}

/** The ServiceAccount ESO signs in as, per provider, in the team's namespace. */
function esoAccount(provider: string): string {
  return `eso-${provider}`;
}

function serviceAccountYaml(team: string, name: string, annotations: Record<string, string>): string {
  const lines = Object.entries(annotations).map(([key, value]) => `    ${key}: ${value}`);
  return [
    "apiVersion: v1",
    "kind: ServiceAccount",
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${team}`,
    "  annotations:",
    ...lines,
  ].join("\n");
}

const issuerHost = (facts: Facts) => facts.clusterIssuer.replace(/^https:\/\//, "");

const ALL_PROVIDERS: ProviderGuide[] = [
  {
    id: "gcpsm",
    title: "GCP Secret Manager",
    description: "Secrets in a Google Cloud project your team owns.",
    credential: "nothing: Vennir signs in with Workload Identity.",
    tested: true,
    unavailable: (facts) =>
      facts.gcpWorkloadIdentityPool && facts.gkeClusterName && facts.gkeClusterLocation
        ? null
        : "Needs a GKE cluster with Workload Identity; this one isn't.",
    fields: [
      { key: "project", label: "GCP project holding your secrets", hint: "Your own project is fine; it doesn't have to be Vennir's." },
      { key: "firstSecret", label: "A first secret to allow", hint: "Grant more later the same way, one secret at a time." },
    ],
    defaults: () => ({ project: "", firstSecret: "" }),
    signsInAs: (team, facts, values) => [
      ["GCP service account", gcpServiceAccount(team, values)],
      ["Kubernetes ServiceAccount", `${team}/${esoAccount("gcp")}`],
      ["Workload Identity member", `serviceAccount:${facts.gcpWorkloadIdentityPool}[${team}/${esoAccount("gcp")}]`],
    ],
    commandsIntro:
      "Creates a GCP identity only this team uses, lets it read the secret you named, and lets Vennir sign in as it. Safe to re-run.",
    commands: (team, facts, values) => {
      const project = values["project"] || "<YOUR_PROJECT>";
      const sa = gcpServiceAccount(team, values);
      return [
        `gcloud iam service-accounts create vennir-eso-${team} \\`,
        `  --project=${project}`,
        "",
        `gcloud secrets add-iam-policy-binding ${values["firstSecret"] || "<SECRET_NAME>"} \\`,
        `  --project=${project} \\`,
        "  --role=roles/secretmanager.secretAccessor \\",
        `  --member=serviceAccount:${sa}`,
        "",
        `gcloud iam service-accounts add-iam-policy-binding ${sa} \\`,
        `  --project=${project} \\`,
        "  --role=roles/iam.workloadIdentityUser \\",
        `  --member="serviceAccount:${facts.gcpWorkloadIdentityPool}[${team}/${esoAccount("gcp")}]"`,
      ].join("\n");
    },
    manifest: (team, facts, values) =>
      [
        serviceAccountYaml(team, esoAccount("gcp"), {
          "iam.gke.io/gcp-service-account": gcpServiceAccount(team, values),
        }),
        "---",
        "apiVersion: external-secrets.io/v1",
        "kind: SecretStore",
        "metadata:",
        "  name: gcp-secret-manager",
        `  namespace: ${team}`,
        "spec:",
        "  provider:",
        "    gcpsm:",
        `      projectID: ${values["project"] || "<YOUR_PROJECT>"}`,
        "      auth:",
        "        workloadIdentity:",
        `          clusterLocation: ${facts.gkeClusterLocation}`,
        `          clusterName: ${facts.gkeClusterName}`,
        "          serviceAccountRef:",
        `            name: ${esoAccount("gcp")}`,
      ].join("\n"),
    remoteKeyLabel: "Secret name in Secret Manager",
    propertyLabel: "JSON field (optional)",
    propertyHint: "Only if the secret holds JSON and you need one field of it. Latest version.",
  },
  {
    id: "azurekv",
    title: "Azure Key Vault",
    description: "Secrets in a Key Vault your team owns.",
    credential: "nothing: Azure trusts this cluster's identity directly.",
    tested: false,
    unavailable: (facts) =>
      facts.clusterIssuer ? null : "Needs a cluster whose identity Azure can trust; this one's isn't published.",
    fields: [
      { key: "resourceGroup", label: "Resource group", hint: "Where the vault and the new identity live." },
      { key: "vault", label: "Key Vault name" },
      { key: "tenantId", label: "Tenant ID" },
      { key: "clientId", label: "Identity client ID", hint: "Printed by the first command below; paste it here so the file is complete." },
    ],
    defaults: () => ({ resourceGroup: "", vault: "", tenantId: "", clientId: "" }),
    signsInAs: (team, facts) => [
      ["Issuer (this cluster)", facts.clusterIssuer],
      ["Subject", `system:serviceaccount:${team}:${esoAccount("azure")}`],
      ["Audience", "api://AzureADTokenExchange"],
    ],
    commandsIntro:
      "Creates a managed identity, lets it read the vault's secrets, and tells Azure to trust Vennir's cluster for it.",
    commands: (team, facts, values) => {
      const group = values["resourceGroup"] || "<RESOURCE_GROUP>";
      const identity = `vennir-eso-${team}`;
      return [
        `az identity create -g ${group} -n ${identity} --query clientId -o tsv`,
        "",
        "az role assignment create \\",
        '  --role "Key Vault Secrets User" \\',
        `  --assignee-object-id $(az identity show -g ${group} -n ${identity} --query principalId -o tsv) \\`,
        "  --assignee-principal-type ServicePrincipal \\",
        `  --scope $(az keyvault show -n ${values["vault"] || "<VAULT>"} --query id -o tsv)`,
        "",
        "az identity federated-credential create \\",
        `  -g ${group} --identity-name ${identity} \\`,
        `  --name vennir-${team} \\`,
        `  --issuer ${facts.clusterIssuer} \\`,
        `  --subject system:serviceaccount:${team}:${esoAccount("azure")} \\`,
        "  --audiences api://AzureADTokenExchange",
      ].join("\n");
    },
    manifest: (team, _facts, values) =>
      [
        serviceAccountYaml(team, esoAccount("azure"), {
          "azure.workload.identity/client-id": values["clientId"] || "<IDENTITY_CLIENT_ID>",
          "azure.workload.identity/tenant-id": values["tenantId"] || "<TENANT_ID>",
        }),
        "---",
        "apiVersion: external-secrets.io/v1",
        "kind: SecretStore",
        "metadata:",
        "  name: azure-key-vault",
        `  namespace: ${team}`,
        "spec:",
        "  provider:",
        "    azurekv:",
        "      authType: WorkloadIdentity",
        `      vaultUrl: https://${values["vault"] || "<VAULT>"}.vault.azure.net`,
        "      serviceAccountRef:",
        `        name: ${esoAccount("azure")}`,
      ].join("\n"),
    remoteKeyLabel: "Secret name in Key Vault",
    propertyLabel: "JSON field (optional)",
    propertyHint: "Only if the secret holds JSON and you need one field of it.",
  },
  {
    id: "aws",
    title: "AWS Secrets Manager",
    description: "Secrets in an AWS account your team owns.",
    credential: "nothing: AWS trusts this cluster's identity directly.",
    tested: true,
    unavailable: (facts) =>
      facts.clusterIssuer ? null : "Needs a cluster whose identity AWS can trust; this one's isn't published.",
    fields: [
      { key: "account", label: "AWS account ID" },
      { key: "region", label: "Region", hint: "Where your secrets are, e.g. eu-west-1." },
    ],
    defaults: () => ({ account: "", region: "" }),
    signsInAs: (team, facts, values) => [
      ["IAM role", awsRole(team, values)],
      ["Issuer (this cluster)", facts.clusterIssuer],
      ["Subject", `system:serviceaccount:${team}:${esoAccount("aws")}`],
    ],
    commandsIntro:
      "Registers Vennir's cluster as an identity provider in IAM (once per cluster: an install vennir made on AWS has it already, so skip that step), then a role only this team's ESO ServiceAccount can use (IRSA), limited to secrets whose names start with the team's name and a slash.",
    commands: (team, facts, values) => {
      const account = values["account"] || "<ACCOUNT_ID>";
      const region = values["region"] || "<REGION>";
      const host = issuerHost(facts);
      const trust = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Federated: `arn:aws:iam::${account}:oidc-provider/${host}` },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                [`${host}:sub`]: `system:serviceaccount:${team}:${esoAccount("aws")}`,
                [`${host}:aud`]: "sts.amazonaws.com",
              },
            },
          },
        ],
      };
      const policy = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "secretsmanager:GetSecretValue",
            Resource: `arn:aws:secretsmanager:${region}:${account}:secret:${team}/*`,
          },
        ],
      };
      return [
        "# Once per cluster (vennir does this for an install it made on AWS):",
        `aws iam create-open-id-connect-provider \\`,
        `  --url ${facts.clusterIssuer} \\`,
        "  --client-id-list sts.amazonaws.com",
        "",
        "cat > trust.json <<'EOF'",
        JSON.stringify(trust, null, 2),
        "EOF",
        `aws iam create-role --role-name vennir-eso-${team} \\`,
        "  --assume-role-policy-document file://trust.json",
        "",
        "cat > read-secrets.json <<'EOF'",
        JSON.stringify(policy, null, 2),
        "EOF",
        `aws iam put-role-policy --role-name vennir-eso-${team} \\`,
        `  --policy-name read-${team}-secrets \\`,
        "  --policy-document file://read-secrets.json",
      ].join("\n");
    },
    manifest: (team, _facts, values) =>
      [
        serviceAccountYaml(team, esoAccount("aws"), { "eks.amazonaws.com/role-arn": awsRole(team, values) }),
        "---",
        "apiVersion: external-secrets.io/v1",
        "kind: SecretStore",
        "metadata:",
        "  name: aws-secrets-manager",
        `  namespace: ${team}`,
        "spec:",
        "  provider:",
        "    aws:",
        "      service: SecretsManager",
        `      region: ${values["region"] || "<REGION>"}`,
        "      auth:",
        "        jwt:",
        "          serviceAccountRef:",
        `            name: ${esoAccount("aws")}`,
      ].join("\n"),
    remoteKeyLabel: "Secret name in Secrets Manager",
    propertyLabel: "JSON field (optional)",
    propertyHint: "Secrets Manager values are often JSON; name the one field you need.",
  },
  {
    id: "onepasswordSDK",
    title: "1Password",
    description: "Items in a 1Password vault your team owns.",
    credential: "a 1Password service account token, set on this team's Secrets tab (each install keeps its own).",
    tested: false,
    unavailable: (facts) => (facts.catalogRepo ? null : "Needs the catalog repo configured for this console."),
    fields: [{ key: "vault", label: "Vault name", hint: "Give the 1Password service account access to this vault only." }],
    defaults: (team) => ({ vault: `vennir-${team}` }),
    signsInAs: (team) => [
      ["Token stored as", "Secrets tab → Stored credential, in this install only"],
      ["Becomes Kubernetes Secret", `${team}/eso-auth (key: token)`],
    ],
    commandsIntro:
      "1Password can't trust a cluster directly, so it needs one stored token. It never goes in git: each install keeps its own, and no step can mount it.",
    commands: (_team, _facts, values) =>
      [
        "# 1. In 1Password: Developer > Service Accounts > New service account.",
        `#    Read-only access to the vault "${values["vault"] || "<VAULT>"}" and nothing else.`,
        "",
        "# 2. Paste its token under Stored credential on this team's Secrets",
        "#    tab, in each install that uses this catalog.",
        "",
        "# To rotate: create a new token, save it there, then revoke the old",
        "# one in 1Password.",
      ].join("\n"),
    manifest: (team, _facts, values) =>
      [
        "apiVersion: external-secrets.io/v1",
        "kind: SecretStore",
        "metadata:",
        "  name: onepassword",
        `  namespace: ${team}`,
        "spec:",
        "  provider:",
        "    onepasswordSDK:",
        `      vault: ${values["vault"] || "<VAULT>"}`,
        "      auth:",
        "        serviceAccountSecretRef:",
        "          name: eso-auth",
        "          key: token",
      ].join("\n"),
    remoteKeyLabel: "Item name",
    propertyLabel: "Field (optional)",
    propertyHint: 'The field of the item to use, e.g. "password" or "api key".',
  },
];

function gcpServiceAccount(team: string, values: Values): string {
  return `vennir-eso-${team}@${values["project"] || "<YOUR_PROJECT>"}.iam.gserviceaccount.com`;
}

function awsRole(team: string, values: Values): string {
  return `arn:aws:iam::${values["account"] || "<ACCOUNT_ID>"}:role/vennir-eso-${team}`;
}

export function providerGuide(id: string): ProviderGuide | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Where a team's SecretStore file is in the catalog. */
export const secretStoreFile = (team: string) => `teams/${team}/secret-stores/secretstore.yaml`;

/** A link that opens GitHub's "create file" page in the catalog with the
 * SecretStore filled in. */
export function newFileUrl(repo: string, team: string, manifest: string): string {
  return catalogFileUrl(repo, secretStoreFile(team), "new", `${manifest}\n`);
}

/** The command that fixes a GCP "permission denied" sync error: let the
 * store's identity read that one secret. Null when it doesn't apply. */
export function gcpAccessFix(
  provider: string,
  project: string | null,
  identity: string | null,
  remoteKey: string,
  message: string | null,
): string | null {
  if (provider !== "gcpsm" || !project || !identity || !message) return null;
  if (!/permission|denied|403/i.test(message)) return null;
  return [
    `gcloud secrets add-iam-policy-binding ${remoteKey} \\`,
    `  --project=${project} \\`,
    "  --role=roles/secretmanager.secretAccessor \\",
    `  --member=serviceAccount:${identity}`,
  ].join("\n");
}

/** The sources offered: Azure Key Vault waits until Azure is proven (after the MVP, decided 2026-10-25). */
export const PROVIDERS: ProviderGuide[] = ALL_PROVIDERS.filter((p) => p.id !== "azurekv");
