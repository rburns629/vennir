#!/usr/bin/env python3
"""aws/rds-postgres's "delete" action, its create's cleanup: deletes an
instance create made (tagged vennir-made=true) for the run's team
(tagged vennir-team=<it>), and no other, given the resource create reported
(its ARN, which names its region). A final snapshot is kept, named in the output, so the data isn't lost with it:
delete that snapshot once nobody needs it (it's billed as storage). An
instance already gone, or already being deleted, counts as deleted. RDS
finishes a delete on its own once it's accepted, so this doesn't wait.

Credentials as for create (see the aws team's README.md).
"""

import json
import re
import sys
import time
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
# aws-rds-postgres-role (key role-arn) and assumed by web identity with the step's
# own token (product.yaml's tokenAudiences). The role trusts this cluster's
# issuer for this product's ServiceAccount alone (the aws team's README.md,
# AWS from another cluster).
OWN_ROLE_FILE = Path("/platform/secrets/aws-rds-postgres-role/role-arn")
TOKEN_FILE = Path("/platform/tokens/sts.amazonaws.com")
MADE_BY_TAG = ("vennir-made", "true")
TEAM_TAG = "vennir-team"
INSTANCE_ARN = re.compile(r"^arn:aws[a-z-]*:rds:([a-z0-9-]+):[0-9]{12}:db:([a-zA-Z](?:[a-zA-Z0-9]|-(?!-)){0,62})$")
RETRYABLE_CODES = {
    # STS couldn't fetch the cluster's keys just then (off EKS).
    "IDPCommunicationError",
    "Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException",
    "ServiceUnavailable", "InternalError", "InternalFailure",
    # Busy (a backup or a modification in progress): it can be deleted once that's done.
    "InvalidDBInstanceState",
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
        return _failure("AWS_NO_CREDENTIALS", "No AWS credentials: on EKS, bind the step's ServiceAccount to an IAM role; elsewhere, give the step its aws-rds-postgres-role secret.")
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
    print(f"instance '{arn}' is already gone, or going")
    _write_result({"status": "succeeded", "outputs": {"deleted": arn}})
    return 0


def main() -> int:
    request = json.loads(INPUT_PATH.read_text())
    resource = request.get("inputs", {}).get("resource") or {}
    arn = resource.get("id", "")
    if resource.get("type") != "aws/rds-instance" or not arn:
        return _failure("MISSING_INPUT", "inputs.resource is the aws/rds-instance to delete, as create reported it")
    team = request.get("forTeam")
    if not team:
        return _failure("MISSING_TEAM", "request.json has no forTeam: run it for one of your teams")
    match = INSTANCE_ARN.match(arn)
    if not match:
        return _failure("INVALID_INPUT", f"'{arn}' isn't an RDS instance's ARN")
    region, instance_id = match.group(1), match.group(2)

    try:
        rds = _session(region).client("rds")
        try:
            instance = rds.describe_db_instances(DBInstanceIdentifier=instance_id)["DBInstances"][0]
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "DBInstanceNotFound":
                return _gone(arn)
            raise
        if instance.get("DBInstanceStatus") == "deleting":
            return _gone(arn)
        if {"Key": MADE_BY_TAG[0], "Value": MADE_BY_TAG[1]} not in instance.get("TagList", []):
            return _failure(
                "NOT_MADE_BY_VENNIR",
                f"Instance '{instance_id}' has no {MADE_BY_TAG[0]}={MADE_BY_TAG[1]} tag: this product deletes only instances it made.",
            )
        if {"Key": TEAM_TAG, "Value": team} not in instance.get("TagList", []):
            return _failure(
                "NOT_THIS_TEAMS",
                f"Instance '{instance_id}' has no {TEAM_TAG}={team} tag: this product deletes only instances it made for this team.",
            )
        snapshot = f"{instance_id}-final-{time.strftime('%Y%m%d%H%M%S', time.gmtime())}"
        try:
            rds.delete_db_instance(
                DBInstanceIdentifier=instance_id,
                SkipFinalSnapshot=False,
                FinalDBSnapshotIdentifier=snapshot,
                DeleteAutomatedBackups=True,
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "DBInstanceNotFound":
                return _gone(arn)
            raise
    except (ClientError, BotoCoreError) as error:
        return _aws_failure(error)

    print(f"deleting instance '{instance_id}', keeping the final snapshot '{snapshot}'")
    _write_result({"status": "succeeded", "outputs": {"deleted": arn, "finalSnapshot": snapshot}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
