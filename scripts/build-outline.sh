#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
outline_os=${1:-$(go env GOOS)}
outline_arch=${2:-$(go env GOARCH)}
case "$outline_os/$outline_arch" in linux/arm64|linux/amd64|darwin/arm64|darwin/amd64) ;; *) echo 'Unsupported Outline target'; exit 1;; esac
cd "$root/server/outline"
mkdir -p "bin/$outline_os-$outline_arch"
CGO_ENABLED=0 GOOS="$outline_os" GOARCH="$outline_arch" go build -mod=vendor -trimpath -ldflags='-s -w' -o "bin/$outline_os-$outline_arch/outline-bridge" .
