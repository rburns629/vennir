"""Tests for aws/app-runner's create action, with boto3 mocked, so they run
without an AWS account. `./vennir catalog check` runs them in the product's own
image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_MODULE_PATH = Path(__file__).parent / "create.py"

RUNNING = {"ServiceName": "web", "Status": "RUNNING", "ServiceUrl": "abc.awsapprunner.com", "ServiceArn": "arn:svc"}


def _load_create_module():
    spec = importlib.util.spec_from_file_location("aws_app_runner_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.POLL_SECONDS = 0
    return module


class CreateActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, inputs: dict, configure, team: str | None = "web") -> tuple[int, dict, object]:
        self.module.INPUT_PATH.write_text(json.dumps({"forTeam": team, "inputs": inputs} if team else {"inputs": inputs}))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            client = session_cls.return_value.client.return_value
            configure(client)
            exit_code = self.module.main()
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text()), client

    def test_missing_input_fails_without_calling_aws(self) -> None:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {"serviceName": "web"}}))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            self.assertEqual(self.module.main(), 1)
        session_cls.assert_not_called()

    def test_an_existing_service_is_left_alone(self) -> None:
        def configure(client):
            client.list_services.return_value = {"ServiceSummaryList": [RUNNING]}
        exit_code, result, client = self._run(
            {"serviceName": "web", "image": "123.dkr.ecr.eu-west-1.amazonaws.com/web:1", "region": "eu-west-1"},
            configure,
        )
        self.assertEqual(exit_code, 0)
        # Not reported: its cleanup mustn't delete a service it didn't make.
        self.assertEqual(result["outputs"], {"serviceUrl": "https://abc.awsapprunner.com", "serviceArn": "arn:svc"})
        client.create_service.assert_not_called()

    def test_a_service_it_made_is_reported_when_found_again(self) -> None:
        def configure(client):
            client.list_services.return_value = {"ServiceSummaryList": [RUNNING]}
            client.list_tags_for_resource.return_value = {"Tags": [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}]}
        _, result, _ = self._run({"serviceName": "web", "image": "i", "region": "eu-west-1"}, configure)
        self.assertEqual(result["outputs"]["resources"][0]["id"], "arn:svc")
        # Made by this product for another team: not this team's to delete.
        _, result, _ = self._run({"serviceName": "web", "image": "i", "region": "eu-west-1"}, configure, team="data")
        self.assertNotIn("resources", result["outputs"])

    def test_a_request_without_a_team_is_refused(self) -> None:
        def configure(client):
            client.list_services.return_value = {"ServiceSummaryList": []}
        exit_code, result, client = self._run({"serviceName": "web", "image": "i", "region": "eu-west-1"}, configure, team=None)
        self.assertEqual((exit_code, result["error"]["code"]), (1, "MISSING_TEAM"))
        client.create_service.assert_not_called()

    def test_an_existing_service_still_starting_is_waited_for(self) -> None:
        # A retry finding the service its last attempt was still creating.
        def configure(client):
            client.list_services.return_value = {"ServiceSummaryList": [{**RUNNING, "Status": "OPERATION_IN_PROGRESS"}]}
            client.list_tags_for_resource.return_value = {"Tags": [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}]}
            client.describe_service.side_effect = [
                {"Service": {**RUNNING, "Status": "OPERATION_IN_PROGRESS"}},
                {"Service": RUNNING},
            ]
        exit_code, result, client = self._run({"serviceName": "web", "image": "i", "region": "eu-west-1"}, configure)
        self.assertEqual(exit_code, 0)
        self.assertEqual(client.describe_service.call_count, 2)
        client.create_service.assert_not_called()
        self.assertEqual(result["outputs"]["serviceUrl"], "https://abc.awsapprunner.com")
        self.assertEqual(result["outputs"]["resources"][0]["id"], "arn:svc")

    def test_an_existing_service_still_starting_at_the_deadline_is_retryable(self) -> None:
        self.module.START_TIMEOUT_SECONDS = 0
        def configure(client):
            client.list_services.return_value = {"ServiceSummaryList": [{**RUNNING, "Status": "OPERATION_IN_PROGRESS"}]}
        exit_code, result, _ = self._run({"serviceName": "web", "image": "i", "region": "eu-west-1"}, configure)
        self.assertEqual(exit_code, 1)
        self.assertEqual((result["error"]["code"], result["error"]["retryable"]), ("SERVICE_NOT_RUNNING", True))

    def test_an_existing_service_that_failed_fails_for_good(self) -> None:
        for status in ("CREATE_FAILED", "DELETE_FAILED", "PAUSED"):
            with self.subTest(status=status):
                def configure(client):
                    client.list_services.return_value = {"ServiceSummaryList": [{**RUNNING, "Status": status}]}
                exit_code, result, client = self._run({"serviceName": "web", "image": "i", "region": "eu-west-1"}, configure)
                self.assertEqual(exit_code, 1)
                self.assertEqual((result["error"]["code"], result["error"]["retryable"]), ("SERVICE_NOT_RUNNING", False))
                client.create_service.assert_not_called()

    def test_a_private_service_has_no_url(self) -> None:
        # App Runner gives a private service no ServiceUrl (found on EKS, 2026-10-25).
        private = {k: v for k, v in RUNNING.items() if k != "ServiceUrl"}
        def configure(client):
            client.list_services.return_value = {"ServiceSummaryList": []}
            client.create_service.return_value = {"Service": {**private, "Status": "OPERATION_IN_PROGRESS"}}
            client.describe_service.return_value = {"Service": private}
        exit_code, result, _ = self._run({"serviceName": "web", "image": "i", "region": "eu-west-1"}, configure)
        self.assertEqual(exit_code, 0)
        self.assertNotIn("serviceUrl", result["outputs"])
        self.assertEqual(result["outputs"]["serviceArn"], "arn:svc")

    def test_a_new_service_is_private_by_default_and_waited_for(self) -> None:
        def configure(client):
            client.list_services.return_value = {"ServiceSummaryList": []}
            client.create_service.return_value = {"Service": {**RUNNING, "Status": "OPERATION_IN_PROGRESS"}}
            client.describe_service.return_value = {"Service": RUNNING}
        exit_code, result, client = self._run(
            {"serviceName": "web", "image": "public.ecr.aws/x/web:1", "region": "eu-west-1",
             "environment": {"BUCKET": "b"}},
            configure,
        )
        self.assertEqual(exit_code, 0)
        kwargs = client.create_service.call_args.kwargs
        self.assertFalse(kwargs["NetworkConfiguration"]["IngressConfiguration"]["IsPubliclyAccessible"])
        repository = kwargs["SourceConfiguration"]["ImageRepository"]
        self.assertEqual(repository["ImageRepositoryType"], "ECR_PUBLIC")
        self.assertEqual(repository["ImageConfiguration"]["RuntimeEnvironmentVariables"], {"BUCKET": "b"})
        self.assertEqual(result["outputs"]["serviceUrl"], "https://abc.awsapprunner.com")
        self.assertEqual(kwargs["Tags"], [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}])
        self.assertEqual(result["outputs"]["resources"][0], {
            "type": "aws/app-runner-service", "id": "arn:svc", "name": "web",
            "link": "https://eu-west-1.console.aws.amazon.com/apprunner/home?region=eu-west-1#/services",
        })

    def test_a_service_that_fails_to_start_fails_the_step(self) -> None:
        def configure(client):
            client.list_services.return_value = {"ServiceSummaryList": []}
            client.create_service.return_value = {"Service": {**RUNNING, "Status": "CREATE_FAILED"}}
        exit_code, result, _ = self._run(
            {"serviceName": "web", "image": "123.dkr.ecr.eu-west-1.amazonaws.com/web:1", "region": "eu-west-1"},
            configure,
        )
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["error"]["code"], "SERVICE_NOT_RUNNING")
        self.assertFalse(result["error"]["retryable"])

    def test_non_string_environment_values_are_refused(self) -> None:
        self.module.INPUT_PATH.write_text(json.dumps({"forTeam": "web", "inputs": {
            "serviceName": "web", "image": "i", "region": "r", "environment": {"PORT": 8080}}}))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            self.assertEqual(self.module.main(), 1)
        session_cls.assert_not_called()


class SessionTest(unittest.TestCase):
    """Signing in: on EKS the default credentials; off EKS (none) its own
    role by web identity with the step's token, unsigned; then aws-target,
    when given, assumed as that."""

    CREDENTIALS = {"Credentials": {"AccessKeyId": "ASIAEXAMPLE", "SecretAccessKey": "not-a-secret", "SessionToken": "t"}}
    OWN = "arn:aws:iam::123456789012:role/own"
    TARGET = "arn:aws:iam::123456789012:role/acts-as"

    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.TARGET_ROLE_FILE = Path(self.tmp_dir.name) / "role-arn"
        self.module.OWN_ROLE_FILE = Path(self.tmp_dir.name) / "own-role-arn"
        self.module.TOKEN_FILE = Path(self.tmp_dir.name) / "sts.amazonaws.com"
        self.module.OWN_ROLE_FILE.write_text(self.OWN + "\n")
        self.module.TOKEN_FILE.write_text("the-projected-token\n")

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _session(self, credentials) -> tuple[object, object]:
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            session_cls.return_value.get_credentials.return_value = credentials
            sts = session_cls.return_value.client.return_value
            sts.assume_role.return_value = sts.assume_role_with_web_identity.return_value = self.CREDENTIALS
            self.module._session("us-east-2")
        return session_cls.return_value, sts

    def test_off_eks_its_own_role_by_web_identity(self) -> None:
        session, sts = self._session(None)
        sts.assume_role_with_web_identity.assert_called_once_with(
            RoleArn=self.OWN, RoleSessionName="vennir-step", WebIdentityToken="the-projected-token")
        sts.assume_role.assert_not_called()
        self.assertEqual(session.client.call_args_list[0].kwargs["config"].signature_version, self.module.UNSIGNED)

    def test_off_eks_then_aws_target_as_its_own_role(self) -> None:
        self.module.TARGET_ROLE_FILE.write_text(self.TARGET)
        _, sts = self._session(None)
        sts.assume_role_with_web_identity.assert_called_once()
        sts.assume_role.assert_called_once_with(RoleArn=self.TARGET, RoleSessionName="vennir-step")

    def test_on_eks_the_default_credentials_then_aws_target(self) -> None:
        self.module.TARGET_ROLE_FILE.write_text(self.TARGET)
        _, sts = self._session(object())
        sts.assume_role_with_web_identity.assert_not_called()
        sts.assume_role.assert_called_once_with(RoleArn=self.TARGET, RoleSessionName="vennir-step")

    def test_off_eks_without_its_token_there_are_no_credentials(self) -> None:
        self.module.TOKEN_FILE.unlink()
        with self.assertRaises(self.module.NoCredentialsError):
            self._session(None)


if __name__ == "__main__":
    unittest.main()
