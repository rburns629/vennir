#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Proves the charts' admission policies on a real cluster: dispatch (team
# namespaces only, Jobs shaped as the executor makes them), step Jobs and
# Pods, image sources, step identity, scans and purging (kernel
# chart), and the console's write fence, its namespaces, its Jobs and the
# gateway's tokens (console chart). Every case is a server-side dry run, so
# nothing is created, made as the identity the policy guards (impersonated).
# What a case deletes or replaces is made first, for real, in the scratch
# namespaces.
#
# Renders the policies under their own release name, "policytest", and
# team label (<release>.test/team), so they only ever match that release's
# (impersonated) identities and namespaces: a Vennir install on the same
# cluster is unaffected, and its policies (which cover every namespace with
# its own team label) leave this run's alone. Removes everything it added.
#
#   bash helm/tests/admission-policies.sh            # kubectl's current context
#   KUBE_CONTEXT=kind-vennir-local bash helm/tests/admission-policies.sh
#   POLICY_TEST_RELEASE=policytest-2 bash ...        # beside another run
#
# Needs kubectl, helm, python3, and a cluster with ValidatingAdmissionPolicy
# (Kubernetes 1.30+) where you may impersonate ServiceAccounts.
set -uo pipefail
cd "$(dirname "$0")/../.."

CONTEXT_ARGS=()
HELM_CONTEXT_ARGS=()
[ -n "${KUBE_CONTEXT:-}" ] && CONTEXT_ARGS=(--context "$KUBE_CONTEXT") && HELM_CONTEXT_ARGS=(--kube-context "$KUBE_CONTEXT")
# ${a[@]+...}: an empty array is "unbound" to bash 3.2 (macOS) under set -u.
k() { kubectl ${CONTEXT_ARGS[@]+"${CONTEXT_ARGS[@]}"} "$@"; }

RELEASE=${POLICY_TEST_RELEASE:-policytest}
PLATFORM_NS=$RELEASE-system
TEAM_A=$RELEASE-team-a
TEAM_B=$RELEASE-team-b
OTHER_NS=$RELEASE-other
RETIRED_NS=$RELEASE-retired
PROTECTED_NS=$RELEASE-protected
# Team A's API backends' namespace, a retired team's, and one labelled as
# one though its name isn't <team>-apis.
APIS_NS=$TEAM_A-apis
RETIRED_APIS_NS=$RELEASE-retired-apis
NOT_APIS_NS=$RELEASE-not-a-backends
SCHEDULER=system:serviceaccount:$PLATFORM_NS:$RELEASE-execution-kernel
CONSOLE=system:serviceaccount:$PLATFORM_NS:$RELEASE-execution-console
GATEWAY=system:serviceaccount:$PLATFORM_NS:$RELEASE-execution-console-gateway
PURGER_USER=$RELEASE-purger
PURGER_GROUP=$RELEASE-purgers
SOURCE=registry.example
# An upgraded install's legacy products list (by repository, any digest),
# which the console empties once its rollout is over.
LEGACY_PRODUCTS='[{"team":"'$TEAM_A'","repository":"registry.example/db","action":"create","serviceAccount":"db-sa","audiences":"sts.amazonaws.com"}]'
TEAM_SECRETS='{"'$TEAM_A'":"api-token,db-key","'$TEAM_B'":"b-key"}'
# The team label this run's policies and namespaces use, its own: an
# install on the same cluster (vennir/team) never matches this run's
# namespaces, and its policies, which cover every namespace labelled with
# its label, never refuse this run's identities.
TEAM_LABEL=$RELEASE.test/team
FAILURES=0

# helm template, with this run's team label in both charts.
ht() { helm template "$@" --set "dispatchPolicy.teamNamespaceLabel=$TEAM_LABEL" --set "writeFence.teamNamespaceLabel=$TEAM_LABEL"; }

render() {
  {
    # Steps pull with vennir-pull, and a product asking for Spot runs on
    # its pool (helm/tests/step-job.json is such a step's Job).
    ht "$RELEASE" helm/charts/execution-kernel -n "$PLATFORM_NS" \
      --set imagePolicy.sourceRegistry=$SOURCE \
      --set scheduler.taskImagePullSecret=vennir-pull \
      --set scheduler.capacityPlacements.spot.nodeSelector.pool=spot \
      --set 'scheduler.capacityPlacements.spot.tolerations[0].key=pool' \
      --set 'scheduler.capacityPlacements.spot.tolerations[0].operator=Equal' \
      --set 'scheduler.capacityPlacements.spot.tolerations[0].value=spot' \
      --set 'scheduler.capacityPlacements.spot.tolerations[0].effect=NoSchedule' \
      --show-only templates/dispatch-policy.yaml \
      --show-only templates/image-policy.yaml \
      --show-only templates/identity-policy.yaml \
      --show-only templates/step-pods-policy.yaml \
      --show-only templates/step-jobs-policy.yaml \
      --set scanPolicy.requireDigest=false --show-only templates/scan-policy.yaml
    echo "---"
    # The console as the purger, as on kind and GKE, and a User and a Group.
    ht "$RELEASE" helm/charts/execution-kernel -n "$PLATFORM_NS" \
      --set 'purgePolicy.purgers[0].kind=ServiceAccount' \
      --set "purgePolicy.purgers[0].name=$RELEASE-execution-console" \
      --set "purgePolicy.purgers[0].namespace=$PLATFORM_NS" \
      --set 'purgePolicy.purgers[1].kind=User' --set "purgePolicy.purgers[1].name=$PURGER_USER" \
      --set 'purgePolicy.purgers[2].kind=Group' --set "purgePolicy.purgers[2].name=$PURGER_GROUP" \
      --set "purgePolicy.protectedNamespaces[0]=$PROTECTED_NS" \
      --show-only templates/purge-policy.yaml
    echo "---"
    ht "$RELEASE" helm/charts/execution-console -n "$PLATFORM_NS" \
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
    ht "$RELEASE" helm/charts/execution-console -n "$PLATFORM_NS" \
      --set kernelApiUrl=http://unused --set gateway.enabled=true \
      --show-only templates/gateway.yaml \
      | python3 -c '
import re, sys
docs = re.split(r"^---$", sys.stdin.read(), flags=re.M)
print("---".join(d for d in docs if re.search(r"^kind: ValidatingAdmissionPolicy", d, re.M)))'
  }
}

# The kernel chart's catalog policies (kernel policy's, decision 27) as an
# upgrade renders them (lookup), their RBAC, and the console chart's
# ClusterRole for the policies it may write: not the Deployment, nor
# anything else either chart makes.
render_catalog() {
  {
    ht "$RELEASE" helm/charts/execution-kernel -n "$PLATFORM_NS" ${HELM_CONTEXT_ARGS[@]+"${HELM_CONTEXT_ARGS[@]}"} \
      --dry-run=server --take-ownership \
      --set catalogPolicy.enabled=true --set catalogPolicy.release=$SOURCE/catalog-release:latest \
      --set 'catalogPolicy.signature.publicKeys[0]=unused' \
      --set catalogPolicy.gateway.serviceAccount=$RELEASE-execution-console-gateway \
      --show-only templates/catalog-policy.yaml
    echo "---"
    ht "$RELEASE" helm/charts/execution-console -n "$PLATFORM_NS" \
      --set kernelApiUrl=http://unused --set gateway.enabled=true \
      --set imagePolicy.policyName=$RELEASE-execution-kernel-image \
      --set identityPolicy.policyName=$RELEASE-execution-kernel-identity \
      --set catalogPolicy.identityPolicyName=$RELEASE-execution-kernel-catalog-identity \
      --show-only templates/rbac.yaml
  } | python3 -c '
import re, sys
keep = ("ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding", "ServiceAccount", "ClusterRole", "ClusterRoleBinding")
docs = re.split(r"^---$", sys.stdin.read(), flags=re.M)
out = []
for d in docs:
    kind = re.search(r"^kind: (\w+)$", d, re.M)
    name = re.search(r"^  name: (\S+)$", d, re.M)
    if not kind or kind.group(1) not in keep:
        continue
    # Of the console chart, only the ClusterRole of the policies it writes.
    if kind.group(1).startswith("ClusterRole") and not re.search(r"-(execution-kernel-policy|execution-console-image-policy)$", name.group(1) if name else ""):
        continue
    if kind.group(1) == "ServiceAccount" and not (name and name.group(1).endswith("-execution-kernel-policy")):
        continue
    out.append(d)
print("---".join(out))'
}

cleanup() {
  render | k delete -f - --ignore-not-found > /dev/null 2>&1
  k delete validatingadmissionpolicybinding,validatingadmissionpolicy \
    $RELEASE-execution-kernel-catalog-identity $RELEASE-execution-kernel-catalog-tokens --ignore-not-found > /dev/null 2>&1
  k delete clusterrolebinding,clusterrole $RELEASE-execution-kernel-policy $RELEASE-execution-console-image-policy \
    --ignore-not-found > /dev/null 2>&1
  k delete clusterrolebinding,clusterrole $RELEASE-dry-run --ignore-not-found > /dev/null 2>&1
  [ -n "${ESO_CRD_STUB:-}" ] && k delete crd externalsecrets.external-secrets.io --ignore-not-found > /dev/null 2>&1
  k delete namespace "$PLATFORM_NS" "$TEAM_A" "$TEAM_B" "$OTHER_NS" "$RETIRED_NS" "$PROTECTED_NS" "$APIS_NS" "$RETIRED_APIS_NS" "$NOT_APIS_NS" --ignore-not-found --wait=false > /dev/null 2>&1
}
trap cleanup EXIT

echo "Setting up on $(k config current-context)"
# A previous run's namespaces may still be terminating; creating them again
# would fail until they're gone.
for _ in $(seq 1 90); do
  grep -q "namespace/$RELEASE-" <<<"$(k get namespaces --field-selector status.phase=Terminating -o name)" || break
  sleep 2
done
for ns in "$PLATFORM_NS" "$TEAM_A" "$TEAM_B" "$OTHER_NS" "$RETIRED_NS" "$PROTECTED_NS" "$APIS_NS" "$RETIRED_APIS_NS" "$NOT_APIS_NS"; do
  k create namespace "$ns" --dry-run=client -o yaml | k apply -f - > /dev/null
done
k label namespace "$TEAM_A" "$TEAM_B" "$TEAM_LABEL=true" --overwrite > /dev/null
k label namespace "$RETIRED_NS" "$PROTECTED_NS" "$TEAM_LABEL=retired" --overwrite > /dev/null
k label namespace "$APIS_NS" vennir/api-backends=true --overwrite > /dev/null
k label namespace "$RETIRED_APIS_NS" "$NOT_APIS_NS" vennir/api-backends=retired --overwrite > /dev/null
for sa in eso-gcp db-sa orders-api ledger-api site-api unpublished-api; do
  k -n "$TEAM_A" create serviceaccount "$sa" --dry-run=client -o yaml | k apply -f - > /dev/null
