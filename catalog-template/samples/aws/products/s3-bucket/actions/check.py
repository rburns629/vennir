#!/usr/bin/env python3
"""aws/s3-bucket's "check" action: whether it's ready on this install
(product.yaml's check). Changes nothing.

Run by the console with no inputs, as this product's identity. It signs in
the way create does (boto3's default chain: EKS Pod Identity or IRSA, then
the aws-target role when the team's secret is mounted; off EKS, with no
default credentials, that role by web identity with its own token) and asks
STS who it is. That's all it can honestly find out: its role's S3 actions are granted
on the bucket names it may use (arn:aws:s3:::<prefix>*, the aws team's
README.md), and with no bucket named there's nothing to ask S3 about, so
only a create finds those out (and says so). Ready means it can sign in.
"""

import json
import sys
from pathlib import Path
from typing import Any

import boto3
from botocore import UNSIGNED
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

OUTPUT_PATH = Path("/platform/output/result.json")

# product.yaml's serviceAccount: the Kubernetes identity bound to its IAM role.
SERVICE_ACCOUNT = "aws-s3-bucket"
TARGET_ROLE_FILE = Path("/platform/secrets/aws-target/role-arn")
# Off EKS: its own token for AWS's STS (product.yaml's tokenAudiences).
TOKEN_FILE = Path("/platform/tokens/sts.amazonaws.com")
# What STS says when the aws-target role's trust doesn't take the token.
UNTRUSTED = {"InvalidIdentityToken", "IDPRejectedClaim"}
# Where it asks when the cluster names no region.
FALLBACK_REGION = "us-east-1"
DENIED = {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation"}


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


def _code(error: ClientError) -> str:
    return error.response.get("Error", {}).get("Code", "Unknown")


def _role(arn: str) -> str:
    """The role an assumed-role ARN is a session of, else the ARN itself."""
    parts = arn.split(":", 5)[-1].split("/")
    return f"role {parts[1]}" if parts[0] == "assumed-role" and len(parts) > 1 else arn


def main() -> int:
    region = boto3.session.Session().region_name or FALLBACK_REGION
    no_identity = f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, with no AWS identity"
    ready = (
        "It can sign in. Its S3 actions are granted on the bucket names it may use, "
        "so each create finds out whether it may use the one it's given."
    )
    try:
        session = boto3.session.Session(region_name=region)
        target = TARGET_ROLE_FILE.read_text().strip() if TARGET_ROLE_FILE.exists() else ""
        if session.get_credentials() is None and target and TOKEN_FILE.exists():
            # Off EKS: aws-target by web identity, unsigned (the token is the proof).
            try:
                credentials = session.client("sts", config=Config(signature_version=UNSIGNED)).assume_role_with_web_identity(
                    RoleArn=target, RoleSessionName="vennir-check", WebIdentityToken=TOKEN_FILE.read_text().strip()
                )
            except ClientError as error:
                if _code(error) not in DENIED | UNTRUSTED:
                    raise
                return _answer(False, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, by web identity",
                               [f"{target}'s trust policy letting this cluster's issuer in for ServiceAccount {SERVICE_ACCOUNT} "
                                "(sts:AssumeRoleWithWebIdentity, audience sts.amazonaws.com), from an IAM OIDC provider for the issuer"],
                               f"Couldn't act as the aws-target role by web identity: {_code(error)}.")
            return _answer(True, credentials["AssumedRoleUser"]["Arn"], [], ready)
        try:
            principal = session.client("sts").get_caller_identity()["Arn"]
        except NoCredentialsError:
            return _answer(False, no_identity,
                           [f"an IAM role for ServiceAccount {SERVICE_ACCOUNT} (an EKS Pod Identity association, or IRSA)"],
                           "No AWS credentials: this step's ServiceAccount isn't bound to an IAM role.")
        except ClientError as error:  # IRSA's role refused it, say
            details = error.response.get("Error", {})
            return _answer(False, no_identity,
                           [f"an IAM role for ServiceAccount {SERVICE_ACCOUNT} whose trust policy lets it in"],
                           f"Couldn't sign in: {_code(error)}: {details.get('Message', '')[:300]}")

        if target:
            try:
                credentials = session.client("sts").assume_role(
                    RoleArn=target, RoleSessionName="vennir-check"
                )
            except ClientError as error:
                if _code(error) not in DENIED:
                    raise
                return _answer(False, principal,
                               [f"sts:AssumeRole on {target} for {_role(principal)}, allowed by {target}'s trust policy"],
                               "It can sign in, but can't act as the aws-target role.")
            principal = credentials["AssumedRoleUser"]["Arn"]
    except ClientError as error:
        details = error.response.get("Error", {})
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        return _failure("AWS_API_ERROR", f"{_code(error)}: {details.get('Message', '')}", retryable=status >= 500 or status == 429)
    except BotoCoreError as error:  # a connection problem: no answer
        return _failure("AWS_API_ERROR", str(error), retryable=True)

    return _answer(True, principal, [], ready)


if __name__ == "__main__":
    sys.exit(main())
