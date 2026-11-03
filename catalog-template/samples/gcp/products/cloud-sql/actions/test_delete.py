"""Tests for gcp/cloud-sql's delete action (its cleanup), with the Cloud SQL
Admin API mocked: only an instance create made is deleted, and waited for;
one already gone succeeds.
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_MODULE_PATH = Path(__file__).parent / "delete.py"
CONNECTION = "demo-project:us-central1:orders-db"
# An instance create made for team web.
MADE_FOR_WEB = {"settings": {"userLabels": {"vertra-made": "true", "vertra-team": "web"}}}


def _load():
    spec = importlib.util.spec_from_file_location("gcp_cloud_sql_delete", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _http_error(status: int) -> Exception:
    resp = MagicMock()
    resp.status = status
    return __import__("googleapiclient.errors", fromlist=["HttpError"]).HttpError(resp, b"{}")


class DeleteActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"
        build = patch.object(self.module.discovery, "build")
        self.service = build.start().return_value
        self.addCleanup(build.stop)

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, resource: dict, team: str | None = "web") -> tuple[int, dict]:
        request: dict = {"inputs": {"resource": resource}}
        if team:
            request["forTeam"] = team
        self.module.INPUT_PATH.write_text(json.dumps(request))
        with patch.object(self.module.time, "sleep"):
            code = self.module.main()
        return code, json.loads(self.module.OUTPUT_PATH.read_text())

    def test_an_instance_it_made_is_deleted_and_waited_for(self) -> None:
        self.service.instances.return_value.get.return_value.execute.return_value = MADE_FOR_WEB
        self.service.instances.return_value.delete.return_value.execute.return_value = {"name": "op-1"}
        self.service.operations.return_value.get.return_value.execute.return_value = {"status": "DONE"}
        code, result = self._run({"type": "gcp/cloud-sql-instance", "id": CONNECTION})
        self.assertEqual(code, 0)
        self.service.instances.return_value.delete.assert_called_once_with(project="demo-project", instance="orders-db")
        self.assertEqual(result["outputs"], {"deleted": CONNECTION})

    def test_a_delete_still_finishing_is_reported_done(self) -> None:
        self.service.instances.return_value.get.return_value.execute.return_value = MADE_FOR_WEB
        self.service.instances.return_value.delete.return_value.execute.return_value = {"name": "op-1"}
        self.service.operations.return_value.get.return_value.execute.return_value = {"status": "RUNNING"}
        self.module.OPERATION_TIMEOUT_SECONDS = 0
        code, result = self._run({"type": "gcp/cloud-sql-instance", "id": CONNECTION})
        self.assertEqual((code, result["outputs"]), (0, {"deleted": CONNECTION, "finishing": True}))

    def test_one_made_some_other_way_is_refused(self) -> None:
        self.service.instances.return_value.get.return_value.execute.return_value = {"settings": {}}
        code, result = self._run({"type": "gcp/cloud-sql-instance", "id": CONNECTION})
        self.assertEqual((code, result["error"]["code"]), (1, "NOT_MADE_BY_VERTRA"))
        self.service.instances.return_value.delete.assert_not_called()

    def test_one_made_for_another_team_is_refused(self) -> None:
        self.service.instances.return_value.get.return_value.execute.return_value = MADE_FOR_WEB
        code, result = self._run({"type": "gcp/cloud-sql-instance", "id": CONNECTION}, team="data")
        self.assertEqual((code, result["error"]["code"]), (1, "NOT_THIS_TEAMS"))
        self.service.instances.return_value.delete.assert_not_called()

    def test_a_request_without_a_team_is_refused(self) -> None:
        code, result = self._run({"type": "gcp/cloud-sql-instance", "id": CONNECTION}, team=None)
        self.assertEqual((code, result["error"]["code"]), (1, "MISSING_TEAM"))
        self.service.instances.assert_not_called()

    def test_one_already_gone_succeeds(self) -> None:
        self.service.instances.return_value.get.return_value.execute.side_effect = _http_error(404)
        code, _ = self._run({"type": "gcp/cloud-sql-instance", "id": CONNECTION})
        self.assertEqual(code, 0)
        self.service.instances.return_value.delete.assert_not_called()

    def test_needs_a_connection_name(self) -> None:
        code, result = self._run({"type": "gcp/cloud-sql-instance", "id": "orders-db"})
        self.assertEqual((code, result["error"]["code"]), (1, "MISSING_INPUT"))

    def test_a_call_unanswered_is_retried(self) -> None:
        self.service.instances.return_value.get.return_value.execute.side_effect = TimeoutError("timed out")
        code, result = self._run({"type": "gcp/cloud-sql-instance", "id": CONNECTION})
        self.assertEqual((code, result["error"]["code"], result["error"]["retryable"]), (1, "GCP_TIMEOUT", True))


if __name__ == "__main__":
    unittest.main()
