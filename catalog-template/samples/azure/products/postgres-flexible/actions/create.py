#!/usr/bin/env python3
"""azure/postgres-flexible's "create" action: finds an Azure Database for
PostgreSQL flexible server by name, creating it only if it doesn't exist,
and makes sure the given Microsoft Entra principal is its administrator.

No password exists anywhere: password sign-in is off and only Microsoft
Entra identities sign in (an app with its own managed identity, a person
with `az login`). Public network access is off unless `publicNetworkAccess`
is "Enabled"; reach it from a VNet or a private endpoint. Credentials as in
the azure team's README.md (Workload Identity, through DefaultAzureCredential).
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
from azure.identity import DefaultAzureCredential
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


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result(
        {"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}}
    )
    return 1


def _azure_failure(error: Exception) -> int:
    if isinstance(error, ClientAuthenticationError):
        return _failure(
            "AZURE_AUTH_FAILED",
            "Couldn't sign in to Azure: is the step's ServiceAccount federated with a managed "
            f"identity? ({type(error).__name__})",
        )
    if isinstance(error, HttpResponseError):
        status = error.status_code or 0
        code = getattr(error.error, "code", None) or str(status)
        retryable = status in (408, 429) or status >= 500
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
    # The webhook that supplies Workload Identity sets AZURE_TENANT_ID.
    tenant = inputs.get("tenantId") or os.environ.get("AZURE_TENANT_ID")
    if not tenant:
        return _failure("MISSING_INPUT", "inputs.tenantId is required (AZURE_TENANT_ID isn't set)")
    admin_type = inputs.get("adminType", "Group")
    if admin_type not in PRINCIPAL_TYPES:
        return _failure("INVALID_INPUT", f"inputs.adminType must be one of {sorted(PRINCIPAL_TYPES)}")
    group, name = inputs["resourceGroup"], inputs["serverName"]

    try:
        client = PostgreSQLManagementClient(DefaultAzureCredential(), inputs["subscriptionId"])
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
    except (HttpResponseError, ServiceRequestError) as error:
        return _azure_failure(error)

    print(f"server '{name}' is ready, administered by {inputs['adminName']}")
    _write_result({
        "status": "succeeded",
        "outputs": {"serverName": server.name, "fqdn": server.fully_qualified_domain_name or "", "id": server.id},
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
