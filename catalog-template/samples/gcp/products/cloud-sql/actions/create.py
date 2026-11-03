#!/usr/bin/env python3
"""gcp/cloud-sql's "create" action: looks up a Cloud SQL instance by name
within a project, creating it (and waiting for the real, long-running
provisioning operation to finish) only if it doesn't already exist.


Run directly by this product's entrypoint.sh, which already guarantees this
script only ever runs for action="create" -- see product.yaml for this
action's declared input/output schema.

Unlike gcp/project and gcp/app-hosting, the Cloud SQL Admin API has no
dedicated GAPIC client library (no `google.cloud.sql_v1`) -- Google's own
documentation points at the generic, discovery-based
`googleapiclient.discovery` client instead (the same "sqladmin" v1 service
every official Cloud SQL admin-api doc uses), so this file uses that
instead of `google.cloud.*`.

By default, calls the Cloud SQL Admin API using whatever
GOOGLE_APPLICATION_CREDENTIALS/ADC the container finds. If
the gcp-target secret is mounted, those base credentials are never used to
call GCP APIs directly -- they're only the *source* identity used to
impersonate that service account instead. See gcp/project's own
create.py and the gcp samples' README.md for the full reasoning (identical
pattern, copied rather than shared -- the same README says why products
don't share code).
"""

import json
import sys
import time
from pathlib import Path
from typing import Any

import google.auth
import google.auth.credentials
import google.auth.exceptions
from google.auth import impersonated_credentials
from googleapiclient import discovery
from googleapiclient.errors import HttpError

# What this product made, so it reports (and its delete removes) only
# those, never an instance made some other way; and how a retry that finds
# the instance it made a moment ago still reports it.
MADE_BY_LABEL = ("vertra-made", "true")
# And for which team (the request's forTeam, the team the run is for, not
# the one it runs in: a Kubernetes namespace name, so always a valid label
# value), so it's reported, and deleted, only for that team: another team's
# instance, even one this product made, isn't theirs.
TEAM_LABEL = "vertra-team"

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

# The service account to act as, if the team registered one: its secret
# gcp-target (key service-account), mounted when the action lists it in
# secretRefs. See the gcp team's README.md.
TARGET_SERVICE_ACCOUNT_FILE = Path("/platform/secrets/gcp-target/service-account")
IMPERSONATION_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]

DEFAULT_DATABASE_VERSION = "POSTGRES_15"
DEFAULT_TIER = "db-f1-micro"
DEFAULT_REGION = "us-central1"

# A real instance takes several minutes to provision -- this is a ceiling
# on how long *this action* waits for that, independent of (and shorter
# than) whatever timeoutSeconds the submitted task itself is given; the
# task's own timeout must be set generously (see product.yaml) or the
# kernel force-fails the task before this loop would ever time out on its
# own.
OPERATION_TIMEOUT_SECONDS = 600
OPERATION_POLL_INTERVAL_SECONDS = 5

