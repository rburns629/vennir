"""Tests for aws/ecs-express's create action, with boto3 mocked, so they run
without an AWS account. `./vennir catalog check` runs them in the product's
own image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError

_MODULE_PATH = Path(__file__).parent / "create.py"

ACCOUNT = "123456789012"
ARN = f"arn:aws:ecs:us-east-2:{ACCOUNT}:service/default/web"
# A prefix the team's images are under: an ECR registry and a namespace in it.
REGISTRY = f"{ACCOUNT}.dkr.ecr.us-east-2.amazonaws.com/aws"
URL = "https://ve-0123abcd.ecs.us-east-2.on.aws"
TAGS = [{"key": "vennir-made", "value": "true"}, {"key": "vennir-team", "value": "web"}]
EXECUTION_ROLE = f"arn:aws:iam::{ACCOUNT}:role/web-execution"
TASK_DEFINITION = f"arn:aws:ecs:us-east-2:{ACCOUNT}:task-definition/default-web:1"
# What describe reports of a service made from INPUTS, as ECS fills it in.
CONFIGURATION = {
    "executionRoleArn": EXECUTION_ROLE,
    "taskDefinitionArn": TASK_DEFINITION,
    "primaryContainer": {
        "image": f"{REGISTRY}/web:1", "containerPort": 8080,
        "awsLogsConfiguration": {"logGroup": "/aws/ecs/default/web-ab12", "logStreamPrefix": "ecs"},
    },
    "healthCheckPath": "/", "cpu": "256", "memory": "512",
    "scalingTarget": {"minTaskCount": 1, "maxTaskCount": 2, "autoScalingMetric": "AVERAGE_CPU", "autoScalingTargetValue": 60},
    "networkConfiguration": {"subnets": ["subnet-0a", "subnet-0b"], "securityGroups": ["sg-0a"]},
    "ingressPaths": [{"accessType": "PUBLIC", "endpoint": URL}],
    "createdAt": "2026-11-07 15:00:00+00:00",
}
SERVICE = {
    "serviceName": "web", "serviceArn": ARN, "status": {"statusCode": "ACTIVE"},
    "activeConfigurations": [CONFIGURATION],
}
INPUTS = {"serviceName": "web", "image": f"{REGISTRY}/web:1", "region": "us-east-2"}


def _not_found(code: str = "ClusterNotFoundException") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "not found"}}, "DescribeExpressGatewayService")


def _rollout(state: str, running: int = 1, task_definition: str = TASK_DEFINITION) -> dict:
    return {"services": [{"runningCount": running, "deployments": [
        {"status": "PRIMARY", "rolloutState": state, "taskDefinition": task_definition}]}]}


def _then(first, service: dict):
    """describe's answers: first (an error to raise, or a service), then the
    service for every call after."""
    calls = []
    def answer(**_):
        calls.append(1)
        if len(calls) == 1:
            if isinstance(first, Exception):
                raise first
            return {"service": first}
        return {"service": service}
    return answer


def _load_create_module():
    spec = importlib.util.spec_from_file_location("aws_ecs_express_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.POLL_SECONDS = 0
    # Every URL answers, unless a test says otherwise.
    module._answers = lambda url: True
    return module


class CreateActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp_dir.name)
        self.module.INPUT_PATH = tmp / "request.json"
        self.module.OUTPUT_PATH = tmp / "result.json"
        self.module.SETTINGS_DIR = tmp / "ecs-express"
        self.module.SETTINGS_DIR.mkdir()
        for key, value in {
            "image-registry": REGISTRY + "\n",
            "execution-role-arn": f"arn:aws:iam::{ACCOUNT}:role/web-execution",
            "infrastructure-role-arn": f"arn:aws:iam::{ACCOUNT}:role/web-infrastructure",
        }.items():
            (self.module.SETTINGS_DIR / key).write_text(value)

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, inputs: dict, configure, team: str | None = "web") -> tuple[int, dict, object]:
        self.module.INPUT_PATH.write_text(json.dumps({"forTeam": team, "inputs": inputs} if team else {"inputs": inputs}))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            client = session_cls.return_value.client.return_value
            client.get_caller_identity.return_value = {"Arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/r/s", "Account": ACCOUNT}
            configure(client)
            exit_code = self.module.main()
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text()), client

    def _refused_without_calling_aws(self, inputs: dict) -> dict:
        self.module.INPUT_PATH.write_text(json.dumps({"forTeam": "web", "inputs": inputs}))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            self.assertEqual(self.module.main(), 1)
        session_cls.assert_not_called()
        return json.loads(self.module.OUTPUT_PATH.read_text())["error"]

    def test_missing_input_fails_without_calling_aws(self) -> None:
        self.assertEqual(self._refused_without_calling_aws({"serviceName": "web"})["code"], "MISSING_INPUT")

    def test_an_image_outside_the_teams_registry_is_refused(self) -> None:
        for image in ("public.ecr.aws/nginx/nginx:latest", f"{REGISTRY}-other/web:1", f"{REGISTRY}:1"):
            with self.subTest(image=image):
                error = self._refused_without_calling_aws({**INPUTS, "image": image})
                self.assertEqual(error["code"], "IMAGE_OUTSIDE_REGISTRY")

    def test_without_the_teams_secret_nothing_is_deployed(self) -> None:
        (self.module.SETTINGS_DIR / "execution-role-arn").unlink()
        self.assertEqual(self._refused_without_calling_aws(INPUTS)["code"], "MISSING_SECRET")

    def test_a_bad_service_name_or_environment_is_refused(self) -> None:
        self.assertEqual(self._refused_without_calling_aws({**INPUTS, "serviceName": "-web"})["code"], "INVALID_INPUT")
        self.assertEqual(self._refused_without_calling_aws({**INPUTS, "environment": {"PORT": 8080}})["code"], "INVALID_INPUT")

    def test_a_request_without_a_team_is_refused(self) -> None:
        exit_code, result, client = self._run(INPUTS, lambda client: None, team=None)
        self.assertEqual((exit_code, result["error"]["code"]), (1, "MISSING_TEAM"))
        client.create_express_gateway_service.assert_not_called()

    def test_a_new_service_is_made_with_the_teams_roles_and_waited_for(self) -> None:
        def configure(client):
            client.describe_express_gateway_service.side_effect = _then(_not_found(), {**SERVICE, "tags": TAGS})
            client.create_express_gateway_service.return_value = {"service": SERVICE}
            client.describe_services.side_effect = [_rollout("IN_PROGRESS", 0), _rollout("COMPLETED")]
        exit_code, result, client = self._run(
            {**INPUTS, "port": 80, "environment": {"BUCKET": "b"}, "subnets": ["subnet-0a"]}, configure)
        self.assertEqual(exit_code, 0)
        client.describe_express_gateway_service.assert_any_call(serviceArn=ARN, include=["TAGS"])
        kwargs = client.create_express_gateway_service.call_args.kwargs
        self.assertEqual(kwargs["executionRoleArn"], EXECUTION_ROLE)
        self.assertEqual(kwargs["infrastructureRoleArn"], f"arn:aws:iam::{ACCOUNT}:role/web-infrastructure")
        self.assertNotIn("taskRoleArn", kwargs)  # the app itself gets no AWS role
        self.assertEqual(kwargs["primaryContainer"], {
            "image": f"{REGISTRY}/web:1", "containerPort": 80, "environment": [{"name": "BUCKET", "value": "b"}]})
        self.assertEqual((kwargs["cluster"], kwargs["healthCheckPath"], kwargs["cpu"], kwargs["memory"]), ("default", "/", "256", "512"))
        self.assertEqual(kwargs["scalingTarget"], {"minTaskCount": 1, "maxTaskCount": 2})
        self.assertEqual(kwargs["networkConfiguration"], {"subnets": ["subnet-0a"]})
        self.assertEqual(kwargs["tags"], TAGS)
        self.assertEqual(client.describe_services.call_count, 2)
        self.assertEqual(result["outputs"], {
            "serviceArn": ARN, "serviceUrl": URL,
            "resources": [{
                "type": "aws/ecs-express-service", "id": ARN, "name": "web",
                "link": "https://us-east-2.console.aws.amazon.com/ecs/v2/clusters/default/services/web?region=us-east-2",
            }],
        })

    def test_without_subnets_it_uses_the_default_vpc(self) -> None:
        def configure(client):
            client.describe_express_gateway_service.side_effect = _then(_not_found("ResourceNotFoundException"), SERVICE)
            client.create_express_gateway_service.return_value = {"service": SERVICE}
            client.describe_services.return_value = _rollout("COMPLETED")
        exit_code, _, client = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 0)
        self.assertNotIn("networkConfiguration", client.create_express_gateway_service.call_args.kwargs)
        self.assertEqual(client.create_express_gateway_service.call_args.kwargs["primaryContainer"]["containerPort"], 8080)

    def test_an_existing_service_is_left_alone_and_not_reported(self) -> None:
        def configure(client):
            client.describe_express_gateway_service.return_value = {"service": {**SERVICE, "tags": []}}
            client.describe_services.return_value = _rollout("COMPLETED")
        exit_code, result, client = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 0)
        client.create_express_gateway_service.assert_not_called()
        # Not reported: its cleanup mustn't delete a service it didn't make.
        self.assertEqual(result["outputs"], {"serviceArn": ARN, "serviceUrl": URL})

    def test_a_service_it_made_is_reported_when_found_again_for_its_team_only(self) -> None:
        def configure(client):
            client.describe_express_gateway_service.return_value = {"service": {**SERVICE, "tags": TAGS}}
            client.describe_services.return_value = _rollout("COMPLETED")
        _, result, _ = self._run(INPUTS, configure)
        self.assertEqual(result["outputs"]["resources"][0]["id"], ARN)
        # Made by this product for another team: not this team's to delete.
        _, result, _ = self._run(INPUTS, configure, team="data")
        self.assertNotIn("resources", result["outputs"])

    def test_a_deleted_service_of_that_name_is_made_again(self) -> None:
        def configure(client):
            client.describe_express_gateway_service.side_effect = _then({**SERVICE, "status": {"statusCode": "INACTIVE"}}, SERVICE)
            client.create_express_gateway_service.return_value = {"service": SERVICE}
            client.describe_services.return_value = _rollout("COMPLETED")
        exit_code, _, client = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 0)
        client.create_express_gateway_service.assert_called_once()

    def test_a_service_being_deleted_is_retryable(self) -> None:
        def configure(client):
            client.describe_express_gateway_service.return_value = {"service": {**SERVICE, "status": {"statusCode": "DRAINING"}}}
        exit_code, result, client = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 1)
        self.assertEqual((result["error"]["code"], result["error"]["retryable"]), ("SERVICE_DELETING", True))
        client.create_express_gateway_service.assert_not_called()

    def test_a_rollout_still_going_at_the_deadline_is_retryable(self) -> None:
        self.module.START_TIMEOUT_SECONDS = 0
        def configure(client):
            client.describe_express_gateway_service.return_value = {"service": {**SERVICE, "tags": TAGS}}
            client.describe_services.return_value = _rollout("IN_PROGRESS", 0)
        exit_code, result, _ = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 1)
        self.assertEqual((result["error"]["code"], result["error"]["retryable"]), ("SERVICE_NOT_RUNNING", True))

    def test_a_failed_rollout_fails_for_good(self) -> None:
        def configure(client):
            client.describe_express_gateway_service.side_effect = _then(_not_found(), SERVICE)
            client.create_express_gateway_service.return_value = {"service": SERVICE}
            client.describe_services.return_value = _rollout("FAILED", 0)
        exit_code, result, _ = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 1)
        self.assertEqual((result["error"]["code"], result["error"]["retryable"]), ("SERVICE_NOT_RUNNING", False))

    def test_a_public_service_is_waited_for_until_its_url_answers(self) -> None:
        asked = []
        answers = iter([False, False, True])
        self.module._answers = lambda url: asked.append(url) or next(answers)
        def configure(client):
            client.describe_express_gateway_service.return_value = {"service": {**SERVICE, "tags": TAGS}}
            client.describe_services.return_value = _rollout("COMPLETED")
        exit_code, _, _ = self._run({**INPUTS, "healthCheckPath": "/health"}, configure)
        self.assertEqual(exit_code, 0)
        self.assertEqual(asked, [URL + "/health"] * 3)

    def test_a_public_service_whose_url_never_answers_is_retryable(self) -> None:
        self.module.SERVE_TIMEOUT_SECONDS = 0
        self.module._answers = lambda url: False
        def configure(client):
            client.describe_express_gateway_service.return_value = {"service": {**SERVICE, "tags": TAGS}}
            client.describe_services.return_value = _rollout("COMPLETED")
        exit_code, result, _ = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 1)
        self.assertEqual((result["error"]["code"], result["error"]["retryable"]), ("SERVICE_NOT_RUNNING", True))

    def test_a_private_service_isnt_asked_at_its_url(self) -> None:
        self.module._answers = lambda url: self.fail("asked a private service's URL")
        private = {**SERVICE, "tags": TAGS, "activeConfigurations": [
            {**CONFIGURATION, "ingressPaths": [{"accessType": "PRIVATE", "endpoint": URL}]}]}
        def configure(client):
            client.describe_express_gateway_service.return_value = {"service": private}
            client.describe_services.return_value = _rollout("COMPLETED")
        exit_code, result, _ = self._run(INPUTS, configure)
        self.assertEqual((exit_code, result["outputs"]["serviceUrl"]), (0, URL))

    def test_a_service_it_made_for_this_team_is_brought_to_the_inputs(self) -> None:
        new_definition = TASK_DEFINITION[:-1] + "2"
        rolled = {**SERVICE, "tags": TAGS, "activeConfigurations": [
            {**CONFIGURATION, "taskDefinitionArn": new_definition, "createdAt": "2026-11-07 16:00:00+00:00",
             "primaryContainer": {**CONFIGURATION["primaryContainer"], "image": f"{REGISTRY}/web:2",
                                  "environment": [{"name": "MODE", "value": "new"}]}},
            CONFIGURATION]}
        def configure(client):
            client.describe_express_gateway_service.side_effect = _then({**SERVICE, "tags": TAGS}, rolled)
            client.update_express_gateway_service.return_value = {"service": {"serviceArn": ARN, "status": {"statusCode": "ACTIVE"}}}
            # The last deployment is still primary and done for a moment;
            # then the new one runs, and finishes.
            client.describe_services.side_effect = [
                _rollout("COMPLETED"), _rollout("IN_PROGRESS", 1, new_definition), _rollout("COMPLETED", 1, new_definition)]
        exit_code, result, client = self._run({**INPUTS, "image": f"{REGISTRY}/web:2", "environment": {"MODE": "new"}}, configure)
        self.assertEqual(exit_code, 0)
        client.create_express_gateway_service.assert_not_called()
        kwargs = client.update_express_gateway_service.call_args.kwargs
        self.assertEqual(kwargs["serviceArn"], ARN)
        self.assertEqual(kwargs["primaryContainer"], {
            "image": f"{REGISTRY}/web:2", "containerPort": 8080, "environment": [{"name": "MODE", "value": "new"}]})
        self.assertEqual(kwargs["executionRoleArn"], EXECUTION_ROLE)
        # Its autoscaling stays; its subnets, infrastructure role and tags aren't asked to change.
        self.assertEqual(kwargs["scalingTarget"], CONFIGURATION["scalingTarget"])
        for key in ("networkConfiguration", "infrastructureRoleArn", "tags"):
            self.assertNotIn(key, kwargs)
        self.assertEqual(client.describe_services.call_count, 3)
        self.assertEqual((result["outputs"]["serviceUrl"], result["outputs"]["resources"][0]["id"]), (URL, ARN))

    def test_a_configuration_still_rolling_out_is_waited_for_not_made_again(self) -> None:
        # A retry: the last attempt's update is the newest configuration.
        def configure(client):
            client.describe_express_gateway_service.return_value = {"service": {**SERVICE, "tags": TAGS}}
            client.describe_services.side_effect = [_rollout("IN_PROGRESS", 1), _rollout("COMPLETED")]
        exit_code, _, client = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 0)
        client.update_express_gateway_service.assert_not_called()
        client.create_express_gateway_service.assert_not_called()

    def test_one_made_some_other_way_is_changed_by_no_one(self) -> None:
        for tags in ([], [{"key": "vennir-made", "value": "true"}, {"key": "vennir-team", "value": "data"}]):
            with self.subTest(tags=tags):
                def configure(client):
                    client.describe_express_gateway_service.return_value = {"service": {**SERVICE, "tags": tags}}
                exit_code, result, client = self._run({**INPUTS, "image": f"{REGISTRY}/web:2"}, configure)
                self.assertEqual((exit_code, result["error"]["code"], result["error"]["retryable"]), (1, "SERVICE_EXISTS", False))
                self.assertIn("image", result["error"]["message"])
                client.update_express_gateway_service.assert_not_called()

    def test_its_subnets_stay_as_it_was_made(self) -> None:
        def configure(client):
            client.describe_express_gateway_service.return_value = {"service": {**SERVICE, "tags": TAGS}}
        exit_code, result, client = self._run({**INPUTS, "subnets": ["subnet-0c"]}, configure)
        self.assertEqual((exit_code, result["error"]["code"]), (1, "SUBNETS_CHANGED"))
        client.update_express_gateway_service.assert_not_called()
        # The same subnets, in any order, are no change.
        exit_code, _, client = self._run({**INPUTS, "subnets": ["subnet-0b", "subnet-0a"]},
                                         lambda c: (configure(c), setattr(c.describe_services, "return_value", _rollout("COMPLETED"))))
        self.assertEqual(exit_code, 0)
        client.update_express_gateway_service.assert_not_called()

    def test_a_role_not_yet_assumable_is_retryable(self) -> None:
        # IAM's eventual consistency, right after the team made its roles.
        def configure(client):
            client.describe_express_gateway_service.side_effect = [_not_found()]
            client.create_express_gateway_service.side_effect = ClientError(
                {"Error": {"Code": "InvalidParameterException", "Message": "Unable to assume the service linked role."}},
                "CreateExpressGatewayService")
        exit_code, result, _ = self._run(INPUTS, configure)
        self.assertEqual(exit_code, 1)
        self.assertEqual((result["error"]["code"], result["error"]["retryable"]), ("AWS_API_ERROR", True))

    def test_access_denied_fails_for_good(self) -> None:
        def configure(client):
            client.describe_express_gateway_service.side_effect = ClientError(
                {"Error": {"Code": "AccessDeniedException", "Message": "not authorized"}}, "DescribeExpressGatewayService")
        exit_code, result, _ = self._run(INPUTS, configure)
        self.assertEqual((exit_code, result["error"]["code"], result["error"]["retryable"]), (1, "AWS_API_ERROR", False))


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
