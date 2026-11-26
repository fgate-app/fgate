#!/bin/sh
# Run from a source checkout or unpacked FreedomGate release.
set -eu
umask 022
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/scripts/platform-support.sh"

activate_release() {
 ln -sfn "$1" /opt/freedomgate/current.next
 mv -Tf /opt/freedomgate/current.next /opt/freedomgate/current
}

restart_gateway() {
 systemctl restart freedomgate-network.service freedomgate.service
}

rollback_install() {
 install_exit=$?
 trap - EXIT HUP INT TERM
 if [ "$install_committed" != 1 ];then
  echo 'Installation did not complete; restoring installer-owned runtime, units and application.' >&2
  if [ "$activation_started" = 1 ];then python3 "$ROOT/scripts/install-transaction.py" restore "$install_backup" --restart
  else python3 "$ROOT/scripts/install-transaction.py" restore "$install_backup";fi
 fi
 exit "$install_exit"
}

wait_for_admin() {
 for attempt in 1 2 3 4 5 6 7 8 9 10;do
  if "$node_dir/bin/node" scripts/install-health.mjs;then return 0;fi
  sleep 1
 done
 return 1
}

ensure_runtime() {
 runtime_name=$1
 runtime_version=$(python3 -c 'import json,sys;print(json.load(open("packaging/runtime.lock.json"))[sys.argv[1]]["version"])' "$runtime_name")
 runtime_target="$runtime/$runtime_name-$runtime_version-$arch"
 if [ ! -x "$runtime_target/bin/$runtime_name" ];then
  python3 scripts/fetch-runtime.py "$runtime_name" --platform "linux-$arch" --output "$runtime_target" >&2
 fi
 python3 -c 'import sys;sys.path.insert(0,"scripts");from install_support import public_tree;public_tree(sys.argv[1])' "$runtime_target"
 printf '%s\n' "$runtime_target"
}

mode=native
check=0
while [ "$#" -gt 0 ]; do
 case "$1" in
  --container) mode=container;;
  --native) mode=native;;
  --check) check=1;;
  --with-lantern) :;;
  --help|-h) printf 'Usage: sudo sh scripts/install.sh [--native|--container] [--check]\nLinux Debian 13, Ubuntu 24.04/26.04 LTS, Raspberry Pi OS 13; ARM64 or x86-64.\n';exit 0;;
  *) echo "Unknown option: $1" >&2;exit 2;;
 esac
 shift
done
[ "$(uname -s)" = Linux ] || { echo 'Gateway installation requires Linux.' >&2;exit 1; }
arch=$(platform_arch "$(uname -m)")
printf 'FreedomGate: linux-%s, %s installation\n' "$arch" "$mode"
if [ "$mode" = container ]; then
 command -v docker >/dev/null || { echo 'Install Docker Engine and Compose v2 first.' >&2;exit 1; }
 compose_platform "$(docker compose version --short)"
 docker info >/dev/null
 if [ -n "${DOCKER_CONTEXT:-}" ];then docker_endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
 elif [ -n "${DOCKER_HOST:-}" ];then docker_endpoint=$DOCKER_HOST
 else docker_endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}');fi
 container_platform "$(docker info --format '{{.OSType}}')" "$(docker info --format '{{.OperatingSystem}}')" "$(docker info --format '{{.Architecture}}')" "$(docker info --format '{{.CgroupVersion}}')" "$(docker info --format '{{json .SecurityOptions}}')" "$docker_endpoint" "$arch"
 [ -f /sys/fs/cgroup/cgroup.controllers ] || { echo 'The host must expose cgroup v2.' >&2;exit 1; }
 if command -v systemctl >/dev/null && systemctl is-active --quiet freedomgate.service freedomgate-network.service;then echo 'Native FreedomGate is running. Stop native services before starting the container.' >&2;exit 1;fi
 if [ ! -c /dev/net/tun ];then
  [ "$check" != 1 ] || { echo 'Host kernel TUN support (/dev/net/tun) is required.' >&2;exit 1; }
  if [ "$(id -u)" = 0 ] && command -v modprobe >/dev/null;then modprobe tun;fi
  [ -c /dev/net/tun ] || { echo 'Host kernel TUN support (/dev/net/tun) is required.' >&2;exit 1; }
 fi
 [ "$check" = 1 ] && exit 0
 cd "$ROOT"
 docker compose -f compose.yaml up --build -d --wait --wait-timeout 180
 printf 'Open http://<host-LAN-IP>/ and create the administrator.\n'
 exit 0
fi
[ -f /etc/os-release ] || { echo 'Cannot detect distribution.' >&2;exit 1; }
. /etc/os-release
native_platform "$ID" "${VERSION_ID:-}" "$(getconf LONG_BIT)" "$arch"
[ "$(dpkg --print-architecture)" = "$arch" ] || { echo 'Kernel and userspace architectures must match.' >&2;exit 1; }
if command -v systemd-detect-virt >/dev/null && systemd-detect-virt --container --quiet;then echo 'Use the Docker image workflow inside containers; native installation requires a Linux host or VM.' >&2;exit 1;fi
command -v systemctl >/dev/null || { echo 'Native installation requires systemctl.' >&2;exit 1; }
[ -d /run/systemd/system ] || { echo 'Native installation requires systemd.' >&2;exit 1; }
if [ -c /dev/net/tun ];then :
elif command -v modprobe >/dev/null && modprobe -n tun >/dev/null 2>&1;then :
else echo 'Host kernel TUN support (/dev/net/tun) is required.' >&2;exit 1;fi
if command -v docker >/dev/null && [ "$(docker -H unix:///var/run/docker.sock inspect -f '{{.State.Running}}' freedomgate 2>/dev/null || true)" = true ];then echo 'FreedomGate container is running. Stop it before native installation.' >&2;exit 1;fi
for unit in freedomgate.service freedomgate-network.service;do
 case "$(systemctl is-enabled "$unit" 2>/dev/null || true)" in masked*) echo 'Unmask FreedomGate services before installation.' >&2;exit 1;;esac
