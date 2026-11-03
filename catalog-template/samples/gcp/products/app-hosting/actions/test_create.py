"""Tests for gcp/app-hosting's create action, with the Google Cloud clients
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

_VALID_INPUTS = {
    "projectId": "my-project",
    "serviceName": "hello-world",
    "image": "us-central1-docker.pkg.dev/my-project/demo/hello-world-app:latest",
}

_RUNTIME_ACCOUNT = "web-runtime@my-project.iam.gserviceaccount.com"


def _load_create_module():
    spec = importlib.util.spec_from_file_location("gcp_app_hosting_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _mount_settings(module, folder: Path) -> None:
    """The team's secret app-hosting, mounted."""
    module.SETTINGS_DIR = folder / "app-hosting"
    module.SETTINGS_DIR.mkdir()
    (module.SETTINGS_DIR / "image-registry").write_text("us-central1-docker.pkg.dev/my-project/demo/\n")
    (module.SETTINGS_DIR / "runtime-service-account").write_text(_RUNTIME_ACCOUNT + "\n")


class CreateActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"
        _mount_settings(self.module, Path(self.tmp_dir.name))
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

    def test_missing_inputs_fails_without_calling_gcp(self) -> None:
        self._write_request({})
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            exit_code = self.module.main()

        client_cls.assert_not_called()
        self.assertEqual(exit_code, 1)
        self.assertEqual(self._result()["error"]["code"], "MISSING_INPUT")

    def test_without_the_team_secret_nothing_is_deployed(self) -> None:
        for key in ("image-registry", "runtime-service-account"):
            with self.subTest(missing=key):
                value = (self.module.SETTINGS_DIR / key).read_text()
                (self.module.SETTINGS_DIR / key).unlink()
                self._write_request(_VALID_INPUTS)
                with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
                    self.assertEqual(self.module.main(), 1)
                (self.module.SETTINGS_DIR / key).write_text(value)
                client_cls.assert_not_called()
                error = self._result()["error"]
                self.assertEqual((error["code"], error["retryable"]), ("MISSING_SECRET", False))

    def test_an_image_from_another_registry_is_refused(self) -> None:
        for image in (
            "docker.io/anyone/tool:latest",
            "us-central1-docker.pkg.dev/my-project/demo-other/app:1",  # a prefix, not the registry
            "us-central1-docker.pkg.dev/my-project/demo",
        ):
            with self.subTest(image=image):
                self._write_request({**_VALID_INPUTS, "image": image})
                with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
                    self.assertEqual(self.module.main(), 1)
                client_cls.assert_not_called()
                error = self._result()["error"]
                self.assertEqual((error["code"], error["retryable"]), ("IMAGE_NOT_ALLOWED", False))

    def test_existing_service_skips_deployment(self) -> None:
        self._write_request(_VALID_INPUTS)
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client = client_cls.return_value
            client.service_path.return_value = (
                "projects/my-project/locations/us-central1/services/hello-world"
            )
            existing = MagicMock(labels={})  # deployed some other way: not reported
            existing.uri = "https://hello-world-abc123-uc.a.run.app"
            client.get_service.return_value = existing

            exit_code = self.module.main()

        client.service_path.assert_called_once_with("my-project", "us-central1", "hello-world")
        client.create_service.assert_not_called()
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            self._result(),
            {
                "status": "succeeded",
                "outputs": {"serviceUrl": "https://hello-world-abc123-uc.a.run.app"},
            },
        )

    def test_a_service_it_deployed_is_reported_only_for_its_team(self) -> None:
        for team, reported in (("web", True), ("data", False)):
            self._write_request(_VALID_INPUTS)
            with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
                client_cls.return_value.service_path.return_value = "projects/my-project/locations/us-central1/services/hello-world"
                client_cls.return_value.get_service.return_value = MagicMock(uri="https://x", labels={"vertra-made": "true", "vertra-team": team})
                self.assertEqual(self.module.main(), 0)
            self.assertEqual("resources" in self._result()["outputs"], reported, team)

    def test_a_request_without_a_team_is_refused(self) -> None:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": _VALID_INPUTS}))
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            self.assertEqual(self.module.main(), 1)
        client_cls.assert_not_called()
        self.assertEqual(self._result()["error"]["code"], "MISSING_TEAM")

    def test_new_service_is_deployed(self) -> None:
        self._write_request(_VALID_INPUTS)
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client = client_cls.return_value
            client.service_path.return_value = (
                "projects/my-project/locations/us-central1/services/hello-world"
            )
            client.get_service.side_effect = self.module.NotFound("no such service")

            deployed = MagicMock()
            deployed.uri = "https://hello-world-xyz789-uc.a.run.app"
            client.create_service.return_value.result.return_value = deployed

            exit_code = self.module.main()

        client.create_service.assert_called_once()
        call_kwargs = client.create_service.call_args.kwargs
        self.assertEqual(call_kwargs["parent"], "projects/my-project/locations/us-central1")
        self.assertEqual(call_kwargs["service_id"], "hello-world")
        submitted_image = call_kwargs["service"].template.containers[0].image
        self.assertEqual(submitted_image, _VALID_INPUTS["image"])
        self.assertEqual(dict(call_kwargs["service"].labels), {"vertra-made": "true", "vertra-team": "web"})
        # The team's runtime account, never the project's default compute one.
        self.assertEqual(call_kwargs["service"].template.service_account, _RUNTIME_ACCOUNT)
        self.assertEqual(exit_code, 0)
        outputs = self._result()["outputs"]
        self.assertEqual(outputs["serviceUrl"], "https://hello-world-xyz789-uc.a.run.app")
        self.assertEqual(outputs["resources"][0]["id"], "projects/my-project/locations/us-central1/services/hello-world")

    def test_region_input_is_honored(self) -> None:
        self._write_request(dict(_VALID_INPUTS, region="europe-west1"))
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client = client_cls.return_value
            client.get_service.side_effect = self.module.NotFound("no such service")
            client.create_service.return_value.result.return_value = MagicMock(uri="https://x")

            self.module.main()

        client.service_path.assert_called_once_with("my-project", "europe-west1", "hello-world")

    def test_default_region_is_us_central1(self) -> None:
        self._write_request(_VALID_INPUTS)
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client = client_cls.return_value
            client.get_service.side_effect = self.module.NotFound("no such service")
            client.create_service.return_value.result.return_value = MagicMock(uri="https://x")

            self.module.main()

        client.service_path.assert_called_once_with("my-project", "us-central1", "hello-world")

    def test_cloud_sql_connection_name_wires_a_volume_and_env_var(self) -> None:
        self._write_request(dict(_VALID_INPUTS, cloudSqlConnectionName="my-project:us-central1:my-db"))
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client = client_cls.return_value
            client.get_service.side_effect = self.module.NotFound("no such service")
            client.create_service.return_value.result.return_value = MagicMock(uri="https://x")

            self.module.main()

        submitted_service = client.create_service.call_args.kwargs["service"]
        container = submitted_service.template.containers[0]
        self.assertEqual(container.volume_mounts[0].name, "cloudsql")
        self.assertEqual(container.volume_mounts[0].mount_path, "/cloudsql")
        self.assertEqual(container.env[0].name, "CLOUD_SQL_CONNECTION_NAME")
        self.assertEqual(container.env[0].value, "my-project:us-central1:my-db")
        volume = submitted_service.template.volumes[0]
        self.assertEqual(volume.name, "cloudsql")
        self.assertEqual(volume.cloud_sql_instance.instances, ["my-project:us-central1:my-db"])

    def test_no_cloud_sql_connection_name_means_no_volume_at_all(self) -> None:
        self._write_request(_VALID_INPUTS)  # no cloudSqlConnectionName
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client = client_cls.return_value
            client.get_service.side_effect = self.module.NotFound("no such service")
            client.create_service.return_value.result.return_value = MagicMock(uri="https://x")

            self.module.main()

        submitted_service = client.create_service.call_args.kwargs["service"]
        self.assertEqual(list(submitted_service.template.volumes), [])
        self.assertEqual(list(submitted_service.template.containers[0].volume_mounts), [])

    def test_get_service_api_error_is_a_retryable_failure(self) -> None:
        self._write_request(_VALID_INPUTS)
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client = client_cls.return_value
            client.get_service.side_effect = self.module.GoogleAPIError("transient")
            exit_code = self.module.main()

        self.assertEqual(exit_code, 1)
        result = self._result()
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertTrue(result["error"]["retryable"])


    def test_a_refusal_is_not_retried(self) -> None:
        # Cloud Run's create without read access to the image's repository.
        self._write_request(_VALID_INPUTS)
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client = client_cls.return_value
            client.get_service.side_effect = self.module.NotFound("no such service")
            client.create_service.side_effect = __import__("google.api_core.exceptions", fromlist=["PermissionDenied"]).PermissionDenied(
                "Permission 'artifactregistry.repositories.downloadArtifacts' denied")
            self.assertEqual(self.module.main(), 1)

        result = self._result()
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertFalse(result["error"]["retryable"])

    def test_a_deploy_still_running_when_the_wait_ends_is_retried(self) -> None:
        self._write_request({"projectId": "p", "serviceName": "hello", "image": _VALID_INPUTS["image"]})
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            client = client_cls.return_value
            client.get_service.side_effect = self.module.NotFound("no such service")
            client.create_service.return_value.result.side_effect = TimeoutError()
            self.assertEqual(self.module.main(), 1)
        error = self._result()["error"]
        self.assertEqual((error["code"], error["retryable"]), ("GCP_TIMEOUT", True))

    def test_google_unreachable_to_sign_in_is_retried(self) -> None:
        self._write_request({"projectId": "p", "serviceName": "hello", "image": _VALID_INPUTS["image"]})
        with patch.object(self.module.run_v2, "ServicesClient") as client_cls:
            self.adc.refresh.side_effect = self.module.google.auth.exceptions.TransportError("reset")
            self.assertEqual(self.module.main(), 1)
        client_cls.return_value.get_service.assert_not_called()
        error = self._result()["error"]
        self.assertEqual((error["code"], error["retryable"]), ("GCP_SIGN_IN_FAILED", True))


class BuildCredentialsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
        # Where the team secret gcp-target would be mounted: absent until a test writes it.
        self.module.TARGET_SERVICE_ACCOUNT_FILE = Path(tempfile.mkdtemp()) / "service-account"
        _mount_settings(self.module, Path(tempfile.mkdtemp()))

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
            patch.object(self.module.run_v2, "ServicesClient") as client_cls,
        ):
            default_mock.return_value = (MagicMock(), "some-project")
            client_cls.return_value.get_service.return_value = MagicMock(uri="https://x", labels={})

            self.module.INPUT_PATH = Path(tempfile.mkstemp()[1])
            self.module.OUTPUT_PATH = Path(tempfile.mkstemp()[1])
            self.module.INPUT_PATH.write_text(json.dumps({"forTeam": "web", "inputs": _VALID_INPUTS}))

            self.module.main()

        client_cls.assert_called_once_with(credentials=creds_cls.return_value)


if __name__ == "__main__":
    unittest.main()
