#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Proves the charts' admission policies on a real cluster: dispatch (team
# namespaces only), image sources, step identity, scans and purging (kernel
# chart), and the console's write fence, its namespaces, its Jobs and the
# gateway's tokens (console chart). Every case is a server-side dry run, so
# nothing is created, made as the identity the policy guards (impersonated).
# What a case deletes or replaces is made first, for real, in the scratch
# namespaces.
#
# Renders the policies under their own release name, "policytest", so they
# only ever match that release's (impersonated) identities: a Vertra
# install on the same cluster is unaffected. Removes everything it added.
#
#   bash helm/tests/admission-policies.sh            # kubectl's current context
#   KUBE_CONTEXT=kind-vertra-local bash helm/tests/admission-policies.sh
#   POLICY_TEST_RELEASE=policytest-2 bash ...        # beside another run
#
# Needs kubectl, helm, python3, and a cluster with ValidatingAdmissionPolicy
# (Kubernetes 1.30+) where you may impersonate ServiceAccounts.
set -uo pipefail
cd "$(dirname "$0")/../.."

CONTEXT_ARGS=()
[ -n "${KUBE_CONTEXT:-}" ] && CONTEXT_ARGS=(--context "$KUBE_CONTEXT")
# ${a[@]+...}: an empty array is "unbound" to bash 3.2 (macOS) under set -u.
k() { kubectl ${CONTEXT_ARGS[@]+"${CONTEXT_ARGS[@]}"} "$@"; }

RELEASE=${POLICY_TEST_RELEASE:-policytest}
PLATFORM_NS=$RELEASE-system
TEAM_A=$RELEASE-team-a
TEAM_B=$RELEASE-team-b
OTHER_NS=$RELEASE-other
RETIRED_NS=$RELEASE-retired
PROTECTED_NS=$RELEASE-protected
SCHEDULER=system:serviceaccount:$PLATFORM_NS:$RELEASE-execution-kernel
CONSOLE=system:serviceaccount:$PLATFORM_NS:$RELEASE-execution-console
GATEWAY=system:serviceaccount:$PLATFORM_NS:$RELEASE-execution-console-gateway
PURGER_USER=$RELEASE-purger
PURGER_GROUP=$RELEASE-purgers
SOURCE=registry.example
PRODUCTS='[{"team":"'$TEAM_A'","repository":"registry.example/db","action":"create","serviceAccount":"db-sa","audiences":"sts.amazonaws.com"},{"team":"","repository":"registry.example/platform","action":"run","serviceAccount":"plat-sa","audiences":""}]'
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
    # The console as the purger, as on kind and GKE, and a User and a Group.
    helm template "$RELEASE" helm/charts/execution-kernel -n "$PLATFORM_NS" \
      --set 'purgePolicy.purgers[0].kind=ServiceAccount' \
      --set "purgePolicy.purgers[0].name=$RELEASE-execution-console" \
      --set "purgePolicy.purgers[0].namespace=$PLATFORM_NS" \
      --set 'purgePolicy.purgers[1].kind=User' --set "purgePolicy.purgers[1].name=$PURGER_USER" \
      --set 'purgePolicy.purgers[2].kind=Group' --set "purgePolicy.purgers[2].name=$PURGER_GROUP" \
      --set "purgePolicy.protectedNamespaces[0]=$PROTECTED_NS" \
      --show-only templates/purge-policy.yaml
    echo "---"
    helm template "$RELEASE" helm/charts/execution-console -n "$PLATFORM_NS" \
      --set kernelApiUrl=http://unused --set gateway.enabled=true --set teamNamespaces.blockMetadata=true \
      --set teamNamespaces.schedulerLogs.clusterRole=$RELEASE-execution-kernel-scheduler-logs \
      --set teamNamespaces.schedulerLogs.serviceAccount=$PLATFORM_NS/$RELEASE-execution-kernel \
      --set scanning.image.repository=example.com/trivy --set scanning.image.tag=1 --set scanning.image.digest= \
      --set catalog.verifier.image.repository=example.com/cosign --set catalog.verifier.image.tag=2 \
      --set catalog.verifier.image.digest=sha256:$(printf 'c%.0s' $(seq 64)) \
      --set registryCheck.pullSecretName=pull-secret \
      --show-only templates/write-fence-policy.yaml \
      --show-only templates/namespace-policy.yaml \
      --show-only templates/console-jobs-policy.yaml
    echo "---"
    # Only the gateway's token policy, not the gateway itself.
    helm template "$RELEASE" helm/charts/execution-console -n "$PLATFORM_NS" \
      --set kernelApiUrl=http://unused --set gateway.enabled=true \
      --show-only templates/gateway.yaml \
      | python3 -c '
