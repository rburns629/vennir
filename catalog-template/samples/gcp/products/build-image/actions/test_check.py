"""Tests for gcp/build-image's check action, with Google mocked, so they
run without a GCP account. `./vennir catalog check` runs them in the
product's own image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_MODULE_PATH = Path(__file__).parent / "check.py"
ALL = ["cloudbuild.builds.create", "cloudbuild.builds.get", "cloudbuild.builds.list"]


def _load_check_module():
    spec = importlib.util.spec_from_file_location("gcp_build_image_check", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _response(body: dict, status: int = 200):
    response = MagicMock(status_code=status)
    response.json.return_value = body
    return response


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

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, projects: list[str], held: dict[str, list[str]]):
        def request(method, url, **kwargs):
            if url.endswith("projects:search"):
                return _response({"projects": [{"projectId": p, "name": "projects/1"} for p in projects]})
            project = url.split("/projects/")[1].split(":")[0]
            return _response({"permissions": held.get(project, [])} if held.get(project) else {})

        with patch.object(self.module, "AuthorizedSession") as session_cls:
            session_cls.return_value.request.side_effect = request
            exit_code = self.module.main()
        self.session = session_cls.return_value
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text())

    def test_ready_when_it_may_build_in_a_project(self) -> None:
        exit_code, result = self._run(["web-1", "web-2"], {"web-2": ALL})
        self.assertEqual(exit_code, 0)
        self.assertTrue(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["missing"], [])
        self.assertIn("web-2", result["outputs"]["detail"])
        self.assertEqual(
            result["outputs"]["principal"],
            "Kubernetes ServiceAccount gcp-build-image, by Workload Identity (my-project.svc.id.goog)",
        )
        self.source.refresh.assert_called_once()  # it really signed in
        # Only asks: a search and testIamPermissions, nothing else.
        for call in self.session.request.call_args_list:
            self.assertTrue(call.args[1].endswith((":search", ":testIamPermissions")))

    def test_not_ready_when_it_sees_no_project(self) -> None:
        _, result = self._run([], {})
        self.assertFalse(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["missing"], ["roles/cloudbuild.builds.editor on a project it builds in"])

    def test_names_the_project_it_came_closest_in(self) -> None:
        _, result = self._run(["web-1", "web-2"], {"web-2": ["cloudbuild.builds.get"]})
        self.assertFalse(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["missing"], ["roles/cloudbuild.builds.editor on project web-2"])

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
            [f"roles/iam.serviceAccountTokenCreator on {target}, for ServiceAccount gcp-build-image"],
        )

    def test_an_api_error_is_a_failure_not_an_answer(self) -> None:
        error = self.module.requests.HTTPError("503", response=MagicMock(status_code=503))
        with patch.object(self.module, "AuthorizedSession") as session_cls:
            session_cls.return_value.request.return_value.raise_for_status.side_effect = error
            self.assertEqual(self.module.main(), 1)
        result = json.loads(self.module.OUTPUT_PATH.read_text())
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertTrue(result["error"]["retryable"])


if __name__ == "__main__":
    unittest.main()