done
[ "$check" = 1 ] && exit 0
[ "$(id -u)" = 0 ] || { echo 'Run with sudo.' >&2;exit 1; }
cd "$ROOT"
PATH="/usr/sbin:/usr/bin:/sbin:/bin:$PATH";export PATH
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates openssh-client curl python3 xz-utils tar unzip make gcc g++ pkg-config libnetfilter-queue-dev libcap-dev zlib1g-dev libmnl-dev libnfnetlink-dev liblua5.4-dev libluajit-5.1-dev hostapd dnsmasq-base nftables iproute2 iw rfkill procps iputils-ping kmod
# Own daemons are started by the helper, not the distribution's hostapd unit.
# Do not stop or disable unrelated host services automatically.
python3 -c 'import sys;assert sys.version_info >= (3,12), "Python 3.12 or newer is required."'
if [ ! -c /dev/net/tun ];then modprobe tun;fi
runtime=/opt/freedomgate/runtime
install -d -m 0755 /opt/freedomgate "$runtime"
go_dir=$(ensure_runtime go)
PATH="$go_dir/bin:$PATH";export PATH
python3 scripts/release-bundles.py --platform "linux-$arch" --prepare
node_dir=$(ensure_runtime node)
install_backup=$(python3 scripts/install-transaction.py snapshot)
install_committed=0
activation_started=0
trap rollback_install EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
PATH="$node_dir/bin:$PATH";export PATH
if [ ! -f web/dist/index.html ] || [ ! -f node_modules/yaml/package.json ];then npm ci --ignore-scripts;fi
if [ ! -f web/dist/index.html ];then npm run build;fi
python3 scripts/fetch-access-modules.py --platform linux-arm64 --platform linux-amd64
python3 scripts/prepare-modules.py --platform "linux-$arch" --output /opt/freedomgate/modules
if ! id freedomgate >/dev/null 2>&1;then useradd --system --home-dir /var/lib/freedomgate --shell /usr/sbin/nologin freedomgate;fi
install -d -m 0755 /opt/freedomgate/releases /opt/freedomgate/module-updates /etc/freedomgate
if [ ! -d /var/lib/freedomgate ];then install -d -m 0700 -o freedomgate -g freedomgate /var/lib/freedomgate;fi
release_dir=/opt/freedomgate/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir "$release_dir"
python3 scripts/package-tree.py --source "$ROOT" --target "$release_dir"
chown -R root:root "$release_dir"
chmod -R a+rX,go-w "$release_dir"
if [ ! -f /etc/freedomgate/freedomgate.env ];then printf 'HOST=0.0.0.0\nPORT=80\n' > /etc/freedomgate/freedomgate.env;chmod 600 /etc/freedomgate/freedomgate.env;fi
runuser -u freedomgate -- "$node_dir/bin/node" --version
runuser -u freedomgate -- "$node_dir/bin/node" --input-type=module -e "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(':memory:');db.exec('SELECT 1');db.close();"
runuser -u freedomgate -- "$release_dir/server/outline/bin/linux-$arch/outline-bridge" --version
runuser -u freedomgate -- /opt/freedomgate/modules/mihomo/current/mihomo -v
if [ -x /opt/freedomgate/modules/tor/current/tor/tor ];then
 runuser -u freedomgate -- env LD_LIBRARY_PATH=/opt/freedomgate/modules/tor/current/tor /opt/freedomgate/modules/tor/current/tor/tor --version
fi
activation_started=1
for unit in freedomgate.service freedomgate-network.service;do
 if [ "$(systemctl show "$unit" --property=LoadState --value)" != not-found ];then systemctl stop "$unit";fi
done
python3 scripts/install-transaction.py state "$install_backup"
chown -hR freedomgate:freedomgate /var/lib/freedomgate
chmod 0700 /var/lib/freedomgate
python3 scripts/install-transaction.py node "$install_backup" "$node_dir"
activate_release "$release_dir"
# Preserve administrator drop-ins. Package units have portable defaults.
install -m 0644 packaging/systemd/freedomgate.service /etc/systemd/system/freedomgate.service
install -m 0644 packaging/systemd/freedomgate-network.service /etc/systemd/system/freedomgate-network.service
systemctl daemon-reload
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 packaging/systemd/freedomgate-journal.conf /etc/systemd/journald.conf.d/freedomgate.conf
systemctl restart systemd-journald.service
journalctl --flush
systemctl enable freedomgate-network.service freedomgate.service
# Helper upgrades require one deliberate restart to load the new code.
if ! restart_gateway;then
 echo 'Service start failed; previous application restored when available.' >&2;exit 1
fi
# Probe HTTP without sourcing configuration as shell code.
if ! wait_for_admin;then
 echo 'HTTP readiness failed; previous application restored when available. Inspect journalctl -u freedomgate.' >&2;exit 1
fi
install_committed=1
trap - EXIT HUP INT TERM
printf 'Installer backup: %s\n' "$install_backup"
printf 'Installed %s. Open http://<host-LAN-IP>/ and create the administrator.\n' "$release_dir"
