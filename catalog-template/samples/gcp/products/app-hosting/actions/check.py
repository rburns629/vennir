#!/usr/bin/env python3
"""gcp/app-hosting's "check" action: whether it's ready on this install
(product.yaml's check). Changes nothing.

Run by the console with no inputs, as this product's identity. It asks
Google for a token as that identity (impersonating gcp-target when the
team's secret is mounted, as create does), then asks, with
testIamPermissions, whether it may deploy and delete Cloud Run services in
a project it can see, and act as the runtime service account the team's
app-hosting secret names, which a service create deploys runs as. create's
projectId is per run, so it looks for any project: ready means there's at
least one.
Reports what's missing as the roles to grant (the gcp team's README.md,
Credentials).

Resource Manager and IAM are called over REST (this image has no client
library for them): an AuthorizedSession, which adds the token to each
request itself.
"""

import json
import sys
from pathlib import Path
from typing import Any

import google.auth
import google.auth.credentials
import google.auth.exceptions
import google.auth.transport.requests
import requests
from google.auth import impersonated_credentials
from google.auth.transport.requests import AuthorizedSession

OUTPUT_PATH = Path("/platform/output/result.json")

# product.yaml's serviceAccount: the Kubernetes identity Workload Identity
# signs in as, named in what an admin must grant it.
SERVICE_ACCOUNT = "gcp-app-hosting"
TARGET_SERVICE_ACCOUNT_FILE = Path("/platform/secrets/gcp-target/service-account")
# The team's secret app-hosting: the account a service runs as (create.py).
RUNTIME_SERVICE_ACCOUNT_FILE = Path("/platform/secrets/app-hosting/runtime-service-account")
IMPERSONATION_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]

