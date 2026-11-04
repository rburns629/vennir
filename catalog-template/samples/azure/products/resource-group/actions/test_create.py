"""Tests for azure/resource-group's create action, with the Azure clients
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

from azure.core.exceptions import ClientAuthenticationError, HttpResponseError

_MODULE_PATH = Path(__file__).parent / "create.py"
GROUP = SimpleNamespace(name="orders", location="westeurope", id="/subscriptions/s/resourceGroups/orders")
INPUTS = {"subscriptionId": "00000000-0000-0000-0000-000000000000", "name": "orders", "location": "westeurope"}


def _load_create_module():
    spec = importlib.util.spec_from_file_location("azure_resource_group_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _http_error(status: int) -> HttpResponseError:
    error = HttpResponseError(message="test")
    error.status_code = status
    return error


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
            patch.object(self.module, "ResourceManagementClient") as client_cls,
        ):
            groups = client_cls.return_value.resource_groups
            configure(groups)
            exit_code = self.module.main()
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text()), groups

    def test_missing_input_fails_without_calling_azure(self) -> None:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {"name": "orders"}}))
        with patch.object(self.module, "ResourceManagementClient") as client_cls:
            self.assertEqual(self.module.main(), 1)
        client_cls.assert_not_called()

    def test_an_existing_group_is_left_alone(self) -> None:
        def configure(groups):
            groups.check_existence.return_value = True
            groups.get.return_value = GROUP
        exit_code, result, groups = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["outputs"]["resourceGroup"], "orders")
        groups.create_or_update.assert_not_called()

    def test_a_missing_group_is_created(self) -> None:
        def configure(groups):
            groups.check_existence.return_value = False
            groups.create_or_update.return_value = GROUP
        exit_code, _, groups = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 0)
        groups.create_or_update.assert_called_once()
        self.assertEqual(groups.create_or_update.call_args.args[1]["location"], "westeurope")

    def test_errors_are_classified(self) -> None:
        for error, code, retryable in (
            (_http_error(429), "AZURE_API_ERROR", True),
            (_http_error(403), "AZURE_API_ERROR", False),
            (ClientAuthenticationError(message="no identity"), "AZURE_AUTH_FAILED", False),
        ):
            def configure(groups, error=error):
                groups.check_existence.side_effect = error
            _, result, _ = self._run(INPUTS, configure)
            self.assertEqual((result["error"]["code"], result["error"]["retryable"]), (code, retryable))


if __name__ == "__main__":
    unittest.main()
