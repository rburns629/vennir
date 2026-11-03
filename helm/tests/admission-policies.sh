#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Proves the charts' admission policies on a real cluster: dispatch (team
# namespaces only), image sources, step identity (kernel chart) and the
# console's write fence and its Jobs (console chart). Every case is a server-side dry run,
# so nothing is created, made as the identity the policy guards (impersonated).
#
# Renders the policies under their own release name, "policytest", so they
# only ever match that release's (impersonated) identities: a Vertra
# install on the same cluster is unaffected. Removes everything it added.
#
#   bash helm/tests/admission-policies.sh            # kubectl's current context
#   KUBE_CONTEXT=kind-vertra-local bash helm/tests/admission-policies.sh
#
# Needs kubectl, helm, python3, and a cluster with ValidatingAdmissionPolicy
# (Kubernetes 1.30+) where you may impersonate ServiceAccounts.
set -uo pipefail
cd "$(dirname "$0")/../.."

CONTEXT_ARGS=()
[ -n "${KUBE_CONTEXT:-}" ] && CONTEXT_ARGS=(--context "$KUBE_CONTEXT")
# ${a[@]+...}: an empty array is "unbound" to bash 3.2 (macOS) under set -u.
k() { kubectl ${CONTEXT_ARGS[@]+"${CONTEXT_ARGS[@]}"} "$@"; }

RELEASE=policytest
PLATFORM_NS=$RELEASE-system
TEAM_A=$RELEASE-team-a
TEAM_B=$RELEASE-team-b
OTHER_NS=$RELEASE-other
RETIRED_NS=$RELEASE-retired
SCHEDULER=system:serviceaccount:$PLATFORM_NS:$RELEASE-execution-kernel
CONSOLE=system:serviceaccount:$PLATFORM_NS:$RELEASE-execution-console
SOURCE=registry.example
PRODUCTS='[{"team":"'$TEAM_A'","repository":"registry.example/db","action":"create","serviceAccount":"db-sa"},{"team":"","repository":"registry.example/platform","action":"run","serviceAccount":"plat-sa"}]'
TEAM_SECRETS='{"'$TEAM_A'":"api-token,db-key","'$TEAM_B'":"b-key"}'
FAILURES=0

render() {
  {
    helm template "$RELEASE" helm/charts/execution-kernel -n "$PLATFORM_NS" \
      --set imagePolicy.sourceRegistry=$SOURCE \
      --show-only templates/dispatch-policy.yaml \
      --show-only templates/image-policy.yaml \
      --show-only templates/identity-policy.yaml \
      --set scanPolicy.requireDigest=false --show-only templates/scan-policy.yaml
    echo "---"
    # The console as the purger, as on kind and GKE.
    helm template "$RELEASE" helm/charts/execution-kernel -n "$PLATFORM_NS" \
      --set 'purgePolicy.purgers[0].kind=ServiceAccount' \
      --set "purgePolicy.purgers[0].name=$RELEASE-execution-console" \
      --set "purgePolicy.purgers[0].namespace=$PLATFORM_NS" \
      --show-only templates/purge-policy.yaml
    echo "---"
    helm template "$RELEASE" helm/charts/execution-console -n "$PLATFORM_NS" \
      --set kernelApiUrl=http://unused \
      --set teamNamespaces.schedulerLogs.clusterRole=$RELEASE-execution-kernel-scheduler-logs \
      --set teamNamespaces.schedulerLogs.serviceAccount=$PLATFORM_NS/$RELEASE-execution-kernel \
      --set scanning.image.repository=example.com/trivy --set scanning.image.tag=1 --set scanning.image.digest= \
      --set registryCheck.pullSecretName=pull-secret \
      --show-only templates/write-fence-policy.yaml \
      --show-only templates/namespace-policy.yaml \
      --show-only templates/console-jobs-policy.yaml
  }
}

