#!/usr/bin/env bash
# Pins a released vennir in a catalog's ./vennir wrapper: its version and
# each platform's SHA-256, from the release's vennir-checksums.txt, after
# checking each binary downloads anonymously from the public package (as a
# catalog's CI will) and matches.
#
#   .github/scripts/pin-vennir.sh 0.2.0                      catalog-template/vennir
#   .github/scripts/pin-vennir.sh 0.2.0 ../my-catalog/vennir  another catalog's
#
# Reads the release with gh (signed in); the downloads need no sign-in.
set -euo pipefail

version=${1:?usage: pin-vennir.sh <version> [wrapper ...]}
version=${version#v}
shift
root=$(cd "$(dirname "$0")/../.." && pwd)
[ $# -gt 0 ] || set -- "$root/catalog-template/vennir"

checksums=$(gh release download "v$version" --pattern vennir-checksums.txt --output - --repo roburns/vennir)
sha() { awk -v f="vennir-$1" '$2 == f { print $1 }' <<< "$checksums"; }

for wrapper in "$@"; do
  registry=$(sed -n 's/^registry="\(.*\)"$/\1/p' "$wrapper")
  repository=$(sed -n 's/^repository="\(.*\)"$/\1/p' "$wrapper")
  token=$(curl -fsSL "$registry/token?scope=repository:$repository:pull" | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p')
  for platform in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64; do
    want=$(sha "$platform")
    [ -n "$want" ] || { echo "pin-vennir.sh: no checksum for $platform in v$version" >&2; exit 1; }
    got=$(curl -fsSL -H "Authorization: Bearer $token" "$registry/v2/$repository/blobs/sha256:$want" | shasum -a 256 | cut -d' ' -f1) || {
      echo "pin-vennir.sh: $platform's binary doesn't download anonymously: is the package public?" >&2; exit 1; }
    [ "$got" = "$want" ] || { echo "pin-vennir.sh: $platform's download is $got, not $want" >&2; exit 1; }
    sed -i.bak "s/^  $platform) sha256=\"[0-9a-f]*\" ;;$/  $platform) sha256=\"$want\" ;;/" "$wrapper"
  done
  sed -i.bak "s/^version=\".*\"$/version=\"$version\"/" "$wrapper"
  rm -f "$wrapper.bak"
  echo "Pinned vennir $version in $wrapper"
done
