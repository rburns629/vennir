#!/usr/bin/env python3
"""aws/ecs-express's "create" action: deploys a container image as an ECS
Express Mode service (AWS's counterpart to Cloud Run: Fargate tasks behind
a load balancer AWS makes and manages, at an HTTPS URL), or brings one it
made for this team to the inputs (a new image, environment, size: ECS rolls
the new configuration out, keeping its URL), and returns its URL once it
serves. Never builds an image.

What it deploys, and with what, is the team's choice, not the caller's: the
team secret ecs-express names the registry every image must be under and
the two roles a service runs with (the task execution role, which pulls the
image and writes its logs, and the infrastructure role, which makes its
load balancer and scaling). This product's role may pass only those. The
app itself gets no AWS role: it can call nothing in AWS.

The service runs in the region's default ECS cluster (made on first use)
and, unless subnets are given, the region's default VPC, internet-facing.
Waits until its deployment has finished and a task is running, and, for a
public one, until its health check path answers at its URL, so later steps
can use it. One it creates is tagged vennir-made=true and
vennir-team=<the run's team> and reported as a resource, which delete (its
cleanup) removes; one it only found is neither, unless an earlier attempt
made it for this team, and is changed only if this product made it for this
team: one that differs, made some other way, is refused.
Credentials as in the aws team's README.md: boto3's default chain (EKS Pod
Identity or IRSA) or, off EKS, its own role by web identity, optionally
assuming the aws-target role.
"""

import json
import re
import sys
import time
import urllib.error
import urllib.request
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
# Off EKS (GKE, AKS), with no default credentials: this product's own role,
# as EKS Pod Identity would bind it there, named by the team secret
# aws-ecs-express-role (key role-arn) and assumed by web identity with the
# step's own token (product.yaml's tokenAudiences). The role trusts this
# cluster's issuer for this product's ServiceAccount alone (the aws team's
# README.md, AWS from another cluster).
OWN_ROLE_FILE = Path("/platform/secrets/aws-ecs-express-role/role-arn")
TOKEN_FILE = Path("/platform/tokens/sts.amazonaws.com")
# The team's secret ecs-express: image-registry, execution-role-arn and
# infrastructure-role-arn.
SETTINGS_DIR = Path("/platform/secrets/ecs-express")
# Express services go in the region's default cluster; ECS makes it on the
# first create.
CLUSTER = "default"
# What marks a service this product made: delete removes no other.
MADE_BY_TAG = ("vennir-made", "true")
# And for which team (the request's forTeam, the team the run is for, not
# the one it runs in), so it's reported, and deleted, only for that team:
# another team's service, even one this product made, isn't theirs.
TEAM_TAG = "vennir-team"
SERVICE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$")
# What ECS says of a service, or the default cluster, that isn't there.
NOT_FOUND = {"ResourceNotFoundException", "ServiceNotFoundException", "ClusterNotFoundException"}
RETRYABLE_CODES = {
    # STS couldn't fetch the cluster's keys just then (off EKS).
    "IDPCommunicationError",
    "Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException",
    "ServiceUnavailable", "InternalError", "InternalFailure", "ServerException",
}
# How long a new service may take to serve before the step gives up (the
# step's timeoutSeconds must be longer).
START_TIMEOUT_SECONDS = 900
POLL_SECONDS = 15
# What a found service may change into: its subnets stay as it was made
# (moving it is deleting it and making it again), as does its
# infrastructure role (ECS keeps that for good).
SUBNETS = "subnets"
# After its deployment is done, the load balancer can answer 503 for a few
# seconds more (seen 2026-11-07): how long a public service gets to answer
# its health check path at its URL.
SERVE_TIMEOUT_SECONDS = 180


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
        message = details.get("Message", "")
        # IAM is eventually consistent: a role made a moment ago can't be
        # assumed yet (AWS's own guide says to retry after a minute).
        retryable = code in RETRYABLE_CODES or status >= 500 or "Unable to assume" in message
        return _failure("AWS_API_ERROR", f"{code}: {message}", retryable=retryable)
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


def _setting(key: str) -> str:
    path = SETTINGS_DIR / key
    return path.read_text().strip() if path.exists() else ""


def _service_arn(session: boto3.session.Session, region: str, name: str) -> str:
    """The ARN a service of this name has in the account it acts in (the
    aws-target role's, when there is one)."""
    caller = session.client("sts").get_caller_identity()
    partition = caller["Arn"].split(":")[1]
    return f"arn:{partition}:ecs:{region}:{caller['Account']}:service/{CLUSTER}/{name}"


def _describe(ecs: Any, arn: str) -> dict[str, Any] | None:
    try:
        return ecs.describe_express_gateway_service(serviceArn=arn, include=["TAGS"])["service"]
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in NOT_FOUND:
            return None
        raise