cleanup() {
  render | k delete -f - --ignore-not-found > /dev/null 2>&1
  k delete clusterrolebinding,clusterrole $RELEASE-dry-run --ignore-not-found > /dev/null 2>&1
  k delete namespace "$PLATFORM_NS" "$TEAM_A" "$TEAM_B" "$OTHER_NS" "$RETIRED_NS" --ignore-not-found --wait=false > /dev/null 2>&1
}
trap cleanup EXIT

echo "Setting up on $(k config current-context)"
# A previous run's namespaces may still be terminating; creating them again
# would fail until they're gone.
for _ in $(seq 1 90); do
  k get namespaces --field-selector status.phase=Terminating -o name | grep -q "namespace/$RELEASE-" || break
  sleep 2
done
for ns in "$PLATFORM_NS" "$TEAM_A" "$TEAM_B" "$OTHER_NS" "$RETIRED_NS"; do
  k create namespace "$ns" --dry-run=client -o yaml | k apply -f - > /dev/null
done
k label namespace "$TEAM_A" "$TEAM_B" vertra/team=true --overwrite > /dev/null
k label namespace "$RETIRED_NS" vertra/team=retired --overwrite > /dev/null
for sa in eso-gcp db-sa; do
  k -n "$TEAM_A" create serviceaccount "$sa" --dry-run=client -o yaml | k apply -f - > /dev/null
done

# RBAC comes before admission, so the impersonated identities need leave to
# create what the cases try to create.
k apply -f - > /dev/null <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: $RELEASE-dry-run}
rules:
  - {apiGroups: [batch], resources: [jobs], verbs: [create]}
  - {apiGroups: [""], resources: [secrets, configmaps], verbs: [create]}
  - {apiGroups: [""], resources: [namespaces], verbs: [get, create, update, patch]}
  - {apiGroups: [""], resources: [serviceaccounts], verbs: [get, update, patch]}
  - {apiGroups: [rbac.authorization.k8s.io], resources: [rolebindings, roles], verbs: [create]}
  - {apiGroups: [rbac.authorization.k8s.io], resources: [clusterroles], verbs: [bind]}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: {name: $RELEASE-dry-run}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: $RELEASE-dry-run}
subjects:
  - {kind: ServiceAccount, name: $RELEASE-execution-kernel, namespace: $PLATFORM_NS}
  - {kind: ServiceAccount, name: $RELEASE-execution-console, namespace: $PLATFORM_NS}
EOF

render | k apply -f - > /dev/null
# The console keeps the identity policy's products and team secrets
# current; here, fixed ones.
k get validatingadmissionpolicy $RELEASE-execution-kernel-identity -o json \
  | python3 -c '
import json, sys
policy = json.load(sys.stdin)
literals = {"products": sys.argv[1], "teamSecrets": sys.argv[2]}
for variable in policy["spec"]["variables"]:
    if variable["name"] in literals:
        variable["expression"] = literals[variable["name"]]
print(json.dumps(policy))' "$PRODUCTS" "$TEAM_SECRETS" \
  | k replace -f - > /dev/null
# And the scan policy's failed digests.
BLOCKED_DIGEST=sha256:$(printf 'b%.0s' $(seq 64))
k get validatingadmissionpolicy $RELEASE-execution-kernel-scan -o json \
  | python3 -c '
import json, sys
policy = json.load(sys.stdin)
for variable in policy["spec"]["variables"]:
    if variable["name"] == "blockedDigests":
        variable["expression"] = json.dumps([sys.argv[1]])
print(json.dumps(policy))' "$BLOCKED_DIGEST" \
  | k replace -f - > /dev/null

