#!/usr/bin/env python3
"""gcp/app-hosting's "delete" action: deletes a Cloud Run service create
deployed (its cleanup). Given {"resource": {"type":
"gcp/cloud-run-service", "id": "projects/<p>/locations/<r>/services/<name>"}}.

Only a service carrying create's vertra-made label is deleted: one deployed
some other way is refused, whoever asks. One already gone succeeds.
"""

import json
import re
import sys
from pathlib import Path
from typing import Any

import google.auth
import google.auth.credentials
import google.auth.exceptions
from google.api_core.exceptions import GoogleAPIError, NotFound
from google.auth import impersonated_credentials
from google.cloud import run_v2

MADE_BY_LABEL = ("vertra-made", "true")
SERVICE_PATH = re.compile(r"^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/locations/[a-z0-9-]+/services/[a-z][a-z0-9-]{0,62}$")

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

TARGET_SERVICE_ACCOUNT_FILE = Path("/platform/secrets/gcp-target/service-account")
IMPERSONATION_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result({"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}})
    return 1


def _retryable(error: GoogleAPIError) -> bool:
    """Whether trying again may help: Google busy, throttled, unreachable or
    mid-change (409: aborted, or made by an attempt this one replaces, which
    the next finds), not a refusal (a missing permission, a bad input)."""
    code = getattr(error, "code", None)
    return not isinstance(code, int) or code in (408, 409, 429) or code >= 500

def _build_credentials() -> google.auth.credentials.Credentials | None:
    """As create's: the gcp-target service account if the team registered one, else ADC."""
    target = TARGET_SERVICE_ACCOUNT_FILE.read_text().strip() if TARGET_SERVICE_ACCOUNT_FILE.exists() else ""
    if not target:
        return None
    source_credentials, _ = google.auth.default()
    return impersonated_credentials.Credentials(
        source_credentials=source_credentials, target_principal=target, target_scopes=IMPERSONATION_SCOPES
    )


def main() -> int:
    try:
        return _run()
    except google.auth.exceptions.GoogleAuthError as error:
        # Signing in, not the call: no Google credentials here, gcp-target
        # refused to be impersonated, or Google unreachable to ask.
        retryable = error.retryable or isinstance(error, google.auth.exceptions.TransportError)
        return _failure("GCP_SIGN_IN_FAILED", f"couldn't sign in to Google: {error}", retryable=retryable)
    except TimeoutError as error:
        # A call unanswered, or an operation still running when the client
        # stopped waiting for it: the next attempt finds what it made.
        return _failure("GCP_TIMEOUT", f"Google didn't finish in time: {error or 'no answer'}", retryable=True)


def _run() -> int:
    resource = json.loads(INPUT_PATH.read_text()).get("inputs", {}).get("resource") or {}
    path = resource.get("id") if isinstance(resource, dict) else None
    if resource.get("type") != "gcp/cloud-run-service" or not isinstance(path, str) or not SERVICE_PATH.match(path):
        return _failure("MISSING_INPUT", "inputs.resource is the gcp/cloud-run-service to delete, as create reported it")

    services = run_v2.ServicesClient(credentials=_build_credentials())
    try:
        service = services.get_service(name=path)
    except NotFound:
        print(f"service '{path}' is already gone")
        _write_result({"status": "succeeded", "outputs": {"deleted": path}})
        return 0
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    if dict(service.labels).get(MADE_BY_LABEL[0]) != MADE_BY_LABEL[1]:
        return _failure("NOT_MADE_BY_VERTRA", f"service '{path}' wasn't deployed by this product (it has no {MADE_BY_LABEL[0]} label), so it isn't deleted")

    try:
        services.delete_service(name=path).result()
    except NotFound:
        pass
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    print(f"deleted service '{path}'")
    _write_result({"status": "succeeded", "outputs": {"deleted": path}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