done
for ns in "$TEAM_B" "$OTHER_NS" "$RETIRED_NS" "$APIS_NS"; do
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
 {"apiVersion":"networking.k8s.io/v1","kind":"NetworkPolicy","metadata":{"name":"vennir-default-deny","namespace":"$TEAM_B"},
  "spec":{"podSelector":{},"policyTypes":["Ingress"],"ingress":[{"from":[{"podSelector":{}}]}]}}]}
EOF
# ExternalSecrets the console made (labelled) and one it didn't, for the
# write fence's cases. Without External Secrets Operator (CI's cluster), a
# stand-in for its CRD, removed again at the end.
if ! k get crd externalsecrets.external-secrets.io > /dev/null 2>&1; then
  ESO_CRD_STUB=1
  k apply -f - > /dev/null <<EOF
{"apiVersion":"apiextensions.k8s.io/v1","kind":"CustomResourceDefinition",
 "metadata":{"name":"externalsecrets.external-secrets.io"},
 "spec":{"group":"external-secrets.io","scope":"Namespaced",
  "names":{"plural":"externalsecrets","singular":"externalsecret","kind":"ExternalSecret"},
  "versions":[{"name":"v1","served":true,"storage":true,
   "schema":{"openAPIV3Schema":{"type":"object","x-kubernetes-preserve-unknown-fields":true}}}]}}
EOF
  k wait --for=condition=Established crd/externalsecrets.external-secrets.io --timeout=60s > /dev/null
fi
external_secret() {  # name, labels as JSON
  echo '{"apiVersion":"external-secrets.io/v1","kind":"ExternalSecret","metadata":{"name":"'"$1"'","labels":'"$2"'},
 "spec":{"secretStoreRef":{"name":"store","kind":"SecretStore"},"target":{"name":"'"$1"'"},
  "data":[{"secretKey":"a","remoteRef":{"key":"a"}}]}}'
}
CONSOLE_LABELS='{"app.kubernetes.io/managed-by":"vennir-console"}'
external_secret es-console "$CONSOLE_LABELS" | k -n "$TEAM_A" apply -f - > /dev/null
external_secret es-other '{}' | k -n "$TEAM_A" apply -f - > /dev/null
# And Jobs for it to resume, or not: suspended as the executor makes them
# (and one already resumed, with no Pods to make), none of them run.
fixture_job() {  # namespace, name, labels as JSON, suspend, parallelism
  printf '{"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"%s","namespace":"%s","labels":%s},"spec":{"suspend":%s,"parallelism":%s,"backoffLimit":0,"template":{"spec":{"restartPolicy":"Never","containers":[{"name":"step","image":"busybox:1.36","args":["create"]}]}}}}' "$2" "$1" "$3" "$4" "$5"
}
OWN='{"app":"execution-kernel"}'
k apply -f - > /dev/null <<EOF
{"apiVersion":"v1","kind":"List","items":[
 $(fixture_job "$TEAM_A" ek-suspended "$OWN" true 1),
 $(fixture_job "$TEAM_A" ek-resumed "$OWN" false 0),
 $(fixture_job "$TEAM_A" ek-unlabelled '{}' true 1),
 $(fixture_job "$RETIRED_NS" ek-suspended "$OWN" true 1),
 $(fixture_job "$OTHER_NS" ek-suspended "$OWN" true 1)]}
EOF

# RBAC comes before admission, so the impersonated identities need leave to
# create what the cases try to create.
k apply -f - > /dev/null <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: {name: $RELEASE-dry-run}
rules:
  - {apiGroups: [batch], resources: [jobs], verbs: [create, get, patch, delete]}
  - {apiGroups: [""], resources: [secrets, configmaps], verbs: [create, delete]}
  - {apiGroups: [""], resources: [namespaces], verbs: [get, create, update, patch]}
  - {apiGroups: [""], resources: [serviceaccounts], verbs: [get, update, patch]}
  - {apiGroups: [""], resources: [serviceaccounts/token], verbs: [create]}
  - {apiGroups: [""], resources: [resourcequotas, limitranges], verbs: [create, delete]}
  - {apiGroups: [networking.k8s.io], resources: [networkpolicies], verbs: [create, delete]}
  - {apiGroups: [rbac.authorization.k8s.io], resources: [rolebindings, roles], verbs: [create]}
  - {apiGroups: [rbac.authorization.k8s.io], resources: [clusterroles], verbs: [bind]}
  - {apiGroups: [external-secrets.io], resources: [externalsecrets], verbs: [get, create, update, patch, delete]}
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
# And the scan policy's admitted digests (digest to true, in sixteen maps
# by first hex digit): the step identity cases' (0…), one that passed (c…),
# one an admin accepted (a…; the console lists it the same way). One never
# scanned (d…) and one that failed (b…) aren't listed. The rest is filled to
# the most the console writes (scanning.ts's MAX_ADMITTED_DIGESTS), so the
# policy is proven at its size limit.
digest() { echo "sha256:$(printf "$1%.0s" $(seq 64))"; }
ZERO_DIGEST=$(digest 0) PASSED_DIGEST=$(digest c) ACCEPTED_DIGEST=$(digest a)
UNSCANNED_DIGEST=$(digest d) FAILED_DIGEST=$(digest b)
# Products' released digests, for the step identity cases (all passed
# their scans): db's and vault's (0…), the platform product's (1…), the
# "big" product's in a map filled to the most the console writes in one
# (c…), and a digest pushed to db's repository but never released (2…).
PLATFORM_DIGEST=$(digest 1) UNRELEASED_DIGEST=$(digest 2)
scan_literal() {  # digests as a JSON map of digest to true or false, unlistedAdmitted, how many to fill it to, and with what first digit (any)
  k get validatingadmissionpolicy $RELEASE-execution-kernel-scan -o json \
    | python3 -c '
import hashlib, json, sys
policy = json.load(sys.stdin)
# The copy kubectl apply keeps of what it applied: replace would update it, past an annotation size limit.
policy["metadata"].get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
digests = json.loads(sys.argv[1])
for i in range(int(sys.argv[3]) - len(digests)):
    digests["sha256:" + sys.argv[4] + hashlib.sha256(b"fill-%d" % i).hexdigest()[len(sys.argv[4]):]] = True
maps = {digit: {} for digit in "0123456789abcdef"}
for digest, admitted in digests.items():
    maps[digest[7]][digest] = admitted
for variable in policy["spec"]["variables"]:
    if variable["name"] == "unlistedAdmitted":
        variable["expression"] = sys.argv[2]
    elif variable["name"][len("allowedDigests"):] in maps and variable["name"].startswith("allowedDigests"):
        variable["expression"] = json.dumps(maps[variable["name"][len("allowedDigests"):]], separators=(",", ":"))
print(json.dumps(policy))' "$1" "$2" "${3:-0}" "${4:-}" \
    | k replace -f - > /dev/null || { echo "  FAIL  writing the scan policy's digests"; FAILURES=$((FAILURES + 1)); }
}
scan_literal '{"'$ZERO_DIGEST'":true,"'$PASSED_DIGEST'":true,"'$ACCEPTED_DIGEST'":true,"'$PLATFORM_DIGEST'":true,"'$UNRELEASED_DIGEST'":true}' false 5000

# The console keeps the identity policy's literals current (console/src/
# productPolicy.ts); here, fixed ones: the legacy products list, each team's
# secrets, and the released digests, in sixteen maps by first hex digit.
# With "full", the c… map is filled to the most the console writes in one
# map (MAX_MAP_CHARS) and the rest to the most it writes in all
# (MAX_RELEASE_CHARS), so the policy is proven at its size limit.
RELEASES='{"'$ZERO_DIGEST'":[{"team":"'$TEAM_A'","repository":"registry.example/db","action":"create","serviceAccount":"db-sa","audiences":"sts.amazonaws.com"},{"team":"'$TEAM_A'","repository":"registry.example/vault","action":"run","serviceAccount":"eso-gcp","audiences":""}],"'$PLATFORM_DIGEST'":[{"team":"","repository":"registry.example/platform","action":"run","serviceAccount":"plat-sa","audiences":""}],"'$PASSED_DIGEST'":[{"team":"'$TEAM_A'","repository":"registry.example/big","action":"run","serviceAccount":"db-sa","audiences":""}]}'
identity_literal() {  # legacy products, team secrets, releases (digest to products), "full" or ""
  k get validatingadmissionpolicy $RELEASE-execution-kernel-identity -o json \
    | python3 -c '
import hashlib, json, sys
policy = json.load(sys.stdin)
policy["metadata"].get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
# Unconditionally, as below: the type-checking status of a replace just before may still be landing.
policy["metadata"].pop("resourceVersion", None)
MAX_MAP_CHARS, MAX_RELEASE_CHARS = 95000, 600000
maps = {digit: {} for digit in "0123456789abcdef"}
for digest, entries in json.loads(sys.argv[3]).items():
    maps[digest[7]][digest] = entries
dump = lambda m: json.dumps(m, separators=(",", ":"))
def fill(digit, limit, n):
    while True:
        h = hashlib.sha256(b"fill-%d" % n).hexdigest()
        digest = "sha256:" + digit + h[1:]
        entry = [{"team": "fill", "repository": "registry.example/fill/p%d" % n, "action": "run", "serviceAccount": "fill-%d" % n, "audiences": ""}]
        maps[digit][digest] = entry
        if len(dump(maps[digit])) > limit:
            del maps[digit][digest]
            return n
        n += 1
if sys.argv[4] == "full":
    n = fill("c", MAX_MAP_CHARS, 0)
    rest = (MAX_RELEASE_CHARS - len(dump(maps["c"]))) // 15
    for digit in "0123456789abdef":
        n = fill(digit, rest, n)
    total = sum(len(dump(m)) for m in maps.values())
    print("  (releases: %d characters, %d in the c map)" % (total, len(dump(maps["c"]))), file=sys.stderr)
for variable in policy["spec"]["variables"]:
    name = variable["name"]
    if name == "products":
        variable["expression"] = sys.argv[1]
    elif name == "teamSecrets":
        variable["expression"] = sys.argv[2]
    elif name.startswith("releases") and name[len("releases"):] in maps:
        variable["expression"] = dump(maps[name[len("releases"):]])
print(json.dumps(policy))' "$1" "$2" "$3" "${4:-}" \
    | k replace -f - > /dev/null || { echo "  FAIL  writing the identity policy's literals"; FAILURES=$((FAILURES + 1)); }
}
identity_literal '[]' "$TEAM_SECRETS" "$RELEASES" full

