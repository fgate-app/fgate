#!/bin/sh
# Pure compatibility checks shared by installation and fixtures.
platform_arch() {
 case "$1" in aarch64|arm64) printf 'arm64\n';;x86_64|amd64) printf 'amd64\n';;*) echo 'Only 64-bit ARM64 and x86-64 are supported.' >&2;return 1;;esac
}
native_platform() {
 case "$1/$2" in debian/13|ubuntu/24.04|ubuntu/26.04|raspbian/13) ;;*) echo 'Native installation requires Debian 13, Ubuntu 24.04/26.04 LTS, or Raspberry Pi OS 13.' >&2;return 1;;esac
 [ "$3" = 64 ] || { echo 'A 64-bit Linux userspace is required.' >&2;return 1; }
 [ "$1" != raspbian ] || [ "$4" = arm64 ] || { echo 'Raspberry Pi OS requires ARM64.' >&2;return 1; }
}
container_platform() {
 # OS type, OS name, daemon architecture, cgroup version, security options, endpoint, host arch.
 [ "$1" = linux ] || { echo 'A Linux Docker daemon is required.' >&2;return 1; }
 case "$2" in *Docker\ Desktop*|*docker-desktop*|*LinuxKit*) echo 'Docker Desktop cannot run the full gateway.' >&2;return 1;;esac
 case "$5" in *rootless*) echo 'Rootless Docker cannot run the full gateway.' >&2;return 1;;esac
 case "$6" in unix:///*) ;;*) echo 'Use a local Docker Engine Unix socket; remote daemons are not supported.' >&2;return 1;;esac
 [ "$4" = 2 ] || { echo 'Full gateway containers require cgroup v2.' >&2;return 1; }
 daemon_arch=$(platform_arch "$3") || return 1
 [ "$daemon_arch" = "$7" ] || { echo 'Docker daemon and host architectures must match.' >&2;return 1; }
}
compose_platform() {
 version=${1#v}
 case "$version" in ''|*[!0-9.]*|.*|*..*) echo 'Docker Compose 2.20 or newer is required.' >&2;return 1;;esac
 major=${version%%.*};rest=${version#*.};minor=${rest%%.*}
 if [ "$major" -gt 2 ] || { [ "$major" = 2 ] && [ "$minor" -ge 20 ]; };then return 0;fi
 echo 'Docker Compose 2.20 or newer is required.' >&2;return 1
}
