"""Tests for azure/container-app's create action, with the Azure clients
mocked, so they run without an Azure subscription. `./vennir catalog check` runs
them in the product's own image with its python3 (unittest, no pytest).
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
APP = SimpleNamespace(
    name="web", id="/subscriptions/s/apps/web",
    configuration=SimpleNamespace(ingress=SimpleNamespace(fqdn="web.internal.example.azurecontainerapps.io")),
)
INPUTS = {
    "subscriptionId": "00000000-0000-0000-0000-000000000000", "resourceGroup": "orders",
    "environmentName": "orders-env", "appName": "web", "image": "mcr.microsoft.com/k8se/quickstart:latest",
    "location": "westeurope",
}


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


if __name__ == "__main__":
    unittest.main()
