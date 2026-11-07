#!/bin/sh
# Generic action dispatcher -- agnostic to what language actions/*.<ext> is
# written in. A product declares its language support by what its own
# Dockerfile installs, not here: this script never hardcodes an
# interpreter, it just execs whichever file matches the requested action
# and trusts that file's own shebang to run it correctly. Every product in
# the catalog copies its own copy of this file (see the catalog's README.md on
# why: separate products share no code, same as project-product/
# application-product already don't).
set -e

ACTION="$1"
SCRIPT=$(find /app/actions -maxdepth 1 -type f -name "${ACTION}.*" | head -n1)

if [ -z "$SCRIPT" ]; then
  printf '{"status":"failed","error":{"code":"UNSUPPORTED_ACTION","message":"no action script found for action \\"%s\\"","retryable":false}}' \
    "$ACTION" > /platform/output/result.json
  exit 1
fi

exec "$SCRIPT"
