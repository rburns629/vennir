#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# A team's secret, end to end, on a kind install (make kind-e2e-secrets):
# a team's SecretStore (ESO's fake provider, which needs no cloud) syncs a
# value into its namespace; a product registered with it reads it in a
# step, which reports only its SHA-256; and a step not of a registered
# product, or of another team, naming the same Secret is refused before it
# runs (IDENTITY_NOT_ALLOWED). Everything it makes is retired and purged at
# the end. With a signed catalog, whose policies the kernel writes (decision
# 27), the product, registered by hand, is refused instead, and a product of
# the catalog's verified release (the local sample's) runs.
#
#   CONSOLE_URL      the console (default http://localhost:18080, make up's)
#   ADMIN_EMAIL      default admin@example.com
#   ADMIN_PASSWORD   required (never printed)
#   KUBE_CONTEXT     default kind-vennir-local
#   REGISTRY         the image source steps may come from (default localhost:5001)
set -euo pipefail

CONSOLE_URL=${CONSOLE_URL:-http://localhost:18080}
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}
KUBE_CONTEXT=${KUBE_CONTEXT:-kind-vennir-local}
REGISTRY=${REGISTRY:-localhost:5001}
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD to the console admin password}"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

suffix=$(openssl rand -hex 3)
TEAM="e2e-sec-$suffix"
OTHER="e2e-oth-$suffix"
VALUE="e2e-value-$suffix-$(openssl rand -hex 12)"
WANT=$(printf %s "$VALUE" | shasum -a 256 | cut -d' ' -f1)
failures=0

pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failures=$((failures + 1)); }

# Calls a console method, signed in; prints the JSON answer.
rpc() {
  curl -sS -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
    -d "$2" "$CONSOLE_URL/api/vennir.console.v1.$1"
}
TOKEN=$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email: $e, password: $p}' |
  curl -sS -X POST -H 'Content-Type: application/json' -d @- "$CONSOLE_URL/api/vennir.console.v1.AuthService/Login" | jq -r '.token // empty')
[ -n "$TOKEN" ] || { echo "couldn't sign in as $ADMIN_EMAIL at $CONSOLE_URL"; exit 1; }

# Undoes it all: the product, its image repository's claim, the teams, and
# their namespaces (which purging leaves, labelled retired).
cleanup() {
  rpc ProductService/DeleteProduct "$(jq -nc --arg n "$TEAM-digest" '{name: $n}')" > /dev/null || true
  rpc ProductService/ReleaseImageRepository "$(jq -nc --arg r "$REGISTRY/vennir-e2e/secret-digest" '{repository: $r}')" > /dev/null || true
  for team in "$TEAM" "$OTHER"; do
    rpc TeamService/RetireTeam "$(jq -nc --arg n "$team" '{name: $n}')" > /dev/null || true
    rpc TeamService/PurgeTeam "$(jq -nc --arg n "$team" '{name: $n}')" > /dev/null || true
    kubectl --context "$KUBE_CONTEXT" delete namespace "$team" --ignore-not-found --wait=false > /dev/null || true
  done
}
trap cleanup EXIT

# The kernel's test fixture (its secret-digest action), by digest.
image_for() {  # repository name under $REGISTRY/vennir-e2e
  local ref="$REGISTRY/vennir-e2e/$1:latest"
  docker build -q -t "$ref" "$ROOT/kernel/internal/kindtest/fixture" > /dev/null
  docker push -q "$ref" > /dev/null
  docker inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" | grep "^$REGISTRY/vennir-e2e/$1@" | head -1
}
PRODUCT_IMAGE=$(image_for secret-digest)
UNREGISTERED_IMAGE=$(image_for unregistered)

for team in "$TEAM" "$OTHER"; do
  rpc TeamService/CreateTeam "$(jq -nc --arg n "$team" '{name: $n}')" | jq -e '.team' > /dev/null
  rpc TeamService/AddMember "$(jq -nc --arg n "$team" --arg e "$ADMIN_EMAIL" '{team: $n, email: $e}')" > /dev/null
done

# The team's reviewed SecretStore file: ESO's fake provider, holding VALUE.
store=$(jq -nc --arg v "$VALUE" '{apiVersion: "external-secrets.io/v1", kind: "SecretStore",
  metadata: {name: "fake"}, spec: {provider: {fake: {data: [{key: "e2e/token", value: $v}]}}}}')
answer=$(rpc TeamService/ApplySecretStore "$(jq -nc --arg t "$TEAM" --argjson s "$store" '{team: $t, documents: [$s]}')")
if [ "$(jq -r '.code // "ok"' <<< "$answer")" = ok ]; then pass "the team's SecretStore is applied"; else fail "ApplySecretStore: $answer"; fi
answer=$(rpc SecretService/SyncSecret "$(jq -nc --arg t "$TEAM" \
  '{team: $t, secretName: "e2e-token", secretStoreName: "fake", keys: [{secretKey: "token", remoteKey: "e2e/token"}]}')")
if [ "$(jq -r '.code // "ok"' <<< "$answer")" = ok ]; then pass "the team's secret syncs from it"; else fail "SyncSecret: $answer"; fi

for _ in $(seq 1 60); do
  kubectl --context "$KUBE_CONTEXT" -n "$TEAM" get secret e2e-token > /dev/null 2>&1 && break
  sleep 2
