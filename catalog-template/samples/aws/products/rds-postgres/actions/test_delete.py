"""Tests for aws/rds-postgres's delete action, with boto3 mocked: it deletes
only an instance create made, keeping a final snapshot, and counts one
already gone or going as deleted.
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError

_MODULE_PATH = Path(__file__).parent / "delete.py"
ARN = "arn:aws:rds:us-east-2:123456789012:db:orders-db"
MADE = [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}]


def _load():
    spec = importlib.util.spec_from_file_location("aws_rds_postgres_delete", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _client_error(code: str, status: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "test"}, "ResponseMetadata": {"HTTPStatusCode": status}},
        "operation",
    )


class DeleteActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, resource: dict, instance: dict | Exception | None = None, team: str | None = "web") -> tuple[int, dict, object, object]:
        request: dict = {"inputs": {"resource": resource}}
        if team:
            request["forTeam"] = team
        self.module.INPUT_PATH.write_text(json.dumps(request))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            rds = session_cls.return_value.client.return_value
            if isinstance(instance, Exception):
                rds.describe_db_instances.side_effect = instance
            else:
                rds.describe_db_instances.return_value = {"DBInstances": [instance or {}]}
            code = self.module.main()
        return code, json.loads(self.module.OUTPUT_PATH.read_text()), rds, session_cls

    def test_an_instance_it_made_is_deleted_keeping_a_final_snapshot(self) -> None:
        code, result, rds, session_cls = self._run(
            {"type": "aws/rds-instance", "id": ARN}, {"DBInstanceStatus": "available", "TagList": MADE}
        )
        self.assertEqual(code, 0)
        kwargs = rds.delete_db_instance.call_args.kwargs
        self.assertEqual((kwargs["DBInstanceIdentifier"], kwargs["SkipFinalSnapshot"]), ("orders-db", False))
        self.assertRegex(kwargs["FinalDBSnapshotIdentifier"], r"^orders-db-final-[0-9]{14}$")
        self.assertEqual(result["outputs"], {"deleted": ARN, "finalSnapshot": kwargs["FinalDBSnapshotIdentifier"]})
        self.assertEqual(session_cls.call_args.kwargs["region_name"], "us-east-2")

    def test_one_made_some_other_way_is_refused(self) -> None:
        code, result, rds, _ = self._run(
            {"type": "aws/rds-instance", "id": ARN}, {"DBInstanceStatus": "available", "TagList": [{"Key": "managed-by", "Value": "vennir"}]}
        )
        self.assertEqual((code, result["error"]["code"]), (1, "NOT_MADE_BY_VENNIR"))
        rds.delete_db_instance.assert_not_called()

    def test_one_made_for_another_team_is_refused(self) -> None:
        code, result, rds, _ = self._run({"type": "aws/rds-instance", "id": ARN}, {"DBInstanceStatus": "available", "TagList": MADE}, team="data")
        self.assertEqual((code, result["error"]["code"]), (1, "NOT_THIS_TEAMS"))
        rds.delete_db_instance.assert_not_called()

    def test_a_request_without_a_team_is_refused(self) -> None:
        code, result, _, session_cls = self._run({"type": "aws/rds-instance", "id": ARN}, team=None)
        self.assertEqual((code, result["error"]["code"]), (1, "MISSING_TEAM"))
        session_cls.assert_not_called()

    def test_one_already_gone_or_going_is_deleted(self) -> None:
        for instance in (_client_error("DBInstanceNotFound", 404), {"DBInstanceStatus": "deleting", "TagList": MADE}):
            code, result, rds, _ = self._run({"type": "aws/rds-instance", "id": ARN}, instance)
            self.assertEqual((code, result["outputs"]), (0, {"deleted": ARN}))
            rds.delete_db_instance.assert_not_called()

    def test_needs_an_instance_arn(self) -> None:
        code, result, _, session_cls = self._run({"type": "aws/rds-instance", "id": "orders-db"})
        self.assertEqual((code, result["error"]["code"]), (1, "INVALID_INPUT"))
        session_cls.assert_not_called()


if __name__ == "__main__":
    unittest.main()
