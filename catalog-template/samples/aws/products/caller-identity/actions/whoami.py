#!/usr/bin/env python3
"""aws/caller-identity's "whoami" action: signs in to AWS as a role with
this step's own Kubernetes identity, and says who AWS says it is.

The kernel mounts an hour-long ServiceAccount token for sts.amazonaws.com
(product.yaml's tokenAudiences) at /platform/tokens/sts.amazonaws.com,
signed by the cluster's OIDC issuer for this product's ServiceAccount. STS's
AssumeRoleWithWebIdentity takes it, unsigned: no key, no secret, nothing
stored. AWS checks the token against the IAM OIDC identity provider made for
the cluster's issuer, and the role's trust policy against its sub and aud.

The credentials it gets are used once, to ask who they are, and never
written anywhere: a step's outputs are readable by anyone who can see the
run.
"""

import json
import sys
from pathlib import Path
from typing import Any

import boto3
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")
TOKEN_PATH = Path("/platform/tokens/sts.amazonaws.com")
DEFAULT_REGION = "us-east-1"


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result({"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}})
    return 1


def _code(error: ClientError) -> str:
    return error.response.get("Error", {}).get("Code", "Unknown")


def main() -> int:
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})
    role = inputs["roleArn"]
    region = inputs.get("region") or DEFAULT_REGION
    if not TOKEN_PATH.exists():
        return _failure("NO_TOKEN", f"No token at {TOKEN_PATH}: this step wasn't given one for sts.amazonaws.com.")
    token = TOKEN_PATH.read_text().strip()

    try:
        # AssumeRoleWithWebIdentity is called without AWS credentials: the token is the proof.
        sts = boto3.client("sts", region_name=region, config=Config(signature_version=UNSIGNED))
        session = sts.assume_role_with_web_identity(RoleArn=role, RoleSessionName="vennir-caller-identity", WebIdentityToken=token)
        credentials = session["Credentials"]
        who = boto3.client(
            "sts",
            region_name=region,
            aws_access_key_id=credentials["AccessKeyId"],
            aws_secret_access_key=credentials["SecretAccessKey"],
            aws_session_token=credentials["SessionToken"],
        ).get_caller_identity()
    except ClientError as error:
        code = _code(error)
        message = error.response.get("Error", {}).get("Message", "")[:500]
        if code in ("InvalidIdentityToken", "IDPRejectedClaim"):
            return _failure("TOKEN_NOT_TRUSTED", f"{code}: {message}")
        if code == "AccessDenied":
            return _failure("ROLE_NOT_ALLOWED", f"{role} doesn't let this ServiceAccount in: {message}")
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        # IDPCommunicationError: AWS couldn't reach the issuer's keys just then.
        retry = code == "IDPCommunicationError" or status >= 500 or status == 429
        return _failure("AWS_API_ERROR", f"{code}: {message}", retryable=retry)
    except BotoCoreError as error:  # no answer at all
        return _failure("AWS_API_ERROR", str(error), retryable=True)

    expires = credentials.get("Expiration")
    outputs = {"account": who["Account"], "arn": who["Arn"]}
    if expires is not None:
        outputs["expiresAt"] = expires.isoformat() if hasattr(expires, "isoformat") else str(expires)
    _write_result({"status": "succeeded", "outputs": outputs})
    return 0


if __name__ == "__main__":
    sys.exit(main())
