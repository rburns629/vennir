"""Tests for aws/s3-bucket's delete action, with boto3 mocked: it deletes
only a bucket create made, counts one already gone as deleted, and refuses
one it can't see or that still holds objects.
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError

_MODULE_PATH = Path(__file__).parent / "delete.py"
MADE = {"TagSet": [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}]}


def _load():
    spec = importlib.util.spec_from_file_location("aws_s3_bucket_delete", _MODULE_PATH)
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

    def _run(self, configure, team: str | None = "web") -> tuple[int, dict, object]:
        request: dict = {"inputs": {"bucketName": "b", "region": "us-east-2"}}
        if team:
            request["forTeam"] = team
        self.module.INPUT_PATH.write_text(json.dumps(request))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            s3 = session_cls.return_value.client.return_value
            configure(s3)
            code = self.module.main()
        return code, json.loads(self.module.OUTPUT_PATH.read_text()), s3

    def test_a_bucket_it_made_is_deleted(self) -> None:
        code, result, s3 = self._run(lambda s3: setattr(s3.get_bucket_tagging, "return_value", MADE))
        self.assertEqual((code, result["outputs"]), (0, {"deleted": "b"}))
        s3.delete_bucket.assert_called_once_with(Bucket="b")

    def test_one_made_some_other_way_is_refused(self) -> None:
        for tagging in ({"TagSet": [{"Key": "team", "Value": "web"}]}, _client_error("NoSuchTagSet", 404)):
            def configure(s3, tagging=tagging):
                if isinstance(tagging, Exception):
                    s3.get_bucket_tagging.side_effect = tagging
                else:
                    s3.get_bucket_tagging.return_value = tagging
            code, result, s3 = self._run(configure)
            self.assertEqual((code, result["error"]["code"]), (1, "NOT_MADE_BY_VENNIR"))
            s3.delete_bucket.assert_not_called()

    def test_one_made_for_another_team_is_refused(self) -> None:
        for tagging in (MADE, {"TagSet": [{"Key": "vennir-made", "Value": "true"}]}):
            code, result, s3 = self._run(lambda s3, tagging=tagging: setattr(s3.get_bucket_tagging, "return_value", tagging), team="data")
            self.assertEqual((code, result["error"]["code"]), (1, "NOT_THIS_TEAMS"))
            s3.delete_bucket.assert_not_called()

    def test_a_request_without_a_team_is_refused(self) -> None:
        code, result, s3 = self._run(lambda s3: setattr(s3.get_bucket_tagging, "return_value", MADE), team=None)
        self.assertEqual((code, result["error"]["code"]), (1, "MISSING_TEAM"))
        s3.delete_bucket.assert_not_called()

    def test_one_already_gone_is_deleted_and_one_it_cant_see_isnt(self) -> None:
        code, result, s3 = self._run(lambda s3: setattr(s3.head_bucket, "side_effect", _client_error("404", 404)))
        self.assertEqual((code, result["outputs"]), (0, {"deleted": "b"}))
        s3.delete_bucket.assert_not_called()
        code, result, s3 = self._run(lambda s3: setattr(s3.head_bucket, "side_effect", _client_error("403", 403)))
        self.assertEqual((code, result["error"]["code"]), (1, "BUCKET_NOT_VISIBLE"))
        s3.delete_bucket.assert_not_called()

    def test_a_bucket_with_objects_is_left_alone(self) -> None:
        def configure(s3):
            s3.get_bucket_tagging.return_value = MADE
            s3.delete_bucket.side_effect = _client_error("BucketNotEmpty", 409)
        code, result, _ = self._run(configure)
        self.assertEqual((code, result["error"]["code"], result["error"]["retryable"]), (1, "BUCKET_NOT_EMPTY", False))


if __name__ == "__main__":
    unittest.main()
