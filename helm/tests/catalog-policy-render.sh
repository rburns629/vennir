#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# The kernel chart's catalog policies (catalogPolicy, decision 27) as
# rendered without a cluster (helm template, a GitOps tool): no lookup, so
# empty maps and apiAudiencesWritten false, a step refused until kernel
# policy writes them; and the settings the chart refuses. No cluster
# needed: CI's helm job runs it. With lookup (an upgrade), see
# admission-policies.sh.
set -uo pipefail
cd "$(dirname "$0")/../.."

FAILURES=0
ok() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n        %s\n' "$1" "$2"; FAILURES=$((FAILURES + 1)); }
on=(--set catalogPolicy.enabled=true --set catalogPolicy.release=r.example/catalog-release:latest
  --set 'catalogPolicy.signature.publicKeys[0]=k' --set catalogPolicy.gateway.serviceAccount=console-execution-console-gateway)

rendered=$(helm template kernel helm/charts/execution-kernel "${on[@]}" --show-only templates/catalog-policy.yaml)
literals=$(echo "$rendered" | python3 -c '
import re, sys, json
docs = re.split(r"^---$", sys.stdin.read(), flags=re.M)
out = {}
for d in docs:
    name = re.search(r"^  name: (\S+)$", d, re.M)
    if not re.search(r"^kind: ValidatingAdmissionPolicy$", d, re.M):
        continue
    for var, expr in re.findall(r"- name: (releases[0-9a-f]|apiAudiences[0-9a-f]|apiAudiencesWritten)\n\s+expression: (.*)", d):
        out[name.group(1) + "/" + var] = json.loads(expr)
print(json.dumps(out))')
python3 -c '
import json, sys
v = json.loads(sys.argv[1])
maps = [k for k in v if not k.endswith("Written")]
assert len(maps) == 32, len(maps)
assert all(v[k] == "{}" for k in maps), "a map seeded with no lookup"
assert v["kernel-execution-kernel-catalog-tokens/apiAudiencesWritten"] == "false"' "$literals" \
  && ok "no lookup: every map empty, apiAudiencesWritten false" || fail "no lookup" "$literals"

# How long an unfinished execution keeps an earlier release: at least the
# scheduler's approval timeout.
in_use() { helm template kernel helm/charts/execution-kernel "${on[@]}" "$@" --show-only templates/configmap.yaml 2>&1 | grep -o 'CATALOG_POLICY_IN_USE_MAX_SECONDS: "[0-9]*"'; }
[ "$(in_use)" = 'CATALOG_POLICY_IN_USE_MAX_SECONDS: "259200"' ] && ok "in use: three days by default" || fail "in use, by default" "$(in_use)"
[ "$(in_use --set scheduler.approvalTimeoutSeconds=604800)" = 'CATALOG_POLICY_IN_USE_MAX_SECONDS: "604800"' ] \
  && ok "in use: the approval timeout, when longer" || fail "in use, a week's approval" "$(in_use --set scheduler.approvalTimeoutSeconds=604800)"
limit() { helm template kernel helm/charts/execution-kernel "${on[@]}" "$@" --show-only templates/configmap.yaml 2>&1 | grep -o 'CATALOG_POLICY_IN_USE_LIMIT_SECONDS: "[0-9]*"'; }
[ "$(limit)" = 'CATALOG_POLICY_IN_USE_LIMIT_SECONDS: "604800"' ] && ok "in-use limit: a week by default" || fail "in-use limit, by default" "$(limit)"
[ "$(limit --set scheduler.approvalTimeoutSeconds=604800)" = 'CATALOG_POLICY_IN_USE_LIMIT_SECONDS: "1209600"' ] \
  && ok "in-use limit: twice the in-use bound, when longer" || fail "in-use limit, a week's approval" "$(limit --set scheduler.approvalTimeoutSeconds=604800)"
low=$(helm template kernel helm/charts/execution-kernel "${on[@]}" --set catalogPolicy.inUseLimitSeconds=3600 --show-only templates/configmap.yaml 2>&1)
if echo "$low" | grep -q "must be at least the in-use bound"; then ok "in-use limit: refused under the in-use bound"
else fail "in-use limit under the in-use bound" "rendered"; fi
short=$(helm template kernel helm/charts/execution-kernel "${on[@]}" --set scheduler.approvalTimeoutSeconds=604800 --set catalogPolicy.inUseMaxSeconds=3600 \
  --show-only templates/configmap.yaml 2>&1)
if echo "$short" | grep -q "must be at least scheduler.approvalTimeoutSeconds"; then ok "in use: refused under the approval timeout"
else fail "in use under the approval timeout" "rendered"; fi

# kernel policy signs in as its own database role (catalogPolicy.database):
# with the bundled Postgres, the chart's, from a Secret of its own, which
# the migration Job makes and kernel migrate grants; never the kernel's.
deployment=$(helm template kernel helm/charts/execution-kernel "${on[@]}" --show-only templates/catalog-policy.yaml | python3 -c '
import re, sys
for d in re.split(r"^---$", sys.stdin.read(), flags=re.M):
    if re.search(r"^kind: Deployment$", d, re.M):
        m = re.search(r"- name: DATABASE_URL\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: (\S+)\n\s+key: (\S+)", d)
        print(m.group(1) + "/" + m.group(2) if m else "none")')
[ "$deployment" = "kernel-execution-kernel-policy-db/database-url" ] && ok "its own role: the policy Pod reads its own Secret" || fail "the policy Pod's database Secret" "$deployment"
job=$(helm template kernel helm/charts/execution-kernel "${on[@]}" --show-only templates/migration-job.yaml)
if echo "$job" | grep -q 'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT' \
  && echo "$job" | grep -A1 'name: CATALOG_POLICY_DATABASE_ROLE' | grep -q '"vennir_kernel_policy"'; then
  ok "its own role: made by the migration Job, and granted by kernel migrate"
else fail "the migration Job and kernel policy's role" "rendered"; fi
secrets=$(helm template kernel helm/charts/execution-kernel "${on[@]}" --show-only templates/secret.yaml)
echo "$secrets" | grep -q '^  name: kernel-execution-kernel-policy-db$' && echo "$secrets" | grep -q 'postgresql://vennir_kernel_policy:' \
  && ok "its own role: a Secret of its own signing in as it" || fail "kernel policy's Secret" "rendered"
off=$(helm template kernel helm/charts/execution-kernel "${on[@]}" --set postgres.auth.policyUsername= --show-only templates/catalog-policy.yaml | grep -A3 'name: DATABASE_URL' | grep -o 'name: kernel-execution-kernel-db[^ ]*\|name: kernel-execution-kernel\b' | head -1)
[ -n "$off" ] && ok "no policyUsername: it signs in as the kernel's, as before" || fail "no policyUsername" "$off"
noSecret=$(helm template kernel helm/charts/execution-kernel "${on[@]}" --set postgres.enabled=false --set externalDatabaseUrl=postgresql://k@db/k \
  --set catalogPolicy.database.role=policy 2>&1)
echo "$noSecret" | grep -q "catalogPolicy.database.role needs catalogPolicy.database.existingSecret" \
  && ok "a role named without its Secret: refused" || fail "a role without its Secret" "rendered"

# The console's identity policy splits only once lookup finds the kernel's
# policy and binding: never without a cluster (admission-policies.sh
# covers the split).
identity=$(helm template kernel helm/charts/execution-kernel "${on[@]}" --show-only templates/identity-policy.yaml)
if echo "$identity" | grep -q "name: candidates"; then ok "no lookup, catalogPolicy on: the console's policy full (candidates)"
else fail "no lookup, catalogPolicy on" "rendered split"; fi
identity=$(helm template kernel helm/charts/execution-kernel --show-only templates/identity-policy.yaml)
if echo "$identity" | grep -q "name: candidates"; then ok "catalogPolicy off: full (candidates)"; else fail "catalogPolicy off" "rendered split"; fi

refused() {  # label, the error it must say, helm arguments
  local label=$1 want=$2; shift 2
  local out
  out=$(helm template kernel helm/charts/execution-kernel "$@" --show-only templates/catalog-policy.yaml 2>&1)
  if echo "$out" | grep -q -- "$want"; then ok "$label"; else fail "$label" "$(echo "$out" | tail -1)"; fi
}
refused "refused without identityPolicy"   "needs identityPolicy.enabled" "${on[@]}" --set identityPolicy.enabled=false
refused "refused without a release"        "catalogPolicy.release"        --set catalogPolicy.enabled=true --set 'catalogPolicy.signature.publicKeys[0]=k'
refused "refused with no signer to trust"  "catalogPolicy.signature"      --set catalogPolicy.enabled=true --set catalogPolicy.release=r/c:l

# Another install's catalog by federation: its own token, projected for
# the other side alone, and the settings that say where; one side only.
gcp_fed=(--set catalogPolicy.registry.federation.gcp.workloadIdentityProvider=projects/1/locations/global/workloadIdentityPools/p/providers/q
  --set catalogPolicy.registry.federation.gcp.serviceAccount=reader@owner.iam.gserviceaccount.com
  --set 'catalogPolicy.registry.federation.hosts[0]=us-central1-docker.pkg.dev')
policy() { helm template kernel helm/charts/execution-kernel "${on[@]}" "$@" --show-only templates/catalog-policy.yaml --show-only templates/configmap.yaml 2>&1; }
fed=$(policy "${gcp_fed[@]}")
if grep -q 'audience: "https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q"' <<<"$fed" &&
  grep -q 'mountPath: /var/run/vennir/federation' <<<"$fed" && grep -qF 'CATALOG_POLICY_FEDERATION_HOSTS: "[\"us-central1-docker.pkg.dev\"]"' <<<"$fed" &&
  grep -q 'CATALOG_POLICY_FEDERATION_TOKEN_FILE: /var/run/vennir/federation/token' <<<"$fed"; then ok "federation to Google: its token, for the provider"
else fail "federation to Google" "$(grep -n 'federation\|FEDERATION\|audience' <<<"$fed" | head)"; fi
aws_fed=$(policy --set catalogPolicy.registry.federation.aws.roleArn=arn:aws:iam::111111111111:role/r \
  --set 'catalogPolicy.registry.federation.hosts[0]=111111111111.dkr.ecr.us-east-2.amazonaws.com')
grep -q 'audience: "sts.amazonaws.com"' <<<"$aws_fed" && ok "federation to AWS: its token, for STS" || fail "federation to AWS" "no STS audience"
! grep -qi 'federation' <<<"$(policy)" && ok "no federation: no token, no settings" || fail "no federation" "rendered some"
grep -q "not both" <<<"$(policy "${gcp_fed[@]}" --set catalogPolicy.registry.federation.aws.roleArn=arn:aws:iam::111111111111:role/r)" \
  && ok "federation refused: both sides" || fail "federation, both sides" "rendered"
grep -q "federation.hosts" <<<"$(policy --set catalogPolicy.registry.federation.gcp.workloadIdentityProvider=p)" \
  && ok "federation refused: no hosts" || fail "federation, no hosts" "rendered"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES case(s) failed"
  exit 1
fi
echo "All cases passed."
