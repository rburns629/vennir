#!/usr/bin/env bash
# The charts' alerts, evaluated by promtool against made-up series
# (helm/tests/prometheus/alerts.test.yaml): both charts rendered with
# monitoring.provider bundled, their rule files run in the same Prometheus
# image the console chart pins. Needs helm and docker; no cluster.
set -euo pipefail
cd "$(dirname "$0")/../.."

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/rules"
cp helm/tests/prometheus/alerts.test.yaml "$work/"

# A rendered ConfigMap's one rule file, as its own file.
rule_file() { # chart, release, key
  helm template "$2" "helm/charts/$1" -n vennir-system --show-only templates/monitoring.yaml \
    --set monitoring.provider=bundled --set monitoring.alerts.enabled=true \
    --set kernelApiUrl=https://kernel-execution-kernel-api.vennir-system.svc:8000 |
    awk -v key="  $3: |" '$0 == key {on=1; next} on && /^[^ ]/ {on=0} on {sub(/^    /, ""); print}'
}
rule_file execution-kernel kernel kernel.rules.yaml > "$work/rules/kernel.rules.yaml"
rule_file execution-console console console.rules.yaml > "$work/rules/console.rules.yaml"

image=$(awk '/^  prometheus:/{p=1} p && /repository:/{r=$2} p && /digest:/{print r "@" $2; exit}' helm/charts/execution-console/values.yaml)
docker run --rm --user "$(id -u):$(id -g)" -v "$work:/work:ro" -w /work --entrypoint promtool "$image" check rules rules/kernel.rules.yaml rules/console.rules.yaml
docker run --rm --user "$(id -u):$(id -g)" -v "$work:/work:ro" -w /work --entrypoint promtool "$image" test rules alerts.test.yaml