# The gateway token policy's literals as the console writes them
# (console/src/gatewayTokenPolicy.ts): each published API's ServiceAccount
# ("<namespace>/<name>") to its audiences, in sixteen maps by the key's
# length modulo 16, and apiAudiencesWritten "true" (the chart seeds it
# "false"). Team A's orders API signs in with a backend token
# (serviceAccountToken), its ledger API with AWS SigV4 (STS's audience), its
# site API with a Google ID token (the GKE pool's audience,
# gateway.gcp.tokenAudience); its unpublished-api is no published API's.
API_AUDIENCES='{"'$TEAM_A'/orders-api":["https://orders.example"],"'$TEAM_A'/ledger-api":["sts.amazonaws.com"],"'$TEAM_A'/site-api":["acme.svc.id.goog"]}'
gateway_literal() {  # each key to its audiences, as JSON; "misplaced" puts each in the wrong map
  k get validatingadmissionpolicy $RELEASE-execution-console-gateway-tokens -o json \
    | python3 -c '
import json, sys
policy = json.load(sys.stdin)
policy["metadata"].get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
shift = 1 if sys.argv[2] == "misplaced" else 0
maps = {digit: {} for digit in "0123456789abcdef"}
for key, audiences in json.loads(sys.argv[1]).items():
    maps["0123456789abcdef"[(len(key) + shift) % 16]][key] = audiences
for variable in policy["spec"]["variables"]:
    digit = variable["name"][len("apiAudiences"):]
    if variable["name"] == "apiAudiencesWritten":
        variable["expression"] = "true"
    elif variable["name"].startswith("apiAudiences") and digit in maps:
        variable["expression"] = json.dumps(maps[digit], separators=(",", ":"))
print(json.dumps(policy))' "$1" "${2:-}" \
    | k replace -f - > /dev/null || { echo "  FAIL  writing the gateway token policy's literals"; FAILURES=$((FAILURES + 1)); }
}
# The kernel's catalog policies' literals as kernel policy writes them
# (kernel/internal/policy): releases (digest to products, by the digest's
# first hex digit) or apiAudiences (key to audiences, by the key's length
# modulo 16, and apiAudiencesWritten "true").
catalog_literal() {  # policy, releases | apiAudiences, the map as JSON
  k get validatingadmissionpolicy "$1" -o json \
    | python3 -c '
import json, sys
policy = json.load(sys.stdin)
policy["metadata"].get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
prefix, digits = sys.argv[1], "0123456789abcdef"
maps = {d: {} for d in digits}
for key, value in json.loads(sys.argv[2]).items():
    maps[key[7] if prefix == "releases" else digits[len(key) % 16]][key] = value
for variable in policy["spec"]["variables"]:
    name = variable["name"]
    if name == "apiAudiencesWritten":
        variable["expression"] = "true"
    elif name == "products":
        variable["expression"] = "[]"  # as the kernel writes it: the legacy list emptied
    elif name.startswith(prefix) and name[len(prefix):] in maps:
        variable["expression"] = json.dumps(maps[name[len(prefix):]], separators=(",", ":"))
print(json.dumps(policy))' "$2" "$3" \
    | k replace -f - > /dev/null || { echo "  FAIL  writing $1's literals"; FAILURES=$((FAILURES + 1)); }
}

# The console chart rendered as an upgrade would (lookup reads this run's
# policy), only the gateway token policy's variables.
gateway_seed() {
  ht "$RELEASE" helm/charts/execution-console -n "$PLATFORM_NS" ${HELM_CONTEXT_ARGS[@]+"${HELM_CONTEXT_ARGS[@]}"} \
    --set kernelApiUrl=http://unused --set gateway.enabled=true --dry-run=server --take-ownership \
    --show-only templates/gateway.yaml 2>&1 \
    | python3 -c '
import re, sys
text = sys.stdin.read()
if "Error" in text and "kind: ValidatingAdmissionPolicy" not in text:
    print(text.strip()); sys.exit()
for doc in re.split(r"^---$", text, flags=re.M):
    if re.search(r"^kind: ValidatingAdmissionPolicy$", doc, re.M):
        for name, expression in re.findall(r"- name: (apiAudiences\w*)\n\s+expression: (.*)", doc):
            if name != "apiAudiences":
                print(name, expression)'
}

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
labels = {"app.kubernetes.io/managed-by": "vennir-console", "app.kubernetes.io/component": "image-scan"}
exec(sys.argv[1])
print(json.dumps({"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": "policy-check"},
                  "spec": {"template": {"metadata": {"labels": labels}, "spec": s}}}))
PY
}

# Hardened as the executor makes a step's Job (the dispatch policy requires it),
# unless the seventh argument is "unhardened" (neither), or "own" (the
# container's securityContext is the sixth argument's).
job() {  # namespace, image, action, serviceAccount, secret ("" for none), extra container JSON, hardening, extra volumes JSON, extra Pod spec JSON
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
 "spec":{"template":{"spec":{"restartPolicy":"Never","serviceAccountName":"$4"$pod${9:-},
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

# The scheduler patching a Job (made above).
scheduler_patch() {  # namespace, name, merge patch
  # kubectl's patch doesn't say "(server dry run)" when it's one, as create
  # and delete do: said here, as expect reads it.
  k --as="$SCHEDULER" -n "$1" patch job "$2" --type=merge -p "$3" --dry-run=server 2>&1 | sed 's/ patched$/ patched (server dry run)/'
}
# The scheduler deleting a ConfigMap (made above).
scheduler_delete() {  # namespace, name
  k --as="$SCHEDULER" -n "$1" delete configmap "$2" --dry-run=server 2>&1
}

# A NetworkPolicy as the console writes it (console/src/k8s.ts), with one
# change made by the python expression given (to spec).
network_policy() {  # name, change, namespace (team A's)
  python3 - "$1" "$2" "$PLATFORM_NS" "$RELEASE" <<'PY' | as_console -n "${3:-$TEAM_A}" create -f -
import json, sys
name, change, platform, release = sys.argv[1:5]
gateway = {"app.kubernetes.io/name": "execution-console", "app.kubernetes.io/instance": release,
           "app.kubernetes.io/component": "gateway"}
spec = {
    "vennir-default-deny": {"podSelector": {}, "policyTypes": ["Ingress"], "ingress": [{"from": [{"podSelector": {}}]}]},
    "vennir-gateway-ingress": {"podSelector": {"matchLabels": {"vennir/api-backend": "true"}}, "policyTypes": ["Ingress"],
        "ingress": [{"from": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": platform}},
                               "podSelector": {"matchLabels": gateway}}]}]},
    "vennir-no-metadata": {"podSelector": {}, "policyTypes": ["Egress"],
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
  grep -q "not a Vennir team namespace" <<<"$(job "$OTHER_NS" $SOURCE/app:1 run default "")" && break
  sleep 1
done

echo "Dispatch:"
expect "a team namespace"                     allowed                        "$(job "$TEAM_A" $SOURCE/app:1 run default "")"
expect "a namespace without the team label"   "not a Vennir team namespace" "$(job "$OTHER_NS" $SOURCE/app:1 run default "")"
expect "the platform's own namespace"         "not a Vennir team namespace" "$(job "$PLATFORM_NS" $SOURCE/app:1 run default "")"
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

# Resuming a Job it made suspended: the one change it may make to one.
RESUME='{"spec":{"suspend":false}}'
expect "resume its own suspended Job"          allowed                       "$(scheduler_patch "$TEAM_A" ek-suspended "$RESUME")"
expect "resume, and run more Pods"             "may only resume its own"     "$(scheduler_patch "$TEAM_A" ek-suspended '{"spec":{"suspend":false,"parallelism":5}}')"
expect "resume, and move the Pod's node"       "may only resume its own"     "$(scheduler_patch "$TEAM_A" ek-suspended '{"spec":{"suspend":false,"template":{"spec":{"nodeSelector":{"x":"y"}}}}}')"
expect "resume, and label it"                  "may only resume its own"     "$(scheduler_patch "$TEAM_A" ek-suspended '{"metadata":{"labels":{"extra":"x"}},"spec":{"suspend":false}}')"
expect "change a suspended Job, not resuming"  "may only resume its own"     "$(scheduler_patch "$TEAM_A" ek-suspended '{"spec":{"parallelism":5}}')"
expect "suspend a running Job"                 "may only resume its own"     "$(scheduler_patch "$TEAM_A" ek-resumed '{"spec":{"suspend":true}}')"
expect "resume one not labelled its own"       "may only resume its own"     "$(scheduler_patch "$TEAM_A" ek-unlabelled "$RESUME")"
expect "resume in a retired team's"            "TEAM_RETIRED"                "$(scheduler_patch "$RETIRED_NS" ek-suspended "$RESUME")"
expect "resume outside team namespaces"        "may only resume its own"     "$(scheduler_patch "$OTHER_NS" ek-suspended "$RESUME")"

# The Pod's volumes, pull Secret and node, as the executor makes them.
SHAPE="a step's Pod mounts only"
expect "its request ConfigMap, under its Job's name" allowed         "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" ',{"name":"input","configMap":{"name":"policy-check"}}')"
expect "another ConfigMap"                    "$SHAPE"               "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" ',{"name":"input","configMap":{"name":"ek-another"}}')"
expect "the node's filesystem"                "$SHAPE\|must run hardened" "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" ',{"name":"root","hostPath":{"path":"/"}}')"
expect "the node's filesystem, unhardened"    "$SHAPE"               "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" unhardened ',{"name":"root","hostPath":{"path":"/"}}')"
expect "a PersistentVolumeClaim"              "$SHAPE"               "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" ',{"name":"pvc","persistentVolumeClaim":{"claimName":"data"}}')"
expect "the Pod's own details (downward API)" "$SHAPE"               "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" ',{"name":"d","downwardAPI":{"items":[{"path":"l","fieldRef":{"fieldPath":"metadata.labels"}}]}}')"
expect "a ConfigMap in a projected volume"    "$SHAPE"               "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" ',{"name":"p","projected":{"sources":[{"configMap":{"name":"kube-root-ca.crt"}}]}}')"
expect "pulling with vennir-pull"             allowed                "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" "" ',"imagePullSecrets":[{"name":"vennir-pull"}]')"
expect "pulling with another Secret"          "$SHAPE"               "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" "" ',"imagePullSecrets":[{"name":"db-key"}]')"
expect "a node named"                         "$SHAPE"               "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" "" ',"nodeName":"some-node"')"
expect "a capacity's placement"               allowed                "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" "" ',"nodeSelector":{"pool":"spot"},"tolerations":[{"key":"pool","operator":"Equal","value":"spot","effect":"NoSchedule"}]')"
expect "a node selector of its own"           "$SHAPE"               "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" "" ',"nodeSelector":{"kubernetes.io/hostname":"some-node"}')"
expect "a toleration of its own"              "$SHAPE"               "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" "" ',"tolerations":[{"operator":"Exists"}]')"
expect "an affinity, with none configured"    "$SHAPE"               "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" "" ',"affinity":{"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":{"nodeSelectorTerms":[{"matchFields":[{"key":"metadata.name","operator":"In","values":["some-node"]}]}]}}}')"
# The Job the executor makes (helm/tests/step-job.json, which a kernel test
# keeps equal to it), as the scheduler makes it; and below, as anyone else.
step_job() {  # namespace, as (empty: this kubeconfig's user)
  local as=()
  [ -n "${2:-}" ] && as=(--as="$2")
  k ${as[@]+"${as[@]}"} -n "$1" create --dry-run=server -f helm/tests/step-job.json 2>&1
}
expect "the executor's own Job"               allowed                "$(step_job "$TEAM_A" "$SCHEDULER")"

