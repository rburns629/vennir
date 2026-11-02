"""Tests for gcp/app-hosting's delete action (its cleanup), with the Cloud
Run client mocked: only a service create deployed is deleted; one already
gone succeeds.
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_MODULE_PATH = Path(__file__).parent / "delete.py"
PATH = "projects/my-project/locations/us-central1/services/hello-world"


def _load():
    spec = importlib.util.spec_from_file_location("gcp_app_hosting_delete", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeleteActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, resource: dict, service: object = None, *, get_error: Exception | None = None):
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {"resource": resource}}))
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client = client_cls.return_value
            if get_error:
                client.get_service.side_effect = get_error
            else:
                client.get_service.return_value = service
            code = self.module.main()
        return code, json.loads(self.module.OUTPUT_PATH.read_text()), client

    def test_a_service_it_deployed_is_deleted(self) -> None:
        code, result, client = self._run({"type": "gcp/cloud-run-service", "id": PATH}, MagicMock(labels={"vertra-made": "true"}))
        self.assertEqual(code, 0)
        client.delete_service.assert_called_once_with(name=PATH)
        self.assertEqual(result["outputs"], {"deleted": PATH})

    def test_one_deployed_some_other_way_is_refused(self) -> None:
        code, result, client = self._run({"type": "gcp/cloud-run-service", "id": PATH}, MagicMock(labels={}))
        self.assertEqual((code, result["error"]["code"]), (1, "NOT_MADE_BY_VERTRA"))
        client.delete_service.assert_not_called()

    def test_one_already_gone_succeeds(self) -> None:
        code, _, client = self._run({"type": "gcp/cloud-run-service", "id": PATH}, get_error=self.module.NotFound("gone"))
        self.assertEqual(code, 0)
        client.delete_service.assert_not_called()

    def test_needs_a_service_path(self) -> None:
        code, result, _ = self._run({"type": "gcp/cloud-run-service", "id": "projects/x/../../etc"})
        self.assertEqual((code, result["error"]["code"]), (1, "MISSING_INPUT"))

    def test_impersonation_refused_writes_a_result(self) -> None:
        code, result, _ = self._run({"type": "gcp/cloud-run-service", "id": PATH}, get_error=self.module.google.auth.exceptions.RefreshError("denied"))
        self.assertEqual((code, result["error"]["code"], result["error"]["retryable"]), (1, "GCP_SIGN_IN_FAILED", False))

    def test_a_delete_still_running_when_the_wait_ends_is_retried(self) -> None:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {"resource": {"type": "gcp/cloud-run-service", "id": PATH}}}))
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client_cls.return_value.get_service.return_value = MagicMock(labels={"vertra-made": "true"})
            client_cls.return_value.delete_service.return_value.result.side_effect = TimeoutError()
            self.assertEqual(self.module.main(), 1)
        error = json.loads(self.module.OUTPUT_PATH.read_text())["error"]
        self.assertEqual((error["code"], error["retryable"]), ("GCP_TIMEOUT", True))


if __name__ == "__main__":
    unittest.main()