import re, sys
docs = re.split(r"^---$", sys.stdin.read(), flags=re.M)
print("---".join(d for d in docs if re.search(r"^kind: ValidatingAdmissionPolicy", d, re.M)))'
  }
}

cleanup() {
  render | k delete -f - --ignore-not-found > /dev/null 2>&1
  k delete clusterrolebinding,clusterrole $RELEASE-dry-run --ignore-not-found > /dev/null 2>&1
  k delete namespace "$PLATFORM_NS" "$TEAM_A" "$TEAM_B" "$OTHER_NS" "$RETIRED_NS" "$PROTECTED_NS" --ignore-not-found --wait=false > /dev/null 2>&1
}
trap cleanup EXIT

echo "Setting up on $(k config current-context)"
# A previous run's namespaces may still be terminating; creating them again
# would fail until they're gone.
for _ in $(seq 1 90); do
  k get namespaces --field-selector status.phase=Terminating -o name | grep -q "namespace/$RELEASE-" || break
  sleep 2
done
for ns in "$PLATFORM_NS" "$TEAM_A" "$TEAM_B" "$OTHER_NS" "$RETIRED_NS" "$PROTECTED_NS"; do
  k create namespace "$ns" --dry-run=client -o yaml | k apply -f - > /dev/null
done
k label namespace "$TEAM_A" "$TEAM_B" vertra/team=true --overwrite > /dev/null
k label namespace "$RETIRED_NS" "$PROTECTED_NS" vertra/team=retired --overwrite > /dev/null
for sa in eso-gcp db-sa orders-api; do
  k -n "$TEAM_A" create serviceaccount "$sa" --dry-run=client -o yaml | k apply -f - > /dev/null
done
for ns in "$OTHER_NS" "$RETIRED_NS"; do
  k -n "$ns" create serviceaccount orders-api --dry-run=client -o yaml | k apply -f - > /dev/null
done
# What the scheduler may and may not delete: ConfigMaps as the executor
# labels its own (and one that isn't), in a team namespace, a retired one
# and the platform's.
k apply -f - > /dev/null <<EOF
{"apiVersion":"v1","kind":"List","items":[
 {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"ek-mine","namespace":"$TEAM_A","labels":{"app":"execution-kernel"}}},
 {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"ek-unlabelled","namespace":"$TEAM_A"}},
 {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"not-ek","namespace":"$TEAM_A","labels":{"app":"execution-kernel"}}},
 {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"ek-mine","namespace":"$RETIRED_NS","labels":{"app":"execution-kernel"}}},
 {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"ek-mine","namespace":"$PLATFORM_NS","labels":{"app":"execution-kernel"}}},
 {"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"ek-mine","namespace":"$OTHER_NS","labels":{"app":"execution-kernel"}}},
 {"apiVersion":"networking.k8s.io/v1","kind":"NetworkPolicy","metadata":{"name":"vertra-default-deny","namespace":"$TEAM_B"},
  "spec":{"podSelector":{},"policyTypes":["Ingress"],"ingress":[{"from":[{"podSelector":{}}]}]}}]}
EOF

# RBAC comes before admission, so the impersonated identities need leave to
# create what the cases try to create.
k apply -f - > /dev/null <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: $RELEASE-dry-run}
rules:
  - {apiGroups: [batch], resources: [jobs], verbs: [create, delete]}
  - {apiGroups: [""], resources: [secrets, configmaps], verbs: [create, delete]}
  - {apiGroups: [""], resources: [namespaces], verbs: [get, create, update, patch]}
  - {apiGroups: [""], resources: [serviceaccounts], verbs: [get, update, patch]}
  - {apiGroups: [""], resources: [serviceaccounts/token], verbs: [create]}
  - {apiGroups: [""], resources: [resourcequotas, limitranges], verbs: [create, delete]}
  - {apiGroups: [networking.k8s.io], resources: [networkpolicies], verbs: [create, delete]}
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
  - {kind: ServiceAccount, name: $RELEASE-execution-console-gateway, namespace: $PLATFORM_NS}
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
labels = {"app.kubernetes.io/managed-by": "vertra-console", "app.kubernetes.io/component": "image-scan"}
exec(sys.argv[1])
print(json.dumps({"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": "policy-check"},
                  "spec": {"template": {"metadata": {"labels": labels}, "spec": s}}}))