echo "Image sources:"
expect "an image from another registry"       IMAGE_NOT_ALLOWED              "$(job "$TEAM_A" busybox:1.36 run default "")"
# Uppercase anywhere but the tag (a host is case-insensitive; Docker reads
# an uppercase first part as a host).
UPPER="has an uppercase letter"
expect "the source's host in uppercase"       "$UPPER"                       "$(job "$TEAM_A" Registry.Example/app:1 run default "")"
expect "uppercase in the repository"          "$UPPER"                       "$(job "$TEAM_A" $SOURCE/team/App:1 run default "")"
expect "an uppercase short name"              "$UPPER"                       "$(job "$TEAM_A" Busybox:1.36 run default "")"
expect "an uppercase first part, read as a host" "$UPPER"                    "$(job "$TEAM_A" Library/busybox:1.36 run default "")"
expect "uppercase in the tag"                 allowed                        "$(job "$TEAM_A" $SOURCE/app:Latest run default "")"

echo "Step Pods (anyone but Kubernetes' own controllers, such as a team's deploys):"
pod() {  # namespace, metadata JSON, as (empty: this kubeconfig's user)
  local as=()
  [ -n "${3:-}" ] && as=(--as="$3")
  k ${as[@]+"${as[@]}"} -n "$1" create --dry-run=server -f - 2>&1 <<EOF
{"apiVersion":"v1","kind":"Pod","metadata":{"name":"policy-check"$2},
 "spec":{"containers":[{"name":"product","image":"$SOURCE/app:1"}]}}
EOF
}
OWNED_BY_STEP=',"ownerReferences":[{"apiVersion":"batch/v1","kind":"Job","name":"ek-0123","uid":"00000000-0000-0000-0000-000000000000","controller":true}]'
expect "a Pod of its own"                         allowed               "$(pod "$TEAM_A" ',"labels":{"app":"orders"}')"
expect "a Pod with a step's job-name"             STEP_POD_NOT_ALLOWED  "$(pod "$TEAM_A" ',"labels":{"job-name":"ek-0123"}')"
expect "the newer job-name label"                 STEP_POD_NOT_ALLOWED  "$(pod "$TEAM_A" ',"labels":{"batch.kubernetes.io/job-name":"ek-0123"}')"
expect "a Job's controller-uid"                   STEP_POD_NOT_ALLOWED  "$(pod "$TEAM_A" ',"labels":{"batch.kubernetes.io/controller-uid":"00000000-0000-0000-0000-000000000000"}')"
expect "owned by a step's Job"                    STEP_POD_NOT_ALLOWED  "$(pod "$TEAM_A" "$OWNED_BY_STEP")"
expect "the Job controller's"                     allowed               "$(pod "$TEAM_A" ',"labels":{"job-name":"ek-0123"}'"$OWNED_BY_STEP" system:serviceaccount:kube-system:job-controller)"
expect "outside a team namespace"                 allowed               "$(pod "$OTHER_NS" ',"labels":{"job-name":"ek-0123"}')"

echo "Step Jobs and ConfigMaps (anyone but the scheduler and Kubernetes' own controllers):"
STEP_JOB=STEP_JOB_NOT_ALLOWED
expect "the scheduler's request ConfigMap"        allowed      "$(k --as="$SCHEDULER" -n "$TEAM_A" create configmap ek-new --dry-run=server 2>&1)"
expect "another's ConfigMap named ek-"            "$STEP_JOB"  "$(k -n "$TEAM_A" create configmap ek-new --dry-run=server 2>&1)"
expect "another's, generated ek-..."              "$STEP_JOB"  "$(echo '{"apiVersion":"v1","kind":"ConfigMap","metadata":{"generateName":"ek-"}}' | k -n "$TEAM_A" create --dry-run=server -f - 2>&1)"
expect "another's ConfigMap of another name"      allowed      "$(k -n "$TEAM_A" create configmap not-a-step --dry-run=server 2>&1)"
expect "another's named ek-, not a team's"        allowed      "$(k -n "$OTHER_NS" create configmap ek-new --dry-run=server 2>&1)"
expect "another's in a retired team's"            "$STEP_JOB"  "$(k -n "$RETIRED_NS" create configmap ek-new --dry-run=server 2>&1)"
expect "another relabelling a step's ConfigMap"   "$STEP_JOB"  "$(k -n "$TEAM_A" label configmap ek-mine app=other --overwrite --dry-run=server 2>&1)"
expect "another deleting one (can't replace it)"  allowed      "$(k -n "$TEAM_A" delete configmap ek-unlabelled --dry-run=server 2>&1)"
expect "another's Job, as the executor makes it"  "$STEP_JOB"  "$(step_job "$TEAM_A")"
expect "another's CronJob named ek-"               "$STEP_JOB"  "$(k -n "$TEAM_A" create cronjob ek-new --image=busybox --schedule='* * * * *' --dry-run=server 2>&1)"
expect "another's CronJob named ek (its Jobs ek-...)" "$STEP_JOB" "$(k -n "$TEAM_A" create cronjob ek --image=busybox --schedule='* * * * *' --dry-run=server 2>&1)"
expect "another's CronJob named ekx"              allowed      "$(k -n "$TEAM_A" create cronjob ekx --image=busybox --schedule='* * * * *' --dry-run=server 2>&1)"
expect "another's CronJob of another name"        allowed      "$(k -n "$TEAM_A" create cronjob not-a-step --image=busybox --schedule='* * * * *' --dry-run=server 2>&1)"
expect "another's Job of another name"            allowed      "$(sed 's/"ek-db-[0-9a-f]*"/"not-a-step"/' helm/tests/step-job.json | k -n "$TEAM_A" create --dry-run=server -f - 2>&1)"
expect "another resuming a step's Job"            "$STEP_JOB"  "$(k -n "$TEAM_A" patch job ek-suspended --type=merge -p '{"spec":{"suspend":false}}' --dry-run=server 2>&1)"
expect "the Job controller changing one"          allowed      "$(k --as=system:serviceaccount:kube-system:job-controller -n "$TEAM_A" label job ek-suspended x=y --dry-run=server 2>&1)"
expect "the garbage collector changing a ConfigMap" allowed    "$(k --as=system:serviceaccount:kube-system:generic-garbage-collector -n "$TEAM_A" label configmap ek-mine x=y --dry-run=server 2>&1)"

echo "Step identity:"
DB=$SOURCE/db:1@$ZERO_DIGEST
expect "a product's release, as its SA, with its secret" allowed       "$(job "$TEAM_A" $DB create db-sa db-key)"
expect "the same, pinned by digest alone"        allowed               "$(job "$TEAM_A" $SOURCE/db@$ZERO_DIGEST create db-sa db-key)"
expect "a release in a full releases map"        allowed               "$(job "$TEAM_A" $SOURCE/big:1@$PASSED_DIGEST run db-sa db-key)"
expect "any other secret of its team"           allowed               "$(job "$TEAM_A" $DB create db-sa api-token)"
expect "a Secret its team never registered"      IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $DB create db-sa eso-auth)"
expect "another digest in its repository"        IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create db-sa db-key)"
expect "another digest, as its SA, no secrets"   IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create db-sa "")"
expect "another digest, as default"              allowed               "$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create default "")"
expect "its tag, not pinned"                     IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/db:1 create db-sa "")"
expect "its digest from another repository"      IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/app:1@$ZERO_DIGEST create db-sa "")"
expect "a platform product, its team's secret"   allowed               "$(job "$TEAM_B" $SOURCE/platform:2@$PLATFORM_DIGEST run plat-sa b-key)"
expect "a platform product, another team's"      IDENTITY_NOT_ALLOWED  "$(job "$TEAM_B" $SOURCE/platform:2@$PLATFORM_DIGEST run plat-sa db-key)"
expect "the product's release, another action"   IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $DB delete db-sa "")"
expect "a team's product in another team"        IDENTITY_NOT_ALLOWED  "$(job "$TEAM_B" $DB create db-sa "")"
expect "a platform product in any team"          allowed               "$(job "$TEAM_B" $SOURCE/platform:2@$PLATFORM_DIGEST run plat-sa "")"
expect "an unregistered image as a product's SA" IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/app:1 run db-sa "")"
expect "ESO's SA, even registered as a product's" IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/vault:1@$ZERO_DIGEST run eso-gcp "")"
expect "default with a secret"                   IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/app:1 run default db-key)"
# The dispatch policy refuses any valueFrom too; either refusal will do.
expect "a secret through env, not a volume"      "IDENTITY_NOT_ALLOWED\|own entrypoint"  "$(job "$TEAM_A" $SOURCE/app:1 run default "" ',"env":[{"name":"K","valueFrom":{"secretKeyRef":{"name":"db-key","key":"k"}}}]')"
expect "a secret through envFrom"                "IDENTITY_NOT_ALLOWED\|own entrypoint"  "$(job "$TEAM_A" $DB create db-sa "" ',"envFrom":[{"secretRef":{"name":"db-key"}}]')"
# The dispatch policy refuses a projected volume of anything but tokens too.
expect "a secret in a projected volume"          "IDENTITY_NOT_ALLOWED\|mounts only"  "$(job "$TEAM_A" $DB create db-sa "" "" "" ',{"name":"p","projected":{"sources":[{"secret":{"name":"db-key"}}]}}')"
AUDIENCE='{"name":"t","projected":{"sources":[{"serviceAccountToken":{"path":"t","audience":"'
expect "a token for its product's audience"      allowed                "$(job "$TEAM_A" $DB create db-sa "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":3600}}]}}')"
expect "a token for another audience"            IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $DB create db-sa "" "" "" ",$AUDIENCE"'https://example.com","expirationSeconds":3600}}]}}')"
expect "a token lasting over an hour"            IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $DB create db-sa "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":7200}}]}}')"
expect "a token for a step that isn't a product" IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/app:1 run default "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":3600}}]}}')"
expect "a token for another digest in its repository" IDENTITY_NOT_ALLOWED "$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create db-sa "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":3600}}]}}')"
# An upgraded install: the chart keeps the legacy list (by repository, any
# digest) until the console, its rollout over, empties it.
identity_literal "$LEGACY_PRODUCTS" "$TEAM_SECRETS" "$RELEASES"
for _ in $(seq 1 30); do
  grep -q "(server dry run)" <<<"$(job "$TEAM_A" $SOURCE/db:1 create db-sa db-key)" && break
  sleep 1
done
expect "upgraded: the legacy list, by repository" allowed              "$(job "$TEAM_A" $SOURCE/db:1 create db-sa db-key)"
expect "upgraded: and another digest of it"      allowed               "$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create db-sa db-key)"
expect "upgraded: still not another repository" IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/app:1 run db-sa "")"
identity_literal '[]' "$TEAM_SECRETS" "$RELEASES"
for _ in $(seq 1 30); do
  grep -q "IDENTITY_NOT_ALLOWED" <<<"$(job "$TEAM_A" $SOURCE/db:1 create db-sa db-key)" && break
  sleep 1
