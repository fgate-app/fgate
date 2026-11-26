#!/bin/sh
set -eu
release_output=${1:-/tmp/freedomgate-release.tar.gz}
case "$release_output" in /*) ;;*) release_output="$(pwd)/$release_output";;esac
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
mkdir -p "$(dirname "$release_output")"
npm run build
# The same explicit assembler is used by native installation.
package_root=$(mktemp -d)
trap 'rm -rf "$package_root"' EXIT
python3 "$(dirname "$0")/package-tree.py" --source "$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)" --target "$package_root/release" --installer
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$release_output" -C "$package_root/release" .
printf 'Release: %s\n' "$release_output"
