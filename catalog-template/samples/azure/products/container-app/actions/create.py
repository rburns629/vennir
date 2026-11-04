#!/usr/bin/env python3
"""azure/container-app's "create" action: deploys a container image as an
Azure Container App, or returns the existing app's URL if one of that name
exists. Creates the Container Apps environment it runs in if that doesn't
exist yet. Never builds an image: `image` is a registry reference.

Ingress is internal to the environment unless `public` is true. Images from
a private registry (Azure Container Registry) are pulled with a managed
identity (`registryIdentity`), never a password. Credentials as in the azure
team's README.md (Workload Identity, through DefaultAzureCredential).
"""

import json
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
from azure.mgmt.appcontainers import ContainerAppsAPIClient
from azure.mgmt.appcontainers.models import (
    Configuration,
    Container,
    ContainerApp,
    ContainerResources,
    EnvironmentVar,
    Ingress,
    ManagedEnvironment,
    RegistryCredentials,
    Template,
)

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


def _outputs(app: Any) -> dict[str, Any]:
    ingress = app.configuration.ingress if app.configuration else None
    fqdn = ingress.fqdn if ingress else None
    return {"appName": app.name, "url": f"https://{fqdn}" if fqdn else "", "id": app.id}


def main() -> int:
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})
    required = ("subscriptionId", "resourceGroup", "environmentName", "appName", "image", "location")
    missing = [key for key in required if not inputs.get(key)]
    if missing:
        return _failure("MISSING_INPUT", "inputs." + ", inputs.".join(missing) + " required")
    environment = inputs.get("environment") or {}
    if not all(isinstance(v, str) for v in environment.values()):
        return _failure("INVALID_INPUT", "inputs.environment values must be strings")
    group, name, location = inputs["resourceGroup"], inputs["appName"], inputs["location"]

    try:
        client = ContainerAppsAPIClient(DefaultAzureCredential(), inputs["subscriptionId"])
        try:
            app = client.container_apps.get(group, name)
            print(f"container app '{name}' already exists, leaving it as it is")
            _write_result({"status": "succeeded", "outputs": _outputs(app)})
            return 0
        except ResourceNotFoundError:
            pass

        try:
            managed_environment = client.managed_environments.get(group, inputs["environmentName"])
        except ResourceNotFoundError:
            print(f"creating Container Apps environment '{inputs['environmentName']}'")
            managed_environment = client.managed_environments.begin_create_or_update(
                group, inputs["environmentName"], ManagedEnvironment(location=location)
            ).result()

        registries = []
        if inputs.get("registryServer"):
            registries.append(RegistryCredentials(
                server=inputs["registryServer"], identity=inputs.get("registryIdentity", "system")
            ))
        app = client.container_apps.begin_create_or_update(
            group,
            name,
            ContainerApp(
                location=location,
                managed_environment_id=managed_environment.id,
                configuration=Configuration(
                    ingress=Ingress(external=bool(inputs.get("public", False)), target_port=int(inputs.get("port", 8080))),
                    registries=registries or None,
                ),
                template=Template(containers=[Container(
                    name=name,
                    image=inputs["image"],
                    env=[EnvironmentVar(name=k, value=v) for k, v in environment.items()] or None,
                    resources=ContainerResources(cpu=0.5, memory="1Gi"),
                )]),
                tags={"managed-by": "vennir"},
            ),
        ).result()
    except (HttpResponseError, ServiceRequestError) as error:
        return _azure_failure(error)

    print(f"created container app '{name}'")
    _write_result({"status": "succeeded", "outputs": _outputs(app)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