done
expect "emptied: its tag again refused"          IDENTITY_NOT_ALLOWED  "$(job "$TEAM_A" $SOURCE/db:1 create db-sa db-key)"
expect "emptied: its release still allowed"      allowed               "$(job "$TEAM_A" $DB create db-sa db-key)"

echo "Image scans:"
expect "a digest that passed"                    allowed               "$(job "$TEAM_A" $SOURCE/app:1@$PASSED_DIGEST run default "")"
expect "a digest an admin accepted"              allowed               "$(job "$TEAM_A" $SOURCE/app:1@$ACCEPTED_DIGEST run default "")"
expect "a digest that failed (not listed)"       IMAGE_SCAN_FAILED     "$(job "$TEAM_A" $SOURCE/app:1@$FAILED_DIGEST run default "")"
expect "a digest never scanned"                  IMAGE_SCAN_FAILED     "$(job "$TEAM_A" $SOURCE/app:1@$UNSCANNED_DIGEST run default "")"
expect "unpinned, with requireDigest off"        allowed               "$(job "$TEAM_A" $SOURCE/app:1 run default "")"
expect "a digest that isn't sha256"              IMAGE_SCAN_FAILED     "$(job "$TEAM_A" $SOURCE/app:1@sha512:$(printf 'c%.0s' $(seq 128)) run default "")"
# One of the sixteen maps at the most the console writes in one
# (scanning.ts's MAX_PER_MAP), near the API server's limit on an expression.
scan_literal '{"'$PASSED_DIGEST'":true}' false 1200 c
for _ in $(seq 1 30); do
  grep -q IMAGE_SCAN_FAILED <<<"$(job "$TEAM_A" $SOURCE/app:1@$ACCEPTED_DIGEST run default "")" && break
  sleep 1
done
expect "a full map: a digest in it"              allowed               "$(job "$TEAM_A" $SOURCE/app:1@$PASSED_DIGEST run default "")"
expect "a full map: one that isn't"              IMAGE_SCAN_FAILED     "$(job "$TEAM_A" $SOURCE/app:1@$UNSCANNED_DIGEST run default "")"
# The chart's seed when upgrading from the deny list: what isn't listed is
# admitted, what's listed false isn't (until the console writes its list).
scan_literal '{"'$FAILED_DIGEST'":false}' true
for _ in $(seq 1 30); do
  grep -q "(server dry run)" <<<"$(job "$TEAM_A" $SOURCE/app:1@$UNSCANNED_DIGEST run default "")" && break
  sleep 1
done
expect "upgrade seed: a digest not listed"       allowed               "$(job "$TEAM_A" $SOURCE/app:1@$UNSCANNED_DIGEST run default "")"
expect "upgrade seed: one the deny list had"     IMAGE_SCAN_FAILED     "$(job "$TEAM_A" $SOURCE/app:1@$FAILED_DIGEST run default "")"

echo "Console write fence:"
expect "a Secret in a team namespace"            allowed                     "$(secret "$TEAM_A")"
expect "a Secret in kube-system"                 "may only write in team"    "$(secret kube-system)"
expect "a Secret in the platform's namespace"    "may only write in team"    "$(secret "$PLATFORM_NS")"
expect "a Secret in an API backends' namespace"  "may only write in team"    "$(secret "$APIS_NS")"

echo "Console ExternalSecrets:"
ES_UNLABELLED="carry app.kubernetes.io/managed-by"
expect "create one, labelled the console's"      allowed            "$(external_secret es-new "$CONSOLE_LABELS" | as_console -n "$TEAM_A" create -f -)"
expect "create one without the label"            "$ES_UNLABELLED"   "$(external_secret es-new '{}' | as_console -n "$TEAM_A" create -f -)"
expect "replace the console's own"               allowed            "$(external_secret es-console "$CONSOLE_LABELS" | as_console -n "$TEAM_A" replace -f -)"
expect "replace one it didn't make"              "$ES_UNLABELLED"   "$(external_secret es-other "$CONSOLE_LABELS" | as_console -n "$TEAM_A" replace -f -)"
expect "label one it didn't make its own"        "$ES_UNLABELLED"   "$(as_console -n "$TEAM_A" label externalsecret es-other app.kubernetes.io/managed-by=vennir-console)"
expect "drop its own label"                      "$ES_UNLABELLED"   "$(as_console -n "$TEAM_A" label externalsecret es-console app.kubernetes.io/managed-by-)"
expect "delete one it didn't make"               allowed            "$(as_console -n "$TEAM_A" delete externalsecret es-other)"

echo "Console NetworkPolicies:"
NP_REFUSED="console's NetworkPolicies are"
expect "the default deny"                        allowed          "$(network_policy vennir-default-deny pass)"
expect "the gateway's ingress"                   allowed          "$(network_policy vennir-gateway-ingress pass)"
expect "the no-metadata one"                     allowed          "$(network_policy vennir-no-metadata pass)"
expect "a default deny letting in another namespace" "$NP_REFUSED" "$(network_policy vennir-default-deny 'spec["ingress"][0]["from"][0]["namespaceSelector"] = {}')"
expect "a default deny letting in an address"    "$NP_REFUSED"    "$(network_policy vennir-default-deny 'spec["ingress"][0]["from"] = [{"ipBlock": {"cidr": "0.0.0.0/0"}}]')"
expect "a default deny selecting some Pods"      "$NP_REFUSED"    "$(network_policy vennir-default-deny 'spec["podSelector"] = {"matchLabels": {"a": "b"}}')"
expect "a default deny letting out everything"   "$NP_REFUSED"    "$(network_policy vennir-default-deny 'spec["policyTypes"] = ["Ingress", "Egress"]; spec["egress"] = [{}]')"
expect "a gateway ingress from any namespace"    "$NP_REFUSED"    "$(network_policy vennir-gateway-ingress 'spec["ingress"][0]["from"][0]["namespaceSelector"] = {}')"
expect "a gateway ingress for every Pod"         "$NP_REFUSED"    "$(network_policy vennir-gateway-ingress 'spec["podSelector"] = {}')"
expect "a gateway ingress letting out everything" "$NP_REFUSED"   "$(network_policy vennir-gateway-ingress 'spec["policyTypes"] = ["Ingress", "Egress"]; spec["egress"] = [{}]')"
expect "no-metadata without its exception"       "$NP_REFUSED"    "$(network_policy vennir-no-metadata 'del spec["egress"][0]["to"][0]["ipBlock"]["except"]')"
expect "no-metadata excepting something else"    "$NP_REFUSED"    "$(network_policy vennir-no-metadata 'spec["egress"][0]["to"][0]["ipBlock"]["except"] = ["10.0.0.0/8"]')"
expect "no-metadata letting out to Pods"         "$NP_REFUSED"    "$(network_policy vennir-no-metadata 'spec["egress"].append({"to": [{"podSelector": {}}]})')"
expect "a policy of another name"                "$NP_REFUSED"    "$(network_policy allow-all 'spec["ingress"] = [{}]')"
expect "deleting the default deny"               "$NP_REFUSED"    "$(as_console -n "$TEAM_B" delete networkpolicy vennir-default-deny)"
expect "the default deny, API backends' namespace"   allowed      "$(network_policy vennir-default-deny pass "$APIS_NS")"
expect "the gateway's ingress, API backends' namespace" allowed   "$(network_policy vennir-gateway-ingress pass "$APIS_NS")"
expect "the no-metadata one, API backends' namespace" allowed     "$(network_policy vennir-no-metadata pass "$APIS_NS")"
expect "a gateway ingress for every Pod there"   "$NP_REFUSED"    "$(network_policy vennir-gateway-ingress 'spec["podSelector"] = {}' "$APIS_NS")"
expect "another name, API backends' namespace"   "$NP_REFUSED"    "$(network_policy allow-all 'spec["ingress"] = [{}]' "$APIS_NS")"
expect "labelled API backends', not named <x>-apis" "may only write in team" "$(network_policy vennir-default-deny pass "$NOT_APIS_NS")"

echo "Console quota and limits:"
expect "the team's quota"                        allowed          "$(as_console -n "$TEAM_A" create quota vennir-team-quota --hard=pods=10)"
expect "a quota of another name"                 "only ResourceQuota" "$(as_console -n "$TEAM_A" create quota other --hard=pods=10)"
LIMITS='{"apiVersion":"v1","kind":"LimitRange","metadata":{"name":"NAME"},"spec":{"limits":[{"type":"Container","default":{"cpu":"1"}}]}}'
expect "the team's limits"                       allowed          "$(echo "${LIMITS/NAME/vennir-team-limits}" | as_console -n "$TEAM_A" create -f -)"
expect "limits of another name"                  "only ResourceQuota" "$(echo "${LIMITS/NAME/other}" | as_console -n "$TEAM_A" create -f -)"
expect "a quota in an API backends' namespace"   "may only write in team" "$(as_console -n "$APIS_NS" create quota vennir-team-quota --hard=pods=10)"

echo "Console namespaces:"
expect "create one labelled a team's"            allowed                      "$(new_namespace $RELEASE-new '{"'"$TEAM_LABEL"'":"true"}')"
expect "create one without the label"            "only create a namespace"    "$(new_namespace $RELEASE-plain '{}')"
expect "create a kube-* one"                     "protected"                  "$(new_namespace kube-$RELEASE '{"'"$TEAM_LABEL"'":"true"}')"
expect "retire a team's"                         allowed                      "$(as_console label namespace "$TEAM_A" "$TEAM_LABEL=retired" --overwrite)"
expect "label a namespace that isn't a team's"   "isn't a team's"             "$(as_console label namespace "$OTHER_NS" "$TEAM_LABEL=true")"
expect "label the platform's own"                "protected"                  "$(as_console label namespace "$PLATFORM_NS" "$TEAM_LABEL=true")"
expect "a label value other than true/retired"   "isn't a team's"             "$(as_console label namespace "$TEAM_A" "$TEAM_LABEL=yes" --overwrite)"
expect "change another label too"                "isn't a team's"             "$(as_console label namespace "$TEAM_A" other=1)"
expect "change an annotation"                    "isn't a team's"             "$(as_console annotate namespace "$TEAM_A" note=1)"
expect "create a team's API backends' one"       allowed                      "$(new_namespace $RELEASE-new-apis '{"vennir/api-backends":"true"}')"
expect "an API backends' one not named <x>-apis" "only create a namespace"    "$(new_namespace $RELEASE-new-backends '{"vennir/api-backends":"true"}')"
expect "an API backends' one, retired"           "only create a namespace"    "$(new_namespace $RELEASE-new-apis '{"vennir/api-backends":"retired"}')"
expect "create one with both labels"             "never both"                 "$(new_namespace $RELEASE-both-apis '{"'"$TEAM_LABEL"'":"true","vennir/api-backends":"true"}')"
expect "retire an API backends' one"             allowed                      "$(as_console label namespace "$APIS_NS" vennir/api-backends=retired --overwrite)"
expect "an API backends' one, a team's too"      "never both"                 "$(as_console label namespace "$APIS_NS" "$TEAM_LABEL=true")"
expect "a team's, an API backends' too"          "never both"                 "$(as_console label namespace "$TEAM_A" vennir/api-backends=true)"
expect "an API backends' one, another label"     "isn't a team's"             "$(as_console label namespace "$APIS_NS" other=1)"
expect "relabel one not named <x>-apis"          "isn't a team's"             "$(as_console label namespace "$NOT_APIS_NS" vennir/api-backends=true --overwrite)"

