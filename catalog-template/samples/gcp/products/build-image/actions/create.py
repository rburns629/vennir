#!/usr/bin/env python3
"""gcp/build-image's "create" action: builds a container image from a
source archive via Cloud Build, pushing it to the given image reference --
or skips the build and returns that reference unchanged if it already
exists.

Run directly by this product's entrypoint.sh, which already guarantees this
script only ever runs for action="create" -- see product.yaml for this
action's declared input/output schema.

The source archive (already in GCS: getting uploaded source there happens
before a DAG is submitted, outside this product) must contain
a Dockerfile at its root; this runs a plain `docker build`, it does not use
buildpacks or otherwise infer how to build arbitrary source.

By default, calls Cloud Build and Artifact Registry using whatever
GOOGLE_APPLICATION_CREDENTIALS/ADC the container finds. If
the gcp-target secret is mounted, those base credentials are never used to
call GCP APIs directly -- they're only the *source* identity used to
impersonate that service account instead (short-lived tokens, minted on
demand; no static key for the target identity ever exists). The source
identity must itself hold roles/iam.serviceAccountTokenCreator on the
target service account, and the target service account needs its own IAM
grants (cloudbuild.builds.{get,create,list}, storage.objects.get on the source
bucket, artifactregistry.tags.get) -- see the gcp team's README.md.
"""

import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import google.auth
import google.auth.credentials
import google.auth.exceptions
import google.auth.transport.requests
from google.api_core.exceptions import GoogleAPIError, NotFound
from google.auth import impersonated_credentials
from google.cloud import artifactregistry_v1
from google.cloud.devtools import cloudbuild_v1

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

# The service account to act as, if the team registered one: its secret
# gcp-target (key service-account), mounted when the action lists it in
# secretRefs. See the gcp team's README.md.
TARGET_SERVICE_ACCOUNT_FILE = Path("/platform/secrets/gcp-target/service-account")
IMPERSONATION_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]

# How a build that didn't succeed ended. Cloud Build's own trouble, or a
# build left queued too long, may pass; the build failing, running out of
# time or being cancelled ends the same way again, so isn't retried.
FAILED_BUILD_STATUSES = (
    cloudbuild_v1.Build.Status.FAILURE,
    cloudbuild_v1.Build.Status.INTERNAL_ERROR,
    cloudbuild_v1.Build.Status.TIMEOUT,
    cloudbuild_v1.Build.Status.CANCELLED,
    cloudbuild_v1.Build.Status.EXPIRED,
)
RETRIED_BUILD_STATUSES = (cloudbuild_v1.Build.Status.INTERNAL_ERROR, cloudbuild_v1.Build.Status.EXPIRED)
UNFINISHED_BUILD_STATUSES = (
    cloudbuild_v1.Build.Status.STATUS_UNKNOWN,
    cloudbuild_v1.Build.Status.PENDING,
    cloudbuild_v1.Build.Status.QUEUED,
    cloudbuild_v1.Build.Status.WORKING,
)

# Waiting on a build an earlier attempt started: at most this long here, as
# for its own (google-cloud's 15 minutes), checking this often.
WAIT_SECONDS = 900
POLL_SECONDS = 10


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


def _build_tag(image_uri: str, source_archive_url: str) -> str:
    """The tag every build of this image from this source carries, so a
    later attempt can find one an earlier attempt left running."""
    digest = hashlib.sha256(f"{image_uri}\n{source_archive_url}".encode()).hexdigest()
    return f"vertra-{digest[:40]}"


def _running_build(client: cloudbuild_v1.CloudBuildClient, project_id: str, tag: str) -> cloudbuild_v1.Build | None:
    """A build with this tag still queued or running, if there is one."""
    builds = client.list_builds(project_id=project_id, filter=f'tags="{tag}" AND (status="QUEUED" OR status="WORKING")')
    return next(iter(builds), None)


def _finished(client: cloudbuild_v1.CloudBuildClient, project_id: str, build_id: str) -> cloudbuild_v1.Build:
    """The build once it has finished; TimeoutError if it hasn't in WAIT_SECONDS."""
    deadline = time.monotonic() + WAIT_SECONDS
    while True:
        build = client.get_build(project_id=project_id, id=build_id)
        if build.status not in UNFINISHED_BUILD_STATUSES:
            return build
        if time.monotonic() >= deadline:
            raise TimeoutError(f"Cloud Build {build_id} hadn't finished after {WAIT_SECONDS}s; it may still push the image")
        time.sleep(POLL_SECONDS)


