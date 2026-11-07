"""Tests for aws/rds-postgres's check action, with boto3 mocked, so they run
without an AWS account. `./vennir catalog check` runs them in the product's
own image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError, NoCredentialsError

_MODULE_PATH = Path(__file__).parent / "check.py"
ROLE_SESSION = "arn:aws:sts::123456789012:assumed-role/aws-rds-postgres/eks-session"
TARGET = "arn:aws:iam::123456789012:role/acts-as"


def _load_check_module():
    spec = importlib.util.spec_from_file_location("aws_rds_postgres_check", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _error(code: str, operation: str, status: int = 400) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "no"}, "ResponseMetadata": {"HTTPStatusCode": status}}, operation)


class CheckActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_check_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"
        self.module.TARGET_ROLE_FILE = Path(self.tmp_dir.name) / "role-arn"
        self.module.OWN_ROLE_FILE = Path(self.tmp_dir.name) / "own-role-arn"
        self.module.TOKEN_FILE = Path(self.tmp_dir.name) / "sts.amazonaws.com"
        # The default credentials: on EKS, Pod Identity's; off EKS, None.
        self.credentials = MagicMock()
        self.sts, self.rds, self.kms = MagicMock(), MagicMock(), MagicMock()
        self.sts.get_caller_identity.return_value = {"Arn": ROLE_SESSION, "Account": "123456789012"}
        self.sts.assume_role.return_value = {
            "AssumedRoleUser": {"Arn": "arn:aws:sts::123456789012:assumed-role/acts-as/vennir-check"},
            "Credentials": {"AccessKeyId": "AKIAEXAMPLE", "SecretAccessKey": "not-a-secret", "SessionToken": "token"},
        }

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self) -> tuple[int, dict]:
        clients = {"sts": self.sts, "rds": self.rds, "kms": self.kms}
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            session_cls.return_value.region_name = "eu-west-1"
            session_cls.return_value.get_credentials.return_value = self.credentials
            session_cls.return_value.client.side_effect = lambda name, **_: clients[name]
            exit_code = self.module.main()
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text())

    def test_ready_when_its_role_may_describe(self) -> None:
        exit_code, result = self._run()
        self.assertEqual(exit_code, 0)
        self.assertTrue(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["principal"], ROLE_SESSION)
        self.assertEqual(result["outputs"]["missing"], [])
        self.rds.describe_db_instances.assert_called_once_with(MaxRecords=20)
        self.kms.describe_key.assert_called_once_with(KeyId="alias/aws/secretsmanager")
        # It only asks.
        self.rds.create_db_instance.assert_not_called()

    def test_names_everything_its_role_lacks(self) -> None:
        self.rds.describe_db_instances.side_effect = _error("AccessDenied", "DescribeDBInstances")
        self.kms.describe_key.side_effect = _error("AccessDeniedException", "DescribeKey")
        _, result = self._run()
        self.assertFalse(result["outputs"]["ready"])
        self.assertEqual(result["outputs"]["missing"], [
            "rds:DescribeDBInstances (and the README's other RDS actions) for role aws-rds-postgres",
            "kms:DescribeKey for role aws-rds-postgres, for the managed password's key",
        ])

    def test_a_password_key_not_made_yet_is_fine(self) -> None:
        self.kms.describe_key.side_effect = _error("NotFoundException", "DescribeKey")
        _, result = self._run()
        self.assertTrue(result["outputs"]["ready"])

    def test_without_credentials_it_is_not_ready(self) -> None:
        self.sts.get_caller_identity.side_effect = NoCredentialsError()
        exit_code, result = self._run()
        self.assertEqual(exit_code, 0)
        self.assertFalse(result["outputs"]["ready"])
        self.assertEqual(
            result["outputs"]["missing"],
            ["an IAM role for ServiceAccount aws-rds-postgres (an EKS Pod Identity association, or IRSA; off EKS, its aws-rds-postgres-role secret)"],
        )

    def test_acts_as_the_target_role_and_never_reports_its_keys(self) -> None:
        self.module.TARGET_ROLE_FILE.write_text(TARGET + "\n")
        _, result = self._run()
        self.assertEqual(result["outputs"]["principal"], "arn:aws:sts::123456789012:assumed-role/acts-as/vennir-check")
        text = self.module.OUTPUT_PATH.read_text()
        for value in ("AKIAEXAMPLE", "not-a-secret", "token"):
            self.assertNotIn(value, text)

    def test_a_target_role_it_may_not_assume_is_missing(self) -> None:
        self.module.TARGET_ROLE_FILE.write_text(TARGET)
        self.sts.assume_role.side_effect = _error("AccessDenied", "AssumeRole")
        _, result = self._run()
        self.assertFalse(result["outputs"]["ready"])
        self.assertEqual(
            result["outputs"]["missing"],
            [f"sts:AssumeRole on {TARGET} for role aws-rds-postgres, allowed by {TARGET}'s trust policy"],
        )

    def test_an_outage_is_a_failure_not_an_answer(self) -> None:
        self.rds.describe_db_instances.side_effect = _error("InternalFailure", "DescribeDBInstances", status=500)
        exit_code, result = self._run()
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["error"]["code"], "AWS_API_ERROR")
        self.assertTrue(result["error"]["retryable"])


class OffEKSCheckTest(unittest.TestCase):
    """GKE, AKS: no default credentials; its own role by web identity."""

    _run = CheckActionTest._run
    tearDown = CheckActionTest.tearDown
    OWN = "arn:aws:iam::123456789012:role/own"

    def setUp(self) -> None:
        CheckActionTest.setUp(self)
        self.credentials = None
        self.module.OWN_ROLE_FILE.write_text(self.OWN + "\n")
        self.module.TOKEN_FILE.write_text("the-projected-token\n")
        self.sts.assume_role_with_web_identity.return_value = {
            "AssumedRoleUser": {"Arn": ROLE_SESSION},
            "Credentials": {"AccessKeyId": "ASIAEXAMPLE", "SecretAccessKey": "not-a-secret", "SessionToken": "t"},
        }

    def test_it_signs_in_as_its_own_role_by_web_identity(self) -> None:
        exit_code, result = self._run()
        self.assertEqual(exit_code, 0)
        self.assertTrue(result["outputs"]["ready"])
        self.sts.assume_role_with_web_identity.assert_called_once_with(
            RoleArn=self.OWN, RoleSessionName="vennir-check", WebIdentityToken="the-projected-token")
        self.sts.assume_role.assert_not_called()

    def test_a_role_that_doesnt_trust_it_is_not_ready(self) -> None:
        self.sts.assume_role_with_web_identity.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "no"}}, "AssumeRoleWithWebIdentity")
        exit_code, result = self._run()
        self.assertEqual(exit_code, 0)
        self.assertFalse(result["outputs"]["ready"])
        self.assertIn("trust policy", result["outputs"]["missing"][0])


if __name__ == "__main__":
    unittest.main()
