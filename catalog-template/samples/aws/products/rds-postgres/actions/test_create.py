"""Tests for aws/rds-postgres's create action, with boto3 mocked, so they run
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

AVAILABLE = {
    "DBInstanceIdentifier": "orders-db",
    "DBInstanceStatus": "available",
    "Endpoint": {"Address": "orders-db.abc.eu-west-1.rds.amazonaws.com", "Port": 5432},
    "MasterUserSecret": {"SecretArn": "arn:aws:secretsmanager:eu-west-1:123456789012:secret:rds-x"},
    "DBInstanceArn": "arn:aws:rds:eu-west-1:123456789012:db:orders-db",
}
NOT_FOUND = ClientError({"Error": {"Code": "DBInstanceNotFound", "Message": "no"}}, "DescribeDBInstances")


def _load_create_module():
    spec = importlib.util.spec_from_file_location("aws_rds_postgres_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
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
            rds = session_cls.return_value.client.return_value
            configure(rds)
            exit_code = self.module.main()
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text()), rds

    def test_missing_or_bad_input_fails_without_calling_aws(self) -> None:
        for inputs in ({"region": "eu-west-1"}, {"instanceId": "1-bad", "region": "eu-west-1"}):
            self.module.INPUT_PATH.write_text(json.dumps({"inputs": inputs}))
            with patch.object(self.module.boto3.session, "Session") as session_cls:
                self.assertEqual(self.module.main(), 1)
            session_cls.assert_not_called()

    def test_an_available_instance_is_left_alone(self) -> None:
        def configure(rds):
            rds.describe_db_instances.return_value = {"DBInstances": [AVAILABLE]}
        exit_code, result, rds = self._run({"instanceId": "orders-db", "region": "eu-west-1"}, configure)
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["outputs"]["endpoint"], "orders-db.abc.eu-west-1.rds.amazonaws.com")
        rds.create_db_instance.assert_not_called()
        self.assertNotIn("resources", result["outputs"])  # not made here: never deleted by its cleanup

    def test_an_instance_it_made_is_reported_when_found_again(self) -> None:
        def configure(rds):
            rds.describe_db_instances.return_value = {"DBInstances": [{**AVAILABLE, "TagList": [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}]}]}
        _, result, _ = self._run({"instanceId": "orders-db", "region": "eu-west-1"}, configure)
        self.assertEqual(result["outputs"]["resources"][0]["id"], AVAILABLE["DBInstanceArn"])
        # Made by this product for another team: not this team's to delete.
        _, result, _ = self._run({"instanceId": "orders-db", "region": "eu-west-1"}, configure, team="data")
        self.assertNotIn("resources", result["outputs"])

    def test_a_request_without_a_team_is_refused(self) -> None:
        exit_code, result, rds = self._run({"instanceId": "orders-db", "region": "eu-west-1"}, lambda rds: None, team=None)
        self.assertEqual((exit_code, result["error"]["code"]), (1, "MISSING_TEAM"))
        rds.create_db_instance.assert_not_called()

    def test_a_new_instance_has_no_password_in_the_step_and_is_private(self) -> None:
        def configure(rds):
            rds.describe_db_instances.side_effect = [NOT_FOUND, {"DBInstances": [AVAILABLE]}]
        exit_code, result, rds = self._run({"instanceId": "orders-db", "region": "eu-west-1"}, configure)
        self.assertEqual(exit_code, 0)
        create = rds.create_db_instance.call_args.kwargs
        self.assertTrue(create["ManageMasterUserPassword"])
        self.assertNotIn("MasterUserPassword", create)
        self.assertFalse(create["PubliclyAccessible"])
        self.assertTrue(create["StorageEncrypted"])
        self.assertEqual(result["outputs"]["masterUserSecretArn"], AVAILABLE["MasterUserSecret"]["SecretArn"])
        self.assertIn({"Key": "vennir-made", "Value": "true"}, create["Tags"])
        self.assertIn({"Key": "vennir-team", "Value": "web"}, create["Tags"])
        self.assertEqual(result["outputs"]["resources"][0], {
            "type": "aws/rds-instance", "id": AVAILABLE["DBInstanceArn"], "name": "orders-db",
            "link": "https://eu-west-1.console.aws.amazon.com/rds/home?region=eu-west-1#database:id=orders-db",
        })

    def test_the_accounts_first_use_is_retried(self) -> None:
        not_ready = ClientError({"Error": {"Code": "InvalidParameterValue", "Message": (
            "Missing necessary credentials. Please check http://docs.aws.amazon.com/AmazonRDS/latest/"
            "UserGuide/UsingWithRDS.IAM.ServiceLinkedRoles.html")}}, "CreateDBInstance")
        def configure(rds):
            rds.describe_db_instances.side_effect = NOT_FOUND
            rds.create_db_instance.side_effect = not_ready
        exit_code, result, _ = self._run({"instanceId": "orders-db", "region": "eu-west-1"}, configure)
        self.assertEqual(exit_code, 1)
        self.assertTrue(result["error"]["retryable"])


if __name__ == "__main__":
    unittest.main()
