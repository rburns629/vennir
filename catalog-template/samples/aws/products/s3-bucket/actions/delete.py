#!/usr/bin/env python3
"""aws/s3-bucket's "delete" action, its create's cleanup: deletes a bucket
create made (tagged vennir-made=true) for the run's team (tagged
vennir-team=<it>), and no other. A bucket that's already
gone counts as deleted; one that still holds objects is refused rather than
emptied, so nothing anyone stored in it is lost by a cleanup.

Credentials as for create (see the aws team's README.md).
"""

import json
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
# aws-s3-bucket-role (key role-arn) and assumed by web identity with the step's
# own token (product.yaml's tokenAudiences). The role trusts this cluster's
# issuer for this product's ServiceAccount alone (the aws team's README.md,
# AWS from another cluster).
OWN_ROLE_FILE = Path("/platform/secrets/aws-s3-bucket-role/role-arn")
TOKEN_FILE = Path("/platform/tokens/sts.amazonaws.com")
MADE_BY_TAG = ("vennir-made", "true")
TEAM_TAG = "vennir-team"
RETRYABLE_CODES = {
    # STS couldn't fetch the cluster's keys just then (off EKS).
    "IDPCommunicationError",
    "Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException",
    "SlowDown", "ServiceUnavailable", "InternalError", "InternalFailure", "OperationAborted",
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
        return _failure("AWS_NO_CREDENTIALS", "No AWS credentials: on EKS, bind the step's ServiceAccount to an IAM role; elsewhere, give the step its aws-s3-bucket-role secret.")
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


def _code(error: ClientError) -> str:
    return error.response.get("Error", {}).get("Code", "")


def _gone(bucket: str) -> int:
    print(f"bucket '{bucket}' is already gone")
    _write_result({"status": "succeeded", "outputs": {"deleted": bucket}})
    return 0


def main() -> int:
    request = json.loads(INPUT_PATH.read_text())
    inputs = request.get("inputs", {})
    bucket, region = inputs.get("bucketName"), inputs.get("region")
    if not bucket or not region:
        return _failure("MISSING_INPUT", "inputs.bucketName and inputs.region are required")
    team = request.get("forTeam")
    if not team:
        return _failure("MISSING_TEAM", "request.json has no forTeam: run it for one of your teams")

    try:
        s3 = _session(region).client("s3")
        try:
            s3.head_bucket(Bucket=bucket)
        except ClientError as error:
            if _code(error) in ("404", "NoSuchBucket"):
                return _gone(bucket)
            if _code(error) == "403":
                # Never reported deleted: it may well still be there.
                return _failure("BUCKET_NOT_VISIBLE", f"Bucket '{bucket}' can't be read: this product may no longer have access to it.")
            raise
        try:
            tags = s3.get_bucket_tagging(Bucket=bucket).get("TagSet", [])
        except ClientError as error:
            if _code(error) != "NoSuchTagSet":
                raise
            tags = []
        if {"Key": MADE_BY_TAG[0], "Value": MADE_BY_TAG[1]} not in tags:
            return _failure(
                "NOT_MADE_BY_VENNIR",
                f"Bucket '{bucket}' has no {MADE_BY_TAG[0]}={MADE_BY_TAG[1]} tag: this product deletes only buckets it made.",
            )
        if {"Key": TEAM_TAG, "Value": team} not in tags:
            return _failure(
                "NOT_THIS_TEAMS",
                f"Bucket '{bucket}' has no {TEAM_TAG}={team} tag: this product deletes only buckets it made for this team.",
            )
        try:
            s3.delete_bucket(Bucket=bucket)
        except ClientError as error:
            if _code(error) == "NoSuchBucket":
                return _gone(bucket)
            if _code(error) == "BucketNotEmpty":
                return _failure(
                    "BUCKET_NOT_EMPTY",
                    f"Bucket '{bucket}' still holds objects: empty it (or keep it), then delete it again.",
                )
            raise
    except (ClientError, BotoCoreError) as error:
        return _aws_failure(error)

    print(f"deleted bucket '{bucket}'")
    _write_result({"status": "succeeded", "outputs": {"deleted": bucket}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