# A Job as the console makes an image scan (console/src/k8s.ts), with one
# change made by the python expression given (to s, the Pod spec).
console_job() {  # change, namespace (the platform's)
  python3 - "$1" "$RELEASE-execution-console-scanner" <<'PY' | as_console -n "${2:-$PLATFORM_NS}" create -f -
import json, sys
s = {"restartPolicy": "Never", "serviceAccountName": sys.argv[2], "automountServiceAccountToken": False,
     "securityContext": {"runAsNonRoot": True, "runAsUser": 65532},
     "containers": [{"name": "trivy", "image": "example.com/trivy:1", "args": ["image", "x"],
                     "env": [{"name": "HOME", "value": "/tmp"}],
                     "securityContext": {"allowPrivilegeEscalation": False, "capabilities": {"drop": ["ALL"]}},
                     "volumeMounts": [{"name": "tmp", "mountPath": "/tmp"}]}],
     "volumes": [{"name": "tmp", "emptyDir": {}}, {"name": "docker-config", "secret": {"secretName": "pull-secret"}}]}
c = s["containers"][0]
exec(sys.argv[1])
print(json.dumps({"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": "policy-check"},
                  "spec": {"template": {"spec": s}}}))
PY
}

# Hardened as the executor makes a step's Job (scheduler.taskPodHardening),
# unless the seventh argument is "unhardened" (neither), or "own" (the
# container's securityContext is the sixth argument's).
job() {  # namespace, image, action, serviceAccount, secret ("" for none), extra container JSON, hardening
  local volumes='{"name":"x","emptyDir":{}}' mounts=""
  local pod=',"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true}'
  local container=',"securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}}'
  if [ "${7:-}" = unhardened ]; then pod="" container=""; fi
  if [ "${7:-}" = own ]; then container=""; fi
  if [ -n "$5" ]; then
    volumes+=',{"name":"s","secret":{"secretName":"'$5'"}}'
    mounts=',"volumeMounts":[{"name":"s","mountPath":"/platform/secrets/'$5'"}]'
  fi
  k --as="$SCHEDULER" -n "$1" create --dry-run=server -f - 2>&1 <<EOF
{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"policy-check"},
 "spec":{"template":{"spec":{"restartPolicy":"Never","serviceAccountName":"$4"$pod,
   "containers":[{"name":"product","image":"$2","args":["$3"]$mounts$container${6:-}}],
   "volumes":[$volumes]}}}}
EOF
}

as_console() { k --as="$CONSOLE" "$@" --dry-run=server 2>&1; }
new_namespace() {  # name, labels as JSON
  echo '{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"'"$1"'","labels":'"$2"'}}' | as_console create -f -
}

secret() {  # namespace
  k --as="$CONSOLE" -n "$1" create secret generic policy-check --from-literal=a=b --dry-run=server 2>&1
}

expect() {  # label, "allowed" | text the refusal must contain, output
  local allowed=no passed=no
  echo "$3" | grep -q "(server dry run)" && allowed=yes
  if [ "$2" = allowed ]; then
    [ "$allowed" = yes ] && passed=yes
  elif [ "$allowed" = no ] && echo "$3" | grep -q -- "$2"; then
    passed=yes
  fi
  if [ "$passed" = yes ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  FAIL  %s\n        expected %s, got: %s\n' "$1" "$2" "$(echo "$3" | tr '\n' ' ' | sed 's/.*denied request: //' | cut -c1-200)"
    FAILURES=$((FAILURES + 1))
  fi
}

# Policies take a few seconds to reach the API server's admission chain.
for _ in $(seq 1 30); do
  job "$OTHER_NS" $SOURCE/app:1 run default "" | grep -q "not a Vertra team namespace" && break
  sleep 1
done

echo "Dispatch:"
expect "a team namespace"                     allowed                        "$(job "$TEAM_A" $SOURCE/app:1 run default "")"
expect "a namespace without the team label"   "not a Vertra team namespace" "$(job "$OTHER_NS" $SOURCE/app:1 run default "")"
expect "the platform's own namespace"         "not a Vertra team namespace" "$(job "$PLATFORM_NS" $SOURCE/app:1 run default "")"
expect "a Job not hardened"                   "must run hardened"           "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" unhardened)"
expect "a Job that adds a capability"         "must run hardened"           "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"],"add":["NET_ADMIN"]}}' own)"

