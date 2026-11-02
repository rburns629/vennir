#!/usr/bin/env python3
"""gcp/app-hosting's "create" action: deploys a pre-built image to Cloud Run
under the given service name, or returns the existing service's URL
unchanged if that name is already taken.

Run directly by this product's entrypoint.sh, which already guarantees this
script only ever runs for action="create" -- see product.yaml for this
action's declared input/output schema.

By default, calls Cloud Run using whatever GOOGLE_APPLICATION_CREDENTIALS/
ADC the container finds. If the gcp-target secret is mounted, those base
credentials are never used to call GCP APIs directly -- they're only the
*source* identity used to impersonate that service account instead
(short-lived tokens, minted on demand; no static key for the target
identity ever exists). The source identity must itself hold
roles/iam.serviceAccountTokenCreator on the target service account, and the
target service account needs its own IAM grants (run.services.{get,create},
iam.serviceAccounts.actAs on the Cloud Run runtime service account) -- see
the gcp team's README.md.
"""

import json
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

# What this product made, so it reports (and its delete removes) only
# those, never a service deployed some other way; and how a retry that finds
# the service it made a moment ago still reports it.
MADE_BY_LABEL = ("vertra-made", "true")

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

DEFAULT_REGION = "us-central1"
# The service account to act as, if the team registered one: its secret
# gcp-target (key service-account), mounted when the action lists it in
# secretRefs. See the gcp team's README.md.
TARGET_SERVICE_ACCOUNT_FILE = Path("/platform/secrets/gcp-target/service-account")
IMPERSONATION_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result(
        {"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}}
    )
    return 1


def _retryable(error: GoogleAPIError) -> bool:
    """Whether trying again may help: Google busy, throttled, unreachable or
    mid-change (409: aborted, or made by an attempt this one replaces, which
    the next finds), not a refusal (a missing permission, a bad input)."""
    code = getattr(error, "code", None)
    return not isinstance(code, int) or code in (408, 409, 429) or code >= 500

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


def _signed_in() -> google.auth.credentials.Credentials:
    """The credentials every client is given, signed in before any call: a
    gRPC client would report a refused sign-in as UNAVAILABLE, retried for
    good, where here it's google.auth's error, which main answers."""
    credentials = _build_credentials() or google.auth.default(scopes=IMPERSONATION_SCOPES)[0]
    credentials.refresh(google.auth.transport.requests.Request())
    return credentials


def _outputs(service: Any, project_id: str, region: str, service_name: str, made_here: bool) -> dict[str, Any]:
    """Its URL, and the service as a resource when this product made it."""
    outputs: dict[str, Any] = {"serviceUrl": service.uri}
    if made_here:
        outputs["resources"] = [
            {
                "type": "gcp/cloud-run-service",
                "id": f"projects/{project_id}/locations/{region}/services/{service_name}",
                "name": service_name,
                "link": f"https://console.cloud.google.com/run/detail/{region}/{service_name}?project={project_id}",
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
    service_name = inputs.get("serviceName")
    image = inputs.get("image")
    if not project_id or not service_name or not image:
        return _failure(
            "MISSING_INPUT",
            "inputs.projectId, inputs.serviceName, and inputs.image are required",
        )
    region = inputs.get("region", DEFAULT_REGION)

    services = run_v2.ServicesClient(credentials=_signed_in())
    service_path = services.service_path(project_id, region, service_name)

    # Existing-user path: a service with this name already exists, so this
    # action is a no-op other than reporting its URL back.
    try:
        existing = services.get_service(name=service_path)
        print(f"service '{service_name}' already exists, skipping deployment")
        made_here = dict(existing.labels).get(MADE_BY_LABEL[0]) == MADE_BY_LABEL[1]
        _write_result({"status": "succeeded", "outputs": _outputs(existing, project_id, region, service_name, made_here)})
        return 0
    except NotFound:
        pass
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    container = run_v2.Container(image=image)
    template = run_v2.RevisionTemplate()

    # See product.yaml's cloudSqlConnectionName field -- this is the actual
    # wiring for "an API that needs its own database": a volume backed by
    # the named Cloud SQL instance(s), mounted where the Cloud SQL Auth
    # Proxy convention expects it, plus an env var so the deployed app's
    # own code knows the socket path without hardcoding it.
    cloud_sql_connection_name = inputs.get("cloudSqlConnectionName")
    if cloud_sql_connection_name:
        container.volume_mounts = [run_v2.VolumeMount(name="cloudsql", mount_path="/cloudsql")]
        container.env = [run_v2.EnvVar(name="CLOUD_SQL_CONNECTION_NAME", value=cloud_sql_connection_name)]
        template.volumes = [
            run_v2.Volume(
                name="cloudsql",
                cloud_sql_instance=run_v2.CloudSqlInstance(instances=[cloud_sql_connection_name]),
            )
        ]

    template.containers = [container]

    try:
        operation = services.create_service(
            parent=f"projects/{project_id}/locations/{region}",
            service_id=service_name,
            service=run_v2.Service(template=template, labels=dict([MADE_BY_LABEL])),
        )
        service = operation.result()
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    print(f"deployed service '{service_name}' -> {service.uri}")
    _write_result({"status": "succeeded", "outputs": _outputs(service, project_id, region, service_name, True)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
