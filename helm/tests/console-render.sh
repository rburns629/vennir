#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# The console chart's refusals, as rendered without a cluster (helm
# template): no cluster needed, CI's helm job runs it.
set -uo pipefail
cd "$(dirname "$0")/../.."

FAILURES=0
ok() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n        %s\n' "$1" "$2"; FAILURES=$((FAILURES + 1)); }
render() { helm template console helm/charts/execution-console --set kernelApiUrl=http://unused --set gateway.enabled=true "$@" --show-only templates/gateway.yaml 2>&1; }

# Every API's pages are on the gateway's origin, never the console's, where
# a backend's script could read the console's session token.
for args in "--set ingress.host=console.example.com --set gateway.publicUrl=https://console.example.com" \
  "--set ingress.host=console.example.com --set gateway.ingress.host=Console.Example.com" \
  "--set gatewayApi.host=console.example.com --set gateway.publicUrl=https://console.example.com:8443/"; do
  # shellcheck disable=SC2086 # the flags, split on purpose
  if grep -q "is the console's" <<<"$(render $args)"; then ok "the gateway on the console's host refused: $args"
  else fail "the gateway on the console's host" "$args rendered"; fi
done
own=$(render --set ingress.host=console.example.com --set gateway.ingress.host=api.example.com --set gateway.publicUrl=https://api.example.com)
if ! grep -q "is the console's" <<<"$own" && grep -q "^kind: Deployment" <<<"$own"; then
  ok "a host of its own renders"
else fail "a host of its own" "refused"; fi

# On GKE's load balancer: Google's certificate for the host, and its health
# check on the public listener's /.vennir/health, tied to the Service's
# public port; none of it without gateway.ingress.gke.
public=(--set gateway.publicListener=true --set gateway.ingress.enabled=true --set gateway.ingress.host=api.example.com)
gke=$(render "${public[@]}" --set gateway.ingress.gke=true)
if grep -q "^kind: ManagedCertificate" <<<"$gke" && grep -q 'domains: \["api.example.com"\]' <<<"$gke" &&
  grep -q "^kind: BackendConfig" <<<"$gke" && grep -q "requestPath: /.vennir/health" <<<"$gke" &&
  grep -q 'networking.gke.io/managed-certificates: console-execution-console-gateway' <<<"$gke" &&
  grep -qF 'cloud.google.com/backend-config: "{\"ports\": {\"public\": \"console-execution-console-gateway\"}}"' <<<"$gke"; then
  ok "GKE: its certificate and health check, tied to the Ingress and the public port"
else fail "GKE's certificate and health check" "$(grep -n 'kind:\|google\|gke' <<<"$gke" | head)"; fi
! grep -q "ManagedCertificate\|BackendConfig\|cloud.google.com" <<<"$(render "${public[@]}")" && ok "not on GKE: none of it" || fail "without gke" "rendered GKE's objects"
grep -q "gke needs gateway.ingress.host" <<<"$(render --set gateway.publicListener=true --set gateway.ingress.enabled=true --set gateway.ingress.gke=true)" \
  && ok "GKE without a host: refused" || fail "GKE without a host" "rendered"

[ "$FAILURES" -eq 0 ] && echo "All cases passed." || { echo "$FAILURES failed."; exit 1; }
