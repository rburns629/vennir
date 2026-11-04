"""Tests for aws/caller-identity's check action. `./vennir catalog check`
runs them in the product's own image with its python3.
"""

import base64
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_MODULE_PATH = Path(__file__).parent / "check.py"


def _load():
    spec = importlib.util.spec_from_file_location("aws_caller_identity_check", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _token(claims: dict) -> str:
    part = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJSUzI1NiJ9.{part}.signature"


class CheckActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load()
        self.tmp = tempfile.TemporaryDirectory()
        self.module.OUTPUT_PATH = Path(self.tmp.name) / "result.json"
        self.module.TOKEN_PATH = Path(self.tmp.name) / "sts.amazonaws.com"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _run(self) -> dict:
        self.assertEqual(self.module.main(), 0)
        return json.loads(self.module.OUTPUT_PATH.read_text())["outputs"]

    def test_ready_with_its_token_naming_its_issuer_and_subject(self) -> None:
        self.module.TOKEN_PATH.write_text(_token({"iss": "https://container.googleapis.com/v1/projects/p/locations/l/clusters/c", "sub": "system:serviceaccount:aws:aws-caller-identity"}))
        outputs = self._run()
        self.assertTrue(outputs["ready"])
        self.assertEqual(outputs["principal"], "system:serviceaccount:aws:aws-caller-identity")
        self.assertIn("container.googleapis.com", outputs["detail"])

    def test_not_ready_without_a_token(self) -> None:
        outputs = self._run()
        self.assertFalse(outputs["ready"])
        self.assertEqual(outputs["missing"], ["a token for sts.amazonaws.com: this install's release must carry the product's tokenAudiences"])


if __name__ == "__main__":
    unittest.main()
