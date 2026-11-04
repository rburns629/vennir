"""Tests for gcp/cloud-sql's check action, with Google mocked, so they run
without a GCP account. `./vennir catalog check` runs them in the product's
own image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_MODULE_PATH = Path(__file__).parent / "check.py"
ALL = ["cloudsql.instances.get", "cloudsql.instances.create", "cloudsql.instances.delete"]


def _load_check_module():
    spec = importlib.util.spec_from_file_location("gcp_cloud_sql_check", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CheckActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_check_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"
        self.module.TARGET_SERVICE_ACCOUNT_FILE = Path(self.tmp_dir.name) / "service-account"
        self.source = MagicMock(service_account_email="my-project.svc.id.goog")
        patcher = patch.object(self.module.google.auth, "default", return_value=(self.source, "my-project"))
        self.default = patcher.start()
        self.addCleanup(patcher.stop)
        # Patched rather than discovery.build, as in test_create.py.
        service_patcher = patch.object(self.module, "_build_service")
        self.projects = service_patcher.start().return_value.projects.return_value
        self.addCleanup(service_patcher.stop)

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, projects: list[str], held: dict[str, list[str]]):
        self.projects.search.return_value.execute.return_value = {"projects": [{"projectId": p} for p in projects]}

        def test_iam_permissions(resource, body):
            permissions = held.get(resource.removeprefix("projects/"))
            call = MagicMock()
            call.execute.return_value = {"permissions": permissions} if permissions else {}
            return call

        self.projects.testIamPermissions.side_effect = test_iam_permissions
        exit_code = self.module.main()
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text())

    def test_ready_when_it_may_make_instances_in_a_project(self) -> None:
        exit_code, result = self._run(["db-1", "db-2"], {"db-2": ALL})
        self.assertEqual(exit_code, 0)
        self.assertTrue(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["missing"], [])
        self.assertIn("db-2", result["outputs"]["detail"])
        self.assertEqual(
            result["outputs"]["principal"],
            "Kubernetes ServiceAccount gcp-cloud-sql, by Workload Identity (my-project.svc.id.goog)",
        )
        self.source.refresh.assert_called_once()  # it really signed in

    def test_names_the_project_it_came_closest_in(self) -> None:
        _, result = self._run(["db-1"], {"db-1": ["cloudsql.instances.get"]})
        self.assertFalse(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["missing"], ["roles/cloudsql.admin on project db-1"])

    def test_not_ready_when_it_sees_no_project(self) -> None:
        _, result = self._run([], {})
        self.assertEqual(result["outputs"]["missing"], ["roles/cloudsql.admin on a project its instances go in"])

    def test_without_workload_identity_it_is_not_ready(self) -> None:
        self.default.side_effect = self.module.google.auth.exceptions.DefaultCredentialsError("none")
        exit_code, result = self._run([], {})
        self.assertEqual(exit_code, 0)
        self.assertFalse(result["outputs"]["ready"])
        self.assertIn("Workload Identity", result["outputs"]["missing"][0])

    def test_impersonation_it_may_not_do_is_missing_token_creator(self) -> None:
        target = "acts-as@my-project.iam.gserviceaccount.com"
        self.module.TARGET_SERVICE_ACCOUNT_FILE.write_text(target + "\n")
        with patch.object(self.module.impersonated_credentials, "Credentials") as creds_cls:
            creds_cls.return_value.refresh.side_effect = self.module.google.auth.exceptions.RefreshError("denied")
            _, result = self._run([], {})
        self.assertEqual(
            result["outputs"]["missing"],
            [f"roles/iam.serviceAccountTokenCreator on {target}, for ServiceAccount gcp-cloud-sql"],
        )

    def test_an_api_error_is_a_failure_not_an_answer(self) -> None:
        resp = MagicMock()
        resp.status = 503
        self.projects.search.return_value.execute.side_effect = self.module.HttpError(resp, b"{}")
        self.assertEqual(self.module.main(), 1)
        result = json.loads(self.module.OUTPUT_PATH.read_text())
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertTrue(result["error"]["retryable"])


if __name__ == "__main__":
    unittest.main()
