"""Tests for aws/s3-bucket's create action, with boto3 mocked, so they run
without an AWS account. `./vennir catalog check` runs them in the product's own
image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError

_MODULE_PATH = Path(__file__).parent / "create.py"


def _load_create_module():
    spec = importlib.util.spec_from_file_location("aws_s3_bucket_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _client_error(code: str, status: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "test"}, "ResponseMetadata": {"HTTPStatusCode": status}},
        "operation",
    )


class CreateActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, inputs: dict, team: str | None = "web") -> tuple[int, dict, object]:
        self.module.INPUT_PATH.write_text(json.dumps({"forTeam": team, "inputs": inputs} if team else {"inputs": inputs}))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            s3 = session_cls.return_value.client.return_value
            self.configure(s3)
            exit_code = self.module.main()
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text()), s3

    def configure(self, s3) -> None:  # overridden per test
        pass

    def test_missing_input_fails_without_calling_aws(self) -> None:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {"bucketName": "b"}}))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            self.assertEqual(self.module.main(), 1)
        session_cls.assert_not_called()

    def test_an_existing_bucket_is_left_alone(self) -> None:
        self.configure = lambda s3: setattr(s3.head_bucket, "return_value", {"BucketRegion": "eu-west-1"})
        exit_code, result, s3 = self._run({"bucketName": "b", "region": "eu-west-1"})
        self.assertEqual(exit_code, 0)
        # Not reported: its cleanup mustn't delete a bucket it didn't make.
        self.assertEqual(result["outputs"], {"bucketName": "b", "region": "eu-west-1", "arn": "arn:aws:s3:::b"})
        s3.create_bucket.assert_not_called()
        s3.put_public_access_block.assert_not_called()

    def test_a_bucket_it_made_is_reported_when_found_again(self) -> None:
        def configure(s3):
            s3.head_bucket.return_value = {"BucketRegion": "eu-west-1"}
            s3.get_bucket_tagging.return_value = {"TagSet": [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}]}
        self.configure = configure
        _, result, s3 = self._run({"bucketName": "b", "region": "eu-west-1"})
        self.assertEqual(result["outputs"]["resources"][0]["id"], "b")
        # Put again: the step that made it may have stopped before it did.
        block = s3.put_public_access_block.call_args.kwargs["PublicAccessBlockConfiguration"]
        self.assertTrue(all(block.values()))
        s3.create_bucket.assert_not_called()
        # Made by this product for another team: not this team's to delete.
        _, result, _ = self._run({"bucketName": "b", "region": "eu-west-1"}, team="data")
        self.assertNotIn("resources", result["outputs"])

    def test_a_request_without_a_team_is_refused(self) -> None:
        self.configure = lambda s3: setattr(s3.head_bucket, "side_effect", _client_error("404", 404))
        exit_code, result, s3 = self._run({"bucketName": "b", "region": "eu-west-1"}, team=None)
        self.assertEqual((exit_code, result["error"]["code"]), (1, "MISSING_TEAM"))
        s3.create_bucket.assert_not_called()

    def test_a_retry_finishes_after_the_block_failed(self) -> None:
        # Attempt 1: created (tagged), then throttled putting the block.
        def first(s3):
            s3.head_bucket.side_effect = _client_error("404", 404)
            s3.put_public_access_block.side_effect = _client_error("SlowDown", 503)
        self.configure = first
        exit_code, result, _ = self._run({"bucketName": "b", "region": "eu-west-1"})
        self.assertEqual((exit_code, result["error"]["retryable"]), (1, True))

        # Attempt 2 finds it, tagged as its own: blocked, and reported.
        def second(s3):
            s3.head_bucket.return_value = {"BucketRegion": "eu-west-1"}
            s3.get_bucket_tagging.return_value = {"TagSet": [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}]}
        self.configure = second
        exit_code, result, s3 = self._run({"bucketName": "b", "region": "eu-west-1"})
        self.assertEqual(exit_code, 0)
        s3.put_public_access_block.assert_called_once()
        self.assertEqual(result["outputs"]["resources"][0]["id"], "b")

    def test_a_bucket_made_a_moment_ago_is_known_by_its_tag(self) -> None:
        for tags, made in (([{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}], True), ([], False)):
            def configure(s3, tags=tags):
                s3.head_bucket.side_effect = _client_error("404", 404)
                s3.create_bucket.side_effect = _client_error("BucketAlreadyOwnedByYou", 409)
                s3.get_bucket_tagging.return_value = {"TagSet": tags}
            self.configure = configure
            exit_code, result, s3 = self._run({"bucketName": "b", "region": "eu-west-1"})
            self.assertEqual(exit_code, 0)
            self.assertEqual("resources" in result["outputs"], made)
            self.assertEqual(s3.put_public_access_block.called, made)

    def test_a_create_denied_names_tag_resource(self) -> None:
        # A role granted from the older README: s3:PutBucketTagging, not s3:TagResource.
        def configure(s3):
            s3.head_bucket.side_effect = _client_error("404", 404)
            s3.create_bucket.side_effect = _client_error("AccessDenied", 403)
        self.configure = configure
        exit_code, result, _ = self._run({"bucketName": "b", "region": "eu-west-1"})
        self.assertEqual(exit_code, 1)
        self.assertFalse(result["error"]["retryable"])
        self.assertIn("s3:TagResource", result["error"]["message"])

    def test_another_accounts_name_found_at_create_is_refused(self) -> None:
        def configure(s3):
            s3.head_bucket.side_effect = _client_error("404", 404)
            s3.create_bucket.side_effect = _client_error("BucketAlreadyExists", 409)
        self.configure = configure
        exit_code, result, _ = self._run({"bucketName": "b", "region": "eu-west-1"})
        self.assertEqual((exit_code, result["error"]["code"]), (1, "BUCKET_NAME_TAKEN"))

    def test_a_missing_bucket_is_created_private(self) -> None:
        self.configure = lambda s3: setattr(s3.head_bucket, "side_effect", _client_error("404", 404))
        exit_code, result, s3 = self._run({"bucketName": "b", "region": "eu-west-1"})
        self.assertEqual(exit_code, 0)
        # Tagged as it's made, so a step cut short after this still finds it its own.
        s3.create_bucket.assert_called_once_with(
            Bucket="b",
            CreateBucketConfiguration={"LocationConstraint": "eu-west-1", "Tags": [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}]},
        )
        block = s3.put_public_access_block.call_args.kwargs["PublicAccessBlockConfiguration"]
        self.assertTrue(all(block.values()))
        self.assertEqual(
            result["outputs"]["resources"],
            [{"type": "aws/s3-bucket", "id": "b", "link": "https://eu-west-1.console.aws.amazon.com/s3/buckets/b?region=eu-west-1"}],
        )

    def test_us_east_1_gets_no_location_constraint(self) -> None:
        self.configure = lambda s3: setattr(s3.head_bucket, "side_effect", _client_error("404", 404))
        _, _, s3 = self._run({"bucketName": "b", "region": "us-east-1"})
        s3.create_bucket.assert_called_once_with(
            Bucket="b", CreateBucketConfiguration={"Tags": [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}]}
        )

    def test_someone_elses_bucket_is_a_clear_refusal(self) -> None:
        self.configure = lambda s3: setattr(s3.head_bucket, "side_effect", _client_error("403", 403))
        exit_code, result, s3 = self._run({"bucketName": "taken", "region": "eu-west-1"})
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["error"]["code"], "BUCKET_NAME_TAKEN")
        self.assertFalse(result["error"]["retryable"])
        s3.create_bucket.assert_not_called()

    def test_throttling_is_retryable_and_access_denied_isnt(self) -> None:
        for code, status, retryable in (("SlowDown", 503, True), ("AccessDenied", 403, False)):
            def configure(s3, code=code, status=status):
                s3.head_bucket.side_effect = _client_error("404", 404)
                s3.create_bucket.side_effect = _client_error(code, status)
            self.configure = configure
            _, result, _ = self._run({"bucketName": "b", "region": "eu-west-1"})
            self.assertEqual(result["error"]["code"], "AWS_API_ERROR")
            self.assertEqual(result["error"]["retryable"], retryable, code)


class SessionTest(unittest.TestCase):
    """The aws-target role: with the default credentials (EKS), or off EKS
    (none) by web identity with the step's own token, unsigned."""

    CREDENTIALS = {"Credentials": {"AccessKeyId": "ASIAEXAMPLE", "SecretAccessKey": "not-a-secret", "SessionToken": "t"}}

    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.TARGET_ROLE_FILE = Path(self.tmp_dir.name) / "role-arn"
        self.module.TOKEN_FILE = Path(self.tmp_dir.name) / "sts.amazonaws.com"
        self.module.TARGET_ROLE_FILE.write_text("arn:aws:iam::123456789012:role/acts-as\n")
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

    def test_off_eks_the_target_role_by_web_identity(self) -> None:
        session, sts = self._session(None)
        sts.assume_role_with_web_identity.assert_called_once_with(
            RoleArn="arn:aws:iam::123456789012:role/acts-as", RoleSessionName="vennir-step", WebIdentityToken="the-projected-token")
        sts.assume_role.assert_not_called()
        self.assertEqual(session.client.call_args.kwargs["config"].signature_version, self.module.UNSIGNED)

    def test_on_eks_the_target_role_with_its_credentials(self) -> None:
        _, sts = self._session(object())
        sts.assume_role.assert_called_once_with(RoleArn="arn:aws:iam::123456789012:role/acts-as", RoleSessionName="vennir-step")
        sts.assume_role_with_web_identity.assert_not_called()


if __name__ == "__main__":
    unittest.main()
