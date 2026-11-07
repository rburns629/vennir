#!/usr/bin/env python3
"""aws/ecs-express's "delete" action, its create's cleanup: deletes a
service create made (tagged vennir-made=true) for the run's team (tagged
vennir-team=<it>), and no other, given the resource create reported (its
ARN, which names its region). ECS then removes what it made for the
service (its load balancer, target groups, security groups and scaling) on
its own, draining its tasks first, so this doesn't wait. A service that's
already gone, or going, counts as deleted.
Credentials as for create (see the aws team's README.md).
"""

import json
import re
import sys
from pathlib import Path
from typing import Any

import boto3
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

TARGET_ROLE_FILE = Path("/platform/secrets/aws-target/role-arn")
# Off EKS (GKE, AKS), with no default credentials: this product's own role,
# as EKS Pod Identity would bind it there, named by the team secret
# aws-ecs-express-role (key role-arn) and assumed by web identity with the
# step's own token (product.yaml's tokenAudiences). The role trusts this
# cluster's issuer for this product's ServiceAccount alone (the aws team's
# README.md, AWS from another cluster).
OWN_ROLE_FILE = Path("/platform/secrets/aws-ecs-express-role/role-arn")
TOKEN_FILE = Path("/platform/tokens/sts.amazonaws.com")
MADE_BY_TAG = ("vennir-made", "true")
TEAM_TAG = "vennir-team"
SERVICE_ARN = re.compile(r"^arn:aws[a-z-]*:ecs:([a-z0-9-]+):[0-9]{12}:service/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$")
# What ECS says of a service that's gone, or already going.
GONE = {"ResourceNotFoundException", "ServiceNotFoundException", "ClusterNotFoundException", "ServiceNotActiveException"}
RETRYABLE_CODES = {
    # STS couldn't fetch the cluster's keys just then (off EKS).
    "IDPCommunicationError",
    "Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException",
    "ServiceUnavailable", "InternalError", "InternalFailure", "ServerException",
}


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result(
        {"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}}
    )
    return 1


def _aws_failure(error: Exception) -> int:
    if isinstance(error, NoCredentialsError):
        return _failure("AWS_NO_CREDENTIALS", "No AWS credentials: on EKS, bind the step's ServiceAccount to an IAM role; elsewhere, give the step its aws-ecs-express-role secret.")
    if isinstance(error, ClientError):
        details = error.response.get("Error", {})
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        code = details.get("Code", "Unknown")
        retryable = code in RETRYABLE_CODES or status >= 500
        return _failure("AWS_API_ERROR", f"{code}: {details.get('Message', '')}", retryable=retryable)
    return _failure("AWS_API_ERROR", str(error), retryable=True)  # a connection problem


def _from(credentials: dict[str, Any], region: str) -> boto3.session.Session:
    return boto3.session.Session(
        aws_access_key_id=credentials["AccessKeyId"],
        aws_secret_access_key=credentials["SecretAccessKey"],
        aws_session_token=credentials["SessionToken"],
        region_name=region,
    )


def _signed_in(region: str) -> boto3.session.Session:
    """The default credentials (on EKS, Pod Identity's or IRSA's), or, with
    none, this product's own role by web identity (OWN_ROLE_FILE)."""
    session = boto3.session.Session(region_name=region)
    if session.get_credentials() is not None or not OWN_ROLE_FILE.exists():
        return session
    if not TOKEN_FILE.exists():
        raise NoCredentialsError()
    # Unsigned: the token is the proof.
    sts = session.client("sts", config=Config(signature_version=UNSIGNED))
    credentials = sts.assume_role_with_web_identity(
        RoleArn=OWN_ROLE_FILE.read_text().strip(), RoleSessionName="vennir-step",
        WebIdentityToken=TOKEN_FILE.read_text().strip(),
    )["Credentials"]
    return _from(credentials, region)


def _session(region: str) -> boto3.session.Session:
    """Signed in (_signed_in), then the aws-target role assumed as that,
    when the team registered one (short-lived; nothing is stored)."""
    session = _signed_in(region)
    target = TARGET_ROLE_FILE.read_text().strip() if TARGET_ROLE_FILE.exists() else ""
    if not target:
        return session
    credentials = session.client("sts").assume_role(
        RoleArn=target, RoleSessionName="vennir-step"
    )["Credentials"]
    return _from(credentials, region)


def _gone(arn: str) -> int:
    print(f"service '{arn}' is already gone")
    _write_result({"status": "succeeded", "outputs": {"deleted": arn}})
    return 0


def _code(error: ClientError) -> str:
    return error.response.get("Error", {}).get("Code", "")


def main() -> int:
    request = json.loads(INPUT_PATH.read_text())
    resource = request.get("inputs", {}).get("resource") or {}
    arn = resource.get("id", "")
    if resource.get("type") != "aws/ecs-express-service" or not arn:
        return _failure("MISSING_INPUT", "inputs.resource is the aws/ecs-express-service to delete, as create reported it")
    team = request.get("forTeam")
    if not team:
        return _failure("MISSING_TEAM", "request.json has no forTeam: run it for one of your teams")
    match = SERVICE_ARN.match(arn)
    if not match:
        return _failure("INVALID_INPUT", f"'{arn}' isn't an ECS service's ARN")

    try:
        ecs = _session(match.group(1)).client("ecs")
        try:
            service = ecs.describe_express_gateway_service(serviceArn=arn, include=["TAGS"])["service"]
        except ClientError as error:
            if _code(error) in GONE:
                return _gone(arn)
            raise
        if service.get("status", {}).get("statusCode") in ("DRAINING", "INACTIVE"):
            return _gone(arn)
        tags = {t.get("key"): t.get("value") for t in service.get("tags", [])}
        if tags.get(MADE_BY_TAG[0]) != MADE_BY_TAG[1]:
            return _failure(
                "NOT_MADE_BY_VENNIR",
                f"Service '{service.get('serviceName')}' has no {MADE_BY_TAG[0]}={MADE_BY_TAG[1]} tag: this product deletes only services it made.",
            )
        if tags.get(TEAM_TAG) != team:
            return _failure(
                "NOT_THIS_TEAMS",
                f"Service '{service.get('serviceName')}' has no {TEAM_TAG}={team} tag: this product deletes only services it made for this team.",
            )
        try:
            ecs.delete_express_gateway_service(serviceArn=arn)
        except ClientError as error:
            if _code(error) in GONE:
                return _gone(arn)
            raise
    except (ClientError, BotoCoreError) as error:
        return _aws_failure(error)

    print(f"deleting service '{service.get('serviceName')}'")
    _write_result({"status": "succeeded", "outputs": {"deleted": arn}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
