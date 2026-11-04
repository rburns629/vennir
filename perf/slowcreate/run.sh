#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Installs (up) or removes (down) the slowcreate webhook on the performance
# cluster, vennir-perf, and nowhere else: every first create of a Job in the
# perf namespace is held for DELAY (default 8s) before the API server makes
# it, plus up to JITTER more at random. The kernel's Kubernetes request
# timeout is 3 s here (perf/slowcreate/kernel.yaml): DELAY=8s shows a create
# the API server abandons with the kernel; DELAY=2.7s JITTER=0.5s, creates
# made just before the kernel gives up, which time out but happen.
# perf/README.md, "A create that timed out", has the runbook.
set -euo pipefail

CONTEXT=kind-vennir-perf
NS=slowcreate
IMAGE=localhost:5001/slowcreate:dev
DELAY=${DELAY:-8s}
JITTER=${JITTER:-0s}
here=$(cd "$(dirname "$0")" && pwd)
k() { kubectl --context "$CONTEXT" "$@"; }

if [ "$(kubectl config current-context)" != "$CONTEXT" ]; then
  echo "kubectl's context is $(kubectl config current-context), not $CONTEXT: refusing." >&2
  exit 1
fi

case "${1:-}" in
up)
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  arch=$(docker info --format '{{.Architecture}}' | sed 's/x86_64/amd64/; s/aarch64/arm64/')
  (cd "$here" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -o "$work/slowcreate" .)
  printf 'FROM scratch\nCOPY slowcreate /slowcreate\nUSER 65532\nENTRYPOINT ["/slowcreate"]\n' > "$work/Dockerfile"
  docker build -q -t "$IMAGE" "$work" > /dev/null
  docker push -q "$IMAGE" > /dev/null

  # A certificate for the Service's name, its own CA: thrown away with the cluster.
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=slowcreate CA" \
    -keyout "$work/ca.key" -out "$work/ca.crt" 2> /dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=slowcreate.$NS.svc" \
    -keyout "$work/tls.key" -out "$work/tls.csr" 2> /dev/null
  printf 'subjectAltName=DNS:slowcreate.%s.svc\n' "$NS" > "$work/san"
  openssl x509 -req -in "$work/tls.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial \
    -days 1 -extfile "$work/san" -out "$work/tls.crt" 2> /dev/null

  k create namespace "$NS" --dry-run=client -o yaml | k apply -f - > /dev/null
  k -n "$NS" create secret tls slowcreate --cert "$work/tls.crt" --key "$work/tls.key" \
    --dry-run=client -o yaml | k apply -f - > /dev/null
  sed -e "s|@IMAGE@|$IMAGE|; s|@DELAY@|$DELAY|; s|@JITTER@|$JITTER|; s|@CA@|$(base64 < "$work/ca.crt" | tr -d '\n')|" \
    "$here/webhook.yaml" | k apply -f - > /dev/null
  k -n "$NS" rollout restart deploy/slowcreate > /dev/null
  k -n "$NS" rollout status deploy/slowcreate --timeout=120s > /dev/null
  echo "slowcreate holds each Job's first create in namespace perf for $DELAY, plus up to $JITTER."
  ;;
down)
  k delete validatingwebhookconfiguration slowcreate --ignore-not-found > /dev/null
  k delete namespace "$NS" --ignore-not-found > /dev/null
  echo "slowcreate removed."
  ;;
*)
  echo "usage: $0 up|down" >&2
  exit 2
  ;;
esac
