#!/usr/bin/env python3
"""gcp/app-hosting's "create" action: deploys a pre-built image to Cloud Run
under the given service name, or brings a service it deployed for this team
to the inputs (a new revision, its URL kept), and returns its URL. A service
of that name deployed some other way is returned only if it already matches
the inputs: this product changes no service it didn't make.

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

What it deploys, and as whom, is the team's choice, not the caller's: the
team secret app-hosting names the registry images must come from and the
service account a service runs as (one the team made for its services,
never the project's default compute account, which is often an Editor).
"""

import json
import sys
import time
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
MADE_BY_LABEL = ("vennir-made", "true")
# And for which team (the request's forTeam, the team the run is for, not
# the one it runs in: a Kubernetes namespace name, so always a valid label
# value), so it's reported, and deleted, only for that team: another team's
# service, even one this product made, isn't theirs.
TEAM_LABEL = "vennir-team"

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

DEFAULT_REGION = "us-central1"
# The service account to act as, if the team registered one: its secret
# gcp-target (key service-account), mounted when the action lists it in
# secretRefs. See the gcp team's README.md.
TARGET_SERVICE_ACCOUNT_FILE = Path("/platform/secrets/gcp-target/service-account")
IMPERSONATION_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
# The team's secret app-hosting: image-registry, the registry (an Artifact
# Registry repository, say) an image must be under, and
# runtime-service-account, the email of the account a service runs as.
SETTINGS_DIR = Path("/platform/secrets/app-hosting")
# A found service still rolling a revision out (an earlier attempt's, say)
# is waited for this long (well inside the step's default 300s timeout),
# then retried.
ROLLOUT_WAIT_SECONDS = 120
POLL_SECONDS = 10


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result(
        {"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}}
    )
    return 1


def _setting(key: str) -> str:
    path = SETTINGS_DIR / key
    return path.read_text().strip() if path.is_file() else ""


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


def _template(image: str, runtime_account: str, cloud_sql_connection_name: str) -> run_v2.RevisionTemplate:
    """The revision the inputs ask for."""
    container = run_v2.Container(image=image)
    template = run_v2.RevisionTemplate(service_account=runtime_account)

    # See product.yaml's cloudSqlConnectionName field -- this is the actual
    # wiring for "an API that needs its own database": a volume backed by
    # the named Cloud SQL instance(s), mounted where the Cloud SQL Auth
    # Proxy convention expects it, plus an env var so the deployed app's
    # own code knows the socket path without hardcoding it.
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
    return template


def _changes(service: run_v2.Service, image: str, runtime_account: str, cloud_sql_connection_name: str) -> list[str]:
    """What the inputs change in the service's current revision template."""
    containers = list(service.template.containers)
    env = {e.name: e.value for e in containers[0].env} if containers else {}
    current = {
        "image": containers[0].image if containers else "",
        "runtime service account": service.template.service_account,
        "cloudSqlConnectionName": env.get("CLOUD_SQL_CONNECTION_NAME", ""),
    }
    wanted = {"image": image, "runtime service account": runtime_account, "cloudSqlConnectionName": cloud_sql_connection_name}
    return [field for field in current if current[field] != wanted[field]]


def _settled(services: run_v2.ServicesClient, service: run_v2.Service) -> run_v2.Service:
    """The service once it's no longer rolling a revision out, or as it is
    when ROLLOUT_WAIT_SECONDS run out."""
    deadline = time.monotonic() + ROLLOUT_WAIT_SECONDS
    while service.reconciling and time.monotonic() < deadline:
        time.sleep(POLL_SECONDS)
        service = services.get_service(name=service.name)
    return service


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
    team = request.get("forTeam")
    if not team:
        return _failure("MISSING_TEAM", "request.json has no forTeam: run it for one of your teams")
    region = inputs.get("region", DEFAULT_REGION)
    registry = _setting("image-registry").rstrip("/")
    runtime_account = _setting("runtime-service-account")
    if not registry or not runtime_account:
        return _failure(
            "MISSING_SECRET",
            f"{SETTINGS_DIR} needs image-registry and runtime-service-account: add the secret "
            "app-hosting for this team in the console (the gcp team's README.md).",
        )
    if not image.startswith(registry + "/"):
        return _failure("IMAGE_OUTSIDE_REGISTRY", f"inputs.image must be under {registry}/, the registry this team deploys from.")

    services = run_v2.ServicesClient(credentials=_signed_in())
    service_path = services.service_path(project_id, region, service_name)
    cloud_sql_connection_name = inputs.get("cloudSqlConnectionName") or ""

    # A service with this name already exists: one it deployed for this team
    # gets a new revision when the inputs differ (a retry finds the revision
    # its last attempt asked for, and changes nothing); any other is only
    # reported, and only when it already matches.
    try:
        existing = services.get_service(name=service_path)
        labels = dict(existing.labels)
        made_here = labels.get(MADE_BY_LABEL[0]) == MADE_BY_LABEL[1] and labels.get(TEAM_LABEL) == team
        changes = _changes(existing, image, runtime_account, cloud_sql_connection_name)
        if not changes:
            # Its template is as asked, but that's not its revision serving
            # until Cloud Run has rolled it out: a revision that never got
            # ready leaves the last one serving.
            existing = _settled(services, existing)
            if existing.reconciling:
                return _failure(
                    "SERVICE_ROLLING_OUT",
                    f"Service '{service_name}' is still rolling out its newest revision.",
                    retryable=True,
                )
            if existing.latest_ready_revision != existing.latest_created_revision:
                serving = existing.latest_ready_revision.rsplit("/", 1)[-1] or "no revision"
                return _failure(
                    "REVISION_NOT_READY",
                    f"Service '{service_name}''s newest revision, {existing.latest_created_revision.rsplit('/', 1)[-1]}, "
                    f"didn't get ready, so {serving} still serves: {existing.terminal_condition.message or 'see its revisions in the Cloud Run console'}. "
                    "Deploy a fixed image under a new tag.",
                )
            print(f"service '{service_name}' already exists as asked, leaving it as it is")
            _write_result({"status": "succeeded", "outputs": _outputs(existing, project_id, region, service_name, made_here)})
            return 0
        if not made_here:
            return _failure(
                "SERVICE_EXISTS",
                f"Service '{service_name}' exists, deployed some other way or for another team, and differs from these "
                f"inputs ({', '.join(changes)}): this product changes only services it deployed for this team. Choose another name.",
            )
        existing.template = _template(image, runtime_account, cloud_sql_connection_name)
        print(f"updating service '{service_name}': {', '.join(changes)}")
        # Done once the new revision serves; until then the last one does.
        service = services.update_service(service=existing).result()
        print(f"updated service '{service_name}' -> {service.uri}")
        _write_result({"status": "succeeded", "outputs": _outputs(service, project_id, region, service_name, True)})
        return 0
    except NotFound:
        pass
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    try:
        operation = services.create_service(
            parent=f"projects/{project_id}/locations/{region}",
            service_id=service_name,
            service=run_v2.Service(
                template=_template(image, runtime_account, cloud_sql_connection_name),
                labels={MADE_BY_LABEL[0]: MADE_BY_LABEL[1], TEAM_LABEL: team},
            ),
        )
        service = operation.result()
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    print(f"deployed service '{service_name}' -> {service.uri}")
    _write_result({"status": "succeeded", "outputs": _outputs(service, project_id, region, service_name, True)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
