#!/usr/bin/env python3
"""azure/resource-group's "create" action: finds a resource group by name in
a subscription, creating it only if it doesn't exist. The Azure counterpart
of gcp/project: where everything a later step creates goes.

Credentials come from DefaultAzureCredential: on AKS, Workload Identity
supplies short-lived ones for the step's ServiceAccount, so nothing is
mounted (see the azure team's README.md for what that needs).
"""

import json
import sys
from pathlib import Path
from typing import Any

from azure.core.exceptions import ClientAuthenticationError, HttpResponseError, ServiceRequestError
from azure.identity import DefaultAzureCredential
from azure.mgmt.resource.resources import ResourceManagementClient

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")


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
    subscription, name, location = inputs.get("subscriptionId"), inputs.get("name"), inputs.get("location")
    if not subscription or not name or not location:
        return _failure("MISSING_INPUT", "inputs.subscriptionId, inputs.name and inputs.location are required")

    try:
        groups = ResourceManagementClient(DefaultAzureCredential(), subscription).resource_groups
        if groups.check_existence(name):
            group = groups.get(name)
            print(f"resource group '{name}' already exists, in {group.location}")
        else:
            group = groups.create_or_update(
                name, {"location": location, "tags": {"managed-by": "vennir"}}
            )
            print(f"created resource group '{name}' in {location}")
    except (HttpResponseError, ServiceRequestError) as error:
        return _azure_failure(error)

    _write_result({
        "status": "succeeded",
        "outputs": {"resourceGroup": group.name, "location": group.location, "id": group.id},
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
