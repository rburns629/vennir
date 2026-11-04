"""Tests for gcp/project's check action, with Google's clients mocked, so
they run without a GCP account. `./vennir catalog check` runs them in the
product's own image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

_MODULE_PATH = Path(__file__).parent / "check.py"
ALL = ["resourcemanager.projects.get", "resourcemanager.projects.create", "resourcemanager.projects.delete"]


def _load_check_module():
    spec = importlib.util.spec_from_file_location("gcp_project_check", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _held(permissions):
    return SimpleNamespace(permissions=permissions)


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

    def _run(self, folder_permissions=ALL, billing_permissions=("billing.resourceAssociations.create",)):
        with (
            patch.object(self.module.resourcemanager_v3, "FoldersClient") as folders_cls,
            patch.object(self.module.resourcemanager_v3, "OrganizationsClient") as orgs_cls,
            patch.object(self.module, "CloudBillingClient") as billing_cls,
        ):
            folders = folders_cls.return_value
            folders.search_folders.return_value = [SimpleNamespace(name="folders/12")]
            folders.test_iam_permissions.return_value = _held(list(folder_permissions))
            orgs_cls.return_value.search_organizations.return_value = []
            billing = billing_cls.return_value
            billing.list_billing_accounts.return_value = [SimpleNamespace(name="billingAccounts/A-B-C")]
            billing.test_iam_permissions.return_value = _held(list(billing_permissions))
            exit_code = self.module.main()
        self.calls = (folders, billing)
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text())

    def test_ready_when_it_may_make_projects_and_link_billing(self) -> None:
        exit_code, result = self._run()
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["status"], "succeeded")
        self.assertTrue(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["missing"], [])
        self.assertEqual(
            result["outputs"]["principal"],
            "Kubernetes ServiceAccount gcp-project, by Workload Identity (my-project.svc.id.goog)",
        )
        self.source.refresh.assert_called_once()  # it really signed in
        folders, _ = self.calls
        folders.test_iam_permissions.assert_called_once_with(resource="folders/12", permissions=ALL)

    def test_names_the_roles_a_folder_lacks(self) -> None:
        _, result = self._run(folder_permissions=["resourcemanager.projects.get"])
        self.assertFalse(result["outputs"]["ready"])
        self.assertEqual(
            result["outputs"]["missing"],
            ["roles/resourcemanager.projectCreator, roles/resourcemanager.projectDeleter on folders/12"],
        )

    def test_names_billing_when_it_may_link_none(self) -> None:
        _, result = self._run(billing_permissions=())
        self.assertFalse(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["missing"], ["roles/billing.user on the billing account it links"])

    def test_without_workload_identity_it_is_not_ready(self) -> None:
        self.default.side_effect = self.module.google.auth.exceptions.DefaultCredentialsError("none")
        exit_code, result = self._run()
        self.assertEqual(exit_code, 0)
        self.assertFalse(result["outputs"]["ready"])
        self.assertIn("Workload Identity", result["outputs"]["missing"][0])

    def test_impersonation_it_may_not_do_is_missing_token_creator(self) -> None:
        target = "acts-as@my-project.iam.gserviceaccount.com"
        self.module.TARGET_SERVICE_ACCOUNT_FILE.write_text(target + "\n")
        with patch.object(self.module.impersonated_credentials, "Credentials") as creds_cls:
            creds_cls.return_value.refresh.side_effect = self.module.google.auth.exceptions.RefreshError("denied")
            _, result = self._run()
        self.assertFalse(result["outputs"]["ready"])
        self.assertEqual(
            result["outputs"]["missing"],
            [f"roles/iam.serviceAccountTokenCreator on {target}, for ServiceAccount gcp-project"],
        )

    def test_impersonating_it_acts_as_the_target(self) -> None:
        target = "acts-as@my-project.iam.gserviceaccount.com"
        self.module.TARGET_SERVICE_ACCOUNT_FILE.write_text(target)
        with patch.object(self.module.impersonated_credentials, "Credentials"):
            _, result = self._run()
        self.assertEqual(result["outputs"]["principal"], target)
        self.assertTrue(result["outputs"]["ready"])

    def test_an_api_error_is_a_retryable_failure_not_an_answer(self) -> None:
        with (
            patch.object(self.module.resourcemanager_v3, "FoldersClient") as folders_cls,
            patch.object(self.module.resourcemanager_v3, "OrganizationsClient"),
        ):
            folders_cls.return_value.search_folders.side_effect = self.module.GoogleAPIError("unavailable")
            self.assertEqual(self.module.main(), 1)
        result = json.loads(self.module.OUTPUT_PATH.read_text())
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertTrue(result["error"]["retryable"])


if __name__ == "__main__":
    unittest.main()