PY
}

# Hardened as the executor makes a step's Job (scheduler.taskPodHardening),
# unless the seventh argument is "unhardened" (neither), or "own" (the
# container's securityContext is the sixth argument's).
job() {  # namespace, image, action, serviceAccount, secret ("" for none), extra container JSON, hardening, extra volumes JSON
  local volumes='{"name":"x","emptyDir":{}}'"${8:-}" mounts=""
  local pod=',"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"seccompProfile":{"type":"RuntimeDefault"}}'
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

# The scheduler deleting a ConfigMap (made above).
scheduler_delete() {  # namespace, name
  k --as="$SCHEDULER" -n "$1" delete configmap "$2" --dry-run=server 2>&1
}

# A NetworkPolicy as the console writes it (console/src/k8s.ts), with one
# change made by the python expression given (to spec).
network_policy() {  # name, change
  python3 - "$1" "$2" "$PLATFORM_NS" "$RELEASE" <<'PY' | as_console -n "$TEAM_A" create -f -
import json, sys
name, change, platform, release = sys.argv[1:5]
gateway = {"app.kubernetes.io/name": "execution-console", "app.kubernetes.io/instance": release,
           "app.kubernetes.io/component": "gateway"}
spec = {
    "vertra-default-deny": {"podSelector": {}, "policyTypes": ["Ingress"], "ingress": [{"from": [{"podSelector": {}}]}]},
    "vertra-gateway-ingress": {"podSelector": {"matchLabels": {"vertra/api-backend": "true"}}, "policyTypes": ["Ingress"],
        "ingress": [{"from": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": platform}},
                               "podSelector": {"matchLabels": gateway}}]}]},
    "vertra-no-metadata": {"podSelector": {}, "policyTypes": ["Egress"],
        "egress": [{"to": [{"ipBlock": {"cidr": "0.0.0.0/0", "except": ["169.254.169.254/32"]}}]}]},
}.get(name, {"podSelector": {}, "policyTypes": ["Ingress"]})
exec(change)
print(json.dumps({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": {"name": name}, "spec": spec}))
PY
}

# A token the gateway asks for (gateway/internal/credentials: ten minutes;
# dryRun=All, so none is issued). An empty audience asks for none.
token() {  # namespace, ServiceAccount, audience, seconds
  local out audiences='[]'
  [ -n "$3" ] && audiences='["'"$3"'"]'
  out=$(echo '{"apiVersion":"authentication.k8s.io/v1","kind":"TokenRequest","spec":{"audiences":'"$audiences"',"expirationSeconds":'"${4:-600}"'}}' \
    | k --as="$GATEWAY" create --raw "/api/v1/namespaces/$1/serviceaccounts/$2/token?dryRun=All" -f - 2>&1)
  # Never print a token: only whether it was allowed, or the refusal.
  if echo "$out" | grep -q '"kind":"TokenRequest"'; then echo "(server dry run)"; else echo "$out"; fi
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

HARD='"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}'
expect "a command of its own"                 "its image's own entrypoint"  "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"command":["sh","-c","id"]')"
expect "more than its action as arguments"    "its image's own entrypoint"  "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"args":["run","--and-more"]')"
expect "an environment variable of its own"   "its image's own entrypoint"  "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"env":[{"name":"EXTRA","value":"x"}]')"
expect "a Kubernetes API token"               "its image's own entrypoint"  "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" ',{"name":"t","projected":{"sources":[{"serviceAccountToken":{"path":"t"}}]}}')"
expect "a postStart hook"                     "its image's own entrypoint"  "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"lifecycle":{"postStart":{"exec":{"command":["sh","-c","id"]}}}')"
expect "an exec probe"                        "its image's own entrypoint"  "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"livenessProbe":{"exec":{"command":["sh","-c","id"]}}')"
expect "a container as root"                  "must run hardened"           "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"securityContext":{'"$HARD"',"runAsUser":0}' own)"
expect "a container without seccomp"          "must run hardened"           "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"securityContext":{'"$HARD"',"seccompProfile":{"type":"Unconfined"}}' own)"
expect "a port on the node"                   "must run hardened"           "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"ports":[{"containerPort":80,"hostPort":80}]')"
expect "delete its own ConfigMap"             allowed                       "$(scheduler_delete "$TEAM_A" ek-mine)"
expect "delete its own in a retired team's"   allowed                       "$(scheduler_delete "$RETIRED_NS" ek-mine)"
expect "delete one not labelled its own"      "may delete only its own"     "$(scheduler_delete "$TEAM_A" ek-unlabelled)"
expect "delete one not named ek-"             "may delete only its own"     "$(scheduler_delete "$TEAM_A" not-ek)"
expect "delete in the platform's namespace"   "may delete only its own"     "$(scheduler_delete "$PLATFORM_NS" ek-mine)"
expect "delete outside team namespaces"       "may delete only its own"     "$(scheduler_delete "$OTHER_NS" ek-mine)"

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
# The dispatch policy refuses any valueFrom too; either refusal will do.
expect "a secret through env, not a volume"      "IDENTITY_NOT_ALLOWED\|own entrypoint"  "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"env":[{"name":"K","valueFrom":{"secretKeyRef":{"name":"db-key","key":"k"}}}]')"
expect "a secret through envFrom"                "IDENTITY_NOT_ALLOWED\|own entrypoint"  "$(job "$TEAM_A" $SOURCE/db:1 create db-sa "" ',"envFrom":[{"secretRef":{"name":"db-key"}}]')"
expect "a secret in a projected volume"          "IDENTITY_NOT_ALLOWED"  "$(job "$TEAM_A" $SOURCE/db:1 create db-sa "" "" "" ',{"name":"p","projected":{"sources":[{"secret":{"name":"db-key"}}]}}')"
AUDIENCE='{"name":"t","projected":{"sources":[{"serviceAccountToken":{"path":"t","audience":"'
expect "a token for its product's audience"      allowed                "$(job "$TEAM_A" $SOURCE/db:1 create db-sa "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":3600}}]}}')"
expect "a token for another audience"            IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/db:1 create db-sa "" "" "" ",$AUDIENCE"'https://example.com","expirationSeconds":3600}}]}}')"
expect "a token lasting over an hour"            IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/db:1 create db-sa "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":7200}}]}}')"
expect "a token for a step that isn't a product" IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":3600}}]}}')"

