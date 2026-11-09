"""Tests for azure/container-app's create action, with the Azure clients
mocked, so they run without an Azure subscription. `./vennir catalog check` runs
them in the product's own image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from azure.core.exceptions import ClientAuthenticationError, ResourceNotFoundError

_MODULE_PATH = Path(__file__).parent / "create.py"
APP = SimpleNamespace(
    name="web", id="/subscriptions/s/apps/web",
    configuration=SimpleNamespace(ingress=SimpleNamespace(fqdn="web.internal.example.azurecontainerapps.io")),
)
INPUTS = {
    "subscriptionId": "00000000-0000-0000-0000-000000000000", "resourceGroup": "orders",
    "environmentName": "orders-env", "appName": "web", "image": "mcr.microsoft.com/k8se/quickstart:latest",
    "location": "westeurope",
}

CLIENT_ID = "33333333-3333-3333-3333-333333333333"
TENANT_ID = "11111111-1111-1111-1111-111111111111"
GATEWAY_ID = "44444444-4444-4444-4444-444444444444"


def _load_create_module():
    spec = importlib.util.spec_from_file_location("azure_container_app_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CreateActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"
        self.module.OWN_IDENTITY = Path(self.tmp_dir.name) / "identity"

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, inputs: dict, configure) -> tuple[int, dict, object]:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": inputs}))
        with (
            patch.object(self.module, "DefaultAzureCredential"),
            patch.object(self.module, "ContainerAppsAPIClient") as client_cls,
        ):
            client = client_cls.return_value
            configure(client)
            exit_code = self.module.main()
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text()), client

    def test_missing_input_fails_without_calling_azure(self) -> None:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {"appName": "web"}}))
        with patch.object(self.module, "ContainerAppsAPIClient") as client_cls:
            self.assertEqual(self.module.main(), 1)
        client_cls.assert_not_called()

    def test_an_existing_app_is_left_alone(self) -> None:
        def configure(client):
            client.container_apps.get.return_value = APP
        exit_code, result, client = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["outputs"]["url"], "https://web.internal.example.azurecontainerapps.io")
        client.container_apps.begin_create_or_update.assert_not_called()

    def test_a_new_app_gets_its_environment_and_is_internal_by_default(self) -> None:
        def configure(client):
            client.container_apps.get.side_effect = ResourceNotFoundError("no app")
            client.managed_environments.get.side_effect = ResourceNotFoundError("no environment")
            client.managed_environments.begin_create_or_update.return_value.result.return_value = SimpleNamespace(id="/env")
            client.container_apps.begin_create_or_update.return_value.result.return_value = APP
        exit_code, _, client = self._run({**INPUTS, "environment": {"MODE": "demo"}}, configure)
        self.assertEqual(exit_code, 0)
        client.managed_environments.begin_create_or_update.assert_called_once()
        app = client.container_apps.begin_create_or_update.call_args.args[2]
        self.assertFalse(app.configuration.ingress.external)
        self.assertEqual(app.managed_environment_id, "/env")
        self.assertEqual(app.template.containers[0].env[0].name, "MODE")
        client.container_apps_auth_configs.create_or_update.assert_not_called()

    def test_a_private_registry_pulls_as_an_identity_the_app_is_given(self) -> None:
        pull = "/subscriptions/s/resourceGroups/g/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull"
        def configure(client):
            client.container_apps.get.side_effect = ResourceNotFoundError("no app")
            client.managed_environments.get.return_value = SimpleNamespace(id="/env")
            client.container_apps.begin_create_or_update.return_value.result.return_value = APP
        exit_code, _, client = self._run({**INPUTS, "registryServer": "r.azurecr.io", "registryIdentity": pull}, configure)
        self.assertEqual(exit_code, 0)
        app = client.container_apps.begin_create_or_update.call_args.args[2]
        self.assertEqual((app.configuration.registries[0].server, app.configuration.registries[0].identity), ("r.azurecr.io", pull))
        self.assertEqual((app.identity.type, list(app.identity.user_assigned_identities)), ("UserAssigned", [pull]))
        # No registry: no identity.
        exit_code, _, client = self._run(INPUTS, configure)
        app = client.container_apps.begin_create_or_update.call_args.args[2]
        self.assertIsNone(app.identity)
        self.assertIsNone(app.configuration.registries)

    def test_entra_auth_requires_a_token_from_the_allowed_applications(self) -> None:
        entra = {"tenantId": TENANT_ID, "clientId": CLIENT_ID, "allowedApplications": [GATEWAY_ID]}
        def configure(client):
            client.container_apps.get.side_effect = ResourceNotFoundError("no app")
            client.managed_environments.get.return_value = SimpleNamespace(id="/env")
            client.container_apps.begin_create_or_update.return_value.result.return_value = APP
        exit_code, _, client = self._run({**INPUTS, "public": True, "entraAuth": entra}, configure)
        self.assertEqual(exit_code, 0)
        group, name, config_name, config = client.container_apps_auth_configs.create_or_update.call_args.args
        self.assertEqual((group, name, config_name), ("orders", "web", "current"))
        properties = config.properties
        self.assertTrue(properties.platform.enabled)
        self.assertEqual(properties.global_validation.unauthenticated_client_action, "Return401")
        entra_id = properties.identity_providers.azure_active_directory
        self.assertEqual(entra_id.registration.client_id, CLIENT_ID)
        self.assertEqual(entra_id.registration.open_id_issuer, f"https://login.microsoftonline.com/{TENANT_ID}/v2.0")
        self.assertEqual(entra_id.validation.allowed_audiences, [CLIENT_ID, f"api://{CLIENT_ID}"])
        self.assertEqual(entra_id.validation.default_authorization_policy.allowed_applications, [GATEWAY_ID])

    def test_an_existing_app_gets_its_entra_auth_again(self) -> None:
        # An earlier attempt may have made the app and stopped before its
        # authentication was on.
        entra = {"tenantId": TENANT_ID, "clientId": CLIENT_ID, "allowedApplications": [GATEWAY_ID]}
        def configure(client):
            client.container_apps.get.return_value = APP
        exit_code, _, client = self._run({**INPUTS, "entraAuth": entra}, configure)
        self.assertEqual(exit_code, 0)
        client.container_apps.begin_create_or_update.assert_not_called()
        client.container_apps_auth_configs.create_or_update.assert_called_once()

    def test_entra_auth_without_its_fields_fails_without_calling_azure(self) -> None:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {**INPUTS, "entraAuth": {"tenantId": TENANT_ID}}}))
        with patch.object(self.module, "ContainerAppsAPIClient") as client_cls:
            self.assertEqual(self.module.main(), 1)
        client_cls.assert_not_called()


class CredentialTest(unittest.TestCase):
    """Who the action signs in as: Workload Identity's on AKS, and off AKS
    its own managed identity, by federation with the step's token."""

    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp_dir.cleanup)
        tmp = Path(self.tmp_dir.name)
        self.module.INPUT_PATH = tmp / "request.json"
        self.module.OUTPUT_PATH = tmp / "result.json"
        self.module.OWN_IDENTITY = tmp / "identity"
        self.module.TOKEN_FILE = tmp / "token"
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": INPUTS}))
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("AZURE_FEDERATED_TOKEN_FILE", "AZURE_TENANT_ID"):
            os.environ.pop(name, None)

    def _own_identity(self, *, token: bool) -> None:
        self.module.OWN_IDENTITY.mkdir()
        (self.module.OWN_IDENTITY / "client-id").write_text(CLIENT_ID + "\n")
        (self.module.OWN_IDENTITY / "tenant-id").write_text(TENANT_ID + "\n")
        if token:
            self.module.TOKEN_FILE.write_text("a-token")

    def _credential(self) -> tuple[object, object, object]:
        with (
            patch.object(self.module, "DefaultAzureCredential") as default,
            patch.object(self.module, "WorkloadIdentityCredential") as federated,
        ):
            return self.module._credential(), default, federated

    def test_with_no_identity_secret_the_default_signs_in(self) -> None:
        credential, default, federated = self._credential()
        self.assertIs(credential, default.return_value)
        federated.assert_not_called()

    def test_on_aks_the_webhook_wins_over_the_secret(self) -> None:
        self._own_identity(token=True)
        os.environ["AZURE_FEDERATED_TOKEN_FILE"] = "/var/run/secrets/azure/tokens/azure-identity-token"
        credential, default, federated = self._credential()
        self.assertIs(credential, default.return_value)
        federated.assert_not_called()

    def test_off_aks_it_signs_in_as_its_own_identity(self) -> None:
        self._own_identity(token=True)
        credential, default, federated = self._credential()
        self.assertIs(credential, federated.return_value)
        federated.assert_called_once_with(
            tenant_id=TENANT_ID, client_id=CLIENT_ID, token_file_path=str(self.module.TOKEN_FILE)
        )
        default.assert_not_called()

    def test_off_aks_with_no_token_it_fails_without_calling_azure(self) -> None:
        self._own_identity(token=False)
        with patch.object(self.module, "ContainerAppsAPIClient") as client_cls:
            self.assertEqual(self.module.main(), 1)
        client_cls.assert_not_called()
        error = json.loads(self.module.OUTPUT_PATH.read_text())["error"]
        self.assertEqual((error["code"], error["retryable"]), ("NO_TOKEN", False))


    def test_with_neither_webhook_nor_secret_it_says_what_is_missing(self) -> None:
        with (
            patch.object(self.module, "DefaultAzureCredential"),
            patch.object(self.module, "ContainerAppsAPIClient") as client_cls,
        ):
            client_cls.return_value.container_apps.get.side_effect = ClientAuthenticationError(message="no credential")
            self.assertEqual(self.module.main(), 1)
        error = json.loads(self.module.OUTPUT_PATH.read_text())["error"]
        self.assertEqual((error["code"], error["retryable"]), ("NO_IDENTITY", False))
        self.assertIn(self.module.OWN_IDENTITY.name, error["message"])

if __name__ == "__main__":
    unittest.main()
