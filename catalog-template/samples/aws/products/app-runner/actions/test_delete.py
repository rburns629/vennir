"""Tests for aws/app-runner's delete action, with boto3 mocked: it deletes
only a service create made, in the region its ARN names, and counts one
already gone as deleted.
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError

_MODULE_PATH = Path(__file__).parent / "delete.py"
ARN = "arn:aws:apprunner:us-east-2:123456789012:service/web/0123abcd"
MADE = {"Tags": [{"Key": "vennir-made", "Value": "true"}, {"Key": "vennir-team", "Value": "web"}]}


def _load():
    spec = importlib.util.spec_from_file_location("aws_app_runner_delete", _MODULE_PATH)
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

    def _run(self, resource: dict, configure=lambda c: None, team: str | None = "web") -> tuple[int, dict, object, object]:
        request: dict = {"inputs": {"resource": resource}}
        if team:
            request["forTeam"] = team
        self.module.INPUT_PATH.write_text(json.dumps(request))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            client = session_cls.return_value.client.return_value
            client.describe_service.return_value = {"Service": {"ServiceName": "web", "Status": "RUNNING"}}
            configure(client)
            code = self.module.main()
        return code, json.loads(self.module.OUTPUT_PATH.read_text()), client, session_cls

    def test_a_service_it_made_is_deleted_in_its_own_region(self) -> None:
        code, result, client, session_cls = self._run(
            {"type": "aws/app-runner-service", "id": ARN}, lambda c: setattr(c.list_tags_for_resource, "return_value", MADE)
        )
        self.assertEqual((code, result["outputs"]), (0, {"deleted": ARN}))
        client.delete_service.assert_called_once_with(ServiceArn=ARN)
        self.assertEqual(session_cls.call_args.kwargs["region_name"], "us-east-2")

    def test_one_made_some_other_way_is_refused(self) -> None:
        code, result, client, _ = self._run(
            {"type": "aws/app-runner-service", "id": ARN}, lambda c: setattr(c.list_tags_for_resource, "return_value", {"Tags": []})
        )
        self.assertEqual((code, result["error"]["code"]), (1, "NOT_MADE_BY_VENNIR"))
        client.delete_service.assert_not_called()

    def test_one_made_for_another_team_is_refused(self) -> None:
        code, result, client, _ = self._run(
            {"type": "aws/app-runner-service", "id": ARN}, lambda c: setattr(c.list_tags_for_resource, "return_value", MADE), team="data"
        )
        self.assertEqual((code, result["error"]["code"]), (1, "NOT_THIS_TEAMS"))
        client.delete_service.assert_not_called()

    def test_a_request_without_a_team_is_refused(self) -> None:
        code, result, _, session_cls = self._run({"type": "aws/app-runner-service", "id": ARN}, team=None)
        self.assertEqual((code, result["error"]["code"]), (1, "MISSING_TEAM"))
        session_cls.assert_not_called()

    def test_one_already_gone_is_deleted(self) -> None:
        for configure in (
            lambda c: setattr(c.describe_service, "side_effect", _client_error("ResourceNotFoundException", 404)),
            lambda c: setattr(c.describe_service, "return_value", {"Service": {"Status": "DELETED"}}),
        ):
            code, result, client, _ = self._run({"type": "aws/app-runner-service", "id": ARN}, configure)
            self.assertEqual((code, result["outputs"]), (0, {"deleted": ARN}))
            client.delete_service.assert_not_called()

    def test_a_busy_service_is_tried_again_and_access_denied_isnt(self) -> None:
        for error, retryable in ((_client_error("InvalidStateException"), True), (_client_error("AccessDeniedException", 403), False)):
            def configure(c, error=error):
                c.list_tags_for_resource.return_value = MADE
                c.delete_service.side_effect = error
            _, result, _, _ = self._run({"type": "aws/app-runner-service", "id": ARN}, configure)
            self.assertEqual(result["error"]["retryable"], retryable)

    def test_needs_a_service_arn(self) -> None:
        code, result, _, session_cls = self._run({"type": "aws/app-runner-service", "id": "web"})
        self.assertEqual((code, result["error"]["code"]), (1, "INVALID_INPUT"))
        session_cls.assert_not_called()


if __name__ == "__main__":
    unittest.main()
