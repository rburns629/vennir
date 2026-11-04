#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Installs the scanners and linters CI uses, at pinned versions, refusing any
# download whose SHA-256 doesn't match the one recorded here. Release
# binaries rather than third-party GitHub Actions: a scanner is exactly what
# an attacker would want to tamper with, and pinning the bytes themselves
# leaves nothing to trust but this file. (Started as a copy of
# vennir-catalog's; the two repos pin independently.)
#
# To upgrade one: bump its version, then take the new linux/amd64 sum from
# that release's own checksums file (trivy_<v>_checksums.txt,
# gitleaks_<v>_checksums.txt, osv-scanner_SHA256SUMS,
# actionlint_<v>_checksums.txt, cosign_checksums.txt).
#
# Usage: install-scanners.sh trivy osv-scanner gitleaks actionlint cosign   (any subset)
set -euo pipefail

TRIVY_VERSION=0.74.0
TRIVY_SHA256=2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a
OSV_SCANNER_VERSION=2.6.0
OSV_SCANNER_SHA256=ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
COSIGN_VERSION=3.1.3
COSIGN_SHA256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71
ORAS_VERSION=1.3.4
ORAS_SHA256=f27adb935022d94df8dc77719c322dda592c78a0d57a6f7dcdd8d900b248c454

bin="${RUNNER_TEMP:-/tmp}/scanners"
mkdir -p "$bin"
work=$(mktemp -d)

fetch() {  # url, expected sha256, output file
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum --check --quiet || {
    echo "::error::Checksum mismatch for $1 -- refusing to install it."
    exit 1
  }
}

for tool in "$@"; do
  case "$tool" in
    trivy)
      fetch "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" \
        "$TRIVY_SHA256" "$work/trivy.tar.gz"
      tar -xzf "$work/trivy.tar.gz" -C "$bin" trivy
      ;;
    osv-scanner)
      fetch "https://github.com/google/osv-scanner/releases/download/v${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64" \
        "$OSV_SCANNER_SHA256" "$bin/osv-scanner"
      chmod +x "$bin/osv-scanner"
      ;;
    gitleaks)
      fetch "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
        "$GITLEAKS_SHA256" "$work/gitleaks.tar.gz"
      tar -xzf "$work/gitleaks.tar.gz" -C "$bin" gitleaks
      ;;
    actionlint)
      fetch "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
        "$ACTIONLINT_SHA256" "$work/actionlint.tar.gz"
      tar -xzf "$work/actionlint.tar.gz" -C "$bin" actionlint
      ;;
    cosign)
      fetch "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-amd64" \
        "$COSIGN_SHA256" "$bin/cosign"
      chmod +x "$bin/cosign"
      ;;
    oras)
      fetch "https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_linux_amd64.tar.gz" \
        "$ORAS_SHA256" "$work/oras.tar.gz"
      tar -xzf "$work/oras.tar.gz" -C "$bin" oras
      ;;
    *)
      echo "::error::Unknown scanner: $tool"
      exit 1
      ;;
  esac
  echo "Installed $tool"
done

rm -rf "$work"
if [ -n "${GITHUB_PATH:-}" ]; then echo "$bin" >> "$GITHUB_PATH"; fi
