#!/usr/bin/env python3
"""azure/postgres-flexible's "create" action: finds an Azure Database for
PostgreSQL flexible server by name, creating it only if it doesn't exist,
and makes sure the given Microsoft Entra principal is its administrator.

No password exists anywhere: password sign-in is off and only Microsoft
Entra identities sign in (an app with its own managed identity, a person
with `az login`). Public network access is off unless `publicNetworkAccess`
is "Enabled"; reach it from a VNet or a private endpoint. Credentials as in
the azure team's README.md: Workload Identity on AKS, and off AKS its own
managed identity (the team secret azure-postgres-flexible-identity) by
federation.
"""

import json
import os
import sys
from pathlib import Path
from typing import Any

from azure.core.exceptions import (
    ClientAuthenticationError,
    HttpResponseError,
    ResourceNotFoundError,
    ServiceRequestError,
)
from azure.identity import DefaultAzureCredential, WorkloadIdentityCredential
from azure.mgmt.postgresqlflexibleservers import PostgreSQLManagementClient
from azure.mgmt.postgresqlflexibleservers.models import (
    AdministratorMicrosoftEntraAdd,
    AuthConfig,
    Backup,
    Network,
    Server,
    Sku,
    Storage,
)

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")
PRINCIPAL_TYPES = {"User", "Group", "ServicePrincipal"}

# Off AKS (GKE, EKS), with no Workload Identity webhook: this product's own
# managed identity, named by the team secret azure-postgres-flexible-identity
# (keys client-id and tenant-id), signed in to with the step's own token
# (product.yaml's tokenAudiences). The identity's federated credential
# trusts this cluster's issuer for this product's ServiceAccount alone (see
# the azure team's README.md, Azure from another cluster).
OWN_IDENTITY = Path("/platform/secrets/azure-postgres-flexible-identity")
TOKEN_FILE = Path("/platform/tokens/api___AzureADTokenExchange")
# Azure's error codes for a failure that may pass on another attempt.
TRANSIENT_CODES = {"InternalServerError", "ServiceUnavailable", "GatewayTimeout", "ServerBusy", "TooManyRequests"}


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result(
        {"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}}
    )
    return 1


class _NoToken(Exception):
    """The identity's secret is mounted, but the step got no token."""


def _credential() -> Any:
    """On AKS, Workload Identity's (DefaultAzureCredential reads what its
    webhook sets); elsewhere, this product's own identity (OWN_IDENTITY) by
    federation with the step's token."""
    if os.environ.get("AZURE_FEDERATED_TOKEN_FILE") or not OWN_IDENTITY.exists():
        return DefaultAzureCredential()
    if not TOKEN_FILE.exists():
        raise _NoToken()
    return WorkloadIdentityCredential(
        tenant_id=(OWN_IDENTITY / "tenant-id").read_text().strip(),
        client_id=(OWN_IDENTITY / "client-id").read_text().strip(),
        token_file_path=str(TOKEN_FILE),
    )


def _azure_failure(error: Exception) -> int:
    if isinstance(error, _NoToken):
        return _failure(
            "NO_TOKEN",
            "The step got no token for api://AzureADTokenExchange: a release without the "
            "product's tokenAudiences, or a step not run as the product.",
        )
    if isinstance(error, ClientAuthenticationError):
        if not (os.environ.get("AZURE_FEDERATED_TOKEN_FILE") or OWN_IDENTITY.exists()):
            return _failure(
                "NO_IDENTITY",
                "No identity to sign in to Azure as: on AKS, Workload Identity's (the step Pod's "
                "label and its ServiceAccount's annotation); off AKS, the team secret "
                f"{OWN_IDENTITY.name}, which the step gets once its secretRefs line in product.yaml "
                "is uncommented.",
            )
        return _failure(
            "AZURE_AUTH_FAILED",
            "Couldn't sign in to Azure: is the step's ServiceAccount federated with a managed "
            f"identity? ({type(error).__name__})",
        )
    if isinstance(error, HttpResponseError):
        status = error.status_code or 0
        code = getattr(error.error, "code", None) or str(status)
        # A long-running operation's failure arrives on a poll that itself
        # succeeded (200): its code says whether trying again may work.
        retryable = status in (408, 429) or status >= 500 or code in TRANSIENT_CODES
        return _failure("AZURE_API_ERROR", f"{code}: {error.message}", retryable=retryable)
    if isinstance(error, ServiceRequestError):
        return _failure("AZURE_API_ERROR", str(error), retryable=True)
    raise error


def main() -> int:
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})
    required = ("subscriptionId", "resourceGroup", "serverName", "location", "adminObjectId", "adminName")
    missing = [key for key in required if not inputs.get(key)]
    if missing:
        return _failure("MISSING_INPUT", "inputs." + ", inputs.".join(missing) + " required")
    # The webhook that supplies Workload Identity sets AZURE_TENANT_ID; off
    # AKS, the identity's own secret says.
    own_tenant = OWN_IDENTITY / "tenant-id"
    tenant = (
        inputs.get("tenantId")
        or os.environ.get("AZURE_TENANT_ID")
        or (own_tenant.read_text().strip() if own_tenant.exists() else "")
    )
    if not tenant:
        return _failure("MISSING_INPUT", "inputs.tenantId is required (AZURE_TENANT_ID isn't set)")
    admin_type = inputs.get("adminType", "Group")
    if admin_type not in PRINCIPAL_TYPES:
        return _failure("INVALID_INPUT", f"inputs.adminType must be one of {sorted(PRINCIPAL_TYPES)}")
    group, name = inputs["resourceGroup"], inputs["serverName"]

    try:
        client = PostgreSQLManagementClient(_credential(), inputs["subscriptionId"])
        try:
            server = client.servers.get(group, name)
            print(f"server '{name}' already exists")
        except ResourceNotFoundError:
            print(f"creating server '{name}'; this takes several minutes")
            server = client.servers.begin_create_or_update(
                group,
                name,
                Server(
                    location=inputs["location"],
                    version=str(inputs.get("version", "16")),
                    sku=Sku(name=inputs.get("skuName", "Standard_B1ms"), tier=inputs.get("skuTier", "Burstable")),
                    storage=Storage(storage_size_gb=int(inputs.get("storageGb", 32))),
                    auth_config=AuthConfig(
                        active_directory_auth="Enabled", password_auth="Disabled", tenant_id=tenant
                    ),
                    network=Network(public_network_access=inputs.get("publicNetworkAccess", "Disabled")),
                    backup=Backup(backup_retention_days=7),
                    tags={"managed-by": "vennir"},
                ),
            ).result()
        # Idempotent: adding the same administrator again changes nothing.
        client.administrators_microsoft_entra.begin_create_or_update(
            group,
            name,
            inputs["adminObjectId"],
            AdministratorMicrosoftEntraAdd(
                principal_type=admin_type, principal_name=inputs["adminName"], tenant_id=tenant
            ),
        ).result()
    except (HttpResponseError, ServiceRequestError, _NoToken) as error:
        return _azure_failure(error)

    print(f"server '{name}' is ready, administered by {inputs['adminName']}")
    _write_result({
        "status": "succeeded",
        "outputs": {"serverName": server.name, "fqdn": server.fully_qualified_domain_name or "", "id": server.id},
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
