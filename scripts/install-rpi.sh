#!/bin/sh
# Backwards-compatible entry point; the installer now supports ARM64 and x86-64.
set -eu
exec sh "$(dirname "$0")/install.sh" "$@"