echo "Image sources:"
expect "an image from another registry"       IMAGE_NOT_ALLOWED              "$(job "$TEAM_A" busybox:1.36 run default "")"

echo "Step identity:"
expect "a product, as its SA, with its secret"   allowed               "$(job "$TEAM_A" $SOURCE/db:1 create db-sa db-key)"
expect "the same, pinned by digest"              allowed               "$(job "$TEAM_A" $SOURCE/db@sha256:$(printf '0%.0s' $(seq 64)) create db-sa db-key)"
expect "the same, tagged and pinned (as submitted)" allowed            "$(job "$TEAM_A" $SOURCE/db:1@sha256:$(printf '0%.0s' $(seq 64)) create db-sa db-key)"
expect "any other secret of its team"           allowed               "$(job "$TEAM_A" $SOURCE/db:1 create db-sa api-token)"
expect "a Secret its team never registered"      IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/db:1 create db-sa eso-auth)"
expect "a platform product, its team's secret"   allowed               "$(job "$TEAM_B" $SOURCE/platform:2 run plat-sa b-key)"
expect "a platform product, another team's"      IDENTITY_NOT_ALLOWED  "$(job "$TEAM_B" $SOURCE/platform:2 run plat-sa db-key)"
expect "the product's image, another action"     IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/db:1 delete db-sa "")"
expect "a team's product in another team"        IDENTITY_NOT_ALLOWED  "$(job "$TEAM_B" $SOURCE/db:1 create db-sa "")"
expect "a platform product in any team"          allowed               "$(job "$TEAM_B" $SOURCE/platform:2 run plat-sa "")"
expect "an unregistered image as a product's SA" IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/app:1 run db-sa "")"
expect "default with a secret"                   IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/app:1 run default db-key)"
expect "a secret through env, not a volume"      IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"env":[{"name":"K","valueFrom":{"secretKeyRef":{"name":"db-key","key":"k"}}}]')"

echo "Image scans:"
expect "an image whose scan failed"              IMAGE_SCAN_FAILED     "$(job "$TEAM_A" $SOURCE/app:1@$BLOCKED_DIGEST run default "")"
expect "the same repository, another digest"     allowed               "$(job "$TEAM_A" $SOURCE/app:1@sha256:$(printf 'c%.0s' $(seq 64)) run default "")"

echo "Console write fence:"
expect "a Secret in a team namespace"            allowed                     "$(secret "$TEAM_A")"
expect "a Secret in kube-system"                 "may only write in team"    "$(secret kube-system)"
expect "a Secret in the platform's namespace"    "may only write in team"    "$(secret "$PLATFORM_NS")"

echo "Console namespaces:"
expect "create one labelled a team's"            allowed                      "$(new_namespace $RELEASE-new '{"vertra/team":"true"}')"
expect "create one without the label"            "only create a namespace"    "$(new_namespace $RELEASE-plain '{}')"
expect "create a kube-* one"                     "protected"                  "$(new_namespace kube-$RELEASE '{"vertra/team":"true"}')"
expect "retire a team's"                         allowed                      "$(as_console label namespace "$TEAM_A" vertra/team=retired --overwrite)"
expect "label a namespace that isn't a team's"   "isn't a team's"             "$(as_console label namespace "$OTHER_NS" vertra/team=true)"
expect "label the platform's own"                "protected"                  "$(as_console label namespace "$PLATFORM_NS" vertra/team=true)"
expect "a label value other than true/retired"   "isn't a team's"             "$(as_console label namespace "$TEAM_A" vertra/team=yes --overwrite)"
expect "change another label too"                "isn't a team's"             "$(as_console label namespace "$TEAM_A" other=1)"
expect "change an annotation"                    "isn't a team's"             "$(as_console annotate namespace "$TEAM_A" note=1)"

