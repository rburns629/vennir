"""Tests for aws/caller-identity's whoami action, with boto3 mocked, so they
run without an AWS account. `./vennir catalog check` runs them in the
product's own image with its python3 (unittest, no pytest).
"""

import datetime
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from botocore import UNSIGNED
from botocore.exceptions import ClientError

_MODULE_PATH = Path(__file__).parent / "whoami.py"
ROLE = "arn:aws:iam::123456789012:role/vennir-caller-identity"
SESSION_ARN = "arn:aws:sts::123456789012:assumed-role/vennir-caller-identity/vennir-caller-identity"


def _load():
    spec = importlib.util.spec_from_file_location("aws_caller_identity_whoami", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _refused(code: str, status: int = 400) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": f"{code} message"}, "ResponseMetadata": {"HTTPStatusCode": status}}, "AssumeRoleWithWebIdentity")


class WhoamiActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load()
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.module.INPUT_PATH = root / "request.json"
        self.module.OUTPUT_PATH = root / "result.json"
        self.module.TOKEN_PATH = root / "sts.amazonaws.com"
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {"roleArn": ROLE}}))
        self.module.TOKEN_PATH.write_text("header.payload.signature\n")
        self.web = MagicMock()
        self.web.assume_role_with_web_identity.return_value = {
            "Credentials": {
                "AccessKeyId": "ASIAEXAMPLE",
                "SecretAccessKey": "not-a-secret",
                "SessionToken": "session-token",
                "Expiration": datetime.datetime(2026, 10, 31, 13, 0, tzinfo=datetime.timezone.utc),
            }
        }
        self.signed = MagicMock()
        self.signed.get_caller_identity.return_value = {"Account": "123456789012", "Arn": SESSION_ARN}
        self.made: list[dict] = []

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _client(self, name: str, **kwargs):
        self.made.append(kwargs)
        return self.signed if "aws_access_key_id" in kwargs else self.web

    def _run(self) -> tuple[int, dict]:
        with patch.object(self.module.boto3, "client", side_effect=self._client):
            code = self.module.main()
        return code, json.loads(self.module.OUTPUT_PATH.read_text())

    def test_signs_in_with_its_token_and_never_reports_the_keys(self) -> None:
        code, result = self._run()
        self.assertEqual(code, 0)
        self.assertEqual(result["outputs"], {"account": "123456789012", "arn": SESSION_ARN, "expiresAt": "2026-10-31T13:00:00+00:00"})
        call = self.web.assume_role_with_web_identity.call_args.kwargs
        self.assertEqual((call["RoleArn"], call["WebIdentityToken"]), (ROLE, "header.payload.signature"))
        # The token exchange is unsigned: no AWS credentials go with it.
        self.assertIs(self.made[0]["config"].signature_version, UNSIGNED)
        written = self.module.OUTPUT_PATH.read_text()
        for secret in ("ASIAEXAMPLE", "not-a-secret", "session-token", "header.payload.signature"):
            self.assertNotIn(secret, written)

    def test_no_token_is_a_failure_of_its_own(self) -> None:
        self.module.TOKEN_PATH.unlink()
        code, result = self._run()
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["code"], "NO_TOKEN")
        self.web.assume_role_with_web_identity.assert_not_called()

    def test_an_issuer_aws_does_not_trust(self) -> None:
        self.web.assume_role_with_web_identity.side_effect = _refused("InvalidIdentityToken")
        _, result = self._run()
        self.assertEqual((result["error"]["code"], result["error"]["retryable"]), ("TOKEN_NOT_TRUSTED", False))

    def test_a_role_that_does_not_let_it_in(self) -> None:
        self.web.assume_role_with_web_identity.side_effect = _refused("AccessDenied", 403)
        _, result = self._run()
        self.assertEqual((result["error"]["code"], result["error"]["retryable"]), ("ROLE_NOT_ALLOWED", False))

    def test_aws_not_reaching_the_issuer_is_retried(self) -> None:
        self.web.assume_role_with_web_identity.side_effect = _refused("IDPCommunicationError")
        _, result = self._run()
        self.assertEqual((result["error"]["code"], result["error"]["retryable"]), ("AWS_API_ERROR", True))


if __name__ == "__main__":
    unittest.main()
