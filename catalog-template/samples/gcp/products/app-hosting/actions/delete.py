#!/usr/bin/env python3
"""gcp/app-hosting's "delete" action: deletes a Cloud Run service create
deployed (its cleanup). Given {"resource": {"type":
"gcp/cloud-run-service", "id": "projects/<p>/locations/<r>/services/<name>"}}.

Only a service carrying create's vennir-made label, and the run's team
(request.json's forTeam) as its vennir-team label, is deleted: one deployed some other way, or
for another team, is refused, whoever asks. One already gone succeeds.
"""

import json
import re
import sys
from pathlib import Path
from typing import Any

import google.auth
import google.auth.credentials
import google.auth.exceptions
import google.auth.transport.requests
from google.api_core.exceptions import GoogleAPIError, NotFound
from google.auth import impersonated_credentials
from google.cloud import run_v2

MADE_BY_LABEL = ("vennir-made", "true")
TEAM_LABEL = "vennir-team"
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


def _signed_in() -> google.auth.credentials.Credentials:
    """The credentials every client is given, signed in before any call: a
    gRPC client would report a refused sign-in as UNAVAILABLE, retried for
    good, where here it's google.auth's error, which main answers."""
    credentials = _build_credentials() or google.auth.default(scopes=IMPERSONATION_SCOPES)[0]
    credentials.refresh(google.auth.transport.requests.Request())
    return credentials


def _iam_busy(error: Exception) -> bool:
    """Whether IAM refused to impersonate gcp-target only for now: its
    answer, a RefreshError's second argument, a 429 or 5xx, not a 401/403."""
    try:
        code = json.loads(error.args[1])["error"]["code"]
    except (IndexError, KeyError, TypeError, ValueError):
        return False
    return isinstance(code, int) and (code == 429 or code >= 500)


def main() -> int:
    try:
        return _run()
    except google.auth.exceptions.GoogleAuthError as error:
        # Signing in, not the call: no Google credentials here, gcp-target
        # refused to be impersonated, or Google unreachable to ask.
        # Unreachable often comes as a RefreshError caused by one (GKE's
        # metadata server, the first seconds of a Pod).
        unreachable = google.auth.exceptions.TransportError
        retryable = (
            error.retryable or isinstance(error, unreachable) or isinstance(error.__cause__, unreachable)
            or _iam_busy(error)
        )
        return _failure("GCP_SIGN_IN_FAILED", f"couldn't sign in to Google: {error}", retryable=retryable)
    except TimeoutError as error:
        # A call unanswered, or an operation still running when the client
        # stopped waiting for it: the next attempt finds what it made.
        return _failure("GCP_TIMEOUT", f"Google didn't finish in time: {error or 'no answer'}", retryable=True)


def _run() -> int:
    request = json.loads(INPUT_PATH.read_text())
    resource = request.get("inputs", {}).get("resource") or {}
    path = resource.get("id") if isinstance(resource, dict) else None
    if resource.get("type") != "gcp/cloud-run-service" or not isinstance(path, str) or not SERVICE_PATH.match(path):
        return _failure("MISSING_INPUT", "inputs.resource is the gcp/cloud-run-service to delete, as create reported it")
    team = request.get("forTeam")
    if not team:
        return _failure("MISSING_TEAM", "request.json has no forTeam: run it for one of your teams")

    services = run_v2.ServicesClient(credentials=_signed_in())
    try:
        service = services.get_service(name=path)
    except NotFound:
        print(f"service '{path}' is already gone")
        _write_result({"status": "succeeded", "outputs": {"deleted": path}})
        return 0
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    labels = dict(service.labels)
    if labels.get(MADE_BY_LABEL[0]) != MADE_BY_LABEL[1]:
        return _failure("NOT_MADE_BY_VENNIR", f"service '{path}' wasn't deployed by this product (it has no {MADE_BY_LABEL[0]} label), so it isn't deleted")
    if labels.get(TEAM_LABEL) != team:
        return _failure("NOT_THIS_TEAMS", f"service '{path}' wasn't deployed for team '{team}' (its {TEAM_LABEL} label says otherwise), so it isn't deleted")

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