def _parse_gcs_url(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    return parts.netloc, parts.path.lstrip("/")


def _artifact_registry_tag_name(image_uri: str) -> str | None:
    """Resource name of image_uri's tag, or None if image_uri isn't a
    LOCATION-docker.pkg.dev reference -- the existing-image check only
    applies to Artifact Registry; anything else always builds.

    An Artifact Registry image uri has the shape
    LOCATION-docker.pkg.dev/PROJECT/REPOSITORY/IMAGE:TAG -- self-describing,
    so this reads the owning project out of the uri itself rather than
    trusting the task's separate projectId input to match it.
    """
    host, _, rest = image_uri.partition("/")
    if not host.endswith("-docker.pkg.dev"):
        return None
    location = host.removesuffix("-docker.pkg.dev")

    project, _, rest = rest.partition("/")
    repository, _, image_and_tag = rest.partition("/")
    image, separator, tag = image_and_tag.rpartition(":")
    if not project or not repository or not image or not separator:
        return None
    return (
        f"projects/{project}/locations/{location}/repositories/{repository}"
        f"/packages/{image}/tags/{tag}"
    )


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
    source_archive_url = inputs.get("sourceArchiveUrl")
    image_uri = inputs.get("imageUri")
    if not project_id or not source_archive_url or not image_uri:
        return _failure(
            "MISSING_INPUT",
            "inputs.projectId, inputs.sourceArchiveUrl, and inputs.imageUri are required",
        )

    credentials = _signed_in()

    # Existing-user path: this exact image:tag was already built, so this
    # action is a no-op other than reporting it back.
    tag_name = _artifact_registry_tag_name(image_uri)
    if tag_name is not None:
        try:
            artifactregistry_v1.ArtifactRegistryClient(credentials=credentials).get_tag(
                name=tag_name
            )
            print(f"image '{image_uri}' already exists, skipping build")
            _write_result({"status": "succeeded", "outputs": {"imageUri": image_uri}})
            return 0
        except NotFound:
            pass
        except GoogleAPIError as error:
            return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    client = cloudbuild_v1.CloudBuildClient(credentials=credentials)
    tag = _build_tag(image_uri, source_archive_url)

    # An earlier attempt's build, still running (its step ran out of time,
    # or stopped waiting): waited on, not started again.
    try:
        running = _running_build(client, project_id, tag)
        if running is not None:
            print(f"Cloud Build {running.id} is already building '{image_uri}', waiting on it")
            result = _finished(client, project_id, running.id)
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    if running is None:
        bucket, object_name = _parse_gcs_url(source_archive_url)
        build = cloudbuild_v1.Build(
            source=cloudbuild_v1.Source(
                storage_source=cloudbuild_v1.StorageSource(bucket=bucket, object_=object_name)
            ),
            steps=[
                cloudbuild_v1.BuildStep(
                    name="gcr.io/cloud-builders/docker", args=["build", "-t", image_uri, "."]
                )
            ],
            images=[image_uri],
            tags=[tag],
        )
        try:
            operation = client.create_build(project_id=project_id, build=build)
        except GoogleAPIError as error:
            return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))
        try:
            result = operation.result()  # blocks until the build finishes
        except GoogleAPIError as error:
            # A build that ran and failed ends its operation with an error too
            # (UNKNOWN, no HTTP code), which alone would be retried: the build
            # itself says how it ended.
            metadata = operation.metadata
            result = metadata.build if metadata is not None else None
            if result is None or result.status not in FAILED_BUILD_STATUSES:
                return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))
        except TimeoutError:
            # Retried: the next attempt finds this build by its tag and waits on it.
            build_id = operation.metadata.build.id if operation.metadata is not None else "?"
            return _failure(
                "GCP_TIMEOUT",
                f"Cloud Build {build_id} hadn't finished when this stopped waiting; it may still push {image_uri}",
                retryable=True,
            )

    if result.status != cloudbuild_v1.Build.Status.SUCCESS:
        return _failure(
            "BUILD_FAILED",
            f"Cloud Build {result.id} finished with status {result.status.name}: {result.status_detail}",
            retryable=result.status in RETRIED_BUILD_STATUSES,
        )

    print(f"built '{source_archive_url}' -> {image_uri}")
    _write_result({"status": "succeeded", "outputs": {"imageUri": image_uri}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
