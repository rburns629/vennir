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

refused() {  # label, the error it must say, helm arguments
  local label=$1 want=$2; shift 2
  local out
  out=$(helm template kernel helm/charts/execution-kernel "$@" --show-only templates/catalog-policy.yaml 2>&1)
  if echo "$out" | grep -q -- "$want"; then ok "$label"; else fail "$label" "$(echo "$out" | tail -1)"; fi
}
refused "refused without identityPolicy"   "needs identityPolicy.enabled" "${on[@]}" --set identityPolicy.enabled=false
refused "refused without a release"        "catalogPolicy.release"        --set catalogPolicy.enabled=true --set 'catalogPolicy.signature.publicKeys[0]=k'
refused "refused with no signer to trust"  "catalogPolicy.signature"      --set catalogPolicy.enabled=true --set catalogPolicy.release=r/c:l

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES case(s) failed"
  exit 1
fi
echo "All cases passed."
