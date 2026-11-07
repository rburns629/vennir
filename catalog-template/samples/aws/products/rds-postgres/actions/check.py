#!/usr/bin/env python3
"""aws/rds-postgres's "check" action: whether it's ready on this install
(product.yaml's check). Changes nothing.

Run by the console with no inputs, as this product's identity. It signs in
the way create does (boto3's default chain: EKS Pod Identity or IRSA, or
off EKS its own role by web identity; then the aws-target role when the
team's secret is mounted), asks STS who it is,
then makes the read-only calls its role must allow: describing DB instances
(one page), the first call create makes, and describing the Secrets Manager
key the managed password is encrypted with. create's region is per run, so
it asks in the cluster's own region (AWS_REGION), or us-east-1. The other
actions in the aws team's README.md have no read-only form, so only a
create finds those out. Reports what's missing as what to grant its role.
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
SERVICE_ACCOUNT = "aws-rds-postgres"
TARGET_ROLE_FILE = Path("/platform/secrets/aws-target/role-arn")
# Off EKS (GKE, AKS), with no default credentials: this product's own role,
# as EKS Pod Identity would bind it there, named by the team secret
# aws-rds-postgres-role (key role-arn) and assumed by web identity with the step's
# own token (product.yaml's tokenAudiences). The role trusts this cluster's
# issuer for this product's ServiceAccount alone (the aws team's README.md,
# AWS from another cluster).
OWN_ROLE_FILE = Path("/platform/secrets/aws-rds-postgres-role/role-arn")
TOKEN_FILE = Path("/platform/tokens/sts.amazonaws.com")
# What STS says when a role's trust doesn't take the token.
UNTRUSTED = {"InvalidIdentityToken", "IDPRejectedClaim"}
# Where it asks when the cluster names no region.
FALLBACK_REGION = "us-east-1"
DENIED = {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation"}
# The AWS managed key RDS keeps the master password's secret under.
PASSWORD_KEY = "alias/aws/secretsmanager"


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
    try:
        session = boto3.session.Session(region_name=region)
        if session.get_credentials() is None and OWN_ROLE_FILE.exists() and TOKEN_FILE.exists():
            # Off EKS: its own role by web identity, unsigned (the token is the proof).
            own = OWN_ROLE_FILE.read_text().strip()
            try:
                assumed = session.client("sts", config=Config(signature_version=UNSIGNED)).assume_role_with_web_identity(
                    RoleArn=own, RoleSessionName="vennir-check", WebIdentityToken=TOKEN_FILE.read_text().strip()
                )
            except ClientError as error:
                if _code(error) not in DENIED | UNTRUSTED:
                    raise
                return _answer(False, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, by web identity",
                               [f"{own}'s trust policy letting this cluster's issuer in for ServiceAccount {SERVICE_ACCOUNT} "
                                "(sts:AssumeRoleWithWebIdentity, audience sts.amazonaws.com), from an IAM OIDC provider for the issuer"],
                               f"Couldn't act as its own role ({SERVICE_ACCOUNT}-role) by web identity: {_code(error)}.")
            credentials = assumed["Credentials"]
            session = boto3.session.Session(
                aws_access_key_id=credentials["AccessKeyId"],
                aws_secret_access_key=credentials["SecretAccessKey"],
                aws_session_token=credentials["SessionToken"],
                region_name=region,
            )
        try:
            principal = session.client("sts").get_caller_identity()["Arn"]
        except NoCredentialsError:
            return _answer(False, no_identity,
                           [f"an IAM role for ServiceAccount {SERVICE_ACCOUNT} (an EKS Pod Identity association, or IRSA; off EKS, its {SERVICE_ACCOUNT}-role secret)"],
                           "No AWS credentials: this step's ServiceAccount isn't bound to an IAM role.")
        except ClientError as error:  # IRSA's role refused it, say
            details = error.response.get("Error", {})
            return _answer(False, no_identity,
                           [f"an IAM role for ServiceAccount {SERVICE_ACCOUNT} whose trust policy lets it in"],
                           f"Couldn't sign in: {_code(error)}: {details.get('Message', '')[:300]}")

        target = TARGET_ROLE_FILE.read_text().strip() if TARGET_ROLE_FILE.exists() else ""
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
            keys = credentials["Credentials"]
            session = boto3.session.Session(
                aws_access_key_id=keys["AccessKeyId"],
                aws_secret_access_key=keys["SecretAccessKey"],
                aws_session_token=keys["SessionToken"],
                region_name=region,
            )

        missing: list[str] = []
        try:
            session.client("rds").describe_db_instances(MaxRecords=20)
        except ClientError as error:
            if _code(error) not in DENIED:
                raise
            missing.append(f"rds:DescribeDBInstances (and the README's other RDS actions) for {_role(principal)}")
        try:
            session.client("kms").describe_key(KeyId=PASSWORD_KEY)
        except ClientError as error:
            # NotFoundException: the account has no such key yet; RDS makes it.
            if _code(error) in DENIED:
                missing.append(f"kms:DescribeKey for {_role(principal)}, for the managed password's key")
            elif _code(error) != "NotFoundException":
                raise
    except ClientError as error:
        details = error.response.get("Error", {})
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        return _failure("AWS_API_ERROR", f"{_code(error)}: {details.get('Message', '')}", retryable=status >= 500 or status == 429)
    except BotoCoreError as error:  # a connection problem: no answer
        return _failure("AWS_API_ERROR", str(error), retryable=True)

    if missing:
        return _answer(False, principal, missing, f"It can sign in, but may not yet make databases in {region}.")
    return _answer(True, principal, [], f"It may describe RDS instances and the password's key in {region}.")


if __name__ == "__main__":
    sys.exit(main())
