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
grants (cloudbuild.builds.{get,create}, storage.objects.get on the source
bucket, artifactregistry.tags.get) -- see the gcp team's README.md.
"""

import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import google.auth
import google.auth.credentials
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


def main() -> int:
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

    credentials = _build_credentials()

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
    )

    try:
        operation = cloudbuild_v1.CloudBuildClient(credentials=credentials).create_build(
            project_id=project_id, build=build
        )
        result = operation.result()  # blocks until the build finishes
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", str(error), retryable=_retryable(error))

    if result.status != cloudbuild_v1.Build.Status.SUCCESS:
        return _failure(
            "BUILD_FAILED",
            f"Cloud Build finished with status {result.status.name}: {result.status_detail}",
            retryable=True,
        )

    print(f"built '{source_archive_url}' -> {image_uri}")
    _write_result({"status": "succeeded", "outputs": {"imageUri": image_uri}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
