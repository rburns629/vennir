#!/usr/bin/env python3
"""http-check's "check" action: one call to an API, done carefully.

- HTTPS only, with a timeout, so a task never hangs or leaks a token over
  plain HTTP. With a token, redirects aren't followed: urllib copies every
  header, the token's among them, to wherever a redirect points, another
  host or http:// included.
- Errors say whether a retry could help: a network blip or a 5xx is
  "retryable"; a bad input or a 4xx isn't.
- The token is read from the mounted secret and never printed or returned.
- An unexpected status still "succeeds" with healthy=false: the check ran,
  and a later task (or a person) decides what to do about it.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")
TOKEN_PATH = Path("/platform/secrets/http-check-token/value")
TIMEOUT_SECONDS = 15


def write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def fail(code: str, message: str, *, retryable: bool) -> int:
    write_result({"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}})
    return 1


class RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Answers a redirect with the redirect itself, as an HTTPError, instead
    of following it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def open_url(request: urllib.request.Request, *, follow_redirects: bool):
    handlers = [] if follow_redirects else [RefuseRedirects()]
    return urllib.request.build_opener(*handlers).open(request, timeout=TIMEOUT_SECONDS)


def main() -> int:
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})
    url = inputs.get("url")
    if not isinstance(url, str) or not url.startswith("https://"):
        return fail("INVALID_INPUT", "inputs.url must be an https:// URL.", retryable=False)
    expect = inputs.get("expectStatus", 200)

    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "vennir-http-check"})
    use_token = bool(inputs.get("useToken"))
    if use_token:
        if not TOKEN_PATH.is_file():
            return fail(
                "MISSING_SECRET",
                f"{TOKEN_PATH} isn't there. Add the secret http-check-token for this product in the "
                "console, and list it in the task's secretRefs.",
                retryable=False,
            )
        request.add_header("Authorization", f"Bearer {TOKEN_PATH.read_text().strip()}")

    try:
        with open_url(request, follow_redirects=not use_token) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
        if use_token and 300 <= status < 400:
            return fail(
                "REDIRECT_REFUSED",
                f"{url} answered {status}, a redirect, which isn't followed while a token is sent. "
                "Give the URL it redirects to instead.",
                retryable=False,
            )
        if status >= 500:
            return fail("UPSTREAM_ERROR", f"{url} answered {status}.", retryable=True)
    except (urllib.error.URLError, TimeoutError) as error:
        return fail("UNREACHABLE", f"Couldn't reach {url}: {error}", retryable=True)

    print(f"{url} answered {status}")
    write_result({"status": "succeeded", "outputs": {"status": status, "healthy": status == expect}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
