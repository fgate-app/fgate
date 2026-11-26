#!/bin/sh
set -eu
[ "$(id -u)" = 0 ]
[ "$(cat /proc/sys/net/ipv4/ip_forward)" = 1 ]
ns=fg-tor-lab
! ip netns list | grep -q "^$ns "
! ip link show fgtor-host >/dev/null 2>&1
! nft list table ip fg_tor_lab >/dev/null 2>&1
cleanup(){ ip netns del "$ns" 2>/dev/null || true; ip link del fgtor-host 2>/dev/null || true; nft delete table ip fg_tor_lab 2>/dev/null || true; rm -rf "/etc/netns/$ns"; }
trap cleanup EXIT INT TERM
ip netns add "$ns"
ip link add fgtor-host type veth peer name fgtor-peer
ip link set fgtor-peer netns "$ns"
ip addr add 198.19.255.1/30 dev fgtor-host
ip link set fgtor-host up
ip -n "$ns" addr add 198.19.255.2/30 dev fgtor-peer
ip -n "$ns" link set fgtor-peer up
ip -n "$ns" link set lo up
ip -n "$ns" route add default via 198.19.255.1
mkdir -p "/etc/netns/$ns"
cp /etc/resolv.conf "/etc/netns/$ns/resolv.conf"
nft -f - <<'NFT'
add table ip fg_tor_lab
add chain ip fg_tor_lab postrouting { type nat hook postrouting priority srcnat; policy accept; }
add rule ip fg_tor_lab postrouting ip saddr 198.19.255.2 masquerade
NFT
ip netns exec "$ns" env FREEDOMGATE_TOR_BUNDLE=/opt/freedomgate/test-stages/tor-bundle /opt/freedomgate/runtime/node/bin/node tests/integration/tor-tun-bootstrap.mjs
