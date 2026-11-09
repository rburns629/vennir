#!/usr/bin/env python3
"""azure/resource-group's "create" action: finds a resource group by name in
a subscription, creating it only if it doesn't exist. The Azure counterpart
of gcp/project: where everything a later step creates goes.

Credentials: on AKS, Workload Identity supplies short-lived ones for the
step's ServiceAccount (DefaultAzureCredential), so nothing is mounted; off
AKS, it signs in as its own managed identity (the team secret
azure-resource-group-identity) with the step's own token. See the azure
team's README.md for what each needs.
"""

import json
import os
import sys
from pathlib import Path
from typing import Any

from azure.core.exceptions import ClientAuthenticationError, HttpResponseError, ServiceRequestError
from azure.identity import DefaultAzureCredential, WorkloadIdentityCredential
from azure.mgmt.resource.resources import ResourceManagementClient

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

# Off AKS (GKE, EKS), with no Workload Identity webhook: this product's own
# managed identity, named by the team secret azure-resource-group-identity
# (keys client-id and tenant-id), signed in to with the step's own token
# (product.yaml's tokenAudiences). The identity's federated credential
# trusts this cluster's issuer for this product's ServiceAccount alone (see
# the azure team's README.md, Azure from another cluster).
OWN_IDENTITY = Path("/platform/secrets/azure-resource-group-identity")
TOKEN_FILE = Path("/platform/tokens/api___AzureADTokenExchange")


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
    subscription, name, location = inputs.get("subscriptionId"), inputs.get("name"), inputs.get("location")
    if not subscription or not name or not location:
        return _failure("MISSING_INPUT", "inputs.subscriptionId, inputs.name and inputs.location are required")

    try:
        groups = ResourceManagementClient(_credential(), subscription).resource_groups
        if groups.check_existence(name):
            group = groups.get(name)
            print(f"resource group '{name}' already exists, in {group.location}")
        else:
            group = groups.create_or_update(
                name, {"location": location, "tags": {"managed-by": "vennir"}}
            )
            print(f"created resource group '{name}' in {location}")
    except (HttpResponseError, ServiceRequestError, _NoToken) as error:
        return _azure_failure(error)

    _write_result({
        "status": "succeeded",
        "outputs": {"resourceGroup": group.name, "location": group.location, "id": group.id},
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