echo "Console purging:"
expect "a retired team namespace"                allowed                      "$(as_console delete namespace "$RETIRED_NS")"
expect "an active team namespace"                "can't be purged"            "$(as_console delete namespace "$TEAM_A")"
expect "kube-system (Kubernetes itself refuses)" "forbidden"                  "$(as_console delete namespace kube-system)"
expect "a protected one, though retired"         "can't be purged"            "$(as_console delete namespace "$PROTECTED_NS")"
expect "a retired API backends' namespace"       allowed                      "$(as_console delete namespace "$RETIRED_APIS_NS")"
expect "an active API backends' namespace"       "can't be purged"            "$(as_console delete namespace "$APIS_NS")"
expect "retired API backends' not named <x>-apis" "can't be purged"           "$(as_console delete namespace "$NOT_APIS_NS")"
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

echo "Gateway tokens, before the console's first write (apiAudiencesWritten false):"
expect "as installed: not yet written"          'apiAudiencesWritten "false"' "$(gateway_seed | grep Written)"
expect "an API's, for any backend audience"      allowed                      "$(token "$TEAM_A" orders-api https://ledger.example)"
expect "for AWS's STS (audience rules only)"     allowed                      "$(token "$TEAM_A" orders-api sts.amazonaws.com)"
expect "an API ServiceAccount no API publishes"  allowed                      "$(token "$TEAM_A" unpublished-api https://orders.example)"
expect "still never for Azure's federation"      "never the Kubernetes API"   "$(token "$TEAM_A" orders-api api://AzureADTokenExchange)"
expect "still never over an hour"                "an hour at most"            "$(token "$TEAM_A" orders-api https://orders.example 7200)"
expect "still never a ServiceAccount not an API's" "only mint tokens for API" "$(token "$TEAM_A" db-sa https://orders.example)"

gateway_literal "$API_AUDIENCES"
API_ONLY="only for the audiences its published API needs"
for _ in $(seq 1 30); do
  grep -q "$API_ONLY" <<<"$(token "$TEAM_A" orders-api sts.amazonaws.com)" && break
  sleep 1
done
echo "Gateway tokens:"
expect "an API's, for its backend"               allowed                      "$(token "$TEAM_A" orders-api https://orders.example)"
expect "a ServiceAccount that isn't an API's"    "only mint tokens for API"   "$(token "$TEAM_A" db-sa https://orders.example)"
expect "an API's outside team namespaces"        "only mint tokens for API"   "$(token "$OTHER_NS" orders-api https://orders.example)"
expect "an API's in a retired team's namespace"  "only mint tokens for API"   "$(token "$RETIRED_NS" orders-api https://orders.example)"
expect "an API's in an API backends' namespace"  "only mint tokens for API"   "$(token "$APIS_NS" orders-api https://orders.example)"
expect "no audience (the Kubernetes API's)"      "never the Kubernetes API"   "$(token "$TEAM_A" orders-api "")"
expect "for the Kubernetes API"                  "never the Kubernetes API"   "$(token "$TEAM_A" orders-api https://kubernetes.default.svc)"
expect "for GKE's API"                           "never the Kubernetes API"   "$(token "$TEAM_A" orders-api https://container.googleapis.com/v1/projects/p)"
expect "for kernel-api"                          "never the Kubernetes API"   "$(token "$TEAM_A" orders-api vennir-kernel-api)"
expect "for Azure's federation"                  "never the Kubernetes API"   "$(token "$TEAM_A" orders-api api://AzureADTokenExchange)"
expect "for a GKE pool's STS audience"           "never the Kubernetes API"   "$(token "$TEAM_A" orders-api identitynamespace:p.svc.id.goog:https://container.googleapis.com/v1/projects/p)"
expect "lasting over an hour"                    "an hour at most"            "$(token "$TEAM_A" orders-api https://orders.example 7200)"
# Each API's ServiceAccount, only what its published API needs: AWS's STS
# (the gateway's own awsSigV4 exchange) for the API that signs in with it,
# never for a backend token's API, nor another API's audience.
expect "for AWS's STS, an awsSigV4 API's"        allowed                      "$(token "$TEAM_A" ledger-api sts.amazonaws.com)"
expect "for the Google pool, a googleIdToken API's" allowed                   "$(token "$TEAM_A" site-api acme.svc.id.goog)"
expect "for AWS's STS, a googleIdToken API's"    "$API_ONLY"                  "$(token "$TEAM_A" site-api sts.amazonaws.com)"
expect "for AWS's STS, a backend token's API"    "$API_ONLY"                  "$(token "$TEAM_A" orders-api sts.amazonaws.com)"
expect "for a Google pool, a backend token's API" "$API_ONLY"                 "$(token "$TEAM_A" orders-api acme.svc.id.goog)"
expect "another API's audience"                  "$API_ONLY"                  "$(token "$TEAM_A" ledger-api https://orders.example)"
expect "an API's, for an audience it doesn't use" "$API_ONLY"                 "$(token "$TEAM_A" orders-api https://ledger.example)"
expect "an API ServiceAccount no API publishes"  "$API_ONLY"                  "$(token "$TEAM_A" unpublished-api https://orders.example)"
expect "the same name in another team"           "$API_ONLY"                  "$(token "$TEAM_B" orders-api https://orders.example)"

