#!/usr/bin/env python3
"""aws/s3-bucket's "create" action: finds an S3 bucket by name, creating it
(with every kind of public access blocked) only if it doesn't exist. One it
creates is tagged vennir-made=true and vennir-team=<the run's team> in the
create call itself, so a step cut short right after still finds its bucket
tagged, and reported as a resource, which delete (its cleanup) removes; one
it only found is neither, unless it was made for this team. A bucket
it made, found again, has its public access block put again, in case the
step that made it stopped before that.

Credentials come from boto3's default chain: on EKS, Pod Identity or IRSA
supplies short-lived ones for the step's ServiceAccount, so nothing is
mounted. With the team secret aws-target, those are used only to assume its
role, and the calls are made as it (see the aws team's README.md).
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

# The role to act as, if the team registered one: its secret aws-target (key
# role-arn), mounted when the action lists it in secretRefs. See the aws
# team's README.md.
TARGET_ROLE_FILE = Path("/platform/secrets/aws-target/role-arn")
# From a cluster that isn't EKS (GKE, AKS): no default credentials, but
# this step's own token for AWS's STS (product.yaml's tokenAudiences), which
# the aws-target role trusts by web identity for this product's
# ServiceAccount (the aws team's README.md, AWS from another cluster).
TOKEN_FILE = Path("/platform/tokens/sts.amazonaws.com")
# What marks a bucket this product made: delete removes no other.
MADE_BY_TAG = ("vennir-made", "true")
# And for which team (the request's forTeam, the team the run is for, not
# the one it runs in), so it's reported, and deleted, only for that team:
# another team's bucket, even one this product made, isn't theirs.
TEAM_TAG = "vennir-team"
RETRYABLE_CODES = {
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
        return _failure("AWS_NO_CREDENTIALS", "No AWS credentials: is the step's ServiceAccount bound to an IAM role?")
    if isinstance(error, ClientError):
        details = error.response.get("Error", {})
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        code = details.get("Code", "Unknown")
        retryable = code in RETRYABLE_CODES or status >= 500
        return _failure("AWS_API_ERROR", f"{code}: {details.get('Message', '')}", retryable=retryable)
    return _failure("AWS_API_ERROR", str(error), retryable=True)  # a connection problem


def _session(region: str) -> boto3.session.Session:
    """The default credentials, or the aws-target role assumed with them
    or, with none (off EKS), by web identity with the step's own token
    (short-lived; nothing is stored)."""
    session = boto3.session.Session(region_name=region)
    target = TARGET_ROLE_FILE.read_text().strip() if TARGET_ROLE_FILE.exists() else ""
    if not target:
        return session
    if session.get_credentials() is None and TOKEN_FILE.exists():
        # Unsigned: the token is the proof.
        sts = session.client("sts", config=Config(signature_version=UNSIGNED))
        credentials = sts.assume_role_with_web_identity(
            RoleArn=target, RoleSessionName="vennir-step", WebIdentityToken=TOKEN_FILE.read_text().strip()
        )["Credentials"]
    else:
        credentials = session.client("sts").assume_role(
            RoleArn=target, RoleSessionName="vennir-step"
        )["Credentials"]
    return boto3.session.Session(
        aws_access_key_id=credentials["AccessKeyId"],
        aws_secret_access_key=credentials["SecretAccessKey"],
        aws_session_token=credentials["SessionToken"],
        region_name=region,
    )


def _made_here(s3: Any, bucket: str, team: str) -> bool:
    """Whether the bucket carries this product's tags, for this team."""
    try:
        tags = s3.get_bucket_tagging(Bucket=bucket).get("TagSet", [])
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "NoSuchTagSet":
            return False
        raise
    return {"Key": MADE_BY_TAG[0], "Value": MADE_BY_TAG[1]} in tags and {"Key": TEAM_TAG, "Value": team} in tags


def _outputs(bucket: str, region: str, made_here: bool) -> dict[str, Any]:
    outputs: dict[str, Any] = {"bucketName": bucket, "region": region, "arn": f"arn:aws:s3:::{bucket}"}
    if made_here:
        outputs["resources"] = [
            {
                "type": "aws/s3-bucket",
                "id": bucket,
                "link": f"https://{region}.console.aws.amazon.com/s3/buckets/{bucket}?region={region}",
            }
        ]
    return outputs


def main() -> int:
    request = json.loads(INPUT_PATH.read_text())
    inputs = request.get("inputs", {})
    bucket = inputs.get("bucketName")
    region = inputs.get("region")
    if not bucket or not region:
        return _failure("MISSING_INPUT", "inputs.bucketName and inputs.region are required")
    team = request.get("forTeam")
    if not team:
        return _failure("MISSING_TEAM", "request.json has no forTeam: run it for one of your teams")

    try:
        s3 = _session(region).client("s3")
        try:
            found = s3.head_bucket(Bucket=bucket)
            region = found.get("BucketRegion") or region
            print(f"bucket '{bucket}' already exists, in {region}")
            made_here = _made_here(s3, bucket, team)
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code")
            if code == "403":
                return _failure(
                    "BUCKET_NAME_TAKEN",
                    f"Bucket '{bucket}' exists but this identity can't use it: bucket names are "
                    "global, so it's probably another account's. Choose another name.",
                )
            if code != "404":
                raise
            made_here = _create(s3, bucket, region, team)
            if made_here is None:
                return _failure("BUCKET_NAME_TAKEN", f"Bucket name '{bucket}' is taken. Choose another.")
            if made_here == "denied":
                return _failure(
                    "AWS_API_ERROR",
                    f"AccessDenied creating bucket '{bucket}' with its tag: the role needs s3:CreateBucket and "
                    "s3:TagResource (one granted from an older aws README has s3:PutBucketTagging instead).",
                )
            print(f"created bucket '{bucket}' in {region}")

        if made_here:
            s3.put_public_access_block(
                Bucket=bucket,
                PublicAccessBlockConfiguration={
                    "BlockPublicAcls": True,
                    "IgnorePublicAcls": True,
                    "BlockPublicPolicy": True,
                    "RestrictPublicBuckets": True,
                },
            )
    except (ClientError, BotoCoreError) as error:
        return _aws_failure(error)

    _write_result({"status": "succeeded", "outputs": _outputs(bucket, region, made_here)})
    return 0


def _create(s3: Any, bucket: str, region: str, team: str) -> bool | None | str:
    """Creates the bucket, tagged for this team: whether it's this product's,
    for this team; None if the name is another account's, or "denied" if
    this role may not."""
    configuration: dict[str, Any] = {"Tags": [{"Key": MADE_BY_TAG[0], "Value": MADE_BY_TAG[1]}, {"Key": TEAM_TAG, "Value": team}]}
    if region != "us-east-1":  # us-east-1 refuses a LocationConstraint
        configuration["LocationConstraint"] = region
    try:
        s3.create_bucket(Bucket=bucket, CreateBucketConfiguration=configuration)
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code")
        if code == "BucketAlreadyExists":
            return None
        if code == "AccessDenied":
            return "denied"
        if code != "BucketAlreadyOwnedByYou":
            raise
        # Made a moment ago, by a run that got there first: its tags say
        # whose, and for which team.
        return _made_here(s3, bucket, team)
    return True


if __name__ == "__main__":
    sys.exit(main())
