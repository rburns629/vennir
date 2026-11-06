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
render() { helm template console helm/charts/execution-console --set gateway.enabled=true "$@" --show-only templates/gateway.yaml 2>&1; }

# Every API's pages are on the gateway's origin, never the console's, where
# a backend's script could read the console's session token.
for args in "--set ingress.host=console.example.com --set gateway.publicUrl=https://console.example.com" \
  "--set ingress.host=console.example.com --set gateway.ingress.host=Console.Example.com" \
  "--set gatewayApi.host=console.example.com --set gateway.publicUrl=https://console.example.com:8443/"; do
  # shellcheck disable=SC2086 # the flags, split on purpose
  if grep -q "is the console's" <<<"$(render $args)"; then ok "the gateway on the console's host refused: $args"
  else fail "the gateway on the console's host" "$args rendered"; fi
done
if ! grep -q "is the console's" <<<"$(render --set ingress.host=console.example.com --set gateway.ingress.host=api.example.com --set gateway.publicUrl=https://api.example.com)"; then
  ok "a host of its own renders"
else fail "a host of its own" "refused"; fi

[ "$FAILURES" -eq 0 ] && echo "All cases passed." || { echo "$FAILURES failed."; exit 1; }