echo "Gateway token policy, upgrade seed (lookup):"
SEED=$(gateway_seed)
expect "keeps apiAudiencesWritten"               allowed  "$(echo "$SEED" | grep -q 'apiAudiencesWritten "true"' && echo '(server dry run)' || echo "$SEED")"
expect "keeps each API's audiences, in its map"  allowed  "$(echo "$SEED" | grep -F "$TEAM_A/site-api" | grep -q "^apiAudiences$(printf '%x' $(( ${#TEAM_A} + 9 & 15 ))) " && echo '(server dry run)' || echo "$SEED")"
gateway_literal "$API_AUDIENCES" misplaced
expect "refuses a key in the wrong map"          "length modulo 16"           "$(gateway_seed)"
gateway_literal "$API_AUDIENCES"

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
expect "the scheduler's logs binding"            allowed                "$(binding "$TEAM_A" vennir-scheduler-logs "$LOGS_ROLE")"
expect "another ClusterRole"                     "only RBAC write"      "$(binding "$TEAM_A" vennir-scheduler-logs cluster-admin)"
expect "another subject too"                     "only RBAC write"      "$(binding "$TEAM_A" vennir-scheduler-logs "$LOGS_ROLE" --serviceaccount="$TEAM_A:db-sa")"
expect "another name"                            "only RBAC write"      "$(binding "$TEAM_A" anything "$LOGS_ROLE")"
expect "in kube-system"                          "may only write in team" "$(binding kube-system vennir-scheduler-logs "$LOGS_ROLE")"
# (RBAC's own escalation check, or the fence: refused either way.)
expect "a Role"                                  "forbidden"            "$(as_console -n "$TEAM_A" create role r --verb=get --resource=pods )"

echo "Catalog policies (decision 27: what the catalog decides, written by kernel policy):"
# The kernel chart's, as an upgrade renders them (lookup: seeded from the
# console's identity and gateway token policies, as they are now), and its
# RBAC beside the console chart's (who may update which policy, by name).
# Not the Deployment: no kernel runs here.
# The console's legacy list (by repository, any digest) seeds the kernel's
# only on the upgrade from v0.11 and older: a console policy of that shape
# (no candidates, no release maps), held to the kernel's rules. Rendered,
# not applied, while the kernel's policy isn't there yet.
LEGACY_SEED='[{"team":"'$TEAM_A'","repository":"registry.example/legacy","action":"run","serviceAccount":"legacy-sa","audiences":""},{"team":"","repository":"registry.example/legacy-platform","action":"run","serviceAccount":"plat-sa"},{"team":"'$TEAM_A'","repository":"registry.example/legacy-eso","action":"run","serviceAccount":"eso-gcp","audiences":""},{"team":"'$TEAM_A'","repository":"registry.example/legacy-api","action":"run","serviceAccount":"legacy-api","audiences":""},{"team":"'$TEAM_A'","repository":"registry.example/legacy-kernel","action":"run","serviceAccount":"kernel-sa","audiences":"sts.amazonaws.com,vennir-kernel-api"}]'
console_legacy() {  # "v011" (reshaped as v0.11 rendered it) or "full": the console's identity policy with LEGACY_SEED as its legacy list
  k get validatingadmissionpolicy "$RELEASE-execution-kernel-identity" -o json | python3 -c '
import json, sys
policy = json.load(sys.stdin)
policy["metadata"].get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
# Unconditionally: the API server may still be writing the type-checking
# status of the last replace, which would make this one conflict.
policy["metadata"].pop("resourceVersion", None)
dropped = {"candidates", "digest", "releases"} | {"releases" + d for d in "0123456789abcdef"}
variables = []
for v in policy["spec"]["variables"]:
    if sys.argv[2] == "v011" and v["name"] in dropped:
        continue
    if v["name"] == "products":
        v["expression"] = sys.argv[1]
    if sys.argv[2] == "v011" and v["name"] == "matched":
        v["expression"] = ("variables.products.filter(p, (p.team == \"\" || p.team == request.namespace) && "
                           "p.repository == variables.repository && p.action == variables.action && "
                           "p.serviceAccount == variables.serviceAccount)")
    variables.append(v)
policy["spec"]["variables"] = variables
print(json.dumps(policy))' "$LEGACY_SEED" "$1" | k replace -f - > /dev/null || { echo "  FAIL  writing the console's legacy list ($1)"; FAILURES=$((FAILURES + 1)); }
}
catalog_products() {  # the kernel's catalog-identity policy as an upgrade would render it now: its products literal
  render_catalog | python3 -c '
import json, re, sys
for d in re.split(r"^---$", sys.stdin.read(), flags=re.M):
    if re.search(r"^kind: ValidatingAdmissionPolicy$", d, re.M) and re.search(r"^  name: \S+-catalog-identity$", d, re.M):
        # The chart writes it as toJson | toJson: a JSON string on one line.
        print(json.loads(re.search(r"- name: products\n\s+expression: (.*)$", d, re.M).group(1)))'
}
console_legacy v011
LEGACY_SEEDED=$(catalog_products)
expect "v0.11 upgrade seed: the console's legacy list kept" allowed "$(grep -q 'registry.example/legacy"' <<<"$LEGACY_SEEDED" && echo '(server dry run)' || echo "not seeded: $LEGACY_SEEDED")"
expect "v0.11 upgrade seed: no platform product, ESO's or an API's SA, or a reserved audience" allowed "$(grep -qE 'legacy-(platform|eso|api|kernel)' <<<"$LEGACY_SEEDED" && echo "seeded: $LEGACY_SEEDED" || echo '(server dry run)')"
# The console's policy full again (the chart's render of it), then a newer
# console's legacy list (only one from before writes it, during a
# rollout): never seeded.
ht "$RELEASE" helm/charts/execution-kernel -n "$PLATFORM_NS" ${HELM_CONTEXT_ARGS[@]+"${HELM_CONTEXT_ARGS[@]}"} \
  --dry-run=server --take-ownership --show-only templates/identity-policy.yaml | python3 -c '
import re, sys
print("---".join(d for d in re.split(r"^---$", sys.stdin.read(), flags=re.M) if re.search(r"^kind: ValidatingAdmissionPolicy$", d, re.M)))' \
  | k replace -f - > /dev/null || { echo "  FAIL  restoring the identity policy"; FAILURES=$((FAILURES + 1)); }
identity_literal '[]' "$TEAM_SECRETS" "$RELEASES"
console_legacy full
render_catalog | k apply -f - > /dev/null
identity_literal '[]' "$TEAM_SECRETS" "$RELEASES"
CATALOG_IDENTITY=$RELEASE-execution-kernel-catalog-identity
CATALOG_TOKENS=$RELEASE-execution-kernel-catalog-tokens
POLICY_SA=system:serviceaccount:$PLATFORM_NS:$RELEASE-execution-kernel-policy
seeded() { k get validatingadmissionpolicy "$1" -o jsonpath="{.spec.variables[?(@.name==\"$2\")].expression}"; }
expect "upgrade seed: the console's releases kept" allowed "$(grep -q "$TEAM_A" <<<"$(seeded "$CATALOG_IDENTITY" releases0)" && echo '(server dry run)' || seeded "$CATALOG_IDENTITY" releases0)"
expect "upgrade seed: the console's API audiences kept" allowed "$(grep -q true <<<"$(seeded "$CATALOG_TOKENS" apiAudiencesWritten)" && echo '(server dry run)' || echo 'not seeded')"
expect "upgrade seed: a newer console's legacy list isn't" allowed "$([ "$(seeded "$CATALOG_IDENTITY" products)" = "[]" ] && echo '(server dry run)' || echo "seeded: $(seeded "$CATALOG_IDENTITY" products)")"
# Held to the kernel's rules: no platform product (team ""), no ESO
# ServiceAccount, though the console's lists them.
expect "upgrade seed: no platform product"       allowed "$(grep -q 'plat-sa' <<<"$(seeded "$CATALOG_IDENTITY" releases1)" && echo 'seeded it' || echo '(server dry run)')"
expect "upgrade seed: no ESO ServiceAccount"     allowed "$(grep -q 'eso-gcp' <<<"$(seeded "$CATALOG_IDENTITY" releases0)" && echo 'seeded it' || echo '(server dry run)')"
# What kernel policy writes from the verified release: db's release and
# big's, with their audiences; no platform product (no release names one);
# orders-api's backend audience only.
catalog_literal "$CATALOG_IDENTITY" releases '{"'$ZERO_DIGEST'":[{"action":"create","audiences":"sts.amazonaws.com","repository":"registry.example/db","serviceAccount":"db-sa","team":"'$TEAM_A'"}],"'$PASSED_DIGEST'":[{"action":"run","audiences":"","repository":"registry.example/big","serviceAccount":"db-sa","team":"'$TEAM_A'"}]}'
catalog_literal "$CATALOG_TOKENS" apiAudiences '{"'$TEAM_A'/orders-api":["https://orders.example"]}'
# The console, taken over, loosens its own: another digest of db's
# repository as db's release, and AWS's STS for orders-api.
identity_literal '[]' "$TEAM_SECRETS" '{"'$ZERO_DIGEST'":[{"team":"'$TEAM_A'","repository":"registry.example/db","action":"create","serviceAccount":"db-sa","audiences":"sts.amazonaws.com"}],"'$UNRELEASED_DIGEST'":[{"team":"'$TEAM_A'","repository":"registry.example/db","action":"create","serviceAccount":"db-sa","audiences":"sts.amazonaws.com"}],"'$PLATFORM_DIGEST'":[{"team":"","repository":"registry.example/platform","action":"run","serviceAccount":"plat-sa","audiences":""}]}'
gateway_literal '{"'$TEAM_A'/orders-api":["https://orders.example","sts.amazonaws.com"]}'
for _ in $(seq 1 30); do
  grep -q "catalog's verified release" <<<"$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create db-sa "")" && break
  sleep 1
done
CATALOG_ONLY="the catalog's verified release doesn't name it"
expect "a release both list, as its SA, its secret" allowed             "$(job "$TEAM_A" $DB create db-sa db-key)"
expect "an unreleased digest the console lists"  "$CATALOG_ONLY"        "$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create db-sa "")"
expect "the same, with its team's secret"        "$CATALOG_ONLY"        "$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create db-sa db-key)"
expect "a platform product no release names"     "$CATALOG_ONLY"        "$(job "$TEAM_B" $SOURCE/platform:2@$PLATFORM_DIGEST run plat-sa "")"
expect "an unregistered image as default"        allowed                "$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create default "")"
expect "default with a secret, still"            IDENTITY_NOT_ALLOWED   "$(job "$TEAM_A" $SOURCE/app:1 run default db-key)"
# The console's own rule, which the kernel's doesn't have, still holds.
expect "the console's: a Secret its team never registered" "aren't all registered" "$(job "$TEAM_A" $DB create db-sa eso-auth)"
expect "a token for its product's audience"      allowed                "$(job "$TEAM_A" $DB create db-sa "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":3600}}]}}')"
expect "a token for another digest, the console's listing it" IDENTITY_NOT_ALLOWED "$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create db-sa "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":3600}}]}}')"
for _ in $(seq 1 30); do
  grep -q "catalog's verified release" <<<"$(token "$TEAM_A" orders-api sts.amazonaws.com)" && break
  sleep 1
done
expect "an API's backend audience, both list it" allowed                "$(token "$TEAM_A" orders-api https://orders.example)"
expect "an audience only the console lists"      "catalog's verified release says its API needs" "$(token "$TEAM_A" orders-api sts.amazonaws.com)"
# A token for one of the cluster's own audiences (kernel-api's), though
# both policies list it as the product's: the kernel's refuses it.
catalog_literal "$CATALOG_IDENTITY" releases '{"'$ZERO_DIGEST'":[{"action":"create","audiences":"sts.amazonaws.com,vennir-kernel-api","repository":"registry.example/db","serviceAccount":"db-sa","team":"'$TEAM_A'"}]}'
identity_literal '[]' "$TEAM_SECRETS" '{"'$ZERO_DIGEST'":[{"team":"'$TEAM_A'","repository":"registry.example/db","action":"create","serviceAccount":"db-sa","audiences":"sts.amazonaws.com,vennir-kernel-api"}]}'
for _ in $(seq 1 30); do
  grep -q "this cluster's own" <<<"$(job "$TEAM_A" $DB create db-sa "" "" "" ",$AUDIENCE"'vennir-kernel-api","expirationSeconds":3600}}]}}')" && break
  sleep 1
done
expect "a token for kernel-api's audience, listed" "this cluster's own" "$(job "$TEAM_A" $DB create db-sa "" "" "" ",$AUDIENCE"'vennir-kernel-api","expirationSeconds":3600}}]}}')"
expect "beside it, its cloud's"                  allowed                "$(job "$TEAM_A" $DB create db-sa "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":3600}}]}}')"
catalog_literal "$CATALOG_IDENTITY" releases '{"'$ZERO_DIGEST'":[{"action":"create","audiences":"sts.amazonaws.com","repository":"registry.example/db","serviceAccount":"db-sa","team":"'$TEAM_A'"}],"'$PASSED_DIGEST'":[{"action":"run","audiences":"","repository":"registry.example/big","serviceAccount":"db-sa","team":"'$TEAM_A'"}]}'
identity_literal '[]' "$TEAM_SECRETS" '{"'$ZERO_DIGEST'":[{"team":"'$TEAM_A'","repository":"registry.example/db","action":"create","serviceAccount":"db-sa","audiences":"sts.amazonaws.com"}],"'$UNRELEASED_DIGEST'":[{"team":"'$TEAM_A'","repository":"registry.example/db","action":"create","serviceAccount":"db-sa","audiences":"sts.amazonaws.com"}],"'$PLATFORM_DIGEST'":[{"team":"","repository":"registry.example/platform","action":"run","serviceAccount":"plat-sa","audiences":""}]}'
# Who may write which: RBAC by name (admission policies don't apply to
# admission policy objects). The console's own ClusterRole, as its chart
# grants it, and kernel policy's.
can() { k auth can-i "$2" "validatingadmissionpolicies/$3" --as="$1" 2>/dev/null; }
expect "the console updating the kernel's identity policy" "no"  "$(can "$CONSOLE" update "$CATALOG_IDENTITY")"
expect "the console updating the kernel's token policy"    "no"  "$(can "$CONSOLE" update "$CATALOG_TOKENS")"
expect "the console reading the kernel's identity policy"  allowed "$(can "$CONSOLE" get "$CATALOG_IDENTITY" | sed 's/^yes$/(server dry run)/')"
expect "the console updating its own identity policy"      allowed "$(can "$CONSOLE" update "$RELEASE-execution-kernel-identity" | sed 's/^yes$/(server dry run)/')"
expect "kernel policy updating its own"                    allowed "$(can "$POLICY_SA" update "$CATALOG_IDENTITY" | sed 's/^yes$/(server dry run)/')"
expect "kernel policy updating the console's"              "no"  "$(can "$POLICY_SA" update "$RELEASE-execution-kernel-identity")"
# And a write tried for real (dry run), as the console.
expect "the console replacing the kernel's identity policy" "forbidden" "$(k get validatingadmissionpolicy "$CATALOG_IDENTITY" -o json | k --as="$CONSOLE" replace --dry-run=server -f - 2>&1)"
# The next upgrade: the chart seeds from the kernel's own policy (as
# written), not the console's (loosened above).
render_catalog | k apply -f - > /dev/null
expect "second upgrade: the kernel's literals kept" allowed "$(grep -q 'registry.example/big' <<<"$(seeded "$CATALOG_IDENTITY" releasesc)" && echo '(server dry run)' || echo 'lost')"
expect "second upgrade: not the console's"       allowed "$(grep -q "$UNRELEASED_DIGEST" <<<"$(seeded "$CATALOG_IDENTITY" "releases$(printf %s "$UNRELEASED_DIGEST" | cut -c8)")" && echo 'seeded the console'"'"'s' || echo '(server dry run)')"
expect "second upgrade: still written"           allowed "$(grep -q true <<<"$(seeded "$CATALOG_TOKENS" apiAudiencesWritten)" && echo '(server dry run)' || echo 'reset')"

