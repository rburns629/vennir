#!/usr/bin/env python3
"""aws/ecs-express's "check" action: whether it's ready on this install
(product.yaml's check). Changes nothing.

Run by the console with no inputs, as this product's identity. It looks for
the team's ecs-express secret (create can do nothing without it), signs in
the way create does (boto3's default chain: EKS Pod Identity or IRSA, or
off EKS its own role by web identity; then the aws-target role when the
team's secret is mounted), asks STS who it is, then describes a service
that doesn't exist, the first call create makes: "not found" means its
role may describe services, "denied" that it may not. It asks in the
cluster's own region (AWS_REGION), else the region of the team's registry
when that's an ECR one, else us-east-1, since create's region is per run.
The other actions in the aws team's README.md have no read-only form, so
only a create finds those out. Reports what's missing as what to grant.
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

OUTPUT_PATH = Path("/platform/output/result.json")

# product.yaml's serviceAccount: the Kubernetes identity bound to its IAM role.
SERVICE_ACCOUNT = "aws-ecs-express"
TARGET_ROLE_FILE = Path("/platform/secrets/aws-target/role-arn")
# Off EKS (GKE, AKS), with no default credentials: this product's own role,
# as EKS Pod Identity would bind it there, named by the team secret
# aws-ecs-express-role (key role-arn) and assumed by web identity with the
# step's own token (product.yaml's tokenAudiences). The role trusts this
# cluster's issuer for this product's ServiceAccount alone (the aws team's
# README.md, AWS from another cluster).
OWN_ROLE_FILE = Path("/platform/secrets/aws-ecs-express-role/role-arn")
TOKEN_FILE = Path("/platform/tokens/sts.amazonaws.com")
# The team's secret ecs-express, as create reads it.
SETTINGS_DIR = Path("/platform/secrets/ecs-express")
SETTINGS = ("image-registry", "execution-role-arn", "infrastructure-role-arn")
# What STS says when a role's trust doesn't take the token.
UNTRUSTED = {"InvalidIdentityToken", "IDPRejectedClaim"}
# Where it asks when neither the cluster nor the registry names a region.
FALLBACK_REGION = "us-east-1"
ECR_REGION = re.compile(r"^[0-9]{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(/|$)")
DENIED = {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation"}
# What ECS says of the service it asks about, which doesn't exist: it was
# allowed to ask.
NOT_FOUND = {"ResourceNotFoundException", "ServiceNotFoundException", "ClusterNotFoundException"}
# A name no create makes (service names start with a letter or digit).
PROBE_NAME = "vennir-readiness-check"


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


def _setting(key: str) -> str:
    path = SETTINGS_DIR / key
    return path.read_text().strip() if path.exists() else ""


def _region() -> str:
    """The cluster's region, else the team registry's (an ECR one names
    it), else FALLBACK_REGION."""
    region = boto3.session.Session().region_name
    if region:
        return region
    match = ECR_REGION.match(_setting("image-registry"))
    return match.group(1) if match else FALLBACK_REGION


def main() -> int:
    region = _region()
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
            caller = session.client("sts").get_caller_identity()
        except NoCredentialsError:
            return _answer(False, no_identity,
                           [f"an IAM role for ServiceAccount {SERVICE_ACCOUNT} (an EKS Pod Identity association, or IRSA; off EKS, its {SERVICE_ACCOUNT}-role secret)"],
                           "No AWS credentials: this step's ServiceAccount isn't bound to an IAM role.")
        except ClientError as error:  # IRSA's role refused it, say
            details = error.response.get("Error", {})
            return _answer(False, no_identity,
                           [f"an IAM role for ServiceAccount {SERVICE_ACCOUNT} whose trust policy lets it in"],
                           f"Couldn't sign in: {_code(error)}: {details.get('Message', '')[:300]}")
        principal, account = caller["Arn"], caller["Account"]

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
            account = principal.split(":")[4]
            keys = credentials["Credentials"]
            session = boto3.session.Session(
                aws_access_key_id=keys["AccessKeyId"],
                aws_secret_access_key=keys["SecretAccessKey"],
                aws_session_token=keys["SessionToken"],
                region_name=region,
            )

        missing: list[str] = []
        if not all(_setting(key) for key in SETTINGS):
            missing.append("the team secret ecs-express, with image-registry, execution-role-arn and infrastructure-role-arn")
        partition = principal.split(":")[1]
        try:
            session.client("ecs").describe_express_gateway_service(
                serviceArn=f"arn:{partition}:ecs:{region}:{account}:service/default/{PROBE_NAME}"
            )
        except ClientError as error:
            if _code(error) in DENIED:
                missing.append(f"ecs:DescribeExpressGatewayService (and the README's other ECS actions) for {_role(principal)}")
            elif _code(error) not in NOT_FOUND:
                raise
    except ClientError as error:
        details = error.response.get("Error", {})
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        return _failure("AWS_API_ERROR", f"{_code(error)}: {details.get('Message', '')}", retryable=status >= 500 or status == 429)
    except BotoCoreError as error:  # a connection problem: no answer
        return _failure("AWS_API_ERROR", str(error), retryable=True)

    if missing:
        return _answer(False, principal, missing, f"It can sign in, but isn't ready to deploy to ECS in {region}.")
    return _answer(True, principal, [], f"It may describe ECS Express services in {region}, and the team chose its registry and roles.")


if __name__ == "__main__":
    sys.exit(main())