RESOURCE_MANAGER = "https://cloudresourcemanager.googleapis.com/v3"
IAM = "https://iam.googleapis.com/v1"
# Cheap: at most this many projects asked about.
MAX_PROJECTS = 20
TIMEOUT_SECONDS = 30
# What create and delete need in their project, and the role that grants each.
PROJECT_PERMISSIONS = {
    "run.services.get": "roles/run.developer",
    "run.services.create": "roles/run.developer",
    "run.services.delete": "roles/run.developer",
}
ACT_AS = "iam.serviceAccounts.actAs"  # roles/iam.serviceAccountUser


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _answer(ready: bool, principal: str, missing: list[str], detail: str) -> int:
    _write_result({
        "status": "succeeded",
        "outputs": {"ready": ready, "principal": principal, "missing": missing, "detail": detail},
    })
    return 0


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result(
        {"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}}
    )
    return 1


def _sign_in() -> tuple[google.auth.credentials.Credentials, str]:
    """This product's credentials, refreshed (so they work), and who they are.
    Raises google.auth's DefaultCredentialsError or RefreshError when it can't."""
    target = TARGET_SERVICE_ACCOUNT_FILE.read_text().strip() if TARGET_SERVICE_ACCOUNT_FILE.exists() else ""
    source, _ = google.auth.default(scopes=IMPERSONATION_SCOPES)
    credentials = source
    if target:
        credentials = impersonated_credentials.Credentials(
            source_credentials=source, target_principal=target, target_scopes=IMPERSONATION_SCOPES
        )
    credentials.refresh(google.auth.transport.requests.Request())
    if target:
        return credentials, target
    # GKE's metadata server names the pool for a Kubernetes identity bound
    # directly (no Google service account): <project>.svc.id.goog.
    email = getattr(source, "service_account_email", "") or ""
    if email.endswith(".svc.id.goog"):
        return credentials, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, by Workload Identity ({email})"
    if not email or email == "default":
        return credentials, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, by Workload Identity"
    return credentials, email  # a Google service account bound to it


def _call(session: Any, method: str, url: str, **kwargs: Any) -> dict[str, Any]:
    response = session.request(method, url, timeout=TIMEOUT_SECONDS, **kwargs)
    response.raise_for_status()
    return response.json()


def main() -> int:
    target = TARGET_SERVICE_ACCOUNT_FILE.read_text().strip() if TARGET_SERVICE_ACCOUNT_FILE.exists() else ""
    try:
        credentials, principal = _sign_in()
    except google.auth.exceptions.DefaultCredentialsError:
        return _answer(
            False, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, with no Google identity",
            [f"GKE Workload Identity Federation for ServiceAccount {SERVICE_ACCOUNT} (the cluster's)"],
            "No Google credentials: this step isn't running with Workload Identity.",
        )
    except google.auth.exceptions.RefreshError as error:
        if target:
            return _answer(
                False, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, impersonating {target}",
                [f"roles/iam.serviceAccountTokenCreator on {target}, for ServiceAccount {SERVICE_ACCOUNT}"],
                f"Couldn't impersonate gcp-target: {str(error)[:300]}",
            )
        return _answer(
            False, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}",
            [f"GKE Workload Identity Federation for ServiceAccount {SERVICE_ACCOUNT} (the cluster's)"],
            f"Couldn't get a Google token: {str(error)[:300]}",
        )
    except google.auth.exceptions.TransportError as error:
        return _failure("GCP_API_ERROR", f"couldn't reach Google to sign in: {error}", retryable=True)

    runtime = RUNTIME_SERVICE_ACCOUNT_FILE.read_text().strip() if RUNTIME_SERVICE_ACCOUNT_FILE.exists() else ""
    if not runtime:
        return _answer(
            False, principal, ["the team secret app-hosting, with image-registry and runtime-service-account"],
            "It can sign in, but doesn't know which registry to deploy from or which account to run as.",
        )

    wanted = list(PROJECT_PERMISSIONS)
    session = AuthorizedSession(credentials)
    try:
        found = _call(session, "GET", f"{RESOURCE_MANAGER}/projects:search",
                      params={"query": "state:ACTIVE", "pageSize": MAX_PROJECTS})
        # The project it may do the most in: ready when that's everything.
        best: tuple[dict[str, Any], set[str]] | None = None
        for project in found.get("projects", [])[:MAX_PROJECTS]:
            held = set(_call(session, "POST", f"{RESOURCE_MANAGER}/projects/{project['projectId']}:testIamPermissions",
                             json={"permissions": wanted}).get("permissions", []))
            if best is None or len(held) > len(best[1]):
                best = (project, held)
            if len(held) == len(wanted):
                break
        if best is None:
            roles = sorted(set(PROJECT_PERMISSIONS.values()))
            return _answer(False, principal, [f"{', '.join(roles)} on a project it deploys to"],
                           "It can sign in, but sees no project.")
        project_id = best[0]["projectId"]
        if len(best[1]) < len(wanted):
            roles = sorted({PROJECT_PERMISSIONS[p] for p in wanted if p not in best[1]})
            return _answer(False, principal, [f"{', '.join(roles)} on project {project_id}"],
                           "It can sign in, but can't deploy to Cloud Run in any project it sees.")
        # A service runs as the team's runtime account, and deploying one
        # needs to act as it. "-": the account's own project, whichever.
        response = session.request("POST", f"{IAM}/projects/-/serviceAccounts/{runtime}:testIamPermissions",
                                   json={"permissions": [ACT_AS]}, timeout=TIMEOUT_SECONDS)
        # 403 or 404: it may not even see the account, or there's none:
        # either way, nothing to act as.
        unseen = response.status_code in (403, 404)
        if not unseen:
            response.raise_for_status()
        acts_as = not unseen and ACT_AS in response.json().get("permissions", [])
    except requests.RequestException as error:
        status = error.response.status_code if error.response is not None else 0
        return _failure("GCP_API_ERROR", f"couldn't ask Google what it may do: {str(error)[:300]}",
                        retryable=status == 0 or status == 429 or status >= 500)

    if not acts_as:
        return _answer(
            False, principal, [f"roles/iam.serviceAccountUser on {runtime} (the team's Cloud Run runtime account)"],
            f"It may deploy to Cloud Run in project {project_id}, but not run a service as its runtime account.",
        )
    return _answer(True, principal, [], f"It may deploy to Cloud Run in project {project_id}.")


if __name__ == "__main__":
    sys.exit(main())
