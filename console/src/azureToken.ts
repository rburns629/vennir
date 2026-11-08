// SPDX-License-Identifier: MIT
/**
 * The console's own Microsoft Entra access tokens (AKS Workload Identity):
 * for a Pod labelled azure.workload.identity/use whose ServiceAccount names
 * a managed identity (azure.workload.identity/client-id), AKS's webhook
 * sets AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_AUTHORITY_HOST and
 * AZURE_FEDERATED_TOKEN_FILE, a token Entra exchanges for the identity's
 * access token. Per scope, kept until five minutes before it expires; the
 * token file is read on each exchange, since the kubelet rotates it.
 * Imports nothing of the console's, so the database layer can use it.
 */
import { readFile } from "node:fs/promises";

const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/";

const tokens = new Map<string, { value: string; expiresAt: number }>();

export async function azureToken(scope: string): Promise<string> {
  const cached = tokens.get(scope);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const clientId = process.env["AZURE_CLIENT_ID"];
  const tenantId = process.env["AZURE_TENANT_ID"];
  const tokenFile = process.env["AZURE_FEDERATED_TOKEN_FILE"];
  if (!clientId || !tenantId || !tokenFile) {
    throw new Error(
      "no Azure workload identity: the Pod needs the label azure.workload.identity/use and its ServiceAccount azure.workload.identity/client-id",
    );
  }
  const authority = (process.env["AZURE_AUTHORITY_HOST"] || DEFAULT_AUTHORITY).replace(/\/?$/, "/");
  const response = await fetch(`${authority}${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId,
      scope,
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: (await readFile(tokenFile, "utf8")).trim(),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Entra's error code (e.g. AADSTS70021, no matching federated
    // credential) says what's wrong; its description can be long.
    const body = (await response.json().catch(() => ({}))) as { error?: string; error_codes?: number[] };
    throw new Error(`Entra returned ${String(response.status)} (${body.error ?? "no error code"}${body.error_codes?.length ? ` AADSTS${String(body.error_codes[0])}` : ""})`);
  }
  const body = (await response.json()) as { access_token: string; expires_in: number };
  const token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 300) * 1000 };
  tokens.set(scope, token);
  return token.value;
}