def _made_here(service: dict[str, Any], team: str) -> bool:
    """Whether the service carries this product's tags, for this team."""
    tags = {t.get("key"): t.get("value") for t in service.get("tags", [])}
    return tags.get(MADE_BY_TAG[0]) == MADE_BY_TAG[1] and tags.get(TEAM_TAG) == team


def _newest(service: dict[str, Any]) -> dict[str, Any]:
    """The configuration ECS last accepted: while a new one rolls out, both
    are active (ECS lists the newest first; createdAt says for sure)."""
    configurations = service.get("activeConfigurations", [])
    return max(configurations, key=lambda c: str(c.get("createdAt", "")), default={})


def _ingress(service: dict[str, Any]) -> tuple[str, str]:
    """The newest configuration's endpoint, and its access type (PUBLIC or
    PRIVATE)."""
    for path in _newest(service).get("ingressPaths", []):
        if path.get("endpoint"):
            return path["endpoint"], path.get("accessType", "")
    return "", ""


def _desired(inputs: dict[str, Any], environment: dict[str, str], execution_role: str) -> dict[str, Any]:
    """The configuration the inputs ask for, as ECS's create and update take
    it (and describe reports it)."""
    desired: dict[str, Any] = {
        "executionRoleArn": execution_role,
        "primaryContainer": {
            "image": inputs["image"],
            "containerPort": int(inputs.get("port", 8080)),
            "environment": [{"name": k, "value": v} for k, v in sorted(environment.items())],
        },
        "healthCheckPath": inputs.get("healthCheckPath", "/"),
        "cpu": inputs.get("cpu", "256"),
        "memory": inputs.get("memory", "512"),
        "scalingTarget": {"minTaskCount": 1, "maxTaskCount": int(inputs.get("maxTasks", 2))},
    }
    if inputs.get("subnets"):
        desired["networkConfiguration"] = {"subnets": list(inputs["subnets"])}
    return desired


def _changes(current: dict[str, Any], desired: dict[str, Any]) -> list[str]:
    """What the desired configuration changes in the current one."""
    have, want = current.get("primaryContainer", {}), desired["primaryContainer"]
    def env(container: dict[str, Any]) -> dict[str, str]:
        return {e.get("name"): e.get("value") for e in container.get("environment", [])}
    changes = [field for field in ("image", "containerPort") if have.get(field) != want[field]]
    if env(have) != env(want):
        changes.append("environment")
    changes += [field for field in ("healthCheckPath", "cpu", "memory", "executionRoleArn") if current.get(field) != desired[field]]
    if any(current.get("scalingTarget", {}).get(k) != v for k, v in desired["scalingTarget"].items()):
        changes.append("scalingTarget")
    if "networkConfiguration" in desired and sorted(
        current.get("networkConfiguration", {}).get("subnets", [])
    ) != sorted(desired["networkConfiguration"]["subnets"]):
        changes.append(SUBNETS)
    return changes


def _url(service: dict[str, Any]) -> str:
    return _ingress(service)[0]


def _answers(url: str) -> bool:
    """Whether the URL answers with anything but a server error: the load
    balancer's 503 while it has no healthy target, say."""
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return response.status < 500
    except urllib.error.HTTPError as error:
        return error.code < 500
    except (urllib.error.URLError, OSError):  # its name not resolving yet, say
        return False


def _rollout(ecs: Any, arn: str, name: str) -> tuple[str, int]:
    """The newest configuration's rollout state (IN_PROGRESS, COMPLETED or
    FAILED), and how many tasks are running. Its deployment is the primary
    one running its task definition; until ECS has made that (a moment
    after an update, when the last one is still primary and done), it's in
    progress."""
    target = _newest(_describe(ecs, arn) or {}).get("taskDefinitionArn", "")
    services = ecs.describe_services(cluster=CLUSTER, services=[name]).get("services", [])
    if not services:
        return "IN_PROGRESS", 0
    running = services[0].get("runningCount", 0)
    primary = next((d for d in services[0].get("deployments", []) if d.get("status") == "PRIMARY"), {})
    if target and primary.get("taskDefinition") != target:
        return "IN_PROGRESS", running
    return primary.get("rolloutState", "IN_PROGRESS"), running


def _outputs(service: dict[str, Any], region: str, made_here: bool) -> dict[str, Any]:
    outputs: dict[str, Any] = {"serviceArn": service["serviceArn"], "serviceUrl": _url(service)}
    if made_here:
        outputs["resources"] = [
            {
                "type": "aws/ecs-express-service",
                "id": service["serviceArn"],
                "name": service["serviceName"],
                "link": f"https://{region}.console.aws.amazon.com/ecs/v2/clusters/{CLUSTER}/services/{service['serviceName']}?region={region}",
            }
        ]
    return outputs


