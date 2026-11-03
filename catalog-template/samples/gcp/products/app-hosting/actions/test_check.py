"""Tests for gcp/app-hosting's check action, with Google mocked, so they
run without a GCP account. `./vertra catalog check` runs them in the
product's own image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_MODULE_PATH = Path(__file__).parent / "check.py"
ALL = ["run.services.get", "run.services.create", "run.services.delete"]
RUNTIME = "web-runtime@my-project.iam.gserviceaccount.com"


def _load_check_module():
    spec = importlib.util.spec_from_file_location("gcp_app_hosting_check", _MODULE_PATH)
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
        # The team's secret app-hosting, mounted.
        self.module.SETTINGS_DIR = Path(self.tmp_dir.name) / "app-hosting"
        self.module.SETTINGS_DIR.mkdir()
        (self.module.SETTINGS_DIR / "image-registry").write_text("us-central1-docker.pkg.dev/my-project/demo\n")
        (self.module.SETTINGS_DIR / "runtime-service-account").write_text(RUNTIME + "\n")
        self.source = MagicMock(service_account_email="my-project.svc.id.goog")
        patcher = patch.object(self.module.google.auth, "default", return_value=(self.source, "my-project"))
        self.default = patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, projects: list[str], held: dict[str, list[str]], act_as=_response({"permissions": ["iam.serviceAccounts.actAs"]})):
        def request(method, url, **kwargs):
            if url.endswith("projects:search"):
                return _response({"projects": [{"projectId": p, "name": "projects/42"} for p in projects]})
            if url.startswith(self.module.IAM):
                self.assertIn(f"/projects/-/serviceAccounts/{RUNTIME}:testIamPermissions", url)
                return act_as
            project = url.split("/projects/")[1].split(":")[0]
            return _response({"permissions": held[project]} if held.get(project) else {})

        with patch.object(self.module, "AuthorizedSession") as session_cls:
            session_cls.return_value.request.side_effect = request
            exit_code = self.module.main()
        self.session = session_cls.return_value
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text())

    def test_ready_when_it_may_deploy_and_act_as_the_runtime_account(self) -> None:
        exit_code, result = self._run(["web-1"], {"web-1": ALL})
        self.assertEqual(exit_code, 0)
        self.assertTrue(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["missing"], [])
        self.assertEqual(
            result["outputs"]["principal"],
            "Kubernetes ServiceAccount gcp-app-hosting, by Workload Identity (my-project.svc.id.goog)",
        )
        self.source.refresh.assert_called_once()  # it really signed in
        # Only asks: a search and testIamPermissions, nothing else.
        for call in self.session.request.call_args_list:
            self.assertTrue(call.args[1].endswith((":search", ":testIamPermissions")))

    def test_names_run_developer_when_it_may_not_deploy(self) -> None:
        _, result = self._run(["web-1"], {"web-1": ["run.services.get"]})
        self.assertFalse(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["missing"], ["roles/run.developer on project web-1"])

    def test_not_ready_when_it_sees_no_project(self) -> None:
        _, result = self._run([], {})
        self.assertEqual(result["outputs"]["missing"], ["roles/run.developer on a project it deploys to"])

    def test_names_service_account_user_when_it_may_not_act_as_the_runtime_account(self) -> None:
        for act_as in (_response({}), _response({}, status=403), _response({}, status=404)):
            _, result = self._run(["web-1"], {"web-1": ALL}, act_as=act_as)
            self.assertFalse(result["outputs"]["ready"])
            self.assertEqual(
                result["outputs"]["missing"],
                [f"roles/iam.serviceAccountUser on {RUNTIME} (the team's Cloud Run runtime account)"],
            )

    def test_not_ready_without_the_team_secret(self) -> None:
        for key in ("image-registry", "runtime-service-account"):
            with self.subTest(missing=key):
                value = (self.module.SETTINGS_DIR / key).read_text()
                (self.module.SETTINGS_DIR / key).unlink()
                exit_code, result = self._run(["web-1"], {"web-1": ALL})
                (self.module.SETTINGS_DIR / key).write_text(value)
                self.assertEqual(exit_code, 0)
                self.assertFalse(result["outputs"]["ready"])
                self.assertEqual(
                    result["outputs"]["missing"],
                    ["the team secret app-hosting, with image-registry and runtime-service-account"],
                )

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
            [f"roles/iam.serviceAccountTokenCreator on {target}, for ServiceAccount gcp-app-hosting"],
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