# An instance that's there but not usable: one that won't become usable
# without someone stepping in fails the step for good; any other state
# (PENDING_CREATE, MAINTENANCE, ...) is waited out, as a retry finding the
# instance its last attempt made needs to.
READY_STATE = "RUNNABLE"
# Shorter than a step's default five minutes, so a step run without a
# longer timeoutSeconds still ends with its own retryable answer.
READY_TIMEOUT_SECONDS = 240
STUCK_STATES = {"FAILED", "SUSPENDED", "PENDING_DELETE"}


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result(
        {"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}}
    )
    return 1


def _retryable(error: HttpError) -> bool:
    """Whether trying again may help: Google busy, throttled, unreachable or
    mid-change (409: another operation in progress, a backup or the end of a
    create), not a refusal (a missing permission, a bad input)."""
    return error.resp.status in (408, 409, 429) or error.resp.status >= 500

def _build_credentials() -> google.auth.credentials.Credentials | None:
    """Impersonated credentials for the gcp-target service account, or None
    to leave each client's own ADC discovery in charge, unimpersonated, when
    the team's gcp-target secret isn't mounted -- None is a valid "use the
    default" value for every google-cloud client's credentials= argument.
    """
    target = TARGET_SERVICE_ACCOUNT_FILE.read_text().strip() if TARGET_SERVICE_ACCOUNT_FILE.exists() else ""
    if not target:
        return None
    source_credentials, _ = google.auth.default()
    return impersonated_credentials.Credentials(
        source_credentials=source_credentials,
        target_principal=target,
        target_scopes=IMPERSONATION_SCOPES,
    )


def _build_service(credentials: google.auth.credentials.Credentials | None):
    # cache_discovery=False: the discovery document cache googleapiclient
    # otherwise tries to write to disk fails noisily (and pointlessly) in
    # a read-only or throwaway container filesystem like this one.
    return discovery.build("sqladmin", "v1", credentials=credentials, cache_discovery=False)


def _wait_for_operation(service, project_id: str, operation_name: str) -> str | None:
    """Blocks until the named long-running operation reaches DONE. Returns
    an error message if the operation itself failed, None on success."""
    deadline = time.monotonic() + OPERATION_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        operation = service.operations().get(project=project_id, operation=operation_name).execute()
        if operation.get("status") == "DONE":
            error = operation.get("error")
            return json.dumps(error) if error else None
        time.sleep(OPERATION_POLL_INTERVAL_SECONDS)
    return f"operation '{operation_name}' did not reach DONE within {OPERATION_TIMEOUT_SECONDS}s"


def _wait_until_ready(service, project_id: str, name: str, instance: dict[str, Any]) -> tuple[dict[str, Any], int | None]:
    """Waits for an instance to be RUNNABLE: the instance, and None once it
    is, or the failure's exit code if it's stuck or still not ready."""
    deadline = time.monotonic() + READY_TIMEOUT_SECONDS
    while True:
        state = instance.get("state")
        if state == READY_STATE:
            return instance, None
        if state in STUCK_STATES:
            return instance, _failure(
                "INSTANCE_NOT_USABLE",
                f"Cloud SQL instance '{name}' is {state}; see it in the Google Cloud console.",
            )
        if time.monotonic() >= deadline:
            return instance, _failure(
                "INSTANCE_NOT_READY",
                f"Cloud SQL instance '{name}' is still {state} after {READY_TIMEOUT_SECONDS}s; "
                "running the step again waits for it.",
                retryable=True,
            )
        print(f"Cloud SQL instance '{name}' is {state}; waiting")
        time.sleep(OPERATION_POLL_INTERVAL_SECONDS)
        instance = service.instances().get(project=project_id, instance=name).execute()


def _outputs_from_instance(instance: dict[str, Any], team: str) -> dict[str, Any]:
    ip_addresses = instance.get("ipAddresses") or []
    outputs: dict[str, Any] = {
        "instanceConnectionName": instance["connectionName"],
        "ipAddress": ip_addresses[0]["ipAddress"] if ip_addresses else "",
    }
    labels = (instance.get("settings") or {}).get("userLabels") or {}
    if labels.get(MADE_BY_LABEL[0]) == MADE_BY_LABEL[1] and labels.get(TEAM_LABEL) == team:
        project = instance["connectionName"].split(":")[0]
        name = instance.get("name", "")
        outputs["resources"] = [
            {
                "type": "gcp/cloud-sql-instance",
                "id": instance["connectionName"],
                "name": name,
                "link": f"https://console.cloud.google.com/sql/instances/{name}/overview?project={project}",
            }
        ]
    return outputs


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
    inputs = request.get("inputs", {})

    project_id = inputs.get("projectId")
    instance_name = inputs.get("instanceName")
    if not project_id or not instance_name:
        return _failure("MISSING_INPUT", "inputs.projectId and inputs.instanceName are required")
    team = request.get("forTeam")
    if not team:
        return _failure("MISSING_TEAM", "request.json has no forTeam: run it for one of your teams")

    credentials = _build_credentials()
    service = _build_service(credentials)

    # Existing-instance path: an instance with this name already exists in
    # the project, so this action makes nothing, and reports it back once
    # it's usable (a retry may find the one its last attempt was still
    # creating).
    try:
        existing = service.instances().get(project=project_id, instance=instance_name).execute()
        print(f"Cloud SQL instance '{instance_name}' already exists in '{project_id}', skipping creation")
        existing, failed = _wait_until_ready(service, project_id, instance_name, existing)
        if failed is not None:
            return failed
        _write_result({"status": "succeeded", "outputs": _outputs_from_instance(existing, team)})
        return 0
    except HttpError as error:
        if error.resp.status != 404:
            return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    # New-instance path: create it, then block until the real,
    # long-running provisioning operation actually finishes -- an instance
    # isn't usable (and its connection info isn't final) the moment
    # instances().insert() returns, only once its Operation reaches DONE.
    database_version = inputs.get("databaseVersion") or DEFAULT_DATABASE_VERSION
    tier = inputs.get("tier") or DEFAULT_TIER
    region = inputs.get("region") or DEFAULT_REGION
    body = {
        "name": instance_name,
        "region": region,
        "databaseVersion": database_version,
        "settings": {
            "tier": tier,
            # Left unset, a new instance defaults to
            # ALLOW_UNENCRYPTED_AND_ENCRYPTED, which this project's org
            # policy (a customConstraints/custom.cloudSqlSslMode
            # constraint set above this project, not something this repo
            # controls) rejects outright with a 400 -- caught live, not
            # anticipated, the first time this action actually tried to
            # create an instance rather than just find an existing one.
            # ENCRYPTED_ONLY, not TRUSTED_CLIENT_CERTIFICATE_REQUIRED --
            # the latter would also need client certs distributed to
            # whatever connects (gcp/app-hosting's Cloud Run service,
            # concretely), real complexity this demo doesn't need just to
            # satisfy the policy.
            "ipConfiguration": {"sslMode": "ENCRYPTED_ONLY"},
            "userLabels": {MADE_BY_LABEL[0]: MADE_BY_LABEL[1], TEAM_LABEL: team},
        },
    }
    try:
        operation = service.instances().insert(project=project_id, body=body).execute()
        operation_error = _wait_for_operation(service, project_id, operation["name"])
        if operation_error:
            return _failure("GCP_OPERATION_FAILED", operation_error, retryable=True)
        instance = service.instances().get(project=project_id, instance=instance_name).execute()
    except HttpError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    print(f"created Cloud SQL instance '{instance_name}' in '{project_id}'")
    _write_result({"status": "succeeded", "outputs": _outputs_from_instance(instance, team)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