def main() -> int:
    request = json.loads(INPUT_PATH.read_text())
    inputs = request.get("inputs", {})
    name, image, region = inputs.get("serviceName"), inputs.get("image"), inputs.get("region")
    if not name or not image or not region:
        return _failure("MISSING_INPUT", "inputs.serviceName, inputs.image and inputs.region are required")
    if not SERVICE_NAME.match(name):
        return _failure("INVALID_INPUT", "inputs.serviceName is 3 to 64 letters, digits, hyphens or underscores")
    team = request.get("forTeam")
    if not team:
        return _failure("MISSING_TEAM", "request.json has no forTeam: run it for one of your teams")
    environment = inputs.get("environment") or {}
    if not all(isinstance(v, str) for v in environment.values()):
        return _failure("INVALID_INPUT", "inputs.environment values must be strings")
    registry = _setting("image-registry").rstrip("/")
    execution_role = _setting("execution-role-arn")
    infrastructure_role = _setting("infrastructure-role-arn")
    if not registry or not execution_role or not infrastructure_role:
        return _failure(
            "MISSING_SECRET",
            f"{SETTINGS_DIR} needs image-registry, execution-role-arn and infrastructure-role-arn: "
            "add the secret ecs-express for this team in the console (the aws team's README.md).",
        )
    if not image.startswith(registry + "/"):
        return _failure("IMAGE_OUTSIDE_REGISTRY", f"inputs.image must be under {registry}/, the registry this team deploys from.")

    try:
        session = _session(region)
        ecs = session.client("ecs")
        arn = _service_arn(session, region, name)
        service = _describe(ecs, arn)
        status = (service or {}).get("status", {}).get("statusCode")
        if status == "DRAINING":
            return _failure("SERVICE_DELETING", f"Service '{name}' is being deleted: run it again once it's gone.", retryable=True)
        desired = _desired(inputs, environment, execution_role)
        if service and status != "INACTIVE":
            # Waited for like a new one: a retry may find the service, or the
            # configuration, its last attempt was still rolling out.
            made_here = _made_here(service, team)
            current = _newest(service)
            changes = _changes(current, desired)
            if changes and not made_here:
                return _failure(
                    "SERVICE_EXISTS",
                    f"Service '{name}' exists, made some other way or for another team, and differs from these inputs "
                    f"({', '.join(changes)}): this product changes only services it made for this team. Choose another name.",
                )
            if SUBNETS in changes:
                return _failure(
                    "SUBNETS_CHANGED",
                    f"Service '{name}' keeps the subnets it was made in: to move it, delete it (its run's Delete) and create it again.",
                )
            if changes:
                update = {"serviceArn": service["serviceArn"], **desired}
                # Its autoscaling metric and target stay as they are.
                update["scalingTarget"] = {**current.get("scalingTarget", {}), **desired["scalingTarget"]}
                service = {**service, **ecs.update_express_gateway_service(**update)["service"]}
                print(f"updating service '{name}': {', '.join(changes)}")
            else:
                print(f"service '{name}' already exists as asked, leaving it as it is")
        else:
            service = ecs.create_express_gateway_service(
                serviceName=name,
                cluster=CLUSTER,
                infrastructureRoleArn=infrastructure_role,
                tags=[{"key": MADE_BY_TAG[0], "value": MADE_BY_TAG[1]}, {"key": TEAM_TAG, "value": team}],
                **desired,
            )["service"]
            made_here = True
            print(f"creating service '{name}'")

        # The service and its URL exist at once; it serves once its first
        # deployment has finished, and a new configuration once its own has
        # (until then the last one serves). Still rolling out is worth a
        # retry, which waits again; a failed rollout needs someone to look.
        deadline = time.monotonic() + START_TIMEOUT_SECONDS
        state, running = _rollout(ecs, arn, name)
        while state == "IN_PROGRESS" and time.monotonic() < deadline:
            time.sleep(POLL_SECONDS)
            state, running = _rollout(ecs, arn, name)
        if state != "COMPLETED" or running < 1:
            return _failure(
                "SERVICE_NOT_RUNNING",
                f"Service '{name}''s deployment is {state.lower()} with {running} task(s) running; "
                "see its events and logs in the ECS console.",
                retryable=state == "IN_PROGRESS",
            )
        service = _describe(ecs, arn) or service
    except (ClientError, BotoCoreError) as error:
        return _aws_failure(error)

    # A public one is asked as its callers will ask it. A private one can't
    # be reached from here: its finished deployment has to do.
    url, access = _ingress(service)
    if access == "PUBLIC":
        health = url.rstrip("/") + inputs.get("healthCheckPath", "/")
        deadline = time.monotonic() + SERVE_TIMEOUT_SECONDS
        while not _answers(health):
            if time.monotonic() >= deadline:
                return _failure("SERVICE_NOT_RUNNING", f"Service '{name}' is deployed but {health} doesn't answer yet.", retryable=True)
            time.sleep(POLL_SECONDS)

    print(f"service '{name}' is serving")
    _write_result({"status": "succeeded", "outputs": _outputs(service, region, made_here)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