done
if kubectl --context "$KUBE_CONTEXT" -n "$TEAM" get secret e2e-token > /dev/null 2>&1; then
  pass "ESO wrote the Secret into the team's namespace"
else
  fail "no Secret e2e-token in $TEAM after two minutes"
fi

# As catalog CI registers a product: its image, its secret.
answer=$(rpc ProductService/RegisterProduct "$(jq -nc --arg t "$TEAM" --arg i "$PRODUCT_IMAGE" '{name: ($t + "-digest"),
  image: $i, action: "secret-digest", team: $t, secretRefs: ["e2e-token"],
  inputSchema: {type: "object"}, outputSchema: {type: "object"}}')")
if [ "$(jq -r '.code // "ok"' <<< "$answer")" = ok ]; then pass "the product is registered with the secret"; else fail "RegisterProduct: $answer"; fi

# Runs one step; prints the execution's JSON once it's finished.
run_step() {  # team image
  local submitted id state
  submitted=$(rpc ExecutionService/SubmitExecution "$(jq -nc --arg t "$1" --arg i "$2" --arg r "e2e-$suffix-$RANDOM" \
    '{dag: {name: "secrets e2e", requestId: $r, tasks: [{id: "read", image: $i, action: "secret-digest", team: $t, secretRefs: ["e2e-token"]}]}}')")
  id=$(jq -r '.executionId // empty' <<< "$submitted")
  if [ -z "$id" ]; then echo "$submitted"; return; fi
  for _ in $(seq 1 90); do
    execution=$(rpc ExecutionService/GetExecution "$(jq -nc --arg id "$id" '{executionId: $id}')")
    state=$(jq -r '.execution.state' <<< "$execution")
    case "$state" in *SUCCEEDED|*FAILED|*CANCELLED) echo "$execution"; return ;; esac
    sleep 2
  done
  echo "$execution"
}

# Who writes the cluster's policies of what the catalog decides (decision
# 27): with a signed catalog, the kernel, from the release it verified; then
# a product registered by hand, as this one is, doesn't run as its product,
# and the console says so before submitting it.
WRITER=$(rpc AdminService/GetPolicySync '{}' | jq -r '.catalog.writer // "console"')
if [ "$WRITER" = kernel ]; then
  answer=$(run_step "$TEAM" "$PRODUCT_IMAGE")
  if jq -e '.code == "failed_precondition" and (.message | test("policy doesn.t list"))' <<< "$answer" > /dev/null; then
    pass "with a signed catalog, a product registered by hand doesn't run as its product (IDENTITY_PENDING)"
  else
    fail "a product no signed release names: $(jq -c '{code, message, state: .execution.state}' <<< "$answer")"
  fi
  # A product of the verified release does: its Job passes the kernel's
  # catalog policy and the console's.
  catalog_image=$(rpc ProductService/ListProducts '{}' | jq -r '.products[] | select(.name == "local-upper-case-transform") | .image')
  submitted=$(rpc ExecutionService/SubmitExecution "$(jq -nc --arg i "$catalog_image" --arg r "e2e-$suffix-catalog" \
    '{dag: {name: "secrets e2e: a catalog product", requestId: $r, tasks: [{id: "up", image: $i, action: "transform", team: "local", inputs: {text: "vennir"}}]}}')")
  id=$(jq -r '.executionId // empty' <<< "$submitted")
  state=none
  for _ in $(seq 1 90); do
    [ -n "$id" ] || break
    state=$(rpc ExecutionService/GetExecution "$(jq -nc --arg id "$id" '{executionId: $id}')" | jq -r '.execution.state')
    case "$state" in *SUCCEEDED|*FAILED|*CANCELLED) break ;; esac
    sleep 2
  done
  case "$state" in *SUCCEEDED) pass "a product of the catalog's verified release runs as its product" ;;
    *) fail "the local sample's upper-case product (local must be published: make catalog-publish): ${id:-$submitted} $state" ;;
  esac
else
  got=$(run_step "$TEAM" "$PRODUCT_IMAGE" | jq -r '.execution.tasks[0].outputs.digests["e2e-token/token"] // empty')
  if [ "$got" = "$WANT" ]; then pass "the product's step read the synced value (its SHA-256 matches)"; else fail "the product's step read ${got:-nothing}, not the value's SHA-256"; fi
fi

# The code a step was refused with: the console's, before it's submitted
# (its copy of the identity policy's rule), or the cluster's, as it starts.
refused() {
  jq -r '[.execution.tasks[0].failure.code, .code] | map(select(. != null)) | first // "nothing"'
}
code=$(run_step "$TEAM" "$UNREGISTERED_IMAGE" | refused)
case "$code" in IDENTITY_NOT_ALLOWED|permission_denied)
  pass "an image no product registered can't mount it ($code)" ;;
  *) fail "an unregistered image naming the secret: $code" ;;
esac
code=$(run_step "$OTHER" "$PRODUCT_IMAGE" | refused)
case "$code" in IDENTITY_NOT_ALLOWED|permission_denied)
  pass "another team can't mount it ($code)" ;;
  *) fail "another team naming the secret: $code" ;;
esac

echo
if [ "$failures" -gt 0 ]; then echo "$failures failed"; exit 1; fi
echo "All passed."
