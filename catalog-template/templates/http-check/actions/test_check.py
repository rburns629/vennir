"""Tests for http-check's check action, with the network faked: CI must
never depend on someone else's server (CI runs every actions/test_*.py)."""

import http.server
import importlib.util
import io
import json
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


def load_action():
    spec = importlib.util.spec_from_file_location("check", Path(__file__).parent / "check.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class CheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.action = load_action()
        self.tmp = tempfile.TemporaryDirectory()
        folder = Path(self.tmp.name)
        self.action.INPUT_PATH = folder / "request.json"
        self.action.OUTPUT_PATH = folder / "result.json"
        self.action.TOKEN_PATH = folder / "token"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_with(self, inputs: dict, respond) -> dict:
        self.action.INPUT_PATH.write_text(json.dumps({"inputs": inputs}))
        with patch.object(self.action, "open_url", side_effect=respond) as opened:
            self.action.main()
            self.opened = opened
        return json.loads(self.action.OUTPUT_PATH.read_text())

    def test_healthy(self) -> None:
        result = self.run_with({"url": "https://example.com"}, lambda *a, **k: FakeResponse(200))
        self.assertEqual(result["outputs"], {"status": 200, "healthy": True})

    def test_refuses_plain_http(self) -> None:
        result = self.run_with({"url": "http://example.com"}, lambda *a, **k: FakeResponse(200))
        self.assertEqual(result["error"]["code"], "INVALID_INPUT")

    def test_server_error_is_retryable(self) -> None:
        def boom(*_a, **_k):
            raise urllib.error.HTTPError("https://example.com", 503, "down", {}, io.BytesIO())
        result = self.run_with({"url": "https://example.com"}, boom)
        self.assertTrue(result["error"]["retryable"])

    def test_client_error_is_unhealthy_not_failed(self) -> None:
        def missing(*_a, **_k):
            raise urllib.error.HTTPError("https://example.com", 404, "nope", {}, io.BytesIO())
        result = self.run_with({"url": "https://example.com"}, missing)
        self.assertEqual(result["outputs"], {"status": 404, "healthy": False})

    def test_sends_the_token_and_never_returns_it(self) -> None:
        self.action.TOKEN_PATH.write_text("tok-123")
        result = self.run_with({"url": "https://example.com", "useToken": True}, lambda *a, **k: FakeResponse(200))
        sent = self.opened.call_args.args[0]
        self.assertEqual(sent.get_header("Authorization"), "Bearer tok-123")
        self.assertNotIn("tok-123", json.dumps(result))
        self.assertEqual(self.opened.call_args.kwargs, {"follow_redirects": False})

    def test_follows_redirects_without_a_token(self) -> None:
        self.run_with({"url": "https://example.com"}, lambda *a, **k: FakeResponse(200))
        self.assertEqual(self.opened.call_args.kwargs, {"follow_redirects": True})

    def test_a_redirect_with_a_token_fails(self) -> None:
        self.action.TOKEN_PATH.write_text("tok-123")

        def moved(*_a, **_k):
            raise urllib.error.HTTPError("https://example.com", 302, "Found", {}, io.BytesIO())
        result = self.run_with({"url": "https://example.com", "useToken": True}, moved)
        self.assertEqual(result["error"]["code"], "REDIRECT_REFUSED")
        self.assertFalse(result["error"]["retryable"])

    def test_names_the_missing_token(self) -> None:
        result = self.run_with({"url": "https://example.com", "useToken": True}, lambda *a, **k: FakeResponse(200))
        self.assertEqual(result["error"]["code"], "MISSING_SECRET")


class RedirectTest(unittest.TestCase):
    """open_url against a real (loopback) server: the redirect's target sees
    the token only when redirects are followed."""

    def setUp(self) -> None:
        self.action = load_action()
        self.seen: list[str | None] = []
        seen = self.seen

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if self.path == "/start":
                    self.send_response(302)
                    self.send_header("Location", "/elsewhere")
                else:
                    seen.append(self.headers.get("Authorization"))
                    self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_args) -> None:
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/start"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def request(self):
        return self.action.urllib.request.Request(self.url, headers={"Authorization": "Bearer tok-123"})

    def test_refusing_keeps_the_token_home(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.action.open_url(self.request(), follow_redirects=False)
        raised.exception.close()
        self.assertEqual(raised.exception.code, 302)
        self.assertEqual(self.seen, [])

    def test_following_would_send_it_on(self) -> None:
        with self.action.open_url(self.request(), follow_redirects=True) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(self.seen, ["Bearer tok-123"])


if __name__ == "__main__":
    unittest.main()
