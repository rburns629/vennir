#!/usr/bin/env python3
"""gcp/cloud-sql's "delete" action: deletes a Cloud SQL instance create made
(its cleanup), and its databases with it. Given {"resource": {"type":
"gcp/cloud-sql-instance", "id": "<project>:<region>:<instance>"}}.

Only an instance carrying create's vertra-made label is deleted: one made
some other way is refused, whoever asks. One already gone succeeds.
"""

import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import google.auth
import google.auth.credentials
from google.auth import impersonated_credentials
from googleapiclient import discovery
from googleapiclient.errors import HttpError

MADE_BY_LABEL = ("vertra-made", "true")
CONNECTION_NAME = re.compile(r"^([a-z][a-z0-9-]{4,28}[a-z0-9]):([a-z0-9-]+):([a-z][a-z0-9-]{0,97})$")

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

TARGET_SERVICE_ACCOUNT_FILE = Path("/platform/secrets/gcp-target/service-account")
IMPERSONATION_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]

# Within a step's default five minutes (a cleanup run sets none): an
# accepted delete can't be stopped, so one still finishing then is reported
# done, with finishing: true.
OPERATION_TIMEOUT_SECONDS = 240
OPERATION_POLL_INTERVAL_SECONDS = 5


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result({"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}})
    return 1


def _retryable(error: HttpError) -> bool:
    """Whether trying again may help: Google busy, throttled, unreachable or
    mid-change (409: another operation in progress, a backup or the end of a
    create), not a refusal (a missing permission, a bad input)."""
    return error.resp.status in (408, 409, 429) or error.resp.status >= 500

def _build_credentials() -> google.auth.credentials.Credentials | None:
    """As create's: the gcp-target service account if the team registered one, else ADC."""
    target = TARGET_SERVICE_ACCOUNT_FILE.read_text().strip() if TARGET_SERVICE_ACCOUNT_FILE.exists() else ""
    if not target:
        return None
    source_credentials, _ = google.auth.default()
    return impersonated_credentials.Credentials(
        source_credentials=source_credentials, target_principal=target, target_scopes=IMPERSONATION_SCOPES
    )


def _wait_for_operation(service, project_id: str, operation_name: str) -> tuple[bool, str | None]:
    """Until the operation is DONE, or the time's up: (done, its error if it failed)."""
    deadline = time.monotonic() + OPERATION_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        operation = service.operations().get(project=project_id, operation=operation_name).execute()
        if operation.get("status") == "DONE":
            error = operation.get("error")
            return True, (json.dumps(error) if error else None)
        time.sleep(OPERATION_POLL_INTERVAL_SECONDS)
    return False, None


def main() -> int:
    resource = json.loads(INPUT_PATH.read_text()).get("inputs", {}).get("resource") or {}
    connection = resource.get("id") if isinstance(resource, dict) else None
    match = CONNECTION_NAME.match(connection) if isinstance(connection, str) else None
    if resource.get("type") != "gcp/cloud-sql-instance" or not match:
        return _failure("MISSING_INPUT", "inputs.resource is the gcp/cloud-sql-instance to delete, as create reported it")
    project_id, _region, instance_name = match.groups()

    service = discovery.build("sqladmin", "v1", credentials=_build_credentials(), cache_discovery=False)
    try:
        instance = service.instances().get(project=project_id, instance=instance_name).execute()
    except HttpError as error:
        if error.resp.status == 404:
            print(f"Cloud SQL instance '{connection}' is already gone")
            _write_result({"status": "succeeded", "outputs": {"deleted": connection}})
            return 0
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    labels = (instance.get("settings") or {}).get("userLabels") or {}
    if labels.get(MADE_BY_LABEL[0]) != MADE_BY_LABEL[1]:
        return _failure("NOT_MADE_BY_VERTRA", f"Cloud SQL instance '{connection}' wasn't made by this product (it has no {MADE_BY_LABEL[0]} label), so it isn't deleted")

    done = True
    try:
        operation = service.instances().delete(project=project_id, instance=instance_name).execute()
        done, operation_error = _wait_for_operation(service, project_id, operation["name"])
        if operation_error:
            return _failure("GCP_OPERATION_FAILED", operation_error, retryable=True)
    except HttpError as error:
        if error.resp.status != 404:
            return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    print(f"deleted Cloud SQL instance '{connection}'" if done else f"Cloud SQL is still deleting '{connection}'; it can't be stopped now")
    _write_result({"status": "succeeded", "outputs": {"deleted": connection, **({} if done else {"finishing": True})}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
