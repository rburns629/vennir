"""Tests for gcp/project's create action, with the Google Cloud clients
mocked, so they run without a GCP account. `./vertra catalog check` runs them in
the product's own image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_MODULE_PATH = Path(__file__).parent / "create.py"
# What create labels a project it makes for team web with.
MADE_FOR_WEB = {"vertra-made": "true", "vertra-team": "web"}


def _load_create_module():
    spec = importlib.util.spec_from_file_location("gcp_project_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CreateActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
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

    def _write_request(self, inputs: dict) -> None:
        self.module.INPUT_PATH.write_text(
            json.dumps(
                {
                    "executionId": "e",
                    "taskId": "t",
                    "forTeam": "web",
                    "action": "create",
                    "attempt": 1,
                    "inputs": inputs,
                }
            )
        )

    def _result(self) -> dict:
        return json.loads(self.module.OUTPUT_PATH.read_text())

    def test_missing_project_id_fails_without_calling_gcp(self) -> None:
        self._write_request({})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            exit_code = self.module.main()

        client_cls.assert_not_called()
        self.assertEqual(exit_code, 1)
        self.assertEqual(self._result()["error"]["code"], "MISSING_INPUT")

    def test_existing_project_skips_creation(self) -> None:
        self._write_request({"projectId": "already-exists"})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client = client_cls.return_value
            client.get_project.return_value = MagicMock(labels={})  # found, made some other way
            exit_code = self.module.main()

        client.get_project.assert_called_once_with(name="projects/already-exists")
        client.create_project.assert_not_called()
        self.assertEqual(exit_code, 0)
        # Not reported: its cleanup mustn't delete a project it didn't make.
        self.assertEqual(
            self._result(), {"status": "succeeded", "outputs": {"projectId": "already-exists"}}
        )

    def test_a_project_it_made_is_reported_when_found_again(self) -> None:
        # A retry that finds the project the first attempt made.
        self._write_request({"projectId": "made-before"})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client_cls.return_value.get_project.return_value = MagicMock(labels=MADE_FOR_WEB)
            self.assertEqual(self.module.main(), 0)
        self.assertEqual(self._result()["outputs"]["resources"][0]["id"], "made-before")

    def test_another_teams_project_isnt_reported_or_billed(self) -> None:
        # Made by this product, but for another team: not this team's to delete.
        self._write_request({"projectId": "data-1", "billingAccountId": "AAAAAA-BBBBBB-CCCCCC"})
        with (
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
            patch.object(self.module, "CloudBillingClient") as billing_cls,
        ):
            client_cls.return_value.get_project.return_value = MagicMock(labels={"vertra-made": "true", "vertra-team": "data"})
            self.assertEqual(self.module.main(), 0)
        billing_cls.assert_not_called()
        self.assertEqual(self._result(), {"status": "succeeded", "outputs": {"projectId": "data-1"}})

    def test_a_request_without_a_team_is_refused(self) -> None:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {"projectId": "brand-new"}}))
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            self.assertEqual(self.module.main(), 1)
        client_cls.assert_not_called()
        self.assertEqual(self._result()["error"]["code"], "MISSING_TEAM")

    def test_new_project_is_created_and_billing_linked(self) -> None:
        self._write_request(
            {"projectId": "brand-new", "billingAccountId": "AAAAAA-BBBBBB-CCCCCC"}
        )
        with (
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
            patch.object(self.module, "CloudBillingClient") as billing_cls,
        ):
            client = client_cls.return_value
            client.get_project.side_effect = self.module.NotFound("no such project")
            client.create_project.return_value.result.return_value = MagicMock()
            billing_client = billing_cls.return_value

            exit_code = self.module.main()

        client.create_project.assert_called_once()
        created_project = client.create_project.call_args.kwargs["project"]
        self.assertEqual(created_project.project_id, "brand-new")
        self.assertEqual(dict(created_project.labels), MADE_FOR_WEB)
        self.assertEqual(
            self._result()["outputs"]["resources"],
            [{"type": "gcp/project", "id": "brand-new", "link": "https://console.cloud.google.com/home/dashboard?project=brand-new"}],
        )

        billing_client.update_project_billing_info.assert_called_once()
        billing_kwargs = billing_client.update_project_billing_info.call_args.kwargs
        self.assertEqual(billing_kwargs["name"], "projects/brand-new")
        self.assertEqual(
            billing_kwargs["project_billing_info"].billing_account_name,
            "billingAccounts/AAAAAA-BBBBBB-CCCCCC",
        )
        self.assertEqual(exit_code, 0)
        self.assertEqual(self._result()["outputs"]["projectId"], "brand-new")

    def test_a_new_project_goes_under_its_parent(self) -> None:
        self._write_request({"projectId": "brand-new", "parent": "folders/123"})
        with (
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
            patch.object(self.module, "CloudBillingClient"),
        ):
            client = client_cls.return_value
            client.get_project.side_effect = self.module.NotFound("no such project")
            self.assertEqual(self.module.main(), 0)
        self.assertEqual(client.create_project.call_args.kwargs["project"].parent, "folders/123")

    def test_a_project_it_may_not_see_is_created(self) -> None:
        # Google's answer for a project that doesn't exist, outside the folder.
        self._write_request({"projectId": "brand-new", "parent": "folders/123"})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client = client_cls.return_value
            client.get_project.side_effect = self.module.PermissionDenied("denied, or it may not exist")
            self.assertEqual(self.module.main(), 0)
        client.create_project.assert_called_once()

    def test_an_id_taken_elsewhere_fails_for_good(self) -> None:
        self._write_request({"projectId": "taken"})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client = client_cls.return_value
            client.get_project.side_effect = self.module.PermissionDenied("denied")
            client.create_project.return_value.result.side_effect = self.module.AlreadyExists("taken")
            self.assertEqual(self.module.main(), 1)
        self.assertEqual(self._result()["error"], {**self._result()["error"], "code": "PROJECT_ID_TAKEN", "retryable": False})

    def test_new_project_without_billing_account_skips_billing_call(self) -> None:
        self._write_request({"projectId": "brand-new-no-billing"})
        with (
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
            patch.object(self.module, "CloudBillingClient") as billing_cls,
        ):
            client = client_cls.return_value
            client.get_project.side_effect = self.module.NotFound("no such project")
            client.create_project.return_value.result.return_value = MagicMock()

            exit_code = self.module.main()

        billing_cls.assert_not_called()
        self.assertEqual(exit_code, 0)

    def test_get_project_api_error_is_a_retryable_failure(self) -> None:
        self._write_request({"projectId": "whatever"})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client = client_cls.return_value
            client.get_project.side_effect = self.module.GoogleAPIError("transient")
            exit_code = self.module.main()

        self.assertEqual(exit_code, 1)
        result = self._result()
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertTrue(result["error"]["retryable"])

    def test_create_project_api_error_is_a_retryable_failure(self) -> None:
        self._write_request({"projectId": "whatever"})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client = client_cls.return_value
            client.get_project.side_effect = self.module.NotFound("no such project")
            client.create_project.side_effect = self.module.GoogleAPIError("quota exceeded")
            exit_code = self.module.main()

        self.assertEqual(exit_code, 1)
        result = self._result()
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertTrue(result["error"]["retryable"])

    def test_a_retry_that_finds_its_project_links_billing(self) -> None:
        # The attempt that made it stopped before linking it (a timeout, say).
        self._write_request({"projectId": "made-before", "billingAccountId": "AAAAAA-BBBBBB-CCCCCC"})
        with (
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
            patch.object(self.module, "CloudBillingClient") as billing_cls,
        ):
            client_cls.return_value.get_project.return_value = MagicMock(labels=MADE_FOR_WEB)
            billing_cls.return_value.get_project_billing_info.return_value = MagicMock(billing_account_name="")
            self.assertEqual(self.module.main(), 0)
        client_cls.return_value.create_project.assert_not_called()
        billing_cls.return_value.update_project_billing_info.assert_called_once()

    def test_billing_already_linked_is_only_read(self) -> None:
        self._write_request({"projectId": "made-before", "billingAccountId": "AAAAAA-BBBBBB-CCCCCC"})
        with (
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
            patch.object(self.module, "CloudBillingClient") as billing_cls,
        ):
            client_cls.return_value.get_project.return_value = MagicMock(labels=MADE_FOR_WEB)
            billing_cls.return_value.get_project_billing_info.return_value = MagicMock(
                billing_account_name="billingAccounts/AAAAAA-BBBBBB-CCCCCC"
            )
            self.assertEqual(self.module.main(), 0)
        billing_cls.return_value.update_project_billing_info.assert_not_called()

    def test_a_project_made_some_other_way_keeps_its_billing(self) -> None:
        self._write_request({"projectId": "theirs", "billingAccountId": "AAAAAA-BBBBBB-CCCCCC"})
        with (
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
            patch.object(self.module, "CloudBillingClient") as billing_cls,
        ):
            client_cls.return_value.get_project.return_value = MagicMock(labels={})
            self.assertEqual(self.module.main(), 0)
        billing_cls.assert_not_called()

    def test_a_create_still_running_when_the_wait_ends_is_retried(self) -> None:
        self._write_request({"projectId": "slow"})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client = client_cls.return_value
            client.get_project.side_effect = self.module.NotFound("no such project")
            client.create_project.return_value.result.side_effect = TimeoutError()
            self.assertEqual(self.module.main(), 1)
        error = self._result()["error"]
        self.assertEqual((error["code"], error["retryable"]), ("GCP_TIMEOUT", True))

    def test_no_google_credentials_writes_a_result(self) -> None:
        self._write_request({"projectId": "whatever"})
        with patch.object(self.module, "_build_credentials", side_effect=self.module.google.auth.exceptions.DefaultCredentialsError("none")):
            self.assertEqual(self.module.main(), 1)
        error = self._result()["error"]
        self.assertEqual((error["code"], error["retryable"]), ("GCP_SIGN_IN_FAILED", False))


class BuildCredentialsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
        # Where the team secret gcp-target would be mounted: absent until a test writes it.
        self.module.TARGET_SERVICE_ACCOUNT_FILE = Path(tempfile.mkdtemp()) / "service-account"

    def test_returns_none_without_the_target_secret(self) -> None:
        self.assertIsNone(self.module._build_credentials())

    def test_impersonates_the_target_in_the_secret(self) -> None:
        target = "kernel-gcp-test@my-project.iam.gserviceaccount.com"
        self.module.TARGET_SERVICE_ACCOUNT_FILE.write_text(target + "\n")
        with (
            patch.object(self.module.google.auth, "default") as default_mock,
            patch.object(self.module.impersonated_credentials, "Credentials") as creds_cls,
        ):
            source_credentials = MagicMock()
            default_mock.return_value = (source_credentials, "some-project")

            result = self.module._build_credentials()

        default_mock.assert_called_once()
        creds_cls.assert_called_once_with(
            source_credentials=source_credentials,
            target_principal=target,
            target_scopes=self.module.IMPERSONATION_SCOPES,
        )
        self.assertEqual(result, creds_cls.return_value)

    def test_impersonated_credentials_are_passed_to_gcp_clients(self) -> None:
        """Proves the wiring end-to-end, not just the helper in isolation:
        when impersonation is configured, main() must actually pass the
        resulting credentials to every client it constructs -- a helper
        that works correctly but never gets used would still be a bug."""
        target = "kernel-gcp-test@my-project.iam.gserviceaccount.com"
        self.module.TARGET_SERVICE_ACCOUNT_FILE.write_text(target + "\n")
        with (
            patch.object(self.module.google.auth, "default") as default_mock,
            patch.object(self.module.impersonated_credentials, "Credentials") as creds_cls,
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
        ):
            default_mock.return_value = (MagicMock(), "some-project")
            client_cls.return_value.get_project.return_value = MagicMock()

            self.module.INPUT_PATH = Path(tempfile.mkstemp()[1])
            self.module.OUTPUT_PATH = Path(tempfile.mkstemp()[1])
            self.module.INPUT_PATH.write_text(
                json.dumps(
                    {
                        "executionId": "e",
                        "taskId": "t",
                        "forTeam": "web",
                        "action": "create",
                        "attempt": 1,
                        "inputs": {"projectId": "already-exists"},
                    }
                )
            )

            self.module.main()

        client_cls.assert_called_once_with(credentials=creds_cls.return_value)


if __name__ == "__main__":
    unittest.main()
