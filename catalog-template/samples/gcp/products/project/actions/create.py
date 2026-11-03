#!/usr/bin/env python3
"""gcp/project's "create" action: looks up a GCP project by id, creating it
(and linking billing) only if it doesn't already exist.


Run directly by this product's entrypoint.sh, which already guarantees this
script only ever runs for action="create" -- see product.yaml for this
action's declared input/output schema.

By default, calls Resource Manager and (when creating a new project) Cloud
Billing using whatever GOOGLE_APPLICATION_CREDENTIALS/ADC the container
finds. If the gcp-target secret is mounted, those base credentials are
never used to call GCP APIs directly -- they're only the *source* identity
used to impersonate that service account instead (short-lived tokens,
minted on demand; no static key for the target identity ever exists). The
source identity must itself hold roles/iam.serviceAccountTokenCreator on
the target service account, and the target service account needs its own
IAM grants on whatever it's actually asked to do -- see the gcp team's README.md.
"""

import json
import sys
from pathlib import Path
from typing import Any

import google.auth
import google.auth.credentials
import google.auth.exceptions
import google.auth.transport.requests
from google.api_core.exceptions import AlreadyExists, GoogleAPIError, NotFound, PermissionDenied
from google.auth import impersonated_credentials
from google.cloud import resourcemanager_v3
from google.cloud.billing_v1 import CloudBillingClient
from google.cloud.billing_v1.types import ProjectBillingInfo

# What this product made, so it reports (and its delete removes) only
# those: never a project someone made some other way. Also how a retry
# that finds the project it made a moment ago still reports it.
MADE_BY_LABEL = ("vertra-made", "true")
# And for which team (the request's forTeam, the team the run is for, not
# the one it runs in: a Kubernetes namespace name, so always a valid label
# value), so it's reported, and deleted, only for that team: another team's
# project, even one this product made, isn't theirs.
TEAM_LABEL = "vertra-team"

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

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


def _link_billing(credentials: google.auth.credentials.Credentials | None, project_id: str, billing_account_id: str) -> None:
    """Links the project to the billing account, unless it is already: a
    later run asking for it again relinks one unlinked since (it's what the
    run asks for), and otherwise only reads, needing no billing right."""
    billing = CloudBillingClient(credentials=credentials)
    name = f"projects/{project_id}"
    account = f"billingAccounts/{billing_account_id}"
    if billing.get_project_billing_info(name=name).billing_account_name == account:
        return
    billing.update_project_billing_info(name=name, project_billing_info=ProjectBillingInfo(billing_account_name=account))


def _outputs(project_id: str, made_here: bool) -> dict[str, Any]:
    """The projectId, and the project as a resource when this product made it."""
    outputs: dict[str, Any] = {"projectId": project_id}
    if made_here:
        outputs["resources"] = [
            {
                "type": "gcp/project",
                "id": project_id,
                "link": f"https://console.cloud.google.com/home/dashboard?project={project_id}",
            }
        ]
    return outputs


def _found(credentials: google.auth.credentials.Credentials, project: Any, project_id: str, team: str,
           billing_account_id: str | None) -> int:
    """Succeeds with a project that's already there, reporting it (and
    linking billing) only when this product made it for this team."""
    labels = dict(project.labels)
    made_here = labels.get(MADE_BY_LABEL[0]) == MADE_BY_LABEL[1] and labels.get(TEAM_LABEL) == team
    if made_here and billing_account_id:
        # The attempt that made it may have stopped before linking it.
        try:
            _link_billing(credentials, project_id, billing_account_id)
        except GoogleAPIError as error:
            return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))
    _write_result({"status": "succeeded", "outputs": _outputs(project_id, made_here)})
    return 0


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
    if not project_id:
        return _failure("MISSING_INPUT", "inputs.projectId is required")
    team = request.get("forTeam")
    if not team:
        return _failure("MISSING_TEAM", "request.json has no forTeam: run it for one of your teams")

    credentials = _signed_in()
    projects = resourcemanager_v3.ProjectsClient(credentials=credentials)
    billing_account_id = inputs.get("billingAccountId")

    # Existing-user path: a project with this id already exists, so this
    # action is a no-op other than reporting it back.
    try:
        existing = projects.get_project(name=f"projects/{project_id}")
    except (NotFound, PermissionDenied):
        # A project that doesn't exist is a 403 too, unless this identity
        # may see wherever it would be: creating it tells them apart.
        existing = None
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))
    if existing is not None:
        print(f"project '{project_id}' already exists, skipping creation")
        return _found(credentials, existing, project_id, team, billing_account_id)

    # New-user path: create the project, then link billing if given --
    # without it the project exists but can't run billable services like
    # Cloud Run, which is exactly what gcp/app-hosting needs next.
    try:
        operation = projects.create_project(
            project=resourcemanager_v3.Project(
                project_id=project_id,
                display_name=project_id,
                labels={MADE_BY_LABEL[0]: MADE_BY_LABEL[1], TEAM_LABEL: team},
                parent=inputs.get("parent", ""),
            )
        )
        operation.result()  # blocks until the long-running create completes

        if billing_account_id:
            _link_billing(credentials, project_id, billing_account_id)
    except AlreadyExists:
        # Made a moment ago by another step for the same id (concurrencyKey
        # makes that rare) or an earlier attempt: found, if it can be seen.
        try:
            existing = projects.get_project(name=f"projects/{project_id}")
        except (NotFound, PermissionDenied):
            # Taken somewhere this identity can't see, or still being created
            # by an earlier attempt of this step, which the next may find.
            return _failure(
                "PROJECT_ID_TAKEN",
                f"project id '{project_id}' is already taken, somewhere this product can't see",
                retryable=request.get("attempt", 1) > 1,
            )
        except GoogleAPIError as error:
            return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))
        print(f"project '{project_id}' was created meanwhile, skipping creation")
        return _found(credentials, existing, project_id, team, billing_account_id)
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    print(f"created project '{project_id}'")
    _write_result({"status": "succeeded", "outputs": _outputs(project_id, True)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
