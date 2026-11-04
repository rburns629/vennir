"""Tests for azure/postgres-flexible's create action, with the Azure clients
mocked, so they run without an Azure subscription. `./vennir catalog check` runs
them in the product's own image with its python3 (unittest, no pytest), so
they also prove the SDK's names the action imports exist.
"""

import importlib.util
import json
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


if __name__ == "__main__":
    unittest.main()
