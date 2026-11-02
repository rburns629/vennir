"""Tests for gcp/project's delete action (its cleanup), with the Google Cloud
client mocked: only a project create made is shut down; one already gone or
shutting down succeeds.
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_MODULE_PATH = Path(__file__).parent / "delete.py"


def _load():
    spec = importlib.util.spec_from_file_location("gcp_project_delete", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeleteActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"
        # Signed in as whatever ADC finds: a stand-in whose refresh passes,
        # unless a test makes it fail.
        self.adc = MagicMock()
        default = patch.object(self.module.google.auth, "default", return_value=(self.adc, "some-project"))
        default.start()
        self.addCleanup(default.stop)

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, resource: dict, project: object = None, *, get_error: Exception | None = None) -> tuple[int, dict, MagicMock]:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {"resource": resource}}))
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client = client_cls.return_value
            if get_error:
                client.get_project.side_effect = get_error
            else:
                client.get_project.return_value = project
            code = self.module.main()
        return code, json.loads(self.module.OUTPUT_PATH.read_text()), client

    def made(self, state=None) -> MagicMock:
        return MagicMock(labels={"vertra-made": "true"}, state=state or self.module.resourcemanager_v3.Project.State.ACTIVE)

    def test_a_project_it_made_is_shut_down(self) -> None:
        code, result, client = self._run({"type": "gcp/project", "id": "web-1"}, self.made())
        self.assertEqual(code, 0)
        client.delete_project.assert_called_once_with(name="projects/web-1")
        self.assertEqual(result, {"status": "succeeded", "outputs": {"deleted": "web-1"}})

    def test_a_project_made_some_other_way_is_refused(self) -> None:
        code, result, client = self._run({"type": "gcp/project", "id": "prod"}, MagicMock(labels={}, state=1))
        self.assertEqual(code, 1)
        client.delete_project.assert_not_called()
        self.assertEqual(result["error"]["code"], "NOT_MADE_BY_VERTRA")

    def test_one_already_gone_or_shutting_down_succeeds(self) -> None:
        code, _, client = self._run({"type": "gcp/project", "id": "gone"}, get_error=self.module.NotFound("gone"))
        self.assertEqual(code, 0)
        client.delete_project.assert_not_called()
        # Purged, or not this product's to see: may still exist, so not done.
        code, result, client = self._run({"type": "gcp/project", "id": "hidden"}, get_error=self.module.PermissionDenied("denied"))
        self.assertEqual((code, result["error"]["code"]), (1, "PROJECT_NOT_VISIBLE"))
        client.delete_project.assert_not_called()
        code, _, client = self._run({"type": "gcp/project", "id": "going"}, self.made(self.module.resourcemanager_v3.Project.State.DELETE_REQUESTED))
        self.assertEqual(code, 0)
        client.delete_project.assert_not_called()

    def test_needs_the_resource(self) -> None:
        code, result, _ = self._run({"type": "gcp/bucket", "id": "x"})
        self.assertEqual((code, result["error"]["code"]), (1, "MISSING_INPUT"))

    def test_impersonation_refused_writes_a_result(self) -> None:
        self.adc.refresh.side_effect = self.module.google.auth.exceptions.RefreshError("denied")
        code, result, client = self._run({"type": "gcp/project", "id": "made-here"})
        self.assertEqual(client.method_calls, [])
        self.assertEqual((code, result["error"]["code"], result["error"]["retryable"]), (1, "GCP_SIGN_IN_FAILED", False))


if __name__ == "__main__":
    unittest.main()