echo "Console purging:"
expect "a retired team namespace"                allowed                      "$(as_console delete namespace "$RETIRED_NS")"
expect "an active team namespace"                "can't be purged"            "$(as_console delete namespace "$TEAM_A")"
expect "kube-system (Kubernetes itself refuses)" "forbidden"                  "$(as_console delete namespace kube-system)"

echo "Console ServiceAccounts:"
expect "update ESO's (eso-*)"                    allowed                      "$(as_console -n "$TEAM_A" annotate serviceaccount eso-gcp iam.gke.io/gcp-service-account=x)"
expect "update a product's"                      "only update the ServiceAccounts ESO" "$(as_console -n "$TEAM_A" annotate serviceaccount db-sa iam.gke.io/gcp-service-account=x)"

echo "Console Jobs (image scans and catalog verifications):"
expect "a scan as the console makes it"          allowed                   "$(console_job 'pass')"
expect "as another ServiceAccount"               "runs as"                 "$(console_job 's["serviceAccountName"] = "'"$RELEASE"'-execution-kernel"')"
expect "with a Kubernetes token"                 "runs as"                 "$(console_job 's["automountServiceAccountToken"] = True')"
expect "another image"                           "scanner or verifier image" "$(console_job 'c["image"] = "busybox"')"
expect "an init container"                       "scanner or verifier image" "$(console_job 's["initContainers"] = [dict(c, name="init")]')"
expect "another Secret"                          "only scratch space"      "$(console_job 's["volumes"].append({"name": "db", "secret": {"secretName": "'"$RELEASE"'-execution-kernel-db"}})')"
expect "the node's filesystem"                   "only scratch space"      "$(console_job 's["volumes"].append({"name": "root", "hostPath": {"path": "/"}})')"
expect "privileged"                              "unprivileged"            "$(console_job 'c["securityContext"] = {"privileged": True, "allowPrivilegeEscalation": True}')"
expect "as root"                                 "unprivileged"            "$(console_job 's["securityContext"] = {"runAsUser": 0}')"
expect "the host's network"                      "unprivileged"            "$(console_job 's["hostNetwork"] = True')"
expect "a Secret in its environment"             "no Secret or ConfigMap"  "$(console_job 'c["env"].append({"name": "P", "valueFrom": {"secretKeyRef": {"name": "x", "key": "y"}}})')"
expect "in a team namespace"                     "platform's namespace"    "$(console_job 'pass' "$TEAM_A")"

echo "Console RBAC (the scheduler's log reading, per team namespace):"
LOGS_ROLE=$RELEASE-execution-kernel-scheduler-logs
SCHED_SA=$PLATFORM_NS:$RELEASE-execution-kernel
binding() {  # namespace, name, clusterrole, extra arguments
  local ns=$1 name=$2 role=$3; shift 3
  as_console -n "$ns" create rolebinding "$name" --clusterrole="$role" --serviceaccount="$SCHED_SA" "$@"
}
expect "the scheduler's logs binding"            allowed                "$(binding "$TEAM_A" vertra-scheduler-logs "$LOGS_ROLE")"
expect "another ClusterRole"                     "only RBAC write"      "$(binding "$TEAM_A" vertra-scheduler-logs cluster-admin)"
expect "another subject too"                     "only RBAC write"      "$(binding "$TEAM_A" vertra-scheduler-logs "$LOGS_ROLE" --serviceaccount="$TEAM_A:db-sa")"
expect "another name"                            "only RBAC write"      "$(binding "$TEAM_A" anything "$LOGS_ROLE")"
expect "in kube-system"                          "may only write in team" "$(binding kube-system vertra-scheduler-logs "$LOGS_ROLE")"
# (RBAC's own escalation check, or the fence: refused either way.)
expect "a Role"                                  "forbidden"            "$(as_console -n "$TEAM_A" create role r --verb=get --resource=pods )"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES case(s) failed"
  exit 1
fi
echo "All cases passed."
