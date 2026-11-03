#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Whether a tag is in the registry, for the release workflow, which writes
# each version's tags once. Needs oras, signed in to the registry.
#
# Prints the tag's digest and exits 0 if it's there; exits 1 if it isn't;
# exits 2 (with the error) if the registry couldn't say, which a caller
# must treat as neither.
#
# Usage: published.sh <registry>/<repository>:<tag>
set -uo pipefail

if out=$(oras resolve "$1" 2>&1); then
  echo "$out"
  exit 0
fi
shopt -s nocasematch
case "$out" in
  *"not found"* | *name_unknown* | *manifest_unknown*) exit 1 ;;
esac
echo "::error::Couldn't tell whether $1 is published: $out" >&2
exit 2
