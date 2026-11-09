#!/usr/bin/env python3
"""azure/container-app's "create" action: deploys a container image as an
Azure Container App, or returns the existing app's URL if one of that name
exists. Creates the Container Apps environment it runs in if that doesn't
exist yet. Never builds an image: `image` is a registry reference.

Ingress is internal to the environment unless `public` is true. With
`entraAuth`, Container Apps' built-in authentication answers 401 to every
request without a Microsoft Entra token for the given app registration from
one of the allowed applications, before it reaches the container: an API
behind the gateway's entraToken. Images from
a private registry (Azure Container Registry) are pulled with a managed
identity (`registryIdentity`), never a password. Credentials as in the azure
team's README.md: Workload Identity on AKS, and off AKS its own managed
identity (the team secret azure-container-app-identity) by federation.
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
from azure.mgmt.appcontainers import ContainerAppsAPIClient
from azure.mgmt.appcontainers.models import (
    AuthConfig,
    AuthConfigProperties,
    AuthPlatform,
    AzureActiveDirectory,
    AzureActiveDirectoryRegistration,
    AzureActiveDirectoryValidation,
    Configuration,
    Container,
    ContainerApp,
    ContainerResources,
    DefaultAuthorizationPolicy,
    EnvironmentVar,
    GlobalValidation,
    IdentityProviders,
    Ingress,
    ManagedEnvironment,
    RegistryCredentials,
    Template,
)

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

# Off AKS (GKE, EKS), with no Workload Identity webhook: this product's own
# managed identity, named by the team secret azure-container-app-identity
# (keys client-id and tenant-id), signed in to with the step's own token
# (product.yaml's tokenAudiences). The identity's federated credential
# trusts this cluster's issuer for this product's ServiceAccount alone (see
# the azure team's README.md, Azure from another cluster).
OWN_IDENTITY = Path("/platform/secrets/azure-container-app-identity")
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
        retryable = status in (408, 429) or status >= 500
        return _failure("AZURE_API_ERROR", f"{code}: {error.message}", retryable=retryable)
    if isinstance(error, ServiceRequestError):
        return _failure("AZURE_API_ERROR", str(error), retryable=True)
    raise error


def _outputs(app: Any) -> dict[str, Any]:
    ingress = app.configuration.ingress if app.configuration else None
    fqdn = ingress.fqdn if ingress else None
    return {"appName": app.name, "url": f"https://{fqdn}" if fqdn else "", "id": app.id}


def _require_entra(client: Any, group: str, name: str, auth: dict[str, Any]) -> None:
    """Turns on the app's built-in authentication: a v2 Entra token whose
    audience is the app registration auth["clientId"], from one of
    auth["allowedApplications"], or 401. Setting it again changes nothing."""
    client_id = auth["clientId"]
    client.container_apps_auth_configs.create_or_update(group, name, "current", AuthConfig(
        properties=AuthConfigProperties(
            platform=AuthPlatform(enabled=True),
            global_validation=GlobalValidation(unauthenticated_client_action="Return401"),
            identity_providers=IdentityProviders(azure_active_directory=AzureActiveDirectory(
                enabled=True,
                registration=AzureActiveDirectoryRegistration(
                    client_id=client_id,
                    open_id_issuer=f"https://login.microsoftonline.com/{auth['tenantId']}/v2.0",
                ),
                validation=AzureActiveDirectoryValidation(
                    # A v2 token's audience is the client id; api://<client id>
                    # too, for an app registration still issuing v1 tokens.
                    allowed_audiences=[client_id, f"api://{client_id}"],
                    default_authorization_policy=DefaultAuthorizationPolicy(
                        allowed_applications=list(auth["allowedApplications"])
                    ),
                ),
            )),
        )
    ))
    print(f"container app '{name}' requires an Entra token for {client_id}")


def main() -> int:
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})
    required = ("subscriptionId", "resourceGroup", "environmentName", "appName", "image", "location")
    missing = [key for key in required if not inputs.get(key)]
    if missing:
        return _failure("MISSING_INPUT", "inputs." + ", inputs.".join(missing) + " required")
    environment = inputs.get("environment") or {}
    if not all(isinstance(v, str) for v in environment.values()):
        return _failure("INVALID_INPUT", "inputs.environment values must be strings")
    entra = inputs.get("entraAuth")
    if entra is not None and not (entra.get("tenantId") and entra.get("clientId") and entra.get("allowedApplications")):
        return _failure("INVALID_INPUT", "inputs.entraAuth needs tenantId, clientId and allowedApplications")
    group, name, location = inputs["resourceGroup"], inputs["appName"], inputs["location"]

    try:
        client = ContainerAppsAPIClient(_credential(), inputs["subscriptionId"])
        try:
            app = client.container_apps.get(group, name)
            # Its authentication again, in case an earlier attempt made the
            # app and stopped before it was on; nothing else is changed.
            print(f"container app '{name}' already exists, leaving it as it is"
                  + (", but for its Entra authentication, set again" if entra else ""))
            if entra:
                _require_entra(client, group, name, entra)
            _write_result({"status": "succeeded", "outputs": _outputs(app)})
            return 0
        except ResourceNotFoundError:
            pass

        try:
            managed_environment = client.managed_environments.get(group, inputs["environmentName"])
        except ResourceNotFoundError:
            print(f"creating Container Apps environment '{inputs['environmentName']}'")
            # With a property set: Azure refuses an environment sent with no
            # properties at all, as the SDK sends one with none set (seen
            # 2026-11-08). One zone, the default anyway.
            managed_environment = client.managed_environments.begin_create_or_update(
                group, inputs["environmentName"], ManagedEnvironment(location=location, zone_redundant=False)
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
        if entra:
            _require_entra(client, group, name, entra)
    except (HttpResponseError, ServiceRequestError, _NoToken) as error:
        return _azure_failure(error)

    print(f"created container app '{name}'")
    _write_result({"status": "succeeded", "outputs": _outputs(app)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
