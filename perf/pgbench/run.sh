#!/usr/bin/env bash
# Postgres alone, in the cluster: pgbench against the kernel release's
# Postgres Pod as it's sized, from a Pod of the release (the NetworkPolicy
# lets only those reach it), over TLS, in a scratch database it drops after.
#
#   perf/pgbench/run.sh <label>      on vennir-perf (KUBE_CONTEXT to change)
#   PGBENCH_ALLOW=<context> KUBE_CONTEXT=<context> perf/pgbench/run.sh <label>
#                                    a throwaway cloud test install, named
#                                    twice so it's never one by mistake
#
# Prints, for 8 and 64 clients at once: transactions a second and latency,
# for pgbench's TPC-B-like mix (writes) and select-only (reads).
set -euo pipefail
label=${1:?usage: run.sh <label>}
ctx=${KUBE_CONTEXT:-kind-vennir-perf}
case "$ctx" in
  kind-vennir-perf*) ;;
  "${PGBENCH_ALLOW:-}") ;;
  *) echo "run.sh: only on a vennir-perf cluster, or one named in PGBENCH_ALLOW, not $ctx" >&2; exit 1;;
esac
ns=vennir-system
release=kernel
image=$(kubectl --context "$ctx" -n "$ns" get deploy "$release-execution-kernel-postgres" -o jsonpath='{.spec.template.spec.containers[0].image}')
secret=$(kubectl --context "$ctx" -n "$ns" get deploy "$release-execution-kernel-postgres" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="POSTGRES_PASSWORD")].valueFrom.secretKeyRef.name}')
name="pgbench-$(date +%s)"
kubectl --context "$ctx" -n "$ns" apply -f - > /dev/null <<YAML
apiVersion: batch/v1
kind: Job
metadata: {name: $name}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: execution-kernel
        app.kubernetes.io/instance: $release
    spec:
      restartPolicy: Never
      containers:
        - name: pgbench
          image: $image
          env:
            - {name: PGHOST, value: $release-execution-kernel-postgres}
            - {name: PGUSER, value: postgres}
            - {name: PGSSLMODE, value: require}
            - name: PGPASSWORD
              valueFrom: {secretKeyRef: {name: $secret, key: postgres-password}}
          command:
            - sh
            - -c
            - |
              set -e
              psql -d postgres -qc 'DROP DATABASE IF EXISTS pgbench' -c 'CREATE DATABASE pgbench'
              # Scale 20: about 300 MB, more than minimal's shared buffers.
              pgbench -d pgbench -i -s 20 -q > /dev/null 2>&1
              for clients in 8 64; do
                for mode in tpcb select; do
                  flag=""; [ "\$mode" = select ] && flag="-S"
                  out=\$(pgbench -d pgbench \$flag -c \$clients -j 4 -T 30 -n 2>&1)
                  tps=\$(echo "\$out" | sed -n 's/^tps = \([0-9.]*\).*/\1/p')
                  lat=\$(echo "\$out" | sed -n 's/^latency average = \(.*\)$/\1/p')
                  echo "RESULT $label clients=\$clients mode=\$mode tps=\$tps latency=\$lat"
                done
              done
              psql -d postgres -qc 'DROP DATABASE pgbench'
YAML
kubectl --context "$ctx" -n "$ns" wait --for=condition=complete "job/$name" --timeout=15m > /dev/null
kubectl --context "$ctx" -n "$ns" logs "job/$name" | grep '^RESULT'
kubectl --context "$ctx" -n "$ns" delete job "$name" > /dev/null
