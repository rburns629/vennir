"""Tests for gcp/build-image's create action, with the Google Cloud clients
mocked, so they run without a GCP account. `./vertra catalog check` runs them in
the product's own image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from google.api_core import exceptions as api_exceptions

_MODULE_PATH = Path(__file__).parent / "create.py"

_VALID_INPUTS = {
    "projectId": "my-project",
    "sourceArchiveUrl": "gs://my-bucket/source.zip",
    "imageUri": "us-central1-docker.pkg.dev/my-project/demo/hello-world-app:latest",
}


def _load_create_module():
    spec = importlib.util.spec_from_file_location("gcp_build_image_create", _MODULE_PATH)
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
                    "action": "create",
                    "attempt": 1,
                    "inputs": inputs,
                }
            )
        )

    def _result(self) -> dict:
        return json.loads(self.module.OUTPUT_PATH.read_text())

    def test_missing_inputs_fails_without_calling_gcp(self) -> None:
        self._write_request({})
        with patch.object(self.module.cloudbuild_v1, "CloudBuildClient") as build_cls:
            exit_code = self.module.main()

        build_cls.assert_not_called()
        self.assertEqual(exit_code, 1)
        self.assertEqual(self._result()["error"]["code"], "MISSING_INPUT")

    def test_existing_image_skips_build(self) -> None:
        self._write_request(_VALID_INPUTS)
        with (
            patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls,
            patch.object(self.module.cloudbuild_v1, "CloudBuildClient") as build_cls,
        ):
            ar_client = ar_cls.return_value
            ar_client.get_tag.return_value = MagicMock()  # found

            exit_code = self.module.main()

        ar_client.get_tag.assert_called_once_with(
            name="projects/my-project/locations/us-central1/repositories/demo"
            "/packages/hello-world-app/tags/latest"
        )
        build_cls.assert_not_called()
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            self._result(),
            {"status": "succeeded", "outputs": {"imageUri": _VALID_INPUTS["imageUri"]}},
        )

    def test_new_image_triggers_build_and_succeeds(self) -> None:
        self._write_request(_VALID_INPUTS)
        with (
            patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls,
            patch.object(self.module.cloudbuild_v1, "CloudBuildClient") as build_cls,
        ):
            ar_client = ar_cls.return_value
            ar_client.get_tag.side_effect = self.module.NotFound("no such tag")

            build_client = build_cls.return_value
            build_result = MagicMock()
            build_result.status = self.module.cloudbuild_v1.Build.Status.SUCCESS
            build_client.create_build.return_value.result.return_value = build_result

            exit_code = self.module.main()

        build_client.create_build.assert_called_once()
        call_kwargs = build_client.create_build.call_args.kwargs
        self.assertEqual(call_kwargs["project_id"], "my-project")
        submitted_build = call_kwargs["build"]
        self.assertEqual(submitted_build.source.storage_source.bucket, "my-bucket")
        self.assertEqual(submitted_build.source.storage_source.object_, "source.zip")
        self.assertEqual(list(submitted_build.images), [_VALID_INPUTS["imageUri"]])
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            self._result(),
            {"status": "succeeded", "outputs": {"imageUri": _VALID_INPUTS["imageUri"]}},
        )

    def test_build_failure_status_is_reported(self) -> None:
        self._write_request(_VALID_INPUTS)
        with (
            patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls,
            patch.object(self.module.cloudbuild_v1, "CloudBuildClient") as build_cls,
        ):
            ar_client = ar_cls.return_value
            ar_client.get_tag.side_effect = self.module.NotFound("no such tag")

            build_client = build_cls.return_value
            build_result = MagicMock()
            build_result.status = self.module.cloudbuild_v1.Build.Status.FAILURE
            build_result.status_detail = "build step failed"
            build_client.create_build.return_value.result.return_value = build_result

            exit_code = self.module.main()

        self.assertEqual(exit_code, 1)
        result = self._result()
        self.assertEqual(result["error"]["code"], "BUILD_FAILED")
        # The same source fails the same way again.
        self.assertFalse(result["error"]["retryable"])

    def test_an_image_in_a_folder_is_looked_up_by_its_encoded_package(self) -> None:
        self._write_request(dict(_VALID_INPUTS, imageUri="us-central1-docker.pkg.dev/my-project/demo/payments/api:v2"))
        with (
            patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls,
            patch.object(self.module.cloudbuild_v1, "CloudBuildClient"),
        ):
            ar_cls.return_value.get_tag.return_value = MagicMock()
            self.assertEqual(self.module.main(), 0)
        ar_cls.return_value.get_tag.assert_called_once_with(
            name="projects/my-project/locations/us-central1/repositories/demo/packages/payments%2Fapi/tags/v2"
        )

    def test_non_artifact_registry_image_always_builds(self) -> None:
        inputs = dict(_VALID_INPUTS, imageUri="gcr.io/my-project/legacy:v1")
        self._write_request(inputs)
        with (
            patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls,
            patch.object(self.module.cloudbuild_v1, "CloudBuildClient") as build_cls,
        ):
            build_client = build_cls.return_value
            build_result = MagicMock()
            build_result.status = self.module.cloudbuild_v1.Build.Status.SUCCESS
            build_client.create_build.return_value.result.return_value = build_result

            exit_code = self.module.main()

        ar_cls.assert_not_called()
        build_client.create_build.assert_called_once()
        self.assertEqual(exit_code, 0)

    def test_get_tag_api_error_is_a_retryable_failure(self) -> None:
        self._write_request(_VALID_INPUTS)
        with patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls:
            ar_client = ar_cls.return_value
            ar_client.get_tag.side_effect = self.module.GoogleAPIError("transient")
            exit_code = self.module.main()

        self.assertEqual(exit_code, 1)
        result = self._result()
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertTrue(result["error"]["retryable"])

    def _build(self, status=None, *, error: Exception | None = None, metadata_status=None) -> dict:
        """Runs a build of a new image that ends with status, or whose
        operation raises error with metadata_status as the build's own."""
        self._write_request(_VALID_INPUTS)
        with (
            patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls,
            patch.object(self.module.cloudbuild_v1, "CloudBuildClient") as build_cls,
        ):
            ar_cls.return_value.get_tag.side_effect = self.module.NotFound("no such tag")
            operation = build_cls.return_value.create_build.return_value
            if error is not None:
                operation.result.side_effect = error
                operation.metadata.build.status = metadata_status
            else:
                operation.result.return_value = MagicMock(status=status)
            self.assertEqual(self.module.main(), 1)
        return self._result()["error"]

    def test_a_build_that_failed_is_not_retried(self) -> None:
        # How Cloud Build ends a failed build's operation: an error with no HTTP code.
        error = self._build(error=api_exceptions.Unknown("Build failed"), metadata_status=self.module.cloudbuild_v1.Build.Status.FAILURE)
        self.assertEqual((error["code"], error["retryable"]), ("BUILD_FAILED", False))

    def test_cloud_builds_own_trouble_is_retried(self) -> None:
        error = self._build(self.module.cloudbuild_v1.Build.Status.INTERNAL_ERROR)
        self.assertEqual((error["code"], error["retryable"]), ("BUILD_FAILED", True))

    def test_an_operation_error_before_the_build_ran_is_googles(self) -> None:
        error = self._build(error=api_exceptions.ServiceUnavailable("busy"), metadata_status=self.module.cloudbuild_v1.Build.Status.QUEUED)
        self.assertEqual((error["code"], error["retryable"]), ("GCP_API_ERROR", True))

    def test_a_build_still_running_when_the_wait_ends_is_retried(self) -> None:
        error = self._build(error=TimeoutError("Operation did not complete within the designated timeout."))
        self.assertEqual((error["code"], error["retryable"]), ("GCP_TIMEOUT", True))

    def _with_an_earlier_build(self, status, *later) -> tuple[int, MagicMock]:
        """Runs create after an earlier attempt's build, last seen with status,
        which then reports each of later in turn."""
        self._write_request(_VALID_INPUTS)
        with (
            patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls,
            patch.object(self.module.cloudbuild_v1, "CloudBuildClient") as build_cls,
            patch.object(self.module.time, "sleep"),
        ):
            ar_cls.return_value.get_tag.side_effect = self.module.NotFound("no such tag")
            client = build_cls.return_value
            older = MagicMock(id="b-0", status=self.module.cloudbuild_v1.Build.Status.INTERNAL_ERROR, create_time=1)
            client.list_builds.return_value = iter([older, MagicMock(id="b-1", status=status, status_detail="", create_time=2)])
            client.get_build.side_effect = [MagicMock(id="b-1", status=s, status_detail="") for s in later]
            client.create_build.return_value.result.return_value = MagicMock(status=self.module.cloudbuild_v1.Build.Status.SUCCESS)
            code = self.module.main()
        return code, client

    def _tag(self) -> str:
        return self.module._build_tag("e", "t", _VALID_INPUTS["imageUri"], _VALID_INPUTS["sourceArchiveUrl"])

    def test_a_build_an_earlier_attempt_left_running_is_waited_on(self) -> None:
        status = self.module.cloudbuild_v1.Build.Status
        code, client = self._with_an_earlier_build(status.WORKING, status.WORKING, status.SUCCESS)
        self.assertEqual(code, 0)
        client.create_build.assert_not_called()
        client.get_build.assert_called_with(project_id="my-project", id="b-1")
        self.assertEqual(client.list_builds.call_args.kwargs, {"project_id": "my-project", "filter": f'tags="{self._tag()}"'})

    def test_an_earlier_attempts_build_that_failed_is_this_ones_failure(self) -> None:
        # Its step was stopped; its build went on and failed: not paid for again.
        code, client = self._with_an_earlier_build(self.module.cloudbuild_v1.Build.Status.FAILURE)
        self.assertEqual(code, 1)
        client.create_build.assert_not_called()
        self.assertEqual((self._result()["error"]["code"], self._result()["error"]["retryable"]), ("BUILD_FAILED", False))

    def test_an_earlier_attempts_build_that_cloud_build_lost_is_built_again(self) -> None:
        code, client = self._with_an_earlier_build(self.module.cloudbuild_v1.Build.Status.INTERNAL_ERROR)
        self.assertEqual(code, 0)
        client.create_build.assert_called_once()

    def test_a_running_build_that_fails_is_its_failure(self) -> None:
        status = self.module.cloudbuild_v1.Build.Status
        code, client = self._with_an_earlier_build(status.QUEUED, status.FAILURE)
        self.assertEqual(code, 1)
        client.create_build.assert_not_called()
        self.assertEqual((self._result()["error"]["code"], self._result()["error"]["retryable"]), ("BUILD_FAILED", False))

    def test_a_running_build_still_running_when_the_wait_ends_is_retried(self) -> None:
        self.module.WAIT_SECONDS = 0
        status = self.module.cloudbuild_v1.Build.Status
        code, _ = self._with_an_earlier_build(status.WORKING, status.WORKING)
        self.assertEqual(code, 1)
        self.assertEqual((self._result()["error"]["code"], self._result()["error"]["retryable"]), ("GCP_TIMEOUT", True))

    def test_cloud_build_failing_to_list_is_googles(self) -> None:
        self._write_request(_VALID_INPUTS)
        with (
            patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls,
            patch.object(self.module.cloudbuild_v1, "CloudBuildClient") as build_cls,
        ):
            ar_cls.return_value.get_tag.side_effect = self.module.NotFound("no such tag")
            build_cls.return_value.list_builds.side_effect = api_exceptions.ServiceUnavailable("busy")
            self.assertEqual(self.module.main(), 1)
        self.assertEqual((self._result()["error"]["code"], self._result()["error"]["retryable"]), ("GCP_API_ERROR", True))

    def test_a_new_build_carries_its_image_and_sources_tag(self) -> None:
        self._write_request(_VALID_INPUTS)
        with (
            patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls,
            patch.object(self.module.cloudbuild_v1, "CloudBuildClient") as build_cls,
        ):
            ar_cls.return_value.get_tag.side_effect = self.module.NotFound("no such tag")
            client = build_cls.return_value
            client.list_builds.return_value = iter([])
            client.create_build.return_value.result.return_value = MagicMock(status=self.module.cloudbuild_v1.Build.Status.SUCCESS)
            self.assertEqual(self.module.main(), 0)
        tag = self._tag()
        self.assertEqual(list(client.create_build.call_args.kwargs["build"].tags), [tag])
        # A tag Cloud Build accepts: letters, digits, _ . -, at most 128.
        self.assertRegex(tag, r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
        # This step's alone: another run's, or another source's, differs.
        self.assertNotEqual(tag, self.module._build_tag("e2", "t", _VALID_INPUTS["imageUri"], _VALID_INPUTS["sourceArchiveUrl"]))
        self.assertNotEqual(tag, self.module._build_tag("e", "t", _VALID_INPUTS["imageUri"], "gs://my-bucket/other.zip"))

    def _sign_in_failing(self, error: Exception) -> dict:
        self.adc.refresh.side_effect = error
        self._write_request(_VALID_INPUTS)
        with patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls:
            self.assertEqual(self.module.main(), 1)
        # Never left to a gRPC client, which would call it UNAVAILABLE.
        ar_cls.return_value.get_tag.assert_not_called()
        return self._result()["error"]

    def test_a_refused_sign_in_is_not_retried(self) -> None:
        error = self._sign_in_failing(self.module.google.auth.exceptions.RefreshError("permission denied"))
        self.assertEqual((error["code"], error["retryable"]), ("GCP_SIGN_IN_FAILED", False))

    def test_google_unreachable_to_sign_in_is_retried(self) -> None:
        error = self._sign_in_failing(self.module.google.auth.exceptions.TransportError("connection reset"))
        self.assertEqual((error["code"], error["retryable"]), ("GCP_SIGN_IN_FAILED", True))

    def test_iam_busy_is_retried(self) -> None:
        error = self._sign_in_failing(self.module.google.auth.exceptions.RefreshError(
            "Unable to acquire impersonated credentials", '{"error": {"code": 503, "status": "UNAVAILABLE"}}'
        ))
        self.assertEqual((error["code"], error["retryable"]), ("GCP_SIGN_IN_FAILED", True))

    def test_iam_refusing_is_not_retried(self) -> None:
        error = self._sign_in_failing(self.module.google.auth.exceptions.RefreshError(
            "Unable to acquire impersonated credentials", '{"error": {"code": 403, "status": "PERMISSION_DENIED"}}'
        ))
        self.assertEqual((error["code"], error["retryable"]), ("GCP_SIGN_IN_FAILED", False))

    def test_a_metadata_server_unreachable_is_retried(self) -> None:
        # GKE's credentials wrap the TransportError in a RefreshError.
        refused = self.module.google.auth.exceptions.RefreshError("metadata server unreachable")
        refused.__cause__ = self.module.google.auth.exceptions.TransportError("connection refused")
        error = self._sign_in_failing(refused)
        self.assertEqual((error["code"], error["retryable"]), ("GCP_SIGN_IN_FAILED", True))


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
        resulting credentials to every client it constructs."""
        target = "kernel-gcp-test@my-project.iam.gserviceaccount.com"
        self.module.TARGET_SERVICE_ACCOUNT_FILE.write_text(target + "\n")
        with (
            patch.object(self.module.google.auth, "default") as default_mock,
            patch.object(self.module.impersonated_credentials, "Credentials") as creds_cls,
            patch.object(self.module.artifactregistry_v1, "ArtifactRegistryClient") as ar_cls,
        ):
            default_mock.return_value = (MagicMock(), "some-project")
            ar_cls.return_value.get_tag.return_value = MagicMock()

            self.module.INPUT_PATH = Path(tempfile.mkstemp()[1])
            self.module.OUTPUT_PATH = Path(tempfile.mkstemp()[1])
            self.module.INPUT_PATH.write_text(json.dumps({"inputs": _VALID_INPUTS}))

            self.module.main()

        ar_cls.assert_called_once_with(credentials=creds_cls.return_value)


if __name__ == "__main__":
    unittest.main()
