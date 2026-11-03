#!/usr/bin/env python3
"""title-case's "transform" action: capitalize every word.

Reads /platform/input/request.json, writes /platform/output/result.json:
{"status": "succeeded", "outputs": {...}} or
{"status": "failed", "error": {"code", "message", "retryable"}}.
"""

import json
import re
import sys
from pathlib import Path
from typing import Any

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")
# The output carries the text back, and result.json is limited to 4 KB: a
# limit in characters, and the encoded result measured too, since JSON
# writes a control character as six bytes and UTF-8 others as up to four.
MAX_LENGTH = 1000
MAX_RESULT_BYTES = 4096


def encode(result: dict[str, Any]) -> bytes:
    return json.dumps(result, ensure_ascii=False).encode()


def write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_bytes(encode(result))


def fail(code: str, message: str) -> int:
    write_result({"status": "failed", "error": {"code": code, "message": message, "retryable": False}})
    return 1


def title_case(text: str) -> str:
    # Word by word rather than str.title(), which also capitalizes after an
    # apostrophe ("don't" -> "Don'T"); the spacing between words is kept.
    return re.sub(r"\S+", lambda word: word[0][:1].upper() + word[0][1:].lower(), text)


def main() -> int:
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})
    text = inputs.get("text")
    if not isinstance(text, str) or not text.strip():
        return fail("MISSING_INPUT", "inputs.text is required: the text to change.")
    if len(text) > MAX_LENGTH:
        return fail("TEXT_TOO_LONG", f"inputs.text is {len(text)} characters; the limit is {MAX_LENGTH}.")

    result = {"status": "succeeded", "outputs": {"text": title_case(text), "language": "Python"}}
    if len(encode(result)) > MAX_RESULT_BYTES:
        return fail("TEXT_TOO_LONG", f"inputs.text would make a result over {MAX_RESULT_BYTES} bytes.")
    # A JSON line with level info: what everyone who can see the run sees.
    # Anything else (debug, warn, error, plain) only this team sees.
    print(json.dumps({"level": "debug", "msg": f"{len(text.split())} words in, {len(re.findall(r'[A-Z]', text))} capitals already"}))
    print(json.dumps({"level": "info", "msg": f"title-cased {len(text)} characters"}))
    write_result(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
