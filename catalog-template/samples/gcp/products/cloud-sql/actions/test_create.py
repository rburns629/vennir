"""Tests for gcp/cloud-sql's create action, with the Google Cloud clients
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


def _load_create_module():
    spec = importlib.util.spec_from_file_location("gcp_cloud_sql_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _http_error(status: int) -> Exception:
    resp = MagicMock()
    resp.status = status
    return __import__("googleapiclient.errors", fromlist=["HttpError"]).HttpError(resp, b"{}")


class CreateActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"
        # Every test patches _build_service directly rather than the real
        # discovery.build -- that call makes a real network request to
        # fetch Google's discovery document even before any mocking of the
        # returned service's methods would help.
        self.build_service_patch = patch.object(self.module, "_build_service")
        self.build_service_mock = self.build_service_patch.start()
        self.service = MagicMock()
        self.build_service_mock.return_value = self.service
        self.addCleanup(self.build_service_patch.stop)

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _write_request(self, inputs: dict) -> None:
        self.module.INPUT_PATH.write_text(
            json.dumps(
                {"executionId": "e", "taskId": "t", "action": "create", "attempt": 1, "inputs": inputs}
            )
        )

    def _result(self) -> dict:
        return json.loads(self.module.OUTPUT_PATH.read_text())

    def test_missing_inputs_fails_without_calling_gcp(self) -> None:
        self._write_request({"projectId": "demo-project"})  # instanceName missing
        exit_code = self.module.main()

        self.build_service_mock.assert_not_called()
        self.assertEqual(exit_code, 1)
        self.assertEqual(self._result()["error"]["code"], "MISSING_INPUT")

    def test_existing_instance_skips_creation(self) -> None:
        self._write_request({"projectId": "demo-project", "instanceName": "already-exists"})
        self.service.instances.return_value.get.return_value.execute.return_value = {
            "connectionName": "demo-project:us-central1:already-exists",
            "ipAddresses": [{"ipAddress": "10.0.0.1"}],
            "state": "RUNNABLE",
        }

        exit_code = self.module.main()

        self.service.instances.return_value.insert.assert_not_called()
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            self._result(),
            {
                "status": "succeeded",
                "outputs": {
                    "instanceConnectionName": "demo-project:us-central1:already-exists",
                    "ipAddress": "10.0.0.1",
                },
            },
        )

    def test_an_existing_instance_still_being_made_is_waited_for(self) -> None:
        # A retry finding the instance its last attempt was still creating.
        self._write_request({"projectId": "demo-project", "instanceName": "made"})
        made = {"name": "made", "connectionName": "demo-project:us-central1:made", "settings": {"userLabels": {"vertra-made": "true"}}}
        self.service.instances.return_value.get.return_value.execute.side_effect = [
            {**made, "state": "PENDING_CREATE"},
            {**made, "state": "PENDING_CREATE"},
            {**made, "state": "RUNNABLE", "ipAddresses": [{"ipAddress": "10.0.0.3"}]},
        ]
        with patch.object(self.module.time, "sleep") as slept:
            self.assertEqual(self.module.main(), 0)
        self.assertEqual(slept.call_count, 2)
        self.service.instances.return_value.insert.assert_not_called()
        outputs = self._result()["outputs"]
        self.assertEqual(outputs["ipAddress"], "10.0.0.3")
        self.assertEqual(outputs["resources"][0]["id"], "demo-project:us-central1:made")

    def test_an_existing_instance_still_not_ready_is_a_retryable_failure(self) -> None:
        self._write_request({"projectId": "demo-project", "instanceName": "slow"})
        self.module.READY_TIMEOUT_SECONDS = 0
        self.service.instances.return_value.get.return_value.execute.return_value = {
            "name": "slow", "connectionName": "demo-project:us-central1:slow", "state": "PENDING_CREATE",
        }
        self.assertEqual(self.module.main(), 1)
        error = self._result()["error"]
        self.assertEqual((error["code"], error["retryable"]), ("INSTANCE_NOT_READY", True))

    def test_a_failed_existing_instance_fails_for_good(self) -> None:
        for state in ("FAILED", "SUSPENDED", "PENDING_DELETE"):
            with self.subTest(state=state):
                self._write_request({"projectId": "demo-project", "instanceName": "broken"})
                self.service.instances.return_value.get.return_value.execute.return_value = {
                    "name": "broken", "connectionName": "demo-project:us-central1:broken", "state": state,
                }
                with patch.object(self.module.time, "sleep") as slept:
                    self.assertEqual(self.module.main(), 1)
                slept.assert_not_called()
                error = self._result()["error"]
                self.assertEqual((error["code"], error["retryable"]), ("INSTANCE_NOT_USABLE", False))
                self.assertNotIn("outputs", self._result())

    def test_new_instance_is_created_and_waits_for_operation(self) -> None:
        self._write_request({"projectId": "demo-project", "instanceName": "brand-new"})
        self.service.instances.return_value.get.return_value.execute.side_effect = [
            _http_error(404),  # existing-check: not found
            {  # post-creation get: the real instance
                "connectionName": "demo-project:us-central1:brand-new",
                "ipAddresses": [{"ipAddress": "10.0.0.2"}],
            },
        ]
        self.service.instances.return_value.insert.return_value.execute.return_value = {
            "name": "operation-123"
        }
        self.service.operations.return_value.get.return_value.execute.return_value = {
            "status": "DONE"
        }

        with patch.object(self.module.time, "sleep"):
            exit_code = self.module.main()

        insert_kwargs = self.service.instances.return_value.insert.call_args.kwargs
        self.assertEqual(insert_kwargs["project"], "demo-project")
        self.assertEqual(insert_kwargs["body"]["name"], "brand-new")
        self.assertEqual(insert_kwargs["body"]["databaseVersion"], self.module.DEFAULT_DATABASE_VERSION)
        self.assertEqual(insert_kwargs["body"]["settings"]["tier"], self.module.DEFAULT_TIER)
        # Left unset, a new instance defaults to a mode this project's org
        # policy rejects outright (a real 400, caught live -- see the
        # comment beside this field in create.py itself).
        self.assertEqual(
            insert_kwargs["body"]["settings"]["ipConfiguration"]["sslMode"], "ENCRYPTED_ONLY"
        )

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            self._result(),
            {
                "status": "succeeded",
                "outputs": {
                    "instanceConnectionName": "demo-project:us-central1:brand-new",
                    "ipAddress": "10.0.0.2",
                },
            },
        )

    def test_an_instance_it_made_is_labelled_and_reported(self) -> None:
        self._write_request({"projectId": "demo-project", "instanceName": "made"})
        self.service.instances.return_value.get.return_value.execute.side_effect = [
            _http_error(404),
            {"name": "made", "connectionName": "demo-project:us-central1:made", "settings": {"userLabels": {"vertra-made": "true"}}},
        ]
        self.service.instances.return_value.insert.return_value.execute.return_value = {"name": "operation-1"}
        self.service.operations.return_value.get.return_value.execute.return_value = {"status": "DONE"}
        with patch.object(self.module.time, "sleep"):
            self.assertEqual(self.module.main(), 0)
        body = self.service.instances.return_value.insert.call_args.kwargs["body"]
        self.assertEqual(body["settings"]["userLabels"], {"vertra-made": "true"})
        self.assertEqual(self._result()["outputs"]["resources"][0]["id"], "demo-project:us-central1:made")

    def test_operation_failure_is_a_retryable_failure(self) -> None:
        self._write_request({"projectId": "demo-project", "instanceName": "will-fail"})
        self.service.instances.return_value.get.return_value.execute.side_effect = _http_error(404)
        self.service.instances.return_value.insert.return_value.execute.return_value = {
            "name": "operation-456"
        }
        self.service.operations.return_value.get.return_value.execute.return_value = {
            "status": "DONE",
            "error": {"errors": [{"code": "QUOTA_EXCEEDED"}]},
        }

        with patch.object(self.module.time, "sleep"):
            exit_code = self.module.main()

        self.assertEqual(exit_code, 1)
        result = self._result()
        self.assertEqual(result["error"]["code"], "GCP_OPERATION_FAILED")
        self.assertTrue(result["error"]["retryable"])

    def test_get_instance_api_error_is_a_retryable_failure(self) -> None:
        self._write_request({"projectId": "demo-project", "instanceName": "whatever"})
        self.service.instances.return_value.get.return_value.execute.side_effect = _http_error(500)

        exit_code = self.module.main()

        self.assertEqual(exit_code, 1)
        result = self._result()
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertTrue(result["error"]["retryable"])

    def test_a_refusal_is_not_retried(self) -> None:
        self._write_request({"projectId": "demo-project", "instanceName": "whatever"})
        self.service.instances.return_value.get.return_value.execute.side_effect = _http_error(403)

        self.assertEqual(self.module.main(), 1)
        result = self._result()
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertFalse(result["error"]["retryable"])

    def test_custom_database_version_tier_and_region_are_passed_through(self) -> None:
        self._write_request(
            {
                "projectId": "demo-project",
                "instanceName": "custom",
                "databaseVersion": "MYSQL_8_0",
                "tier": "db-custom-2-7680",
                "region": "europe-west1",
            }
        )
        self.service.instances.return_value.get.return_value.execute.side_effect = [
            _http_error(404),
            {"connectionName": "demo-project:europe-west1:custom", "ipAddresses": []},
        ]
        self.service.instances.return_value.insert.return_value.execute.return_value = {
            "name": "operation-789"
        }
        self.service.operations.return_value.get.return_value.execute.return_value = {
            "status": "DONE"
        }

        with patch.object(self.module.time, "sleep"):
            exit_code = self.module.main()

        insert_kwargs = self.service.instances.return_value.insert.call_args.kwargs
        self.assertEqual(insert_kwargs["body"]["databaseVersion"], "MYSQL_8_0")
        self.assertEqual(insert_kwargs["body"]["settings"]["tier"], "db-custom-2-7680")
        self.assertEqual(insert_kwargs["body"]["region"], "europe-west1")
        self.assertEqual(exit_code, 0)
        # No IP addresses at all is a real, valid state (some instances are
        # private-IP-only) -- must not crash, and reports an empty string.
        self.assertEqual(self._result()["outputs"]["ipAddress"], "")

    def test_impersonation_refused_writes_a_result(self) -> None:
        self._write_request({"projectId": "demo-project", "instanceName": "orders-db"})
        self.service.instances.return_value.get.return_value.execute.side_effect = self.module.google.auth.exceptions.RefreshError("denied")
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

        creds_cls.assert_called_once_with(
            source_credentials=source_credentials,
            target_principal=target,
            target_scopes=self.module.IMPERSONATION_SCOPES,
        )
        self.assertEqual(result, creds_cls.return_value)


if __name__ == "__main__":
    unittest.main()
