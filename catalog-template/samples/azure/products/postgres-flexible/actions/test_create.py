"""Tests for azure/postgres-flexible's create action, with the Azure clients
mocked, so they run without an Azure subscription. `./vennir catalog check` runs
them in the product's own image with its python3 (unittest, no pytest), so
they also prove the SDK's names the action imports exist.
"""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from azure.core.exceptions import ResourceNotFoundError

_MODULE_PATH = Path(__file__).parent / "create.py"
SERVER = SimpleNamespace(name="orders-db", fully_qualified_domain_name="orders-db.postgres.database.azure.com", id="/servers/orders-db")
INPUTS = {
    "subscriptionId": "00000000-0000-0000-0000-000000000000", "resourceGroup": "orders",
    "serverName": "orders-db", "location": "westeurope", "tenantId": "11111111-1111-1111-1111-111111111111",
    "adminObjectId": "22222222-2222-2222-2222-222222222222", "adminName": "orders-db-admins",
}

CLIENT_ID = "33333333-3333-3333-3333-333333333333"
TENANT_ID = "11111111-1111-1111-1111-111111111111"


def _load_create_module():
    spec = importlib.util.spec_from_file_location("azure_postgres_flexible_create", _MODULE_PATH)
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
            patch.object(self.module, "PostgreSQLManagementClient") as client_cls,
        ):
            client = client_cls.return_value
            configure(client)
            exit_code = self.module.main()
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text()), client

    def test_missing_input_fails_without_calling_azure(self) -> None:
        for inputs in ({"serverName": "orders-db"}, {**INPUTS, "adminType": "Robot"}):
            self.module.INPUT_PATH.write_text(json.dumps({"inputs": inputs}))
            with patch.object(self.module, "PostgreSQLManagementClient") as client_cls:
                self.assertEqual(self.module.main(), 1)
            client_cls.assert_not_called()

    def test_an_existing_server_keeps_its_settings_and_gets_the_admin(self) -> None:
        def configure(client):
            client.servers.get.return_value = SERVER
        exit_code, result, client = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 0)
        client.servers.begin_create_or_update.assert_not_called()
        client.administrators_microsoft_entra.begin_create_or_update.assert_called_once()
        self.assertEqual(result["outputs"]["fqdn"], "orders-db.postgres.database.azure.com")

    def test_a_new_server_has_no_password_and_no_public_access(self) -> None:
        def configure(client):
            client.servers.get.side_effect = ResourceNotFoundError("no server")
            client.servers.begin_create_or_update.return_value.result.return_value = SERVER
        exit_code, _, client = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 0)
        server = client.servers.begin_create_or_update.call_args.args[2]
        self.assertEqual(server.auth_config.password_auth, "Disabled")
        self.assertEqual(server.auth_config.active_directory_auth, "Enabled")
        self.assertIsNone(server.administrator_login_password)
        self.assertEqual(server.network.public_network_access, "Disabled")


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
        with patch.object(self.module, "PostgreSQLManagementClient") as client_cls:
            self.assertEqual(self.module.main(), 1)
        client_cls.assert_not_called()
        error = json.loads(self.module.OUTPUT_PATH.read_text())["error"]
        self.assertEqual((error["code"], error["retryable"]), ("NO_TOKEN", False))

    def test_off_aks_the_tenant_comes_from_its_identity(self) -> None:
        self._own_identity(token=True)
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {k: v for k, v in INPUTS.items() if k != "tenantId"}}))
        with (
            patch.object(self.module, "WorkloadIdentityCredential"),
            patch.object(self.module, "PostgreSQLManagementClient") as client_cls,
        ):
            client_cls.return_value.servers.get.return_value = SERVER
            self.assertEqual(self.module.main(), 0)
        admin = client_cls.return_value.administrators_microsoft_entra.begin_create_or_update.call_args.args[3]
        self.assertEqual(admin.tenant_id, TENANT_ID)


if __name__ == "__main__":
    unittest.main()