echo "The console's identity policy beside the kernel's (catalogPolicy: each team's secret names alone):"
# The kernel chart's identity policy as it renders with catalogPolicy on,
# in place of the full one (split: an upgrade after the one that made the
# kernel's policy and binding, which lookup finds); the console writes its
# teamSecrets. Before it, catalogPolicy on, the chart still renders it full.
ht "$RELEASE" helm/charts/execution-kernel -n "$PLATFORM_NS" \
  --set catalogPolicy.enabled=true --set catalogPolicy.release=$SOURCE/catalog-release:latest \
  --set 'catalogPolicy.signature.publicKeys[0]=unused' \
  ${HELM_CONTEXT_ARGS[@]+"${HELM_CONTEXT_ARGS[@]}"} --dry-run=server --take-ownership \
  --show-only templates/identity-policy.yaml | python3 -c '
import re, sys
print("---".join(d for d in re.split(r"^---$", sys.stdin.read(), flags=re.M) if re.search(r"^kind: ValidatingAdmissionPolicy$", d, re.M)))' \
  | k replace -f - > /dev/null || { echo "  FAIL  replacing the identity policy"; FAILURES=$((FAILURES + 1)); }
# Its release maps and legacy list are inert (kept for a console from
# before, during the upgrade): here a console writes another digest of
# db's repository into them, and the legacy list by repository, and
# neither lets anything run.
identity_literal "$LEGACY_PRODUCTS" "$TEAM_SECRETS" '{"'$UNRELEASED_DIGEST'":[{"team":"'$TEAM_A'","repository":"registry.example/db","action":"create","serviceAccount":"db-sa","audiences":"sts.amazonaws.com"}]}'
expect "it matches no releases (no candidates)"  allowed "$([ -z "$(seeded "$RELEASE-execution-kernel-identity" candidates)" ] && echo '(server dry run)' || echo 'it still matches them')"
# Until the API server has the new version: the full one's refusal names
# "a registered product's release". Where both policies refuse, either
# refusal may come back, so every probe must show the new one.
# (Each captured: a refused dry run exits 1, which pipefail would take for
# the grep's answer.)
for _ in $(seq 1 60); do
  probes="$(job "$TEAM_A" $SOURCE/app:1 run default db-key)$(job "$TEAM_A" $SOURCE/db:1 create db-sa "")"
  grep -q "registered product's release" <<<"$probes" || break
  sleep 1
done
expect "a release the kernel lists, its team's secret"  allowed            "$(job "$TEAM_A" $DB create db-sa db-key)"
expect "a token for its product's audience"             allowed            "$(job "$TEAM_A" $DB create db-sa "" "" "" ",$AUDIENCE"'sts.amazonaws.com","expirationSeconds":3600}}]}}')"
expect "a Secret its team never registered (the console's)" "aren't all registered" "$(job "$TEAM_A" $DB create db-sa eso-auth)"
expect "another team's Secret (the console's)"           "aren't all registered" "$(job "$TEAM_A" $DB create db-sa b-key)"
expect "an unreleased digest its inert maps list (the kernel's)" "$CATALOG_ONLY" "$(job "$TEAM_A" $SOURCE/db:1@$UNRELEASED_DIGEST create db-sa "")"
expect "its tag, by the inert legacy list (the kernel's)" "$CATALOG_ONLY"     "$(job "$TEAM_A" $SOURCE/db:1 create db-sa "")"
expect "an unregistered image with a Secret (the kernel's)" "$CATALOG_ONLY"   "$(job "$TEAM_A" $SOURCE/app:1 run default db-key)"
expect "ESO's SA (both)"                                 IDENTITY_NOT_ALLOWED "$(job "$TEAM_A" $SOURCE/vault:1@$ZERO_DIGEST run eso-gcp "")"
expect "an unregistered image as default"                allowed            "$(job "$TEAM_A" $SOURCE/app:1 run default "")"

echo "The identity policy's shape, rendered (candidates: it matches releases):"
shape() {  # release, extra helm arguments: the identity policy rendered, or "not rendered: <helm's error>"
  local release=$1 out; shift
  out=$(ht "$release" helm/charts/execution-kernel -n "$PLATFORM_NS" ${HELM_CONTEXT_ARGS[@]+"${HELM_CONTEXT_ARGS[@]}"} \
    --dry-run=server --take-ownership --show-only templates/identity-policy.yaml "$@" 2>&1)
  if grep -q '^kind: ValidatingAdmissionPolicy$' <<<"$out"; then echo "$out"; else echo "not rendered: $(tail -1 <<<"$out")"; fi
}
form() {  # release, extra helm arguments: full (candidates: it matches releases), split, or not rendered
  local out
  out=$(shape "$@")
  if grep -q '^not rendered' <<<"$out"; then echo "$out"; elif grep -q 'name: candidates' <<<"$out"; then echo full; else echo split; fi
}
CATALOG_ON=(--set catalogPolicy.enabled=true --set catalogPolicy.release=$SOURCE/catalog-release:latest --set 'catalogPolicy.signature.publicKeys[0]=unused')
expect "catalogPolicy on, the kernel's policy there: split" split "$(form "$RELEASE" "${CATALOG_ON[@]}")"
expect "catalogPolicy on, no kernel policy yet: full"      full  "$(form "$RELEASE-none" "${CATALOG_ON[@]}")"
# The kernel's policy holding a legacy list seeded from a v0.11 console's
# (any digest of a repository), the kernel not having written yet: not
# split, or that list would be the only release rule until it does.
kernel_legacy() {  # legacy products JSON ("" removes it), catalog-release annotation
  k get validatingadmissionpolicy "$CATALOG_IDENTITY" -o json | python3 -c '
import json, sys
policy = json.load(sys.stdin)
policy["metadata"].pop("resourceVersion", None)
annotations = policy["metadata"].setdefault("annotations", {})
annotations.pop("kubectl.kubernetes.io/last-applied-configuration", None)
annotations["vennir.dev/catalog-release"] = sys.argv[2]
variables = [v for v in policy["spec"]["variables"] if v["name"] != "products"]
if sys.argv[1]:
    variables.insert(0, {"name": "products", "expression": sys.argv[1]})
policy["spec"]["variables"] = variables
print(json.dumps(policy))' "$1" "$2" | k replace -f - > /dev/null || { echo "  FAIL  writing the kernel policy's legacy list"; FAILURES=$((FAILURES + 1)); }
}
kernel_legacy "$LEGACY_PRODUCTS" ""
expect "kernel policy with a seeded legacy list, unwritten: full" full  "$(form "$RELEASE" "${CATALOG_ON[@]}")"
kernel_legacy "$LEGACY_PRODUCTS" "$SOURCE/catalog-release@$ZERO_DIGEST"
expect "the same, once the kernel has written: split"          split "$(form "$RELEASE" "${CATALOG_ON[@]}")"
kernel_legacy "[]" ""
expect "its legacy list emptied: split"                        split "$(form "$RELEASE" "${CATALOG_ON[@]}")"
kernel_legacy "" ""
# Turning catalogPolicy off again: the releases back from the kernel's
# policy, but never a platform product's (team "": every namespace here).
catalog_literal "$CATALOG_IDENTITY" releases '{"'$ZERO_DIGEST'":[{"action":"create","audiences":"sts.amazonaws.com","repository":"registry.example/db","serviceAccount":"db-sa","team":"'$TEAM_A'"}],"'$PLATFORM_DIGEST'":[{"action":"run","audiences":"","repository":"registry.example/platform","serviceAccount":"plat-sa","team":""}]}'
RESEED=$(shape "$RELEASE")
expect "catalogPolicy off again: full"                  full    "$(form "$RELEASE")"
expect "its releases re-seeded from the kernel's"       allowed "$(grep -q 'registry.example/db' <<<"$RESEED" && echo '(server dry run)' || echo "not seeded: $RESEED")"
expect "but not a platform entry"                       allowed "$(if grep -q '^not rendered' <<<"$RESEED"; then echo "$RESEED"; elif grep -q 'plat-sa' <<<"$RESEED"; then echo 'seeded it'; else echo '(server dry run)'; fi)"

echo "Upgrading from a policy from before released digests (v0.11 and older: no candidates, no release maps):"
# The full policy in place again, then reshaped as v0.11's chart rendered
# it: the legacy products list and teamSecrets, matched by repository. It
# has no candidates either, and must not be taken for the split one: its
# legacy list is kept.
LEGACY_V011='[{"team":"'$TEAM_A'","repository":"registry.example/legacy-v011","action":"run","serviceAccount":"legacy-sa","audiences":""}]'
shape "$RELEASE" | python3 -c '
import re, sys
print("---".join(d for d in re.split(r"^---$", sys.stdin.read(), flags=re.M) if re.search(r"^kind: ValidatingAdmissionPolicy$", d, re.M)))' \
  | k replace -f - > /dev/null || { echo "  FAIL  replacing the identity policy"; FAILURES=$((FAILURES + 1)); }
k get validatingadmissionpolicy "$RELEASE-execution-kernel-identity" -o json | python3 -c '
import json, sys
policy = json.load(sys.stdin)
policy["metadata"].get("annotations", {}).pop("kubectl.kubernetes.io/last-applied-configuration", None)
# Unconditionally: the API server writes the type-checking status of the policy
# just after the replace above, which would make this one conflict.
policy["metadata"].pop("resourceVersion", None)
dropped = {"candidates", "digest", "releases"} | {"releases" + d for d in "0123456789abcdef"}
variables = []
for v in policy["spec"]["variables"]:
    if v["name"] in dropped:
        continue
    if v["name"] == "products":
        v["expression"] = sys.argv[1]
    if v["name"] == "matched":
        v["expression"] = ("variables.products.filter(p, (p.team == \"\" || p.team == request.namespace) && "
                           "p.repository == variables.repository && p.action == variables.action && "
                           "p.serviceAccount == variables.serviceAccount)")
    variables.append(v)
policy["spec"]["variables"] = variables
print(json.dumps(policy))' "$LEGACY_V011" \
  | k replace -f - > /dev/null || { echo "  FAIL  writing a v0.11-shaped identity policy"; FAILURES=$((FAILURES + 1)); }
expect "it is v0.11's shape (no candidates, no releases0)" allowed "$([ -z "$(seeded "$RELEASE-execution-kernel-identity" candidates)$(seeded "$RELEASE-execution-kernel-identity" releases0)" ] && echo '(server dry run)' || echo 'not reshaped')"
V011=$(shape "$RELEASE")
expect "catalogPolicy off: full"                        full    "$(form "$RELEASE")"
expect "its legacy list kept"                           allowed "$(grep -q 'registry.example/legacy-v011' <<<"$V011" && echo '(server dry run)' || echo "dropped: $(grep -A1 'name: products$' <<<"$V011")")"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES case(s) failed"
  exit 1
fi
echo "All cases passed."
