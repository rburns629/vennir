#!/usr/bin/env python3
"""aws/rds-postgres's "create" action: finds an RDS for PostgreSQL instance
by id, creating it only if it doesn't exist, and waits until it's available.

No password ever passes through the step: RDS generates the master password
and keeps it in AWS Secrets Manager (ManageMasterUserPassword), and the
output is that secret's ARN, a reference an app's own identity may be
granted to read. New instances are encrypted and not publicly accessible.
One it creates is tagged vennir-made=true and vennir-team=<the run's team> and
reported as a resource, which delete (its cleanup) removes; one it only
found is neither, unless an earlier attempt made it for this team.
Credentials as in the aws team's README.md: boto3's default chain (EKS Pod
Identity or IRSA) or, off EKS, its own role by web identity, optionally
assuming the aws-target role.
"""

import json
import re
import sys
from pathlib import Path
from typing import Any

import boto3
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError, WaiterError

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

# The role to act as, if the team registered one: its secret aws-target (key
# role-arn), mounted when the action lists it in secretRefs. See the aws
# team's README.md.
TARGET_ROLE_FILE = Path("/platform/secrets/aws-target/role-arn")
# Off EKS (GKE, AKS), with no default credentials: this product's own role,
# as EKS Pod Identity would bind it there, named by the team secret
# aws-rds-postgres-role (key role-arn) and assumed by web identity with the step's
# own token (product.yaml's tokenAudiences). The role trusts this cluster's
# issuer for this product's ServiceAccount alone (the aws team's README.md,
# AWS from another cluster).
OWN_ROLE_FILE = Path("/platform/secrets/aws-rds-postgres-role/role-arn")
TOKEN_FILE = Path("/platform/tokens/sts.amazonaws.com")
# What marks an instance this product made: delete removes no other.
MADE_BY_TAG = ("vennir-made", "true")
# And for which team (the request's forTeam, the team the run is for, not
# the one it runs in), so it's reported, and deleted, only for that team:
# another team's instance, even one this product made, isn't theirs.
TEAM_TAG = "vennir-team"
RETRYABLE_CODES = {
    # STS couldn't fetch the cluster's keys just then (off EKS).
    "IDPCommunicationError",
    "Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException",
    "ServiceUnavailable", "InternalError", "InternalFailure",
}
INSTANCE_ID = re.compile(r"^[a-zA-Z](?:[a-zA-Z0-9]|-(?!-)){0,62}$")
# A first create takes several minutes: 30s x 40 = 20 minutes, inside the
# step's timeoutSeconds (set it to 1500 or more).
WAIT = {"Delay": 30, "MaxAttempts": 40}


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
        # RDS's first use in an account makes its service-linked role, and the
        # create right after can fail before that role is usable: try again.
        first_use = code == "InvalidParameterValue" and "ServiceLinkedRoles" in details.get("Message", "")
        retryable = code in RETRYABLE_CODES or status >= 500 or first_use
        return _failure("AWS_API_ERROR", f"{code}: {details.get('Message', '')}", retryable=retryable)
    return _failure("AWS_API_ERROR", str(error), retryable=True)


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


def _describe(rds: Any, instance_id: str) -> dict[str, Any] | None:
    try:
        return rds.describe_db_instances(DBInstanceIdentifier=instance_id)["DBInstances"][0]
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "DBInstanceNotFound":
            return None
        raise


def _outputs(instance: dict[str, Any], region: str, made_here: bool, team: str) -> dict[str, Any]:
    endpoint = instance.get("Endpoint") or {}
    outputs: dict[str, Any] = {
        "instanceId": instance["DBInstanceIdentifier"],
        "endpoint": endpoint.get("Address", ""),
        "port": endpoint.get("Port", 5432),
    }
    secret = (instance.get("MasterUserSecret") or {}).get("SecretArn")
    if secret:
        outputs["masterUserSecretArn"] = secret
    tags = instance.get("TagList", [])
    made = made_here or ({"Key": MADE_BY_TAG[0], "Value": MADE_BY_TAG[1]} in tags and {"Key": TEAM_TAG, "Value": team} in tags)
    if made and instance.get("DBInstanceArn"):
        outputs["resources"] = [
            {
                "type": "aws/rds-instance",
                "id": instance["DBInstanceArn"],
                "name": instance["DBInstanceIdentifier"],
                "link": f"https://{region}.console.aws.amazon.com/rds/home?region={region}#database:id={instance['DBInstanceIdentifier']}",
            }
        ]
    return outputs


def main() -> int:
    request = json.loads(INPUT_PATH.read_text())
    inputs = request.get("inputs", {})
    instance_id, region = inputs.get("instanceId"), inputs.get("region")
    if not instance_id or not region:
        return _failure("MISSING_INPUT", "inputs.instanceId and inputs.region are required")
    team = request.get("forTeam")
    if not team:
        return _failure("MISSING_TEAM", "request.json has no forTeam: run it for one of your teams")
    if not INSTANCE_ID.match(instance_id):
        return _failure(
            "INVALID_INPUT",
            "inputs.instanceId: a letter, then up to 62 letters, digits or single hyphens",
        )

    try:
        rds = _session(region).client("rds")
        instance = _describe(rds, instance_id)
        created = instance is None
        if instance is None:
            create: dict[str, Any] = {
                "DBInstanceIdentifier": instance_id,
                "Engine": "postgres",
                "DBInstanceClass": inputs.get("instanceClass", "db.t4g.micro"),
                "AllocatedStorage": int(inputs.get("allocatedStorageGb", 20)),
                "MasterUsername": inputs.get("masterUsername", "vennir_admin"),
                "ManageMasterUserPassword": True,
                "StorageEncrypted": True,
                "PubliclyAccessible": False,
                "BackupRetentionPeriod": 7,
                "CopyTagsToSnapshot": True,
                "Tags": [{"Key": "managed-by", "Value": "vennir"}, {"Key": MADE_BY_TAG[0], "Value": MADE_BY_TAG[1]}, {"Key": TEAM_TAG, "Value": team}],
            }
            if inputs.get("engineVersion"):
                create["EngineVersion"] = inputs["engineVersion"]
            rds.create_db_instance(**create)
            print(f"creating instance '{instance_id}'; this takes several minutes")
        elif instance.get("DBInstanceStatus") == "available":
            print(f"instance '{instance_id}' already exists")
            _write_result({"status": "succeeded", "outputs": _outputs(instance, region, False, team)})
            return 0
        else:
            print(f"instance '{instance_id}' exists ({instance.get('DBInstanceStatus')}); waiting")

        rds.get_waiter("db_instance_available").wait(
            DBInstanceIdentifier=instance_id, WaiterConfig=WAIT
        )
        instance = _describe(rds, instance_id) or {}
    except WaiterError as error:
        return _failure(
            "INSTANCE_NOT_AVAILABLE",
            f"Instance '{instance_id}' isn't available yet ({error}); running the step again waits for it.",
            retryable=True,
        )
    except (ClientError, BotoCoreError) as error:
        return _aws_failure(error)

    print(f"instance '{instance_id}' is available")
    _write_result({"status": "succeeded", "outputs": _outputs(instance, region, created, team)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