echo "Image scans:"
expect "an image whose scan failed"              IMAGE_SCAN_FAILED     "$(job "$TEAM_A" $SOURCE/app:1@$BLOCKED_DIGEST run default "")"
expect "the same repository, another digest"     allowed               "$(job "$TEAM_A" $SOURCE/app:1@sha256:$(printf 'c%.0s' $(seq 64)) run default "")"

echo "Console write fence:"
expect "a Secret in a team namespace"            allowed                     "$(secret "$TEAM_A")"
expect "a Secret in kube-system"                 "may only write in team"    "$(secret kube-system)"
expect "a Secret in the platform's namespace"    "may only write in team"    "$(secret "$PLATFORM_NS")"

echo "Console NetworkPolicies:"
NP_REFUSED="console's NetworkPolicies are"
expect "the default deny"                        allowed          "$(network_policy vertra-default-deny pass)"
expect "the gateway's ingress"                   allowed          "$(network_policy vertra-gateway-ingress pass)"
expect "the no-metadata one"                     allowed          "$(network_policy vertra-no-metadata pass)"
expect "a default deny letting in another namespace" "$NP_REFUSED" "$(network_policy vertra-default-deny 'spec["ingress"][0]["from"][0]["namespaceSelector"] = {}')"
expect "a default deny letting in an address"    "$NP_REFUSED"    "$(network_policy vertra-default-deny 'spec["ingress"][0]["from"] = [{"ipBlock": {"cidr": "0.0.0.0/0"}}]')"
expect "a default deny selecting some Pods"      "$NP_REFUSED"    "$(network_policy vertra-default-deny 'spec["podSelector"] = {"matchLabels": {"a": "b"}}')"
expect "a default deny letting out everything"   "$NP_REFUSED"    "$(network_policy vertra-default-deny 'spec["policyTypes"] = ["Ingress", "Egress"]; spec["egress"] = [{}]')"
expect "a gateway ingress from any namespace"    "$NP_REFUSED"    "$(network_policy vertra-gateway-ingress 'spec["ingress"][0]["from"][0]["namespaceSelector"] = {}')"
expect "a gateway ingress for every Pod"         "$NP_REFUSED"    "$(network_policy vertra-gateway-ingress 'spec["podSelector"] = {}')"
expect "a gateway ingress letting out everything" "$NP_REFUSED"   "$(network_policy vertra-gateway-ingress 'spec["policyTypes"] = ["Ingress", "Egress"]; spec["egress"] = [{}]')"
expect "no-metadata without its exception"       "$NP_REFUSED"    "$(network_policy vertra-no-metadata 'del spec["egress"][0]["to"][0]["ipBlock"]["except"]')"
expect "no-metadata excepting something else"    "$NP_REFUSED"    "$(network_policy vertra-no-metadata 'spec["egress"][0]["to"][0]["ipBlock"]["except"] = ["10.0.0.0/8"]')"
expect "no-metadata letting out to Pods"         "$NP_REFUSED"    "$(network_policy vertra-no-metadata 'spec["egress"].append({"to": [{"podSelector": {}}]})')"
expect "a policy of another name"                "$NP_REFUSED"    "$(network_policy allow-all 'spec["ingress"] = [{}]')"
expect "deleting the default deny"               "$NP_REFUSED"    "$(as_console -n "$TEAM_B" delete networkpolicy vertra-default-deny)"

echo "Console quota and limits:"
expect "the team's quota"                        allowed          "$(as_console -n "$TEAM_A" create quota vertra-team-quota --hard=pods=10)"
expect "a quota of another name"                 "only ResourceQuota" "$(as_console -n "$TEAM_A" create quota other --hard=pods=10)"
LIMITS='{"apiVersion":"v1","kind":"LimitRange","metadata":{"name":"NAME"},"spec":{"limits":[{"type":"Container","default":{"cpu":"1"}}]}}'
expect "the team's limits"                       allowed          "$(echo "${LIMITS/NAME/vertra-team-limits}" | as_console -n "$TEAM_A" create -f -)"
expect "limits of another name"                  "only ResourceQuota" "$(echo "${LIMITS/NAME/other}" | as_console -n "$TEAM_A" create -f -)"

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
expect "a protected one, though retired"         "can't be purged"            "$(as_console delete namespace "$PROTECTED_NS")"
expect "a User purger, a retired one"            allowed                      "$(k --as="$PURGER_USER" delete namespace "$RETIRED_NS" --dry-run=server 2>&1)"
expect "a User purger, an active one"            "can't be purged"            "$(k --as="$PURGER_USER" delete namespace "$TEAM_A" --dry-run=server 2>&1)"
expect "a Group purger's member, a retired one"  allowed                      "$(k --as=someone --as-group="$PURGER_GROUP" delete namespace "$RETIRED_NS" --dry-run=server 2>&1)"
expect "a Group purger's member, an active one"  "can't be purged"            "$(k --as=someone --as-group="$PURGER_GROUP" delete namespace "$TEAM_A" --dry-run=server 2>&1)"
expect "a Group purger's member, the platform's" "can't be purged"            "$(k --as=someone --as-group="$PURGER_GROUP" delete namespace "$PLATFORM_NS" --dry-run=server 2>&1)"

echo "Console ServiceAccounts:"
expect "update ESO's (eso-*)"                    allowed                      "$(as_console -n "$TEAM_A" annotate serviceaccount eso-gcp iam.gke.io/gcp-service-account=x)"
expect "update a product's"                      "only update the ServiceAccounts ESO" "$(as_console -n "$TEAM_A" annotate serviceaccount db-sa iam.gke.io/gcp-service-account=x)"
expect "update an API's"                         "only update the ServiceAccounts ESO" "$(as_console -n "$TEAM_A" label serviceaccount orders-api a=b)"
expect "update default"                          "only update the ServiceAccounts ESO" "$(as_console -n "$TEAM_A" annotate serviceaccount default iam.gke.io/gcp-service-account=x)"

echo "Gateway tokens:"
expect "an API's, for its backend"               allowed                      "$(token "$TEAM_A" orders-api https://orders.example)"
expect "a ServiceAccount that isn't an API's"    "only mint tokens for API"   "$(token "$TEAM_A" db-sa https://orders.example)"
expect "an API's outside team namespaces"        "only mint tokens for API"   "$(token "$OTHER_NS" orders-api https://orders.example)"
expect "an API's in a retired team's namespace"  "only mint tokens for API"   "$(token "$RETIRED_NS" orders-api https://orders.example)"
expect "no audience (the Kubernetes API's)"      "never the Kubernetes API"   "$(token "$TEAM_A" orders-api "")"
expect "for the Kubernetes API"                  "never the Kubernetes API"   "$(token "$TEAM_A" orders-api https://kubernetes.default.svc)"
expect "for GKE's API"                           "never the Kubernetes API"   "$(token "$TEAM_A" orders-api https://container.googleapis.com/v1/projects/p)"
expect "for kernel-api"                          "never the Kubernetes API"   "$(token "$TEAM_A" orders-api vertra-kernel-api)"
expect "lasting over an hour"                    "an hour at most"            "$(token "$TEAM_A" orders-api https://orders.example 7200)"

echo "Console Jobs (image scans and catalog verifications):"
expect "a scan as the console makes it"          allowed                   "$(console_job 'pass')"
expect "as another ServiceAccount"               "runs as"                 "$(console_job 's["serviceAccountName"] = "'"$RELEASE"'-execution-kernel"')"
expect "with a Kubernetes token"                 "runs as"                 "$(console_job 's["automountServiceAccountToken"] = True')"
expect "a verification, by digest"               allowed                   "$(console_job 'c["image"] = "example.com/cosign:2@sha256:" + "c" * 64; labels["app.kubernetes.io/component"] = "catalog-verify"')"
expect "another image"                           "scanner or verifier image" "$(console_job 'c["image"] = "busybox"')"
expect "the console's own labels"                "only its own labels"     "$(console_job 'labels.update({"app.kubernetes.io/name": "execution-console", "app.kubernetes.io/instance": "'"$RELEASE"'"})')"
expect "another component"                       "only its own labels"     "$(console_job 'labels["app.kubernetes.io/component"] = "app"')"
expect "a ServiceAccount token volume"           "only scratch space"      "$(console_job 's["volumes"].append({"name": "t", "projected": {"sources": [{"serviceAccountToken": {"path": "t"}}]}})')"
expect "an init container"                       "scanner or verifier image" "$(console_job 's["initContainers"] = [dict(c, name="init")]')"
expect "another Secret"                          "only scratch space"      "$(console_job 's["volumes"].append({"name": "db", "secret": {"secretName": "'"$RELEASE"'-execution-kernel-db"}})')"
expect "the node's filesystem"                   "only scratch space"      "$(console_job 's["volumes"].append({"name": "root", "hostPath": {"path": "/"}})')"
expect "privileged"                              "unprivileged"            "$(console_job 'c["securityContext"] = {"privileged": True, "allowPrivilegeEscalation": True}')"
expect "privilege escalation"                    "unprivileged"            "$(console_job 'c["securityContext"]["allowPrivilegeEscalation"] = True')"
expect "a container as root"                     "unprivileged"            "$(console_job 'c["securityContext"]["runAsUser"] = 0')"
expect "added capabilities"                      "unprivileged"            "$(console_job 'c["securityContext"]["capabilities"]["add"] = ["NET_RAW"]')"
expect "a port on the node"                      "unprivileged"            "$(console_job 'c["ports"] = [{"containerPort": 80, "hostPort": 80}]')"
expect "SELinux options"                         "unprivileged"            "$(console_job 'c["securityContext"]["seLinuxOptions"] = {"type": "spc_t"}')"
expect "no seccomp"                              "unprivileged"            "$(console_job 's["securityContext"]["seccompProfile"] = {"type": "Unconfined"}')"
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
